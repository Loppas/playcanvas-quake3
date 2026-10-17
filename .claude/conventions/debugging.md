# Seeing a defect

How to look at what the game draws when a test cannot: the browser pane, pixel readbacks, frames
driven by hand, a recorded session, and a model rasterized offline. How a change is proved is
[`testing.md`](../testing.md)'s.

## The browser pane

**The automated browser pane never runs the frame loop, because its tab is backgrounded** —
`document.hidden` is `true`, so `requestAnimationFrame` never fires and neither does
`app.on('update')`. (It has also been seen with a 0×0 viewport, which stops anything rendering
at all; an offscreen render target does not rescue that either. Check `innerWidth` and
`document.hidden` before concluding which one you have.)

**The pane can still be made to render, and its pixels read back.** `app.render()` after
`app.update(dt)` draws a frame even on a hidden tab (~45 ms), and `drawImage(canvas, …)` into a
2D canvas then `getImageData` reads it out (~60 ms). That makes a real screenshot diff possible:
capture with an effect enabled and disabled *between renders with no update in between*, so
nothing else can move, and the difference is that effect alone. Toggling `entity.enabled` works
for this. **Read back at full canvas resolution** — a two-pixel-wide beam averages away to
nothing in a 4× downscale, which cost an hour of chasing a rendering bug that was really a
measurement bug.

**When the page is hidden, read from a render target, not the canvas.** With the pane hidden
(`document.hidden`), `FILLMODE_FILL_WINDOW` collapses the canvas to 0×0, and once forced back to
size a WebGPU canvas hands `drawImage` a *stale* frame — every diff reads zero, which looks
exactly like "the effect is hidden". Pin the size
(`setCanvasFillMode(FILLMODE_NONE, w, h)` plus `setCanvasResolution(RESOLUTION_FIXED, w, h)`),
point the camera at an offscreen `RenderTarget`, and read it with
`colorBuffer.read(x, y, w, h, { immediate: true })`; without `immediate` the read returns zeros.
Before trusting any diff, check that captures change when something known moves. Keep each
script under the javascript tool's 45 s timeout and crop the reads: a long loop of full-frame
readbacks crashed the pane once.

**Drive the frames yourself.** `app.update(dt)` fires the update event and runs one whole
simulation frame, so a console snippet can step the app deterministically and read the result —
which is a *better* test than watching, because a frame counter is an exact number. A synthetic
`KeyboardEvent`/`MouseEvent` dispatched at `window` or the canvas reaches PlayCanvas' `Keyboard`
and `Mouse` normally, so the whole input → sim → entity-transform chain can be exercised this way.
That is how the weapons' firing was confirmed: dispatch a `mousedown`, step twelve frames, watch the
weapon's local position leave its idle tag and the flash entity light for exactly one frame.
Set `pcqInput.active = true` first: the game takes keys and buttons only while it holds the
mouse, which a script can't capture, and the flag stands in for the capture.

**Reach the running app through the page's own copy of the engine.** Import `playcanvas` from
the exact URL the page loaded it from — `performance.getEntriesByType('resource')` lists it as
`/node_modules/.vite/deps/playcanvas.js?v=<hash>` — and `pc.AppBase.getApplication()` returns
the game's app. Any other URL loads a second copy of the module, with no app registered. Set
`app.timeScale = 0` so the real loop stands still while you step. Weapon keys follow Q3's
slots: 3 is the shotgun and 4 the grenade launcher; F holds the grapple. A refire blocks a
switch, so after the railgun, wait out its 1.5 s before pressing the next key, or the next shot is
still the rail's. Two more traps:
- **Weapons build asynchronously.** The viewmodel builds a weapon in the background, so after
  a switch, yield to the event loop (`await` a timer) before stepping anything that reads the
  gun's muzzle. A script that never yields fires a lightning gun with no bolt.
- **The HUD never updates in a hidden pane.** It stays on "loading map…", even once the game
  is running, so wait for the `world-effects` entity instead.

Frame-rate figures still need a real browser and a human. Do not report an fps number obtained
from the automated pane — a hand-driven `app.update` loop measures nothing about real frame cost.

## Recording a session

**When only a human can see the defect, have them record it: `npm run record`.** A headed
Playwright Chromium, a CDP screencast to individual frames, and a key that brackets the event.
This exists because "the rocket shrinks when I strafe" cost four rounds of prose and two wrong
hypotheses to fail to convey.

**Bracket the event, do not point at it.** The first build took a point-in-time mark and a
window around it. Across a real 46 s playtest, 11 presses landed anywhere from 800 ms *before*
the event to seconds after it — people mark when they *notice*, when they *anticipate*, and
when they *finish reacting*, all in the same session. No fixed window catches that, and every
sheet came out empty. Press once to open, once to close; whatever is between is the evidence.
The badge holds a red border while a segment is open, because a toggle without state feedback
is worse than no toggle.

**A contact sheet locates; full-resolution frames show.** Thumbnails are ~440 px wide, and a
rocket 30 px across in the source frame is invisible in one — the same failure as the two-pixel
beam that averaged away in a 4× downscale. Use the sheet to find the frames, then read those
`frames/*.jpeg`. They arrive at the display's real backing resolution (on a HiDPI display, more
than the 1280 × 720 viewport), which is where the detail is.

