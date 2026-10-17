import { beforeAll, describe, expect, it } from 'vitest';

import { parseBsp } from '../../formats/bsp';
import { retailMaps } from '../../formats/bsp-test-fixtures';
import { havePak } from '../../pak/pak-test-fixtures';
import { MASK } from '../constants';
import { newTrace, type ClipMap } from './cm-local';
import { loadMap } from './cm-load';
import { boxTrace } from './cm-trace';
import { traceCorpus, type CorpusKind } from './trace-test-fixtures';

/**
 * The twin's corpus over each retail map: its entity origins, then a count and a digest for each
 * kind of trace, contents, leaf and area query, as ioquake3's own `cm_*.c` gave them.
 */
const TWIN: Record<string, Record<string, CorpusKind | number>> = {
  'pro-q3dm13': {
    origins: 318,
    world: { count: 3000, digest: '5f347652' },
    patches: { count: 564, digest: '02be8861' },
    nocurves: { count: 288, digest: '146baef1' },
    noclip: { count: 288, digest: '0772d6db' },
    contents: { count: 2000, digest: '2379e424' },
    models: { count: 48, digest: '891644ca' },
    box: { count: 1200, digest: '2d1aac2c' },
    leaves: { count: 600, digest: '28c3f0da' },
    areas: { count: 64, digest: 'c78c4a5b' }
  },
  'pro-q3dm6': {
    origins: 343,
    world: { count: 3000, digest: '2c5c472a' },
    patches: { count: 2148, digest: '79ddeac0' },
    nocurves: { count: 288, digest: '73114637' },
    noclip: { count: 288, digest: '0a5ddb43' },
    contents: { count: 2000, digest: 'c7f077a6' },
    models: { count: 48, digest: '011c22e9' },
    box: { count: 1200, digest: 'bc4ecb4b' },
    leaves: { count: 600, digest: '40e92f55' },
    areas: { count: 64, digest: 'cf4597d4' }
  },
  'pro-q3tourney2': {
    origins: 184,
    world: { count: 3000, digest: 'f1b3ccc9' },
    patches: { count: 1458, digest: '741d38df' },
    nocurves: { count: 288, digest: '0d39ca14' },
    noclip: { count: 288, digest: '508f26fe' },
    contents: { count: 2000, digest: '2d0ea3e3' },
    models: { count: 192, digest: 'f115c393' },
    box: { count: 1200, digest: 'f76b616f' },
    leaves: { count: 600, digest: 'dcf97c40' },
    areas: { count: 64, digest: '01c8c80f' }
  },
  'pro-q3tourney4': {
    origins: 213,
    world: { count: 3000, digest: '9cc7a784' },
    patches: { count: 96, digest: 'e3f0eb68' },
    nocurves: { count: 96, digest: 'de6c60fb' },
    noclip: { count: 96, digest: 'c4c29126' },
    contents: { count: 2000, digest: 'dde7d1b4' },
    models: { count: 288, digest: 'c0c2566a' },
    box: { count: 1200, digest: 'aee230b7' },
    leaves: { count: 600, digest: 'cce08240' },
    areas: { count: 64, digest: 'c2b45883' }
  },
  'q3ctf1': {
    origins: 439,
    world: { count: 3000, digest: '215ae575' },
    patches: { count: 1356, digest: '398dca21' },
    nocurves: { count: 288, digest: 'a6c8d1fb' },
    noclip: { count: 288, digest: 'f3527391' },
    contents: { count: 2000, digest: '5998b189' },
    models: { count: 96, digest: 'b3b7b707' },
    box: { count: 1200, digest: 'f8a29b6a' },
    leaves: { count: 600, digest: '76d3c291' },
    areas: { count: 64, digest: '4550ce25' }
  },
  'q3ctf2': {
    origins: 1024,
    world: { count: 3000, digest: 'ee2c562b' },
    patches: { count: 3216, digest: '3fe49c4a' },
    nocurves: { count: 288, digest: '688982b2' },
    noclip: { count: 288, digest: '0b7b7609' },
    contents: { count: 2000, digest: 'aa1f5338' },
    models: { count: 800, digest: 'f49bec42' },
    box: { count: 1200, digest: '678a81f2' },
    leaves: { count: 600, digest: '89a2fcca' },
    areas: { count: 64, digest: '2b9e1a5b' }
  },
  'q3ctf3': {
    origins: 521,
    world: { count: 3000, digest: '4eb08e20' },
    patches: { count: 3036, digest: '7689c339' },
    nocurves: { count: 288, digest: '7096d20d' },
    noclip: { count: 288, digest: 'cf491d2d' },
    contents: { count: 2000, digest: 'fe3c8af9' },
    models: { count: 64, digest: 'f1383958' },
    box: { count: 1200, digest: 'acc52bfe' },
    leaves: { count: 600, digest: 'ad4e662d' },
    areas: { count: 64, digest: '36d8fb0f' }
  },
  'q3ctf4': {
    origins: 182,
    world: { count: 3000, digest: '68b0b6dd' },
    patches: { count: 156, digest: '90fd9153' },
    nocurves: { count: 156, digest: '9ab0cf30' },
    noclip: { count: 156, digest: '04608cf8' },
    contents: { count: 2000, digest: '02a63aaa' },
    models: { count: 448, digest: '6eb84273' },
    box: { count: 1200, digest: '01543915' },
    leaves: { count: 600, digest: 'bbd508b0' },
    areas: { count: 64, digest: 'a5dd7832' }
  },
  'q3dm0': {
    origins: 146,
    world: { count: 3000, digest: '58c95f4a' },
    patches: { count: 276, digest: '021ae740' },
    nocurves: { count: 276, digest: '52062d35' },
    noclip: { count: 276, digest: 'e2933dc7' },
    contents: { count: 2000, digest: '165fbc80' },
    models: { count: 208, digest: 'c0566736' },
    box: { count: 1200, digest: 'a0e50dec' },
    leaves: { count: 600, digest: 'f407fb7a' },
    areas: { count: 64, digest: 'ead7e295' }
  },
  'q3dm1': {
    origins: 160,
    world: { count: 3000, digest: '9592c161' },
    patches: { count: 678, digest: 'f2e5eff2' },
    nocurves: { count: 288, digest: '0e87f583' },
    noclip: { count: 288, digest: '6ba699f5' },
    contents: { count: 2000, digest: 'c02ef999' },
    models: { count: 0, digest: '811c9dc5' },
    box: { count: 1200, digest: '23d364ff' },
    leaves: { count: 600, digest: 'df9380f3' },
    areas: { count: 64, digest: 'c89eb7c3' }
  },
  'q3dm10': {
    origins: 220,
    world: { count: 3000, digest: '0259cce3' },
    patches: { count: 1320, digest: 'cd3b2c7a' },
    nocurves: { count: 288, digest: 'b872ae4a' },
    noclip: { count: 288, digest: '970efa07' },
    contents: { count: 2000, digest: '5b802160' },
    models: { count: 32, digest: 'd1428620' },
    box: { count: 1200, digest: '7c407a71' },
    leaves: { count: 600, digest: '14772ecd' },
    areas: { count: 64, digest: '172aa87c' }
  },
  'q3dm11': {
    origins: 524,
    world: { count: 3000, digest: 'a5502b4e' },
    patches: { count: 612, digest: '68a59d8e' },
    nocurves: { count: 288, digest: '2dd04280' },
    noclip: { count: 288, digest: '5c47275c' },
    contents: { count: 2000, digest: 'e5ce6f86' },
    models: { count: 512, digest: 'c82f3bd4' },
    box: { count: 1200, digest: '61b9d25b' },
    leaves: { count: 600, digest: 'd2da7969' },
    areas: { count: 64, digest: '71ad2056' }
  },
  'q3dm12': {
    origins: 491,
    world: { count: 3000, digest: '39ef419e' },
    patches: { count: 1524, digest: '25b4a89a' },
    nocurves: { count: 288, digest: '30fefed8' },
    noclip: { count: 288, digest: 'd8eded90' },
    contents: { count: 2000, digest: 'd4907299' },
    models: { count: 1008, digest: '50736eb9' },
    box: { count: 1200, digest: '87b94b99' },
    leaves: { count: 600, digest: '8cbf70b0' },
    areas: { count: 64, digest: 'fb4e9700' }
  },
  'q3dm13': {
    origins: 299,
    world: { count: 3000, digest: '14eb2c1f' },
    patches: { count: 486, digest: '8f91e4c8' },
    nocurves: { count: 288, digest: '80de8630' },
    noclip: { count: 288, digest: '2d7d38e7' },
    contents: { count: 2000, digest: '05e97451' },
    models: { count: 48, digest: 'e8b67d64' },
    box: { count: 1200, digest: '89617a11' },
    leaves: { count: 600, digest: 'bebd6d1e' },
    areas: { count: 64, digest: '99fabf8c' }
  },
  'q3dm14': {
    origins: 558,
    world: { count: 3000, digest: '269e460c' },
    patches: { count: 1890, digest: '1b63cfb8' },
    nocurves: { count: 288, digest: '16e00f0f' },
    noclip: { count: 288, digest: '88a26b92' },
    contents: { count: 2000, digest: '289f34db' },
    models: { count: 256, digest: 'dc144a92' },
    box: { count: 1200, digest: 'd7317724' },
    leaves: { count: 600, digest: '4932ee9d' },
    areas: { count: 64, digest: '3622751f' }
  },
  'q3dm15': {
    origins: 504,
    world: { count: 3000, digest: 'f83212f6' },
    patches: { count: 1872, digest: '351d21e1' },
    nocurves: { count: 288, digest: '2567ef5c' },
    noclip: { count: 288, digest: '1822a1a8' },
    contents: { count: 2000, digest: 'fe13b4a9' },
    models: { count: 320, digest: 'a67fa6f0' },
    box: { count: 1200, digest: 'cdd47cce' },
    leaves: { count: 600, digest: '34adab5d' },
    areas: { count: 64, digest: 'e853249e' }
  },
  'q3dm16': {
    origins: 145,
    world: { count: 3000, digest: '07d2c673' },
    patches: { count: 606, digest: 'ee9c2a80' },
    nocurves: { count: 288, digest: '0f302085' },
    noclip: { count: 288, digest: '56cad494' },
    contents: { count: 2000, digest: 'a693236a' },
    models: { count: 176, digest: 'be1bb090' },
    box: { count: 1200, digest: '9865564d' },
    leaves: { count: 600, digest: '3479fc3f' },
    areas: { count: 64, digest: '17db99c2' }
  },
  'q3dm17': {
    origins: 133,
    world: { count: 3000, digest: 'aa597959' },
    patches: { count: 192, digest: '4b5c2e29' },
    nocurves: { count: 192, digest: 'ace65f34' },
    noclip: { count: 192, digest: 'ef1d9c4f' },
    contents: { count: 2000, digest: '23fad9d4' },
    models: { count: 304, digest: 'a1ae582c' },
    box: { count: 1200, digest: 'a55ccb84' },
    leaves: { count: 600, digest: '004928f4' },
    areas: { count: 64, digest: 'f7717f8a' }
  },
  'q3dm18': {
    origins: 115,
    world: { count: 3000, digest: '03490d19' },
    patches: { count: 1332, digest: 'd6d23454' },
    nocurves: { count: 288, digest: '8969e082' },
    noclip: { count: 288, digest: 'c902fed8' },
    contents: { count: 2000, digest: '6ec19cea' },
    models: { count: 288, digest: 'bdcd1b39' },
    box: { count: 1200, digest: 'ff2ec396' },
    leaves: { count: 600, digest: 'f9aa7629' },
    areas: { count: 64, digest: '929fe87a' }
  },
  'q3dm19': {
    origins: 75,
    world: { count: 3000, digest: '9c5ba190' },
    patches: { count: 0, digest: '811c9dc5' },
    nocurves: { count: 0, digest: '811c9dc5' },
    noclip: { count: 0, digest: '811c9dc5' },
    contents: { count: 2000, digest: '669548af' },
    models: { count: 272, digest: '2d463789' },
    box: { count: 1200, digest: '211450c9' },
    leaves: { count: 600, digest: '19c9498f' },
    areas: { count: 64, digest: 'a5dd7832' }
  },
  'q3dm2': {
    origins: 151,
    world: { count: 3000, digest: '34ef9dac' },
    patches: { count: 1416, digest: '6eac52af' },
    nocurves: { count: 288, digest: 'a83f6331' },
    noclip: { count: 288, digest: '17c63baf' },
    contents: { count: 2000, digest: 'a760de58' },
    models: { count: 32, digest: '77a1549a' },
    box: { count: 1200, digest: '8f07c263' },
    leaves: { count: 600, digest: '4361d148' },
    areas: { count: 64, digest: '0d32cd2a' }
  },
  'q3dm3': {
    origins: 93,
    world: { count: 3000, digest: '1de25f85' },
    patches: { count: 654, digest: 'a90bd8f2' },
    nocurves: { count: 288, digest: 'e0a56c19' },
    noclip: { count: 288, digest: 'ab0c605c' },
    contents: { count: 2000, digest: '332e23af' },
    models: { count: 0, digest: '811c9dc5' },
    box: { count: 1200, digest: '18f2e659' },
    leaves: { count: 600, digest: '268f8fa0' },
    areas: { count: 64, digest: 'eba41765' }
  },
  'q3dm4': {
    origins: 196,
    world: { count: 3000, digest: 'e3ec92db' },
    patches: { count: 2250, digest: 'ad133128' },
    nocurves: { count: 288, digest: '68bb06e7' },
    noclip: { count: 288, digest: 'c59e9a77' },
    contents: { count: 2000, digest: '92a93c7d' },
    models: { count: 144, digest: '81c4eb7b' },
    box: { count: 1200, digest: 'e7237769' },
    leaves: { count: 600, digest: 'a82aac0e' },
    areas: { count: 64, digest: 'b04efff0' }
  },
  'q3dm5': {
    origins: 233,
    world: { count: 3000, digest: 'a60b43e0' },
    patches: { count: 1356, digest: 'c2cdfd0d' },
    nocurves: { count: 288, digest: '8995c784' },
    noclip: { count: 288, digest: '154f687d' },
    contents: { count: 2000, digest: '3ad4263e' },
    models: { count: 48, digest: '95a7a0f7' },
    box: { count: 1200, digest: 'fdcb0682' },
    leaves: { count: 600, digest: 'ee143ea3' },
    areas: { count: 64, digest: '778ed65c' }
  },
  'q3dm6': {
    origins: 330,
    world: { count: 3000, digest: '1db44569' },
    patches: { count: 2148, digest: '7b4d76f2' },
    nocurves: { count: 288, digest: '2f2cf983' },
    noclip: { count: 288, digest: 'f33f38b3' },
    contents: { count: 2000, digest: '1c01d6d9' },
    models: { count: 48, digest: 'fec8617e' },
    box: { count: 1200, digest: 'df443fd6' },
    leaves: { count: 600, digest: '19a83516' },
    areas: { count: 64, digest: '5157b6d0' }
  },
  'q3dm7': {
    origins: 544,
    world: { count: 3000, digest: 'd24f857e' },
    patches: { count: 1134, digest: '06bd776e' },
    nocurves: { count: 288, digest: '4f8304b9' },
    noclip: { count: 288, digest: '34e00866' },
    contents: { count: 2000, digest: '6e03e72d' },
    models: { count: 112, digest: '9c4ceddd' },
    box: { count: 1200, digest: '7d24d326' },
    leaves: { count: 600, digest: '68fbe0f4' },
    areas: { count: 64, digest: '0f9f5a4a' }
  },
  'q3dm8': {
    origins: 825,
    world: { count: 3000, digest: 'c9b2ebe6' },
    patches: { count: 2142, digest: '1a064bad' },
    nocurves: { count: 288, digest: '1b65cfec' },
    noclip: { count: 288, digest: 'aaea3755' },
    contents: { count: 2000, digest: '9319670e' },
    models: { count: 448, digest: '98bbc6f4' },
    box: { count: 1200, digest: '7f68d4f3' },
    leaves: { count: 600, digest: '716dc04e' },
    areas: { count: 64, digest: '386c6a82' }
  },
  'q3dm9': {
    origins: 349,
    world: { count: 3000, digest: 'c8b59308' },
    patches: { count: 2412, digest: 'b4a4f97e' },
    nocurves: { count: 288, digest: '537adb09' },
    noclip: { count: 288, digest: '5c23182a' },
    contents: { count: 2000, digest: '29fdcf2b' },
    models: { count: 416, digest: '1e39820f' },
    box: { count: 1200, digest: 'd91450e3' },
    leaves: { count: 600, digest: 'f08ed457' },
    areas: { count: 64, digest: '14b98e88' }
  },
  'q3tourney1': {
    origins: 127,
    world: { count: 3000, digest: '1120d43d' },
    patches: { count: 2058, digest: 'd62fa106' },
    nocurves: { count: 288, digest: 'ce8c2db5' },
    noclip: { count: 288, digest: '6d2fe801' },
    contents: { count: 2000, digest: 'aaf9f7c2' },
    models: { count: 48, digest: '4bd22e2b' },
    box: { count: 1200, digest: '3bd95791' },
    leaves: { count: 600, digest: '549eebde' },
    areas: { count: 64, digest: 'a02205b7' }
  },
  'q3tourney2': {
    origins: 151,
    world: { count: 3000, digest: 'fddd75f5' },
    patches: { count: 1236, digest: '9e9f81c2' },
    nocurves: { count: 288, digest: '6c88e3a1' },
    noclip: { count: 288, digest: 'ece702a5' },
    contents: { count: 2000, digest: '744b9a38' },
    models: { count: 160, digest: '376b5a17' },
    box: { count: 1200, digest: 'cbe07d72' },
    leaves: { count: 600, digest: 'a3007e8e' },
    areas: { count: 64, digest: '0cafc9c0' }
  },
  'q3tourney3': {
    origins: 93,
    world: { count: 3000, digest: '0e815d52' },
    patches: { count: 714, digest: '5346c279' },
    nocurves: { count: 288, digest: '8b08cf56' },
    noclip: { count: 288, digest: 'be86d402' },
    contents: { count: 2000, digest: '23b7203c' },
    models: { count: 224, digest: '298fcaa8' },
    box: { count: 1200, digest: '97243bbf' },
    leaves: { count: 600, digest: '0b096f43' },
    areas: { count: 64, digest: '2bbb5d2b' }
  },
  'q3tourney4': {
    origins: 198,
    world: { count: 3000, digest: '0d1843d8' },
    patches: { count: 96, digest: 'fbd9be50' },
    nocurves: { count: 96, digest: 'a79bf65f' },
    noclip: { count: 96, digest: '5df8b44f' },
    contents: { count: 2000, digest: 'b62aac39' },
    models: { count: 256, digest: '0f2c6c0a' },
    box: { count: 1200, digest: '48bec1b9' },
    leaves: { count: 600, digest: 'f86740dc' },
    areas: { count: 64, digest: 'f4e2047d' }
  },
  'q3tourney5': {
    origins: 67,
    world: { count: 3000, digest: '4f879e07' },
    patches: { count: 354, digest: '3f639318' },
    nocurves: { count: 288, digest: '1af2d556' },
    noclip: { count: 288, digest: '39531b60' },
    contents: { count: 2000, digest: '28138e45' },
    models: { count: 16, digest: '1a18528d' },
    box: { count: 1200, digest: '8e99b409' },
    leaves: { count: 600, digest: 'df3b1b34' },
    areas: { count: 64, digest: '1b63f446' }
  },
  'q3tourney6': {
    origins: 148,
    world: { count: 3000, digest: '2f481480' },
    patches: { count: 24, digest: 'a2d8bd54' },
    nocurves: { count: 24, digest: '4030e990' },
    noclip: { count: 24, digest: 'e5e01b2a' },
    contents: { count: 2000, digest: 'ae72d89a' },
    models: { count: 336, digest: '847db991' },
    box: { count: 1200, digest: '4e2dd5a5' },
    leaves: { count: 600, digest: 'ad16a3bd' },
    areas: { count: 64, digest: 'ac166edc' }
  },
  'q3tourney6_ctf': {
    origins: 180,
    world: { count: 3000, digest: '3a53237f' },
    patches: { count: 24, digest: '1ea676b0' },
    nocurves: { count: 24, digest: '522ea4f4' },
    noclip: { count: 24, digest: '296364fc' },
    contents: { count: 2000, digest: '41a1d381' },
    models: { count: 336, digest: 'aa870e5c' },
    box: { count: 1200, digest: 'c09a3e76' },
    leaves: { count: 600, digest: 'b869e44e' },
    areas: { count: 64, digest: '70e08482' }
  },
  'test_bigbox': {
    origins: 4,
    world: { count: 3000, digest: '6a7f9d3f' },
    patches: { count: 0, digest: '811c9dc5' },
    nocurves: { count: 0, digest: '811c9dc5' },
    noclip: { count: 0, digest: '811c9dc5' },
    contents: { count: 2000, digest: '66a0cd86' },
    models: { count: 0, digest: '811c9dc5' },
    box: { count: 1200, digest: 'c0c0f78c' },
    leaves: { count: 600, digest: '41828e86' },
    areas: { count: 64, digest: '94b54da0' }
  }
};

