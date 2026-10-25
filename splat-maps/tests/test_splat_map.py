"""`splat_map.py`, the format's shared pieces, each held to the rule it follows."""

import json
import zipfile

import numpy as np
import pytest

from splat_maps import splat_map as sm
from room import encode_octree, room_grid


def tokens(data, **kwargs):
    tok = sm.Tokenizer(data)
    out = []
    while (t := tok.next(**kwargs)) is not None:
        out.append(t)
    return out, tok


def room_octree(hole=False):
    return sm.Octree.from_bytes(*encode_octree(room_grid(hole)))


def spawn_box(origin):
    """A spawn spot's box as the game places it: raised 9, the player's mins and maxs."""
    x, y, z = origin
    z += sm.SPAWN_RAISE
    return (x - 15, y - 15, z - 24), (x + 15, y + 15, z + 32)


# ------------------------------------------------------------------------------ tokenizer


def test_tokenizer_skips_comments_and_reads_quotes_across_lines():
    out, tok = tokens(b'a // gone\n/* gone\ntoo */ "b c\nd" e')
    assert out == ["a", "b c\nd", "e"]
    assert tok.line == 4


def test_tokenizer_treats_high_bytes_as_whitespace_and_not_del():
    assert tokens(b"a\x80b\xffc")[0] == ["a", "b", "c"]
    assert tokens(b"a\x7fb")[0] == ["a\x7fb"]


def test_tokenizer_stops_at_a_nul():
    assert tokens(b"a\x00b")[0] == ["a"]


def test_tokenizer_cuts_a_long_token_and_records_it():
    out, tok = tokens(b"x" * 1030)
    assert out == ["x" * 1023]
    assert tok.truncated == [(1, 1030)]


def test_tokenizer_reports_a_line_break_when_not_allowed():
    assert tokens(b"a\nb", allow_line_breaks=False)[0] == ["a", "", "b"]


# ------------------------------------------------------------------------------ entities


def test_entities_round_trip_through_the_editor_layout():
    ents = [[("classname", "worldspawn"), ("message", "Hi")],
            [("classname", "info_player_deathmatch"), ("origin", "1 2 3")]]
    text = sm.format_entities(ents, ["", "a note"])
    assert text == ('// entity 0\n{\n"classname" "worldspawn"\n"message" "Hi"\n}\n'
                    '// entity 1: a note\n{\n"classname" "info_player_deathmatch"\n'
                    '"origin" "1 2 3"\n}\n')
    back, _ = sm.parse_entities(text.encode("ascii"))
    assert [e.pairs for e in back] == ents
    assert [e.line for e in back] == [2, 7]


def test_entities_refuse_a_quote_inside_a_token():
    with pytest.raises(sm.FormatError):
        sm.format_entities([[("message", 'a "b"')]])


@pytest.mark.parametrize("key, value, held", [
    ("message", "Zo\xeb", "U+00EB LATIN SMALL LETTER E WITH DIAERESIS"),
    ("message", "a\x7fb", "U+007F <control>"),
    ("m\xe9ssage", "Zoe", "U+00E9 LATIN SMALL LETTER E WITH ACUTE"),
])
def test_entities_refuse_what_is_not_printable_ascii(key, value, held):
    with pytest.raises(sm.FormatError) as raised:
        sm.format_entities([[("classname", "worldspawn"), (key, value)]])
    assert f"{key!a} holds {held}, which entity text cannot hold" in str(raised.value)


def test_entities_hold_printable_ascii_tabs_and_line_breaks():
    assert sm.unprintable(" ~\t\n\r") == []
    assert sm.unprintable("Zo\xeb \x7f \xeb") == ["\x7f", "\xeb"]
    # Named in ASCII, as an error goes to a console that may not show the characters.
    assert sm.named(["\x7f", "\xeb"]) == ("U+007F <control>, "
                                          "U+00EB LATIN SMALL LETTER E WITH DIAERESIS")


