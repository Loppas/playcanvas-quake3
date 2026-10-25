"""`levelshot.py`'s render, as far as it reaches without a GPU: the splat it renders."""

import json
import os

import pytest

from room import run_cli
from splat_maps import splat_map as sm
from tools import install, runs, splat_transform


@pytest.mark.parametrize("filtered", [True, False], ids=["filtered", "drawn whole"])
def test_the_levelshot_renders_the_splat_the_map_draws(room, tmp_path, monkeypatch, filtered):
    tool = install(tmp_path / "bin", "splat-transform",
                   splat_transform(sm.SPLAT_TRANSFORM_VERSION))
    monkeypatch.setenv("PATH", str(tool.parent) + os.pathsep + os.environ["PATH"])
    drawn = room.with_name("room.drawn.sog")
    drawn.write_bytes(room.read_bytes())
    if filtered:
        record = room.with_name("room.bake.json")
        record.write_text(json.dumps({**json.loads(record.read_text(encoding="utf-8")),
                                      "drawn": drawn.name}), encoding="utf-8")
    code, out = run_cli("levelshot", room)
    # The stand-in renders nothing, so the levelshot stops at reading the frame.
    assert code == 1, out
    [render] = runs(tool)
    assert render[:3] == ["-w", "-q", str(drawn if filtered else room)]
