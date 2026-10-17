@echo off
REM ============================================================================
REM  Write a splat map's .ent from viewpos readings, applying the placement rules
REM  of map-format.md section 3.4: a spawn spot is its reading less 26 in z; the
REM  intermission point and what it faces are their readings as they are.
REM
REM  Usage:  write_ent.bat <stem>.ent --message "NAME" --spawn "(x y z) : yaw" [--spawn ...]
REM                   --intermission "(x y z) : yaw" --look-at "(x y z) : yaw"
REM                   [--octree <stem>.voxel.json]
REM ============================================================================
setlocal
set SCRIPT_DIR=%~dp0
call "%SCRIPT_DIR%settings.bat"

if "%~1"=="" echo Usage: write_ent.bat ^<stem^>.ent --message NAME --spawn "(x y z) : yaw" --intermission ... --look-at ... & exit /b 1
"%SPLAT_PYTHON%" "%SCRIPT_DIR%write_ent.py" %*
