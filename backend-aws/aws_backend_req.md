<!-- This is a minimalist requirement document, aiming at letting reader get a overall grasp of core concepts/workflows, and design and implementation requirement, at a few glances-->

The tab cloud used to be reachable only through the local backend server (`../backend/tab_server.py`), so using it away from home meant exposing a home-network server to the internet. This sub-project gives the browser extension a backend living fully on aws: the extension talks to aws directly, and nothing on the home network is exposed or listens on an internet-facing port.

Users log in with aws cognito (the shared user pool of the aws_oa sub-project `_0_auth_cognito`), and the login session must persist across popup and browser restarts, without logging in again and again.

Every operation the extension could do against the local server must work against the aws backend, with the same api (`../backend/tab_cloud_api.md`) and the same behavior. The api core logic must be written once and shared by both backends, not maintained twice.

The local server code and workflow must remain fully working. The extension lets the user pick which backend to use (local server, or aws), with independent settings and login per backend.

The search index stays on the home elasticsearch, used through the aws_oa sub-project `_2_local_es` (task queue + result table, all connections initiated from home). A down home worker must not make the aws backend fully unavailable: tab operations keep working, only search degrades until the index catches up.

The aws resource instances must be ensured via python script, all named with the unified `name_prefix` of `config.yaml`, following the aws_oa principles (two-layer config, generated ids in `config_gen.yaml`, ensure = create if missing and never blind-recreate); refer to `/2026/aws_oa/doc/aws_oa.md`. The script must also be able to check the whole architecture (including the local es service and the extension's index on it) without changing anything.
