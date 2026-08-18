
# Tab cloud backend server: http entry, auth, and the core logic of each api.
# Refer to tab_cloud.md for the design and tab_cloud_api.md for the api list.
#
# Reading guide: every route below is a short core-logic block; storage and
# index details live in tab_server_db.py and tab_server_index.py.
#
# run: python tab_server.py

import base64
import hashlib
import hmac
import os

import yaml
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

import tab_server_db as db
import tab_server_check as config_check
import tab_server_index as index
from tab_server_db import DbUnavailableError, DbConflictError
from tab_server_index import IndexUnavailableError


BATCH_MAX = 40  # one dynamodb transaction holds at most 100 items

CODE_FAIL = -1
CODE_AUTH = -2
CODE_NOT_FOUND = -3
CODE_INVALID = -4
CODE_CLOUD = -5


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


# ---------------------------------------------------------------------------
# config (two-layer, refer to config-two-layer.md)
# ---------------------------------------------------------------------------

def load_config():
	dir_path = os.path.dirname(os.path.realpath(__file__))

	def read_yaml(file_name):
		file_path = os.path.join(dir_path, file_name)
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


config = load_config()
db.init_db(config)
index.init_index(config)


# ---------------------------------------------------------------------------
# auth
# ---------------------------------------------------------------------------

def _token_sign(payload_text):
	secret = str(config.get("auth", {}).get("token_secret", ""))
	return hmac.new(secret.encode(), payload_text.encode(), hashlib.sha256).hexdigest()


def token_make(user_id):
	expire_hour = config.get("auth", {}).get("token_expire_hour", 720)
	expire_at = db.now_ms() + int(expire_hour) * 3600 * 1000
	payload_text = f"{user_id}|{expire_at}"
	token_text = f"{payload_text}|{_token_sign(payload_text)}"
	return base64.urlsafe_b64encode(token_text.encode()).decode(), expire_at


def user_of_request(request):
	header = request.headers.get("authorization", "")
	if not header.startswith("Bearer "):
		raise ApiError(CODE_AUTH, "missing auth token")
	try:
		token_text = base64.urlsafe_b64decode(header[len("Bearer "):].encode()).decode()
		user_id, expire_at, signature = token_text.rsplit("|", 2)
	except Exception:
		raise ApiError(CODE_AUTH, "invalid auth token")
	if not hmac.compare_digest(signature, _token_sign(f"{user_id}|{expire_at}")):
		raise ApiError(CODE_AUTH, "invalid auth token")
	if db.now_ms() > int(expire_at):
		raise ApiError(CODE_AUTH, "token expired")
	return user_id


# ---------------------------------------------------------------------------
# app
# ---------------------------------------------------------------------------

app = FastAPI()

cors_origin_list = config.get("server", {}).get("cors_origin_list") or []
app.add_middleware(
	CORSMiddleware,
	allow_origins=cors_origin_list if cors_origin_list else ["*"],
	allow_methods=["*"],
	allow_headers=["*"],
)


@app.exception_handler(Exception)
async def handle_error(request, error):
	if isinstance(error, ApiError):
		return JSONResponse({"code": error.code, "message": error.message})
	if isinstance(error, (DbUnavailableError, IndexUnavailableError)):
		return JSONResponse({"code": CODE_CLOUD, "message": str(error)})
	if isinstance(error, DbConflictError):
		return JSONResponse({"code": CODE_FAIL, "message": f"write conflict: {error}"})
	return JSONResponse({"code": CODE_FAIL, "message": str(error)})


async def read_body(request):
	try:
		body = await request.json()
	except Exception:
		body = {}
	return body if isinstance(body, dict) else {}


def read_id_list(body, name, is_required=True):
	id_list = body.get(name)
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
# auth and status apis
# ---------------------------------------------------------------------------

@app.post("/api/auth/login")
async def api_login(request: Request):
	body = await read_body(request)
	username = str(body.get("username", ""))
	password = str(body.get("password", ""))
	for user in config.get("auth", {}).get("users", []):
		if user.get("username") == username and user.get("password") == password:
			token, expire_at = token_make(username)
			return ok({"token": token, "userId": username, "expireAt": expire_at})
	raise ApiError(CODE_AUTH, "wrong username or password")


