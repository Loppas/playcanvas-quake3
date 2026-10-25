# Artefacts

What a player sees in a splat map that the capture didn't mean, what draws it, how the survey
finds it, and what fixes it. Each class was found on `vegetables_mice`: Vegetables HQ, a tabletop,
built for a 0.05 m player. Its 2.55M splats are very translucent, with a median opacity of 0.14.
Its numbers are given where they were measured, and the filters themselves are in
[filters.md](filters.md).

| Class | A player sees | Found by | Fix |
|---|---|---|---|
| Show-through | haze, blobs, curtains on a surface | the survey's `box` panoramas | the box filter |
| Spikes and plumes | smoke and streaks fanning off corners | the survey's `cluster` panoramas | the cluster filter |
| Free-air fog | haze in the air a player moves through | the survey's `floaters` panoramas | the floater filter |
| Ribbons | streaks standing off a curved silhouette | looking, then `attribute.py` | a length cap, confined to a region |
| View-dependent colour | a patch whose colour shifts with the eye | the survey's `harmonics` panoramas | none measured |
| Magnification blur | soft blobs close up, the detail gone | looking | none: report it |

## Show-through

**Seen:** a haze over a surface, a coloured blob on it, a pale curtain along its edge. They move
against the surface as the eye moves, a parallax double image.

**Drawn by** splats outside the map's box: under the floor, behind a wall, past a cloth's edge,
seen through a translucent surface. The bake's `--box` crops only what it voxelises, so the drawn
splat keeps all of them.

**Measured:** 531k splats (21%), with 30% of the drawn area, nearly all under the tea towel or past
its edge. The crop cleared the blue haze over the board's base, the lavender blob on the towel and
the white curtains along it. The towel's edge then ends in a clean cut.

## Spikes and plumes

**Seen:** plumes and streaks like smoke off a surface's corners and edges. They fan out and fold
away as the eye moves.

**Drawn by** a few giant Gaussians, many voxels long and faint: 8.8k splats (0.35%), their
longest axis 9.3 units at the median and 24 at the 90th percentile, carrying 30% of the drawn area.

**Measured:** the cluster filter took most of the plumes. What it left became small fans.

## Free-air fog

**Seen:** a haze in the open air the player moves through, or smoke just off a surface.

**Drawn by** faint splats with no dense surface near them.

**Measured:** on its own the floater filter changed nothing visible: at its defaults (6k splats) or
at `0.05,0.3,0.02` (38k). At `0.05,0.5,0.1`, run after the cluster filter, it removed an orange
plume at the board's corner.

## Ribbons

**Seen:** thin streaks, darker or brighter than the surface, standing off a curved silhouette, as
on the top of the dark cucumber.

**Drawn by** opaque, flat, long splats lying along the curve, 9 to 24 units long, whose ends stick
out past it. The opacity, floater and cluster filters keep them, since they are dense and on the
surface. `attribute.py` finds them on a patch just above the silhouette. The splats that carry the
patch are opaque (opacity 1.0 at the median), flat (no third axis) and long (19 by 4 units), and
drawn alone they are the streaks.

**Measured:** a cap on every axis (`--filter-value scale_N,lt,0.4`) clears them. Across the whole
map it blotches the board and the towel, whose smooth faces are made of the same long splats.
Confined to what lies above the board's top, z 52, it leaves those alone. The cucumber's top then
shows more speckle from above, and a pale stripe. That map is the test stem `vegmice_cap`. It has
been built and delivered, and is still to be judged.

## View-dependent colour

**Seen:** a patch whose colour shifts as the eye moves past it: a sheen, or a tint that comes and
goes.

**Drawn by** the view-dependent bands, `f_rest`.

**Measured:** `--filter-harmonics 0` and `1` made no visible difference on `vegetables_mice`. List
such a finding in the residual unless its own try shows a change.

## Magnification blur

**Seen:** close to a surface, it softens into blobs, and detail is gone.

**Drawn by** the capture's own splat spacing, magnified by the map's scale
([conventions](../../../../splat-maps/docs/conventions.md), "Capture resolution bounds the usable
scale factor").

**Fix:** none downstream. A denser capture fixes it, or a map at a smaller magnification. List it
in the residual.
