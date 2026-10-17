import type { DecodedImage } from './tga';

/**
 * An image's size and texels as opengl1 uploads them (`Upload32`, `tr_image.c:553-829`), which is
 * not always as the file holds them.
 *
 * Engine-free, like the decoders.
 */

/**
 * Resize an image with `ResampleTexture`'s four taps (`tr_image.c:300-338`): each texel the mean of
 * four of the source's, a quarter and three quarters of the way across its span each way, in whole
 * bytes. It only shrinks well by up to half.
 */
export function resampleTexture(image: DecodedImage, width: number, height: number): DecodedImage {
  const { pixels, width: inWidth, height: inHeight } = image;
  // Fixed point, 16 bits of fraction, as Q3's `unsigned` steps are.
  const step = Math.floor((inWidth * 0x10000) / width);
  const first = new Int32Array(width);
  const second = new Int32Array(width);
  let frac = step >>> 2;
  for (let i = 0; i < width; i++, frac += step) first[i] = 4 * (frac >>> 16);
  frac = 3 * (step >>> 2);
  for (let i = 0; i < width; i++, frac += step) second[i] = 4 * (frac >>> 16);

  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < height; i++) {
    const row = 4 * inWidth * Math.trunc(((i + 0.25) * inHeight) / height);
    const row2 = 4 * inWidth * Math.trunc(((i + 0.75) * inHeight) / height);
    for (let j = 0; j < width; j++) {
      for (let c = 0; c < 4; c++) {
        out[(i * width + j) * 4 + c] =
          (pixels[row + first[j] + c] +
            pixels[row + second[j] + c] +
            pixels[row2 + first[j] + c] +
            pixels[row2 + second[j] + c]) >>
          2;
      }
    }
  }
  return { width, height, pixels: out };
}

/**
 * Halve an image each way with `R_MipMap`, a 2×2 box in whole bytes, at `r_simpleMipMaps`' default
 * (`tr_image.c:462-500`). A side already at one texel stays there, and the other halves as a row.
 */
export function mipMap(image: DecodedImage): DecodedImage {
  const { pixels, width, height } = image;
  if (width === 1 && height === 1) return image;
  const halfWidth = width >> 1;
  const halfHeight = height >> 1;
  if (halfWidth === 0 || halfHeight === 0) {
    // A one-texel-wide image is a row in memory too: neighbours are averaged in pairs.
    const count = halfWidth + halfHeight;
    const out = new Uint8ClampedArray(count * 4);
    for (let i = 0; i < count * 4; i++) {
      const at = (i >> 2) * 8 + (i & 3);
      out[i] = (pixels[at] + pixels[at + 4]) >> 1;
    }
    return { width: Math.max(1, halfWidth), height: Math.max(1, halfHeight), pixels: out };
  }
  const out = new Uint8ClampedArray(halfWidth * halfHeight * 4);
  const row = width * 4;
  for (let i = 0; i < halfHeight; i++) {
    for (let j = 0; j < halfWidth; j++) {
      const at = i * 2 * row + j * 8;
      for (let c = 0; c < 4; c++) {
        out[(i * halfWidth + j) * 4 + c] =
          (pixels[at + c] + pixels[at + 4 + c] + pixels[at + row + c] + pixels[at + row + 4 + c]) >>
          2;
      }
    }
  }
  return { width: halfWidth, height: halfHeight, pixels: out };
}

/** The power of two at or below `side`, as `r_roundImagesDown`'s default rounds (`:574-581`). */
function roundDown(side: number): number {
  let scaled = 1;
  while (scaled < side) scaled <<= 1;
  return scaled > side ? scaled >> 1 : scaled;
}

/**
 * An image as `Upload32` makes it before it uploads: each side rounded down to a power of two and
 * resampled there, then `picmip` halvings, never below one texel (`tr_image.c:572-607, 757-770`).
 *
 * @param picmip - `r_picmip` for an image that takes it, else 0.
 */
export function upload32Image(image: DecodedImage, picmip: number): DecodedImage {
  let scaledWidth = roundDown(image.width);
  let scaledHeight = roundDown(image.height);
  let out =
    scaledWidth === image.width && scaledHeight === image.height
      ? image
      : resampleTexture(image, scaledWidth, scaledHeight);
  scaledWidth = Math.max(1, scaledWidth >> picmip);
  scaledHeight = Math.max(1, scaledHeight >> picmip);
  while (out.width > scaledWidth || out.height > scaledHeight) out = mipMap(out);
  return out;
}
