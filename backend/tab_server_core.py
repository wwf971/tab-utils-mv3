
# Core logic of every tab cloud api, independent of the transport carrying
# the requests. two transports dispatch into this module:
#
#   backend/tab_server.py             local flask server (home network)
#   backend-aws/lambda_tab/           aws lambda behind api gateway
#
# each api is a function (user_id, body) -> response dict {code, data?,
# message?}, listed in API_HANDLER_MAP at the end of this file. the transport
# authenticates the request, parses the json body, looks up the handler by
# path, and serializes the returned dict. auth itself is transport-specific
# (local: hmac token of the config users; aws: cognito jwt) and lives in the
# transports.
#
# the index backend also differs per transport (local: elasticsearch directly
# via tab_server_index.py; aws: the local es service via
# tab_server_index_sqs.py), so the transport passes its index module to
# core_init. both modules implement the same general index api.
#
# Refer to tab_cloud.md for the design and tab_cloud_api.md for the api list.
#
# Reading guide: every handler below is a short core-logic block; storage
# details live in ../backend-aws/tab_server_db.py and index details in the
# index module.

import tab_server_check as config_check
import tab_server_db as db
import tab_server_params as params


TRANSACT_ITEM_MAX = 100  # one dynamodb transaction holds at most 100 items
BATCH_MAX = 40

CODE_FAIL = -1
CODE_AUTH = -2
CODE_NOT_FOUND = -3
CODE_INVALID = -4
CODE_CLOUD = -5

index = None  # the index module of the transport, set by core_init


def core_init(index_module):
	global index
	index = index_module


class ApiError(Exception):
	def __init__(self, code, message):
		super().__init__(message)
		self.code = code
		self.message = message


def ok(data=None, message=None):
	response = {"code": 0}
	if data is not None:
		response["data"] = data
	if message:
		response["message"] = message
	return response


def read_page_range(body, limit_default, limit_max):
	# offset/limit pagination of the search-like apis (the list apis page
	# with a cursor instead). the isMore response field tells whether more
	# results exist past offset + limit.
	offset = max(0, int(body.get("offset") or 0))
	limit = min(limit_max, int(body.get("limit") or limit_default))
	return offset, limit


def read_id_list(body, name, is_required=True):
	id_list = body.get(name)
	if id_list is None and not is_required:
		return []
	if not isinstance(id_list, list) or (is_required and len(id_list) == 0):
		raise ApiError(CODE_INVALID, f"{name} is required")
	if len(id_list) > BATCH_MAX:
		raise ApiError(CODE_INVALID, f"{name} exceeds the batch limit of {BATCH_MAX}")
	return [str(item) for item in id_list]


def tab_response(item):
	return {
		"id": item["id"],
		"windowId": item.get("windowId"),
		"tabPath": item["tabPath"],
		"title": item.get("title", ""),
		"url": item.get("url", ""),
		"tagIdList": item.get("tagIdList", []),
		"groupId": item.get("groupId"),
		"createAt": item.get("createAt"),
		"createAtTimezone": item.get("createAtTimezone"),
		"modifyAt": item.get("modifyAt"),
		"modifyAtTimezone": item.get("modifyAtTimezone"),
		"trashAt": item.get("trashAt"),
	}


def window_response(item, tab_count=None):
	response = {
		"id": item["id"],
		"windowPath": item["windowPath"],
		"title": item.get("title", ""),
		"createAt": item.get("createAt"),
		"createAtTimezone": item.get("createAtTimezone"),
		"modifyAt": item.get("modifyAt"),
		"trashAt": item.get("trashAt"),
	}
	if tab_count is not None:
		response["tabCount"] = tab_count
	return response


# ---------------------------------------------------------------------------
# db + index consistency: journal-wrapped writes
# (refer to tab_cloud.md#consistency-between-dynamodb-and-index)
# ---------------------------------------------------------------------------

def index_repair_tab_ids(user_id, tab_id_list):
	for tab_id in tab_id_list:
		item = db.tab_get_by_id(user_id, tab_id)
		if item:
			index.doc_put(item)
		else:
			index.doc_delete(tab_id)


def run_indexed_write(user_id, changes, tab_id_list, index_apply):
	# 1. db changes + journal commit in one transaction
	# 2. index actions
	# 3. success: drop journal.  failure: revert db, converge index, report failure
	journal = db.journal_item_make(user_id, tab_id_list)
	db.transact_apply(changes + [db.change_put("Meta", journal, is_new_key=True)])
	try:
		index_apply()
	except Exception as index_error:
		try:
			db.transact_revert(changes)
			index_repair_tab_ids(user_id, tab_id_list)
			db.journal_delete(user_id, journal["metaPath"])
		except Exception:
			pass  # the journal item remains and points repair at the leftovers
		raise ApiError(CODE_CLOUD, f"index write failed, change rolled back: {index_error}")
	db.journal_delete(user_id, journal["metaPath"])


# ---------------------------------------------------------------------------
# status api (the login api is transport-specific and not in this module)
# ---------------------------------------------------------------------------

def api_status(user_id, body):
	table_list, table_record = run_table_config_check("status")
	index_status, index_record = run_index_config_check("status")
	return ok({
		"isDbOk": table_record["isPassed"],
		"isIndexOk": index_record["isPassed"],
		"dbMessage": table_check_message(table_list),
		"indexMessage": index_check_message(index_status),
		"serverTimeMs": db.now_ms(),
	})


# ---------------------------------------------------------------------------
# window apis
# ---------------------------------------------------------------------------

def get_window_live(user_id, window_id):
	window = db.window_get_by_id(user_id, window_id)
	if not window or not window["windowPath"].startswith(db.LIVE_PREFIX):
		raise ApiError(CODE_NOT_FOUND, "window not found")
	return window


def api_window_list(user_id, body):
	items, cursor = db.window_list(user_id, body.get("cursor"), int(body.get("limit") or 100))
	window_list = [
		window_response(item, db.window_tab_count(user_id, item["id"]))
		for item in items
	]
	data = {"windowList": window_list}
	if cursor:
		data["cursor"] = cursor
	return ok(data)


