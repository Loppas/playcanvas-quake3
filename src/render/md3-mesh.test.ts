// @vitest-environment jsdom
import {
  CULLFACE_BACK,
  CULLFACE_FRONT,
  CULLFACE_NONE,
  Entity,
  Layer,
  Vec3,
  type AppBase,
  type BoundingBox,
  type MeshInstance,
  type StandardMaterial
} from 'playcanvas';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { simToWorld } from '../coords';
import { parseMd3 } from '../formats/md3';
import { AssetLibrary } from '../formats/asset-library';
import { buildMd3 } from '../formats/md3-test-fixtures';
import { findShader } from '../formats/shader-script';
import { decodeTga } from '../formats/tga';
import { PROBE_ENTRY, havePak0, openPak } from '../pak/pak-test-fixtures';
import { LIGHT_HEADROOM, type EntityLight } from '../view/entity-light';
import { CLASSIC_FULLSCREEN, setRendererStyle } from '../view/overbright';
import { SceneShaders } from '../view/scene-shaders';
import { modelStep } from '../view/scene-sort';
import { deformView, viewerInModel } from './deform-view';
import { ORDER_STEP } from './draw-order';
import { createEffectStages } from './effect-material';
import {
  IDENTITY_PIECE,
  createTestApp,
  expectClose,
  held,
  lightUniform,
  uniform
} from './engine-test-fixtures';
import {
  BLENDED_CHILD,
  QUAKE_TO_WORLD_EULER,
  copyMd3,
  createMd3Entity,
  createSurfaceMaterial,
  decodeImage,
  decodeTgasWith,
  faceMd3,
  playMd3,
  q3CullMode,
  rippleSurface,
  shadeMd3,
  type Md3Renderable
} from './md3-mesh';
import { FOG_UNIFORM } from './fog-chunks';
import { DEFORM_SLOTS, writeDeforms, writeView } from './model-chunks';
import { frameTexture, quadReach, stampMesh, surfaceMesh } from './model-frames';
import { encode, whiteTga } from './player-test-fixtures';
import { SceneDraws, sceneDraw } from './scene-draws';

/**
 * The engine-free parts of the render adapter. Mesh and texture construction need a real
 * graphics device, which jsdom cannot provide, so what is covered here is the two conventions
 * that decide whether a model *looks* right: the UV origin and the Quake-to-world basis change.
 */

describe('QUAKE_TO_WORLD_EULER', () => {
  /** Rotate a vector by the entity euler the adapter applies, as PlayCanvas would. */
  function rotate([x, y, z]: [number, number, number]): [number, number, number] {
    const radians = (QUAKE_TO_WORLD_EULER[0] * Math.PI) / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    // Rotation about X only; the other two euler components are zero.
    return [x, y * cos - z * sin, y * sin + z * cos];
  }

  it('reproduces coords.simToWorld, so meshes and the sim agree on which way is up', () => {
    // This is the whole reason the rotation is expressed as an entity transform: the sim's
    // conversion and the model's orientation must be the same mapping, not two guesses.
    for (const v of [
      { x: 1, y: 0, z: 0 },
      { x: 0, y: 1, z: 0 },
      { x: 0, y: 0, z: 1 },
      { x: 3, y: -7, z: 11 }
    ]) {
      const rotated = rotate([v.x, v.y, v.z]);
      // simToWorld also divides by 32; the adapter carries that as entity scale, so compare
      // directions only.
      const expected = simToWorld(v).map((component) => component * 32);
      for (let i = 0; i < 3; i++) {
        expect(rotated[i], `${JSON.stringify(v)}[${i}]`).toBeCloseTo(expected[i], 6);
      }
    }
  });

  it('sends Quake up (+Z) to world up (+Y)', () => {
    const up = rotate([0, 0, 1]);
    expect(up[1]).toBeCloseTo(1, 6);
  });

  it('is a rotation, not a reflection, so triangle winding survives it', () => {
    // A negative determinant here would flip every face inside out.
    const [a, b, c] = [rotate([1, 0, 0]), rotate([0, 1, 0]), rotate([0, 0, 1])];
    const determinant =
      a[0] * (b[1] * c[2] - b[2] * c[1]) -
      a[1] * (b[0] * c[2] - b[2] * c[0]) +
      a[2] * (b[0] * c[1] - b[1] * c[0]);
    expect(determinant).toBeCloseTo(1, 6);
  });
});

