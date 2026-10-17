import { describe, expect, it } from 'vitest';

import { SS_BLEND0, SS_NEAREST, SS_OPAQUE } from '../formats/shader-script';
import { GT } from '../sim/constants';
import { ITEMS } from '../sim/items';
import { SceneShaders, type SceneShaderSources } from './scene-shaders';
import { surface, testBsp, testSources } from './world-test-fixtures';
import { LIGHTMAP_2D, LIGHTMAP_NONE, loadWorldShaders, type WorldShaders } from './world-shaders';

const SCRIPTS = `
  textures/a/water { { map w.tga blendFunc blend } }
  smokePuff { { map p.tga blendFunc blend } }
  shotgunSmokePuff { { map p.tga blendFunc blend } }
  rocketExplosion { { map r.tga blendFunc add } }
  viewBloodBlend { sort nearest { map b.tga blendFunc blend } }
  models/s/glow { { map g.tga blendFunc add } }
`;

const IMAGES = [
  'textures/a/wall.tga',
  'w.tga',
  'p.tga',
  'r.tga',
  'b.tga',
  'g.tga',
  'models/s/skin.tga',
  'models/s/lod.tga'
];

/** A map's registry: a lightmapped wall and a blended water. */
function worldShaders(): WorldShaders {
  const bsp = testBsp({
    shaders: ['textures/a/wall', 'textures/a/water'],
    surfaces: [0, 1].map((shaderNum) => surface({ shaderNum, lightmapNum: 0 })),
    lightmaps: 1
  });
  return loadWorldShaders(bsp, testSources(SCRIPTS, IMAGES));
}

/** Models and skins by path, each the shaders it names; none for a file the paks lack. */
function sources(files: Record<string, string[]>): SceneShaderSources & { read: string[] } {
  const read: string[] = [];
  const answer = async (path: string) => {
    read.push(path);
    return files[path] ?? null;
  };
  return { modelShaders: answer, skinShaders: answer, read };
}

/** A shader's place, by its name and index, once registered. */
function placeOf(scene: SceneShaders, name: string, index = LIGHTMAP_2D): number {
  return scene.place(scene.handle(name, index));
}

/** `CS_ITEMS` listing these classnames' slots. */
function itemsListing(...classnames: string[]): string {
  const listed = (slot: number) => slot > 0 && classnames.includes(ITEMS[slot].classname);
  return ITEMS.map((_, slot) => (listed(slot) ? '1' : '0')).join('');
}

