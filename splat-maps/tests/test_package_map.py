"""`package_map.py`: the parts into a pk3 laid out as `map-format.md` §2.1 has it, the same
bytes from the same parts."""

import json
import subprocess
import zipfile

import pytest

import package_map
import splat_map as sm
from room import BAKE, ENT, POLISH, read_pk3, run_script


def test_package_lays_out_the_pk3(packaged):
    pk3, code, log = packaged
    assert code == 0, log
    with zipfile.ZipFile(pk3) as z:
        infos = z.infolist()
    assert [(i.filename, i.compress_type) for i in infos] == [
        ("maps/room.sog", zipfile.ZIP_STORED),
        ("maps/room.voxel.json", zipfile.ZIP_DEFLATED),
        ("maps/room.voxel.bin", zipfile.ZIP_DEFLATED),
        ("maps/room.ent", zipfile.ZIP_DEFLATED),
        ("scripts/room.arena", zipfile.ZIP_DEFLATED),
        ("levelshots/room.tga", zipfile.ZIP_DEFLATED),
        ("room.txt", zipfile.ZIP_DEFLATED),
    ]
    assert {i.date_time for i in infos} == {(1980, 1, 1, 0, 0, 0)}
    assert {i.external_attr >> 16 for i in infos} == {0o644}
    assert "0 error(s), 0 warning(s): passes" in log


def test_package_copies_the_parts_unchanged(packaged):
    pk3, _, _ = packaged
    entries = {name: data for name, data, _ in read_pk3(pk3)}
    for name, part in [("maps/room.sog", "room.sog"), ("maps/room.voxel.json", "room.voxel.json"),
                       ("maps/room.voxel.bin", "room.voxel.bin"),
                       ("scripts/room.arena", "room.arena"), ("levelshots/room.tga", "room.tga")]:
        assert entries[name] == (pk3.parent / part).read_bytes(), name


def test_package_writes_the_pipelines_keys_into_worldspawn(packaged):
    pk3, _, _ = packaged
    with zipfile.ZipFile(pk3) as z:
        entities, _ = sm.parse_entities(z.read("maps/room.ent"))
    world = entities[0].pairs
    pipeline = world[-1][1]
    assert world == [
        ("classname", "worldspawn"), ("message", "Test Room"),
        ("_pcq_format", "1"),
        ("_pcq_source", POLISH["_pcq_source"]),
        ("_pcq_license", "CC-BY-4.0"),
        ("_pcq_polish", POLISH["_pcq_polish"]),
        ("_pcq_scale", "1.00000000"),
        ("_pcq_bake", BAKE["_pcq_bake"]),
        ("_pcq_splat_transform", "3.1.6"),
        ("_pcq_pipeline", pipeline),
    ]
    head = subprocess.run(["git", "-C", str(package_map.HERE), "rev-parse", "--short", "HEAD"],
                          capture_output=True, text=True).stdout.strip()
    assert pipeline.removesuffix("-dirty") == head
    original, _ = sm.parse_entities(ENT.encode("ascii"))
    assert [e.pairs for e in entities[1:]] == [e.pairs for e in original[1:]]


README = """\
Test Room
=========

Map name       room   (start it with: map room)
File           map-room.pk3
Author         A Mapper
Description    A Quake 3 map made from a Gaussian-splat capture, for
               playcanvas-quake3. The splat is the map's surfaces and lighting,
               and a voxel octree baked from it is the map's collision.

Play information
----------------
Game types     ffa team
Bot play       no: a splat map has no .aas
New sounds     no
New graphics   the splat, maps/room.sog
New music      no
Needs          playcanvas-quake3, which reads a splat map. Stock ioquake3
               cannot load it, since it has no BSP.

Construction
------------
Base           "Test Room", a Gaussian-splat capture (see Credits)
Built with     playcanvas-quake3 {pipeline}, splat-transform 3.1.6
Polish         sog_inspect --metric-height 3.0 --player-height 1.8
               --up-hint 0,-1,0
               scaled 1.00000000x, to metres at 32 Quake units each
Collision      splat-transform --voxel-size 0.25 --voxel-external-fill 0.125
               --voxel-carve 0.75,0.125 --seed-pos 0,0,0
               --collision-mesh smooth
Entities       1 spawn spot, 2 others, in Q3 units
Levelshot      levelshots/room.tga, from the intermission point
Known bugs     none measured

Credits
-------
This map is built on "Test Room" by Nobody
(https://example.com/user/1), https://example.com/scene/1.
It is licensed under CC BY 4.0 (http://creativecommons.org/licenses/by/4.0/).

The capture was changed: levelled and squared, scaled 1.00000000x,
baked into a voxel collision octree, and given Quake 3 entities.

Distribution and copyright
--------------------------
This map is licensed under CC BY 4.0, as its source is:
http://creativecommons.org/licenses/by/4.0/
Credit the source as the Credits section does, and say what you changed.
"""


