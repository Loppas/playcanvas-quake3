import { beforeAll, describe, expect, it } from 'vitest';

import { parseBsp } from '../formats/bsp';
import { retailMaps } from '../formats/bsp-test-fixtures';
import { havePak } from '../pak/pak-test-fixtures';
import { lightCorpus, type LightCorpus } from './light-test-fixtures';

/**
 * The twin's corpus over each retail map, as ioquake3's own `tr_bsp.c` and `tr_light.c` gave it:
 * how many items and spawn points, how many points in all, and at `r_overBrightBits` 1 and 0 a
 * digest of the grid as loaded, of each point's sample, of each entity lit with its lights and
 * turned, of its colours at eight normals, and of the first 64 lit again with no world.
 */
const TWIN: Record<string, LightCorpus> = {
  'pro-q3dm13': {
    spots: 53,
    points: 2109,
    ob1: {
      grid: 'c47e11e7',
      sample: '905ca722',
      light: '28c28d9e',
      diffuse: '1d924677',
      noworld: '7ceb29f5',
      nodiffuse: '01c0e85f'
    },
    ob0: {
      grid: 'c214ef0b',
      sample: '1f537bde',
      light: '7f1d6730',
      diffuse: '696d3c63',
      noworld: '934da60e',
      nodiffuse: '75a4b01a'
    }
  },
  'pro-q3dm6': {
    spots: 66,
    points: 2136,
    ob1: {
      grid: 'dcfc53e0',
      sample: '96b85cfe',
      light: '497527f9',
      diffuse: '775941b8',
      noworld: '736add91',
      nodiffuse: '0c2bece2'
    },
    ob0: {
      grid: 'b2e8c652',
      sample: 'ab466c06',
      light: '5ee0703b',
      diffuse: 'aef9408a',
      noworld: 'f052cd84',
      nodiffuse: '1b9cf31b'
    }
  },
  'pro-q3tourney2': {
    spots: 50,
    points: 2103,
    ob1: {
      grid: '97bcf78b',
      sample: '57da16c1',
      light: '7aed5d32',
      diffuse: 'ac824f87',
      noworld: 'a85ca6c6',
      nodiffuse: 'a4d104e8'
    },
    ob0: {
      grid: '1ad986b6',
      sample: '02fcbf87',
      light: '806f9faa',
      diffuse: '72aae8a5',
      noworld: 'f3438444',
      nodiffuse: '82f0b447'
    }
  },
  'pro-q3tourney4': {
    spots: 42,
    points: 2088,
    ob1: {
      grid: '4738a4a8',
      sample: 'e193beda',
      light: '6ffd67af',
      diffuse: '5162866a',
      noworld: 'dd8856d0',
      nodiffuse: '23de7c98'
    },
    ob0: {
      grid: '2cb84e65',
      sample: 'e451cb0e',
      light: '183f8db4',
      diffuse: '258d61ce',
      noworld: '3b9b56c8',
      nodiffuse: 'e4d21166'
    }
  },
  q3ctf1: {
    spots: 82,
    points: 2168,
    ob1: {
      grid: '5ef05df6',
      sample: '906284c4',
      light: '292cc1cf',
      diffuse: 'c4ee1619',
      noworld: '2f85e83c',
      nodiffuse: '7a60dba5'
    },
    ob0: {
      grid: '82ed4e50',
      sample: 'd1b0445b',
      light: '5aa83fad',
      diffuse: '9311f9ae',
      noworld: '4eca5bef',
      nodiffuse: '63d52178'
    }
  },
  q3ctf2: {
    spots: 154,
    points: 2312,
    ob1: {
      grid: 'c6204b51',
      sample: '1c570883',
      light: '0f0b55fd',
      diffuse: 'ef93151f',
      noworld: '52a787ee',
      nodiffuse: 'a911a82e'
    },
    ob0: {
      grid: 'ca6179e7',
      sample: 'f104802e',
      light: '04b21df8',
      diffuse: '6a0f261c',
      noworld: 'b15d24a3',
      nodiffuse: '773367d0'
    }
  },
  q3ctf3: {
    spots: 159,
    points: 2322,
    ob1: {
      grid: '28721c5a',
      sample: 'c3b51f52',
      light: 'b6959005',
      diffuse: 'd9d5eebe',
      noworld: '21dd8b0c',
      nodiffuse: 'b90f0a1d'
    },
    ob0: {
      grid: 'c3548b5b',
      sample: '338cc2bf',
      light: '8f0bc86d',
      diffuse: 'e5603793',
      noworld: '4e07b7cc',
      nodiffuse: '7aea904d'
    }
  },
  q3ctf4: {
    spots: 56,
    points: 2114,
    ob1: {
      grid: 'b363d2e9',
      sample: 'cfd924bb',
      light: '1f4d17d3',
      diffuse: '2c14e663',
      noworld: 'b5ff3690',
      nodiffuse: '3ba5d09a'
    },
    ob0: {
      grid: 'ced4e4e5',
      sample: 'b6e453b7',
      light: 'ab41d15a',
      diffuse: '070d4587',
      noworld: 'fb261bfb',
      nodiffuse: 'c657b54a'
    }
  },
  q3dm0: {
    spots: 25,
    points: 2053,
    ob1: {
      grid: 'de935315',
      sample: '4a86e26d',
      light: '3c529352',
      diffuse: '82d0e29d',
      noworld: 'ebc90261',
      nodiffuse: 'd33d1376'
    },
    ob0: {
      grid: 'f6b5092e',
      sample: 'ca268103',
      light: '1aad78f6',
      diffuse: '46799b50',
      noworld: 'ef9ec765',
      nodiffuse: '38839bc9'
    }
  },
  q3dm1: {
    spots: 25,
    points: 2053,
    ob1: {
      grid: 'd441e51d',
      sample: 'f917bc10',
      light: 'ea14b36d',
      diffuse: '1ced6f08',
      noworld: 'ebc90261',
      nodiffuse: 'd33d1376'
    },
    ob0: {
      grid: '1e52484e',
      sample: '2032e0c1',
      light: 'c8d9f645',
      diffuse: '042edb14',
      noworld: 'ef9ec765',
      nodiffuse: '38839bc9'
    }
  },
  q3dm10: {
    spots: 43,
    points: 2090,
    ob1: {
      grid: 'd5208f4b',
      sample: 'b8e7d693',
      light: 'dd3c6656',
      diffuse: 'be5c0691',
      noworld: 'b571c1db',
      nodiffuse: 'fdb42699'
    },
    ob0: {
      grid: 'faf915f8',
      sample: '7f6c78a3',
      light: '6392cb9f',
      diffuse: '301ef27f',
      noworld: 'f2b3fdc6',
      nodiffuse: 'b67c754f'
    }
  },
  q3dm11: {
    spots: 86,
    points: 2176,
    ob1: {
      grid: '762dfd64',
      sample: '042decde',
      light: '776cd854',
      diffuse: '1fb4495f',
      noworld: 'f0b0f6ec',
      nodiffuse: '03a696c2'
    },
    ob0: {
      grid: '7405f373',
      sample: '9566fa40',
      light: 'c6c63339',
      diffuse: 'e2a55a6d',
      noworld: 'd5e0330a',
      nodiffuse: '7345c223'
    }
  },
  q3dm12: {
    spots: 86,
    points: 2176,
    ob1: {
      grid: 'a3e564fa',
      sample: 'b360bc8f',
      light: '01096f76',
      diffuse: '5dbe1d4f',
      noworld: 'f0b0f6ec',
      nodiffuse: '03a696c2'
    },
    ob0: {
      grid: '03461957',
      sample: 'acdf7c1b',
      light: '79e57221',
      diffuse: '312e0f50',
      noworld: 'd5e0330a',
      nodiffuse: '7345c223'
    }
  },
  q3dm13: {
    spots: 58,
    points: 2119,
    ob1: {
      grid: '3325b7ba',
      sample: '2b87ef39',
      light: '766bb8f8',
      diffuse: 'c4c1e190',
      noworld: 'bee9d60b',
      nodiffuse: 'cce04724'
    },
    ob0: {
      grid: '96e9ec7a',
      sample: '44ef8f30',
      light: 'b5086997',
      diffuse: 'c5a253ed',
      noworld: 'b35e98a6',
      nodiffuse: '9154b110'
    }
  },
  q3dm14: {
    spots: 79,
    points: 2162,
    ob1: {
      grid: '7708b412',
      sample: 'b98b5b75',
      light: 'aa7cb8a5',
      diffuse: '34019171',
      noworld: 'b9a6f539',
      nodiffuse: 'ba195c9d'
    },
    ob0: {
      grid: '7067b2aa',
      sample: 'e589b677',
      light: '5f47bd01',
      diffuse: '2c1676c3',
      noworld: 'b2d37757',
      nodiffuse: 'caf775b4'
    }
  },
  q3dm15: {
    spots: 74,
    points: 2152,
    ob1: {
      grid: 'cb68eb39',
      sample: '7a27c479',
      light: '0c4f76ed',
      diffuse: '25643368',
      noworld: '66a0633c',
      nodiffuse: 'f1c96a85'
    },
    ob0: {
      grid: '199a53f8',
      sample: '7baec107',
      light: '034c4241',
      diffuse: '0a2f54f3',
      noworld: 'cc0799f6',
      nodiffuse: '74f4eac3'
    }
  },
  q3dm16: {
    spots: 60,
    points: 2123,
    ob1: {
      grid: '9de42aa1',
      sample: 'cf967990',
      light: '2ff52212',
      diffuse: '892b6191',
      noworld: '4ac86e85',
      nodiffuse: 'a2f1dd59'
    },
    ob0: {
      grid: 'e4d41c5d',
      sample: '4f8146b6',
      light: 'c07e105f',
      diffuse: '78ff4074',
      noworld: '8fbb602a',
      nodiffuse: '437ecdd1'
    }
  },
  q3dm17: {
    spots: 42,
    points: 2087,
    ob1: {
      grid: 'd427dc4f',
      sample: '736ba602',
      light: '8497a388',
      diffuse: 'f41a7931',
      noworld: '8d6e58d9',
      nodiffuse: '56fbc46a'
    },
    ob0: {
      grid: 'e441ae2e',
      sample: '9c27f742',
      light: 'cd8d68bf',
      diffuse: '61d356eb',
      noworld: 'b4bb22f4',
      nodiffuse: '5fd50806'
    }
  },
  q3dm18: {
    spots: 39,
    points: 2082,
    ob1: {
      grid: '6dbf41e7',
      sample: '0d7e2342',
      light: '672c55be',
      diffuse: 'f369c5a1',
      noworld: '08017de8',
      nodiffuse: 'cdc4bbc0'
    },
    ob0: {
      grid: '802eb954',
      sample: '9b7339a9',
      light: '954df24b',
      diffuse: '243078f2',
      noworld: 'e2f2eca9',
      nodiffuse: '08bc3195'
    }
  },
  q3dm19: {
    spots: 35,
    points: 2072,
    ob1: {
      grid: 'a67a6291',
      sample: 'b2a20828',
      light: '9b5567ed',
      diffuse: '80e06b7f',
      noworld: 'e176fac2',
      nodiffuse: '76bb0d64'
    },
    ob0: {
      grid: 'da9ef873',
      sample: '64f1671b',
      light: 'baa6f8e4',
      diffuse: 'c6345206',
      noworld: 'e3d9b49d',
      nodiffuse: 'fa34cd92'
    }
  },
  q3dm2: {
    spots: 35,
    points: 2074,
    ob1: {
      grid: '2f9bf942',
      sample: '85b41296',
      light: '3a1e4954',
      diffuse: '33544c44',
      noworld: '82bae207',
      nodiffuse: 'c6b6584b'
    },
    ob0: {
      grid: '61d20825',
      sample: 'c8b068e5',
      light: 'cf28959a',
      diffuse: '78a71693',
      noworld: 'f1124a35',
      nodiffuse: '11612464'
    }
  },
  q3dm3: {
    spots: 34,
    points: 2071,
    ob1: {
      grid: '739d5303',
      sample: 'be275058',
      light: '8ae921d8',
      diffuse: 'c0590f81',
      noworld: '1783bc41',
      nodiffuse: 'feb377f6'
    },
    ob0: {
      grid: 'ac4a6b43',
      sample: 'bade8c33',
      light: '4a28bb65',
      diffuse: 'edc4e9e5',
      noworld: '6a9a1d5a',
      nodiffuse: '3216c6e8'
    }
  },
  q3dm4: {
    spots: 28,
    points: 2059,
    ob1: {
      grid: '16d2adc7',
      sample: 'bec6e3a9',
      light: 'faf94b08',
      diffuse: 'e156a113',
      noworld: '85653f8b',
      nodiffuse: '93597aaf'
    },
    ob0: {
      grid: '42b63e21',
      sample: '350412ef',
      light: 'cd2d7dbf',
      diffuse: '511f6f22',
      noworld: '5bf4e045',
      nodiffuse: 'e2af3404'
    }
  },
  q3dm5: {
    spots: 34,
    points: 2071,
    ob1: {
      grid: '34b7adea',
      sample: '028dbc9a',
      light: 'cd6312b7',
      diffuse: 'fef7576c',
      noworld: '1783bc41',
      nodiffuse: 'feb377f6'
    },
    ob0: {
      grid: '057ebe20',
      sample: '838ff15e',
      light: '8124317b',
      diffuse: '8c5f5ddf',
      noworld: '6a9a1d5a',
      nodiffuse: '3216c6e8'
    }
  },
  q3dm6: {
    spots: 64,
    points: 2132,
    ob1: {
      grid: '218dd6b3',
      sample: 'a3fc6648',
      light: 'a4d72f93',
      diffuse: '021fd4cf',
      noworld: '087d8a3e',
      nodiffuse: 'c5a9a339'
    },
    ob0: {
      grid: 'ada7aa45',
      sample: '9c9a1469',
      light: '4bda8374',
      diffuse: '2c65e182',
      noworld: '9c176b69',
      nodiffuse: '8c5635e5'
    }
  },
  q3dm7: {
    spots: 82,
    points: 2168,
    ob1: {
      grid: 'cbaddaa2',
      sample: '64faf39c',
      light: '0648047c',
      diffuse: '2d96f65b',
      noworld: '2f85e83c',
      nodiffuse: '7a60dba5'
    },
    ob0: {
      grid: '29d80116',
      sample: '32f376f2',
      light: '2c3652a9',
      diffuse: 'e3624064',
      noworld: '4eca5bef',
      nodiffuse: '63d52178'
    }
  },
  q3dm8: {
    spots: 96,
    points: 2196,
    ob1: {
      grid: '54f1cd4f',
      sample: 'a10b1cf0',
      light: '59ca3292',
      diffuse: '3eb02676',
      noworld: '31734480',
      nodiffuse: '764e8272'
    },
    ob0: {
      grid: '73bd9232',
      sample: '8345cf82',
      light: 'ece7e752',
      diffuse: '4a72623b',
      noworld: 'e521dc50',
      nodiffuse: '33ca72f3'
    }
  },
  q3dm9: {
    spots: 72,
    points: 2147,
    ob1: {
      grid: 'c5580b4a',
      sample: '8c81685e',
      light: '23405728',
      diffuse: 'ea5decc6',
      noworld: '265817c2',
      nodiffuse: 'cd1bf225'
    },
    ob0: {
      grid: '37fdd528',
      sample: 'fc54313c',
      light: 'e85dc5ca',
      diffuse: '86994149',
      noworld: '7a75b190',
      nodiffuse: '92d23b5f'
    }
  },
  q3tourney1: {
    spots: 25,
    points: 2053,
    ob1: {
      grid: 'cfc15cf3',
      sample: 'b14ab1e3',
      light: 'e29bf578',
      diffuse: 'c02229c5',
      noworld: 'ebc90261',
      nodiffuse: 'd33d1376'
    },
    ob0: {
      grid: 'b0789614',
      sample: '31a7f351',
      light: '04ea062e',
      diffuse: '475875b0',
      noworld: 'ef9ec765',
      nodiffuse: '38839bc9'
    }
  },
  q3tourney2: {
    spots: 40,
    points: 2083,
    ob1: {
      grid: '49e181b3',
      sample: 'f9809713',
      light: '9e59ffcb',
      diffuse: '930a18fb',
      noworld: 'e8a6ea42',
      nodiffuse: 'a824f3db'
    },
    ob0: {
      grid: 'ebc09773',
      sample: '9a9f5117',
      light: '455d0f65',
      diffuse: '3ddd566e',
      noworld: '1b106d23',
      nodiffuse: '3a1fe3f8'
    }
  },
  q3tourney3: {
    spots: 30,
    points: 2063,
    ob1: {
      grid: '78af9fa5',
      sample: '716bb7d9',
      light: 'b88b5727',
      diffuse: '13913b1b',
      noworld: '6b4000de',
      nodiffuse: '87acc033'
    },
    ob0: {
      grid: '90fbce6a',
      sample: 'ab3b9682',
      light: '3c054b3f',
      diffuse: '486568e2',
      noworld: 'c71db6ea',
      nodiffuse: '5e54145b'
    }
  },
  q3tourney4: {
    spots: 36,
    points: 2076,
    ob1: {
      grid: '6f604e66',
      sample: '9490130e',
      light: '18a382d7',
      diffuse: '75c04fad',
      noworld: '07345b8b',
      nodiffuse: 'a4b263bf'
    },
    ob0: {
      grid: 'd59a77be',
      sample: '57b447c0',
      light: 'c7befc9b',
      diffuse: 'a713f2f9',
      noworld: '194d0259',
      nodiffuse: '847fe0d7'
    }
  },
  q3tourney5: {
    spots: 31,
    points: 2065,
    ob1: {
      grid: 'da7e18c6',
      sample: 'cbaba224',
      light: '3a4a96e3',
      diffuse: '21256bc7',
      noworld: 'ae334794',
      nodiffuse: 'de7c3967'
    },
    ob0: {
      grid: '462754fa',
      sample: '1a74d878',
      light: 'a4b9102c',
      diffuse: 'ddaaffd4',
      noworld: 'ab3028ec',
      nodiffuse: 'a7cb2c6a'
    }
  },
  q3tourney6: {
    spots: 31,
    points: 2064,
    ob1: {
      grid: '4144210b',
      sample: 'bb9d4dbd',
      light: '90fe35ea',
      diffuse: '37311cd2',
      noworld: 'e6285e89',
      nodiffuse: '6cf36393'
    },
    ob0: {
      grid: '88764711',
      sample: '0536d9c5',
      light: 'f21c351c',
      diffuse: '8263b7c3',
      noworld: '756e2023',
      nodiffuse: 'fecc132e'
    }
  },
  q3tourney6_ctf: {
    spots: 45,
    points: 2093,
    ob1: {
      grid: '0523ea29',
      sample: '424259dd',
      light: '74160016',
      diffuse: '9a018971',
      noworld: '22e68ad4',
      nodiffuse: 'e3c6e8cb'
    },
    ob0: {
      grid: '2a9f133e',
      sample: 'a018d02b',
      light: '288d8bb3',
      diffuse: 'df8c6bf6',
      noworld: '548876e6',
      nodiffuse: '4cd6ee52'
    }
  },
  test_bigbox: {
    spots: 1,
    points: 2004,
    ob1: {
      grid: '3eefb468',
      sample: '9372d76b',
      light: '00dc8b5d',
      diffuse: 'a473f356',
      noworld: '2e146cec',
      nodiffuse: '05732e02'
    },
    ob0: {
      grid: '635359dc',
      sample: 'eab20030',
      light: '14d19cc5',
      diffuse: '773f233c',
      noworld: '9f3340a0',
      nodiffuse: '888110ea'
    }
  }
};

const haveFullSet = Array.from({ length: 9 }, (_, i) => havePak(`pak${i}.pk3`)).every(Boolean);

describe.skipIf(!haveFullSet)('the light against the twin, over the 36 retail maps', () => {
  let corpora: Map<string, LightCorpus>;
  beforeAll(async () => {
    corpora = await retailMaps((bytes, path) => lightCorpus(parseBsp(bytes, path)));
  }, 120_000);

  it('loads, samples, lights and shades each map as the C does, to the bit', () => {
    expect(Object.fromEntries(corpora)).toEqual(TWIN);
  });
});
