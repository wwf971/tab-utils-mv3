# Tab Utils Chrome Extension

A manifest v3 browser extension that integrates several useful tab management utilities that make browsing experience smoother.

Every feature can be turned off either in popup settings panel or by not assigning a hotkey for it.

For the system design and documentation index, see [Tab Utils](./doc/tab-utils-mv3.md).

## Features

- **open new tab next to current tab**.
  - similar to a previous chrome extension has implemented this function which became unavailable since chrome enforced migration from manifest v2 to v3.
  - ![](./asset/open-tabs-next-to-current.png)

- **duplicate current tab**: 
  - similar to [Duplicate Tab Shortcut](https://chromewebstore.google.com/detail/duplicate-tab-shortcut/klehggjefofgiajjfpoebdidnpjmljhb) extension.
  - support using a custom key to duplicate current tab.

- **display tab count**: Shows alternating current window / total tab count as a number on the extension icon (when pinned)
- **Settings Popup**: Click extension icon to configure features
- **browser recovery**: Regularly saves windows and tabs. A selected snapshot can be restored directly, or later events can be replayed to calculate and restore the last known state. See [snapshot recovery](./doc/snapshot_recover.md).

## Test

Launch frontend test server by `pnpm run dev`, which serves a page presenting the ui design of popups/windows/tabs of this extension.

## Build

### Build popup pages and generate file for browser to import

```bash
cd popup
pnpm install
pnpm build:chrome # build for chrome
pnpm build:firefox # build for firefox.
  # an .xpi file will be generated at root, if build succeeds.
```


## Build and for Chrome
1. git clone this repo.
1. build the popup (see above)
2. Go to `chrome://extensions/` in chrome browser.
3. Enable "Developer mode"
4. Click "Load unpacked"
5. Select the `tab-utils-mv3` folder

## Installation for Firefox

On firefox, go to `about:debugging#/runtime/this-firefox`, and load extension at that page, instead of going to `about:addons`.