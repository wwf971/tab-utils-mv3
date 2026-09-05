
# ensure all aws resource instances of the tab cloud aws backend: the
# dynamodb tables, the cognito app client of the extension, the api lambda,
# the api gateway http api, and the search index on the local es service.
# refer to tab_cloud.md for the table formats, tab_cloud_aws_init.md for the
# table initialization design, and aws_backend_impl.md for the aws backend.
#
# 'ensure' means: create if missing, report if config differs, never recreate.
# an existing table with a wrong schema is reported by the check result and is
# not repaired automatically.
#
# usage:
#   python ensure_architect.py                 ensure everything
#   python ensure_architect.py --tables        ensure the dynamodb tables only
#   python ensure_architect.py --check         inspect everything, change nothing
#   python ensure_architect.py --delete all    remove the aws backend (typed
#                                              confirmation; --assume-prefix
#                                              handles resources of an older
#                                              name_prefix)
#
# also used as a module: tab_server_db.py calls architect_check() and
# architect_ensure() behind the /api/maintenance table apis (both from the
# local server and from the lambda, so anything imported only by the ensure
# flows below is imported lazily, the lambda runtime does not have yaml or
# the aws_oa project).
#
# config layers, later overrides earlier (refer to config-two-layer.md):
#   ./config.yaml     example
#   ./config.0.yaml   authentic (git-ignored)
#
# resource ids that can only be fetched from aws are written by this script
# into ./config_gen.yaml (refer to aws_oa.md#layered-config).

import io
import json
import os
import sys
import zipfile

import boto3


DIR_SELF = os.path.dirname(os.path.realpath(__file__))


def config_load():
	# yaml is imported here, not at module top: this module is also packaged
	# into the lambda zip (for TABLE_SPECS and the table check), and the
	# lambda runtime has no yaml; the lambda passes its config via env and
	# never calls config_load().
	import yaml

	def read_yaml(file_name):
		file_path = os.path.join(DIR_SELF, file_name)
		if not os.path.exists(file_path):
			return {}
		with open(file_path, "r", encoding="utf-8") as config_file:
			return yaml.safe_load(config_file) or {}

	def merge(base, override):
		for key, value in override.items():
			if isinstance(value, dict) and isinstance(base.get(key), dict):
				merge(base[key], value)
			else:
				base[key] = value
		return base

	return merge(read_yaml("config.yaml"), read_yaml("config.0.yaml"))


def dynamodb_client_make(config):
	aws = config.get("aws", {})
	kwargs = {
		"region_name": aws.get("region_name"),
		"aws_access_key_id": aws.get("access_key_id"),
		"aws_secret_access_key": aws.get("secret_access_key"),
	}
	endpoint_url = aws.get("dynamodb", {}).get("endpoint_url")
	if endpoint_url:
		kwargs["endpoint_url"] = endpoint_url
	return boto3.client("dynamodb", **kwargs)


def table_name_prefix_of(config):
	return config.get("aws", {}).get("dynamodb", {}).get("table_name_prefix", "tabCloud")


# ---------------------------------------------------------------------------
# table specs: the configured architecture, the single source of truth
# ---------------------------------------------------------------------------

# key tuples are (attribute name, attribute type, key type)
TABLE_SPECS = {
	"Window": {
		"keys": [("userId", "S", "HASH"), ("windowPath", "S", "RANGE")],
		"gsis": [{"name": "gsiWindowId", "keys": [("id", "S", "HASH")]}],
	},
	"Tab": {
		"keys": [("userId", "S", "HASH"), ("tabPath", "S", "RANGE")],
		"gsis": [{"name": "gsiTabId", "keys": [("id", "S", "HASH")]}],
	},
	"Tag": {
		"keys": [("userId", "S", "HASH"), ("tagName", "S", "RANGE")],
		"gsis": [{"name": "gsiTagId", "keys": [("id", "S", "HASH")]}],
	},
	"TabTag": {
		"keys": [("tagId", "S", "HASH"), ("tabPath", "S", "RANGE")],
		"gsis": [{"name": "gsiTabTag", "keys": [("tabId", "S", "HASH"), ("tagId", "S", "RANGE")]}],
	},
	"Group": {
		"keys": [("userId", "S", "HASH"), ("id", "S", "RANGE")],
		"gsis": [],
	},
	"Meta": {
		"keys": [("userId", "S", "HASH"), ("metaPath", "S", "RANGE")],
		"gsis": [],
	},
}