describe('SceneShaders', () => {
  it('places every draw at 0 with no map bound', () => {
    expect(placeOf(new SceneShaders(), 'smokePuff')).toBe(0);
  });

  it("sorts cgame's shaders after the world's of their sort, by when each was registered", () => {
    const world = worldShaders();
    const scene = new SceneShaders();
    scene.bind(world);
    const wall = world.findByName('textures/a/wall');
    const water = world.findByName('textures/a/water');
    expect([wall.sort, water.sort]).toEqual([SS_OPAQUE, SS_BLEND0]);
    // A skin's opaque shader goes after the wall, and before the water, by its sort.
    const skin = placeOf(scene, 'models/s/skin', LIGHTMAP_NONE);
    expect(skin).toBeGreaterThan(wall.sortedIndex);
    expect(skin).toBeLessThan(water.sortedIndex);
    // An effect of the water's sort goes after it, whatever its depth: Q3 draws an explosion seen
    // through water over it, untinted.
    expect(placeOf(scene, 'rocketExplosion')).toBeGreaterThan(water.sortedIndex);
    // `sort nearest` after everything.
    const blood = placeOf(scene, 'viewBloodBlend');
    expect(world.shaders.find((shader) => shader.sortedIndex === blood)!.sort).toBe(SS_NEAREST);
    expect(blood).toBeGreaterThan(placeOf(scene, 'rocketExplosion'));
  });

  it('makes a name two shaders: one cgame registers by name, and a surface\'s or a skin\'s', () => {
    const scene = new SceneShaders();
    scene.bind(worldShaders());
    expect(scene.handle('Smokepuff.tga')).toBe(scene.handle('smokepuff'));
    const byName = scene.handle('smokePuff', LIGHTMAP_2D);
    expect(scene.handle('smokePuff', LIGHTMAP_NONE)).not.toBe(byName);
    expect(placeOf(scene, 'smokePuff', LIGHTMAP_NONE)).not.toBe(placeOf(scene, 'smokePuff'));
  });

  it("registers CG_RegisterGraphics' media in its order, before a shader first drawn", async () => {
    const scene = new SceneShaders();
    scene.bind(worldShaders());
    await scene.registerGraphics({ gametype: GT.FFA, items: '', models: [] }, sources({}));
    // An effect not on the map, registered as it is first drawn, after every one cgame had.
    const explosion = placeOf(scene, 'rocketExplosion');
    expect(placeOf(scene, 'smokePuff')).toBeLessThan(placeOf(scene, 'shotgunSmokePuff'));
    expect(placeOf(scene, 'shotgunSmokePuff')).toBeLessThan(explosion);
  });

  it("registers a listed weapon's media with its item, before shaders drawn later", async () => {
    const scene = new SceneShaders();
    scene.bind(worldShaders());
    const files = sources({});
    const items = itemsListing('weapon_rocketlauncher');
    await scene.registerGraphics({ gametype: GT.FFA, items, models: ['models/s/m2.md3'] }, files);
    const glow = placeOf(scene, 'models/s/glow');
    // The rocket launcher's explosion came with its item, so before a shader drawn later.
    expect(placeOf(scene, 'rocketExplosion')).toBeLessThan(glow);
    // Its models, its ammo's, its flash, barrel and hand, then the rocket, each coarsest first.
    const launcher = 'models/weapons2/rocketl/rocketl';
    expect(files.read).toEqual(
      expect.arrayContaining([
        `${launcher}_2.md3`,
        `${launcher}_1.md3`,
        `${launcher}.md3`,
        `${launcher}_flash.md3`,
        `${launcher}_barrel.md3`,
        `${launcher}_hand.md3`,
        'models/weapons2/shotgun/shotgun_hand.md3',
        'models/ammo/rocket/rocket.md3',
        'models/s/m2.md3'
      ])
    );
    const at = (path: string) => files.read.indexOf(path);
    expect(at(`${launcher}_2.md3`)).toBeLessThan(at(`${launcher}.md3`));
    expect(at(`${launcher}_hand.md3`)).toBeLessThan(at('models/weapons2/shotgun/shotgun_hand.md3'));
    // The server's models last.
    expect(files.read.at(-3)).toBe('models/s/m2_2.md3');
    expect(files.read.at(-1)).toBe('models/s/m2.md3');
  });

  it("registers a model's shaders at LIGHTMAP_NONE, its coarsest detail first", async () => {
    const scene = new SceneShaders();
    const world = worldShaders();
    scene.bind(world);
    const files = sources({
      'models/s/thing_1.md3': ['models/s/lod'],
      'models/s/thing.md3': ['models/s/skin']
    });
    expect(await scene.registerModel('models/s/thing.md3', files)).toBe(true);
    expect(await scene.registerModel('models/s/none.md3', files)).toBe(false);
    expect(await scene.registerModel('*3', files)).toBe(false);
    const lod = world.variants('models/s/lod')[0];
    const skin = world.variants('models/s/skin')[0];
    expect([lod.lightmapIndex, skin.lightmapIndex]).toEqual([LIGHTMAP_NONE, LIGHTMAP_NONE]);
    expect(lod.index).toBeLessThan(skin.index);
  });

  it("registers a look's models, then its skins, and a skin not a file as its shader", async () => {
    const scene = new SceneShaders();
    const world = worldShaders();
    scene.bind(world);
    const files = sources({
      'models/players/s/lower.md3': ['models/s/lod'],
      'models/players/s/lower_default.skin': ['models/s/skin']
    });
    await scene.registerLook(
      { models: ['models/players/s/lower.md3'], skins: ['models/players/s/lower_default.skin'] },
      files
    );
    expect(world.variants('models/s/lod')[0].index).toBeLessThan(
      world.variants('models/s/skin')[0].index
    );
    await scene.registerSkin('models/s/glow', files);
    expect(world.variants('models/s/glow')[0].lightmapIndex).toBe(LIGHTMAP_NONE);
  });

  it("registers Capture the Flag's flags, and a team game's, only in those games", async () => {
    const read = async (gametype: number) => {
      const scene = new SceneShaders();
      scene.bind(worldShaders());
      const files = sources({});
      await scene.registerGraphics({ gametype, items: '', models: [] }, files);
      return files.read;
    };
    expect(await read(GT.FFA)).not.toContain('models/flags/r_flag.md3');
    expect(await read(GT.CTF)).toContain('models/flags/r_flag.md3');
  });

  it('finds each shader again in the next registry bound, and counts a change of place', () => {
    const scene = new SceneShaders();
    const first = worldShaders();
    scene.bind(first);
    const handle = scene.handle('smokePuff');
    scene.place(handle);
    expect(handle.shader).toBe(first.variants('smokePuff')[0]);
    const before = scene.generation;
    const second = worldShaders();
    scene.bind(second);
    expect(scene.generation).not.toBe(before);
    scene.place(handle);
    expect(handle.shader).toBe(second.variants('smokePuff')[0]);
    const placed = scene.generation;
    placeOf(scene, 'rocketExplosion');
    // A shader sorted in may have moved every place after it.
    expect(scene.generation).not.toBe(placed);
  });
});
