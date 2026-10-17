@echo off
REM ============================================================================
REM  The splat-transform these scripts are calibrated for: installed if it is
REM  missing, refused if another version is on PATH. The frame calibration in
REM  docs\conventions.md and the bake's sizes were measured on this version,
REM  so moving the pin means re-running calibrate_transform.py and re-measuring a
REM  bake first. splat_map.py reads ST_VERSION from this file.
REM
REM  Usage (Node >=24 on PATH):  call pin-splat-transform.bat || exit /b 1
REM ============================================================================
set ST_VERSION=3.1.6
where splat-transform >nul 2>nul || call npm install -g "@playcanvas/splat-transform@%ST_VERSION%"
splat-transform --version 2>&1 | findstr /b /c:"splat-transform v%ST_VERSION% " >nul
if errorlevel 1 (
  echo splat-transform is not v%ST_VERSION%. Install it with:
  echo   npm install -g @playcanvas/splat-transform@%ST_VERSION%
  exit /b 1
)
exit /b 0
