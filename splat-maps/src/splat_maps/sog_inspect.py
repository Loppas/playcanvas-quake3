"""Measure a trained SOG and derive the polish transform, headlessly.

A trained splat comes out of COLMAP/gsplat tilted, yawed, off-centre and at an arbitrary
scale. Correcting that has meant SuperSplat by hand (`docs/training.md`, Polish). This measures the
same things numerically and prints the `splat-transform` command that applies the fix, so
the polish stage can run from a script and be diffed between runs.

What it does:
  1. decodes the SOG's splat centres and opacities (no GPU, no browser)
  2. finds the vertical axis, then refits it on the floor plane specifically
  3. finds the yaw that squares the walls to X/Z
  4. converts to metres, if given a real-world reference
  5. writes orthographic plan/section drawings, and optionally photoreal renders,
     so the result can be checked by eye before anything is written

Nothing is modified: the input is read-only and every output lands in --out.

Usage:
    python -m splat_maps.sog_inspect <input.sog> [--out DIR] [--metric-height M] [--render]

Requires numpy + Pillow (present in the `gsplat` conda env) and, for --render,
splat-transform on PATH (Node >= 24).
"""

import argparse
import io
import json
import math
import os
import subprocess
import sys
import zipfile

import numpy as np
from PIL import Image, ImageDraw

from . import splat_map as sm

# A splat this transparent contributes almost nothing but is numerous enough to drag every
# percentile and plane fit around. Geometry is measured on the solid remainder.
DEFAULT_OPACITY = 0.3

#: Life-size player, in metres. Quake 3's bounding box is 56 units tall (MINS_Z -24 to
#: DEFAULT_HEIGHT 32) and the port runs at 32 units = 1 m (`src/coords.ts`).
PLAYER_HEIGHT_M = 1.75

#: With `--outdoor`, the capture's top is this percentile of the solid splats' heights,
#: not their highest: above a capture with no ceiling float stray splats of sky and spill, far
#: past anything in it.
TOP_PERCENTILE = 99


# --------------------------------------------------------------------------- decode


def _plane(zf, name, count):
    """One SOG attribute image as an (N, 4) uint8 array, trimmed to the splat count."""
    img = Image.open(io.BytesIO(zf.read(name))).convert("RGBA")
    return np.asarray(img).reshape(-1, 4)[:count]


def load_sog(path, opacity_cutoff=None, max_points=None, seed=0):
    """Splat centres (N, 3 float32) and linear opacities (N,) from a .sog bundle.

    The centre encoding is SOG v2's: two 8-bit planes give 16 bits per component, which
    index into the log-space range stored in meta.json. Mirrors GSplatSogIterator in the
    PlayCanvas engine — keep them in step if the format revs.

    Selection happens *before* the centres are built, and this matters. Decoding all of a
    13.9M-splat map first and filtering after needs several float32 copies of the full
    cloud at once; doing it in this order the arithmetic only ever touches the splats being
    kept. `opacity_cutoff` drops transparent haze (typically well over half a map) and
    `max_points` caps what survives, which is what keeps a big map inside a sane footprint.
    Neither changes the measurements: plane fits and histograms converge long before a
    million points.
    """
    with zipfile.ZipFile(path) as zf:
        meta = json.loads(zf.read("meta.json"))
        n = meta["count"]

        # Opacity first — one byte plane, and a 256-entry table beats a per-splat exp().
        raw = _plane(zf, "sh0.webp", n)[:, 3]
        sh0 = meta["sh0"]
        if "codebook" in sh0:
            logit = np.array(sh0["codebook"], np.float32)
        else:
            logit = sh0["mins"] + (sh0["maxs"] - sh0["mins"]) * (np.arange(256) / 255.0)
        table = (1.0 / (1.0 + np.exp(-logit))).astype(np.float32)

        keep = np.flatnonzero(table[raw] > opacity_cutoff) if opacity_cutoff else None
        if max_points is not None:
            pool = keep if keep is not None else np.arange(n)
            if len(pool) > max_points:
                picked = np.random.default_rng(seed).choice(len(pool), max_points,
                                                            replace=False)
                keep = np.sort(pool[picked])
        index = keep if keep is not None else slice(None)
        opacity = table[raw[index]]
        del raw, table

        mins = np.array(meta["means"]["mins"], np.float32)
        maxs = np.array(meta["means"]["maxs"], np.float32)
        v = _plane(zf, meta["means"]["files"][1], n)[index, :3].astype(np.float32)
        v *= 256.0
        v += _plane(zf, meta["means"]["files"][0], n)[index, :3]
        v /= 65535.0
        v *= maxs - mins
        v += mins
        centres = np.copysign(np.expm1(np.abs(v)), v)

    return centres, opacity, meta


# --------------------------------------------------------------------- plane fitting


