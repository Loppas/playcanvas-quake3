"""Bake a splat map's collision, sized in Quake units, and re-measure what was written.

The bake is splat-transform's own voxel writer. What this adds is the sizing and the checking
(`map-format.md` §6.1):
  1. the voxel is a whole number of units, at most 13, chosen per map (default 8);
  2. `--voxel-carve` is derived from it, for the largest box that fits the crouched player,
     30 x 40 units, so the carve never seals a space the player could crouch through;
  3. `--voxel-external-fill` is the smallest reach that seals the capture's hull, found by
     baking and bisecting. The less the fill dilates, the more of the outside it fills: a large
     reach also seals the ring of reconstruction spill around the room, and the voids inside
     that ring (under the floor, behind the walls) then count as inside;
  4. the seed is given in Q3 units, as `viewpos` prints them, or taken from the map's first
     spawn spot, and converted to the octree's frame.

Then it loads the octree back and measures it: the port's own structural checks, whether
splat-transform skipped a step (a leak skips the exterior fill without an error), every spawn
spot in the `.ent` if there is one, the floor as the player will walk it, and everywhere the
player's box can get to. The record, `<stem>.bake.json`, carries `_pcq_bake` for the package
and the measurements.

Usage:
    python bake_map.py <map.sog> [--voxel 8] [--fill auto|UNITS] [--seed x,y,z] [--ent FILE]
                       [--mesh smooth|faces] [--out-dir DIR]

Outputs, beside the .sog unless --out-dir is given: <stem>.voxel.json, <stem>.voxel.bin,
<stem>.collision.glb, <stem>.bake.json and <stem>.bake.log (splat-transform's own output).
Requires numpy, and splat-transform at the pinned version on PATH (Node >= 24).
"""

import argparse
import json
import math
import os
import re
import shutil
import struct
import subprocess
import sys
import time

import numpy as np

import splat_map as sm

#: The largest reach the fill search tries, in units: the standing player's height
#: (bg_public.h:50-51). At an 8-unit voxel it is the 7-voxel dilation of splat-transform's
#: 1.6 m default, which the shipped garage bake used, and it seals hull holes under 112 units.
DEFAULT_FILL_UNITS = sm.PLAYER_MAXS[2] - sm.PLAYER_MINS[2]

#: splat-transform's only sign of a leak. It is logged as information, and the octree is
#: written anyway with the whole outside left open (cli.mjs `fillExterior`).
LEAK = "seed reachable from outside, skipping exterior fill"

#: What splat-transform prints when it skips a step instead of failing (cli.mjs `carve`,
#: `fillExterior`). Each one leaves an octree that looks fine and plays wrong.
SKIPPED = {
    LEAK:
        "LEAK: the seed is reachable from outside the capture, so the exterior fill was skipped. "
        "Raise --fill until the hull seals, or check the seed is inside the room",
    "seed outside grid bounds, skipping exterior fill":
        "the seed lies outside the capture, so the exterior fill was skipped",
    "outside grid, skipping carve": "the seed lies outside the capture, so the carve was skipped",
    "skipping carve": "the seed is walled in, so the carve was skipped",
    "no navigable cells remain": "the carve left no open space at all",
}

#: The band either side of the polished floor (sim z = 0) in which the floor is looked for, in
#: units. The polish puts the fitted floor plane at z = 0 (sog_inspect.py).
FLOOR_BAND = 48