@app.get("/api/status")
async def api_status():
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


@app.post("/api/window/list")
async def api_window_list(request: Request):
	user_id = user_of_request(request)
	body = await read_body(request)
	items, cursor = db.window_list(user_id, body.get("cursor"), int(body.get("limit") or 100))
	window_list = [
		window_response(item, db.window_tab_count(user_id, item["id"]))
		for item in items
	]
	data = {"windowList": window_list}
	if cursor:
		data["cursor"] = cursor
	return ok(data)


@app.post("/api/window/create")
async def api_window_create(request: Request):
	user_id = user_of_request(request)
	body = await read_body(request)
	rank = db.rank_between(db.window_rank_last(user_id), "")
	window = db.window_item_make(user_id, str(body.get("title") or ""), rank)
	db.transact_apply([db.change_put("Window", window, is_new_key=True)])
	return ok({"window": window_response(window, 0)})


@app.post("/api/window/update")
async def api_window_update(request: Request):
	user_id = user_of_request(request)
	body = await read_body(request)
	window = get_window_live(user_id, str(body.get("windowId", "")))
	window_new = {**window, "title": str(body.get("title") or ""),
				  "modifyAt": db.now_ms(), "modifyAtTimezone": db.now_timezone_hour()}
	db.transact_apply([db.change_put("Window", window_new, item_old=window)])
	return ok()


@app.post("/api/window/move")
async def api_window_move(request: Request):
	user_id = user_of_request(request)
	body = await read_body(request)
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


@app.post("/api/window/trash")
async def api_window_trash(request: Request):
	user_id = user_of_request(request)
	body = await read_body(request)
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


@app.post("/api/window/deletePermanent")
async def api_window_delete_permanent(request: Request):
	user_id = user_of_request(request)
	body = await read_body(request)
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


@app.post("/api/tab/list")
async def api_tab_list(request: Request):
	user_id = user_of_request(request)
	body = await read_body(request)
	window = get_window_live(user_id, str(body.get("windowId", "")))
	items, cursor = db.tab_list(user_id, window["id"], body.get("cursor"),
								int(body.get("limit") or 100))
	data = {"tabList": [tab_response(item) for item in items]}
	if cursor:
		data["cursor"] = cursor
	return ok(data)


@app.post("/api/tab/get")
async def api_tab_get(request: Request):
	user_id = user_of_request(request)
	body = await read_body(request)
	tab_id_list = read_id_list(body, "tabIdList")
	items = db.tab_get_by_ids(user_id, tab_id_list)
	return ok({"tabList": [tab_response(item) for item in items]})


@app.post("/api/tab/create")
async def api_tab_create(request: Request):
	user_id = user_of_request(request)
	body = await read_body(request)
	tab_input_list = body.get("tabList")
	if not isinstance(tab_input_list, list) or len(tab_input_list) == 0:
		raise ApiError(CODE_INVALID, "tabList is required")
	if len(tab_input_list) > BATCH_MAX:
		raise ApiError(CODE_INVALID, f"tabList exceeds the batch limit of {BATCH_MAX}")

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
			"tagIdList": [],
			"contentRevision": 0,
			"createAt": db.now_ms(),
			"createAtTimezone": db.now_timezone_hour(),
		}
		if group_id:
			tab["groupId"] = group_id
		tabs_new.append(tab)
		changes.append(db.change_put("Tab", tab, is_new_key=True))
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


@app.post("/api/tab/update")
async def api_tab_update(request: Request):
	user_id = user_of_request(request)
	body = await read_body(request)
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


@app.post("/api/tab/move")
async def api_tab_move(request: Request):
	user_id = user_of_request(request)
	body = await read_body(request)
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
		for relation in db.relation_list_of_tab(tab["id"]):
			relation_new = {**relation, "tabPath": tab_path_new}
			changes.append(db.change_delete("TabTag", db.key_of("TabTag", relation), relation))
			changes.append(db.change_put("TabTag", relation_new, is_new_key=True))
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