def ransac_planes(pts, tol, count, rng, trials=400):
    """The `count` largest planar surfaces, biggest first, as (normal, offset, inliers).

    Inliers are consumed between rounds, so each plane is a different surface rather than
    `count` restatements of the floor.
    """
    work = pts.copy()
    found = []
    for _ in range(count):
        if len(work) < 2000:
            break
        best, best_n = None, 0
        for _ in range(trials):
            a, b, c = work[rng.choice(len(work), 3, replace=False)]
            nrm = np.cross(b - a, c - a)
            length = np.linalg.norm(nrm)
            if length < 1e-9:
                continue
            nrm = nrm / length
            hits = int((np.abs(work @ nrm + -nrm @ a) < tol).sum())
            if hits > best_n:
                best, best_n = (nrm, float(-nrm @ a)), hits
        if best is None:
            break
        nrm, d = best
        inl = np.abs(work @ nrm + d) < tol
        nrm, d = refit_plane(work[inl])
        found.append((nrm, d, int(inl.sum())))
        work = work[~inl]
    return found


def refit_plane(pts):
    """Least-squares plane through a point set, as (unit normal, offset).

    Via the 3x3 scatter matrix, whose smallest eigenvector is the normal. The obvious
    `np.linalg.svd(pts - centre)[2][2]` gives the same answer and is a memory bomb: numpy
    defaults to full_matrices=True, so an (N, 3) input allocates an N x N left-singular
    matrix. At a 40k-point inlier band that is 6.4 GB, which is enough to take a machine
    into swap. Nothing here needs the left singular vectors.
    """
    centre = pts.mean(0)
    centred = pts - centre
    normal = np.linalg.eigh(centred.T @ centred)[1][:, 0]   # ascending: [:, 0] is smallest
    return normal.astype(np.float32), float(-normal @ centre)


def outer_peaks(values, bins=1500, edge=0.25):
    """The bounding surfaces along one axis, as (low, high).

    The densest slab within `edge` of each end of the occupied range — for a levelled room,
    the floor and the ceiling. Two failure modes are being dodged here, both hit on the
    garage. Taking the two densest slabs overall picks the ceiling and a shelf beneath it,
    leaving the floor counted as outside the room. Taking the outermost slab above a density
    threshold picks the reconstruction spill *below* the floor instead, which is thin but
    not empty, and inflates the room by most of a metre. The floor is neither the densest
    surface nor the lowest occupied one: it is the densest thing near the bottom.

    The range is clipped to the 0.5–99.5 percentiles so a handful of stray splats cannot
    drag the search window off the building.
    """
    lo, hi = (float(v) for v in np.percentile(values, [0.5, 99.5]))
    hist, edges = np.histogram(values, bins=bins, range=(lo, hi))
    mid = (edges[:-1] + edges[1:]) / 2
    width = max(1, int(bins * edge))
    low = mid[int(np.argmax(hist[:width]))]
    high = mid[len(hist) - width + int(np.argmax(hist[-width:]))]
    return float(low), float(high)


def candidate_slabs(heights, window, count=8, bins=1500):
    """The densest, mutually separated slabs inside `window` — seeds, not answers."""
    lo, hi = window
    hist, edges = np.histogram(heights, bins=bins, range=(lo, hi))
    mid = (edges[:-1] + edges[1:]) / 2
    separation = (hi - lo) * 0.08
    picked = []
    for i in np.argsort(hist)[::-1]:
        if any(abs(mid[i] - p) < separation for p in picked):
            continue
        picked.append(float(mid[i]))
        if len(picked) == count:
            break
    return picked


def interior_of(points, cell, margin):
    """Mask dropping points near the edge of their own plan-view footprint.

    Where a floor meets a wall, the lowest thing present is skirting, a shelf base or
    whatever is stored against it — all slightly above the slab, all around the outside, so
    they lever the fitted plane like a rim. Occupancy is gridded in plan, eroded by `margin`
    cells, and only points over surviving cells are kept.
    """
    origin = points[:, [0, 2]].min(axis=0)
    ix, iz = ((points[:, [0, 2]] - origin) / cell).astype(np.int32).T
    occupied = np.zeros((ix.max() + 1, iz.max() + 1), bool)
    occupied[ix, iz] = True
    for _ in range(margin):
        shrunk = occupied.copy()
        shrunk[1:, :] &= occupied[:-1, :]
        shrunk[:-1, :] &= occupied[1:, :]
        shrunk[:, 1:] &= occupied[:, :-1]
        shrunk[:, :-1] &= occupied[:, 1:]
        occupied = shrunk
    return occupied[ix, iz]


