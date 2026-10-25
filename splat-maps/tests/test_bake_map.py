"""The bake's box, `--outdoor` and filters, as far as they reach without a GPU: the box's corners
as splat-transform reads them, the shell that seals an outdoor box, what the bake refuses, and
the commands it runs, against stand-in splat-transforms whose bakes the measuring then rejects."""

import itertools
import json
import math
import os
import zipfile

import numpy as np
import pytest

from room import GENERATOR, run_cli, sog_bytes
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


#: The box the filter tests bake, and its corners as splat-transform reads them.
BOX, OCTREE_BOX = "--box=-640,-704,-32,640,704,256", "-20,-8,-22,20,1,22"

#: The room's splat's credit, in superspl.at's layout.
LICENCE = b"Title: Test Room\nAuthor: Nobody\n"

#: What the bake's measuring finds wrong with the room after a stand-in's bake, which leaves the
#: room's own octree in place and writes no debug mesh.
NO_MESH = ["room.collision.glb was not written"]


def filterer(version, removed=None, group="Filter cluster"):
    """splat-transform at `version`. A run that writes a splat copies the first file it is
    given, a bundle, dropping its `license.txt`; with `--filter-cluster`, it prints the cluster
    filter's group as splat-transform does, headed `group`, with `removed` (a count as
    splat-transform rounds it) splats removed. A bake writes nothing."""
    removed_line = f'print("    · removed {removed} gaussians")' if removed else ""
    return f"""import sys, zipfile

sys.stdout.reconfigure(encoding="utf-8")
if sys.argv[1:] == ["--version"]:
    print("splat-transform v{version} (a stand-in)")
    sys.exit(0)
{LOG}
if args[-1].endswith(".voxel.json"):
    sys.exit(0)
src = next(a for a in args if Path(a).is_file())
with zipfile.ZipFile(src) as zin, zipfile.ZipFile(args[-1], "w") as out:
    for item in zin.infolist():
        if item.filename != "license.txt":
            out.writestr(item, zin.read(item))
if "--filter-cluster" in args:
    print("  ▸ {group}")
    print("    · scene: 4m x 10m x 4m, grid: 16 x 40 x 16 voxels (10.2K) @ 25cm")
    print("    · cluster is 9 of 10 blocks")
    {removed_line}
print("  · 1 gaussians · 3 SH bands")
"""


def use(tool_code, tmp_path, monkeypatch):
    """The stand-in `tool_code` as splat-transform, first on PATH."""
    tool = install(tmp_path / "bin", "splat-transform", tool_code)
    monkeypatch.setenv("PATH", str(tool.parent) + os.pathsep + os.environ["PATH"])
    return tool


def license_the_room(sog, count):
    """The room's splat, holding `count` splats and its credit."""
    sog.write_bytes(sog_bytes({"version": 2, "count": count, "asset": {"generator": GENERATOR}}))
    with zipfile.ZipFile(sog, "a") as z:
        z.writestr("license.txt", LICENCE)


def bake_record(sog):
    return json.loads(sog.with_name("room.bake.json").read_text(encoding="utf-8"))


def octree_seed(sim):
    return ",".join(sm.fmt_num(c) for c in sm.sim_to_octree(sim))


def test_the_bake_draws_the_filtered_splat_and_bakes_the_collision_from_it(room, tmp_path,
                                                                         monkeypatch):
    tool = use(filterer(sm.SPLAT_TRANSFORM_VERSION, removed="8.81K"), tmp_path, monkeypatch)
    license_the_room(room, 2_550_850)
    code, out = run_cli("bake", room, "--seed", "0,0,32", "--fill", "16", BOX,
                        "--crop", "--cluster", "--decimate", "50%")
    record = bake_record(room)
    assert code == 1 and record["errors"] == NO_MESH, out
    drawn = str(room.with_name("room.drawn.sog"))
    seed = octree_seed((0, 0, 32))
    # The cluster before the crop, and the decimation last, into a PLY a second run writes as
    # the SOG; then the bake, from the drawn splat, still cropped.
    actions = ["--filter-cluster", "0.25,0.5,0.1", "--filter-box", OCTREE_BOX, "--decimate", "50%"]
    draw, write, bake = runs(tool)
    ply = draw[-1]
    assert ply.endswith(".ply")
    assert draw == ["-w", "--no-tty", "--seed-pos", seed, str(room), *actions, ply]
    assert write == ["-w", "--no-tty", ply, drawn]
    assert bake[bake.index(drawn) + 1:] == ["--filter-box", OCTREE_BOX,
                                            str(room.with_name("room.voxel.json"))]
    assert record["_pcq_filter"] == " ".join(["--seed-pos", seed, *actions])
    assert record["drawn"] == "room.drawn.sog"
    assert (record["polished_splats"], record["drawn_splats"]) == (2_550_850, 2_550_850)
    assert record["cluster"] == {"removed": 8810, "said": ["cluster is 9 of 10 blocks"]}
    with zipfile.ZipFile(drawn) as z:
        assert z.read("license.txt") == LICENCE
        assert z.getinfo("license.txt").compress_type == zipfile.ZIP_STORED
    assert "removed 8.81K gaussians" in room.with_name("room.bake.log").read_text(encoding="utf-8")


