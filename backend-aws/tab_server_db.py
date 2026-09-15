
# DynamoDB layer of tab cloud: tables, item access, transactions, lexorank, journal.
# Refer to tab_cloud.md for the table formats and the consistency design.
#
# Besides its own tables, this layer also reads/writes three tables of the
# external tag service (aws_oa sub-project _3_tag_and_type): the tag entity
# table, the obj-tag attach table and the obj-tag history table. They join the
# same TransactWriteItems calls as the tab items (dynamodb transactions span
# tables), which is what keeps "delete a tab + delete its attach entries"
# atomic. Refer to tab_cloud.md#tags.

import base64
import json
import random
import string
import time

import boto3
from boto3.dynamodb.conditions import Key
from boto3.dynamodb.types import TypeSerializer, TypeDeserializer
from botocore.exceptions import ClientError, EndpointConnectionError, ConnectTimeoutError

import ensure_architect as architect


class DbUnavailableError(Exception):
	pass


class DbConflictError(Exception):
	# a transaction condition failed, for example a rank collision
	pass


RANK_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz"
RANK_BASE = len(RANK_ALPHABET)

LIVE_PREFIX = "live#"
TRASH_PREFIX = "trash#"

_resource = None
_client = None
_serializer = TypeSerializer()
_deserializer = TypeDeserializer()
_table_name_prefix = "tabCloud"
# short name -> physical name of the tag service tables (they carry the tag
# service's own name prefix, so they are configured, not prefix-derived)
_tag_service_table_names = {}


def init_db(config):
	global _resource, _client, _table_name_prefix, _tag_service_table_names
	aws = config.get("aws", {})
	kwargs = {
		"region_name": aws.get("region_name"),
		"aws_access_key_id": aws.get("access_key_id"),
		"aws_secret_access_key": aws.get("secret_access_key"),
	}
	endpoint_url = aws.get("dynamodb", {}).get("endpoint_url")
	if endpoint_url:
		kwargs["endpoint_url"] = endpoint_url
	_resource = boto3.resource("dynamodb", **kwargs)
	_client = boto3.client("dynamodb", **kwargs)
	_table_name_prefix = aws.get("dynamodb", {}).get("table_name_prefix", "tabCloud")
	tag_service = config.get("tag_service", {}) or {}
	_tag_service_table_names = {
		"TagEntity": tag_service.get("table_tag") or "",
		"ObjTag": tag_service.get("table_obj_tag") or "",
		"ObjTagHistory": tag_service.get("table_obj_tag_history") or "",
	}


def table_name(short_name):
	if short_name in _tag_service_table_names:
		full_name = _tag_service_table_names[short_name]
		if not full_name:
			raise DbUnavailableError(
				"tag service tables are not configured,"
				" re-run ensure_architect.py (refer to aws_backend_impl.md)")
		return full_name
	return _table_name_prefix + short_name


def _table(short_name):
	return _resource.Table(table_name(short_name))


def _wrap_db_error(error):
	if isinstance(error, (EndpointConnectionError, ConnectTimeoutError)):
		return DbUnavailableError(str(error))
	if isinstance(error, ClientError):
		error_code = error.response.get("Error", {}).get("Code", "")
		if error_code in ("ResourceNotFoundException",):
			return DbUnavailableError(f"table missing: {error_code}. run awsInit first")
		if error_code in ("TransactionCanceledException", "ConditionalCheckFailedException"):
			return DbConflictError(str(error))
	return error


# ---------------------------------------------------------------------------
# ids, time, lexorank
# ---------------------------------------------------------------------------

def make_id(length=8):
	return "".join(random.choices(RANK_ALPHABET, k=length))


def now_ms():
	return int(time.time() * 1000)


def now_timezone_hour():
	return -time.timezone // 3600


def now_timezone_minute():
	# the tag service tables store timezones in signed minutes (time-format.md)
	return -time.timezone // 60