/**
 * Point traces that start exactly on, or lie in, a patch facet's inward border, which a search of
 * the retail patches found and no seeded trace reaches, with the twin's whole result: allsolid,
 * startsolid, fraction, endpos, the plane's normal, distance, type and sign bits, the surface
 * flags, the contents and the entity.
 */
const FOUND = [
  {
    map: 'pro-q3dm13',
    model: 0,
    mask: MASK.SHOT,
    start: [843.5029296875, 553.8724365234375, 482.1141662597656],
    end: [869.1053466796875, 568.4232177734375, 435.5829162597656],
    trace: [0, 0, 0.9623238444328308, 868.1407470703125, 567.875, 437.3360290527344, 0, -1, 0, -568,
      0, 0, 0, 1, 0]
  },
  {
    map: 'pro-q3dm13',
    model: 0,
    mask: MASK.SHOT,
    start: [907.341796875, 600.712890625, 423.99932861328125],
    end: [871.001953125, 593.974609375, 431.7942810058594],
    trace: [0, 0, 1, 871.001953125, 593.974609375, 431.7942810058594, 0, 0, 0, 0, 0, 0, 0, 0, 0]
  },
  {
    map: 'pro-q3dm13',
    model: 0,
    mask: MASK.SHOT,
    start: [869.528076171875, 617.568115234375, 423.99932861328125],
    end: [844.317138671875, 620.521240234375, 402.5043640136719],
    trace: [0, 0, 0.8129233717918396, 849.0335083007812, 619.96875, 406.52557373046875,
      0.9599999785423279, 0, -0.2800000011920929, 701.1199951171875, 0, 0, 0, 1, 0]
  },
  {
    map: 'pro-q3dm13',
    model: 0,
    mask: MASK.SHOT,
    start: [881.2181396484375, 636.4786376953125, 423.99932861328125],
    end: [847.1243896484375, 574.8341064453125, 425.71453857421875],
    trace: [0, 0, 1, 847.1243896484375, 574.8341064453125, 425.71453857421875, 0, 0, 0, 0, 0, 0, 0,
      0, 0]
  },
  {
    map: 'pro-q3dm13',
    model: 0,
    mask: MASK.SHOT,
    start: [669.6290283203125, 606.0015258789062, 249.98541259765625],
    end: [610.9766845703125, 606.0015258789062, 308.71588134765625],
    trace: [0, 0, 1, 610.9766845703125, 606.0015258789062, 308.71588134765625, 0, 0, 0, 0, 0, 0, 0,
      0, 0]
  },
  {
    map: 'pro-q3dm13',
    model: 0,
    mask: MASK.SHOT,
    start: [626.2677612304688, 606.0015258789062, 289.2269592285156],
    end: [616.9083862304688, 606.0015258789062, 298.5433654785156],
    trace: [0, 0, 1, 616.9083862304688, 606.0015258789062, 298.5433654785156, 0, 0, 0, 0, 0, 0, 0,
      0, 0]
  },
  {
    map: 'pro-q3dm13',
    model: 0,
    mask: MASK.SHOT,
    start: [631.07568359375, 606.0015258789062, 256.7798156738281],
    end: [586.14208984375, 606.0015258789062, 296.6782531738281],
    trace: [0, 0, 1, 586.14208984375, 606.0015258789062, 296.6782531738281, 0, 0, 0, 0, 0, 0, 0, 0,
      0]
  },
  {
    map: 'pro-q3dm13',
    model: 0,
    mask: MASK.SHOT,
    start: [636.6902465820312, 620.39697265625, 296.0005798339844],
    end: [613.8347778320312, 596.22509765625, 296.0005798339844],
    trace: [0, 0, 1, 613.8347778320312, 596.22509765625, 296.0005798339844, 0, 0, 0, 0, 0, 0, 0, 0,
      0]
  }
];

