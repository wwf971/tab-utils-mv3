# Live browser state

## Name

The maintained data is called live browser state.

The background subsystem that maintains it is called the browser state tracker.

Live is more accurate than real-time. Browser events are delivered quickly, but an extension service worker can stop and start again. Browser APIs also do not promise a strict maximum delay.

## Core model

The browser is the ultimate truth for windows, tabs, focus, selection, and tab groups.

The background tracker is the extension-facing source of truth. Popup pages, extension windows, search, and save utilities read through the tracker. They do not independently query and combine browser events.

```text
browser APIs
  -> one set of background listeners
  -> normalized browser change
      -> update live browser state
      -> create a smaller recovery event when needed
      -> run existing tab behavior when needed
  -> notify open frontend panels
  -> frontend panels re-fetch data
```

The live state and a snapshot use the same window, tab, and group tree. A live state describes now. A snapshot is a durable checkpoint captured at one time. For the shared tree, refer to [Browser state data](./browser_state_data.md).

## Tracker lifecycle

The tracker has these phases:

- `notReady`: no state can be served yet.
- `scanning`: a complete browser scan is running.
- `ready`: events are updating a complete state.
- `refreshing`: a new scan is running while the last complete state remains readable.
- `error`: no complete state is available.

The public read API normally waits for `ready`. A refresh API may return the last complete state with its observation time while a replacement scan is running.

### Background start

Browser listeners must be registered synchronously when the background script or service worker loads. Asynchronous initialization starts only after listener registration.

```text
register listeners
  -> begin buffering normalized changes
  -> read browserRunId
  -> scan all included windows and tabs
  -> read groups when supported
  -> build one complete state
  -> apply buffered changes in received order
  -> validate indexes, active tabs, selection, and focus
  -> publish state as ready
```

The scan uses `windows.getAll({ populate: true })`. Populated tab objects include `highlighted`, which provides the initial selection state. Optional tab-group data is read in parallel when the API and permission are available.

Changes can occur while the scan is running. They are buffered and then applied after the scanned state is built. Reducers must be idempotent because a scanned result may already include a buffered change.

### Normal event update

Each browser event listener creates one normalized browser change and passes it to one dispatcher. The dispatcher keeps received order and applies the change to the live state.

The normalized change contains the complete information available from that callback. Consumers then select what they need:

- The live tracker keeps current titles, URLs, selection, and other supported properties.
- The recovery log keeps only data needed for recovery. It may omit title changes and coalesce frequent URL changes.
- Existing tab behavior can react to the same change without registering a second listener for the same purpose.

This separation shares event capture without making live state follow the recovery log's reduced data policy.

When a reducer cannot locate an affected object, receives an impossible index, or finds another broken invariant, it keeps known data and requests a full refresh. It does not guess an unrelated tab or window identity.

Windows that are intentionally excluded from the state, such as non-normal windows or private windows while private capture is off, still emit browser events for their tabs. The tracker remembers the excluded window IDs and drops these changes without a refresh. Treating them as inconsistencies caused a continuous rescan loop (refer to [Firefox freeze and crash notes](./issue_firefox_crash.md)).

### Refresh and reconciliation

Events are the normal fast path. A full scan repairs missed, unsupported, or ambiguous changes.

A refresh runs:

- after background or service-worker initialization
- after an explicit `refreshState` request
- after a reducer detects an invariant failure
- when a snapshot performs a complete browser scan
- from a low-frequency reconciliation alarm when no regular snapshot scan is available

Snapshot capture and live-state refresh use one scanner. A successful scan can both replace the live state and become the browser tree of a new snapshot. The browser is queried once for that operation.

The reconciliation alarm is a safety mechanism, not the primary update mechanism. Alarm delivery can be delayed. Its interval should be configurable and should not cause a second scan when a recent snapshot or explicit refresh already produced a complete state.

### Service-worker restart

Global variables are lost when a Manifest V3 service worker stops. The tracker therefore does not claim that an in-memory object is durable.

After each background start, the tracker registers listeners and rebuilds state from browser APIs. `storage.session` may keep a warm cache and freshness information, but that cache cannot be published as current until it has been reconciled. It is cleared when the browser run ends and must not be copied into another browser run.

## Event ownership and ordering

Exactly one background context owns browser listeners.

Each listener should call a shared dispatcher. The handler may have separate consumers for live state, recovery logging, and existing extension behavior, but the browser event itself is captured once.

