"""`map_lint.py`: each of `map-format.md` §10's rules, broken one at a time in the packaged
room, fails that rule and no other."""

import json

import pytest

from room import encode_octree, lint_failures, read_pk3, room_grid, run_script, sog_bytes, \
    write_pk3


def lint(pk3):
    code, log = run_script("map_lint.py", pk3)
    return code, log, lint_failures(log)


def test_lint_passes_the_packaged_room(room_pk3):
    code, log, failed = lint(room_pk3)
    assert (code, failed) == (0, set()), log
    assert "0 error(s), 0 warning(s): passes" in log


def entry(entries, name):
    return next(e for e in entries if e[0] == name)


def edit(name, change):
    def apply(entries):
        e = entry(entries, name)
        e[1] = change(e[1])
    return apply


def replace(name, old, new):
    def change(data):
        text = data.decode("latin-1")
        assert old in text, old
        return text.replace(old, new).encode("latin-1")
    return edit(name, change)


def ent(old, new):
    return replace("maps/room.ent", old, new)


def add_entity(*pairs):
    text = "{\n" + "".join(f'"{k}" "{v}"\n' for k, v in pairs) + "}\n"
    return edit("maps/room.ent", lambda data: data + text.encode("ascii"))


def add_spawn(origin):
    return add_entity(("classname", "info_player_deathmatch"), ("origin", origin))


def add_file(name, data, method=8):
    return lambda entries: entries.append([name, data, method])


def drop(name):
    return lambda entries: entries.remove(entry(entries, name))


def set_method(name, method):
    def apply(entries):
        entry(entries, name)[2] = method
    return apply


def header(change):
    def apply(data):
        h = json.loads(data)
        change(h)
        return json.dumps(h).encode("ascii")
    return edit("maps/room.voxel.json", apply)


def octree(grid, voxel_m=0.25):
    def apply(entries):
        h, raw = encode_octree(grid, voxel_m=voxel_m)
        entry(entries, "maps/room.voxel.json")[1] = json.dumps(h).encode("ascii")
        entry(entries, "maps/room.voxel.bin")[1] = raw
    return apply


def both(*changes):
    def apply(entries):
        for change in changes:
            change(entries)
    return apply


def off_whole_cell(h):
    h["gridBounds"]["min"][0] -= 0.1
    h["gridBounds"]["max"][0] -= 0.1


