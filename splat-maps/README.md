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
from a video: `uv run splat-maps --help` lists them. The Windows batch files are wrappers over
it. The training half needs an NVIDIA GPU with CUDA. Every stage has been run on Windows 11;
macOS and Linux are untried.

## The docs

| Doc | What it covers |
|---|---|
| [capture.md](docs/capture.md) | Filming or photographing a space so it trains well: video, photos, macro, hard interiors |
| [training.md](docs/training.md) | Capture to a trained SOG: the environment, frames, COLMAP, gsplat, and the polish's place |
| [maps.md](docs/maps.md) | A SOG to a map in the game: polish, bake, entities, levelshot, arena, package, deliver |
| [map-format.md](docs/map-format.md) | The spec of a splat map: what the pk3 holds, the frames, the bake's sizes, the lint's rules |
| [conventions.md](docs/conventions.md) | Lessons the pipeline has paid for: verification, calibrating splat-transform, fitting planes, scale |

## Quick start (Windows)

Install the prerequisites in [training.md](docs/training.md#the-environment), then run from
`splat-maps\`:

```bat
:: once
scripts\windows\setup-env.bat

:: once a command prompt: the settings, and the package on PYTHONPATH
call scripts\windows\settings.bat

:: a video to a map in the game, in one run
"%SPLAT_PYTHON%" -m splat_maps all "C:\path\to\video.mov" myroom 2.4 --box=-128,-128,-32,128,128,96 --license "Title: My Room; Author: Your Name; Source: <link>; License URL: https://creativecommons.org/licenses/by/4.0/" --author "Your Name"
```

`2.4` is the room's floor-to-ceiling height in metres, `--box` the map's corners in Q3 units
(32 to the metre, about the plan's centre, the floor at 0), which cut the stray splats a trained
capture holds, and `--license` the capture's credit. A capture outdoors adds `--outdoor`
([training.md](docs/training.md), "Quick start"). `all`'s map has starter entities: one spawn over the floor and the intermission above it.
[maps.md](docs/maps.md) walks each step from step 1, checking each one's output before the next:
the polish, a first bake from a seed, the entities, the bake again from the spawn, the levelshot,
the arena block, the package and the delivery into the port's `public\maps\`. Its step 4 places
the real entities. [training.md](docs/training.md) runs the training stages one at a time.

## Settings

The scripts find their tools through `scripts\windows\settings.bat`. Each setting has a default,
and a value already in the environment wins. The CLI reads `SPLAT_FFMPEG`, `SPLAT_COLMAP` and
`SPLAT_GSPLAT` itself, so they serve it outside the wrappers too. A machine's own paths go in
`scripts\windows\settings.local.bat`, which git ignores:

```bat
@echo off
set "SPLAT_COLMAP=C:\Tools\colmap\bin\colmap.exe"
set "SPLAT_FFMPEG=C:\Tools\ffmpeg\bin\ffmpeg.exe"
```

| Setting | Default | What it is |
|---|---|---|
| `SPLAT_PYTHON` | `%USERPROFILE%\miniconda3\envs\gsplat\python.exe` | The Python every script runs on: the conda env `setup-env.bat` makes |
| `SPLAT_GSPLAT` | `gsplat\` beside this checkout | gsplat's clone, which `setup-env.bat` makes and builds and `train` runs |
| `SPLAT_COLMAP` | `colmap`, from `PATH` | COLMAP 4.1.1's `colmap.exe` |
| `SPLAT_FFMPEG` | `ffmpeg`, from `PATH` | ffmpeg |
| `SPLAT_VCVARS` | Visual Studio 2022 Community's `vcvars64.bat` | The compiler environment gsplat is built in |
| `SPLAT_NODE` | none: Node from `PATH` | A folder put first on `PATH`, for Node 24 and splat-transform |
| `TORCH_CUDA_ARCH_LIST` | none: the GPUs in this machine | Torch's own: the GPU architectures gsplat is built for, e.g. `8.9` |

## The example

[`examples/garage_cats/`](examples/garage_cats/) holds the parts of `garage_cats`, one of the
port's maps, as the map steps wrote them: its hand-placed entities, its arena block, its bake and
its levelshot, with what the polish and the bake recorded. The splat itself is left out, at 178 MB,
and its README rebuilds the map from the capture it was made from.

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
├── scripts/windows/         the batch wrappers and settings.bat, which run the package
├── src/splat_maps/          the stages' Python, one package, and its CLI
│   └── templates/readme.txt the readme packed into each map
├── tests/                   pytest for the stages that need no GPU, on a map they build
├── pyproject.toml, uv.lock  the package and its locked environment, which the tests run in
├── examples/garage_cats/    a map's parts, from polish to package
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
