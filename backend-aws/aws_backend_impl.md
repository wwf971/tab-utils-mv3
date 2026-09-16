# tab cloud aws backend implementation

The extension talks to aws directly: cognito for login, api gateway + lambda for every api, dynamodb as the source of truth, and the home elasticsearch (through the `_2_local_es` service of the aws_oa project) as the search index. Requirements in `aws_backend_req.md`; the data model, api behavior and consistency design are those of `../backend/tab_cloud.md` and `../backend/tab_cloud_api.md`, unchanged.

```text
extension popup
  login / silent refresh -------> cognito user pool (aws_oa _0_auth_cognito)
  api call (bearer token) ------> api gateway http api
                                    jwt authorizer (verifies the token)
                                    -> lambda {prefix}-api
                                         -> dynamodb tabCloud* tables
                                         -> tag service tables (aws_oa _3_tag_and_type),
                                            joined into the same transactions
                                         -> es task queue --> home worker --> local es
                                            (aws_oa _2_local_es; tab index + the tag
                                            service's 3_tag name index)
```

## One Core, Two Transports

Every api's logic lives in `../backend/tab_server_core.py` as one function `(user_id, body) -> {code, data?, message?}`, listed in `API_HANDLER_MAP` by path. A transport authenticates the request, parses the json body, looks up the handler by path, and serializes the returned dict:

| transport | entry | auth | index module |
|---|---|---|---|
| local server | `../backend/tab_server.py` (flask) | local hmac token of the config users | `tab_server_index.py`, elasticsearch directly |
| aws backend | `lambda_tab/lambda_function.py` | cognito jwt (verified by the api gateway) | `tab_server_index_sqs.py`, over the local es service |

The transport passes its index module to `core_init`; both index modules implement the same general index api. `tab_server_db.py` (the dynamodb layer) is shared as-is: on the local server it uses the config credentials, in the lambda it uses the execution role.

## Login and Session

The extension authenticates against cognito directly (plain https to the `cognito-idp` endpoint, no aws sdk), using a dedicated app client `{prefix}-extension` with no secret (a browser extension cannot keep one) and exactly two auth flows:

- `USER_PASSWORD_AUTH` at login: username + password, returns an access token (1h) and a refresh token (`cognito.refresh_token_valid_days`, default 90 days).
- `REFRESH_TOKEN_AUTH` for the silent renewal: the extension keeps the refresh token in `chrome.storage.local`, and before any api call renews the access token when it is (nearly) expired. This is what makes the session persist across popup and browser restarts; the user logs in again only when the refresh token itself expires or is revoked.

Users and their passwords are managed by `_0_auth_cognito` (the shared pool); this project only adds its own app client. A user still on the temporary password gets a `NEW_PASSWORD_REQUIRED` challenge, which the extension does not implement — the account setup is finished once through the aws_oa hosted login page.

Verification is split in two, same pattern as the aws_oa services:

1. The api gateway jwt authorizer (issuer = the user pool, audience = this app client) rejects unsigned/expired/foreign tokens with a bare http 401 before the lambda runs.
2. The lambda maps the verified cognito `sub` claim to the internal `user_id` through the shared user table of `_0_auth_cognito` (query on `gsi_auth_id` with `auth_id = cognito#{sub}`, cached per container). A cognito user without a mapping row is rejected; run `_0_auth_cognito/ensure_user_table.py` to create the mapping.

## Index over the Local ES Service

`tab_server_index_sqs.py` mirrors the general index api of `../backend/tab_server_index.py`, but sends every action as a task into the `_2_local_es` task queue (fifo, message group = index name) instead of talking to elasticsearch; the worker on the home server executes it and writes the result into the service's result table. Refer to `/2026/aws_oa/_2_local_es/local_es_impl.md` for the service itself.

The two kinds of actions degrade differently when the home worker is down:

- document writes (`doc_put`, `doc_delete`, batches) are enqueue-and-return: a successful enqueue counts as write success. The fifo queue keeps the per-index write order, and the worker applies the backlog when it comes back. So tab create/trash/move keep working with the worker down; dynamodb (the source of truth) is never blocked by the index.
- `search` and the `index_*` maintenance actions need an answer, so they wait for the worker's result and fail with `IndexUnavailableError` (api code -5) after `local_es.result_timeout`.

Tasks a dead worker never fetched die out with the queue's retention; the journal + repair design of `tab_cloud.md#consistency-between-dynamodb-and-index` (indexRepair / indexRebuild apis) covers those lost writes, unchanged from the local backend.

The index is `local_es.index_name` on the shared home elasticsearch, config name `char` with the same field config as the local index layer (char fields `title`/`url`, exact fields `userId`/`isTrashed`/`contentRevision`), so it carries this project's ownership stamp and no other service can silently adopt it.

Both index modules additionally offer `tag_name_put` / `tag_name_search` over the tag service's `3_tag` name index (document `{name, user_id}`, document id = tag id) on the same home elasticsearch; that index is created and owned by the tag service. Unlike the tab document writes, `tag_name_put` waits for the worker's confirmation: a tag entity is written to dynamodb only after its name is confirmed indexed (refer to `../backend/tab_cloud.md#tags`).

## Tag Service Binding

