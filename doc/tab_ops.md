# Tab operations in the popup

## Search

This section describes features implemented under the 'Search' tab's page in the popup panel.

The search panel lets the user find open tabs, select results, and act on them. All views read the maintained live browser state through the background; refer to [Live browser state](./browser_state.md). No view queries browser tab APIs directly.


`PopupStore` is the source of truth: the fetched items, the selected tab IDs of each view, the loaded context range, and the running action. `SearchPanel` renders from the store and sends user attempts back to it. The search state itself lives in a reusable `TabSearchCore` class, which the snapshot detail view also uses over its own steady data.

### Panel modes

A segmented control above the Search tab switches between three top-level panel modes:

- `Search` shows the search field and the matched tabs (the result views below).
- `All Windows` shows the complete live windows tree: every window at the left side, the selected window's tabs at the right.
- `Selected Tabs` shows only the browser-selected (highlighted) tabs of each window. Chrome and Firefox allow selecting multiple tabs in a window (ctrl/shift+click on the tab bar); this mode exists to act on such a selection in one run, typically uploading it to remote through the right-click menu.

All modes and views render through the shared `WindowTabView` component of `@wwf971/tab-manage-frontend-common` (window sidebar + tab table). Its appearance is a view mode: `table` renders index/title/url/group/state columns; `item` renders one `TabItem` per tab (icon, title over url, status marks), which is what every panel mode here uses. The sidebar can be hidden, which is how the flat `list` result view is rendered. In `All Windows` and `Selected Tabs` the status marks are hidden, and the view fills the remaining popup height instead of using a fixed table height.

`All Windows` and `Selected Tabs` read one live windows tree (`windowsAll`), refreshed on background change notices; `Selected Tabs` reduces each window to its selected tabs. The active tab of a window counts as selected (refer to [Live browser state](./browser_state.md), Multi-tab selection), so a window without an explicit multi-selection shows its active tab. Both modes start on the window the user was in before opening the popup. Entering `Selected Tabs` and switching windows there selects every shown tab, so the usual flow — select tabs in the browser, open the popup, right-click, upload — needs no re-selection in the table; in `All Windows` a window switch drops the tab selection instead, like the snapshot window sidebar.

Mounting the tab list of a large window blocks the popup for a moment, so entering these modes and switching windows inside them never render the heavy list right away. A spinning circle is painted first — replacing the list on mode entry, laid over it on a window switch — and the list renders one frame later. The spinner animation is composited (refer to `SpinningCircle` of `react-comp-misc`), so it keeps spinning while the blocking render runs.

### Search result views

The result area has two views, switched by a segmented control at the start of the button group:

- `list` shows every match in one flat list.
- `window` shows the windows that contain matches at the left side (the shared `WindowSidebar` component, also used by the snapshot detail) and the selected window's matches at the right.

The view choice lives in `PopupStore.searchViewCurrent` and is not persisted. The view shown when the popup opens is a setting in the Common tab (`search_view_default`, an enum, default `list`), stored in `storage.sync` through the background `updateSettings` action like the other common settings.

In the window view, switching windows drops the tab selection, and leaving the window that owns an open context view exits that context.

### Search result selection behavior

Rows support multiple selection: plain click selects one row, shift+click selects a range, ctrl+click toggles one row. Right-clicking a row inside the selection keeps the selection; right-clicking outside it selects just that row. The selected IDs keep the order rows were selected: clicks append at the end, and a shift range keeps the anchor-to-target direction. Ordered operations, such as uploading tabs to remote, rely on this order.

The result view and the context view each keep their own selected IDs, so a background-driven refresh of one view cannot disturb the selection of the other.

The control button group acts on the current selection:

- Close closes every selected tab in one request.
- Context needs exactly one selected tab and opens its context view.
- Move/Duplicate Left/Right need exactly one selected tab; they act relative to the current active tab.

### Show context of a tab

The context view shows the neighborhood of one result: the tabs sitting before and after it in its window. This is similar to "open containing folder" in a file-explorer search.

