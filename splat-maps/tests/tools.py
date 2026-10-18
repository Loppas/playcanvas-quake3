"""Stand-ins for npm and splat-transform, put on PATH in the form npm gives a command here.

Each is a Python script, started the way npm starts a command it installs: through a `.cmd` on
Windows, and an executable shell script elsewhere.
"""

import os
import sys
from pathlib import Path

TESTS = Path(__file__).parent


def install(folder, name, code):
    """The command `name` in `folder`, running the Python `code`; returns the command's path."""
    folder = Path(folder)
    folder.mkdir(parents=True, exist_ok=True)
    script = folder / f"{name}.py"
    script.write_text(code, encoding="utf-8")
    if os.name == "nt":
        command = folder / f"{name}.cmd"
        command.write_text(f'@"{sys.executable}" "{script}" %*\n', encoding="utf-8")
    else:
        command = folder / name
        command.write_text(f'#!/bin/sh\nexec "{sys.executable}" "{script}" "$@"\n',
                           encoding="utf-8")
        command.chmod(0o755)
    return command


def splat_transform(version):
    """splat-transform at `version`. `-w <in> ... <out>` copies the bundle as its writer does,
    dropping `license.txt`, and logs its arguments, one run a line, to `splat-transform.log`."""
    return f"""import json, sys, zipfile
from pathlib import Path

args = sys.argv[1:]
if args == ["--version"]:
    print("splat-transform v{version} (a stand-in)")
    sys.exit(0)
with open(Path(__file__).with_name("splat-transform.log"), "a", encoding="utf-8") as log:
    log.write(json.dumps(args) + "\\n")
with zipfile.ZipFile(args[1]) as src, zipfile.ZipFile(args[-1], "w") as out:
    for item in src.infolist():
        if item.filename != "license.txt":
            out.writestr(item, src.read(item))
"""


def npm(version):
    """npm, whose `install` writes `npm.log` and installs splat-transform at `version` beside
    itself."""
    return f"""import sys
from pathlib import Path

sys.path.insert(0, {str(TESTS)!r})
from tools import install, splat_transform

here = Path(__file__).parent
(here / "npm.log").write_text(" ".join(sys.argv[1:]), encoding="utf-8")
install(here, "splat-transform", splat_transform({version!r}))
"""
