"""Record what the polish did, keep the source's licence, and check the verify.

The last step of polish.bat. The polish's parameters used to survive nowhere (the port's garage
had to be reconstructed from a log), and `splat-transform -w` drops a SOG bundle's
`license.txt`, which is how the source's CC BY credit was lost. This:
  1. puts the input's `license.txt` back into the output bundle, stored, as the source had it.
     A capture with none, such as these scripts' own `deliver.bat` writes, takes one from
     `--license`: a file in superspl.at's layout, or the same `Key: value` fields in one string,
     separated by semicolons. A source that carries its own is never replaced;
  2. writes `<output stem>.polish.json`, holding the `_pcq_*` keys the polish owns
     (`map-format.md` §7) and what the verify measured;
  3. refuses the output unless the verify found it level, square, with its floor at 0 and its
     clear height kept.

Usage:
    python -m splat_maps.polish_record <input.sog> <output.sog> [--license FILE|FIELDS]
                                       [the sog_inspect arguments polish.bat ran]

It reads the two reports sog_inspect wrote: `<input>_inspect/report.json` (the measure) and
`<output>_inspect/report.json` (the verify).
"""

import json
import os
import re
import sys
import zipfile

from . import splat_map as sm

#: What a verify must show. The shipped garage verifies at 0.044 deg of tilt, -0.02 deg of yaw
#: and its floor 0.23 units low, so these leave room without letting a real error through.
MAX_TILT_DEG = 0.1
MAX_YAW_DEG = 0.1
MAX_FLOOR_UNITS = 1.0
MAX_CLEAR_CHANGE = 0.005

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


def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    sys.stdout.reconfigure(encoding="utf-8")
    src, out = sys.argv[1], sys.argv[2]
    inspect_args = sys.argv[3:]
    errors, warnings = [], []
    given = None
    if "--license" in inspect_args:
        i = inspect_args.index("--license")
        if i + 1 >= len(inspect_args):
            sys.exit("ERROR: --license needs a file or 'Key: value; ...' fields")
        given = given_license(inspect_args[i + 1])
        del inspect_args[i:i + 2]

    measure = json.load(open(os.path.splitext(src)[0] + "_inspect/report.json", encoding="utf-8"))
    verify = json.load(open(os.path.splitext(out)[0] + "_inspect/report.json", encoding="utf-8"))

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

    # 1. The licence, back into the bundle: the source's own, or else the one given.
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
              "_pcq_splat_transform": sm.splat_transform_version()}
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

    # 3. The verify, checked.
    tilt = verify["tilt_from_hint_deg"]
    yaw = verify["yaw_deg"]
    floor_units = verify["floor_y_units"] * sm.UNITS_PER_METRE  # the output is in metres
    clear_in = measure["clear_height_units"] * measure["scale_m_per_unit"]
    clear_out = verify["clear_height_units"]
    change = abs(clear_out - clear_in) / clear_in
    checks = [
        (tilt <= MAX_TILT_DEG, f"tilt {tilt:.3f} deg (at most {MAX_TILT_DEG})"),
        (abs(yaw) <= MAX_YAW_DEG, f"yaw {yaw:+.3f} deg (at most {MAX_YAW_DEG})"),
        (abs(floor_units) <= MAX_FLOOR_UNITS,
         f"floor {floor_units:+.2f} units from z = 0 (at most {MAX_FLOOR_UNITS})"),
        (change <= MAX_CLEAR_CHANGE,
         f"clear height {clear_out:.3f} m against {clear_in:.3f} m expected "
         f"({change:.2%}; at most {MAX_CLEAR_CHANGE:.1%})"),
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
