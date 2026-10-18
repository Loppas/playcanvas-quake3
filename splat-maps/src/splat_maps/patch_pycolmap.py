"""Patch the (rmbrualla) pycolmap fork bundled with gsplat's examples so it works on
Windows + Python 3. Two latent bugs that only bite on Windows/Py3:

  1) scene_manager.py reads uint64 counts with native 'L' (4 bytes on Windows, 8 on Linux)
     -> force 'Q'; and the camera header 'IiLL' -> explicit little-endian '<IiQQ'.
  2) camera.py slices a Python-3 map() object (a Py2-ism) -> coerce params to list.

Idempotent: safe to run repeatedly (reports "already patched" once applied).
Run with the gsplat env python:  python -m splat_maps.patch_pycolmap
"""
import importlib.util
import os
import sys


def find_pycolmap():
    spec = importlib.util.find_spec("pycolmap")
    if not spec or not spec.origin:
        sys.exit("ERROR: pycolmap not found in this environment.")
    return os.path.dirname(spec.origin)


def patch(path, replacements):
    with open(path, "r", encoding="utf-8") as f:
        src = f.read()
    n = 0
    for old, new in replacements:
        if old in src:
            src = src.replace(old, new)
            n += 1
    if n:
        with open(path, "w", encoding="utf-8") as f:
            f.write(src)
    return n


def main():
    pkg = find_pycolmap()

    # 1) binary loaders: platform-dependent 'L' -> 'Q', and 'IiLL' -> '<IiQQ'
    n1 = patch(os.path.join(pkg, "scene_manager.py"), [
        ("struct.unpack('L', f.read(8))", "struct.unpack('Q', f.read(8))"),
        ("struct.unpack('IiLL', f.read(24))", "struct.unpack('<IiQQ', f.read(24))"),
    ])
    print(f"scene_manager.py: {'patched' if n1 else 'already patched'} ({n1} pattern(s))")

    # 2) camera.py: coerce map() -> list at the top of Camera.__init__
    cam = os.path.join(pkg, "camera.py")
    with open(cam, "r", encoding="utf-8") as f:
        csrc = f.read()
    if "params = list(params)" in csrc:
        print("camera.py: already patched")
    else:
        anchor = ("    def __init__(self, type_, width_, height_, params):\n"
                  "        self.width = width_\n"
                  "        self.height = height_\n")
        if anchor in csrc:
            csrc = csrc.replace(
                anchor,
                anchor + "        params = list(params)  # Win/Py3 fix: map() -> subscriptable\n",
            )
            with open(cam, "w", encoding="utf-8") as f:
                f.write(csrc)
            print("camera.py: patched")
        else:
            print("camera.py: WARNING anchor not found - patch manually (params = list(params))")


if __name__ == "__main__":
    main()
