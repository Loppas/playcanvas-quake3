"""The CLI: `splat-maps <stage> [args]`, or `python -m splat_maps <stage> [args]`.

Each stage is a module whose `main(argv, prog)` parses its own arguments. The CLI finds the
module by the stage's words and hands it the rest of the command line.
"""

import importlib
import sys
from importlib.metadata import version

PROG = "splat-maps"

#: Each stage's module, by the words that run it. `entities` has a word for each way of placing
#: them: an editor's reference model, the `.map` saved from it, or `viewpos` readings.
STAGES = {
    ("polish",): "polish",
    ("bake",): "bake_map",
    ("entities", "reference"): "glb_to_editor",
    ("entities", "from-map"): "map_to_ent",
    ("entities", "readings"): "write_ent",
    ("levelshot",): "levelshot",
    ("arena",): "write_arena",
    ("package",): "package_map",
    ("deliver",): "deliver_map",
    ("lint",): "map_lint",
}


def usage(under=()):
    """The stages whose words start with `under`, each with its module's summary."""
    lines = [f"usage: {PROG} <stage> [args]   ({PROG} <stage> --help for its arguments)", "",
             "stages:"]
    for words, name in STAGES.items():
        if words[:len(under)] == under:
            doc = importlib.import_module(f".{name}", __package__).__doc__
            lines.append(f"  {' '.join(words):20s} {doc.strip().splitlines()[0]}")
    return "\n".join(lines)


def main(argv=None):
    args = sys.argv[1:] if argv is None else list(argv)
    if args[:1] == ["--version"]:
        print(f"{PROG} {version(PROG)}")
        return 0
    for words, name in STAGES.items():
        if tuple(args[:len(words)]) == words:
            module = importlib.import_module(f".{name}", __package__)
            module.main(args[len(words):], prog=" ".join((PROG, *words)))
            return 0

    # No stage named in full: list those under the word given, so `entities` lists its own.
    first = args[0] if args else None
    under = (first,) if any(words[0] == first for words in STAGES) else ()
    asked = "-h" in args or "--help" in args
    print(usage(under), file=sys.stdout if asked else sys.stderr)
    if args and not under and not asked:
        print(f"\n{PROG}: no stage {args[0]!r}", file=sys.stderr)
    return 0 if asked else 2


if __name__ == "__main__":
    sys.exit(main())