def main():
    ap = argparse.ArgumentParser(description="Bake a splat map's collision in Quake units.")
    ap.add_argument("sog", help="the delivered, polished map .sog (metres, Y up, floor at 0)")
    ap.add_argument("--voxel", type=float, default=8,
                    help="voxel edge in Quake units: whole, 1 to 13 (default 8)")
    ap.add_argument("--fill", default="auto",
                    help="external fill reach in units, sealing hull holes narrower than twice "
                         "this; or auto (the default), the smallest reach that seals, found by "
                         f"baking, up to {DEFAULT_FILL_UNITS}")
    ap.add_argument("--seed", help="a point in the room's open air, in Q3 units, as viewpos "
                                   "prints it: x,y,z. Default: the .ent's first spawn spot")
    ap.add_argument("--ent", help="the map's entity text (default <stem>.ent beside the .sog, "
                                  "if it exists); its spawn spots are checked after the bake")
    ap.add_argument("--mesh", default="smooth", choices=("smooth", "faces"),
                    help="the debug overlay's shape (default smooth)")
    ap.add_argument("--out-dir", help="where to write (default beside the .sog)")
    args = ap.parse_args()
    sys.stdout.reconfigure(line_buffering=True, encoding="utf-8")

    auto = args.fill == "auto"
    try:
        exe = sm.require_splat_transform()
        v = args.voxel
        sizes = sm.bake_sizes(v, DEFAULT_FILL_UNITS if auto else float(args.fill))
    except (sm.FormatError, ValueError) as e:
        sys.exit(f"ERROR: {e}")
    v = int(v)

    stem = sm.stem_of(args.sog, ".sog")
    out_dir = args.out_dir or os.path.dirname(os.path.abspath(args.sog))
    os.makedirs(out_dir, exist_ok=True)
    out_json = os.path.join(out_dir, f"{stem}.voxel.json")

    ent_path = args.ent or os.path.join(os.path.dirname(os.path.abspath(args.sog)), f"{stem}.ent")
    entities = None
    if os.path.exists(ent_path):
        with open(ent_path, "rb") as fh:
            try:
                entities, _ = sm.parse_entities(fh.read())
            except sm.FormatError as e:
                sys.exit(f"ERROR: {ent_path}: {e}")
    elif args.ent:
        sys.exit(f"ERROR: not found: {args.ent}")

    # The seed: the carve's box is centred on its cell, so put it where a spawned player's
    # crouch box would be centred, feet on the floor.
    box_w, box_h = sizes["carve_box_units"]
    if args.seed:
        seed_sim = tuple(float(c) for c in args.seed.split(","))
        seed_from = "--seed"
    else:
        spots = sm.spawn_spots(entities) if entities else []
        if not spots:
            sys.exit("ERROR: no seed. Give --seed x,y,z in Q3 units (a point in the room's open "
                     "air, as viewpos prints it), or an .ent with a spawn spot")
        ox, oy, oz = spots[0].vector("origin")
        seed_sim = (ox, oy, oz + sm.SPAWN_RAISE + sm.PLAYER_MINS[2] + box_h / 2)
        seed_from = f"{os.path.basename(ent_path)}'s first spawn spot"
    seed_oct = sm.sim_to_octree(seed_sim)

    print(f"=== baking {args.sog}")
    print(f"  voxel {v} units ({sm.fmt_num(sizes['voxel_m'])} m)")
    print(f"  carve box {box_w:g} x {box_h:g} units, within the crouched player's "
          f"{sm.CARVE_LIMIT_UNITS[0]} x {sm.CARVE_LIMIT_UNITS[1]}")
    print(f"  seed sim ({', '.join(sm.fmt_num(c) for c in seed_sim)}) from {seed_from}, "
          f"octree ({', '.join(sm.fmt_num(c) for c in seed_oct)})")

    def flags_for(s):
        return ["--voxel-size", sm.fmt_num(s["voxel_m"]),
                "--voxel-external-fill", sm.fmt_num(s["fill_m"]),
                "--voxel-carve", f"{sm.fmt_num(s['carve_h_m'])},{sm.fmt_num(s['carve_r_m'])}",
                "--seed-pos", ",".join(sm.fmt_num(c) for c in seed_oct),
                "--collision-mesh", args.mesh]

    def bake(s, where):
        """One splat-transform run into `where`: (its output, seconds, whether it leaked)."""
        os.makedirs(where, exist_ok=True)
        cmd = [exe, "-w", "--no-tty", *flags_for(s), args.sog,
               os.path.join(where, f"{stem}.voxel.json")]
        print(f"  splat-transform {' '.join(cmd[1:])}")
        t0 = time.time()
        proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                              text=True, encoding="utf-8", errors="replace")
        with open(os.path.join(where, f"{stem}.bake.log"), "w", encoding="utf-8") as log:
            log.write(proc.stdout)
        if proc.returncode != 0:
            print(proc.stdout[-3000:])
            sys.exit(f"ERROR: splat-transform failed ({proc.returncode}); see {where}")
        return proc.stdout, time.time() - t0, LEAK in proc.stdout

    trail = []
    if not auto:
        print(f"  external fill {sizes['fill_voxels']} voxels: seals hull holes under "
              f"{sizes['fill_seals_under_units']} units")
        text, seconds, leaked = bake(sizes, out_dir)
        trail.append({"fill_units": float(args.fill), "leaked": leaked,
                      "seconds": round(seconds, 1)})
    else:
        # The smallest reach that seals. The less the fill dilates, the more of the outside it
        # fills, and a reach that seals the room's own hull never enters the room. Leaking only
        # stops as the reach grows, so bisect over whole voxels.
        top = sizes["fill_voxels"]
        print(f"  external fill: the smallest reach from 1 to {top} voxels that seals the hull")
        search = os.path.join(out_dir, f"{stem}.fill-search")
        results = {}

        def seals(k):
            if k not in results:
                s = sm.bake_sizes(v, k * v)
                where = os.path.join(search, f"k{k}")
                text_k, sec_k, leaked_k = bake(s, where)
                results[k] = (s, where, text_k, sec_k, leaked_k)
                trail.append({"fill_units": k * v,
                              "seals_under_units": s["fill_seals_under_units"],
                              "leaked": leaked_k, "seconds": round(sec_k, 1)})
                print(f"    {k} voxels ({k * v} units): {'leaks' if leaked_k else 'seals'}, "
                      f"{sec_k:.0f} s")
            return not results[k][4]

        lo, hi = 1, top
        while lo < hi:
            mid = (lo + hi) // 2
            if seals(mid):
                hi = mid
            else:
                lo = mid + 1
        if not seals(lo):
            shutil.rmtree(search, ignore_errors=True)
            sys.exit(f"ERROR: LEAK: the hull does not seal even at {top * v} units of fill, so "
                     f"some hole in the capture is at least {2 * top * v} units wide. Find it "
                     "in the collision overlay, or pass a larger --fill to accept it")
        sizes, where, text, seconds, leaked = results[lo]
        for suffix in (".voxel.json", ".voxel.bin", ".collision.glb", ".bake.log"):
            src_f = os.path.join(where, stem + suffix)
            if os.path.exists(src_f):
                os.replace(src_f, os.path.join(out_dir, stem + suffix))
        shutil.rmtree(search, ignore_errors=True)
        print(f"  external fill {lo} voxels ({lo * v} units): seals hull holes under "
              f"{sizes['fill_seals_under_units']} units")
    flags = flags_for(sizes)
    log_path = os.path.join(out_dir, f"{stem}.bake.log")
    print(f"  baked in {seconds:.1f} s; log {log_path}")

    # ---------------------------------------------------------------- re-measure
    print("\n=== re-measuring what was written")
    errors, warnings = [], []
    for needle, meaning in SKIPPED.items():
        if needle in text:
            errors.append(meaning)

    try:
        octree = sm.Octree.load(out_json)
    except sm.FormatError as e:
        sys.exit(f"ERROR: the octree does not load as the port loads it: {e}")
    stats = octree.validate()
    errors += stats["problems"]
    try:
        octree.cells_from_origin()
    except sm.FormatError as e:
        errors.append(f"the port refuses this bake: {e}")
    if abs(octree.voxel_units() - v) > 1e-9:
        errors.append(f"voxelResolution is {octree.voxel_units()} units, not {v}")
    got_box = sm.carve_box_units(sizes["carve_h_m"], sizes["carve_r_m"], sizes["voxel_m"])
    if got_box[0] > sm.CARVE_LIMIT_UNITS[0] or got_box[1] > sm.CARVE_LIMIT_UNITS[1]:
        errors.append(f"carve box {got_box} exceeds {sm.CARVE_LIMIT_UNITS}")

    grid = octree.dense()
    s = octree.voxel_units()
    free = int((~grid).sum())
    shape_units = [n * s for n in octree.shape]
    print(f"  grid {octree.shape[0]} x {octree.shape[1]} x {octree.shape[2]} voxels "
          f"({shape_units[0]:g} x {shape_units[2]:g} x {shape_units[1]:g} units, x y z in sim)")
    print(f"  {stats['interior']:,} interior nodes, {stats['mixed']:,} mixed leaves, "
          f"{stats['solid']:,} solid leaves; tree checks "
          f"{'pass' if not stats['problems'] else 'FAIL'}")
    print(f"  open space {free:,} voxels ({free * (s / sm.UNITS_PER_METRE) ** 3:,.0f} m^3)")

    # The seed: the carve starts from the nearest open cell within 2 max(k, j) voxels of it,
    # and says nothing when it moves it (cli.mjs `carve`).
    k, j = sizes["carve_voxels"]
    search = 2 * max(k, j)
    c = [int(math.floor((seed_oct[i] - octree.gmin[i]) / octree.vr)) for i in range(3)]
    lo = [max(0, c[i] - search) for i in range(3)]
    hi = [min(octree.shape[i], c[i] + search + 1) for i in range(3)]
    window = ~grid[lo[0]:hi[0], lo[1]:hi[1], lo[2]:hi[2]] if all(lo[i] < hi[i] for i in range(3)) \
        else np.zeros((0, 0, 0), bool)
    if not window.any():
        errors.append("no open cell near the seed survives the bake")
    else:
        pts = np.argwhere(window) + np.array(lo)
        d = np.abs(pts - np.array(c)).max(axis=1).min()
        print(f"  nearest open cell to the seed: {int(d)} voxels away")

    # The glb: a well-formed glTF 2.0 binary whose positions sit inside the grid.
    glb_path = out_json.replace(".voxel.json", ".collision.glb")
    glb = measure_glb(glb_path, octree)
    if glb.get("error"):
        errors.append(glb["error"])
    else:
        print(f"  collision.glb: {glb['triangles']:,} triangles, inside the grid")

    spawns = sm.judge_spawns(octree, entities) if entities else []
    for sp in spawns:
        box = "free" if sp["solid_voxels"] == 0 else f"IN SOLID ({sp['solid_voxels']} voxels)"
        print(f"  spawn at ({', '.join(sm.fmt_num(c) for c in sp['origin'])}): box {box}"
              f", drop {sp['drop'] if sp['drop'] is not None else 'bottomless'} units, "
              f"landing {sp['landing']}")
        if sp["solid_voxels"]:
            errors.append(f"spawn at {sp['origin']} is in solid (L20)")
        if sp["landing"] == "hurts":
            errors.append(f"spawn at {sp['origin']} drops {sp['drop']} units and lands hurt (L21)")
        elif sp["landing"] == "thuds":
            warnings.append(f"spawn at {sp['origin']} drops {sp['drop']} units and thuds (L21)")

    floor = measure_floor(octree)
    print_floor(floor, s)

    # Where the player can get to: from the first spawn spot, or else from the seed.
    if spawns:
        o = spawns[0]["origin"]
        foot = (o[0] + sm.PLAYER_MINS[0], o[1] + sm.PLAYER_MINS[1],
                o[2] + sm.SPAWN_RAISE + sm.PLAYER_MINS[2])
    else:
        crouch_h = sm.CROUCH_MAXS_Z - sm.PLAYER_MINS[2]
        foot = (seed_sim[0] + sm.PLAYER_MINS[0], seed_sim[1] + sm.PLAYER_MINS[1],
                seed_sim[2] - crouch_h / 2)
    reach = measure_reach(octree, foot)
    if reach is None:
        errors.append("the player's box fits nowhere near the start")
    else:
        print(f"  the crouched player's box reaches {reach['positions']:,} positions: feet "
              f"{reach['feet_min']:g} to {reach['feet_max']:g}, x {reach['x'][0]:g} to "
              f"{reach['x'][1]:g}, y {reach['y'][0]:g} to {reach['y'][1]:g}")
        if reach["under_floor"]:
            warnings.append(f"the player can get {reach['under_floor']:,} box positions under the "
                            f"floor (feet below -{FLOOR_BAND}, lowest {reach['feet_min']:g}): the "
                            "capture has holes the player fits through")

    m = re.search(r"peak cpu=([\d.]+)(\w+) gpu=([\d.]+)(\w+)", text)
    peak = f"{m.group(1)} {m.group(2)} CPU, {m.group(3)} {m.group(4)} GPU" if m else None
    if peak:
        print(f"  splat-transform peak memory: {peak}")

    sizes_out = {n: os.path.getsize(p) for n, p in (
        ("voxel.json", out_json), ("voxel.bin", out_json[:-5] + ".bin"),
        ("collision.glb", glb_path))
        if os.path.exists(p)}
    print("  files: " + ", ".join(f"{n} {b / 1e6:.2f} MB" for n, b in sizes_out.items()))

    record = {
        "_pcq_bake": " ".join(flags),
        "_pcq_splat_transform": sm.SPLAT_TRANSFORM_VERSION,
        "input": os.path.basename(args.sog),
        "voxel_units": v,
        "carve_box_units": list(got_box),
        "fill_units": sizes["fill_voxels"] * v,
        "fill_seals_under_units": sizes["fill_seals_under_units"],
        "fill_search": trail if auto else None,
        "seed_sim": list(seed_sim),
        "seed_from": seed_from,
        "seed_octree": list(seed_oct),
        "seconds": round(seconds, 1),
        "peak_memory": peak,
        "grid_voxels": list(octree.shape),
        "open_voxels": free,
        "nodes": {k2: stats[k2] for k2 in ("interior", "mixed", "solid")},
        "bytes": sizes_out,
        "glb": glb,
        "spawns": spawns,
        "floor": floor,
        "reach": reach,
        "errors": errors,
        "warnings": warnings,
    }
    rec_path = os.path.join(out_dir, f"{stem}.bake.json")
    with open(rec_path, "w", encoding="utf-8") as fh:
        json.dump(record, fh, indent=2)
    print(f"\n  _pcq_bake \"{record['_pcq_bake']}\"")
    print(f"  wrote {rec_path}")
    for w in warnings:
        print(f"  WARNING: {w}")
    if errors:
        for e in errors:
            print(f"  ERROR: {e}")
        sys.exit(1)
    print("  the bake re-measures clean")