def api_window_create(user_id, body):
	rank = db.rank_between(db.window_rank_last(user_id), "")
	window = db.window_item_make(user_id, str(body.get("title") or ""), rank)
	db.transact_apply([db.change_put("Window", window, is_new_key=True)])
	return ok({"window": window_response(window, 0)})


def api_window_update(user_id, body):
	window = get_window_live(user_id, str(body.get("windowId", "")))
	window_new = {**window, "title": str(body.get("title") or ""),
				  "modifyAt": db.now_ms(), "modifyAtTimezone": db.now_timezone_hour()}
	db.transact_apply([db.change_put("Window", window_new, item_old=window)])
	return ok()


def api_window_move(user_id, body):
	window = get_window_live(user_id, str(body.get("windowId", "")))
	target = get_window_live(user_id, str(body.get("targetWindowId", "")))
	placement = str(body.get("placement", "after"))
	if window["id"] == target["id"]:
		raise ApiError(CODE_INVALID, "cannot move a window next to itself")
	windows, _ = db.window_list(user_id, limit=1000)
	windows = [item for item in windows if item["id"] != window["id"]]
	index_target = next(i for i, item in enumerate(windows) if item["id"] == target["id"])
	index_insert = index_target if placement == "before" else index_target + 1
	rank_prev = "" if index_insert == 0 else \
		windows[index_insert - 1]["windowPath"][len(db.LIVE_PREFIX):]
	rank_next = "" if index_insert >= len(windows) else \
		windows[index_insert]["windowPath"][len(db.LIVE_PREFIX):]
	window_new = {**window, "windowPath": db.window_path_live(db.rank_between(rank_prev, rank_next))}
	db.transact_apply([
		db.change_delete("Window", db.key_of("Window", window), window),
		db.change_put("Window", window_new, is_new_key=True),
	])
	return ok()


def api_window_trash(user_id, body):
	window = get_window_live(user_id, str(body.get("windowId", "")))
	# trash the remaining live tabs batch by batch, each batch one transaction
	while True:
		tabs, _ = db.tab_list(user_id, window["id"], limit=BATCH_MAX)
		if not tabs:
			break
		trash_tabs_core(user_id, tabs)
	trash_at = db.now_ms()
	window_new = {
		**window,
		"windowPath": db.tab_path_trash(trash_at, window["id"]),
		"trashAt": trash_at,
		"windowPathBeforeTrash": window["windowPath"],
	}
	db.transact_apply([
		db.change_delete("Window", db.key_of("Window", window), window),
		db.change_put("Window", window_new, is_new_key=True),
	])
	return ok()


def api_window_delete_permanent(user_id, body):
	window = db.window_get_by_id(user_id, str(body.get("windowId", "")))
	if not window:
		raise ApiError(CODE_NOT_FOUND, "window not found")
	if not window["windowPath"].startswith(db.TRASH_PREFIX):
		raise ApiError(CODE_INVALID, "only a trashed window can be deleted permanently")
	db.transact_apply([db.change_delete("Window", db.key_of("Window", window), window)])
	return ok()


# ---------------------------------------------------------------------------
# tab apis
# ---------------------------------------------------------------------------

def get_tab_live(user_id, tab_id):
	tab = db.tab_get_by_id(user_id, tab_id)
	if not tab or not tab["tabPath"].startswith(db.LIVE_PREFIX):
		raise ApiError(CODE_NOT_FOUND, f"tab not found: {tab_id}")
	return tab


def get_tabs_live(user_id, tab_id_list):
	return [get_tab_live(user_id, tab_id) for tab_id in tab_id_list]


def get_tabs_trashed(user_id, tab_id_list):
	tabs = []
	for tab_id in tab_id_list:
		tab = db.tab_get_by_id(user_id, tab_id)
		if not tab or not tab["tabPath"].startswith(db.TRASH_PREFIX):
			raise ApiError(CODE_NOT_FOUND, f"trashed tab not found: {tab_id}")
		tabs.append(tab)
	return tabs


def api_tab_list(user_id, body):
	window = get_window_live(user_id, str(body.get("windowId", "")))
	items, cursor = db.tab_list(user_id, window["id"], body.get("cursor"),
								int(body.get("limit") or 100))
	data = {"tabList": [tab_response(item) for item in items]}
	if cursor:
		data["cursor"] = cursor
	return ok(data)


def api_tab_get(user_id, body):
	tab_id_list = read_id_list(body, "tabIdList")
	items = db.tab_get_by_ids(user_id, tab_id_list)
	return ok({"tabList": [tab_response(item) for item in items]})


