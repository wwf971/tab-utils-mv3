

<!-- this document should be kept concise. AI agent is allowed to modify, but should not largely paraphrase for some content apparently is human writte, if not asked to -->

# Tab Cloud

Tab Cloud stores tabs remotely. The extension talks to a backend server, the backend stores data in AWS DynamoDB, and a char-level index (Elasticsearch, deployed on local network devices) serves substring search over title/url.

```text
extension popup('Remote' tab, upload panels in 'Search' tab)
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

There are six DynamoDB tables, named `{table_name_prefix}` + `Window` / `Tab` / `Tag` / `TabTag` / `Group` / `Meta`. `PK`/`SK` mark the table primary key; `GSI` marks a global secondary index.

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

tagIdList        # display copy of tag membership; the relationship table is the truth
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

Looking a tab up by id alone uses the GSI `gsiTabId`. Because tabPath is a key attribute, moving a tab means delete + put of the tab item inside one transaction, plus rewriting the tabPath copies in its tag relationship items.

### Tags

Tabs are allowed to have unfixed number of tags. Tags are stored as items in a tag table. 
The relationship that a tab has a tag is stored in a separate table.
And tabs mainly record the tag they have by tag id, not tag name. 

A tag item's data format:

```text
userId(PK)
tagName(SK)      # lists one user's tags in name order, makes the name unique
id               # GSI gsiTagId: (id)
color            # optional
createAt
createAtTimezone
```

A tab--have-->tag relationship item format:

```text
tagId(PK)
tabPath(SK)      # denormalized copy of the tab's live tabPath
tabId            # GSI gsiTabTag: (tabId, tagId), finds the relationship items of one tab
userId
createAt
createAtTimezone
```

It is allowed to have some demormalization by putting some tabPath into the relationship item, so we can use tabPath as the sort Key: querying one tag partition returns its tabs already in window order, without reading every tab item first. The cost is that moving a tab must rewrite that tab's relationship items (found through gsiTabTag) in the same transaction; a tab has few tags, so this stays cheap.

Trashing a tab keeps its relationship items untouched; tag listing joins with tab items by id and drops trashed tabs. Renaming a tag is delete + put of the tag item (tagName is its SK) and touches nothing else, because tabs reference tags by id. Deleting a tag deletes its relationship items and removes the tagId from each member tab's `tagIdList`.

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

Key-changing operations (move, trash, restore, tag rename) are a delete + put of the same item inside the transaction. Puts of new keys carry an `attribute_not_exists` condition, so a rank collision or a concurrent duplicate aborts the whole transaction instead of overwriting.

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
     rewrite their relationship items, delete groups left empty
```

Searching:

```text
search(query, isSearchTitle, isSearchUrl, isTrashed, limit)
  -> index search -> tabIds + match positions
  -> batch-get tab items from dynamodb by id (gsiTabId)
  -> drop hits whose item is gone or whose trash state changed meanwhile
  -> respond items joined with match positions
```

