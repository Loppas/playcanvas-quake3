"""The bake's box and `--outdoor`, as far as they reach without a GPU: the box's corners as
splat-transform reads them, what the bake refuses, and the command it runs, against a stand-in
splat-transform whose bake the measuring then rejects."""

import os

import pytest

from room import run_cli
from splat_maps import bake_map
from splat_maps import splat_map as sm
from tools import install, runs, splat_transform


def test_the_box_turns_into_the_octree_s_frame():
    # Forward stays x, negated; up, z, becomes -y; left, y, becomes -z.
    assert bake_map.filter_box("-640,-704,-32,640,704,256") == "-20,-8,-22,20,1,22"


def test_a_box_on_the_map_s_one_side_lies_on_the_octree_s_other():
    # splat-transform reads its box turned 180 degrees about Z: the map's +x is its -x.
    assert bake_map.filter_box("0,-3200,-3200,3200,3200,3200") == "-100,-100,-100,0,100,100"


@pytest.mark.parametrize("box", ["1,2,3", "0,0,0,0,1,1", "a,b,c,d,e,f"])
def test_a_box_that_is_not_one_is_refused(box):
    with pytest.raises(ValueError, match="is not x0,y0,z0,x1,y1,z1"):
        bake_map.filter_box(box)


def test_outdoor_leaves_no_fill_to_size(room):
    code, out = run_cli("bake", room, "--outdoor", "--fill", "16")
    assert code == 1
    assert "--fill sizes the exterior fill, which --outdoor leaves out" in out


@pytest.mark.parametrize("outdoor", [True, False], ids=["outdoor", "fill given"])
def test_the_bake_crops_after_its_input_and_fills_only_indoors(room, tmp_path, monkeypatch,
                                                               outdoor):
    tool = install(tmp_path / "bin", "splat-transform",
                   splat_transform(sm.SPLAT_TRANSFORM_VERSION))
    monkeypatch.setenv("PATH", str(tool.parent) + os.pathsep + os.environ["PATH"])
    given = ["--outdoor"] if outdoor else ["--fill", "16"]
    code, out = run_cli("bake", room, "--seed", "0,0,32", "--box=-640,-704,-32,640,704,256",
                        *given)
    # The stand-in writes no octree, so the measuring stops the bake.
    assert code == 1, out
    [args] = runs(tool)
    at = args.index(str(room))
    assert args[at + 1:at + 3] == ["--filter-box", "-20,-8,-22,20,1,22"]
    assert ("--voxel-external-fill" in args) is not outdoor
