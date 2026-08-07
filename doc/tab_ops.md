# Tab operations in the popup

## Search

This section describes features implemented under the 'Search' tab's page in the popup panel.

The search panel lets the user find open tabs, select results, and act on them. All views read the maintained live browser state through the background; refer to [Live browser state](./browser_state.md). No view queries browser tab APIs directly.

`PopupStore` is the source of truth: the fetched items, the selected tab IDs of each view, the loaded context range, and the running action. `SearchPanel` renders from the store and sends user attempts back to it. The search state itself lives in a reusable `TabSearchCore` class, which the snapshot detail view also uses over its own steady data.

### Result selection

Rows support multiple selection: plain click selects one row, shift+click selects a range, ctrl+click toggles one row. Right-clicking a row inside the selection keeps the selection; right-clicking outside it selects just that row.

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

Core UI behavior: main search panel --> menu item --> secondary search panel. One side of the operation is fixed by the right-clicked selection; the other side is picked inside the panel. The operation is available in the result view and in the context view alike.

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

The panel offers the current active tab as a special option above the search field:

- when picking source tabs, ticking the current tab adds it next to the searched picks; other tabs can still be picked
- when picking the target tab, ticking the current tab decides the target, so searching is forbidden while it is ticked

Tabs on the fixed side of the operation are greyed out in the panel's results and cannot be picked, so a tab can never be brought next to itself. The current tab is resolved once when the panel opens.

```text
user clicks Apply
  -> popup sends browserTabAction bringTabs
     with source tab IDs, target tab ID, placement
  -> background moves the source tabs one at a time
     next to the target, keeping their order
  -> panel closes; result view and context view re-fetch
```
