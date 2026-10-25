"""A filter tried on the work's splat: what it removes, and how each view changes without it.

    python try_filter.py <work dir> <views.json> <name> "<actions>" [--after box,cluster,<try>]
                         [--region x0,y0,z0,x1,y1,z1]

Runs splat-transform's `actions` on what the `--after` removals leave of the work's splat: census
columns, or earlier tries by name, so a chain runs in its order. The rows the actions remove are
the try's. With `--region`, in Q3 units, the try keeps only the removals centred inside it, so a
filter that harms one part of a map can be confined to another. Saves the removal as
`<work>/try/<name>.npy`, with `<name>.json`: what it removes, as census.py counts it, and for each
view the share of its drawn pixels that changed. Renders each view of `views.json` before and
after: `<work>/try/<name>/<view>.before.png`, without `--after`'s removals, and
`<work>/try/<name>/<view>.png`, without the try's as well.
"""

import argparse
import json
import os
import shlex

import numpy as np

import splatlib as sl


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("work")
    ap.add_argument("views")
    ap.add_argument("name")
    ap.add_argument("actions")
    ap.add_argument("--after", default="", help="removals applied first: census columns or tries")
    ap.add_argument("--region", help="keep only removals centred in this box, Q3 units")
    args = ap.parse_args()
    out = os.path.join(args.work, "try")
    os.makedirs(os.path.join(out, args.name), exist_ok=True)
    s = sl.Splat(os.path.join(args.work, "cleanup.ply"))
    n = len(s.data)
    after = [c for c in args.after.split(",") if c]
    before = np.zeros(n, bool)
    for c in after:
        before |= sl.removal(s, args.work, c)
    src = os.path.join(out, "_before.ply")
    sl.write_ply(src, s.names, s.data[~before])

    gone, log = sl.removed(src, n, shlex.split(args.actions), args.work)
    gone &= ~before
    if args.region:
        r = np.array([float(c) for c in args.region.split(",")])
        gone &= ((s.pos() >= r[:3]) & (s.pos() <= r[3:])).all(1)
    np.save(os.path.join(out, f"{args.name}.npy"), gone)

    op = s.opacity()
    srt = np.sort(s.axes(), 1)
    area = op * srt[:, 1] * srt[:, 2]
    k = int(gone.sum())
    report = {"name": args.name, "actions": args.actions, "after": after, "region": args.region,
              "removes": k, "share": k / n, "area_share": float(area[gone].sum() / area.sum()),
              "log": [l.strip(" ·▸") for l in log.splitlines() if "cluster is" in l or "removed" in l],
              "views": {}}
    if k:
        report.update(opacity_p50=float(np.median(op[gone])), length_p50=float(np.median(srt[gone, 2])),
                      length_p90=float(np.percentile(srt[gone, 2], 90)))
    print(f"{args.name}: removes {k:,} splats ({100 * report['share']:.2f}%), {100 * report['area_share']:.1f}% of "
          f"the drawn area" + (f"; opacity p50 {report['opacity_p50']:.2f}, length p50 {report['length_p50']:.1f} "
                              f"p90 {report['length_p90']:.1f} units" if k else ""))
    for line in report["log"]:
        print(f"  {line}")

    kept = os.path.join(out, "_kept.ply")
    sl.write_ply(kept, s.names, s.data[~(gone | before)])
    for view in sl.load_views(args.views):
        flags = sl.camera(view["eye"], view["angles"])
        a, _ = sl.render(src, flags, os.path.join(out, args.name, f"{view['name']}.before.png"))
        b, bg = sl.render(kept, flags, os.path.join(out, args.name, f"{view['name']}.png"))
        drawn = ~sl.background(a)
        share = float((sl.changed(a, b) & drawn).sum() / max(1, drawn.sum()))
        report["views"][view["name"]] = round(share, 4)
        print(f"  {view['name']}: {100 * share:5.1f}% changed" + ("  LOST" if bg > sl.LOST else ""))
    os.remove(kept)
    os.remove(src)
    with open(os.path.join(out, f"{args.name}.json"), "w", encoding="utf-8") as fh:
        json.dump(report, fh, indent=1)


if __name__ == "__main__":
    main()
