# garage_cats

The parts of `garage_cats`, the garage at a 0.5 m player, as [maps.md](../../docs/maps.md)'s steps
wrote them. Its pk3 packs them with the polished splat, the collision octree and mesh, and a
readme. Those three are left out here, the splat at 176 MB, and the steps below make them again.

| File | Written by | What it is |
|---|---|---|
| `garage_cats.ent` | a person, from `viewpos` readings | The entities: worldspawn, four spawn spots, the intermission point and what it faces. Each comment gives the reading the entity came from |
| `garage_cats.polish.json` | `splat-maps polish` | What the polish did, measured again: its arguments as `_pcq_polish`, the transform, the verify, and the source's licence |
| `garage_cats.bake.json` | `splat-maps bake` | The bake's flags as `_pcq_bake`, the fill it searched for, and each spawn spot measured |
| `garage_cats.tga` | `splat-maps levelshot` | The levelshot, 128 × 128, as Q3's `levelshot` command makes one |
| `garage_cats.levelshot.png` | `splat-maps levelshot` | The full frame the levelshot is sampled from |
| `garage_cats.arena` | `splat-maps arena` | The arena block: the map's name, its long name, its modes and its bots |

## Rebuilding it

Make `data\garage\garage-aligned.sog` as [the examples' README](../README.md) has it. Then, from
`splat-maps\`, with `nvm use 24` run once, copy its entities into the map's folder:

**Windows**

```bat
mkdir data\garage_cats\map
copy examples\garage_cats\garage_cats.ent data\garage_cats\map\
```

**Linux/macOS**

```bash
mkdir -p data/garage_cats/map
cp examples/garage_cats/garage_cats.ent data/garage_cats/map/
```

Then build it there, the same on both:

```bash
splat-maps polish data/garage/garage-aligned.sog data/garage_cats/map/garage_cats.sog 3.0 --player-height 0.5
splat-maps bake data/garage_cats/map/garage_cats.sog
splat-maps levelshot data/garage_cats/map/garage_cats.sog
splat-maps arena data/garage_cats/map/garage_cats.arena --ent data/garage_cats/map/garage_cats.ent --type "ffa tourney team clanarena" --bots "mynx orbb bitterman"
splat-maps package data/garage_cats/map/garage_cats.sog --author "<your name>"
splat-maps deliver data/garage_cats/map/map-garage_cats.pk3
```

The bake seeds from the `.ent`'s first spawn spot. The arena and the polish's record come out as
they are here, byte for byte, and the bake's record differs only in its timings and peak memory. The
octree and the mesh come out as the map's pk3 has them, in `maps/`. Each polish encodes the splat's
spherical harmonics afresh, so about one in eight of the levelshot's pixels may differ, by a level
or two.

## Credit

`garage_cats` is adapted from ["Garage - High Detail Test"](https://superspl.at/scene/8f4d8e05)
by [Ethan](https://superspl.at/user?id=ethan3111), licensed
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Changes: levelled, rescaled, voxel
collision baked, and Quake 3 entities added. The files here are made from it, and are under the
same licence.