@app.post("/api/tab/trash")
async def api_tab_trash(request: Request):
	user_id = user_of_request(request)
	body = await read_body(request)
	tabs = get_tabs_live(user_id, read_id_list(body, "tabIdList"))
	tabs_new = trash_tabs_core(user_id, tabs)
	return ok({"tabList": [tab_response(tab) for tab in tabs_new]})


@app.post("/api/tab/restore")
async def api_tab_restore(request: Request):
	user_id = user_of_request(request)
	body = await read_body(request)
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
		for relation in db.relation_list_of_tab(tab["id"]):
			if relation["tabPath"] != tab_path_new:
				relation_new = {**relation, "tabPath": tab_path_new}
				changes.append(db.change_delete("TabTag", db.key_of("TabTag", relation), relation))
				changes.append(db.change_put("TabTag", relation_new, is_new_key=True))

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


@app.post("/api/tab/deletePermanent")
async def api_tab_delete_permanent(request: Request):
	user_id = user_of_request(request)
	body = await read_body(request)
	tabs = get_tabs_trashed(user_id, read_id_list(body, "tabIdList"))
	changes = []
	for tab in tabs:
		changes.append(db.change_delete("Tab", db.key_of("Tab", tab), tab))
		for relation in db.relation_list_of_tab(tab["id"]):
			changes.append(db.change_delete("TabTag", db.key_of("TabTag", relation), relation))
	tab_id_list = [tab["id"] for tab in tabs]
	run_indexed_write(user_id, changes, tab_id_list,
					  lambda: index.doc_delete_batch(tab_id_list))
	return ok()


@app.post("/api/tab/context")
async def api_tab_context(request: Request):
	user_id = user_of_request(request)
	body = await read_body(request)
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


@app.post("/api/trash/list")
async def api_trash_list(request: Request):
	user_id = user_of_request(request)
	body = await read_body(request)
	items, cursor = db.trash_list(user_id, body.get("cursor"), int(body.get("limit") or 100))
	data = {"tabList": [tab_response(item) for item in items]}
	if cursor:
		data["cursor"] = cursor
	return ok(data)


@app.post("/api/trash/windowList")
async def api_trash_window_list(request: Request):
	user_id = user_of_request(request)
	body = await read_body(request)
	items, cursor = db.window_trash_list(user_id, body.get("cursor"),
										 int(body.get("limit") or 100))
	data = {"windowList": [window_response(item) for item in items]}
	if cursor:
		data["cursor"] = cursor
	return ok(data)


# ---------------------------------------------------------------------------
# tag apis
# ---------------------------------------------------------------------------

def get_tag(user_id, tag_id):
	tag = db.tag_get_by_id(user_id, tag_id)
	if not tag:
		raise ApiError(CODE_NOT_FOUND, "tag not found")
	return tag


def tag_response(item):
	return {
		"id": item["id"],
		"tagName": item["tagName"],
		"color": item.get("color"),
		"createAt": item.get("createAt"),
		"createAtTimezone": item.get("createAtTimezone"),
	}


@app.post("/api/tag/create")
async def api_tag_create(request: Request):
	user_id = user_of_request(request)
	body = await read_body(request)
	tag_name = str(body.get("tagName") or "").strip()
	if not tag_name:
		raise ApiError(CODE_INVALID, "tagName is required")
	if db.tag_get_by_name(user_id, tag_name):
		raise ApiError(CODE_INVALID, "a tag with this name already exists")
	tag = {
		"userId": user_id, "tagName": tag_name, "id": db.make_id(),
		"createAt": db.now_ms(), "createAtTimezone": db.now_timezone_hour(),
	}
	if body.get("color"):
		tag["color"] = str(body["color"])
	db.transact_apply([db.change_put("Tag", tag, is_new_key=True)])
	return ok({"tag": tag_response(tag)})


@app.post("/api/tag/list")
async def api_tag_list(request: Request):
	user_id = user_of_request(request)
	return ok({"tagList": [tag_response(item) for item in db.tag_list(user_id)]})


