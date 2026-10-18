"""What do `splat-transform`'s --rotate, --translate and --scale actually do?

The CLI documents no Euler order, and guessing cost three failed round trips. This measures
all three actions: transform a file by known amounts and recover what came out the far end.

Recovering the rotation is the awkward part, because a re-encode does not preserve splat
order, so points cannot be paired by index. Covariance is order-free: C_out = R C_in R^T,
so the eigenvectors give R up to a sign per axis. Third moments are odd, so they flip with
the axis and pin the signs down.

Translation must be probed too, and not as an afterthought: rotations cannot identify the
frame on their own, because conjugating by diag(-1,-1,1) and by diag(1,1,-1) are the same
operation — they differ by -I, which cancels. Translating tells them apart, and getting it
wrong put a polished floor at -3.136 instead of 0. Centroids are order-free, so this part
is a subtraction.

Usage:  python -m splat_maps.calibrate_transform <source.sog>
"""

import itertools
import math
import os
import subprocess
import sys

import numpy as np

from .sog_inspect import find_splat_transform, load_sog

PROBES = [(30.0, 0.0, 0.0), (0.0, 30.0, 0.0), (0.0, 0.0, 30.0), (30.0, 20.0, 10.0)]
CAP = 1_000_000        # covariance and third moments converge long before this


def rx(t):
    t = math.radians(t)
    return np.array([[1, 0, 0], [0, math.cos(t), -math.sin(t)], [0, math.sin(t), math.cos(t)]])


def ry(t):
    t = math.radians(t)
    return np.array([[math.cos(t), 0, math.sin(t)], [0, 1, 0], [-math.sin(t), 0, math.cos(t)]])


def rz(t):
    t = math.radians(t)
    return np.array([[math.cos(t), -math.sin(t), 0], [math.sin(t), math.cos(t), 0], [0, 0, 1]])


def principal(pts):
    """Centred points, their covariance eigenvectors (ascending eigenvalue), and eigenvalues."""
    centred = pts - pts.mean(0)
    cov = (centred.T @ centred) / len(centred)
    vals, vecs = np.linalg.eigh(cov)
    return centred, vecs, vals


def recover(P, Q):
    """The rotation taking cloud P to cloud Q, without pairing any points.

    Both clouds share eigenvalues, so their eigenvector frames differ only by R and a sign
    per axis. Of the four sign combinations with a positive determinant, the right one is
    the one whose third moments agree: those are odd, so flipping an axis flips its sign,
    which a symmetric statistic like the covariance can never see.
    """
    cp, Vp, wp = principal(P)
    cq, Vq, wq = principal(Q)
    rel = float(np.abs(wp - wq).max() / max(np.abs(wp).max(), 1e-9))
    skew_p = [float(np.mean((cp @ Vp[:, i]) ** 3)) for i in range(3)]

    best, best_score = None, None
    for signs in itertools.product((1, -1), repeat=3):
        V = Vq * np.array(signs)
        if np.linalg.det(V) * np.linalg.det(Vp) < 0:
            continue
        skew_q = [float(np.mean((cq @ V[:, i]) ** 3)) for i in range(3)]
        score = sum((a - b) ** 2 for a, b in zip(skew_p, skew_q))
        if best_score is None or score < best_score:
            best, best_score = V @ Vp.T, score
    return best, rel, best_score, skew_p


def candidates(ex, ey, ez):
    """Every convention worth considering, as {name: matrix}."""
    out = {}
    for order_name, build in (
        ("Rz*Ry*Rx", lambda a, b, c: rz(c) @ ry(b) @ rx(a)),
        ("Rx*Ry*Rz", lambda a, b, c: rx(a) @ ry(b) @ rz(c)),
    ):
        for sign_name, s in (("", 1.0), (" negated", -1.0)):
            base = build(s * ex, s * ey, s * ez)
            for flip_name, d in (
                ("", np.eye(3)),
                (" Zflip", np.diag([1.0, 1.0, -1.0])),
                (" Yflip", np.diag([1.0, -1.0, 1.0])),
                (" Xflip", np.diag([-1.0, 1.0, 1.0])),
            ):
                out[f"{order_name}{sign_name}{flip_name}"] = d @ base @ d
    return out


def main():
    SRC = sys.argv[1]
    EXE = find_splat_transform()
    print(f"source: {SRC}")
    P, _, _ = load_sog(SRC, max_points=CAP)
    print(f"  {len(P):,} splats")
    _, _, wp = principal(P)
    print(f"  covariance eigenvalues {np.sort(wp)[::-1]}")

    scores = {}
    for probe in PROBES:
        tag = "_".join(f"{v:g}" for v in probe).replace("-", "m").replace(".", "p")
        out = f"cal_{tag}.sog"
        subprocess.run([EXE, "-w", "-q", SRC, "-r", ",".join(f"{v:g}" for v in probe), out],
                       check=True)
        Q, _, _ = load_sog(out, max_points=CAP)
        os.remove(out)
        R, rel, skew_err, skew_p = recover(P, Q)

        print(f"\n--- probe -r {','.join(f'{v:g}' for v in probe)} ---")
        print(f"  eigenvalue mismatch {rel:.2e} (should be ~0: the clouds are the same shape)")
        print(f"  third-moment residual after sign choice {skew_err:.3e}, |skew| {np.abs(skew_p)}")
        errs = {n: float(np.abs(M - R).max()) for n, M in candidates(*probe).items()}
        for name, err in sorted(errs.items(), key=lambda kv: kv[1])[:4]:
            print(f"  {name:26s} max|diff| {err:.5f}")
        # Every candidate must be scored on every probe, not just the ones that placed here:
        # single-axis probes leave whole families degenerate, and a candidate that is exact on
        # one axis and wrong on another would otherwise never be charged for the miss.
        for name, err in errs.items():
            scores[name] = scores.get(name, 0.0) + err

    print("\n=== summed error over all probes (lower is the convention) ===")
    for name, total in sorted(scores.items(), key=lambda kv: kv[1])[:6]:
        print(f"  {name:26s} {total:.5f}")
    print("\nThe combined probe is the decisive one — single-axis probes cannot tell the "
          "composition order apart.")

    # --- translate and scale: order-free, so plain centroid and extent comparisons ----------
    print("\n=== translate and scale ===")
    probe_t = (1.0, 2.0, 3.0)
    subprocess.run([EXE, "-w", "-q", SRC, "-t", ",".join(f"{v:g}" for v in probe_t),
                    "cal_t.sog"], check=True)
    T, _, _ = load_sog("cal_t.sog", max_points=CAP)
    os.remove("cal_t.sog")
    shift = T.mean(0) - P.mean(0)
    print(f"  -t {probe_t} shifts the centroid by {np.round(shift, 4)}")
    print(f"  => per-axis sign {np.round(shift / np.array(probe_t), 3)}")

    subprocess.run([EXE, "-w", "-q", SRC, "-s", "2", "cal_s.sog"], check=True)
    S, _, _ = load_sog("cal_s.sog", max_points=CAP)
    os.remove("cal_s.sog")
    ratio = np.percentile(S, 99, axis=0) / np.percentile(P, 99, axis=0)
    print(f"  -s 2 scales the extent by {np.round(ratio, 4)} (expect 2, unsigned)")

    print("\nsog_inspect.ST_FRAME must equal diag(per-axis sign) above; the same frame governs "
          "the rotation, since conjugating by it reproduces the winning convention.")
    print("\nThe combined probe is the decisive one — single-axis probes cannot tell the "
          "composition order apart.")


if __name__ == "__main__":
    main()
