"""Deliver a splat map pk3 to the port's `public/maps/`, where the port mounts it.

The port mounts `public/maps/*.pk3` as the lowest layer of its search path (`map-format.md` §8).
Delivery is the only way a map gets there, so nothing is copied by hand:
  1. the pk3 is linted, and refused if any rule fails at E;
  2. it is copied under a temporary name and renamed into place, so a running dev server never
     sees half a pk3;
  3. the copy is hashed against the original.

Usage:
    splat-maps deliver <dir>/map-<stem>.pk3 [--port DIR]

`--port` defaults to the checkout these scripts are in. A released pk3 is never rewritten in
place (§9), so delivering over an existing file with different bytes needs --replace.
"""

import argparse
import hashlib
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_PORT = os.path.normpath(os.path.join(HERE, "..", "..", ".."))


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main(argv=None, prog=None):
    ap = argparse.ArgumentParser(prog=prog, description="Deliver a splat map pk3 to the port.")
    ap.add_argument("pk3")
    ap.add_argument("--port", default=DEFAULT_PORT,
                    help=f"the port's checkout (default {DEFAULT_PORT})")
    ap.add_argument("--replace", action="store_true",
                    help="replace a delivered pk3 of the same name whose bytes differ")
    args = ap.parse_args(argv)
    sys.stdout.reconfigure(encoding="utf-8")

    maps = os.path.join(args.port, "public", "maps")
    if not os.path.isfile(os.path.join(args.port, "package.json")) or not os.path.isdir(maps):
        sys.exit(f"ERROR: {args.port} does not look like the port: no package.json and public/maps")
    dest = os.path.join(maps, os.path.basename(args.pk3))

    print(flush=True)
    lint = subprocess.run([sys.executable, "-m", "splat_maps", "lint", args.pk3])
    if lint.returncode != 0:
        sys.exit("ERROR: the lint refused the pk3, so it was not delivered")

    digest = sha256(args.pk3)
    if os.path.exists(dest):
        if sha256(dest) == digest:
            print(f"\n{dest} is already this pk3, byte for byte")
            return
        if not args.replace:
            sys.exit(f"ERROR: {dest} exists with different bytes. A released pk3 is never "
                     "rewritten in place: give the fix a name that sorts later, such as "
                     "map-<stem>_v2.pk3, or pass --replace for a map that was never released")

    part = dest + ".part"
    shutil.copyfile(args.pk3, part)
    os.replace(part, dest)
    if sha256(dest) != digest:
        sys.exit(f"ERROR: {dest} does not hash to the pk3 it was copied from")
    print(f"\ndelivered {dest}: {os.path.getsize(dest):,} bytes, sha256 {digest[:16]}…, "
          "the same as the pk3 it came from")


if __name__ == "__main__":
    main()
