// @vitest-environment jsdom
import {
  Entity,
  Layer,
  Vec3,
  type AppBase,
  StandardMaterial,
  type BoundingBox,
  type MeshInstance
} from 'playcanvas';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AssetLibrary } from '../formats/asset-library';
import { buildMd3 } from '../formats/md3-test-fixtures';
import { SUN_DIRECTION, lightInEntityFrame } from '../view/entity-light';
import { CLASSIC_FULLSCREEN, setRendererStyle } from '../view/overbright';
import type { FrameBlend } from '../view/player-animation';
import type { Rgb } from '../view/player-color';
import type { Placement } from '../view/player-pose';
import { SceneShaders } from '../view/scene-shaders';
import { modelStep } from '../view/scene-sort';
import { LIGHTMAP_NONE } from '../view/world-shaders';
import { deformView } from './deform-view';
import { ORDER_STEP } from './draw-order';
import { IDENTITY_PIECE, createTestApp, expectClose, held, uniform } from './engine-test-fixtures';
import { FOG_UNIFORM } from './fog-chunks';
import { BLENDED_CHILD } from './md3-mesh';
import { DEFORM_AUTOSPRITE, DEFORM_SLOTS, DEFORM_WAVE, writeDeforms, writeView } from './model-chunks';
import { frameTexture, quadReach, stampMesh, surfaceMesh } from './model-frames';
import { encode, whiteTga } from './player-test-fixtures';
import { SceneDraws, sceneDraw } from './scene-draws';
import type { SkinStage } from './skin-material';
import { setFramebuffer } from './stage-gain';
import {
  buildStagedModel,
  copyStagedModel,
  drawOwnSurfaces,
  drawPlacedModel,
  drawStagedModel,
  lightInEntity,
  playStagedStages,
  tintStagedModel,
  type StagedModel
} from './staged-model';
import { TextureCache } from './texture-cache';

/**
 * Skins on the null device, as a model draws them each frame:
 * - one that shines: a lit white base, and a texture over it that multiplies it by
 *   `GL_DST_COLOR GL_SRC_ALPHA` with `alphaGen lightingSpecular`, as razor's patriot does;
 * - one that mirrors by `tcGen environment`, as patriot's goggles do;
 * - one that ripples and mirrors, whose two sets of moving coordinates take a mesh each;
 * - one that takes the entity's colour, as the railgun's glow does, and one lit and scrolling;
 * - ones that swell and wobble by `deformVertexes wave`, and one that bends its normals, bulges
 *   and moves;
 * - one stamped as a square facing the viewer and lit, as Slash's skates are, and one pivoting
 *   to face it and flickering, as the jets' flames do.
 */

const SHADERS = `
models/test/shine
{
  { map $whiteimage rgbGen lightingDiffuse }
  { map models/test/shine.tga blendFunc GL_DST_COLOR GL_SRC_ALPHA rgbGen identity
    alphaGen lightingSpecular }
}
models/test/mirror
{
  { map models/test/shine.tga tcGen environment blendFunc GL_ONE GL_ZERO rgbGen lightingDiffuse }
}
models/test/ripple
{
  { map models/test/shine.tga tcMod turb 0 .25 0 1.6
    }
  { map models/test/shine.tga blendFunc add tcGen environment }
  { map models/test/shine.tga blendFunc add }
}
models/test/tint
{
  { map models/test/shine.tga blendFunc add rgbGen entity }
}
models/test/glide
{
  { map models/test/shine.tga rgbGen lightingDiffuse tcMod scroll 1 0
    }
}
models/test/tiled
{
  { map models/test/shine.tga blendFunc add tcMod scale 2 3
    }
}
models/test/swell
{
  deformVertexes wave 100 sin 3 0 0 0
  { map models/test/shine.tga blendFunc add tcGen environment }
}
models/test/wobble
{
  deformVertexes wave 300 sin 0 2 0 0.5
  { map models/test/shine.tga blendFunc add }
}
models/test/drift
{
  deformVertexes normal 0.5 2
  deformVertexes bulge 3 10 1
  deformVertexes move 0 0 .7 sin 0 5 0 0.2
  { map models/test/shine.tga tcGen environment blendFunc GL_ONE GL_ZERO rgbGen lightingDiffuse }
}
models/test/darken
{
  { map models/test/shine.tga blendFunc filter rgbGen lightingDiffuse }
}
models/test/stamp
{
  deformVertexes autosprite
  { map models/test/shine.tga rgbGen lightingDiffuse }
}
models/test/jet
{
  deformVertexes autoSprite2
  deformVertexes wave 100 sin 0 1 0 9
  { map models/test/shine.tga blendFunc add }
}
models/test/glow
{
  { map models/test/shine.tga blendFunc add }
  { map models/test/shine.tga blendFunc blend }
  { map models/test/shine.tga blendFunc filter }
}
`;

/** A strip 8 wide and 64 tall in the x-z plane, drawn as a fan. */
const QUAD = 'models/test/quad.md3';

