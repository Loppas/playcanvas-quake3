// @vitest-environment jsdom
import { Entity, Layer, type AppBase, type MeshInstance, type StandardMaterial } from 'playcanvas';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { UNITS_PER_METRE, worldToSim } from '../coords';
import { AssetLibrary } from '../formats/asset-library';
import { madd, scale, vec3, type Vec3 } from '../sim/vec3';
import { localEntity } from '../view/scene-sort';
import { SceneShaders } from '../view/scene-shaders';
import { loadFogs } from '../view/world-fog';
import { LIGHTMAP_2D } from '../view/world-shaders';
import { fogParts, testBsp } from '../view/world-test-fixtures';
import { SceneFogs } from './bsp-fog';
import { createTestApp, expectClose, held } from './engine-test-fixtures';
import { FOG_UNIFORM } from './fog-chunks';
import { applyQuakeTransform, type GammaVertexColorMaterial } from './md3-mesh';
import { MERGED_SHADERS, MergedSprites, mergedBucket } from './merged-sprites';
import { encode, whiteTga } from './player-test-fixtures';
import { SceneDraws, sceneDraw } from './scene-draws';

/**
 * Merged sprites on the null device, read back from the batch a frame writes, under a camera
 * turned so that no axis of the view lines up with the world's.
 */

const STAGE = `map gfx/misc/smokepuff3.tga blendFunc GL_SRC_ALPHA GL_ONE_MINUS_SRC_ALPHA
  rgbGen vertex alphaGen vertex`;
const SECOND = `map gfx/misc/second.tga blendFunc GL_SRC_ALPHA GL_ONE_MINUS_SRC_ALPHA
  rgbGen vertex alphaGen vertex`;

/** The retail `smokePuff`. */
const MERGABLE = `smokePuff { cull none entityMergable { ${STAGE} } }`;

const WHITE = [1, 1, 1, 1];

/** A quad as the batch holds it: its corners in the node's space, its colour, and its image. */
interface Quad {
  corners: Vec3[];
  color: number[];
  image: string;
}

