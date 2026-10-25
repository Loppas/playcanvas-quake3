"""What each standard filter would take from a map's splat, splat by splat; and the work's splat.

    python census.py <map.sog> <work dir>

Decodes the SOG to a PLY, runs each of reference/filters.md's standard filters on it alone, and
writes `<work>/cleanup.ply`: the splat, a `row` column, and a `c_<filter>` column marking the rows
that filter removes (splatlib.py). The box, seed and voxel are the bake's, from `<stem>.bake.json`
beside the SOG. Prints what each filter removes: its count, its share of the splat's drawn area
(opacity times the two longest axes), its median opacity and length in units, and how much of it
lies outside the box; and writes them to `<work>/census.json`.
"""

import json
import os
import sys

import numpy as np

import splatlib as sl
from splat_maps import bake_map
from splat_maps import splat_map as sm


def standard_filters(bake):
    """The standard filters' splat-transform actions, sized from the bake: the crop to its box, and
    the cluster filter on its voxel from its seed."""
    return {
        "box": ["--filter-box", bake_map.filter_box(",".join(sm.fmt_num(c) for c in bake["box_sim"]))],
        "cluster": ["--seed-pos", ",".join(sm.fmt_num(c) for c in bake["seed_octree"]),
                    "--filter-cluster", f"{sm.fmt_num(bake['voxel_units'] / sm.UNITS_PER_METRE)},0.5,0.1"],
        "floaters": ["--filter-floaters", "0.05,0.5,0.1"],
    }


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    sog, work = sys.argv[1], sys.argv[2]
    os.makedirs(work, exist_ok=True)
    bake = sl.bake_of(sog)
    out = os.path.join(work, "cleanup.ply")
    sl.run([sl.splat_transform(), "-w", "-q", sog, out])
    s = sl.Splat(out)
    n = len(s.data)
    if n >= sl.MAX_ROWS:
        sys.exit(f"ERROR: {n:,} splats; the row column counts to {sl.MAX_ROWS:,}")
    sl.write_ply(out, s.names + ["row"], np.concatenate([s.data, np.arange(n, dtype=np.float32)[:, None]], 1))

    box = np.array(bake["box_sim"], float)
    pos, op = s.pos(), s.opacity()
    srt = np.sort(s.axes(), 1)
    longest, area = srt[:, 2], op * srt[:, 1] * srt[:, 2]
    outside = ~((pos >= box[:3]) & (pos <= box[3:])).all(1)
    report = {"sog": os.path.abspath(sog), "splats": n, "filters": {}}
    print(f"{n:,} splats; box {sl.fmt_point(box[:3])} to {sl.fmt_point(box[3:])}")
    print(f"{'filter':9s} {'removes':>10s} {'share':>7s} {'drawn area':>10s} {'opacity p50':>11s} "
          f"{'length p50':>10s} {'p90':>6s} {'outside box':>11s}")
    marks = {}
    for name, actions in standard_filters(bake).items():
        gone, log = sl.removed(out, n, actions, work)
        marks[name] = gone
        k = int(gone.sum())
        row = {"actions": actions, "removes": k, "share": k / n, "area_share": float(area[gone].sum() / area.sum()),
               "outside_box": int((gone & outside).sum()),
               "log": [l.strip(" ·▸") for l in log.splitlines() if "cluster is" in l or "removed" in l]}
        if k:
            row.update(opacity_p50=float(np.median(op[gone])), length_p50=float(np.median(longest[gone])),
                       length_p90=float(np.percentile(longest[gone], 90)))
        report["filters"][name] = row
        print(f"{name:9s} {k:>10,} {100 * row['share']:6.2f}% {100 * row['area_share']:9.1f}% "
              + (f"{row['opacity_p50']:11.2f} {row['length_p50']:10.1f} {row['length_p90']:6.1f} "
                 f"{row['outside_box']:>11,}" if k else ""))
        for line in row["log"]:
            print(f"          {line}")

    s = sl.Splat(out)
    sl.write_ply(out, s.names + [f"c_{c}" for c in marks],
                 np.concatenate([s.data, np.stack([m.astype(np.float32) for m in marks.values()], 1)], 1))
    with open(os.path.join(work, "census.json"), "w", encoding="utf-8") as fh:
        json.dump(report, fh, indent=1)
    print(f"wrote {out} and census.json")


if __name__ == "__main__":
    main()
