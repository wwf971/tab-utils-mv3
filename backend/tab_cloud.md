

<!-- this document should be kept concise. AI agent is allowed to modify, but should not largely paraphrase for some content apparently is human writte, if not asked to -->

# Tab Cloud

Tab Cloud stores tabs remotely. The extension talks to a backend server, the backend stores data in AWS DynamoDB, and a char-level index (Elasticsearch, deployed on local network devices) serves substring search over title/url.

```text
extension popup('Remote' tab, upload confirm popup from 'Search' tab)
  -> backend server (python)
       -> dynamodb                          # the source of truth
       -> char-level index (elasticsearch)  # search only, rebuildable from dynamodb
```

DynamoDB is the source of truth. The index only answers search and can always be rebuilt from DynamoDB.

Remote tabs keep a window-tab hierarchy similar to the browser:

```text
user
 ├─ window            # ordered by windowLexoRank
 │   └─ tab           # ordered by tabLexoRank inside its window
 │       ├─ tag       # 0..n tags per tab
 │       └─ group     # 0..1 group per tab; a group covers continuous tabs
 └─ trash             # trashed tabs and trashed windows, ordered by trash time
```

Deleting is soft by default: a deleted tab goes to the trash, stays searchable there, and can be restored or permanently deleted. Refer to [Trash](#trash).

For the concrete api list, refer to [Tab cloud api](./tab_cloud_api.md).

## Core Concepts and Their Data Format

There are four DynamoDB tables owned by this project, named `{table_name_prefix}` + `Window` / `Tab` / `Group` / `Meta`. Tags live in the tables of the external tag service and are only accessed from here (refer to [Tags](#tags)). `PK`/`SK` mark the table primary key; `GSI` marks a global secondary index.

Every table is partitioned by `userId`, so all list/slice reads are one Query on the user's partition. Random ids conform to `id-format.md`; time fields conform to `time-format.md` (epoch ms + optional timezone integer, unit hour).

Windows are stored as items in a window table. A window item's data format:

```text
userId(PK)
windowPath(SK)   # live form:  live#{windowLexoRank}
                 # trash form: trash#{trashAt}#{id}
id               # GSI gsiWindowId: (id), lookup by window id
title
createAt         # unix timestamp with at least millisecond presicion
createAtTimezone # optional, integer, using +09 to represent UTC+09 timezone
modifyAt         # optional, created only after first modification
modifyAtTimezone # optional
trashAt          # optional, exists only while trashed
windowPathBeforeTrash # optional, the live windowPath to restore to
```

Tabs are stored as items in a tab table. A tab item's data format:

```text
userId(PK)
tabPath(SK)      # live form:  live#{remoteWindowId}#{tabLexoRank}
                 # trash form: trash#{trashAt}#{id}
id               # GSI gsiTabId: (id), lookup by tab id
windowId         # the window this tab belongs (belonged) to
title
url
createAt         # unix timestamp with at least millisecond presicion
createAtTimezone # optional, integer, using +09 to represent UTC+09 timezone
modifyAt         # optional, created only after first modification
modifyAtTimezone # optional

tagIdList        # display copy of tag membership; the tag service's obj-tag table is the truth
groupId          # optional, refer to Tab Group
contentRevision  # integer, +1 on every title/url change, used by index sync

trashAt              # optional, exists only while trashed
tabPathBeforeTrash   # optional, the live tabPath the tab had when trashed
```

Because live and trash SK forms have distinct prefixes (`live#` / `trash#`), window listing, tab slices, and trash listing are each one prefix-range Query, and trashed items never appear inside live ranges.

### Tab order and LexoRank

A LexoRank is a rank string using chars 0-9 a-z. Plain string comparison of ranks gives the order. Inserting a tab between two neighbors only calcs a rank string between the two neighbor ranks and writes the inserted tab item; the other tabs are untouched. When two neighbor ranks have no room in between, the ranks of that window are rebalanced; this is rare and touches one window only.

`tabPath` embeds the window id before the rank, so on the table key (userId, tabPath), one user's live tabs are sorted window by window, and inside one window by rank:

```text
list tabs of one window     -> query userId, tabPath begins_with live#{windowId}#
next n tabs of a given tab  -> query userId, live#{givenPath} < tabPath < live#{windowId}#{rank upper bound}, forward, limit n
previous n tabs             -> query userId, live#{windowId}# < tabPath < live#{givenPath}, backward, limit n
```

These slice queries are what the remote context mode is built on.

Looking a tab up by id alone uses the GSI `gsiTabId`. Because tabPath is a key attribute, moving a tab means delete + put of the tab item inside one transaction.

### Tags

Tabs are allowed to have an unfixed number of tags. Tags are not stored in tables of this project: they are entities of the tag service (aws_oa sub-project `_3_tag_and_type`, refer to its `tag_type_service_impl.md`), and tab cloud reads/writes that service's DynamoDB tables directly, for its `tab` objects only. Tags are user specific, like every other object here. Three tag service tables are touched:

```text
tag entity table (PK user_id, SK tag_id)
  name             # unique per user, enforced by tab cloud on create
  is_history_enabled, create_at/_timezone, modify_at/_timezone

obj-tag table (PK obj_id, SK tag_id)     # one attach entry per tab-has-tag
  obj_id           # = the tab id
  user_id
  lexorank         # order of the tags of one tab; the tag service's lexorank
                   # rule applies: a rank never ends with '0'
  create_at/_timezone
                   # GSI gsi_tag_id: (tag_id, obj_id), INCLUDE user_id

obj-tag-history table (PK obj_id, SK time_key)  # one attach/detach record per change
```

The physical table names and the name index of the tag service come from that sub-project's `config_gen.yaml`; ensure_architect.py wires them into the lambda env, and the local server reads them at startup (refer to `../backend-aws/aws_backend_impl.md`).

Both query directions are efficient:

- tags of a tab: the tab item's `tagIdList` is the denormalized display copy; the obj-tag partition of the tab id is the truth, in lexorank order.
- tabs of a tag: one query on `gsi_tag_id` with the tag id, then join the tab items by id (dropping trashed tabs and other users' entries).

The tabs-of-a-tag direction also powers the tag filter of the search api: one `gsi_tag_id` query per given tag, intersected into "tabs carrying all the tags" (refer to [Search with a tag filter](#search-with-a-tag-filter)).

The attach entries live in DynamoDB next to this project's tables, so every tag change joins the tab cloud transaction: assigning/removing a tag writes the attach entry, one history record, and the tab item's `tagIdList` in one `TransactWriteItems`; uploading a tab with tags writes the tab item and its attach entries together. Attach entries are keyed by the tab id (not tabPath), so moving/trashing/restoring a tab does not touch them. Permanently deleting a tab deletes its attach entries in the same transaction; the history records (unbounded count) are wiped after the transaction, orphans are harmless because nothing reads history by a deleted tab id.

Tag names are searched through the tag service's own char-level index (`3_tag`, document `{name, user_id}`, document id = tag id) living on the same local es service as the tab index. Creating a tag follows the tag service's rule: the name is indexed first and the worker's confirmation is awaited, only then the entity is written to DynamoDB, so a tag can never exist without being char-searchable.

Renaming and deleting a tag are not offered from tab cloud for the time being.

Trashing a tab keeps its attach entries untouched; tabs-of-tag listing joins with tab items by id and drops trashed tabs.

### Tab Group

A tab group should only consist of continuous tabs in the same window. A tab group can consist of only one tab.

Groups are stored as items in a group table. A group item's data format:

```text
userId(PK)
id(SK)
title            # optional
color
windowId         # a group lives inside exactly one window
createAt
createAtTimezone
```

A tab records its group by the optional `groupId` field. The group item keeps no member list; the members are exactly the live tabs pointing at the group. Groups of a window are found from its tabs' distinct groupId values.

Continuity is an invariant kept by write operations, not a stored structure. Operations keep it the same way browsers do:

- creating or moving a tab to a position strictly inside another group's range makes the tab join that group
- moving a grouped tab to a position outside its group's range makes it leave the group
- group creation validates the chosen tabs are continuous, by reading the tabs between the smallest and largest chosen rank and checking the set matches exactly
- trashing a tab removes it from its group; when an operation leaves a group with no member, the group item is deleted in the same transaction

Deciding join/leave for one position only reads the neighbor tabs of that position; no scan is needed.

Deleting a group only clears `groupId` on its member tabs; the tabs remain.

A visual design when for showing a tab's group(group is optional, a tab can have no group at all) is to have a row painted with color representing one group:

```text
|icon|(above: title, below: url)|group color block|
|icon|(above: title, below: url)|group color block|
|icon|(above: title, below: url)|group color block|
```

In this way, tabs belonging to same group, their group color block form a vertical color bar. groups that are not neighboring may have same color.

### Meta table

The meta table stores small per-user service data as generic key items:

```text
userId(PK)
metaPath(SK)
...attributes of that item
```

Items currently stored:

- `config`: per-user service config, currently `{windowDefaultId}`. The default window receives uploaded tabs when no window is chosen. If it is unset, trashed, or gone, the backend creates a window titled `default` and stores its id here.
- `journal#{journalAt}#{journalId}`: one index journal item per in-flight write, refer to [Consistency](#consistency-between-dynamodb-and-index). Listing pending journals is one prefix Query.

## Trash

Tabs are deleted to the trash by default. Trashing rewrites the item's SK from the live form to the trash form (delete + put in one transaction), so:

- live listing and context slices naturally exclude trashed tabs
- the trash is listed by one Query on the `trash#` prefix, newest first
- the index document is kept with `isTrashed: true`, so searching inside the trash works exactly like normal search

```text
tabTrash(tabIdList)
  -> one transaction:
       for each tab: delete live item + put trash item (groupId cleared)
       delete group items that lost their last member
       put the journal item
  -> index: docPut each tab with isTrashed true
  -> delete the journal item
```

A window can be trashed only when it contains no live tab (the normal path: trash all its tabs first, or use the window trash api that does both). Restoring works in the other direction:

- `tabRestore(tabIdList, windowIdTarget?)` puts tabs back to a live tabPath.
  - default target is the tab's original window; if that window is trashed, the window is restored first in the same transaction (bringing a tab alive brings its window alive)
  - if the original window is permanently gone, `windowIdTarget` chooses an existing window (the frontend uses the remote window selector for this)
  - the original position is used when its rank is still free, otherwise the tab is appended at the window end
- `tabDeletePermanent(tabIdList)` removes trashed tabs, their relationship items, and their index documents for good.

Group membership is not restored; a restored tab starts ungrouped.

## Index Design(Elasticsearch)

The index needs to be char-level, supporting matching by pure substring matching.

Elasticsearch is used as the default index. But the methods/apis related to indexing that the core logic call, should stay general purposed, so that in the feature we may support other indices, like whoosh, or OpenSearch.

```
core logic --> general api --> specific api(elasticsearch)
```

The general api (implemented in `tab_server_index.py`):

```text
index_ensure()                       # create the index with correct mapping if missing
index_check()                        # -> {is_ok, message}
doc_put(tab)                         # upsert one document, docId = tab id
doc_delete(tab_id)
doc_put_batch(tab_list) / doc_delete_batch(tab_id_list)
search(user_id, query_tree, field_list, is_trashed, limit)
  -> [{tabId, matchList: [{field, indexStart, indexEnd}]}]
```

Core logic never sees an elasticsearch query body or response; another engine only needs to implement these calls.

### Basic Operations Related to Index

User should be able to know/do the following things related to index:

<!-- below part should not be modified-->
1. does the index exists?
2. if so, is its config consistent with how it is designed in doc and assumed  in code?
2.1 recreation/re-initialization the index, which will ask for confirm before doing so, if the index is not empty.
3. if not, init/create the index.
<!-- above part should not be modified-->

The index check reports reachability, existence, document count, and whether
the configured settings and mappings required by the search code are present.
The config comparison checks the required analyzer, tokenizer, shard count,
field types, analyzers, and term vectors. Extra Elasticsearch-managed settings
do not make the check fail.

Index operations are separate:

```text
check
  -> read existence, config, and document count

initialize missing index
  -> create only when missing
  -> never replaces an existing index

recreate index
  -> read document count
  -> non-empty: require an explicit second confirmed request
  -> delete and create with the configured schema
```

Recreation deletes indexed documents, not DynamoDB tab items. The current
account can use index rebuild afterward to copy its DynamoDB tabs into the new
index. Confirmation is an in-page frontend state; browser confirmation dialogs
are not used. The backend also requires the confirmation field, so another
client cannot accidentally skip this protection.

### Index and document format

One document per tab, document id = tab id, so put and delete never need a search.

```jsonc
{
  "userId": "user1",
  "title": "Example Page",
  "url": "https://example.com/",
  "isTrashed": false,
  "contentRevision": 3
}
```

`title` and `url` use a char-level analyzer: a pattern tokenizer with empty pattern splits text into single chars, and a lowercase filter makes search case-insensitive. `match_phrase` on such a field is exactly substring matching.

The two fields store `term_vector: with_positions_offsets`, so the fvh highlighter can mark a whole matched substring as one range (the plain highlighter would mark every single char separately). Match positions are extracted from the highlight tags and returned as `indexStart`/`indexEnd` over the original text, for the frontend to highlight.

Searching only title, or only url, is just choosing which fields receive the `match_phrase` and highlight config. `userId` and `isTrashed` are keyword/boolean filters added to every search, so normal search and trash search share one code path.

### Query expression

The simple case is one query string. The search api also accepts a query tree, so AND/OR/NOT can be added later without changing the api shape:

```jsonc
{"and": [
  {"term": "python"},
  {"or": [{"term": "doc"}, {"term": "tutorial"}]},
  {"not": {"term": "youtube"}}
]}
```

`and` maps to bool.must, `or` to bool.should, `not` to bool.must_not; a `term` leaf becomes one match_phrase per searched field. NOT branches produce no highlight. Only the plain string case is urgent; the tree format just needs to be fixed now.

## Transactions and Consistency

### DynamoDB transactions

Every api that writes more than one item writes them in one `TransactWriteItems` call, so a request either applies completely or not at all. This includes batch apis: uploading a batch of tabs, trashing/restoring/permanently-deleting a batch, moving a batch, assigning a tag to a batch. One transaction holds at most 100 items, so batch apis cap their input (refer to the api doc) and reject larger input with `-4` instead of splitting silently.

Key-changing operations (move, trash, restore) are a delete + put of the same item inside the transaction. Puts of new keys carry an `attribute_not_exists` condition, so a rank collision or a concurrent duplicate aborts the whole transaction instead of overwriting.

Transactions are not limited to this project's tables: tag changes put/delete items of the tag service's obj-tag tables in the same `TransactWriteItems` call (refer to [Tags](#tags)); DynamoDB transactions work across tables in one region.

### Consistency between DynamoDB and index

The api operation's workflow design should ensure that the following situation should be either avoided, or be able to be detected easily, without the need to do full scan of index or dynamodb:

1. A tab item does not have corresponding document in index, or does not have its corresponding index document updated to its latest content.

2. A document in index of one tab exists, but this tab has been deleted.

The index cannot join the DynamoDB transaction, so every write that changes indexed content is wrapped by an index journal:

```text
write request that changes indexed content
  -> compute the change: old item states + new item states (kept in memory)
  -> transactWrite: all db changes + put one journal item {tabIdList}
  -> apply the index actions (doc_put / doc_delete)
  -> index success:
       -> delete the journal item
       -> respond success
  -> index failure:
       -> transactWrite revert: restore the old item states, remove the new ones
       -> index repair for the journal tabIdList (see below)
       -> delete the journal item when repair converged
       -> respond failure
```

So an index failure rolls the DynamoDB change back and the request returns failure; the client sees either full success or no visible change.

If the process crashes anywhere in between, the journal item is left behind. The journal lives in the meta table under the `journal#` prefix, so unfinished writes are found by one cheap Query per user — no full scan. Index repair converges the index to the DynamoDB truth for the journal's tabIds:

```text
index_repair(tabIdList)
  for each tabId:
    read the tab item (gsiTabId)
    item exists      -> doc_put with the item's current content and isTrashed
    item is missing  -> doc_delete
```

Repair is idempotent (doc_put overwrites by id, doc_delete of a missing doc is a no-op) and runs from three places: the failure path above, the `indexRepair` maintenance api, and lazily at login. `contentRevision` in the document tells whether a document already matches the item.

Situation 1 and 2 are therefore both covered: any window in which the index can disagree with DynamoDB is exactly the lifetime of a journal item, and journal items are directly queryable. An orphan index document can only outlive its request if the revert or repair also failed, and then its journal item is still there pointing at it.

Reordering (tabPath change) does not touch the index, because documents store no position data; search results are joined with fresh DynamoDB items anyway.

### Basic Operations

A typical workflow for creating tabs (single create is the batch of one):

```text
tabCreate(windowId | windowTitleNew, tabList, position)
  -> resolve the target window:
       given windowId            -> that live window
       windowTitleNew            -> create a window with that title
       neither, default exists   -> the stored default window
       neither, no live default  -> create a window titled `default`,
                                    store it as windowDefaultId
  -> read the two neighbor tabs of the position
  -> calc one tabLexoRank per tab between the neighbor ranks
  -> if the position is strictly inside a group's range, take that groupId
  -> transactWrite: put all tab items (+ the new window item if created) + journal
  -> doc_put_batch
  -> delete the journal item
```

Updating title/url:

```text
tabUpdate(tabId, title, url)
  -> transactWrite: update item fields, contentRevision + 1, + journal
  -> doc_put
  -> delete the journal item
```

Moving (no indexed content changes, so no journal):

```text
tabMove(tabIdList, targetTabId, placement)
  -> calc new ranks between the target's neighbors (target window may differ)
  -> decide group join / leave by the continuity rule
  -> transactWrite: delete + put each tab item with its new tabPath,
     delete groups left empty
```

Searching (paged with `offset` + `limit`; the response's `isMore` tells whether more results exist past the page):

```text
search(query, isSearchTitle, isSearchUrl, isTrashed, offset, limit)
  -> index search, size offset + limit + 1   # the extra hit answers isMore
  -> cut the [offset, offset + limit) page
  -> batch-get the page's tab items from dynamodb by id (gsiTabId)
  -> drop hits whose item is gone or whose trash state changed meanwhile
  -> respond items joined with match positions, + isMore
```

Paging works over the stable index ranking, and never considers more than the top `SEARCH_INDEX_FETCH_MAX` (500) index hits: past that window `isMore` answers false and paging stops. Page sizes and this cap live in `tab_server_params.py`.

### Search with a tag filter

The search api takes an optional `tagIdList`; results must carry ALL the given tags. The tag filter is answered from the obj-tag table (the membership truth), not from the search index — tag membership is not indexed, and the intersection query is cheap:

```text
search(query?, ..., tagIdList, offset, limit)
  -> one gsi_tag_id query per tag -> intersect into the tagged tab id set
  -> query text empty:
       -> batch-get the tagged tab items, filter to the live/trash scope,
          sort in window order (trash: newest first)
     query text given:
       -> index search at the full considered window (a small size could
          hide tagged tabs ranked after untagged ones), keep hits inside
          the tagged set
  -> cut the [offset, offset + limit) page, respond + isMore
```

Without `tagIdList` the search flow above is unchanged.

Trash, restore, and permanent delete follow the journal workflow above; refer to [Trash](#trash).

Assigning a tag writes the attach entry, one history record (both in the tag service's tables), and the tab item's `tagIdList` in one transaction. The obj-tag table is the truth for membership, `tagIdList` is a display copy. Refer to [Tags](#tags).

## Auth and Config

Config uses the two-layer scheme of `config-two-layer.md`: `config.yaml` holds tracked example values; `config.0.yaml` holds the real values, overrides matching entries, and stays untracked (gitignored).

Auth is transport-specific. On the local server, users are hard coded in config for the time being, as a list of username/password pairs; the username is used as userId. Login exchanges username/password for a signed token; every other api requires the token in the `Authorization: Bearer` header. On the aws backend, login is aws cognito and the token is verified by the api gateway; refer to `../backend-aws/aws_backend_impl.md#login-and-session`.

The elasticsearch config block follows the named-endpoint style shared with other projects: named blocks (for example `local`) each holding `host`, `port`, `scheme`, `index_name`, `number_of_shards`, and `endpoint_use` choosing the active one.

## AWS Integrity and Initialization

The backend does not create tables or an index implicitly. DynamoDB and search
index operations are separate so an action never has an ambiguous target.

- Table check reports existence, ACTIVE status, key schema, GSI schema,
  projection, and billing mode for every table.
- Table initialize creates missing tables and leaves existing tables unchanged.
- Index check reports existence, required config consistency, and document count.
- Index initialize creates only a missing index.
- Index recreate replaces an index, with non-empty confirmation as described above.

Every config check is added to a bounded backend cache. A record contains
`checkId`, `checkType`, `checkAtMs`, `isPassed`, `trigger`, and the typed check
result. The cache keeps the newest 50 records in backend-process memory. A
history query returns a shorter newest-first list, the latest record of each
type, and a derived summary of the latest required checks (both required
check types recorded and passed, or the reason why not).

Config checks run only when explicitly requested: from the cloud settings
panel (each resource tab's check/initialize actions, the status refresh) or by
calling `/api/status` directly. The extension never checks the cloud
configuration on its own — opening the popup, logging in, or entering a panel
mode sends no check request. Consequently no operation is gated on check
results: upload and every other remote feature only require a login, and a
not-ready cloud side surfaces as the failing operation's own error (the
per-tab error of an upload row, the search message line, and so on). The
cloud settings panel shows the check summary and has separate DynamoDB
Tables, Search Index, and Check History tabs.

The older combined `awsCheck` and `awsInit` apis remain compatible, but the
popup uses the separate operations. All apis answer `-5` with a short message
when DynamoDB or the index is unreachable, instead of hanging or crashing; the
extension keeps its local features usable.

## Backend Code Boundaries

```text
backend/tab_server_core.py       # core logic of each api, transport-independent
backend/tab_server_params.py     # centralized tunable parameters (pagination sizes etc.)
backend/tab_server.py            # local transport: flask http entry, local auth, routing
backend/tab_server_index.py      # general index api + elasticsearch implementation
backend/config.yaml              # example config (auth, elasticsearch, server), tracked
backend/config.0.yaml            # real config, untracked

backend-aws/lambda_tab/          # aws transport: lambda entry behind api gateway
backend-aws/tab_server_index_sqs.py  # general index api over the local es service
backend-aws/tab_server_db.py     # dynamodb item access, transactions, lexorank calc, journal
backend-aws/ensure_architect.py  # IaC: table specs + the full aws backend ensure/check/delete
backend-aws/config.yaml          # example aws config (region, keys, table prefix), tracked
backend-aws/config.0.yaml        # real aws config, untracked
```

The core logic of each api stays as a short readable block in `tab_server_core.py`, calling named functions of the db and index modules; refer to `backend-design.md`. Two transports dispatch into it: the local flask server, and the aws lambda (refer to `../backend-aws/aws_backend_impl.md#one-core-two-transports`). Each transport passes its index module to the core; both index modules implement the same general index api.

Everything that talks to aws lives under `backend-aws`, together with its own two config layers. `ensure_architect.py` is the IaC entry: it holds the table specs as the single source of truth and ensures the whole aws backend from the terminal (`python ensure_architect.py`, refer to `../backend-aws/aws_backend_impl.md#ensure-script-iac-entry-point`). The server reaches the same table functions through `tab_server_db.aws_check()` and `aws_init()`, so the maintenance apis and the terminal script cannot diverge.

All responses use the `{code, data, message}` envelope: code 0 for success, negative for failure.

## Frontend Layout

For the extension popup, there should be a separate tab 'Remote' for features related to remotely stored tabs.

Basic layout actually should be similar to 'Search', containing a search area that search only for tabs stored remotedly. Operations should be supported in a similar way.

```text
search bar (+ title/url scope toggles, live/trash scope toggle)
tag filter row (remote tag selector; results must carry all picked tags)
control button group
search result table
```

Everything is driven by the remote MobX store: server data (windows, tabs, tags), request states, and every ui state (search input, selected rows, open panels, selector dropdown state) live in the store; components render from it and send change attempts back.

- Live scope: search results support Open (open in browser), Open + Trash (trash on the backend after the browser confirms the tabs opened), Context (remote context slices, same interaction as local context mode), Move before/after (right-click), and Trash.
- Trash scope: the same search bar searches trashed tabs; results support Restore (to the original window, or to a window picked with the remote window selector) and Delete Permanently.
- Match positions returned by the search api are highlighted with a yellow background.
- The tag filter row narrows both scopes to tabs carrying all the picked tags; with tags picked, an empty search text lists those tabs without text matching (refer to [Search with a tag filter](#search-with-a-tag-filter)). Without picked tags the search request stays the original one.
- Launch rule: with no picked tag the search launches automatically (typing is debounced, scope and title/url toggles re-search). With at least one picked tag the search is launched manually with the Search button of the tag filter row — picking tags, typing, and the toggles then only compose the query, so composing a multi-tag query fires no request per click. Removing the last picked tag resumes the automatic mode right away. Refresh and the after-operation reload always re-run the current query in both modes.
- Results load one page at a time: when the response says more results exist, a Load More button below the result table appends the next page (duplicates from shifted pages are dropped). A new search, a scope switch, or a refresh restarts at the first page. Page sizes live in the popup's `params.ts`, the backend counterparts in `tab_server_params.py`.

### Upload from the Search tab

Uploading uses the right-click menu of the local Search tab plus a confirm popup:

```text
right-click menu
  ├─ Upload selected tab(s) to remote
  └─ Upload this window to remote

upload confirm popup
  ├─ list of tabs to upload, each row showing its own upload state
  ├─ target: remote window selector (default: the default remote window)
  ├─ tags: remote tag selector (default: none); every uploaded tab gets them
  ├─ [x] close each uploaded tab after its upload is confirmed   # default on
  ├─ progress line (uploaded / failed counts) while the run is active
  └─ Upload / Stop / Cancel
```

The 'Current Tab' panel mode of the Search tab is a third opener: it shows only the currently active tab and its upload button opens the same confirm popup prefilled with that one tab (refer to `/doc/tab_ops.md`).

Tabs upload one by one, each in its own api call, so partial failure is allowed: a failed tab is marked with its error and does not block the remaining tabs. A tab is closed right after the backend confirms its own upload (when the checkbox is on), never in a batch at the end, so a browser crash in the middle loses no tab that is not stored remotely yet.

```text
for each tab in the panel list      # tabs keep their select order
  -> stop requested? break here
  -> /api/tab/create with this one tab
  -> success: mark the row uploaded
       -> close the local tab when the checkbox is on
  -> failure: mark the row failed with the message
       -> continue with the next tab
```

While the run is active, the confirm popup stays open and the rest of the ui is locked behind its backdrop; the user waits for the run and only a Stop button stays usable. Clicking the backdrop closes the popup when idle, not while the run is active. Stop breaks the run after the tab currently being processed completes its full logic (success or fail). The result counts (uploaded / failed / not attempted) land in the search message line; a partially failed or stopped run keeps the popup open, and Upload then retries exactly the tabs that are not uploaded yet.

The first successful upload decides the target window when none is chosen; every later tab goes to that same window. If the target is left as the default remote window, and no live default window exists yet (first upload, or the stored default is unset / trashed / gone), the backend creates a window titled `default`, stores it as `windowDefaultId`, and uploads the tab into it. The created window is committed in the same transaction as that first tab.

### Remote window selector

A reusable selector component (conforming to `selector.md`): a search-bar-like area showing the selected window as a tag with a cross icon, and a chevron pointing down at the right. Clicking the bar or the chevron toggles a dropdown with a search field, a Fetch All button, and the window list; clicking outside the selector also closes the dropdown. The tag's cross icon only clears the selection, without toggling the dropdown. It searches the store's cached windows first and asks the server at a bounded frequency; results are cached in the store keyed by id, and each selector instance keeps its own ui state in the store keyed by a selector id, cleared on unmount. It is used by the upload panel and by trash restore.

### Remote tag selector

The tag counterpart (multi selection): picked tags show as chips with a cross icon, the dropdown search field queries `/api/tabTag/search` (the backend char index) instead of filtering a local cache — an empty search text lists the user's tags via `/api/tabTag/list`. Both are paged: the dropdown shows one page and ends with a "Load more tags" row while the backend says more exist; loading a next page keeps the loaded tags visible (the full-list spinner only shows for a fresh search). When no listed tag matches the entered text exactly, the first row offers creating that tag in place (`/api/tabTag/create`); the created tag is not selected automatically — it shows at the top of the list (it matches the entered text) and the user clicks it to add it to the selection. Fetched tags are cached in the store keyed by id for chip display. It is used by the upload panel's tags row, and by the Remote tab's tag filter row — there in-place creation is disallowed (a filter only makes sense over existing tags), which callers choose with the `isCreateAllowed` prop.

Both selector dropdowns open immediately on click and show a spinning circle while their server request (window fetch, tag list/search) is running, so a slow backend never blocks opening the dropdown.

### Toward one unified search bar

Remote search results reuse the shape of local search results: items plus match positions per field, and the same context-slice interaction (`/api/tab/context` mirrors `browserStateQueryTabContext`). A result row additionally carries its source (`local` / `remote`). Keeping the shapes identical lets a future unified search bar merge both sources into one result table without reworking either side.

### Endpoint Config and Login

There should be a settings icon at top right, clicking which will open a popup panel for backend endpoint and login.
Cloud service(aws etc) status should also be reflected in this area.

The popup panel is built from the config-panel component series (`ConfigPanel`
etc.): a backend group (a selector choosing the backend to use — the local
server, or aws directly — plus login/logout of the selected backend), one
settings group per backend (local: endpoint url; aws: api endpoint url,
cognito region and app client id), and a cloud status group. An extension
build embeds those three AWS defaults from `backend-aws/config_gen.yaml` when
they exist; users can override or restore them. The cloud group uses top tabs for DynamoDB Tables, Search
Index, and Check History. Each resource tab owns its check and initialization
actions. The selected backend, both backends' settings, and their login
sessions (local: token; aws: cognito refresh + access token) are stored in
`storage.local`, so switching backends never re-asks for anything.

When the backend or aws is unreachable (frequent during early development), every remote feature shows its error inline and stays retryable; nothing blocks the rest of the popup.

CORS need to be handled carefully for browser extention. Avoid having CORS porblems when extension communicates with backend service.

The backend answers `OPTIONS` preflight requests and returns the `Access-Control-Allow-*` headers on every response. Allowed origins come from config (`server.cors_origin_list`); extension origins look like `chrome-extension://{id}` and `moz-extension://{id}`. An empty configured list allows any origin, which is acceptable while every data api requires the auth token.
