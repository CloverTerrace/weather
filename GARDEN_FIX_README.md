# Garden desktop broken-image cleanup

This pass untangles the seasonal decorative-image lifecycle without changing the garden's visual layout.

## Replace

- `gardening.html` -> repository root `gardening.html`
- `gardening.js` -> `js/gardening.js`

## Apply patches

- `gardening.css.patch` -> `css/gardening.css`
- `sw.js.patch` -> `sw.js`

## What changed

1. `gardening.html` now owns one seasonal-art table and one safe image-loader helper.
2. Seasonal decorative images start with `hidden` and are shown only after a successful load.
3. Failed seasonal assets fall back to the corresponding summer asset; if that also fails, the image is removed/hidden instead of showing a browser broken-image glyph.
4. The season badge now has stable DOM (`#garden-season-icon` + `#garden-season-label`) instead of being rebuilt with `innerHTML`.
5. `gardening.js` reads the same season table instead of maintaining a second `TREE_COMPANIONS` map.
6. The old `onerror = () => {}` behavior is gone; that code suppressed JavaScript errors but still allowed the browser's broken-image icon to render.
7. Service-worker cache is bumped to v6 and `garden-sprites.js` is added to the shell.

## Important known asset mismatch

The Autumn border set currently does not contain `assets/garden/autumn/borders/vine-edge-bottom.png`, while the page requests that file. The new loader therefore falls back to the summer bottom edge instead of exposing a broken image.

## Validation

- `node --check gardening.js` passes.
- The updated HTML contains no visible `<img>` without a `src`.
