"""The CLI: each stage's words reach that stage's own parser, and anything else lists them."""

import tomllib
from pathlib import Path

import pytest

from room import run_cli
from splat_maps import write_ent
from splat_maps.__main__ import main

#: Each stage's words, and the description its own parser prints.
STAGES = [
    (("all",), "Make a map from a video: every stage, with starter entities."),
    (("frames",), "Extract a video's frames for the SfM."),
    (("sfm",), "COLMAP's SfM over a capture's frames."),
    (("train",), "Train a splat with gsplat's MCMC trainer."),
    (("export",), "Export a trained splat as a SOG."),
    (("polish",), "Level, square and scale a trained SOG, and record the polish."),
    (("bake",), "Bake a splat map's collision in Quake units."),
    (("entities", "reference"), "Write a splat map's collision mesh as an editor model."),
    (("entities", "from-map"), "Keep a .map's point entities as a splat map .ent."),
    (("entities", "readings"), "Write a splat map's .ent from viewpos readings."),
    (("levelshot",), "Make a splat map's levelshot, as Q3 makes one."),
    (("arena",), "Write a splat map's arena block."),
    (("package",), "Assemble a splat map's pk3."),
    (("deliver",), "Deliver a splat map pk3 to the port."),
    (("lint",), "Lint a splat map pk3."),
]


def listed(text):
    """The stages a listing names, by their words."""
    rows = text.split("stages:\n", 1)[1].splitlines()
    return [tuple(row[:22].split()) for row in rows if row.strip()]


@pytest.mark.parametrize("words, description", STAGES, ids=[" ".join(w) for w, _ in STAGES])
def test_each_stage_reaches_its_own_parser(words, description, capsys):
    with pytest.raises(SystemExit) as ended:
        main([*words, "--help"])
    assert ended.value.code == 0
    out = capsys.readouterr().out
    assert out.startswith(f"usage: splat-maps {' '.join(words)} ")
    assert description in out


def test_a_stage_gets_the_arguments_after_its_words(monkeypatch):
    seen = {}
    monkeypatch.setattr(write_ent, "main", lambda argv, prog: seen.update(argv=argv, prog=prog))
    assert main(["entities", "readings", "room.ent", "--message", "Room"]) == 0
    assert seen == {"argv": ["room.ent", "--message", "Room"],
                    "prog": "splat-maps entities readings"}


def test_python_dash_m_runs_the_cli():
    code, out = run_cli("entities", "readings", "--help")
    assert code == 0
    assert out.startswith("usage: splat-maps entities readings ")


def test_help_lists_every_stage():
    code, out = run_cli("--help")
    assert code == 0
    assert listed(out) == [words for words, _ in STAGES]


def test_no_stage_lists_them_and_fails(capsys):
    assert main([]) == 2
    err = capsys.readouterr().err
    assert listed(err) == [words for words, _ in STAGES]


def test_an_unknown_stage_is_named(capsys):
    assert main(["bak", "room.sog"]) == 2
    err = capsys.readouterr().err
    assert err.rstrip().endswith("splat-maps: no stage 'bak'")


@pytest.mark.parametrize("args, code", [(["entities"], 2), (["entities", "--help"], 0),
                                        (["entities", "readigns"], 2)])
def test_entities_alone_lists_its_routes(args, code, capsys):
    assert main(args) == code
    captured = capsys.readouterr()
    text = captured.out if code == 0 else captured.err
    assert listed(text) == [("entities", "reference"), ("entities", "from-map"),
                            ("entities", "readings")]
    assert "no stage" not in text


def test_version_is_the_projects():
    pyproject = Path(__file__).resolve().parents[1] / "pyproject.toml"
    expected = tomllib.loads(pyproject.read_text(encoding="utf-8"))["project"]["version"]
    assert run_cli("--version") == (0, f"splat-maps {expected}\n")