def fit_horizontal_surface(level, seeds, tol, centre_xz):
    """The best horizontal surface among `seeds`, as (height, normal, inlier count).

    Picking a surface by histogram density alone is unstable: a rafter is denser than the
    ceiling boards it hangs below, so a small change in where the search window falls swaps
    one for the other, and the measured room height jumps. Measured across four rotations of
    the same garage, that produced clear heights of 2.98 / 3.00 / 3.07 / 3.27 units — and
    since scale is metric_height / clear_height, a 10% wobble there is a 10% wrong map.

    So density only proposes. Each seed is grown into a plane and re-fitted on its own
    inliers, and the winner is the one covering the most splats — area, which a rafter does
    not have. Height is then read off the fitted plane at `centre_xz` rather than from a
    histogram bin, so a slight residual tilt cannot bias it either.
    """
    def upright(normal, offset):
        flip = np.sign(normal[1]) or 1.0
        return normal * flip, offset * flip

    cell, margin = tol * 6.0, 3
    best = None
    for seed in seeds:
        band = level[np.abs(level[:, 1] - seed) < tol]
        if len(band) < 2000:
            continue
        normal, offset = upright(*refit_plane(band))
        if normal[1] < 0.85:            # a wall, or a stack of shelving read edge-on
            continue

        # Re-select and re-fit until the normal settles. One pass leaves the plane wherever
        # the seed band happened to put it; on rough concrete under clutter that was worth
        # about a degree of roll, which is 1.6 m across the far end of a scaled-up map.
        #
        # The drift guard is not optional. Re-selecting inliers from the whole cloud each
        # pass lets the plane walk: nearly a tenth of this capture lies *below* the slab as
        # reconstruction spill, and unanchored the floor slid 0.26 units into it and inflated
        # the room by a quarter of a metre. The seed is the densest slab down there, which is
        # the floor itself, so the plane is allowed to rotate freely but not to leave it.
        def height_of(plane):
            normal, offset = plane
            return -(offset + normal[0] * centre_xz[0] + normal[2] * centre_xz[1]) / normal[1]

        count = int((np.abs(level @ normal + offset) < tol * 0.5).sum())
        for _ in range(6):
            inliers = level[np.abs(level @ normal + offset) < tol * 0.5]
            if len(inliers) < 2000:
                break
            core = inliers[interior_of(inliers, cell, margin)]
            fitted = upright(*refit_plane(core if len(core) > 2000 else inliers))
            if abs(height_of(fitted) - seed) > tol * 2:
                break
            moved = math.degrees(math.acos(max(-1.0, min(1.0, float(fitted[0] @ normal)))))
            normal, offset, count = *fitted, len(inliers)
            if moved < 0.01:
                break
        if count < 2000:
            continue

        height = height_of((normal, offset))
        if best is None or count > best[2]:
            best = (float(height), normal, int(count))
    return best


def find_up(pts, planes, span, hint):
    """The scene's vertical axis, chosen from the candidate plane normals.

    Two filters, in order:

    *Enclosure* — a real floor/ceiling pair is two parallel, heavily populated planes with
    nearly the whole cloud between them. Anything that leaves a third of the scene outside
    is not it.

    *Hint* — of the survivors, take the one closest to `hint`, world +Y by default. The
    enclosure test alone cannot separate the axes of a box: a garage's end walls enclose
    the cloud just as well as its floor and ceiling do, and they are denser. What breaks
    the tie is that the reconstruction inherits the camera's own idea of upright, and a
    handheld capture is never ninety degrees from level — here the true vertical is 15 deg
    off world +Y while every wall axis is past 75. That also fixes the sign for free.
    Aerial or otherwise unusual captures need --up-hint.

    Returns (unit vector, degrees from the hint, diagnostics), or None if nothing encloses.
    """
    hint = np.asarray(hint, np.float32)
    hint = hint / np.linalg.norm(hint)
    best = None
    for normal, _, _ in planes:
        for direction in (normal, -normal):
            direction = direction / np.linalg.norm(direction)
            h = pts @ direction
            low, high = outer_peaks(h)
            outside = float((h < low).mean() + (h > high).mean())
            if outside > 0.35:
                continue
            off = math.degrees(math.acos(max(-1.0, min(1.0, float(direction @ hint)))))
            if best is None or off < best[1]:
                best = (direction, off,
                        {"separation": high - low, "outside_fraction": outside})
    return best


# ------------------------------------------------------------------------- transform


def basis_from_up(up):
    """A right-handed basis whose +Y is `up` and whose +X stays as close to world +X as it can.

    Rows are the new axes, so levelling a cloud is `pts @ R.T`.
    """
    x = np.array([1.0, 0.0, 0.0], np.float32) - up * float(up[0])
    if np.linalg.norm(x) < 1e-3:                      # up was almost world +X
        x = np.array([0.0, 0.0, 1.0], np.float32) - up * float(up[2])
    x /= np.linalg.norm(x)
    return np.stack([x, up, np.cross(x, up)]).astype(np.float32)