/** Two triangles, one after the other. */
const PAIR = 'models/test/pair.md3';

/** The ripple's `tcMod turb`. */
const RIPPLE = { func: 'sin', base: 0, amplitude: 0.25, phase: 0, frequency: 1.6 } as const;

/** At the origin, unturned, on its first frame. */
const POSE: Placement & FrameBlend = {
  origin: [0, 0, 0],
  axis: [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1]
  ],
  frame: 0,
  oldFrame: 0,
  backlerp: 0
};

let app: AppBase;
let library: AssetLibrary;

beforeEach(() => {
  ({ app } = createTestApp());
  library = new AssetLibrary(
    new Map([
      ['scripts/models.shader', encode(SHADERS)],
      ['models/test/shine.tga', whiteTga()],
      // One triangle at the origin, its normals up.
      ['models/test/shine.md3', buildMd3({ surfaces: [{ name: 'body' }] })],
      [PAIR, buildMd3({ surfaces: [{ name: 'near' }, { name: 'far' }] })],
      [
        QUAD,
        buildMd3({
          surfaces: [
            {
              name: 'strip',
              positions: () => [-4, 0, 0, 4, 0, 0, 4, 0, 64, -4, 0, 64],
              indices: [0, 1, 2, 0, 2, 3]
            }
          ]
        })
      ]
    ])
  );
});

afterEach(() => {
  app.destroy();
});

/**
 * A test model wearing `shader`, hung from a parent turned and scaled, as a body hangs from the
 * Quake frame's root.
 *
 * @param animated - Collects the stages to play every frame.
 * @param path - The model: the triangle unless told.
 */
async function wear(
  shader: string,
  animated: SkinStage[] = [],
  path = 'models/test/shine.md3'
): Promise<StagedModel> {
  const staged = await buildStagedModel(
    app,
    library,
    new TextureCache(app.graphicsDevice).scope(),
    'test',
    library.model(path),
    () => shader,
    {},
    animated
  );
  const root = new Entity('root');
  root.setLocalEulerAngles(-90, 30, 0);
  root.setLocalScale(0.025, 0.025, 0.025);
  root.addChild(staged.entity);
  app.root.addChild(root);
  return staged;
}

/** A viewer at a point in a model's own frame. */
function seenFrom(staged: StagedModel, point: readonly number[]): Entity {
  const viewer = new Entity('viewer');
  viewer.setPosition(staged.entity.getWorldTransform().transformPoint(new Vec3(point[0], point[1], point[2])));
  return viewer;
}

/** A camera at `position` in the world, looking at `target`, off every axis of the test's. */
function camera(position = [3, 1, 2], target = [0, 0.5, 0]): Entity {
  const entity = new Entity('camera');
  entity.setPosition(position[0], position[1], position[2]);
  entity.lookAt(target[0], target[1], target[2]);
  return entity;
}

/** The bounds a draw is culled by, where it has its own. */
function cullBounds(instance: MeshInstance): BoundingBox | null {
  return (instance as unknown as { _customAabb: BoundingBox | null })._customAabb;
}

describe('lightInEntity', () => {
  it("takes the light into an entity's own frame, as lightInEntityFrame does by its axis", () => {
    // The Quake frame's root, and under it a model turned 90° left.
    const root = new Entity('root');
    root.setLocalEulerAngles(-90, 0, 0);
    const turned = new Entity('turned');
    turned.setLocalEulerAngles(0, 0, 90);
    root.addChild(turned);
    app.root.addChild(root);
    const turnedLeft = [
      [0, 1, 0],
      [-1, 0, 0],
      [0, 0, 1]
    ];
    // Not the sun's, so the light's own direction is what turns.
    const light = { ambient: [91, 40, 10], directed: [75, 150, 0], direction: [0.6, 0, 0.8] } as const;

    const drawn = lightInEntity(turned, light);
    expectClose(drawn.direction, lightInEntityFrame(turnedLeft, light).direction);
    // Only the direction turns.
    expect(drawn.ambient).toEqual(light.ambient);
    expect(drawn.directed).toEqual(light.directed);
    // The splat map's own light by default: the sun, which the unturned root sees where it is.
    expectClose(lightInEntity(root).direction, SUN_DIRECTION);
  });
});

