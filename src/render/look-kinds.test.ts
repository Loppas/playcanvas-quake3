// @vitest-environment jsdom
import { Entity, type AppBase, type MeshInstance, type StandardMaterial } from 'playcanvas';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AssetLibrary } from '../formats/asset-library';
import { buildMd3 } from '../formats/md3-test-fixtures';
import { findShader } from '../formats/shader-script';
import { SceneShaders } from '../view/scene-shaders';
import { LIGHTMAP_2D } from '../view/world-shaders';
import { createTestApp } from './engine-test-fixtures';
import { kindShaders, stageKind, warmLookKinds } from './look-kinds';
import { BLENDED_CHILD } from './md3-mesh';
import type { PlayerRigOptions } from './player-rig';
import { encode, whiteTga } from './player-test-fixtures';
import { SceneDraws, sceneDraw } from './scene-draws';
import { skinShaderStages } from './skin-material';
import { buildStagedModel } from './staged-model';
import { TextureCache } from './texture-cache';
import { warmUp } from './warm-up';
import { WHITE_IMAGE_PATH } from './white-image';

/**
 * Every kind of stage the paks' looks draw, and the warm-up's stand-in for them, on the null
 * device: skins of the retail shapes, and one stage a keyword away from another for each thing
 * that sets a kind apart.
 */

const SHADERS = `
models/test/xaero
{
  { map $whiteimage rgbGen lightingDiffuse }
  { map models/test/a.tga blendFunc GL_DST_COLOR GL_SRC_ALPHA rgbGen identity
    alphaGen lightingSpecular }
}
models/test/xian
{
  { map $whiteimage rgbGen lightingDiffuse }
  { map models/test/b.tga blendFunc GL_DST_COLOR GL_SRC_ALPHA rgbGen identity
    alphaGen lightingSpecular }
}
models/test/mirror
{
  { map models/test/a.tga tcGen environment rgbGen lightingDiffuse }
}
models/test/scroll
{
  { map models/test/a.tga blendFunc add tcMod scroll 1 0
    }
}
models/test/glide
{
  { map models/test/b.tga blendFunc add rgbGen wave sin 0 1 0 1 tcMod scroll 0.5 2
    }
}
models/test/cutout
{
  cull none
  { map models/test/a.tga alphaFunc GE128 rgbGen lightingDiffuse }
}
models/test/missing
{
  { map models/test/none.tga rgbGen lightingDiffuse }
}
models/test/base { { map models/test/a.tga } }
models/test/added { { map models/test/a.tga blendFunc add } }
models/test/shone { { map models/test/a.tga blendFunc GL_DST_COLOR GL_SRC_ALPHA } }
models/test/brightened { { map models/test/a.tga blendFunc GL_DST_COLOR GL_ONE } }
models/test/tested { { map models/test/a.tga alphaFunc GE128 } }
models/test/lit { { map models/test/a.tga rgbGen lightingDiffuse } }
models/test/shiny { { map models/test/a.tga alphaGen lightingSpecular } }
models/test/mirrored { { map models/test/a.tga tcGen environment } }
models/test/moved
{
  { map models/test/a.tga tcMod scale 2 2
    }
}
models/test/twosided { cull none { map models/test/a.tga } }
models/test/waved { deformVertexes wave 100 sin 0 1 0 1 { map models/test/a.tga } }
models/test/bent { deformVertexes normal 0.5 2 { map models/test/a.tga } }
models/test/depth { { map models/test/a.tga blendFunc add depthWrite } }
models/test/overopaque { { map models/test/a.tga } { map models/test/a.tga blendFunc add } }
models/test/overadded
{
  { map models/test/a.tga blendFunc add }
  { map models/test/a.tga blendFunc add }
}
`;

/** A square, as the skins wear in the tests that draw them. */
const SQUARE = 'models/test/square.md3';

let app: AppBase;
let library: AssetLibrary;
let cache: TextureCache;

/** Every image but `models/test/none.tga` is in the paks. */
const hasImage = (name: string) => library.resolveImage(name) !== undefined;

beforeEach(() => {
  ({ app } = createTestApp());
  library = new AssetLibrary(
    new Map([
      ['scripts/models.shader', encode(SHADERS)],
      ['models/test/a.tga', whiteTga()],
      ['models/test/b.tga', whiteTga()],
      [
        SQUARE,
        buildMd3({
          surfaces: [
            {
              name: 'square',
              positions: () => [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0],
              indices: [0, 1, 2, 0, 2, 3]
            }
          ]
        })
      ]
    ])
  );
  cache = new TextureCache(app.graphicsDevice);
});

afterEach(() => {
  app.destroy();
});

/** A model's draws: its own, and its blended child's where it has one. */
function drawsOf(entity: Entity): MeshInstance[] {
  const blended = entity.findByName(BLENDED_CHILD) as Entity | null;
  return [entity, ...(blended ? [blended] : [])].flatMap((drawn) => drawn.render!.meshInstances);
}

/** The kind of a shader's stage, with every image there unless told. */
function kind(name: string, stage = 0, images: (name: string) => boolean = () => true): string {
  const shader = findShader(library.shaders, name)!;
  return stageKind(shader, shader.stages[stage], images);
}

