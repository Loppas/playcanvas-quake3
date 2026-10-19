# splat-maps

The pipeline that turns a real space into a Quake 3 map the port plays. A video or photos of the
space train a Gaussian splat; the splat is levelled and scaled, a voxel octree is baked from it
for collision, and Quake 3's own entity text, arena block and levelshot go beside them in a pk3.
Everything runs locally, on open-source tools.

```
capture ─▶ frames ─▶ structure from motion ─▶ training ─▶ SOG          (training.md)
  ffmpeg, COLMAP, gsplat, splat-transform
                                                            │
SOG ─▶ polish ─▶ bake ─▶ entities ─▶ levelshot ─▶ arena ─▶ package ─▶ deliver   (maps.md)
  the scripts here, splat-transform, optionally NetRadiant-custom
```

Every stage is a command of one Python package's CLI, `splat-maps`, and `all` runs them in order
from a video: `splat-maps --help` lists them. The training half needs an NVIDIA GPU with CUDA.
Every stage has been run on Windows 11; macOS and Linux are untried.

## The docs

| Doc | What it covers |
|---|---|
| [capture.md](docs/capture.md) | Filming or photographing a space so it trains well: video, photos, macro, hard interiors |
| [training.md](docs/training.md) | Capture to a trained SOG: the environment, frames, COLMAP, gsplat, and the polish's place |
| [maps.md](docs/maps.md) | A SOG to a map in the game: polish, bake, entities, levelshot, arena, package, deliver |
| [map-format.md](docs/map-format.md) | The spec of a splat map: what the pk3 holds, the frames, the bake's sizes, the lint's rules |
| [conventions.md](docs/conventions.md) | Lessons the pipeline has paid for: verification, calibrating splat-transform, fitting planes, scale |

## Quick start

### A first map, from the garage

The port's `garage_cats`, from the capture it was made of. It skips the training, so it needs no
CUDA. It needs:

