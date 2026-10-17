import { describe, expect, it } from 'vitest';

import { mipMap, resampleTexture, upload32Image } from './image-scale';
import type { DecodedImage } from './tga';

/** An image whose texels are these reds, row by row; green, blue and alpha 0. */
function reds(width: number, height: number, values: number[]): DecodedImage {
  const pixels = new Uint8ClampedArray(width * height * 4);
  values.forEach((value, i) => (pixels[i * 4] = value));
  return { width, height, pixels };
}

/** An image's reds, row by row. */
function redsOf(image: DecodedImage): number[] {
  return Array.from({ length: image.width * image.height }, (_, i) => image.pixels[i * 4]);
}

describe('resampleTexture', () => {
  it('takes four taps a quarter and three quarters across, truncating their mean', () => {
    // 3 wide to 2: the taps fall on columns 0 and 1, then 1 and 2, of the one row each way.
    const out = resampleTexture(reds(3, 2, [10, 20, 31, 40, 50, 61]), 2, 2);
    expect(redsOf(out)).toEqual([15, 25, 45, 55]);
  });

  it('picks its rows a quarter and three quarters down each output row', () => {
    // 1 wide, 3 tall to 2 tall: row 0 takes rows 0 and 1, row 1 takes rows 1 and 2.
    const out = resampleTexture(reds(1, 3, [0, 100, 201]), 1, 2);
    expect(redsOf(out)).toEqual([50, 150]);
  });
});

describe('mipMap', () => {
  it('averages each 2×2 box, truncating', () => {
    const out = mipMap(reds(4, 2, [1, 2, 3, 4, 5, 6, 7, 9]));
    expect([out.width, out.height]).toEqual([2, 1]);
    // (1 + 2 + 5 + 6) / 4 and (3 + 4 + 7 + 9) / 4 = 5.75.
    expect(redsOf(out)).toEqual([3, 5]);
  });

  it('averages pairs once a side is one texel', () => {
    const tall = mipMap(reds(1, 4, [10, 21, 30, 40]));
    expect([tall.width, tall.height]).toEqual([1, 2]);
    expect(redsOf(tall)).toEqual([15, 35]);
    const wide = mipMap(reds(2, 1, [7, 10]));
    expect([wide.width, wide.height]).toEqual([1, 1]);
    expect(redsOf(wide)).toEqual([8]);
  });

  it('leaves a single texel as it is', () => {
    const one = reds(1, 1, [9]);
    expect(mipMap(one)).toBe(one);
  });
});

describe('upload32Image', () => {
  it('leaves a power-of-two image as it is at picmip 0', () => {
    const image = reds(4, 2, [1, 2, 3, 4, 5, 6, 7, 8]);
    expect(upload32Image(image, 0)).toBe(image);
  });

  it('rounds a side that is not a power of two down, as r_roundImagesDown does', () => {
    // q3dm9's 226×226 textures upload at 128×128, q3dm1's 66×640 at 64×512.
    const out = upload32Image(reds(3, 2, [10, 20, 31, 40, 50, 61]), 0);
    expect([out.width, out.height]).toEqual([2, 2]);
    expect(redsOf(out)).toEqual([15, 25, 45, 55]);
    const column = upload32Image(reds(66, 640, []), 0);
    expect([column.width, column.height]).toEqual([64, 512]);
  });

  it('halves each side per picmip level, never below one texel', () => {
    const image = reds(4, 2, [1, 2, 3, 4, 5, 6, 7, 9]);
    const half = upload32Image(image, 1);
    expect([half.width, half.height]).toEqual([2, 1]);
    expect(redsOf(half)).toEqual([3, 5]);
    // 4×2 at picmip 3: 4×2 to 2×1, then the pair to 1×1.
    const least = upload32Image(image, 3);
    expect([least.width, least.height]).toEqual([1, 1]);
    expect(redsOf(least)).toEqual([4]);
  });
});
