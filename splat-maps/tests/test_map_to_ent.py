"""`map_to_ent.py`: an editor's `.map` to a splat map's `.ent`, its point entities kept."""

import pytest

from splat_maps import map_to_ent
from splat_maps import splat_map as sm
from room import run_cli

#: A `.map` as NetRadiant saves one: worldspawn's brushes in all three syntaxes and a patch, a
#: func_group, the collision mesh as a reference misc_model, and the point entities.
MAP = """\
// entity 0
{
"classname" "worldspawn"
"message" "Test Room"
// brush 0
{
( -64 -64 -8 ) ( -64 63 -8 ) ( 63 -64 -8 ) common/caulk 0 0 0 0.5 0.5 0 0 0
}
// brush 1
{
( -64 -64 -8 ) ( -64 63 -8 ) ( 63 -64 -8 ) common/caulk [ 1 0 0 0 ] [ 0 -1 0 0 ] 0 0.5 0.5
}
// brush 2
{
brushDef
{
( 0 0 1 0 ) ( ( 0.03125 0 0 ) ( 0 0.03125 0 ) ) common/caulk 0 0 0
}
}
// brush 3
{
patchDef2
{
common/caulk
( 3 3 0 0 0 )
(
( ( 0 0 0 0 0 ) ( 0 8 0 0 1 ) ( 0 16 0 0 2 ) )
)
}
}
}
// entity 1
{
"classname" "info_player_deathmatch"
"origin" "0 0 24"
"angle" "90"
}
// entity 2
{
"classname" "func_group"
{
( -64 -64 -8 ) ( -64 63 -8 ) ( 63 -64 -8 ) common/caulk 0 0 0 0.5 0.5 0 0 0
}
}
// entity 3
{
"classname" "misc_model"
"model" "models/room_collision.obj"
"origin" "0 0 0"
}
// entity 4
{
"classname" "info_player_intermission"
"origin" "0 -32 100"
}
"""

ENT = """\
// entity 0: worldspawn, less its 4 brushes
{
"classname" "worldspawn"
"message" "Test Room"
}
// entity 1: from room.map line 33
{
"classname" "info_player_deathmatch"
"origin" "0 0 24"
"angle" "90"
}
// entity 2: from room.map line 52
{
"classname" "info_player_intermission"
"origin" "0 -32 100"
}
"""


def write_map(tmp_path, text=MAP):
    path = tmp_path / "room.map"
    path.write_text(text, encoding="ascii")
    return path


def test_read_map_counts_each_brush_and_patch_and_skips_comments():
    ents = map_to_ent.read_map(MAP.encode("ascii"))
    assert [(pairs[0][1], prims, line) for pairs, prims, line in ents] == [
        ("worldspawn", 4, 2), ("info_player_deathmatch", 0, 33), ("func_group", 1, 39),
        ("misc_model", 0, 46), ("info_player_intermission", 0, 52)]


@pytest.mark.parametrize("text, message", [
    ('"classname" "worldspawn"', "expected {"),
    ('{\n"classname" "worldspawn"\n', "does not close"),
    ('{\n"classname" "worldspawn"\n{\n( 0 0 0 )\n', "brush or patch"),
    ('{\n"classname"', "ends inside a key"),
])
def test_read_map_refuses_an_unfinished_map(text, message):
    with pytest.raises(sm.FormatError, match=message):
        map_to_ent.read_map(text.encode("ascii"))


def test_map_to_ent_keeps_the_point_entities(tmp_path):
    out = tmp_path / "room.ent"
    code, log = run_cli("entities", "from-map", write_map(tmp_path), out)
    assert code == 0, log
    assert out.read_bytes() == ENT.encode("ascii")
    assert "wrote" in log and "3 entities, 1 spawn spot(s)" in log
    assert "dropped func_group at line 39" in log
    assert "dropped the reference misc_model at line 46" in log


def test_map_to_ent_drops_only_the_named_reference(tmp_path):
    out = tmp_path / "room.ent"
    code, log = run_cli("entities", "from-map", write_map(tmp_path), out,
                        "--reference", "other_collision.obj")
    assert code == 0, log
    assert '"model" "models/room_collision.obj"' in out.read_text(encoding="ascii")


def test_map_to_ent_refuses_an_entity_with_brushes(tmp_path):
    text = MAP.replace('"classname" "func_group"', '"classname" "func_door"')
    code, log = run_cli("entities", "from-map", write_map(tmp_path, text), tmp_path / "room.ent")
    assert code != 0
    assert "func_door at line 39, with 1 brush(es) or patch(es)" in log
    assert not (tmp_path / "room.ent").exists()


def test_map_to_ent_needs_worldspawn_first(tmp_path):
    text = ('{\n"classname" "info_player_deathmatch"\n"origin" "0 0 24"\n}\n'
            '{\n"classname" "worldspawn"\n}\n')
    code, log = run_cli("entities", "from-map", write_map(tmp_path, text), tmp_path / "room.ent")
    assert code != 0
    assert "first kept entity is not worldspawn" in log
    assert not (tmp_path / "room.ent").exists()


def test_map_to_ent_refuses_a_value_entity_text_cannot_hold(tmp_path):
    path = tmp_path / "room.map"
    path.write_bytes(MAP.replace('"Test Room"', '"Caf\xe9 Room"').encode("latin-1"))
    code, log = run_cli("entities", "from-map", path, tmp_path / "room.ent")
    assert code != 0 and "Traceback" not in log
    assert "'message' holds U+00E9 LATIN SMALL LETTER E WITH ACUTE, which entity text" in log
    assert not (tmp_path / "room.ent").exists()


def test_map_to_ent_warns_of_a_map_with_no_spawn(tmp_path):
    text = MAP.replace('"info_player_deathmatch"', '"info_null"')
    code, log = run_cli("entities", "from-map", write_map(tmp_path, text), tmp_path / "room.ent")
    assert code == 0, log
    assert "WARNING: no spawn spot" in log
