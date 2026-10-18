"""Assemble a splat map's pk3, `map-<stem>.pk3`, from the files the other steps wrote.

The working folder holds each part under the map's stem, as the steps write them:

    <stem>.sog              the polished splat (polish)
    <stem>.polish.json      what the polish did, and the source's licence
    <stem>.voxel.json/.bin  the collision octree (bake)
    <stem>.collision.glb    its debug mesh
    <stem>.bake.json        the bake's flags and measurements
    <stem>.ent              the entity text, written by a person
    <stem>.arena            the arena block (arena)
    <stem>.tga              the levelshot (levelshot)

This puts each at its Q3 path (`map-format.md` §2.1). It writes the `_pcq_*` keys into the
packed `.ent`'s worldspawn, replacing any it finds, as q3map2 writes its own keys at compile
time (§7). It writes the readme `<stem>.txt` from `templates/readme.txt`. The `.sog` is stored,
since it is a zip already, and everything else is deflated (§8). Entries carry a fixed date,
so the same inputs always make the same bytes.

It then reads the pk3 back and checks it entry by entry against what it packed, and runs the
lint.

Usage:
    splat-maps package <dir>/<stem>.sog --author NAME [--out-dir DIR]
"""

import argparse
import json
import os
import subprocess
import sys
import textwrap
import zipfile

from . import splat_map as sm

#: The layout's version (§9). It changes only when the spec changes what a reader must do.
PCQ_FORMAT = "1"

#: Every entry's date, so a rebuild from the same inputs is byte-identical. Q3 never reads it.
ZIP_DATE = (1980, 1, 1, 0, 0, 0)

HERE = os.path.dirname(os.path.abspath(__file__))


def pipeline_commit():
    """The short commit of this repository that built the map, with -dirty when the package
    has uncommitted changes."""
    def git(*a):
        run = subprocess.run(["git", "-C", HERE, *a], capture_output=True, text=True)
        return run.stdout.strip()
    sha = git("rev-parse", "--short", "HEAD")
    dirty = git("status", "--porcelain", "--", ".")
    return (sha or "unknown") + ("-dirty" if dirty else "")


