@echo off
REM ============================================================================
REM  Lint a finished splat map pk3 against map-format.md section 10's rules,
REM  L1 to L29, changing nothing. Exits 1 if any rule fails at error level.
REM
REM  Usage:  map_lint.bat <dir>\map-<stem>.pk3
REM ============================================================================
setlocal
set SCRIPT_DIR=%~dp0
call "%SCRIPT_DIR%settings.bat"

if "%~1"=="" echo Usage: map_lint.bat ^<dir^>\map-^<stem^>.pk3 & exit /b 1
"%SPLAT_PYTHON%" -m splat_maps lint %*
