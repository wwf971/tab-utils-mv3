# Tab search selection and context view

The popup search panel lets the user find open tabs, select a result, and act on it. It also lets the user look at the neighborhood of one result: the tabs sitting before and after it in its window. This is similar to "open containing folder" in a file-explorer search.

## Core concepts

- The result view lists tabs matching the committed search text.
- The context view lists one contiguous slice of one window's tabs, centered on one chosen tab.
- The center tab is the tab whose context is shown. It keeps a distinct row style.
- An edge row sits above the first and below the last context tab. It either loads more tabs or states that the window border is reached.

Both views read the maintained live browser state through the background; refer to [Live browser state](./browser_state.md). Neither view queries browser tab APIs directly.

`PopupStore` is the source of truth for both views: the fetched items, the selected tab IDs of each view, the loaded range, and the running action. `SearchPanel` renders from the store and sends user attempts back to it.

## Selection and tab actions

Rows are selected by clicking, using the single-selection support of `FolderView`. Each view keeps its own selected IDs, so a background-driven refresh of one view cannot disturb the selection of the other.

The control button group acts on the current selection. Close sends every selected tab ID in one request, and the background closes them in one `tabs.remove` call. The message protocol therefore carries a tab ID list for close, even while the visible list still uses single selection.

## Entering the context view

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

## Edge rows and loading more

An edge row has three states with one fixed height, so switching states never shifts the rows around it:

- more tabs exist: clicking it raises `countBefore` or `countAfter` by the configured side count and re-fetches
- loading: the row is greyed with a spinning circle until the response arrives; a failure restores the row and shows the error in the message line
- no more tabs: the row reads "Reaching window border, no more tabs" and ignores clicks

When earlier tabs are prepended, the panel compensates the scroll offset so the tabs already on screen stay visually in place.

## Event updates

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

Tab actions started from the panel (close, move, duplicate) also trigger an immediate re-fetch, so the user does not wait for the debounced notice.

Editing the search text exits the context view, because the context belongs to a tab chosen from the previous result list.