@app.post("/api/tag/update")
async def api_tag_update(request: Request):
	user_id = user_of_request(request)
	body = await read_body(request)
	tag = get_tag(user_id, str(body.get("tagId", "")))
	tag_new = {**tag}
	if body.get("color") is not None:
		tag_new["color"] = str(body["color"])
	changes = []
	tag_name_new = str(body.get("tagName") or "").strip()
	if tag_name_new and tag_name_new != tag["tagName"]:
		if db.tag_get_by_name(user_id, tag_name_new):
			raise ApiError(CODE_INVALID, "a tag with this name already exists")
		tag_new["tagName"] = tag_name_new
		changes.append(db.change_delete("Tag", db.key_of("Tag", tag), tag))
		changes.append(db.change_put("Tag", tag_new, is_new_key=True))
	else:
		changes.append(db.change_put("Tag", tag_new, item_old=tag))
	db.transact_apply(changes)
	return ok({"tag": tag_response(tag_new)})


@app.post("/api/tag/delete")
async def api_tag_delete(request: Request):
	user_id = user_of_request(request)
	body = await read_body(request)
	tag = get_tag(user_id, str(body.get("tagId", "")))
	changes = [db.change_delete("Tag", db.key_of("Tag", tag), tag)]
	relations, _ = db.relation_list_of_tag(tag["id"], limit=1000)
	for relation in relations:
		changes.append(db.change_delete("TabTag", db.key_of("TabTag", relation), relation))
		tab = db.tab_get_by_id(user_id, relation["tabId"])
		if tab and tag["id"] in tab.get("tagIdList", []):
			tab_new = {**tab, "tagIdList": [
				tag_id for tag_id in tab["tagIdList"] if tag_id != tag["id"]]}
			changes.append(db.change_put("Tab", tab_new, item_old=tab))
	db.transact_apply(changes)
	return ok()


@app.post("/api/tag/assign")
async def api_tag_assign(request: Request):
	user_id = user_of_request(request)
	body = await read_body(request)
	tag = get_tag(user_id, str(body.get("tagId", "")))
	tabs = get_tabs_live(user_id, read_id_list(body, "tabIdList"))
	changes = []
	for tab in tabs:
		if tag["id"] in tab.get("tagIdList", []):
			continue
		relation = {
			"tagId": tag["id"], "tabPath": tab["tabPath"], "tabId": tab["id"],
			"userId": user_id,
			"createAt": db.now_ms(), "createAtTimezone": db.now_timezone_hour(),
		}
		tab_new = {**tab, "tagIdList": [*tab.get("tagIdList", []), tag["id"]]}
		changes.append(db.change_put("TabTag", relation, is_new_key=True))
		changes.append(db.change_put("Tab", tab_new, item_old=tab))
	db.transact_apply(changes)
	return ok()


@app.post("/api/tag/remove")
async def api_tag_remove(request: Request):
	user_id = user_of_request(request)
	body = await read_body(request)
	tag = get_tag(user_id, str(body.get("tagId", "")))
	tabs = get_tabs_live(user_id, read_id_list(body, "tabIdList"))
	changes = []
	for tab in tabs:
		if tag["id"] not in tab.get("tagIdList", []):
			continue
		relation = {"tagId": tag["id"], "tabPath": tab["tabPath"]}
		changes.append(db.change_delete("TabTag", relation, None))
		tab_new = {**tab, "tagIdList": [
			tag_id for tag_id in tab["tagIdList"] if tag_id != tag["id"]]}
		changes.append(db.change_put("Tab", tab_new, item_old=tab))
	db.transact_apply(changes)
	return ok()


@app.post("/api/tag/tabList")
async def api_tag_tab_list(request: Request):
	user_id = user_of_request(request)
	body = await read_body(request)
	tag = get_tag(user_id, str(body.get("tagId", "")))
	relations, cursor = db.relation_list_of_tag(
		tag["id"], body.get("cursor"), int(body.get("limit") or 100))
	tabs = db.tab_get_by_ids(user_id, [relation["tabId"] for relation in relations])
	tabs_live = [tab for tab in tabs if tab["tabPath"].startswith(db.LIVE_PREFIX)]
	data = {"tabList": [tab_response(tab) for tab in tabs_live]}
	if cursor:
		data["cursor"] = cursor
	return ok(data)


# ---------------------------------------------------------------------------
# group apis
# ---------------------------------------------------------------------------

