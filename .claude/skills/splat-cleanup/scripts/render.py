"""Views of a splat rendered offline, as the port draws them.

    python render.py <map.sog | <work>/cleanup.ply> <views.json> <out dir> [--without box,<try>]

Renders each view of `views.json` with splat-transform's rasteriser, at splatlib.camera's view, to
`<out dir>/<view>.png`, and prints its background share. Given a work's splat, `--without` leaves
out those removals, census columns or tries.
"""

import argparse
import os

import numpy as np

import splatlib as sl


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("src")
    ap.add_argument("views")
    ap.add_argument("out")
    ap.add_argument("--without", default="")
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    src = args.src
    without = [c for c in args.without.split(",") if c]
    if without:
        s = sl.Splat(src)
        gone = np.zeros(len(s.data), bool)
        for c in without:
            gone |= sl.removal(s, os.path.dirname(os.path.abspath(src)), c)
        src = os.path.join(args.out, "_kept.ply")
        sl.write_ply(src, s.names, s.data[~gone])
    for view in sl.load_views(args.views):
        _, bg = sl.render(src, sl.camera(view["eye"], view["angles"]), os.path.join(args.out, f"{view['name']}.png"))
        print(f"{view['name']}: {100 * bg:.1f}% background" + ("  LOST" if bg > sl.LOST else ""))
    if without:
        os.remove(src)


if __name__ == "__main__":
    main()
