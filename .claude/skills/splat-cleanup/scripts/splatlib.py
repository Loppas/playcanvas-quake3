"""What the clean-up scripts must agree on: a splat as the rows of one PLY, its quantities in Q3
units, and a camera placed as the port places the player's view.

The work's splat is `cleanup.ply`: splat-transform's own decode of the map's SOG, with a `row`
column numbering its rows and a `c_<filter>` column, 0 or 1, marking what each standard filter
removes. splat-transform carries every column through its filters and keeps the rows in order, so a
filter's output names the rows it kept, and a render leaves a filter's rows out with
`--filter-value c_<filter>,eq,0`.
"""

import json
import os
import subprocess

import numpy as np
from PIL import Image

from splat_maps import levelshot
from splat_maps import splat_map as sm

#: `f_dc` to colour: the zeroth band's constant.
SH_C0 = 0.28209479177387814
#: Render sizes: a view at the port's 16:9, and a panorama at the 2:1 an equirect needs. Both stay
#: within the 1024 x 1024 a render keeps its splats at (splat-maps/docs/conventions.md).
VIEW_SIZE = (960, 540)
PANORAMA_SIZE = (1024, 512)
#: A render with more background than this lost its splats, or faces out of the capture.
LOST = 0.95
#: `row` is a float32 column, exact for whole numbers below 2^24.
MAX_ROWS = 1 << 24


def read_ply(path):
    """A binary little-endian PLY of float properties: its property names, and its rows as an
    (n, k) float32 array."""
    with open(path, "rb") as fh:
        header = b""
        while not header.endswith(b"end_header\n"):
            line = fh.readline()
            if not line:
                raise ValueError(f"{path}: no end_header")
            header += line
        lines = header.decode("ascii").splitlines()
        if "format binary_little_endian 1.0" not in lines:
            raise ValueError(f"{path}: not a binary little-endian PLY")
        n = next(int(l.split()[2]) for l in lines if l.startswith("element vertex"))
        props = [l.split() for l in lines if l.startswith("property")]
        if any(p[1] != "float" for p in props):
            raise ValueError(f"{path}: a property is not a float")
        names = [p[2] for p in props]
        data = np.fromfile(fh, np.float32, n * len(names)).reshape(n, len(names))
    return names, data


def write_ply(path, names, data):
    """Writes rows of float properties as a binary little-endian PLY."""
    head = (f"ply\nformat binary_little_endian 1.0\nelement vertex {len(data)}\n"
            + "".join(f"property float {n}\n" for n in names) + "end_header\n")
    with open(path, "wb") as fh:
        fh.write(head.encode("ascii"))
        np.ascontiguousarray(data, np.float32).tofile(fh)


class Splat:
    """A PLY's rows, and what the scripts measure of them, in Q3 units."""

    def __init__(self, path):
        self.names, self.data = read_ply(path)

    def col(self, name):
        return self.data[:, self.names.index(name)]

    def pos(self):
        """Centres, in Q3 units."""
        return np.stack(sm.world_to_sim((self.col("x"), self.col("y"), self.col("z"))), 1)

    def axes(self):
        """Each Gaussian's three standard deviations, in units, in its own axis order."""
        return np.exp(self.data[:, [self.names.index(f"scale_{k}") for k in range(3)]]) * sm.UNITS_PER_METRE

    def opacity(self):
        return 1 / (1 + np.exp(-self.col("opacity")))

    def quat(self):
        """Unit quaternions, w first."""
        q = self.data[:, [self.names.index(f"rot_{k}") for k in range(4)]].astype(np.float64)
        return q / np.linalg.norm(q, axis=1, keepdims=True)

    def colour(self):
        """The view-independent colour, 0 to 1."""
        return 0.5 + SH_C0 * self.data[:, [self.names.index(f"f_dc_{k}") for k in range(3)]]


def splat_transform():
    """The pinned splat-transform; raises if another version is on PATH."""
    return sm.require_splat_transform()


def run(cmd):
    """Runs splat-transform, raising with its output when it fails."""
    proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if proc.returncode != 0:
        raise RuntimeError(f"{' '.join(cmd[:3])} ... failed:\n{proc.stdout[-2000:]}{proc.stderr[-2000:]}")
    return proc.stdout + proc.stderr


def _flag(v):
    return ",".join(f"{c:.6f}" for c in v)


