"""Splats written as splat-transform writes a PLY, from what a test states in Q3 units. Their
quaternions are unrotated but not of unit length, as a trained splat's need not be."""

import numpy as np

import splatlib as sl
from splat_maps import splat_map as sm

COLUMNS = ["x", "y", "z", "rot_0", "rot_1", "rot_2", "rot_3", "scale_0", "scale_1", "scale_2",
           "opacity", "f_dc_0", "f_dc_1", "f_dc_2"]


def write(path, centres, axes=5.0, opacity=0.99, colour=(0.5, 0.5, 0.5), extra=None):
    """A PLY of unrotated splats: `centres` in Q3 units, each axis `axes` units (one number, or one
    per splat), `opacity` and `colour` one each or one per splat, and `extra` columns by name."""
    n = len(centres)
    world = np.array([sm.sim_to_world(c) for c in centres], np.float64).reshape(n, 3)
    axes = np.asarray(axes, float)
    axes = np.broadcast_to(axes[:, None] if axes.ndim == 1 else axes, (n, 3))
    opacity = np.broadcast_to(np.asarray(opacity, float), (n,))
    colour = np.broadcast_to(np.asarray(colour, float), (n, 3))
    data = np.column_stack([
        world, np.full(n, 2.0), np.zeros((n, 3)), np.log(axes / sm.UNITS_PER_METRE),
        np.log(opacity / (1 - opacity)), (colour - 0.5) / sl.SH_C0,
    ])
    names = list(COLUMNS)
    for name, values in (extra or {}).items():
        names.append(name)
        data = np.column_stack([data, np.asarray(values, float)])
    sl.write_ply(path, names, data)
    return path
