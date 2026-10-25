"""Splats composited over a patch of a view, front to back, as the rasteriser draws them."""

import numpy as np
import pytest

import attribute
import splats
import splatlib as sl

#: At the origin, facing +X: a splat on the X axis draws at the view's centre.
VIEW = {"name": "v", "eye": [0, 0, 0], "angles": [0, 0, 0]}
CENTRE = (470, 260, 490, 280)


def splat(tmp_path, centres, **kw):
    return sl.Splat(splats.write(tmp_path / "s.ply", centres, **kw))


def test_an_opaque_splat_ahead_covers_the_patch_in_its_colour(tmp_path):
    s = splat(tmp_path, [(100, 0, 0)], axes=10, colour=(0.8, 0.2, 0.1))
    cand, share, image, covered = attribute.composite(s, VIEW, CENTRE, np.ones(1, bool))
    assert cand.tolist() == [0]
    assert covered > 0.9
    assert image[10, 10] == pytest.approx([0.8 * 0.99, 0.2 * 0.99, 0.1 * 0.99], abs=0.02)


def test_the_nearer_splat_hides_the_farther_whatever_their_rows(tmp_path):
    s = splat(tmp_path, [(200, 0, 0), (100, 0, 0)], axes=[5, 10], colour=[(0, 0, 1), (1, 0, 0)])
    cand, share, image, _ = attribute.composite(s, VIEW, CENTRE, np.ones(2, bool))
    far, near = share[list(cand).index(0)], share[list(cand).index(1)]
    assert near > 10 * far
    assert image[10, 10, 0] > 0.9 and image[10, 10, 2] < 0.05


def test_a_splat_centred_past_the_guard_band_is_not_drawn(tmp_path):
    # Broad enough to reach the patch, but centred far below the frame.
    s = splat(tmp_path, [(100, 0, -400)], axes=300)
    cand, _, _, covered = attribute.composite(s, VIEW, CENTRE, np.ones(1, bool))
    assert len(cand) == 0 and covered == 0


def test_a_splat_left_out_draws_nothing(tmp_path):
    s = splat(tmp_path, [(100, 0, 0)])
    cand, _, _, covered = attribute.composite(s, VIEW, CENTRE, np.zeros(1, bool))
    assert len(cand) == 0 and covered == 0