- The context view lists one contiguous slice of one window's tabs, centered on one chosen tab.
- The center tab is the tab whose context is shown. It keeps a distinct row style.
- An edge row sits above the first and below the last context tab. It either loads more tabs or states that the window border is reached.

```text
user selects one search result
  -> clicks Context
  -> store sends browserStateQueryTabContext
     with the center tab ID, countBefore, countAfter
  -> background slices that window's tabs from live state
  -> panel shows edge row + tabs + center + tabs + edge row
  -> panel scrolls the center tab to the middle
```

The tab count on each side is a setting in the Common tab (`search_context_tab_count_side`, default 10). It is stored with the other common settings in `storage.sync` through the background `updateSettings` action.

The Context button becomes Exit Context inside the view. The button keeps one fixed width in both states so the toolbar does not jitter.

The loaded range is only the pair `countBefore` and `countAfter`, counted from the center tab. Stored tab IDs or indexes are not used to define the range. Every fetch recomputes the slice from the current live state, so a closed or moved neighbor tab is reflected by the next fetch without special casing.

#### Edge rows and loading more

An edge row has three states with one fixed height, so switching states never shifts the rows around it:

- more tabs exist: clicking it raises `countBefore` or `countAfter` by the configured side count and re-fetches
- loading: the row is greyed with a spinning circle until the response arrives; a failure restores the row and shows the error in the message line
- no more tabs: the row reads "Reaching window border, no more tabs" and ignores clicks

When earlier tabs are prepended, the panel compensates the scroll offset so the tabs already on screen stay visually in place.

#### Event updates

In context mode, changes of browser state should be reflected real-time. For example, if tabs displayed in context has delete/create/move events, then this should be reflected real-time.

```text
background publishes browserStateChanged
  -> popup store debounces the notice
  -> result view re-fetches the search
  -> context view re-fetches its slice
      -> center tab gone: exit the context view with a message
      -> center tab in another window or position: show the refreshed
         slice and scroll the center tab back to the middle
      -> otherwise: apply the refreshed slice in place
```

Tab actions started from the panel (close, move, duplicate, bring) also trigger an immediate re-fetch, so the user does not wait for the debounced notice.

Editing the search text exits the context view, because the context belongs to a tab chosen from the previous result list.

### Bring tabs to before/after another tab

Core model: source tabs --> target tab. One or many source tabs are moved to directly before or after one target tab, in the target's window, keeping their given order.

Core UI behavior: main search panel --> menu item --> bring popup panel. One side of the operation is fixed by the right-clicked selection; the other side is picked inside the panel. Clicking the backdrop closes the popup unless Apply is running. The operation is available in the result view and in the context view alike.

```text
main search panel
   ├─ select one tab
   │        └─ right-click menu
   │                  ├─ menu items of the multiple-tab case below
   │                  ├─ bring current tab to before/after it
   │                  └─ bring other tabs to before/after it
   │                     (tabs to bring picked from the secondary panel)
   └─ select multiple tabs
            └─ right-click menu
                      ├─ bring to before/after current tab
                      └─ bring to before/after a target tab
                         (target picked from the secondary panel)
```

The secondary search panel runs its own `TabSearchCore` over the live browser state, so text matching, debounce, and event-driven refresh behave exactly like the main search. Result rows carry a checkbox in the first column. The panel works in two pick modes:

- multiple selection, used to pick the source tabs
- single selection, used to pick the target tab

The panel offers the current active tab as a special option:

- when picking source tabs, ticking the current tab uses it as the source
- when picking the target tab, ticking the current tab decides the target
- when the current tab fills either side, the search field and result list are hidden (that area is unused); untick the current tab to search again

Tabs on the fixed side of the operation are greyed out in the panel's results and cannot be picked, so a tab can never be brought next to itself. The current tab is resolved once when the panel opens.

```text
user clicks Apply
  -> popup sends browserTabAction bringTabs
     with source tab IDs, target tab ID, placement
  -> background moves the source tabs one at a time
     next to the target, keeping their order
  -> panel closes; result view and context view re-fetch
```
