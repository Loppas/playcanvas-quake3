"""Stand-ins for the tools the stages run, put on PATH in the form npm gives a command here:
npm, splat-transform, ffmpeg and COLMAP, and gsplat's trainer in a checkout of its own.

Each is a Python script, started the way npm starts a command it installs: through a `.cmd` on
Windows, and an executable shell script elsewhere. Each logs its arguments, one run a line, to
`<name>.log` beside itself.
"""

import json
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


#: Every stand-in starts by logging its arguments.
LOG = """import json, sys
from pathlib import Path

args = sys.argv[1:]
with open(Path(__file__).with_suffix(".log"), "a", encoding="utf-8") as log:
    log.write(json.dumps(args) + "\\n")
"""


def runs(command):
    """The arguments of each run of an installed stand-in, from its log."""
    log = command.parent / f"{command.stem}.log"
    return [json.loads(line) for line in log.read_text(encoding="utf-8").splitlines()]


def splat_transform(version):
    """splat-transform at `version`. `-w <in> ... <out>` copies a bundle as its writer does,
    dropping `license.txt`, and any other input, a PLY, as it is."""
    return f"""import shutil, sys, zipfile

if sys.argv[1:] == ["--version"]:
    print("splat-transform v{version} (a stand-in)")
    sys.exit(0)
{LOG}
if not zipfile.is_zipfile(args[1]):
    shutil.copyfile(args[1], args[-1])
    sys.exit(0)
with zipfile.ZipFile(args[1]) as src, zipfile.ZipFile(args[-1], "w") as out:
    for item in src.infolist():
        if item.filename != "license.txt":
            out.writestr(item, src.read(item))
"""


def ffmpeg(frames, blurred=()):
    """ffmpeg, writing `frames` frames to the pattern it is given last: noise, the first frame's
    over the full range and the others' over a quarter of it, so far less sharp, but for those
    numbered in `blurred`, which are flat grey."""
    return f"""{LOG}
import numpy as np
from PIL import Image

rng = np.random.default_rng(0)
for i in range(1, {frames} + 1):
    if i in {tuple(blurred)!r}:
        grey = np.full((48, 64), 128, np.uint8)
    else:
        grey = rng.integers(0, 256, (48, 64), dtype=np.uint8) if i == 1 else \\
            rng.integers(96, 160, (48, 64), dtype=np.uint8)
    Image.fromarray(grey).save(args[-1] % i, "JPEG")
"""


def colmap(models):
    """COLMAP, whose mapper makes `models`, {name: frames registered}, and whose
    model_analyzer reports a model's count as COLMAP does."""
    return f"""{LOG}
value = dict(zip(args[1::2], args[2::2]))
if args[0] == "feature_extractor":
    Path(value["--database_path"]).write_bytes(b"db")
elif args[0] == "mapper":
    for name, count in {models!r}.items():
        model = Path(value["--output_path"], name)
        model.mkdir()
        (model / "registered").write_text(str(count))
elif args[0] == "model_analyzer":
    print("Registered images:", (Path(value["--path"]) / "registered").read_text())
"""


def gsplat(checkout):
    """A checkout of gsplat whose `simple_trainer.py` logs its arguments, folder and Python,
    and saves a PLY at step 7,000 and at its last, as gsplat's does."""
    examples = Path(checkout) / "examples"
    examples.mkdir(parents=True)
    (examples / "simple_trainer.py").write_text(f"""import os
{LOG}
print(json.dumps({{"cwd": os.getcwd(), "python": sys.executable}}))
value = dict(zip(args[1::2], args[2::2]))
ply = Path(value["--result-dir"], "ply")
ply.mkdir(parents=True)
for step in (6999, int(value["--max-steps"]) - 1):
    (ply / f"point_cloud_{{step}}.ply").write_text(f"step {{step}}")
""", encoding="utf-8")
    return examples / "simple_trainer.py"


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
