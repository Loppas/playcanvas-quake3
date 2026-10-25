# Building splat maps: lessons the docs don't hold yet

What building the garage, vegetables and church maps taught, beyond what
[maps.md](../../../../splat-maps/docs/maps.md) and
[conventions.md](../../../../splat-maps/docs/conventions.md) already say. Read those first. A
test stem goes through their steps, and these are what tripped those steps up.

## Naming and licence

- **Read the capture's `license.txt` before building.** An NC or ND capture can be built for local
  play, but never shipped. A shell build packs every `public/maps/*.pk3` (`electron-builder.config.mjs`),
  so a build shared with anyone must leave such maps out. A test stem from such a capture is local
  only too.

## Polish and scale

- **A vaulted room has no flat ceiling to fit.** The indoor fit locks onto a cornice, and the verify
  can lock onto another. Polish it `--outdoor`, whose reference is the solid splats' 99th-percentile
  top, and give the height that keeps the scale.
- **Put a spawn on the highest place a player can stand.** The bake and a live check then prove
  the headroom maps.md asks for.

## The bake

- **Magnification turns stray splats into blobs.** At 1× a stray makes one voxel, which the bake
  clears. At 3.5× it spans several, and the exterior fill, scaled with the map, leaves open
  pockets outside the walls. The bake's own reach, any amount of jumping, then runs to the grid's
  edges with no `LEAK`, and blobs in the open air become places to stand. So judge containment by
  walking and jumping alone. `reach.py`'s patches go wherever the open space does, and on the
  church at 3.5× they ran into the pockets. The ground under a patch can't tell inside from out
  there, since the pockets stand on the reconstruction spill, not the fill. A box floor just under the floor, `z0 = -16`, crops the floor's reflection splats and most
  positions under it.
- **A low seed among furniture can fool the fill search.** A small fill floods the room but traps a
  pocket round the seed, reads as sealed, and the carve then finds the seed walled in. Bake with a
  high seed to find the fill, and give that as `--fill`.
- **A rebuild repeats the bake's own flags**, from `<stem>.bake.json`: `--box=` its `box_sim`,
  `--voxel` its `voxel_units`, and `--fill` its `fill_units`, or `--outdoor` where that is null.
  With no `--seed`, the bake seeds from the `.ent`'s first spawn.

## Running the pipeline

- **The env's `splat-maps` runs one checkout's code**, the one `pip install -e` named. To run
  another, a worktree on `main` say, set `PYTHONPATH=<it>/splat-maps/src`, run
  `python -m splat_maps <step>`, and deliver with `--port <the checkout that serves the maps>`.
- **Run heavy steps one at a time.** splat-transform's renders and filters share the GPU, and two at
  once slow each other and blur any timing.