def api_tab_create(user_id, body):
	tab_input_list = body.get("tabList")
	if not isinstance(tab_input_list, list) or len(tab_input_list) == 0:
		raise ApiError(CODE_INVALID, "tabList is required")
	if len(tab_input_list) > BATCH_MAX:
		raise ApiError(CODE_INVALID, f"tabList exceeds the batch limit of {BATCH_MAX}")

	# optional tags applied to every created tab. each (tab, tag) pair adds an
	# attach entry + a history record to the transaction, so the pair count is
	# capped to stay below the transaction item limit.
	tag_id_list = read_id_list(body, "tagIdList", is_required=False)
	for tag_id in tag_id_list:
		get_tag(user_id, tag_id)  # raises when the tag does not exist
	if len(tab_input_list) * len(tag_id_list) * 2 > TRANSACT_ITEM_MAX - BATCH_MAX:
		raise ApiError(CODE_INVALID, "too many (tab, tag) pairs for one transaction")

	changes = []
	window, meta_change = resolve_target_window(user_id, body, changes)

	target_tab = None
	if body.get("targetTabId"):
		target_tab = get_tab_live(user_id, str(body["targetTabId"]))
		if db.window_id_of_tab_path(target_tab["tabPath"]) != window["id"]:
			raise ApiError(CODE_INVALID, "targetTabId is not inside the target window")
	placement = str(body.get("placement", "after"))
	tab_prev, tab_next = db.tab_neighbors_of_position(user_id, window["id"], target_tab, placement)
	group_id = db.group_id_of_position(tab_prev, tab_next)
	rank_prev = db.rank_of_tab_path(tab_prev["tabPath"]) if tab_prev else ""
	rank_next = db.rank_of_tab_path(tab_next["tabPath"]) if tab_next else ""
	ranks = db.rank_list_between(rank_prev, rank_next, len(tab_input_list))

	tabs_new = []
	for tab_input, rank in zip(tab_input_list, ranks):
		tab = {
			"userId": user_id,
			"tabPath": db.tab_path_live(window["id"], rank),
			"id": db.make_id(),
			"windowId": window["id"],
			"title": str(tab_input.get("title") or ""),
			"url": str(tab_input.get("url") or ""),
			"tagIdList": list(tag_id_list),
			"contentRevision": 0,
			"createAt": db.now_ms(),
			"createAtTimezone": db.now_timezone_hour(),
		}
		if group_id:
			tab["groupId"] = group_id
		tabs_new.append(tab)
		changes.append(db.change_put("Tab", tab, is_new_key=True))
		# attach entries of the tag service, in the same transaction as the tab
		tag_rank = ""
		for tag_id in tag_id_list:
			tag_rank = db.tag_rank_between(tag_rank, "")
			append_tag_attach_changes(user_id, tab, tag_id, tag_rank, changes)
	if meta_change is not None:
		changes.append(meta_change)

	run_indexed_write(user_id, changes, [tab["id"] for tab in tabs_new],
					  lambda: index.doc_put_batch(tabs_new))
	return ok({"windowId": window["id"],
			   "tabList": [tab_response(tab) for tab in tabs_new]})


def resolve_target_window(user_id, body, changes):
	# returns (window, meta_change). a newly created window is added to changes,
	# so it commits in the same transaction as the tabs.
	if body.get("windowId"):
		return get_window_live(user_id, str(body["windowId"])), None
	if body.get("windowTitleNew") is not None:
		rank = db.rank_between(db.window_rank_last(user_id), "")
		window = db.window_item_make(user_id, str(body["windowTitleNew"]), rank)
		changes.append(db.change_put("Window", window, is_new_key=True))
		return window, None
	# default window from meta config; create one when unset, trashed, or gone
	meta_config = db.meta_config_get(user_id)
	window_default_id = (meta_config or {}).get("windowDefaultId")
	if window_default_id:
		window = db.window_get_by_id(user_id, window_default_id)
		if window and window["windowPath"].startswith(db.LIVE_PREFIX):
			return window, None
	rank = db.rank_between(db.window_rank_last(user_id), "")
	window = db.window_item_make(user_id, "default", rank)
	changes.append(db.change_put("Window", window, is_new_key=True))
	meta_new = {"userId": user_id, "metaPath": "config",
				**(meta_config or {}), "windowDefaultId": window["id"]}
	meta_old = meta_config if meta_config else None
	return window, db.change_put("Meta", meta_new, item_old=meta_old)


def api_tab_update(user_id, body):
	tab = get_tab_live(user_id, str(body.get("tabId", "")))
	tab_new = {
		**tab,
		"title": str(body["title"]) if "title" in body else tab.get("title", ""),
		"url": str(body["url"]) if "url" in body else tab.get("url", ""),
		"contentRevision": tab.get("contentRevision", 0) + 1,
		"modifyAt": db.now_ms(),
		"modifyAtTimezone": db.now_timezone_hour(),
	}
	changes = [db.change_put("Tab", tab_new, item_old=tab)]
	run_indexed_write(user_id, changes, [tab["id"]], lambda: index.doc_put(tab_new))
	return ok({"tab": tab_response(tab_new)})


def api_tab_move(user_id, body):
	tab_id_list = read_id_list(body, "tabIdList")
	target_tab = get_tab_live(user_id, str(body.get("targetTabId", "")))
	if target_tab["id"] in tab_id_list:
		raise ApiError(CODE_INVALID, "targetTabId cannot be one of the moved tabs")
	placement = str(body.get("placement", "after"))
	tabs = get_tabs_live(user_id, tab_id_list)
	tab_id_moved_set = set(tab_id_list)
	window_id_target = db.window_id_of_tab_path(target_tab["tabPath"])

	tab_prev, tab_next = db.tab_neighbors_of_position(
		user_id, window_id_target, target_tab, placement)
	# a moved tab found as neighbor gives no group information for the position
	is_neighbor_moved = (
		(tab_prev and tab_prev["id"] in tab_id_moved_set) or
		(tab_next and tab_next["id"] in tab_id_moved_set))
	group_id_new = None if is_neighbor_moved else db.group_id_of_position(tab_prev, tab_next)
	rank_prev = db.rank_of_tab_path(tab_prev["tabPath"]) if tab_prev else ""
	rank_next = db.rank_of_tab_path(tab_next["tabPath"]) if tab_next else ""
	ranks = db.rank_list_between(rank_prev, rank_next, len(tabs))

	changes = []
	group_check_list = []
	for tab, rank in zip(tabs, ranks):
		tab_path_new = db.tab_path_live(window_id_target, rank)
		tab_new = {**tab, "tabPath": tab_path_new, "windowId": window_id_target}
		group_id_old = tab.get("groupId")
		if group_id_new:
			tab_new["groupId"] = group_id_new
		else:
			tab_new.pop("groupId", None)
		if group_id_old and group_id_old != group_id_new:
			group_check_list.append((db.window_id_of_tab_path(tab["tabPath"]), group_id_old))
		changes.append(db.change_delete("Tab", db.key_of("Tab", tab), tab))
		changes.append(db.change_put("Tab", tab_new, is_new_key=True))
	append_group_cleanup_changes(user_id, group_check_list, tab_id_moved_set, changes)
	db.transact_apply(changes)
	return ok()


