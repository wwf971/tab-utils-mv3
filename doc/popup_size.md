# Extension popup size

The browser decides the popup window size from the rendered document. The manifest does not specify popup dimensions.

The sizing relationship is:

```text
html and body define the window size
  -> #root fills the document
      -> .popup-container fills #root
          -> content panels scroll inside the fixed popup
```

## Source of truth

`popup/src/index.css` is the source of truth for popup dimensions:

```css
:root {
  --popup-width: 620px;
  --popup-height: 580px;
}
```

Apply the width and height, including matching minimum and maximum values, to both `html` and `body`. Make `#root` and `.popup-container` fill that size with `width: 100%` and `height: 100%`.

Chrome and Firefox use the same popup CSS. Browser-specific manifest or JavaScript resizing logic is not needed.

## Important constraints

- Set popup dimensions on `html` and `body`, not only on a nested component.
- Do not use `100vh` or `100vw` to limit popup size. They refer to the popup's current viewport, which can be very small during initial rendering.
- Do not let loading, empty, or error content determine the document height.
- Keep root and container dimensions consistent. A wider inner container can be clipped by a narrower body.
- Use `box-sizing: border-box` so borders and padding stay inside the specified size.
- Keep the popup within browser extension-popup limits. Oversized dimensions can be restricted by the browser.
- Put overflow scrolling on an inner content panel. Keep the document itself fixed to avoid window-size changes between views.

## Verification

The development preview can provide its own wrapper size and hide root sizing mistakes. Build the extension and open the real packaged popup in both Chrome and Firefox when verifying size behavior.
