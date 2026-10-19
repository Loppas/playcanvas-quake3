# Capture Checklists — Photos & Video for Gaussian Splats

Good capture is the biggest quality lever — nail this and the cleanup after training is short.

## The three rules that matter most

1. **Lock exposure, focus, and white balance (full manual).** Auto-exposure flicker breaks
   SfM registration and bakes color drift into walls. #1 rule.
2. **Downward floor passes.** Floors shot only at grazing angles reconstruct as noise — the
   top complaint for walkable splats. Shoot the floor deliberately, about 45° down.
3. **Close the loop.** Return to your start and overlap the first frames so poses form a
   consistent ring.

![Filming a room. From above: a ring along the walls that pauses at each corner and goes back over its start, filmed both ways, toward the walls and into the room, and a slow pass over the whole floor. From the side: rings at low, eye and high heights, each filmed both ways, a pass tilted about 45 degrees down at the floor, and one tilted up at the ceiling](images/capture-path.svg)

## Universal (both modalities)

- [ ] Full manual: fixed shutter, ISO, focus, white balance — one setting all session
- [ ] Static scene only — no people/pets/cars/blowing foliage (they become permanent floaters)
- [ ] Even, diffuse light — overcast or bounced/soft indoor; avoid hard shadows & shifting daylight
- [ ] Sharp frames: shutter ≥ **1/125 s**, **f/8–f/11**, ISO as low as light allows (100–400),
  35–85 mm equiv
- [ ] **Multiple heights** — low / eye (~1.7 m) / high
- [ ] **Each ring both ways** — facing the walls, and facing into the room, level to about 15°
  down
- [ ] **Downward floor passes**, about 45° down, + upward ceiling/upper-wall pass, 30–45° up
  with ceiling lights out of frame
- [ ] Cover corners, floor-wall & ceiling-wall seams, both sides of every doorway
- [ ] **Close the loop** (overlap start)
- [ ] **Measure floor to ceiling**: the polish scales the map by it ([maps.md](maps.md), step 2)
- [ ] **Scale reference in frame** (meter stick / printed board / known object) → checks that scale

---

## (a) VIDEO — printable

```
[ ] 4K minimum, 60 fps+ (high fps = less motion blur, more frames)
[ ] Full manual: fixed shutter (>=1/120), ISO, focus, white balance
[ ] Move SLOWLY & smoothly; pause at corners; NO whip pans
[ ] Overlapping rings at 2-3 heights (low / eye / high)
[ ] Film each ring both ways: facing the walls, and facing into the room,
    level to ~15 deg down
[ ] Dedicated slow DOWNWARD-tilt pass over the whole floor, ~45 deg down
[ ] Dedicated UPWARD pass for ceiling / upper walls, 30-45 deg up
[ ] Orbit key objects 360 where reachable
[ ] Return to start, re-film opening path (loop closure)
[ ] Keep a scale object visible for several seconds
[ ] Extract every 2nd-5th frame; discard blurred -> ~150-500 sharp frames
```
**Prefer video when:** you need dense coverage fast, the space is large/complex, or you
can't hold still for hundreds of stills.
**Downsides:** rolling shutter + per-frame motion blur, lower per-frame resolution (~8 MP).

---

## (b) PHOTO — printable

```
[ ] Full manual + RAW / high-quality JPEG; single fixed exposure all session
[ ] f/8-f/11, ISO 100-400, shutter >=1/125 handheld (tripod if dim)
[ ] Manual focus locked; manual white balance locked
[ ] 70-80% overlap within a ring/row; 60-70% between height rows; 15-30 deg between shots
[ ] Room-scale: 200-500+ photos; small object: 50-200
[ ] 3-4 height rings (crouch / standing / raised) around the whole space
[ ] Shoot each ring both ways: facing the walls, and facing into the room,
    level to ~15 deg down
[ ] Deliberate downward-angled shots covering the entire floor, ~45 deg down
[ ] Upward shots for ceiling / tops of walls, 30-45 deg up
[ ] Cover corners, seams, both sides of every doorway; close the loop
[ ] Scale reference photographed clearly in several frames
[ ] Cull blurry/duplicate shots before COLMAP
```
**Prefer photos when:** quality is the priority (hero scene), higher per-frame resolution
(40 MP+) and better low-light matter, and the scene is static enough to shoot deliberately.
**Downsides:** slower, easier to leave coverage gaps.

