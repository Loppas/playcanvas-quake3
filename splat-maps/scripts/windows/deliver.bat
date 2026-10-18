@echo off
REM ============================================================================
REM  Convert the trained PLY to web-ready SOG + a standalone HTML viewer
REM  (src\splat_maps\export.py). Requires Node >=24:  run `nvm use 24` once beforehand.
REM  Usage:  deliver.bat <project_name>
REM  Output: splat-maps\data\<project>\results\mcmc\{<project>.sog, <project>_viewer.html}
REM ============================================================================
setlocal
set SCRIPT_DIR=%~dp0
set ROOT=%SCRIPT_DIR%..\..
call "%SCRIPT_DIR%settings.bat"

if "%~1"=="" echo Usage: deliver.bat ^<project^> & exit /b 1
"%SPLAT_PYTHON%" -m splat_maps export "%ROOT%\data\%~1"