- [uv](https://docs.astral.sh/uv/), which runs the CLI from this folder as `uv run splat-maps`, in
  the environment the tests run in;
- Node 24, through nvm-windows or nvm, for splat-transform, which the polish installs if it is
  missing;
- a GPU, which splat-transform encodes, bakes and renders on through WebGPU, and is far slower
  without;
- the port, set up as [its quick start](../README.md#run-from-source) has it. The map is
  delivered into its `public/maps/`, so leave out the download of `map-garage_cats.pk3` there, or
  delete it.

From `splat-maps/`, with `nvm use 24` run once:

1. Download the capture, ["Garage - High Detail Test"](https://superspl.at/scene/8f4d8e05), from
   its page on superspl.at, as `data/garage/garage.sog`.
2. Align it at life size, as [the examples' README](examples/README.md#the-aligned-garage)
   explains:

   ```bash
   uv run splat-maps polish data/garage/garage.sog data/garage/garage-aligned.sog 3.0 --up-hint "0,-1,0"
   ```

3. Copy `garage_cats`' entities into its map's folder:

   **Windows (cmd)**

   ```bat
   mkdir data\garage_cats\map
   copy examples\garage_cats\garage_cats.ent data\garage_cats\map\
   ```

   **Linux/macOS (bash)**

   ```bash
   mkdir -p data/garage_cats/map
   cp examples/garage_cats/garage_cats.ent data/garage_cats/map/
   ```

4. Build the map there, and deliver it into the port, the same on both:

   ```bash
   uv run splat-maps polish data/garage/garage-aligned.sog data/garage_cats/map/garage_cats.sog 3.0 --player-height 0.5
   uv run splat-maps bake data/garage_cats/map/garage_cats.sog
   uv run splat-maps levelshot data/garage_cats/map/garage_cats.sog
   uv run splat-maps arena data/garage_cats/map/garage_cats.arena --ent data/garage_cats/map/garage_cats.ent --type "ffa tourney team clanarena" --bots "mynx orbb bitterman"
   uv run splat-maps package data/garage_cats/map/garage_cats.sog --author "<your name>"
   uv run splat-maps deliver data/garage_cats/map/map-garage_cats.pk3
   ```

5. From the port's folder, start its dev server, and open the address it prints with
   `?map=garage_cats` on the end:

   ```bash
   npm run dev
   ```

Each step checks what it wrote and stops on an error: [maps.md](docs/maps.md) says what each one
prints. [`garage_rats`](examples/garage_rats/README.md) is the same garage at a smaller player.

### Your own video

Set up the environment once, as [training.md](docs/training.md#the-environment) does, then run
from `splat-maps\`. Once a shell, the environment and where gsplat is:

**Windows (cmd)**

```bat
conda activate gsplat
set SPLAT_GSPLAT=C:\src\gsplat
```

**Linux (bash)**

```bash
conda activate gsplat
export SPLAT_GSPLAT=~/src/gsplat
```

Then a video to a map in the game, in one run, the same on both:

```bash
splat-maps all "/path/to/video.mov" myroom 2.4 --box=-128,-128,-32,128,128,96 --license "Title: My Room; Author: Your Name; Source: <link>; License URL: https://creativecommons.org/licenses/by/4.0/" --author "Your Name"
```

`2.4` is the room's floor-to-ceiling height in metres, `--box` the map's corners in Q3 units
(32 to the metre, about the plan's centre, the floor at 0), which cut the stray splats a trained
capture holds, and `--license` the capture's credit. A capture outdoors adds `--outdoor`
([training.md](docs/training.md), "Quick start"). `all`'s map has starter entities: one spawn over the floor and the intermission above it.
[maps.md](docs/maps.md) walks each step from step 1, checking each one's output before the next:
the polish, a first bake from a seed, the entities, the bake again from the spawn, the levelshot,
the arena block, the package and the delivery into the port's `public\maps\`. Its step 4 places
the real entities. [training.md](docs/training.md) runs the training stages one at a time.

### Cleaning a capture

A capture holds more than the space: floaters, stray splats past the walls, and clutter a map
may be better without. Cleaning them out is trial and error, mostly by hand in
[SuperSplat](https://superspl.at/editor), and nothing here does it. The polish only levels,
squares and scales a capture, and the bake's `--box` bounds only what is voxelised, not what is
drawn.

The garage needed no cleaning ([the examples' README](examples/README.md#the-aligned-garage)
counts its splats). A capture that needs only a crop to a box can take splat-transform's
`-B x,y,z,X,Y,Z` (`--filter-box`), with two catches:

- its corners are in the file's own frame, which for a polished splat is metres with Y up and the
  floor at 0, not Q3 units as the bake's `--box` takes them;
- what it writes carries no `license.txt`, so the polish after it needs the capture's credit
  through `--license` ([maps.md](docs/maps.md#1-check-the-source-carries-its-licence)).

## Placing entities

A map's entities, where players spawn and what the intermission camera sees, are Quake 3's own
entity text, `<stem>.ent`. Two routes place them, and step 4 of
[maps.md](docs/maps.md#4-place-the-entities) gives each in full:

- **In [NetRadiant-custom](https://github.com/Garux/netradiant-custom), the recommended route.**
  The bake's collision mesh opens in the editor as a model, and the entities go on it as on any
  Quake 3 map, in its 2D and 3D views. It needs only the bake, so it places a new map's first
  spawn too. It runs on Windows; its Linux AppImage is untried here, and it has no macOS build.
- **From `viewpos` readings.** Fly the map in the port, and paste what `viewpos` prints for each
  spot. The port loads a map only with a spawn spot in it, so a new map needs one first.

Neither gives a splat map what it has no place for: brush entities such as doors, platforms, jump
pads and teleporters, water and the other contents, or fog and sky
([map-format.md §3.3](docs/map-format.md#33-what-a-splat-map-cannot-carry)).

### In the editor, on `garage_cats`

The quick start leaves `garage_cats`' bake in `data/garage_cats/map/`. Set the editor up once as
[maps.md](docs/maps.md#once-per-machine) does: NetRadiant-custom in `editor/`, and its engine path
`data/editor/`. Then, from `splat-maps/`:

1. Make the collision mesh the editor's reference model:

   ```bash
   uv run splat-maps entities reference data/garage_cats/map/garage_cats.collision.glb --out data/editor/baseq3/models/splatmaps/garage_cats_collision.obj
   ```

2. Copy the map's entities to the editor as a map: an `.ent` is a `.map` with no brushes.

   **Windows (cmd)**

   ```bat
   copy data\garage_cats\map\garage_cats.ent data\editor\baseq3\maps\garage_cats.map
   ```

   **Linux/macOS (bash)**

   ```bash
   cp data/garage_cats/map/garage_cats.ent data/editor/baseq3/maps/garage_cats.map
   ```

3. Start the editor as maps.md's step 4a does, with the map's path on the end. Add the reference
   model, a `misc_model` with `"model" "models/splatmaps/garage_cats_collision.obj"` at
   `"origin" "0 0 0"`: the four spawn spots, the intermission point and what it faces stand
   inside the garage's mesh.
4. Move a spawn spot, or add one from a 2D view's right-click menu, under `info`. A spot's box
   should rest on the floor.
5. Save, and turn the map back into the `.ent`, which leaves the reference model out:

   ```bash
   uv run splat-maps entities from-map data/editor/baseq3/maps/garage_cats.map data/garage_cats/map/garage_cats.ent
   ```

6. Run the quick start's step 4 again from `bake` on. The bake checks every spawn spot, and says
   which to move.

## Settings

The CLI finds its tools through these environment variables, set in the prompt or once as a
user's own. Node 24, for splat-transform, comes from `PATH`.

| Setting | Read by | Default | What it names |
|---|---|---|---|
| `SPLAT_GSPLAT` | `train` | none, so `train` refuses to start | gsplat's checkout, whose `examples/simple_trainer.py` runs in the CLI's own Python |
| `SPLAT_COLMAP` | `sfm` | `colmap`, from `PATH` | COLMAP 4.1.1's `colmap.exe` |
| `SPLAT_FFMPEG` | `frames` | `ffmpeg`, from `PATH` | ffmpeg |

**Windows (cmd)**

```bat
set SPLAT_COLMAP=C:\Tools\colmap\bin\colmap.exe
set SPLAT_FFMPEG=C:\Tools\ffmpeg\bin\ffmpeg.exe
```

**Linux/macOS (bash)**

```bash
export SPLAT_COLMAP=/opt/colmap/bin/colmap
export SPLAT_FFMPEG=/opt/ffmpeg/bin/ffmpeg
```

## The examples

[`examples/`](examples/) holds the parts of the port's two garage maps, `garage_cats` and
`garage_rats`, as the map steps wrote them: their hand-placed entities, their arena blocks and their
levelshots, with what the polish and the bake recorded. The splats, at about 175 MB each, are left
out with the octrees and the meshes. Each map's README rebuilds its map from the garage aligned at
life size, which [`examples/README.md`](examples/README.md) makes from the capture. The maps
themselves are on [their release](https://github.com/Loppas/playcanvas-quake3/releases/tag/splat-maps-v0.1.0):
[`map-garage_cats.pk3`](https://github.com/Loppas/playcanvas-quake3/releases/download/splat-maps-v0.1.0/map-garage_cats.pk3)
and
[`map-garage_rats.pk3`](https://github.com/Loppas/playcanvas-quake3/releases/download/splat-maps-v0.1.0/map-garage_rats.pk3).

## Tests

The stages are tested with pytest, on a tiny map and capture the tests build: the format's shared
pieces, the polish's measure, the entities, the arena block, the package, the lint and the
delivery. The ones that need a GPU or an outside tool, ffmpeg, COLMAP, gsplat's trainer and
splat-transform, run against stand-ins that record what they were given. Their environment is a [uv](https://docs.astral.sh/uv/) project: `pyproject.toml` and
its lock, `uv.lock`, on the Python in `.python-version`, which uv fetches if it is missing. From
`splat-maps/`:

```bash
uv sync
uv run pytest
```

CI runs them on Linux, macOS and Windows whenever `splat-maps/` changes.

## Layout

```
splat-maps/
├── README.md
├── docs/                    the docs above
├── src/splat_maps/          the stages' Python, one package, and its CLI
│   └── templates/readme.txt the readme packed into each map
├── tests/                   pytest for the stages that need no GPU, on a map they build
├── pyproject.toml, uv.lock  the package and its locked environment, which the tests run in
├── gsplat-requirements.txt  gsplat's example dependencies, for the training environment
├── examples/                two maps' parts, and the garage they start from
├── data/                    per-capture working data and outputs (git-ignored)
└── editor/                  NetRadiant-custom, for placing entities (git-ignored)
```

## Versions

`splat-maps` is released on its own, tagged `splat-maps-v<version>`, from the changes under this
folder. Its version is `pyproject.toml`'s, which `splat-maps --version` prints. The pk3s it makes
carry the layout's own version, `_pcq_format` (`map-format.md` §7), which changes only when the
layout does: a reader of the pk3 goes by that one.

## Licence and credits

`splat-maps/` is part of playcanvas-quake3 and under its licence, the GNU GPL, version 2 or later
([LICENSE](../LICENSE)). Its tokenizer and levelshot translate ioquake3's code
([NOTICE](../NOTICE)). It calls its tools and bundles none; [CREDITS.md](../CREDITS.md) credits
them and the garage capture.
