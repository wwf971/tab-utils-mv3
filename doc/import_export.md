# Import and export

## Copy one window's tabs as text

At the top of the popup Search tab, select `All Windows` to open the full display panel. This panel shows a window list at the left side and every tab of the selected window at the right side. The `Windows` display inside search mode also has the window list. Right-clicking a window in either place opens a menu with two actions:

- `Copy tabs as "url | title" lines` puts every tab of that window into the clipboard, one line per tab:

```text
{url} | {title}
{url} | {title}
...
```

- `Close window` closes that window with all of its tabs.

The copied text always reflects the tabs of that window at copy time; it is read from the live browser state, not from the rendered rows.

Used together, the two actions extract one whole window into plain text and then remove it from the browser. This suits browser office automation: a set of open pages leaves the browser as text, can be kept in any note or document, and the pages can be reopened later from the copied URLs.

## Copy selected tabs as text

Right-clicking a tab row opens the tab menu, in every panel mode of the Search tab (`Search`, `All Windows`, `Selected Tabs`). Two items there copy the selected tabs in the same `{url} | {title}` line format as the window copy above:

- `Copy selected tab(s) as "url | title" lines` copies the selected tabs, in the order they were selected (like uploading to remote).
- `Copy selected tab(s), close on success` also closes exactly the copied tabs, but only after the clipboard write succeeded, so a failed copy never loses tabs.

This is the whole-window extraction above, scoped down to a hand-picked set of tabs.
