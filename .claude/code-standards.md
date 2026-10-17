# Code Standards & Design Philosophy

## How to use this file

These standards are **binding on the agent**. Adhere to them strictly unless the maintainer gives
permission to supersede them.

Scope: this file is *how to write code here* — language, layout, testing, docs and process. The
rules for working in the repository at all — the design principles, when to stop and ask,
comments, breaking points and git — are in [`AGENTS.md`](../AGENTS.md). The broader empirical
rules this project has learned (measurement over derivation, the velocity snap, the sim/view
boundary, engine and fixture gotchas) live in [`conventions.md`](conventions.md). Where this file
overlaps either, this file wins.

If satisfying a requirement appears to require violating a standard, **stop and raise it with the
maintainer** — do not decide unilaterally, and do not quietly work around it. State which
standard is in tension with which requirement and what the options are. Once the maintainer
grants an exception, record it where the next session will read it — here, if it lasts, or in the
pull request that needed it — so it is not re-litigated.

## Language & tooling

Started from PlayCanvas's `vanilla-ts` template (`npm create playcanvas@latest`):

- **TypeScript**, `strict` + `noUnusedLocals`/`noUnusedParameters` + `erasableSyntaxOnly`.
  `erasableSyntaxOnly` bans constructor parameter properties and `enum` — declare fields
  explicitly.
- **Vite** dev server / bundler; **PlayCanvas 2.x** as a plain npm dependency (engine-only,
  no editor). Node `^20.19.0 || >=22.12.0`, and `.nvmrc`'s for development.
- `npm run typecheck` must be clean before any change is called done.
- No linter/formatter yet — add one when the codebase justifies it, not before.

## Project layout

```
src/              # the game: the page (main.ts) and the PlayCanvas glue (App.ts and beside it)
  sim/              # Q3's game and bg_ code: pmove, collision, entities, items, weapons, rules
  server/           # Q3's server: the host, the dedicated server, a tab's server in its worker
  net/              # Q3's network: msg, netchan, deltas, the client's connection, masters, WebRTC
  view/             # Q3's cgame and q3_ui: prediction, the HUD, effects, the menus' pages
  render/           # the PlayCanvas side: the world, models, effects, HUD and menus drawn, sound
  formats/          # Q3's files: bsp, md3, shaders, entity text, arenas, cfgs, images, sounds
  pak/              # pk3s: zip reading, the search path, the install, the browser's cache
  settings/         # cvars, binds, the config file and the command router
master/           # the port's dpmaster
electron/         # the desktop shell's main process
scripts/          # the dev server's routes, build helpers, live checks and tools
public/maps/      # the port's map pk3s — gitignored
```

Per "Decouple simulation from rendering" below, only `render/` and the glue at `src/`'s top
import `playcanvas`; every other folder runs under Node, headless, for tests. `src/view/` is Q3's
cgame split: presentation that must not affect the simulation. Dependencies point **into** the
sim, never out of it — `view/look.ts` takes its pitch limit from `sim/constants.ts` for exactly
this reason.

## Design philosophies

- **Feel first.** Any change touching movement must preserve ioq3-faithful behavior.
  Movement constants live in one place, named as in bg_pmove.c, with source references.
- **Decouple simulation from rendering.** The movement/collision sim must not depend on
  PlayCanvas types; the engine is a view/input layer. (Enables headless testing of pmove.)
- **Determinism where it matters.** Fixed-tick simulation, frame-rate independent
  (ioq3 pmove_msec lessons apply).
- **Small, reviewable steps.** Each change lands as a small, reviewable pull request.

## Coding conventions

The design principles — SOLID, KISS and YAGNI, readability over efficiency, no moving parts the
work did not ask for, and one definition for what must agree — are
[`AGENTS.md`](../AGENTS.md#design-principles)'s. Here:

- **JSDoc on functions and classes.** Document what it does and what the parameters mean;
  skip restating types the signature already gives.
- **Comments: succinct and sparing**, as [`AGENTS.md`](../AGENTS.md#comments) sets out. Here
  that is mostly why a constant has that value, which ioq3 source a formula comes from (as
  `file.c:line`), or a non-obvious engine constraint.

## Testing

**Runner: [Vitest](https://vitest.dev)** (`npm test`), with jsdom for the DOM layer. It shares
Vite's transform pipeline, so no second build config. Tests are colocated as `*.test.ts` and
import from `vitest` explicitly rather than relying on globals. Files needing a DOM opt in per
file with `// @vitest-environment jsdom`.

- **A suite of unit and integration tests must exist before code is committed.** Not after,
  not "next milestone".
  - *Unit* — the sim math in isolation: accel/friction/strafe-jump curves, golden values
    taken from ioq3 behaviour, trace primitives against synthetic voxel geometry.
  - *Integration* — the pieces wired together: pmove driving the real trace backend through
    a test room, asset/scene wiring booting without error.
- Movement constants that diverge from `bg_pmove.c` source values require both a test
  pinning the chosen value and a comment giving the reason.
- **Mock only what cannot run in the test environment** — the graphics device, and later the
  engine surface. Everything downstream of that seam is exercised as real code. A test that
  mostly asserts against mocks is not coverage.

**Known gap:** the graphics path in `src/App.ts` — device creation, SOG asset load, gsplat
component wiring — has no unit coverage, because jsdom provides neither WebGPU nor WebGL2.
Closing it would mean a browser runtime under the suite (`@vitest/browser` + Playwright). Until
then that path is proved by live checks in a real browser ([`testing.md`](testing.md)).
Everything testable without a GPU is covered.

## Documentation & process

- A change and its docs land together: what the README or a convention says of the behaviour
  changes in the same pull request.
- A recorded decision is not re-litigated — reopen it explicitly with the maintainer instead.
- Git — commit messages, branches and what never goes in a commit — is
  [`AGENTS.md`](../AGENTS.md#git)'s.
