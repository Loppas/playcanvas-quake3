@echo off
REM ============================================================================
REM  Keep a saved .map's point entities as a splat map's .ent: worldspawn's keys
REM  and every point entity; func_group and the reference misc_model dropped;
REM  any other entity with brushes refused.
REM
REM  Usage:  map_to_ent.bat <file>.map <stem>.ent [--reference <stem>_collision.obj]
REM ============================================================================
setlocal
set SCRIPT_DIR=%~dp0
call "%SCRIPT_DIR%settings.bat"

if "%~1"=="" echo Usage: map_to_ent.bat ^<file^>.map ^<stem^>.ent [--reference FILE] & exit /b 1
"%SPLAT_PYTHON%" "%SCRIPT_DIR%map_to_ent.py" %*
