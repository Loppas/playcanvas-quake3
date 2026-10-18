"""Polish a trained SOG: level it, square it, scale it to metres, and put its floor at y = 0.

The headless replacement for the manual SuperSplat pass. Its four steps check the output rather
than assume it:
  1. measure: `sog_inspect` measures the input and derives the transform;
  2. apply: splat-transform writes the output through it;
  3. verify: `sog_inspect` measures the output, as it now stands;
  4. record:
     - the input's `license.txt` goes back into the output, stored, as the source had it, since
       `splat-transform -w` drops a SOG bundle's. A capture with none, such as one these
       scripts trained, takes one from `--license`: a file in superspl.at's layout, or the same
       `Key: value` fields in one string, separated by semicolons. A source that carries its
       own is never replaced;
     - `<output stem>.polish.json` holds the `_pcq_*` keys the polish owns (`map-format.md` §7)
       and what the verify measured;
     - the output is refused unless the verify found it level, square, with its floor at 0 and
       its clear height kept.

Usage:
    splat-maps polish <input.sog> <output.sog> <metric_height_m> [--license FILE|FIELDS]
                      [sog_inspect's arguments, e.g. --player-height 0.5 --up-hint 0,-1,0
                       --outdoor]

The three positional arguments come first. Any other argument is sog_inspect's, given to both
measures. Outputs: <output.sog>, <output stem>.polish.json, and each measure's report and
drawings, in <input stem>_inspect/ and <output stem>_inspect/.
Requires numpy and Pillow, and splat-transform at the pinned version on PATH (Node >= 24).
"""

import argparse
import json
import os
import re
import subprocess
import sys
import zipfile

from . import sog_inspect
from . import splat_map as sm

#: What a verify must show. The shipped garage verifies at 0.044 deg of tilt, -0.02 deg of yaw
#: and its floor 0.23 units low, so these leave room without letting a real error through.
MAX_TILT_DEG = 0.1
MAX_YAW_DEG = 0.1
MAX_FLOOR_UNITS = 1.0
MAX_CLEAR_CHANGE = 0.005

#: The same with `--outdoor`. A yard's paving, lawn and trees are rougher ground for the fits
#: than a room's floor and walls, and its measure and verify agree to about a tenth of a degree,
#: so these are wider, and still far inside a levelling error, which is degrees.
OUTDOOR_MAX_TILT_DEG = 0.25
OUTDOOR_MAX_YAW_DEG = 0.25
OUTDOOR_MAX_CLEAR_CHANGE = 0.01

#: sog_inspect arguments that change nothing in the transform, so are not recorded.
NOT_RECORDED = {"--render": 0, "--out": 1}


def spdx(url):
    """The SPDX identifier for a Creative Commons licence URL, e.g. CC-BY-4.0."""
    m = re.search(r"creativecommons\.org/licenses/([a-z-]+)/(\d+\.\d+)", url or "")
    if m:
        return f"CC-{m.group(1).upper()}-{m.group(2)}"
    m = re.search(r"creativecommons\.org/publicdomain/zero/(\d+\.\d+)", url or "")
    if m:
        return f"CC0-{m.group(1)}"
    return None


def read_license(text):
    """superspl.at's `license.txt`: `Key: value` lines (Title, Author, Source, License,
    License URL, Requirements)."""
    fields = {}
    for line in text.splitlines():
        if ":" in line:
            key, value = line.split(":", 1)
            fields[key.strip().lower()] = value.strip()
    return fields


#: The fields `_pcq_source` and `_pcq_license` are made from (`map-format.md` §7).
NEEDED = ("title", "author", "source", "license url")


def given_license(value):
    """`--license`'s bytes, as a `license.txt` holds them: the file it names, or else its
    `Key: value` fields, one per line in the order given."""
    if os.path.isfile(value):
        with open(value, "rb") as fh:
            return fh.read()
    lines = [f.strip() for f in value.split(";") if f.strip()]
    if not any(line.split(":", 1)[0].strip().lower() in NEEDED for line in lines if ":" in line):
        sys.exit(f"ERROR: --license {value!r} is neither a file nor 'Key: value; ...' fields")
    return "\n".join(lines).encode("utf-8")


