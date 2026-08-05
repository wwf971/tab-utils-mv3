# Tab Utils

Tab Utils is a Chrome and Firefox extension for tab behavior, tab counts, snapshots, and browser recovery.

## Core concepts

- Live browser state is the background's current window, tab, focus, selection, and group model.
- A snapshot is one durable checkpoint created from the current browser-state maintained by this extention.
- An event is one ordered change kept after a snapshot for last-moment recovery.
- A saved tab is a durable user record with its own stable identity. It is not a live tab object or a snapshot.
- A browser run is one browser lifetime. Browser-provided window, tab, and group IDs are meaningful only inside that run.

The browser is the ultimate truth for what is open now. The background context is the single extension-facing source of truth for live state and durable recovery data.

```text
browser tab and window events
  -> one background dispatcher
      -> update live browser state
      -> store reduced recovery events
      -> run tab utilities
  -> background change notice
  -> open frontend panels re-fetch needed data
  -> MobX store updates rendered panels
```

Frontend panels do not listen to browser tab and window events directly. The background context owns event capture and can be started when no frontend panel is open. Keeping capture there avoids duplicated listeners and different behavior between popup, settings, and extension windows.

A background module and its listeners must be registered once. Chrome packages declare only `background.js` as a service worker, which imports the snapshot modules. Firefox packages declare only the ordered background script list. The build removes the other browser's background declaration. Duplicate background contexts would have independent storage queues and could overwrite events recorded during the same burst.

The manifest `version` must be raised for every Firefox deployment. Firefox caches the parsed manifest keyed by extension ID and version, so installing a new package with an unchanged version keeps the old cached background script list; a script file newly added to that list is then never loaded, and every function it defines is missing at runtime.

A background change notice is an invalidation signal, not the changed data itself. Each open panel debounces notices and re-fetches from the background. This keeps the background as the source of truth and combines event bursts into fewer reads.

Manual refresh is always available. It performs the same full re-fetch and is useful after a frontend was opened late, suspended, or temporarily disconnected.

## Normal workflows

### Current browser data

```text
background starts
  -> register browser listeners
  -> scan current windows and tabs
  -> apply buffered changes
  -> publish live browser state
  -> keep it updated from events
  -> occasionally reconcile with a new scan
```

Search and save utilities read this maintained state. They do not each scan the browser or maintain another event model.

For tracker lifecycle, event sharing, selected tabs, and APIs, refer to [Live browser state](./browser_state.md).

For result selection and the nearby-tabs context view of the popup search panel, refer to [Tab search selection and context view](./search_context.md).

For the common window, tab, and group format, refer to [Browser state data](./browser_state_data.md).

### Recovery

A snapshot is a complete checkpoint of windows and tabs. Events record later changes. Recovery can either restore one selected snapshot directly, or replay events after the newest snapshot and restore the calculated state after user confirmation.

For snapshot formats and event storage, refer to [Browser snapshots and event storage](./snapshot.md).

For recovery modes, replay rules, tab ordering, restoration batching, and Firefox details, refer to [Snapshot recovery](./snapshot_recover.md).

For the Firefox freeze investigation and the designs that keep background load bounded, refer to [Firefox freeze and crash notes](./issue_firefox_crash.md).

### Firefox and the tab-count badge

If on Firefox the browser gets stuck after a while, consider turning off the tab number display feature. The possible cause: when both the current-window count and the total count are enabled, a background timer keeps running to switch the badge on the extension icon between the two numbers, and each switch re-queries windows and tabs. The timer runs only while both counts are enabled; displaying a single count updates the badge from browser events without any timer.