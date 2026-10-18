# garage_cats

The parts of `garage_cats`, the garage at a 0.5 m player, as [maps.md](../../docs/maps.md)'s steps
wrote them. Its pk3 packs the octree, the mesh, the entities, the levelshot and the arena block
with the polished splat and a readme. The splat is left out here: it is 178 MB, and the steps
below make it again from the capture.

| File | Written by | What it is |
|---|---|---|
| `garage_cats.ent` | a person, from `viewpos` readings | The entities: worldspawn, four spawn spots, the intermission point and what it faces. Each comment gives the reading the entity came from |
| `garage_cats.polish.json` | `splat-maps polish` | What the polish did, measured again: its arguments as `_pcq_polish`, the transform, the verify, and the source's licence |
| `garage_cats.voxel.json`, `.voxel.bin` | `splat-maps bake` | The collision octree: the header, and the octree itself |
| `garage_cats.collision.glb` | `splat-maps bake` | The octree as a mesh, for looking at and for the map editor |
| `garage_cats.bake.json` | `splat-maps bake` | The bake's flags as `_pcq_bake`, the fill it searched for, and each spawn spot measured |
| `garage_cats.tga` | `splat-maps levelshot` | The levelshot, 128 × 128, as Q3's `levelshot` command makes one |
| `garage_cats.levelshot.png` | `splat-maps levelshot` | The full frame the levelshot is sampled from |
| `garage_cats.arena` | `splat-maps arena` | The arena block: the map's name, its long name, its modes and its bots |

## Rebuilding it

Download the capture, "Garage - High Detail Test", from its page on
[superspl.at](https://superspl.at/scene/8f4d8e05), as `data\garage\garage.sog`. It carries its
licence inside it, which the polish keeps. Then, from `splat-maps\`, with `nvm use 24` run once:

```bat
mkdir data\garage_cats\map
copy examples\garage_cats\garage_cats.ent data\garage_cats\map\
splat-maps polish data\garage\garage.sog data\garage_cats\map\garage_cats.sog 3.0 --player-height 0.5 --up-hint "0,-1,0"
splat-maps bake data\garage_cats\map\garage_cats.sog
splat-maps levelshot data\garage_cats\map\garage_cats.sog
splat-maps arena data\garage_cats\map\garage_cats.arena --ent data\garage_cats\map\garage_cats.ent --type "ffa tourney team clanarena" --bots "mynx orbb bitterman"
splat-maps package data\garage_cats\map\garage_cats.sog --author "<your name>"
splat-maps deliver data\garage_cats\map\map-garage_cats.pk3
```

The garage's capture is upside down in its file, hence `--up-hint`. The bake seeds from the
`.ent`'s first spawn spot. The octree, the mesh, the arena and the polish's record come out as
they are here, byte for byte, and the bake's record differs only in its timings. The splat's
colours are encoded afresh by each polish, so a few of the levelshot's pixels may differ by one
level.

## Credit

`garage_cats` is adapted from ["Garage - High Detail Test"](https://superspl.at/scene/8f4d8e05)
by [Ethan](https://superspl.at/user?id=ethan3111), licensed
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Changes: levelled, rescaled, voxel
collision baked, and Quake 3 entities added. The files here are made from it, and are under the
same licence.