def main(argv=None, prog=None):
    ap = argparse.ArgumentParser(
        prog=prog, description="Level, square and scale a trained SOG, and record the polish.",
        epilog="Any other argument is sog_inspect's, given to both measures: --player-height, "
               "--up-hint, --outdoor, --opacity, --no-yaw or --render, say.")
    ap.add_argument("input", help="the trained .sog")
    ap.add_argument("output", help="the polished .sog to write")
    ap.add_argument("metric_height", metavar="metric_height_m",
                    help="the real floor-to-ceiling height in metres, the scale's reference; "
                         "with --outdoor, from the floor to the capture's top")
    ap.add_argument("--license", help="the source's credit, for a capture with no license.txt of "
                                      "its own: a file in superspl.at's layout, or its fields in "
                                      "one string, \"Title: ...; Author: ...; Source: <link>; "
                                      "License URL: <link>\"")
    args, extra = ap.parse_known_args(argv)
    sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)
    given = given_license(args.license) if args.license else None
    try:
        exe = sm.require_splat_transform()
    except sm.FormatError as e:
        sys.exit(f"ERROR: {e}")
    inspect_args = ["--metric-height", args.metric_height, *extra]

    print(f"\n=== 1/4  measuring {args.input}")
    measure = sog_inspect.main([args.input, *inspect_args], prog=prog)

    st_args = measure["splat_transform_args"]
    print(f"\n=== 2/4  applying: splat-transform -w {args.input} {' '.join(st_args)} {args.output}")
    if subprocess.run([exe, "-w", args.input, *st_args, args.output]).returncode != 0:
        sys.exit("ERROR: splat-transform failed")

    # The output is +Y up by construction, so the verify always hints +Y: the input's
    # --up-hint 0,-1,0 would make it lock onto the ceiling. argparse keeps the last one given.
    print(f"\n=== 3/4  verifying {args.output}   (expect tilt ~0, yaw ~0, floor y ~0)")
    verify = sog_inspect.main([args.output, "--scale", "1.0", *extra, "--up-hint", "0,1,0"],
                              prog=prog)

    print("\n=== 4/4  recording the polish and keeping the source's licence")
    record_polish(args.input, args.output, measure, verify, inspect_args, given)
    print("\nDone. Compare the two report.json files and the plan/section drawings.")