The dispatcher assigns a received order before asynchronous storage work. Live-state application must not wait for a recovery event to be written. Recovery storage keeps its own durable `eventSequence`.

A scan creates an ordering barrier:

1. Changes received before the scan is published remain buffered.
2. The scanner builds a complete state.
3. Buffered changes are applied in received order.
4. The new state receives a new `stateId`.
5. Later changes increment `stateRevision`.

The pair of `stateId` and `stateRevision` identifies one published revision. A revision number alone is not sufficient because a service-worker restart or full rebuild can start a new state instance.

## Multi-tab selection

Active and selected are different properties.

- Each window has one active tab.
- A window can have multiple selected tabs.
- The active tab is always selected.
- The active tab is the browser-wide focused tab only when its window is focused.

The browser Tab API calls selected tabs highlighted tabs. The common state stores this as `isSelected`.

Initial scan:

```text
populated tab.highlighted
  -> tab.isSelected
```

Event update:

```text
tabs.onHighlighted
  -> windowSourceId and complete tabIds for that window
  -> replace the selected set for that window
```

The event gives the complete selected-ID set for one window. The reducer first clears `isSelected` for tabs in that window, then sets it for the listed IDs. This operation is idempotent.

An explicit selected-tab query may use `tabs.query({ highlighted: true })` for reconciliation. It should not use `active: true`, because that returns only the one active tab in each matching window.

## Background API

Background modules use an internal API. This avoids runtime-message overhead and keeps browser access in one subsystem.

- `getState()` waits for a complete state and returns a read-only copy.
- `refreshState()` performs a complete scan and returns the new state.
- `queryTabs(query)` searches the maintained state and returns matching window and tab data.
- `getTabsSelected(query)` returns selected tabs, optionally limited by window.
- `subscribe(listener)` receives a small change description after a revision is published.

Consumers must not mutate the tracker's arrays or objects. A utility that needs a long operation takes a copy with `stateId` and `stateRevision`, then decides whether a later revision requires revalidation.

### Tab query

`queryTabs` can support optional filters without changing the state format:

- text matched against normalized title and URL
- `windowSourceIds`
- `tabSourceIds`
- `isActive`
- `isSelected`
- `isPinned`
- `isPrivate`
- `groupSourceIds`
- result limit and ordering

Absent filters do not restrict results. Unknown filters produce a validation error instead of being silently ignored.

## Frontend communication

Popup pages and extension-owned windows use `chrome.runtime.sendMessage` for requests and responses.

Initial actions:

- `browserStateGet`
- `browserStateRefresh`
- `browserStateQueryTabs`
- `browserStateQueryTabContext` for the slice of tabs around one tab; refer to [Tab search selection and context view](./search_context.md)

All responses use:

```json
{
  "success": true,
  "stateId": "20260723_22050112+09_a821",
  "stateRevision": 18,
  "result": {}
}
```

An error response uses `success: false` and a short `error` value. Error text must not include complete titles, URLs, or state objects.

After publishing a revision, the background sends:

```json
{
  "action": "browserStateChanged",
  "stateId": "20260723_22050112+09_a821",
  "stateRevision": 19,
  "changeType": "tabUpdated",
  "windowSourceIds": [91],
  "tabSourceIds": [804]
}
```

This message is an invalidation notice, not the state itself. Frontend stores debounce notices and re-fetch through the background. This works for short-lived popups and long-lived extension windows without giving them separate browser listeners.

The first implementation should use request messages and invalidation notices. A long-lived port or revision-delta API should be added only if measured state size or refresh frequency makes full re-fetch too expensive.

## Search and save utilities

Search reads from `queryTabs`. Saving selected tabs starts from `getTabsSelected`. A frontend sends the user's intent to a background utility; it does not write browser-state data directly to local or remote storage.

Live runtime IDs are useful only inside one browser run. A durable saved-tab record therefore has its own stable ID and schema. It copies durable properties such as URL, title, group label, and save time. It may keep runtime IDs as optional origin information, but must not use them as durable identity.

Local save, remote save, upload, and search indexes are separate consumers. Their storage and retry rules do not belong in the live-state tracker.

## Privacy and capabilities

Private windows follow one shared inclusion setting. Excluded private objects must not appear in live state, query results, invalidation details, snapshots, logs, or saved records.

Optional browser fields are recorded only when the API, permission, and browser provide them. State metadata reports relevant capabilities so a missing field can be distinguished from a false value.

Complete URLs and titles are returned only to authorized extension pages and background modules. Change notices contain IDs and change kinds, not full tab content.
