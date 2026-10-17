"""Write a splat map's arena block, `scripts/<n>.arena`, and read it back as Q3 would.

The arena block is Q3's own file, unchanged (`map-format.md` §4): how menus list a map without
loading it. This writes one block from arguments, in retail's layout (keys bare, values quoted,
one pair per line), then re-reads it with `G_ParseInfos`'s rules (g_bot.c:68-110) and checks it
against the lint's arena rules (L25-L27).

Usage:
    python write_arena.py <out/<stem>.arena> [--longname TEXT] [--type "ffa tourney team"]
                          [--ent <stem>.ent] [--fraglimit N] [--timelimit N] [--bots NAMES]
                          [--special Training|Final]

The `map` key is the stem, taken from the file's name. `--longname` defaults to the `.ent`'s
worldspawn `message`, and `--type` to `ffa`.
"""

import argparse
import os
import sys

import splat_map as sm

#: The gametype tokens the menus know (`GametypeBits`, ui_startserver.c:113-151), and the
#: port's `clanarena` for Clan Arena. Others are ignored there, so the lint only warns about them.
KNOWN_TYPES = ("ffa", "tourney", "single", "team", "ctf", "clanarena")


def main():
    ap = argparse.ArgumentParser(description="Write a splat map's arena block.")
    ap.add_argument("out", help="the file to write, <stem>.arena")
    ap.add_argument("--longname", help="the display name (default: the .ent's worldspawn message)")
    ap.add_argument("--type", default="ffa", help="space-separated gametypes (default ffa)")
    ap.add_argument("--ent", help="the map's .ent, for the default longname and a check against it")
    ap.add_argument("--fraglimit", type=int, help="Single Player only (g_bot.c:1029-1044)")
    ap.add_argument("--timelimit", type=int, help="Single Player only")
    ap.add_argument("--bots", help="bot names for Single Player")
    ap.add_argument("--special", choices=("Training", "Final"), help="a Single Player tier")
    args = ap.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")

    stem = sm.stem_of(args.out, ".arena")
    if not sm.STEM_RE.match(stem):
        sys.exit(f"ERROR: the stem {stem!r} is not [a-z0-9_], at most 44 characters "
                 "(map-format.md section 2.3)")

    message = None
    if args.ent:
        with open(args.ent, "rb") as fh:
            try:
                entities, _ = sm.parse_entities(fh.read())
            except sm.FormatError as e:
                sys.exit(f"ERROR: {args.ent}: {e}")
        message = entities[0].get("message")
    longname = args.longname or message
    if not longname:
        sys.exit("ERROR: no longname: pass --longname, or an .ent whose worldspawn has a message")

    pairs = [("map", stem), ("longname", longname), ("type", " ".join(args.type.split()))]
    for key in ("fraglimit", "timelimit", "bots", "special"):
        value = getattr(args, key)
        if value is not None:
            pairs.append((key, str(value)))
    try:
        text = sm.format_arena(pairs)
    except sm.FormatError as e:
        sys.exit(f"ERROR: {e}")
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w", encoding="ascii", newline="\n") as fh:
        fh.write(text)

    # Read it back as the game and the menus read it.
    errors, warnings = [], []
    with open(args.out, "rb") as fh:
        try:
            blocks = sm.parse_arena(fh.read())
        except sm.FormatError as e:
            sys.exit(f"ERROR: the arena does not read back: {e}")
    if len(blocks) != 1:
        errors.append(f"{len(blocks)} blocks, not one (L25)")
    got = dict((k.lower(), v) for k, v in blocks[0]) if blocks else {}
    if got.get("map") != stem:
        errors.append(f"map is {got.get('map')!r}, not the stem {stem!r} (L25)")
    for key in ("longname", "type"):
        if not got.get(key):
            errors.append(f"{key} is not set (L25)")
    unknown = [t for t in got.get("type", "").split() if t not in KNOWN_TYPES]
    if unknown:
        warnings.append(f"type tokens the menus ignore: {' '.join(unknown)} (L26)")
    if message is not None and got.get("longname") != message:
        warnings.append(f"longname {got.get('longname')!r} differs from worldspawn's message "
                        f"{message!r} (L27)")

    print(text, end="")
    print(f"wrote {args.out}")
    for w in warnings:
        print(f"WARNING: {w}")
    if errors:
        for e in errors:
            print(f"ERROR: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