def record_polish(src, out, measure, verify, inspect_args, given):
    """The polish's last step: `src`'s licence, or else `given`'s bytes, into `out`; the record
    written beside `out`; and the verify checked. Exits 1 if anything is wrong.

    `measure` and `verify` are sog_inspect's reports on `src` and `out`, and `inspect_args` the
    measure's arguments, as given.
    """
    errors, warnings = [], []

    # The arguments that made the transform, as given, minus paths and displays.
    kept, skip = [], 0
    for a in inspect_args:
        if skip:
            skip -= 1
            continue
        if a in NOT_RECORDED:
            skip = NOT_RECORDED[a]
            continue
        kept.append(a)
    polish = " ".join(kept)
    st_args = measure["splat_transform_args"]
    scale = st_args[st_args.index("-s") + 1]

    # The licence, back into the bundle: the source's own, or else the one given.
    with zipfile.ZipFile(src) as zin:
        lic_bytes = zin.read("license.txt") if "license.txt" in zin.namelist() else None
    if lic_bytes is not None and given is not None and given != lic_bytes:
        sys.exit(f"ERROR: {os.path.basename(src)} carries its own license.txt, which --license "
                 "would replace. A source's licence is its creator's to set")
    lic_bytes = lic_bytes if lic_bytes is not None else given
    lic = {}
    if lic_bytes is None:
        warnings.append(f"{os.path.basename(src)} carries no license.txt, so the package will "
                        "refuse it (L29). Give the source's credit with --license")
    else:
        with zipfile.ZipFile(out) as z:
            has = "license.txt" in z.namelist()
        if not has:
            with zipfile.ZipFile(out, "a", compression=zipfile.ZIP_STORED) as z:
                z.writestr("license.txt", lic_bytes)
        with zipfile.ZipFile(out) as z:
            bad = z.testzip()
            if bad:
                errors.append(f"{os.path.basename(out)} fails its CRC check at {bad}")
            if z.read("license.txt") != lic_bytes:
                errors.append("license.txt in the output differs from the one it was given")
            if json.loads(z.read("meta.json"))["count"] != measure["splats"]:
                errors.append("the output's splat count differs from the input's")
        lic = read_license(lic_bytes.decode("utf-8", errors="replace"))

    record = {"_pcq_polish": polish, "_pcq_scale": scale,
              "_pcq_splat_transform": sm.SPLAT_TRANSFORM_VERSION}
    if lic_bytes is not None:
        missing = [k for k in NEEDED if not lic.get(k)]
        if missing:
            errors.append(f"the licence gives no {', '.join(missing)}: _pcq_source needs the "
                          "title, creator and link, and _pcq_license the licence's URL "
                          "(map-format.md section 7)")
        elif len(lic["source"].split()) != 1:
            errors.append(f"the Source {lic['source']!r} is not a single link (L29)")
    if lic:
        author = re.sub(r"\s*\(.*\)$", "", lic.get("author", "")).strip()
        record["_pcq_source"] = f"{lic.get('title', '')} by {author}, {lic.get('source', '')}"
        record["_pcq_license"] = spdx(lic.get("license url"))
        if not record["_pcq_license"]:
            errors.append(f"cannot name the licence {lic.get('license')!r} "
                          f"({lic.get('license url')}) as an SPDX identifier")
        for key in ("_pcq_source", "_pcq_license"):
            if record.get(key) and ('"' in record[key] or len(record[key]) > 1023):
                errors.append(f"{key} cannot ride in an entity token: {record[key]!r}")

    # The verify, checked.
    if measure.get("outdoor"):
        max_tilt, max_yaw, max_clear = (OUTDOOR_MAX_TILT_DEG, OUTDOOR_MAX_YAW_DEG,
                                        OUTDOOR_MAX_CLEAR_CHANGE)
    else:
        max_tilt, max_yaw, max_clear = MAX_TILT_DEG, MAX_YAW_DEG, MAX_CLEAR_CHANGE
    tilt = verify["tilt_from_hint_deg"]
    yaw = verify["yaw_deg"]
    floor_units = verify["floor_y_units"] * sm.UNITS_PER_METRE  # the output is in metres
    clear_in = measure["clear_height_units"] * measure["scale_m_per_unit"]
    clear_out = verify["clear_height_units"]
    change = abs(clear_out - clear_in) / clear_in
    checks = [
        (tilt <= max_tilt, f"tilt {tilt:.3f} deg (at most {max_tilt})"),
        (abs(yaw) <= max_yaw, f"yaw {yaw:+.3f} deg (at most {max_yaw})"),
        (abs(floor_units) <= MAX_FLOOR_UNITS,
         f"floor {floor_units:+.2f} units from z = 0 (at most {MAX_FLOOR_UNITS})"),
        (change <= max_clear,
         f"clear height {clear_out:.3f} m against {clear_in:.3f} m expected "
         f"({change:.2%}; at most {max_clear:.1%})"),
    ]
    print("  verify:")
    for ok, what in checks:
        print(f"    {'ok  ' if ok else 'FAIL'} {what}")
        if not ok:
            errors.append(f"the verify is not clean: {what}")

    record.update({
        "input": os.path.basename(src),
        "transform": " ".join(st_args),
        "license": lic or None,
        "verify": {"tilt_deg": tilt, "yaw_deg": yaw, "floor_units": round(floor_units, 3),
                   "clear_height_m": round(clear_out, 3), "footprint_m": verify["footprint_units"]},
        "errors": errors, "warnings": warnings,
    })
    rec_path = os.path.splitext(out)[0] + ".polish.json"
    with open(rec_path, "w", encoding="utf-8") as fh:
        json.dump(record, fh, indent=2)
    for key in ("_pcq_source", "_pcq_license", "_pcq_polish", "_pcq_scale", "_pcq_splat_transform"):
        if key in record:
            print(f'  "{key}" "{record[key]}"')
    print(f"  wrote {rec_path}")
    for w in warnings:
        print(f"  WARNING: {w}")
    if errors:
        for e in errors:
            print(f"  ERROR: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
