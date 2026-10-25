"""The map's splat without the chosen removals, as a SOG that keeps the source's credit.

    python build_splat.py <work dir> <out.sog> <removal> [<removal> ...]

A removal is a census column (`box`, `cluster`, `floaters`) or a try's name (`<work>/try/<name>.npy`).
Writes the rows no removal marks, with the source's own columns only, and has splat-transform
encode them as `out.sog`. splat-transform's `-w` drops the source's `license.txt`, so this puts it
back, stored, as the polish does, then checks every entry's CRC and that the credit is the
source's. The source is the SOG census.py read.
"""

import json
import os
import sys
import zipfile

import numpy as np

import splatlib as sl


def main():
    work, out, names = sys.argv[1], sys.argv[2], sys.argv[3:]
    if not names:
        sys.exit("ERROR: name at least one removal")
    with open(os.path.join(work, "census.json"), encoding="utf-8") as fh:
        source = json.load(fh)["sog"]
    s = sl.Splat(os.path.join(work, "cleanup.ply"))
    gone = np.zeros(len(s.data), bool)
    for name in names:
        mark = sl.removal(s, work, name)
        print(f"  {name}: {int(mark.sum()):,} splats, {int((mark & ~gone).sum()):,} not already removed")
        gone |= mark
    own = [i for i, n in enumerate(s.names) if n != "row" and not n.startswith("c_")]
    ply = os.path.splitext(out)[0] + ".ply"
    sl.write_ply(ply, [s.names[i] for i in own], s.data[~gone][:, own])
    sl.run([sl.splat_transform(), "-w", "-q", ply, out])
    os.remove(ply)

    with zipfile.ZipFile(source) as z:
        credit = z.read("license.txt")
    with zipfile.ZipFile(out, "a", compression=zipfile.ZIP_STORED) as z:
        if "license.txt" not in z.namelist():
            z.writestr("license.txt", credit)
    with zipfile.ZipFile(out) as z:
        bad = z.testzip()
        if bad:
            sys.exit(f"ERROR: {bad}'s CRC does not match")
        if z.read("license.txt") != credit:
            sys.exit("ERROR: the license.txt in the output is not the source's")
        count = json.loads(z.read("meta.json"))["count"]
    print(f"wrote {out}: {count:,} splats of {len(s.data):,} ({int(gone.sum()):,} removed), "
          f"{os.path.getsize(out) / 1e6:.1f} MB, with the source's license.txt")


if __name__ == "__main__":
    main()
