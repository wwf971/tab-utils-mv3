# Snapshot recovery

## Recovery model

A snapshot is a complete checkpoint. Events are ordered changes after that checkpoint.

There are two recovery modes.

- Snapshot restore opens the windows and tabs stored in one selected snapshot.
- Last-moment restore starts from the newest complete snapshot and replays later events from the same browser run.

Both modes create new windows. They do not close current windows.

For snapshot and event storage formats, refer to [Browser snapshots and event storage](./snapshot.md).

## Last-moment restore

```text
newest complete snapshot
  -> load later events from the same browser run
  -> sort by event sequence
  -> user chooses the last event to apply
  -> apply events through that step to the in-memory state
  -> show warnings and calculated snapshot
  -> user confirms
  -> verify that the selected event is still available
  -> create calculated windows and tabs
```

Replay is conservative. An object is removed or moved only when its identity can be found. A missing tab close, invalid index, missing event range, or unsupported event records a message without stopping later events. When state is uncertain, known tabs are kept.

Confirmation is tied to the last replayed event sequence. The background repeats the same bounded replay before restoration, so the restored state matches the overview that the user confirms.

A typical selected-step use case is restoring after windows were closed manually and the browser was then relaunched. Select the event immediately before the unwanted window-close events, replay to that step, inspect the calculated snapshot, and restore it.

## Choosing where replay ends

Every replay is the same bounded replay; the first-line radios choose how the end event is found:

```text
replay end event
  <- last step: the last available event
  <- given step: one event picked in the events table
  <- advanced: {offset} step of the (first/last) {index}-th {event type} event
```

The target form exists because one selected step is often hard to find by hand. A browser crash frequently records several window-close events at the end of the log, one per open window, so "replay to last step" rebuilds an almost empty state. The state to restore lies immediately before those close events.

The target has four parameters:

- event type, default `windowRemoved`
- counting order, default counting from the last event
- index, the n-th matching event in that order, default 1
- offset, in steps relative to the matched event, default -1

The defaults therefore mean "replay to one step before the last window-close event". If the browser had several windows, the user increases the index and watches the calculated snapshot until it matches the state before the crash, then restores.

An offset can move the end before the first event; replay then keeps the snapshot unchanged. An offset past the last event replays everything. A target that matches no recorded event reports an error instead of replaying.

With real-time replay on (a popup setting, `enable_recovery_replay_realtime` in `storage.sync`, default true), a mode change, a selected-event change, or an advanced parameter edit replays immediately, so the user can tune the current mode and directly observe the result. Rapid edits are debounced. The Replay button and the real-time replay checkbox stay on the first line and stay clickable in every mode. The advanced target controls stay greyed out while last step or given step is selected.

## Window identity during replay

Browser window IDs are stable only inside one browser run. They can change after a browser exit, crash, or relaunch.

This does not prevent recovery. A snapshot stores its browser-run ID and the runtime ID of each window. Each later event also stores its browser-run ID and the window or tab runtime IDs involved. Replay uses only events from the snapshot's browser run, so an event can identify a window in that snapshot or a window created by an earlier replayed event.

Replay does not compare these old IDs with windows in the relaunched browser. It first calculates the old state entirely from stored data. Restoration then creates new windows and maps the stored tab and window identities to the new browser IDs.

The important boundary is the browser run, not ID stability across runs. Events from another run cannot be safely mixed with a snapshot because the browser may reuse the same numeric IDs for unrelated windows.

## Tab order

### Snapshot order

Snapshot capture sorts each window's tabs by the browser-provided index. The stored array is the intended tab order.

### Event replay order

Ordering events contain positions from the state at the time of that event.

- `tabCreated` contains the initial window and index.
- `tabUpdated` contains the current index when browser-managed properties such as pinning change.
- `tabMoved` contains the old and new index.
- `tabDetached` contains the old window and position.
- `tabAttached` contains the new window and position.
- `tabRemoved` identifies the tab that leaves the current array.

Events are applied by sequence, one at a time. After each create, move, attach, or remove, indexes are normalized. The next event index is therefore interpreted against the state produced by all earlier events, not against the original snapshot.

Moving a tab between windows is represented by detach and attach events. Detach alone does not remove the known tab. Attach moves it when both the tab and destination window can be identified. This avoids losing a tab when an attach event is delayed or missing.

### Browser restoration order

The restore controls provide two methods supported by both Chrome and Firefox.

- Batch tabs passes the ordered URL array to `windows.create`. The browser creates all tabs for one window in one call. Pinned tabs are then applied, and ordered pinned and unpinned tab arrays are moved into their final positions.
- One by one creates the window and then awaits each `tabs.create` call in stored order.

