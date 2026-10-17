"""Make a splat map's levelshot the way Q3's `levelshot` command makes one.

Q3's command puts the player at the intermission point and `R_LevelShot` samples the screen
down to a 128 x 128 TGA (g_cmds.c:420-442; tr_init.c:566-625). This does the same with
splat-transform's rasterizer (`map-format.md` §5):
  1. the camera stands at the `.ent`'s first `info_player_intermission`, at its origin, with no
     view height (cg_view.c:641-646);
  2. it faces the entity its `target` names, or else its `angles` (g_main.c:963-981), turned
     into a view with Q3's own `vectoangles` and `AngleVectors` (q_math.c:376-413, :932-965);
  3. a 4:3 frame, 90 degrees across (cg_view.c:480-482), so 2 atan(0.75) = 73.74 degrees
     tall, rendered at 512 x 384 with Q3's near plane of 4 units (`r_znear`, tr_init.c:1074);
  4. each 4 x 3 block summed and divided by 12 in integers, as `R_LevelShot` does;
  5. written as an uncompressed 24-bit TGA, BGR, bottom row first, 49,170 bytes.

The rasterizer takes its camera in splat-transform's frame, the world turned 180 degrees about
Z, which is the octree's frame. Measured on 3.1.6: a camera at the origin aimed at +X sees
the file's -X, the file's +Y comes out down, right is forward x up, and `--camera-fov` is
vertical. So the camera goes through `sim_to_octree`, not `sim_to_world`.

Then it reads the TGA back and checks it byte for byte, and checks the view is not into the
void or a wall.

Usage:
    python levelshot.py <map.sog> [--ent <stem>.ent] [--out <stem>.tga]

Writes <stem>.tga beside the .sog, and <stem>.levelshot.png, the 512 x 384 frame, for people.
"""

import argparse
import math
import os
import subprocess
import sys

import numpy as np
from PIL import Image

import splat_map as sm

WIDTH, HEIGHT = 512, 384                                          # tr_init.c:597-598
FOV_X = 90.0                                                      # cg_view.c:480-482
FOV_Y = math.degrees(2 * math.atan(math.tan(math.radians(FOV_X / 2)) * HEIGHT / WIDTH))
ZNEAR_UNITS = 4                                                   # tr_init.c:1074
TGA_SIZE = 18 + 128 * 128 * 3                                     # 49,170


def vectoangles(v):
    """Q3's `vectoangles` (q_math.c:376-413): pitch, yaw, roll in degrees, roll always 0."""
    x, y, z = v
    if x == 0 and y == 0:
        yaw, pitch = 0.0, (90.0 if z > 0 else 270.0)
    else:
        if x:
            yaw = math.degrees(math.atan2(y, x))
        else:
            yaw = 90.0 if y > 0 else 270.0
        if yaw < 0:
            yaw += 360
        pitch = math.degrees(math.atan2(z, math.hypot(x, y)))
        if pitch < 0:
            pitch += 360
    return (-pitch, yaw, 0.0)


def angle_vectors(angles):
    """Q3's `AngleVectors` (q_math.c:932-965): forward and up, in sim axes."""
    p, y, r = (math.radians(a) for a in angles)
    sp, cp = math.sin(p), math.cos(p)
    sy, cy = math.sin(y), math.cos(y)
    sr, cr = math.sin(r), math.cos(r)
    forward = (cp * cy, cp * sy, -sp)
    up = (cr * sp * cy + -sr * -sy, cr * sp * sy + -sr * cy, cr * cp)
    return forward, up