def measure_glb(path, octree):
    """Read the debug mesh's header and position bounds back (glTF 2.0 binary)."""
    if not os.path.exists(path):
        return {"error": f"{os.path.basename(path)} was not written"}
    with open(path, "rb") as fh:
        data = fh.read()
    magic, version, length = struct.unpack_from("<4sII", data, 0)
    if magic != b"glTF" or version != 2 or length != len(data):
        return {"error": f"{os.path.basename(path)} is not a glTF 2.0 binary of its own length"}
    jlen, jtype = struct.unpack_from("<I4s", data, 12)
    gltf = json.loads(data[20:20 + jlen])
    tris, lo, hi = 0, [math.inf] * 3, [-math.inf] * 3
    for mesh in gltf.get("meshes", []):
        for prim in mesh["primitives"]:
            acc = gltf["accessors"][prim["attributes"]["POSITION"]]
            lo = [min(a, b) for a, b in zip(lo, acc["min"])]
            hi = [max(a, b) for a, b in zip(hi, acc["max"])]
            if "indices" in prim:
                tris += gltf["accessors"][prim["indices"]]["count"] // 3
    # The smooth mesh's vertices can sit up to half a voxel outside the grid; allow one.
    eps = octree.vr * 1.001
    inside = all(lo[i] >= octree.gmin[i] - eps and hi[i] <= octree.gmax[i] + eps for i in range(3))
    out = {"triangles": tris, "min": lo, "max": hi}
    if not inside:
        out["error"] = (f"collision.glb bounds {lo}..{hi} leave the grid "
                        f"{octree.gmin}..{octree.gmax}")
    return out