def yaw_matrix(degrees):
    """Rotation about +Y, applied the same way as every other matrix here (`pts @ M.T`)."""
    a = math.radians(degrees)
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, 0.0, -s], [0.0, 1.0, 0.0], [s, 0.0, c]], np.float32)


def find_yaw(band):
    """The rotation about the up axis that squares the walls to X and Z.

    Scored by how hard the plan-view points pile onto axis-aligned lines: a wall parallel
    to an axis lands in one histogram bin, a skewed one smears across many. Only a quarter
    turn is searched because the answer is 90-degree symmetric. Candidates are rotated
    with `yaw_matrix`, the same function that applies the winner — a private 2x2 here is
    how the sign silently inverts.
    """
    def energy(degrees):
        rot = band @ yaw_matrix(degrees).T
        total = 0.0
        for axis in (0, 2):
            hist, _ = np.histogram(rot[:, axis], bins=600)
            total += float((hist.astype(np.float64) ** 2).sum())
        return total

    coarse = max(np.arange(-45.0, 45.0, 0.5), key=energy)
    return float(max(np.arange(coarse - 0.5, coarse + 0.5, 0.02), key=energy))


def euler_zyx_degrees(m):
    """`m` decomposed as Rz*Ry*Rx, i.e. PlayCanvas's Quat.setFromEulerAngles order.

    Callers pass the *transpose* of the rotation they want applied — see `emit_rotation`.
    """
    ey = -math.asin(max(-1.0, min(1.0, float(m[2, 0]))))
    ex = math.atan2(float(m[2, 1]), float(m[2, 2]))
    ez = math.atan2(float(m[1, 0]), float(m[0, 0]))
    return [round(math.degrees(v), 4) for v in (ex, ey, ez)]


#: splat-transform works in a frame rotated 180 degrees about Z relative to the stored SOG
#: data, measured by calibrate_transform.py against v3.1.6. One convention covers every
#: action: rotations conjugate by it, translations pass through it, scale is unaffected.
ST_FRAME = np.diag([-1.0, -1.0, 1.0]).astype(np.float32)


def emit_rotation(basis):
    """The --rotate triple that levels a cloud whose levelling basis is `basis`.

    `--rotate` takes Euler angles and documents no order, and guessing it wrong is not
    obvious from looking at the result: a residual pitch down the length of a room reads as
    perspective in a render, and the section drawings are made in the levelled frame so they
    look flat regardless. Three guesses cost three round trips, all measured on garage.sog
    (residual tilt off world +Y, from 13.06 deg unpolished):

        euler_zyx(basis)                25.60 deg   inverted — the tilt roughly doubled
        euler_zyx(basis.T)               2.68 deg   pitch and yaw solved, roll untouched
        -euler_zyx(basis) componentwise  3.93 deg   roll worse still

    `calibrate_transform.py` then measured it: the composition is Rz*Ry*Rx, PlayCanvas's own
    order, in the ST_FRAME frame. Conjugating by that negates the X and Y angles and leaves
    Z alone, which is why negating all three fixed the pitch and yaw but drove the roll the
    wrong way. Inverting it: we need F(e) = E*E_zyx(e)*E to equal `basis`, so
    E_zyx(e) = E*basis*E.
    """
    return euler_zyx_degrees(ST_FRAME @ np.asarray(basis, np.float32) @ ST_FRAME)


def emit_translation(offset):
    """`offset`, expressed the way --translate expects it.

    Rotations alone cannot pin the frame down: conjugating by diag(-1,-1,1) and by
    diag(1,1,-1) give identical results, since the two differ by -I, which cancels. So the
    rotation calibration passed while the translation stayed silently wrong, and the polished
    floor came out at -3.136 instead of 0 — exactly twice the offset, in the wrong direction.
    Translating is what distinguishes the two: `-t 1,2,3` measurably shifts a cloud by
    (-1, -2, +3).
    """
    return [round(float(v), 6) for v in ST_FRAME @ np.asarray(offset, np.float32)]


# ---------------------------------------------------------------------------- output