---

**Short version:** photos = maximum sharpness/resolution per view → best final fidelity;
video = fastest path to dense, gap-free coverage → best for large/awkward spaces. Video +
frame extraction is the pragmatic middle ground; shoot video for coverage, add a few stills
for detail areas.

---

## (c) MACRO / FOCUS-STACKED capture (advanced — close-range "miniature" scenes)

For close-range subjects, depth of field is millimetres and you can't buy it back with
aperture (diffraction softens the frame past ~f/11–f/16). Since splatting wants **all-in-focus,
pinhole-style images**, the fix is **focus stacking**: at each camera position shoot a bracket
of shots across focus, then merge them into one sharp image. This is an established technique —
"macro Gaussian splatting" (COLMAP → splat, same backbone as this pipeline).

**Do the cheap baseline check first.** At your shooting distance, take one shot at **f/8–f/11**.
If it's sharp corner-to-corner, you DON'T need stacking — just capture normally (checklist a/b).
Only stack if DoF is visibly too shallow.

**Two independent axes — don't conflate them:**
- **Focus brackets** (per position) → solve *sharpness*. Merged to ONE image per position.
- **Multiple positions** (parallax) → solve *3D coverage*. Stacking does NOT replace this; you
  still orbit the subject at many positions/heights like checklist (b).
- Total frames = `positions × frames-per-bracket`; each position collapses to one stacked image.

**Terminology:** you vary **focus distance**, NOT focal length. Keep **focal length + exposure
locked**; only the focus point moves within a bracket (COLMAP needs consistent intrinsics). The
slight magnification shift as focus changes ("focus breathing") is corrected by the stacker's
alignment step.

### Per-position focus bracket — printable
```
[ ] Camera ROCK-SOLID (tripod/rig/rail); nothing moves between bracket shots but focus
[ ] Full manual, ONE fixed exposure + fixed focal length for the whole session
[ ] Bracket focus NEAREST -> FARTHEST point of the subject
[ ] Focus steps small enough that each shot's sharp zone OVERLAPS the next
[ ] ~10-30 frames per stack (macro insect work caps ~16); more for deeper subjects
[ ] Controlled/plain background (bright or busy backgrounds -> floating splats around subject)
[ ] Then MOVE to next position and repeat -> many positions at multiple heights/angles
[ ] Keep a scale reference visible (per universal rules) to check the metric scaling
```

### Focus-stack the brackets (open source, $0, local)

| Tool | Interface | Notes |
|---|---|---|
| **focus-stack** (Petteri Aimonen) | **CLI**, batch | Best for scripting over many positions. Fast, cross-platform, auto-aligns. |
| **ChimpStackr** (noah-peeters) | GUI **+ CLI** | Multiple algorithms; good GUI sanity-checker for first stacks. |
| **OpenFocus** (Xinzhe99, 2025) | GUI (PyQt6) | MIT; strong alignment/blending; CPU default, optional GPU. |
| **Hugin** `align_image_stack` + `enfuse` | CLI | Classic scriptable FOSS route; more manual. |

(Proprietary Helicon Focus / Zerene Stacker are the paid gold standard — excluded by the
open-source/$0 rule.)

One stack, then a batch over a folder-per-position layout:
```bash
# single position
focus-stack pos01/*.JPG --output stacked/pos01.png
# batch (bash): each subfolder of positions/ is one bracket
for d in positions/*/; do focus-stack "$d"/*.JPG --output "stacked/$(basename "$d").png"; done
```