def table_full_name(table_name_prefix, short_name):
	return table_name_prefix + short_name


# ---------------------------------------------------------------------------
# check: compare every existing table against the configured spec
# ---------------------------------------------------------------------------

def architect_check(client, table_name_prefix):
	table_status_list = []
	for short_name, spec in TABLE_SPECS.items():
		full_name = table_full_name(table_name_prefix, short_name)
		try:
			response = client.describe_table(TableName=full_name)
		except client.exceptions.ResourceNotFoundException:
			table_status_list.append({
				"tableName": full_name,
				"isExisting": False,
				"isConfigConsistent": None,
				"isReady": False,
				"statusText": "MISSING",
				"configIssueList": [],
			})
			continue
		table_description = response["Table"]
		config_issue_list = _table_config_issue_list(table_description, spec)
		status_text = table_description["TableStatus"]
		table_status_list.append({
			"tableName": full_name,
			"isExisting": True,
			"isConfigConsistent": len(config_issue_list) == 0,
			"isReady": status_text == "ACTIVE" and len(config_issue_list) == 0,
			"statusText": status_text,
			"configIssueList": config_issue_list,
		})
	return table_status_list


def _table_config_issue_list(table_description, spec):
	issue_list = []
	key_schema_actual = _key_schema_normalized(table_description.get("KeySchema", []))
	key_schema_expected = _key_schema_normalized([
		{"AttributeName": name, "KeyType": key_type}
		for name, _, key_type in spec["keys"]
	])
	if key_schema_actual != key_schema_expected:
		issue_list.append("key schema differs from the configured schema")

	attribute_actual = {
		(item["AttributeName"], item["AttributeType"])
		for item in table_description.get("AttributeDefinitions", [])
	}
	attribute_expected = {
		(name, attr_type)
		for name, attr_type, _ in spec["keys"]
	}
	for gsi in spec["gsis"]:
		for name, attr_type, _ in gsi["keys"]:
			attribute_expected.add((name, attr_type))
	if attribute_actual != attribute_expected:
		issue_list.append("key attribute definitions differ from the configured schema")

	gsi_actual_by_name = {
		item["IndexName"]: item
		for item in table_description.get("GlobalSecondaryIndexes", [])
	}
	gsi_expected_names = {item["name"] for item in spec["gsis"]}
	if set(gsi_actual_by_name) != gsi_expected_names:
		issue_list.append("global secondary index names differ from the configured schema")
	for gsi_expected in spec["gsis"]:
		gsi_actual = gsi_actual_by_name.get(gsi_expected["name"])
		if gsi_actual is None:
			continue
		key_actual = _key_schema_normalized(gsi_actual.get("KeySchema", []))
		key_expected = _key_schema_normalized([
			{"AttributeName": name, "KeyType": key_type}
			for name, _, key_type in gsi_expected["keys"]
		])
		if key_actual != key_expected:
			issue_list.append(
				f"index {gsi_expected['name']} key schema differs from the configured schema")
		if gsi_actual.get("Projection", {}).get("ProjectionType") != "ALL":
			issue_list.append(
				f"index {gsi_expected['name']} projection must be ALL")

	billing_mode = table_description.get(
		"BillingModeSummary", {}).get("BillingMode", "PROVISIONED")
	if billing_mode != "PAY_PER_REQUEST":
		issue_list.append("billing mode must be PAY_PER_REQUEST")
	return issue_list


def _key_schema_normalized(key_schema):
	return sorted(
		(item.get("AttributeName"), item.get("KeyType"))
		for item in key_schema)


# ---------------------------------------------------------------------------
# ensure: create every missing table, wait until active, then check
# ---------------------------------------------------------------------------