describe('q3CullMode', () => {
  it("maps Q3's default to CULLFACE_FRONT, because MD3 faces are wound clockwise outward", () => {
    expect(q3CullMode(undefined)).toBe(CULLFACE_FRONT);
    expect(q3CullMode('front')).toBe(CULLFACE_FRONT);
  });

  it('maps the two explicit modes straight through', () => {
    expect(q3CullMode('back')).toBe(CULLFACE_BACK);
    expect(q3CullMode('none')).toBe(CULLFACE_NONE);
  });
});

describe('decodeImage', () => {
  afterEach(() => decodeTgasWith(decodeTga));

  it('decodes a TGA by the decoder it is given, and in place until then', async () => {
    expect(await decodeImage('models/a.tga', whiteTga())).toEqual(decodeTga(whiteTga()));
    const asked: string[] = [];
    decodeTgasWith(async (bytes, label) => {
      asked.push(label);
      return decodeTga(bytes, label);
    });
    expect(await decodeImage('models/a.tga', whiteTga())).toEqual(decodeTga(whiteTga()));
    expect(asked).toEqual(['models/a.tga']);
  });
});

describe.skipIf(!havePak0)('MD3 triangle winding', () => {
  it('is clockwise seen from outside, on every triangle of the rocket launcher', async () => {
    // The measurement {@link q3CullMode} rests on, and the reason Q3 culls GL_FRONT. A
    // triangle's winding normal — cross(b - a, c - a) — points *away* from the vertex
    // normals the artist authored, on all 405 faces. That is what makes CULLFACE_BACK draw
    // the model's interior instead of hiding it, which is a far more confusing failure than
    // an invisible weapon.
    const pak0 = await openPak('pak0.pk3');
    const model = parseMd3((await pak0.read(PROBE_ENTRY))!, PROBE_ENTRY);
    let clockwise = 0;
    let counterClockwise = 0;
    let degenerate = 0;

    for (const surface of model.surfaces) {
      const { positions, normals } = surface.frames[0];
      for (let i = 0; i < surface.indices.length; i += 3) {
        const [ia, ib, ic] = [surface.indices[i], surface.indices[i + 1], surface.indices[i + 2]];
        const at = (v: number, axis: number) => positions[v * 3 + axis];
        const e1 = [0, 1, 2].map((axis) => at(ib, axis) - at(ia, axis));
        const e2 = [0, 1, 2].map((axis) => at(ic, axis) - at(ia, axis));
        const face = [
          e1[1] * e2[2] - e1[2] * e2[1],
          e1[2] * e2[0] - e1[0] * e2[2],
          e1[0] * e2[1] - e1[1] * e2[0]
        ];
        // Against the average of the three vertex normals: those are the authored outward
        // direction, independent of any winding convention.
        const outward = [0, 1, 2].map(
          (axis) => normals[ia * 3 + axis] + normals[ib * 3 + axis] + normals[ic * 3 + axis]
        );
        const agreement = face[0] * outward[0] + face[1] * outward[1] + face[2] * outward[2];
        if (agreement < 0) clockwise++;
        else if (agreement > 0) counterClockwise++;
        else degenerate++;
      }
    }

    expect(counterClockwise).toBe(0);
    expect(degenerate).toBe(0);
    expect(clockwise).toBe(405);
  });
});

describe('createSurfaceMaterial', () => {
  let app: AppBase;

  beforeEach(() => {
    ({ app } = createTestApp());
  });

  afterEach(() => {
    app.destroy();
  });

  /** A 2 × 2 white 32-bit TGA, top-left origin. */
  function tga(): Uint8Array {
    const header = [0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 2, 0, 32, 0x28];
    return new Uint8Array([...header, ...new Array(2 * 2 * 4).fill(255)]);
  }

  /** A library with one skin and the given shader script. */
  function library(script: string): AssetLibrary {
    return new AssetLibrary(
      new Map([
        ['scripts/test.shader', new TextEncoder().encode(script)],
        ['models/skin.tga', tga()]
      ])
    );
  }

  it("draws a scripted surface at its stage's brightness on screen", async () => {
    const shaders = library(`
      models/glow { { map models/skin.tga rgbGen identity } }
      models/plain { { map models/skin.tga blendFunc GL_ONE GL_ONE } }
      models/pulse { { map models/skin.tga blendFunc GL_ONE GL_ONE rgbGen wave sin 1 1 0 1 } }
      models/rail { { map models/skin.tga blendFunc GL_ONE GL_ONE rgbGen entity } }
    `);
    const gain = async (name: string) =>
      (await createSurfaceMaterial(app, shaders, name)).emissive.r;
    // The plasma gun's glow and the BFG's energy are `rgbGen identity`: twice a default stage.
    expect(await gain('models/glow.tga')).toBe(2);
    expect(await gain('models/plain.tga')).toBe(1);
    // The railgun's glow takes the entity's colour, which Q3 feeds it from `color1` and nothing
    // feeds it here, so it keeps a default stage's brightness.
    expect(await gain('models/rail.tga')).toBe(1);
    // A body draws its one stage still, so a wave keeps a default stage's brightness.
    expect(await gain('models/pulse.tga')).toBe(1);
  });

  it("doubles a lit surface's vertex colours, which hold half its shade", async () => {
    const material = await createSurfaceMaterial(app, library(''), 'models/skin.tga');
    expect(material.emissiveVertexColor).toBe(true);
    expect(material.emissive.r).toBe(LIGHT_HEADROOM);
  });
});

