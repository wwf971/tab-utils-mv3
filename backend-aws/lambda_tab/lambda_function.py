
# Tab cloud aws backend: lambda entry behind api gateway http api. the api
# gateway jwt authorizer has already verified the cognito access token; this
# file resolves the internal user id from the shared user table (aws_oa
# sub-project _0_auth_cognito), parses the body, and dispatches into
# core.API_HANDLER_MAP -- the same core logic as the local flask server.
# refer to aws_backend_impl.md.
#
# deployed by ensure_architect.py, which zips this file together with
# tab_server_core.py, tab_server_check.py, tab_server_db.py,
# tab_server_index_sqs.py and ensure_architect.py (flat, import by module
# name). configuration comes from the lambda env, refer to
# ensure_architect.py#lambda_env_build.

import base64
import json
import os

import boto3
from boto3.dynamodb.conditions import Key

import tab_server_core as core
import tab_server_db as db
import tab_server_index_sqs as index
from tab_server_core import ApiError, CODE_AUTH, CODE_CLOUD, CODE_FAIL, CODE_NOT_FOUND
from tab_server_db import DbConflictError, DbUnavailableError
from tab_server_index_sqs import IndexUnavailableError


# ---------------------------------------------------------------------------
# init, once per lambda container
# ---------------------------------------------------------------------------

db.init_db({"aws": {
	# region and credentials come from the lambda runtime (execution role)
	"dynamodb": {"table_name_prefix": os.environ["TABLE_NAME_PREFIX"]},
}})

index.init_index({
	"queue_url": os.environ["ES_QUEUE_URL"],
	"table_result": os.environ["ES_RESULT_TABLE"],
	"index_name": os.environ["ES_INDEX_NAME"],
	"result_timeout": os.environ.get("ES_RESULT_TIMEOUT_SEC", "20"),
	"result_poll_interval": os.environ.get("ES_RESULT_POLL_SEC", "0.25"),
})

core.core_init(index)

_table_user = boto3.resource("dynamodb").Table(os.environ["TABLE_USER"])
_user_id_cache = {}  # cognito sub -> user_id, for the lambda container lifetime


def user_id_resolve(sub):
	if sub in _user_id_cache:
		return _user_id_cache[sub]
	found = _table_user.query(
		IndexName="gsi_auth_id",
		KeyConditionExpression=Key("auth_id").eq(f"cognito#{sub}"),
	)["Items"]
	if not found:
		return None
	_user_id_cache[sub] = found[0]["user_id"]
	return _user_id_cache[sub]


# ---------------------------------------------------------------------------
# handler
# ---------------------------------------------------------------------------

def lambda_handler(event, context):
	# cors preflight, via the unauthorized OPTIONS route (refer to
	# ensure_architect.py#options_route_ensure): empty answer, the api
	# gateway attaches the cors headers itself
	if event["requestContext"]["http"]["method"] == "OPTIONS":
		return {"statusCode": 204}

	claims = event["requestContext"]["authorizer"]["jwt"]["claims"]
	user_id = user_id_resolve(claims["sub"])
	if user_id is None:
		return response_make({
			"code": CODE_AUTH,
			"message": "no user_id mapping for this cognito user,"
					   " run _0_auth_cognito/ensure_user_table.py",
		})

	path = event["rawPath"]
	handler = core.API_HANDLER_MAP.get(path)
	if handler is None:
		return response_make({"code": CODE_NOT_FOUND, "message": f"unknown api: {path}"})

	try:
		return response_make(handler(user_id, body_parse(event)))
	except ApiError as error:
		return response_make({"code": error.code, "message": error.message})
	except (DbUnavailableError, IndexUnavailableError) as error:
		return response_make({"code": CODE_CLOUD, "message": str(error)})
	except DbConflictError as error:
		return response_make({"code": CODE_FAIL, "message": f"write conflict: {error}"})
	except Exception as error:
		return response_make({"code": CODE_FAIL, "message": str(error)})


def body_parse(event):
	raw = event.get("body")
	if not raw:
		return {}
	if event.get("isBase64Encoded"):
		raw = base64.b64decode(raw).decode()
	body = json.loads(raw)
	return body if isinstance(body, dict) else {}


def response_make(body):
	# same convention as the local server: the http status is 200 and the
	# outcome lives in the body's code field
	return {
		"statusCode": 200,
		"headers": {"content-type": "application/json"},
		"body": json.dumps(body),
	}
