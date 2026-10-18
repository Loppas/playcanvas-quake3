"""`write_ent.py`: viewpos readings to entity text, by `map-format.md` §3.4's rules."""

import argparse
import json

import pytest

from splat_maps import write_ent
from room import encode_octree, room_grid, run_cli

#: garage_cats' entities, as write_ent wrote them from its readings.
GARAGE_CATS_ENT = """\
// entity 0
{
"classname" "worldspawn"
"message" "The Garage (Cat Size)"
}
// entity 1: spawn from viewpos (-1 -1 58) : 0, z less 26
{
"classname" "info_player_deathmatch"
"origin" "-1 -1 32"
"angle" "0"
"spawnflags" "1"
}
// entity 2: spawn from viewpos (-16 -343 162) : 87, z less 26
{
"classname" "info_player_deathmatch"
"origin" "-16 -343 136"
"angle" "87"
}
// entity 3: spawn from viewpos (-5 -121 58) : 88, z less 26
{
"classname" "info_player_deathmatch"
"origin" "-5 -121 32"
"angle" "88"
}
// entity 4: spawn from viewpos (-17 420 58) : 272, z less 26
{
"classname" "info_player_deathmatch"
"origin" "-17 420 32"
"angle" "272"
}
// entity 5: intermission camera from viewpos (211 403 174) : 242
{
"classname" "info_player_intermission"
"origin" "211 403 174"
"target" "intermission_view"
}
// entity 6: what the intermission camera faces, from viewpos (0 0 20)
{
"classname" "target_position"
"targetname" "intermission_view"
"origin" "0 0 20"
}
"""


@pytest.mark.parametrize("text, value", [
    ("(1 2 3) : 4", (1.0, 2.0, 3.0, 4.0)),
    ("  ( -1.5  2 3 ):-90 ", (-1.5, 2.0, 3.0, -90.0)),
])
def test_reading_takes_viewpos_as_it_prints(text, value):
    assert write_ent.reading(text) == value


@pytest.mark.parametrize("text", ["1 2 3 : 4", "(1 2) : 4", "(1 2 3)", "(1 2 3) : north",
                                  "(1 2 3) : 4 5"])
def test_reading_refuses_anything_else(text):
    with pytest.raises(argparse.ArgumentTypeError):
        write_ent.reading(text)


def test_write_ent_places_garage_cats_from_its_readings(tmp_path):
    out = tmp_path / "garage_cats.ent"
    code, log = run_cli(
        "entities", "readings", out, "--message", "The Garage (Cat Size)",
        "--spawn", "(-1 -1 58) : 0", "--spawn", "(-16 -343 162) : 87",
        "--spawn", "(-5 -121 58) : 88", "--spawn", "(-17 420 58) : 272",
        "--intermission", "(211 403 174) : 242", "--look-at", "(0 0 20) : 0")
    assert code == 0, log
    assert out.read_bytes() == GARAGE_CATS_ENT.encode("ascii")


def test_write_ent_needs_a_spawn(tmp_path):
    code, log = run_cli("entities", "readings", tmp_path / "room.ent", "--message", "Test Room",
                        "--intermission", "(0 -32 100) : 0", "--look-at", "(0 0 24) : 0")
    assert code != 0
    assert "at least one --spawn" in log
    assert not (tmp_path / "room.ent").exists()


@pytest.fixture
def octree(tmp_path):
    def write(hole=False):
        header, raw = encode_octree(room_grid(hole))
        (tmp_path / "room.voxel.json").write_text(json.dumps(header), encoding="utf-8")
        (tmp_path / "room.voxel.bin").write_bytes(raw)
        return tmp_path / "room.voxel.json"
    return write


def place(tmp_path, octree, spawn, intermission="(0 -32 100) : 0"):
    return run_cli("entities", "readings", tmp_path / "room.ent", "--message", "Test Room",
                   "--spawn", spawn, "--intermission", intermission,
                   "--look-at", "(8 -16 24) : 0", "--octree", octree)


def test_write_ent_checks_a_free_spawn_and_an_open_intermission(tmp_path, octree):
    code, log = place(tmp_path, octree(), "(0 0 50) : 90")
    assert code == 0, log
    assert "spawn (0 0 24): free, drops 9.0 units, lands silent" in log
    assert "the intermission point is open" in log
    assert (tmp_path / "room.ent").read_text(encoding="ascii").endswith(
        '"classname" "target_position"\n"targetname" "intermission_view"\n'
        '"origin" "8 -16 24"\n}\n')


@pytest.mark.parametrize("hole, spawn, intermission, code, line", [
    (False, "(48 48 50) : 0", "(0 -32 100) : 0", 1, "ERROR: spawn (48 48 24) is in solid (L20)"),
    (False, "(-48 0 86) : 0", "(0 -32 100) : 0", 0,
     "WARNING: spawn (-48 0 60) drops 45.0 units and thuds (L21)"),
    (True, "(-48 -48 106) : 0", "(0 -32 100) : 0", 1,
     "ERROR: spawn (-48 -48 80) drops 257.0 units and lands hurt (L21)"),
    (False, "(0 0 50) : 0", "(48 48 80) : 0", 1,
     "ERROR: the intermission point is in a solid voxel (L22)"),
])
def test_write_ent_judges_the_spots_in_the_octree(tmp_path, octree, hole, spawn, intermission,
                                                  code, line):
    got, log = place(tmp_path, octree(hole), spawn, intermission)
    assert got == code, log
    assert line in log.splitlines()
