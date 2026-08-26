
# ensure all aws resource instances of tab cloud: the dynamodb tables.
# refer to tab_cloud.md for the table formats and tab_cloud_aws_init.md for
# the initialization design.
#
# 'ensure' means: create if missing, report if config differs, never recreate.
# an existing table with a wrong schema is reported by the check result and is
# not repaired automatically.
#
# used in two ways:
#   - from the terminal: python ensure_architect.py
#   - from the backend server: tab_server_db.py calls architect_check() and
#     architect_ensure() behind the /api/maintenance table apis.
#
# config layers, later overrides earlier (refer to config-two-layer.md):
#   ./config.yaml     aws config, example
#   ./config.0.yaml   aws config, authentic (git-ignored)

import os

import boto3
import yaml


DIR_SELF = os.path.dirname(os.path.realpath(__file__))


def config_load():
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


# ----------------------------------------------------------------------- main

def main():
	config = config_load()
	client = dynamodb_client_make(config)
	table_name_prefix = table_name_prefix_of(config)
	table_status_list = architect_ensure(client, table_name_prefix)
	for table_status in table_status_list:
		if table_status["isReady"]:
			print(f"{table_status['tableName']}: ok")
			continue
		print(f"{table_status['tableName']}: {table_status['statusText']}")
		for issue_text in table_status["configIssueList"]:
			print(f"  issue: {issue_text}")


if __name__ == "__main__":
	main()