@pytest.mark.parametrize("text, folded", [
    ("J\xf6rg Example", "Joerg Example"),
    ("Jo\u0308rg Example", "Joerg Example"),
    ("\xc4rger, \xd6l, \xdcber, Stra\xdfe", "Aerger, Oel, Ueber, Strasse"),
    ("Zo\xeb, Caf\xe9, Fran\xe7ois, \xc5ngstr\xf6m", "Zoe, Cafe, Francois, Angstroem"),
    ("\xc6sir, \xf8, \u0153uvre, \u0142\xf3d\u017a, \u0111, \xf0, \xfe",
     "Aesir, oe, oeuvre, lodz, d, d, th"),
    ("St. Mary\u2019s \u2013 \u201cEast\u201d\u2026", "St. Mary's - 'East'..."),
    ("Garage - High Detail Test", "Garage - High Detail Test"),
])
def test_the_fold_spells_a_letter_out_or_drops_its_accent(text, folded):
    assert sm.to_ascii(text) == folded


def test_the_fold_leaves_a_script_it_cannot_spell_for_its_caller_to_refuse():
    assert sm.unprintable(sm.to_ascii("\u041f\u0451\u0442\u0440")) == ["\u041f", "\u0435",
                                                                       "\u0440", "\u0442"]


@pytest.mark.parametrize("data, message", [
    (b'"classname" "worldspawn"', "found classname when expecting {"),
    (b'{ "classname" "worldspawn"', "EOF without closing brace"),
    (b'{ "classname"', "EOF without closing brace"),
    (b'{ "classname" }', "closing brace without data"),
    (b"// nothing\n", "no entities"),
])
def test_entities_raise_q3s_errors(data, message):
    with pytest.raises(sm.FormatError, match=message):
        sm.parse_entities(data)


def block(pairs):
    return ("{\n" + "".join(f'"{k}" "{v}"\n' for k, v in pairs) + "}\n").encode("ascii")


def test_entities_hold_64_pairs_and_no_more():
    pairs = [(f"k{i}", "v") for i in range(64)]
    sm.parse_entities(block(pairs))
    with pytest.raises(sm.FormatError, match="MAX_SPAWN_VARS"):
        sm.parse_entities(block(pairs + [("k64", "v")]))


def test_entities_hold_4096_characters_and_no_more():
    # Each pair counts its key and value with a NUL apiece: four of 1022, then one of 3 + n.
    pairs = [(f"k{i}", "x" * 1018) for i in range(4)]
    sm.parse_entities(block(pairs + [("k", "x" * 5)]))
    with pytest.raises(sm.FormatError, match="MAX_SPAWN_VARS_CHARS"):
        sm.parse_entities(block(pairs + [("k", "x" * 6)]))


def test_entity_get_ignores_case_and_takes_the_first():
    e = sm.Entity([("ClassName", "a"), ("classname", "b")], 1)
    assert e.get("CLASSNAME") == "a"
    assert e.classname == "a"
    assert e.get("origin", "none") == "none"


def test_entity_vector_reads_as_g_spawnvector():
    e = sm.Entity([("origin", "1x 2"), ("angles", "1 2 3 4")], 1)
    assert e.vector("origin") == (1.0, 2.0, 0.0)
    assert e.vector("angles") == (1.0, 2.0, 3.0)
    assert e.vector("absent", (5.0, 6.0, 7.0)) == (5.0, 6.0, 7.0)


@pytest.mark.parametrize("pairs, yaw", [
    ([("angles", "10 20 30")], 20.0),
    ([("angles", "10 20 30"), ("angle", "45")], 45.0),
    ([("angle", "abc")], 0.0),
    ([], 0.0),
])
def test_entity_yaw_lets_angle_overwrite_angles(pairs, yaw):
    assert sm.Entity(pairs, 1).yaw() == yaw


@pytest.mark.parametrize("text, value", [
    ("12abc", 12.0), ("abc", 0.0), (".5", 0.5), ("-3.25e1x", -32.5), ("  7", 7.0), ("1e", 1.0),
    ("+2", 2.0),
])
def test_atof_reads_as_c(text, value):
    assert sm._atof(text) == value


