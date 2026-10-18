@echo off
REM ============================================================================
REM  Frames + COLMAP SfM for one scene (src\splat_maps\frames.py and sfm.py).
REM  Usage:  process.bat <video_file> <project_name> [fps] [width]
REM    fps    frames-per-second to extract (default 1.5; raise for bigger spaces)
REM    width  output frame width in px (default 1920)
REM  Output: splat-maps\data\<project>\{images, sparse\0 (largest model, BIN)}
REM ============================================================================
setlocal
set SCRIPT_DIR=%~dp0
set ROOT=%SCRIPT_DIR%..\..
call "%SCRIPT_DIR%settings.bat"

set FPS=%~3
if "%FPS%"=="" set FPS=1.5
set WIDTH=%~4
if "%WIDTH%"=="" set WIDTH=1920
if "%~2"=="" echo Usage: process.bat ^<video^> ^<project^> [fps] [width] & exit /b 1

set DATA=%ROOT%\data\%~2
"%SPLAT_PYTHON%" -m splat_maps frames "%~1" "%DATA%" --fps %FPS% --width %WIDTH% || exit /b 1
"%SPLAT_PYTHON%" -m splat_maps sfm "%DATA%" || exit /b 1
echo.
echo Done. Dataset ready at %DATA%  (next: train.bat %~2)
