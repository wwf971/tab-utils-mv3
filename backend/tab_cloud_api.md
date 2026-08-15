# Tab Cloud API

Concrete api list of the backend server. For concepts and storage design, refer to [Tab cloud](./tab_cloud.md).

## Common

- All apis live under `/api/`. All use POST with a json body, except `GET /api/status`.
- Except login and status, every request carries header `Authorization: Bearer {token}`.
- Every response uses the envelope:

```jsonc
{
  "code": 0,        // 0: success. < 0: failure, the value doubles as error code
  "data": {},       // only present when there is data to return
  "message": "..."  // only present when there is something to tell, mostly on failure
}
```

- List apis page with a cursor: pass `cursor` from the previous response to get the next page; a response without `cursor` is the last page. `limit` defaults to 100.
- Batch apis run in one DynamoDB transaction. `tabIdList` / `tabList` inputs are capped at 40 per request (a transaction holds at most 100 items); larger input is rejected with `-4`.
- A tab object in responses always has this shape (`matchList` only appears in search results, trash fields only on trashed tabs):

```jsonc
{
  "id": "k3x8q0d2",
  "windowId": "b7n2m4p1",
  "tabPath": "live#b7n2m4p1#h5k2",
  "title": "Example Page",
  "url": "https://example.com/",
  "tagIdList": ["t9d4w7"],
  "groupId": null,
  "createAt": 1784487600120,
  "createAtTimezone": 9,
  "modifyAt": null,
  "trashAt": null
}
```

Error codes:

```text
-1  general failure
-2  auth failed or token expired
-3  target not found
-4  invalid request (also: batch too large, group not continuous)
-5  cloud service (dynamodb / index) unreachable
```

## Auth and Status

### POST /api/auth/login

```jsonc
// request
{"username": "user1", "password": "pass1"}
// data
{"token": "....", "userId": "user1", "expireAt": 1787079600000}
```

### GET /api/status

No auth needed; used by the settings panel to show reachability.

```jsonc
// data
{"isDbOk": true, "isIndexOk": true, "serverTimeMs": 1784487600120}
```

## Window

### POST /api/window/list

request `{cursor?, limit?}` — live windows in rank order.

```jsonc
// data
{
  "windowList": [
    {"id": "b7n2m4p1", "title": "reading list", "tabCount": 18, "createAt": 1784487600120, "createAtTimezone": 9}
  ],
  "cursor": "..." // absent on the last page
}
```

`tabCount` is counted per window with a key-only prefix Query.

### POST /api/window/create

request `{title?}` — appended after the last window. data `{window}`

### POST /api/window/update

request `{windowId, title}`

### POST /api/window/move

request `{windowId, targetWindowId, placement}` — placement is `before` or `after`.

### POST /api/window/trash

request `{windowId}` — trashes the window's remaining live tabs (batch by batch, each batch one transaction) and finally the window item itself.

### POST /api/window/deletePermanent

request `{windowId}` — only allowed on a trashed window; removes the window item for good. Its trashed tabs stay in the trash (restoring them later needs a target window).

## Tab

### POST /api/tab/list

request `{windowId, cursor?, limit?}` → data `{tabList, cursor?}`, in window order.

### POST /api/tab/get

request `{tabIdList}` → data `{tabList}`

### POST /api/tab/create

Batch upload; this is what "upload tabs to remote" from the extension calls. One transaction.

```jsonc
// request
{
  "windowId": null,             // target window id; null/absent = the default window
  "windowTitleNew": null,       // or create a window with this title and use it
  "tabList": [
    {"title": "Example", "url": "https://example.com/"}
  ],
  "targetTabId": null,          // default position: end of the window
  "placement": "after"          // before | after targetTabId, keeping tabList order
}
// data
{"windowId": "b7n2m4p1", "tabList": [/* created tab objects */]}
```

When no window is given and no default window exists (or it is trashed/gone), the backend creates a window titled `default`, stores it as the default, and uses it.

A position strictly inside a group's range makes the created tabs join that group.

### POST /api/tab/update

request `{tabId, title?, url?}`

### POST /api/tab/move

request `{tabIdList, targetTabId, placement}` — moves the tabs next to the target (possibly in another window) in one transaction, keeping their given order. Group join/leave follows the continuity rule.

### POST /api/tab/trash

request `{tabIdList}` — moves the tabs to the trash in one transaction; index documents get `isTrashed: true`. Groups left without members are deleted.

