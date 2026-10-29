import { zipSync } from 'fflate';
import { describe, expect, it, vi } from 'vitest';
import { openAssetCache, writeAssetCache } from '../pak/asset-cache';
import { blobSource, memorySource } from '../pak/byte-source';
import {
  bytesRead,
  countReads,
  havePak,
  memoryCacheStore,
  openPak
} from '../pak/pak-test-fixtures';
import { PakFileSystem } from '../pak/vfs';
import { EOCD_SEARCH_CHUNK, ZipArchive } from '../pak/zip';
import { infoValueForKey } from '../net/info';
import { BOT_LIST, BOTS_FILE } from '../sim/bots';
import { ITEMS } from '../sim/items';
import { ALL_WEAPONS } from '../sim/weapons/constants';
import { ARENAS_FILE, MENU_ARENA_LIST, loadArenas, readInfoFiles } from './arena';
import { shownMapName } from './arena-list';
import {
  AssetLibrary,
  cacheSubset,
  extractAssets,
  loadAssets,
  manifestVersion,
  type PakRoutes
} from './asset-library';
import {
  ANNOUNCER_SOUNDS,
  CUSTOM_SOUNDS,
  ITEM_ASSETS,
  MEDAL_SHADERS,
  MAX_PLAYERMODELS,
  PLAYER_PARTS,
  UNKNOWN_MAP,
  WEAPON_ASSETS,
  listPlayerModels,
  weaponModelPath
} from './asset-manifest';

const bytes = (text: string) => new TextEncoder().encode(text);

/** The browser's cache made from mounted paks, then mounted, as a later visit finds it. */
async function cacheOf(fs: PakFileSystem) {
  const store = memoryCacheStore();
  expect(await writeAssetCache(store, 'v', fs, await cacheSubset(fs))).toBeDefined();
  return { ...(await openAssetCache(store, 'v'))!, store };
}

describe('manifestVersion', () => {
  it('is stable across calls', () => {
    expect(manifestVersion()).toBe(manifestVersion());
  });

  it('is derived from the manifest, so editing it invalidates every cache', () => {
    // The guarantee that matters: the version is content-derived, not hand-maintained, so
    // a forgotten bump cannot serve a subset that lacks a newly added asset.
    expect(manifestVersion()).toMatch(/^v4-[0-9a-f]+$/);
  });

  it("changes with the announcer's voices", async () => {
    const before = manifestVersion();
    vi.resetModules();
    vi.doMock('./asset-manifest', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./asset-manifest')>();
      return {
        ...actual,
        ANNOUNCER_SOUNDS: { ...actual.ANNOUNCER_SOUNDS, extra: 'sound/feedback/extra.wav' }
      };
    });
    try {
      const { manifestVersion: after } = await import('./asset-library');
      expect(after()).not.toBe(before);
    } finally {
      vi.doUnmock('./asset-manifest');
      vi.resetModules();
    }
  });

  it("changes with what the skirmish pages read, so an older cache that lacks it isn't used", async () => {
    const before = manifestVersion();
    vi.resetModules();
    vi.doMock('./asset-manifest', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./asset-manifest')>();
      return { ...actual, MENU_FILES: { ...actual.MENU_FILES, levelshots: 'shots/' } };
    });
    try {
      const { manifestVersion: after } = await import('./asset-library');
      expect(after()).not.toBe(before);
    } finally {
      vi.doUnmock('./asset-manifest');
      vi.resetModules();
    }
  });
});

describe('AssetLibrary', () => {
  const library = new AssetLibrary(
    new Map([
      ['scripts/models.shader', bytes('models/weapons2/x/x { { map textures/real.jpg } }')],
      ['textures/real.jpg', bytes('jpeg')],
      ['models/weapons2/y/y.jpg', bytes('other')]
    ])
  );

  it('parses the shader scripts it was given', () => {
    expect(library.shader('models/weapons2/x/x')).toBeDefined();
    expect(library.shaderWarnings).toEqual([]);
  });

  it('leaves out a shader file whose braces do not match, keeping its warning to print', () => {
    const broken = new AssetLibrary(
      new Map([
        ['scripts/a.shader', bytes('models/a { { map a.jpg } }')],
        ['scripts/b.shader', bytes('models/b { { map b.jpg }')]
      ])
    );
    expect([broken.shader('models/a'), broken.shader('models/b')].map(Boolean)).toEqual([
      true,
      false
    ]);
    expect(broken.shaderWarnings).toEqual([
      'WARNING: Ignoring shader file scripts/b.shader. Shader "models/b" on line 1 missing ' +
        'closing brace.\n'
    ]);
  });

  it('resolves a surface texture through its shader', () => {
    expect(library.surfaceTexture('models/weapons2/x/x.tga')?.path).toBe('textures/real.jpg');
  });

  it('falls back to the extension search for a surface with no shader', () => {
    expect(library.surfaceTexture('models/weapons2/y/y.tga')?.path).toBe('models/weapons2/y/y.jpg');
  });

  it('reads case-insensitively', () => {
    expect(library.read('Textures/Real.JPG')).toBeDefined();
  });

  it('reports a helpful error for a model that was never extracted', () => {
    expect(() => library.model('models/weapons2/z/z.md3')).toThrow(/was not extracted/);
  });

  it('sums its own size', () => {
    let expected = 0;
    for (const file of library.files.values()) expected += file.byteLength;
    expect(library.byteLength).toBe(expected);
    expect(library.byteLength).toBeGreaterThan(0);
  });
});

