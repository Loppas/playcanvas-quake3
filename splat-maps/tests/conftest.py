"""The test room, as fixtures."""

import shutil
from pathlib import Path

import pytest

from room import run_cli, write_room


@pytest.fixture
def room(tmp_path):
    """The room's parts in a folder of the test's own; returns its `.sog`."""
    return write_room(tmp_path / "room")


@pytest.fixture(scope="session")
def packaged(tmp_path_factory):
    """The room packaged once: the pk3, and package_map's exit code and output."""
    sog = write_room(tmp_path_factory.mktemp("packaged"))
    code, out = run_cli("package", sog, "--author", "A Mapper")
    return sog.with_name("map-room.pk3"), code, out


@pytest.fixture
def room_pk3(packaged, tmp_path):
    """A copy of the packaged room, for a test to change."""
    pk3, code, out = packaged
    assert code == 0, out
    return Path(shutil.copy(pk3, tmp_path / pk3.name))
