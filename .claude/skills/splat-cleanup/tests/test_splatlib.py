"""The definitions the scripts share: the PLY, a splat's quantities in Q3 units, the camera, the
panorama's angles, and how a removal is found."""

import json

import numpy as np
import pytest

import splats
import splatlib as sl
from splat_maps import levelshot
from splat_maps import splat_map as sm


def flags(cmd):
    """A camera's flags as a dict, each value as given."""
    return dict(zip(cmd[::2], cmd[1::2]))


def numbers(text):
    return [float(c) for c in text.split(",")]


def test_a_ply_reads_back_as_written(tmp_path):
    data = np.arange(12, dtype=np.float32).reshape(4, 3)
    sl.write_ply(tmp_path / "a.ply", ["x", "y", "row"], data)
    names, back = sl.read_ply(tmp_path / "a.ply")
    assert names == ["x", "y", "row"]
    assert np.array_equal(back, data)


def test_a_ply_of_another_layout_is_refused(tmp_path):
    (tmp_path / "a.ply").write_bytes(b"ply\nformat ascii 1.0\nelement vertex 0\nproperty float x\nend_header\n")
    with pytest.raises(ValueError, match="not a binary little-endian PLY"):
        sl.read_ply(tmp_path / "a.ply")
    (tmp_path / "b.ply").write_bytes(b"ply\nformat binary_little_endian 1.0\nelement vertex 0\n"
                                     b"property uchar red\nend_header\n")
    with pytest.raises(ValueError, match="not a float"):
        sl.read_ply(tmp_path / "b.ply")


def test_a_splat_is_measured_in_q3_units(tmp_path):
    s = sl.Splat(splats.write(tmp_path / "s.ply", [(32, -96, 64)], axes=16, opacity=0.25, colour=(0.2, 0.4, 0.6)))
    assert np.allclose(s.pos(), [[32, -96, 64]], atol=1e-4)
    assert np.allclose(s.axes(), 16, atol=1e-4)
    assert np.allclose(s.opacity(), 0.25, atol=1e-6)
    assert np.allclose(s.colour(), [[0.2, 0.4, 0.6]], atol=1e-6)
    assert np.allclose(s.quat(), [[1, 0, 0, 0]])


def test_a_view_is_drawn_as_the_levelshot_draws_one():
    f = flags(sl.camera((32, 0, 64), (0, 0, 0)))
    assert float(f["--camera-fov"]) == pytest.approx(levelshot.FOV_Y)
    assert float(f["--camera-near"]) == levelshot.ZNEAR_UNITS / sm.UNITS_PER_METRE
    assert f["--resolution"] == "960x540"
    pos = numbers(f["--camera-pos"])
    assert pos == pytest.approx(sm.sim_to_octree((32, 0, 64)))
    # Facing +X, a unit ahead; up is the sim's +Z: both through the octree's frame.
    ahead = np.array(numbers(f["--camera-target"])) - pos
    assert ahead == pytest.approx(np.array(sm.sim_to_octree((1, 0, 0))) * sm.UNITS_PER_METRE)
    assert numbers(f["--camera-up"]) == pytest.approx(np.array(sm.sim_to_octree((0, 0, 1))) * sm.UNITS_PER_METRE)


def test_a_panorama_is_level():
    f = flags(sl.camera((0, 0, 0), (40, 90, 0), panorama=True))
    assert f["--projection"] == "equirect"
    assert f["--resolution"] == "1024x512"
    assert "--camera-fov" not in f
    level = flags(sl.camera((0, 0, 0), (0, 90, 0)))
    assert f["--camera-target"] == level["--camera-target"]


def test_a_panoramas_columns_are_yaws_and_its_rows_pitches():
    w, h = sl.PANORAMA_SIZE
    pitch, yaw = sl.panorama_angles(w / 2 - 0.5, h / 2 - 0.5, 30)
    assert (pitch, yaw) == pytest.approx((0, 30))
    assert sl.panorama_angles(w / 4 - 0.5, h / 2 - 0.5, 30)[1] == pytest.approx(120)
    assert sl.panorama_angles(0, 0, 0)[0] == pytest.approx(-90, abs=0.5)


def test_a_change_is_more_than_24_levels_in_a_channel():
    a = np.zeros((1, 3, 3), int)
    b = np.array([[[24, 0, 0], [0, 25, 0], [0, 0, 0]]])
    assert sl.changed(a, b).tolist() == [[False, True, False]]
    assert sl.background(np.array([[[3, 4, 4], [4, 4, 4]]])).tolist() == [[True, False]]


def test_removed_names_the_rows_a_filter_drops(tmp_path, splat_transform):
    ply = splats.write(tmp_path / "s.ply", [(k, 0, 0) for k in range(4)], extra={"row": range(4)})
    gone, _ = sl.removed(ply, 4, ["--filter-value", "row,gt,1"], tmp_path)
    assert gone.tolist() == [True, True, False, False]
    assert not (tmp_path / "_filtered.ply").exists()


def test_a_removal_is_a_try_before_a_census_column(tmp_path):
    s = sl.Splat(splats.write(tmp_path / "s.ply", [(0, 0, 0)] * 3, extra={"c_box": [1, 0, 0]}))
    assert sl.removal(s, tmp_path, "box").tolist() == [True, False, False]
    (tmp_path / "try").mkdir()
    np.save(tmp_path / "try" / "box.npy", np.array([False, False, True]))
    assert sl.removal(s, tmp_path, "box").tolist() == [False, False, True]
    with pytest.raises(ValueError, match="neither a try"):
        sl.removal(s, tmp_path, "cap")


def test_a_bake_with_no_box_is_refused(tmp_path):
    (tmp_path / "m.bake.json").write_text(json.dumps({"box_sim": None}))
    with pytest.raises(ValueError, match="records no box"):
        sl.bake_of(tmp_path / "m.sog")


def test_a_view_needs_an_eye_and_angles_of_three(tmp_path):
    (tmp_path / "v.json").write_text(json.dumps([{"name": "a", "eye": [0, 0], "angles": [0, 0, 0]}]))
    with pytest.raises(ValueError, match="view 'a'"):
        sl.load_views(tmp_path / "v.json")