describe('drawStagedModel', () => {

  it("draws every stage from the surface's one mesh and frames, each stage with its own parts", async () => {
    const staged = await wear('models/test/shine');
    const surface = library.model('models/test/shine.md3').surfaces[0];
    const instances = staged.entity.render!.meshInstances;
    expect(instances).toHaveLength(2);
    for (const instance of instances) {
      expect(instance.mesh).toBe(surfaceMesh(app.graphicsDevice, surface));
      expect(held(instance, 'q3_frames')).toBe(frameTexture(app.graphicsDevice, surface));
    }
    const [base, shine] = instances.map((instance) => (instance.material as StandardMaterial).defines);
    expect([base.get('Q3_LIT'), base.has('Q3_SPECULAR')]).toEqual([true, false]);
    expect([shine.has('Q3_LIT'), shine.get('Q3_SPECULAR')]).toEqual([false, true]);
    // Another model of the same surface draws the same mesh.
    const other = await wear('models/test/mirror');
    expect(other.entity.render!.meshInstances[0].mesh).toBe(instances[0].mesh);
    expect((other.entity.render!.meshInstances[0].material as StandardMaterial).defines.get('Q3_TCGEN_ENV')).toBe(true);
  });

  it("sets what a frame draws: its frames, the light, and the viewer in the model's frame", async () => {
    const staged = await wear('models/test/shine');
    const [instance] = staged.entity.render!.meshInstances;
    drawStagedModel(staged, POSE, 0, seenFrom(staged, [0, 0, 64]));
    expect(uniform(instance, 'q3_anim')).toEqual([0, 0, 0, 3]);
    const light = lightInEntityFrame(POSE.axis);
    // The shade's scale in the directed light's w: on screen, 1 at the default overbright.
    expectClose(uniform(instance, 'q3_light[0]'), [
      ...light.ambient,
      0,
      ...light.directed,
      1,
      ...light.direction,
      0
    ]);
    expectClose(uniform(instance, 'q3_viewer'), [0, 0, 64, 1]);
    // No deform, so none packed.
    expect(uniform(instance, 'q3_deform[0]')).toEqual(new Array(DEFORM_SLOTS * 8).fill(0));
    // With no viewer, none: no highlight, and a mirror's own coordinates.
    drawStagedModel(staged, POSE, 0);
    expect(uniform(instance, 'q3_viewer')).toEqual([0, 0, 0, 0]);
    // A frame the model lacks draws frame 0, as `R_AddMD3Surfaces` has it.
    drawStagedModel(staged, { ...POSE, oldFrame: 0, frame: 5, backlerp: 0.5 }, 0);
    expect(uniform(instance, 'q3_anim')).toEqual([0, 0, 0.5, 3]);
  });

  it('tells a lit model where the viewer is under opengl2, which lights it per pixel, but not as fastLight', async () => {
    try {
      // An image with no script: one lit stage.
      setRendererStyle({ renderer: 'opengl2', overBrightBits: 1 });
      const pixel = await wear('models/test/plain.tga');
      const [instance] = pixel.entity.render!.meshInstances;
      expect((instance.material as StandardMaterial).defines.get('Q3_LIGHTALL')).toBe(true);
      drawStagedModel(pixel, POSE, 0, seenFrom(pixel, [0, 0, 64]));
      expectClose(uniform(instance, 'q3_viewer'), [0, 0, 64, 1]);

      setRendererStyle({ renderer: 'opengl2', overBrightBits: 1, normalMapping: false, specularMapping: false });
      const vertex = await wear('models/test/plain.tga');
      drawStagedModel(vertex, POSE, 0, seenFrom(vertex, [0, 0, 64]));
      expect(uniform(vertex.entity.render!.meshInstances[0], 'q3_viewer')).toEqual([0, 0, 0, 0]);
    } finally {
      setRendererStyle(CLASSIC_FULLSCREEN);
    }
  });

  it("brightens a lit stage that multiplies colour as its renderer does, drawn still or played", async () => {
    const emissive = (staged: StagedModel) =>
      (staged.entity.render!.meshInstances[0].material as StandardMaterial).emissive.r;
    // Under opengl1 the ramp brightens what is drawn, not what a filter multiplies it by.
    const darken = await wear('models/test/darken');
    expect([emissive(await wear('models/test/plain.tga')), emissive(darken)]).toEqual([2, 1]);
    try {
      // opengl2 gives the light no overbright factor instead (tr_shade.c:572–581).
      setRendererStyle({ renderer: 'opengl2', overBrightBits: 1 });
      const modern = await wear('models/test/darken');
      expect(emissive(modern)).toBe(2);
      const { defines } = modern.entity.render!.meshInstances[0].material as StandardMaterial;
      expect(defines.get('Q3_LIT_MULTIPLIES')).toBe(true);
    } finally {
      setRendererStyle(CLASSIC_FULLSCREEN);
    }
  });

  it('gives a model that only mirrors the viewer too', async () => {
    const staged = await wear('models/test/mirror');
    drawStagedModel(staged, POSE, 0, seenFrom(staged, [0, 0, 64]));
    expectClose(uniform(staged.entity.render!.meshInstances[0], 'q3_viewer'), [0, 0, 64, 1]);
  });

  it('sets a coloured light as given, for a model where it already sits', async () => {
    const staged = await wear('models/test/mirror');
    staged.entity.setLocalPosition(5, 0, 0);
    const light = { ambient: [91, 40, 10], directed: [75, 150, 0], direction: [0, 0, 1] } as const;
    drawPlacedModel(staged, { oldFrame: 0, frame: 0, backlerp: 0 }, light, 0);
    expect(staged.entity.getLocalPosition().x).toBe(5);
    expect(uniform(staged.entity.render!.meshInstances[0], 'q3_light[0]')).toEqual([
      91, 40, 10, 0, 75, 150, 0, 1, 0, 0, 1, 0
    ]);
  });

  it("scales a lit model's shade by the overbright on screen, not in the framebuffer", async () => {
    try {
      setRendererStyle({ renderer: 'opengl1', overBrightBits: 2 });
      const staged = await wear('models/test/shine');
      const [instance] = staged.entity.render!.meshInstances;
      drawStagedModel(staged, POSE, 0);
      // The ramp's factor of 4 over the light's headroom of 2.
      expect(uniform(instance, 'q3_light[0]')[7]).toBe(2);
      setFramebuffer(staged.lit!, true);
      drawStagedModel(staged, POSE, 0);
      expect(uniform(instance, 'q3_light[0]')[7]).toBe(1);
    } finally {
      setRendererStyle(CLASSIC_FULLSCREEN);
    }
  });

  it("moves a deform and a ripple on the stages' clock, and grows the bounds as far as a deform pushes", async () => {
    const wobble = await wear('models/test/wobble');
    const [instance] = wobble.entity.render!.meshInstances;
    // `wave 300 sin 0 2 0 0.5`, half a second in: a quarter turn.
    drawStagedModel(wobble, POSE, 0.5);
    expectClose(uniform(instance, 'q3_deform[0]').slice(0, 8), [DEFORM_WAVE, 0, 1 / 300, 0, 0, 2, 0.25, 0]);
    const bounds = (instance as unknown as { _customAabb: BoundingBox })._customAabb;
    const own = instance.mesh!.aabb.halfExtents;
    expectClose(bounds.halfExtents.toArray(), [own.x + 2, own.y + 2, own.z + 2]);
    // `wave 100 sin 3 0 0 0` stands every vertex 3 off, with no amplitude at all.
    const swell = await wear('models/test/swell');
    const swollen = (swell.entity.render!.meshInstances[0] as unknown as { _customAabb: BoundingBox })._customAabb;
    expectClose(swollen.halfExtents.toArray(), [own.x + 3, own.y + 3, own.z + 3]);

    // Every other kind packed as writeDeforms packs it; the normal brings the noise in; the bulge
    // reaches 10 and the move 0.7 · 5.
    const drift = await wear('models/test/drift');
    const [drifting] = drift.entity.render!.meshInstances;
    drawStagedModel(drift, POSE, 1.3);
    const packed = new Float32Array(24);
    writeDeforms(library.shaders.get('models/test/drift')!.deforms, 1.3, packed);
    expect(uniform(drifting, 'q3_deform[0]')).toEqual([...packed]);
    expect((drifting.material as StandardMaterial).defines.get('Q3_DEFORM_NOISE')).toBe(true);
    const drifted = (drifting as unknown as { _customAabb: BoundingBox })._customAabb;
    expectClose(drifted.halfExtents.toArray(), [own.x + 13.5, own.y + 13.5, own.z + 13.5]);
    expect((instance.material as StandardMaterial).defines.has('Q3_DEFORM_NOISE')).toBe(false);

    const ripple = await wear('models/test/ripple');
    drawStagedModel(ripple, POSE, 0.25);
    const [turbulent, , plain] = ripple.entity.render!.meshInstances;
    // One turb, its amplitude and phase now, between pieces that move nothing.
    expectClose(uniform(turbulent, 'q3_coords[0]').slice(0, 16), [1, 0, 0, 0, ...IDENTITY_PIECE, RIPPLE.amplitude, 0.4, 0, 0]);
    expect(uniform(plain, 'q3_coords[0]').slice(0, 12)).toEqual([0, 0, 0, 0, ...IDENTITY_PIECE]);
    // No deform, so the mesh's own bounds, which hold every frame.
    expect((turbulent as unknown as { _customAabb: BoundingBox | null })._customAabb).toBeNull();

    // A scrolling stage moves its coordinates through `q3_coords`, the port's own uniform, and
    // asks its material for them in the chunks: `tcMod scroll 1 0` drifts s a unit a second, so at
    // 0.25 s the offset is 0.25.
    const animated: SkinStage[] = [];
    const glide = await wear('models/test/glide', animated);
    const [scrolling] = glide.entity.render!.meshInstances;
    expect((scrolling.material as StandardMaterial).defines.get('Q3_TCMOD')).toBe(true);
    // A stage with no `tcMod` keeps the define off, and its coordinates as the surface hands them.
    expect((plain.material as StandardMaterial).defines.has('Q3_TCMOD')).toBe(false);
    // The stage is played here, as a frame's does: the engine's own map transform must stay at
    // identity, the port's uniform carrying the movement instead.
    playStagedStages(animated, 0.25);
    const material = scrolling.material as StandardMaterial;
    expectClose([material.emissiveMapTiling.x, material.emissiveMapOffset.x], [1, 0]);
    drawStagedModel(glide, POSE, 0.25);
    expectClose(uniform(scrolling, 'q3_coords[0]').slice(4, 12), [1, 0, 0.25, 0, 0, 1, 0, 0]);

    // A copy gets its own coordinates, so the two move apart: as the model's last stood until the
    // copy is drawn, its array its own.
    const copy = copyStagedModel(glide);
    const [copied] = copy.entity.render!.meshInstances;
    expect(held(copied, 'q3_coords[0]')).not.toBe(held(scrolling, 'q3_coords[0]'));
    expectClose(uniform(copied, 'q3_coords[0]').slice(4, 12), [1, 0, 0.25, 0, 0, 1, 0, 0]);
    drawStagedModel(copy, POSE, 0.5);
    expectClose(uniform(copied, 'q3_coords[0]').slice(4, 12), [1, 0, 0.5, 0, 0, 1, 0, 0]);
    // The model's own stays where its last draw left it.
    expectClose(uniform(scrolling, 'q3_coords[0]').slice(4, 12), [1, 0, 0.25, 0, 0, 1, 0, 0]);
    // A stage whose tcMod stands still is written once, as its surface is built.
    const [scaled] = (await wear('models/test/tiled')).entity.render!.meshInstances;
    expect((scaled.material as StandardMaterial).defines.get('Q3_TCMOD')).toBe(true);
    expect(uniform(scaled, 'q3_coords[0]').slice(0, 12)).toEqual([0, 0, 0, 0, 2, 0, 0, 0, 0, 3, 0, 0]);
  });

  it("draws a stamped surface from its stamps' mesh, turned by where the camera looks", async () => {
    const staged = await wear('models/test/stamp', [], QUAD);
    const [instance] = staged.entity.render!.meshInstances;
    const surface = library.model(QUAD).surfaces[0];
    expect(instance.mesh).toBe(stampMesh(app.graphicsDevice, surface));
    expect((instance.material as StandardMaterial).defines.get('Q3_DEFORM_SPRITE')).toBe(true);

    const viewer = camera();
    drawStagedModel(staged, POSE, 0, viewer);
    const view = new Float32Array(16);
    writeView(deformView(staged.entity, viewer), view);
    expect(uniform(instance, 'q3_view[0]')).toEqual([...view]);
    expect(uniform(instance, 'q3_deform[0]').slice(0, 8)).toEqual([DEFORM_AUTOSPRITE, 0, 0, 0, 0, 0, 0, 0]);
    // Culled as far as a corner can stand from its quad's middle.
    const own = instance.mesh!.aabb.halfExtents;
    const reach = quadReach(surface);
    expectClose(cullBounds(instance)!.halfExtents.toArray(), [own.x + reach, own.y + reach, own.z + reach]);

    // With no viewer, no view, which turns no sprite.
    drawStagedModel(staged, POSE, 0);
    expect(uniform(instance, 'q3_view[0]')).toEqual(new Array(16).fill(0));
    // A model with no sprite is given no view.
    const plain = await wear('models/test/mirror');
    drawStagedModel(plain, POSE, 0, viewer);
    expect(uniform(plain.entity.render!.meshInstances[0], 'q3_view[0]')).toEqual(new Array(16).fill(0));
  });

  it('pivots a strip over its own mesh, culled as far as the pivot and the flicker reach', async () => {
    const staged = await wear('models/test/jet', [], QUAD);
    const [instance] = staged.entity.render!.meshInstances;
    const surface = library.model(QUAD).surfaces[0];
    expect(instance.mesh).toBe(surfaceMesh(app.graphicsDevice, surface));
    const own = instance.mesh!.aabb.halfExtents;
    const reach = quadReach(surface) + 1;
    expectClose(cullBounds(instance)!.halfExtents.toArray(), [own.x + reach, own.y + reach, own.z + reach]);
  });
});

