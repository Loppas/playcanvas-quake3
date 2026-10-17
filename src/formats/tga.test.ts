import { describe, expect, it } from 'vitest';
import { havePak0, openPak } from '../pak/pak-test-fixtures';
import { decodeTga } from './tga';

/**
 * Build a TGA header. `type` 2 is uncompressed true colour, 10 is RLE true colour, 3 is
 * grayscale; `descriptor` bit 5 marks a top-left origin.
 */
function header(options: {
  type: number;
  width: number;
  height: number;
  bpp: number;
  descriptor?: number;
}): number[] {
  const { type, width, height, bpp, descriptor = 0 } = options;
  return [
    0, 0, type, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    width & 0xff, width >> 8,
    height & 0xff, height >> 8,
    bpp, descriptor
  ];
}

describe('decodeTga', () => {
  it('decodes uncompressed 24-bit BGR as RGBA', () => {
    // One row, two pixels, stored BGR: pure red then pure blue.
    const bytes = new Uint8Array([
      ...header({ type: 2, width: 2, height: 1, bpp: 24, descriptor: 0x20 }),
      0, 0, 255,
      255, 0, 0
    ]);
    const image = decodeTga(bytes);
    expect(image.width).toBe(2);
    expect(image.height).toBe(1);
    expect([...image.pixels]).toEqual([255, 0, 0, 255, 0, 0, 255, 255]);
  });

  it('keeps the alpha channel of a 32-bit image', () => {
    const bytes = new Uint8Array([
      ...header({ type: 2, width: 1, height: 1, bpp: 32, descriptor: 0x20 }),
      10, 20, 30, 40
    ]);
    expect([...decodeTga(bytes).pixels]).toEqual([30, 20, 10, 40]);
  });

  it('flips bottom-origin images, which is most of them', () => {
    // Two rows stored bottom-up: the stored first row is the image's bottom row.
    const bytes = new Uint8Array([
      ...header({ type: 2, width: 1, height: 2, bpp: 24 }),
      0, 0, 1, // bottom row: R=1
      0, 0, 2 // top row: R=2
    ]);
    const pixels = decodeTga(bytes).pixels;
    expect(pixels[0]).toBe(2);
    expect(pixels[4]).toBe(1);
  });

  it('leaves top-origin images alone', () => {
    const bytes = new Uint8Array([
      ...header({ type: 2, width: 1, height: 2, bpp: 24, descriptor: 0x20 }),
      0, 0, 1,
      0, 0, 2
    ]);
    expect(decodeTga(bytes).pixels[0]).toBe(1);
  });

  it('expands RLE run packets', () => {
    // High bit set, count-1 = 3, so one BGR triple repeats four times.
    const bytes = new Uint8Array([
      ...header({ type: 10, width: 4, height: 1, bpp: 24, descriptor: 0x20 }),
      0x83, 7, 8, 9
    ]);
    const pixels = decodeTga(bytes).pixels;
    expect([...pixels]).toEqual([9, 8, 7, 255, 9, 8, 7, 255, 9, 8, 7, 255, 9, 8, 7, 255]);
  });

  it('copies RLE literal packets', () => {
    // High bit clear, count-1 = 1, so two distinct pixels follow.
    const bytes = new Uint8Array([
      ...header({ type: 10, width: 2, height: 1, bpp: 24, descriptor: 0x20 }),
      0x01, 1, 2, 3, 4, 5, 6
    ]);
    expect([...decodeTga(bytes).pixels]).toEqual([3, 2, 1, 255, 6, 5, 4, 255]);
  });

  it('handles a run and a literal in the same image', () => {
    const bytes = new Uint8Array([
      ...header({ type: 10, width: 3, height: 1, bpp: 32, descriptor: 0x20 }),
      0x81, 1, 1, 1, 1, // run of 2
      0x00, 9, 9, 9, 9 // literal of 1
    ]);
    const pixels = decodeTga(bytes).pixels;
    expect([...pixels.slice(0, 4)]).toEqual([1, 1, 1, 1]);
    expect([...pixels.slice(8, 12)]).toEqual([9, 9, 9, 9]);
  });

  it('expands grayscale to opaque RGB', () => {
    const bytes = new Uint8Array([
      ...header({ type: 3, width: 2, height: 1, bpp: 8, descriptor: 0x20 }),
      64, 200
    ]);
    expect([...decodeTga(bytes).pixels]).toEqual([64, 64, 64, 255, 200, 200, 200, 255]);
  });

  it('skips the image id field when one is present', () => {
    const bytes = new Uint8Array([
      ...header({ type: 2, width: 1, height: 1, bpp: 24, descriptor: 0x20 }),
      0, 0, 255
    ]);
    bytes[0] = 3; // idLength
    const withId = new Uint8Array([...bytes.slice(0, 18), 65, 66, 67, ...bytes.slice(18)]);
    expect([...decodeTga(withId).pixels]).toEqual([255, 0, 0, 255]);
  });

  it('rejects colour-mapped files rather than decoding garbage', () => {
    const bytes = new Uint8Array(header({ type: 1, width: 1, height: 1, bpp: 8 }));
    expect(() => decodeTga(bytes)).toThrow(/colour-mapped/);
  });

  it('rejects truncated pixel data', () => {
    const bytes = new Uint8Array([...header({ type: 2, width: 8, height: 8, bpp: 24 }), 1, 2, 3]);
    expect(() => decodeTga(bytes)).toThrow(/truncated/);
  });

  it('rejects an RLE stream that overruns the image', () => {
    const bytes = new Uint8Array([
      ...header({ type: 10, width: 2, height: 1, bpp: 24, descriptor: 0x20 }),
      0x8f, 1, 2, 3 // claims 16 pixels for a 2-pixel image
    ]);
    expect(() => decodeTga(bytes)).toThrow(/overruns/);
  });
});

// Guarded against the user's install — measured, then pinned.
describe.skipIf(!havePak0)('decodeTga against retail pak0.pk3', () => {
  it('decodes a weapon icon', async () => {
    const pak0 = await openPak('pak0.pk3');
    const icon = decodeTga((await pak0.read('icons/iconw_rocket.tga'))!, 'iconw_rocket');
    expect([icon.width, icon.height]).toEqual([32, 32]);
    expect(icon.pixels.length).toBe(32 * 32 * 4);
    // Top-left pixel is transparent red — the icons are 32-bit with a cut-out background.
    expect([...icon.pixels.slice(0, 4)]).toEqual([255, 1, 1, 0]);
  });

  it('decodes every TGA in the pak, including the RLE ones', async () => {
    // 720 files: 575 uncompressed 32-bit, 143 uncompressed 24-bit, 2 RLE 32-bit. The RLE
    // path is rare enough in the data that only a sweep like this exercises it for real.
    const pak0 = await openPak('pak0.pk3');
    const names = pak0.names().filter((n) => n.endsWith('.tga'));
    expect(names.length).toBe(720);

    const kinds = new Map<string, number>();
    for (const name of names) {
      const bytes = (await pak0.read(name))!;
      kinds.set(`${bytes[2]}/${bytes[16]}`, (kinds.get(`${bytes[2]}/${bytes[16]}`) ?? 0) + 1);
      const image = decodeTga(bytes, name);
      expect(image.pixels.length, name).toBe(image.width * image.height * 4);
    }
    expect(Object.fromEntries(kinds)).toEqual({ '2/32': 575, '2/24': 143, '10/32': 2 });
  });
});