describe('extractAssets', () => {
  it('reads only the entries the manifest names, each exactly once', async () => {
    const zip = zipSync({
      // Unrelated to the manifest, and far bigger than everything it names.
      'maps/q3dm17.bsp': [new Uint8Array(256 * 1024).fill(0x42), { level: 0 }],
      'scripts/weapons.shader': bytes('models/weapons2/rocketl/rocketl { { map textures/x.tga } }'),
      'models/weapons2/rocketl/rocketl.md3': bytes('not a parseable model'),
      'models/weapons2/rocketl/rocketl_hand.md3': bytes('tags only'),
      'icons/iconw_rocket.tga': bytes('icon'),
      'sound/weapons/rocket/rocklf1a.wav': bytes('RIFF'),
      'textures/base_wall/unrelated.tga': bytes('never asked for'),
      // Keeps the directory's read clear of the bsp.
      'pad.bin': [new Uint8Array(2 * EOCD_SEARCH_CHUNK), { level: 0 }]
    });
    const source = countReads(memorySource('pak0.pk3', zip));
    const archive = await ZipArchive.open(source);
    const fs = new PakFileSystem();
    fs.mount(archive);
    const read = vi.spyOn(fs, 'read');

    const library = await extractAssets(fs);

    const extracted = [...library.files.keys()].sort();
    expect(extracted).toEqual([
      'icons/iconw_rocket.tga',
      'models/weapons2/rocketl/rocketl.md3',
      'models/weapons2/rocketl/rocketl_hand.md3',
      'scripts/weapons.shader',
      'sound/weapons/rocket/rocklf1a.wav'
    ]);
    // The models are read while resolving the manifest and kept for the library, but read once.
    const asked = read.mock.calls.map(([path]) => path);
    expect(asked.sort()).toEqual(extracted);

    const bspStart = archive.entry('maps/q3dm17.bsp')!.localHeaderOffset;
    const bspEnd = archive.entry('scripts/weapons.shader')!.localHeaderOffset;
    for (const [offset, length] of source.reads) {
      expect(offset + length <= bspStart || offset >= bspEnd, `read ${offset}+${length}`).toBe(true);
    }
  });

  it('names each file it reads to work out the manifest, before it counts any', async () => {
    const zip = zipSync({
      'scripts/weapons.shader': bytes('models/weapons2/rocketl/rocketl { { map textures/x.tga } }'),
      'models/weapons2/rocketl/rocketl.md3': bytes('not a parseable model'),
      'icons/iconw_rocket.tga': bytes('icon')
    });
    const fs = new PakFileSystem();
    fs.mount(await ZipArchive.open(memorySource('pak0.pk3', zip)));
    const heard: string[] = [];

    await extractAssets(fs, {
      onLookup: (path) => heard.push(`lookup ${path}`),
      onRead: (done, total) => heard.push(`read ${done}/${total}`)
    });
    const firstRead = heard.findIndex((event) => event.startsWith('read'));
    expect(heard.slice(0, firstRead)).toEqual(
      expect.arrayContaining([
        'lookup scripts/weapons.shader',
        'lookup models/weapons2/rocketl/rocketl.md3'
      ])
    );
    // Reading the files the look-up found names nothing more.
    expect(heard.slice(firstRead).every((event) => event.startsWith('read'))).toBe(true);
  });

  it("counts each of the manifest's files in as it is read", async () => {
    const fs = new PakFileSystem();
    const pak0 = zipSync({
      'icons/iconw_rocket.tga': bytes('icon'),
      'sound/weapons/rocket/rocklf1a.wav': bytes('RIFF'),
      'textures/base_wall/unrelated.tga': bytes('never asked for')
    });
    fs.mount(await ZipArchive.open(memorySource('pak0.pk3', pak0)));
    const onRead = vi.fn();

    const library = await extractAssets(fs, { onRead });
    expect(onRead.mock.calls.map(([done, total]) => [done, total])).toEqual([
      [1, 2],
      [2, 2]
    ]);
    expect(onRead.mock.calls.map(([, , path]) => path).sort()).toEqual(
      [...library.files.keys()].sort()
    );
  });
});