def test_package_writes_the_readme_for_people(packaged):
    pk3, _, _ = packaged
    with zipfile.ZipFile(pk3) as z:
        readme = z.read("room.txt")
        entities, _ = sm.parse_entities(z.read("maps/room.ent"))
    pipeline = entities[0].get("_pcq_pipeline")
    assert readme == README.format(pipeline=pipeline).replace("\n", "\r\n").encode("ascii")


def test_package_makes_the_same_bytes_from_the_same_parts(packaged, tmp_path):
    pk3, _, _ = packaged
    code, log = run_script("package_map.py", pk3.parent / "room.sog", "--author", "A Mapper",
                           "--out-dir", tmp_path)
    assert code == 0, log
    assert (tmp_path / "map-room.pk3").read_bytes() == pk3.read_bytes()


def test_package_leaves_out_a_part_that_is_optional(room):
    room.with_name("room.tga").unlink()
    code, log = run_script("package_map.py", room, "--author", "A Mapper")
    assert code == 0, log
    with zipfile.ZipFile(room.with_name("map-room.pk3")) as z:
        assert "levelshots/room.tga" not in z.namelist()
        assert "Levelshot      none" in z.read("room.txt").decode("ascii")


def rewrite_json(name, change):
    def apply(folder):
        path = folder / name
        path.write_text(json.dumps(change(json.loads(path.read_text(encoding="utf-8")))),
                        encoding="utf-8")
    return apply


def rewrite_ent(old, new):
    def apply(folder):
        path = folder / "room.ent"
        text = path.read_text(encoding="ascii")
        assert old in text
        path.write_text(text.replace(old, new), encoding="ascii")
    return apply


def rename_parts(folder):
    for part in list(folder.iterdir()):
        part.rename(folder / part.name.replace("room", "Room"))


@pytest.mark.parametrize("change, sog, message", [
    (lambda f: (f / "room.bake.json").unlink(), "room.sog", "missing room.bake.json"),
    (rewrite_json("room.polish.json", lambda p: {**p, "errors": ["a tilt"]}), "room.sog",
     "the polish or the bake recorded errors"),
    (rewrite_json("room.polish.json", lambda p: {**p, "_pcq_splat_transform": "3.1.5"}),
     "room.sog", "(L19)"),
    (rewrite_json("room.polish.json", lambda p: {k: v for k, v in p.items() if k != "license"}),
     "room.sog", "(L29)"),
    (rewrite_ent('"classname" "worldspawn"', '"classname" "info_null"'), "room.sog",
     "not worldspawn"),
    (rewrite_ent('"message" "Test Room"', '"message" "' + "x" * 1100 + '"'), "room.sog",
     "cut at 1023 bytes"),
    (rewrite_ent('"message" "Test Room"',
                 "\n".join(f'"k{i}" "v"' for i in range(56)) + '\n"message" "Test Room"'),
     "room.sog", "with the _pcq_* keys, worldspawn breaks a limit"),
    (rename_parts, "Room.sog", "is not [a-z0-9_]"),
])
def test_package_refuses(room, change, sog, message):
    change(room.parent)
    code, log = run_script("package_map.py", room.parent / sog, "--author", "A Mapper")
    assert code != 0
    assert message in log
    assert not list(room.parent.glob("*.pk3"))


def git(folder, *args):
    subprocess.run(["git", "-C", str(folder), "-c", "user.name=test",
                    "-c", "user.email=test", *args], check=True, capture_output=True)


def test_pipeline_commit_names_the_scripts_commit_and_whether_they_changed(tmp_path, monkeypatch):
    monkeypatch.setattr(package_map, "HERE", str(tmp_path))
    assert package_map.pipeline_commit() == "unknown"
    git(tmp_path, "init", "-q")
    (tmp_path / "stage.py").write_text("one\n", encoding="utf-8")
    git(tmp_path, "add", ".")
    git(tmp_path, "commit", "-q", "-m", "one")
    head = subprocess.run(["git", "-C", str(tmp_path), "rev-parse", "--short", "HEAD"],
                          capture_output=True, text=True).stdout.strip()
    assert package_map.pipeline_commit() == head
    (tmp_path / "stage.py").write_text("two\n", encoding="utf-8")
    assert package_map.pipeline_commit() == head + "-dirty"


def test_package_warns_when_the_scripts_have_changed(room, monkeypatch, capsys):
    monkeypatch.setattr(package_map, "pipeline_commit", lambda: "abc1234-dirty")
    monkeypatch.setattr("sys.argv", ["package_map.py", str(room), "--author", "A Mapper"])
    with pytest.raises(SystemExit) as ended:
        package_map.main()
    assert ended.value.code == 0
    assert "WARNING: the scripts have uncommitted changes" in capsys.readouterr().out