def main(argv=None, prog=None):
    ap = argparse.ArgumentParser(prog=prog, description="Assemble a splat map's pk3.")
    ap.add_argument("sog", help="the map's polished .sog, beside its other parts")
    ap.add_argument("--author", required=True, help="who made the map, for the readme")
    ap.add_argument("--out-dir", help="where to write map-<stem>.pk3 (default beside the .sog)")
    args = ap.parse_args(argv)
    sys.stdout.reconfigure(encoding="utf-8")

    stem = sm.stem_of(args.sog, ".sog")
    if not sm.STEM_RE.match(stem):
        sys.exit(f"ERROR: the stem {stem!r} is not [a-z0-9_], at most 44 characters "
                 "(map-format.md section 2.3)")
    here = os.path.dirname(os.path.abspath(args.sog))
    part = lambda suffix: os.path.join(here, stem + suffix)  # noqa: E731
    errors, warnings = [], []

    required = [".sog", ".voxel.json", ".voxel.bin", ".ent", ".polish.json", ".bake.json"]
    missing = [stem + s for s in required if not os.path.exists(part(s))]
    if missing:
        sys.exit("ERROR: missing " + ", ".join(missing))
    polish = json.load(open(part(".polish.json"), encoding="utf-8"))
    bake = json.load(open(part(".bake.json"), encoding="utf-8"))
    if polish.get("errors") or bake.get("errors"):
        sys.exit("ERROR: the polish or the bake recorded errors; fix them and re-run it first")
    if polish.get("_pcq_splat_transform") != bake.get("_pcq_splat_transform"):
        sys.exit(f"ERROR: the polish ran splat-transform {polish.get('_pcq_splat_transform')} and "
                 f"the bake {bake.get('_pcq_splat_transform')} (L19)")
    lic = polish.get("license")
    if not lic:
        sys.exit("ERROR: the polish record carries no source licence, and the readme must credit "
                 "the source (L29). Polish from a .sog that holds the source's license.txt")

    # The packed .ent: the person's entities, with the pipeline's keys in worldspawn.
    with open(part(".ent"), "rb") as fh:
        try:
            entities, tok = sm.parse_entities(fh.read())
        except sm.FormatError as e:
            sys.exit(f"ERROR: {stem}.ent: {e}")
    if tok.truncated:
        sys.exit(f"ERROR: {stem}.ent has tokens Q3 would cut at 1023 bytes: {tok.truncated}")
    world = entities[0]
    if world.classname != "worldspawn":
        sys.exit(f"ERROR: {stem}.ent's first entity is {world.classname!r}, not worldspawn")
    pcq = [
        ("_pcq_format", PCQ_FORMAT),
        ("_pcq_source", polish["_pcq_source"]),
        ("_pcq_license", polish["_pcq_license"]),
        ("_pcq_polish", polish["_pcq_polish"]),
        ("_pcq_scale", polish["_pcq_scale"]),
        ("_pcq_bake", bake["_pcq_bake"]),
        ("_pcq_splat_transform", bake["_pcq_splat_transform"]),
        ("_pcq_pipeline", pipeline_commit()),
    ]
    if pcq[-1][1].endswith("-dirty"):
        warnings.append("splat_maps has uncommitted changes, so _pcq_pipeline names a commit "
                        "that did not build this")
    kept = [(k, v) for k, v in world.pairs if not k.lower().startswith("_pcq_")]
    world.pairs = kept + pcq
    ent_text = sm.format_entities(entities).encode("ascii")
    try:
        sm.parse_entities(ent_text)  # the limits, re-checked with the keys in
    except sm.FormatError as e:
        sys.exit(f"ERROR: with the _pcq_* keys, worldspawn breaks a limit: {e}")

    # The readme, for people.
    arena = None
    if os.path.exists(part(".arena")):
        with open(part(".arena"), "rb") as fh:
            blocks = sm.parse_arena(fh.read())
        arena = dict((k.lower(), v) for k, v in blocks[0]) if blocks else None
    spawns = sm.spawn_spots(entities)
    others = [e for e in entities[1:] if e not in spawns]
    author_url = ""
    source_author = lic.get("author", "")
    if "(" in source_author and source_author.endswith(")"):
        source_author, author_url = source_author[:-1].split("(", 1)
        source_author = source_author.strip()
    title = world.get("message") or stem
    known = "; ".join(bake.get("warnings", [])) or "none measured"

    def wrap(text):
        """A value under a 15-column label, wrapped to 79 columns, each flag kept on one line
        with its value (a no-break space holds them together, since textwrap never breaks on
        one)."""
        words = text.split(" ")
        glued = []
        for w in words:
            if glued and glued[-1].startswith("--") and "\xa0" not in glued[-1] \
                    and not w.startswith("--"):
                glued[-1] += "\xa0" + w
            else:
                glued.append(w)
        filled = textwrap.fill(" ".join(glued), width=79, initial_indent=" " * 15,
                               subsequent_indent=" " * 15, break_on_hyphens=False)
        return filled[15:].replace("\xa0", " ")

    def spoken(spdx):
        """CC-BY-SA-4.0 -> CC BY-SA 4.0, as Creative Commons writes its own names."""
        parts = spdx.split("-")
        if parts[0] == "CC" and len(parts) > 2:
            return f"CC {'-'.join(parts[1:-1])} {parts[-1]}"
        return spdx

    fields = {
        "title": title, "underline": "=" * len(title), "stem": stem, "author": args.author,
        "gametypes": arena["type"] if arena else "any (no arena block, so no menu lists it)",
        "base": wrap(f"\"{lic.get('title', '')}\", a Gaussian-splat capture (see Credits)"),
        "source_title": lic.get("title", ""), "source_author": source_author,
        "source_author_url": author_url or "no link given",
        "source_url": lic.get("source", ""),
        "source_license": spoken(polish["_pcq_license"]),
        "source_license_url": lic.get("license url", ""),
        "license": spoken(polish["_pcq_license"]), "license_url": lic.get("license url", ""),
        "pipeline": pcq[-1][1], "splat_transform": bake["_pcq_splat_transform"],
        "polish": wrap("sog_inspect " + polish["_pcq_polish"]), "scale": polish["_pcq_scale"],
        "bake": wrap("splat-transform " + bake["_pcq_bake"]),
        "entities": f"{len(spawns)} spawn spot{'s' * (len(spawns) != 1)}, "
                    f"{len(others)} other{'s' * (len(others) != 1)}, in Q3 units",
        "levelshot": "levelshots/" + stem + ".tga, from the intermission point"
                     if os.path.exists(part(".tga")) else "none",
        "known": wrap(known),
    }
    with open(os.path.join(HERE, "templates", "readme.txt"), encoding="utf-8") as fh:
        readme = fh.read().format(**fields)
    if not readme.isascii():
        warnings.append("the readme has non-ASCII text")
    readme_bytes = readme.replace("\n", "\r\n").encode("utf-8")

    # The pk3, in section 2.1's order.
    entries = [
        (f"maps/{stem}.sog", part(".sog"), zipfile.ZIP_STORED),
        (f"maps/{stem}.voxel.json", part(".voxel.json"), zipfile.ZIP_DEFLATED),
        (f"maps/{stem}.voxel.bin", part(".voxel.bin"), zipfile.ZIP_DEFLATED),
        (f"maps/{stem}.collision.glb", part(".collision.glb"), zipfile.ZIP_DEFLATED),
        (f"maps/{stem}.ent", ent_text, zipfile.ZIP_DEFLATED),
        (f"scripts/{stem}.arena", part(".arena"), zipfile.ZIP_DEFLATED),
        (f"levelshots/{stem}.tga", part(".tga"), zipfile.ZIP_DEFLATED),
        (f"{stem}.txt", readme_bytes, zipfile.ZIP_DEFLATED),
    ]
    out_dir = args.out_dir or here
    os.makedirs(out_dir, exist_ok=True)
    pk3 = os.path.join(out_dir, f"map-{stem}.pk3")
    packed = {}
    with zipfile.ZipFile(pk3, "w", allowZip64=False) as z:
        for name, src, method in entries:
            if isinstance(src, str):
                if not os.path.exists(src):
                    continue  # an optional part
                with open(src, "rb") as fh:
                    data = fh.read()
            else:
                data = src
            info = zipfile.ZipInfo(name, date_time=ZIP_DATE)
            info.compress_type = method
            info.external_attr = 0o644 << 16
            z.writestr(info, data, compresslevel=9 if method == zipfile.ZIP_DEFLATED else None)
            packed[name] = (data, method)

    # Read it back.
    with zipfile.ZipFile(pk3) as z:
        infos = z.infolist()
        names = [i.filename for i in infos]
        if len(names) != len(set(names)):
            errors.append("duplicate entry names (L1)")
        if z.testzip():
            errors.append(f"CRC check fails at {z.testzip()}")
        for i in infos:
            data, method = packed.get(i.filename, (None, None))
            if data is None:
                errors.append(f"unexpected entry {i.filename}")
                continue
            if i.compress_type != method:
                errors.append(f"{i.filename} is method {i.compress_type}, not {method}")
            if z.read(i.filename) != data:
                errors.append(f"{i.filename} reads back different from what was packed")
            if i.filename != i.filename.lower() or "\\" in i.filename:
                errors.append(f"{i.filename} is not lowercase with forward slashes (L3)")
        with open(pk3, "rb") as fh:
            raw = fh.read()
        if b"PK\x06\x06" in raw[-4096:] or b"PK\x06\x07" in raw[-4096:]:
            errors.append("the pk3 has zip64 records (L1)")

    print(f"=== packaged {pk3}")
    for i in infos:
        kind = "stored" if i.compress_type == zipfile.ZIP_STORED else "deflated"
        print(f"  {i.filename:40s} {i.file_size:>12,} bytes, {kind}")
    print(f"  {os.path.getsize(pk3):,} bytes in all")
    print("  worldspawn's _pcq_* keys:")
    for k, v in pcq:
        print(f'    "{k}" "{v}"')
    for w in warnings:
        print(f"  WARNING: {w}")
    if errors:
        for e in errors:
            print(f"  ERROR: {e}")
        sys.exit(1)

    print(flush=True)  # the lint writes to the same console
    lint = subprocess.run([sys.executable, "-m", "splat_maps", "lint", pk3]).returncode
    if lint != 0:
        sys.exit(lint)


if __name__ == "__main__":
    main()
