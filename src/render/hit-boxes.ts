import {
  ADDRESS_CLAMP_TO_EDGE,
  BLEND_ADDITIVE,
  CULLFACE_NONE,
  Entity,
  FILTER_LINEAR,
  FILTER_LINEAR_MIPMAP_LINEAR,
  Mesh,
  MeshInstance,
  PIXELFORMAT_RGBA8,
  StandardMaterial,
  Texture,
  type AppBase,
  type GraphicsDevice
} from 'playcanvas';

import type { HitBox } from '../view/hit-boxes';
import { WORLD_ENTITY } from '../view/scene-sort';
import { LIGHTMAP_2D, fogAdjustment } from '../view/world-shaders';
import { dimEffectStages } from './bsp-fog';
import { applyQuakeTransform, setMaterial } from './md3-mesh';
import { sceneEntity, type SceneDraws, type SceneEntity } from './scene-draws';
import { setGain } from './stage-gain';
import { showHidden, type Warmed } from './warm-up';

/**
 * The hit boxes `cg_drawBBox` asks for, drawn as Excessive Plus's `bbox_nocull` shader draws
 * them: its border texture across each face, added onto the scene in the box's colour
 * (`rgbGen vertex`, `blendFunc GL_ONE GL_ONE`), both sides showing. The texture is black inside,
 * so a box shows as glowing edges over clear faces. Its faces are polys, which a scene sorts with
 * the world's surfaces, after every entity.
 */

/** The shader Excessive Plus draws a box in, which it registers by name. */
const BOX_SHADER = 'bbox_nocull';

/** How a box's colour is drawn. */
const BOX_STAGE = {
  rgbGen: 'vertex',
  blend: 'add',
  blendFactors: ['gl_one', 'gl_one'] as [string, string]
} as const;

/** The border texture's size, as Excessive Plus's `gfx/misc/bbox` is. */
const SIZE = 32;

/**
 * That texture's border, read from it: how bright each row is, in from an edge, out to where it
 * is black.
 */
const BORDER = [229, 168, 86, 26, 2];

/**
 * The border texture at a texel: where two edges meet, each lets through what the other leaves
 * dark, which is how the texture's corners come out.
 */
export function borderTexel(x: number, y: number): number {
  const edge = (i: number) => BORDER[Math.min(i, SIZE - 1 - i)] ?? 0;
  return Math.round(255 - ((255 - edge(x)) * (255 - edge(y))) / 255);
}

export class HitBoxes {
  private readonly root: Entity;
  private readonly layers: number[];
  private readonly scene: SceneDraws | undefined;
  private readonly mesh: Mesh;
  private readonly texture: Texture;
  private readonly pool: { entity: Entity; instance: MeshInstance; order: SceneEntity }[] = [];
  /** A material for each colour asked for, made once and kept. */
  private readonly materials = new Map<string, StandardMaterial>();

  private constructor(
    app: AppBase,
    layers: number[],
    mesh: Mesh,
    texture: Texture,
    scene: SceneDraws | undefined
  ) {
    this.layers = layers;
    this.scene = scene;
    this.mesh = mesh;
    this.texture = texture;
    this.root = new Entity('hit-boxes');
    applyQuakeTransform(this.root);
    app.root.addChild(this.root);
  }

  /**
   * @param layers - The layers they draw in: the effects', which blend over the map.
   * @param scene - The scene they are placed in, where a map's world is drawn.
   */
  static create(app: AppBase, layers: number[], scene?: SceneDraws): HitBoxes {
    const device = app.graphicsDevice;
    return new HitBoxes(app, layers, createBoxMesh(device), createBorderTexture(device), scene);
  }

  /** Draw this frame's boxes, and nothing of the last frame's that is not among them. */
  update(boxes: readonly HitBox[]): void {
    boxes.forEach(({ origin, mins, maxs, color }, i) => {
      const drawn = this.pool[i] ?? this.spawn();
      drawn.entity.enabled = true;
      drawn.entity.setLocalPosition(
        origin.x + (mins.x + maxs.x) / 2,
        origin.y + (mins.y + maxs.y) / 2,
        origin.z + (mins.z + maxs.z) / 2
      );
      drawn.entity.setLocalScale(maxs.x - mins.x, maxs.y - mins.y, maxs.z - mins.z);
      setMaterial(drawn.instance, this.material(color));
      // Its six polys in one draw, in the fog their box finds (`RE_AddPolyToScene`).
      const { fogBy } = drawn.order;
      if (fogBy?.kind === 'box') {
        fogBy.mins[0] = origin.x + mins.x;
        fogBy.mins[1] = origin.y + mins.y;
        fogBy.mins[2] = origin.z + mins.z;
        fogBy.maxs[0] = origin.x + maxs.x;
        fogBy.maxs[1] = origin.y + maxs.y;
        fogBy.maxs[2] = origin.z + maxs.z;
      }
    });
    for (let i = boxes.length; i < this.pool.length; i++) this.pool[i].entity.enabled = false;
  }

