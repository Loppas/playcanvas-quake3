import { zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import { memorySource } from '../pak/byte-source';
import { PakFileSystem } from '../pak/vfs';
import { ZipArchive } from '../pak/zip';
import { bspPath, mapKind, mapNames, readBsp } from './map-kind';

/** A search path of one pak holding these files, each a byte. */
async function searchPathOf(...paths: string[]): Promise<PakFileSystem> {
  const fs = new PakFileSystem();
  const files = Object.fromEntries(paths.map((path) => [path, new Uint8Array(1)]));
  fs.mount(await ZipArchive.open(memorySource('maps-test.pk3', zipSync(files))));
  return fs;
}

describe('mapKind', () => {
  it('finds a splat map by its splat, a BSP by its BSP, and nothing for neither', async () => {
    const fs = await searchPathOf('maps/garage.sog', 'maps/q3dm1.bsp');
    expect(mapKind(fs, 'garage')).toBe('splat');
    expect(mapKind(fs, 'q3dm1')).toBe('bsp');
    expect(mapKind(fs, 'q3dm2')).toBeNull();
  });

  it('takes the splat where a map ships both, and any case of the name', async () => {
    const fs = await searchPathOf('maps/both.bsp', 'maps/both.sog');
    expect(mapKind(fs, 'both')).toBe('splat');
    expect(mapKind(fs, 'BOTH')).toBe('splat');
  });
});

describe('mapNames', () => {
  it('lists every splat and every BSP once, by name, in order', async () => {
    const fs = await searchPathOf(
      'maps/q3dm1.bsp',
      'maps/garage.sog',
      'maps/garage.voxel.json',
      'maps/both.sog',
      'maps/both.bsp',
      'maps/arena.bsp',
      'levelshots/q3dm2.jpg'
    );
    expect(mapNames(fs)).toEqual(['arena', 'both', 'garage', 'q3dm1']);
  });
});

describe('bspPath', () => {
  it("is where `SV_Map_f` looks for a map's BSP", () => {
    expect(bspPath('q3dm17')).toBe('maps/q3dm17.bsp');
  });
});

describe('readBsp', () => {
  it("reads a map's BSP whole, telling its progress", async () => {
    const file = Uint8Array.from({ length: 64 }, (_, i) => i);
    const fs = new PakFileSystem();
    const pak = zipSync({ 'maps/q3dm1.bsp': file });
    fs.mount(await ZipArchive.open(memorySource('maps-test.pk3', pak)));
    const heard: number[] = [];

    const bytes = await readBsp(fs, 'q3dm1', (received, total) => heard.push(received / total));

    expect(bytes).toEqual(file);
    expect(heard.at(-1)).toBe(1);
  });

  it("says a map it has not got in `CM_LoadMap`'s words", async () => {
    const fs = await searchPathOf('maps/garage.sog');
    await expect(readBsp(fs, 'garage')).rejects.toThrow("Couldn't load maps/garage.bsp");
  });
});