def architect_ensure(client, table_name_prefix):
	for short_name, spec in TABLE_SPECS.items():
		full_name = table_full_name(table_name_prefix, short_name)
		try:
			client.describe_table(TableName=full_name)
			print(f"table already exists: {full_name}")
			continue
		except client.exceptions.ResourceNotFoundException:
			pass
		attribute_names = {}
		for name, attr_type, _ in spec["keys"]:
			attribute_names[name] = attr_type
		for gsi in spec["gsis"]:
			for name, attr_type, _ in gsi["keys"]:
				attribute_names[name] = attr_type
		create_kwargs = {
			"TableName": full_name,
			"BillingMode": "PAY_PER_REQUEST",
			"AttributeDefinitions": [
				{"AttributeName": name, "AttributeType": attr_type}
				for name, attr_type in attribute_names.items()
			],
			"KeySchema": [
				{"AttributeName": name, "KeyType": key_type}
				for name, _, key_type in spec["keys"]
			],
		}
		if spec["gsis"]:
			create_kwargs["GlobalSecondaryIndexes"] = [
				{
					"IndexName": gsi["name"],
					"KeySchema": [
						{"AttributeName": name, "KeyType": key_type}
						for name, _, key_type in gsi["keys"]
					],
					"Projection": {"ProjectionType": "ALL"},
				}
				for gsi in spec["gsis"]
			]
		client.create_table(**create_kwargs)
		print(f"table created: {full_name}")
	for short_name in TABLE_SPECS:
		client.get_waiter("table_exists").wait(
			TableName=table_full_name(table_name_prefix, short_name),
			WaiterConfig={"Delay": 2, "MaxAttempts": 60})
	return architect_check(client, table_name_prefix)


# ---------------------------------------------------------------------------
# aws backend resources beyond the tables: cognito app client, lambda,
# http api, search index. everything below runs on the deploy machine only.
# ---------------------------------------------------------------------------

def name_prefix_of(config):
	return config.get("name_prefix", "tab-cloud")


def names_build(name_prefix):
	return {
		"app_client": f"{name_prefix}-extension",
		"role": f"{name_prefix}-api-role",
		"lambda": f"{name_prefix}-api",
		"api": f"{name_prefix}-api",
	}


def aws_client_make(config, service, region_name=None):
	aws = config.get("aws", {})
	return boto3.client(
		service,
		region_name=region_name or aws.get("region_name"),
		aws_access_key_id=aws.get("access_key_id"),
		aws_secret_access_key=aws.get("secret_access_key"),
	)


def aws_oa_dir_of(config):
	project_dir = config.get("aws_oa", {}).get("project_dir")
	if not project_dir or not os.path.isdir(project_dir):
		raise SystemExit(
			"aws_oa.project_dir is not set or does not exist; point it at the"
			" aws_oa project in config.0.yaml (the auth and local es"
			" sub-projects live there)")
	return project_dir


def aws_utils_import(config):
	# the shared ensure helpers of the aws_oa project (refer to
	# aws_oa.md#arthitecture-ensurement); imported from the package top level
	sys.path.insert(0, aws_oa_dir_of(config))
	import aws_utils
	return aws_utils


def aws_oa_gen_load(config, sub_name):
	# config_gen.yaml of one aws_oa sub-project: the generated resource ids
	# (user pool id, queue url, ...) this backend builds upon
	import yaml
	path = os.path.join(aws_oa_dir_of(config), sub_name, "config_gen.yaml")
	if not os.path.exists(path):
		raise SystemExit(
			f"{path} not found: run ensure_architect.py of {sub_name} first")
	with open(path, "r", encoding="utf-8") as gen_file:
		return yaml.safe_load(gen_file) or {}


def config_gen_save(config_gen):
	import yaml
	path = os.path.join(DIR_SELF, "config_gen.yaml")
	with open(path, "w", encoding="utf-8") as gen_file:
		yaml.safe_dump(config_gen, gen_file, sort_keys=False)
	print(f"generated config written: {path}")


# ---------------------------------------------------- cognito app client

# the extension logs in with username/password against cognito directly and
# then refreshes silently, so its app client needs these two explicit flows
EXTENSION_AUTH_FLOWS = ["ALLOW_USER_PASSWORD_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"]


