# PlayCanvas and the renderers

**A `.sog` is a bundle whose attribute planes load as `.webp` sub-assets, so `TextureHandler` must
be registered alongside `GSplatHandler`**, and `app.start()` must come *before* the asset load.

**The engine runs headless on its own `NullGraphicsDevice`.** A real `AppBase` on
`new NullGraphicsDevice(canvas)` under jsdom runs a whole `app.render()`. That covers
composition, culling, every layer's render step, and the scene's `prerender:layer` and
`postrender:layer` events, with only the device calls stubbed. The fixture is
`src/render/engine-test-fixtures.ts`. Layer membership and draw order are therefore unit-testable,
and a spy on `renderer.renderForwardLayer` reads the order back. Pixels still need a
browser, and so does anything the unified splat renderer does: it needs a GPU, so its seams (for
example `app.systems.gsplat.getMaterial`) are the one thing to stub.

**PlayCanvas blends in display space, as Q3 does.** The texture decode, the material colour and
the output encode are all one 2.2 power, and the camera renders into an 8-bit backbuffer that
isn't sRGB, so every blend happens on gamma-encoded values, the way Q3's framebuffer holds them.
An emissive colour of *g* is therefore exactly *g* times the texture on screen, clamped at white.
Measured on WebGPU: a texel of 100 reads back at 50, 100, 200 and 255 for *g* of 0.5, 1, 2 and 3.
That is how the port reproduces Q3's overbright stage by stage on a splat map's models and effects.
On a BSP map the whole 3D scene draws Q3's framebuffer instead
([`rendering.md`](rendering.md)), each material turned to those values at its first draw in the
scene and back at a splat map's load. An HDR camera frame, a
tone curve or an sRGB backbuffer (`DISPLAYFORMAT_LDR_SRGB`) would move blending into linear
light and change every effect's brightness.

**A vertex colour is decoded before it is interpolated** (`vertexColorGamma`), so a blend between
a dark vertex and a light one is made in linear light, where opengl1 interpolates the bytes. A
vertex-lit statue drew nearly twice as bright at its silhouettes. The world's stages decode
their colours once interpolated, in an emission of their own (`VERTEX_COLOR_EMISSION`).

**Added light cannot show on white.** An additive stage only brightens what lies behind it, so
over a bright background it vanishes, whatever its colour, and a splat map can be bright
anywhere. An effect whose colour has to read on any map draws over the background instead: its
colour as a flat emissive, and its texture's brightness as the opacity (`blendOver`).
Because the blend happens in display space, that is exactly the additive stage tinted over black,
and over white the colour still shows. Everything that is Q3's own look keeps Q3's additive
blend.

**The null device counts no textures** (its `createTextureImpl` adds none), so a test of what a
teardown frees can't count them there: lightmap pages once went undestroyed, and the count held.
Check that each texture was destroyed.

**Freeing and sorting have traps of their own.**
- `registry.remove()` frees nothing alone: it strands the resource and the sub-textures a `.sog`
  registers. Pair it with `unload()`, as the engine's own container resource does.
- `Material.destroy()` quietly rebinds live mesh instances to the default material, so destroy the
  entities first.
- A splat is freed only once its sorter lets go of it, a frame or two later, so wait for that
  before counting what was freed.
- `enabled` already folds in the parents; there is no `enabledInHierarchy`.
- Blended draws sort by the middle of their bounds, so overlapping surfaces of one model can swap
  order. A clone loses `drawOrder`, and the render component resets custom bounds when it takes a
  mesh, so set them after.

**A `CanvasFont` atlas is not clear where it is empty.** The engine clears it to the text's colour
at an alpha of 1/255, so each word draws on a faint box, its glyphs' cells, 2–3 levels over black.
A canvas can't hold colour at alpha 0, since it stores colour premultiplied, so clearing it
through the canvas darkens the glyphs' filtered edges. The menu's font instead replaces each
atlas texture with a typed-array copy that is white throughout and clear where empty
(`render/menu-font.ts`, on each `render` event).

**Know which renderer a Q3 screenshot came from before matching it.** ioquake3 ships two
renderers, and their brightness differs:
- **`opengl1`** is classic Q3 and the port's reference. ioq3 itself now defaults to
  `opengl2` where it loads its renderers as DLLs.
- **`opengl2`** adds HDR, a filmic tone map and auto-exposure, and draws waves dimmer.

The install's `q3config.cfg` records which one is in use (`cl_renderer`, `r_hdr` and
`r_toneMap`; on Windows it is in `%APPDATA%\Quake3\baseq3`). The screenshot can also tell you:
classic Q3's fullscreen overbright shifts every byte of a screenshot through its gamma table, so
it leaves only even values, and 255.

**The debug build can't keep up with a couple of thousand draws.** Its WebGPU checks push and
pop an error scope round every draw, and on a map of 1,892 draws their answers fell behind: the page
grew to 5 GB and never showed the map, which the release build loads in 10 s and draws at 7 ms a
frame. A check of what a player sees runs on the release build.

**On WebGPU a refused submit loses all its work, and what the engine does once is not done
again.** The browser refuses a frame's whole submit when any pass in it is invalid, as each pass
to a canvas with no area is: no texture can be made to draw it into. A splat's copy into its work
buffer, made only at its first sort, was lost there, and a map loaded on a 0×0 canvas drew black
for good. The release build ignores the device's uncaptured errors, so nothing notices. Since
PlayCanvas 2.23.2 the device keeps its last size while the canvas has none, so every frame has a
texture to draw into, and the port draws them all (`render/canvas-area.test.ts` holds the engine
to it).

**A browser's GPU defect is found by drawing it, not by the browser's name.** Firefox 148's WebGPU
loses a draw's `firstInstance` in a shader's helper, so PlayCanvas's mesh instance storage drew
every menu item with the first one's matrix. A probe at boot draws that pattern, reads it back,
and turns the storage off where it fails.

## PlayCanvas doc index

https://developer.playcanvas.com/llms.txt
