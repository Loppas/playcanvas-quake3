"""Extract a video's frames for structure from motion, the first stage of a capture.

ffmpeg takes `--fps` frames a second, scaled to `--width` pixels across. About 150 to 300 frames
suit a room, so for a clip of S seconds take an fps near 200 / S (`docs/training.md`).

Then the blurred frames are set aside: those whose sharpness, the variance of the Laplacian of
their grey, is under `--min-sharpness` of the capture's median. A blurred frame holds few
features, and a run of them breaks sequential matching, so that everything filmed after it is
lost from the SfM. They are moved to images_rejected/, not deleted.

Usage:
    splat-maps frames <video> <dataset> [--fps 1.5] [--width 1920] [--min-sharpness 0.25]

Writes <dataset>/images/frame_0001.jpg, ..., which `sfm` reads. ffmpeg is $SPLAT_FFMPEG, or
`ffmpeg` on PATH.
"""

import argparse
import os
import shutil
import subprocess
import sys

import numpy as np
from PIL import Image
from scipy.ndimage import laplace

#: The default `--min-sharpness`: under a frame that is merely soft, near half the median, and
#: over motion blur, which falls to a fifth of it.
MIN_SHARPNESS = 0.25


def find_ffmpeg():
    """ffmpeg's path, from $SPLAT_FFMPEG or PATH; exits if there is none."""
    name = os.environ.get("SPLAT_FFMPEG", "ffmpeg")
    exe = shutil.which(name)
    if exe is None:
        sys.exit(f"ERROR: no ffmpeg at {name!r}: put it on PATH, or name it in SPLAT_FFMPEG")
    return exe


def sharpness(path):
    """How much fine detail the frame at `path` holds: the variance of the Laplacian of its
    grey, at half size."""
    grey = np.asarray(Image.open(path).convert("L").reduce(2), dtype=np.float32)
    return float(laplace(grey).var())


def set_aside_blurred(images, fraction):
    """Move the frames in `images` whose sharpness is under `fraction` of the median to
    images_rejected/ beside it; returns their names."""
    names = sorted(os.listdir(images))
    values = [sharpness(os.path.join(images, name)) for name in names]
    floor = fraction * float(np.median(values))
    blurred = [name for name, value in zip(names, values) if value < floor]
    if blurred:
        rejected = os.path.join(os.path.dirname(images), "images_rejected")
        os.makedirs(rejected, exist_ok=True)
        for name in blurred:
            os.replace(os.path.join(images, name), os.path.join(rejected, name))
    return blurred


def main(argv=None, prog=None):
    ap = argparse.ArgumentParser(prog=prog, description="Extract a video's frames for the SfM.")
    ap.add_argument("video")
    ap.add_argument("dataset", help="the capture's folder; the frames go in its images/")
    ap.add_argument("--fps", type=float, default=1.5, help="frames a second (default 1.5)")
    ap.add_argument("--width", type=int, default=1920, help="frame width in pixels (default 1920)")
    ap.add_argument("--min-sharpness", type=float, default=MIN_SHARPNESS,
                    help="set aside frames under this fraction of the median sharpness "
                         f"(default {MIN_SHARPNESS}; 0 keeps every frame)")
    args = ap.parse_args(argv)
    sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)

    exe = find_ffmpeg()
    if not os.path.isfile(args.video):
        sys.exit(f"ERROR: no video at {args.video}")
    images = os.path.join(args.dataset, "images")
    if os.path.isdir(images) and os.listdir(images):
        sys.exit(f"ERROR: {images} already holds frames. Remove it to extract them again")
    os.makedirs(images, exist_ok=True)

    print(f"=== frames: {args.fps:g} a second, {args.width} px wide -> {images}")
    run = subprocess.run([exe, "-hide_banner", "-loglevel", "warning", "-i", args.video,
                          "-vf", f"fps={args.fps:g},scale={args.width}:-2", "-qscale:v", "2",
                          os.path.join(images, "frame_%04d.jpg")])
    if run.returncode != 0:
        sys.exit("ERROR: ffmpeg failed")
    count = len(os.listdir(images))
    if count == 0:
        sys.exit("ERROR: ffmpeg wrote no frames")
    print(f"  {count} frames")
    blurred = set_aside_blurred(images, args.min_sharpness)
    if blurred:
        print(f"  {len(blurred)} blurred, under {args.min_sharpness:g} of the median sharpness, "
              f"set aside in images_rejected/: {', '.join(blurred)}")


if __name__ == "__main__":
    main()
