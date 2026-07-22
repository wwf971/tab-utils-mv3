# Browser snapshots and event storage

## Core concepts

The snapshot system has four durable concepts.

- A snapshot is one complete view of open windows, ordered tabs, focus, selection, and optional tab groups.
- An event records one tab, window, or tab-group change after a snapshot.
- A catalog lists storage keys and small metadata without loading every stored object.
- A browser run identifies one browser lifetime. Browser tab and window IDs are only meaningful inside that run.

Snapshots are checkpoints. Events are the changes after a checkpoint. For restoring a snapshot with or without event replay, refer to [Snapshot recovery](./snapshot_recover.md).

All capture, event, and retention logic runs in the extension background context. The popup manages settings, shows status, and starts explicit actions.

## Normal workflow

### Browser start

The background logic registers browser event listeners synchronously.

It then:

1. Loads `snapshotConfigV1` from `storage.sync`.
2. Gets or creates `browserRunId` in `storage.session`.
3. Loads the local catalogs.
4. Verifies that the snapshot alarm exists.
5. Records a browser-run start event.
6. Repairs catalogs only when normal validation finds missing or inconsistent records.

`storage.session` survives a Manifest V3 service-worker restart but is cleared when the browser exits. This prevents a service-worker restart from being mistaken for a new browser run.

### Automatic snapshot

The default snapshot interval is five minutes. It is configurable in the Snapshots popup tab and stored as `snapshotIntervalMinute`. Changing it recreates the alarm. `chrome.alarms` must be used because `setInterval` is not durable when a Manifest V3 service worker stops.

An alarm can be delayed by the browser. The configured interval is a request, not a strict schedule.

Snapshot retention has a separate cleaning alarm controlled by `cleanIntervalMinute`. Snapshot creation does not run retention directly. A successful manual snapshot recreates both alarms, so the next automatic snapshot and cleaning run are each one full configured interval away.

Snapshot creation uses the serialized storage task queue:

1. Close the active event chunk.
2. Record the last persisted event sequence as `eventSequenceCutoff`.
3. Read all included windows with their tabs.
4. Read tab-group data when group capture is enabled and the API is available.
5. Build and validate the complete snapshot.
6. Write the snapshot object.
7. Read it back and validate its identity and schema version.
8. Add it to the snapshot catalog.
9. Delete old closed event chunks.
10. Update storage usage and warning state.

Browser events that arrive during capture wait behind the snapshot task. They receive a sequence greater than `eventSequenceCutoff`. The captured browser state may already contain such a change, but replay remains correct because event application is idempotent.

If snapshot writing or validation fails, the old catalog and event log remain usable. Event cleanup only runs after the new snapshot has been committed to the catalog.

### Recovery

Recovery modes, replay behavior, tab ordering, restoration batching, and browser-specific details are documented in [Snapshot recovery](./snapshot_recover.md).

## Snapshot data

The required time text format is `YYYYMMDD_HHmmssSS+HH`. It has ten-millisecond precision and a signed timezone offset in hours, for example `20260720_04000012+09`.

Epoch millisecond values are also stored. They are the source of truth for ordering and retention. Formatted time text is for display and export.

Example snapshot:

```json
{
  "schemaVersion": 1,
  "snapshotId": "20260720_04000012+09_f3a1",
  "browserRunId": "20260720_00010203+09_71bc",
  "snapshotGenerateAtMs": 1784487600120,
  "snapshotGenerateAtText": "20260720_04000012+09",
  "snapshotCaptureStartAtMs": 1784487600080,
  "snapshotCaptureEndAtMs": 1784487600120,
  "eventSequenceCutoff": 1842,
  "windowFocusedSourceId": 91,
  "tabFocusedSourceId": 804,
  "metadata": {
    "windowCountTotal": 2,
    "tabCountTotal": 18,
    "snapshotSizeByte": 6214,
    "isPrivateIncluded": false,
    "isTabGroupIncluded": true,
    "isTabSelectionIncluded": true
  },
  "windows": [
    {
      "windowSourceId": 91,
      "windowIndex": 0,
      "windowType": "normal",
      "windowState": "normal",
      "isFocused": true,
      "isPrivate": false,
      "left": 20,
      "top": 30,
      "width": 1400,
      "height": 900,
      "tabActiveSourceId": 804,
      "tabs": [
        {
          "tabSourceId": 804,
          "tabIndex": 0,
          "title": "Example",
          "url": "https://example.com/",
          "isActive": true,
          "isSelected": true,
          "isPinned": false,
          "groupSourceId": 14
        }
      ],
      "groups": [
        {
          "groupSourceId": 14,
          "title": "Reference",
          "color": "blue",
          "isCollapsed": false
        }
      ]
    }
  ]
}
```