def orthographic(pts, au, av, path, title, step, res=1000):
    """A gridded density projection, ticked in scene units so distances can be read off.

    Note what these cannot show. They are drawn in the levelled frame, so the floor comes
    out flat whether or not the *file* is level — and a first-person render down a room
    reads a residual pitch as perspective. Neither is a check on the transform. The number
    to verify against is `tilt_from_hint_deg` in report.json.
    """
    u, v = pts[:, au], pts[:, av]
    ru = tuple(np.percentile(u, [0.3, 99.7]))
    rv = tuple(np.percentile(v, [0.3, 99.7]))
    hist, _, _ = np.histogram2d(u, v, bins=res, range=[ru, rv])
    hist = np.log1p(hist)
    grey = (hist / max(hist.max(), 1e-6) * 255).astype(np.uint8)
    img = Image.fromarray(np.flipud(grey.T)).convert("RGB")

    pad = 46
    canvas = Image.new("RGB", (img.width + pad, img.height + pad), (16, 16, 22))
    canvas.paste(img, (pad, 0))
    draw = ImageDraw.Draw(canvas)
    for t in np.arange(math.ceil(ru[0] / step) * step, ru[1], step):
        x = pad + (t - ru[0]) / (ru[1] - ru[0]) * img.width
        draw.line([(x, 0), (x, img.height)], fill=(70, 90, 130))
        draw.text((x + 3, img.height + 6), f"{t:+.1f}", fill=(190, 200, 220))
    for t in np.arange(math.ceil(rv[0] / step) * step, rv[1], step):
        y = img.height - (t - rv[0]) / (rv[1] - rv[0]) * img.height
        draw.line([(pad, y), (canvas.width, y)], fill=(70, 90, 130))
        draw.text((4, y - 6), f"{t:+.1f}", fill=(190, 200, 220))
    draw.text((pad + 6, 6), f"{title}   grid {step} units", fill=(255, 230, 140))
    canvas.save(path)


def render_views(sog, basis, eye, targets, out_dir, resolution="800x450"):
    """Photoreal renders from inside the levelled scene, via splat-transform's rasterizer.

    Cameras are given in the levelled frame and mapped back to the file's own coordinates,
    so the input is rendered untouched and what comes back still shows what the proposed
    transform would produce.

    The rasterizer takes its camera in splat-transform's own frame, ST_FRAME applied to the
    file's coordinates, as its transforms do. Measured on 3.1.6 with coloured probe splats: a
    camera at the origin aimed at +X sees the file's -X, and the file's +Y comes out down.
    Handing it file coordinates rendered every view from the wrong side and upside down.
    """
    exe = sm.find_splat_transform()
    if not exe:
        print("  (skipping --render: splat-transform not on PATH; run `nvm use 24`)")
        return []

    def camera(q):
        """A levelled-frame point or direction, as the rasterizer's flags want it."""
        in_file = np.asarray(q, np.float32) @ basis
        return ",".join(f"{c:.4f}" for c in ST_FRAME @ in_file)

    made = []
    for name, target in targets:
        webp = os.path.join(out_dir, f"view_{name}.webp")
        cmd = [
            exe, "-w", sog,
            "--camera-pos", camera(eye),
            "--camera-target", camera(target),
            "--camera-up", camera((0.0, 1.0, 0.0)),
            "--camera-fov", "80", "--camera-near", "0.02",
            "--resolution", resolution, webp, "-q",
        ]
        if subprocess.run(cmd).returncode != 0:
            print(f"  render failed: {name}")
            continue
        made.append(Image.open(webp).convert("RGB"))
        os.remove(webp)

    if not made:
        return []
    w, h = made[0].size
    sheet = Image.new("RGB", (w, h * len(made)))
    for i, img in enumerate(made):
        sheet.paste(img, (0, i * h))
    path = os.path.join(out_dir, "views.png")
    sheet.save(path)
    return [path]


# ------------------------------------------------------------------------------ main


