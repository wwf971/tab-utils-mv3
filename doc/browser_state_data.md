# Browser state data

## Purpose

Live browser state and snapshots describe the same browser tree:

```text
browser state
  -> ordered windows
      -> ordered tabs
      -> optional tab groups
  -> focused window
  -> focused tab
```

They use different envelopes around that tree.

- Live state adds an observation identity and revision.
- A snapshot adds durable checkpoint identity, capture times, and recovery cutoff.

This document defines the common tree once. [Live browser state](./browser_state.md) explains how it is maintained. [Browser snapshots and event storage](./snapshot.md) explains durable checkpoints and recovery events.

## Common browser tree

The common tree fields are:

- `browserRunId`
- `windowFocusedSourceId`
- `tabFocusedSourceId`
- `metadata`
- `windows`

The array order is meaningful. `windows` uses `windowIndex`, and each window's `tabs` array follows `tabIndex`.

### Browser run and source IDs

`browserRunId` identifies one browser lifetime.

`windowSourceId`, `tabSourceId`, and `groupSourceId` are IDs supplied by the browser. They are valid only inside their browser run. A browser can reuse the same numeric ID in a later run for an unrelated object.

A source ID is suitable for:

- applying a later event in the same browser run
- locating an object in live state
- correlating a frontend selection with a background request

A source ID is not suitable as the durable identity of a saved tab, search document, remote record, or restored browser object.

### Window

A window object has:

```json
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
  "tabs": [],
  "groups": []
}
```

Required fields:

- `windowSourceId`
- `windowIndex`
- `windowType`
- `windowState`
- `isFocused`
- `isPrivate`
- `tabActiveSourceId`
- `tabs`
- `groups`

Bounds can be `null` when the browser does not provide them. A future window property can be added as an optional field.

Each included window has at most one tab identified by `tabActiveSourceId`. `isFocused` is true for at most one included window.

### Tab

A tab object has:

```json
{
  "tabSourceId": 804,
  "tabIndex": 0,
  "title": "Example",
  "url": "https://example.com/",
  "isActive": true,
  "isSelected": true,
  "isPinned": false,
  "groupSourceId": 14,
  "isMuted": false,
  "isDiscarded": false
}
```

Required version-1 fields:

- `tabSourceId`
- `tabIndex`
- `title`
- `url`
- `isActive`
- `isSelected`
- `isPinned`
- `groupSourceId`

Optional fields can describe more browser state when available:

- `favIconUrl`
- `isAudible`
- `isMuted`
- `isDiscarded`
- `openerTabSourceId`
- `status`
- `lastAccessedAtMs`
- browser-specific container or workspace identity

An active tab is always selected, but a selected tab is not always active. Each window can contain multiple tabs with `isSelected: true`.

`url` uses `pendingUrl` when a newly created or restoring tab has no committed URL. If neither value is visible to the extension, it is an empty string.

### Tab group

A group object has:

```json
{
  "groupSourceId": 14,
  "title": "Reference",
  "color": "blue",
  "isCollapsed": false
}
```

A grouped tab refers to its group through `groupSourceId`. An ungrouped tab uses `null`.

Groups belong to the window containing their tabs. `groups` contains only groups referenced by included tabs in that window.

Group data is optional as a capability. When group capture is unavailable, `groups` is empty and every tab has `groupSourceId: null`. Metadata records that group data was not included.

### Focus

Every window can have one active tab. Only the active tab in the focused window is the browser-wide focused tab.

The tree therefore stores both:

- `windowFocusedSourceId`
- `tabFocusedSourceId`

These values are `null` when no included browser window is focused. They must agree with window `isFocused`, window `tabActiveSourceId`, and tab `isActive`.

### Metadata

Common metadata starts with:

```json
{
  "windowCountTotal": 2,
  "tabCountTotal": 18,
  "isPrivateIncluded": false,
  "isTabGroupIncluded": true,
  "isTabSelectionIncluded": true
}
```

Counts describe objects in this state, not all objects hidden by inclusion rules.

Capability booleans describe whether a type of data was intentionally included and available. They do not claim that an included group or selected secondary tab exists.

An envelope can add its own metadata. For example, a snapshot adds `snapshotSizeByte`.