def append_group_cleanup_changes(user_id, group_check_list, tab_id_excluded_set, changes):
	# groups whose last member left are deleted in the same transaction
	for window_id, group_id in set(group_check_list):
		if not db.group_has_other_member(user_id, window_id, group_id, tab_id_excluded_set):
			group = db.group_get(user_id, group_id)
			if group:
				changes.append(db.change_delete("Group", db.key_of("Group", group), group))


def trash_tabs_core(user_id, tabs):
	trash_at = db.now_ms()
	changes = []
	tabs_new = []
	group_check_list = []
	tab_id_set = {tab["id"] for tab in tabs}
	for tab in tabs:
		tab_new = {
			**tab,
			"tabPath": db.tab_path_trash(trash_at, tab["id"]),
			"trashAt": trash_at,
			"tabPathBeforeTrash": tab["tabPath"],
		}
		tab_new.pop("groupId", None)
		if tab.get("groupId"):
			group_check_list.append((db.window_id_of_tab_path(tab["tabPath"]), tab["groupId"]))
		tabs_new.append(tab_new)
		changes.append(db.change_delete("Tab", db.key_of("Tab", tab), tab))
		changes.append(db.change_put("Tab", tab_new, is_new_key=True))
	append_group_cleanup_changes(user_id, group_check_list, tab_id_set, changes)
	run_indexed_write(user_id, changes, [tab["id"] for tab in tabs],
					  lambda: index.doc_put_batch(tabs_new))
	return tabs_new


def api_tab_trash(user_id, body):
	tabs = get_tabs_live(user_id, read_id_list(body, "tabIdList"))
	tabs_new = trash_tabs_core(user_id, tabs)
	return ok({"tabList": [tab_response(tab) for tab in tabs_new]})


def api_tab_restore(user_id, body):
	tabs = get_tabs_trashed(user_id, read_id_list(body, "tabIdList"))
	window_target = None
	if body.get("windowIdTarget"):
		window_target = get_window_live(user_id, str(body["windowIdTarget"]))

	changes = []
	tabs_new = []
	windows_restored_by_id = {}
	for tab in tabs:
		window, tab_path_new = resolve_restore_position(
			user_id, tab, window_target, windows_restored_by_id, changes)
		tab_new = {**tab, "tabPath": tab_path_new, "windowId": window["id"]}
		tab_new.pop("trashAt", None)
		tab_new.pop("tabPathBeforeTrash", None)
		tabs_new.append(tab_new)
		changes.append(db.change_delete("Tab", db.key_of("Tab", tab), tab))
		changes.append(db.change_put("Tab", tab_new, is_new_key=True))

	run_indexed_write(user_id, changes, [tab["id"] for tab in tabs],
					  lambda: index.doc_put_batch(tabs_new))
	return ok({"tabList": [tab_response(tab) for tab in tabs_new]})


def resolve_restore_position(user_id, tab, window_target, windows_restored_by_id, changes):
	# decides the window and the live tabPath one restored tab goes to.
	# a trashed original window is restored (appended at the window list end)
	# inside the same transaction; refer to tab_cloud.md#trash.
	tab_path_before = tab.get("tabPathBeforeTrash", "")
	window_id_origin = db.window_id_of_tab_path(tab_path_before) if tab_path_before else None

	if window_target is not None:
		window = window_target
	else:
		if not window_id_origin:
			raise ApiError(CODE_INVALID, "tab has no original window, pass windowIdTarget")
		if window_id_origin in windows_restored_by_id:
			window = windows_restored_by_id[window_id_origin]
		else:
			window = db.window_get_by_id(user_id, window_id_origin)
			if window is None:
				raise ApiError(CODE_NOT_FOUND,
					"the original window is permanently gone, pass windowIdTarget")
			if window["windowPath"].startswith(db.TRASH_PREFIX):
				window_live = {**window,
					"windowPath": db.window_path_live(
						db.rank_between(db.window_rank_last(user_id), ""))}
				window_live.pop("trashAt", None)
				window_live.pop("windowPathBeforeTrash", None)
				changes.append(db.change_delete("Window", db.key_of("Window", window), window))
				changes.append(db.change_put("Window", window_live, is_new_key=True))
				window = window_live
				windows_restored_by_id[window_id_origin] = window

	# original position when its rank is still free, otherwise the window end
	if window["id"] == window_id_origin and tab_path_before:
		is_taken = any(
			change["op"] == "put" and change["item_new"].get("tabPath") == tab_path_before
			for change in changes if change["table"] == "Tab")
		if not is_taken and db.tab_get_by_path(user_id, tab_path_before) is None:
			return window, tab_path_before
	tabs_last, _ = db.tab_list(user_id, window["id"], limit=1000)
	rank_last = db.rank_of_tab_path(tabs_last[-1]["tabPath"]) if tabs_last else ""
	rank_pending = [
		db.rank_of_tab_path(change["item_new"]["tabPath"])
		for change in changes
		if change["op"] == "put" and change["table"] == "Tab"
		and change["item_new"]["tabPath"].startswith(f"{db.LIVE_PREFIX}{window['id']}#")
	]
	if rank_pending:
		rank_last = max([rank_last] + rank_pending)
	return window, db.tab_path_live(window["id"], db.rank_between(rank_last, ""))


def api_tab_delete_permanent(user_id, body):
	tabs = get_tabs_trashed(user_id, read_id_list(body, "tabIdList"))
	changes = []
	for tab in tabs:
		changes.append(db.change_delete("Tab", db.key_of("Tab", tab), tab))
		# the tab's attach entries in the tag service's obj-tag table die in
		# the same transaction, so a tab is never gone with entries left over
		for entry in db.tab_tag_entry_list_of_tab(user_id, tab["id"]):
			changes.append(db.change_delete(
				"ObjTag", {"obj_id": entry["obj_id"], "tag_id": entry["tag_id"]}, entry))
	tab_id_list = [tab["id"] for tab in tabs]
	run_indexed_write(user_id, changes, tab_id_list,
					  lambda: index.doc_delete_batch(tab_id_list))
	# history record count is unbounded, so the wipe runs after the
	# transaction; it is idempotent and a crash here leaves only orphan
	# history records, which nothing reads by tab id anymore
	for tab in tabs:
		db.tab_tag_history_wipe(user_id, tab["id"])
	return ok()


