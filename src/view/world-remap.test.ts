import { describe, expect, it } from 'vitest';

import { MST_TRIANGLE_SOUP } from '../formats/bsp';
import { readEntities } from '../formats/entity-text';
import { drawnShader, remapShader, shaderSwaps } from './world-remap';
import {
  DEFAULT_SHADER,
  LIGHTMAP_BY_VERTEX,
  LIGHTMAP_NONE,
  NO_MULTITEXTURE,
  loadWorldShaders,
  type ShaderSwap,
  type WorldShaders
} from './world-shaders';
import { surface, testBsp, testSources } from './world-test-fixtures';

const SCRIPTS = `
  textures/a/wall
  {
    {
      map $lightmap
    }
    {
      map textures/a/wall.tga
      blendFunc filter
    }
  }
  textures/a/lit
  {
    {
      map $lightmap
    }
    {
      map textures/a/glow.tga
      blendFunc filter
    }
  }
  textures/a/scared
  {
    cull bogus
    {
      map textures/a/scared.tga
    }
  }
  textures/a/drops
  {
    {
      map textures/a/wall.tga
      tcMod scroll 1 0
      tcMod scroll 1 0
      tcMod scroll 1 0
      tcMod scroll 1 0
      tcMod scroll 1 0
    }
  }
`;

const IMAGES = [
  'textures/a/wall.tga',
  'textures/a/glow.tga',
  'textures/a/scared.tga',
  'textures/a/ghost.tga'
];

/** The warning `textures/a/scared`'s parse gives. */
const SCARED_WARNING = "WARNING: invalid cull parm 'bogus' in shader 'textures/a/scared'\n";

/**
 * A map whose wall is lit by two pages, with a ghost lit by its vertices and a glow on page 0,
 * loaded with these swaps: the default, `wall` at 0 and 1, `ghost` and `glow` registered, in
 * that order.
 */
function load(swaps: ShaderSwap[] = []) {
  const sources = testSources(SCRIPTS, IMAGES);
  const bsp = testBsp({
    shaders: ['textures/a/wall', 'textures/a/ghost', 'textures/a/glow'],
    surfaces: [
      surface({ shaderNum: 0, lightmapNum: 0 }),
      surface({ shaderNum: 0, lightmapNum: 1 }),
      surface({ shaderNum: 1, surfaceType: MST_TRIANGLE_SOUP }),
      surface({ shaderNum: 2, lightmapNum: 0 })
    ],
    lightmaps: 2
  });
  const shaders = loadWorldShaders(bsp, sources, false, NO_MULTITEXTURE, swaps);
  const [fallback, wall0, wall1, ghost, glow] = shaders.shaders;
  const swap = (oldShader: string, newShader: string, timeOffset = ' 0.00') =>
    remapShader(shaders, oldShader, newShader, timeOffset, sources.warn);
  return { shaders, sources, fallback, wall0, wall1, ghost, glow, swap };
}

/** What each shader draws instead, by name and lightmap index, or null. */
function remaps(shaders: WorldShaders) {
  return shaders.shaders.map(({ remappedShader: to }) => to && [to.name, to.lightmapIndex]);
}

describe('shaderSwaps', () => {
  it('reads each entity with both names, the last of each key in any case, cut to 63', () => {
    const long = 'n'.repeat(70);
    const entities = readEntities(`
      { "classname" "worldspawn" }
      { "TargetShaderName" "a" "targetshadernewname" "b" "targetshadername" "c" }
      { "targetShaderName" "d" }
      { "targetShaderNewName" "e" }
      { "targetShaderName" "${long}" "targetShaderNewName" "f" }
    `);
    expect(shaderSwaps(entities)).toEqual([
      { oldShader: 'c', newShader: 'b' },
      { oldShader: 'n'.repeat(63), newShader: 'f' }
    ]);
  });
});