## Live-state envelope

Example:

```json
{
  "schemaVersion": 1,
  "stateId": "20260723_22050112+09_a821",
  "stateRevision": 18,
  "browserRunId": "20260723_08010203+09_71bc",
  "stateObserveStartAtMs": 1784811901080,
  "stateObserveEndAtMs": 1784811901120,
  "windowFocusedSourceId": 91,
  "tabFocusedSourceId": 804,
  "metadata": {
    "windowCountTotal": 1,
    "tabCountTotal": 1,
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
          "groupSourceId": null
        }
      ],
      "groups": []
    }
  ]
}
```

`stateId` identifies one state built by a complete scan. `stateRevision` starts at 1 when that state is published and increases after each published event update.

`stateObserveStartAtMs` and `stateObserveEndAtMs` bound the scan that built the state. Event updates increase the revision but do not change these scan times. A later full scan creates a new `stateId` and new observation times.

The state served by the public API is complete. Tracker phases such as `scanning` and `error` belong to tracker status, not inside a half-built browser tree.

## Snapshot envelope

A version-1 snapshot keeps the common tree at its top level and adds:

- `snapshotId`
- `snapshotGenerateAtMs`
- `snapshotGenerateAtText`
- `snapshotCaptureStartAtMs`
- `snapshotCaptureEndAtMs`
- `eventSequenceCutoff`
- `metadata.snapshotSizeByte`

The existing top-level layout remains valid. It must not be changed only to place common fields under a new nested property.

In code, sharing should happen before serialization:

```text
scanBrowserState()
  -> common browser tree
      -> publish as live state
      -> add snapshot envelope and store as snapshot
```

This lets both records use one scanner, one normalizer, and one tree validator without migrating old snapshots.

## Field extension rules

The format is designed for additive change.

### Adding a field

A new field can be added without increasing `schemaVersion` when all of these are true:

- the field is optional for readers
- its absence has a defined meaning
- old readers can safely ignore it
- the meaning of every existing field stays unchanged

Each optional field must define one of these absence meanings:

- data was not supported
- permission was unavailable
- data was not captured by that record version
- the property had no value

Absence must not be interpreted as `false` unless that field contract explicitly says so. An explicit boolean false means the property is known to be false.

Use `null` only when the field is known and has no referenced value, such as an ungrouped tab's `groupSourceId`. Omit a field when the capability or record version did not capture it.

### Unknown fields and values

Readers ignore unknown fields. A reader that copies or transforms a record should preserve unknown fields when practical.

An unknown enum value is not silently converted to a known value. The reader keeps it or reports that the value is unsupported while preserving the rest of the object.

Do not add one unstructured object for arbitrary future data. Named optional fields are easier to validate, document, query, and migrate. Browser-specific data can use a clearly named optional object when several related fields must remain together.

### Increasing the schema version

Increase `schemaVersion` for a breaking change, including:

- removing or renaming a field
- changing a field's type
- changing the meaning of an existing value
- changing required ordering or identity rules

Stored data readers support known old versions and normalize them into the latest internal model. Writers emit only the current version.

Normalization supplies documented defaults only. It does not invent unavailable browser data. For example, an old record without `isMuted` remains unknown, not automatically false.

Storage keys can include a format version when exact-key discovery or migration requires it. The version in the value remains authoritative for validation.

## Validation

A complete state or snapshot is valid when:

- IDs required by the envelope are present
- every window and tab source ID is unique inside its browser run
- array order and index fields agree
- each active-tab reference resolves inside its window
- focused-window and focused-tab references agree
- every group reference resolves inside the same window when group data is included
- active tabs are selected
- metadata counts agree with included arrays
- required fields match their declared types

Optional unknown fields do not make a record invalid.

Validation runs after a complete scan, before snapshot storage, after reading durable data, and after normalizing an older schema.

## Saved tab records

A saved tab is not a browser-state tab object.

It has a stable saved-record ID, save time, destination and synchronization metadata, and selected durable tab properties. Runtime source IDs can be retained only as optional origin information.

Keeping this schema separate allows saved records to outlive a browser run and evolve without adding storage-specific fields to every live tab.
