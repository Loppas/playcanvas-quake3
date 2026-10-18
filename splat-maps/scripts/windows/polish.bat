@echo off
REM ============================================================================
REM  Polish a trained SOG: level it, square it, scale it to metres, move the
REM  floor to y=0. The headless replacement for the manual SuperSplat pass:
REM  measure, apply, verify and record, so the output is checked rather than
REM  assumed (src\splat_maps\polish.py).
REM
REM  Requires Node >=24:  run `nvm use 24` once beforehand.
REM  Usage:  polish.bat <input.sog> <output.sog> <metric_height_m> [--license L] [extra args...]
REM    metric_height_m  real floor-to-ceiling height in metres (the scale reference)
REM    --license        the source's credit, for a capture with no license.txt of its
REM                     own: a file in superspl.at's layout, or its fields in one quoted
REM                     string, "Title: ...; Author: ...; Source: <link>; License URL: <link>"
REM    extra args       sog_inspect's, given to both measures, e.g. --up-hint 0,-1,0
REM                     --player-height 0.1 --render
REM  Output: <output.sog>, with the input's license.txt, or the one given, inside it;
REM          <output>.polish.json, the _pcq_* keys the polish owns and the verify;
REM          <input>_inspect\ and <output>_inspect\, each a report and drawings
REM ============================================================================
setlocal
set SCRIPT_DIR=%~dp0
call "%SCRIPT_DIR%settings.bat"

if "%~3"=="" echo Usage: polish.bat ^<input.sog^> ^<output.sog^> ^<metric_height_m^> [--license L] [extra args] & exit /b 1
"%SPLAT_PYTHON%" -m splat_maps polish %*