def app_client_find(cognito, pool_id, client_name):
	paginator = cognito.get_paginator("list_user_pool_clients")
	for page in paginator.paginate(UserPoolId=pool_id, MaxResults=60):
		for client in page["UserPoolClients"]:
			if client["ClientName"] == client_name:
				return client["ClientId"]
	return None


def app_client_ensure(cognito, pool_id, client_name, refresh_token_valid_days):
	desired = {
		"ClientName": client_name,
		"ExplicitAuthFlows": EXTENSION_AUTH_FLOWS,
		"RefreshTokenValidity": refresh_token_valid_days,
		"TokenValidityUnits": {"RefreshToken": "days"},
	}
	client_id = app_client_find(cognito, pool_id, client_name)
	if client_id is None:
		client_id = cognito.create_user_pool_client(
			UserPoolId=pool_id, GenerateSecret=False, **desired,
		)["UserPoolClient"]["ClientId"]
		print(f"app client created: {client_name} ({client_id})")
		return client_id
	existing = cognito.describe_user_pool_client(
		UserPoolId=pool_id, ClientId=client_id)["UserPoolClient"]
	is_same = (
		sorted(existing.get("ExplicitAuthFlows", [])) == sorted(EXTENSION_AUTH_FLOWS)
		and existing.get("RefreshTokenValidity") == refresh_token_valid_days
		and existing.get("TokenValidityUnits", {}).get("RefreshToken") == "days"
	)
	if is_same:
		print(f"app client already exists: {client_name} ({client_id}), ok")
	else:
		# this client is fully managed here, so sending only the desired
		# fields (update resets unmanaged fields to their defaults) is fine
		cognito.update_user_pool_client(
			UserPoolId=pool_id, ClientId=client_id, **desired)
		print(f"app client updated: {client_name} ({client_id})")
	return client_id


def app_client_delete(cognito, pool_id, client_name):
	client_id = app_client_find(cognito, pool_id, client_name)
	if client_id is None:
		print(f"app client does not exist: {client_name}")
		return
	cognito.delete_user_pool_client(UserPoolId=pool_id, ClientId=client_id)
	print(f"app client deleted: {client_name}")


# ------------------------------------------------------------- api lambda

# the lambda zip, flat: the handler, the shared core, and the storage/index
# layers it imports. boto3 comes with the lambda runtime.
LAMBDA_FILE_LIST = [
	"lambda_tab/lambda_function.py",
	"tab_server_db.py",
	"tab_server_index_sqs.py",
	"ensure_architect.py",
	"../backend/tab_server_core.py",
	"../backend/tab_server_check.py",
]


def lambda_zip_build():
	buffer = io.BytesIO()
	with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zip_file:
		for file_path in LAMBDA_FILE_LIST:
			path_full = os.path.join(DIR_SELF, file_path)
			zip_file.write(path_full, os.path.basename(file_path))
	return buffer.getvalue()


def role_policy_build(region, account_id, table_name_prefix,
					  user_table_arn, queue_arn, result_table_arn):
	table_arn_prefix = f"arn:aws:dynamodb:{region}:{account_id}:table/{table_name_prefix}"
	return {
		"Version": "2012-10-17",
		"Statement": [
			{
				"Sid": "TabCloudTables",
				"Effect": "Allow",
				"Action": [
					"dynamodb:CreateTable",
					"dynamodb:DescribeTable",
					"dynamodb:GetItem",
					"dynamodb:PutItem",
					"dynamodb:DeleteItem",
					"dynamodb:Query",
					"dynamodb:TransactWriteItems",
				],
				"Resource": [f"{table_arn_prefix}*", f"{table_arn_prefix}*/index/*"],
			},
			{
				"Sid": "UserTableRead",
				"Effect": "Allow",
				"Action": ["dynamodb:Query"],
				"Resource": [user_table_arn, f"{user_table_arn}/index/*"],
			},
			{
				"Sid": "EsTaskSend",
				"Effect": "Allow",
				"Action": ["sqs:SendMessage"],
				"Resource": [queue_arn],
			},
			{
				"Sid": "EsResultRead",
				"Effect": "Allow",
				"Action": ["dynamodb:GetItem"],
				"Resource": [result_table_arn],
			},
			{
				"Sid": "Logs",
				"Effect": "Allow",
				"Action": [
					"logs:CreateLogGroup",
					"logs:CreateLogStream",
					"logs:PutLogEvents",
				],
				"Resource": "arn:aws:logs:*:*:*",
			},
		],
	}


