# garage_rats

The parts of `garage_rats`, the garage at a 0.1 m player, as [maps.md](../../docs/maps.md)'s steps
wrote them. Its pk3 packs them with the polished splat, the collision octree and mesh, and a
readme. Those three are left out here, the splat at 175 MB, and the steps below make them again.

| File | Written by | What it is |
|---|---|---|
| `garage_rats.ent` | a person, from `viewpos` readings | The entities: worldspawn, nine spawn spots, the intermission point and what it faces. Each comment gives the reading the entity came from |
| `garage_rats.polish.json` | `splat-maps polish` | What the polish did, measured again: its arguments as `_pcq_polish`, the transform, the verify, and the source's licence |
| `garage_rats.bake.json` | `splat-maps bake` | The bake's flags as `_pcq_bake`, the fill it searched for, and each spawn spot measured |
| `garage_rats.tga` | `splat-maps levelshot` | The levelshot, 128 × 128, as Q3's `levelshot` command makes one |
| `garage_rats.levelshot.png` | `splat-maps levelshot` | The full frame the levelshot is sampled from |
| `garage_rats.arena` | `splat-maps arena` | The arena block: the map's name, its long name, its modes and its bots |

## Rebuilding it

Make `data/garage/garage-aligned.sog` as
[the splat-maps quick start](../../README.md#a-first-map-from-the-garage)'s steps 1 and 2 do. Then,
from `splat-maps/`, with `nvm use 24` run once, copy its entities into the map's folder:

**Windows (cmd)**

```bat
mkdir data\garage_rats\map
copy examples\garage_rats\garage_rats.ent data\garage_rats\map\
```

**Linux/macOS (bash)**

```bash
mkdir -p data/garage_rats/map
cp examples/garage_rats/garage_rats.ent data/garage_rats/map/
```

Then build it there, the same on both:

```bash
uv run splat-maps polish data/garage/garage-aligned.sog data/garage_rats/map/garage_rats.sog 3.0 --player-height 0.1
uv run splat-maps bake data/garage_rats/map/garage_rats.sog
uv run splat-maps levelshot data/garage_rats/map/garage_rats.sog
uv run splat-maps arena data/garage_rats/map/garage_rats.arena --ent data/garage_rats/map/garage_rats.ent --type "ffa tourney team clanarena" --bots "ranger phobos sarge"
uv run splat-maps package data/garage_rats/map/garage_rats.sog --author "<your name>"
uv run splat-maps deliver data/garage_rats/map/map-garage_rats.pk3
```

The bake seeds from the `.ent`'s first spawn spot. The arena and the polish's record come out as
they are here, byte for byte, and the bake's record differs only in its timings and peak memory. The
octree and the mesh come out as [the map's pk3](https://github.com/Loppas/playcanvas-quake3/releases/download/splat-maps-v0.1.0/map-garage_rats.pk3)
has them, in `maps/`. Each polish encodes the splat's
spherical harmonics afresh, so about one in eight of the levelshot's pixels may differ, by a level
or two.

The bake and the lint warn that the crouched player's box can get under the floor, through holes
in the capture. The lint passes with that warning.

## Credit

`garage_rats` is adapted from ["Garage - High Detail Test"](https://superspl.at/scene/8f4d8e05)
by [Ethan](https://superspl.at/user?id=ethan3111), licensed
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Changes: levelled, rescaled, voxel
collision baked, and Quake 3 entities added. The files here are made from it, and are under the
same licence.