@app.post("/api/group/create")
async def api_group_create(request: Request):
	user_id = user_of_request(request)
	body = await read_body(request)
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


@app.post("/api/group/update")
async def api_group_update(request: Request):
	user_id = user_of_request(request)
	body = await read_body(request)
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


@app.post("/api/group/delete")
async def api_group_delete(request: Request):
	user_id = user_of_request(request)
	body = await read_body(request)
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

@app.post("/api/meta/get")
async def api_meta_get(request: Request):
	user_id = user_of_request(request)
	meta_config = db.meta_config_get(user_id) or {}
	return ok({"windowDefaultId": meta_config.get("windowDefaultId")})


@app.post("/api/meta/update")
async def api_meta_update(request: Request):
	user_id = user_of_request(request)
	body = await read_body(request)
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

@app.post("/api/search")
async def api_search(request: Request):
	user_id = user_of_request(request)
	body = await read_body(request)
	query_tree = body.get("query")
	if isinstance(query_tree, str):
		query_tree = query_tree.strip()
	if not query_tree:
		raise ApiError(CODE_INVALID, "query is required")
	field_list = []
	if body.get("isSearchTitle", True):
		field_list.append("title")
	if body.get("isSearchUrl", True):
		field_list.append("url")
	if not field_list:
		raise ApiError(CODE_INVALID, "at least one of isSearchTitle/isSearchUrl must be true")
	is_trashed = bool(body.get("isTrashed", False))
	limit = min(500, int(body.get("limit") or 100))

	hits = index.search(user_id, query_tree, field_list, is_trashed, limit)
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
	return ok({"tabList": tab_list})


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


@app.post("/api/maintenance/awsCheck")
async def api_aws_check(request: Request):
	user_id = user_of_request(request)
	table_list, _ = run_table_config_check("manual")
	index_status, _ = run_index_config_check("manual")
	return ok(maintenance_response(user_id, table_list, index_status))


@app.post("/api/maintenance/awsInit")
async def api_aws_init(request: Request):
	user_id = user_of_request(request)
	db.aws_init()
	index.index_ensure()
	table_list, _ = run_table_config_check("initialize")
	index_status, _ = run_index_config_check("initialize")
	return ok(maintenance_response(user_id, table_list, index_status))


@app.post("/api/maintenance/tableCheck")
async def api_table_check(request: Request):
	user_id = user_of_request(request)
	table_list, _ = run_table_config_check("manual")
	return ok(table_maintenance_response(user_id, table_list))


@app.post("/api/maintenance/tableInit")
async def api_table_init(request: Request):
	user_id = user_of_request(request)
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


@app.post("/api/maintenance/indexCheck")
async def api_index_check(request: Request):
	user_of_request(request)
	index_status, _ = run_index_config_check("manual")
	return ok(index_maintenance_response(index_status))


@app.post("/api/maintenance/indexInit")
async def api_index_init(request: Request):
	user_of_request(request)
	try:
		index.index_ensure()
	except Exception:
		run_index_config_check("initialize")
		raise
	index_status, _ = run_index_config_check("initialize")
	return ok(index_maintenance_response(index_status))


@app.post("/api/maintenance/indexRecreate")
async def api_index_recreate(request: Request):
	user_id = user_of_request(request)
	body = await read_body(request)
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


@app.post("/api/maintenance/configCheckHistory")
async def api_config_check_history(request: Request):
	user_of_request(request)
	body = await read_body(request)
	return ok(config_check.check_history(body.get("limit") or 20))


@app.post("/api/maintenance/indexRepair")
async def api_index_repair(request: Request):
	user_id = user_of_request(request)
	repair_count = 0
	for journal in db.journal_list(user_id):
		index_repair_tab_ids(user_id, journal.get("tabIdList", []))
		db.journal_delete(user_id, journal["metaPath"])
		repair_count += 1
	return ok({"repairCount": repair_count})


@app.post("/api/maintenance/indexRebuild")
async def api_index_rebuild(request: Request):
	user_id = user_of_request(request)
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


if __name__ == "__main__":
	import uvicorn
	server_config = config.get("server", {})
	uvicorn.run(app, host=server_config.get("host", "0.0.0.0"),
				port=int(server_config.get("port", 8300)))
