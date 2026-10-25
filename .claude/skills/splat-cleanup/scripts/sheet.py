"""Images tiled into one, each under its label, to show side by side.

    python sheet.py <out.png> [--cols 3] [--width 640] "label=path" ["label=path" ...]
"""

import argparse

from PIL import Image, ImageDraw


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("out")
    ap.add_argument("tiles", nargs="+")
    ap.add_argument("--cols", type=int, default=3)
    ap.add_argument("--width", type=int, default=640)
    args = ap.parse_args()
    tiles = [t.split("=", 1) for t in args.tiles]
    images = [Image.open(path).convert("RGB") for _, path in tiles]
    w = args.width
    h = max(round(im.height * w / im.width) for im in images)
    label = 20
    rows = (len(images) + args.cols - 1) // args.cols
    sheet = Image.new("RGB", (args.cols * w, rows * (h + label)), (24, 24, 24))
    draw = ImageDraw.Draw(sheet)
    for k, ((text, _), im) in enumerate(zip(tiles, images)):
        x, y = (k % args.cols) * w, (k // args.cols) * (h + label)
        sheet.paste(im.resize((w, round(im.height * w / im.width)), Image.LANCZOS), (x, y + label))
        draw.text((x + 4, y + 4), text, fill=(255, 230, 120))
    sheet.save(args.out)
    print(f"wrote {args.out}: {len(images)} tiles")


if __name__ == "__main__":
    main()
