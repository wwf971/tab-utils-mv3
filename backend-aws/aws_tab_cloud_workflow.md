# tab cloud aws workflow

How one request flows through the aws backend (full design in `aws_backend_impl.md`):

```text
extension popup
  -> cognito login (once) / silent token refresh
  -> api call with the access token
       -> api gateway http api: jwt authorizer verifies the token
       -> lambda {prefix}-api: cognito sub -> user_id, dispatch into
          tab_server_core.API_HANDLER_MAP (shared with the local server)
            -> dynamodb tabCloud* tables (source of truth)
            -> search / index writes as tasks into the es task queue

home server (aws_oa _2_local_es, no inbound connection)
  -> es_worker long-polls the task queue
  -> runs each task on the local elasticsearch
  -> writes the result into the es result table (lambda polls it for
     search/index_* answers; doc writes are enqueue-and-return)
```

Deploy order:

```text
1. aws_oa _0_auth_cognito ensure_architect.py     (pool, users, user table)
2. aws_oa _2_local_es ensure_architect.py + deploy_to_raspi.sh
3. ./ensure_architect.py                          (this backend; prints the
                                                   endpoint + client id)
4. extension Remote settings: backend = AWS, fill endpoint / region /
   client id, log in
```
