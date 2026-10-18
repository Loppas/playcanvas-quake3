"""`write_arena.py`: the arena block, written in retail's layout and read back as Q3 reads it."""

import pytest

from room import ENT, run_script

#: garage_cats' arena block, as write_arena wrote it.
GARAGE_CATS_ARENA = """\
{
map "garage_cats"
longname "The Garage (Cat Size)"
type "ffa tourney team clanarena"
bots "mynx orbb bitterman"
}
"""


@pytest.fixture
def ent(tmp_path):
    path = tmp_path / "room.ent"
    path.write_text(ENT.replace("Test Room", "The Garage (Cat Size)"), encoding="ascii")
    return path


def test_write_arena_writes_garage_cats_block(tmp_path, ent):
    out = tmp_path / "scripts" / "garage_cats.arena"
    code, log = run_script("write_arena.py", out, "--ent", ent,
                           "--type", "ffa  tourney team clanarena", "--bots", "mynx orbb bitterman")
    assert code == 0, log
    assert out.read_bytes() == GARAGE_CATS_ARENA.encode("ascii")
    assert "WARNING" not in log


def test_write_arena_adds_single_players_keys_in_order(tmp_path):
    out = tmp_path / "room.arena"
    code, log = run_script("write_arena.py", out, "--longname", "Test Room", "--type", "single",
                           "--fraglimit", "10", "--timelimit", "5", "--special", "Training")
    assert code == 0, log
    assert out.read_text(encoding="ascii") == (
        '{\nmap "room"\nlongname "Test Room"\ntype "single"\nfraglimit "10"\ntimelimit "5"\n'
        'special "Training"\n}\n')


def test_write_arena_defaults_to_ffa(tmp_path):
    out = tmp_path / "room.arena"
    assert run_script("write_arena.py", out, "--longname", "Test Room")[0] == 0
    assert 'type "ffa"' in out.read_text(encoding="ascii")


@pytest.mark.parametrize("args, warning", [
    (["--type", "ffa capture"], "WARNING: type tokens the menus ignore: capture (L26)"),
    (["--longname", "Another Room"],
     "WARNING: longname 'Another Room' differs from worldspawn's message "
     "'The Garage (Cat Size)' (L27)"),
])
def test_write_arena_warns_as_the_lint(tmp_path, ent, args, warning):
    code, log = run_script("write_arena.py", tmp_path / "room.arena", "--ent", ent, *args)
    assert code == 0, log
    assert warning in log.splitlines()


@pytest.mark.parametrize("name, args, error", [
    ("Room.arena", ["--longname", "Test Room"], "is not [a-z0-9_]"),
    ("room.arena", [], "no longname"),
    ("room.arena", ["--longname", "Test; Room"], "not a valid arena pair"),
])
def test_write_arena_refuses(tmp_path, name, args, error):
    code, log = run_script("write_arena.py", tmp_path / name, *args)
    assert code != 0
    assert error in log
    assert not (tmp_path / name).exists()
