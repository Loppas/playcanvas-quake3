import { beforeAll, describe, expect, it } from 'vitest';

import { shaderTextOrder } from '../formats/asset-library';
import { parseBsp } from '../formats/bsp';
import { parseShaderScripts } from '../formats/shader-script';
import { havePak, openPak } from '../pak/pak-test-fixtures';
import { PakFileSystem } from '../pak/vfs';
import { loadMap } from '../sim/cm/cm-load';
import { markEvents, marksCorpus, type MarksCorpus } from './marks-test-fixtures';
import { loadPatchGrids } from './world-curves';
import { loadWorldShaders } from './world-shaders';

/**
 * The twin's marks corpus over each retail map, as ioquake3's own `tr_marks.c`,
 * `RE_AddPolyToScene` and `cg_marks.c` gave it, the map loaded by its own `tr_bsp.c` and
 * `tr_curve.c`: the impacts and shadows cut, the fragments and points they cut, those that filled
 * 128 fragments and the walks that listed 64 surfaces, the frames' polys and those the scene's caps
 * dropped, and digests of every fragment and of every frame's polys.
 */
const TWIN: Record<string, MarksCorpus> = {
  'pro-q3dm13': {
    impacts: 304,
    fragments: 2644,
    points: 8753,
    full: 0,
    listed64: 7,
    polys: 30507,
    dropped: 0,
    fragmentDigest: '8228e9ab',
    polyDigest: 'cf209fd3'
  },
  'pro-q3dm6': {
    impacts: 355,
    fragments: 2978,
    points: 9857,
    full: 1,
    listed64: 15,
    polys: 40313,
    dropped: 0,
    fragmentDigest: '46e43ef4',
    polyDigest: 'a7ec1f5a'
  },
  'pro-q3tourney2': {
    impacts: 269,
    fragments: 1822,
    points: 6056,
    full: 2,
    listed64: 9,
    polys: 19495,
    dropped: 0,
    fragmentDigest: '70092219',
    polyDigest: '80b5a6f8'
  },
  'pro-q3tourney4': {
    impacts: 441,
    fragments: 4834,
    points: 16200,
    full: 0,
    listed64: 30,
    polys: 42950,
    dropped: 0,
    fragmentDigest: '789d66ca',
    polyDigest: '005ef98f'
  },
  q3ctf1: {
    impacts: 530,
    fragments: 5168,
    points: 17169,
    full: 1,
    listed64: 12,
    polys: 43400,
    dropped: 9,
    fragmentDigest: '56bddbb7',
    polyDigest: '30944dac'
  },
  q3ctf2: {
    impacts: 299,
    fragments: 2560,
    points: 8340,
    full: 0,
    listed64: 25,
    polys: 29098,
    dropped: 0,
    fragmentDigest: 'a385b7f4',
    polyDigest: 'ae171211'
  },
  q3ctf3: {
    impacts: 357,
    fragments: 2985,
    points: 9956,
    full: 1,
    listed64: 21,
    polys: 42923,
    dropped: 0,
    fragmentDigest: '967c86e7',
    polyDigest: '0c5a196a'
  },
  q3ctf4: {
    impacts: 958,
    fragments: 1821,
    points: 5987,
    full: 0,
    listed64: 3,
    polys: 24323,
    dropped: 0,
    fragmentDigest: 'c435b1cc',
    polyDigest: '9ba6fd31'
  },
  q3dm0: {
    impacts: 112,
    fragments: 1122,
    points: 3686,
    full: 0,
    listed64: 6,
    polys: 19111,
    dropped: 0,
    fragmentDigest: 'ac77c41c',
    polyDigest: 'b1ce5e0a'
  },
  q3dm1: {
    impacts: 460,
    fragments: 4297,
    points: 14272,
    full: 0,
    listed64: 24,
    polys: 37143,
    dropped: 0,
    fragmentDigest: '00c0ce74',
    polyDigest: 'e5f32fb7'
  },
  q3dm10: {
    impacts: 409,
    fragments: 3193,
    points: 10525,
    full: 1,
    listed64: 25,
    polys: 34785,
    dropped: 0,
    fragmentDigest: 'da0d316b',
    polyDigest: '600eb4ce'
  },
  q3dm11: {
    impacts: 258,
    fragments: 1566,
    points: 5191,
    full: 0,
    listed64: 5,
    polys: 30838,
    dropped: 0,
    fragmentDigest: '57774a09',
    polyDigest: '0f8611e2'
  },
  q3dm12: {
    impacts: 387,
    fragments: 1969,
    points: 6567,
    full: 0,
    listed64: 14,
    polys: 23029,
    dropped: 0,
    fragmentDigest: '45047c10',
    polyDigest: '8c4b3774'
  },
  q3dm13: {
    impacts: 326,
    fragments: 3294,
    points: 10766,
    full: 0,
    listed64: 4,
    polys: 32644,
    dropped: 0,
    fragmentDigest: '050eac7a',
    polyDigest: '8e711614'
  },
  q3dm14: {
    impacts: 461,
    fragments: 3299,
    points: 11077,
    full: 0,
    listed64: 20,
    polys: 39704,
    dropped: 0,
    fragmentDigest: '3bc28af6',
    polyDigest: '1cd77bb0'
  },
  q3dm15: {
    impacts: 414,
    fragments: 3359,
    points: 10991,
    full: 0,
    listed64: 27,
    polys: 33725,
    dropped: 0,
    fragmentDigest: 'bd34d0d1',
    polyDigest: '608cf794'
  },
  q3dm16: {
    impacts: 806,
    fragments: 837,
    points: 2829,
    full: 0,
    listed64: 7,
    polys: 10382,
    dropped: 0,
    fragmentDigest: '73f9889f',
    polyDigest: '77657cd5'
  },
  q3dm17: {
    impacts: 930,
    fragments: 1150,
    points: 3930,
    full: 0,
    listed64: 0,
    polys: 14741,
    dropped: 0,
    fragmentDigest: 'fac93efa',
    polyDigest: '43637293'
  },
  q3dm18: {
    impacts: 487,
    fragments: 1077,
    points: 3703,
    full: 0,
    listed64: 3,
    polys: 13112,
    dropped: 0,
    fragmentDigest: '8cea17f5',
    polyDigest: '9b6ff33e'
  },
  q3dm19: {
    impacts: 921,
    fragments: 248,
    points: 904,
    full: 0,
    listed64: 0,
    polys: 4051,
    dropped: 0,
    fragmentDigest: '13d67b2a',
    polyDigest: '65133a75'
  },
  q3dm2: {
    impacts: 529,
    fragments: 4954,
    points: 16746,
    full: 1,
    listed64: 30,
    polys: 41510,
    dropped: 0,
    fragmentDigest: '97b00a88',
    polyDigest: '1723e2c3'
  },
  q3dm3: {
    impacts: 490,
    fragments: 3323,
    points: 11343,
    full: 0,
    listed64: 11,
    polys: 38802,
    dropped: 0,
    fragmentDigest: '99ffd487',
    polyDigest: 'd5f5143b'
  },
  q3dm4: {
    impacts: 182,
    fragments: 1528,
    points: 5235,
    full: 0,
    listed64: 15,
    polys: 29269,
    dropped: 0,
    fragmentDigest: '86bb042e',
    polyDigest: '5db1e741'
  },
  q3dm5: {
    impacts: 499,
    fragments: 3938,
    points: 13040,
    full: 2,
    listed64: 25,
    polys: 44013,
    dropped: 0,
    fragmentDigest: '36080952',
    polyDigest: '96a5e265'
  },
  q3dm6: {
    impacts: 355,
    fragments: 2942,
    points: 9734,
    full: 1,
    listed64: 15,
    polys: 40002,
    dropped: 0,
    fragmentDigest: '7386e711',
    polyDigest: '798ff7f1'
  },
  q3dm7: {
    impacts: 346,
    fragments: 2105,
    points: 7055,
    full: 0,
    listed64: 5,
    polys: 34428,
    dropped: 0,
    fragmentDigest: 'f3de2966',
    polyDigest: '869c70fd'
  },
  q3dm8: {
    impacts: 207,
    fragments: 1209,
    points: 3991,
    full: 0,
    listed64: 13,
    polys: 23309,
    dropped: 0,
    fragmentDigest: '8caff82c',
    polyDigest: 'db7e3beb'
  },
  q3dm9: {
    impacts: 341,
    fragments: 2266,
    points: 7591,
    full: 0,
    listed64: 23,
    polys: 35004,
    dropped: 0,
    fragmentDigest: '36727de7',
    polyDigest: 'b15377bd'
  },
  q3tourney1: {
    impacts: 311,
    fragments: 3160,
    points: 10693,
    full: 0,
    listed64: 31,
    polys: 43080,
    dropped: 0,
    fragmentDigest: '8e55537e',
    polyDigest: 'c38a99e2'
  },
  q3tourney2: {
    impacts: 307,
    fragments: 2225,
    points: 7432,
    full: 2,
    listed64: 13,
    polys: 34116,
    dropped: 0,
    fragmentDigest: '64caf1f6',
    polyDigest: '38499670'
  },
  q3tourney3: {
    impacts: 504,
    fragments: 2122,
    points: 7281,
    full: 0,
    listed64: 12,
    polys: 34900,
    dropped: 0,
    fragmentDigest: 'c1c53813',
    polyDigest: 'ac8dc850'
  },
  q3tourney4: {
    impacts: 547,
    fragments: 6571,
    points: 21951,
    full: 1,
    listed64: 41,
    polys: 45034,
    dropped: 49,
    fragmentDigest: '5f9b7fdf',
    polyDigest: '4d34726e'
  },
  q3tourney5: {
    impacts: 497,
    fragments: 1013,
    points: 3430,
    full: 0,
    listed64: 4,
    polys: 22592,
    dropped: 0,
    fragmentDigest: '5971fa6d',
    polyDigest: '0ad925cf'
  },
  q3tourney6: {
    impacts: 950,
    fragments: 1602,
    points: 5373,
    full: 0,
    listed64: 5,
    polys: 15550,
    dropped: 0,
    fragmentDigest: '0d18d591',
    polyDigest: '56fc79e8'
  },
  q3tourney6_ctf: {
    impacts: 710,
    fragments: 1064,
    points: 3587,
    full: 0,
    listed64: 3,
    polys: 17536,
    dropped: 0,
    fragmentDigest: '6d0c5d21',
    polyDigest: '17d5ffca'
  },
  test_bigbox: {
    impacts: 863,
    fragments: 1055,
    points: 4265,
    full: 0,
    listed64: 0,
    polys: 20858,
    dropped: 0,
    fragmentDigest: 'f94d0c58',
    polyDigest: '4c2df24c'
  }
};

const haveFullSet = Array.from({ length: 9 }, (_, i) => havePak(`pak${i}.pk3`)).every(Boolean);

describe.skipIf(!haveFullSet)('the marks against the twin, on the 36 retail maps', () => {
  let corpora: Record<string, MarksCorpus>;
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
      const events = markEvents(bsp, loadMap(bsp, path, { print: () => {} }));
      const shaders = loadWorldShaders(bsp, sources);
      corpora[map] = marksCorpus(bsp, shaders, loadPatchGrids(bsp, 1, 4), events);
    }
  }, 120_000);

  it("cuts, keeps, fades and adds each map's marks as the C does, to the bit", () => {
    expect(corpora).toEqual(TWIN);
  });
});