@pytest.mark.parametrize("text, value", [("12.9", 12), ("-3x", -3), ("", 0), (None, 0), ("x1", 0)])
def test_atoi_reads_as_c(text, value):
    assert sm._atoi(text) == value


def test_spawn_spots_are_both_classnames_in_file_order():
    ents = [sm.Entity([("classname", c)], i) for i, c in enumerate(
        ["worldspawn", "info_player_start", "info_player_intermission", "info_player_deathmatch"])]
    assert [e.line for e in sm.spawn_spots(ents)] == [1, 3]


@pytest.mark.parametrize("pairs, gametype, kept", [
    ([("notsingle", "1")], 2, False), ([("notsingle", "1")], 0, True),
    ([("notsingle", "0")], 2, True),
    ([("notteam", "1")], 3, False), ([("notteam", "1")], 4, False), ([("notteam", "1")], 0, True),
    ([("notfree", "1")], 0, False), ([("notfree", "1")], 1, False), ([("notfree", "1")], 3, True),
    ([("notq3a", "1")], 0, False), ([("notta", "1")], 0, True),
    ([("gametype", "ffa tournament")], 0, True), ([("gametype", "ffa tournament")], 1, True),
    ([("gametype", "ctf")], 0, False), ([("gametype", "team")], 8, True),
    ([("gametype", "ffa")], 8, False),
])
def test_survives_as_g_spawngentityfromspawnvars(pairs, gametype, kept):
    assert sm.survives(sm.Entity(pairs, 1), gametype) is kept


def spawn(origin):
    return sm.Entity([("classname", "info_player_deathmatch"),
                      ("origin", " ".join(str(c) for c in origin))], 1)


def world(gravity=None):
    pairs = [("classname", "worldspawn")] + ([("gravity", gravity)] if gravity else [])
    return sm.Entity(pairs, 1)


def test_judge_spawns_measures_each_spot_in_the_octree():
    spots = [spawn((0, 0, 24)), spawn((-16, 48, 24)), spawn((48, 48, 24)), spawn((-48, 0, 60))]
    judged = sm.judge_spawns(room_octree(), [world()] + spots)
    assert [(j["solid_voxels"], j["drop"], j["landing"]) for j in judged] == [
        (0, 9, "silent"), (0, 1, "silent"), (16, None, "n/a"), (0, 45, "thuds")]
    assert judged[0]["origin"] == [0.0, 0.0, 24.0]


@pytest.mark.parametrize("gravity, landing", [
    ("3888", "silent"), ("3889", "thuds"), ("22222", "thuds"), ("22223", "hurts"),
])
def test_judge_spawns_grades_the_landing_at_the_maps_gravity(gravity, landing):
    # A 9-unit drop: over 7 thuds above a gravity of 3888.9, and over 40 hurts above 22222.2.
    judged = sm.judge_spawns(room_octree(), [world(gravity), spawn((0, 0, 24))])
    assert judged[0]["landing"] == landing


def test_judge_spawns_follows_a_drop_through_a_hole():
    judged = sm.judge_spawns(room_octree(hole=True), [world(), spawn((-48, -48, 80))])
    assert (judged[0]["drop"], judged[0]["landing"]) == (257, "hurts")


# ------------------------------------------------------------------------------ arena block


def test_arena_reads_as_g_parseinfos():
    data = b'{\nmap "room"\nlongname "Test Room"\ntype "ffa team"\n}\n{\nmap "b"\n}\n'
    assert sm.parse_arena(data) == [
        [("map", "room"), ("longname", "Test Room"), ("type", "ffa team")], [("map", "b")]]


def test_arena_value_missing_from_its_line_is_null():
    assert sm.parse_arena(b'{\nmap\n"room"\n}\n') == [[("map", "<NULL>"), ("room", "<NULL>")]]