def coarse(grid):
    """The room at 16-unit voxels, a cell solid where any of its eight was."""
    nx, ny, nz = grid.shape
    return grid.reshape(nx // 2, 2, ny // 2, 2, nz // 2, 2).any(axis=(1, 3, 5))


def tga_depth(data):
    data = bytearray(data)
    data[16] = 32
    return bytes(data)


E, W = "ERR", "warn"
CASES = [
    # the container and its names
    ("duplicate entry", lambda es: es.append(list(entry(es, "maps/room.ent"))), {(E, "L1")}),
    ("a method Q3 cannot read", set_method("room.txt", 12), {(E, "L1")}),
    ("the .sog deflated", set_method("maps/room.sog", 8), {(E, "L2")}),
    ("an uppercase name", add_file("Readme.TXT", b"x"), {(E, "L3"), (W, "L3")}),
    ("a file outside the tree", add_file("notes.txt", b"x"), {(W, "L3")}),
    ("music beside the map", add_file("music/room.wav", b"x"), set()),
    ("a per-map file of another stem", add_file("maps/other.ent", b"{}"), {(E, "L4"), (W, "L3")}),
    ("two splats", add_file("maps/other.sog", sog_bytes(), 0), {(E, "L4")}),
    ("no readme", drop("room.txt"), {(E, "L5")}),
    # the splat and the octree
    ("the .sog not a bundle", edit("maps/room.sog", lambda _: b"not a zip"),
     {(E, "L6"), (E, "L19")}),
    ("the .sog holds no splats", edit("maps/room.sog", lambda _: sog_bytes(
        {"version": 2, "count": 0, "asset": {"generator": "splat-transform v3.1.6"}})),
     {(E, "L6")}),
    ("voxel.bin cut short", edit("maps/room.voxel.bin", lambda data: data[:-4]), {(E, "L7")}),
    ("counts off the header", header(lambda h: h.update(numInteriorNodes=h["numInteriorNodes"] + 1)),
     {(E, "L7")}),
    ("the grid off a whole cell", header(off_whole_cell), {(E, "L8")}),
    ("a 16-unit voxel", octree(coarse(room_grid()), voxel_m=0.5), {(E, "L9"), (E, "L10")}),
    ("the carve taller than the crouched player",
     ent("--voxel-carve 0.75,0.125", "--voxel-carve 1.25,0.125"), {(E, "L10")}),
    ("the carve wider than the player",
     ent("--voxel-carve 0.75,0.125", "--voxel-carve 0.75,0.375"), {(E, "L10")}),
    ("the bake's voxel not the octree's", ent("--voxel-size 0.25", "--voxel-size 0.125"),
     {(E, "L10")}),
    ("no carve in the bake", ent(" --voxel-carve 0.75,0.125", ""), {(E, "L10")}),
    # the entity text
    ("worldspawn not first", ent('"classname" "worldspawn"', '"classname" "info_null"'),
     {(E, "L11")}),
    ("a token Q3 cuts", ent('"message" "Test Room"', '"message" "' + "x" * 1100 + '"'),
     {(E, "L11"), (W, "L27")}),
    ("a key twice", ent('"message" "Test Room"', '"message" "Test Room"\n"Message" "Again"'),
     {(E, "L11")}),
    ("a block left open", edit("maps/room.ent", lambda data: data[:-2]), {(E, "L11")}),
    ("a byte past ASCII", ent("// entity 0", "// entity 0\x7f"), {(E, "L12")}),
    ("a quote in a key", ent('"message" "Test Room"', '"message" "Test Room"\nke"y "v"'),
     {(E, "L12")}),
    ("a brush entity", add_entity(("classname", "func_door")), {(E, "L13")}),
    ("an inline model", add_entity(("classname", "info_null"), ("model", "*1")), {(E, "L13")}),
    ("no spawn in a team game", ent('"spawnflags" "1"', '"spawnflags" "1"\n"notteam" "1"'),
     {(E, "L14")}),
    ("no intermission point", ent('"info_player_intermission"', '"info_null"'), {(E, "L15")}),
    ("a target named nowhere", ent('"target" "view"', '"target" "nowhere"'), {(E, "L16")}),
    ("a classname Q3 lacks", add_entity(("classname", "monster_army")), {(W, "L17")}),
    ("a misc_model", add_entity(("classname", "misc_model"), ("model", "models/x.md3")),
     {(W, "L18")}),
    ("a key of the pipeline's missing", ent('"_pcq_scale" "1.00000000"\n', ""), {(E, "L19")}),
    ("a format to come", ent('"_pcq_format" "1"', '"_pcq_format" "2"'), {(E, "L19")}),
    ("an absolute path", ent('"_pcq_polish" "', '"_pcq_polish" "D:/room.sog '), {(E, "L19")}),
    ("another splat-transform's octree",
     header(lambda h: h["asset"].update(generator="splat-transform v3.1.5")), {(E, "L19")}),
    # placement
    ("a spawn in solid", add_spawn("48 48 24"), {(E, "L20")}),
    ("a spawn that thuds", add_spawn("-48 0 60"), {(W, "L21")}),
    ("a spawn that hurts",
     both(ent('"message" "Test Room"', '"message" "Test Room"\n"gravity" "8000"'),
          add_spawn("-48 0 60")), {(E, "L21"), (W, "L21")}),
    ("the intermission in solid", ent('"origin" "0 -32 100"', '"origin" "48 48 80"'),
     {(E, "L22")}),
    ("two spawns overlapping", add_spawn("10 0 24"), {(W, "L23")}),
    ("two spawns touching", add_spawn("30 0 24"), set()),
    ("two spawns touching the other way", add_spawn("-30 0 24"), set()),
    ("a hole in the floor", octree(room_grid(hole=True)), {(W, "L24")}),
    # the arena, the levelshot and the readme
    ("the arena of another map", replace("scripts/room.arena", 'map "room"', 'map "other"'),
     {(E, "L25")}),
    ("two arena blocks", edit("scripts/room.arena", lambda data: data + data), {(E, "L25")}),
    ("the arena left open", replace("scripts/room.arena", "}", ""), {(E, "L25")}),
    ("a type the menus lack", replace("scripts/room.arena", '"ffa team"', '"ffa team capture"'),
     {(W, "L26")}),
    ("a longname not the message", replace("scripts/room.arena", '"Test Room"', '"Another Room"'),
     {(W, "L27")}),
    ("the levelshot cut short", edit("levelshots/room.tga", lambda data: data[:-1]),
     {(E, "L28")}),
    ("the levelshot at 32 bits", edit("levelshots/room.tga", tga_depth), {(E, "L28")}),
    ("the readme without the licence's link",
     replace("room.txt", "creativecommons.org/licenses/by/4.0", "example.com/licence"),
     {(E, "L29")}),
    ("the readme without the creator", replace("room.txt", "Nobody", "Somebody"), {(E, "L29")}),
]


@pytest.mark.parametrize("change, failed", [c[1:] for c in CASES], ids=[c[0] for c in CASES])
def test_lint_fails_the_rule_broken(room_pk3, change, failed):
    entries = read_pk3(room_pk3)
    change(entries)
    write_pk3(room_pk3, entries)
    code, log, got = lint(room_pk3)
    assert got == failed, log
    assert code == (1 if any(mark == E for mark, _ in failed) else 0), log


@pytest.mark.parametrize("record", [
    {"zip64": {"maps/room.ent"}},
    # A zip64 end record's signature in the archive's last bytes, where the record would sit.
    {"comment": b"PK\x06\x06"},
])
def test_lint_refuses_a_zip64_record(room_pk3, record):
    write_pk3(room_pk3, read_pk3(room_pk3), **record)
    code, log, failed = lint(room_pk3)
    assert (code, failed) == (1, {(E, "L1")}), log


@pytest.mark.parametrize("name, failed", [
    ("map-other.pk3", {(E, "L4")}),
    ("map-room_v2.pk3", set()),
    ("map-room_V2.pk3", {(E, "L4")}),
])
def test_lint_reads_the_stem_from_the_pk3s_name(room_pk3, name, failed):
    renamed = room_pk3.rename(room_pk3.with_name(name))
    code, log, got = lint(renamed)
    assert got == failed, log


def test_lint_refuses_what_is_not_a_zip(tmp_path):
    pk3 = tmp_path / "map-room.pk3"
    pk3.write_bytes(b"not a zip")
    code, log, failed = lint(pk3)
    assert (code, failed) == (1, {(E, "L1")}), log
