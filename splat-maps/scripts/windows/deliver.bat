@echo off
REM ============================================================================
REM  Convert the trained PLY to web-ready SOG + a standalone HTML viewer.
REM  Requires Node >=24:  run `nvm use 24` once beforehand.
REM  Usage:  deliver.bat <project_name>
REM  Output: splat-maps\data\<project>\results\mcmc\{<project>.sog, <project>_viewer.html}
REM ============================================================================
setlocal enabledelayedexpansion
set SCRIPT_DIR=%~dp0
set ROOT=%SCRIPT_DIR%..\..
call "%SCRIPT_DIR%settings.bat"

set PROJ=%~1
if "%PROJ%"=="" echo Usage: deliver.bat ^<project^> & exit /b 1
set OUT=%ROOT%\data\%PROJ%\results\mcmc
set PLYDIR=%OUT%\ply

REM pick the highest-step ply (zero-padded names sort correctly with /o-n)
set PLY=
for /f "delims=" %%F in ('dir /b /o-n "%PLYDIR%\point_cloud_*.ply"') do set PLY=%PLYDIR%\%%F
if "%PLY%"=="" echo No PLY found in %PLYDIR% & exit /b 1

echo Converting !PLY!
call "%SCRIPT_DIR%pin-splat-transform.bat" || exit /b 1
call splat-transform "!PLY!" "%OUT%\%PROJ%.sog" || exit /b 1
call splat-transform "!PLY!" "%OUT%\%PROJ%_viewer.html" || exit /b 1
echo.
echo Done: %OUT%\%PROJ%.sog  and  %OUT%\%PROJ%_viewer.html
