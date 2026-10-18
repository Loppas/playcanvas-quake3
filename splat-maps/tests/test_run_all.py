"""`all`: where it seeds the bake and places the starter entities, and every stage run in turn,
each a stand-in that records what it was given."""

import json

import numpy as np
import pytest

from capture import write_capture
from room import encode_octree, room_grid
from splat_maps import (bake_map, deliver_map, export, frames, levelshot, package_map, polish,
                        run_all, sfm, train, write_arena, write_ent)
from splat_maps import splat_map as sm

FIELDS = ("Title: The Yard; Author: A Capturer; Source: https://example.com/yard; "
          "License URL: https://creativecommons.org/licenses/by/4.0/")
BOX = "--box=-640,-640,-32,640,640,256"


def test_the_seed_goes_over_the_most_densely_captured_floor():
    rng = np.random.default_rng(0)
    # A floor 8 m square, a patch of it 2 m across and twice as dense, and walls, which are not
    # floor. The patch fills the 80-unit window only within 8 units of its middle.
    floor = rng.uniform((-4, -0.05, -4), (4, 0.05, 4), (40_000, 3))
    patch = rng.uniform((1.0, -0.05, -3.0), (3.0, 0.05, -1.0), (2_500, 3))
    walls = rng.uniform((-4, 0.2, -4), (-3, 2.5, 4), (40_000, 3))
    x, y = run_all.floor_patch(np.concatenate([floor, patch, walls]))
    # The patch's middle is (2, -2) m, so (64, 64) units in Q3's axes, y being -z.
    assert abs(x - 64) <= 16 and abs(y - 64) <= 16


def test_a_capture_with_no_floor_cannot_be_seeded():
    with pytest.raises(SystemExit, match="no splats lie on the polished floor"):
        run_all.floor_patch(np.array([[0.0, 1.0, 0.0]]))


@pytest.fixture(scope="module")
def octree():
    """The test room's octree: its floor's top at z 0, its grid's top at z 128."""
    header, raw = encode_octree(room_grid())
    return sm.Octree.from_bytes(header, raw)


@pytest.mark.parametrize("at, readings", [
    # Over the floor: the spawn's eye 50 above it, the camera half the 72 units up to the top.
    ((0, 0), ("(0 0 50) : 0", "(0 0 86) : 0", "(128 0 50) : 0")),
    # Over the step, one voxel high: everything 8 higher, and the camera half of 64.
    ((-20, 48), ("(-20 48 58) : 0", "(-20 48 90) : 0", "(108 48 58) : 0")),
    # Under the cube, 64 up: the camera half of the 8 units between the eye and the cube.
    ((48, 48), ("(48 48 50) : 0", "(48 48 54) : 0", "(176 48 50) : 0")),
], ids=["floor", "step", "cube"])
def test_the_starter_entities_stand_on_what_is_under_the_seed(octree, at, readings):
    assert run_all.starter_readings(octree, *at) == readings


def test_a_camera_rises_no_more_than_its_most(octree, monkeypatch):
    monkeypatch.setattr(run_all, "INTERMISSION_RISE", 16)
    assert run_all.starter_readings(octree, 0, 0)[1] == "(0 0 66) : 0"


@pytest.fixture
def stages(tmp_path, monkeypatch):
    """Every stage `all` runs, as a stand-in recording (stage, argv). The polish writes the
    capture as polished, and the first bake the test room's octree."""
    calls = []

    def stand_in(name, then=None):
        def main(argv, prog):
            calls.append((name, list(argv)))
            if then:
                then(argv)
        return main

    def polished(argv):
        write_capture(argv[1])

    def baked(argv):
        stem = argv[0][:-len(".sog")]
        header, raw = encode_octree(room_grid())
        with open(f"{stem}.voxel.json", "w", encoding="utf-8") as fh:
            json.dump(header, fh)
        with open(f"{stem}.voxel.bin", "wb") as fh:
            fh.write(raw)

    for module, name, then in [(frames, "frames", None), (sfm, "sfm", None),
                               (train, "train", None), (export, "export", None),
                               (polish, "polish", polished), (bake_map, "bake", baked),
                               (write_ent, "entities", None), (levelshot, "levelshot", None),
                               (write_arena, "arena", None), (package_map, "package", None),
                               (deliver_map, "deliver", None)]:
        monkeypatch.setattr(module, "main", stand_in(name, then))
    monkeypatch.setattr(frames, "find_ffmpeg", lambda: "ffmpeg")
    monkeypatch.setattr(sfm, "find_colmap", lambda: "colmap")
    monkeypatch.setattr(train, "find_trainer", lambda: "examples")
    monkeypatch.setattr(sm, "require_splat_transform", lambda: "splat-transform")
    monkeypatch.setattr(run_all, "floor_patch", lambda points: (0, 0))
    port = tmp_path / "port"
    (port / "public" / "maps").mkdir(parents=True)
    (port / "package.json").write_text("{}")
    return calls