Tags are entities of `_3_tag_and_type` (refer to `../backend/tab_cloud.md#tags`). The tab lambda does not call that service's http api: it reads/writes three of its dynamodb tables directly (tag entity, obj-tag, obj-tag-history), so attach entries join the tab cloud `TransactWriteItems` — this is what makes "deleting a tab deletes its tag entries" atomic. The physical table names and the `3_tag` index name come from `_3_tag_and_type/config_gen.yaml` and reach the lambda as env / the local server at startup. The lambda role gets item-level access to exactly those three tables.

## AWS Resource Instances

All names start with `{prefix}` = `name_prefix` from `./config.yaml`. The dynamodb tables use their own `aws.dynamodb.table_name_prefix` (the tables predate this sub-project; specs and check rules in `ensure_architect.py` / `tab_cloud_aws_init.md`).

| resource | name | purpose |
|---|---|---|
| dynamodb tables | `{table_name_prefix}Window` ... | source of truth, 4 tables |
| cognito app client | `{prefix}-extension` | extension login on the shared pool |
| iam role | `{prefix}-api-role` | lambda execution role |
| lambda | `{prefix}-api` | all apis, one function |
| api gateway http api | `{prefix}-api` | route `ANY /api/{proxy+}` + jwt authorizer |

The http api carries the permissive cors configuration of `aws_utils` (any origin, so the extension popup — a `chrome-extension://` origin — can call it). One cors subtlety: the browser's preflight carries no `Authorization` header, and the jwt-authorized `ANY` route would answer it with 401, which the browser treats as a failed preflight. So a second route `OPTIONS /api/{proxy+}` exists without authorization; the lambda answers it with an empty 204 and the api gateway attaches the cors headers.

Resources of the aws_oa sub-projects (user pool, user table, es task queue, es result table, tag service tables) are consumed, not created: their ids are read from each sub-project's `config_gen.yaml` under `aws_oa.project_dir`.

The lambda role allows exactly what the backend does: full access to the `{table_name_prefix}*` tables, item-level access to the three tag service tables, query on the user table, send on the es task queue, get-item on the es result table, and logs.

The `Tag` / `TabTag` tables of the removed built-in tag system are dropped by the deploy flow when found (they never held data) and by `--delete all`.

## Lambda

One function serves every api; the zip is flat (import by module name): `lambda_function.py`, `tab_server_core.py`, `tab_server_check.py`, `tab_server_params.py`, `tab_server_db.py`, `tab_server_index_sqs.py`, and `ensure_architect.py` (for the table specs behind the maintenance apis). boto3 comes with the runtime; nothing else is needed, which is why config reaches the lambda as env instead of yaml:

| env | value |
|---|---|
| `TABLE_NAME_PREFIX` | dynamodb table prefix |
| `TABLE_USER` | user table of `_0_auth_cognito` |
| `ES_QUEUE_URL`, `ES_RESULT_TABLE` | the local es service resources |
| `ES_INDEX_NAME` | this project's index |
| `ES_INDEX_TAG_NAME` | the tag service's name index (`3_tag`) |
| `TAG_TABLE_TAG`, `TAG_TABLE_OBJ_TAG`, `TAG_TABLE_OBJ_TAG_HISTORY` | the tag service tables |
| `ES_RESULT_TIMEOUT_SEC`, `ES_RESULT_POLL_SEC` | result wait tuning |

The http status is always 200 with the outcome in the body's `code` field, same convention as the local server; the only non-200 the extension sees is the authorizer's bare 401, which it maps to "log in again".

## Config

Config layers, later overrides earlier (refer to config-two-layer.md): `./config.yaml` example, `./config.0.yaml` authentic (git-ignored). `./config_gen.yaml` is written by `ensure_architect.py`, never by hand: the api endpoint, the cognito region/pool/client id, and the lambda name. When the extension is built and the generated file contains the endpoint, region and app client id, Vite embeds those three public identifiers as the AWS settings defaults.

## Ensure Script (IaC entry point)

```text
ensure_architect.py            ensure tables -> app client -> role -> lambda
                               -> http api (authorizer, integration, route,
                                  stage, invoke permission) -> es index
                               -> write config_gen.yaml, print the endpoint
                               and client id for the extension settings
ensure_architect.py --tables   the dynamodb tables only
ensure_architect.py --check    inspect everything (incl. a worker roundtrip
                               on the local es service), change nothing
ensure_architect.py --delete all   remove the aws backend (typed confirmation)
```

It builds on `aws_utils` of the aws_oa project (imported from `aws_oa.project_dir`) for the role/lambda/http-api ensurement. A down home worker fails only the es index step with a warning, never the aws-side deploy: the index can be ensured later by re-running the script or by the indexInit api.

Prerequisites: `_0_auth_cognito`, `_2_local_es` and `_3_tag_and_type` are ensured (their `config_gen.yaml` exist), and the extension users have mapping rows in the user table.

## Extension Side

The Remote settings hold a backend selector (`local` / `aws`) with per-backend settings and login; all remote features go through one `call` method of the popup's RemoteStore, so the selected backend is transparent to every feature. For aws the settings are the api endpoint url, the cognito region and the app client id. A fresh extension uses the values embedded from this project's `config_gen.yaml`; saved manual changes take precedence, and **Restore Generated Values** restores the values from the current extension build. Refer to `tab_cloud.md#endpoint-config-and-login`.
