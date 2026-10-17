# Training — Photos/Video → Gaussian Splat (gsplat-direct)

Turn a video (or photos) of a real space into a trained Gaussian splat and a web-ready SOG,
fully local and open-source. Trainer is **gsplat's own `simple_trainer.py mcmc`** (no
nerfstudio). Validated end to end on Windows 11 with an NVIDIA GPU and CUDA 12.8.

```
capture ──▶ frames (ffmpeg) ──▶ COLMAP SfM ──▶ gsplat MCMC train ──▶ PLY
                                                                      │
                                          SOG + HTML viewer ◀── splat-transform
                     (then the polish, which starts a map: maps.md)
```

> **Platform:** the validated path is **Windows** — see the [Windows section](#windows)
> for the environment, exact commands, and the OS-specific gotchas that will bite otherwise
> (they are all handled by the scripts under `scripts/windows/`). macOS/Linux are not yet
> validated.

---

## Quick start (Windows)

One-time environment setup, then three commands per scene, run from `splat-maps\`:

```bat
:: one-time (see Windows §Prerequisites first)
scripts\windows\setup-env.bat

:: per scene  (project name is any label; data lands in data\<project>\)
scripts\windows\process.bat  "C:\path\to\video.mov"  myscene  1.5
scripts\windows\train.bat    myscene
nvm use 24 && scripts\windows\deliver.bat  myscene
```

Outputs land in `data\<project>\results\mcmc\`: `ply\point_cloud_*.ply`,
`<project>.sog` (ship this), `<project>_viewer.html` (open in a browser to fly around).

**Frame count matters.** `process.bat`'s 3rd arg is fps of extraction. ~150–300 frames is a
good room-scale target: pick `fps ≈ frames / clip_seconds`. Bigger spaces need more — e.g. a
large kitchen over 2–3 min → `fps 2.0`+ for 300–400 frames.

---

<a id="windows"></a>
## Windows — environment, commands, and gotchas

Everything in this section is Windows-specific. The scripts encapsulate it; this documents
what they do and why, so it is debuggable.

### Prerequisites (install once, manually)

| Tool | Version / notes |
|---|---|
| **Miniconda** | for the `gsplat` Python env |
| **Visual Studio 2022 Community** | with the **C++ (Desktop)** workload — provides **MSVC 14.44**. ⚠️ NOT VS "18"/BuildTools 2026 (MSVC 14.51) — its `cudafe++` crashes with CUDA 12.8. |
| **CUDA Toolkit 12.8** | must match torch cu128. (A separate CUDA 13.x may coexist; the build uses 12.8's `nvcc`.) |
| **COLMAP 4.1.1 (CUDA)** | official binary from github.com/colmap/colmap releases. conda-forge's COLMAP is DLL-broken on Windows. |
| **ffmpeg** | e.g. `conda create -n colmap -c conda-forge ffmpeg` (the same env can hold ffmpeg). |
| **Node ≥ 24** | via nvm-windows (`nvm install 24` / `nvm use 24`) — for splat-transform. |
| **git** | to clone gsplat. |

Where the scripts find these is set in `scripts\windows\settings.bat`, each with a default:
see the [README's Settings](../README.md#settings).

### What `setup-env.bat` builds (the validated stack)

| Component | Pin | Why this exact pin |
|---|---|---|
| Python | 3.11 | conda env `gsplat` |
| torch / torchvision | **2.8.0+cu128 / 0.23.0** | torch **2.9.x breaks** `fused_ssim` (`compiled_autograd.h C2872 'std' ambiguous`) |
| gsplat | **v1.5.3** (source-built) | **main HEAD is Windows-broken** (`std::isfinite` in device code) |
| fused_ssim | built from source | required by `simple_trainer.py` |
| fused_bilagrid | **skipped** | narrowing-conversion build error; use `--use-bilateral-grid` (pure-python `lib_bilagrid`) |
| MSVC / CUDA | 14.44 / 12.8 | see prerequisites |

No prebuilt gsplat wheel exists for this torch/cuda on Windows, so it is source-built inside
`vcvars64.bat` with `--no-build-isolation`. Its CUDA code is built for the GPUs in the machine,
as torch's extension builder does when `TORCH_CUDA_ARCH_LIST` is unset; set it to build for
others, e.g. `8.9` (torch's `torch/utils/cpp_extension.py`, `CUDAExtension`).

### The pycolmap patch (automatic, via `patch_pycolmap.py`)

gsplat's bundled pycolmap (rmbrualla fork) is broken on Windows+Py3. `setup-env.bat` runs
`patch_pycolmap.py`, which idempotently fixes:
- `scene_manager.py`: uint64 count reads use native `'L'` (4 bytes on Windows) → `'Q'`; camera
  header `'IiLL'` → `'<IiQQ'`.
- `camera.py`: `params` is a Py3 `map()` (not subscriptable) → coerced to `list`.

### COLMAP 4.1.1 gotchas (handled by `process.bat`)

- Options were **renamed**: `--FeatureExtraction.use_gpu` / `--FeatureMatching.use_gpu`
  (the old `SiftExtraction`/`SiftMatching.use_gpu` no longer parse; GPU is on by default).
- The mapper can emit **several sub-models** (`sparse/0`, `sparse/1`, …) and the largest is
  **not always `sparse/0`**. `promote_largest_model.py` picks the one with the most registered
  images and promotes it to `sparse/0`; then `model_converter --output_type BIN` normalizes it.

---

## Stage detail

### 1. Capture
See [capture.md](capture.md) (video + photo, and a macro/focus-stack section). Three rules: lock
exposure/focus/WB, shoot the floor with downward passes, close the loop. Measure the room's
floor-to-ceiling height: the polish scales the map by it.

### 2. Process (`process.bat <video> <project> [fps] [width]`)
ffmpeg extracts frames (fps × width) → COLMAP feature-extract (OPENCV camera, single-camera) →
sequential match → map → promote largest model → normalize to BIN. Sanity signal: most frames
should register (COLMAP `model_analyzer` prints "Registered images"). Texture-poor indoor
scenes may register poorly — capture more overlap / more frames.

### 3. Train (`train.bat <project> [cap_max] [max_steps]`)
`simple_trainer.py mcmc` with `--data-factor 1 --antialiased --save-ply --disable-viewer`.
`cap_max` (default 1,000,000) is the quality↔size/VRAM lever; `max_steps` default 30,000
(~15–25 min on the GPU it was validated on). Add `--use-bilateral-grid` in `train.bat` for
scenes with exposure drift. Metrics land in `results/mcmc/stats/`.

### 4. Deliver (`deliver.bat <project>` — needs `nvm use 24`)
splat-transform converts the highest-step PLY → `<project>.sog` (web delivery, ~15–24× smaller)
and `<project>_viewer.html` (standalone interactive viewer). For very large scenes, output
`lod-meta.json` for streamed SOG instead (see splat-transform docs).

---

<a id="polish"></a>
## Polish — metric scale, level, and cleanup

The raw trained splat has **arbitrary scale**, a tilt and a yaw, and edge **floaters**. Before
using it in a game or for collision:

1. **Clean, by eye, if it needs it.** In SuperSplat (https://superspl.at/editor), sphere/box-select
   the keep-volume → Invert → Delete, and remove floaters in Rings mode. Deciding what is clutter
   and what is the room is a judgement no script makes. Export the `.sog`.
2. **Polish, by script.** `polish.bat` levels the floor, squares the walls to the axes, scales to
   metres from the room's floor-to-ceiling height and moves the floor to y = 0, then measures its
   own output and fails unless it is level ([maps.md](maps.md), step 2). It is the first step of a
   map.

Do the polish **before** any collision bake — voxel sizes and physics are all in metres.