@pytest.mark.parametrize("data, message", [
    (b'map "room"', "Missing {"),
    (b'{ map "room"', "Unexpected end"),
    (b'{ map "a;b" }', "Can't use keys or values"),
    (b'{ map "a\\b" }', "Can't use keys or values"),
])
def test_arena_raises_q3s_errors(data, message):
    with pytest.raises(sm.FormatError, match=message):
        sm.parse_arena(data)


def test_arena_info_string_holds_1023_bytes():
    sm.parse_arena(b'{ k "' + b"x" * 1020 + b'" }')
    with pytest.raises(sm.FormatError, match="Info string length exceeded"):
        sm.parse_arena(b'{ k "' + b"x" * 1021 + b'" }')


def test_format_arena_writes_retails_layout():
    assert sm.format_arena([("map", "room"), ("longname", "Test Room")]) == \
        '{\nmap "room"\nlongname "Test Room"\n}\n'


@pytest.mark.parametrize("pair", [("map", 'a"b'), ("map", "a;b"), ("map", "a\\b"), ("long name", "a")])
def test_format_arena_refuses_what_q3_cannot_read(pair):
    with pytest.raises(sm.FormatError):
        sm.format_arena([pair])


# ------------------------------------------------------------------------------ frames


def test_frames_convert_as_the_ports_coords():
    assert sm.sim_to_world((32, 64, 96)) == (1, 3, -2)
    assert sm.world_to_sim((1, 3, -2)) == (32, 64, 96)
    assert sm.sim_to_octree((32, 64, 96)) == (-1, -3, -2)
    assert sm.octree_to_sim((-1, -3, -2)) == (32, 64, 96)


@pytest.mark.parametrize("value, text", [
    (1.5, "1.5"), (2.0, "2"), (-0.0, "0"), (1e-11, "0"), (-1e-11, "0"), (0.1, "0.1"),
    (-26.0, "-26"), (1234567.125, "1234567.125"),
])
def test_fmt_num_writes_no_exponent_and_no_trailing_zeros(value, text):
    assert sm.fmt_num(value) == text


# ------------------------------------------------------------------------------ bake sizes


def test_bake_sizes_for_an_8_unit_voxel_are_garage_cats_flags():
    sizes = sm.bake_sizes(8, 8)
    assert (sizes["voxel_m"], sizes["carve_h_m"], sizes["carve_r_m"], sizes["fill_m"]) == \
        (0.25, 0.75, 0.125, 0.125)
    assert sizes["carve_voxels"] == (1, 2)
    assert sizes["carve_box_units"] == (24.0, 40.0)
    assert (sizes["fill_voxels"], sizes["fill_seals_under_units"]) == (1, 16)


@pytest.mark.parametrize("fill, voxels, fill_m, seals", [(32, 4, 0.875, 64), (12, 2, 0.375, 32)])
def test_bake_sizes_dilate_the_fill_in_whole_voxels(fill, voxels, fill_m, seals):
    sizes = sm.bake_sizes(8, fill)
    assert (sizes["fill_voxels"], sizes["fill_m"], sizes["fill_seals_under_units"]) == \
        (voxels, fill_m, seals)


def test_bake_sizes_for_a_13_unit_voxel_carve_no_radius():
    sizes = sm.bake_sizes(13, 13)
    assert (sizes["carve_r_m"], sizes["carve_voxels"], sizes["carve_box_units"]) == \
        (0.0, (0, 1), (13.0, 39.0))


@pytest.mark.parametrize("voxel", range(1, 14))
def test_bake_sizes_fit_the_crouched_player_at_every_voxel(voxel):
    sizes = sm.bake_sizes(voxel, voxel)
    w, h = sizes["carve_box_units"]
    assert w <= 30 and h <= 40
    assert sm.carve_voxels(sizes["carve_h_m"], sizes["carve_r_m"], sizes["voxel_m"]) == \
        sizes["carve_voxels"]