  /** A box, for the warm-up (`warm-up.ts`). */
  warm(): Warmed {
    let hide: (() => void) | null = null;
    return {
      at: () => {
        if (hide) return;
        // Hidden, as a box no frame asks for is, for the warm-up to show and hide again.
        if (this.pool.length === 0) this.spawn().entity.enabled = false;
        hide = showHidden(this.root);
      },
      end: () => {
        hide?.();
        hide = null;
      }
    };
  }

  destroy(): void {
    this.root.destroy();
    for (const material of this.materials.values()) material.destroy();
    this.mesh.destroy();
    this.texture.destroy();
  }

  /** Another box to draw with. */
  private spawn(): HitBoxes['pool'][number] {
    const instance = new MeshInstance(this.mesh, this.material([0, 0, 0]));
    const entity = new Entity('hit-box');
    entity.addComponent('render', { meshInstances: [instance], layers: this.layers });
    const order = sceneEntity({ kind: 'box', mins: [0, 0, 0], maxs: [0, 0, 0] });
    order.value = WORLD_ENTITY;
    const { scene } = this;
    if (scene) {
      const shader = scene.shaders.handle(BOX_SHADER, LIGHTMAP_2D);
      scene.placeDrawing(entity.render!, 'effects', shader, order);
    }
    this.root.addChild(entity);
    const drawn = { entity, instance, order };
    this.pool.push(drawn);
    return drawn;
  }

  /** The border, added in a colour. */
  private material(color: HitBox['color']): StandardMaterial {
    const key = color.join();
    let material = this.materials.get(key);
    if (!material) {
      material = new StandardMaterial();
      material.useLighting = false;
      material.diffuse.set(0, 0, 0);
      setGain(material, BOX_STAGE, { color });
      material.emissiveMap = this.texture;
      material.blendType = BLEND_ADDITIVE;
      material.depthWrite = false;
      material.cull = CULLFACE_NONE;
      material.update();
      dimEffectStages([{ material, fog: fogAdjustment(BOX_STAGE, BOX_STAGE) }]);
      this.materials.set(key, material);
    }
    return material;
  }
}

/**
 * A unit cube about its centre. Each face has corners of its own, so the texture spans it once,
 * as each of the shader's quads does.
 */
function createBoxMesh(device: GraphicsDevice): Mesh {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (let axis = 0; axis < 3; axis++) {
    const across = (axis + 1) % 3;
    const up = (axis + 2) % 3;
    for (const side of [-0.5, 0.5]) {
      const base = positions.length / 3;
      for (const [s, t] of [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1]
      ]) {
        const corner = [0, 0, 0];
        corner[axis] = side;
        corner[across] = s - 0.5;
        corner[up] = t - 0.5;
        positions.push(...corner);
        // Unlit, but a mesh built without a NORMAL stream draws nothing at all.
        const normal = [0, 0, 0];
        normal[axis] = Math.sign(side);
        normals.push(...normal);
        uvs.push(s, t);
      }
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }
  const mesh = new Mesh(device);
  mesh.setPositions(positions);
  mesh.setNormals(normals);
  mesh.setUvs(0, uvs);
  mesh.setIndices(indices);
  mesh.update();
  // Shared by every box, so none of their instances' retirements may free it.
  mesh.incRefCount();
  return mesh;
}

/** Excessive Plus's `gfx/misc/bbox`, made from its border. */
function createBorderTexture(device: GraphicsDevice): Texture {
  const texture = new Texture(device, {
    name: 'hit-box-border',
    width: SIZE,
    height: SIZE,
    format: PIXELFORMAT_RGBA8,
    mipmaps: true,
    minFilter: FILTER_LINEAR_MIPMAP_LINEAR,
    magFilter: FILTER_LINEAR,
    addressU: ADDRESS_CLAMP_TO_EDGE,
    addressV: ADDRESS_CLAMP_TO_EDGE
  });
  const pixels = texture.lock() as Uint8Array;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const value = borderTexel(x, y);
      pixels.set([value, value, value, 255], (y * SIZE + x) * 4);
    }
  }
  texture.unlock();
  return texture;
}
