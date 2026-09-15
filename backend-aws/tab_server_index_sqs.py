
# Index layer of tab cloud over the local es service (aws_oa sub-project
# _2_local_es): same general api as backend/tab_server_index.py, but instead
# of talking to elasticsearch directly, every action is sent as a task into
# the service's sqs task queue; the worker on the home server runs it on the
# local elasticsearch and writes the result into the service's result table.
#
#   index_ensure / index_recreate / index_check
#   doc_put / doc_delete / doc_put_batch / doc_delete_batch
#   search(user_id, query_tree, field_list, is_trashed, limit)
#   tag_name_put / tag_name_search      (tag name index of the tag service)
#
# document writes are enqueue-and-return: enqueue success counts as write
# success, the fifo queue keeps the write order per index, and the worker
# applies the writes when it is up. so a down home server delays search index
# convergence but never blocks tab writes. search and index_* wait for the
# worker's result and fail with IndexUnavailableError on timeout.
# refer to aws_backend_impl.md#index-over-the-local-es-service.

import json
import random
import string
import time

import boto3


class IndexUnavailableError(Exception):
	pass


INDEX_CONFIG_NAME = "char"

# field_config of the char index config, mirroring the mappings of
# backend/tab_server_index.py (userId/isTrashed/contentRevision are exact
# filter fields, title/url are char-level search fields)
FIELD_CONFIG = {
	"field_list_char": ["title", "url"],
	"field_list_exact": [
		{"name": "userId", "type": "keyword"},
		{"name": "isTrashed", "type": "boolean"},
		{"name": "contentRevision", "type": "long"},
	],
}

_sqs = None
_db = None
_queue_url = None
_table_result = None
_index_name = "tab_cloud_tab"
_index_tag_name = "3_tag"
_result_timeout_sec = 20.0
_result_poll_sec = 0.25


def init_index(index_config):
	"""index_config: {queue_url, table_result, index_name, index_tag_name?,
	region_name?, access_key_id?, secret_access_key?, result_timeout?,
	result_poll_interval?}. the lambda builds it from env, ensure_architect.py
	builds it from the local es service's config_gen.yaml."""
	global _sqs, _db, _queue_url, _table_result, _index_name, _index_tag_name
	global _result_timeout_sec, _result_poll_sec
	kwargs = {}
	if index_config.get("region_name"):
		kwargs["region_name"] = index_config["region_name"]
	if index_config.get("access_key_id"):
		kwargs["aws_access_key_id"] = index_config["access_key_id"]
		kwargs["aws_secret_access_key"] = index_config["secret_access_key"]
	_sqs = boto3.client("sqs", **kwargs)
	_db = boto3.client("dynamodb", **kwargs)
	_queue_url = index_config["queue_url"]
	_table_result = index_config["table_result"]
	_index_name = index_config.get("index_name", "tab_cloud_tab")
	_index_tag_name = index_config.get("index_tag_name") or "3_tag"
	_result_timeout_sec = float(index_config.get("result_timeout", 20))
	_result_poll_sec = float(index_config.get("result_poll_interval", 0.25))


# ---------------------------------------------------------------------------
# task send + result wait (the request/response protocol of the local es
# service, refer to _2_local_es/local_es_impl.md)
# ---------------------------------------------------------------------------

def _task_id_make():
	return "".join(random.choices(string.digits + string.ascii_lowercase, k=16))


def _task_send(action, payload, message_group=None):
	task_id = _task_id_make()
	task = {"task_id": task_id, "action": action, "payload": payload}
	try:
		_sqs.send_message(
			QueueUrl=_queue_url,
			MessageBody=json.dumps(task),
			# fifo: keeps the write order per index
			MessageGroupId=message_group or _index_name,
			MessageDeduplicationId=task_id,
		)
	except Exception as error:
		raise IndexUnavailableError(f"cannot enqueue index task: {error}")
	return task_id


def _result_wait(task_id):
	deadline = time.monotonic() + _result_timeout_sec
	while time.monotonic() < deadline:
		try:
			response = _db.get_item(
				TableName=_table_result, Key={"task_id": {"S": task_id}})
		except Exception as error:
			raise IndexUnavailableError(f"cannot read index task result: {error}")
		if "Item" in response:
			return json.loads(response["Item"]["result"]["S"])
		time.sleep(_result_poll_sec)
	raise IndexUnavailableError(
		f"no result after {_result_timeout_sec}s,"
		" is the es worker running on the home server?")


def _task_run(action, payload, message_group=None):
	result = _result_wait(_task_send(action, payload, message_group))
	if result.get("code", -1) != 0:
		raise IndexUnavailableError(result.get("message") or f"{action} failed")
	return result.get("data")


# ---------------------------------------------------------------------------
# index
# ---------------------------------------------------------------------------

def index_ensure():
	return _task_run("index_ensure", {
		"index_name": _index_name,
		"config_name": INDEX_CONFIG_NAME,
		"field_config": FIELD_CONFIG,
	})