@pytest.mark.parametrize("voxel", [0, 14, 2.5])
def test_bake_sizes_refuse_a_voxel_out_of_range(voxel):
    with pytest.raises(sm.FormatError):
        sm.bake_sizes(voxel, 8)


def test_carve_box_is_whole_voxels_about_one_cell():
    assert sm.carve_box_units(0.75, 0.125, 0.25) == (24.0, 40.0)
    assert sm.carve_voxels(0.76, 0.13, 0.25) == (1, 2)
    assert sm.carve_voxels(0.7500001, 0.25, 0.25) == (1, 2)
    assert sm.carve_voxels(1.0000001, 0.2500001, 0.25) == (2, 3)


# ------------------------------------------------------------------------------ octree


def test_octree_decodes_the_layout_it_was_written_in():
    for hole in (False, True):
        octree = room_octree(hole)
        assert np.array_equal(octree.dense(), room_grid(hole))
        stats = octree.validate()
        assert stats["problems"] == []
        assert (stats["interior"], stats["mixed"], stats["solid"]) == \
            (octree.header["numInteriorNodes"], octree.header["numMixedLeaves"], 2)


def test_octree_loads_from_its_two_files(tmp_path):
    header, raw = encode_octree(room_grid())
    (tmp_path / "room.voxel.json").write_text(json.dumps(header), encoding="utf-8")
    (tmp_path / "room.voxel.bin").write_bytes(raw)
    octree = sm.Octree.load(str(tmp_path / "room.voxel.json"))
    assert np.array_equal(octree.dense(), room_grid())


@pytest.mark.parametrize("change, message", [
    (lambda h, raw: (h, raw[:-4]), "voxel.bin size"),
    (lambda h, raw: ({**h, "leafDataCount": h["leafDataCount"] - 2}, raw[:-8]), "leafDataCount"),
    (lambda h, raw: ({**h, "leafSize": 8}, raw), "leafSize"),
])
def test_octree_refuses_a_bake_the_port_would(change, message):
    with pytest.raises(sm.FormatError, match=message):
        sm.Octree.from_bytes(*change(*encode_octree(room_grid())))


def test_octree_validate_reports_counts_off_the_header():
    header, raw = encode_octree(room_grid())
    header["numInteriorNodes"] += 1
    assert sm.Octree.from_bytes(header, raw).validate()["problems"] == [
        f"interior nodes {header['numInteriorNodes'] - 1} != header {header['numInteriorNodes']}"]


def test_octree_grid_must_start_on_a_whole_cell():
    assert room_octree().cells_from_origin() == (-8, -16, -8)
    header, raw = encode_octree(room_grid(), grid_min=(-2.1, -4.0, -2.0))
    with pytest.raises(sm.FormatError, match="not a whole multiple"):
        sm.Octree.from_bytes(header, raw).cells_from_origin()


def test_octree_maps_sim_voxels_to_cells_as_the_port():
    octree = room_octree()
    assert octree.voxel_units() == 8
    assert octree.sim_voxel_to_cell(0, 0, 0) == (7, 15, 7)
    assert octree.sim_voxel_to_cell(-2, 7, 0) == (9, 15, 0)
    assert octree.is_solid_cell(9, 15, 0)        # the step's edge
    assert not octree.is_solid_cell(8, 15, 0)
    assert not octree.is_solid_cell(7, 15, 7)
    assert octree.is_solid_cell(-1, 0, 0) and octree.is_solid_cell(0, 40, 0)  # outside


@pytest.mark.parametrize("mins, maxs, solid", [
    ((0, 0, 0), (8, 8, 8), 0),          # resting on the floor touches it, no more
    ((0, 0, -1), (8, 8, 8), 1),
    ((64, 0, 0), (72, 8, 8), 1),        # outside the grid
    ((32, 32, 64), (64, 64, 96), 64),   # the cube
    ((-32, 32, 0), (0, 64, 8), 12),     # the step
])
def test_sim_box_counts_the_solid_voxels_it_overlaps(mins, maxs, solid):
    assert room_octree().sim_box_solid_cells(mins, maxs) == solid