def api_tab_context(user_id, body):
	tab = get_tab_live(user_id, str(body.get("tabId", "")))
	count_before = min(200, max(0, int(body.get("countBefore") or 0)))
	count_after = min(200, max(0, int(body.get("countAfter") or 0)))
	window_id = db.window_id_of_tab_path(tab["tabPath"])
	tabs_before, is_more_before = db.tab_slice(
		user_id, window_id, tab["tabPath"], count_before, "before")
	tabs_after, is_more_after = db.tab_slice(
		user_id, window_id, tab["tabPath"], count_after, "after")
	return ok({
		"tabListBefore": [tab_response(item) for item in tabs_before],
		"tabCenter": tab_response(tab),
		"tabListAfter": [tab_response(item) for item in tabs_after],
		"isWindowStartReached": not is_more_before,
		"isWindowEndReached": not is_more_after,
	})


def api_trash_list(user_id, body):
	items, cursor = db.trash_list(user_id, body.get("cursor"), int(body.get("limit") or 100))
	data = {"tabList": [tab_response(item) for item in items]}
	if cursor:
		data["cursor"] = cursor
	return ok(data)


def api_trash_window_list(user_id, body):
	items, cursor = db.window_trash_list(user_id, body.get("cursor"),
										 int(body.get("limit") or 100))
	data = {"windowList": [window_response(item) for item in items]}
	if cursor:
		data["cursor"] = cursor
	return ok(data)


# ---------------------------------------------------------------------------
# tab tag apis. tags are entities of the external tag service (aws_oa
# _3_tag_and_type): the tag entity table and the name index (3_tag) belong to
# that service, and a tab-has-tag relationship is one attach entry in the
# service's obj-tag table (obj_id = tab id, gsi_tag_id answers "tabs of a
# tag"). the tab item's tagIdList stays the denormalized display copy. the
# attach entries and their obj history records join the same transaction as
# the tab item changes. tag rename/delete is not offered here for the time
# being. refer to tab_cloud.md#tags.
# ---------------------------------------------------------------------------

# assign/remove write 3 items per tab (entry + history + tab item), so their
# tab batch stays below the 100-item transaction limit
TAG_BATCH_MAX = 30


def get_tag(user_id, tag_id):
	tag = db.tag_get(user_id, tag_id)
	if not tag:
		raise ApiError(CODE_NOT_FOUND, f"tag not found: {tag_id}")
	return tag


def tag_response(item, match_list=None):
	response = {
		"id": item["tag_id"],
		"name": item["name"],
		"parentId": item.get("parent_id"),
	}
	if match_list is not None:
		response["matchList"] = match_list
	return response


def append_tag_attach_changes(user_id, tab, tag_id, lexorank, changes):
	entry = db.tab_tag_entry_make(user_id, tab["id"], tag_id, lexorank)
	changes.append(db.change_put("ObjTag", entry, is_new_key=True))
	changes.append(db.change_put(
		"ObjTagHistory",
		db.tab_tag_history_make(user_id, tab["id"], tag_id, "attach", lexorank),
		is_new_key=True))


def api_tab_tag_list(user_id, body):
	# without tabId: the user's tags in name order, paged with offset/limit.
	# with tabId: the tags of that tab, in attach-entry lexorank order; one
	# tab carries few tags, so this mode is not paged.
	if body.get("tabId"):
		tab = db.tab_get_by_id(user_id, str(body["tabId"]))
		if not tab:
			raise ApiError(CODE_NOT_FOUND, "tab not found")
		tag_list = []
		for entry in db.tab_tag_entry_list_of_tab(user_id, tab["id"]):
			tag = db.tag_get(user_id, entry["tag_id"])
			if tag:
				tag_list.append(tag_response(tag))
		return ok({"tagList": tag_list, "isMore": False})
	offset, limit = read_page_range(
		body, params.TAG_LIMIT_DEFAULT, params.TAG_LIMIT_MAX)
	tags = sorted(db.tag_list_of_user(user_id), key=lambda tag: tag["name"])
	is_more = len(tags) > offset + limit
	tags = tags[offset:offset + limit]
	return ok({"tagList": [tag_response(tag) for tag in tags], "isMore": is_more})


def api_tab_tag_search(user_id, body):
	query_text = str(body.get("query") or "").strip()
	if not query_text:
		raise ApiError(CODE_INVALID, "query is required")
	offset, limit = read_page_range(
		body, params.TAG_LIMIT_DEFAULT, params.TAG_LIMIT_MAX)
	# one extra hit answers isMore without a second request
	limit_index = min(offset + limit + 1, params.TAG_INDEX_FETCH_MAX)
	hits = index.tag_name_search(user_id, query_text, limit_index)
	is_more = len(hits) > offset + limit
	hits = hits[offset:offset + limit]
	# join with the tag entities; a doc whose entity is gone is dropped
	tag_list = []
	for hit in hits:
		tag = db.tag_get(user_id, hit["tagId"])
		if tag:
			tag_list.append(tag_response(tag, hit["matchList"]))
	return ok({"tagList": tag_list, "isMore": is_more})


def api_tab_tag_create(user_id, body):
	name = str(body.get("name") or "").strip()
	if not name:
		raise ApiError(CODE_INVALID, "name is required")
	if any(tag["name"] == name for tag in db.tag_list_of_user(user_id)):
		raise ApiError(CODE_INVALID, "a tag with this name already exists")
	tag = db.tag_item_make(user_id, name)
	# index the name FIRST (waits for the worker's confirmation): a tag whose
	# name is not confirmed indexed is never written to dynamodb, so a tag can
	# never silently miss from char search. same rule as the tag service.
	index.tag_name_put(tag["tag_id"], name, user_id)
	db.transact_apply([db.change_put("TagEntity", tag, is_new_key=True)])
	return ok({"tag": tag_response(tag)})


