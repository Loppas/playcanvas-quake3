# Filters

splat-transform 3.1.6's filters, as its own TypeScript implements them (`dist/cli.mjs.map`
carries the source in `sourcesContent`), and what they did on real maps. Each is an action, and
it applies to the input it follows. Positions are in the octree's frame, which is how
splat-transform reads them. Sizes are in the file's metres, and the polished file's metres are the
game's: 1 m is 32 units.

## The standard set

`census.py` runs these on every map, sized from the bake's record, and marks what each removes.

| Filter | Actions | On `vegetables_mice`, 2.55M splats |
|---|---|---|
| `box` | `--filter-box`, the bake's `--box` turned by `bake_map.filter_box` | 531k (21%), 30% of the drawn area |
| `cluster` | `--seed-pos` the bake's seed, `--filter-cluster <voxel>,0.5,0.1` | 8.8k (0.35%), 30% of the drawn area |
| `floaters` | `--filter-floaters 0.05,0.5,0.1` | 114k (4.5%), 14% of the drawn area |

The bake runs `cluster` and `box` itself, at these sizes, with `--cluster` and `--crop`
([maps.md](../../../../splat-maps/docs/maps.md), step 3).

The delivered `vegetables_mice` ran the cluster filter, then the floater filter, then the box. It
kept 1,930,592 splats, and its pk3 is a quarter smaller. `build_splat.py` with `box`, `cluster`
and the floater filter tried `--after cluster` makes the same splat, position for position.

## Each filter

- **`--filter-box x,y,z,X,Y,Z`** keeps the splats centred inside the box. The bake's own crop
  takes the same box in the same frame, so the drawn splat and the collision then agree on it.
- **`--filter-cluster res,op,min`**, with `--seed-pos` (default 1.0,0.999,0.1), voxelises at
  `res`, solid where the Beer-Lambert opacity reaches `op`, and keeps the 6-connected solid
  component nearest the seed. Its **spike rule** takes the plumes: a splat whose box spans more
  than two voxels survives only if it reaches `min` in a tenth of them.
  - It is fragile on a translucent capture. At `op` 0.999, or on a 0.15 or 0.1 m grid, the flood
    stopped at the seed's own island and kept about 10k of 2.55M splats. Read its `cluster is N of
    M blocks` line and its removed count before trusting a run.
  - Run it before the box, since the box changes the grid it builds.
- **`--filter-floaters size,op,min`** (default 0.05,0.1,0.004) voxelises at `size` and keeps a
  splat whose centre lies in a solid voxel, or whose density reaches `min` at one. Only isolated
  splats in free space go.
- **`--filter-value name,cmp,value`** keeps the rows where the comparison holds. Opacity and
  `scale_N` compare in linear units. Several are ANDed, so no one run removes "faint *and* big". It
  takes any column, the census's `c_` columns among them.
  - **A length cap** is one on each axis: `--filter-value scale_0,lt,L`, and likewise `scale_1` and
    `scale_2`, with `L` in metres.
  - **A cut on scale alone breaks surfaces.** Below 0.15 m on every axis it took the plumes and
    broke the board and the towel into holes, since big splats are their smooth faces too.
  - **Opacity alone did nothing visible.** At 0.05 it removed 159k tiny, faint splats.
- **`--filter-harmonics 0-3`** drops the view-dependent bands above the one given.
- **`--decimate n|n%`** merges splats, and is a frame-rate lever, not a clean-up. It must be the
  last action and must write a `.ply`; a second run turns that into a `.sog`. At 50%, the St.
  Maurice church (9.98M splats) kept its look, a mean difference near 3 of 255, softer only at 2×
  zoom, and its frame rate rose 47%: from 187 to 275 fps still, and 169 to 247 turning.
- Also `--filter-sphere`, `--filter-nan` and `--tag-lod`, none of them tried on a map.

## What a filter step must keep

- **The credit.** `splat-transform -w` drops a SOG's `license.txt`, which the package needs.
  `build_splat.py` puts it back, stored, as the polish does
  ([conventions](../../../../splat-maps/docs/conventions.md), "Polish runs measure → apply →
  verify → record").
- **The rows.** A filter writing a PLY keeps the surviving rows in order, and every column, the
  `row` and `c_` columns included. The work's splat relies on that. A SOG re-encode does not keep
  the order ([conventions](../../../../splat-maps/docs/conventions.md), "A re-encode does not
  preserve splat order").
- **The collision.** Bake the filtered splat, since it is the file that ships
  ([conventions](../../../../splat-maps/docs/conventions.md), "Bake the file that ships"). Fog dense
  enough to bake solid comes out as open space once it is gone: `vegetables_mice`'s rebake opened
  159 voxels.
- **The record.** A bake that filters records its actions as `_pcq_filter`, and the readme names
  them. A filter tried outside the bake, as `build_splat.py` tries one, is recorded nowhere, so say
  which filters built a test map wherever it is described.