def level_shot(frame):
    """`R_LevelShot`'s resample of a 512 x 384 frame (top row first) into the TGA's 128 x 128
    pixels: bottom row first, as `glReadPixels` returns them, each the integer mean of a 4 x 3
    block, in BGR (tr_init.c:597-616)."""
    bottom_up = frame[::-1].astype(np.int64)
    sums = bottom_up.reshape(128, 3, 128, 4, 3).sum(axis=(1, 3))
    return (sums // 12).astype(np.uint8)[:, :, ::-1]


def tga_header():
    """The 18 bytes `R_LevelShot` writes: type 2, 128 x 128, 24 bits (tr_init.c:589-594)."""
    h = bytearray(18)
    h[2], h[12], h[14], h[16] = 2, 128, 128, 24
    return bytes(h)


def main():
    ap = argparse.ArgumentParser(description="Make a splat map's levelshot, as Q3 makes one.")
    ap.add_argument("sog", help="the map's polished .sog")
    ap.add_argument("--ent", help="the map's entity text (default <stem>.ent beside the .sog)")
    ap.add_argument("--out", help="the TGA to write (default <stem>.tga beside the .sog)")
    args = ap.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")

    stem = sm.stem_of(args.sog, ".sog")
    here = os.path.dirname(os.path.abspath(args.sog))
    ent_path = args.ent or os.path.join(here, f"{stem}.ent")
    out = args.out or os.path.join(here, f"{stem}.tga")
    try:
        exe = sm.require_splat_transform()
        with open(ent_path, "rb") as fh:
            entities, _ = sm.parse_entities(fh.read())
    except (OSError, sm.FormatError) as e:
        sys.exit(f"ERROR: {e}")
    errors, warnings = [], []

    points = [e for e in entities if e.classname == "info_player_intermission"]
    if not points:
        sys.exit("ERROR: no info_player_intermission: the levelshot is taken from one, so the "
                 "format requires it (map-format.md section 3.2)")
    if len(points) > 1:
        warnings.append(f"{len(points)} intermission points; Q3 uses the first, and so does this")
    cam = points[0]
    origin = cam.vector("origin")
    angles = cam.vector("angles")
    if cam.get("angle") is not None:
        angles = (0.0, sm._atof(cam.get("angle")), 0.0)
    facing = "its angles"
    if cam.get("target"):
        aimed = [e for e in entities if e.get("targetname") == cam.get("target")]
        if not aimed:
            errors.append(f"target {cam.get('target')!r} names no entity (L16)")
        else:
            if len(aimed) > 1:
                warnings.append(f"{len(aimed)} entities share targetname {cam.get('target')!r}; "
                                "Q3 picks one at random each time, this takes the first")
            to = aimed[0].vector("origin")
            angles = vectoangles(tuple(to[i] - origin[i] for i in range(3)))
            facing = f"{aimed[0].classname} at ({' '.join(sm.fmt_num(c) for c in to)})"
    forward, up = angle_vectors(angles)

    # Into the rasterizer's frame, which is the octree's. Directions go through the same linear
    # map; the 1/32 cancels once they are normalised.
    def direction(v):
        d = np.array(sm.sim_to_octree(v))
        return d / np.linalg.norm(d)

    pos = np.array(sm.sim_to_octree(origin))
    target = pos + direction(forward)
    cam_up = direction(up)
    print(f"=== levelshot from {os.path.basename(ent_path)}'s intermission point")
    print(f"  origin ({' '.join(sm.fmt_num(c) for c in origin)}), facing {facing}: pitch "
          f"{angles[0]:.2f}, yaw {angles[1]:.2f}, roll {angles[2]:.2f}")
    print(f"  {WIDTH} x {HEIGHT}, {FOV_X:g} degrees across and {FOV_Y:.2f} tall, near plane "
          f"{ZNEAR_UNITS} units")

    # The intermission origin must be open (L22), if the bake is beside the map.
    vox = os.path.join(here, f"{stem}.voxel.json")
    if os.path.exists(vox):
        octree = sm.Octree.load(vox)
        s = octree.voxel_units()
        v = [math.floor(c / s) for c in origin]
        if octree.is_solid_cell(*octree.sim_voxel_to_cell(*v)):
            errors.append(f"the intermission origin ({' '.join(sm.fmt_num(c) for c in origin)}) is "
                          "in a solid voxel (L22)")
        else:
            print("  the intermission origin is in open space")

    webp = os.path.splitext(out)[0] + ".levelshot.webp"
    cmd = [exe, "-w", "-q", args.sog,
           "--camera-pos", ",".join(f"{c:.6f}" for c in pos),
           "--camera-target", ",".join(f"{c:.6f}" for c in target),
           "--camera-up", ",".join(f"{c:.6f}" for c in cam_up),
           "--camera-fov", f"{FOV_Y:.6f}",
           "--camera-near", sm.fmt_num(ZNEAR_UNITS / sm.UNITS_PER_METRE),
           "--resolution", f"{WIDTH}x{HEIGHT}", "--background", "0,0,0,1", webp]
    proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if proc.returncode != 0:
        sys.exit(f"ERROR: the render failed: {proc.stdout[-2000:]}{proc.stderr[-2000:]}")
    frame = np.asarray(Image.open(webp).convert("RGB"))
    os.remove(webp)
    if frame.shape != (HEIGHT, WIDTH, 3):
        sys.exit(f"ERROR: the render is {frame.shape[1]} x {frame.shape[0]}, "
                 f"not {WIDTH} x {HEIGHT}")
    preview = os.path.splitext(out)[0] + ".levelshot.png"
    Image.fromarray(frame).save(preview)

    pixels = level_shot(frame)
    with open(out, "wb") as fh:
        fh.write(tga_header())
        fh.write(pixels.tobytes())

    # Read it back.
    with open(out, "rb") as fh:
        data = fh.read()
    if len(data) != TGA_SIZE:
        errors.append(f"{len(data)} bytes, not {TGA_SIZE} (L28)")
    if data[:18] != tga_header():
        errors.append("the header differs from R_LevelShot's (L28)")
    back = np.frombuffer(data[18:], np.uint8).reshape(128, 128, 3)
    if not np.array_equal(back, pixels):
        errors.append("the pixels read back differ from those written")
    # Undo the layout by hand and compare with the frame, as a check on the resample itself.
    shown = back[::-1, :, ::-1].astype(int)                       # top row first, RGB
    blocks = frame.astype(int).reshape(128, 3, 128, 4, 3).mean(axis=(1, 3))
    worst = float(np.abs(shown - blocks).max())
    if worst >= 1.0:
        errors.append(f"the TGA is up to {worst:.2f} levels off the frame's 4 x 3 means")
    # Gross errors: the camera in a wall, or facing out of the capture.
    void = float((frame.sum(axis=2) < 12).mean())
    if void > 0.5:
        warnings.append(f"{void:.0%} of the frame is empty background: is the camera facing out "
                        "of the capture, or inside a wall?")
    print(f"  wrote {out} ({len(data):,} bytes) and {preview}")
    print(f"  read back: header and size as R_LevelShot writes them; pixels within "
          f"{worst:.2f} of the 4 x 3 means; {void:.1%} of the frame is background")
    for w in warnings:
        print(f"  WARNING: {w}")
    if errors:
        for e in errors:
            print(f"  ERROR: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
