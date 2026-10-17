@echo off
REM ============================================================================
REM  One-time Windows setup for the gsplat-direct training environment.
REM  Prereqs (docs\training.md, "Windows"): Miniconda, VS 2022 Community (MSVC
REM  14.44, C++ workload), CUDA Toolkit 12.8, git. Run from a normal cmd/PowerShell.
REM  Its paths are settings (settings.bat). gsplat's CUDA code is built for the
REM  GPUs in this machine unless TORCH_CUDA_ARCH_LIST names others, e.g. 8.9.
REM ============================================================================
setlocal
set SCRIPT_DIR=%~dp0
set ENV_NAME=gsplat
call "%SCRIPT_DIR%settings.bat"

echo === 1/5  conda env (py3.11) + torch 2.8.0+cu128 ===
call conda create -y -n %ENV_NAME% python=3.11 || exit /b 1
"%SPLAT_PYTHON%" -m pip install --upgrade pip || exit /b 1
"%SPLAT_PYTHON%" -m pip install torch==2.8.0+cu128 torchvision==0.23.0+cu128 --index-url https://download.pytorch.org/whl/cu128 || exit /b 1
"%SPLAT_PYTHON%" -m pip install ninja jaxtyping rich || exit /b 1

echo === 2/5  clone + source-build gsplat v1.5.3 (main HEAD is Windows-broken) ===
if not exist "%SPLAT_GSPLAT%" git clone --recursive https://github.com/nerfstudio-project/gsplat.git "%SPLAT_GSPLAT%" || exit /b 1
cd /d "%SPLAT_GSPLAT%" || exit /b 1
git checkout v1.5.3 || exit /b 1
git submodule update --init --recursive || exit /b 1
if exist build rmdir /s /q build
call "%SPLAT_VCVARS%" || exit /b 1
set DISTUTILS_USE_SDK=1
set MAX_JOBS=8
set NVCC_APPEND_FLAGS=-allow-unsupported-compiler
"%SPLAT_PYTHON%" -m pip install . --no-build-isolation --no-cache-dir || exit /b 1

echo === 3/5  example deps (minus optional fused_bilagrid) ===
"%SPLAT_PYTHON%" -m pip install -r "%SCRIPT_DIR%requirements-min.txt" --no-build-isolation || exit /b 1

echo === 4/5  patch pycolmap for Windows/Py3 ===
"%SPLAT_PYTHON%" "%SCRIPT_DIR%patch_pycolmap.py" || exit /b 1

echo === 5/5  verify ===
"%SPLAT_PYTHON%" -c "import torch,gsplat,fused_ssim,pycolmap; print('OK | torch',torch.__version__,'| gsplat',gsplat.__version__,'| cuda',torch.cuda.is_available())" || exit /b 1

echo.
echo Done. Also install (separately): COLMAP 4.1.1 CUDA binary + ffmpeg, and Node^>=24 (nvm use 24).
