"""Make a map from a video in one run: every stage in order, with starter entities.

  1-4. frames, sfm, train, export: the capture in <data>/<stem>/, the trained splat in
       results/mcmc/<stem>.sog;
  5.   polish, into <data>/<stem>/map/<stem>.sog, hinting +Z up, as gsplat's trainer leaves a
       capture (examples/datasets/colmap.py normalises the world to it);
  6.   bake, cropped to `--box`, seeded a metre above the middle of the most densely captured
       patch of floor: the plan's centre can be off the floor, inside a building or under a bed.
       Both bakes filter the drawn splat with `--crop`, `--cluster` and `--decimate`, if given;
  7.   starter entities: one spawn on what lies under the seed, facing +X, and the intermission
       above it, looking along +X down to the spawn's eye height 4 m on. Place the real ones
       afterwards, as `docs/maps.md` step 4 does, and run its steps 5-9 again;
  8-12. bake again, from the spawn; levelshot; arena; package; deliver.

Each stage checks its own output and stops the run on an error, so a finished run has passed
every check. The tools are looked for, and the arguments checked, before the frames.

Usage:
    splat-maps all <video> <stem> <metric_height_m> --license FILE|FIELDS --author WHO
                   --box=x0,y0,z0,x1,y1,z1 [--outdoor] [--crop] [--cluster] [--decimate N|N%]
                   [--message TEXT] [--data DIR] [--fps 1.5] [--width 1920]
                   [--min-sharpness 0.25] [--cap-max N] [--max-steps N] [--port DIR] [--replace]
                   [the polish's arguments]

`--box` is the bake's: the corners of the map in Q3 units, about the polished plan's centre,
the floor at z = 0. A trained capture holds stray splats far past what was filmed, so every run
names one, as `--box=x0,...`, since a value that starts with a minus is read as an option.
Which way the plan faces is known only after the polish, so make it square in plan.
`--outdoor` is for a capture with no ceiling and no hull: the polish scales it to its top, and
the bakes leave out the exterior fill, so the box bounds the map. `--message`, the map's long
name, defaults to the licence's Title. Any other argument is the polish's: `--player-height`,
say, or `--up-hint`.
"""

import argparse
import os
import sys

import numpy as np
from scipy.ndimage import uniform_filter

from . import (bake_map, deliver_map, export, frames, levelshot, package_map, polish, sfm,
               sog_inspect, train, write_arena, write_ent)
from . import splat_map as sm

#: The floor the polish leaves is at y = 0; splats this close to it, in metres, are floor.
FLOOR_BAND_M = 0.1

#: The floor's density is counted in cells of this many units, and summed over this many
#: cells a side: 80 units, room for the player's 30 with some to spare.
FLOOR_CELL, FLOOR_WINDOW = 16, 5

#: The seed's height above the floor, in units: a metre, in the open air a player stands in.
SEED_Z = sm.UNITS_PER_METRE

#: The intermission rises half the open space above the spawn's eye, at most this many units,
#: and looks this far along +X.
INTERMISSION_RISE, LOOK_AHEAD = 64, 128


