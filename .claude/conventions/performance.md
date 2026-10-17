# Performance

Rules for a frame that stays cheap, and for proving a change did not cost one. Measurement over
derivation is [`porting.md`](porting.md)'s rule; the harness and how a run is
judged are [`testing.md`](../testing.md)'s.

**Make nothing per frame.** A frame that allocates is a frame the collector will pause. What the
cycle pooled, grown once and then reused: the view's snapshots (`SnapshotPool`), the effects and
their material clones and buffers (the local entities and the world effects' pools), a body per
look (`PlayerEntities`), a missile per weapon, the packets (one `Message` a connection and one on
the host, the netchan's datagram buffer, the loopback's slice moved across the worker boundary),
and the solids lists. `perf-heap.mjs` names the site that is still making something.

**Read once a change, not once a frame.** Quake 3's `cgs`/`vmCvar` pattern: the serverinfo is
parsed when `CS_SERVERINFO` moves (`PlayerView.serverInfo`), and the userinfo is built, and the
rule cvars walked, only when the store's total modification count moves
(`CvarStore.totalModifications`). A per-frame parse of the serverinfo was 55% of the page's
allocation.

**Compile at load, never in play.** Every draw is done once under the load screen, Q3's
precache-then-touch (`RB_ShowImages`); the load then waits for the device's queue (`gpuFinished`)
and, on a splat map, for the splat's first sorted frame. The check is a count of zero new shaders
and pipelines after the warm-up. What a player can bring into a match is warmed from the data
that names it: every stage kind the paks' player skins name, read as text, is drawn once under the
first load screen, so a look's first join compiles nothing, at 54 shaders and 54 pipelines for 77
models' skins. Warm no more than play can draw: showing every fog pass, the
blended shaders' among them, cost the load a second.

**Bind every texture once under the load screen, every flipbook frame among them.** WebGPU makes a
texture's sampler at its first draw (`WebgpuTexture.getSampler`), so a warm-up that drew each
flipbook at two moments left ten samplers to be made in play, the later frames of q3dm11's flames.
The world's warm-up draws a frame for each frame of its longest flipbook.

**Batch draws per shader, and share pipelines.** The HUD is one quad batch a shader, in Q3's order
(`QuadBatch`, `RB_StretchPic`'s merging), not an entity a character; an `entityMergable` effect is
one draw a shader (`MergedSprites`); a surface's mesh takes an interleaved vertex format so a
shader's pipelines serve every vertex count, since PlayCanvas keys a pipeline by the surface's
vertex count. Assign a material to an instance only when it changes.

**Port Quake 3's loop as written, and measure it before cutting it.** cgame clips a trace against
every solid entity; online on `q3dm12` that was 4,000 to 7,000 brush-model traces and 9.6 ms of
prediction a frame, so a reach test went in, at 2.9 ms. A cut Quake 3 hasn't got gives every
answer the whole loop gives, held by seeded sweeps and a search: 400,000 searched sweeps met no hit
it passes over. Where the cost is a size, take Quake 3's: the music's 2 s reads cost the frame up
to 4.1 ms, and a quarter second's, about Quake 3's own 30,000 bytes, 0.1 to 0.3.

**Never dirty a material a frame.** A moving texture-coordinate transform goes through a uniform of
the port's own, written in place as `q3_coords` is, not `material.update()`; a colour change goes
through the setters, and only when it changes. PlayCanvas 2.23 keeps a material's
values in a uniform buffer, so a getter no longer dirties its shader. A state a draw can walk into
is a uniform, never a variant: a blended model stage always carries its fog's dimming, all zeros
outside a fog, so a model walking into one makes nothing.

**Pace frames on the display's frames, not on a timer**. `com_maxfps` thins
`requestAnimationFrame`'s frames (`src/frame-pacer.ts`), so the harness sees every frame made. A
Chromium started unpaced (the shell with vertical sync off, or the harness's flags) hands out the
next frame at once only after a frame that drew something. After one that drew nothing it waits
its idle pace, about 18 ms, and a pixel moved from a timer brings it no sooner. So a wait on an
unpaced display moves a pixel at each frame it holds back, as the harness's display does.

**The network's rules.**
- Read the packets before deciding to resend, as `CL_CheckForResend` does: a stalled frame must not
  resend a `connect` whose answer has already landed.
- Never send a peer what it cannot yet decode. A not-active snapshot to a just-`CONNECTED` client
  overflowed a worker's 16-deep loopback and dropped the `connectResponse` among the oldest, so the
  page never connected.
- Both server loops wake at absolute deadlines, as `SV_FrameMsec`, not a fixed sleep.
- The defaults: `snaps` 125, `cl_maxpackets` 125, `rate` 50000.

**A change that only moves work must not move the picture.** Prove it with the warm check and a
pixel readback; where a departure from Quake 3 buys the speed, state its cost beside it.