describe('MergedSprites', () => {
  let app: AppBase;
  let camera: Entity;
  let layer: Layer;
  let node: Entity;
  let sprites: MergedSprites | undefined;

  beforeEach(() => {
    ({ app, camera } = createTestApp());
    layer = new Layer({ name: 'effects' });
    app.scene.layers.push(layer);
    node = new Entity('quake');
    applyQuakeTransform(node);
    app.root.addChild(node);
    camera.setEulerAngles(20, 35, 10);
  });

  afterEach(() => {
    sprites?.destroy();
    app.destroy();
  });

  /** `smokePuff` as `script` defines it. */
  async function create(script = MERGABLE): Promise<MergedSprites> {
    const library = new AssetLibrary(
      new Map([
        ['scripts/gfx.shader', encode(script)],
        ['gfx/misc/smokepuff3.tga', whiteTga()],
        ['gfx/misc/second.tga', whiteTga()]
      ])
    );
    sprites = await MergedSprites.create(app, library, 'smokePuff', node, [layer], camera);
    return sprites;
  }

  /** A frame of white sprites eight units in radius, unturned, one at each origin. */
  function frame(...origins: Vec3[]): void {
    sprites!.begin();
    for (const origin of origins) sprites!.add(origin, 8, 0, WHITE);
    sprites!.end();
  }

  /** The draws shown, in the order drawn. */
  function draws(): MeshInstance[] {
    return layer.meshInstances
      .filter((draw) => draw.visible)
      .sort((a, b) => a.drawOrder - b.drawOrder);
  }

  /** A draw's quads, in the order written. */
  function quads(draw: MeshInstance): Quad[] {
    const { base, count } = draw.mesh!.primitive[0];
    const floats = new Float32Array(draw.mesh!.vertexBuffer.storage);
    const bytes = new Uint8Array(draw.mesh!.vertexBuffer.storage);
    const image = (draw.material as StandardMaterial).emissiveMap!.name;
    const written: Quad[] = [];
    for (let quad = base / 6; quad < (base + count) / 6; quad++) {
      const corners = [0, 1, 2, 3].map((corner) => {
        const at = (quad * 4 + corner) * 6;
        return vec3(floats[at], floats[at + 1], floats[at + 2]);
      });
      written.push({ corners, color: [...bytes.subarray(quad * 96 + 20, quad * 96 + 24)], image });
    }
    return written;
  }

  /** Every quad shown, in the order drawn. */
  const shown = () => draws().flatMap(quads);

  /** Where a quad is centred. */
  const centre = ({ corners }: Quad) =>
    scale(corners.reduce((a, b) => madd(a, 1, b), vec3()), 1 / 4);

  /** The view's left and up in Quake's space: the camera's right reversed, and its up. */
  function view(): { left: Vec3; up: Vec3 } {
    const { right, up } = camera;
    const metres = (v: Vec3) => scale(v, 1 / UNITS_PER_METRE);
    return {
      left: metres(worldToSim(-right.x, -right.y, -right.z)),
      up: metres(worldToSim(up.x, up.y, up.z))
    };
  }

  /** Assert a quad's corners are `origin` plus and minus `left` and `up`, as Q3 stamps them. */
  function expectStamp(quad: Quad, origin: Vec3, left: Vec3, up: Vec3): void {
    const expected = [
      madd(madd(origin, 1, left), 1, up),
      madd(madd(origin, -1, left), 1, up),
      madd(madd(origin, -1, left), -1, up),
      madd(madd(origin, 1, left), -1, up)
    ];
    expected.forEach((corner, i) => {
      const { x, y, z } = quad.corners[i];
      // Quake units in single floats.
      for (const d of [x - corner.x, y - corner.y, z - corner.z]) {
        expect(Math.abs(d)).toBeLessThan(1e-3);
      }
    });
  }

  it('stamps a sprite about its origin, facing the eye, as RB_SurfaceSprite lays its corners', async () => {
    await create();
    const origin = vec3(100, -50, 30);
    frame(origin);
    const { left, up } = view();
    expectStamp(shown()[0], origin, scale(left, 8), scale(up, 8));
  });

  it("turns a sprite in the view's plane by its rotation", async () => {
    await create();
    const origin = vec3(100, -50, 30);
    sprites!.begin();
    sprites!.add(origin, 8, 30, WHITE);
    sprites!.end();
    const { left, up } = view();
    const c = Math.cos(Math.PI / 6) * 8;
    const s = Math.sin(Math.PI / 6) * 8;
    // `left = axis[1] c - axis[2] s` and `up = axis[2] c + axis[1] s`, the radius on both.
    expectStamp(shown()[0], origin, madd(scale(left, c), -s, up), madd(scale(up, c), s, left));
  });

  it("carries each sprite's colour, a byte a channel", async () => {
    await create();
    sprites!.begin();
    sprites!.add(vec3(), 8, 0, [1, 0.5, 0, 84 / 255]);
    sprites!.end();
    expect(shown()[0].color).toEqual([255, 128, 0, 84]);
  });

  it('takes the colour where its stage says rgbGen and alphaGen vertex, decoded as its image is', async () => {
    await create();
    frame(vec3());
    const [vertex] = draws().map((draw) => draw.material as GammaVertexColorMaterial);
    expect([vertex.emissiveVertexColor, vertex.vertexColorGamma]).toEqual([true, true]);
    expect([vertex.opacityVertexColor, vertex.opacityVertexColorChannel]).toEqual([true, 'a']);
    sprites!.destroy();

    await create(`smokePuff { entityMergable { map gfx/misc/smokepuff3.tga blendFunc blend
      rgbGen identity } }`);
    frame(vec3());
    const [fixed] = draws().map((draw) => draw.material as StandardMaterial);
    expect([fixed.emissiveVertexColor, fixed.opacityVertexColor]).toEqual([false, false]);
  });

  it('draws every sprite of an entityMergable shader as one draw, in the order added', async () => {
    await create();
    frame(vec3(0, 0, 0), vec3(64, 0, 0), vec3(128, 0, 0));
    expect(draws()).toHaveLength(1);
    expectClose(shown().map((quad) => centre(quad).x), [0, 64, 128]);
  });

  it('draws each sprite of any other shader as its own draw, in order, as Q3 flushes at each entity', async () => {
    await create(`smokePuff { cull none { ${STAGE} } }`);
    frame(vec3(0, 0, 0), vec3(64, 0, 0), vec3(128, 0, 0));
    expect(draws().map((draw) => quads(draw).length)).toEqual([1, 1, 1]);
    expectClose(shown().map((quad) => centre(quad).x), [0, 64, 128]);
  });

  it("draws each stage over every sprite in turn, or each sprite's stages in turn where none merge", async () => {
    await create(`smokePuff { entityMergable { ${STAGE} } { ${SECOND} } }`);
    frame(vec3(0, 0, 0), vec3(64, 0, 0));
    const drawn = () => shown().map((quad) => [quad.image, Math.round(centre(quad).x)]);
    const [first, second] = ['gfx/misc/smokepuff3.tga', 'gfx/misc/second.tga'];
    expect(draws()).toHaveLength(2);
    expect(drawn()).toEqual([
      [first, 0],
      [first, 64],
      [second, 0],
      [second, 64]
    ]);
    sprites!.destroy();

    await create(`smokePuff { { ${STAGE} } { ${SECOND} } }`);
    frame(vec3(0, 0, 0), vec3(64, 0, 0));
    expect(draws()).toHaveLength(4);
    expect(drawn()).toEqual([
      [first, 0],
      [second, 0],
      [first, 64],
      [second, 64]
    ]);
  });

  it('draws the bubbles first, then in the order cgame registers', async () => {
    // `waterBubble`, sorted `underwater`, before the blended `smokePuff`, `bloodTrail` and
    // `hasteSmokePuff` (`cg_main.c:851, 859, 882`); the engine's default bucket is 127, and a
    // layer that sorts back to front draws a higher one first.
    const buckets = MERGED_SHADERS.map(mergedBucket);
    expect(MERGED_SHADERS).toEqual(['waterBubble', 'smokePuff', 'bloodTrail', 'hasteSmokePuff']);
    expect(buckets.every((bucket, i) => bucket > (buckets[i + 1] ?? 127))).toBe(true);
    await create();
    frame(vec3());
    expect(draws()[0].drawBucket).toBe(mergedBucket('smokePuff'));
  });

  it('keeps room for any number of sprites, and draws none once cleared', async () => {
    await create();
    const xs = Array.from({ length: 100 }, (_, i) => i);
    frame(...xs.map((x) => vec3(x, 0, 0)));
    expectClose(shown().map((quad) => centre(quad).x), xs);
    sprites!.clear();
    expect(draws()).toEqual([]);
  });

  it('draws one sprite for the warm-up, and nothing after it', async () => {
    await create();
    const warmed = sprites!.warm();
    warmed.at(0);
    expect(shown()).toHaveLength(1);
    warmed.end();
    expect(draws()).toEqual([]);
  });

  it("keys a merged batch, a stage at a time, by its first sprite's entity", async () => {
    const scene = new SceneDraws(new SceneShaders(), {
      models: [],
      effects: [layer],
      gun: [],
      screen: []
    });
    const library = new AssetLibrary(
      new Map([
        ['scripts/gfx.shader', encode(`smokePuff { entityMergable { ${STAGE} } { ${SECOND} } }`)],
        ['gfx/misc/smokepuff3.tga', whiteTga()],
        ['gfx/misc/second.tga', whiteTga()]
      ])
    );
    sprites = await MergedSprites.create(app, library, 'smokePuff', node, [layer], camera, scene);
    sprites.begin();
    sprites.add(vec3(), 8, 0, WHITE, localEntity(5));
    sprites.add(vec3(16, 0, 0), 8, 0, WHITE, localEntity(6));
    sprites.end();
    const tags = draws().map((draw) => sceneDraw(draw)!);
    expect(tags.map((tag) => [tag.entity.value, tag.step])).toEqual([
      [localEntity(5), 0],
      [localEntity(5), 1]
    ]);
    expect(tags[0].shader).toBe(scene.shaders.handle('smokePuff', LIGHTMAP_2D));
  });

  it("keys any other shader's sprites one at a time, each by its own entity", async () => {
    const scene = new SceneDraws(new SceneShaders(), {
      models: [],
      effects: [layer],
      gun: [],
      screen: []
    });
    const library = new AssetLibrary(
      new Map([
        ['scripts/gfx.shader', encode(`smokePuff { { ${STAGE} } { ${SECOND} } }`)],
        ['gfx/misc/smokepuff3.tga', whiteTga()],
        ['gfx/misc/second.tga', whiteTga()]
      ])
    );
    sprites = await MergedSprites.create(app, library, 'smokePuff', node, [layer], camera, scene);
    sprites.begin();
    sprites.add(vec3(), 8, 0, WHITE, localEntity(5));
    sprites.add(vec3(16, 0, 0), 8, 0, WHITE, localEntity(6));
    sprites.end();
    const tags = draws().map((draw) => sceneDraw(draw)!);
    expect(tags.map((tag) => [tag.entity.value, tag.step])).toEqual([
      [localEntity(5), 0],
      [localEntity(5), 1],
      [localEntity(6), 0],
      [localEntity(6), 1]
    ]);
  });

  it('ends a merged run at a change of fog, each reading its fog in the world frame', async () => {
    const scene = new SceneDraws(new SceneShaders(), {
      models: [],
      effects: [layer],
      gun: [],
      screen: []
    });
    const fogs = loadFogs(
      testBsp(fogParts([{ mins: [0, 0, -64], maxs: [64, 64, 64], shader: 'fog' }])),
      () => ({ fogParms: { color: [1, 1, 1], depthForOpaque: 100 } })
    );
    const sceneFogs = new SceneFogs(fogs, [[255, 255, 255, 255]]);
    sceneFogs.view([-100, 32, 0], [1, 0, 0]);
    scene.enter({ layer, fog: sceneFogs, key: () => {} });
    const library = new AssetLibrary(
      new Map([
        ['scripts/gfx.shader', encode(`smokePuff { entityMergable { ${STAGE} } { ${SECOND} } }`)],
        ['gfx/misc/smokepuff3.tga', whiteTga()],
        ['gfx/misc/second.tga', whiteTga()]
      ])
    );
    sprites = await MergedSprites.create(app, library, 'smokePuff', node, [layer], camera, scene);
    sprites.begin();
    // Out, in, in, out: the middle two one run.
    sprites.add(vec3(100, 0, 0), 8, 0, WHITE, localEntity(1));
    sprites.add(vec3(32, 32, 0), 8, 0, WHITE, localEntity(2));
    sprites.add(vec3(40, 32, 0), 8, 0, WHITE, localEntity(3));
    sprites.add(vec3(200, 0, 0), 8, 0, WHITE, localEntity(4));
    sprites.end();
    const drawn = draws();
    const tags = drawn.map((draw) => sceneDraw(draw)!);
    expect(tags.map((tag) => [tag.entity.value, tag.entity.fog, tag.step])).toEqual([
      [localEntity(1), 0, 0],
      [localEntity(1), 0, 1],
      [localEntity(2), 1, 0],
      [localEntity(2), 1, 1],
      [localEntity(4), 0, 0],
      [localEntity(4), 0, 1]
    ]);
    expect(drawn.map((draw) => quads(draw).length)).toEqual([1, 1, 2, 2, 1, 1]);
    expect([...tags[2].entity.fogData]).toEqual([...sceneFogs.worldData(1)]);
    expect([...tags[0].entity.fogData]).toEqual(new Array(12).fill(0));
    expect(held(drawn[2], FOG_UNIFORM)).toBe(tags[2].entity.fogData);
    // Each stage dimmed by its fog, as its blend says.
    const material = drawn[0].material as StandardMaterial;
    expect([material.defines.has('Q3_FOG_ALPHA'), material.defines.has('Q3_FOG_RGB')]).toEqual([
      true,
      false
    ]);
  });

  it('takes its draws out of its layers when destroyed', async () => {
    await create();
    frame(vec3());
    sprites!.destroy();
    sprites = undefined;
    expect(layer.meshInstances).toEqual([]);
  });
});
