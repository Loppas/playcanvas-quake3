"""Turn a splat map's collision mesh into a reference model for a Q3 map editor.

The bake's `<stem>.collision.glb` is in the octree's frame: metres, the world turned 180 degrees
about Z (`map-format.md` §6). NetRadiant-custom and its q3map2 load every model through assimp and
turn it from Y up to Z up, `(x, y, z)` to `(x, -z, y)`, with no scale (`plugins/assmodel/
model.cpp:678-682`, `tools/quake3/q3map2/model.cpp:325-329`, at tag 20260114). That turn is the
port's own world-to-sim one without its factor of 32, so this writes the mesh as a Wavefront OBJ
in the world frame scaled to units, `(-32x, -32y, 32z)` from the octree's `(x, y, z)`. A
`misc_model` at the origin with no rotation then shows the collision where the player meets it,
`sim = (-32x, -32z, -32y)`. The map is laid out around it, and `map_to_ent.py` keeps the point
entities and drops the reference.

Both turns are proper rotations, so the glb's counter-clockwise winding is kept, and the loaders'
winding flip makes it Q3's clockwise.

Then it reads the OBJ back, applies the loaders' turn, and measures the result: vertex and face
counts, bounds, and where the mesh's floor sits against the octree's under a given point.

Usage:
    python glb_to_editor.py <stem>.collision.glb [--out <stem>_collision.obj] [--probe x,y,z]
"""

import argparse
import json
import os
import struct
import sys

import numpy as np

import splat_map as sm


def read_glb(path):
    """Positions (N, 3 float32) and triangle indices (M, 3) of a single-primitive glTF binary."""
    with open(path, "rb") as fh:
        data = fh.read()
    magic, version, length = struct.unpack_from("<4sII", data, 0)
    if magic != b"glTF" or version != 2 or length != len(data):
        raise sm.FormatError(f"{path} is not a glTF 2.0 binary")
    jlen, _ = struct.unpack_from("<I4s", data, 12)
    gltf = json.loads(data[20:20 + jlen])
    blen, btype = struct.unpack_from("<I4s", data, 20 + jlen)
    blob = data[28 + jlen:28 + jlen + blen]
    if btype != b"BIN\x00":
        raise sm.FormatError(f"{path} has no binary chunk")
    for node in gltf.get("nodes", []):
        if any(k in node for k in ("matrix", "rotation", "translation", "scale")):
            raise sm.FormatError(f"{path} has a node transform, which this does not apply")
    prims = [p for m in gltf["meshes"] for p in m["primitives"]]
    if len(prims) != 1:
        raise sm.FormatError(f"{path} has {len(prims)} primitives, not one")

    def accessor(i, dtype, width):
        acc = gltf["accessors"][i]
        view = gltf["bufferViews"][acc["bufferView"]]
        if view.get("byteStride") not in (None, width * np.dtype(dtype).itemsize):
            raise sm.FormatError(f"{path} interleaves its buffers, which this does not read")
        start = view.get("byteOffset", 0) + acc.get("byteOffset", 0)
        count = acc["count"] * width
        return np.frombuffer(blob, dtype=dtype, count=count, offset=start).reshape(-1, width)

    pos = accessor(prims[0]["attributes"]["POSITION"], "<f4", 3)
    component = gltf["accessors"][prims[0]["indices"]]["componentType"]
    itype = {5121: "<u1", 5123: "<u2", 5125: "<u4"}[component]
    idx = accessor(prims[0]["indices"], itype, 1).reshape(-1, 3)
    return pos, idx


def floor_hits(verts, tris, x, y):
    """The z of every triangle a vertical line through (x, y) crosses."""
    a, b, c = verts[tris[:, 0]], verts[tris[:, 1]], verts[tris[:, 2]]
    d = (b[:, 1] - c[:, 1]) * (a[:, 0] - c[:, 0]) + (c[:, 0] - b[:, 0]) * (a[:, 1] - c[:, 1])
    ok = np.abs(d) > 1e-9
    d = np.where(ok, d, 1.0)
    w1 = ((b[:, 1] - c[:, 1]) * (x - c[:, 0]) + (c[:, 0] - b[:, 0]) * (y - c[:, 1])) / d
    w2 = ((c[:, 1] - a[:, 1]) * (x - c[:, 0]) + (a[:, 0] - c[:, 0]) * (y - c[:, 1])) / d
    w3 = 1 - w1 - w2
    inside = ok & (w1 >= 0) & (w2 >= 0) & (w3 >= 0)
    return (w1 * a[:, 2] + w2 * b[:, 2] + w3 * c[:, 2])[inside]


