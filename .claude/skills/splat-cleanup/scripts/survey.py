"""Panoramas from every pose, and where the standard filters change what a player sees.

    python survey.py <work dir> [--top 12]

Renders a panorama of the work's splat from every pose in `<work>/poses.json`, and again without
everything census.py's columns mark. A pixel has changed when a channel moves more than
splatlib.CHANGE; a pose's score is the share of its drawn pixels that changed. For the `--top`
poses it renders a panorama without each filter alone, and one with the view-dependent bands
dropped (`--filter-harmonics 0`), and scores each the same way.

Writes, in `<work>/survey/`, each pose's panorama, `<pose>.jpg`, and `<pose>.changed.jpg`, the
panorama dimmed with its changed pixels lit; `survey.json`, every pose ranked by its score with its
background share; and `views.json`, a view from each top pose facing where most changed, to look at
and to try filters on. A panorama more than splatlib.LOST background is listed as lost and not
ranked.
"""

import argparse
import json
import os
import time

import numpy as np
from PIL import Image

import splatlib as sl
from splat_maps import levelshot

#: A view's width in a panorama's columns: 106 degrees, a view's 73.74 tall across 16:9.
VIEW_COLUMNS = int(sl.PANORAMA_SIZE[0] / 360 * 2 * np.degrees(
    np.arctan(np.tan(np.radians(levelshot.FOV_Y / 2)) * sl.VIEW_SIZE[0] / sl.VIEW_SIZE[1])))
#: The steepest a survey view looks up or down. A view 73.74 degrees tall at 30 down still sees the
#: floor 67 degrees below the horizon.
PITCH = 30


def facing(mask, pose):
    """A view from the pose facing the changed pixels: of the windows a view wide, the one holding
    the most, centred on their mean column there and pitched to their median row, at most PITCH.
    The floor round the pose fills the panorama's lower rows, so the median row alone points most
    views at the player's feet."""
    cols = mask.sum(0).astype(float)
    window = np.convolve(np.concatenate([cols, cols, cols]), np.ones(VIEW_COLUMNS), "same")[len(cols):2 * len(cols)]
    best = int(np.argmax(window))
    near = np.arange(best - VIEW_COLUMNS // 2, best + VIEW_COLUMNS // 2)
    weight = np.take(cols, near, mode="wrap")
    col = float((near * weight).sum() / weight.sum()) if weight.sum() else float(best)
    rows = np.nonzero(np.take(mask, near, axis=1, mode="wrap"))[0]
    row = int(np.median(rows)) if rows.size else mask.shape[0] // 2
    pitch, yaw = sl.panorama_angles(col, row, pose["angles"][1])
    return {"name": f"{pose['name']}_y{round(yaw):03d}", "eye": pose["eye"],
            "angles": [round(float(np.clip(pitch, -PITCH, PITCH)), 1), round(float(yaw), 1), 0.0]}


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("work")
    ap.add_argument("--top", type=int, default=12)
    args = ap.parse_args()
    ply = os.path.join(args.work, "cleanup.ply")
    out = os.path.join(args.work, "survey")
    os.makedirs(out, exist_ok=True)
    poses = sl.load_views(os.path.join(args.work, "poses.json"))
    names, _ = sl.read_ply(ply)
    columns = [n for n in names if n.startswith("c_")]
    without = [a for c in columns for a in ("--filter-value", f"{c},eq,0")]
    print(f"{len(poses)} poses, 2 panoramas each, then {len(columns) + 1} more for each of the top {args.top}")

    results, masks, t0 = [], {}, time.time()
    for k, pose in enumerate(poses):
        cam = sl.camera(pose["eye"], pose["angles"], panorama=True)
        base, bg = sl.render(ply, cam, os.path.join(out, f"{pose['name']}.jpg"))
        filtered, _ = sl.render(ply, cam, os.path.join(out, "_filtered.jpg"), without)
        drawn = ~sl.background(base)
        mask = sl.changed(base, filtered) & drawn
        score = float(mask.sum() / max(1, drawn.sum()))
        heat = (base * 0.35).astype(np.uint8)
        heat[mask] = (255, 60, 255)
        Image.fromarray(heat).save(os.path.join(out, f"{pose['name']}.changed.jpg"), quality=92)
        lost = bg > sl.LOST
        results.append({"name": pose["name"], "eye": pose["eye"], "background": round(bg, 3),
                        "lost": lost, "changed": round(score, 4)})
        masks[pose["name"]] = mask
        if k == 0:
            print(f"  {time.time() - t0:.1f} s a pose; about {(time.time() - t0) * len(poses) / 60:.0f} min for the poses")
        print(f"  {pose['name']}: {100 * score:5.1f}% changed, {100 * bg:4.1f}% background" + ("  LOST" if lost else ""))
    os.remove(os.path.join(out, "_filtered.jpg"))

    ranked = sorted((r for r in results if not r["lost"]), key=lambda r: -r["changed"])
    views = []
    for r in ranked[:args.top]:
        pose = next(p for p in poses if p["name"] == r["name"])
        cam = sl.camera(pose["eye"], pose["angles"], panorama=True)
        base, _ = sl.render(ply, cam, os.path.join(out, f"{pose['name']}.jpg"))
        drawn = ~sl.background(base)
        r["filters"] = {}
        for c in columns + ["harmonics"]:
            actions = ["--filter-harmonics", "0"] if c == "harmonics" else ["--filter-value", f"{c},eq,0"]
            alone, _ = sl.render(ply, cam, os.path.join(out, f"{r['name']}.{c.removeprefix('c_')}.jpg"), actions)
            r["filters"][c.removeprefix("c_")] = round(float((sl.changed(base, alone) & drawn).sum() / max(1, drawn.sum())), 4)
        r["view"] = facing(masks[r["name"]], pose)
        views.append(r["view"])
        print(f"  {r['name']}: " + ", ".join(f"{k} {100 * v:.1f}%" for k, v in r["filters"].items()))

    with open(os.path.join(out, "survey.json"), "w", encoding="utf-8") as fh:
        json.dump({"change": sl.CHANGE, "poses": ranked + [r for r in results if r["lost"]]}, fh, indent=1)
    with open(os.path.join(out, "views.json"), "w", encoding="utf-8") as fh:
        json.dump(views, fh, indent=1)
    lost = [r["name"] for r in results if r["lost"]]
    print(f"done in {(time.time() - t0) / 60:.1f} min; wrote survey.json and views.json in {out}"
          + (f"; lost: {', '.join(lost)}" if lost else ""))


if __name__ == "__main__":
    main()
