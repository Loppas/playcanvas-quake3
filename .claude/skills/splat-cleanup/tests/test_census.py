"""The standard filters, sized from the bake's record."""

import census


def test_the_standard_filters_take_the_bakes_box_seed_and_voxel():
    # vegetables_mice's bake: its _pcq_bake crops with --filter-box -11,-20,-8.5,12.5,1,7.5.
    bake = {"box_sim": [-400, -240, -32, 352, 272, 640], "seed_octree": [8.25, -2.40625, 4.25], "voxel_units": 8}
    filters = census.standard_filters(bake)
    assert filters["box"] == ["--filter-box", "-11,-20,-8.5,12.5,1,7.5"]
    assert filters["cluster"] == ["--seed-pos", "8.25,-2.40625,4.25", "--filter-cluster", "0.25,0.5,0.1"]
    assert filters["floaters"] == ["--filter-floaters", "0.05,0.5,0.1"]
