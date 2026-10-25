"""The polish, run as the CLI: the measure and the verify for real, on a box room already
polished, and splat-transform a stand-in that copies the bundle as its writer does."""

import json
import os
import shutil
import zipfile

import pytest

from capture import LICENCE, write_capture
from room import run_cli
from splat_maps import polish as polish_stage
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


def polish(tmp_path, *args, licence=LICENCE, ceiling=True):
    """The capture polished into `map/room.sog`: the exit code, the output and the record."""
    src = write_capture(tmp_path / "room.sog", licence, ceiling)
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


def test_a_capture_open_to_the_sky_has_no_ceiling_to_scale_by(tmp_path, runs):
    code, text, record = polish(tmp_path, "2.5", ceiling=False)
    assert code == 1
    assert "--outdoor for a capture with no ceiling" in text
    assert record is None


def test_the_top_of_a_capture_open_to_the_sky_scales_it(tmp_path, runs):
    # The walls stand 2.5 m, and the top leaves the highest 1% of the splats above it: 1.4% of
    # the walls', so their top 3.6 cm. Given as 2.464 m, the copy verifies.
    code, text, record = polish(tmp_path, "2.464", "--outdoor", ceiling=False)
    assert code == 0, text
    measure = json.loads((tmp_path / "room_inspect" / "report.json").read_text())
    assert (measure["outdoor"], measure["ceiling_inliers"]) == (True, None)
    assert measure["clear_height_units"] == pytest.approx(2.464, abs=0.002)
    assert record["_pcq_polish"] == "--metric-height 2.464 --outdoor"
    assert record["verify"]["clear_height_m"] == pytest.approx(2.464, abs=0.005)
    assert (record["errors"], record["warnings"]) == ([], [])


@pytest.mark.parametrize("outdoor", [True, False], ids=["outdoors", "a room"])
def test_outdoors_the_verify_may_sit_a_little_further_off(tmp_path, outdoor):
    # 0.2 degrees of tilt and yaw and 0.8% of height: inside --outdoor's limits, past a room's.
    src = write_capture(tmp_path / "room.sog", LICENCE)
    out = tmp_path / "map.sog"
    shutil.copy(src, out)
    measure = {"splat_transform_args": ["-s", "1.00000000"], "outdoor": outdoor, "splats": 40_000,
               "clear_height_units": 2.5, "scale_m_per_unit": 1.0}
    verify = {"tilt_from_hint_deg": 0.2, "yaw_deg": -0.2, "floor_y_units": 0.0,
              "clear_height_units": 2.52, "footprint_units": [4.0, 5.0]}
    record = lambda: polish_stage.record_polish(str(src), str(out), measure, verify,  # noqa: E731
                                                ["--metric-height", "2.5"], None)
    if outdoor:
        record()
    else:
        with pytest.raises(SystemExit):
            record()
    written = json.loads(out.with_name("map.polish.json").read_text())
    assert len(written["errors"]) == (0 if outdoor else 3)


def record_credit(tmp_path, title, author):
    """The polish's last step on a capture whose licence gives `title` and `author`, its verify
    clean: whether it exited, and its record."""
    licence = LICENCE.replace(b"Test Room", title.encode()).replace(b"A Capturer (a note)",
                                                                    author.encode())
    src = write_capture(tmp_path / "room.sog", licence)
    out = tmp_path / "map.sog"
    shutil.copy(src, out)
    measure = {"splat_transform_args": ["-s", "1.00000000"], "outdoor": False, "splats": 40_000,
               "clear_height_units": 2.5, "scale_m_per_unit": 1.0}
    verify = {"tilt_from_hint_deg": 0.0, "yaw_deg": 0.0, "floor_y_units": 0.0,
              "clear_height_units": 2.5, "footprint_units": [4.0, 5.0]}
    try:
        polish_stage.record_polish(str(src), str(out), measure, verify, ["--metric-height", "2.5"],
                                   None)
        exited = False
    except SystemExit:
        exited = True
    return exited, json.loads(out.with_name("map.polish.json").read_text(encoding="utf-8"))


def test_the_polish_folds_a_credit_spelt_past_ascii_and_keeps_the_licence_as_spelt(tmp_path):
    exited, record = record_credit(tmp_path, "Caf\xe9 Room",
                                   "J\xf6rg Example (https://example.com/user/1)")
    assert (exited, record["errors"]) == (False, [])
    assert record["_pcq_source"] == "Cafe Room by Joerg Example, https://example.com/room"
    assert record["license"]["title"] == "Caf\xe9 Room"
    assert record["license"]["author"] == "J\xf6rg Example (https://example.com/user/1)"


def test_the_polish_refuses_a_credit_no_fold_brings_into_ascii(tmp_path):
    exited, record = record_credit(tmp_path, "Test Room", "\u041f\u0451\u0442\u0440")
    assert exited
    assert len(record["errors"]) == 1
    assert record["errors"][0].startswith("_pcq_source holds U+041F CYRILLIC CAPITAL LETTER PE, ")


def test_a_verify_off_the_mark_fails_the_polish(tmp_path, runs):
    # 3 m asks for a scale of 1.2, which the copy never gets.
    code, text, record = polish(tmp_path, "3.0")
    assert code == 1
    assert "FAIL clear height" in text
    assert len(record["errors"]) == 1 and "clear height" in record["errors"][0]