describe('the shaders a swap can draw', () => {
  it("makes a new name the map hasn't got at lightmap 0, unregistered until a swap asks", () => {
    const { shaders, sources, wall0, wall1, ghost, fallback, swap } = load([
      { oldShader: 'textures/a/wall', newShader: 'textures/a/lit' },
      { oldShader: 'textures/a/ghost', newShader: 'textures/a/scared' },
      { oldShader: 'textures/a/ghost', newShader: 'textures/a/scared.tga' }
    ]);
    const [lit, scared] = shaders.shaders.slice(5);
    expect([lit.name, lit.lightmapIndex]).toEqual(['textures/a/lit', 0]);
    // With no lightmap stage, it is kept at none.
    expect([scared.name, scared.lightmapIndex]).toEqual(['textures/a/scared', LIGHTMAP_NONE]);
    expect(shaders.shaders).toHaveLength(7);
    expect(shaders.swapTargets.get(wall0)).toEqual([lit]);
    expect(shaders.swapTargets.get(wall1)).toEqual([lit]);
    expect(shaders.swapTargets.get(ghost)).toEqual([scared]);

    // No name finds it, and its parse's warning waits for the swap.
    expect(shaders.findByName('textures/a/scared')).toBe(fallback);
    expect(shaders.variants('textures/a/scared')).toEqual([]);
    expect(sources.warnings).toEqual([]);

    swap('textures/a/ghost', 'textures/a/scared');
    expect(sources.warnings).toEqual([SCARED_WARNING]);
    expect(shaders.findByName('textures/a/scared')).toBe(scared);
    expect(drawnShader(ghost)).toBe(scared);
  });

  it('makes nothing for a swap of a name the map has not got, or to one it has', () => {
    const { shaders, wall0, glow } = load([
      { oldShader: 'gfx/2d/numbers/zero_32b', newShader: 'textures/a/lit' },
      { oldShader: 'textures/a/wall', newShader: 'textures/a/glow' },
      { oldShader: 'textures/a/wall', newShader: 'textures/a/wall' }
    ]);
    expect(shaders.shaders).toHaveLength(5);
    // A swap to its own name draws its last registered, which the wall at page 0 is not.
    expect(shaders.swapTargets.get(wall0)).toEqual([glow, shaders.shaders[2]]);
    expect(shaders.swapTargets.get(shaders.shaders[2])).toEqual([glow]);
  });

  it('makes nothing for a swap to an empty name, which finds the default alone', () => {
    const { shaders, ghost } = load([{ oldShader: 'textures/a/ghost', newShader: '' }]);
    expect(shaders.shaders).toHaveLength(5);
    expect(shaders.swapTargets.get(ghost)).toBeUndefined();
  });

  it("leaves the map's clouds alone for a sky made ahead", () => {
    const sources = testSources(
      `
      textures/a/sky
      {
        skyparms - 512 -
        {
          map textures/a/wall.tga
        }
      }
      textures/a/othersky
      {
        skyparms - 256 -
        {
          map textures/a/wall.tga
        }
      }
      `,
      IMAGES
    );
    const bsp = testBsp({
      shaders: ['textures/a/sky', 'textures/a/wall'],
      surfaces: [surface({ shaderNum: 0 }), surface({ shaderNum: 1 })]
    });
    const swaps = [{ oldShader: 'textures/a/wall', newShader: 'textures/a/othersky' }];
    const shaders = loadWorldShaders(bsp, sources, false, NO_MULTITEXTURE, swaps);
    expect(shaders.findByName('textures/a/othersky')).toBe(shaders.shaders[0]);
    expect(shaders.shaders.at(-1)!.name).toBe('textures/a/othersky');
    expect(shaders.cloudHeight).toBe(512);
  });

  it('leaves the drop of a new shader whose parse drops the map to the swap', () => {
    const { shaders, wall0, swap } = load([
      { oldShader: 'textures/a/wall', newShader: 'textures/a/drops' }
    ]);
    expect(shaders.shaders).toHaveLength(5);
    expect(shaders.swapTargets.get(wall0)).toBeUndefined();
    expect(() => swap('textures/a/wall', 'textures/a/drops')).toThrow(
      new Error("ERROR: too many tcMod stages in shader 'textures/a/drops'")
    );
  });
});

