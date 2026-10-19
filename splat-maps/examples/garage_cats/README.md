# garage_cats

The parts of `garage_cats`, the garage at a 0.5 m player, as [maps.md](../../docs/maps.md)'s steps
wrote them. [Its pk3](https://github.com/Loppas/playcanvas-quake3/releases/download/splat-maps-v0.1.0/map-garage_cats.pk3)
packs them with the polished splat, the collision octree and mesh, and a readme.

| File | Written by | What it is |
|---|---|---|
| `garage_cats.ent` | a person, from `viewpos` readings | The entities: worldspawn, four spawn spots, the intermission point and what it faces. Each comment gives the reading the entity came from |
| `garage_cats.polish.json` | `splat-maps polish` | What the polish did, measured again: its arguments as `_pcq_polish`, the transform, the verify, and the source's licence |
| `garage_cats.bake.json` | `splat-maps bake` | The bake's flags as `_pcq_bake`, the fill it searched for, and each spawn spot measured |
| `garage_cats.tga` | `splat-maps levelshot` | The levelshot, 128 × 128, as Q3's `levelshot` command makes one |
| `garage_cats.levelshot.png` | `splat-maps levelshot` | The full frame the levelshot is sampled from |
| `garage_cats.arena` | `splat-maps arena` | The arena block: the map's name, its long name, its modes and its bots |

## Rebuilding it

[The splat-maps quick start](../../README.md#a-first-map-from-the-garage) rebuilds it, from the
capture to the map in the game. [The examples' README](../README.md#a-rebuild) says what matches
the pk3.

## Credit

`garage_cats` is adapted from ["Garage - High Detail Test"](https://superspl.at/scene/8f4d8e05)
by [Ethan](https://superspl.at/user?id=ethan3111), licensed
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Changes: levelled, rescaled, voxel
collision baked, and Quake 3 entities added. The files here are made from it, and are under the
same licence.
