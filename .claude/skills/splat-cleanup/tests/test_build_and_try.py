"""A try's removal, and the splat built without the chosen removals, through splat-transform's
stand-in."""

import json
import sys
import zipfile

import numpy as np

import build_splat
import splats
import try_filter

CREDIT = b"Title: A Room\nAuthor: Someone\nSource: https://example.com/a-room\n"


def work_dir(tmp_path, n=6):
    """A work folder of `n` splats a metre apart along X, the census marking the first as `box`'s."""
    work = tmp_path / "work"
    (work / "try").mkdir(parents=True)
    splats.write(work / "cleanup.ply", [(32 * k, 0, 0) for k in range(n)],
                 extra={"row": range(n), "c_box": [1] + [0] * (n - 1)})
    source = tmp_path / "map.sog"
    with zipfile.ZipFile(source, "w") as z:
        z.writestr("meta.json", json.dumps({"count": n}))
        z.writestr("license.txt", CREDIT)
    (work / "census.json").write_text(json.dumps({"sog": str(source)}))
    (work / "views.json").write_text("[]")
    return work


def run(module, monkeypatch, *args):
    monkeypatch.setattr(sys, "argv", [module.__name__, *map(str, args)])
    module.main()


def test_a_try_counts_only_its_own_removals(tmp_path, splat_transform, monkeypatch):
    work = work_dir(tmp_path)
    # Keeps the file's x between 0.5 and 3.5 m: it would take rows 0, 4 and 5, but the box took 0.
    run(try_filter, monkeypatch, work, work / "views.json", "mid",
        "--filter-value x,gt,0.5 --filter-value x,lt,3.5", "--after", "box")
    assert np.load(work / "try" / "mid.npy").tolist() == [False, False, False, False, True, True]
    assert json.loads((work / "try" / "mid.json").read_text())["removes"] == 2
    # The actions ran on what the box left, as a chain runs them in order.
    assert [run["rows"] for run in splat_transform()] == [5]
    assert not list((work / "try").glob("*.ply"))


def test_a_region_confines_a_try(tmp_path, splat_transform, monkeypatch):
    work = work_dir(tmp_path)
    run(try_filter, monkeypatch, work, work / "views.json", "far",
        "--filter-value x,lt,3.5", "--after", "box", "--region=140,-100,-100,200,100,100")
    assert np.load(work / "try" / "far.npy").tolist() == [False] * 5 + [True]


def test_the_build_leaves_out_every_removal_and_keeps_the_credit(tmp_path, splat_transform, monkeypatch):
    work = work_dir(tmp_path)
    np.save(work / "try" / "cap.npy", np.array([False, False, True, False, False, False]))
    out = tmp_path / "test.sog"
    run(build_splat, monkeypatch, work, out, "box", "cap")
    with zipfile.ZipFile(out) as z:
        meta = json.loads(z.read("meta.json"))
        assert meta["count"] == 4
        assert "row" not in meta["names"] and not any(n.startswith("c_") for n in meta["names"])
        assert z.read("license.txt") == CREDIT
        assert z.getinfo("license.txt").compress_type == zipfile.ZIP_STORED
    assert not out.with_suffix(".ply").exists()