describe('stageKind', () => {
  it('leaves out what only feeds the shader: its images, numbers and colours', () => {
    expect(kind('models/test/xian', 1)).toBe(kind('models/test/xaero', 1));
    expect(kind('models/test/glide')).toBe(kind('models/test/scroll'));
  });

  it('sets apart each thing that changes the shader or the pipeline', () => {
    const apart = [
      kind('models/test/base'),
      kind('models/test/added'),
      kind('models/test/shone'),
      kind('models/test/brightened'),
      kind('models/test/tested'),
      kind('models/test/lit'),
      kind('models/test/shiny'),
      kind('models/test/mirrored'),
      kind('models/test/moved'),
      kind('models/test/twosided'),
      kind('models/test/waved'),
      kind('models/test/bent'),
      kind('models/test/depth'),
      kind('models/test/base', 0, () => false)
    ];
    expect(new Set(apart).size).toBe(apart.length);
    // A fog dims a blended stage only where the first stage blends too.
    expect(kind('models/test/overopaque', 1)).not.toBe(kind('models/test/overadded', 1));
  });

  it("draws the white image as an image, and Q3's default shader as a lit stage", () => {
    expect(kind('models/test/xaero', 0, () => false)).toBe(kind('models/test/lit'));
    const { shader, stages } = skinShaderStages(library.shaders, 'models/test/a.tga');
    expect(stageKind(shader, stages[0], () => true)).toBe(kind('models/test/lit'));
  });
});

describe('kindShaders', () => {
  it('picks the first shader of each kind, in the order given, each once', () => {
    const picked = kindShaders(
      library.shaders,
      [
        'models/test/xaero',
        'models/test/xian',
        'models/test/scroll',
        'models/test/xaero',
        'models/test/glide',
        'models/test/lit',
        'models/test/mirror'
      ],
      hasImage
    );
    // xian's kinds are xaero's, glide's scroll's, and lit's xaero's lit white base.
    expect(picked).toEqual(['models/test/xaero', 'models/test/scroll', 'models/test/mirror']);
  });

  it("takes a name with no script as Q3's default shader, an image's or none", () => {
    const names = ['models/test/a.tga', 'models/test/lit', ''];
    expect(kindShaders(library.shaders, names, hasImage)).toEqual(['models/test/a.tga', '']);
  });
});

describe('warmLookKinds', () => {
  /** Every shader of the retail shapes, and an image the paks lack. */
  const LOOKS = [
    'models/test/xaero',
    'models/test/mirror',
    'models/test/scroll',
    'models/test/cutout',
    'models/test/missing',
    'models/test/a.tga',
    ''
  ];

  /** A body wearing `shader` on the square, its images as the paks have them, shown. */
  const wear = async (shader: string) => {
    const scope = cache.scope();
    const model = library.model(SQUARE);
    const part = await buildStagedModel(app, library, scope, shader, model, () => shader, {}, []);
    app.root.addChild(part.entity);
    return { part, scope };
  };

  /** The stand-in for {@link LOOKS}, drawn where `options` says. */
  const build = (options: PlayerRigOptions = {}) =>
    warmLookKinds(app, library.shaders, cache, LOOKS, hasImage, options);

  it('draws every kind the skins name, so that a look drawn after it makes no shader', async () => {
    const shaders = app.graphicsDevice.shaders;
    const before = shaders.length;
    warmUp(app, [await build()]);
    const made = shaders.length;
    expect(made).toBeGreaterThan(before);

    (app.root.findByName('camera') as Entity).camera!.frustumCulling = false;
    for (const name of LOOKS) {
      const { part, scope } = await wear(name);
      app.render();
      part.entity.destroy();
      scope.dispose();
    }
    expect(shaders.length).toBe(made);
  });

  it('builds the stand-in hidden, shows it for the warm-up, and gives it all back', async () => {
    const before = app.root.children.length;
    const warmed = await build();
    const standIn = app.root.children[before] as Entity;
    expect([app.root.children.length, standIn.enabled]).toEqual([before + 1, false]);
    // A surface of each kind's first shader, every image white: none at all where the paks lack it.
    const maps = drawsOf(standIn).map(
      (draw) => (draw.material as StandardMaterial).emissiveMap?.name
    );
    expect(maps).toEqual([...new Array<string>(5).fill(WHITE_IMAGE_PATH), undefined]);

    warmed.at(0);
    expect(standIn.enabled).toBe(true);
    warmed.end();
    expect(app.root.children).toHaveLength(before);
    expect(cache.size).toBe(0);
  });

  it("sorts as Q3's default shader in a map's scene, naming none of the skins'", async () => {
    const shaders = new SceneShaders();
    const scene = new SceneDraws(shaders, { models: [], effects: [], gun: [], screen: [] });
    const before = app.root.children.length;
    await build({ scene });
    const standIn = app.root.children[before] as Entity;
    const tags = drawsOf(standIn).map((draw) => sceneDraw(draw)!);
    // Six stages of five shaders, and a fog pass each.
    expect(tags).toHaveLength(11);
    for (const tag of tags) expect(tag.shader).toBe(shaders.handle('', LIGHTMAP_2D));
  });
});