def measure_reach(octree, foot):
    """The crouched player's reachable space, summarised (Octree.player_reach)."""
    r = octree.player_reach(foot, FLOOR_BAND)
    if r is None:
        return None
    return {
        "positions": r["positions"],
        "box_voxels": list(r["box_voxels"]),
        "feet_min": r["feet"][0], "feet_max": r["feet"][1],
        "x": list(r["x"]), "y": list(r["y"]),
        "under_floor": r["under"],
    }


def measure_floor(octree):
    """The floor as the player walks it, from the octree alone.

    In each sim column (one voxel square), the floor is the top of the highest solid voxel
    within FLOOR_BAND units of the polished floor (sim z = 0) that has crouch room, 40 units,
    open above it. The player's 30-unit box rests on the highest of the columns under it, so
    the height it stands at is the maximum over its footprint of ceil(30/s) columns square.
    Moving the box one column, the rise is what the player meets: a rise of 2 or less raises
    no step event, one of up to 18 is a step up that the view smooths over 200 ms, and more is
    a wall (bg_slidemove.c:319-329; cg_view.c:299-306).
    """
    from scipy import ndimage as ndi

    s = octree.voxel_units()
    g = octree.dense()
    # Reorder to sim axes: octree x = -sim x, octree y = -sim z, octree z = -sim y. Flip so
    # index 0 is the lowest sim coordinate, then sim z increases along the last axis.
    sim = np.transpose(g, (0, 2, 1))[::-1, ::-1, ::-1]
    gx, gy, gz = octree.cells_from_origin()
    # sim voxel index of array index 0 along each axis: octree cell c = -v - g0 - 1, and
    # array index a = n - 1 - c, so v = a - n - g0 ... solve for a = 0.
    nx, ny, nz = sim.shape
    vx0 = -(nx - 1) - gx - 1
    vy0 = -(ny - 1) - gz - 1
    vz0 = -(nz - 1) - gy - 1
    z_lo = int(math.floor(-FLOOR_BAND / s)) - vz0
    z_hi = int(math.ceil(FLOOR_BAND / s)) - vz0
    z_lo, z_hi = max(z_lo, 0), min(z_hi, nz - 1)
    room = int(math.ceil((sm.CROUCH_MAXS_Z - sm.PLAYER_MINS[2]) / s))
    top = np.full((nx, ny), np.nan)
    for a in range(z_hi, z_lo - 1, -1):
        if a + room >= nz:
            continue
        solid_here = sim[:, :, a]
        open_above = ~sim[:, :, a + 1:a + 1 + room].any(axis=2)
        hit = solid_here & open_above & np.isnan(top)
        top[hit] = (a + vz0 + 1) * s
    have = ~np.isnan(top)
    if not have.any():
        return {"columns": 0}
    w = int(math.ceil((sm.PLAYER_MAXS[0] - sm.PLAYER_MINS[0]) / s))
    support = ndi.maximum_filter(np.where(have, top, -np.inf), size=(w, w),
                                 origin=(-(w // 2), -(w // 2)), mode="constant", cval=-np.inf)
    rises = []
    for axis in (0, 1):
        a = np.take(support, range(0, support.shape[axis] - 1), axis=axis)
        b = np.take(support, range(1, support.shape[axis]), axis=axis)
        both = np.isfinite(a) & np.isfinite(b)
        rises.append(np.abs(a[both] - b[both]))
    r = np.concatenate(rises)
    n = len(r)
    flat = int((r == 0).sum())
    quiet = int(((r > 0) & (r <= sm.STEP_EVENT_MIN)).sum())
    steps = int(((r > sm.STEP_EVENT_MIN) & (r <= sm.STEPSIZE)).sum())
    walls = int((r > sm.STEPSIZE).sum())
    heights = top[have]
    # Walking a straight line moves the box across 100/s columns per 100 units; about half the
    # steps are rises in the direction of travel.
    per100 = (steps / n) / 2 * (100 / s) if n else 0.0
    stepping = r[(r > sm.STEP_EVENT_MIN) & (r <= sm.STEPSIZE)]
    climb100 = float(stepping.sum()) / n / 2 * (100 / s) if n else 0.0
    # the event each step raises: under 7 is EV_STEP_4, under 11 EV_STEP_8, under 15
    # EV_STEP_12, else EV_STEP_16 (bg_slidemove.c:319-329)
    events = {f"EV_STEP_{e}": int(((stepping >= lo) & (stepping < hi)).sum())
              for e, lo, hi in ((4, 0, 7), (8, 7, 11), (12, 11, 15), (16, 15, 99))}
    return {
        "columns": int(have.sum()),
        "area_m2": round(float(have.sum()) * (s / sm.UNITS_PER_METRE) ** 2, 1),
        "height_units": {"p5": float(np.percentile(heights, 5)),
                         "median": float(np.median(heights)),
                         "p95": float(np.percentile(heights, 95))},
        "neighbour_pairs": n,
        "flat": flat, "quiet": quiet, "steps": steps, "walls": walls,
        "step_ups_per_100_units": round(per100, 2),
        "units_climbed_per_100_units": round(climb100, 2),
        "step_events": events,
    }


def print_floor(f, s):
    if not f.get("columns"):
        print(f"  floor: none found within {FLOOR_BAND} units of z = 0")
        return
    h = f["height_units"]
    n = f["neighbour_pairs"]
    print(f"  floor: {f['columns']:,} columns ({f['area_m2']:,} m^2) within {FLOOR_BAND} units "
          f"of z = 0; height p5 {h['p5']:g}, median {h['median']:g}, p95 {h['p95']:g}")
    print(f"    moving the player's box one column: {f['flat'] / n:.1%} level, "
          f"{f['quiet'] / n:.1%} a quiet "
          f"rise (<= {sm.STEP_EVENT_MIN}), {f['steps'] / n:.1%} a step (<= {sm.STEPSIZE}), "
          f"{f['walls'] / n:.1%} a wall")
    print(f"    about {f['step_ups_per_100_units']} step-ups per 100 units walked, climbing "
          f"{f['units_climbed_per_100_units']} units; steps by event: "
          + ", ".join(f"{k} {v}" for k, v in f["step_events"].items() if v))


if __name__ == "__main__":
    main()
