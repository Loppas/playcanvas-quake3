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

The scripts are Windows batch files over Python. The training half needs an NVIDIA GPU with
CUDA. Every stage has been run on Windows 11; macOS and Linux are untried.

## The docs

| Doc | What it covers |
|---|---|
| [capture.md](docs/capture.md) | Filming or photographing a space so it trains well: video, photos, macro, hard interiors |
| [training.md](docs/training.md) | Capture to a trained SOG: the environment, frames, COLMAP, gsplat, and the polish's place |
| [maps.md](docs/maps.md) | A SOG to a map in the game: polish, bake, entities, levelshot, arena, package, deliver |
| [map-format.md](docs/map-format.md) | The spec of a splat map: what the pk3 holds, the frames, the bake's sizes, the lint's rules |
| [conventions.md](docs/conventions.md) | Lessons the pipeline has paid for: verification, calibrating splat-transform, fitting planes, scale |

## Quick start (Windows)

Install the prerequisites in [training.md](docs/training.md#windows), then run from `splat-maps\`:

```bat
:: once
scripts\windows\setup-env.bat

:: a capture to a trained splat
scripts\windows\process.bat  "C:\path\to\video.mov"  myroom  1.5
scripts\windows\train.bat    myroom
nvm use 24 && scripts\windows\deliver.bat  myroom
```

Then follow [maps.md](docs/maps.md) from step 1, which checks each step's output before the next:
the polish, a first bake from a seed, the entities, the bake again from the spawn, the levelshot,
the arena block, the package and the delivery into the port's `public\maps\`.

## Settings

The scripts find their tools through `scripts\windows\settings.bat`. Each setting has a default,
and a value already in the environment wins. A machine's own paths go in
`scripts\windows\settings.local.bat`, which git ignores:

```bat
@echo off
set "SPLAT_COLMAP=C:\Tools\colmap\bin\colmap.exe"
set "SPLAT_FFMPEG=C:\Tools\ffmpeg\bin\ffmpeg.exe"
```

| Setting | Default | What it is |
|---|---|---|
| `SPLAT_PYTHON` | `%USERPROFILE%\miniconda3\envs\gsplat\python.exe` | The Python every script runs on: the conda env `setup-env.bat` makes |
| `SPLAT_GSPLAT` | `gsplat\` beside this checkout | gsplat's clone, which `setup-env.bat` makes and builds and `train.bat` runs |
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

The stages that need no GPU and no external tool are tested with pytest, on a tiny map the tests
build: the format's shared pieces, the entities, the arena block, the package, the lint and the
delivery. Their environment is a [uv](https://docs.astral.sh/uv/) project: `pyproject.toml` and
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
├── scripts/windows/         the batch wrappers, settings.bat, and the Python they run
│   └── templates/readme.txt the readme packed into each map
├── tests/                   pytest for the stages that need no GPU, on a map they build
├── pyproject.toml, uv.lock  the map half's Python environment, which the tests run in
├── examples/garage_cats/    a map's parts, from polish to package
├── data/                    per-capture working data and outputs (git-ignored)
└── editor/                  NetRadiant-custom, for placing entities (git-ignored)
```

## Licence and credits

`splat-maps/` is part of playcanvas-quake3 and under its licence, the GNU GPL, version 2 or later
([LICENSE](../LICENSE)). Its tokenizer and levelshot translate ioquake3's code
([NOTICE](../NOTICE)). It calls its tools and bundles none; [CREDITS.md](../CREDITS.md) credits
them and the garage capture.
