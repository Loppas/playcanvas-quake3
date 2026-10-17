# Conventions

Durable rules for this repo, distilled from the work so far. Each is a decision already paid for.

**Boundary with [`code-standards.md`](code-standards.md):** that file
governs *how to write code here* — language, layout, testing, docs. These are broader and
empirical: what this project learned about porting Quake 3, driving a splat map, and drawing and
playing a Quake 3 one, which would otherwise be re-derived. Where they overlap, code-standards
wins and is binding. How a change is proved, fixtures included, is [`testing.md`](testing.md)'s,
and how to work in the repository at all — the design principles, comments and git — is
[`AGENTS.md`](../AGENTS.md)'s.

The rules are split by theme, one file each. Read the ones a change touches; each stands alone.

| File | Covers |
|---|---|
| [porting.md](conventions/porting.md) | Measurement over derivation; reading Quake 3 at the source; porting a function whole; C's number types and memory; Quake 3's resets; the C as the x86-64 build runs it, reads past the data, and the QVMs' floats; failures in Q3's words and order; departures from Quake 3, and the port's scope; the velocity snap |
| [server-and-game.md](conventions/server-and-game.md) | Quake 3's split in the port: what reaches the client, where state lives, the page's worker and its one store, the numbers Quake 3 hands out, the frame's order, lists and length, the client doing what cgame does, hiding what cgame no longer draws, every way out shutting the game down first, and frames drawn while a map loads |
| [mods.md](conventions/mods.md) | A mod on id's core: extending id's code, rulesets as settings and presets, naming, new state, and reading a mod that ships only compiled code |
| [settings.md](conventions/settings.md) | Settings as cvars: when each takes effect, binds in an old config, every cvar read, and every cvar Quake 3 registers registered |
| [menus.md](conventions/menus.md) | The menus on screen: q3_ui's items in the port's box model, text by its capitals, one padding on all sides, a shared spacing scale, fitted and centred panels, popups, no layout shift, focus, and the probe that measures them |
| [sim-and-view.md](conventions/sim-and-view.md) | Dependencies into the sim, what counts as motion, and Quake 3's view angles |
| [maps.md](conventions/maps.md) | Units and the map boundary, rats maps, collision data, splat-maps, the install's Quake 3 maps, a BSP map beside the splat's, and a brush's contents |
| [engine.md](conventions/engine.md) | PlayCanvas: the `.sog` handler, the null device, display-space blending, vertex colours decoded before interpolating, freeing and sorting, a font atlas's faint clear, ioquake3's two renderers, the debug build's draws, a refused submit's lost work, a browser's GPU defect probed by drawing it, and the doc index |
| [rendering.md](conventions/rendering.md) | A Quake 3 world as `opengl1` draws it: Q3's framebuffer for the whole 3D scene and the ramp, one hand-sorted list keyed as Q3's sort key, depth-equal passes, and opengl1's batches each frame |
| [debugging.md](conventions/debugging.md) | Seeing a defect: the browser pane, pixel readbacks, driving frames, recording a session, measuring the menus' layout, rasterizing offline, and a page that never comes up |
| [performance.md](conventions/performance.md) | Making a frame cheap: nothing per frame, reads once a change, compiles and samplers at load, warming what the data names, batched and shared draws, measuring a loop before cutting it, the network's rules, and the picture unchanged |
| [planning.md](conventions/planning.md) | Taking a stage: survey the tree, the data and both releases of the C first, and leave nothing unscheduled |
