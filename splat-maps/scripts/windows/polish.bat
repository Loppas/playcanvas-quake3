@echo off
REM ============================================================================
REM  Polish a trained SOG: level it, square it, scale it to metres, move the
REM  floor to y=0. The headless replacement for the manual SuperSplat pass.
REM
REM  Runs measure -> apply -> re-measure -> record, so the output is always
REM  checked rather than assumed: the second report must show ~0 tilt, ~0 yaw,
REM  floor y=0 and the clear height kept, or the polish fails.
REM
REM  Requires Node >=24:  run `nvm use 24` once beforehand.
REM  Usage:  polish.bat <input.sog> <output.sog> <metric_height_m> [--license L] [extra args...]
REM    metric_height_m  real floor-to-ceiling height in metres (the scale reference)
REM    --license        the source's credit, for a capture with no license.txt of its
REM                     own: a file in superspl.at's layout, or its fields in one quoted
REM                     string, "Title: ...; Author: ...; Source: <link>; License URL: <link>"
REM    extra args       passed through to sog_inspect.py, e.g. --up-hint "0,-1,0"
REM                     --player-height 0.1 --render. Quote any value with a comma:
REM                     cmd splits arguments on commas, so 0,-1,0 arrives as 0 -1 0
REM  Output: <output.sog>, with the input's license.txt, or the one given, inside it;
REM          <output>.polish.json, the _pcq_* keys the polish owns and the verify;
REM          <input>_inspect\ and <output>_inspect\, each a report and drawings
REM ============================================================================
setlocal enabledelayedexpansion
set SCRIPT_DIR=%~dp0
call "%SCRIPT_DIR%settings.bat"

set IN=%~1
set OUT=%~2
set HEIGHT=%~3
if "%HEIGHT%"=="" echo Usage: polish.bat ^<input.sog^> ^<output.sog^> ^<metric_height_m^> [extra args] & exit /b 1
if not exist "%IN%" echo Not found: %IN% & exit /b 1
shift & shift & shift

REM --license goes to the record only: sog_inspect does not take it, and it is not part of the
REM transform. %2 is read when the block is parsed, before either shift runs.
set EXTRA=
set LICENSE=
:collect
if "%~1"=="" goto collected
if /i "%~1"=="--license" (
  set LICENSE=--license %2
  shift & shift
  goto collect
)
set EXTRA=!EXTRA! %1
shift
goto collect
:collected

call "%SCRIPT_DIR%pin-splat-transform.bat" || exit /b 1

echo(
echo === 1/4  measuring %IN%
"%SPLAT_PYTHON%" "%SCRIPT_DIR%sog_inspect.py" "%IN%" --metric-height %HEIGHT% !EXTRA! || exit /b 1

REM sog_inspect writes the transform to report.json next to the input. The command
REM starts with `call` because for /f strips the first and last quote from a command
REM that begins with one, which broke the quoted python path.
for %%F in ("%IN%") do set REPORT=%%~dpnF_inspect\report.json
for /f "delims=" %%A in ('call "%SPLAT_PYTHON%" -c "import json,sys;print(' '.join(json.load(open(sys.argv[1]))['splat_transform_args']))" "!REPORT!"') do set ARGS=%%A
if "!ARGS!"=="" echo Could not read the transform from !REPORT! & exit /b 1

echo(
echo === 2/4  applying: splat-transform -w "%IN%" !ARGS! "%OUT%"
call splat-transform -w "%IN%" !ARGS! "%OUT%" || exit /b 1

REM The output is +Y up by construction, so the verify always hints +Y. Passing the
REM input's --up-hint on to it made sog_inspect lock onto the ceiling of an output
REM polished with --up-hint 0,-1,0. argparse keeps the last value given.
echo(
echo === 3/4  verifying %OUT%   (expect tilt ~0, yaw ~0, floor y ~0)
"%SPLAT_PYTHON%" "%SCRIPT_DIR%sog_inspect.py" "%OUT%" --scale 1.0 !EXTRA! --up-hint 0,1,0 || exit /b 1

echo(
echo === 4/4  recording the polish and keeping the source's licence
"%SPLAT_PYTHON%" "%SCRIPT_DIR%polish_record.py" "%IN%" "%OUT%" !LICENSE! --metric-height %HEIGHT% !EXTRA! || exit /b 1

echo(
echo Done. Compare the two report.json files and the plan/section drawings.
