@echo off
REM ============================================================================
REM  Bake a splat map's collision octree, sized in Quake units, then re-measure
REM  it: the port's own checks, skipped steps (a leak), spawn spots, the floor.
REM
REM  Requires Node >=24:  run `nvm use 24` once beforehand.
REM  Usage:  bake.bat <map.sog> [--voxel 8] [--fill auto] [--seed x,y,z] [--ent FILE]
REM    --voxel   voxel edge in Quake units, whole, 1 to 13 (default 8)
REM    --fill    external fill reach in units, or auto: the smallest that seals
REM              the hull, found by baking (default auto)
REM    --seed    a point in the room's open air, in Q3 units as viewpos prints it;
REM              default: the first spawn spot in <stem>.ent beside the .sog
REM  Output: <stem>.voxel.json/.bin, .collision.glb, .bake.json, .bake.log
REM ============================================================================
setlocal
set SCRIPT_DIR=%~dp0
call "%SCRIPT_DIR%settings.bat"

if "%~1"=="" echo Usage: bake.bat ^<map.sog^> [--voxel 8] [--fill auto] [--seed x,y,z] [--ent FILE] & exit /b 1
call "%SCRIPT_DIR%pin-splat-transform.bat" || exit /b 1
"%SPLAT_PYTHON%" -m splat_maps bake %*
