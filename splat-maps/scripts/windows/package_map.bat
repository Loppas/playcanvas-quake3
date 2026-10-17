@echo off
REM ============================================================================
REM  Assemble a splat map's pk3, map-<stem>.pk3, from the parts beside its .sog:
REM  <stem>.sog, .polish.json, .voxel.json/.bin, .collision.glb, .bake.json, .ent,
REM  and optionally .arena and .tga. Writes the _pcq_* keys into the packed .ent
REM  and the readme <stem>.txt, then reads the pk3 back and lints it.
REM
REM  Usage:  package_map.bat <dir>\<stem>.sog --author "NAME" [--out-dir DIR]
REM ============================================================================
setlocal
set SCRIPT_DIR=%~dp0
call "%SCRIPT_DIR%settings.bat"

if "%~1"=="" echo Usage: package_map.bat ^<dir^>\^<stem^>.sog --author "NAME" [--out-dir DIR] & exit /b 1
"%SPLAT_PYTHON%" "%SCRIPT_DIR%package_map.py" %*