### Feed stacked images into the pipeline
The `stacked/` folder of all-in-focus images IS the image input to the pipeline.
`frames` takes a video, so copy the stills into `data\<scene>\images\` and run `sfm` on
`data\<scene>` ([training.md](training.md), stage 2). It matches sequentially, as a walk-through
video wants (see §(d)). For a controlled macro set of a few hundred images, `exhaustive` matching
is appropriate: run the COLMAP commands `sfm` runs, with `exhaustive_matcher` in place of
`sequential_matcher`. Then continue with `train` and `export` unchanged.

### Macro gotchas
- **Backgrounds → floaters.** The #1 macro-splat artifact. Control the background or plan to
  crop hard in SuperSplat after training.
- **Parallax still required.** Sharp ≠ 3D. Cover many angles/heights.
- **"Miniature" ≠ tilt-shift blur.** For a VR splat you want everything sharp; the small-world
  feel comes from scale/framing, not lens blur.
- **Time drift.** Long macro shoots let the subject/light shift — work efficiently.

> Untried in this pipeline. Validate the per-position stack quality on a couple of fixed
> positions before committing to a full multi-position macro capture.

---

## (d) HARD INTERIORS — white / glossy / low-texture rooms

Modern kitchens, bathrooms, and laundries are the **worst case** for Gaussian splatting: white
cabinets, walls and counters give almost no photometric gradient, and glossy surfaces, glass, and
stainless add view-dependent reflections that corrupt SfM. Film them with more care than the
checklists above ask:

- **Lock exposure and white balance**, full manual, one setting the whole clip. On iPhone, the
  free **Blackmagic Camera** app locks ISO, shutter, white balance and focus; the built-in
  Camera's AE-lock still drifts, and can't lock white balance.
- **Keep lights and windows out of frame.** Turn ceiling downlights off, curtain bright windows,
  expose for the room, and never pan across a light.
- **Stand back, 1.5–2 m**, so several surfaces and objects fill each frame. A lone flat wall
  filling the frame has no geometry to match.
- **Shoot mirrors, glass and stainless at an oblique angle**, never head-on, with yourself out of
  the reflection, and expect to crop them in SuperSplat after training.
- **Add temporary texture**: patterned props on counters (books, patterned cloths), or low-tack
  painter's-tape crosses on blank walls, peeled off after.
- **Move slowly** and pause at corners, with the shutter at 1/120 or faster. A high frame rate
  (60 fps) helps only if the motion is slow.

**Match frames in order, densely.** The `sfm` stage's sequential matching is right for a
walk-through, but it needs frames close together in time: extract them about 0.6 s apart. Don't
reach for `exhaustive` matching to make up for sparse frames in a repetitive room: identical
cabinet doors and doorframes match falsely, into a reconstruction that is wrong but fits its
frames well, and trains to fog. Fix the coverage at capture and extraction, not with a heavier
matcher.

### Hard interior — printable
```
[ ] Blackmagic Camera (or equal): LOCK ISO, shutter (>=1/120), focus, white balance
[ ] Turn OFF ceiling downlights; curtain/avoid bright windows; even ambient light
[ ] Lights and windows OUT of frame; never pan across them
[ ] Stay 1.5-2 m back; keep 2-3 surfaces/objects in every frame (never a lone flat wall)
[ ] Add texture: patterned props on counters + low-tack tape crosses on blank walls
[ ] Move SLOWLY, pause at corners, no whip pans; overlapping rings at 2-3 heights
[ ] Oblique angles on mirror/glass/stainless; keep yourself out of reflections
[ ] Dedicated slow downward floor pass; brief controlled upper-wall pass (not the lights)
[ ] Orbit the textured counter/appliance areas; close the loop back to start
[ ] Measure floor to ceiling for the polish; keep a known-size object in frame to check it
[ ] Extract ~0.6 s apart (dense) -> sequential matcher; expect ~300-500 sharp frames
```

> If a room still won't resolve because it is genuinely featureless, that surface may be a poor
> splat subject — stage it with props, or accept heavy cleanup there.

### Example: a kitchen that trained to fog

This is a real capture that failed: a kitchen filmed for this pipeline, whose splat trained to
fog. Nothing in the pipeline was wrong; the capture was. Its 413 frames, measured, showed each
mistake the advice above prevents:

| What went wrong | What the frames showed | The advice that prevents it |
|---|---|---|
| Exposure not locked | brightness swung from 50 to 211, of 255 | Lock exposure and white balance |
| Frames aimed at ceilings and downlights | up to a third of a frame blown pure white | Keep lights and windows out of frame |
| The camera point-blank on blank walls | the blurriest frames were a wall about 30 cm away | Stand back, 1.5–2 m |
| The photographer reflected | the photographer visible in a glossy wall | Shoot reflective surfaces at an oblique angle |
| Low texture everywhere | the sharpest frame was still soft, a Laplacian variance of only 95 | Add temporary texture: the one patterned towel in frame was the strongest region |
| Motion blur | about 18% of frames below half the median sharpness | Move slowly |
