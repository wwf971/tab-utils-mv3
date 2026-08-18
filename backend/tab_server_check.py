"""Bounded in-memory history of backend configuration checks."""

import copy
import threading
import time


CHECK_TYPE_TABLES = "dynamodbTables"
CHECK_TYPE_INDEX = "searchIndex"
CHECK_TYPE_REQUIRED_FOR_UPLOAD = (CHECK_TYPE_TABLES, CHECK_TYPE_INDEX)
CHECK_HISTORY_LIMIT = 50

_check_list = []
_check_sequence = 0
_check_lock = threading.Lock()


def check_record(check_type, is_passed, result, trigger):
	global _check_sequence
	with _check_lock:
		_check_sequence += 1
		check_at_ms = int(time.time() * 1000)
		record = {
			"checkId": f"{check_at_ms:013d}-{_check_sequence}",
			"checkType": check_type,
			"checkAtMs": check_at_ms,
			"isPassed": bool(is_passed),
			"trigger": trigger,
			"result": copy.deepcopy(result),
		}
		_check_list.insert(0, record)
		del _check_list[CHECK_HISTORY_LIMIT:]
		return copy.deepcopy(record)


def check_history(limit=20):
	limit_valid = min(CHECK_HISTORY_LIMIT, max(1, int(limit)))
	with _check_lock:
		check_list_all = copy.deepcopy(_check_list)
	return _history_data(check_list_all[:limit_valid], check_list_all)


def _history_data(check_list, check_list_all):
	latest_by_type = {}
	for record in check_list_all:
		check_type = record["checkType"]
		if check_type not in latest_by_type:
			latest_by_type[check_type] = record

	is_upload_allowed = True
	upload_block_reason = ""
	for check_type in CHECK_TYPE_REQUIRED_FOR_UPLOAD:
		record = latest_by_type.get(check_type)
		if record is None:
			is_upload_allowed = False
			upload_block_reason = "Cloud configuration has not been checked"
			break
		if not record["isPassed"]:
			is_upload_allowed = False
			upload_block_reason = _check_failure_reason(record)
			break

	return {
		"checkList": check_list,
		"latestByType": latest_by_type,
		"isUploadAllowed": is_upload_allowed,
		"uploadBlockReason": upload_block_reason,
	}


def _check_failure_reason(record):
	if record["checkType"] == CHECK_TYPE_TABLES:
		return "DynamoDB table configuration check did not pass"
	if record["checkType"] == CHECK_TYPE_INDEX:
		return "Search index configuration check did not pass"
	return "Cloud configuration check did not pass"
