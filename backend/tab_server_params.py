
# Centralized tunable parameters of the tab cloud backend (pagination sizes
# etc.); future parameters of this kind belong here too. Shared by both
# transports: the local server imports it next to the core, and the file is
# packaged into the lambda zip (LAMBDA_FILE_LIST of ensure_architect.py).
#
# Deployment config (endpoints, credentials, table names) does NOT belong
# here — that lives in the config.yaml layers.

# /api/search: one page of results
SEARCH_LIMIT_DEFAULT = 100
SEARCH_LIMIT_MAX = 500
# a search never considers more index hits than this; paging stops there
SEARCH_INDEX_FETCH_MAX = 500

# /api/tabTag/list and /api/tabTag/search: one page of tags
TAG_LIMIT_DEFAULT = 50
TAG_LIMIT_MAX = 200
# a tag name search never considers more index hits than this
TAG_INDEX_FETCH_MAX = 500
