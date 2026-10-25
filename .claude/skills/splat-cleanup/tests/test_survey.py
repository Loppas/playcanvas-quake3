"""A survey view faces where a pose's panorama changed most."""

import numpy as np
import pytest

import splatlib as sl
import survey

POSE = {"name": "p000s", "eye": [8.0, 16.0, 58.0], "angles": [0.0, 0.0, 0.0]}
H, W = sl.PANORAMA_SIZE[1], sl.PANORAMA_SIZE[0]


def mask(rows, cols):
    m = np.zeros((H, W), bool)
    m[rows, cols] = True
    return m


def test_a_view_faces_the_yaw_where_most_changed():
    # A quarter of the way right of the centre column is yaw 270; the middle row is level.
    view = survey.facing(mask(slice(250, 262), slice(760, 776)) | mask(slice(250, 262), slice(100, 102)), POSE)
    assert view["eye"] == POSE["eye"]
    assert view["angles"][1] == pytest.approx(270, abs=2)
    assert view["angles"][0] == pytest.approx(0, abs=2)
    assert view["name"].startswith("p000s_y")


def test_a_change_across_the_panoramas_seam_counts_whole():
    # 16 columns split by the seam, against 12 in one piece at yaw 0.
    seam = mask(slice(250, 262), slice(0, 8)) | mask(slice(250, 262), slice(W - 8, W))
    view = survey.facing(seam | mask(slice(250, 262), slice(506, 518)), POSE)
    assert view["angles"][1] == pytest.approx(180, abs=2)


def test_a_view_of_the_floor_is_held_to_the_steepest_pitch():
    view = survey.facing(mask(slice(H - 30, H), slice(500, 524)), POSE)
    assert view["angles"][0] == survey.PITCH