def floor_patch(points):
    """The middle of the most densely captured patch of floor, (x, y) in Q3 units. `points` are
    solid splats in the polished frame: metres, +Y up, the floor at y = 0."""
    floor = points[np.abs(points[:, 1]) < FLOOR_BAND_M]
    if len(floor) == 0:
        sys.exit("ERROR: no splats lie on the polished floor")
    x = floor[:, 0] * sm.UNITS_PER_METRE
    y = -floor[:, 2] * sm.UNITS_PER_METRE
    x0, y0 = x.min(), y.min()
    nx, ny = int((x.max() - x0) // FLOOR_CELL) + 1, int((y.max() - y0) // FLOOR_CELL) + 1
    counts, _, _ = np.histogram2d(x, y, bins=(nx, ny), range=((x0, x0 + nx * FLOOR_CELL),
                                                             (y0, y0 + ny * FLOOR_CELL)))
    density = uniform_filter(counts, FLOOR_WINDOW, mode="constant")
    i, j = np.unravel_index(np.argmax(density), density.shape)
    return round(float(x0 + (i + 0.5) * FLOOR_CELL)), round(float(y0 + (j + 0.5) * FLOOR_CELL))


def headroom(octree, x, y, z, limit):
    """How far open space reaches straight up from (x, y, z), in units, up to `limit`."""
    s = octree.voxel_units()
    rise = 0
    while rise < limit:
        if octree.sim_box_solid_cells((x - 1, y - 1, z + rise), (x + 1, y + 1, z + rise + s)):
            break
        rise += s
    return min(rise, limit)


def starter_readings(octree, x, y):
    """The starter entities at (x, y), as `viewpos` readings for `write_ent`: the spawn, the
    intermission and what it looks at."""
    foot = SEED_Z
    drop = octree.sim_drop((x + sm.PLAYER_MINS[0], y + sm.PLAYER_MINS[1], foot),
                           (x + sm.PLAYER_MAXS[0], y + sm.PLAYER_MAXS[1],
                            foot + sm.PLAYER_MAXS[2] - sm.PLAYER_MINS[2]))
    if drop is None:
        sys.exit(f"ERROR: nothing solid lies under the seed at ({x}, {y}): place the entities by "
                 "hand (docs/maps.md, step 4)")
    eye = foot - drop - sm.PLAYER_MINS[2] + sm.DEFAULT_VIEWHEIGHT
    camera = eye + headroom(octree, x, y, eye, 2 * INTERMISSION_RISE) // 2

    def reading(px, pz):
        return f"({sm.fmt_num(px)} {sm.fmt_num(y)} {sm.fmt_num(pz)}) : 0"

    return reading(x, eye), reading(x, camera), reading(x + LOOK_AHEAD, eye)


def main(argv=None, prog=None):
    ap = argparse.ArgumentParser(
        prog=prog, description="Make a map from a video: every stage, with starter entities.",
        epilog="Any other argument is the polish's.")
    ap.add_argument("video")
    ap.add_argument("stem", help="the map's name, lowercase letters, digits and _")
    ap.add_argument("metric_height", metavar="metric_height_m",
                    help="the polish's scale reference: the real floor-to-ceiling height in "
                         "metres, or with --outdoor, the floor to the capture's top")
    ap.add_argument("--license", required=True,
                    help="the capture's credit, as the polish takes it: a file, or \"Title: ...; "
                         "Author: ...; Source: <link>; License URL: <link>\"")
    ap.add_argument("--author", required=True, help="who made the map, for the pk3's readme")
    ap.add_argument("--box", required=True,
                    help="the map's corners in Q3 units, x0,y0,z0,x1,y1,z1, about the plan's "
                         "centre with the floor at z 0; the bakes cut what lies outside it")
    ap.add_argument("--outdoor", action="store_true",
                    help="a capture with no ceiling and no hull: the polish scales to its top, "
                         "and the bakes leave out the exterior fill")
    ap.add_argument("--crop", action="store_true", help="the bakes' --crop: draw only the box")
    ap.add_argument("--cluster", action="store_true",
                    help="the bakes' --cluster: draw only the capture's main cluster")
    ap.add_argument("--decimate", metavar="N|N%",
                    help="the bakes' --decimate: merge the drawn splat down to N splats, or N%%")
    ap.add_argument("--message", help="the map's long name (default the licence's Title)")
    ap.add_argument("--data", default="data", help="where the capture's folder goes (default data)")
    ap.add_argument("--fps", default="1.5", help="frames a second (default 1.5)")
    ap.add_argument("--width", default="1920", help="frame width in pixels (default 1920)")
    ap.add_argument("--min-sharpness", default=str(frames.MIN_SHARPNESS),
                    help="set aside frames under this fraction of the median sharpness "
                         f"(default {frames.MIN_SHARPNESS}; 0 keeps every frame)")
    ap.add_argument("--cap-max", default="1000000", help="the most splats (default 1000000)")
    ap.add_argument("--max-steps", default="30000", help="training steps (default 30000)")
    ap.add_argument("--port", default=deliver_map.DEFAULT_PORT,
                    help=f"the port's checkout (default {deliver_map.DEFAULT_PORT})")
    ap.add_argument("--replace", action="store_true",
                    help="replace a delivered pk3 of the same name whose bytes differ")
    args, extra = ap.parse_known_args(argv)
    sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)

    # Everything a later stage would refuse, refused before the hours of training.
    if not sm.STEM_RE.match(args.stem):
        sys.exit(f"ERROR: {args.stem!r} is not a map name: 1 to 44 lowercase letters, digits "
                 "and _")
    dataset = os.path.join(args.data, args.stem)
    if os.path.isdir(dataset) and os.listdir(dataset):
        sys.exit(f"ERROR: {dataset} is not empty. Remove it, or name the map otherwise")
    licence = polish.read_license(polish.given_license(args.license).decode("utf-8"))
    missing = [k for k in polish.NEEDED if not licence.get(k)]
    if missing:
        sys.exit(f"ERROR: --license gives no {', '.join(missing)}")
    message = args.message or licence["title"]
    try:
        bake_map.filter_box(args.box)
        if args.decimate:
            bake_map.decimate_value(args.decimate)
    except ValueError as e:
        sys.exit(f"ERROR: {e}")
    frames.find_ffmpeg()
    sfm.find_colmap()
    train.find_trainer()
    try:
        sm.require_splat_transform()
    except sm.FormatError as e:
        sys.exit(f"ERROR: {e}")
    deliver_map.maps_folder(args.port)

    folder = os.path.join(dataset, "map")
    sog = os.path.join(folder, f"{args.stem}.sog")
    ent = os.path.join(folder, f"{args.stem}.ent")
    octree = os.path.join(folder, f"{args.stem}.voxel.json")

    outdoor = ["--outdoor"] if args.outdoor else []
    bounds = [f"--box={args.box}", *outdoor, *(["--crop"] if args.crop else []),
              *(["--cluster"] if args.cluster else []),
              *([f"--decimate={args.decimate}"] if args.decimate else [])]

    def stage(n, name, module, stage_argv):
        print(f"\n########## all {n}/12: {name}", flush=True)
        module.main([str(a) for a in stage_argv], prog=f"{prog or 'all'}: {name}")

    stage(1, "frames", frames, [args.video, dataset, "--fps", args.fps, "--width", args.width,
                                "--min-sharpness", args.min_sharpness])
    stage(2, "sfm", sfm, [dataset])
    stage(3, "train", train, [dataset, "--cap-max", args.cap_max, "--max-steps", args.max_steps])
    stage(4, "export", export, [dataset, "--name", args.stem])
    os.makedirs(folder, exist_ok=True)
    trained = os.path.join(dataset, train.RESULTS, f"{args.stem}.sog")
    stage(5, "polish", polish, [trained, sog, args.metric_height, "--license", args.license,
                                "--up-hint", "0,0,1", *outdoor, *extra])
    solid, _, _ = sog_inspect.load_sog(sog, opacity_cutoff=sog_inspect.DEFAULT_OPACITY,
                                       max_points=2_000_000)
    x, y = floor_patch(solid)
    stage(6, "bake, from a seed over the floor", bake_map,
          [sog, "--seed", f"{x},{y},{SEED_Z}", *bounds])
    print("\n########## all 7/12: starter entities", flush=True)
    spawn, camera, look_at = starter_readings(sm.Octree.load(octree), x, y)
    write_ent.main([ent, "--message", message, "--spawn", spawn, "--intermission", camera,
                    "--look-at", look_at, "--octree", octree], prog=f"{prog or 'all'}: entities")
    stage(8, "bake again, from the spawn", bake_map, [sog, *bounds])
    stage(9, "levelshot", levelshot, [sog])
    stage(10, "arena", write_arena, [os.path.join(folder, f"{args.stem}.arena"), "--ent", ent])
    stage(11, "package", package_map, [sog, "--author", args.author])
    stage(12, "deliver", deliver_map, [os.path.join(folder, f"map-{args.stem}.pk3"),
                                       "--port", args.port, *(["--replace"] if args.replace else [])])
    print(f"\nDone: {args.stem} is in the port. Its entities are starters: place the real ones as "
          "docs/maps.md step 4 does, then run its steps 5-9 again.")


if __name__ == "__main__":
    main()