`windowSourceId`, `tabSourceId`, and `groupSourceId` are browser-provided runtime IDs. They are not stable across browser runs. Recovery keeps snapshot and event identities inside one browser run; refer to [Window identity during replay](./snapshot_recover.md#window-identity-during-replay).

The active tab is the focused tab only when its window is focused. Every window may have one active tab. `windowFocusedSourceId` and `tabFocusedSourceId` make the browser-wide focus explicit.

Native multi-tab selection is stored as `isSelected`. It comes from `tab.highlighted`. The snapshot query already returns this field in both Chrome and Firefox, so polling is not needed.

When group capture is enabled, each grouped tab stores `groupSourceId`, while the group object stores title, color, and collapsed state. Group capture is skipped with a recorded capability status when `chrome.tabGroups` is unavailable or permission is not present.

Private windows are controlled by `isPrivateIncluded`. The default is false. Changing this setting affects future snapshots and events; it does not rewrite old records.

### Snapshot size

`snapshotSizeByte` is the UTF-8 byte length of the serialized snapshot with `metadata.snapshotSizeByte` omitted. Omitting the field avoids a self-referential size calculation.

Actual snapshot storage usage is measured with `storage.local.getBytesInUse(snapshotKeys)`. Event-log usage and total extension-local usage are measured separately. If that method is unavailable, the fallback is the UTF-8 encoded size of known catalog keys and values. The fallback is an estimate and is marked as such in maintenance state.

## Event data

Each event contains:

- `schemaVersion`
- `eventId`
- `browserRunId`
- `eventSequence`
- `eventAtMs`
- `eventAtText`
- `eventType`
- IDs needed to locate the affected object
- the smallest complete state change needed by recovery

Example:

```json
{
  "schemaVersion": 1,
  "eventId": "20260720_04010123+09_1843",
  "browserRunId": "20260720_00010203+09_71bc",
  "eventSequence": 1843,
  "eventAtMs": 1784487661230,
  "eventAtText": "20260720_04010123+09",
  "eventType": "tabUpdated",
  "tabSourceId": 804,
  "windowSourceId": 91,
  "change": {
    "url": "https://example.com/page"
  }
}
```

The log covers current non-deprecated browser events relevant to state reconstruction.

Tab events:

- `tabCreated`
- `tabUpdated`
- `tabMoved`
- `tabActivated`
- `tabHighlighted`
- `tabAttached`
- `tabDetached`
- `tabRemoved`
- `tabReplaced` when supported
- `tabZoomChanged`

Window events:

- `windowCreated`
- `windowRemoved`
- `windowFocusChanged`
- `windowBoundsChanged`

Tab-group events when supported:

- `tabGroupCreated`
- `tabGroupUpdated`
- `tabGroupMoved`
- `tabGroupRemoved`

Tab title changes are not logged. Titles can change very frequently for clocks, stock prices, unread counts, and media status, while they do not determine which page recovery opens. A full snapshot still stores the current title for display.

URL changes are logged with a configurable per-tab maximum frequency, default ten seconds. The first change is recorded immediately. Further changes inside the interval are coalesced in memory, and the newest URL is recorded at the interval boundary. This limits one tab to one URL event per interval without retaining stale intermediate URLs. If the background worker stops before a pending URL is flushed, the next full snapshot still captures the current URL.

Other `tabUpdated` events retain only state needed by recovery, including pin, mute, discarded, and group membership changes. Repeated application of the same update produces the same reconstructed state.

Snapshots and events retain the index information needed for tab ordering. Replay and browser restoration details are documented in [Snapshot recovery](./snapshot_recover.md#tab-order).

Create events carry the complete initial object. Remove events carry the final known location and identity. Move, attach, and detach events carry both old and new location data when the browser API provides it.

Unsupported events are not emulated by polling. Capability information in maintenance state explains which optional event sources are active.

## Local storage format

Storage keys have a version in both the key and value.

```text
snapshotCatalogV1
snapshotDataV1:<snapshotId>
eventCatalogV1
eventChunkV1:<browserRunId>:<chunkId>
snapshotMaintenanceV1
```

### Snapshot catalog

`snapshotCatalogV1` is small and ordered from newest to oldest.

```json
{
  "schemaVersion": 1,
  "snapshotItems": [
    {
      "snapshotId": "20260720_04000012+09_f3a1",
      "storageKey": "snapshotDataV1:20260720_04000012+09_f3a1",
      "browserRunId": "20260720_00010203+09_71bc",
      "snapshotGenerateAtMs": 1784487600120,
      "snapshotGenerateAtText": "20260720_04000012+09",
      "windowCountTotal": 2,
      "tabCountTotal": 18,
      "snapshotSizeByte": 6214,
      "isPinned": false
    }
  ]
}
```

The catalog supports list, pinning, retention, and exact-key reads without loading snapshot bodies. `isPinned` belongs to the catalog entry because retention does not load snapshot bodies. Entries created by older extension versions without this field are treated as unpinned.

The complete snapshot keeps its own `metadata` object, and the catalog stores an independent copy of all metadata needed by listing and cleaning. Retention reads only `snapshotCatalogV1`; it does not read full snapshot objects. A metadata copy is updated only when the corresponding complete snapshot has first been written and validated.

### Event catalog and chunks

`eventCatalogV1` lists all known chunks and the next sequence.

```json
{
  "schemaVersion": 1,
  "eventSequenceNext": 1844,
  "chunkActiveId": "20260720_0401_17",
  "chunks": [
    {
      "chunkId": "20260720_0401_17",
      "storageKey": "eventChunkV1:20260720_00010203+09_71bc:20260720_0401_17",
      "browserRunId": "20260720_00010203+09_71bc",
      "eventSequenceFirst": 1831,
      "eventSequenceLast": 1843,
      "eventAtFirstMs": 1784487540100,
      "eventAtLastMs": 1784487661230,
      "eventCount": 13,
      "isClosed": false
    }
  ]
}
```

Each chunk object contains `schemaVersion`, chunk identity, and an ordered `events` array.

The active chunk rolls when any configured limit is reached:

- age, default one minute
- event count, default 256
- encoded size, default 256 KiB

Only one active chunk exists. A serialized queue prevents two event callbacks from assigning the same sequence or overwriting each other.

### Maintenance state

`snapshotMaintenanceV1` contains:

- last snapshot success time
- last snapshot error time and short error text
- last retention time
- last catalog repair time
- snapshot count
- event count across all cataloged chunks
- actual or estimated snapshot storage bytes
- actual or estimated event-log storage bytes
- actual or estimated total extension-local storage bytes
- configured warning bytes
- `isStorageWarning`
- `isStorageSizeEstimated`
- active browser capability flags

Error text must not contain complete URLs, titles, or snapshot bodies.

## Why event chunks are used

`storage.local` does not support a key-prefix query. It can read exact keys, all keys, or all values. `getKeys()` still returns every key before application-side filtering.

Normal operations therefore use exact storage keys from the two catalogs. Prefix filtering is reserved for catalog repair. Repair uses `storage.local.getKeys()` when available and falls back to `storage.local.get(null)`.

One storage object for the entire event history is not suitable. Every event would read and rewrite an ever-growing array, increase write contention, and make corruption affect the full log.

One storage object for every event is also not suitable. It creates many keys, increases catalog and serialization overhead, and makes cleanup require large key lists.

Bounded chunks keep writes and cleanup limited while preserving ordered durable events. The current chunk is rewritten as it grows, but its maximum size is controlled. Closed chunks are immutable.

### Catalog consistency

`storage.local` does not provide a transaction spanning multiple keys.

For creation, the data object is written and validated before its catalog entry. A crash can leave an unlisted object, but cannot make the catalog claim that an incomplete new object is valid.

For deletion, the data object is removed before its catalog entry. A crash can leave a stale catalog entry, which readers skip and catalog repair removes.

Catalog repair:

1. Reads keys once.
2. Finds versioned snapshot and event-chunk keys.
3. Validates each candidate object.
4. Rebuilds catalog entries.
5. Removes invalid entries only after the rebuilt catalog is committed.

Repair is not part of normal snapshot creation.

## Event cleanup

The default overlap is one minute.

After snapshot commit, event cleanup calculates:

```text
eventDeleteBeforeMs = snapshotGenerateAtMs - eventOverlapMs
```

It deletes only closed chunks whose `eventAtLastMs` is earlier than `eventDeleteBeforeMs`. The active chunk and every chunk crossing the boundary remain.

The overlap gives diagnostic context and protects against time-boundary uncertainty. Recovery does not depend on timestamp filtering. It applies only events with `eventSequence` greater than the snapshot's `eventSequenceCutoff`, so preserved pre-snapshot events are not applied twice.

If a chunk contains both old and new events, the whole chunk remains. Cleanup does not rewrite a closed chunk merely to remove a few old events.

## Snapshot retention

Retention removes snapshots that are too close together as they age.

Default tiers:

```text
Age from now       Minimum spacing
0 to 1 hour        4 minutes
1 to 24 hours      55 minutes
1 to 7 days        23 hours
7 to 30 days       6 days 23 hours
Older than 30 days 29 days 23 hours
```

All tier boundaries and minimum spacings are configurable. The default five-minute snapshot alarm normally leaves every recent snapshot because adjacent snapshots are more than four minutes apart.

The retention algorithm:

1. Sort complete snapshot catalog items from newest to oldest.
2. Divide them by current age.
3. In each non-empty tier, keep the newest item.
4. Continue toward older items in that tier.
5. Keep an item when its distance from the last kept item is at least the tier minimum spacing.
6. Remove the other items only after the complete keep set is known.
7. Never remove the newest complete snapshot.
8. Never remove a pinned snapshot.

The first snapshot in adjacent tiers can be close to the last snapshot in the previous tier. Preserving the newest snapshot of each tier makes boundary behavior stable and understandable.

These values are minimum kept spacings, not maximum recovery gaps. Browser sleep, shutdown, alarm delay, write failure, or disabled capture can create a larger gap.

The oldest tier has no age limit. Its snapshots remain at roughly monthly spacing for as long as storage is available.

## Settings

Feature settings are stored as one small `snapshotConfigV1` object in `storage.sync`.

```json
{
  "schemaVersion": 1,
  "isSnapshotEnabled": true,
  "isEventLogEnabled": true,
  "snapshotIntervalMinute": 5,
  "cleanIntervalMinute": 10,
  "isPrivateIncluded": false,
  "isTabGroupIncluded": true,
  "isTabSelectionIncluded": true,
  "tabUrlEventIntervalSecond": 10,
  "eventOverlapMinute": 1,
  "eventChunkAgeMinute": 1,
  "eventChunkCountMax": 256,
  "eventChunkSizeByteMax": 262144,
  "storageWarningByte": 8388608,
  "retentionTiers": [
    { "ageMaxMinute": 60, "spacingMinMinute": 4 },
    { "ageMaxMinute": 1440, "spacingMinMinute": 55 },
    { "ageMaxMinute": 10080, "spacingMinMinute": 1380 },
    { "ageMaxMinute": 43200, "spacingMinMinute": 10020 },
    { "ageMaxMinute": null, "spacingMinMinute": 43140 }
  ]
}
```

Validation requires positive alarm and spacing values, ascending age boundaries, and bounded chunk limits. Invalid saved values fall back individually to defaults and produce a settings warning.

Changing either interval recreates its alarm. A successful manual snapshot resets both alarm schedules. Disabling snapshots removes the snapshot alarm but does not delete stored data. Disabling event logging closes the active chunk and stops new event writes.

## Storage capacity and manual cleanup

The Common popup tab shows snapshot count and size, event count and size, and total extension-local storage size. Normal state reads use the last maintenance values so event-driven popup refreshes do not repeatedly scan extension storage. Snapshot, deletion, and cleaning actions update the values, and the explicit usage refresh measures them on demand.

The configurable warning threshold applies to the total size of all snapshots. Total extension-local usage is also shown because the browser quota applies to snapshots, event logs, and other local records together. When snapshot usage reaches the threshold, the popup shows an inline warning. It must not use a browser alert or confirmation dialog.

The popup uses a fixed larger size and top configuration tabs for Common and Snapshots. The Snapshots tab contains automatic-capture settings, a fixed-height `FolderView` snapshot list, a horizontally scrollable control button group, and the cleaning policy. Snapshot rows display the required formatted timestamp as their name, a pinned-state column, and separate window and tab count columns.

The snapshot workspace uses `TabsOnTop`. Its first tab is the snapshot list and cannot be closed. Opening detail creates or focuses one detail tab per snapshot. Each detail has a window sidebar and a fixed-height `FolderView` tab table. Deleting a snapshot from its detail closes that detail tab after storage deletion succeeds.

`PopupStore` is the popup source of truth. It owns settings, selected rows, open detail tabs, active tabs, selected detail windows, column widths, button offsets, request status, and loaded snapshot data. Render components receive data and configuration and send change attempts back to the store.

The Restore panel is documented in [Snapshot recovery](./snapshot_recover.md#restore-panel).

Retention durations are displayed as readable text such as `6 days 23 hours`. Each duration element uses its `title` property to expose the exact minute count and supports committing a readable duration or exact minute value. Manual cleaning locks the complete configuration panel until cleaning finishes.

Manual actions include:

- create a snapshot now
- pin or unpin selected snapshots
- run retention now
- delete selected snapshots
- delete oldest snapshots until usage is below a user-entered target
- delete event logs already covered by the newest snapshot
- rebuild catalogs

Destructive actions use an in-page confirmation state.

Quota failure is handled as a normal storage error. The previous valid snapshot and event log remain available, the failed snapshot is not cataloged, no event cleanup occurs, and the popup shows the stored error.

### Unlimited storage build parameter

`unlimitedStorage` is a manifest permission and cannot be toggled at runtime.

The build has a parameter such as:

```text
BUILD_IS_SNAPSHOT_STORAGE_UNLIMITED=true
```

When true, manifest generation includes `unlimitedStorage`. When false, it does not. Chrome and Firefox packages can choose the value independently.

The warning threshold remains active in both builds. Unlimited storage reduces browser quota restrictions but does not guarantee available disk space.

## Code boundaries

The feature should be split into small background modules while keeping `background.js` as the entry and coordinator.

Suggested modules:

```text
background/snapshot-config.js
background/snapshot-base.js
background/snapshot-storage.js
background/snapshot-capture.js
background/snapshot-retention.js
background/event-log.js
background/recovery.js
```

Responsibilities:

- `snapshot-config.js` loads defaults, validates settings, and manages the alarm.
- `snapshot-base.js` formats required time text, creates collision-safe IDs, and owns shared constants.
- `snapshot-storage.js` owns catalogs, exact-key access, serialized writes, size checks, and repair.
- `snapshot-capture.js` converts browser windows, tabs, selection, focus, and groups into a snapshot.
- `snapshot-retention.js` computes a complete keep and delete set without storage side effects.
- `event-log.js` registers event handlers, assigns sequence numbers, and rolls chunks.
- `recovery.js` applies ordered events to a snapshot-derived state model.

The existing `background.js` listeners should call the event logger from the same handler that performs current extension behavior. This avoids duplicate listeners whose ordering is unclear.

`manifest.json` needs the `alarms` permission. It needs `tabGroups` when group details are enabled in a distributable build. Build generation conditionally adds `unlimitedStorage`.

The root package scripts must include new background files in both Chrome and Firefox archives. The Firefox `background.scripts` list and Chrome `background.service_worker` entry must load modules in a compatible order.

`popup/src/App.tsx` remains the settings and maintenance UI. Snapshot data management stays in the background and is accessed through runtime messages. Large snapshot objects are not placed in `storage.sync`.

The local development browser mock needs `storage.local`, `storage.session`, alarms, usage measurement, and the new runtime-message actions before the popup status and maintenance controls can be tested outside an installed extension.

## Verification

Automated tests should cover:

- time formatting in positive and negative timezones
- collision-safe IDs inside the same ten-millisecond unit
- snapshot schema validation and serialization
- UTF-8 byte calculation
- highlighted tabs and focused-window mapping
- group API present, absent, and denied
- private-window inclusion settings
- every event reducer
- duplicate event application
- sequence ordering across chunk rotation
- event cleanup at, before, and after the one-minute boundary
- all retention tier boundaries
- delayed and missing snapshots
- catalog inconsistency and repair
- quota failure without event deletion
- service-worker restart inside one browser run
- new browser-run creation after browser restart
- Chrome and Firefox packages with unlimited storage on and off

Manual browser checks should cover:

- multiple normal windows
- multiple selected tabs in Chrome and Firefox
- active tabs in focused and unfocused windows
- grouped and ungrouped tabs
- a service-worker stop between events
- browser restart after an event but before the next snapshot
- popup warning and in-page manual cleanup