Both methods run a final order pass because browser rules, failed URLs, pinned tabs, and other extension behavior can change positions during creation. If batch movement is unavailable or fails, restoration falls back to moving tabs individually. If one tab cannot be created or moved, restoration records an error and preserves the intended relative order of the other successfully created tabs.

Batch mode is substantially faster for large windows, but all URLs can begin loading concurrently. One-by-one mode is slower and places less simultaneous loading pressure on the browser.

Tab Utils normally moves a newly opened tab next to the active tab. That behavior is disabled during extension-started restoration. Without this guard, each restored tab could be moved while later tabs are still being created, producing an order that looks partly reversed or shuffled.

Browsers keep pinned tabs before unpinned tabs. A captured browser state already follows this rule. Restoration requests the captured pinned state and order, but the browser remains authoritative when a page or tab position is not allowed.

## Events generated by restoration

Creating restored windows and tabs emits normal browser events. During extension-started restoration, these events are collected in one ordered memory batch. The batch is written when restoration finishes, then an immediate snapshot is created.

Unrelated browser events during restoration enter the same batch and are not discarded. If the browser stops before the batch is written, existing snapshots and previously stored events remain valid, but the unfinished batch is not durable.

## Restore panel

The Restore panel shows:

1. A first-line radio group that chooses where replay ends: last step, a given selected step, or the advanced target below. The Replay button and the real-time replay checkbox stay on this line and stay clickable in every mode.
2. The advanced replay target controls (refer to [Choosing where replay ends](#choosing-where-replay-ends)). These stay greyed out unless the advanced radio is selected.
3. The source snapshot, with its time, window count, and tab count on the same line as the title.
4. Selectable events after that snapshot.
5. Replay warnings and errors.
6. The calculated snapshot.
7. Final confirmation.

Choosing last step replays every available event. Choosing given step replays through the selected event. The advanced radio uses the target parameters. The Replay button runs the current mode. With real-time replay on, a mode change, a selected-event change, or an advanced parameter edit also replays immediately. A checkbox beside each restore action selects batch or one-by-one tab creation. Snapshot window rows never wrap a cell such as `444 tabs`; extra title text is clipped.

### Events table

The events after the snapshot are shown as a table with index, type, and time columns and a header row. A columns-per-row control lets several such column groups share one row, separated from the event counters by a clear vertical divider. Dragging a column border in the header resizes that column. The index column width follows the digit count of the largest event sequence, so a large index such as 181181 stays fully visible without manual resizing. The row where the last replay ended is marked.

A Maximize button beside the table title opens the same table enlarged in an in-popup overlay, so events are easier to find and select. The overlay close button sits at the top right corner. The overlay also closes on an outside click.

### Panel height

The Restore panel fills the fixed popup height; it measures its available height once when it mounts. The events table absorbs the remaining height and scrolls internally, while the other areas keep preferred heights and shrink only when the panel runs out of height. The popup itself must never get a vertical scrollbar; a popup-level scrollbar next to the scrolling inner areas is a layout bug. Refer to [Extension popup size](./popup_size.md).

Background changes invalidate the displayed source, and the MobX store re-fetches it from the background. Manual refresh always performs the same full re-fetch.

## Technical details

### Firefox background loading

Exactly one background context must own event listeners and the serialized storage queue.

The Firefox package declares only the ordered `background.scripts` list. The Chrome package declares only `background.js` as a service worker. The build removes the other browser's declaration.

This separation is important. Two background contexts would have independent in-memory queues while writing the same event catalog. Rapid create, move, update, and remove events could then overwrite one another.

The following details are important on Firefox:

- Snapshot modules load before `background.js` in their declared order.
- `background.js` does not import the modules again when `TabSnapshot` already exists.
- Event and message listener registration is idempotent.
- One serialized queue assigns event sequences and writes event chunks.
- Browser events received while one event write is active are drained together instead of creating an unbounded list of storage tasks.
- The browser-run ID survives background suspension through `storage.session`.
- Badge refresh uses a completion-based timeout and permits only one tab query at a time. A slow idle-resume query therefore cannot overlap later refreshes.

The following details are not required:

- Firefox does not need to run the Chrome service worker.
- Frontend panels do not need to remain open for event recording.
- Frontend panels do not need direct tab or window listeners.
- Using the `chrome` namespace is not itself a problem because Firefox provides the compatible extension API namespace used by this project.
- Splitting background logic across several files is safe when they run once in one shared context and in the declared order.
