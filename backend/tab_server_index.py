
# Index layer of tab cloud: a general api backed by an elasticsearch
# implementation. Core logic must only call the general functions here:
#
#   index_ensure / index_recreate / index_check
#   doc_put / doc_delete / doc_put_batch / doc_delete_batch
#   search(user_id, query_tree, field_list, is_trashed, limit)
#
# so another engine (whoosh, opensearch) only needs to re-implement them.
# Refer to tab_cloud.md#index-designelasticsearch.

from elasticsearch import Elasticsearch


class IndexUnavailableError(Exception):
	pass


HIGHLIGHT_TAG_START = "[[HL_START]]"
HIGHLIGHT_TAG_END = "[[HL_END]]"

_es = None
_index_name = "tab_cloud_tab"
_shard_count = 1


def init_index(config):
	global _es, _index_name, _shard_count
	es_config = config.get("elasticsearch", {})
	endpoint = es_config.get(es_config.get("endpoint_use", "local"), {})
	server_url = (f"{endpoint.get('scheme', 'http')}://"
				  f"{endpoint.get('host', '127.0.0.1')}:{endpoint.get('port', 9200)}")
	_index_name = endpoint.get("index_name", "tab_cloud_tab")
	_shard_count = endpoint.get("number_of_shards", 1)
	_es = Elasticsearch(server_url, request_timeout=5)


def _wrap_index_call(call):
	try:
		return call()
	except Exception as error:
		raise IndexUnavailableError(str(error))


def index_check():
	try:
		if not _es.ping():
			return _index_status_error("elasticsearch not reachable")
		is_existing = bool(_es.indices.exists(index=_index_name))
		if not is_existing:
			return {
				"isOk": True,
				"isExisting": False,
				"isConfigConsistent": None,
				"indexName": _index_name,
				"documentCount": None,
				"configIssueList": [],
				"message": "",
			}
		settings_response = _es.indices.get_settings(index=_index_name)
		mapping_response = _es.indices.get_mapping(index=_index_name)
		document_count = int(_es.count(index=_index_name).get("count", 0))
		config_issue_list = _index_config_issue_list(
			settings_response[_index_name].get("settings", {}),
			mapping_response[_index_name].get("mappings", {}),
		)
		return {
			"isOk": True,
			"isExisting": True,
			"isConfigConsistent": len(config_issue_list) == 0,
			"indexName": _index_name,
			"documentCount": document_count,
			"configIssueList": config_issue_list,
			"message": "",
		}
	except Exception as error:
		return _index_status_error(str(error))


def index_ensure():
	def call():
		if _es.indices.exists(index=_index_name):
			return False
		_es.indices.create(index=_index_name, body=_index_body())
		return True
	return _wrap_index_call(call)


def index_recreate():
	def call():
		if _es.indices.exists(index=_index_name):
			_es.indices.delete(index=_index_name)
		_es.indices.create(index=_index_name, body=_index_body())
	return _wrap_index_call(call)


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


def _index_config_issue_list(settings, mappings):
	expected = _index_body()
	settings_actual = settings.get("index", settings)
	settings_expected = expected["settings"]
	issue_list = []
	_compare_config_required(
		settings_actual, settings_expected, "settings", issue_list)
	_compare_config_required(
		mappings, expected["mappings"], "mappings", issue_list)
	return issue_list


def _compare_config_required(actual, expected, path, issue_list):
	if isinstance(expected, dict):
		if not isinstance(actual, dict):
			issue_list.append(f"{path}: expected an object")
			return
		for key, value_expected in expected.items():
			path_child = f"{path}.{key}"
			if key not in actual:
				issue_list.append(f"{path_child}: missing")
				continue
			_compare_config_required(actual[key], value_expected, path_child, issue_list)
		return
	if isinstance(expected, list):
		if not isinstance(actual, (list, tuple)):
			issue_list.append(f"{path}: expected {expected}, got {actual}")
			return
		if list(actual) != expected:
			issue_list.append(f"{path}: expected {expected}, got {actual}")
		return
	if str(actual) != str(expected):
		issue_list.append(f"{path}: expected {expected}, got {actual}")


def _char_field():
	# char-level, case-insensitive, with term vectors for the fvh highlighter
	return {
		"type": "text",
		"analyzer": "char_analyzer",
		"term_vector": "with_positions_offsets",
	}