const haveFullSet = Array.from({ length: 9 }, (_, i) => havePak(`pak${i}.pk3`)).every(Boolean);

describe.skipIf(!haveFullSet)('the traces against the twin, over the 36 retail maps', () => {
  const clipMaps = new Map<string, ClipMap>();
  let corpora: Map<string, Record<string, CorpusKind | number>>;
  beforeAll(async () => {
    corpora = await retailMaps((bytes, path) => {
      const name = path.slice('maps/'.length, -'.bsp'.length);
      const cm = loadMap(parseBsp(bytes, path), path, { print: () => {} });
      if (FOUND.some((c) => c.map === name)) clipMaps.set(name, cm);
      return traceCorpus(cm, name);
    });
  }, 60_000);

  it('traces, tests and lists each map as the C does, to the bit', () => {
    expect(Object.fromEntries(corpora)).toEqual(TWIN);
  });

  it("traces a point from on, or in, a facet's inward border as the C does", () => {
    const t = newTrace();
    for (const c of FOUND) {
      boxTrace(clipMaps.get(c.map)!, t, c.start, c.end, null, null, c.model, c.mask);
      const p = t.plane;
      expect([
        ...[t.allsolid ? 1 : 0, t.startsolid ? 1 : 0, t.fraction, ...t.endpos],
        ...[...p.normal, p.dist, p.type, p.signbits, t.surfaceFlags, t.contents, t.entityNum]
      ]).toEqual(c.trace);
    }
  });
});