describe('the order a model draws in', () => {

  it("sorts every draw at the model's origin, in the order it adds them", async () => {
    const blendedLayer = new Layer({ name: 'blended' });
    app.scene.layers.push(blendedLayer);
    const staged = await buildStagedModel(
      app,
      library,
      undefined,
      'pair',
      library.model(PAIR),
      () => 'models/test/ripple',
      { blendedLayers: [blendedLayer.id] },
      []
    );
    app.root.addChild(staged.entity);
    staged.entity.setPosition(1, 2, -30);
    // Each surface's plain stage writes depth; its two others draw apart, over it.
    const own = staged.entity.render!.meshInstances;
    const apart = (staged.entity.findByName(BLENDED_CHILD) as Entity).render!.meshInstances;
    expect(own.map((draw) => draw.drawOrder)).toEqual([0, 3]);
    expect(apart.map((draw) => draw.drawOrder)).toEqual([1, 2, 4, 5]);
    // Looking from the origin along a slant: the model's origin, 25.32 along it, not a draw's
    // own bounds.
    const eye = new Vec3(0, 0, 0);
    const forward = new Vec3(0.36, 0.48, -0.8);
    for (const draw of [...own, ...apart]) {
      expect(draw.calculateSortDistance!(draw, eye, forward)).toBeCloseTo(
        25.32 - draw.drawOrder * ORDER_STEP,
        9
      );
    }
  });
});