def test_sim_drop_falls_to_the_highest_solid_under_the_box():
    octree = room_octree()
    assert octree.sim_drop(*spawn_box((0, 0, 24))) == 9
    assert octree.sim_drop(*spawn_box((-16, 48, 24))) == 1
    assert octree.sim_drop(*spawn_box((0, 0, 24)), limit=8) is None
    assert octree.sim_drop(*spawn_box((0, 0, 24)), limit=16) == 9
    assert room_octree(hole=True).sim_drop(*spawn_box((-48, -48, 24))) == 201


def test_player_reach_stays_above_a_sealed_floor():
    reach = room_octree().player_reach(spawn_box((0, 0, 24))[0], 48)
    assert reach == {"positions": 1876, "box_voxels": (4, 4, 5), "x": (-64.0, 32.0),
                     "y": (-64.0, 32.0), "feet": (0.0, 88.0), "under": 0}


def test_player_reach_falls_through_a_hole_in_the_floor():
    reach = room_octree(hole=True).player_reach(spawn_box((0, 0, 24))[0], 48)
    assert reach["feet"] == (-192.0, 88.0)
    assert reach["under"] == 2530


# ------------------------------------------------------------------------------ names


def test_stem_of_strips_the_suffix_in_any_case():
    assert sm.stem_of("dir/garage_rats.voxel.json", ".voxel.json") == "garage_rats"
    assert sm.stem_of("ROOM.SOG", ".sog") == "ROOM"
    with pytest.raises(sm.FormatError):
        sm.stem_of("room.ent", ".sog")


@pytest.mark.parametrize("stem, ok", [
    ("a" * 44, True), ("a" * 45, False), ("room_1", True), ("Room", False), ("room-1", False),
    ("", False),
])
def test_stem_is_lowercase_digits_and_underscores_up_to_44(stem, ok):
    assert bool(sm.STEM_RE.match(stem)) is ok


@pytest.mark.parametrize("record, drawn", [
    (None, "room.sog"),
    ({"_pcq_bake": "--voxel-size 0.25"}, "room.sog"),
    ({"drawn": "room.drawn.sog"}, "room.drawn.sog"),
], ids=["no bake", "a bake that filtered nothing", "a bake that filtered"])
def test_the_drawn_splat_is_the_one_the_bake_record_names(tmp_path, record, drawn):
    for name in ("room.sog", "room.drawn.sog"):
        (tmp_path / name).write_bytes(b"")
    if record is not None:
        (tmp_path / "room.bake.json").write_text(json.dumps(record), encoding="utf-8")
    assert sm.drawn_splat(str(tmp_path / "room.sog")) == str(tmp_path / drawn)


@pytest.mark.parametrize("held", [None, b"Title: Another\n"], ids=["none", "another"])
def test_a_licence_is_put_into_a_bundle_stored_unless_it_holds_one(tmp_path, held):
    sog = tmp_path / "room.sog"
    with zipfile.ZipFile(sog, "w") as z:
        z.writestr("meta.json", "{}")
        if held:
            z.writestr("license.txt", held)
    problems = sm.put_license(str(sog), b"Title: Test Room\n")
    with zipfile.ZipFile(sog) as z:
        assert z.getinfo("license.txt").compress_type == zipfile.ZIP_STORED
        assert z.read("license.txt") == (held or b"Title: Test Room\n")
    assert problems == ([] if held is None else
                        ["license.txt in room.sog differs from the one it was given"])


def test_a_drawn_splat_that_is_missing_is_refused(tmp_path):
    (tmp_path / "room.sog").write_bytes(b"")
    (tmp_path / "room.bake.json").write_text(json.dumps({"drawn": "room.drawn.sog"}),
                                             encoding="utf-8")
    with pytest.raises(sm.FormatError, match="room.drawn.sog, which is missing: bake again"):
        sm.drawn_splat(str(tmp_path / "room.sog"))