def index_recreate():
	return _task_run("index_recreate", {
		"index_name": _index_name,
		"config_name": INDEX_CONFIG_NAME,
		"field_config": FIELD_CONFIG,
	})


def index_delete():
	# used by ensure_architect.py --delete only, not by any api
	return _task_run("index_delete", {"index_name": _index_name})


def index_check():
	# same status shape as tab_server_index.index_check. the worker's
	# index_check only answers existence + count; config consistency is then
	# verified by re-ensuring: the worker accepts its own index (created from
	# the same config) and refuses a foreign or differing one.
	try:
		data = _task_run("index_check", {"index_name": _index_name})
	except IndexUnavailableError as error:
		return _index_status_error(str(error))
	if not data.get("is_existing"):
		return {
			"isOk": True,
			"isExisting": False,
			"isConfigConsistent": None,
			"indexName": _index_name,
			"documentCount": None,
			"configIssueList": [],
			"message": "",
		}
	config_issue_list = []
	try:
		index_ensure()
	except IndexUnavailableError as error:
		config_issue_list.append(str(error))
	return {
		"isOk": True,
		"isExisting": True,
		"isConfigConsistent": len(config_issue_list) == 0,
		"indexName": _index_name,
		"documentCount": data.get("doc_count"),
		"configIssueList": config_issue_list,
		"message": "",
	}


def _index_status_error(message):
	return {
		"isOk": False,
		"isExisting": False,
		"isConfigConsistent": None,
		"indexName": _index_name,
		"documentCount": None,
		"configIssueList": [],
		"message": message,
	}


# ---------------------------------------------------------------------------
# documents (enqueue-and-return, refer to the module comment)
# ---------------------------------------------------------------------------

def _doc_of_tab(tab):
	return {
		"userId": tab["userId"],
		"title": tab.get("title", ""),
		"url": tab.get("url", ""),
		"isTrashed": tab.get("trashAt") is not None,
		"contentRevision": tab.get("contentRevision", 0),
	}


def doc_put(tab):
	_task_send("doc_put", {
		"index_name": _index_name, "doc_id": tab["id"], "doc": _doc_of_tab(tab)})


def doc_delete(tab_id):
	_task_send("doc_delete", {"index_name": _index_name, "doc_id": tab_id})


def doc_put_batch(tab_list):
	if not tab_list:
		return
	_task_send("doc_put_batch", {
		"index_name": _index_name,
		"doc_list": [
			{"doc_id": tab["id"], "doc": _doc_of_tab(tab)} for tab in tab_list],
	})


def doc_delete_batch(tab_id_list):
	if not tab_id_list:
		return
	_task_send("doc_delete_batch", {
		"index_name": _index_name, "doc_id_list": tab_id_list})


# ---------------------------------------------------------------------------
# search
# ---------------------------------------------------------------------------

def search(user_id, query_tree, field_list, is_trashed, limit):
	# returns [{"tabId": ..., "matchList": [{"field", "indexStart", "indexEnd"}]}]
	data = _task_run("search", {
		"index_name": _index_name,
		"config_name": INDEX_CONFIG_NAME,
		"query_tree": query_tree,
		"field_list": field_list,
		"filter_exact": {"userId": user_id, "isTrashed": bool(is_trashed)},
		"limit": limit,
	})
	return [
		{"tabId": hit["doc_id"], "matchList": _match_list_response(hit)}
		for hit in data or []
	]


def _match_list_response(hit):
	return [
		{
			"field": match["field"],
			"indexStart": match["index_start"],
			"indexEnd": match["index_end"],
		}
		for match in hit.get("match_list", [])
	]


# ---------------------------------------------------------------------------
# tag name index: the 3_tag index of the tag service (aws_oa _3_tag_and_type)
# on the same local es service. its doc shape is {name, user_id}, doc id = tag
# id. unlike the tab document writes above, tag_name_put WAITS for the
# worker's confirmation: the tag service design indexes the name first and
# only touches dynamodb after the index is confirmed, so a tag is never
# created without being char-searchable. refer to tab_cloud.md#tags.
# ---------------------------------------------------------------------------

def tag_name_put(tag_id, name, user_id):
	_task_run("doc_put", {
		"index_name": _index_tag_name,
		"doc_id": tag_id,
		"doc": {"name": name, "user_id": user_id},
	}, message_group=_index_tag_name)


def tag_name_search(user_id, query_text, limit):
	# returns [{"tagId": ..., "matchList": [{"field", "indexStart", "indexEnd"}]}]
	data = _task_run("search", {
		"index_name": _index_tag_name,
		"config_name": INDEX_CONFIG_NAME,
		"query_tree": query_text,
		"field_list": ["name"],
		"filter_exact": {"user_id": user_id},
		"limit": limit,
	}, message_group=_index_tag_name)
	return [
		{"tagId": hit["doc_id"], "matchList": _match_list_response(hit)}
		for hit in data or []
	]
