@echo off
REM ============================================================================
REM  Train a Gaussian splat with gsplat's MCMC trainer (src\splat_maps\train.py).
REM  Usage:  train.bat <project_name> [cap_max] [max_steps]
REM    cap_max    max # Gaussians (default 1000000)
REM    max_steps  training steps (default 30000)
REM  Input:  splat-maps\data\<project>\   Output: ...\results\mcmc\ply\point_cloud_*.ply
REM ============================================================================
setlocal
set SCRIPT_DIR=%~dp0
set ROOT=%SCRIPT_DIR%..\..
call "%SCRIPT_DIR%settings.bat"

set CAP=%~2
if "%CAP%"=="" set CAP=1000000
set STEPS=%~3
if "%STEPS%"=="" set STEPS=30000
if "%~1"=="" echo Usage: train.bat ^<project^> [cap_max] [max_steps] & exit /b 1

"%SPLAT_PYTHON%" -m splat_maps train "%ROOT%\data\%~1" --cap-max %CAP% --max-steps %STEPS%
