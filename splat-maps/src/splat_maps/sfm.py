"""Structure from motion over a capture's frames, with COLMAP: the cameras and a sparse cloud.

  1. features, one OPENCV camera for every frame, on the GPU;
  2. sequential matching, since the frames come from a video in order;
  3. the mapper, which can make several disconnected models, `sparse/0`, `sparse/1`, ..., the
     largest not always the first;
  4. the model with the most registered frames moved to `sparse/0`, the rest removed, and
     written in COLMAP's binary format: gsplat's parser reads `sparse/0` alone.

Most frames should register. A capture that registers few needs more overlap or more frames.

Usage:
    splat-maps sfm <dataset>

Reads <dataset>/images/ (`frames` writes it); writes <dataset>/database.db and
<dataset>/sparse/0. COLMAP is $SPLAT_COLMAP, or `colmap` on PATH: 4.1 or later, whose options
these are (`FeatureExtraction.use_gpu` was `SiftExtraction.use_gpu` before).
"""

import argparse
import os
import re
import shutil
import subprocess
import sys


def find_colmap():
    """COLMAP's path, from $SPLAT_COLMAP or PATH; exits if there is none."""
    name = os.environ.get("SPLAT_COLMAP", "colmap")
    exe = shutil.which(name)
    if exe is None:
        sys.exit(f"ERROR: no COLMAP at {name!r}: put it on PATH, or name it in SPLAT_COLMAP")
    return exe


def colmap(exe, *args):
    """Run a COLMAP command; exits if it fails."""
    print(f"\n=== sfm: colmap {args[0]}", flush=True)
    if subprocess.run([exe, *args]).returncode != 0:
        sys.exit(f"ERROR: colmap {args[0]} failed")


def registered_images(exe, model):
    """How many frames `model` registered, as COLMAP's model_analyzer counts them."""
    run = subprocess.run([exe, "model_analyzer", "--path", model], capture_output=True, text=True)
    m = re.search(r"Registered images:\s*(\d+)", run.stdout + run.stderr)
    return int(m.group(1)) if m else 0


def keep_largest(exe, sparse):
    """The model in `sparse` with the most registered frames, moved to `sparse/0`, the others
    removed; returns how many frames it registered."""
    models = sorted((d for d in os.listdir(sparse)
                     if d.isdigit() and os.path.isdir(os.path.join(sparse, d))), key=int)
    if not models:
        sys.exit(f"ERROR: the mapper made no model in {sparse}")
    counts = {d: registered_images(exe, os.path.join(sparse, d)) for d in models}
    for d in models:
        print(f"  sparse/{d}: {counts[d]} registered frames")
    best = max(models, key=lambda d: counts[d])
    if models != ["0"]:
        chosen = os.path.join(sparse, "_chosen")
        os.rename(os.path.join(sparse, best), chosen)
        for d in models:
            if d != best:
                shutil.rmtree(os.path.join(sparse, d))
        os.rename(chosen, os.path.join(sparse, "0"))
        print(f"  kept sparse/{best} as sparse/0")
    return counts[best]


def main(argv=None, prog=None):
    ap = argparse.ArgumentParser(prog=prog, description="COLMAP's SfM over a capture's frames.")
    ap.add_argument("dataset", help="the capture's folder, its frames in images/")
    args = ap.parse_args(argv)
    sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)

    exe = find_colmap()
    images = os.path.join(args.dataset, "images")
    frames = len(os.listdir(images)) if os.path.isdir(images) else 0
    if frames == 0:
        sys.exit(f"ERROR: no frames in {images}. Extract them with `frames` first")
    sparse = os.path.join(args.dataset, "sparse")
    if os.path.isdir(sparse) and os.listdir(sparse):
        sys.exit(f"ERROR: {sparse} already holds a model. Remove it to run the SfM again")
    os.makedirs(sparse, exist_ok=True)
    db = os.path.join(args.dataset, "database.db")
    if os.path.exists(db):
        os.remove(db)

    colmap(exe, "feature_extractor", "--database_path", db, "--image_path", images,
           "--ImageReader.single_camera", "1", "--ImageReader.camera_model", "OPENCV",
           "--FeatureExtraction.use_gpu", "1")
    colmap(exe, "sequential_matcher", "--database_path", db, "--FeatureMatching.use_gpu", "1")
    colmap(exe, "mapper", "--database_path", db, "--image_path", images, "--output_path", sparse)
    print("\n=== sfm: the largest model")
    registered = keep_largest(exe, sparse)
    model = os.path.join(sparse, "0")
    colmap(exe, "model_converter", "--input_path", model, "--output_path", model,
           "--output_type", "BIN")
    print(f"\n  {registered} of {frames} frames registered, in {model}")
    if registered < frames / 2:
        print("  WARNING: fewer than half the frames registered. Capture with more overlap, or "
              "extract more frames")


if __name__ == "__main__":
    main()
