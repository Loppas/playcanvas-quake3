# Maps

## Units and the map boundary

**The sim runs in native Q3 units, Z-up, at 32 units = 1 m**. Convert to the renderer's
metres and Y-up only at the render boundary — never inside `sim/` or `view/`.

**Map assets arrive already polished.** splat-maps delivers them levelled, walls squared,
floor on y = 0 and metrically scaled, so `MAP_EULER_ANGLES` is `(0, 0, 0)` for any polished map.
A non-zero value there is a stopgap for a raw capture and should not survive.

**A "rats" map scales the world, not the player.** The player stays 1.75 m (the 56-unit box), so
every Quake constant keeps working unchanged and the feel follows automatically. Scale factors are
set upstream in splat-maps' polish, not compensated for in the game.

## A rats map changes what "correct" looks like

**Effects are authored for Quake distances; this map is 16.09× larger than one.** `garage_rats`
turns a 4.53 × 8.29 × 3.00 m garage into an 80 × 144 × 52 m room, so the far wall is ~4 600
units away where a Q3 room puts one at 400–800. A correctly-sized rocket therefore recedes to a
speck within half a second and takes about five seconds at 900 ups to cross the room — and
often never hits anything while the player is still watching.

So "the projectile looks too small" and "the explosion never happens" are the *expected*
appearance of correct code on this map, and cannot be judged by eye here. Any fidelity claim
about a projectile or an effect has to be made against its distance **in Quake units**, not
against how it looks in this room. Measure `apparent size × distance`; that product is what a
perspective bug breaks, and it is scale-free.

## Collision data

**The collision bake is `splat-transform`'s own output, decoded by us.** We
do not vendor viewer code, and we do not swap the trace: `.voxel.json` + `.voxel.bin` load behind
the `VoxelGrid` seam and `voxel-trace.ts` is unchanged. `--collision-mesh`'s `.collision.glb` is a
debug overlay only — routing the trace through it would mean mesh sweeps and ammo.js, which the
port rules out.

**The `.voxel.json` is only a header; the octree is the `.bin`.** It carries bounds,
`voxelResolution`, `leafSize` and array counts. The binary is a Laine-Karras SVO of `uint32`
nodes followed by `leafData`: interior `(childMask << 24) | firstChildIndex` with children
contiguous in octant order, solid leaf `0xFF000000` (baseOffset 0 is never valid for an interior
node under BFS layout), mixed leaf indexing `leafData` in pairs as a 64-bit mask over a 4×4×4
block. `gridBounds` is in world units; block edge is `leafSize × voxelResolution`.

**Bake the file you ship, and size the voxel in Quake units.** The voxel flags are metric with
human-scale defaults, which a rats map invalidates: `--voxel-size 0.05` on a 16× map asks for
billions of voxels, and baking the unscaled map instead lands the grid at 25.7 units — coarser
than the 18-unit `STEPSIZE`, so steps stop existing. The sizes are splat-maps' to choose
(`splat-maps/docs/map-format.md` §6.1): a whole-unit voxel of at most 13, and a carve box no
larger than the crouched player, 30 × 40. The carve's box snaps to whole voxels, so
`--voxel-carve 1.75,0.47` at 0.25 m rounds to 40 × 72, not the player's 30 × 56.

**A decoder claim is checked against the header.** The reader must reproduce `numInteriorNodes`
and `numMixedLeaves` exactly, reach every node in `nodeCount` with no orphans and no node twice,
and fill `gridBounds` — that is what caught a wrong first guess at the layout.

## Quake 3 maps

**A map with a BSP and no splat is played on its BSP.** Its world draws as `opengl1` draws it under
the player's view, and the server and the client each trace it through Quake 3's own collision
(`src/sim/cm`), loaded from the one file in cgame's order: collision, then the world. A map that
ships a splat takes the splat match. While the cheat `pcq_preview` is set, a BSP map
opens as a preview instead: its world for a free camera, with no game, server or collision. The
renderer's rules are [`rendering.md`](rendering.md)'s.

**A BSP map is a branch beside the splat's, never its replacement.** A splat map loads, draws,
traces and plays as it did, and every stage's check plays a splat match beside its BSP ones.
Where a change of Quake 3's own reaches a splat match, it is put as such: a resting grenade
traced, a light's bytes truncated and the base mixer's levels.

**A brush's contents are the compiler's, not its shader's name.** `common/trigger` is only
`nodraw`, so q3map gives a trigger's brushes `CONTENTS_SOLID`: a point in one reads solid on the
server, and refuses a water jump over a ledge there, as Quake 3's does, while the client, which adds
only solid brush models, predicts the jump.

**A player's `baseq3` is often not retail, and their maps are all of it.** Third-party paks sit
beside pak0–pak8, and later paks override earlier ones: one in circulation ships a `common.shader`
with no `portal_sfx`, so with it q3dm11's portal draws as its image alone. A check against Quake
3's own data reads pak0–pak8 alone. Third-party paks use what no retail map does (`tcGen base` or
`lightmap`, smoothed planar normals), so Q3's rules are ported whole and proved on maps built for
the test; and some are zips with no end-of-central-directory record, skipped as ioquake3 skips
them. Count the install before scoping a stage, and load every map in it once before a change
reaches them all.

## The map pipeline

**The map pipeline lives in [`splat-maps/`](../../splat-maps/), kept apart from the game**, with
its own [conventions](../../splat-maps/docs/conventions.md). Do not re-derive capture, training,
polish or scale rules in the game's code.
