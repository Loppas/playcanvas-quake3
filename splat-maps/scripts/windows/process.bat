@echo off
REM ============================================================================
REM  Frames + COLMAP SfM for one scene.
REM  Usage:  process.bat <video_file> <project_name> [fps] [width]
REM    fps    frames-per-second to extract (default 1.5; raise for bigger spaces)
REM    width  output frame width in px (default 1920)
REM  Output: splat-maps\data\<project>\{images, sparse\0 (largest model, BIN)}
REM ============================================================================
setlocal
set SCRIPT_DIR=%~dp0
set ROOT=%SCRIPT_DIR%..\..
call "%SCRIPT_DIR%settings.bat"

set VIDEO=%~1
set PROJ=%~2
set FPS=%~3
if "%FPS%"=="" set FPS=1.5
set WIDTH=%~4
if "%WIDTH%"=="" set WIDTH=1920
if "%PROJ%"=="" echo Usage: process.bat ^<video^> ^<project^> [fps] [width] & exit /b 1

set DATA=%ROOT%\data\%PROJ%
set IMG=%DATA%\images
set DB=%DATA%\database.db
set SPARSE=%DATA%\sparse

echo === extract frames (fps=%FPS%, width=%WIDTH%) -> %IMG% ===
if not exist "%IMG%" mkdir "%IMG%"
"%SPLAT_FFMPEG%" -hide_banner -loglevel warning -i "%VIDEO%" -vf "fps=%FPS%,scale=%WIDTH%:-2" -qscale:v 2 "%IMG%\frame_%%04d.jpg" || exit /b 1

echo === COLMAP feature extraction (GPU) ===
if exist "%DB%" del /q "%DB%"
"%SPLAT_COLMAP%" feature_extractor --database_path "%DB%" --image_path "%IMG%" --ImageReader.single_camera 1 --ImageReader.camera_model OPENCV --FeatureExtraction.use_gpu 1 || exit /b 1

echo === COLMAP sequential matching (GPU) ===
"%SPLAT_COLMAP%" sequential_matcher --database_path "%DB%" --FeatureMatching.use_gpu 1 || exit /b 1

echo === COLMAP mapping ===
if not exist "%SPARSE%" mkdir "%SPARSE%"
"%SPLAT_COLMAP%" mapper --database_path "%DB%" --image_path "%IMG%" --output_path "%SPARSE%" || exit /b 1

echo === promote largest sub-model to sparse/0, normalize to BIN ===
"%SPLAT_PYTHON%" "%SCRIPT_DIR%promote_largest_model.py" "%SPARSE%" "%SPLAT_COLMAP%" || exit /b 1
"%SPLAT_COLMAP%" model_converter --input_path "%SPARSE%\0" --output_path "%SPARSE%\0" --output_type BIN || exit /b 1

echo.
echo Done. Dataset ready at %DATA%  (next: train.bat %PROJ%)
