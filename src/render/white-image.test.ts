import { describe, expect, it } from 'vitest';

import { decodeTga } from '../formats/tga';
import type { ImageSource } from './effect-material';
import { WHITE_IMAGE_PATH, whiteImageTga, withWhiteImage } from './white-image';

describe('withWhiteImage', () => {
  const images: ImageSource = {
    resolveImage: (reference) => (reference === 'skin' ? 'skin.tga' : undefined),
    read: (path) => (path === 'skin.tga' ? Uint8Array.of(1, 2, 3) : undefined)
  };

  it('reads `$whiteimage`, in any case, as one white texel', () => {
    const white = withWhiteImage(images);
    expect(white.resolveImage('$whiteimage')).toBe(WHITE_IMAGE_PATH);
    expect(white.resolveImage('$WhiteImage')).toBe(WHITE_IMAGE_PATH);
    const texel = decodeTga(white.read(WHITE_IMAGE_PATH) as Uint8Array);
    expect([texel.width, texel.height, [...texel.pixels]]).toEqual([1, 1, [255, 255, 255, 255]]);
    expect(whiteImageTga()).toEqual(white.read(WHITE_IMAGE_PATH));
  });

  it('reads every other image from the images it is given', () => {
    const white = withWhiteImage(images);
    expect(white.resolveImage('skin')).toBe('skin.tga');
    expect(white.read('skin.tga')).toEqual(Uint8Array.of(1, 2, 3));
    expect(white.resolveImage('$lightmap')).toBeUndefined();
    expect(white.resolveImage('missing')).toBeUndefined();
  });
});
