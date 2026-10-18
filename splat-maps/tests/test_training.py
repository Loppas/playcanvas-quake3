"""The training stages, frames to export, run as the CLI, with stand-ins for ffmpeg, COLMAP,
gsplat's trainer and splat-transform, which need a GPU and hours."""

import json
import os
import sys
from pathlib import Path

import pytest

from room import run_cli
from splat_maps import splat_map as sm
from tools import colmap, ffmpeg, gsplat, install, runs, splat_transform


@pytest.fixture
def bin_dir(tmp_path, monkeypatch):
    """A folder first on PATH for the stand-ins, with no tool named in a setting."""
    for name in ("SPLAT_FFMPEG", "SPLAT_COLMAP", "SPLAT_GSPLAT"):
        monkeypatch.delenv(name, raising=False)
    folder = tmp_path / "bin"
    folder.mkdir()
    monkeypatch.setenv("PATH", str(folder) + os.pathsep + os.environ["PATH"])
    return folder


def frames_in(dataset, count):
    """`count` frames in the dataset's images/, as `frames` names them."""
    images = dataset / "images"
    images.mkdir(parents=True)
    for i in range(1, count + 1):
        (images / f"frame_{i:04d}.jpg").write_bytes(b"frame")


# ------------------------------------------------------------------------------------- frames


def test_frames_are_taken_at_the_rate_and_width_asked(tmp_path, bin_dir):
    tool = install(bin_dir, "ffmpeg", ffmpeg(3))
    video = tmp_path / "room.mov"
    video.write_bytes(b"video")
    code, out = run_cli("frames", video, tmp_path / "room", "--fps", "2", "--width", "960")
    assert code == 0, out
    assert sorted(os.listdir(tmp_path / "room" / "images")) == [
        "frame_0001.jpg", "frame_0002.jpg", "frame_0003.jpg"]
    [args] = runs(tool)
    assert args[args.index("-vf") + 1] == "fps=2,scale=960:-2"
    assert "3 frames" in out


def test_frames_come_from_the_ffmpeg_the_setting_names(tmp_path, bin_dir, monkeypatch):
    tool = install(tmp_path / "elsewhere", "ffmpeg", ffmpeg(1))
    monkeypatch.setenv("SPLAT_FFMPEG", str(tool))
    video = tmp_path / "room.mov"
    video.write_bytes(b"video")
    code, out = run_cli("frames", video, tmp_path / "room")
    assert code == 0, out
    assert len(runs(tool)) == 1


def test_blurred_frames_are_set_aside(tmp_path, bin_dir):
    install(bin_dir, "ffmpeg", ffmpeg(4, blurred=(2, 3)))
    video = tmp_path / "room.mov"
    video.write_bytes(b"video")
    code, out = run_cli("frames", video, tmp_path / "room")
    assert code == 0, out
    assert sorted(os.listdir(tmp_path / "room" / "images")) == ["frame_0001.jpg",
                                                                 "frame_0004.jpg"]
    assert sorted(os.listdir(tmp_path / "room" / "images_rejected")) == ["frame_0002.jpg",
                                                                          "frame_0003.jpg"]
    assert ("2 blurred, under 0.25 of the median sharpness, set aside in images_rejected/: "
            "frame_0002.jpg, frame_0003.jpg") in out


def test_no_frame_is_set_aside_at_no_minimum(tmp_path, bin_dir):
    install(bin_dir, "ffmpeg", ffmpeg(4, blurred=(2, 3)))
    video = tmp_path / "room.mov"
    video.write_bytes(b"video")
    code, out = run_cli("frames", video, tmp_path / "room", "--min-sharpness", "0")
    assert code == 0, out
    assert len(os.listdir(tmp_path / "room" / "images")) == 4
    assert not (tmp_path / "room" / "images_rejected").exists()


def test_a_video_that_gives_no_frames_stops_there(tmp_path, bin_dir):
    install(bin_dir, "ffmpeg", ffmpeg(0))
    video = tmp_path / "room.mov"
    video.write_bytes(b"video")
    code, out = run_cli("frames", video, tmp_path / "room")
    assert code == 1
    assert "ffmpeg wrote no frames" in out


def test_frames_are_never_mixed_with_others(tmp_path, bin_dir):
    tool = install(bin_dir, "ffmpeg", ffmpeg(3))
    frames_in(tmp_path / "room", 1)
    video = tmp_path / "room.mov"
    video.write_bytes(b"video")
    code, out = run_cli("frames", video, tmp_path / "room")
    assert code == 1
    assert "already holds frames" in out
    assert not (tool.parent / "ffmpeg.log").exists()