describe('shader order', () => {
  /** Two paks on which the file-name rule and ioq3's order resolve two names differently. */
  async function paks(): Promise<PakFileSystem> {
    const fs = new PakFileSystem();
    const pak = (label: string, files: Record<string, string>) => {
      const entries = Object.entries(files).map(([name, text]) => [name, bytes(text)]);
      return ZipArchive.open(memorySource(label, zipSync(Object.fromEntries(entries))));
    };
    fs.mount(
      await pak('pak0.pk3', {
        'scripts/one.shader': 'shared { { map pak0.tga } }  inpak { { map one.tga } }',
        'scripts/two.shader': 'inpak { { map two.tga } }'
      })
    );
    fs.mount(await pak('pak1.pk3', { 'scripts/aaa.shader': 'shared { { map pak1.tga } }' }));
    return fs;
  }

  const firstMap = (library: AssetLibrary, name: string) =>
    library.shader(name)?.stages[0].maps[0];

  it('resolves a name defined in two scripts as ioq3 does', async () => {
    // ioq3 lists pak1's aaa, then pak0's one and two, and reads them in reverse. By file name,
    // aaa would come first and win `shared`, and one would win `inpak`.
    const library = await extractAssets(await paks());
    expect(library.shaderOrder).toEqual([
      'scripts/two.shader',
      'scripts/one.shader',
      'scripts/aaa.shader'
    ]);
    // Across paks the lower-priority pak's definition wins, and within one pak the later entry's.
    expect(firstMap(library, 'shared')).toBe('pak0.tga');
    expect(firstMap(library, 'inpak')).toBe('two.tga');
  });

  it('resolves the same way from the cache', async () => {
    const fs = await paks();
    const cache = await cacheOf(fs);
    const restored = await extractAssets(cache.fs, { playerModels: cache.info.playerModels });
    expect(restored.shaderOrder).toEqual((await extractAssets(fs)).shaderOrder);
    expect(firstMap(restored, 'shared')).toBe('pak0.tga');
    expect(firstMap(restored, 'inpak')).toBe('two.tga');
  });
});

/** A pak of text files, in the order given. */
const pakOf = (label: string, files: Record<string, string>) => {
  const entries = Object.entries(files).map(([name, text]) => [name, bytes(text)]);
  return ZipArchive.open(memorySource(label, zipSync(Object.fromEntries(entries))));
};

/**
 * A model's parts, `animation.cfg`, skins and icons. `skins` gives the texture each skin
 * draws, and `icons` the skins that have an icon: all of them unless said otherwise.
 */
const model = (name: string, skins: Record<string, string>, icons = Object.keys(skins)) => {
  const dir = `models/players/${name}/`;
  const files: Record<string, string> = {
    [`${dir}lower.md3`]: 'md3',
    [`${dir}upper.md3`]: 'md3',
    [`${dir}head.md3`]: 'md3',
    [`${dir}animation.cfg`]: 'sex m'
  };
  for (const [skin, texture] of Object.entries(skins)) {
    files[`${dir}lower_${skin}.skin`] = `tag_torso,\nl_legs,${texture}`;
    files[`${dir}upper_${skin}.skin`] = `u_torso,${texture}`;
    files[`${dir}head_${skin}.skin`] = `h_head,${texture}`;
    files[texture] = 'tga';
  }
  for (const skin of icons) files[`${dir}icon_${skin}.tga`] = 'icon';
  return files;
};

