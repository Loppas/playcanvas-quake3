import { zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { memorySource } from './byte-source';
import { PakFileSystem, searchPath } from './vfs';
import { ZipArchive } from './zip';

const encode = (s: string) => new TextEncoder().encode(s);
const decode = (b: Uint8Array | undefined) => (b ? new TextDecoder().decode(b) : undefined);

function archive(label: string, files: Record<string, string>): Promise<ZipArchive> {
  const entries: Record<string, Uint8Array> = {};
  for (const [name, body] of Object.entries(files)) entries[name] = encode(body);
  return ZipArchive.open(memorySource(label, zipSync(entries)));
}

/** pak0 plus a point release that patches one file and adds another — the vanilla shape. */
async function twoPakFileSystem(): Promise<PakFileSystem> {
  const fs = new PakFileSystem();
  fs.mount(
    await archive('pak0.pk3', {
      'scripts/gfx.shader': 'from pak0',
      'models/weapons2/rocketl/rocketl.md3': 'rocket from pak0',
      'icons/iconw_rocket.tga': 'icon tga',
      'sound/weapons/rocket/rocklf1a.wav': 'wav'
    })
  );
  fs.mount(
    await archive('pak8.pk3', { 'scripts/gfx.shader': 'from pak8', 'scripts/new.shader': 'added' })
  );
  return fs;
}

describe('searchPath', () => {
  it("puts each layer's archives over the ones before, so the last layer wins", async () => {
    const maps = new PakFileSystem();
    maps.mount(await archive('map-garage.pk3', { 'maps/garage.ent': 'the map', 'x.txt': 'map' }));
    const paks = await twoPakFileSystem();
    paks.mount(await archive('zz-patch.pk3', { 'x.txt': 'patch' }));

    const fs = searchPath([maps, undefined, paks]);
    expect(fs.mounted.map((pak) => pak.label)).toEqual([
      'map-garage.pk3',
      'pak0.pk3',
      'pak8.pk3',
      'zz-patch.pk3'
    ]);
    expect(decode(await fs.read('maps/garage.ent'))).toBe('the map');
    expect(decode(await fs.read('x.txt'))).toBe('patch');
    // The layers themselves are left as they were.
    expect(maps.mounted).toHaveLength(1);
    expect(searchPath([]).mounted).toEqual([]);
  });
});

describe('PakFileSystem', () => {
  it('resolves a file from the only archive holding it', async () => {
    const fs = await twoPakFileSystem();
    expect(decode(await fs.read('models/weapons2/rocketl/rocketl.md3'))).toBe('rocket from pak0');
  });

  it('lets the later-mounted pak override an earlier one', async () => {
    const fs = await twoPakFileSystem();
    expect(decode(await fs.read('scripts/gfx.shader'))).toBe('from pak8');
    expect(fs.sourceOf('scripts/gfx.shader')?.label).toBe('pak8.pk3');
  });

  it('keeps files the later pak does not replace', async () => {
    const fs = await twoPakFileSystem();
    expect(fs.sourceOf('models/weapons2/rocketl/rocketl.md3')?.label).toBe('pak0.pk3');
    expect(decode(await fs.read('scripts/new.shader'))).toBe('added');
  });

  it('counts distinct paths, not entries across archives', async () => {
    // 4 in pak0 + 1 new in pak8; the overridden shader is one path, not two.
    expect((await twoPakFileSystem()).size).toBe(5);
  });

  it('matches lookups case-insensitively', async () => {
    expect((await twoPakFileSystem()).has('Models/Weapons2/RocketL/RocketL.md3')).toBe(true);
  });

  it('reads nothing for a path no archive holds', async () => {
    expect(await (await twoPakFileSystem()).read('models/weapons2/nail/nail.md3')).toBeUndefined();
  });

  it('names the mounted archives when a required file is missing', async () => {
    const fs = await twoPakFileSystem();
    await expect(fs.readRequired('models/weapons2/nail/nail.md3')).rejects.toThrow(
      /not found in mounted archives: pak0\.pk3, pak8\.pk3/
    );
    expect(decode(await fs.readRequired('scripts/new.shader'))).toBe('added');
  });

  it('decodes text files', async () => {
    const fs = await twoPakFileSystem();
    expect(await fs.readText('scripts/gfx.shader')).toBe('from pak8');
    expect(await fs.readText('scripts/none.shader')).toBeUndefined();
  });

  it('lists by prefix and extension, sorted', async () => {
    expect((await twoPakFileSystem()).list('scripts/', 'shader')).toEqual([
      'scripts/gfx.shader',
      'scripts/new.shader'
    ]);
  });

  it('lists in ioq3 search order: the top pak first, each in its own order, each name once', async () => {
    // `FS_ListFilteredFiles`: pak8 before pak0, each pak's entries as its directory holds them,
    // and the overridden gfx.shader only where pak8, which answers for it, lists it.
    const fs = new PakFileSystem();
    fs.mount(await archive('pak0.pk3', { 'scripts/zz.shader': '', 'scripts/gfx.shader': '' }));
    fs.mount(await archive('pak8.pk3', { 'scripts/new.shader': '', 'scripts/gfx.shader': '' }));
    expect(fs.listInSearchOrder('scripts/', 'shader')).toEqual([
      'scripts/new.shader',
      'scripts/gfx.shader',
      'scripts/zz.shader'
    ]);
  });

  describe('getFileList', () => {
    it("lists a folder's names in search order, the folder taken off", async () => {
      const fs = new PakFileSystem();
      fs.mount(await archive('pak0.pk3', { 'scripts/b.arena': '', 'scripts/arenas.txt': '' }));
      fs.mount(await archive('pak6.pk3', { 'scripts/a.ARENA': '', 'maps/a.arena': '' }));
      expect(fs.getFileList('scripts', '.arena', 1024)).toEqual(['a.arena', 'b.arena']);
      expect(fs.getFileList('scripts/', '.arena', 1024)).toEqual(['a.arena', 'b.arena']);
    });

    it("stops at the first name the caller's buffer has no room for", async () => {
      const fs = new PakFileSystem();
      fs.mount(await archive('pak0.pk3', { 'scripts/abc.arena': '', 'scripts/de.arena': '' }));
      // Each name takes its length and a NUL, 10 and 9, and the list one NUL more, so both need
      // a buffer over 20 bytes, and the first alone one over 11.
      expect(fs.getFileList('scripts', '.arena', 21)).toEqual(['abc.arena', 'de.arena']);
      expect(fs.getFileList('scripts', '.arena', 20)).toEqual(['abc.arena']);
      expect(fs.getFileList('scripts', '.arena', 11)).toEqual([]);
    });
  });

  describe('resolveImage', () => {
    it('takes an exact hit as-is', async () => {
      expect((await twoPakFileSystem()).resolveImage('icons/iconw_rocket.tga')).toBe(
        'icons/iconw_rocket.tga'
      );
    });

    it('falls back through the image extensions, as R_FindShader does', async () => {
      // Shader scripts routinely name a .tga that only ships as .jpg, and MD3 surfaces name
      // textures with no extension at all.
      const fs = new PakFileSystem();
      fs.mount(await archive('pak0.pk3', { 'textures/sfx/flame.jpg': 'jpeg bytes' }));
      expect(fs.resolveImage('textures/sfx/flame.tga')).toBe('textures/sfx/flame.jpg');
      expect(fs.resolveImage('textures/sfx/flame')).toBe('textures/sfx/flame.jpg');
    });

    it('returns undefined when no variant exists', async () => {
      expect((await twoPakFileSystem()).resolveImage('textures/none/missing')).toBeUndefined();
    });
  });
});
