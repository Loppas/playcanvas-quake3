"""A tiny capture for the polish, built by the tests and never committed.

A SOG bundle of a box room's six faces, written in the encoding `sog_inspect.load_sog` reads.
The room is already level, square and in metres, its floor at y = 0 and its plan centred, so
the polish's transform is all but none, and a copy of the bundle stands in for applying it.
"""

import io
import json
import zipfile

import numpy as np
from PIL import Image

#: The room in metres: 4 wide (x), 2.5 from floor to ceiling (y), 5 deep (z).
ROOM = (4.0, 2.5, 5.0)

#: superspl.at's `license.txt`, as a capture from there carries it.
LICENCE = (b"Title: Test Room\nAuthor: A Capturer (a note)\nSource: https://example.com/room\n"
           b"License: CC BY 4.0\nLicense URL: https://creativecommons.org/licenses/by/4.0/\n")


def room_centres(count=40_000, seed=0):
    """`count` points over the room's faces, each face's share by its area, 2 mm of noise."""
    rng = np.random.default_rng(seed)
    w, h, d = ROOM
    # Each face: the axis it is flat on, where, and its area.
    faces = [(1, 0.0, w * d), (1, h, w * d), (0, -w / 2, h * d), (0, w / 2, h * d),
             (2, -d / 2, w * h), (2, d / 2, w * h)]
    areas = np.array([a for _, _, a in faces])
    face = rng.choice(len(faces), count, p=areas / areas.sum())
    pts = rng.uniform((-w / 2, 0.0, -d / 2), (w / 2, h, d / 2), (count, 3))
    for i, (axis, at, _) in enumerate(faces):
        pts[face == i, axis] = at
    return pts + rng.normal(0.0, 0.002, pts.shape)


def webp(rgba, width=256):
    """An (N, 4) uint8 array as lossless WebP, in rows of `width`, the last padded."""
    rows = -(-len(rgba) // width)
    padded = np.zeros((rows * width, 4), np.uint8)
    padded[:len(rgba)] = rgba
    out = io.BytesIO()
    Image.fromarray(padded.reshape(rows, width, 4), "RGBA").save(out, "WEBP", lossless=True,
                                                                  exact=True)
    return out.getvalue()


def write_capture(path, licence=None):
    """The room's SOG at `path`, with `licence` as its `license.txt` if given; returns `path`."""
    pts = room_centres()
    n = len(pts)
    # Positions are stored log-scaled, as 16 bits split over two planes.
    v = np.sign(pts) * np.log1p(np.abs(pts))
    mins, maxs = v.min(0), v.max(0)
    q = np.round((v - mins) / (maxs - mins) * 65535).astype(np.uint16)
    lo = np.full((n, 4), 255, np.uint8)
    hi = np.full((n, 4), 255, np.uint8)
    lo[:, :3] = q & 0xFF
    hi[:, :3] = q >> 8
    # Every splat opaque: its alpha indexes the codebook's last logit.
    sh0 = np.zeros((n, 4), np.uint8)
    sh0[:, 3] = 255
    meta = {"version": 2, "count": n,
            "means": {"mins": mins.tolist(), "maxs": maxs.tolist(),
                      "files": ["means_l.webp", "means_u.webp"]},
            "sh0": {"codebook": np.linspace(-6.0, 6.0, 256).tolist(), "files": ["sh0.webp"]},
            "asset": {"generator": "the tests"}}
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("meta.json", json.dumps(meta))
        z.writestr("means_l.webp", webp(lo))
        z.writestr("means_u.webp", webp(hi))
        z.writestr("sh0.webp", webp(sh0))
        if licence is not None:
            z.writestr("license.txt", licence)
    return path
