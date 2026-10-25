"""Every patch a player can stand on, however high, and nothing they can't."""

import json
import sys

import numpy as np
import pytest

import reach
from room import VOXEL_M, encode_octree  # splat-maps' own test room

S = 8  # units a voxel
SPAWN = [[5, 5, 0]]


def grid(nx=48, ny=48, nz=48):
    """Open space, in sim axes [x, y, z]; the grid's outside, its floor too, is solid."""
    return np.ones((nx, ny, nz), bool)


def rests_at(open_, z):
    rest, _, _ = reach.standable(open_, SPAWN, S)
    return rest[rest[:, 2] == z]


def test_a_floor_is_a_patch_wherever_the_box_fits():
    rest, foot, count = reach.standable(grid(), SPAWN, S)
    assert foot == 4
    assert len(rest) == (48 - foot + 1) ** 2 and (rest[:, 2] == 0).all()
    assert count["kept"] == count["patches"] == 1


def test_a_platform_past_a_jump_counts():
    g = grid()
    g[24:36, 24:36, :15] = False  # 120 units up, where only the grapple goes
    assert len(rests_at(g, 15))


@pytest.mark.parametrize("across, kept", [(7, False), (8, True)])
def test_a_patch_needs_ground_two_player_widths_across(across, kept):
    g = grid()
    g[24:24 + across, 24:24 + across, :15] = False  # 56 or 64 units: two widths are 60
    assert bool(len(rests_at(g, 15))) == kept


def test_a_speck_is_left_out_though_the_box_can_overhang_it():
    g = grid()
    g[24:26, 24:26, :15] = False  # two voxels across, where 25 boxes rest
    assert not len(rests_at(g, 15))


@pytest.mark.parametrize("clear, kept", [(7, False), (8, True)])
def test_a_patch_needs_standing_room_and_a_voxel_above_it(clear, kept):
    g = grid()
    # The standing box is 56 tall: 56 units clear holds it, but not a voxel more.
    g[:20, :, clear:clear + 2] = False
    under = rests_at(g, 0)
    assert under[:, 0].min() == (0 if kept else 20)
    assert len(rests_at(g, clear + 2))  # on top of it, either way


def test_a_sealed_pocket_is_not_inside():
    g = grid()
    g[30:46, 30:46, :30] = False
    g[32:44, 32:44, 2:28] = True  # a room the box can't get into
    assert not len(rests_at(g, 2))


@pytest.mark.parametrize("height, kept", [(2, True), (3, False)])
def test_a_ledge_too_narrow_alone_counts_a_step_from_the_floor(height, kept):
    g = grid()
    g[20:23, :, :height] = False  # three voxels wide: 16 units up is a step, 24 is not
    assert bool(len(rests_at(g, height))) == kept


def test_a_spawn_with_no_room_stops_the_run():
    g = grid()
    g[:12, :12, :12] = False
    with pytest.raises(SystemExit, match="no room"):
        reach.standable(g, SPAWN, S)


def test_a_pose_stands_over_a_rest_in_each_cube(tmp_path, monkeypatch):
    # A floor 160 units across, its top at 8: rests' boxes centred from 16 to 144, two 96-unit
    # cubes each way, and the second cube's centre the last box's.
    open_ = grid(20, 20, 16)
    open_[:, :, 0] = False
    nx, ny, nz = open_.shape
    cells = np.transpose(~open_[::-1, ::-1, ::-1], (0, 2, 1))  # sim_open's own map, undone
    header, raw = encode_octree(cells, grid_min=(-nx * VOXEL_M, -nz * VOXEL_M, -ny * VOXEL_M))
    (tmp_path / "flat.voxel.json").write_text(json.dumps(header), encoding="utf-8")
    (tmp_path / "flat.voxel.bin").write_bytes(raw)
    (tmp_path / "flat.ent").write_text('{\n"classname" "worldspawn"\n}\n{\n"classname" '
                                       '"info_player_deathmatch"\n"origin" "40 40 24"\n}\n')
    work = tmp_path / "work"
    monkeypatch.setattr(sys, "argv", ["reach.py", str(tmp_path / "flat.sog"), str(work)])
    reach.main()

    poses = json.loads((work / "poses.json").read_text(encoding="utf-8"))
    assert [p["name"] for p in poses] == ["p000", "p001", "p002", "p003"]
    assert {tuple(p["eye"]) for p in poses} == {(x, y, 8 + 24 + 26.0) for x in (48.0, 144.0) for y in (48.0, 144.0)}
    assert (work / "reach.png").stat().st_size