def api_tab_tag_assign(user_id, body):
	tag = get_tag(user_id, str(body.get("tagId", "")))
	tab_id_list = read_id_list(body, "tabIdList")
	if len(tab_id_list) > TAG_BATCH_MAX:
		raise ApiError(CODE_INVALID, f"tabIdList exceeds the batch limit of {TAG_BATCH_MAX}")
	tabs = get_tabs_live(user_id, tab_id_list)
	changes = []
	for tab in tabs:
		if tag["tag_id"] in tab.get("tagIdList", []):
			continue  # already assigned
		entries = db.tab_tag_entry_list_of_tab(user_id, tab["id"])
		rank_last = entries[-1]["lexorank"] if entries else ""
		append_tag_attach_changes(
			user_id, tab, tag["tag_id"], db.tag_rank_between(rank_last, ""), changes)
		tab_new = {**tab, "tagIdList": [*tab.get("tagIdList", []), tag["tag_id"]]}
		changes.append(db.change_put("Tab", tab_new, item_old=tab))
	db.transact_apply(changes)
	return ok()


def api_tab_tag_remove(user_id, body):
	tag = get_tag(user_id, str(body.get("tagId", "")))
	tab_id_list = read_id_list(body, "tabIdList")
	if len(tab_id_list) > TAG_BATCH_MAX:
		raise ApiError(CODE_INVALID, f"tabIdList exceeds the batch limit of {TAG_BATCH_MAX}")
	tabs = get_tabs_live(user_id, tab_id_list)
	changes = []
	for tab in tabs:
		if tag["tag_id"] not in tab.get("tagIdList", []):
			continue
		entry_key = {"obj_id": tab["id"], "tag_id": tag["tag_id"]}
		changes.append(db.change_delete("ObjTag", entry_key, None))
		changes.append(db.change_put(
			"ObjTagHistory",
			db.tab_tag_history_make(user_id, tab["id"], tag["tag_id"], "detach"),
			is_new_key=True))
		tab_new = {**tab, "tagIdList": [
			tag_id for tag_id in tab["tagIdList"] if tag_id != tag["tag_id"]]}
		changes.append(db.change_put("Tab", tab_new, item_old=tab))
	db.transact_apply(changes)
	return ok()


def api_tab_tag_tab_list(user_id, body):
	tag = get_tag(user_id, str(body.get("tagId", "")))
	entries = db.tab_tag_entry_list_of_tag(tag["tag_id"])
	tab_ids = [entry["obj_id"] for entry in entries if entry.get("user_id") == user_id]
	tabs = db.tab_get_by_ids(user_id, tab_ids)
	tabs_live = [tab for tab in tabs if tab["tabPath"].startswith(db.LIVE_PREFIX)]
	tabs_live.sort(key=lambda tab: tab["tabPath"])  # window order
	return ok({"tabList": [tab_response(tab) for tab in tabs_live]})


# ---------------------------------------------------------------------------
# group apis
# ---------------------------------------------------------------------------

def api_group_create(user_id, body):
	tabs = get_tabs_live(user_id, read_id_list(body, "tabIdList"))
	window_ids = {db.window_id_of_tab_path(tab["tabPath"]) for tab in tabs}
	if len(window_ids) != 1:
		raise ApiError(CODE_INVALID, "grouped tabs must be in one window")
	window_id = next(iter(window_ids))
	# continuity: the tabs between the smallest and largest chosen rank must be
	# exactly the chosen set
	paths = sorted(tab["tabPath"] for tab in tabs)
	tabs_range = db.tab_range(user_id, paths[0], paths[-1])
	if {tab["id"] for tab in tabs_range} != {tab["id"] for tab in tabs}:
		raise ApiError(CODE_INVALID, "chosen tabs are not continuous in the window")

	group = {
		"userId": user_id, "id": db.make_id(),
		"title": str(body.get("title") or ""),
		"color": str(body.get("color") or "grey"),
		"windowId": window_id,
		"createAt": db.now_ms(), "createAtTimezone": db.now_timezone_hour(),
	}
	changes = [db.change_put("Group", group, is_new_key=True)]
	group_check_list = []
	tab_id_set = {tab["id"] for tab in tabs}
	for tab in tabs:
		if tab.get("groupId") and tab["groupId"] != group["id"]:
			group_check_list.append((window_id, tab["groupId"]))
		changes.append(db.change_put("Tab", {**tab, "groupId": group["id"]}, item_old=tab))
	append_group_cleanup_changes(user_id, group_check_list, tab_id_set, changes)
	db.transact_apply(changes)
	return ok({"group": group})


def api_group_update(user_id, body):
	group = db.group_get(user_id, str(body.get("groupId", "")))
	if not group:
		raise ApiError(CODE_NOT_FOUND, "group not found")
	group_new = {**group}
	if body.get("title") is not None:
		group_new["title"] = str(body["title"])
	if body.get("color") is not None:
		group_new["color"] = str(body["color"])
	db.transact_apply([db.change_put("Group", group_new, item_old=group)])
	return ok({"group": group_new})


def api_group_delete(user_id, body):
	group = db.group_get(user_id, str(body.get("groupId", "")))
	if not group:
		raise ApiError(CODE_NOT_FOUND, "group not found")
	changes = [db.change_delete("Group", db.key_of("Group", group), group)]
	for tab in db.tab_list_all_of_window(user_id, group["windowId"]):
		if tab.get("groupId") == group["id"]:
			tab_new = {**tab}
			tab_new.pop("groupId", None)
			changes.append(db.change_put("Tab", tab_new, item_old=tab))
	db.transact_apply(changes)
	return ok()


# ---------------------------------------------------------------------------
# meta apis
# ---------------------------------------------------------------------------

def api_meta_get(user_id, body):
	meta_config = db.meta_config_get(user_id) or {}
	return ok({"windowDefaultId": meta_config.get("windowDefaultId")})


def api_meta_update(user_id, body):
	window = get_window_live(user_id, str(body.get("windowDefaultId", "")))
	meta_config = db.meta_config_get(user_id) or {}
	meta_config.pop("userId", None)
	meta_config.pop("metaPath", None)
	meta_config["windowDefaultId"] = window["id"]
	db.meta_config_put(user_id, meta_config)
	return ok()


