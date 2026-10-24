# Vendored three.js r166 (0.166.1)

Committed so the site is fully self-contained and can be served as static files
(GitHub Pages) without an `npm install` or any CDN request.

- `build/three.module.js` — the core library, unmodified.
- `addons/` — only the modules this project imports, plus their transitive
  dependencies (14 files): `EffectComposer`, `RenderPass`, `ShaderPass`,
  `UnrealBloomPass`, `SMAAPass`, `OutputPass`, `MaskPass`, `Pass`,
  `BufferGeometryUtils`, `RoomEnvironment` and the shaders they pull in.

Nothing here is modified from upstream. three.js is MIT licensed; see `LICENSE`.

To refresh after bumping the `three` dependency, re-run the dependency walk
described in the project README's tooling section.
