# Conventions

Settled rules for the splat-map pipeline. Each one is a lesson already paid for: reopen one
explicitly with the maintainer rather than quietly re-deciding it.

## Verification

**Re-measure the artifact you wrote. A display is not evidence.** Every wrong turn in building
the polish came from believing something that looked right: a first-person render whose residual
pitch read as ordinary perspective, section drawings that are flat by construction because they
are drawn in the levelled frame, and twice a coarse intermediate printed where a final number
belonged. Load the output file back and compare numbers against the input.

**Never print a stage value where a reader expects a result.** `find_up`'s coarse axis was
printed as "vertical axis N deg off" while the refined answer went unprinted; that alone
manufactured a phantom 1.07 deg defect and sent a long hunt after a rotation bug that did not
exist. Label intermediates as intermediate, and print the final value next to them.

**Pictures are for spotting gross errors — upside-down, inside-out, wrong room.** They cannot
confirm a transform. Numbers can.

## Calibrating an external tool

**Probe undocumented conventions; do not guess.** `splat-transform --rotate` documents no Euler
order. Three guesses cost three full round trips before measuring settled it in one.

**Probe every action, not only the interesting one.** Rotations cannot identify a frame:
conjugating by `diag(-1,-1,1)` and by `diag(1,1,-1)` are the same operation, because they differ
by `-I`, which cancels. The rotation calibration therefore passed while `--translate` stayed
silently wrong and put a polished floor at -3.136 instead of 0. Translation distinguishes them.

**A re-encode does not preserve splat order**, so a recovered transform cannot come from pairing
points by index. Use order-free statistics: covariance eigenvectors for the rotation (third
moments break the per-axis sign ambiguity, since odd moments flip with the axis), centroid
difference for translation, extent ratio for scale.

**Single-axis probes cannot separate composition orders** — several conventions stay degenerate.
Always include a probe with all three angles non-zero; that is the one that decides.

**Current answer (splat-transform v3.1.6):** it works in a frame rotated 180 deg about Z,
`ST_FRAME = diag(-1,-1,1)`, and composes `Rz*Ry*Rx`. One frame governs rotate, translate and
scale together. Re-run `calibrate_transform.py` after any upgrade:
`uv run python -m splat_maps.calibrate_transform <source.sog>`, from `splat-maps/`.
- **The rasterizer's camera is in that frame too.** `--camera-pos`, `--camera-target` and
  `--camera-up` are `ST_FRAME` applied to the file's coordinates, which is the collision
  octree's frame.
- **Measured with coloured probe splats:** aimed at +X it sees the file's −X, and the file's +Y
  comes out down. Right is forward × up, row 0 is the top, and `--camera-fov` is vertical.
- **File coordinates render upside down, from the wrong side.** That is what `sog_inspect
  --render` did until it was measured, so its check views were upside down. A picture meant to
  catch an upside-down map cannot be trusted until its own camera is calibrated.
- **A large frame silently loses splats.** From the garage's spawn, 1024 × 1024 renders full and
  1025 × 1024 comes out 98% background, with no warning. 2049 × 512 is full, so the limit
  depends on the view, not only on the size. Render at 1024 × 1024 or less, and count the
  background pixels of every render a check relies on.

## Fitting geometry in a splat cloud

**Density proposes, area decides.** Choosing a surface by point count picks a rafter over the
ceiling boards it hangs below, and a dense clutter shoulder over the floor slab 26 cm beneath it.
Grow each candidate into a plane, re-fit on its own inliers, and select on coverage.

**Erode the perimeter before fitting a floor.** Where floor meets wall the lowest thing present
is skirting, a shelf base or stored junk — all slightly high, all around the outside, levering
the plane like a rim. A whole-floor flatness figure of 0.91 units peak-to-peak became 0.028 once
the boundary ring was dropped.

**An iterative plane fit needs an anchor.** Re-selecting inliers from the whole cloud each pass
lets the plane walk: roughly a tenth of a typical interior capture is reconstruction spill
*below* the slab, and unanchored the floor slid into it and inflated the room by a quarter-metre.
Let the plane rotate freely; do not let it leave its seed.

**Converge on the same data you report.** Refining against a subsample and then reporting a
full-cloud fit means the transform levels one estimate while the verify measures another. The
disagreement looks exactly like a bad rotation convention and is not one.