def main(argv=None, prog=None):
    """Measure a SOG, write its report and drawings, and return the report."""
    ap = argparse.ArgumentParser(prog=prog,
                                 description="Measure a SOG and derive its polish transform.")
    ap.add_argument("input", help="path to a .sog")
    ap.add_argument("--out", help="output directory (default <input>_inspect/)")
    ap.add_argument("--opacity", type=float, default=DEFAULT_OPACITY,
                    help=f"opacity cutoff for solid geometry (default {DEFAULT_OPACITY})")
    ap.add_argument("--sample", type=int, default=400_000, help="splats used for fitting")
    ap.add_argument("--max-points", type=int, default=2_000_000,
                    help="cap on solid splats held in memory (default 2000000); a 13.9M-splat "
                         "map decoded whole needs several GB, and the fits do not need it")
    ap.add_argument("--metric-height", type=float,
                    help="real floor-to-ceiling height in metres; derives the scale factor")
    ap.add_argument("--outdoor", action="store_true",
                    help="a capture with no ceiling, such as one outdoors: --metric-height then "
                         f"reaches the capture's top, the {TOP_PERCENTILE}th percentile of the "
                         "solid splats' heights, and not a fitted ceiling")
    ap.add_argument("--scale", type=float,
                    help="force the final scale factor outright, ignoring the two above")
    ap.add_argument("--player-height", type=float, default=PLAYER_HEIGHT_M,
                    help="how tall the player should appear to be in the captured space, in "
                         f"metres (default {PLAYER_HEIGHT_M}, life size). Smaller values blow "
                         "the map up around a fixed-size player — 0.1 puts them at rat scale")
    ap.add_argument("--up-hint", default="0,1,0",
                    help="roughly which way is up in the file (default 0,1,0 — see find_up)")
    ap.add_argument("--no-yaw", action="store_true", help="skip the yaw alignment")
    ap.add_argument("--render", action="store_true", help="also render photoreal check views")
    args = ap.parse_args(argv)

    sys.stdout.reconfigure(line_buffering=True)
    out_dir = args.out or os.path.splitext(args.input)[0] + "_inspect"
    os.makedirs(out_dir, exist_ok=True)
    rng = np.random.default_rng(0)

    print(f"reading {args.input}")
    solid, _, meta = load_sog(args.input, opacity_cutoff=args.opacity,
                              max_points=args.max_points)
    print(f"  {meta['count']:,} splats; measuring {len(solid):,} of them "
          f"(opacity > {args.opacity}, capped at {args.max_points:,})")
    print(f"  generator: {meta.get('asset', {}).get('generator', 'unknown')}")
    if len(solid) < 20_000:
        sys.exit("ERROR: too few solid splats to fit geometry — lower --opacity")

    sub = solid[rng.choice(len(solid), min(args.sample, len(solid)), replace=False)]
    span = float(np.percentile(np.abs(sub - np.median(sub, 0)), 90))
    planes = ransac_planes(sub[:150_000], span * 0.01, 8, rng)
    print(f"  scene span ~{span:.3f} units, {len(planes)} dominant planes")

    hint = [float(v) for v in args.up_hint.split(",")]
    found = find_up(sub, planes, span, hint)
    if found is None:
        sys.exit("ERROR: no enclosing plane pair found — is this an interior scene?")
    up, off_hint, diag = found
    print(f"  coarse vertical ({up[0]:+.4f}, {up[1]:+.4f}, {up[2]:+.4f}), "
          f"{off_hint:.2f} deg off the {args.up_hint} hint, "
          f"{diag['outside_fraction']:.1%} of the cloud outside it — refined below")
    if off_hint > 45.0:
        print("  WARNING: that is a long way from the hint — check the renders, "
              "and pass --up-hint if the capture was not roughly upright")

    # Refit the vertical on the floor alone. Taking it from the strongest horizontal slab
    # leaves a degree or so of residual tilt, which is the difference between "floor at
    # y=0" being true everywhere and true at one end of the room.
    def surfaces(cloud, tol):
        """Fitted floor and ceiling of a levelled cloud, each as (height, normal, inliers)."""
        y = cloud[:, 1]
        lo, hi = (float(v) for v in np.percentile(y, [0.5, 99.5]))
        # Generous: rotating the cloud shifts these percentiles, and a window that just
        # clips the real ceiling makes the fit fall back on some smaller surface. Costs
        # only a few more plane fits, and the inlier count still decides.
        reach = (hi - lo) * 0.45
        centre_xz = np.median(cloud[:, [0, 2]], axis=0)
        return (fit_horizontal_surface(cloud, candidate_slabs(y, (lo, lo + reach)),
                                       tol, centre_xz),
                fit_horizontal_surface(cloud, candidate_slabs(y, (hi - reach, hi)),
                                       tol, centre_xz))

    # Take the vertical from the floor plane itself. Seeding it from the strongest horizontal
    # slab leaves a degree or so of tilt, which is the difference between "floor at y=0" being
    # true everywhere and true at one end of the room.
    #
    # Converge on the same cloud that is measured at the end. Refining against a subsample and
    # then reporting a full-cloud fit means the transform levels one estimate while the verify
    # re-measures another, and the two disagreed by around two degrees — which reads exactly
    # like a bad rotation convention and is not one.
    basis = basis_from_up(up)
    for _ in range(5):
        fitted, _ = surfaces(solid @ basis.T, span * 0.02)
        if fitted is None:
            break
        residual = math.degrees(math.acos(max(-1.0, min(1.0, float(fitted[1][1])))))
        basis = basis_from_up(basis.T @ fitted[1])
        if residual < 0.02:
            break

    # The refit moved the vertical off the coarse `find_up` answer; report what was used.
    # Yaw is about Y, so it leaves this row alone and this stays true after squaring.
    # Print it too: quoting the coarse figure as the residual made a levelled map look 2 deg
    # out and sent me hunting a rotation bug that did not exist.
    up = basis[1].copy()
    tilt = math.degrees(math.acos(max(-1.0, min(1.0, float(up[1])))))
    print(f"  vertical axis ({up[0]:+.4f}, {up[1]:+.4f}, {up[2]:+.4f}), "
          f"{tilt:.3f} deg off the hint after refitting on the floor")

    level = solid @ basis.T
    floor, ceiling = surfaces(level, span * 0.02)
    if args.outdoor:
        if floor is None:
            sys.exit("ERROR: could not fit a floor. Try --opacity or --up-hint")
        floor_y = floor[0]
        ceiling_y = float(np.percentile(level[:, 1], TOP_PERCENTILE))
        ceiling, out_of_plane = None, None
        clear = ceiling_y - floor_y
        print(f"  floor {floor_y:+.4f} ({floor[2]:,} splats), the capture's top "
              f"{ceiling_y:+.4f} (the solid splats' {TOP_PERCENTILE}th percentile), "
              f"{clear:.4f} units above the floor")
    else:
        if floor is None or ceiling is None:
            sys.exit("ERROR: could not fit both a floor and a ceiling. Try --opacity or "
                     "--up-hint, or --outdoor for a capture with no ceiling")
        floor_y, ceiling_y = floor[0], ceiling[0]
        clear = ceiling_y - floor_y
        print(f"  floor {floor_y:+.4f} ({floor[2]:,} splats), "
              f"ceiling {ceiling_y:+.4f} ({ceiling[2]:,} splats), clear height {clear:.4f} units")
        out_of_plane = math.degrees(math.acos(max(-1.0, min(1.0, float(ceiling[1] @ floor[1])))))
        print(f"  ceiling sits {out_of_plane:.2f} deg off parallel to the floor"
              f"{'  — check it is not a sloped roof' if out_of_plane > 3 else ''}")
    below_floor = float((level[:, 1] < floor_y).mean())
    above_ceiling = float((level[:, 1] > ceiling_y).mean())
    print(f"  outside the room: {below_floor:.2%} below the floor, {above_ceiling:.2%} above "
          f"{'the top' if args.outdoor else 'the ceiling'}")

    # Vertical-sign guard. find_up biases the up axis toward its hint (default +Y) and the
    # enclosure test cannot tell a box's floor from its ceiling, so an inverted capture — whose
    # true up leans past 90 deg from the hint — is chosen upside down and levels the whole map
    # the wrong way up. The garage's capture is one: the polished map, splat and collision bake
    # together, came out inverted, with the player standing on the ceiling.
    #
    # The physical tell is spill asymmetry. SfM leaves far more stray points *under* a real floor
    # (there is no scene above a ceiling to spill from), so below-floor spill normally dominates.
    # When it is the ceiling that carries the spill, the sign is probably flipped. This only warns
    # — it never changes the transform — so a false positive costs one extra line to eyeball.
    if above_ceiling > 2.0 * below_floor and above_ceiling - below_floor > 0.03:
        flip = ",".join("0" if abs(c) < 0.5 else ("-1" if c > 0 else "1")
                        for c in (float(v) for v in np.asarray(hint, np.float32)))
        print(f"  WARNING: more cloud lies past the ceiling ({above_ceiling:.1%}) than under the "
              f"floor ({below_floor:.1%}). Reconstruction spill usually collects *below* the "
              f"floor, so the vertical may be inverted and the map would render upside down. "
              f"Re-run with the negated hint (--up-hint {flip}) and compare the two reports.")

    yaw = 0.0
    if not args.no_yaw:
        wall_band = level[(level[:, 1] > floor_y + 0.15 * clear)
                          & (level[:, 1] < floor_y + 0.55 * clear)]
        take = min(400_000, len(wall_band))
        yaw = find_yaw(wall_band[rng.choice(len(wall_band), take, replace=False)])
        print(f"  yaw to square the walls: {yaw:+.2f} deg")
        basis = yaw_matrix(yaw) @ basis
        level = solid @ basis.T

    footprint = level[(level[:, 1] > floor_y + 0.05 * clear)
                      & (level[:, 1] < floor_y + 0.75 * clear)]
    lo = np.percentile(footprint, 0.5, axis=0)
    hi = np.percentile(footprint, 99.5, axis=0)
    centre = ((lo + hi) / 2).astype(float)
    print(f"  footprint {hi[0] - lo[0]:.3f} x {hi[2] - lo[2]:.3f} units "
          f"(X {lo[0]:+.2f}..{hi[0]:+.2f}, Z {lo[2]:+.2f}..{hi[2]:+.2f})")

    # Two independent factors. The first is physical: how big the room really is. The second
    # is a deliberate lie, and the whole point of a "rats" map — the player keeps its fixed
    # 1.75 m, so shrinking `--player-height` inflates the world around it instead.
    metric = args.metric_height / clear if args.metric_height else None
    miniature = PLAYER_HEIGHT_M / args.player_height
    if args.scale is not None:
        scale, miniature = args.scale, None
    elif metric is not None:
        scale = metric * miniature
    else:
        print("\n  NO METRIC REFERENCE — pass --metric-height (floor-to-ceiling, in metres)")
        print(f"  or --scale. The clear height is {clear:.4f} units, so scale = "
              f"height_in_metres / {clear:.4f}.")
        scale, miniature = 1.0, None

    width, depth = float(hi[0] - lo[0]), float(hi[2] - lo[2])
    if metric is not None:
        print(f"\n  true size {width * metric:.2f} x {depth * metric:.2f} x "
              f"{clear * metric:.2f} m  ({metric:.6f} m/unit)")
    if miniature and abs(miniature - 1.0) > 1e-6:
        print(f"  player set to {args.player_height:.3f} m, so the world is built "
              f"{miniature:.2f}x life size")
    if scale != 1.0:
        print(f"  final scale {scale:.6f} -> in game {width * scale:.1f} x "
              f"{depth * scale:.1f} x {clear * scale:.1f} m "
              f"({width * scale * sm.UNITS_PER_METRE:.0f} x "
              f"{depth * scale * sm.UNITS_PER_METRE:.0f} x "
              f"{clear * scale * sm.UNITS_PER_METRE:.0f} Quake units)")

    # Where the room needs to move: plan centre to the origin, floor to y = 0.
    offset = [-centre[0] * scale, -floor_y * scale, -centre[2] * scale]
    euler = emit_rotation(basis)
    translate = emit_translation(offset)
    st_args = ["-r", ",".join(str(v) for v in euler),
               "-s", f"{scale:.8f}",
               "-t", ",".join(str(v) for v in translate)]

    print("\n--- derived transform (rotate, then scale, then translate) ---")
    print(f"  splat-transform -w <in>.sog {' '.join(st_args)} <out>.sog")

    print("\n--- drawings ---")
    orthographic(footprint, 0, 2, os.path.join(out_dir, "plan.png"),
                 "FLOOR PLAN  u=X v=Z", step=0.5)
    orthographic(level[np.abs(level[:, 0] - centre[0]) < 0.15 * (hi[0] - lo[0])], 2, 1,
                 os.path.join(out_dir, "section_z.png"), "SECTION along Z  u=Z v=Y", step=0.5)
    orthographic(level[np.abs(level[:, 2] - centre[2]) < 0.15 * (hi[2] - lo[2])], 0, 1,
                 os.path.join(out_dir, "section_x.png"), "SECTION along X  u=X v=Y", step=0.5)
    for name in ("plan.png", "section_z.png", "section_x.png"):
        print(f"  {os.path.join(out_dir, name)}")

    if args.render:
        print("\n--- renders ---")
        eye = floor_y + 0.55 * clear
        reach = max(hi[0] - lo[0], hi[2] - lo[2])
        targets = [
            ("z_pos", (centre[0], eye, centre[2] + reach)),
            ("z_neg", (centre[0], eye, centre[2] - reach)),
            ("x_pos", (centre[0] + reach, eye, centre[2])),
            ("x_neg", (centre[0] - reach, eye, centre[2])),
        ]
        for path in render_views(args.input, basis, (centre[0], eye, centre[2]),
                                 targets, out_dir):
            print(f"  {path}")

    report = {
        "input": os.path.abspath(args.input),
        "splats": meta["count"],
        "measured_splats": int(len(solid)),
        "opacity_cutoff": args.opacity,
        "max_points": args.max_points,
        "up_axis": [round(float(c), 6) for c in up],
        "up_hint": args.up_hint,
        "tilt_from_hint_deg": round(math.degrees(math.acos(
            max(-1.0, min(1.0, float(up[1]))))), 4),
        "coarse_tilt_from_hint_deg": round(off_hint, 4),
        "outside_enclosure_fraction": round(diag["outside_fraction"], 6),
        "yaw_deg": round(yaw, 4),
        "floor_y_units": round(floor_y, 6),
        "ceiling_y_units": round(ceiling_y, 6),
        "clear_height_units": round(clear, 6),
        "outdoor": args.outdoor,
        "floor_inliers": floor[2],
        "ceiling_inliers": ceiling[2] if ceiling else None,
        "ceiling_off_parallel_deg": round(out_of_plane, 4) if ceiling else None,
        "footprint_units": [round(float(hi[0] - lo[0]), 4), round(float(hi[2] - lo[2]), 4)],
        "scale_m_per_unit": scale,
        "metric_scale_m_per_unit": metric,
        "miniature_factor": miniature,
        "player_height_m": args.player_height,
        "true_size_m": [round(width * metric, 4), round(depth * metric, 4),
                        round(clear * metric, 4)] if metric else None,
        "in_game_size_m": [round(width * scale, 3), round(depth * scale, 3),
                           round(clear * scale, 3)],
        "metric": bool(args.scale or args.metric_height),
        "transform": {"rotate_euler_deg": euler, "scale": scale, "translate": translate},
        "world_offset": [round(float(v), 6) for v in offset],
        "splat_transform_args": st_args,
    }
    report_path = os.path.join(out_dir, "report.json")
    with open(report_path, "w", encoding="utf-8") as fh:
        json.dump(report, fh, indent=2)
    print(f"\nwrote {report_path}")
    return report


if __name__ == "__main__":
    main()