def _index_body():
	return {
		"settings": {
			"number_of_shards": _shard_count,
			"analysis": {
				"analyzer": {
					"char_analyzer": {
						"type": "custom",
						"tokenizer": "char_tokenizer",
						"filter": ["lowercase"],
					}
				},
				"tokenizer": {
					"char_tokenizer": {
						"type": "pattern",
						"pattern": "",  # empty pattern splits on each character
					}
				},
			},
		},
		"mappings": {
			"properties": {
				"userId": {"type": "keyword"},
				"title": _char_field(),
				"url": _char_field(),
				"isTrashed": {"type": "boolean"},
				"contentRevision": {"type": "long"},
			}
		},
	}


# ---------------------------------------------------------------------------
# documents
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
	_wrap_index_call(lambda: _es.index(
		index=_index_name, id=tab["id"], document=_doc_of_tab(tab),
		refresh="wait_for"))


def doc_delete(tab_id):
	def call():
		try:
			_es.delete(index=_index_name, id=tab_id, refresh="wait_for")
		except Exception as error:
			if getattr(error, "status_code", None) == 404 or "NotFoundError" in type(error).__name__:
				return
			raise
	_wrap_index_call(call)


def doc_put_batch(tab_list):
	for tab in tab_list:
		doc_put(tab)


def doc_delete_batch(tab_id_list):
	for tab_id in tab_id_list:
		doc_delete(tab_id)


# ---------------------------------------------------------------------------
# search
# ---------------------------------------------------------------------------

def _term_query(term_text, field_list):
	conditions = [{"match_phrase": {field: term_text}} for field in field_list]
	if len(conditions) == 1:
		return conditions[0]
	return {"bool": {"should": conditions, "minimum_should_match": 1}}


def _tree_query(query_tree, field_list):
	# query tree: "text", or {"term": ...} / {"and": [...]} / {"or": [...]} / {"not": ...}
	if isinstance(query_tree, str):
		return _term_query(query_tree, field_list)
	if not isinstance(query_tree, dict):
		raise ValueError("invalid query tree")
	if "term" in query_tree:
		return _term_query(str(query_tree["term"]), field_list)
	if "and" in query_tree:
		return {"bool": {"must": [
			_tree_query(child, field_list) for child in query_tree["and"]]}}
	if "or" in query_tree:
		return {"bool": {
			"should": [_tree_query(child, field_list) for child in query_tree["or"]],
			"minimum_should_match": 1,
		}}
	if "not" in query_tree:
		return {"bool": {"must_not": [_tree_query(query_tree["not"], field_list)]}}
	raise ValueError("invalid query tree")


def search(user_id, query_tree, field_list, is_trashed, limit):
	# returns [{"tabId": ..., "matchList": [{"field", "indexStart", "indexEnd"}]}]
	highlight_fields = {}
	for field in field_list:
		highlight_fields[field] = {
			"type": "fvh",  # phrase-aware whole-substring highlight, needs term vectors
			"pre_tags": [HIGHLIGHT_TAG_START],
			"post_tags": [HIGHLIGHT_TAG_END],
			"fragment_size": 999999,
			"number_of_fragments": 0,
		}
	body = {
		"query": {
			"bool": {
				"must": [_tree_query(query_tree, field_list)],
				"filter": [
					{"term": {"userId": user_id}},
					{"term": {"isTrashed": bool(is_trashed)}},
				],
			}
		},
		"highlight": {"fields": highlight_fields},
		"size": limit,
	}
	response = _wrap_index_call(lambda: _es.search(index=_index_name, body=body))
	results = []
	for hit in response["hits"]["hits"]:
		match_list = []
		highlight = hit.get("highlight", {})
		for field in field_list:
			for highlighted_text in highlight.get(field, []):
				for index_start, index_end in _positions_of_highlight(highlighted_text):
					match_list.append({
						"field": field,
						"indexStart": index_start,
						"indexEnd": index_end,
					})
		results.append({"tabId": hit["_id"], "matchList": match_list})
	return results


def _positions_of_highlight(highlighted_text):
	# extract (start, end) char positions over the original text from the tags
	positions = []
	position_original = 0
	position_tagged = 0
	while True:
		index_start = highlighted_text.find(HIGHLIGHT_TAG_START, position_tagged)
		if index_start == -1:
			break
		position_original += index_start - position_tagged
		index_end = highlighted_text.find(HIGHLIGHT_TAG_END, index_start)
		if index_end == -1:
			break
		match_length = index_end - (index_start + len(HIGHLIGHT_TAG_START))
		positions.append((position_original, position_original + match_length))
		position_original += match_length
		position_tagged = index_end + len(HIGHLIGHT_TAG_END)
	return positions