def options_route_ensure(apigw, api_id, integration_id):
	# the browser's cors preflight carries no Authorization header, and the
	# jwt-authorized ANY route would reject it with 401 (a preflight must get
	# 2xx). so OPTIONS gets its own route without authorization; the lambda
	# answers it with an empty 204 and the api gateway attaches the cors
	# headers of its cors configuration.
	route_key = "OPTIONS /api/{proxy+}"
	target = f"integrations/{integration_id}"
	for route in apigw.get_routes(ApiId=api_id)["Items"]:
		if route["RouteKey"] == route_key:
			print(f"route already exists: {route_key}, ok")
			return
	apigw.create_route(
		ApiId=api_id, RouteKey=route_key, Target=target, AuthorizationType="NONE")
	print(f"route created: {route_key}")


def lambda_env_build(config, cognito_gen, es_gen):
	local_es = config.get("local_es", {})
	return {
		"TABLE_NAME_PREFIX": table_name_prefix_of(config),
		"TABLE_USER": cognito_gen["user_table"]["table_name"],
		"ES_REGION": es_gen["region_name"],
		"ES_QUEUE_URL": es_gen["queue_task"]["queue_url"],
		"ES_RESULT_TABLE": es_gen["table_result"]["table_name"],
		"ES_INDEX_NAME": local_es.get("index_name", "tab_cloud_tab"),
		"ES_RESULT_TIMEOUT_SEC": str(local_es.get("result_timeout", 20)),
		"ES_RESULT_POLL_SEC": str(local_es.get("result_poll_interval", 0.25)),
	}


# -------------------------------------------------- index on local es service

def es_index_module_make(config, es_gen):
	# the same index adapter the lambda uses, configured with the deploy
	# machine's credentials, for ensuring/checking the index from this script
	import tab_server_index_sqs as index_sqs
	aws = config.get("aws", {})
	local_es = config.get("local_es", {})
	index_sqs.init_index({
		"queue_url": es_gen["queue_task"]["queue_url"],
		"table_result": es_gen["table_result"]["table_name"],
		"index_name": local_es.get("index_name", "tab_cloud_tab"),
		"region_name": es_gen["region_name"],
		"access_key_id": aws.get("access_key_id"),
		"secret_access_key": aws.get("secret_access_key"),
		"result_timeout": local_es.get("result_timeout", 20),
		"result_poll_interval": local_es.get("result_poll_interval", 0.25),
	})
	return index_sqs


def es_service_check(config, es_gen):
	# aws side: the task queue and the result table of the local es service
	# exist. local side: the worker on the home server answers a roundtrip.
	from tab_server_index_sqs import IndexUnavailableError

	sqs = aws_client_make(config, "sqs", es_gen["region_name"])
	queue_name = es_gen["queue_task"]["queue_name"]
	try:
		sqs.get_queue_url(QueueName=queue_name)
		print(f"es task queue: {queue_name}, ok")
	except Exception as error:
		print(f"es task queue: {queue_name}, MISSING ({error})")
		return

	db_client = aws_client_make(config, "dynamodb", es_gen["region_name"])
	table_result = es_gen["table_result"]["table_name"]
	try:
		db_client.describe_table(TableName=table_result)
		print(f"es result table: {table_result}, ok")
	except Exception as error:
		print(f"es result table: {table_result}, MISSING ({error})")
		return

	index_sqs = es_index_module_make(config, es_gen)
	try:
		status = index_sqs.index_check()
	except IndexUnavailableError as error:
		print(f"es worker roundtrip: FAILED ({error})")
		return
	if not status["isOk"]:
		print(f"es worker roundtrip: FAILED ({status['message']})")
		return
	print("es worker roundtrip: ok (the home server worker answered)")
	if not status["isExisting"]:
		print(f"es index {status['indexName']}: MISSING, run ensure to create it")
	elif status["isConfigConsistent"] is not True:
		print(f"es index {status['indexName']}: configuration differs:"
			  f" {status['configIssueList']}")
	else:
		print(f"es index {status['indexName']}: ok,"
			  f" {status['documentCount']} document(s)")