def _rank_digit(rank_text, index, default_value):
	if index < len(rank_text):
		return RANK_ALPHABET.index(rank_text[index])
	return default_value


def rank_between(rank_prev, rank_next):
	# returns a rank strictly between the two neighbors.
	# rank_prev '' means no lower neighbor, rank_next '' means no upper neighbor.
	result = []
	index = 0
	is_next_unbounded = rank_next == ""
	while True:
		digit_prev = _rank_digit(rank_prev, index, 0)
		digit_next = RANK_BASE if is_next_unbounded else _rank_digit(rank_next, index, 0)
		if digit_prev == digit_next:
			result.append(RANK_ALPHABET[digit_prev])
			index += 1
			continue
		digit_mid = (digit_prev + digit_next) // 2
		if digit_mid > digit_prev:
			result.append(RANK_ALPHABET[digit_mid])
			return "".join(result)
		# adjacent digits: keep the lower digit; any continuation stays below
		# rank_next, so only the lower bound constrains from here on.
		result.append(RANK_ALPHABET[digit_prev])
		is_next_unbounded = True
		index += 1


def rank_list_between(rank_prev, rank_next, count):
	ranks = []
	rank_last = rank_prev
	for _ in range(count):
		rank_new = rank_between(rank_last, rank_next)
		ranks.append(rank_new)
		rank_last = rank_new
	return ranks


