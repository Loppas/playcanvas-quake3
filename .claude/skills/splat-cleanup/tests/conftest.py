"""The skill's scripts and splat-maps' test tools on the path, and splat-transform as a stand-in.

Run from `splat-maps/`, in its environment: `uv run pytest ../.claude/skills/splat-cleanup/tests`.
"""

import json
import sys
from pathlib import Path

import pytest

from splat_maps import splat_map as sm

SKILL = Path(__file__).resolve().parents[1]
REPO = SKILL.parents[2]
sys.path[:0] = [str(SKILL / "scripts"), str(REPO / "splat-maps" / "tests")]

#: `-w [-q] <in.ply> [--filter-value name,cmp,value ...] <out>`: keeps the rows every comparison
#: holds for, on the raw column, and writes them as a PLY, or as a bundle whose `meta.json` gives
#: their count and columns, with no `license.txt`, as the real writer drops it. Logs each run's
#: arguments and the rows it was given to `splat-transform.log`.
STAND_IN = f"""import json, sys, zipfile
from pathlib import Path
if sys.argv[1:] == ["--version"]:
    print("splat-transform v{sm.SPLAT_TRANSFORM_VERSION} (a stand-in)")
    sys.exit(0)
sys.path.insert(0, {str(SKILL / "scripts")!r})
import numpy as np
import splatlib as sl
args = [a for a in sys.argv[1:] if a not in ("-w", "-q")]
names, data = sl.read_ply(args[0])
with open(Path(__file__).with_suffix(".log"), "a", encoding="utf-8") as log:
    log.write(json.dumps({{"args": args, "rows": len(data)}}) + "\\n")
keep = np.ones(len(data), bool)
compare = {{"lt": np.less, "gt": np.greater, "eq": np.equal}}
actions = args[1:-1]
while actions:
    flag, value, *actions = actions
    if flag != "--filter-value":
        sys.exit(f"the stand-in has no {{flag}}")
    name, cmp, number = value.split(",")
    keep &= compare[cmp](data[:, names.index(name)], float(number))
if args[-1].endswith(".ply"):
    sl.write_ply(args[-1], names, data[keep])
else:
    with zipfile.ZipFile(args[-1], "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("meta.json", json.dumps({{"count": int(keep.sum()), "names": names}}))
"""


@pytest.fixture
def splat_transform(tmp_path, monkeypatch):
    """The stand-in, and all of PATH. Returns its runs: each run's arguments and rows given."""
    from tools import install  # splat-maps' own, on the path above

    folder = tmp_path / "bin"
    install(folder, "splat-transform", STAND_IN)
    monkeypatch.setenv("PATH", str(folder))
    log = folder / "splat-transform.log"
    return lambda: [json.loads(line) for line in log.read_text(encoding="utf-8").splitlines()]
