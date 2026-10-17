@echo off
REM ============================================================================
REM  Turn a splat map's collision mesh into an OBJ in Quake 3 units, Y up, which
REM  NetRadiant-custom's loader turns to Z up, for a reference misc_model at the
REM  origin.
REM
REM  Usage:  glb_to_editor.bat <stem>.collision.glb [--out <stem>_collision.obj]
REM ============================================================================
setlocal
set SCRIPT_DIR=%~dp0
call "%SCRIPT_DIR%settings.bat"

if "%~1"=="" echo Usage: glb_to_editor.bat ^<stem^>.collision.glb [--out FILE] & exit /b 1
"%SPLAT_PYTHON%" "%SCRIPT_DIR%glb_to_editor.py" %*