describe('copyStagedModel', () => {
  it("draws the model's meshes and materials, in its order, with uniforms of its own", async () => {
    const blendedLayer = new Layer({ name: 'blended' });
    app.scene.layers.push(blendedLayer);
    const staged = await buildStagedModel(
      app,
      library,
      undefined,
      'pair',
      library.model(PAIR),
      () => 'models/test/ripple',
      { blendedLayers: [blendedLayer.id] },
      []
    );
    const copy = copyStagedModel(staged);
    app.root.addChild(copy.entity);
    expect(copy.entity.name).toBe('pair');
    const renders = (model: StagedModel) =>
      [model.entity, model.entity.findByName(BLENDED_CHILD) as Entity].map(
        (entity) => entity.render!
      );
    const copied = renders(copy);
    for (const [i, render] of renders(staged).entries()) {
      expect(copied[i].layers).toEqual(render.layers);
      const of = (draws: readonly MeshInstance[], key: 'mesh' | 'material' | 'drawOrder') =>
        draws.map((draw) => draw[key]);
      for (const key of ['mesh', 'material', 'drawOrder'] as const) {
        expect(of(copied[i].meshInstances, key)).toEqual(of(render.meshInstances, key));
      }
    }

    // Drawn lit, somewhere, at a time the ripple has moved: the model's own are left as they were.
    drawStagedModel(copy, { ...POSE, origin: [0, 0, 32] }, 0.5, camera());
    const [own] = staged.entity.render!.meshInstances;
    const [drawn] = copy.entity.render!.meshInstances;
    expect(uniform(own, 'q3_light[0]')).toEqual(new Array(12).fill(0));
    expect(uniform(drawn, 'q3_light[0]')).not.toEqual(new Array(12).fill(0));
    // The model's own ripple is unwritten, with no turb, and the copy's moved on.
    expect(uniform(own, 'q3_coords[0]')[0]).toBe(0);
    expect(uniform(drawn, 'q3_coords[0]')[0]).toBe(1);
    expect(held(drawn, 'q3_frames')).toBe(held(own, 'q3_frames'));

    // Sorted at the copy's own origin, in the model's order.
    copy.entity.setPosition(1, 2, -30);
    const eye = new Vec3(0, 0, 0);
    const forward = new Vec3(0.36, 0.48, -0.8);
    for (const draw of copied.flatMap((render) => render.meshInstances)) {
      expect(draw.calculateSortDistance!(draw, eye, forward)).toBeCloseTo(
        25.32 - draw.drawOrder * ORDER_STEP,
        9
      );
    }
  });

  it('culls a copy by the bounds its deforms reach', async () => {
    const staged = await wear('models/test/swell');
    const copy = copyStagedModel(staged);
    const [own] = staged.entity.render!.meshInstances;
    const [drawn] = copy.entity.render!.meshInstances;
    expectClose(cullBounds(drawn)!.halfExtents.toArray(), cullBounds(own)!.halfExtents.toArray());
    expectClose(cullBounds(drawn)!.center.toArray(), cullBounds(own)!.center.toArray());
  });
});