describe('player models', () => {
  /** pak0's sarge, with a scripted cigar and two sounds; pak2's tim, whose red skin has no icon. */
  async function install(): Promise<PakFileSystem> {
    const fs = new PakFileSystem();
    fs.mount(
      await pakOf('pak0.pk3', {
        ...model('sarge', {
          default: 'models/players/sarge/band.tga',
          red: 'models/players/sarge/red.tga'
        }),
        'models/players/sarge/head_default.skin':
          'h_cigar,models/players/sarge/cigar.tga\nh_head,models/players/sarge/band.tga',
        'models/players/sarge/cigar_glow.tga': 'glow',
        'scripts/models.shader':
          'models/players/sarge/cigar { { map models/players/sarge/cigar_glow.tga blendfunc add } }',
        'sound/player/sarge/death1.wav': 'RIFF',
        'sound/player/sarge/jump1.wav': 'RIFF'
      })
    );
    fs.mount(
      await pakOf(
        'pak2.pk3',
        model(
          'tim',
          { default: 'models/players/tim/tim.tga', red: 'models/players/medium/tim/red.tga' },
          ['default']
        )
      )
    );
    return fs;
  }

  it('lists every skin that has an icon, in search order, and not tim/red, which has none', async () => {
    // pak2 is searched first, so its tim comes before pak0's sarge.
    expect(listPlayerModels((await install()).listInSearchOrder('models/players/'))).toEqual([
      { model: 'tim', skin: 'default' },
      { model: 'sarge', skin: 'default' },
      { model: 'sarge', skin: 'red' }
    ]);
  });

  it("brings the chosen model: parts, skins, icons, own sounds, and the skins' textures", async () => {
    const library = await extractAssets(await install());
    const sarge = [...library.files.keys()].filter((path) => path.includes('/sarge/')).sort();
    // The cigar draws through its script, so the glow it names comes rather than cigar.tga.
    expect(sarge).toEqual([
      'models/players/sarge/animation.cfg',
      'models/players/sarge/band.tga',
      'models/players/sarge/cigar_glow.tga',
      'models/players/sarge/head.md3',
      'models/players/sarge/head_default.skin',
      'models/players/sarge/head_red.skin',
      'models/players/sarge/icon_default.tga',
      'models/players/sarge/icon_red.tga',
      'models/players/sarge/lower.md3',
      'models/players/sarge/lower_default.skin',
      'models/players/sarge/lower_red.skin',
      'models/players/sarge/red.tga',
      'models/players/sarge/upper.md3',
      'models/players/sarge/upper_default.skin',
      'models/players/sarge/upper_red.skin',
      'sound/player/sarge/death1.wav',
      'sound/player/sarge/jump1.wav'
    ]);
    expect(library.hasPlayerModel('sarge')).toBe(true);
    // Only the chosen model comes at boot; tim waits until he is chosen.
    expect(library.hasPlayerModel('tim')).toBe(false);
  });

  it("counts no sound a model lacks as missing, since sarge's stands in", async () => {
    const library = await extractAssets(await install(), { players: 'all' });
    const own = library.missing.filter((path) => /^sound\/player\/(sarge|tim)\//.test(path));
    expect(own).toEqual([]);
  });

  it('reads another model from the install when it is chosen', async () => {
    const library = await extractAssets(await install());
    expect(await library.loadPlayerModel('tim')).toBe(true);
    expect(library.read('models/players/tim/lower_default.skin')).toBeDefined();
    expect(library.read('models/players/tim/tim.tga')).toBeDefined();
    // tim/red is not offered, so its skin never comes.
    expect(library.read('models/players/tim/lower_red.skin')).toBeUndefined();
  });

  it('refuses a model with no skin to load, so the caller falls back to sarge', async () => {
    const library = await extractAssets(await install());
    expect(await library.loadPlayerModel('nobody')).toBe(false);
  });

  it("stops the page at q3_ui's 256 entries, yet still brings sarge from beyond them", async () => {
    // A pak searched first, whose one folder holds 256 icons, fills the page before sarge. The
    // cap is the menu's; cgame loads sarge by name all the same.
    const fs = await install();
    const crowd: Record<string, string> = {};
    for (let i = 0; i < MAX_PLAYERMODELS; i++) crowd[`models/players/crowd/icon_s${i}.tga`] = 'icon';
    fs.mount(await pakOf('zz-crowd.pk3', crowd));

    const library = await extractAssets(fs);
    expect(library.playerModels).toHaveLength(MAX_PLAYERMODELS);
    expect(library.playerModels.every(({ model }) => model === 'crowd')).toBe(true);
    expect(library.hasPlayerModel('sarge')).toBe(true);
  });

  it("reads a model's icon from the install when the Model page asks for it, and keeps it", async () => {
    const library = await extractAssets(await install());
    const icon = 'models/players/tim/icon_default.tga';
    expect(library.read(icon)).toBeUndefined();
    expect(new TextDecoder().decode(await library.loadFile(icon))).toBe('icon');
    expect(library.read(icon)).toBeDefined();
    expect(await library.loadFile('models/players/tim/icon_red.tga')).toBeUndefined();
  });

  it('reads no file later without an install behind it', async () => {
    const extracted = await extractAssets(await install());
    const cached = new AssetLibrary(new Map(extracted.files));
    expect(await cached.loadFile('models/players/tim/icon_default.tga')).toBeUndefined();
    expect(await cached.loadFile('models/players/sarge/icon_default.tga')).toBeDefined();
  });

  it('loads nothing later without an install behind it', async () => {
    const extracted = await extractAssets(await install());
    const cached = new AssetLibrary(new Map(extracted.files), { playerModels: extracted.playerModels });
    expect(await cached.loadPlayerModel('tim')).toBe(false);
    expect(await cached.loadPlayerModel('sarge')).toBe(true);
  });

  it('keeps every listed model through the cache, reading each when it is chosen', async () => {
    const fs = await install();
    const cache = await cacheOf(fs);
    const library = await extractAssets(cache.fs, { playerModels: cache.info.playerModels });
    expect(library.playerModels).toEqual(listPlayerModels(fs.listInSearchOrder('models/players/')));
    expect(library.hasPlayerModel('tim')).toBe(false);
    expect(await library.loadPlayerModel('tim')).toBe(true);
    expect(library.read('models/players/tim/tim.tga')).toBeDefined();
  });

  it('reads only what it extracts on a later visit, from the cache', async () => {
    const cache = await cacheOf(await install());
    const read = vi.spyOn(cache.fs, 'read');
    const library = await extractAssets(cache.fs, { playerModels: cache.info.playerModels });
    expect(read.mock.calls.map(([path]) => path).sort()).toEqual([...library.files.keys()].sort());
    expect(library.hasPlayerModel('sarge')).toBe(true);
    expect(library.hasPlayerModel('tim')).toBe(false);
  });
});

describe('what the skirmish pages read, kept', () => {
  /**
   * pak0: sarge and his bot, two arena files, a levelshot for two of their maps and one that no
   * arena names, and the unknown map's picture. pak1, searched first: an arena whose map's name
   * runs past fifteen letters, and a bot in hellspawn's red with horns' head. zz-crowd, searched
   * before both, fills the model page's list, so neither of the bot's models is on it.
   */
  async function install(): Promise<PakFileSystem> {
    const fs = new PakFileSystem();
    fs.mount(
      await pakOf('pak0.pk3', {
        ...model('sarge', { default: 'models/players/sarge/band.tga' }),
        'scripts/arenas.txt': '{\nmap "q3dm1"\ntype "ffa tourney"\n}\n{\nmap "q3dm2"\ntype "ffa"\n}\n',
        'scripts/pak0.arena': '{\nmap "q3dm3"\ntype "team"\n}\n',
        'levelshots/q3dm1.jpg': 'jpg',
        'levelshots/q3dm2.tga': 'tga',
        'levelshots/q3dm99.jpg': 'jpg',
        'menu/art/unknownmap.jpg': 'jpg',
        'scripts/bots.txt': '{\nname "Sarge"\nmodel "sarge"\naifile "bots/sarge_c.c"\n}\n'
      })
    );
    fs.mount(
      await pakOf('pak1.pk3', {
        'scripts/pak1.arena': '{\nmap "averyveryverylongmap"\ntype "ffa"\n}\n',
        'levelshots/averyveryverylo.png': 'png',
        'levelshots/averyveryverylongmap.png': 'png',
        'scripts/hellspawn.bot':
          '{\nname "Hellspawn"\nmodel "Hellspawn/red"\nheadmodel "horns"\naifile "bots/hell_c.c"\n}\n',
        ...model('hellspawn', {
          default: 'models/players/hellspawn/skin.tga',
          red: 'models/players/hellspawn/red.tga'
        }),
        ...model('horns', { default: 'models/players/horns/horns.tga' })
      })
    );
    const crowd: Record<string, string> = {};
    for (let i = 0; i < MAX_PLAYERMODELS; i++) crowd[`models/players/crowd/icon_s${i}.tga`] = 'icon';
    fs.mount(await pakOf('zz-crowd.pk3', crowd));
    return fs;
  }

  it("keeps every arena and bot file, each arena's levelshot by the name Start Server asks for, and the unknown map's picture", async () => {
    const { files } = await cacheSubset(await install());
    // A levelshot no arena names stays out, as does one under a map's name past fifteen letters.
    expect(files.filter((path) => /^(levelshots|menu)\/|\.(arena|bot|txt)$/.test(path))).toEqual([
      'levelshots/averyveryverylo.png',
      'levelshots/q3dm1.jpg',
      'levelshots/q3dm2.tga',
      'menu/art/unknownmap.jpg',
      'scripts/arenas.txt',
      'scripts/bots.txt',
      'scripts/hellspawn.bot',
      'scripts/pak0.arena',
      'scripts/pak1.arena'
    ]);
  });

  it("keeps each bot's body and head models whole, while the model page's list stays q3_ui's", async () => {
    const subset = await cacheSubset(await install());
    expect(subset.playerModels.every(({ model }) => model === 'crowd')).toBe(true);
    expect(subset.files.filter((path) => /\/(hellspawn|horns)\//.test(path))).toEqual([
      'models/players/hellspawn/animation.cfg',
      'models/players/hellspawn/head.md3',
      'models/players/hellspawn/head_default.skin',
      'models/players/hellspawn/head_red.skin',
      'models/players/hellspawn/icon_default.tga',
      'models/players/hellspawn/icon_red.tga',
      'models/players/hellspawn/lower.md3',
      'models/players/hellspawn/lower_default.skin',
      'models/players/hellspawn/lower_red.skin',
      'models/players/hellspawn/red.tga',
      'models/players/hellspawn/skin.tga',
      'models/players/hellspawn/upper.md3',
      'models/players/hellspawn/upper_default.skin',
      'models/players/hellspawn/upper_red.skin',
      'models/players/horns/animation.cfg',
      'models/players/horns/head.md3',
      'models/players/horns/head_default.skin',
      'models/players/horns/horns.tga',
      'models/players/horns/icon_default.tga',
      'models/players/horns/lower.md3',
      'models/players/horns/lower_default.skin',
      'models/players/horns/upper.md3',
      'models/players/horns/upper_default.skin'
    ]);
  });

  it('lists the arenas and bots from the cache as the paks list them, and finds each picture the same', async () => {
    const fs = await install();
    const cache = await cacheOf(fs);
    for (const [file, extension, room] of [
      [ARENAS_FILE, '.arena', MENU_ARENA_LIST],
      [BOTS_FILE, '.bot', BOT_LIST]
    ] as const) {
      expect(await readInfoFiles(cache.fs, file, extension, room)).toEqual(
        await readInfoFiles(fs, file, extension, room)
      );
    }
    // pak1 is searched first, so its arena comes first, and not in the names' order.
    expect(cache.fs.getFileList('scripts', '.arena', MENU_ARENA_LIST)).toEqual(['pak1.arena', 'pak0.arena']);
    for (const name of ['levelshots/Q3DM1', 'levelshots/Q3DM2', 'levelshots/AVERYVERYVERYLO', UNKNOWN_MAP]) {
      expect(cache.fs.resolveImage(name), name).toBe(fs.resolveImage(name));
    }
  });

  it('dresses a bot past the list from the cache, body, head and portrait', async () => {
    const cache = await cacheOf(await install());
    const library = await extractAssets(cache.fs, { playerModels: cache.info.playerModels });
    expect(await library.loadPlayerModel('hellspawn')).toBe(true);
    expect(await library.loadPlayerModel('horns')).toBe(true);
    expect(await library.loadFile('models/players/hellspawn/icon_red.tga')).toBeDefined();
  });
});

describe('loadAssets', () => {
  const noInstall = async () => undefined;
  const nothingKept = async () => undefined;
  const noDrop = () => Promise.reject(new Error('should not have shown the drop screen'));
  /** Mounted paks holding one file the manifest names. */
  const paks = async () => {
    const fs = new PakFileSystem();
    const pak0 = zipSync({ 'sound/weapons/change.wav': bytes('RIFF') });
    fs.mount(await ZipArchive.open(memorySource('pak0.pk3', pak0)));
    return fs;
  };

  it('reads the dev install in place and never touches the cache', async () => {
    const kept = vi.fn(nothingKept);
    const keep = vi.fn(async () => true);
    const install = new PakFileSystem();
    const { source, paks: read } = await loadAssets({
      dev: async () => install,
      kept,
      ask: noDrop,
      keep
    });
    expect(source).toBe('install');
    // The paks the library was read from, for the search path.
    expect(read).toBe(install);
    // Dev keeps no cache, in either direction.
    expect(kept).not.toHaveBeenCalled();
    expect(keep).not.toHaveBeenCalled();
  });

  it('boots from what was kept without showing the drop screen, and keeps nothing more', async () => {
    const fs = await paks();
    const keep = vi.fn(async () => true);
    const { library, source, paks: read } = await loadAssets({
      dev: noInstall,
      kept: async () => ({ fs, source: 'cache' }),
      ask: noDrop,
      keep
    });
    expect(source).toBe('cache');
    expect(read).toBe(fs);
    expect(library.read('sound/weapons/change.wav')).toBeDefined();
    expect(keep).not.toHaveBeenCalled();
  });

  it('asks for paks when nothing was kept, and keeps their subset', async () => {
    const fs = await paks();
    const keep = vi.fn(async () => true);
    const { library, source, paks: read } = await loadAssets({
      dev: noInstall,
      kept: nothingKept,
      ask: async () => ({ fs, source: 'paks' }),
      keep
    });
    expect(source).toBe('paks');
    expect(read).toBe(fs);
    expect(library.read('sound/weapons/change.wav')).toBeDefined();
    expect(keep).toHaveBeenCalledWith(fs, await cacheSubset(fs));
  });

  it('still boots when the subset cannot be kept', async () => {
    const { source } = await loadAssets({
      dev: noInstall,
      kept: nothingKept,
      ask: async () => ({ fs: await paks(), source: 'paks' }),
      keep: async () => {
        throw new Error('over quota');
      }
    });
    expect(source).toBe('paks');
  });

  it('counts each file read, whichever route brings the paks', async () => {
    const fs = await paks();
    const routes: PakRoutes[] = [
      { dev: async () => fs, kept: nothingKept, ask: noDrop },
      { dev: noInstall, kept: async () => ({ fs, source: 'cache' }), ask: noDrop }
    ];
    for (const route of routes) {
      const onRead = vi.fn();
      await loadAssets(route, { onRead });
      expect(onRead.mock.calls).toEqual([[1, 1, 'sound/weapons/change.wav']]);
    }
  });
});

// Guarded against the user's install: the manifest is only meaningful against real paks.
const haveFullSet = Array.from({ length: 9 }, (_, i) => havePak(`pak${i}.pk3`)).every(Boolean);

describe.skipIf(!haveFullSet)('extractAssets against the retail pak set', () => {
  async function mountAll(): Promise<PakFileSystem> {
    const fs = new PakFileSystem();
    for (let i = 0; i <= 8; i++) fs.mount(await openPak(`pak${i}.pk3`));
    return fs;
  }

  it('resolves the whole manifest with nothing missing', async () => {
    const library = await extractAssets(await mountAll());
    expect(library.missing).toEqual([]);
  });

  it('lists the 29 retail models, and not tim/red, which has no icon', async () => {
    const list = listPlayerModels((await mountAll()).listInSearchOrder('models/players/'));
    expect(new Set(list.map(({ model }) => model)).size).toBe(29);
    expect(list).toContainEqual({ model: 'tim', skin: 'default' });
    expect(list).not.toContainEqual({ model: 'tim', skin: 'red' });
  });

  it('brings sarge whole: five skins with their icons, and his thirteen sounds', async () => {
    const library = await extractAssets(await mountAll());
    const skins = library.playerModels.filter(({ model }) => model === 'sarge').map(({ skin }) => skin);
    expect([...skins].sort()).toEqual(['blue', 'default', 'krusade', 'red', 'roderic']);
    for (const skin of skins) {
      for (const part of PLAYER_PARTS) {
        expect(library.read(`models/players/sarge/${part}_${skin}.skin`), `${part}_${skin}`).toBeDefined();
      }
      expect(library.read(`models/players/sarge/icon_${skin}.tga`), skin).toBeDefined();
    }
    for (const sound of CUSTOM_SOUNDS) {
      expect(library.read(`sound/player/sarge/${sound}.wav`), sound).toBeDefined();
    }
    expect(library.read('models/players/sarge/band.tga')).toBeDefined();
  });

  it('resolves every retail model, missing only the hat glow retail never shipped', async () => {
    // The scripts give brandon's hat a glow stage from models/players/light/brandon/, where pak2
    // ships only the hat itself. Q3 draws that stage with its default image.
    const library = await extractAssets(await mountAll(), { players: 'all' });
    expect(library.missing).toEqual(['models/players/light/brandon/branhat.glow.tga']);
    for (const { model } of library.playerModels) {
      expect(library.hasPlayerModel(model), model).toBe(true);
    }
  });

  it('extracts a small subset, not the pak, reading each file once', async () => {
    // 527 files and 13 MB measured, against a 457 MB pak0: the weapons' 204 files, the items and
    // their icons and sounds, the hits' blood, the HUD's art — the four flag status icons past
    // each side's first among it, the six medals, the lagometer's picture, the defer cross and
    // the team chat's band — the gibs, the player and menu sounds, the water's, the splashes, the
    // clanks, the gurgles and the fry among them, the announcer's voices, which are 3 MB of it,
    // chat's talk sound, the jump pad's boing, the teleport's two sounds, its model and its
    // image, the held powerups' shells, the bubble, the three sprites over a head, and sarge.
    const fs = await mountAll();
    const read = vi.spyOn(fs, 'read');
    const library = await extractAssets(fs);
    expect(library.files.size).toBe(527);
    expect(library.byteLength).toBeLessThan(16 * 1024 * 1024);
    expect(read).toHaveBeenCalledTimes(527);
  });

  it("brings a teleport's two sounds, and its model with the image its shader draws", async () => {
    const library = await extractAssets(await mountAll());
    for (const file of [
      'sound/world/telein.wav',
      'sound/world/teleout.wav',
      'models/misc/telep.md3',
      'gfx/misc/teleportEffect2.jpg'
    ]) {
      expect(library.read(file), file).toBeDefined();
    }
  });

  it('brings the three sprites a head wears besides the medals', async () => {
    const library = await extractAssets(await mountAll());
    for (const image of ['gfx/2d/net.jpg', 'sprites/balloon4.tga', 'sprites/foe2.tga']) {
      expect(library.read(image), image).toBeDefined();
    }
  });

  it("brings the lagometer's picture, which its script names as a .tga", async () => {
    const library = await extractAssets(await mountAll());
    expect(library.read('gfx/2d/lag.jpg')).toBeDefined();
  });

  it('brings all six medals, from pak0, pak4 and pak5', async () => {
    const library = await extractAssets(await mountAll());
    for (const shader of Object.values(MEDAL_SHADERS)) {
      expect(library.read(`menu/medals/${shader}.tga`), shader).toBeDefined();
    }
  });

  it("brings every one of the announcer's voices, pak4's among them", async () => {
    const library = await extractAssets(await mountAll());
    for (const [cue, path] of Object.entries(ANNOUNCER_SOUNDS)) {
      expect(library.read(path), cue).toBeDefined();
    }
  });

  it('brings the five frames of the blood a hit draws', async () => {
    const library = await extractAssets(await mountAll());
    for (let frame = 1; frame <= 5; frame++) {
      expect(library.read(`models/weaphits/blood20${frame}.tga`), `frame ${frame}`).toBeDefined();
    }
  });

  it('brings the shells a held powerup draws, through their scripts’ tga references', async () => {
    const library = await extractAssets(await mountAll());
    // Each shader's map is a `.tga` the install ships as a `.jpg`, so this is also the
    // extension fallback: without the scripts in the manifest the shell draws untextured white.
    for (const reference of [
      'textures/effects/quadmap2.tga',
      'textures/effects/invismap.tga',
      'textures/effects/regenmap2.tga',
      'textures/effects/envmapgold2.tga',
      'textures/effects/blueflagmap.tga'
    ]) {
      expect(library.resolveImage(reference), reference).toBeDefined();
    }
  });

  it('gives every weapon a parseable model, hand rig, flash and icon', async () => {
    const library = await extractAssets(await mountAll());
    for (const asset of WEAPON_ASSETS) {
      expect(library.model(weaponModelPath(asset.dir)).surfaces.length, asset.dir)
        .toBeGreaterThan(0);
      expect(library.model(weaponModelPath(asset.dir, '_hand')).numFrames, asset.dir)
        .toBeGreaterThan(1);
      expect(library.model(weaponModelPath(asset.dir, '_flash')), asset.dir).toBeDefined();
      expect(library.resolveImage(asset.icon), asset.dir).toBeDefined();
    }
    expect(WEAPON_ASSETS.map((a) => a.id)).toEqual(ALL_WEAPONS);
  });

  it('brings every item model the game draws, and no second model it never does', async () => {
    const library = await extractAssets(await mountAll());
    for (const item of ITEMS.slice(1)) {
      expect(library.read(item.worldModel[0]!), item.classname).toBeDefined();
    }
    // The second model of a health or a powerup is drawn with it; a holdable's is registered by
    // `CG_RegisterItemVisuals` and never drawn, which is why one is here and the other is not.
    expect(ITEM_ASSETS.models).toContain('models/powerups/health/medium_sphere.md3');
    expect(ITEM_ASSETS.models).toContain('models/powerups/instant/quad_ring.md3');
    expect(ITEM_ASSETS.models).not.toContain('models/powerups/holdable/medkit_sphere.md3');
  });

  it('brings every item icon and every sound a pickup, a respawn or a powerup makes', async () => {
    const library = await extractAssets(await mountAll());
    for (const item of ITEMS.slice(1)) {
      expect(library.resolveImage(item.icon), item.classname).toBeDefined();
    }
    for (const sound of ITEM_ASSETS.sounds) {
      expect(library.read(sound), sound).toBeDefined();
    }
    // The eight the client supplies itself, which no table entry names: an item's respawn, a
    // powerup's arrival and its wear-off tick, the three effects a held powerup makes, and the
    // two a holdable's use makes.
    for (const sound of [
      'sound/items/respawn1.wav',
      'sound/items/wearoff.wav',
      'sound/items/poweruprespawn.wav',
      'sound/items/damage3.wav',
      'sound/items/protect3.wav',
      'sound/items/regen.wav',
      'sound/items/use_nothing.wav',
      'sound/items/use_medkit.wav'
    ]) {
      expect(library.read(sound), sound).toBeDefined();
    }
  });

  it('finds a texture for every surface of every weapon model', async () => {
    // Three weapons (railgun, plasma, BFG) resolve only because shader lookup strips
    // the extension first, as R_FindShader does. A regression there shows up here.
    const library = await extractAssets(await mountAll());
    for (const asset of WEAPON_ASSETS) {
      const model = library.model(weaponModelPath(asset.dir));
      for (const surface of model.surfaces) {
        for (const shaderName of surface.shaders) {
          expect(library.surfaceTexture(shaderName), `${asset.dir}/${surface.name}`).toBeDefined();
        }
      }
    }
  });

  it('extracts every sound the manifest names, all playable', async () => {
    const library = await extractAssets(await mountAll());
    for (const asset of WEAPON_ASSETS) {
      for (const sound of [...asset.fireSounds, ...(asset.impactSounds ?? [])]) {
        expect(library.read(sound), sound).toBeDefined();
      }
    }
    expect(library.read('sound/weapons/change.wav')).toBeDefined();
  });

  it('survives the cache round trip with identical assets', async () => {
    const fs = await mountAll();
    const library = await extractAssets(fs);
    const cache = await cacheOf(fs);
    const restored = await extractAssets(cache.fs, { playerModels: cache.info.playerModels });

    expect([...restored.files.keys()].sort()).toEqual([...library.files.keys()].sort());
    expect(restored.playerModels).toEqual(library.playerModels);
    expect(restored.shaderOrder).toEqual(library.shaderOrder);
    // The library must behave identically whichever route it came from — the cached copy
    // resolves shaders and textures the same way, or a warm boot would look different.
    expect(restored.shaders.size).toBe(library.shaders.size);
    expect(restored.surfaceTexture('models/weapons2/rocketl/rocketl.TGA')?.path).toBe(
      'models/weapons2/rocketl/rocketl.jpg'
    );
    expect(restored.model(weaponModelPath('rocketl')).surfaces.length).toBe(2);
    for (const { model } of restored.playerModels) {
      expect(await restored.loadPlayerModel(model), model).toBe(true);
    }
  });

  it('keeps what the skirmish pages read: the arenas and bots as the paks list them, and every levelshot', async () => {
    const fs = await mountAll();
    const cache = await cacheOf(fs);
    for (const [file, extension, room] of [
      [ARENAS_FILE, '.arena', MENU_ARENA_LIST],
      [BOTS_FILE, '.bot', BOT_LIST]
    ] as const) {
      expect(await readInfoFiles(cache.fs, file, extension, room)).toEqual(
        await readInfoFiles(fs, file, extension, room)
      );
    }
    const arenas = loadArenas(await readInfoFiles(fs, ARENAS_FILE, '.arena', MENU_ARENA_LIST), () => {});
    for (const arena of arenas) {
      const shot = `levelshots/${shownMapName(infoValueForKey(arena, 'map'))}`;
      expect(cache.fs.resolveImage(shot), shot).toBe(fs.resolveImage(shot));
    }
    expect(cache.fs.resolveImage(UNKNOWN_MAP)).toBe('menu/art/unknownmap.jpg');
  });

  it('keeps every listed model in about 50 MB, of which a later visit reads a fraction', async () => {
    const cache = await cacheOf(await mountAll());
    const pak = cache.store.files.get('assets.pk3')!;
    expect(pak.size).toBeLessThan(55 * 1024 * 1024);

    const source = countReads(blobSource(pak, 'assets.pk3'));
    const fs = new PakFileSystem();
    fs.mount(await ZipArchive.open(source));
    await extractAssets(fs, { playerModels: cache.info.playerModels });
    expect(bytesRead(source)).toBeLessThan(10 * 1024 * 1024);
  });
});