def tag_rank_between(rank_low, rank_high):
	# lexorank of the tag service's attach entries: same 0-9a-z alphabet, but
	# following that service's rule that a rank never ends with '0', so a gap
	# always exists below every rank (refer to
	# _3_tag_and_type/tag_type_service_impl.md#core-concepts)
	result = ""
	position = 0
	while True:
		digit_low = RANK_ALPHABET.index(rank_low[position]) if position < len(rank_low) else 0
		digit_high = RANK_ALPHABET.index(rank_high[position]) if position < len(rank_high) else RANK_BASE
		if digit_high - digit_low > 1:
			return result + RANK_ALPHABET[(digit_low + digit_high) // 2]
		# digits equal or adjacent: keep the low digit and go one char deeper
		result += RANK_ALPHABET[digit_low]
		position += 1


def tab_path_live(window_id, tab_rank):
	return f"{LIVE_PREFIX}{window_id}#{tab_rank}"


def tab_path_trash(trash_at, item_id):
	return f"{TRASH_PREFIX}{trash_at:013d}#{item_id}"


def window_path_live(window_rank):
	return f"{LIVE_PREFIX}{window_rank}"


def rank_of_tab_path(tab_path):
	# live#{windowId}#{rank} -> rank
	return tab_path.split("#", 2)[2]


def window_id_of_tab_path(tab_path):
	return tab_path.split("#", 2)[1]


# ---------------------------------------------------------------------------
# generic query helpers
# ---------------------------------------------------------------------------

def _plain(value):
	# DynamoDB Decimal -> int/float for json responses
	if isinstance(value, list):
		return [_plain(item) for item in value]
	if isinstance(value, dict):
		return {key: _plain(item) for key, item in value.items()}
	type_name = type(value).__name__
	if type_name == "Decimal":
		return int(value) if value % 1 == 0 else float(value)
	if isinstance(value, set):
		return sorted(_plain(item) for item in value)
	return value


def encode_cursor(last_key):
	if not last_key:
		return None
	return base64.urlsafe_b64encode(json.dumps(_plain(last_key)).encode()).decode()


def decode_cursor(cursor):
	if not cursor:
		return None
	return json.loads(base64.urlsafe_b64decode(cursor.encode()).decode())


def _query(short_name, limit=None, cursor=None, index_name=None,
			scan_forward=True, key_condition=None, filter_expression=None,
			select=None):
	kwargs = {
		"KeyConditionExpression": key_condition,
		"ScanIndexForward": scan_forward,
	}
	if limit:
		kwargs["Limit"] = limit
	if index_name:
		kwargs["IndexName"] = index_name
	if filter_expression is not None:
		kwargs["FilterExpression"] = filter_expression
	if select:
		kwargs["Select"] = select
	start_key = decode_cursor(cursor)
	if start_key:
		kwargs["ExclusiveStartKey"] = start_key
	try:
		response = _table(short_name).query(**kwargs)
	except Exception as error:
		raise _wrap_db_error(error)
	items = [_plain(item) for item in response.get("Items", [])]
	return items, encode_cursor(response.get("LastEvaluatedKey")), response


def _query_all(short_name, **kwargs):
	# follows pagination to the end; used for bounded sets like relations of one tag
	items_all = []
	cursor = None
	while True:
		items, cursor, _ = _query(short_name, cursor=cursor, **kwargs)
		items_all.extend(items)
		if not cursor:
			return items_all


# ---------------------------------------------------------------------------
# transactions: change lists that can be applied and reverted
# ---------------------------------------------------------------------------

def change_put(short_name, item_new, item_old=None, is_new_key=False):
	return {
		"op": "put", "table": short_name,
		"item_new": item_new, "item_old": item_old, "is_new_key": is_new_key,
	}


def change_delete(short_name, key, item_old):
	return {"op": "delete", "table": short_name, "key": key, "item_old": item_old}


def _serialize_item(item):
	return {name: _serializer.serialize(value) for name, value in item.items()
			if value is not None}


def key_of(short_name, item):
	key_names = _TABLE_KEY_NAMES[short_name]
	return {name: item[name] for name in key_names}


def transact_apply(changes):
	transact_items = []
	for change in changes:
		if change["op"] == "put":
			put_item = {
				"TableName": table_name(change["table"]),
				"Item": _serialize_item(change["item_new"]),
			}
			if change.get("is_new_key"):
				key_names = _TABLE_KEY_NAMES[change["table"]]
				put_item["ConditionExpression"] = f"attribute_not_exists({key_names[-1]})"
			transact_items.append({"Put": put_item})
		else:
			transact_items.append({"Delete": {
				"TableName": table_name(change["table"]),
				"Key": _serialize_item(change["key"]),
			}})
	if not transact_items:
		return
	if len(transact_items) > 100:
		raise DbConflictError("transaction too large")
	try:
		_client.transact_write_items(TransactItems=transact_items)
	except Exception as error:
		raise _wrap_db_error(error)


def transact_revert(changes):
	# best-effort compensation: restore old states, remove newly created keys
	revert_changes = []
	for change in changes:
		if change["op"] == "put":
			if change.get("item_old") is not None:
				revert_changes.append(change_put(change["table"], change["item_old"]))
			else:
				revert_changes.append(change_delete(
					change["table"], key_of(change["table"], change["item_new"]), None))
		else:
			if change.get("item_old") is not None:
				revert_changes.append(change_put(change["table"], change["item_old"]))
	transact_apply(revert_changes)


# ---------------------------------------------------------------------------
# journal (index intent log), stored in the meta table
# ---------------------------------------------------------------------------

def journal_item_make(user_id, tab_id_list):
	journal_at = now_ms()
	return {
		"userId": user_id,
		"metaPath": f"journal#{journal_at:013d}#{make_id(4)}",
		"tabIdList": list(tab_id_list),
		"createAt": journal_at,
	}


def journal_delete(user_id, meta_path):
	try:
		_table("Meta").delete_item(Key={"userId": user_id, "metaPath": meta_path})
	except Exception as error:
		raise _wrap_db_error(error)


def journal_list(user_id):
	return _query_all("Meta", key_condition=(
		Key("userId").eq(user_id) & Key("metaPath").begins_with("journal#")))


# ---------------------------------------------------------------------------
# meta config (default window etc)
# ---------------------------------------------------------------------------

def meta_config_get(user_id):
	try:
		response = _table("Meta").get_item(Key={"userId": user_id, "metaPath": "config"})
	except Exception as error:
		raise _wrap_db_error(error)
	return _plain(response.get("Item")) if response.get("Item") else None


def meta_config_put(user_id, config_item):
	item = {"userId": user_id, "metaPath": "config", **config_item}
	try:
		_table("Meta").put_item(Item=item)
	except Exception as error:
		raise _wrap_db_error(error)


# ---------------------------------------------------------------------------
# windows
# ---------------------------------------------------------------------------

def window_list(user_id, cursor=None, limit=100):
	items, cursor_next, _ = _query("Window", limit=limit, cursor=cursor, key_condition=(
		Key("userId").eq(user_id) & Key("windowPath").begins_with(LIVE_PREFIX)))
	return items, cursor_next


def window_trash_list(user_id, cursor=None, limit=100):
	items, cursor_next, _ = _query("Window", limit=limit, cursor=cursor,
		scan_forward=False, key_condition=(
			Key("userId").eq(user_id) & Key("windowPath").begins_with(TRASH_PREFIX)))
	return items, cursor_next


def window_get_by_id(user_id, window_id):
	items = _query_all("Window", index_name="gsiWindowId",
		key_condition=Key("id").eq(window_id))
	for item in items:
		if item.get("userId") == user_id:
			return item
	return None


def window_rank_last(user_id):
	items, _, _ = _query("Window", limit=1, scan_forward=False, key_condition=(
		Key("userId").eq(user_id) & Key("windowPath").begins_with(LIVE_PREFIX)))
	if not items:
		return ""
	return items[0]["windowPath"][len(LIVE_PREFIX):]


def window_item_make(user_id, title, window_rank):
	return {
		"userId": user_id,
		"windowPath": window_path_live(window_rank),
		"id": make_id(),
		"title": title or "",
		"createAt": now_ms(),
		"createAtTimezone": now_timezone_hour(),
	}


def window_tab_count(user_id, window_id):
	count_total = 0
	cursor = None
	while True:
		_, cursor, response = _query("Tab", cursor=cursor, select="COUNT",
			key_condition=(Key("userId").eq(user_id) &
				Key("tabPath").begins_with(f"{LIVE_PREFIX}{window_id}#")))
		count_total += response.get("Count", 0)
		if not cursor:
			return count_total


# ---------------------------------------------------------------------------
# tabs
# ---------------------------------------------------------------------------

def tab_list(user_id, window_id, cursor=None, limit=100):
	items, cursor_next, _ = _query("Tab", limit=limit, cursor=cursor, key_condition=(
		Key("userId").eq(user_id) &
		Key("tabPath").begins_with(f"{LIVE_PREFIX}{window_id}#")))
	return items, cursor_next


def tab_list_all_of_window(user_id, window_id):
	return _query_all("Tab", key_condition=(
		Key("userId").eq(user_id) &
		Key("tabPath").begins_with(f"{LIVE_PREFIX}{window_id}#")))


def trash_list(user_id, cursor=None, limit=100):
	items, cursor_next, _ = _query("Tab", limit=limit, cursor=cursor,
		scan_forward=False, key_condition=(
			Key("userId").eq(user_id) & Key("tabPath").begins_with(TRASH_PREFIX)))
	return items, cursor_next


def tab_get_by_id(user_id, tab_id):
	items = _query_all("Tab", index_name="gsiTabId", key_condition=Key("id").eq(tab_id))
	for item in items:
		if item.get("userId") == user_id:
			return item
	return None


def tab_get_by_path(user_id, tab_path):
	try:
		response = _table("Tab").get_item(Key={"userId": user_id, "tabPath": tab_path})
	except Exception as error:
		raise _wrap_db_error(error)
	return _plain(response.get("Item")) if response.get("Item") else None


def tab_range(user_id, tab_path_first, tab_path_last):
	# live tabs between two paths, both ends included
	return _query_all("Tab", key_condition=(
		Key("userId").eq(user_id) &
		Key("tabPath").between(tab_path_first, tab_path_last)))


def tab_list_all_of_user(user_id, cursor=None, limit=200):
	# live and trashed tabs together; used by index rebuild
	items, cursor_next, _ = _query("Tab", limit=limit, cursor=cursor,
		key_condition=Key("userId").eq(user_id))
	return items, cursor_next


def tab_get_by_ids(user_id, tab_id_list):
	tabs = []
	for tab_id in tab_id_list:
		tab = tab_get_by_id(user_id, tab_id)
		if tab:
			tabs.append(tab)
	return tabs


def tab_slice(user_id, window_id, tab_path, count, direction):
	# tabs strictly before/after one live tabPath, inside the same window
	prefix = f"{LIVE_PREFIX}{window_id}#"
	if direction == "after":
		condition = Key("tabPath").between(tab_path + "#", prefix + "~")
		scan_forward = True
	else:
		condition = Key("tabPath").between(prefix, tab_path)
		scan_forward = False
	items, _, _ = _query("Tab", limit=count + 1, scan_forward=scan_forward,
		key_condition=(Key("userId").eq(user_id) & condition))
	# the between bounds can include the center path itself; drop it
	items = [item for item in items if item["tabPath"] != tab_path]
	is_more = len(items) > count
	items = items[:count]
	if direction == "before":
		items.reverse()
	return items, is_more


def tab_neighbors_of_position(user_id, window_id, target_tab, placement):
	# returns (tab_prev, tab_next) around the insert position.
	# target_tab None means the end of the window.
	if target_tab is None:
		items, _, _ = _query("Tab", limit=1, scan_forward=False, key_condition=(
			Key("userId").eq(user_id) &
			Key("tabPath").begins_with(f"{LIVE_PREFIX}{window_id}#")))
		return (items[0] if items else None), None
	side_items, _ = tab_slice(
		user_id, window_id, target_tab["tabPath"], 1,
		"before" if placement == "before" else "after")
	neighbor = side_items[0] if side_items else None
	if placement == "before":
		return neighbor, target_tab
	return target_tab, neighbor


def group_id_of_position(tab_prev, tab_next):
	# strictly inside a group's range: both neighbors live in the same group
	group_prev = (tab_prev or {}).get("groupId")
	group_next = (tab_next or {}).get("groupId")
	if group_prev and group_prev == group_next:
		return group_prev
	return None


def group_has_other_member(user_id, window_id, group_id, tab_id_excluded_set):
	items = tab_list_all_of_window(user_id, window_id)
	for item in items:
		if item.get("groupId") == group_id and item["id"] not in tab_id_excluded_set:
			return True
	return False


# ---------------------------------------------------------------------------
# tags: entities and attach entries of the external tag service
# (aws_oa _3_tag_and_type). its tables use snake_case attributes, 16-char ids
# and timezone attributes in signed MINUTES; refer to tab_cloud.md#tags.
# ---------------------------------------------------------------------------

TIME_KEY_DIGITS = 16  # sort key format of the obj-tag history table


def time_key_make(time_stamp):
	return f"{time_stamp:0{TIME_KEY_DIGITS}d}#{make_id(4)}"


def tag_get(user_id, tag_id):
	try:
		response = _table("TagEntity").get_item(
			Key={"user_id": user_id, "tag_id": tag_id})
	except Exception as error:
		raise _wrap_db_error(error)
	return _plain(response.get("Item")) if response.get("Item") else None


def tag_list_of_user(user_id):
	return _query_all("TagEntity", key_condition=Key("user_id").eq(user_id))


def tag_item_make(user_id, name):
	time_stamp = now_ms()
	timezone_minute = now_timezone_minute()
	return {
		"user_id": user_id,
		"tag_id": make_id(16),
		"name": name,
		"is_history_enabled": False,
		"create_at": time_stamp,
		"create_at_timezone": timezone_minute,
		"modify_at": time_stamp,
		"modify_at_timezone": timezone_minute,
	}


def tab_tag_entry_list_of_tab(user_id, tab_id):
	# attach entries of one tab (the user's only), in lexorank order
	entries = _query_all("ObjTag", key_condition=Key("obj_id").eq(tab_id))
	entries = [entry for entry in entries if entry.get("user_id") == user_id]
	entries.sort(key=lambda entry: entry.get("lexorank", ""))
	return entries


def tab_tag_entry_list_of_tag(tag_id):
	# all attach entries of one tag through gsi_tag_id (INCLUDE projection
	# carries obj_id + user_id, enough to join the tab items)
	return _query_all("ObjTag", index_name="gsi_tag_id",
		key_condition=Key("tag_id").eq(tag_id))


def tab_tag_entry_make(user_id, tab_id, tag_id, lexorank):
	return {
		"obj_id": tab_id,
		"tag_id": tag_id,
		"user_id": user_id,
		"lexorank": lexorank,
		"create_at": now_ms(),
		"create_at_timezone": now_timezone_minute(),
	}


def tab_tag_history_make(user_id, tab_id, tag_id, operation, lexorank=None):
	# one attach/detach record of the obj-tag history table, written in the
	# same transaction as the attach entry change
	time_stamp = now_ms()
	record = {
		"obj_id": tab_id,
		"time_key": time_key_make(time_stamp),
		"user_id": user_id,
		"operation": operation,
		"tag_id": tag_id,
		"time_stamp": time_stamp,
		"time_stamp_timezone": now_timezone_minute(),
	}
	if lexorank is not None:
		record["lexorank"] = lexorank
	return record


def tab_tag_history_wipe(user_id, tab_id):
	# remove the tag history records of one tab (used after the tab is deleted
	# permanently). record count is unbounded, so this runs as batch deletes
	# outside the delete transaction; it is idempotent and retryable.
	records = _query_all("ObjTagHistory", key_condition=Key("obj_id").eq(tab_id))
	try:
		with _table("ObjTagHistory").batch_writer() as batch:
			for record in records:
				if record.get("user_id") != user_id:
					continue
				batch.delete_item(Key={
					"obj_id": record["obj_id"], "time_key": record["time_key"]})
	except Exception as error:
		raise _wrap_db_error(error)


# ---------------------------------------------------------------------------
# groups
# ---------------------------------------------------------------------------

def group_get(user_id, group_id):
	try:
		response = _table("Group").get_item(Key={"userId": user_id, "id": group_id})
	except Exception as error:
		raise _wrap_db_error(error)
	return _plain(response.get("Item")) if response.get("Item") else None


# ---------------------------------------------------------------------------
# table architecture: specs, integrity check and initialization all live in
# ensure_architect.py (IaC script, also runnable directly from the terminal).
# this layer only adapts them to the connected client and wraps db errors.
# ---------------------------------------------------------------------------

_TABLE_KEY_NAMES = {
	short_name: tuple(name for name, _, _ in spec["keys"])
	for short_name, spec in architect.TABLE_SPECS.items()
}
# key names of the tag service tables (their specs live in the tag service's
# own ensure script, not in this project's TABLE_SPECS)
_TABLE_KEY_NAMES.update({
	"TagEntity": ("user_id", "tag_id"),
	"ObjTag": ("obj_id", "tag_id"),
	"ObjTagHistory": ("obj_id", "time_key"),
})


def aws_check():
	try:
		return architect.architect_check(_client, _table_name_prefix)
	except Exception as error:
		raise _wrap_db_error(error)


def aws_init():
	try:
		return architect.architect_ensure(_client, _table_name_prefix)
	except Exception as error:
		raise _wrap_db_error(error)


def db_check():
	try:
		_client.describe_table(TableName=table_name("Meta"))
		return True, ""
	except Exception as error:
		return False, str(_wrap_db_error(error))
