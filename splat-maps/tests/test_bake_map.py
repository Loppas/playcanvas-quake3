"""The bake's box and `--outdoor`, as far as they reach without a GPU: the box's corners as
splat-transform reads them, the shell that seals an outdoor box, what the bake refuses, and the
command it runs, against a stand-in splat-transform whose bake the measuring then rejects."""

import itertools
import math
import os

import numpy as np
import pytest

from room import run_cli
from splat_maps import bake_map
from splat_maps import splat_map as sm
from tools import LOG, install, runs, splat_transform


def read_shell(ply):
    """A shell PLY's Gaussians: their centres in Q3 units, one per row, and their standard
    deviations in units and opacities, each the same for all."""
    head, body = ply.split(b"end_header\n")
    lines = head.decode("ascii").splitlines()
    assert lines[:2] == ["ply", "format binary_little_endian 1.0"]
    count = int(lines[2].split()[2])
    names = [line.split()[2] for line in lines[3:]]
    rows = np.frombuffer(body, "<f4").reshape(count, len(names))
    col = {name: rows[:, i].astype(float) for i, name in enumerate(names)}
    sigmas = {float(s) for i in range(3) for s in np.exp(col[f"scale_{i}"]) * sm.UNITS_PER_METRE}
    opacities = set(1 / (1 + np.exp(-col["opacity"])))
    assert len(sigmas) == 1 and len(opacities) == 1
    assert {tuple(r) for r in np.column_stack([col[f"rot_{i}"] for i in range(4)])} == {(1, 0, 0, 0)}
    centres = np.column_stack(sm.world_to_sim((col["x"], col["y"], col["z"])))
    return centres, sigmas.pop(), opacities.pop()


@pytest.mark.parametrize("box, v", [
    ((-64, -48, -16, 64, 48, 80), 8),
    ((-43, -37, -11, 50, 41, 67), 5),
], ids=["on the lattice, even", "off it, odd"])
def test_the_shell_makes_a_solid_wall_one_voxel_thick_inside_each_face(box, v):
    centres, sigma, opacity = read_shell(bake_map.shell_ply(box, v))
    # Every voxel a Gaussian's three-sigma box reaches, on the v-unit lattice the grid is
    # aligned to. Each holds the centre on its boundary, so its nearest point is the centre and
    # it gets the whole opacity, far past splat-transform's 0.1.
    assert 1 - math.exp(-opacity) > 0.5
    reached = set()
    for c in centres:
        ranges = [range(math.floor((x - 3 * sigma) / v), math.ceil((x + 3 * sigma) / v))
                  for x in c]
        for cell in itertools.product(*ranges):
            assert all(k * v <= x <= (k + 1) * v for x, k in zip(c, cell))
            reached.add(cell)
    lo = [math.ceil(c / v) for c in box[:3]]
    hi = [math.floor(c / v) for c in box[3:]]
    inside = set(itertools.product(*(range(a, b) for a, b in zip(lo, hi))))
    wall = {c for c in inside if any(c[i] in (lo[i], hi[i] - 1) for i in range(3))}
    assert wall <= reached
    assert not (inside - wall) & reached
    # What reaches past the box is at most one voxel past it, outside the wall.
    assert all(lo[i] - 1 <= c[i] <= hi[i] for c in reached for i in range(3))


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


def shell_keeper(version):
    """splat-transform at `version`, which keeps a copy of any PLY it is given as `shell.ply`
    beside itself, and writes nothing."""
    return f"""import shutil, sys

if sys.argv[1:] == ["--version"]:
    print("splat-transform v{version} (a stand-in)")
    sys.exit(0)
{LOG}
for arg in args:
    if arg.endswith(".ply"):
        shutil.copyfile(arg, Path(__file__).with_name("shell.ply"))
"""


@pytest.mark.parametrize("given", [["--outdoor", "--box=-640,-704,-32,640,704,256"],
                                   ["--outdoor"],
                                   ["--fill", "16", "--box=-640,-704,-32,640,704,256"]],
                         ids=["outdoor with a box", "outdoor alone", "indoors"])
def test_only_an_outdoor_box_is_sealed_by_a_shell_after_the_cropped_input(room, tmp_path,
                                                                         monkeypatch, given):
    tool = install(tmp_path / "bin", "splat-transform", shell_keeper(sm.SPLAT_TRANSFORM_VERSION))
    monkeypatch.setenv("PATH", str(tool.parent) + os.pathsep + os.environ["PATH"])
    code, out = run_cli("bake", room, "--seed", "0,0,32", "--voxel", "5", *given)
    # The stand-in bakes nothing, so the measuring stops the bake, and nothing else does.
    assert code == 1 and "Traceback" not in out, out
    [args] = runs(tool)
    after = args[args.index(str(room)) + 1:-1]
    sealed = "--outdoor" in given and len(given) == 2
    if sealed:
        # The crop is the input's action, so the shell follows it, uncut, as a second input.
        assert after[:2] == ["--filter-box", "-20,-8,-22,20,1,22"]
        assert after[2:] == [after[2]] and after[2].endswith(".ply")
        assert (tool.parent / "shell.ply").read_bytes() == \
            bake_map.shell_ply((-640, -704, -32, 640, 704, 256), 5)
    else:
        assert not any(a.endswith(".ply") for a in after)
    assert (tool.parent / "shell.ply").exists() is sealed
