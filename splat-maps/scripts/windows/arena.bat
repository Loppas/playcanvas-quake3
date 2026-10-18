@echo off
REM ============================================================================
REM  Write a splat map's arena block, scripts\<n>.arena, and read it back by
REM  Q3's own rules (map-format.md section 4).
REM
REM  Usage:  arena.bat <stem>.arena [--longname "The Garage"] [--type "ffa tourney team"]
REM                    [--ent <stem>.ent] [--fraglimit N] [--timelimit N]
REM    map is the stem, from the file's name; longname defaults to the .ent's
REM    worldspawn message; type defaults to ffa
REM ============================================================================
setlocal
set SCRIPT_DIR=%~dp0
call "%SCRIPT_DIR%settings.bat"

if "%~1"=="" echo Usage: arena.bat ^<stem^>.arena [--longname TEXT] [--type TYPES] [--ent FILE] & exit /b 1
"%SPLAT_PYTHON%" -m splat_maps arena %*