Trash, restore, and permanent delete follow the journal workflow above; refer to [Trash](#trash).

Assigning a tag writes the relationship item and the tab item's `tagIdList` in one transaction. The relationship table is the truth for membership, `tagIdList` is a display copy.

## Auth and Config

Config uses the two-layer scheme of `config-two-layer.md`: `config.yaml` holds tracked example values; `config.0.yaml` holds the real values, overrides matching entries, and stays untracked (gitignored).

Users are hard coded in config for the time being, as a list of username/password pairs; the username is used as userId. Login exchanges username/password for a signed token; every other api requires the token in the `Authorization: Bearer` header.

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
type, and the derived upload readiness.

```text
latest DynamoDB table check passed
  + latest search index check passed
    -> upload allowed

missing or failed latest required check
    -> upload blocked
    -> user runs the relevant check
    -> passing result removes the block
```

The popup fetches cached checks after loading a saved login and after login.
Upload entry points, including right-click menu items and the final Apply
action, use the same readiness state. The cloud settings panel has separate
DynamoDB Tables, Search Index, and Check History tabs.

The older combined `awsCheck` and `awsInit` apis remain compatible, but the
popup uses the separate operations. All apis answer `-5` with a short message
when DynamoDB or the index is unreachable, instead of hanging or crashing; the
extension keeps its local features usable.

## Backend Code Boundaries

```text
backend/tab_server.py        # http entry, auth, api routing, core logic of each api
backend/tab_server_db.py     # dynamodb tables, item access, transactions, lexorank calc, journal
backend/tab_server_index.py  # general index api + elasticsearch implementation
backend/config.yaml          # example config, tracked
backend/config.0.yaml        # real config, untracked
```

The server framework is FastAPI. The core logic of each api stays as a short readable block in `tab_server.py`, calling named functions of the db and index modules; refer to `backend-design.md`.

All responses use the `{code, data, message}` envelope: code 0 for success, negative for failure.

## Frontend Layout

For the extension popup, there should be a separate tab 'Remote' for features related to remotely stored tabs.

Basic layout actually should be similar to 'Search', containing a search area that search only for tabs stored remotedly. Operations should be supported in a similar way.

```text
search bar (+ title/url scope toggles, live/trash scope toggle)
control button group
search result table
```

Everything is driven by the remote MobX store: server data (windows, tabs, tags), request states, and every ui state (search input, selected rows, open panels, selector dropdown state) live in the store; components render from it and send change attempts back.

- Live scope: search results support Open (open in browser), Open + Trash (trash on the backend after the browser confirms the tabs opened), Context (remote context slices, same interaction as local context mode), Move before/after (right-click), and Trash.
- Trash scope: the same search bar searches trashed tabs; results support Restore (to the original window, or to a window picked with the remote window selector) and Delete Permanently.
- Match positions returned by the search api are highlighted with a yellow background.

### Upload from the Search tab

Uploading uses the right-click menu of the local Search tab plus an inline panel (same pattern as the bring-tabs panel):

```text
right-click menu
  ├─ Upload selected tab(s) to remote
  └─ Upload this window to remote

upload panel
  ├─ list of tabs to upload
  ├─ target: remote window selector (default: the default remote window)
  ├─ [x] close uploaded tabs on success   # default on
  └─ Apply / Cancel
```

The upload is one batch api call in one backend transaction. Local tabs are closed only after the backend confirms success, and only when the checkbox is on.

If the target is left as the default remote window, and no live default window exists yet (first upload, or the stored default is unset / trashed / gone), the backend creates a window titled `default`, stores it as `windowDefaultId`, and uploads the tabs into it. The created window is committed in the same transaction as the tabs.

### Remote window selector

A reusable selector component (conforming to `selector.md`): a search-bar-like area showing the selected window as a tag with a cross icon, and an edit icon opening a dropdown with a search field, a Fetch All button, and the window list. Clicking outside the selector closes the dropdown. It searches the store's cached windows first and asks the server at a bounded frequency; results are cached in the store keyed by id, and each selector instance keeps its own ui state in the store keyed by a selector id, cleared on unmount. It is used by the upload panel and by trash restore.

### Toward one unified search bar

Remote search results reuse the shape of local search results: items plus match positions per field, and the same context-slice interaction (`/api/tab/context` mirrors `browserStateQueryTabContext`). A result row additionally carries its source (`local` / `remote`). Keeping the shapes identical lets a future unified search bar merge both sources into one result table without reworking either side.

### Endpoint Config and Login

There should be a settings icon at top right, clicking which will open a popup panel for backend endpoint and login.
Cloud service(aws etc) status should also be reflected in this area.

The popup panel is built from the config-panel component series (`ConfigPanel`
etc.): an endpoint/login group (endpoint url, username, password,
login/logout), and a cloud status group. The cloud group uses top tabs for
DynamoDB Tables, Search Index, and Check History. Each resource tab owns its
check and initialization actions. The endpoint url, username, and token are
stored in `storage.local`.

When the backend or aws is unreachable (frequent during early development), every remote feature shows its error inline and stays retryable; nothing blocks the rest of the popup.

CORS need to be handled carefully for browser extention. Avoid having CORS porblems when extension communicates with backend service.

The backend answers `OPTIONS` preflight requests and returns the `Access-Control-Allow-*` headers on every response. Allowed origins come from config (`server.cors_origin_list`); extension origins look like `chrome-extension://{id}` and `moz-extension://{id}`. An empty configured list allows any origin, which is acceptable while every data api requires the auth token.
