"""Export a trained splat as a SOG, which the polish reads, and as a viewer to fly around it.

The trainer saves `point_cloud_<step>.ply` at set steps and at its last (simple_trainer.py's
`ply_steps`), its step unpadded, so the last is found by the number: by name, 6999 sorts after
29999.

Usage:
    splat-maps export <dataset> [--name NAME]

Reads <dataset>/results/mcmc/ply/ (`train` writes it); writes <name>.sog and <name>_viewer.html
beside ply/, the name the dataset folder's unless given. Requires splat-transform at the pinned
version on PATH.
"""

import argparse
import os
import re
import subprocess
import sys

from . import splat_map as sm
from .train import RESULTS

PLY = re.compile(r"^point_cloud_(\d+)\.ply$")


def last_ply(folder):
    """The PLY of the last step saved in `folder`; exits if there is none."""
    names = os.listdir(folder) if os.path.isdir(folder) else []
    steps = {int(m.group(1)): name for name in names if (m := PLY.match(name))}
    if not steps:
        sys.exit(f"ERROR: no point_cloud_<step>.ply in {folder}. Run `train` first")
    return os.path.join(folder, steps[max(steps)])


def main(argv=None, prog=None):
    ap = argparse.ArgumentParser(prog=prog, description="Export a trained splat as a SOG.")
    ap.add_argument("dataset", help="the capture's folder, trained by `train`")
    ap.add_argument("--name", help="the files' name (default the dataset folder's)")
    args = ap.parse_args(argv)
    sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)

    try:
        exe = sm.require_splat_transform()
    except sm.FormatError as e:
        sys.exit(f"ERROR: {e}")
    results = os.path.join(args.dataset, RESULTS)
    ply = last_ply(os.path.join(results, "ply"))
    name = args.name or os.path.basename(os.path.normpath(args.dataset))
    for out in (f"{name}.sog", f"{name}_viewer.html"):
        out = os.path.join(results, out)
        print(f"=== export: {ply} -> {out}", flush=True)
        if subprocess.run([exe, "-w", ply, out]).returncode != 0:
            sys.exit("ERROR: splat-transform failed")


if __name__ == "__main__":
    main()
