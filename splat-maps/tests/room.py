"""A tiny splat map, the test room, built by the tests and never committed.

Its octree is written in splat-transform's layout, as `src/sim/voxel-svo.ts` documents it, from
a grid of cells laid out by hand, so the scripts' reader is held to the format and not to itself.
The splat is a SOG bundle holding only the `meta.json` the lint opens.
"""

import io
import json
import math
import re
import struct
import subprocess
import sys
import warnings
import zipfile
from pathlib import Path

import numpy as np

SOLID_LEAF_MARKER = 0xFF000000
GENERATOR = "splat-transform v3.1.6"

#: The room's octree: 0.25 m voxels, 8 units, from this corner in the octree's frame (metres).
VOXEL_M = 0.25
GRID_MIN = (-2.0, -4.0, -2.0)


def room_grid(hole=False):
    """The room's cells, a bool array [x, y, z] in the octree's frame, True for solid.

    Sim voxel (vx, vy, vz) is cell (7 - vx, 15 - vz, 7 - vy), so the room spans sim x and y
    [-64, 64) and z [-192, 128):
      - a floor one voxel thick, its top at z 0, with open space under it down to -192;
      - a step one voxel high on the floor, over x [-32, -8) and y [32, 64): three voxels by
        four, so its block is not the same in x and z;
      - a solid cube over x and y [32, 64) and z [64, 96), one whole block of 4 x 4 x 4;
      - a solid chunk under the floor, over x and y [0, 64) and z [-192, -128): eight blocks,
        so solid a level above the leaves;
      - with `hole`, a gap in the floor over x and y [-64, -32), into the space under it.
    Outside the grid is solid.
    """
    g = np.zeros((16, 40, 16), dtype=bool)
    g[:, 16, :] = True
    g[9:12, 15, 0:4] = True
    g[0:4, 4:8, 0:4] = True
    g[0:8, 32:40, 0:8] = True
    if hole:
        g[12:16, 16, 12:16] = False
    return g