/**
 * A model as a missile or a flash is built: a lit body, a surface whose second stage ripples and
 * draws over the first, a glow Q3 stamps facing the viewer, and a surface that drifts.
 */
describe('createMd3Entity, copyMd3 and shadeMd3', () => {
  const PATH = 'models/test/thing.md3';
  /** A model with no sprite: one lit surface. */
  const PLAIN = 'models/test/plain.md3';
  const SHADERS = `
    models/test/ripple { { map models/test/skin.tga }
      { map models/test/skin.tga blendFunc add tcMod turb 0 .25 0 1.6
        } }
    models/test/glow { deformVertexes autosprite { map models/test/skin.tga blendFunc add } }
    models/test/drift { deformVertexes normal .3 .2 deformVertexes move 0 0 2 sin 1 1 0 0.5
      { map models/test/skin.tga blendFunc add } }
  `;
  /** A light no model is lit by unless told. */
  const LIGHT: EntityLight = { ambient: [91, 40, 10], directed: [75, 150, 0], direction: [0, 0, 1] };

  let app: AppBase;
  let library: AssetLibrary;
  let layer: Layer;

  beforeEach(() => {
    ({ app } = createTestApp());
    library = new AssetLibrary(
      new Map([
        ['scripts/test.shader', encode(SHADERS)],
        ['models/test/skin.tga', whiteTga()],
        [
          PATH,
          buildMd3({
            surfaces: [
              { name: 'body', shader: 'models/test/skin.tga' },
              { name: 'ripple', shader: 'models/test/ripple' },
              {
                name: 'glow',
                shader: 'models/test/glow',
                positions: () => [-4, 0, 0, 4, 0, 0, 4, 0, 64, -4, 0, 64],
                indices: [0, 1, 2, 0, 2, 3]
              },
              { name: 'drift', shader: 'models/test/drift' }
            ]
          })
        ],
        [PLAIN, buildMd3({ surfaces: [{ name: 'body', shader: 'models/test/skin.tga' }] })]
      ])
    );
    layer = new Layer({ name: 'blended' });
    app.scene.layers.push(layer);
  });

  afterEach(() => {
    app.destroy();
  });

  /** The model, every stage of a scripted surface drawn, its depthless draws apart. */
  function thing(): Promise<Md3Renderable> {
    return createMd3Entity(app, library, PATH, {
      blendedLayers: [layer.id],
      stages: async (name) =>
        findShader(library.shaders, name) ? createEffectStages(app, library, name) : null
    });
  }

  /** A model's draws: its own, then its depthless child's. */
  function draws(model: Md3Renderable): MeshInstance[] {
    const apart = model.entity.findByName(BLENDED_CHILD) as Entity;
    return [...model.entity.render!.meshInstances, ...apart.render!.meshInstances];
  }

  const defines = (instance: MeshInstance) => (instance.material as StandardMaterial).defines;

  it('fogs each surface in a scene: a hidden pass after its stages, or dimmed', async () => {
    const scene = {
      draws: new SceneDraws(new SceneShaders(), { models: [], effects: [], gun: [], screen: [] }),
      group: 'models' as const
    };
    const built = await createMd3Entity(app, library, PATH, {
      blendedLayers: [layer.id],
      stages: async (name) =>
        findShader(library.shaders, name) ? createEffectStages(app, library, name) : null,
      scene
    });
    expect(built.order.fogBy).toMatchObject({ kind: 'model', frame: 0 });
    const passes = draws(built).filter((draw) => sceneDraw(draw)?.fogPass);
    // After each surface's stages: the body's one, the ripple's two, the glow's and the drift's.
    expect(passes.map((pass) => [pass.visible, sceneDraw(pass)!.step])).toEqual([
      [false, modelStep(1, 0)],
      [false, modelStep(2, 1)],
      [false, modelStep(1, 2)],
      [false, modelStep(1, 3)]
    ]);
    const stagesOf = draws(built).filter((draw) => !sceneDraw(draw)?.fogPass);
    for (const draw of draws(built)) expect(held(draw, FOG_UNIFORM)).toBe(built.order.fogData);
    // The drift's pass moves as its stage does.
    expect(held(passes[3], 'q3_deform[0]')).toBe(held(stagesOf[4], 'q3_deform[0]'));
    expect(defines(passes[3]).has('Q3_FOG_PASS')).toBe(true);
    // The ripple's added stage over an opaque one is not dimmed; the glow's and the drift's are.
    const dimmed = stagesOf.map((draw) => defines(draw).has('Q3_FOG_KEEP'));
    expect(dimmed).toEqual([false, false, false, true, true]);

    // A copy reads its own fog, its passes hidden.
    const copy = copyMd3(built);
    expect(copy.order.fogBy).not.toBe(built.order.fogBy);
    const copied = draws(copy);
    for (const draw of copied) expect(held(draw, FOG_UNIFORM)).toBe(copy.order.fogData);
    const copiedPasses = copied.filter((draw) => sceneDraw(draw)?.fogPass);
    expect(copiedPasses.every((pass) => !pass.visible)).toBe(true);

    // Drawn flat from its script's first stage, a surface is dimmed by that stage's blend.
    const flat = await createMd3Entity(app, library, PATH, { blendedLayers: [layer.id], scene });
    const flatDimmed = draws(flat)
      .filter((draw) => !sceneDraw(draw)?.fogPass)
      .map((draw) => defines(draw).has('Q3_FOG_KEEP'));
    expect(flatDimmed).toEqual([false, false, true, true]);
    // Out of a scene, no pass, and a copy's draws read its own fog all the same.
    const unplaced = await thing();
    expect(draws(unplaced).some((draw) => sceneDraw(draw)?.fogPass)).toBe(false);
    const unplacedCopy = copyMd3(unplaced);
    for (const draw of draws(unplacedCopy)) {
      expect(held(draw, FOG_UNIFORM)).toBe(unplacedCopy.order.fogData);
    }
  });

  it("draws each surface's shared mesh and frames, the chunks shading it and rippling it", async () => {
    const built = await thing();
    const [body, ripple, glow] = library.model(PATH).surfaces;
    const device = app.graphicsDevice;
    // The body, the ripple's first stage, then its second, drawn over it.
    const [lit, under, over] = draws(built);
    expect([lit, under, over].map((instance) => instance.mesh)).toEqual([
      surfaceMesh(device, body),
      surfaceMesh(device, ripple),
      surfaceMesh(device, ripple)
    ]);
    for (const [instance, surface] of [
      [lit, body],
      [under, ripple],
      [over, ripple]
    ] as const) {
      expect(held(instance, 'q3_frames')).toBe(frameTexture(device, surface));
      // Frame 0, as `CG_LaunchGib` and a missile leave it; the model's light; no viewer and no
      // deform.
      expect(uniform(instance, 'q3_anim')).toEqual([0, 0, 0, 3]);
      expect(held(instance, 'q3_light[0]')).toBe(built.light);
      expect(uniform(instance, 'q3_viewer')).toEqual([0, 0, 0, 0]);
      expect(uniform(instance, 'q3_deform[0]')).toEqual(new Array(DEFORM_SLOTS * 8).fill(0));
    }
    expect([defines(lit).get('Q3_LIT'), defines(under).has('Q3_LIT')]).toEqual([true, false]);
    // The ripple is the chunks' own, on the surface's coordinates: no second set to read.
    expect([defines(over).get('Q3_TCMOD'), defines(under).has('Q3_TCMOD')]).toEqual([true, false]);
    expect((over.material as StandardMaterial).emissiveMapUv).toBe(0);
    const [turbulent] = built.turbulent;
    const rewritten = vi.spyOn(over.mesh!, 'update');
    rippleSurface(turbulent, 0.25);
    // `turb 0 .25 0 1.6` a quarter of a second in, between two pieces that move nothing, and the
    // shared mesh left as it is.
    expectClose(uniform(over, 'q3_coords[0]').slice(0, 24), [1, 0, 0, 0, ...IDENTITY_PIECE, 0.25, 0.4, 0, 0, ...IDENTITY_PIECE]);
    expect(uniform(under, 'q3_coords[0]').slice(0, 12)).toEqual([0, 0, 0, 0, ...IDENTITY_PIECE]);
    expect(rewritten).not.toHaveBeenCalled();

    // The glow draws its surface's stamps through the chunks, which turn them by the model's
    // view.
    const stamp = draws(built)[3];
    expect(stamp.mesh).toBe(stampMesh(device, glow));
    expect(held(stamp, 'q3_frames')).toBe(frameTexture(device, glow));
    expect(defines(stamp).get('Q3_DEFORM_SPRITE')).toBe(true);
    expect(held(stamp, 'q3_view[0]')).toBe(built.view);
    expect(defines(over).has('Q3_DEFORM_SPRITE')).toBe(false);
    // Culled as far as a corner can stand from its quad's middle.
    const box = (stamp as unknown as { _customAabb: BoundingBox })._customAabb;
    const own = stamp.mesh!.aabb.halfExtents;
    const reach = quadReach(glow);
    expectClose(box.halfExtents.toArray(), [own.x + reach, own.y + reach, own.z + reach]);
  });

  it('asks for the stages of scripted surfaces alone, and gives a view only to a model with a sprite', async () => {
    const asked: string[] = [];
    const stages = async (name: string) => {
      asked.push(name);
      return null;
    };
    const built = await createMd3Entity(app, library, PATH, { stages });
    // The body names an image, which Q3 lights as it is, whatever the callback would offer.
    expect(asked).toEqual(['models/test/ripple', 'models/test/glow', 'models/test/drift']);
    expect(built.view).toHaveLength(16);
    const plain = await createMd3Entity(app, library, PLAIN, { stages });
    expect(plain.view).toBeNull();
    expect(plain.light).toHaveLength(12);
  });

  it('moves a surface its shader deforms by a uniform of its own, culled as far as the deforms reach', async () => {
    const built = await thing();
    const [lit, , over, glow, drift] = draws(built);
    // The surfaces with no deform share one of zeros; the drift has its own, written at 0 s.
    expect(held(lit, 'q3_deform[0]')).toBe(held(over, 'q3_deform[0]'));
    expect(held(drift, 'q3_deform[0]')).not.toBe(held(lit, 'q3_deform[0]'));
    const deforms = library.shaders.get('models/test/drift')!.deforms;
    const packed = new Float32Array(DEFORM_SLOTS * 8);
    writeDeforms(deforms, 0, packed);
    expect(uniform(drift, 'q3_deform[0]')).toEqual([...packed]);
    // The glow's autosprite is a deform too.
    expect(built.deforming).toEqual([
      { deforms: library.shaders.get('models/test/glow')!.deforms, uniform: held(glow, 'q3_deform[0]') },
      { deforms, uniform: held(drift, 'q3_deform[0]') }
    ]);
    // The normal brings the noise in.
    expect([defines(drift).get('Q3_DEFORM_NOISE'), defines(over).has('Q3_DEFORM_NOISE')]).toEqual([true, false]);

    // Its owner moves it on, with the ripples.
    playMd3(built, 1.5);
    writeDeforms(deforms, 1.5, packed);
    expect(uniform(drift, 'q3_deform[0]')).toEqual([...packed]);
    // 2.4 periods in: their fraction, and the whole periods apart.
    expectClose(uniform(over, 'q3_coords[0]').slice(12, 15), [0.25, 0.4, 2]);

    // Culled by its mesh's bounds grown by the move's reach, 2 · (1 + 1); the rest by their own.
    const box = (instance: MeshInstance) =>
      (instance as unknown as { _customAabb: BoundingBox | null })._customAabb;
    const own = drift.mesh!.aabb.halfExtents;
    expectClose(box(drift)!.halfExtents.toArray(), [own.x + 4, own.y + 4, own.z + 4]);
    expect(box(lit)).toBeNull();

    // A copy shares the deform, and keeps the bounds a clone alone would drop.
    const copy = copyMd3(built);
    const copied = draws(copy)[4];
    expect(held(copied, 'q3_deform[0]')).toBe(held(drift, 'q3_deform[0]'));
    expect(box(copied)!.halfExtents.toArray()).toEqual(box(drift)!.halfExtents.toArray());
    expect(copy.deforming).toBe(built.deforming);
  });

  it("copies a model with its draws bound, sharing its meshes, frames and ripples and each with a light of its own", async () => {
    const prototype = await thing();
    const one = copyMd3(prototype);
    const two = copyMd3(prototype);
    expect(one.light).toHaveLength(12);
    expect(new Set([prototype.light, one.light, two.light]).size).toBe(3);
    const originals = draws(prototype);
    draws(one).forEach((instance, index) => {
      expect(instance.mesh).toBe(originals[index].mesh);
      for (const name of ['q3_frames', 'q3_anim', 'q3_viewer', 'q3_deform[0]', 'q3_coords[0]']) {
        expect(held(instance, name), name).toBe(held(originals[index], name));
      }
      expect(held(instance, 'q3_light[0]')).toBe(one.light);
    });
    // Its view is its own too, which its sprites read; its ripples its prototype's, so one
    // ripple moves them all.
    expect(one.view).toHaveLength(16);
    expect(new Set([prototype.view, one.view, two.view]).size).toBe(3);
    expect(held(draws(one)[3], 'q3_view[0]')).toBe(one.view);
    expect(one.turbulent).toBe(prototype.turbulent);

    // A copy is shaded alone.
    shadeMd3(one, LIGHT);
    expect(uniform(draws(one)[0], 'q3_light[0]')).toEqual(lightUniform(LIGHT));
    expect(uniform(draws(two)[0], 'q3_light[0]')).toEqual(new Array(12).fill(0));
  });

  it("turns a copy's sprites to where the camera looks, by its own view", async () => {
    const camera = new Entity('camera');
    camera.setEulerAngles(-30, -90, 0);
    const copy = copyMd3(await thing());
    copy.entity.setLocalEulerAngles(0, 40, 0);
    faceMd3(copy, camera);
    const view = new Float32Array(16);
    writeView(deformView(copy.entity, camera), view);
    expect(uniform(draws(copy)[3], 'q3_view[0]')).toEqual([...view]);
  });

  it('tells a lit surface where the camera is under opengl2, each copy by a viewer of its own', async () => {
    const camera = new Entity('camera');
    camera.setPosition(0, 2, 3);
    try {
      setRendererStyle({ renderer: 'opengl2', overBrightBits: 1 });
      const prototype = await createMd3Entity(app, library, PLAIN);
      expect(prototype.viewer).toHaveLength(4);
      const copy = copyMd3(prototype);
      expect(copy.viewer).toHaveLength(4);
      expect(copy.viewer).not.toBe(prototype.viewer);
      copy.entity.setLocalEulerAngles(0, 40, 0);
      faceMd3(copy, camera);
      const [lit] = copy.entity.render!.meshInstances;
      expect(held(lit, 'q3_viewer')).toBe(copy.viewer);
      expectClose(uniform(lit, 'q3_viewer'), [...viewerInModel(copy.entity, camera), 1]);
      // Unfaced, the prototype is seen head on.
      expect(uniform(prototype.entity.render!.meshInstances[0], 'q3_viewer')).toEqual([0, 0, 0, 0]);
    } finally {
      setRendererStyle(CLASSIC_FULLSCREEN);
    }
    // opengl1 lights it per vertex, and facing it writes nothing.
    const classic = await createMd3Entity(app, library, PLAIN);
    expect(classic.viewer).toBeNull();
    faceMd3(classic, camera);
  });

  it("puts every draw in Q3's order, sorted at its model's origin, and a copy's at its own", async () => {
    // Looking from the origin along a slant.
    const eye = new Vec3(0, 0, 0);
    const forward = new Vec3(0.36, 0.48, -0.8);
    const prototype = await thing();
    app.root.addChild(prototype.entity);
    prototype.entity.setPosition(0, 5, -10);
    const copy = copyMd3(prototype);
    app.root.addChild(copy.entity);
    copy.entity.setPosition(3, 0, -50);
    for (const [model, depth] of [
      [prototype, 10.4],
      [copy, 41.08]
    ] as const) {
      // The body, the ripple's two stages, the glow and the drift.
      const drawn = draws(model);
      expect(drawn.map((draw) => draw.drawOrder)).toEqual([0, 1, 2, 3, 4]);
      expectClose(
        drawn.map((draw) => draw.calculateSortDistance!(draw, eye, forward)),
        [0, 1, 2, 3, 4].map((order) => depth - order * ORDER_STEP)
      );
    }
  });
});