### POST /api/tab/restore

request `{tabIdList, windowIdTarget?}` — one transaction.

- default target: each tab's original window; a trashed original window is restored together
- `windowIdTarget` restores all listed tabs into that existing live window instead (required when an original window is permanently gone, picked with the remote window selector)
- original position when its rank is still free, otherwise appended at the window end; restored tabs start ungrouped

### POST /api/tab/deletePermanent

request `{tabIdList}` — only allowed on trashed tabs; removes the items, their relationship items, and their index documents.

### POST /api/tab/context

The remote counterpart of the local `browserStateQueryTabContext`; feeds the context view.

```jsonc
// request
{"tabId": "k3x8q0d2", "countBefore": 10, "countAfter": 10}
// data
{
  "tabListBefore": [],
  "tabCenter": {},
  "tabListAfter": [],
  "isWindowStartReached": false,
  "isWindowEndReached": true
}
```

### POST /api/trash/list

request `{cursor?, limit?}` → data `{tabList, cursor?}`, newest trashed first.

```jsonc
// data
{"tabList": [/* trashed tab objects, trashAt set */], "cursor": "..."}
```

### POST /api/trash/windowList

request `{cursor?, limit?}` → data `{windowList, cursor?}`, trashed windows, newest first.

## Tag

### POST /api/tag/create

request `{tagName, color?}` → data `{tag}`. Fails with -4 if the user already has a tag with this name.

### POST /api/tag/list

request `{}` → data `{tagList}`, ordered by tagName.

### POST /api/tag/update

request `{tagId, tagName?, color?}` — a rename is delete + put of the tag item in one transaction.

### POST /api/tag/delete

request `{tagId}` — deletes its relationship items and removes the tagId from member tabs, one transaction.

### POST /api/tag/assign

request `{tagId, tabIdList}` — one transaction; already-assigned tabs are skipped silently.

### POST /api/tag/remove

request `{tagId, tabIdList}` — one transaction.

### POST /api/tag/tabList

request `{tagId, cursor?, limit?}` → data `{tabList, cursor?}`, in window order (from the relationship items' tabPath sort key); trashed tabs are dropped after the join.

## Group

### POST /api/group/create

request `{tabIdList, title?, color}` — the tabs must be continuous in one window, otherwise -4. One transaction. data `{group}`

### POST /api/group/update

request `{groupId, title?, color?}`

### POST /api/group/delete

request `{groupId}` — clears `groupId` on member tabs in one transaction; the tabs remain.

## Meta

### POST /api/meta/get

request `{}` → data `{windowDefaultId}` (null when unset)

### POST /api/meta/update

request `{windowDefaultId}` — must be an existing live window.

## Search

### POST /api/search

```jsonc
// request
{
  "query": "python doc",     // a plain string, or a query tree (refer to tab_cloud.md#query-expression)
  "isSearchTitle": true,
  "isSearchUrl": true,
  "isTrashed": false,        // true searches inside the trash
  "limit": 100
}
// data
{
  "tabList": [
    {
      // ... normal tab object fields ...
      "matchList": [
        {"field": "title", "indexStart": 3, "indexEnd": 13},
        {"field": "url", "indexStart": 20, "indexEnd": 30}
      ]
    }
  ]
}
```

Matching is case-insensitive pure substring matching. `indexStart`/`indexEnd` are char positions over the original text, end exclusive, for frontend highlighting. At least one of `isSearchTitle` / `isSearchUrl` must be true.

## Maintenance

### POST /api/maintenance/awsCheck

request `{}` — reports without changing anything.

```jsonc
// data
{
  "tableList": [
    {"tableName": "tabCloudTab", "isExisting": true, "statusText": "ACTIVE"}
  ],
  "index": {"isExisting": true, "indexName": "tab_cloud_tab"},
  "journalPendingCount": 0
}
```

### POST /api/maintenance/awsInit

request `{}` — creates missing tables (with GSIs, on-demand billing) and the missing index, waits until active, then returns the same data as awsCheck.

### POST /api/maintenance/indexRepair

request `{}` — runs index repair for every pending journal of the current user (refer to tab_cloud.md#consistency-between-dynamodb-and-index).
data `{repairCount}`

### POST /api/maintenance/indexRebuild

request `{}` — rewrites every tab (live and trashed) of the current user into the index; used after switching index engine or losing the index. Can take time.
data `{docCount}`
