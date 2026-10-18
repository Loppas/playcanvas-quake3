@echo off
REM ============================================================================
REM  Make a splat map's levelshot as Q3's `levelshot` command makes one: from the
REM  .ent's intermission point, 90 degrees across, 512x384 averaged down to a
REM  128x128 24-bit TGA (map-format.md section 5). Then read it back.
REM
REM  Requires Node >=24:  run `nvm use 24` once beforehand.
REM  Usage:  levelshot.bat <map.sog> [--ent <stem>.ent] [--out <stem>.tga]
REM  Output: <stem>.tga beside the .sog, and <stem>.levelshot.png, the full frame
REM ============================================================================
setlocal
set SCRIPT_DIR=%~dp0
call "%SCRIPT_DIR%settings.bat"

if "%~1"=="" echo Usage: levelshot.bat ^<map.sog^> [--ent FILE] [--out FILE] & exit /b 1
"%SPLAT_PYTHON%" -m splat_maps levelshot %*