def encode_octree(grid, voxel_m=VOXEL_M, grid_min=GRID_MIN, generator=GENERATOR):
    """`grid`'s cells as a `.voxel.json` header and `.voxel.bin` bytes.

    Blocks of 4 x 4 x 4 cells are the leaves: absent when open, `SOLID_LEAF_MARKER` when solid,
    and otherwise a mixed leaf, an index into the leaf data's pairs of 32-bit words, whose bit
    `lx + 4 ly + 16 lz` is a solid cell. An interior node is `(childMask << 24) | firstChild`, its
    children stored together in octant order, octant `x + 2y + 4z`. Breadth first, root at 0.
    """
    blocks = [n // 4 for n in grid.shape]
    depth = max(1, math.ceil(math.log2(max(blocks))))

    def leaf(bx, by, bz):
        if bx >= blocks[0] or by >= blocks[1] or bz >= blocks[2]:
            return None
        cells = grid[bx * 4:bx * 4 + 4, by * 4:by * 4 + 4, bz * 4:bz * 4 + 4]
        if cells.all():
            return "solid"
        if not cells.any():
            return None
        mask = 0
        for lx, ly, lz in zip(*np.nonzero(cells)):
            mask |= 1 << int(lx + 4 * ly + 16 * lz)
        return mask

    def subtree(level, bx, by, bz):
        if level == 0:
            return leaf(bx, by, bz)
        half = 1 << (level - 1)
        children = []
        for octant in range(8):
            child = subtree(level - 1, bx + half * (octant & 1), by + half * (octant >> 1 & 1),
                            bz + half * (octant >> 2 & 1))
            if child is not None:
                children.append((octant, child))
        if len(children) == 8 and all(c == "solid" for _, c in children):
            return "solid"
        return children or None

    nodes, leaf_data, interior, mixed = [None], [], 0, 0
    queue = [(0, subtree(depth, 0, 0, 0))]
    while queue:
        index, node = queue.pop(0)
        if node == "solid":
            nodes[index] = SOLID_LEAF_MARKER
        elif isinstance(node, list):
            interior += 1
            mask = 0
            first = len(nodes)
            for octant, child in node:
                mask |= 1 << octant
                queue.append((len(nodes), child))
                nodes.append(None)
            nodes[index] = (mask << 24) | first
        else:
            mixed += 1
            nodes[index] = len(leaf_data) // 2
            leaf_data += [node & 0xFFFFFFFF, node >> 32]

    grid_max = [grid_min[i] + grid.shape[i] * voxel_m for i in range(3)]
    header = {
        "version": "1.1", "asset": {"generator": generator},
        "gridBounds": {"min": list(grid_min), "max": grid_max},
        "sceneBounds": {"min": list(grid_min), "max": grid_max},
        "voxelResolution": voxel_m, "leafSize": 4, "treeDepth": depth,
        "numInteriorNodes": interior, "numMixedLeaves": mixed,
        "nodeCount": len(nodes), "leafDataCount": len(leaf_data),
    }
    return header, np.array(nodes + leaf_data, dtype="<u4").tobytes()


ENT = """\
// entity 0
{
"classname" "worldspawn"
"message" "Test Room"
"_pcq_format" "0"
}
// entity 1
{
"classname" "info_player_deathmatch"
"origin" "0 0 24"
"angle" "90"
"spawnflags" "1"
}
// entity 2
{
"classname" "info_player_intermission"
"origin" "0 -32 100"
"target" "view"
}
// entity 3
{
"classname" "target_position"
"targetname" "view"
"origin" "0 0 24"
}
"""

ARENA = '{\nmap "room"\nlongname "Test Room"\ntype "ffa team"\n}\n'

POLISH = {
    "_pcq_polish": "--metric-height 3.0 --player-height 1.8 --up-hint 0,-1,0",
    "_pcq_scale": "1.00000000",
    "_pcq_splat_transform": "3.1.6",
    "_pcq_source": "Test Room by Nobody, https://example.com/scene/1",
    "_pcq_license": "CC-BY-4.0",
    "license": {
        "title": "Test Room",
        "author": "Nobody (https://example.com/user/1)",
        "source": "https://example.com/scene/1",
        "license url": "http://creativecommons.org/licenses/by/4.0/",
    },
    "errors": [],
    "warnings": [],
}

BAKE = {
    "_pcq_bake": "--voxel-size 0.25 --voxel-external-fill 0.125 --voxel-carve 0.75,0.125 "
                 "--seed-pos 0,0,0 --collision-mesh smooth",
    "_pcq_splat_transform": "3.1.6",
    "errors": [],
    "warnings": [],
}


def sog_bytes(meta=None):
    """A SOG bundle holding only its `meta.json`."""
    meta = meta if meta is not None else {"version": 2, "count": 1,
                                          "asset": {"generator": GENERATOR}}
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("meta.json", json.dumps(meta))
    return buf.getvalue()


def tga_bytes():
    """A levelshot as `R_LevelShot` writes one: 128 x 128, 24-bit, uncompressed."""
    head = bytearray(18)
    head[2], head[12], head[14], head[16] = 2, 128, 128, 24
    return bytes(head) + bytes(128 * 128 * 3)


def write_room(folder, stem="room"):
    """The room's parts in `folder`, named as the map steps name them; returns the `.sog`."""
    folder = Path(folder)
    folder.mkdir(parents=True, exist_ok=True)
    header, raw = encode_octree(room_grid())
    (folder / f"{stem}.sog").write_bytes(sog_bytes())
    (folder / f"{stem}.voxel.json").write_text(json.dumps(header, indent=2), encoding="utf-8")
    (folder / f"{stem}.voxel.bin").write_bytes(raw)
    (folder / f"{stem}.ent").write_bytes(ENT.encode("ascii"))
    (folder / f"{stem}.arena").write_bytes(ARENA.replace('"room"', f'"{stem}"').encode("ascii"))
    (folder / f"{stem}.tga").write_bytes(tga_bytes())
    (folder / f"{stem}.polish.json").write_text(json.dumps(POLISH, indent=2), encoding="utf-8")
    (folder / f"{stem}.bake.json").write_text(json.dumps(BAKE, indent=2), encoding="utf-8")
    return folder / f"{stem}.sog"


def run_cli(*args):
    """Run the CLI in its own process; returns its exit code and its output."""
    run = subprocess.run([sys.executable, "-m", "splat_maps", *map(str, args)],
                         capture_output=True, text=True, encoding="utf-8")
    return run.returncode, run.stdout + run.stderr


def read_pk3(path):
    """A pk3's entries in order, as [name, bytes, method]."""
    with zipfile.ZipFile(path) as z:
        return [[i.filename, z.read(i), i.compress_type] for i in z.infolist()]


def write_pk3(path, entries, zip64=(), comment=b""):
    """Entries as `read_pk3` gives them; those named in `zip64` carry an empty zip64 block in
    their extra field. A name given twice is written twice, as the lint's L1 is tested with."""
    with warnings.catch_warnings(), zipfile.ZipFile(path, "w") as z:
        warnings.simplefilter("ignore", UserWarning)
        for name, data, method in entries:
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = method
            if name in zip64:
                info.extra = struct.pack("<HH", 1, 0)
            z.writestr(info, data)
        z.comment = comment


def lint_failures(output):
    """The rules the lint's report failed, as {("ERR" or "warn", "L<n>")}."""
    return {(mark.strip(), rule)
            for mark, rule in re.findall(r"^  (ERR |warn) (L\d+)", output, re.M)}