# ---------------------------------------------------------------------------
# search api
# ---------------------------------------------------------------------------

def api_search(user_id, body):
	query_tree = body.get("query")
	if isinstance(query_tree, str):
		query_tree = query_tree.strip()
	# optional tag filter: only tabs carrying ALL the given tags are answered.
	# with a tag filter the query text may be empty (tags-only listing).
	tag_id_list = read_id_list(body, "tagIdList", is_required=False)
	for tag_id in tag_id_list:
		get_tag(user_id, tag_id)  # raises when the tag does not exist
	if not query_tree and not tag_id_list:
		raise ApiError(CODE_INVALID, "query or tagIdList is required")
	field_list = []
	if body.get("isSearchTitle", True):
		field_list.append("title")
	if body.get("isSearchUrl", True):
		field_list.append("url")
	if not field_list:
		raise ApiError(CODE_INVALID, "at least one of isSearchTitle/isSearchUrl must be true")
	is_trashed = bool(body.get("isTrashed", False))
	offset, limit = read_page_range(
		body, params.SEARCH_LIMIT_DEFAULT, params.SEARCH_LIMIT_MAX)

	tab_id_tagged_set = None
	if tag_id_list:
		tab_id_tagged_set = search_tag_tab_id_set(user_id, tag_id_list)

	if not query_tree:
		return search_tags_only(user_id, tab_id_tagged_set, is_trashed, offset, limit)

	if tab_id_tagged_set is not None:
		# with a tag filter the whole considered index window is fetched:
		# hits outside the tagged set are dropped below, so a small index
		# limit could hide tagged tabs ranked after untagged ones
		limit_index = params.SEARCH_INDEX_FETCH_MAX
	else:
		# one extra hit answers isMore without a second request
		limit_index = min(offset + limit + 1, params.SEARCH_INDEX_FETCH_MAX)
	hits = index.search(user_id, query_tree, field_list, is_trashed, limit_index)
	if tab_id_tagged_set is not None:
		hits = [hit for hit in hits if hit["tabId"] in tab_id_tagged_set]
	is_more = len(hits) > offset + limit
	hits = hits[offset:offset + limit]
	# join with fresh dynamodb items; drop hits whose item is gone or whose
	# trash state changed meanwhile
	tab_by_id = {tab["id"]: tab
				 for tab in db.tab_get_by_ids(user_id, [hit["tabId"] for hit in hits])}
	tab_list = []
	for hit in hits:
		tab = tab_by_id.get(hit["tabId"])
		if not tab:
			continue
		if (tab.get("trashAt") is not None) != is_trashed:
			continue
		tab_list.append({**tab_response(tab), "matchList": hit["matchList"]})
	return ok({"tabList": tab_list, "isMore": is_more})


def search_tag_tab_id_set(user_id, tag_id_list):
	# ids of the tabs carrying ALL the given tags: intersect the attach
	# entries of each tag (gsi_tag_id of the obj-tag table, the membership
	# truth; refer to tab_cloud.md#tags). entries of other users are dropped.
	tab_id_set = None
	for tag_id in tag_id_list:
		entries = db.tab_tag_entry_list_of_tag(tag_id)
		tab_id_set_of_tag = {
			entry["obj_id"] for entry in entries
			if entry.get("user_id") == user_id}
		if tab_id_set is None:
			tab_id_set = tab_id_set_of_tag
		else:
			tab_id_set = tab_id_set & tab_id_set_of_tag
	return tab_id_set


def search_tags_only(user_id, tab_id_tagged_set, is_trashed, offset, limit):
	# empty query text with a tag filter: list the tabs carrying all the
	# tags straight from dynamodb, no text matching and no index involved
	tabs = db.tab_get_by_ids(user_id, sorted(tab_id_tagged_set))
	tabs = [tab for tab in tabs if (tab.get("trashAt") is not None) == is_trashed]
	# live scope: window order. trash scope: newest trashed first (a trash
	# tabPath starts with the zero-padded trashAt)
	tabs.sort(key=lambda tab: tab["tabPath"], reverse=is_trashed)
	is_more = len(tabs) > offset + limit
	tabs = tabs[offset:offset + limit]
	return ok({"tabList": [tab_response(tab) for tab in tabs], "isMore": is_more})


# ---------------------------------------------------------------------------
# maintenance apis
# ---------------------------------------------------------------------------

def is_table_list_ready(table_list):
	return len(table_list) > 0 and all(item["isReady"] for item in table_list)


def is_index_status_ready(index_status):
	return (
		index_status["isOk"]
		and index_status["isExisting"]
		and index_status["isConfigConsistent"] is True
	)


def table_check_message(table_list):
	if is_table_list_ready(table_list):
		return ""
	table_missing_count = sum(not item["isExisting"] for item in table_list)
	table_invalid_count = sum(
		item["isExisting"] and item["isConfigConsistent"] is not True
		for item in table_list)
	if table_missing_count:
		return f"{table_missing_count} DynamoDB table(s) missing"
	if table_invalid_count:
		return f"{table_invalid_count} DynamoDB table configuration(s) differ"
	return "DynamoDB tables are not active"


def index_check_message(index_status):
	if not index_status["isOk"]:
		return index_status["message"] or "search index is unreachable"
	if not index_status["isExisting"]:
		return "search index is missing"
	if index_status["isConfigConsistent"] is not True:
		return "search index configuration differs"
	return ""


def run_table_config_check(trigger):
	try:
		table_list = db.aws_check()
	except Exception as error:
		config_check.check_record(
			config_check.CHECK_TYPE_TABLES,
			False,
			{"tableList": [], "message": str(error)},
			trigger,
		)
		raise
	record = config_check.check_record(
		config_check.CHECK_TYPE_TABLES,
		is_table_list_ready(table_list),
		{"tableList": table_list},
		trigger,
	)
	return table_list, record


