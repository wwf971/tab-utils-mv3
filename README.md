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
pnpm install
pnpm build:chrome
pnpm build:firefox
```

The Firefox build creates `tab-utils.xpi` at the project root. This file is packaged but not Mozilla-signed.

## Build and for Chrome
1. git clone this repo.
1. build the popup (see above)
2. Go to `chrome://extensions/` in chrome browser.
3. Enable "Developer mode"
4. Click "Load unpacked"
5. Select the `tab-utils-mv3` folder

## Installation for Firefox

### Temporary development installation

Open `about:debugging#/runtime/this-firefox`, select Load Temporary Add-on, and choose `tab-utils.xpi` or its manifest.

This installation is intentionally temporary. Firefox unloads it when the browser exits, so it must be loaded again after the next start.

### Permanent installation

Normal Firefox requires Mozilla to sign an extension before `about:addons` can install it permanently. Packaging a directory as an `.xpi` does not sign it.

For private use without a public Add-ons listing:

1. Submit the extension to Mozilla Add-ons for unlisted signing.
2. Download the signed `.xpi`.
3. Open `about:addons`.
4. Use Install Add-on From File and choose the signed `.xpi`.

The signed extension remains installed after Firefox restarts. Keep the Gecko extension ID in `manifest.json` unchanged across versions so updates use the same extension identity.

Firefox Developer Edition and Nightly can be configured to accept an unsigned `.xpi` by setting `xpinstall.signatures.required` to `false` in `about:config`. Normal Firefox enforces signing and should use the Mozilla-signed file.