"""COLMAP's mapper can emit several disconnected sub-models (sparse/0, sparse/1, ...),
and the largest is NOT always sparse/0. gsplat's parser reads sparse/0, so this promotes
the sub-model with the most registered images to sparse/0 (removing the rest).

Usage:  python -m splat_maps.promote_largest_model <sparse_dir> <colmap_exe>
"""
import os
import re
import shutil
import subprocess
import sys


def registered_images(colmap, model_dir):
    out = subprocess.run(
        [colmap, "model_analyzer", "--path", model_dir],
        capture_output=True, text=True,
    )
    m = re.search(r"Registered images:\s*(\d+)", out.stdout + out.stderr)
    return int(m.group(1)) if m else 0


def main():
    sparse, colmap = sys.argv[1], sys.argv[2]
    subs = sorted(d for d in os.listdir(sparse)
                  if d.isdigit() and os.path.isdir(os.path.join(sparse, d)))
    if not subs:
        sys.exit(f"ERROR: no numeric sub-models in {sparse}")

    best, best_n = None, -1
    for d in subs:
        n = registered_images(colmap, os.path.join(sparse, d))
        print(f"  sparse/{d}: {n} registered images")
        if n > best_n:
            best, best_n = d, n
    print(f"Largest: sparse/{best} ({best_n} images)")

    if best == "0" and len(subs) == 1:
        print("sparse/0 is already the only/largest model - nothing to do.")
        return

    tmp = os.path.join(sparse, "_chosen")
    if os.path.exists(tmp):
        shutil.rmtree(tmp)
    shutil.copytree(os.path.join(sparse, best), tmp)
    for d in subs:
        shutil.rmtree(os.path.join(sparse, d))
    os.rename(tmp, os.path.join(sparse, "0"))
    print(f"Promoted sparse/{best} -> sparse/0")


if __name__ == "__main__":
    main()
