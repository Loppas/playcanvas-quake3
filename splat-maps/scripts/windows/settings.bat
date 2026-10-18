@echo off
REM ============================================================================
REM  Where the wrappers find their tools. Each wrapper calls this inside its own
REM  setlocal. A setting already in the environment is kept, and
REM  settings.local.bat beside this file, which git ignores, is read first, so a
REM  machine's own paths go there. The README's "Settings" lists each one.
REM ============================================================================
if exist "%~dp0settings.local.bat" call "%~dp0settings.local.bat"
if not defined SPLAT_PYTHON set "SPLAT_PYTHON=%USERPROFILE%\miniconda3\envs\gsplat\python.exe"
if not defined SPLAT_GSPLAT set "SPLAT_GSPLAT=%~dp0..\..\..\..\gsplat"
if not defined SPLAT_COLMAP set "SPLAT_COLMAP=colmap"
if not defined SPLAT_FFMPEG set "SPLAT_FFMPEG=ffmpeg"
if not defined SPLAT_VCVARS set "SPLAT_VCVARS=C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat"
if defined SPLAT_NODE set "PATH=%SPLAT_NODE%;%PATH%"
REM The splat_maps package the wrappers run, from this checkout.
if defined PYTHONPATH (set "PYTHONPATH=%~dp0..\..\src;%PYTHONPATH%") else (set "PYTHONPATH=%~dp0..\..\src")
exit /b 0
