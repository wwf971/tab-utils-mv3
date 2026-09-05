
# Tab cloud local backend server: flask http entry + local auth. the core
# logic of every api lives in tab_server_core.py (shared with the aws lambda
# transport in ../backend-aws); this file only authenticates the request,
# parses the body, and dispatches into core.API_HANDLER_MAP.
# Refer to tab_cloud.md for the design and tab_cloud_api.md for the api list.
#
# run: python tab_server.py

import base64
import hashlib
import hmac
import os
import sys

import yaml
from flask import Flask, jsonify, make_response, request
from werkzeug.exceptions import HTTPException

# aws-related modules (dynamodb layer, IaC scripts) live in ../backend-aws
DIR_SELF = os.path.dirname(os.path.realpath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(DIR_SELF), "backend-aws"))

import ensure_architect
import tab_server_core as core
import tab_server_db as db
import tab_server_index as index
from tab_server_core import ApiError, CODE_AUTH, CODE_CLOUD, CODE_FAIL, ok
from tab_server_db import DbUnavailableError, DbConflictError
from tab_server_index import IndexUnavailableError


# ---------------------------------------------------------------------------
# config (two-layer, refer to config-two-layer.md)
# ---------------------------------------------------------------------------

def load_config():
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


config = load_config()
# the aws config has its own two layers under backend-aws, next to the IaC
# scripts that also read it. refer to backend-aws/ensure_architect.py.
config["aws"] = ensure_architect.config_load().get("aws", {})
db.init_db(config)
index.init_index(config)
core.core_init(index)


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

app = Flask(__name__)
cors_origin_list = config.get("server", {}).get("cors_origin_list") or []


def cors_headers_set(response):
	# empty cors_origin_list allows any origin (extension popup, local page, etc.)
	origin = request.headers.get("Origin")
	if cors_origin_list:
		if origin in cors_origin_list:
			response.headers["Access-Control-Allow-Origin"] = origin
			response.headers.add("Vary", "Origin")
	elif origin:
		response.headers["Access-Control-Allow-Origin"] = origin
	else:
		response.headers["Access-Control-Allow-Origin"] = "*"
	response.headers["Access-Control-Allow-Headers"] = "Authorization, Content-Type"
	response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
	return response


@app.before_request
def handle_options():
	if request.method == "OPTIONS":
		return make_response("", 204)


@app.after_request
def after_request(response):
	return cors_headers_set(response)


@app.errorhandler(Exception)
def handle_error(error):
	if isinstance(error, HTTPException):
		return error.get_response()
	if isinstance(error, ApiError):
		return jsonify({"code": error.code, "message": error.message})
	if isinstance(error, (DbUnavailableError, IndexUnavailableError)):
		return jsonify({"code": CODE_CLOUD, "message": str(error)})
	if isinstance(error, DbConflictError):
		return jsonify({"code": CODE_FAIL, "message": f"write conflict: {error}"})
	return jsonify({"code": CODE_FAIL, "message": str(error)})


def read_body():
	body = request.get_json(silent=True)
	return body if isinstance(body, dict) else {}


# ---------------------------------------------------------------------------
# routes: login (local-only api), then every core api from API_HANDLER_MAP
# ---------------------------------------------------------------------------

@app.post("/api/auth/login")
def api_login():
	body = read_body()
	username = str(body.get("username", ""))
	password = str(body.get("password", ""))
	for user in config.get("auth", {}).get("users", []):
		if user.get("username") == username and user.get("password") == password:
			token, expire_at = token_make(username)
			return jsonify(ok({"token": token, "userId": username, "expireAt": expire_at}))
	raise ApiError(CODE_AUTH, "wrong username or password")


@app.get("/api/status")
def api_status():
	# status is answered without auth, so the extension can probe the server
	return jsonify(core.api_status(None, {}))


def core_view_make(handler):
	def view():
		user_id = user_of_request(request)
		return jsonify(handler(user_id, read_body()))
	return view


for api_path, api_handler in core.API_HANDLER_MAP.items():
	if api_path == "/api/status":
		continue  # registered above without auth
	app.add_url_rule(api_path, endpoint=api_path,
					 view_func=core_view_make(api_handler), methods=["POST"])


if __name__ == "__main__":
	server_config = config.get("server", {})
	app.run(host=server_config.get("host", "0.0.0.0"),
			port=int(server_config.get("port", 8300)),
			threaded=True)
