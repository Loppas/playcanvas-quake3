"""Write a splat map's entity text from `viewpos` readings, applying the placement rules.

`viewpos` prints the view's origin and yaw in Q3 units, `(x y z) : yaw` (cg_consolecmds.c:80-84).
A reading is not yet an entity. `map-format.md` §3.4's rules turn it into one:
  - a spawn spot: stand where it goes and take 26 from z, the standing view height
    (`DEFAULT_VIEWHEIGHT`, bg_public.h:52), so its box rests on the floor; the yaw is its angle;
  - the intermission point: the reading as it is, since at intermission the view origin is the
    entity's origin (cg_view.c:641-646). Frame it at cg_fov 90;
  - what the intermission looks at: a `target_position` at a second reading, as it is, which the
    intermission point targets. `viewpos` prints no pitch, and the game aims the camera from the
    two points (g_main.c:974-981).

Paste the readings as `viewpos` prints them. The file is written with a comment above each
entity naming the reading it came from, then read back by Q3's rules. Given the bake, each spawn
and the intermission point are checked in the octree as the lint checks them (L20-L22).

Usage:
    splat-maps entities readings <stem>.ent --message "The Garage" --spawn "(-4 -4 69) : 0"
                                 [--spawn ...] --intermission "(1056 2016 868) : 242"
                                 --look-at "(0 0 100) : 0" [--octree <stem>.voxel.json]

The first spawn gets spawnflags 1, the spot a local player's first spawn prefers
(g_client.c:308-333). The _pcq_* keys are left out: package_map writes them.
"""

import argparse
import math
import os
import re
import sys

from . import splat_map as sm

READING = re.compile(r"^\s*\(\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*\)"
                     r"\s*:\s*(-?\d+(?:\.\d+)?)\s*$")


def reading(text):
    """`(x y z) : yaw`, as viewpos prints it, to four numbers."""
    m = READING.match(text)
    if not m:
        raise argparse.ArgumentTypeError(f"not a viewpos reading, (x y z) : yaw: {text!r}")
    return tuple(float(g) for g in m.groups())


def num(v):
    return sm.fmt_num(v)


def main(argv=None, prog=None):
    ap = argparse.ArgumentParser(
        prog=prog, description="Write a splat map's .ent from viewpos readings.")
    ap.add_argument("out", help="the file to write, <stem>.ent")
    ap.add_argument("--message", required=True, help="the map's long name, worldspawn's message")
    ap.add_argument("--spawn", type=reading, action="append", default=[],
                    help="a viewpos reading taken standing where a spawn spot goes, "
                         '"(x y z) : yaw"')
    ap.add_argument("--intermission", type=reading, required=True,
                    help="a viewpos reading of the intermission and levelshot camera")
    ap.add_argument("--look-at", type=reading, required=True,
                    help="a viewpos reading at the point the intermission camera faces")
    ap.add_argument("--octree", help="the map's <stem>.voxel.json, to check the spots in it")
    args = ap.parse_args(argv)
    sys.stdout.reconfigure(encoding="utf-8")
    if not args.spawn:
        sys.exit("ERROR: at least one --spawn: every spawn path in Q3 falls back to one "
                 "(g_client.c:238-249)")

    entities, notes = [], []
    entities.append([("classname", "worldspawn"), ("message", args.message)])
    notes.append("")
    for i, (x, y, z, yaw) in enumerate(args.spawn):
        pairs = [("classname", "info_player_deathmatch"),
                 ("origin", f"{num(x)} {num(y)} {num(z - sm.DEFAULT_VIEWHEIGHT)}"),
                 ("angle", num(yaw))]
        if i == 0:
            pairs.append(("spawnflags", "1"))
        entities.append(pairs)
        notes.append(f"spawn from viewpos ({num(x)} {num(y)} {num(z)}) : {num(yaw)}, z less "
                     f"{sm.DEFAULT_VIEWHEIGHT}")
    ix, iy, iz, iyaw = args.intermission
    lx, ly, lz, _ = args.look_at
    entities.append([("classname", "info_player_intermission"),
                     ("origin", f"{num(ix)} {num(iy)} {num(iz)}"), ("target", "intermission_view")])
    notes.append(f"intermission camera from viewpos ({num(ix)} {num(iy)} {num(iz)}) : {num(iyaw)}")
    entities.append([("classname", "target_position"), ("targetname", "intermission_view"),
                     ("origin", f"{num(lx)} {num(ly)} {num(lz)}")])
    notes.append(f"what the intermission camera faces, "
                 f"from viewpos ({num(lx)} {num(ly)} {num(lz)})")

    try:
        text = sm.format_entities(entities, notes)
    except sm.FormatError as e:
        sys.exit(f"ERROR: {e}")
    with open(args.out, "w", encoding="ascii", newline="\n") as fh:
        fh.write(text)

    # Read it back, and check it in the octree if there is one.
    errors, warnings = [], []
    with open(args.out, "rb") as fh:
        back, _ = sm.parse_entities(fh.read())
    if [e.pairs for e in back] != entities:
        errors.append("the file does not read back as written")
    if args.octree:
        octree = sm.Octree.load(args.octree)
        for sp in sm.judge_spawns(octree, back):
            where = " ".join(num(c) for c in sp["origin"])
            if sp["solid_voxels"]:
                errors.append(f"spawn ({where}) is in solid (L20)")
            elif sp["landing"] == "hurts":
                errors.append(f"spawn ({where}) drops {sp['drop']} units and lands hurt (L21)")
            elif sp["landing"] == "thuds":
                warnings.append(f"spawn ({where}) drops {sp['drop']} units and thuds (L21)")
            else:
                print(f"  spawn ({where}): free, drops {sp['drop']} units, lands silent")
        s = octree.voxel_units()
        cell = octree.sim_voxel_to_cell(*(math.floor(c / s) for c in (ix, iy, iz)))
        if octree.is_solid_cell(*cell):
            errors.append("the intermission point is in a solid voxel (L22)")
        else:
            print("  the intermission point is open")
    print(text, end="")
    print(f"wrote {args.out}")
    for w in warnings:
        print(f"WARNING: {w}")
    if errors:
        for e in errors:
            print(f"ERROR: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
