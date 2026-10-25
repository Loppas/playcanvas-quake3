"""Which splats draw a patch of a view, composited as the rasteriser draws them, and what they are.

    python attribute.py <work dir> <views.json> <view> x0,y0,x1,y1 [--top 40] [--without box,<try>]

The view is splatlib.camera's, at splatlib.VIEW_SIZE, and the patch is in its pixels, x0,y0 its
top left. Each splat is projected as its screen-space Gaussian (EWA: its covariance through the
projection's Jacobian, plus a 0.3-pixel blur), and the splats are composited front to back by
centre depth at every pixel of the patch: a splat's share of a pixel is its alpha there, opacity
times e^(-d²/2) capped at 0.99, times the light those in front of it leave. `--without` leaves out
those removals, census columns or tries, so the attribution sees the map as they would leave it.

Prints the `--top` splats by their share of the patch, with their row, centre (Q3 units), axes
(units, longest first), opacity and colour, and a summary of them; writes them to
`<work>/attribute/<view>.json`, the view with the patch outlined to `<view>.png`, and the view
drawn with those splats alone to `<view>.top.png`.
"""

import argparse
import json
import math
import os

import numpy as np
from PIL import Image, ImageDraw

import splatlib as sl
from splat_maps import levelshot

#: The file's axes to Q3's, without the scale (splat_map.world_to_sim): x, -z, y.
FILE_TO_Q3 = np.array([[1, 0, 0], [0, 0, -1], [0, 1, 0]], float)
TILE = 16
#: A splat whose centre projects further out than this many half-frames is not drawn: 3DGS's
#: `in_frustum` band, which the composite check below holds splat-transform to.
GUARD = 1.3


def rotations(q):
    """Rotation matrices of unit quaternions, w first."""
    w, a, b, c = q.T
    R = np.empty((len(q), 3, 3))
    R[:, 0] = np.stack([1 - 2 * (b * b + c * c), 2 * (a * b - c * w), 2 * (a * c + b * w)], 1)
    R[:, 1] = np.stack([2 * (a * b + c * w), 1 - 2 * (a * a + c * c), 2 * (b * c - a * w)], 1)
    R[:, 2] = np.stack([2 * (a * c - b * w), 2 * (b * c + a * w), 1 - 2 * (a * a + b * b)], 1)
    return R


