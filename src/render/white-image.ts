import type { ImageSource } from './effect-material';

/**
 * `$whiteimage`: `tr.whiteImage`, solid white, which Q3 binds where a stage names it
 * (`tr_image.c:1232-1234`, `tr_shader.c:622-625`).
 */

/** Where the white image is read from: a name no pak can hold. */
export const WHITE_IMAGE_PATH = '*white.tga';

/** A TGA of one white texel, uncompressed, with eight bits of alpha. */
export function whiteImageTga(): Uint8Array {
  const bytes = new Uint8Array(18 + 4).fill(255, 18);
  bytes[2] = 2;
  bytes[12] = 1;
  bytes[14] = 1;
  bytes[16] = 32;
  bytes[17] = 0x28;
  return bytes;
}

/** `images`, with `$whiteimage` read from it as the white image, its name in any case. */
export function withWhiteImage(images: ImageSource): ImageSource {
  return {
    resolveImage: (reference) =>
      reference.toLowerCase() === '$whiteimage'
        ? WHITE_IMAGE_PATH
        : images.resolveImage(reference),
    read: (path) => (path === WHITE_IMAGE_PATH ? whiteImageTga() : images.read(path))
  };
}
