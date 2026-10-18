@echo off
REM ============================================================================
REM  Deliver a splat map pk3 to the port's public\maps\, where the port mounts
REM  it: lint it, copy it into place, and hash the copy.
REM
REM  Usage:  deliver_map.bat <dir>\map-<stem>.pk3 [--port DIR] [--replace]
REM    --port     the port's checkout (default: the one these scripts are in)
REM    --replace  replace a delivered pk3 whose bytes differ; a released pk3 is
REM               never rewritten in place, so a fix normally takes a new name
REM ============================================================================
setlocal
set SCRIPT_DIR=%~dp0
call "%SCRIPT_DIR%settings.bat"

if "%~1"=="" echo Usage: deliver_map.bat ^<dir^>\map-^<stem^>.pk3 [--port DIR] [--replace] & exit /b 1
"%SPLAT_PYTHON%" -m splat_maps deliver %*