describe("a model in a map's scene", () => {
  it('tags each draw with its shader and step, stage then surface; a copy its own', async () => {
    const draws = new SceneDraws(new SceneShaders(), {
      models: [],
      effects: [],
      gun: [],
      screen: []
    });
    const staged = await buildStagedModel(
      app,
      library,
      undefined,
      'pair',
      library.model(PAIR),
      () => 'models/test/ripple',
      { scene: { draws, group: 'models' } },
      []
    );
    const tagsOf = (model: StagedModel) =>
      [model.entity, model.entity.findByName(BLENDED_CHILD) as Entity]
        .flatMap((entity) => entity.render!.meshInstances)
        .map((draw) => sceneDraw(draw)!);
    const tags = tagsOf(staged);
    // Each surface's plain stage with the model, and its fog pass after its three stages; its two
    // blended ones apart.
    expect(tags.map((tag) => [tag.step, tag.fogPass === true])).toEqual([
      [modelStep(0, 0), false],
      [modelStep(3, 0), true],
      [modelStep(0, 1), false],
      [modelStep(3, 1), true],
      [modelStep(1, 0), false],
      [modelStep(2, 0), false],
      [modelStep(1, 1), false],
      [modelStep(2, 1), false]
    ]);
    const shader = draws.shaders.handle('models/test/ripple', LIGHTMAP_NONE);
    for (const tag of tags) {
      expect([tag.shader === shader, tag.entity === staged.order, tag.depthHack]).toEqual([
        true,
        true,
        false
      ]);
    }
    const copy = copyStagedModel(staged);
    const copied = tagsOf(copy);
    expect(copied.map((tag) => tag.step)).toEqual(tags.map((tag) => tag.step));
    expect(copy.order).not.toBe(staged.order);
    for (const tag of copied) expect(tag.entity).toBe(copy.order);
  });
});