@pytest.mark.parametrize("given, actions", [
    (["--crop"], ["--filter-box", OCTREE_BOX]),
    (["--decimate", "1000"], ["--decimate", "1000"]),
], ids=["crop", "decimate"])
def test_a_filter_without_the_cluster_needs_no_seed(room, tmp_path, monkeypatch, given, actions):
    tool = use(filterer(sm.SPLAT_TRANSFORM_VERSION), tmp_path, monkeypatch)
    code, out = run_cli("bake", room, "--seed", "0,0,32", "--fill", "16", BOX, *given)
    record = bake_record(room)
    assert code == 1 and record["errors"] == NO_MESH, out
    draw = runs(tool)[0]
    assert draw[:3] == ["-w", "--no-tty", str(room)]
    assert draw[3:-1] == actions
    assert record["_pcq_filter"] == " ".join(actions)
    assert "cluster" not in record


def test_the_bake_refuses_a_cluster_whose_flood_stopped_at_the_seed(room, tmp_path, monkeypatch):
    tool = use(filterer(sm.SPLAT_TRANSFORM_VERSION, removed="1.28M"), tmp_path, monkeypatch)
    license_the_room(room, 2_550_850)
    code, out = run_cli("bake", room, "--seed", "0,0,32", "--fill", "16", "--cluster")
    assert code == 1
    assert "the cluster filter removed 1,280,000 of 2,550,850 splats" in out
    assert len(runs(tool)) == 1
    assert not room.with_name("room.drawn.sog").exists()


def test_the_bake_refuses_a_cluster_filter_it_cannot_read(room, tmp_path, monkeypatch):
    use(filterer(sm.SPLAT_TRANSFORM_VERSION, removed="8", group="Filter clusters"), tmp_path,
        monkeypatch)
    code, out = run_cli("bake", room, "--seed", "0,0,32", "--fill", "16", "--cluster")
    assert code == 1
    assert "splat-transform printed nothing of the cluster filter" in out
    assert not room.with_name("room.drawn.sog").exists()


def test_a_bake_without_filters_draws_the_polished_splat(room, tmp_path, monkeypatch):
    tool = use(filterer(sm.SPLAT_TRANSFORM_VERSION), tmp_path, monkeypatch)
    room.with_name("room.drawn.sog").write_bytes(room.read_bytes())
    code, out = run_cli("bake", room, "--seed", "0,0,32", "--fill", "16", BOX)
    record = bake_record(room)
    assert code == 1 and record["errors"] == NO_MESH, out
    [bake] = runs(tool)
    assert str(room) in bake
    assert not room.with_name("room.drawn.sog").exists()
    assert not {"_pcq_filter", "drawn"} & set(record)


@pytest.mark.parametrize("given, message", [
    (["--crop"], "--crop cuts the drawn splat to --box, and no --box is given"),
    (["--decimate", "0"], "--decimate '0' is neither"),
])
def test_a_filter_the_bake_cannot_run_is_refused(room, tmp_path, monkeypatch, given, message):
    tool = use(filterer(sm.SPLAT_TRANSFORM_VERSION), tmp_path, monkeypatch)
    code, out = run_cli("bake", room, "--seed", "0,0,32", *given)
    assert code == 1 and message in out
    assert not os.path.exists(tool.with_suffix(".log"))


@pytest.mark.parametrize("value", ["50%", "12.5%", "100%", "1000000"])
def test_decimate_takes_a_count_or_a_percentage(value):
    assert bake_map.decimate_value(value) == value


@pytest.mark.parametrize("value", ["0", "0%", "100.5%", "1.5", "-5", "half", "50 %"])
def test_decimate_refuses_anything_else(value):
    with pytest.raises(ValueError, match="is neither a whole number of splats"):
        bake_map.decimate_value(value)


#: splat-transform 3.1.6's output for the cluster filter on vegetables_mice, then the box.
CLUSTER_LOG = """\
splat-transform v3.1.6 (04b6d15)
▸ [2/2] Output out.sog
  ▸ Filter cluster
    · scene: 27.9m x 11.1m x 20.4m, grid: 116 x 48 x 88 voxels (490K) @ 25cm
    ▸ Voxelizing [####################] 0.584s
    ! seed (8.25, -2.41, 4.25) unoccupied; resolved to nearest at (7.38, -3.38, 3.38)
    · cluster is 1.7K of 2.01K blocks
    · removed 8.81K gaussians
  · 2.01M gaussians · 3 SH bands
  ▸ Writing
    ▸ k-means [####################] 8.788s
    · out.sog (23.5MB)
done in 20.729s  [peak cpu=2.99GB gpu=384.4MB]
"""


def test_the_cluster_report_reads_the_cluster_filter_s_own_group():
    assert bake_map.cluster_report(CLUSTER_LOG) == (8810, [
        "seed (8.25, -2.41, 4.25) unoccupied; resolved to nearest at (7.38, -3.38, 3.38)",
        "cluster is 1.7K of 2.01K blocks"])


def test_the_cluster_report_ends_with_the_cluster_filter_s_group():
    then = CLUSTER_LOG.replace("  · 2.01M gaussians", "  ▸ Filter floaters\n"
                               "    · removed 114K gaussians\n  · 1.9M gaussians")
    assert bake_map.cluster_report(then)[0] == 8810


def test_a_cluster_that_is_everything_removes_nothing():
    whole = CLUSTER_LOG.replace("    · removed 8.81K gaussians\n",
                                "    · all blocks in one cluster, no filtering needed\n")
    removed, said = bake_map.cluster_report(whole)
    assert removed == 0 and said[-1] == "all blocks in one cluster, no filtering needed"


def test_a_log_with_no_cluster_filter_reports_none():
    assert bake_map.cluster_report(CLUSTER_LOG.replace("Filter cluster", "Filter box")) is None
