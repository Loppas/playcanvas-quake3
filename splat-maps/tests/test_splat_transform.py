"""The pinned splat-transform: found where npm puts it on this OS, held to the pin, and installed
with npm when it is missing. npm and splat-transform are stand-ins, and all of PATH."""

import os
import re

import pytest

from splat_maps import splat_map as sm
from tools import install, npm, splat_transform

PIN = sm.SPLAT_TRANSFORM_VERSION
COMMAND = "splat-transform.cmd" if os.name == "nt" else "splat-transform"


@pytest.fixture
def path(tmp_path, monkeypatch):
    """An empty folder, and the whole of PATH."""
    folder = tmp_path / "bin"
    folder.mkdir()
    monkeypatch.setenv("PATH", str(folder))
    return folder


def test_the_pinned_version_on_path_is_used(path):
    install(path, "splat-transform", splat_transform(PIN))
    assert os.path.samefile(sm.require_splat_transform(), path / COMMAND)
    assert not (path / "npm.log").exists()


def test_another_version_is_refused(path):
    install(path, "splat-transform", splat_transform("3.1.5"))
    install(path, "npm", npm(PIN))
    refused = rf"splat-transform 3\.1\.5 is on PATH.*calibrated for {re.escape(PIN)}"
    with pytest.raises(sm.FormatError, match=refused):
        sm.require_splat_transform()
    assert not (path / "npm.log").exists()


def test_a_missing_one_is_installed_with_npm(path):
    install(path, "npm", npm(PIN))
    assert os.path.samefile(sm.require_splat_transform(), path / COMMAND)
    assert (path / "npm.log").read_text() == f"install -g @playcanvas/splat-transform@{PIN}"


def test_an_install_of_another_version_is_refused(path):
    install(path, "npm", npm("3.1.5"))
    with pytest.raises(sm.FormatError, match=r"splat-transform 3\.1\.5 is on PATH"):
        sm.require_splat_transform()


@pytest.mark.parametrize("code, message", [
    ("import sys; sys.exit(1)", "npm could not install"),
    ("", "but not into a folder on PATH"),
], ids=["npm fails", "npm installs elsewhere"])
def test_an_install_that_puts_none_on_path_is_named(path, code, message):
    install(path, "npm", code)
    with pytest.raises(sm.FormatError, match=message):
        sm.require_splat_transform()


def test_no_npm_names_node(path):
    with pytest.raises(sm.FormatError, match=r"nor is npm.*Node >= 24"):
        sm.require_splat_transform()