def run_index_config_check(trigger):
	index_status = index.index_check()
	record = config_check.check_record(
		config_check.CHECK_TYPE_INDEX,
		is_index_status_ready(index_status),
		{"index": index_status},
		trigger,
	)
	return index_status, record


def maintenance_response(user_id, table_list, index_status):
	journal_pending_count = None
	is_meta_active = any(
		item["tableName"] == db.table_name("Meta") and item["isReady"]
		for item in table_list)
	if is_meta_active:
		journal_pending_count = len(db.journal_list(user_id))
	return {
		"tableList": table_list,
		"index": index_status,
		"journalPendingCount": journal_pending_count,
		"checkHistory": config_check.check_history(),
	}


def table_maintenance_response(user_id, table_list):
	journal_pending_count = None
	is_meta_active = any(
		item["tableName"] == db.table_name("Meta") and item["isReady"]
		for item in table_list)
	if is_meta_active:
		journal_pending_count = len(db.journal_list(user_id))
	return {
		"tableList": table_list,
		"journalPendingCount": journal_pending_count,
		"checkHistory": config_check.check_history(),
	}


def index_maintenance_response(index_status):
	return {
		"index": index_status,
		"checkHistory": config_check.check_history(),
	}


def api_aws_check(user_id, body):
	table_list, _ = run_table_config_check("manual")
	index_status, _ = run_index_config_check("manual")
	return ok(maintenance_response(user_id, table_list, index_status))


def api_aws_init(user_id, body):
	db.aws_init()
	index.index_ensure()
	table_list, _ = run_table_config_check("initialize")
	index_status, _ = run_index_config_check("initialize")
	return ok(maintenance_response(user_id, table_list, index_status))


def api_table_check(user_id, body):
	table_list, _ = run_table_config_check("manual")
	return ok(table_maintenance_response(user_id, table_list))


def api_table_init(user_id, body):
	try:
		db.aws_init()
	except Exception:
		try:
			run_table_config_check("initialize")
		except Exception:
			pass
		raise
	table_list, _ = run_table_config_check("initialize")
	return ok(table_maintenance_response(user_id, table_list))


def api_index_check(user_id, body):
	index_status, _ = run_index_config_check("manual")
	return ok(index_maintenance_response(index_status))


def api_index_init(user_id, body):
	try:
		index.index_ensure()
	except Exception:
		run_index_config_check("initialize")
		raise
	index_status, _ = run_index_config_check("initialize")
	return ok(index_maintenance_response(index_status))


def api_index_recreate(user_id, body):
	index_status = index.index_check()
	document_count = index_status.get("documentCount")
	if document_count is not None and document_count > 0 \
			and body.get("isConfirmedNonEmpty") is not True:
		return {
			"code": -6,
			"data": {"documentCount": document_count},
			"message": "confirmation required before recreating a non-empty index",
		}
	try:
		index.index_recreate()
	except Exception:
		run_index_config_check("recreate")
		raise
	index_status, _ = run_index_config_check("recreate")
	return ok(index_maintenance_response(index_status))


def api_config_check_history(user_id, body):
	return ok(config_check.check_history(body.get("limit") or 20))


def api_index_repair(user_id, body):
	repair_count = 0
	for journal in db.journal_list(user_id):
		index_repair_tab_ids(user_id, journal.get("tabIdList", []))
		db.journal_delete(user_id, journal["metaPath"])
		repair_count += 1
	return ok({"repairCount": repair_count})


def api_index_rebuild(user_id, body):
	index.index_ensure()
	doc_count = 0
	cursor = None
	while True:
		tabs, cursor = db.tab_list_all_of_user(user_id, cursor, 200)
		index.doc_put_batch(tabs)
		doc_count += len(tabs)
		if not cursor:
			break
	return ok({"docCount": doc_count})


# ---------------------------------------------------------------------------
# api path -> handler. the transports dispatch with this map, so both serve
# the same api list. /api/auth/login is not here: login is transport-specific.
# ---------------------------------------------------------------------------

API_HANDLER_MAP = {
	"/api/status": api_status,
	"/api/window/list": api_window_list,
	"/api/window/create": api_window_create,
	"/api/window/update": api_window_update,
	"/api/window/move": api_window_move,
	"/api/window/trash": api_window_trash,
	"/api/window/deletePermanent": api_window_delete_permanent,
	"/api/tab/list": api_tab_list,
	"/api/tab/get": api_tab_get,
	"/api/tab/create": api_tab_create,
	"/api/tab/update": api_tab_update,
	"/api/tab/move": api_tab_move,
	"/api/tab/trash": api_tab_trash,
	"/api/tab/restore": api_tab_restore,
	"/api/tab/deletePermanent": api_tab_delete_permanent,
	"/api/tab/context": api_tab_context,
	"/api/trash/list": api_trash_list,
	"/api/trash/windowList": api_trash_window_list,
	"/api/tabTag/list": api_tab_tag_list,
	"/api/tabTag/search": api_tab_tag_search,
	"/api/tabTag/create": api_tab_tag_create,
	"/api/tabTag/assign": api_tab_tag_assign,
	"/api/tabTag/remove": api_tab_tag_remove,
	"/api/tabTag/tabList": api_tab_tag_tab_list,
	"/api/group/create": api_group_create,
	"/api/group/update": api_group_update,
	"/api/group/delete": api_group_delete,
	"/api/meta/get": api_meta_get,
	"/api/meta/update": api_meta_update,
	"/api/search": api_search,
	"/api/maintenance/awsCheck": api_aws_check,
	"/api/maintenance/awsInit": api_aws_init,
	"/api/maintenance/tableCheck": api_table_check,
	"/api/maintenance/tableInit": api_table_init,
	"/api/maintenance/indexCheck": api_index_check,
	"/api/maintenance/indexInit": api_index_init,
	"/api/maintenance/indexRecreate": api_index_recreate,
	"/api/maintenance/configCheckHistory": api_config_check_history,
	"/api/maintenance/indexRepair": api_index_repair,
	"/api/maintenance/indexRebuild": api_index_rebuild,
}