# ------------------------------------------------------- ensure / check / delete

def table_status_print(table_status_list):
	for table_status in table_status_list:
		if table_status["isReady"]:
			print(f"{table_status['tableName']}: ok")
			continue
		print(f"{table_status['tableName']}: {table_status['statusText']}")
		for issue_text in table_status["configIssueList"]:
			print(f"  issue: {issue_text}")


def architecture_ensure(config):
	utils = aws_utils_import(config)
	cognito_gen = aws_oa_gen_load(config, "_0_auth_cognito")
	es_gen = aws_oa_gen_load(config, "_2_local_es")
	names = names_build(name_prefix_of(config))
	region = config["aws"]["region_name"]
	pool_id = cognito_gen["cognito"]["user_pool_id"]
	pool_region = pool_id.split("_")[0]

	print("== dynamodb tables")
	table_status_print(architect_ensure(
		dynamodb_client_make(config), table_name_prefix_of(config)))

	print("== cognito app client of the extension")
	cognito = aws_client_make(config, "cognito-idp", pool_region)
	client_id = app_client_ensure(
		cognito, pool_id, names["app_client"],
		int(config.get("cognito", {}).get("refresh_token_valid_days", 90)))

	print("== api lambda")
	account_id = aws_client_make(config, "sts").get_caller_identity()["Account"]
	user_table_arn = (f"arn:aws:dynamodb:{pool_region}:{account_id}:table/"
					  f"{cognito_gen['user_table']['table_name']}")
	iam = aws_client_make(config, "iam")
	role_arn = utils.lambda_role_ensure(iam, names["role"], role_policy_build(
		region, account_id, table_name_prefix_of(config),
		user_table_arn,
		es_gen["queue_task"]["queue_arn"],
		es_gen["table_result"]["table_arn"],
	))
	lambda_client = aws_client_make(config, "lambda")
	lambda_config = {
		"runtime": config.get("lambda", {}).get("runtime", "python3.12"),
		"memory_mb": int(config.get("lambda", {}).get("memory_mb", 256)),
		"timeout_sec": int(config.get("lambda", {}).get("timeout_sec", 30)),
	}
	lambda_arn = utils.lambda_function_ensure(
		lambda_client, names["lambda"], lambda_config, role_arn,
		lambda_env_build(config, cognito_gen, es_gen), lambda_zip_build())

	print("== api gateway http api")
	apigw = aws_client_make(config, "apigatewayv2")
	api_id, api_endpoint = utils.http_api_ensure(apigw, names["api"])
	authorizer_id = utils.jwt_authorizer_ensure(
		apigw, api_id,
		f"https://cognito-idp.{pool_region}.amazonaws.com/{pool_id}", client_id)
	integration_id = utils.lambda_integration_ensure(apigw, api_id, lambda_arn)
	utils.api_route_ensure(
		apigw, api_id, "ANY /api/{proxy+}", integration_id, authorizer_id)
	options_route_ensure(apigw, api_id, integration_id)
	utils.api_stage_ensure(apigw, api_id)
	utils.lambda_invoke_permission_ensure(
		lambda_client, names["lambda"], region, account_id, api_id)

	print("== search index on the local es service")
	index_sqs = es_index_module_make(config, es_gen)
	index_name = config.get("local_es", {}).get("index_name", "tab_cloud_tab")
	try:
		index_sqs.index_ensure()
		print(f"es index ensured: {index_name}")
	except Exception as error:
		# a down home worker must not fail the aws-side deploy; the index can
		# be ensured later by re-running this script or the indexInit api
		print(f"es index NOT ensured (is the home server worker running?): {error}")

	config_gen_save({
		"api": {"api_id": api_id, "endpoint": api_endpoint},
		"cognito": {
			"user_pool_id": pool_id,
			"region": pool_region,
			"app_client_id": client_id,
		},
		"lambda": {"function_name": names["lambda"], "arn": lambda_arn},
	})
	print("\nthe extension connects with:")
	print(f"  api endpoint:  {api_endpoint}")
	print(f"  cognito region / client id: {pool_region} / {client_id}")