**Match the capture frequency to the event, and throttle by slot rather than by gap.** `--fps`
defaults to 20, which is enough to *locate* a moment and not enough to *watch* one: a rocket at
900 ups crosses this map in under a second, so twelve frames is the whole flight. Raise it for
anything that happens in a few frames. The throttle buckets time into `1000/fps` slots and keeps
the first frame in each; the obvious alternative — "has an interval passed since the last frame
I kept?" — rounds every interval up to the next 16.67 ms compositor step, so it could only ever
produce rates that divide 60. `--fps 24` silently gave 20 and `--fps 45` gave 30. Any throttle
sampling a quantised stream has this bug; measure what it delivers instead of assuming.

**Report the rate that was captured, not the one that was asked for.** The screencast cannot
hand over frames the page never composited, so the flag is a ceiling. The summary line prints
the measured cadence and warns when it falls short. That figure is the *capture* rate — it is
not, and must not be quoted as, the game's frame rate.

**Index a recording by the event's own signature, not by the marks.** A muzzle flash is a
single frame with a few hundred thousand hot pixels — unmistakable, and it finds every shot in
a 46 s session in one pass. That located six rocket flights when the marks had missed all of
them. Whatever the effect is, it usually has a signature that can be searched for; look for it
before trusting a human's timing.

Sanity to keep: the recording must not change the thing being recorded, so no extra Chromium
flags and no relaxed autoplay policy. And frames are JPEG by default — a splat render is a
photograph and costs 4.0 MB as PNG against 669 KB at quality 90 — with `--format png` reserved
for frames that will be measured rather than looked at.

## Measuring the menus' layout

**For a layout defect in the menus, run the probe before designing the fix: `npm run
probe:layout`.** It starts its own dev server and master on free ports, with a home folder of its
own, and both master slots pointed at its master through the query string, so it touches neither
yours. Tab A hosts a match and tab B visits every page: the main tree, the server browser through
its states, the Server Information box, the in-game menu as a remote server's player and as the
host, the connect screen as a map loads, and the error screen, each at 16:9 and 4:3. It writes
`report.txt`, `result.json` and a screenshot of each view under the OS's temp folder, or
`--out`. [menus.md](menus.md) says what it measures and why.

**Measure what is drawn, bar to bar.** A bar fitted round its text can outgrow the place it was
given, so two places 4 apart drew bars 2.7 apart. The probe reads each element's
`screenCorners` after the frame has fitted it.

**Read a text's ink only over its own line.** Rows 16 apart lend each other their descenders in
any box taller than the capitals, so the ink is looked for from a little over the capitals to
under the descenders. A glyph in a label's place, as a grid's arrows are, needn't fill the
capitals' box, so only a text in capitals is held to its bar's middle.

**A run that stops or finds nothing means the page changed under it.** It reads
`window.pcqMenu` and the renderer's entity names (`menu-item-N`, `menu-frame`,
`menu-popup-panel`), and each page by the labels that reach it: a label it cannot find is
reported as not reached, and its page skipped.

## Rasterizing offline

**When the pane cannot render, rasterize offline and look at the picture.** A throwaway
`src/probe.test.ts` that software-rasterizes the model — same transform chain the rig applies, a
z-buffer, near-plane clip, nearest-sample the decoded texture — and writes a BMP is enough to
*see* a render bug. BMP because it is twenty lines to write; `sips -s format bmp|png` converts
both ways, which also makes `sips` the repo's image decoder in Node, where there is none. Then
read the PNG back as an image and compare it against a reference screenshot. This found both
viewmodel defects that a human eye had flagged but could not name.

Two camera-independent variants of the same probe are worth more than the render itself, because
each answers a question instead of inviting a squint:

- **UV overlay** — draw every triangle's edges over its own texture. If the islands land on the
  painted artwork, the mapping is right, and no amount of "the texture looks off" can override it.
  That is what cleared the UVs and forced the search onwards to the real cause.
- **Winding count** — compare `cross(b - a, c - a)` against the vertex normals across every
  triangle. That is what proved MD3 faces are clockwise-outward, and so that the cull mode was
  inverted.

Render the *broken* configuration too. Reproducing the reported screenshot from the suspected
cause is what turns a plausible story into a proven one — here, culling clockwise faces
regenerated the reported image exactly.

This is still "probe, then delete the probe": what ships is the fix, a test pinning the
measurement, and a comment giving the reason.

**Name the surface under a texel that differs with a depth buffer of your own.** A throwaway
Vitest file rasterises the map's surfaces from the capture's view in software, keeps the nearest at
each texel, and tallies the pair's differing texels by shader. That put most of two maps' remaining
difference on vertex-lit statues, which a second pass interpolating their colours both ways
explained.

## A page that never comes up

**Pause it through the debugger, and step out to the callers.** A page whose main thread is busy
answers no `page.evaluate` and starts no profile, but CDP's `Debugger.pause` still interrupts it,
and `Debugger.stepOut` walks up from wherever it landed. Navigate with `waitUntil: 'commit'`,
since a busy page may never fire its load event, and bound the browser's close. A pause that lands
in the engine's per-draw bookkeeping rather than in a loop of the port's means the page is drawing,
only slowly: time the same load on the release build before suspecting the port.