**Test rotation invariance by measuring one scene under several rotations.** A statistic that
sets the scale must not move when the cloud does. Clear height varied 10% across four rotations
before this was checked, which would have been a 10% wrong map.

**Geometry alone cannot orient a box.** Every axis of a room has a dense enclosing plane pair and
four perpendicular walls, so enclosure tests pick the long axis as readily as the vertical. Use
the capture-upright prior (`--up-hint`, default world +Y): a handheld capture is never 90 deg from
level. Aerial and turntable captures will need something else.

**The prior fixes the axis but can pick the wrong end.** "Never 90 deg from level" still leaves
two candidates 180 deg apart, and a capture whose reconstruction came out upside down leans past
90 deg from +Y — so `find_up` locks onto the downward normal and the whole map, splat and
collision bake together, levels the wrong way up. The garage did exactly this: the polished
floor was really the ceiling, and the player stood on it. The physical tell is
spill asymmetry — SfM leaves far more stray points *under* a real floor than above a ceiling, so
when the report shows more cloud past the ceiling than under the floor the sign is probably
flipped. `sog_inspect` now warns on that and names the negated `--up-hint` to try; the garage
needs `--up-hint 0,-1,0`. Verify the fix by re-running and comparing the two reports (and a
`--render`), not by eyeballing the section drawings — they are drawn in the levelled frame and
look flat either way up.

**Absolute scale cannot be recovered from SfM output.** It comes from the physical space — one
known distance, or a scale bar in the capture. Everything else is derivable; this is not.

## Performance and memory

**`np.linalg.svd` defaults to `full_matrices=True`.** On an `(N, 3)` input that allocates an
`N x N` left-singular matrix — 6.4 GB at a 40k-point band, enough to drive the machine into swap.
Plane normals come from the 3x3 scatter matrix via `eigh`, which is identical and O(1) in memory.
Fixing this took the tool from 5.8 GB / 4 min to 0.39 GB / 6 s.

**Filter and cap before decoding, not after.** Building all 13.9M centres and then selecting
needs several float32 copies of the whole cloud; selecting first means the arithmetic only ever
touches what is kept. Fits and histograms converge long before a million points.

**Bound anything long-running, and run heavy steps one at a time.** `splat-transform` itself
peaks near 4 GB writing a large SOG — that budget is not ours to shrink, so do not stack it
against another hungry process.

## Scale and game units

**32 units = 1 m; the player is 1.75 m** (Quake 3's 56-unit box; the port's `src/coords.ts`).
Kept as `UNITS_PER_METRE` in `splat_map`, and `PLAYER_HEIGHT_M` in `sog_inspect`.

**A "rats" map scales the world, not the player.** Because the player stays 1.75 m in world
units, the player's box, step height and speeds all keep working, and the map's feel follows
automatically. Express the intent as `--player-height` (how
tall the player should appear in the real space) rather than as a bare multiplier.

**Capture resolution bounds the usable scale factor.** Apparent blob size is splat spacing times
the factor. The garage's ~2.8 cm spacing is invisible at life size and reads as ~45 cm smears at
16x. Scaling up past what the capture resolves cannot be fixed downstream — it needs a denser
re-capture or a smaller factor.

## The map editor and q3map2

**A model for NetRadiant-custom or q3map2 is Y up, in units.** Both load every model through
assimp and turn it from Y up to Z up, (x, y, z) to (x, −z, y), with no scale
(`plugins/assmodel/model.cpp:678-682`, `tools/quake3/q3map2/model.cpp:325-329`, tag 20260114).
That turn is the port's world-to-sim without the 32. So a reference model is the world frame times
32, and a `misc_model` at the origin then sits where the player meets it. A model written in sim,
Z up, lies on its side. Measured with the bundled q3map2: a marker came out turned exactly so, and
the garage's collision mesh landed 0.0000 units from the octree's.

**Point the editor's engine path at a writable copy, never at the game install.** The editor
offers to install its dev files into the engine path whenever that differs from where it last
installed them (`radiant/mainframe.cpp:306-314`), and its shader module may write
`scripts/shaderlist.txt` there. A reference model goes under that path's
`baseq3/models/splatmaps/`.