def camera(eye, angles, panorama=False):
    """splat-transform's camera flags for an eye at `eye`, Q3 units, facing `angles`, (pitch, yaw,
    roll) in degrees as `viewpos` and the entities give them. A view is the port's: 73.74 degrees
    tall, near plane `r_znear` (levelshot.py). A panorama is level, its centre column at the yaw.
    The rasteriser's camera is in the octree's frame, so everything goes through `sim_to_octree`."""
    if panorama:
        angles = (0.0, angles[1], 0.0)
    forward, up = levelshot.angle_vectors(angles)

    def direction(v):
        d = np.array(sm.sim_to_octree(v))
        return d / np.linalg.norm(d)

    pos = np.array(sm.sim_to_octree(eye))
    flags = ["--camera-pos", _flag(pos), "--camera-target", _flag(pos + direction(forward)),
             "--camera-up", _flag(direction(up)),
             "--camera-near", sm.fmt_num(levelshot.ZNEAR_UNITS / sm.UNITS_PER_METRE)]
    if panorama:
        return flags + ["--projection", "equirect", "--resolution", "%dx%d" % PANORAMA_SIZE]
    return flags + ["--camera-fov", f"{levelshot.FOV_Y:.6f}", "--resolution", "%dx%d" % VIEW_SIZE]


def render(src, flags, out, actions=()):
    """Renders `src`, a .sog or .ply, after splat-transform `actions` on it, to `out` (.png, or
    .jpg to save space). Returns the frame as an (h, w, 3) int array, and the share of it that is
    background, as the levelshot counts it."""
    webp = os.path.splitext(out)[0] + ".webp"
    run([splat_transform(), "-w", "-q", src, *actions, *flags, "--background", "0,0,0,1", webp])
    img = Image.open(webp).convert("RGB")
    img.save(out, quality=92)
    os.remove(webp)
    frame = np.asarray(img, np.int32)
    return frame, float(background(frame).mean())


def background(frame):
    """The pixels a render left as background: summed channels under 12, as the levelshot's check."""
    return frame.sum(2) < 12


#: A pixel has changed between two renders when a channel moves more than this, of 255.
CHANGE = 24


def changed(a, b):
    return np.abs(a - b).max(2) > CHANGE


def panorama_angles(col, row, yaw, size=PANORAMA_SIZE):
    """The view angles (pitch, yaw) through a panorama's pixel, for a panorama centred on `yaw`.
    Measured on 3.1.6 against views: yaw rises leftward from the centre column, as Q3's does, and
    the top row looks straight up."""
    w, h = size
    return (row + 0.5) * 180 / h - 90, (yaw + (w / 2 - (col + 0.5)) * 360 / w) % 360


def load_views(path):
    """A views file: a JSON list of {"name", "eye": [x, y, z], "angles": [pitch, yaw, roll]}."""
    with open(path, encoding="utf-8") as fh:
        views = json.load(fh)
    for v in views:
        if len(v["eye"]) != 3 or len(v["angles"]) != 3:
            raise ValueError(f"{path}: view {v.get('name')!r} needs eye and angles of three")
    return views


def bake_of(sog):
    """The bake's record beside the SOG, `<stem>.bake.json`: its box (`box_sim`, Q3 units), its
    seed in the octree's frame (`seed_octree`) and its voxel (`voxel_units`)."""
    stem = sm.stem_of(sog, ".sog")
    with open(os.path.join(os.path.dirname(os.path.abspath(sog)), f"{stem}.bake.json"), encoding="utf-8") as fh:
        bake = json.load(fh)
    if not bake.get("box_sim"):
        raise ValueError(f"{stem}.bake.json records no box: bake the map with --box first")
    return bake


def removed(ply, n, actions, work):
    """Which of the `n` rows of `ply` splat-transform's `actions` remove, as a bool array: the
    actions run to a PLY in `work`, whose `row` column names the rows they kept. Also returns
    splat-transform's log."""
    out = os.path.join(work, "_filtered.ply")
    log = run([splat_transform(), "-w", ply, *actions, out])
    names, data = read_ply(out)
    os.remove(out)
    gone = np.ones(n, bool)
    gone[data[:, names.index("row")].astype(np.int64)] = False
    return gone, log


def removal(splat, work, name):
    """The rows a removal takes, by name: a try's (`<work>/try/<name>.npy`), or else a census
    column's (`c_<name>`)."""
    path = os.path.join(work, "try", f"{name}.npy")
    if os.path.exists(path):
        return np.load(path)
    if f"c_{name}" not in splat.names:
        raise ValueError(f"{name!r} is neither a try in {os.path.join(work, 'try')} nor a census column")
    return splat.col(f"c_{name}") > 0


def fmt_point(p):
    return " ".join(sm.fmt_num(round(float(c), 1)) for c in p)
