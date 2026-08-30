# Publishing a permanent Firefox add-on

Loading Temporary Add-on from `about:debugging` is not a permanent install. Firefox unloads that add-on when the browser exits.

Release Firefox only keeps an add-on after Mozilla has signed the package. `pnpm build:firefox` writes an unsigned `tab-utils.xpi`. That unsigned file is for a temporary load, and for upload to AMO. The file that stays installed after Firefox restarts is the signed `.xpi` you download from AMO after signing.

```text
source tree
  -> pnpm build:firefox
  -> unsigned tab-utils.xpi
  -> submit to AMO (unlisted)
  -> wait for signing
  -> download signed .xpi
  -> about:addons -> Install Add-on From File
```

Unlisted means the add-on is not shown on the public store. Mozilla still signs an unlisted add-on. An add-on only for your own machine still uses this path.

For the Firefox package layout, and the rule that `version` in `manifest.json` must rise on every deploy, refer to [Tab Utils](./tab-utils-mv3.md).

## Identities

Three names show up in this process. They are not the same thing.

```text
gecko id          = who this add-on is
Mozilla account   = who is allowed to upload new versions of that add-on
Mozilla signature = this exact file was checked and approved
```

### Gecko id

Firefox and AMO treat two packages as the same add-on when they share the same gecko id. Local storage, snapshots, and later updates stay attached to that id.

The gecko id is written in `manifest.json`, under the Firefox-only block:

```json
"browser_specific_settings": {
  "gecko": {
    "id": "name@something"
  }
}
```

The Firefox packager keeps this block in the Firefox package. The Chrome packager removes it, because Chrome does not use a gecko id.

The id looks like an email, `name@something`. It does not need to be a real mailbox. The part after `@` does not need to be a domain you own, and does not need to resolve on the internet. A random token is fine, for example `tab-utils@wwf971`.

The whole string must be unique on AMO. If another add-on already uses the same gecko id, the submit fails.

Choose the gecko id before the first submit. After AMO accepts the first version, that id cannot change. A new gecko id is a different add-on: a new listing, empty storage, and old snapshots do not carry over.

### Mozilla account

The account on the AMO Developer Hub is only the owner who may upload later versions of that gecko id. Do not put the account name into the project. Each new signed file still uses the same gecko id from `manifest.json`.

### Version and signature

Firefox decides that a file is a newer install of the same add-on when the gecko id is the same and `version` is higher. If the gecko id stays the same and `version` also stays the same, Firefox does not treat the file as an update, even if the bytes inside the `.xpi` changed.

AMO stores one file for each version string. A second upload of the same version, with different contents, is rejected.

A Mozilla signature covers one exact file. After the contents change, raise `version` in `manifest.json`, rebuild, and submit again. The old signed `.xpi` is not valid for the new bytes.

## Manifest fields AMO checks

The Firefox package must contain these fields.

`browser_specific_settings.gecko.id` is the add-on identity. Manifest V3 requires it.

`browser_specific_settings.gecko.data_collection_permissions` is required for new Firefox add-ons. It says what data leaves the local browser. It is not the same list as `permissions` such as `tabs` or `storage`. Those API permissions allow the add-on to read browser data. This field is the install-time consent list for sending data away.

`version` must be a new number on every submit.

`icons` and `action.default_icon` must point to square PNG files. The pixel size of each file must match the size written in the manifest key.

If the add-on can send tab URLs or titles to a backend, such as the Remote tab, declare `browsingActivity`. If nothing is sent outside the local browser, declare `none`:

```json
"data_collection_permissions": {
  "required": ["none"]
}
```

Do not declare `none` when the package can upload browsing data.

## Icons

Every icon file that AMO reads must be square: width equals height. A 100×90 PNG will fail to firefox checks. If three manifest entries point at that one file, AMO reports the same error three times.

The number in the `icons` key must match the pixels of that file. If the key is `"16"`, the file must be 16×16. Pointing `"16"`, `"48"`, and `"128"` at one 100×100 file fails the size check.

```text
icons.16  -> 16x16 PNG
icons.48  -> 48x48 PNG
icons.128 -> 128x128 PNG
```

If the source picture is not square, padding it to a square is allowed. The pad color should be the same as the background of the source. The source icon in this project has a transparent background, not a black one.

## Publish steps

```text
1. raise version in manifest.json
2. after the first submit, keep gecko.id unchanged
3. pnpm build:firefox
4. open AMO Developer Hub
5. first time: Submit a New Add-on, channel On your own / unlisted
   later times: add a new version on the same listing
6. upload the unsigned tab-utils.xpi
7. wait until that version is signed
8. download the signed .xpi from the version page
9. in about:addons, use Install Add-on From File in the gear menu
   choose the signed file, not the unsigned xpi in the project folder
```

For the first submit, open [Submit a New Add-on](https://addons.mozilla.org/developers/addon/submit/). For later versions, open [Manage My Submissions](https://addons.mozilla.org/developers/addons), open this add-on, and upload a new version on the same listing.

### Download the signed file

Signing is usually a machine check. It is often a few minutes, not a day. AMO may take up to about a day, or longer if a person reviews the file.

The page that says the upload succeeded often has no large Download button. After the version is signed, the signed file is on the version page:

```text
Manage My Submissions
  -> the add-on
  -> Manage Status & Versions
  -> the version just uploaded
  -> Files
  -> the .xpi link
```

Right-click the `.xpi` link and use Save Link As. A normal click may try to install that file in the current Firefox, instead of saving it.

If Files has no `.xpi` link, signing is not finished. Refresh later, or wait for the email from AMO.

Firefox Developer Edition and Nightly can install an unsigned `.xpi` if `xpinstall.signatures.required` is set to `false` in `about:config`. Release Firefox ignores that pref, and needs the signed file.
