# Tab Utils

Tab Utils is a Chrome and Firefox extension for tab behavior, tab counts, snapshots, and browser recovery.

## Core design

The background context is the source of truth for browser state and durable recovery data.

```text
browser tab and window events
  -> background listeners
  -> serialized event storage
  -> background recovery-change notice
  -> open frontend panels re-fetch recovery data
  -> MobX store updates rendered panels
```

Frontend panels do not listen to browser tab and window events directly. The background context already owns event capture and remains active when no frontend panel is open. Keeping capture there avoids duplicated listeners and different behavior between popup, settings, and future panels.

A background module and its listeners must be registered once. Chrome packages declare only `background.js` as a service worker, which imports the snapshot modules. Firefox packages declare only the ordered background script list. The build removes the other browser's background declaration. Duplicate background contexts would have independent storage queues and could overwrite events recorded during the same burst.

A recovery-change notice is an invalidation signal, not the recovery data itself. It is sent only after an event or snapshot change has been written. Each open panel debounces notices and re-fetches from the background. This keeps the background as the source of truth and combines event bursts into fewer reads.

Manual refresh is always available. It performs the same full re-fetch and is useful after a frontend was opened late, suspended, or temporarily disconnected.

## Recovery model

A snapshot is a complete checkpoint of windows and tabs. Events record later changes. Recovery can either restore one selected snapshot directly, or replay events after the newest snapshot and restore the calculated state after user confirmation.

For snapshot formats and event storage, refer to [Browser snapshots and event storage](./snapshot.md).

For recovery modes, replay rules, tab ordering, restoration batching, and Firefox details, refer to [Snapshot recovery](./snapshot_recover.md).
