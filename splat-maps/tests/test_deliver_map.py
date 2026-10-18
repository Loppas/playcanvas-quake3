"""`deliver_map.py`: a linted pk3 into the port's `public/maps/`, whole or not at all."""

from pathlib import Path

import pytest

from room import run_cli
from splat_maps import deliver_map


@pytest.fixture
def port(tmp_path):
    """A checkout as delivery recognises one: a package.json and public/maps."""
    root = tmp_path / "port"
    (root / "public" / "maps").mkdir(parents=True)
    (root / "package.json").write_text("{}\n", encoding="utf-8")
    return root


def deliver(pk3, port, *args):
    return run_cli("deliver", pk3, "--port", port, *args)


def test_the_default_port_is_this_checkout():
    assert Path(deliver_map.DEFAULT_PORT) == Path(__file__).resolve().parents[2]


def test_deliver_copies_the_pk3_whole(room_pk3, port):
    code, log = deliver(room_pk3, port)
    assert code == 0, log
    maps = port / "public" / "maps"
    assert [p.name for p in maps.iterdir()] == ["map-room.pk3"]
    assert (maps / "map-room.pk3").read_bytes() == room_pk3.read_bytes()
    assert "the same as the pk3 it came from" in log


def test_deliver_again_changes_nothing(room_pk3, port):
    assert deliver(room_pk3, port)[0] == 0
    code, log = deliver(room_pk3, port)
    assert code == 0, log
    assert "is already this pk3, byte for byte" in log


def test_deliver_never_rewrites_a_pk3_in_place(room_pk3, port):
    dest = port / "public" / "maps" / "map-room.pk3"
    dest.write_bytes(b"a released map")
    code, log = deliver(room_pk3, port)
    assert code != 0
    assert "exists with different bytes" in log
    assert dest.read_bytes() == b"a released map"


def test_deliver_replaces_when_told(room_pk3, port):
    dest = port / "public" / "maps" / "map-room.pk3"
    dest.write_bytes(b"a map never released")
    code, log = deliver(room_pk3, port, "--replace")
    assert code == 0, log
    assert dest.read_bytes() == room_pk3.read_bytes()
    assert not dest.with_name("map-room.pk3.part").exists()


def test_deliver_refuses_what_the_lint_refuses(room_pk3, port):
    renamed = room_pk3.rename(room_pk3.with_name("map-other.pk3"))
    code, log = deliver(renamed, port)
    assert code != 0
    assert "the lint refused the pk3, so it was not delivered" in log
    assert not list((port / "public" / "maps").iterdir())


@pytest.mark.parametrize("missing", ["package.json", "public/maps"])
def test_deliver_needs_the_port(room_pk3, port, missing):
    path = port / missing
    path.rmdir() if path.is_dir() else path.unlink()
    code, log = deliver(room_pk3, port)
    assert code != 0
    assert "does not look like the port" in log
