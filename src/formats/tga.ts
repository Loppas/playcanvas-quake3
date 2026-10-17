/**
 * TGA decoder for pak textures (`renderer/tr_image.c`, `LoadTGA`).
 *
 * Vanilla Quake 3 ships `.tga` and `.jpg` only. JPEGs the browser decodes natively through
 * `createImageBitmap`, so this is the one image format we have to read ourselves — id used
 * TGA for anything needing an alpha channel, which is most weapon skins and every effect
 * sprite.
 *
 * Supports the two types the game data actually contains: uncompressed and RLE true-colour
 * (24/32-bit), plus 8-bit grayscale, which a handful of shaders use as masks. Output is
 * always RGBA8 in top-to-bottom row order, ready for `ImageData` or a GPU upload.
 */

/** Uncompressed colour-mapped (palette) — refused; no vanilla weapon asset uses it. */
const TYPE_COLOR_MAPPED = 1;
const TYPE_TRUE_COLOR = 2;
const TYPE_GRAYSCALE = 3;
const TYPE_RLE_TRUE_COLOR = 10;
const TYPE_RLE_GRAYSCALE = 11;

/** Bit 5 of the image descriptor: set means the first row stored is the top row. */
const DESCRIPTOR_TOP_ORIGIN = 0x20;

/** A decoded image, in the layout `ImageData` and WebGL both expect. */
export interface DecodedImage {
  width: number;
  height: number;
  /** `width * height * 4` bytes, RGBA, first row is the top of the image. */
  pixels: Uint8ClampedArray;
}

/**
 * Decode a TGA.
 *
 * @param bytes file contents
 * @param label path, used in error messages
 */
export function decodeTga(bytes: Uint8Array, label = 'tga'): DecodedImage {
  if (bytes.byteLength < 18) throw new Error(`${label}: too short to be a TGA`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const idLength = bytes[0];
  const colorMapType = bytes[1];
  const imageType = bytes[2];
  const width = view.getUint16(12, true);
  const height = view.getUint16(14, true);
  const bitsPerPixel = bytes[16];
  const descriptor = bytes[17];

  if (imageType === TYPE_COLOR_MAPPED || colorMapType !== 0) {
    throw new Error(`${label}: colour-mapped TGAs are not supported`);
  }
  const rle = imageType === TYPE_RLE_TRUE_COLOR || imageType === TYPE_RLE_GRAYSCALE;
  const grayscale = imageType === TYPE_GRAYSCALE || imageType === TYPE_RLE_GRAYSCALE;
  if (imageType !== TYPE_TRUE_COLOR && imageType !== TYPE_RLE_TRUE_COLOR && !grayscale) {
    throw new Error(`${label}: unsupported TGA image type ${imageType}`);
  }
  if (bitsPerPixel !== 8 && bitsPerPixel !== 24 && bitsPerPixel !== 32) {
    throw new Error(`${label}: unsupported TGA depth ${bitsPerPixel}`);
  }
  if (width === 0 || height === 0) throw new Error(`${label}: TGA has zero extent`);

  const bytesPerPixel = bitsPerPixel / 8;
  const pixelCount = width * height;
  const pixels = new Uint8ClampedArray(pixelCount * 4);

  let at = 18 + idLength;

  /** Write one source pixel, converting BGR(A)/gray to RGBA. */
  const emit = (target: number, source: number) => {
    if (grayscale) {
      const value = bytes[source];
      pixels[target] = value;
      pixels[target + 1] = value;
      pixels[target + 2] = value;
      pixels[target + 3] = 255;
      return;
    }
    // TGA stores true colour as BGR(A).
    pixels[target] = bytes[source + 2];
    pixels[target + 1] = bytes[source + 1];
    pixels[target + 2] = bytes[source];
    pixels[target + 3] = bytesPerPixel === 4 ? bytes[source + 3] : 255;
  };

  if (!rle) {
    if (at + pixelCount * bytesPerPixel > bytes.byteLength) {
      throw new Error(`${label}: TGA pixel data is truncated`);
    }
    for (let i = 0; i < pixelCount; i++) emit(i * 4, at + i * bytesPerPixel);
  } else {
    let written = 0;
    while (written < pixelCount) {
      if (at >= bytes.byteLength) throw new Error(`${label}: TGA RLE data is truncated`);
      const packet = bytes[at++];
      // The low 7 bits are "count - 1"; the high bit distinguishes a run from a literal.
      const count = (packet & 0x7f) + 1;
      if (written + count > pixelCount) throw new Error(`${label}: TGA RLE overruns the image`);

      if (packet & 0x80) {
        for (let i = 0; i < count; i++) emit((written + i) * 4, at);
        at += bytesPerPixel;
      } else {
        for (let i = 0; i < count; i++) emit((written + i) * 4, at + i * bytesPerPixel);
        at += count * bytesPerPixel;
      }
      written += count;
    }
  }

  // TGA's default origin is bottom-left, so most files need flipping to get a top-down image.
  if ((descriptor & DESCRIPTOR_TOP_ORIGIN) === 0) flipVertically(pixels, width, height);

  return { width, height, pixels };
}

/** Reverse row order in place. */
function flipVertically(pixels: Uint8ClampedArray, width: number, height: number): void {
  const stride = width * 4;
  const row = new Uint8ClampedArray(stride);
  for (let y = 0; y < Math.floor(height / 2); y++) {
    const top = y * stride;
    const bottom = (height - 1 - y) * stride;
    row.set(pixels.subarray(top, top + stride));
    pixels.copyWithin(top, bottom, bottom + stride);
    pixels.set(row, bottom);
  }
}
