"""The polish, run as the CLI: the measure and the verify for real, on a box room already
polished, and splat-transform a stand-in that copies the bundle as its writer does."""

import json
import os
import zipfile

import pytest

from capture import LICENCE, write_capture
from room import run_cli
from splat_maps import splat_map as sm
from tools import install, splat_transform

#: superspl.at's fields, given as `--license` for a capture with none of its own.
FIELDS = ("Title: Test Room; Author: A Capturer; Source: https://example.com/room; "
          "License URL: https://creativecommons.org/licenses/by/4.0/")


def first_on_path(monkeypatch, folder, version):
    """The stand-in splat-transform at `version`, first on PATH; returns the log of its runs."""
    install(folder, "splat-transform", splat_transform(version))
    monkeypatch.setenv("PATH", str(folder) + os.pathsep + os.environ["PATH"])
    return folder / "splat-transform.log"


@pytest.fixture
def runs(tmp_path, monkeypatch):
    """The stand-in splat-transform at the pin, first on PATH; returns the log of its runs."""
    return first_on_path(monkeypatch, tmp_path / "bin", sm.SPLAT_TRANSFORM_VERSION)


def polish(tmp_path, *args, licence=LICENCE):
    """The capture polished into `map/room.sog`: the exit code, the output and the record."""
    src = write_capture(tmp_path / "room.sog", licence)
    out = tmp_path / "map" / "room.sog"
    out.parent.mkdir()
    code, text = run_cli("polish", src, out, *args)
    record = out.with_name("room.polish.json")
    return code, text, json.loads(record.read_text()) if record.exists() else None


def test_the_polish_measures_applies_verifies_and_records(tmp_path, runs):
    # The box is the same either way up, so the hint turns the transform over and the copy still
    # verifies, as long as the verify hints +Y.
    code, text, record = polish(tmp_path, "2.5", "--player-height", "1.75", "--up-hint", "0,-1,0",
                                "--opacity", "0.3")
    assert code == 0, text
    measure = json.loads((tmp_path / "room_inspect" / "report.json").read_text())
    verify = json.loads((tmp_path / "map" / "room_inspect" / "report.json").read_text())

    # Applied once, through the transform the measure derived.
    applied = [json.loads(line) for line in runs.read_text().splitlines()]
    assert applied == [["-w", str(tmp_path / "room.sog"), *measure["splat_transform_args"],
                        str(tmp_path / "map" / "room.sog")]]
    # Verified as polished: +Y up whatever the input's hint, at the output's own scale.
    assert (verify["up_hint"], verify["scale_m_per_unit"]) == ("0,1,0", 1.0)

    assert record["_pcq_polish"] == ("--metric-height 2.5 --player-height 1.75 --up-hint 0,-1,0 "
                                     "--opacity 0.3")
    transform = measure["splat_transform_args"]
    assert record["_pcq_scale"] == dict(zip(transform[::2], transform[1::2]))["-s"]
    assert record["_pcq_splat_transform"] == sm.SPLAT_TRANSFORM_VERSION
    assert record["_pcq_source"] == "Test Room by A Capturer, https://example.com/room"
    assert record["_pcq_license"] == "CC-BY-4.0"
    assert (record["errors"], record["warnings"]) == ([], [])
    assert record["verify"]["clear_height_m"] == pytest.approx(2.5, abs=0.005)
    with zipfile.ZipFile(tmp_path / "map" / "room.sog") as z:
        assert z.read("license.txt") == LICENCE


def test_a_capture_with_no_licence_takes_the_one_given(tmp_path, runs):
    code, text, record = polish(tmp_path, "2.5", "--license", FIELDS,
                                "--out", tmp_path / "drawings", licence=None)
    assert code == 0, text
    # Where the drawings go changes nothing in the transform, so is not recorded.
    assert record["_pcq_polish"] == "--metric-height 2.5"
    assert record["_pcq_source"] == "Test Room by A Capturer, https://example.com/room"
    with zipfile.ZipFile(tmp_path / "map" / "room.sog") as z:
        assert z.read("license.txt").decode() == FIELDS.replace("; ", "\n")


def test_a_source_s_own_licence_is_never_replaced(tmp_path, runs):
    code, text, _ = polish(tmp_path, "2.5", "--license", FIELDS)
    assert code == 1
    assert "carries its own license.txt, which --license would replace" in text


def test_another_splat_transform_is_refused_before_anything_is_measured(tmp_path, monkeypatch):
    first_on_path(monkeypatch, tmp_path / "bin", "3.1.5")
    code, text, record = polish(tmp_path, "2.5")
    assert code == 1
    assert "splat-transform 3.1.5 is on PATH" in text
    assert not (tmp_path / "room_inspect").exists() and record is None


def test_a_verify_off_the_mark_fails_the_polish(tmp_path, runs):
    # 3 m asks for a scale of 1.2, which the copy never gets.
    code, text, record = polish(tmp_path, "3.0")
    assert code == 1
    assert "FAIL clear height" in text
    assert len(record["errors"]) == 1 and "clear height" in record["errors"][0]
