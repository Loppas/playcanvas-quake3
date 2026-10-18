# Training — Photos/Video → Gaussian Splat (gsplat-direct)

Turn a video (or photos) of a real space into a trained Gaussian splat and a web-ready SOG,
fully local and open-source. Trainer is **gsplat's own `simple_trainer.py mcmc`** (no
nerfstudio). Each stage is a command of the `splat-maps` CLI, and `all` runs them, and the map's
after them, in one go. Validated end to end on Windows 11 with an NVIDIA GPU and CUDA 12.8.

```
capture ──▶ frames (ffmpeg) ──▶ sfm (COLMAP) ──▶ train (gsplat MCMC) ──▶ PLY
                                                                          │
                                       SOG + HTML viewer ◀── export (splat-transform)
                     (then the polish, which starts a map: maps.md)
```

> **Platform:** the validated path is **Windows**: the [environment](#the-environment) below is
> what it ran on, and the [Windows section](#windows) the OS-specific gotchas the stages handle.
> `frames`, `sfm`, `train` and `export` run gsplat, COLMAP and splat-transform on the GPU, and
> none of them has been tried on macOS or Linux.

---

## Quick start (Windows)

Set up the environment once ([below](#the-environment)), then from `splat-maps\`:

```bat
:: once a command prompt: the settings, and the package on PYTHONPATH
call scripts\windows\settings.bat

:: a video to a map in the game, in one run
"%SPLAT_PYTHON%" -m splat_maps all "C:\path\to\video.mov" myroom 2.4 --box=-128,-128,-32,128,128,96 --license "Title: My Room; Author: Your Name; Source: <link>; License URL: https://creativecommons.org/licenses/by/4.0/" --author "Your Name"
```

`all` runs this doc's stages and then [maps.md](maps.md)'s, and delivers `map-myroom.pk3` to
the port. The `2.4` is the room's floor-to-ceiling height in metres, and `--license` the
capture's credit, both the polish's ([maps.md](maps.md), steps 1 and 2). `--box` is the
bake's: the map's corners in Q3 units, 32 to the metre, about the plan's centre with the floor
at 0. A trained capture holds stray splats far past what was filmed, out to kilometres, so the
box is required; make it square in plan and a little larger than the space, since which way the
plan faces is known only after the polish ([maps.md](maps.md), step 3). Write it `--box=…`: a
value starting with a minus is otherwise read as an option. For a capture outdoors, with no
ceiling or hull, add `--outdoor` and give the height of its tallest thing instead
([maps.md](maps.md), steps 2 and 3). Its entities are
starters: one spawn over the most densely captured floor, facing +X, and the intermission above
it. Place the real ones afterwards ([maps.md](maps.md), step 4) and run its steps 5 to 9 again.
It checks its tools and arguments before the frames, and stops at the first stage whose output
fails its checks. It takes the training stages' own options too: `--fps`, `--width` and
`--min-sharpness` for the frames, and `--cap-max` and `--max-steps` for the trainer (stage
detail, below).

Or the training stages one at a time, each on the capture's folder:

```bat
"%SPLAT_PYTHON%" -m splat_maps frames "C:\path\to\video.mov" data\myroom --fps 1.5
"%SPLAT_PYTHON%" -m splat_maps sfm    data\myroom
"%SPLAT_PYTHON%" -m splat_maps train  data\myroom
"%SPLAT_PYTHON%" -m splat_maps export data\myroom
```

The batch wrappers run the same on `data\<project>`: `process.bat <video> <project> [fps]
[width]` is `frames` and `sfm`, `train.bat <project> [cap_max] [max_steps]` is `train`, and
`deliver.bat <project>` is `export`.

Outputs land in `data\<project>\results\mcmc\`: `ply\point_cloud_<step>.ply`,
`<project>.sog` (the polish's input), `<project>_viewer.html` (open in a browser to fly around).

**Frame count matters.** `frames`' `--fps` is the rate of extraction. ~150–300 frames is a
good room-scale target: pick `fps ≈ frames / clip_seconds`. Bigger spaces need more — e.g. a
large kitchen over 2–3 min → `--fps 2.0`+ for 300–400 frames.

---

## The environment

What the stages need, and the versions validated together. On Windows, `setup-env.bat` builds
the Python side; the rest is installed by hand. Elsewhere it is the same list, untried.

| Need | Validated | Why, and what to watch |
|---|---|---|
| **An NVIDIA GPU** | | gsplat's CUDA code is built for the GPUs in the machine unless `TORCH_CUDA_ARCH_LIST` names others, e.g. `8.9` (torch's `torch/utils/cpp_extension.py`, `CUDAExtension`) |
| **CUDA Toolkit** | **12.8** | must match torch's cu128; its `nvcc` builds gsplat. A separate CUDA 13.x may coexist |
| **A C++ compiler CUDA 12.8 accepts** | **MSVC 14.44**: Visual Studio 2022 Community, the C++ (Desktop) workload | ⚠️ NOT VS "18"/Build Tools 2026 (MSVC 14.51): its `cudafe++` crashes with CUDA 12.8. Elsewhere, a GCC that CUDA 12.8 supports |
| **Python** | **3.11**, the conda env `gsplat` (Miniconda) | numpy below 2, Pillow and scipy for the map stages |
| **torch / torchvision** | **2.8.0+cu128 / 0.23.0** | torch **2.9.x breaks** `fused_ssim` (`compiled_autograd.h C2872 'std' ambiguous`) |
| **gsplat** | **v1.5.3**, built from source | **main HEAD is Windows-broken** (`std::isfinite` in device code). No prebuilt wheel exists for this torch and CUDA on Windows |
| gsplat's example dependencies | `scripts/windows/requirements-min.txt` | `fused_ssim` built from source, which `simple_trainer.py` needs; **`fused_bilagrid` skipped**: a narrowing-conversion build error, so `--use-bilateral-grid` takes the pure-Python `lib_bilagrid` |
| **The pycolmap patch** | `python -m splat_maps.patch_pycolmap` | [below](#the-pycolmap-patch-automatic-via-patch_pycolmappy) |
| **COLMAP** | **4.1.1**, the CUDA build | the official binary from github.com/colmap/colmap releases; conda-forge's is DLL-broken on Windows. `sfm` uses 4.1's option names |
| **ffmpeg** | | e.g. `conda create -n colmap -c conda-forge ffmpeg` |
| **Node and splat-transform** | **Node ≥ 24**, splat-transform at the pin | via nvm-windows (`nvm install 24` / `nvm use 24`). `export` and the map stages install the pinned splat-transform with npm when it is missing, and refuse another version |
| **git** | | to clone gsplat |

The steps `setup-env.bat` takes, in a normal command prompt, its paths from `settings.bat`:

```bat
conda create -y -n gsplat python=3.11
python -m pip install torch==2.8.0+cu128 torchvision==0.23.0+cu128 --index-url https://download.pytorch.org/whl/cu128
python -m pip install ninja jaxtyping rich
git clone --recursive https://github.com/nerfstudio-project/gsplat.git ..\..\gsplat
cd ..\..\gsplat && git checkout v1.5.3 && git submodule update --init --recursive
:: in the compiler's environment: vcvars64.bat, DISTUTILS_USE_SDK=1, NVCC_APPEND_FLAGS=-allow-unsupported-compiler
python -m pip install . --no-build-isolation --no-cache-dir
python -m pip install -r <splat-maps>\scripts\windows\requirements-min.txt --no-build-isolation
python -m splat_maps.patch_pycolmap
```

Each `python` is the env's own, and the last needs `splat-maps\src` on `PYTHONPATH`. The CLI
then finds its tools by these settings, each from the environment, which `settings.bat` sets on
Windows ([README](../README.md#settings)):

| Setting | Read by | What it names |
|---|---|---|
| `SPLAT_FFMPEG` | `frames` | ffmpeg; `ffmpeg` on `PATH` if unset |
| `SPLAT_COLMAP` | `sfm` | COLMAP; `colmap` on `PATH` if unset |
| `SPLAT_GSPLAT` | `train` | gsplat's checkout, whose `examples/simple_trainer.py` it runs, in the CLI's own Python |

---

<a id="windows"></a>
## Windows — gotchas

Everything in this section is Windows-specific. The stages and `setup-env.bat` encapsulate it;
this documents what they do and why, so it is debuggable.

### The pycolmap patch (automatic, via `patch_pycolmap.py`)

gsplat's bundled pycolmap (rmbrualla fork) is broken on Windows+Py3. `setup-env.bat` runs
`patch_pycolmap.py`, which idempotently fixes:
- `scene_manager.py`: uint64 count reads use native `'L'` (4 bytes on Windows) → `'Q'`; camera
  header `'IiLL'` → `'<IiQQ'`.
- `camera.py`: `params` is a Py3 `map()` (not subscriptable) → coerced to `list`.

### COLMAP 4.1.1 gotchas (handled by `sfm`)

- Options were **renamed**: `--FeatureExtraction.use_gpu` / `--FeatureMatching.use_gpu`
  (the old `SiftExtraction`/`SiftMatching.use_gpu` no longer parse; GPU is on by default).
- The mapper can emit **several sub-models** (`sparse/0`, `sparse/1`, …) and the largest is
  **not always `sparse/0`**. `sfm` keeps the one with the most registered images as `sparse/0`,
  removes the rest, and `model_converter --output_type BIN` normalizes it.

---

## Stage detail

### 1. Capture
See [capture.md](capture.md) (video + photo, and a macro/focus-stack section). Three rules: lock
exposure/focus/WB, shoot the floor with downward passes, close the loop. Measure the room's
floor-to-ceiling height: the polish scales the map by it.

### 2. Frames and SfM (`frames <video> <dataset> [--fps] [--width] [--min-sharpness]`, then `sfm <dataset>`)
ffmpeg extracts frames (fps × width) into `<dataset>\images\` → the blurred ones set aside in
`images_rejected\` → COLMAP feature-extract (OPENCV camera, single-camera) → sequential match →
map → keep the largest model → normalize to BIN. A frame is blurred when its sharpness, the
variance of the Laplacian, is under `--min-sharpness` (default 0.25) of the capture's median:
motion blur falls to a fifth of it. A run of such frames breaks sequential matching, and
everything filmed after it drops out of the model. `--min-sharpness 0` keeps every frame.
Neither adds to what a run before it left: remove `images\` or `sparse\` to run it again.
Sanity signal: most frames should register (`sfm` prints how many, and warns under half).
Texture-poor indoor scenes may register poorly — capture more overlap / more frames.

### 3. Train (`train <dataset> [--cap-max] [--max-steps]`)
`simple_trainer.py mcmc` with `--data-factor 1 --antialiased --save-ply --disable-viewer`.
`--cap-max` (default 1,000,000) is the quality↔size/VRAM lever; `--max-steps` default 30,000
(~15–25 min on the GPU it was validated on). Any other argument is the trainer's: add
`--use-bilateral-grid` for scenes with exposure drift. Metrics land in `results/mcmc/stats/`.

### 4. Export (`export <dataset> [--name]`)
splat-transform converts the last step's PLY, by its step number → `<project>.sog` (web
delivery, ~15–24× smaller) and `<project>_viewer.html` (standalone interactive viewer). For
very large scenes, output `lod-meta.json` for streamed SOG instead (see splat-transform docs).
A trained splat holds stray splats far past what was filmed, of sky above all, out to
kilometres: the bake's `--box` cuts them, in the polished map's frame ([maps.md](maps.md), step
3).

---

<a id="polish"></a>
## Polish — metric scale, level, and cleanup

The raw trained splat has **arbitrary scale**, a tilt and a yaw, and edge **floaters**. gsplat's
trainer turns the capture so +Z is roughly up (its `examples/datasets/colmap.py` normalises the
world), so polish a splat trained here with `--up-hint 0,0,1`; `all` does. Before using it in a
game or for collision:

1. **Clean, by eye, if it needs it.** In SuperSplat (https://superspl.at/editor), sphere/box-select
   the keep-volume → Invert → Delete, and remove floaters in Rings mode. Deciding what is clutter
   and what is the room is a judgement no script makes. Export the `.sog`.
2. **Polish, by script.** `polish` levels the floor, squares the walls to the axes, scales to
   metres from the room's floor-to-ceiling height and moves the floor to y = 0, then measures its
   own output and fails unless it is level ([maps.md](maps.md), step 2). It is the first step of a
   map. A capture with no ceiling, such as one outdoors, scales from its top instead:
   `--outdoor`.

Do the polish **before** any collision bake — voxel sizes and physics are all in metres.
