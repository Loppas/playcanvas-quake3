"""Every patch of a splat map a player can stand on, and the survey's poses over them.

    python reach.py <map.sog> <work dir> [--spacing 96]

Reads the bake beside the SOG, `<stem>.voxel.json`, and the spawn spots of `<stem>.ent`. The
grapple and rocket jumps take a player to any place they can stand, so the survey goes to every
patch in the bake's open space that holds one (`standable`), not only to where a jump reaches.
That space is the map's inside as the bake made it: the exterior fill closed what lies outside
the capture, and the carve what the player can't get to.

Writes `<work>/poses.json`: one rest in each `spacing` cube of the patches, the one nearest the
cube's centre, as the standing eye over it; and `<work>/reach.png`, the patches from above,
brighter where their floor is higher, with the rests marked.
"""

import argparse
import json
import math
import os

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage as ndi

from splat_maps import splat_map as sm

#: A patch's ground must hold a square this many player widths on a side.
WIDTHS = 2
#: The room a patch needs above it, before a voxel more: the standing player's box.
CLEARANCE_UNITS = sm.PLAYER_MAXS[2] - sm.PLAYER_MINS[2]


def box_fit(open_, size):
    """Where a box of `size` voxels fits in the open grid, indexed by its lowest corner."""
    fit = open_.view(np.uint8)
    for axis, n in enumerate(size):
        # fit[i] covers [i, i + n), and the grid's outside counts as closed
        fit = ndi.minimum_filter1d(fit, n, axis=axis, origin=-(n // 2), mode="constant", cval=0)
    return fit.astype(bool)


def standable(open_, spawns, s):
    """The rests a player can survey from, as lattice indices [x, y, z] of the box's lowest corner,
    and the box's width in voxels, with counts of what was left out.

    A rest is where the player's box, CLEARANCE_UNITS and a voxel tall, sits on something solid.
    It must be inside: in the space the crouched box gets to from `spawns`, the spawned boxes'
    lowest corners as lattice indices. Rests a step apart join into a patch, and a patch counts when
    the ground under it holds a square WIDTHS player widths on a side, so a speck a player can
    barely stand on is left out.
    """
    foot = math.ceil((sm.PLAYER_MAXS[0] - sm.PLAYER_MINS[0]) / s)
    room, _ = ndi.label(box_fit(open_, (foot, foot, math.ceil((sm.CROUCH_MAXS_Z - sm.PLAYER_MINS[2]) / s))))
    inside = set()
    for c in spawns:
        # the lattice boxes beside the spawned box's corner, since it seldom lies on the lattice
        near = room[tuple(slice(max(0, i - 1), max(0, i + 2)) for i in c)]
        if not near.any():
            raise SystemExit(f"ERROR: no room for the box at the spawn spot whose corner is voxel {tuple(c)}")
        inside.update(np.unique(near[near > 0]).tolist())

    tall = math.ceil(CLEARANCE_UNITS / s) + 1
    stand = box_fit(open_, (foot, foot, tall))
    below = np.pad(stand, ((0, 0), (0, 0), (1, 0)))[:, :, :-1]
    rest = stand & ~below & np.isin(room, sorted(inside))
    del room, stand, below

    # each rest reaches up a step, so two rests a step apart in neighbouring columns touch
    joined = rest.copy()
    for d in range(1, int(sm.STEPSIZE // s) + 1):
        joined[:, :, d:] |= rest[:, :, :-d]
    patch, n = ndi.label(joined)
    side = math.ceil(WIDTHS * (sm.PLAYER_MAXS[0] - sm.PLAYER_MINS[0]) / s)
    keep = np.zeros(n + 1, bool)
    for i, box in enumerate(ndi.find_objects(patch), 1):
        # the patch's ground: the solid under its rests' boxes, which can overhang an edge
        ground = np.zeros((box[0].stop - box[0].start + foot, box[1].stop - box[1].start + foot), bool)
        if min(ground.shape) < side:
            continue
        x, y, z = (a + b.start for a, b in zip(np.nonzero((patch[box] == i) & rest[box]), box))
        for dx in range(foot):
            for dy in range(foot):
                # the grid's floor counts as solid
                under = (z == 0) | ~open_[x + dx, y + dy, np.maximum(z - 1, 0)]
                ground[x[under] + dx - box[0].start, y[under] + dy - box[1].start] = True
        keep[i] = ndi.binary_erosion(ground, np.ones((side, side), bool)).any()
    kept = rest & keep[patch]
    return np.argwhere(kept), foot, {"rests": int(rest.sum()), "patches": n, "kept": int(keep.sum()),
                                     "clear": tall * s}


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("sog")
    ap.add_argument("work")
    ap.add_argument("--spacing", type=float, default=96, help="a pose per cube of this side, units")
    args = ap.parse_args()
    os.makedirs(args.work, exist_ok=True)
    stem = sm.stem_of(args.sog, ".sog")
    here = os.path.dirname(os.path.abspath(args.sog))
    octree = sm.Octree.load(os.path.join(here, f"{stem}.voxel.json"))
    with open(os.path.join(here, f"{stem}.ent"), "rb") as fh:
        entities, _ = sm.parse_entities(fh.read())
    s = octree.voxel_units()
    open_, v0 = octree.sim_open()
    spawns = [[int(math.floor((o + m) / s)) - v for o, m, v in
               zip(e.vector("origin"), (sm.PLAYER_MINS[0], sm.PLAYER_MINS[1], sm.PLAYER_MINS[2] + sm.SPAWN_RAISE), v0)]
              for e in sm.spawn_spots(entities)]

    rest, foot, count = standable(open_, spawns, s)
    if not len(rest):
        raise SystemExit("ERROR: no patch to stand on")
    centre = (rest[:, :2] + np.array(v0[:2])) * s + foot * s / 2
    floor = (rest[:, 2] + v0[2]) * s
    print(f"{count['kept']} of {count['patches']} patches inside hold a square {WIDTHS} player widths on a side, "
          f"with {count['clear']:g} units clear: {len(rest):,} of their {count['rests']:,} rests, from "
          f"{len(spawns)} spawn spots; x {centre[:, 0].min():g} to {centre[:, 0].max():g}, "
          f"y {centre[:, 1].min():g} to {centre[:, 1].max():g}, floors {floor.min():g} to {floor.max():g}")

    cube = np.floor(np.column_stack([centre, floor]) / args.spacing).astype(np.int64)
    off = np.hypot(*(centre - (cube[:, :2] + 0.5) * args.spacing).T)
    poses, marks = [], []
    for k, key in enumerate(sorted(set(map(tuple, cube)))):
        i = np.flatnonzero((cube == key).all(1))
        i = i[np.argmin(off[i])]
        eye = floor[i] - sm.PLAYER_MINS[2] + sm.DEFAULT_VIEWHEIGHT
        poses.append({"name": f"p{k:03d}", "eye": [float(centre[i, 0]), float(centre[i, 1]), float(eye)],
                      "angles": [0.0, 0.0, 0.0], "floor": float(floor[i])})
        marks.append(rest[i, :2])
    with open(os.path.join(args.work, "poses.json"), "w", encoding="utf-8") as fh:
        json.dump(poses, fh, indent=1)
    print(f"{len(poses)} poses a {args.spacing:g}-unit cube apart; wrote {os.path.join(args.work, 'poses.json')}")

    nx, ny = open_.shape[:2]
    high = np.full((nx, ny), -np.inf)
    np.maximum.at(high, (rest[:, 0], rest[:, 1]), floor)
    lit = np.isfinite(high)
    level = np.zeros((nx, ny))
    level[lit] = (high[lit] - floor.min()) / max(1.0, float(floor.max() - floor.min()))
    rgb = np.zeros((nx, ny, 3), np.uint8)
    rgb[lit] = np.stack([60 + 195 * level[lit], 200 - 120 * level[lit], 90 + 0 * level[lit]], -1).astype(np.uint8)
    img = Image.fromarray(np.flipud(rgb.transpose(1, 0, 2))).resize((nx * 4, ny * 4), Image.NEAREST)
    draw = ImageDraw.Draw(img)
    for x, y in marks:
        px, py = 4 * x + 2, 4 * (ny - 1 - y) + 2
        draw.ellipse((px - 3, py - 3, px + 3, py + 3), outline=(255, 255, 255))
    img.save(os.path.join(args.work, "reach.png"))


if __name__ == "__main__":
    main()