def run(tmp_path, *args):
    """`all` on a yard, in `tmp_path`; returns the argv it was given before `args`."""
    data = tmp_path / "data"
    given = [str(tmp_path / "yard.mov"), "yard", "7.3", "--license", FIELDS, "--author",
             "A Mapper", BOX, "--data", str(data), "--port", str(tmp_path / "port")]
    run_all.main([*given, *args], prog="splat-maps all")
    return data / "yard"


def test_all_runs_every_stage_in_order(tmp_path, stages):
    dataset = run(tmp_path, "--outdoor", "--max-steps", "10000", "--player-height", "0.5")
    folder = dataset / "map"
    sog, ent, octree = (str(folder / f"yard{ext}") for ext in (".sog", ".ent", ".voxel.json"))
    assert stages == [
        ("frames", [str(tmp_path / "yard.mov"), str(dataset), "--fps", "1.5", "--width", "1920"]),
        ("sfm", [str(dataset)]),
        ("train", [str(dataset), "--cap-max", "1000000", "--max-steps", "10000"]),
        ("export", [str(dataset), "--name", "yard"]),
        ("polish", [str(dataset / "results" / "mcmc" / "yard.sog"), sog, "7.3", "--license",
                    FIELDS, "--up-hint", "0,0,1", "--outdoor", "--player-height", "0.5"]),
        ("bake", [sog, "--seed", "0,0,32", BOX, "--outdoor"]),
        ("entities", [ent, "--message", "The Yard", "--spawn", "(0 0 50) : 0",
                      "--intermission", "(0 0 86) : 0", "--look-at", "(128 0 50) : 0",
                      "--octree", octree]),
        ("bake", [sog, BOX, "--outdoor"]),
        ("levelshot", [sog]),
        ("arena", [str(folder / "yard.arena"), "--ent", ent]),
        ("package", [sog, "--author", "A Mapper"]),
        ("deliver", [str(folder / "map-yard.pk3"), "--port", str(tmp_path / "port")]),
    ]


def test_all_names_the_map_and_replaces_a_delivered_one_when_told(tmp_path, stages):
    run(tmp_path, "--message", "Out the Back", "--replace")
    entities = dict(stages)["entities"]
    assert entities[entities.index("--message") + 1] == "Out the Back"
    assert stages[-1][1][-1] == "--replace"


def test_a_room_keeps_its_ceiling_and_its_bakes_their_fill(tmp_path, stages):
    run(tmp_path)
    called = [argv for name, argv in stages if name in ("polish", "bake")]
    assert all("--outdoor" not in argv for argv in called)
    assert [argv[-1] for argv in called[1:]] == [BOX, BOX]


def test_all_needs_a_box(tmp_path, stages, capsys):
    with pytest.raises(SystemExit) as ended:
        run_all.main([str(tmp_path / "yard.mov"), "yard", "7.3", "--license", FIELDS,
                      "--author", "A Mapper", "--port", str(tmp_path / "port")])
    assert ended.value.code == 2
    assert "--box" in capsys.readouterr().err
    assert stages == []


@pytest.mark.parametrize("change, error", [
    (lambda argv, tmp: argv.__setitem__(1, "Yard"), "'Yard' is not a map name"),
    (lambda argv, tmp: (tmp / "data" / "yard").mkdir(parents=True)
     or (tmp / "data" / "yard" / "images").mkdir(), "is not empty"),
    (lambda argv, tmp: argv.__setitem__(4, "Title: The Yard; Author: A Capturer"),
     "--license gives no source, license url"),
    (lambda argv, tmp: (tmp / "port" / "package.json").unlink(), "does not look like the port"),
    (lambda argv, tmp: argv.__setitem__(7, "--box=0,0,0,640,640"), "is not x0,y0,z0,x1,y1,z1"),
], ids=["stem", "dataset", "licence", "port", "box"])
def test_all_refuses_before_the_first_stage(tmp_path, stages, change, error):
    argv = [str(tmp_path / "yard.mov"), "yard", "7.3", "--license", FIELDS, "--author",
            "A Mapper", BOX, "--data", str(tmp_path / "data"), "--port", str(tmp_path / "port")]
    change(argv, tmp_path)
    with pytest.raises(SystemExit, match=error):
        run_all.main(argv, prog="splat-maps all")
    assert stages == []