**The editor opens one brush syntax per file.** It finds axial, brush primitives or Valve 220
from the file and stops at the first brush in another (`parse error ... expected '['`), loading
nothing. A test map for the editor keeps to one syntax. `map_to_ent.py` reads all three, so a
mixed map still tests it.

**Check a hand-written brush for volume before a test relies on it.** The editor loads a brush
whose planes enclose nothing, counts it, and draws nothing. On save it writes only the brush's
`// brush N` comment (`radiant/brushtokens.h:553-558`), so the brush is deleted without a word.
q3map2 takes a face's three points a, b, c as the plane with normal (c − a) × (b − a), pointing
out of the brush.

## Process

**The scripts and the docs hold only what has been run end to end.** A step that has not is
named as untried where it is described.

**Polish is scripted, never a GUI pass.** SuperSplat output is unreproducible, undiffable
and unreviewable, and cannot run per scene from a batch file. SuperSplat stays for judgement
calls no script should make: deciding what is clutter and what is the room.

**The collision bake is splat-transform's own output** — `--voxel-carve`,
`--voxel-external-fill`, `--collision-mesh`. Do not vendor viewer code for it. It writes
`.voxel.json` **and** a `.voxel.bin` sidecar: the JSON is a header only and the octree is the
binary, so the consumer still needs a reader — the port's is `readOctree`
(`src/formats/splat-map.ts`).

**Voxel flags are metric with human-scale defaults, so a scaled map invalidates them.**
- **Size every flag in Quake units, on the file that ships**, not from the defaults. On a 16x rats
  map the 0.05 m voxel asks for billions of voxels. Baking the unscaled map instead lands the grid
  coarser than the engine's step height.
- **No one voxel size suits every map.** It is a whole number of units, at most 13, chosen per map.
- **The carve's player is a box that snaps to whole voxels**: `2⌈r/v⌉+1` wide and `2⌈h/2v⌉+1`
  tall, centred on a cell. So pass the flags that round to a box no larger than the crouched
  player, 30 × 40 units, never the player's real size. `--voxel-carve 1.75,0.47` at 0.25 m rounds
  to 40 × 72 and seals gaps the player fits through ([map-format.md](map-format.md) §6.1).
- **Seal with the least external fill.** Its dilation seals every hull hole under twice its
  reach, but a large reach also seals the ring of reconstruction spill around the room, and the
  voids inside the ring then stay open behind every hole the carve's small box gets through. The
  smallest reach that does not leak seals the room and fills the most outside. `bake_map.py`
  bisects for it.
- **A leak is logged, not raised.** splat-transform prints `seed reachable from outside, skipping
  exterior fill` as information and writes the octree anyway, with the whole outside open. Check
  the log, and measure where the player's box can reach, not only the octree's structure.
- **Bake the file that ships**, so the player collides with what they see.

**Polish runs measure → apply → verify → record**, and the second measurement is the
deliverable's warrant. The record step fails the polish unless it shows tilt and yaw within
0.1°, the floor within 1 unit of y = 0, and the clear height kept within 0.5%.
- **The verify always hints +Y.** The output is +Y up by construction. Handing it the input's
  `--up-hint 0,-1,0` makes `sog_inspect` lock onto the ceiling and report the map upside down.
- **The polish keeps the source's `license.txt`** inside the output bundle, since
  `splat-transform -w` drops it. The credit it carries is the licence's condition, not
  decoration. A capture with none, as `export` writes, is given one with
  `--license`, a file or its fields in a string. A source's own licence is never replaced: that is
  its creator's to set.
- **A re-encode reproduces geometry, not the SH codebook.** Positions, rotations, scales and
  base colour come out byte-identical. The SH codebook is chosen by k-means, so compare a
  re-polish by its bake, or by its measured transform.

**Batch files are where arguments get lost.** Three bugs kept `polish.bat` from ever running end
to end:
- **Quote any value with a comma.** cmd splits arguments on commas as well as spaces, so
  `--up-hint 0,-1,0` arrives as three arguments. `%*` keeps them, and `%1` with `shift` does not.
- **`call` every `.cmd`**, npm and splat-transform among them. Without it the calling batch
  ends when the `.cmd` does, with exit code 0, so every step after it silently never runs
  (measured: npm installs splat-transform on Windows as a `.cmd`).
- **Start a `for /f` command with `call`** when it begins with a quoted path. `for /f` strips the
  first and last quote of such a command, which breaks the path.
