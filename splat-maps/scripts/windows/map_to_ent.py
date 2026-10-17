"""Keep a saved `.map`'s point entities and write them as a splat map's `<stem>.ent`.

A map editor saves a `.map`: entities of key/value pairs, some carrying brushes and patches. A
splat map carries no brushes (`map-format.md` §3.3), so this keeps:
  - worldspawn's keys, dropping its brushes;
  - every point entity, as it is;
and it drops:
  - `func_group`, which is the editor's grouping and nothing at run time;
  - the `misc_model` that shows the collision mesh as a reference, found by its model path;
and it refuses every other entity with brushes or patches, since Q3 would need an inline model
for it (§3.3).

It reads with Q3's tokenizer, so NetRadiant's `// entity N` and `//@$&` layer comments are
skipped, and all three brush syntaxes are skipped alike (axial, Valve 220, brushDef) along with
`patchDef2`. The result is read back by Q3's rules.

Usage:
    python map_to_ent.py <file>.map <stem>.ent [--reference <stem>_collision.obj]
"""

import argparse
import os
import sys

import splat_map as sm


def read_map(data):
    """The `.map`'s entities as (pairs, primitive count, first line), in file order."""
    tok = sm.Tokenizer(data)
    out = []
    while True:
        t = tok.next()
        if t is None:
            return out
        if t != "{":
            raise sm.FormatError(f"expected {{ at line {tok.line}, found {t!r}")
        line, pairs, prims = tok.line, [], 0
        while True:
            t = tok.next()
            if t is None:
                raise sm.FormatError(f"the entity at line {line} does not close")
            if t == "}":
                break
            if t == "{":
                prims += 1
                depth = 1
                while depth:
                    t = tok.next()
                    if t is None:
                        raise sm.FormatError(f"a brush or patch in the entity at line {line} "
                                             "does not close")
                    depth += (t == "{") - (t == "}")
                continue
            value = tok.next()
            if value is None:
                raise sm.FormatError(f"the entity at line {line} ends inside a key")
            pairs.append((t, value))
        out.append((pairs, prims, line))


def main():
    ap = argparse.ArgumentParser(description="Keep a .map's point entities as a splat map .ent.")
    ap.add_argument("map", help="the editor's saved .map")
    ap.add_argument("out", help="the .ent to write")
    ap.add_argument("--reference", help="the reference model's file name, whose misc_model is "
                                        "dropped (default: any model ending _collision.obj)")
    args = ap.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")

    with open(args.map, "rb") as fh:
        try:
            ents = read_map(fh.read())
        except sm.FormatError as e:
            sys.exit(f"ERROR: {args.map}: {e}")
    if not ents:
        sys.exit(f"ERROR: {args.map} has no entities")

    def classname(pairs):
        return next((v for k, v in pairs if k.lower() == "classname"), "")

    def is_reference(pairs):
        model = next((v for k, v in pairs if k.lower() == "model"), "")
        name = os.path.basename(model.replace("\\", "/"))
        wanted = os.path.basename(args.reference) if args.reference else None
        return name == wanted if wanted else name.endswith("_collision.obj")

    kept, notes, dropped, refused = [], [], [], []
    for pairs, prims, line in ents:
        cls = classname(pairs)
        if cls == "worldspawn":
            kept.append(pairs)
            notes.append(f"worldspawn, less its {prims} brush{'es' * (prims != 1)}"
                         if prims else "")
        elif cls == "func_group":
            dropped.append(f"func_group at line {line}")
        elif cls == "misc_model" and is_reference(pairs):
            dropped.append(f"the reference misc_model at line {line}")
        elif prims:
            refused.append(f"{cls or 'an entity'} at line {line}, "
                           f"with {prims} brush(es) or patch(es)")
        else:
            kept.append(pairs)
            notes.append(f"from {os.path.basename(args.map)} line {line}")
    if refused:
        sys.exit("ERROR: a splat map has no inline models, so these cannot be carried "
                 "(map-format.md section 3.3): " + "; ".join(refused))
    if not kept or classname(kept[0]) != "worldspawn":
        sys.exit("ERROR: the .map's first kept entity is not worldspawn")

    text = sm.format_entities(kept, notes)
    with open(args.out, "w", encoding="ascii", newline="\n") as fh:
        fh.write(text)
    with open(args.out, "rb") as fh:
        back, _ = sm.parse_entities(fh.read())
    if [e.pairs for e in back] != kept:
        sys.exit("ERROR: the .ent does not read back as written")
    spots = sm.spawn_spots(back)
    print(f"wrote {args.out}: {len(back)} entities, {len(spots)} spawn spot(s)")
    for d in dropped:
        print(f"  dropped {d}")
    if not spots:
        print("WARNING: no spawn spot; the map cannot be played until it has one")


if __name__ == "__main__":
    main()
