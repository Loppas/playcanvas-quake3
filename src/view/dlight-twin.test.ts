import { beforeAll, describe, expect, it } from 'vitest';

import { shaderTextOrder } from '../formats/asset-library';
import { parseBsp } from '../formats/bsp';
import { parseShaderScripts } from '../formats/shader-script';
import { havePak, openPak } from '../pak/pak-test-fixtures';
import { PakFileSystem } from '../pak/vfs';
import { dlightCorpus, type DlightCorpus } from './dlight-test-fixtures';
import { loadPatchGrids } from './world-curves';
import { loadWorldShaders } from './world-shaders';

/**
 * The twin's dlight corpus over each retail map, as ioquake3's own `tr_bsp.c`, `tr_curve.c`,
 * `tr_world.c`, `tr_light.c` and `ProjectDlightTexture` gave it: the surfaces its 24 seeded views
 * added and keyed lit, the passes projected and the triangles they kept, and digests of the walk
 * (each surface added and its key's bit, the counters, every surface's light bits) and of the
 * passes (each vertex's place, clip bits and bytes, and each kept triangle).
 */
const TWIN: Record<string, DlightCorpus> = {
  'pro-q3dm13': {
    added: 21477,
    lit: 4142,
    projected: 12682,
    kept: 10306,
    walk: '39a224fc',
    project: 'ae18c275'
  },
  'pro-q3dm6': {
    added: 25114,
    lit: 4838,
    projected: 14107,
    kept: 9674,
    walk: 'b9be4881',
    project: 'dbdcda8d'
  },
  'pro-q3tourney2': {
    added: 24174,
    lit: 3825,
    projected: 13621,
    kept: 10079,
    walk: '43fe58de',
    project: 'b1d5c515'
  },
  'pro-q3tourney4': {
    added: 12006,
    lit: 5376,
    projected: 12221,
    kept: 8858,
    walk: '478a5b35',
    project: '933e8aea'
  },
  q3ctf1: {
    added: 16700,
    lit: 3331,
    projected: 8991,
    kept: 9702,
    walk: 'd6c15608',
    project: 'ca30bf0a'
  },
  q3ctf2: {
    added: 46880,
    lit: 2255,
    projected: 10728,
    kept: 6826,
    walk: 'afab1860',
    project: 'b6ad148b'
  },
  q3ctf3: {
    added: 37271,
    lit: 5146,
    projected: 19501,
    kept: 12677,
    walk: '31143c5e',
    project: 'b73da2d1'
  },
  q3ctf4: {
    added: 11757,
    lit: 2464,
    projected: 8845,
    kept: 2644,
    walk: '3ffe0537',
    project: 'ef6ffacc'
  },
  q3dm0: {
    added: 24193,
    lit: 2166,
    projected: 7726,
    kept: 3986,
    walk: '141769e1',
    project: '51c901a2'
  },
  q3dm1: {
    added: 10320,
    lit: 3936,
    projected: 7897,
    kept: 14159,
    walk: '4b2c826d',
    project: 'd611e4a8'
  },
  q3dm10: {
    added: 18276,
    lit: 4662,
    projected: 12971,
    kept: 11204,
    walk: '48463719',
    project: '972df10d'
  },
  q3dm11: {
    added: 38849,
    lit: 940,
    projected: 2596,
    kept: 1425,
    walk: 'c1e195f4',
    project: '1bde03b7'
  },
  q3dm12: {
    added: 40146,
    lit: 6693,
    projected: 22594,
    kept: 12971,
    walk: '752847db',
    project: '1bf516d6'
  },
  q3dm13: {
    added: 17675,
    lit: 5640,
    projected: 16680,
    kept: 15326,
    walk: 'ee03e4d3',
    project: '22700039'
  },
  q3dm14: {
    added: 15029,
    lit: 5418,
    projected: 11279,
    kept: 11727,
    walk: 'fe83543f',
    project: '944e0b08'
  },
  q3dm15: {
    added: 20904,
    lit: 3589,
    projected: 9143,
    kept: 4697,
    walk: '49bc5bed',
    project: 'ae54fe4a'
  },
  q3dm16: {
    added: 9225,
    lit: 991,
    projected: 3669,
    kept: 1627,
    walk: 'ecd78fc0',
    project: 'c01a6675'
  },
  q3dm17: {
    added: 8339,
    lit: 1683,
    projected: 5811,
    kept: 2354,
    walk: '65df3f80',
    project: 'f77c0565'
  },
  q3dm18: {
    added: 19256,
    lit: 1142,
    projected: 6021,
    kept: 1311,
    walk: '6fe84e77',
    project: '6bfbb98e'
  },
  q3dm19: {
    added: 8932,
    lit: 301,
    projected: 1548,
    kept: 260,
    walk: '1b9a913b',
    project: 'debcacba'
  },
  q3dm2: {
    added: 11288,
    lit: 1575,
    projected: 5619,
    kept: 6178,
    walk: '9f3ebf7e',
    project: '51c0944c'
  },
  q3dm3: {
    added: 8624,
    lit: 2035,
    projected: 5563,
    kept: 3438,
    walk: '54da0c93',
    project: 'd1c105c3'
  },
  q3dm4: {
    added: 12119,
    lit: 1808,
    projected: 5842,
    kept: 5814,
    walk: '30f425e7',
    project: '165a3d2e'
  },
  q3dm5: {
    added: 19317,
    lit: 6688,
    projected: 15895,
    kept: 9960,
    walk: '836b7d37',
    project: '4df0452e'
  },
  q3dm6: {
    added: 25114,
    lit: 4887,
    projected: 14235,
    kept: 9711,
    walk: '1056d228',
    project: '66aecf10'
  },
  q3dm7: {
    added: 25582,
    lit: 3319,
    projected: 10567,
    kept: 10032,
    walk: '4f7bd48d',
    project: '517e8d0d'
  },
  q3dm8: {
    added: 24986,
    lit: 3297,
    projected: 9546,
    kept: 5589,
    walk: '19b7fb2b',
    project: 'c2ce4ac9'
  },
  q3dm9: {
    added: 25297,
    lit: 3446,
    projected: 9477,
    kept: 7447,
    walk: '4dd66b90',
    project: 'ee56dec3'
  },
  q3tourney1: {
    added: 8801,
    lit: 3923,
    projected: 10246,
    kept: 11199,
    walk: 'e12d1ab0',
    project: 'e9259ac7'
  },
  q3tourney2: {
    added: 16522,
    lit: 3519,
    projected: 11549,
    kept: 7378,
    walk: '46325e9a',
    project: '75cc5eb7'
  },
  q3tourney3: {
    added: 10631,
    lit: 3603,
    projected: 8084,
    kept: 6492,
    walk: 'd8808180',
    project: '96347d9a'
  },
  q3tourney4: {
    added: 12667,
    lit: 4880,
    projected: 10933,
    kept: 5278,
    walk: 'd7000995',
    project: '33b3486c'
  },
  q3tourney5: {
    added: 9258,
    lit: 619,
    projected: 3079,
    kept: 1082,
    walk: '3ddd658b',
    project: 'fe5fa510'
  },
  q3tourney6: {
    added: 11031,
    lit: 824,
    projected: 2898,
    kept: 538,
    walk: 'd52a9f80',
    project: 'bc8e86be'
  },
  q3tourney6_ctf: {
    added: 10558,
    lit: 1242,
    projected: 3402,
    kept: 1320,
    walk: 'a3a9e9df',
    project: '5742deba'
  },
  test_bigbox: {
    added: 143,
    lit: 91,
    projected: 350,
    kept: 280,
    walk: 'b628ba23',
    project: '09e6e52e'
  }
};

const haveFullSet = Array.from({ length: 9 }, (_, i) => havePak(`pak${i}.pk3`)).every(Boolean);

describe.skipIf(!haveFullSet)("the world's lights against the twin, on the 36 retail maps", () => {
  let corpora: Record<string, DlightCorpus>;
  beforeAll(async () => {
    const fs = new PakFileSystem();
    for (let i = 0; i <= 8; i++) fs.mount(await openPak(`pak${i}.pk3`));
    const texts: string[] = [];
    for (const path of shaderTextOrder(fs)) texts.push((await fs.readText(path)) ?? '');
    const sources = {
      scripts: parseShaderScripts(texts),
      hasImage: (name: string) => fs.resolveImage(name) !== undefined,
      warn: () => {}
    };
    corpora = {};
    for (const path of fs.list('maps/', 'bsp')) {
      const bsp = parseBsp(await fs.readRequired(path), path);
      const map = path.slice('maps/'.length, -'.bsp'.length);
      corpora[map] = dlightCorpus(bsp, loadWorldShaders(bsp, sources), loadPatchGrids(bsp, 1, 4));
    }
  }, 120_000);

  it('walks, keys and projects each map as the C does, to the bit', () => {
    expect(corpora).toEqual(TWIN);
  });
});
