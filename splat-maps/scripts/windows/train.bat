@echo off
REM ============================================================================
REM  Train a Gaussian splat with gsplat's MCMC trainer.
REM  Usage:  train.bat <project_name> [cap_max] [max_steps]
REM    cap_max    max # Gaussians (default 1000000)
REM    max_steps  training steps (default 30000)
REM  Input:  splat-maps\data\<project>\   Output: ...\results\mcmc\ply\point_cloud_*.ply
REM ============================================================================
setlocal
set SCRIPT_DIR=%~dp0
set ROOT=%SCRIPT_DIR%..\..
call "%SCRIPT_DIR%settings.bat"

set PROJ=%~1
set CAP=%~2
if "%CAP%"=="" set CAP=1000000
set STEPS=%~3
if "%STEPS%"=="" set STEPS=30000
if "%PROJ%"=="" echo Usage: train.bat ^<project^> [cap_max] [max_steps] & exit /b 1

set DATA=%ROOT%\data\%PROJ%
cd /d "%SPLAT_GSPLAT%\examples" || exit /b 1
"%SPLAT_PYTHON%" simple_trainer.py mcmc --data-dir "%DATA%" --data-factor 1 --result-dir "%DATA%\results\mcmc" --strategy.cap-max %CAP% --max-steps %STEPS% --antialiased --save-ply --disable-viewer
REM Add --use-bilateral-grid for scenes with exposure drift (pure-python lib_bilagrid path).