def main():
    ap = argparse.ArgumentParser(
        description="Write a splat map's collision mesh as an editor model.")
    ap.add_argument("glb", help="the bake's <stem>.collision.glb")
    ap.add_argument("--out", help="the OBJ to write (default <stem>_collision.obj beside the glb)")
    ap.add_argument("--probe", default="-4,-4,43",
                    help="a sim point whose floor to compare with the octree's (default -4,-4,43)")
    args = ap.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")

    stem = sm.stem_of(args.glb, ".collision.glb")
    out = args.out or os.path.join(os.path.dirname(os.path.abspath(args.glb)),
                                   f"{stem}_collision.obj")
    try:
        pos, idx = read_glb(args.glb)
    except sm.FormatError as e:
        sys.exit(f"ERROR: {e}")

    u = sm.UNITS_PER_METRE
    pos = pos.astype(np.float64)
    sim = np.stack([-u * pos[:, 0], -u * pos[:, 2], -u * pos[:, 1]], axis=1)
    written = np.stack([-u * pos[:, 0], -u * pos[:, 1], u * pos[:, 2]], axis=1)
    with open(out, "w", encoding="ascii", newline="\n") as fh:
        fh.write(f"# {stem}: the collision mesh of a splat map, in Quake 3 units, Y up\n")
        fh.write(f"# from {os.path.basename(args.glb)}; "
                 "(-32x, -32y, 32z) of the octree frame, which\n")
        fh.write("# an assimp loader's turn to Z up, (x, -z, y), puts where the player meets it\n")
        fh.write(f"o {stem}_collision\n")
        fh.write("\n".join(f"v {x:.4f} {y:.4f} {z:.4f}" for x, y, z in written))
        fh.write("\n")
        fh.write("\n".join(f"f {a + 1} {b + 1} {c + 1}" for a, b, c in idx))
        fh.write("\n")

    # Read it back.
    vs, fs = [], 0
    with open(out, encoding="ascii") as fh:
        for line in fh:
            if line.startswith("v "):
                vs.append([float(t) for t in line.split()[1:4]])
            elif line.startswith("f "):
                fs += 1
    back = np.asarray(vs)
    loaded = np.stack([back[:, 0], -back[:, 2], back[:, 1]], axis=1)
    errors = []
    if len(back) != len(pos) or fs != len(idx):
        errors.append(f"read back {len(back)} vertices and {fs} faces, "
                      f"not {len(pos)} and {len(idx)}")
    worst = float(np.abs(loaded - sim).max()) if len(back) == len(sim) else float("inf")
    if worst > 1e-3:
        errors.append(f"vertices read back up to {worst} units off")
    lo, hi = loaded.min(axis=0), loaded.max(axis=0)
    print(f"=== wrote {out}")
    print(f"  {len(back):,} vertices, {fs:,} triangles; as an editor loads them, within "
          f"{worst:.4f} units of the glb in Q3's frame")
    print(f"  loaded bounds x {lo[0]:g}..{hi[0]:g}, y {lo[1]:g}..{hi[1]:g}, "
          f"z {lo[2]:g}..{hi[2]:g} (units)")

    # Where the mesh's floor sits under the probe, against the octree's floor there: a ray cast
    # straight down through the triangles, since merged faces leave few vertices near any point.
    px, py, pz = (float(c) for c in args.probe.split(","))
    vox = os.path.join(os.path.dirname(os.path.abspath(args.glb)), f"{stem}.voxel.json")
    if os.path.exists(vox):
        octree = sm.Octree.load(vox)
        foot = pz + sm.SPAWN_RAISE + sm.PLAYER_MINS[2]
        mins = (px + sm.PLAYER_MINS[0], py + sm.PLAYER_MINS[1], foot)
        maxs = (px + sm.PLAYER_MAXS[0], py + sm.PLAYER_MAXS[1], foot + 56)
        drop = octree.sim_drop(mins, maxs)
        hits = floor_hits(loaded, idx, px, py)
        below = hits[hits < foot]
        if drop is not None and len(below):
            floor, mesh_floor = foot - drop, float(below.max())
            print(f"  under ({px:g}, {py:g}): the octree's floor top is at z = {floor:g}, the "
                  f"mesh's at z = {mesh_floor:g} ({mesh_floor - floor:+g} units)")
    if errors:
        for e in errors:
            print(f"  ERROR: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