def composite(s, view, patch, keep):
    """The kept splats of `s` composited over `patch` of `view`. Returns the rows that reach the
    patch, each one's summed share of its pixels, the patch's composite of base colours, an
    (h, w, 3) array from 0 to 1, and the share of the patch they cover."""
    x0, y0, x1, y1 = patch
    W, H = sl.VIEW_SIZE
    F = (H / 2) / math.tan(math.radians(levelshot.FOV_Y / 2))
    forward, up = (np.array(v) for v in levelshot.angle_vectors(view["angles"]))
    V = np.stack([np.cross(forward, up), up, forward])
    cam = (s.pos() - np.array(view["eye"], float)) @ V.T
    z = cam[:, 2]
    axes = s.axes()
    # A splat reaches the patch only if its centre lies within three of its longest axes, projected,
    # and within the guard band round the frame, past which the rasteriser drops a splat.
    reach = 3 * axes.max(1) * F / np.maximum(z, 1e-6)
    with np.errstate(divide="ignore", invalid="ignore"):
        px = W / 2 + F * cam[:, 0] / z
        py = H / 2 - F * cam[:, 1] / z
    band = (np.abs(px - W / 2) < GUARD * W / 2) & (np.abs(py - H / 2) < GUARD * H / 2)
    cand = np.flatnonzero(keep & (z > levelshot.ZNEAR_UNITS) & band & (px + reach > x0) & (px - reach < x1)
                          & (py + reach > y0) & (py - reach < y1))
    R = rotations(s.quat()[cand])
    cov = np.einsum("nij,nj,nkj->nik", R, axes[cand] ** 2, R)
    cov = np.einsum("ij,njk,lk->nil", V @ FILE_TO_Q3, cov, V @ FILE_TO_Q3)
    cx, cy, cz = cam[cand].T
    J = np.zeros((len(cand), 2, 3))
    J[:, 0, 0], J[:, 0, 2] = F / cz, -F * cx / cz ** 2
    J[:, 1, 1], J[:, 1, 2] = -F / cz, F * cy / cz ** 2
    cov2 = np.einsum("nij,njk,nlk->nil", J, cov, J) + np.eye(2) * 0.3
    inv = np.linalg.inv(cov2).astype(np.float32)
    mu = np.stack([px[cand], py[cand]], 1).astype(np.float32)
    ext = 3 * np.sqrt(np.stack([cov2[:, 0, 0], cov2[:, 1, 1]], 1))
    op = s.opacity()[cand].astype(np.float32)
    base = np.clip(s.colour()[cand], 0, 1).astype(np.float32)
    order = np.argsort(cz)

    share = np.zeros(len(cand))
    covered = 0.0
    image = np.zeros((y1 - y0, x1 - x0, 3), np.float32)
    for ty in range(y0, y1, TILE):
        for tx in range(x0, x1, TILE):
            gx, gy = np.meshgrid(np.arange(tx, min(tx + TILE, x1)) + 0.5, np.arange(ty, min(ty + TILE, y1)) + 0.5)
            P = np.stack([gx.ravel(), gy.ravel()], 1).astype(np.float32)
            o = order[(mu[order, 0] + ext[order, 0] > P[:, 0].min()) & (mu[order, 0] - ext[order, 0] < P[:, 0].max())
                      & (mu[order, 1] + ext[order, 1] > P[:, 1].min()) & (mu[order, 1] - ext[order, 1] < P[:, 1].max())]
            if not len(o):
                continue
            d = P[None, :, :] - mu[o, None, :]
            m = np.einsum("cpi,cij,cpj->cp", d, inv[o], d)
            alpha = np.minimum(0.99, op[o, None] * np.exp(-0.5 * m))
            alpha[alpha < 1 / 255] = 0
            light = np.cumprod(np.vstack([np.ones((1, len(P)), np.float32), 1 - alpha[:-1]]), 0)
            part = alpha * light
            share[o] += part.sum(1)
            covered += part.sum()
            image[ty - y0:ty - y0 + gy.shape[0], tx - x0:tx - x0 + gx.shape[1]] = \
                (part.T @ base[o]).reshape(gy.shape[0], gx.shape[1], 3)
    return cand, share, image, covered / ((x1 - x0) * (y1 - y0))


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("work")
    ap.add_argument("views")
    ap.add_argument("view")
    ap.add_argument("patch")
    ap.add_argument("--top", type=int, default=40)
    ap.add_argument("--without", default="", help="removals to leave out: census columns or tries")
    args = ap.parse_args()
    view = next(v for v in sl.load_views(args.views) if v["name"] == args.view)
    x0, y0, x1, y1 = (int(c) for c in args.patch.split(","))
    out = os.path.join(args.work, "attribute")
    os.makedirs(out, exist_ok=True)
    s = sl.Splat(os.path.join(args.work, "cleanup.ply"))
    without = [c for c in args.without.split(",") if c]
    keep = np.ones(len(s.data), bool)
    for c in without:
        keep &= ~sl.removal(s, args.work, c)

    cand, share, image, covered = composite(s, view, (x0, y0, x1, y1), keep)
    total = max(share.sum(), 1e-9)
    top = np.argsort(-share)[:args.top]
    rows = cand[top]
    pos, opacity = s.pos(), s.opacity()
    srt = -np.sort(-s.axes()[rows], 1)
    colour = s.colour()[rows]
    cols = [n for n in s.names if n.startswith("c_")]
    splats = [{"row": int(r), "share": round(float(share[t] / total), 4), "centre": [round(float(c), 1) for c in pos[r]],
               "axes": [round(float(a), 2) for a in srt[k]], "opacity": round(float(opacity[r]), 3),
               "colour": [round(float(c), 2) for c in colour[k]], "marked": [c[2:] for c in cols if s.col(c)[r]]}
              for k, (t, r) in enumerate(zip(top, rows))]
    summary = {"patch_pixels": (x1 - x0) * (y1 - y0), "patch_covered": round(covered, 3),
               "candidates": int(len(cand)), "top_share": round(float(share[top].sum() / total), 3),
               "opacity_p50": round(float(np.median(opacity[rows])), 3),
               "axes_p50": [round(float(a), 2) for a in np.median(srt, 0)],
               "flatness_p50": round(float(np.median(srt[:, 2] / srt[:, 1])), 3),
               "marked": {c[2:]: int(s.col(c)[rows].sum()) for c in cols},
               "z_range": [round(float(pos[rows, 2].min()), 1), round(float(pos[rows, 2].max()), 1)]}
    print(f"{view['name']} patch {args.patch}: {len(cand):,} splats reach it; it is {100 * covered:.0f}% covered")
    print(f"the top {len(rows)} carry {100 * summary['top_share']:.0f}% of it: opacity p50 {summary['opacity_p50']}, "
          f"axes p50 {summary['axes_p50']} units, flatness (short/middle) p50 {summary['flatness_p50']}, "
          f"centres z {summary['z_range'][0]:g} to {summary['z_range'][1]:g}, marked {summary['marked']}")
    for sp in splats[:12]:
        print(f"  row {sp['row']:>8}  {100 * sp['share']:5.1f}%  at ({sl.fmt_point(sp['centre'])})  axes {sp['axes']}  "
              f"opacity {sp['opacity']}  colour {sp['colour']}  {' '.join(sp['marked'])}")

    flags = sl.camera(view["eye"], view["angles"])
    frames = {}
    for name, sel in (("", keep), (".top", rows)):
        part = os.path.join(out, "_part.ply")
        sl.write_ply(part, s.names, s.data[sel])
        frames[name], _ = sl.render(part, flags, os.path.join(out, f"{view['name']}{name}.png"))
        os.remove(part)
    # The check on the model: its composite of base colours against the rasteriser's own pixels.
    error = float(np.abs(frames[""][y0:y1, x0:x1] - 255 * image).mean())
    summary["composite_error"] = round(error, 1)
    print(f"check: the composite of base colours is {error:.1f} levels of 255 from the render, on the mean"
          + ("; above 12, so the model misses what the rasteriser draws here" if error > 12 else ""))
    img = Image.open(os.path.join(out, f"{view['name']}.png"))
    ImageDraw.Draw(img).rectangle((x0, y0, x1, y1), outline=(255, 230, 0), width=2)
    img.save(os.path.join(out, f"{view['name']}.png"))
    with open(os.path.join(out, f"{view['name']}.json"), "w", encoding="utf-8") as fh:
        json.dump({"view": view, "patch": [x0, y0, x1, y1], "without": without, "summary": summary, "splats": splats}, fh, indent=1)


if __name__ == "__main__":
    main()