# ---------------------------------------------------------------------------------------- sfm


def test_sfm_runs_colmap_in_order_and_keeps_the_largest_model(tmp_path, bin_dir):
    tool = install(bin_dir, "colmap", colmap({"0": 4, "1": 9}))
    frames_in(tmp_path / "room", 10)
    code, out = run_cli("sfm", tmp_path / "room")
    assert code == 0, out
    assert [args[0] for args in runs(tool)] == [
        "feature_extractor", "sequential_matcher", "mapper", "model_analyzer", "model_analyzer",
        "model_converter"]
    sparse = tmp_path / "room" / "sparse"
    assert os.listdir(sparse) == ["0"]
    assert (sparse / "0" / "registered").read_text() == "9"
    assert runs(tool)[-1][1:] == ["--input_path", str(sparse / "0"), "--output_path",
                                  str(sparse / "0"), "--output_type", "BIN"]
    assert "9 of 10 frames registered" in out and "WARNING" not in out


def test_sfm_warns_when_most_frames_do_not_register(tmp_path, bin_dir):
    install(bin_dir, "colmap", colmap({"0": 4}))
    frames_in(tmp_path / "room", 10)
    code, out = run_cli("sfm", tmp_path / "room")
    assert code == 0, out
    assert "WARNING: fewer than half the frames registered" in out


def test_sfm_never_adds_to_a_model_already_there(tmp_path, bin_dir):
    tool = install(bin_dir, "colmap", colmap({"0": 4}))
    frames_in(tmp_path / "room", 10)
    (tmp_path / "room" / "sparse" / "0").mkdir(parents=True)
    code, out = run_cli("sfm", tmp_path / "room")
    assert code == 1
    assert "already holds a model" in out
    assert not (tool.parent / "colmap.log").exists()


# -------------------------------------------------------------------------------------- train


def test_train_runs_gsplat_s_trainer_in_its_checkout_in_this_python(tmp_path, bin_dir,
                                                                    monkeypatch):
    trainer = gsplat(tmp_path / "gsplat")
    monkeypatch.setenv("SPLAT_GSPLAT", str(tmp_path / "gsplat"))
    dataset = tmp_path / "room"
    (dataset / "sparse" / "0").mkdir(parents=True)
    code, out = run_cli("train", dataset, "--max-steps", "10000", "--use-bilateral-grid")
    assert code == 0, out
    [args] = runs(trainer)
    assert args == ["mcmc", "--data-dir", str(dataset), "--data-factor", "1",
                    "--result-dir", str(dataset / "results" / "mcmc"),
                    "--strategy.cap-max", "1000000", "--max-steps", "10000",
                    "--antialiased", "--save-ply", "--disable-viewer", "--use-bilateral-grid"]
    ran = json.loads(next(line for line in out.splitlines() if line.startswith("{")))
    assert Path(ran["cwd"]) == trainer.parent
    assert Path(ran["python"]).resolve() == Path(sys.executable).resolve()


def test_train_needs_gsplat_s_checkout_named(tmp_path, bin_dir):
    (tmp_path / "room" / "sparse" / "0").mkdir(parents=True)
    code, out = run_cli("train", tmp_path / "room")
    assert code == 1
    assert "SPLAT_GSPLAT is not set" in out


# ------------------------------------------------------------------------------------- export


@pytest.mark.parametrize("steps, last", [((6999, 9999), 9999), ((6999, 29999), 29999)],
                         ids=["by number, not the name's first", "by number, not the name's last"])
def test_export_takes_the_ply_of_the_last_step(tmp_path, bin_dir, steps, last):
    tool = install(bin_dir, "splat-transform", splat_transform(sm.SPLAT_TRANSFORM_VERSION))
    results = tmp_path / "room" / "results" / "mcmc"
    (results / "ply").mkdir(parents=True)
    for step in steps:
        (results / "ply" / f"point_cloud_{step}.ply").write_text(f"step {step}")
    code, out = run_cli("export", tmp_path / "room")
    assert code == 0, out
    ply = str(results / "ply" / f"point_cloud_{last}.ply")
    assert runs(tool) == [["-w", ply, str(results / "room.sog")],
                          ["-w", ply, str(results / "room_viewer.html")]]
    assert (results / "room.sog").read_text() == f"step {last}"


def test_export_with_nothing_trained_says_so(tmp_path, bin_dir):
    install(bin_dir, "splat-transform", splat_transform(sm.SPLAT_TRANSFORM_VERSION))
    code, out = run_cli("export", tmp_path / "room", "--name", "other")
    assert code == 1
    assert "Run `train` first" in out
