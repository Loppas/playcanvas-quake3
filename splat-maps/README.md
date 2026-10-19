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

Set up the environment once, as [training.md](docs/training.md#the-environment) does: the conda
environment `gsplat`, with this package's `splat-maps` command in it. Node, as the port requires
it ([Requirements](../README.md#requirements)), runs splat-transform, which the stages install
with npm when it is missing. Then, in each shell, from `splat-maps/`:

```bash
conda activate gsplat
```

### A first map, from the garage

The port's `garage_cats`, from the capture it was made of, with no training. It is delivered into
the port's `public/maps/`, so set the port up as [its quick start](../README.md#run-from-source)
does, without downloading `map-garage_cats.pk3`.

1. Download the capture, ["Garage - High Detail Test"](https://superspl.at/scene/8f4d8e05), from
   its page on superspl.at, as `data/garage/garage.sog`.
2. Align it at life size ([the examples' README](examples/README.md#the-aligned-garage)):

   ```bash
   splat-maps polish data/garage/garage.sog data/garage/garage-aligned.sog 3.0 --up-hint "0,-1,0"
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

4. Build the map there, and deliver it, the same on both:

   ```bash
   splat-maps polish data/garage/garage-aligned.sog data/garage_cats/map/garage_cats.sog 3.0 --player-height 0.5
   splat-maps bake data/garage_cats/map/garage_cats.sog
   splat-maps levelshot data/garage_cats/map/garage_cats.sog
   splat-maps arena data/garage_cats/map/garage_cats.arena --ent data/garage_cats/map/garage_cats.ent --type "ffa tourney team clanarena" --bots "mynx orbb bitterman"
   splat-maps package data/garage_cats/map/garage_cats.sog --author "<your name>"
   splat-maps deliver data/garage_cats/map/map-garage_cats.pk3
   ```

5. From the port's folder, run `npm run dev`, and open the address it prints with
   `?map=garage_cats` on the end.

Each step checks what it wrote and stops on an error. [maps.md](docs/maps.md) says what each one
prints.

### Your own video

Training also needs gsplat's checkout, once a shell:

**Windows (cmd)**

```bat
set SPLAT_GSPLAT=C:\src\gsplat
```

**Linux (bash)**

```bash
export SPLAT_GSPLAT=~/src/gsplat
```

Then a video to a map in the game, in one run, the same on both:

```bash
splat-maps all "/path/to/video.mov" myroom 2.4 --box=-128,-128,-32,128,128,96 --license "Title: My Room; Author: Your Name; Source: <link>; License URL: https://creativecommons.org/licenses/by/4.0/" --author "Your Name"
```

[training.md](docs/training.md#quick-start) explains its arguments, and runs the training stages
one at a time. [maps.md](docs/maps.md) runs the map's steps one at a time. `all`'s map has starter
entities, one spawn and the intermission, to replace as [Placing entities](#placing-entities)
does.

### Cleaning a capture

A capture holds more than the space: floaters, stray splats past the walls, and clutter. Cleaning
them out is done by hand, by trial and error, mostly in [SuperSplat](https://superspl.at/editor).
Nothing here does it: the polish only levels, squares and scales, and the bake's `--box` bounds
what is voxelised, not what is drawn.

The garage needed no cleaning ([the examples' README](examples/README.md#the-aligned-garage)). A
crop to a box can be made with splat-transform's `-B x,y,z,X,Y,Z` (`--filter-box`), with two
catches:

- its corners are in the file's own frame: for a polished splat, metres with Y up and the floor
  at 0, not the Q3 units of the bake's `--box`;
- its output carries no `license.txt`, so the polish after it needs the capture's credit through
  `--license` ([maps.md](docs/maps.md#1-check-the-source-carries-its-licence)).

## Placing entities

A map's entities, where players spawn and where the intermission camera stands, are Quake 3's own
entity text, `<stem>.ent`. Step 4 of [maps.md](docs/maps.md#4-place-the-entities) gives two
routes:

- **In [NetRadiant-custom](https://github.com/Garux/netradiant-custom), recommended.** The bake's
  collision mesh opens in the editor as a model, and the entities go on it as on any Quake 3 map.
  It needs only the bake, so it can place a new map's first spawn. It runs on Windows; its Linux
  AppImage is untried, and there is no macOS build.
- **From `viewpos` readings.** Fly the map in the port, and paste what `viewpos` prints. The port
  loads a map only with a spawn spot in it, so a new map needs one first.

A splat map has no place for brush entities, such as doors, platforms, jump pads and teleporters,
for water and the other contents, or for fog and sky
([map-format.md §3.3](docs/map-format.md#33-what-a-splat-map-cannot-carry)).

### In the editor, on `garage_cats`

After the quick start, with the editor set up as [maps.md](docs/maps.md#once-per-machine) does,
from `splat-maps/`:

1. Make the collision mesh the editor's reference model:

   ```bash
   splat-maps entities reference data/garage_cats/map/garage_cats.collision.glb --out data/editor/baseq3/models/splatmaps/garage_cats_collision.obj
   ```

2. Copy the entities to the editor as a map, since an `.ent` is a `.map` with no brushes:

   **Windows (cmd)**

   ```bat
   copy data\garage_cats\map\garage_cats.ent data\editor\baseq3\maps\garage_cats.map
   ```

   **Linux/macOS (bash)**

   ```bash
   cp data/garage_cats/map/garage_cats.ent data/editor/baseq3/maps/garage_cats.map
   ```

3. Start the editor as maps.md's step 4a does, with the map's path on the end, and add the
   reference model: a `misc_model` with `"model" "models/splatmaps/garage_cats_collision.obj"` at
   `"origin" "0 0 0"`. The entities stand inside the mesh.
4. Move a spawn spot, or add one from a 2D view's right-click menu, under `info`. Its box should
   rest on the floor.
5. Save, and turn the map back into the `.ent`, without the reference model:

   ```bash
   splat-maps entities from-map data/editor/baseq3/maps/garage_cats.map data/garage_cats/map/garage_cats.ent
   ```

6. Run the quick start's step 4 again from `bake` on. The bake checks every spawn spot.

## Settings

The CLI finds its tools through these environment variables, set in the prompt or once as a
user's own. Node and splat-transform come from `PATH`.

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
`garage_rats`: their hand-placed entities, arena blocks and levelshots, and what the polish and the
bake recorded. Each map's README rebuilds the rest: the splat, the octree and the mesh. The maps
are on [their release](https://github.com/Loppas/playcanvas-quake3/releases/tag/splat-maps-v0.1.0):
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
├── examples/                two maps' parts, and the aligned garage's record
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
