"""Train a Gaussian splat on a capture with gsplat's own trainer, `simple_trainer.py mcmc`.

The trainer lives in gsplat's checkout, `examples/`, beside the dataset readers it imports, so it
runs from there, in this Python, which needs torch and gsplat built for its GPU
(`docs/training.md`). It reads the frames at full size, saves PLYs, and runs without its viewer.

Usage:
    splat-maps train <dataset> [--cap-max 1000000] [--max-steps 30000] [the trainer's arguments]

`--cap-max` bounds the splats, trading size and memory for detail. Any other argument is the
trainer's: `--use-bilateral-grid`, say, for a capture whose exposure drifts. Reads
<dataset>/images/ and sparse/0 (`sfm` writes them); writes <dataset>/results/mcmc/, its PLYs in
ply/point_cloud_<step>.ply. gsplat's checkout is $SPLAT_GSPLAT.
"""

import argparse
import os
import subprocess
import sys

#: The trainer's results, under the dataset.
RESULTS = os.path.join("results", "mcmc")


def find_trainer():
    """The folder of gsplat's checkout that holds `simple_trainer.py`; exits if there is none."""
    checkout = os.environ.get("SPLAT_GSPLAT")
    if not checkout:
        sys.exit("ERROR: SPLAT_GSPLAT is not set: name gsplat's checkout in it "
                 "(docs/training.md)")
    examples = os.path.join(checkout, "examples")
    if not os.path.isfile(os.path.join(examples, "simple_trainer.py")):
        sys.exit(f"ERROR: no examples/simple_trainer.py in {checkout}, which SPLAT_GSPLAT names")
    return examples


def main(argv=None, prog=None):
    ap = argparse.ArgumentParser(prog=prog, description="Train a splat with gsplat's MCMC trainer.",
                                 epilog="Any other argument is the trainer's.")
    ap.add_argument("dataset", help="the capture's folder, with images/ and sparse/0")
    ap.add_argument("--cap-max", type=int, default=1_000_000,
                    help="the most splats the trainer keeps (default 1000000)")
    ap.add_argument("--max-steps", type=int, default=30_000,
                    help="training steps (default 30000)")
    args, extra = ap.parse_known_args(argv)
    sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)

    examples = find_trainer()
    dataset = os.path.abspath(args.dataset)
    if not os.path.isdir(os.path.join(dataset, "sparse", "0")):
        sys.exit(f"ERROR: no sparse/0 in {dataset}. Run `sfm` first")

    print(f"=== train: {args.max_steps:,} steps, at most {args.cap_max:,} splats")
    run = subprocess.run([sys.executable, "simple_trainer.py", "mcmc",
                          "--data-dir", dataset, "--data-factor", "1",
                          "--result-dir", os.path.join(dataset, RESULTS),
                          "--strategy.cap-max", str(args.cap_max),
                          "--max-steps", str(args.max_steps),
                          "--antialiased", "--save-ply", "--disable-viewer", *extra], cwd=examples)
    if run.returncode != 0:
        sys.exit("ERROR: the trainer failed")


if __name__ == "__main__":
    main()