describe("a model's fog", () => {
  const sceneDraws = () =>
    new SceneDraws(new SceneShaders(), { models: [], effects: [], gun: [], screen: [] });
  const placed = (draws: SceneDraws, group: 'models' | 'gun' = 'models') => ({
    scene: { draws, group }
  });
  const passesOf = (model: StagedModel) =>
    model.entity.render!.meshInstances.filter((draw) => sceneDraw(draw)?.fogPass);

  it('passes each surface in a scene after its stages, hidden, over its own morph', async () => {
    const draws = sceneDraws();
    const staged = await buildStagedModel(
      app,
      library,
      undefined,
      'pair',
      library.model(PAIR),
      () => 'models/test/drift',
      placed(draws, 'gun'),
      []
    );
    const passes = passesOf(staged);
    expect(passes.map((pass) => [pass.visible, sceneDraw(pass)!.step])).toEqual([
      [false, modelStep(1, 0)],
      [false, modelStep(1, 1)]
    ]);
    const [stage] = staged.entity.render!.meshInstances;
    for (const pass of passes) {
      const material = pass.material as StandardMaterial;
      expect(['Q3_FOG_PASS', 'Q3_DEFORM_NOISE'].map((name) => material.defines.has(name))).toEqual([
        true,
        true
      ]);
      expect([material.cull, sceneDraw(pass)!.depthHack]).toEqual([
        (stage.material as StandardMaterial).cull,
        true
      ]);
      expect(held(pass, FOG_UNIFORM)).toBe(staged.order.fogData);
      expect(held(pass, 'q3_light[0]')).toBe(staged.uniforms.light);
    }
    // Over the stages' own frames, morph and deforms.
    for (const name of ['q3_frames', 'q3_anim', 'q3_deform[0]']) {
      expect(held(passes[0], name), name).toBe(held(stage, name));
    }
    expect(held(stage, FOG_UNIFORM)).toBe(staged.order.fogData);
    // Out of a scene there is no fog, and no pass.
    const pair = library.model(PAIR);
    const drift = () => 'models/test/drift';
    const own = await buildStagedModel(app, library, undefined, 'pair', pair, drift, {}, []);
    expect(passesOf(own)).toEqual([]);
    // Its draws, and a copy's, read their own fog all the same: none.
    const ownCopy = copyStagedModel(own);
    for (const model of [own, ownCopy]) {
      for (const draw of model.entity.render!.meshInstances) {
        expect(held(draw, FOG_UNIFORM)).toBe(model.order.fogData);
      }
    }
  });

  it("dims a stage by its fog where it and its shader's first stage blend", async () => {
    const dimmedBy = async (shader: string) => {
      const one = library.model('models/test/shine.md3');
      const scene = placed(sceneDraws());
      const wear = () => shader;
      const staged = await buildStagedModel(app, library, undefined, 'one', one, wear, scene, []);
      return [staged.entity, ...staged.entity.children]
        .flatMap((entity) => (entity as Entity).render?.meshInstances ?? [])
        .filter((draw) => !sceneDraw(draw)?.fogPass)
        .map((draw) => {
          const { defines } = draw.material as StandardMaterial;
          const names = ['Q3_FOG_KEEP', 'Q3_FOG_RGB', 'Q3_FOG_ALPHA'];
          return names.filter((name) => defines.has(name)).join(' ');
        });
    };
    expect(await dimmedBy('models/test/glow')).toEqual([
      'Q3_FOG_KEEP Q3_FOG_RGB',
      'Q3_FOG_KEEP Q3_FOG_ALPHA',
      ''
    ]);
    // A first stage that does not blend leaves every stage as it is.
    expect(await dimmedBy('models/test/ripple')).toEqual(['', '', '']);
  });

  it('finds its fog by the frame it is drawn at, and a copy by its own', async () => {
    const draws = sceneDraws();
    const pair = library.model(PAIR);
    const ripple = () => 'models/test/ripple';
    const scene = placed(draws);
    const staged = await buildStagedModel(app, library, undefined, 'pair', pair, ripple, scene, []);
    const { frames } = staged.model;
    expect(staged.order.fogBy).toMatchObject({ kind: 'model', frames, frame: 0 });
    const copy = copyStagedModel(staged);
    expect(copy.order.fogBy).not.toBe(staged.order.fogBy);
    // The test model has one frame: another asked for is drawn as the first, as Q3 draws it.
    drawStagedModel(copy, { ...POSE, oldFrame: 0, frame: 4 }, 0);
    expect(copy.order.fogBy).toMatchObject({ frame: 0 });
    const copied = copy.order.fogBy?.kind === 'model' ? copy.order.fogBy.frames : [];
    expect(copied).toBe(frames);
    for (const draw of copy.entity.render!.meshInstances) {
      expect(held(draw, FOG_UNIFORM)).toBe(copy.order.fogData);
    }
    expect(passesOf(copy).map((pass) => pass.visible)).toEqual([false, false]);
    expect(copy.order.fogData).not.toBe(staged.order.fogData);
  });
});