describe('remapShader', () => {
  it('swaps each lightmap variant of the old name for the new one, which keeps its page', () => {
    const { shaders, swap } = load();
    swap('textures/a/wall', 'textures/a/glow');
    expect(remaps(shaders)).toEqual([
      null,
      ['textures/a/glow', 0],
      ['textures/a/glow', 0],
      null,
      null
    ]);
  });

  it("registers a new name the map hasn't got at lightmap 0, made ahead or not", () => {
    const { shaders, wall1, swap } = load();
    swap('textures/a/wall', 'textures/a/lit');
    const lit = shaders.shaders[5];
    expect([lit.name, lit.lightmapIndex]).toEqual(['textures/a/lit', 0]);
    // The wall at page 1 samples page 0 now.
    expect(drawnShader(wall1)).toBe(lit);
  });

  it("swaps back to the old name's last registered, which the others then draw", () => {
    const { shaders, wall0, wall1, swap } = load();
    swap('textures/a/wall', 'textures/a/glow');
    swap('textures/a/wall', 'textures/a/wall', ' 2.50');
    expect(drawnShader(wall1)).toBe(wall1);
    expect(drawnShader(wall0)).toBe(wall1);
    expect(wall1.timeOffset).toBe(2.5);
    expect(remaps(shaders)[2]).toBeNull();
  });

  it("gives the new shader the swap's time, read as C's atof into a float", () => {
    const { glow, swap } = load();
    swap('textures/a/wall', 'textures/a/glow', ' 1.24');
    expect(glow.timeOffset).toBe(Math.fround(1.24));
    swap('textures/a/wall', 'textures/a/glow', 'x');
    expect(glow.timeOffset).toBe(0);
  });

  it('warns of an old name it cannot find or make, and changes nothing', () => {
    const { shaders, sources, swap } = load();
    swap('textures/a/none', 'textures/a/glow');
    expect(sources.warnings).toEqual([
      'WARNING: R_RemapShader: shader textures/a/none not found\n'
    ]);
    expect(remaps(shaders).every((to) => to === null)).toBe(true);
  });

  it('warns of a new name it cannot find, and draws its failed shader at the second swap', () => {
    const { shaders, sources, ghost, swap } = load();
    swap('textures/a/ghost', 'textures/a/missing');
    expect(sources.warnings).toEqual([
      'WARNING: R_RemapShader: new shader textures/a/missing not found\n'
    ]);
    expect(drawnShader(ghost)).toBe(ghost);

    // The first registered it, failed, and a name finds a failed shader as any other.
    swap('textures/a/ghost', 'textures/a/missing');
    const missing = shaders.findByName('textures/a/missing');
    expect([missing.name, missing.defaultShader, missing.stages]).toEqual([
      'textures/a/missing',
      true,
      []
    ]);
    expect(drawnShader(ghost)).toBe(missing);
    expect(sources.warnings).toHaveLength(1);
  });

  it('finds a name without its extension and in any case, and an empty one not at all', () => {
    const { shaders, sources, ghost, glow, swap } = load();
    swap('TEXTURES/A/GHOST.tga', 'textures/a/Glow.jpg');
    expect(drawnShader(ghost)).toBe(glow);
    swap('', 'textures/a/glow');
    expect(sources.warnings).toEqual(['WARNING: R_RemapShader: shader  not found\n']);
    expect(shaders.findByName('')).toBe(shaders.shaders[0]);
    expect(shaders.shaders[0].name).toBe(DEFAULT_SHADER);
  });

  it('refuses a name of 64 characters or more as RE_RegisterShaderLightMap does', () => {
    const { sources, swap } = load();
    const long = `textures/${'n'.repeat(55)}`;
    expect(long).toHaveLength(64);
    swap('textures/a/ghost', long);
    expect(sources.warnings).toEqual([
      'Shader name exceeds MAX_QPATH\n',
      `WARNING: R_RemapShader: new shader ${long} not found\n`
    ]);
  });

  it('sorts a shader a swap registers in among the rest', () => {
    const { shaders, swap } = load();
    swap('textures/a/ghost', 'textures/a/scared');
    const scared = shaders.findByName('textures/a/scared');
    expect(scared.lightmapIndex).toBe(LIGHTMAP_NONE);
    const order = [...shaders.shaders].sort((a, b) => a.sortedIndex - b.sortedIndex);
    expect(order.map((shader) => shader.sortedIndex)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(order.at(-1)).toBe(scared);
  });
});

describe('reset', () => {
  it('leaves the shaders as the load left them', () => {
    const { shaders, sources, wall0, ghost, fallback, swap } = load([
      { oldShader: 'textures/a/ghost', newShader: 'textures/a/scared' }
    ]);
    swap('textures/a/ghost', 'textures/a/scared', ' 3.00');
    swap('textures/a/wall', 'textures/a/missing');
    swap('textures/a/wall', 'textures/a/missing');
    expect(shaders.shaders).toHaveLength(7);

    shaders.reset();
    expect(shaders.shaders).toHaveLength(6);
    expect(remaps(shaders).every((to) => to === null)).toBe(true);
    expect(shaders.shaders.every((shader) => shader.timeOffset === 0)).toBe(true);
    expect(shaders.findByName('textures/a/scared')).toBe(fallback);
    expect(shaders.findByName('textures/a/missing')).toBe(fallback);
    expect(drawnShader(wall0)).toBe(wall0);

    // Made ahead again, its warning waits for the next swap to ask for it.
    sources.warnings.length = 0;
    swap('textures/a/ghost', 'textures/a/scared');
    expect(sources.warnings).toEqual([SCARED_WARNING]);
    expect(drawnShader(ghost)).toBe(shaders.shaders[5]);
    expect(ghost.lightmapIndex).toBe(LIGHTMAP_BY_VERTEX);
  });
});