def architecture_check(config):
	cognito_gen = aws_oa_gen_load(config, "_0_auth_cognito")
	es_gen = aws_oa_gen_load(config, "_2_local_es")
	names = names_build(name_prefix_of(config))
	pool_id = cognito_gen["cognito"]["user_pool_id"]
	pool_region = pool_id.split("_")[0]

	print("== dynamodb tables")
	table_status_print(architect_check(
		dynamodb_client_make(config), table_name_prefix_of(config)))

	print("== cognito app client")
	cognito = aws_client_make(config, "cognito-idp", pool_region)
	client_id = app_client_find(cognito, pool_id, names["app_client"])
	print(f"{names['app_client']}: {'ok, ' + client_id if client_id else 'MISSING'}")

	print("== api lambda")
	lambda_client = aws_client_make(config, "lambda")
	try:
		lambda_client.get_function(FunctionName=names["lambda"])
		print(f"{names['lambda']}: ok")
	except lambda_client.exceptions.ResourceNotFoundException:
		print(f"{names['lambda']}: MISSING")

	print("== api gateway http api")
	utils = aws_utils_import(config)
	apigw = aws_client_make(config, "apigatewayv2")
	api = utils.http_api_find(apigw, names["api"])
	print(f"{names['api']}: {'ok, ' + api['ApiEndpoint'] if api else 'MISSING'}")

	print("== local es service and search index")
	es_service_check(config, es_gen)


def architecture_delete(config, name_prefix):
	utils = aws_utils_import(config)
	cognito_gen = aws_oa_gen_load(config, "_0_auth_cognito")
	es_gen = aws_oa_gen_load(config, "_2_local_es")
	names = names_build(name_prefix)
	table_name_prefix = table_name_prefix_of(config)
	pool_id = cognito_gen["cognito"]["user_pool_id"]
	pool_region = pool_id.split("_")[0]

	utils.delete_confirm(
		f"this deletes the http api, lambda, role and app client of prefix"
		f" '{name_prefix}', the dynamodb tables of prefix '{table_name_prefix}'"
		f" WITH ALL THEIR DATA, and the search index on the local es service.")

	apigw = aws_client_make(config, "apigatewayv2")
	utils.http_api_delete(apigw, names["api"])
	lambda_client = aws_client_make(config, "lambda")
	utils.lambda_delete(lambda_client, names["lambda"])
	iam = aws_client_make(config, "iam")
	utils.lambda_role_delete(iam, names["role"])
	cognito = aws_client_make(config, "cognito-idp", pool_region)
	app_client_delete(cognito, pool_id, names["app_client"])

	index_sqs = es_index_module_make(config, es_gen)
	try:
		index_sqs.index_delete()
		print("es index deleted")
	except Exception as error:
		print(f"es index NOT deleted (is the home server worker running?): {error}")

	client = dynamodb_client_make(config)
	for short_name in TABLE_SPECS:
		full_name = table_full_name(table_name_prefix, short_name)
		try:
			client.delete_table(TableName=full_name)
			print(f"table deleted: {full_name}")
		except client.exceptions.ResourceNotFoundException:
			print(f"table does not exist: {full_name}")


# ----------------------------------------------------------------------- main

def main():
	import argparse
	parser = argparse.ArgumentParser(description="tab cloud aws backend IaC")
	parser.add_argument("--tables", action="store_true",
						help="ensure the dynamodb tables only")
	parser.add_argument("--check", action="store_true",
						help="inspect everything, change nothing")
	parser.add_argument("--delete", choices=["all"],
						help="remove the aws backend (typed confirmation)")
	parser.add_argument("--assume-prefix",
						help="operate on resources of this name_prefix instead"
							 " of the configured one (delete only)")
	args = parser.parse_args()

	config = config_load()
	if args.delete:
		architecture_delete(config, args.assume_prefix or name_prefix_of(config))
	elif args.check:
		architecture_check(config)
	elif args.tables:
		table_status_print(architect_ensure(
			dynamodb_client_make(config), table_name_prefix_of(config)))
	else:
		architecture_ensure(config)


if __name__ == "__main__":
	main()