describe('drawOwnSurfaces', () => {
  it('hides and shows a model’s own draws, blended ones too, and nothing hung under it', async () => {
    const blendedLayer = new Layer({ name: 'blended' });
    app.scene.layers.push(blendedLayer);
    // The ripple's plain stage writes depth; its other two do not, so they move onto a child.
    const staged = await buildStagedModel(
      app,
      library,
      undefined,
      'gun',
      library.model('models/test/shine.md3'),
      () => 'models/test/ripple',
      { blendedLayers: [blendedLayer.id] },
      []
    );
    app.root.addChild(staged.entity);
    const blended = staged.entity.findByName('blended') as Entity;
    // A piece hung under it, as a barrel, a flash or a shell hangs under a gun.
    const hung = new Entity('barrel');
    hung.addComponent('render', { type: 'box' });
    staged.entity.addChild(hung);

    drawOwnSurfaces(staged, false);
    expect([staged.entity.render!.enabled, blended.render!.enabled]).toEqual([false, false]);
    expect([staged.entity.enabled, hung.render!.enabled]).toEqual([true, true]);

    drawOwnSurfaces(staged, true);
    expect([staged.entity.render!.enabled, blended.render!.enabled]).toEqual([true, true]);
  });
});

describe('playStagedStages', () => {
  it("collects a stage that takes the entity's colour, and multiplies that colour in", async () => {
    const animated: SkinStage[] = [];
    await wear('models/test/tint', animated);
    expect(animated).toHaveLength(1);
    const { emissive } = animated[0].material;
    // `rgbGen entity` shows at twice the colour under classic Q3's ramp, and white with none.
    playStagedStages(animated, 0, [0, 0.5, 1]);
    expect([emissive.r, emissive.g, emissive.b]).toEqual([0, 1, 2]);
    playStagedStages(animated, 0);
    expect([emissive.r, emissive.g, emissive.b]).toEqual([2, 2, 2]);
  });

  it("multiplies every stage it plays by a tint, the entity's colour and the light's", async () => {
    const played = async (shader: string, color?: Rgb, tint?: Rgb) => {
      const animated: SkinStage[] = [];
      await wear(shader, animated);
      expect(animated).toHaveLength(1);
      playStagedStages(animated, 0, color, tint);
      const { r, g, b } = animated[0].material.emissive;
      return [r, g, b];
    };
    const tint = [0.5, 1, 0.25] as const;
    const tinted = (colour: number[]) => colour.map((value, i) => value * tint[i]);
    expect(await played('models/test/tint', [0, 0.5, 1], tint)).toEqual([0, 1, 0.5]);
    const lit = await played('models/test/glide');
    expect(lit[0]).toBeGreaterThan(0);
    expect(await played('models/test/glide', undefined, tint)).toEqual(tinted(lit));
    const scroll = await played('models/test/ripple');
    expect(await played('models/test/ripple', undefined, tint)).toEqual(tinted(scroll));
  });
});

describe('tintStagedModel', () => {
  it('tints every draw of a model, blended ones too, and nothing hung under it', async () => {
    const blendedLayer = new Layer({ name: 'blended' });
    app.scene.layers.push(blendedLayer);
    const staged = await buildStagedModel(
      app,
      library,
      undefined,
      'gun',
      library.model('models/test/shine.md3'),
      () => 'models/test/ripple',
      { blendedLayers: [blendedLayer.id] },
      []
    );
    const blended = staged.entity.findByName('blended') as Entity;
    const hungMaterial = new StandardMaterial();
    hungMaterial.emissive.set(1, 1, 1);
    const hung = new Entity('barrel');
    hung.addComponent('render', { type: 'box', material: hungMaterial });
    staged.entity.addChild(hung);
    const draws = [...staged.entity.render!.meshInstances, ...blended.render!.meshInstances];
    const colours = () =>
      draws.map((draw) => {
        const { r, g, b } = (draw.material as StandardMaterial).emissive;
        return [r, g, b];
      });
    const before = colours();
    expect(draws).toHaveLength(3);

    tintStagedModel(staged, [0.5, 1, 0.25]);
    expect(colours()).toEqual(before.map(([r, g, b]) => [r * 0.5, g, b * 0.25]));
    const { r, g, b } = hungMaterial.emissive;
    expect([r, g, b]).toEqual([1, 1, 1]);
  });
});
