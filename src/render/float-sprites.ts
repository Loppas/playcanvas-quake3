import { Entity, MeshInstance, type AppBase, type Mesh, type StandardMaterial } from 'playcanvas';

import type { AssetLibrary } from '../formats/asset-library';
import { MEDAL_SHADERS, NUMBER_NAMES, SPRITE_SHADERS } from '../formats/asset-manifest';
import { findShader } from '../formats/shader-script';
import type { FloatSprite } from '../view/player-sprites';
import { LIGHTMAP_2D } from '../view/world-shaders';
import { dimEffectStages } from './bsp-fog';
import { createEffectStages, type EffectStage } from './effect-material';
import { applyQuakeTransform, setMaterial } from './md3-mesh';
import { sceneEntity, setFogRadius, type SceneDraws, type SceneEntity } from './scene-draws';
import { cloneMaterial, tintGain } from './stage-gain';
import { showHidden, type Warmed } from './warm-up';
import { createSpriteMesh } from './world-effects';

/**
 * The sprites that float in the world, turned to face the view: what `CG_PlayerSprites` puts over
 * a head, and the score plums' digits (`RT_SPRITE`, `RB_SurfaceSprite`).
 *
 * A sprite takes its `shaderRGBA` only where its shader reads the vertex colour, as the HUD's
 * pictures do: the plums' digits are `rgbGen vertex`, and so fade and take their colour, while the
 * medals and the markers draw as their images are. In a map's scene each is its entity's sprite,
 * in cgame's `customShader`.
 */

/** Every shader a floating sprite is drawn with. */
export const FLOAT_SPRITE_SHADERS: readonly string[] = [
  ...Object.values(SPRITE_SHADERS),
  ...Object.values(MEDAL_SHADERS),
  ...NUMBER_NAMES.map((name) => `gfx/2d/numbers/${name}_32b`)
];

/** One shader's stages, whether they take the colour, and the quads drawn with it so far. */
interface SpriteShader {
  stages: EffectStage[];
  /** `rgbGen vertex` or `exactVertex`: tinted by the sprite's colour. */
  tinted: boolean;
  /** `alphaGen vertex`, which `rgbGen vertex` brings with it: faded by the colour's alpha. */
  faded: boolean;
  pool: { entity: Entity; instances: MeshInstance[]; order: SceneEntity }[];
}

export class FloatSprites {
  private readonly root: Entity;
  private readonly camera: Entity;
  private readonly layers: number[];
  private readonly mesh: Mesh;
  private readonly shaders: Map<string, SpriteShader>;
  /** A stage's material in each colour asked of it, made once and kept. */
  private readonly tints = new Map<StandardMaterial, Map<string, StandardMaterial>>();
  private readonly scene: SceneDraws | undefined;

  private constructor(
    app: AppBase,
    camera: Entity,
    layers: number[],
    mesh: Mesh,
    shaders: Map<string, SpriteShader>,
    scene: SceneDraws | undefined
  ) {
    this.scene = scene;
    this.camera = camera;
    this.layers = layers;
    this.mesh = mesh;
    this.shaders = shaders;
    this.root = new Entity('float-sprites');
    applyQuakeTransform(this.root);
    app.root.addChild(this.root);
  }

  /**
   * Build every shader a sprite can be drawn with. One the install has no script for is left
   * out, and a sprite asking for it draws nothing.
   *
   * @param camera - What the sprites turn to face.
   * @param layers - The layers they draw in: the effects', which blend over the map.
   * @param scene - The scene they are placed in, where a map's world is drawn.
   */
  static async create(
    app: AppBase,
    library: AssetLibrary,
    camera: Entity,
    layers: number[],
    scene?: SceneDraws
  ): Promise<FloatSprites> {
    const shaders = new Map<string, SpriteShader>();
    for (const name of FLOAT_SPRITE_SHADERS) {
      const shader = findShader(library.shaders, name);
      if (!shader) continue;
      const first = shader.stages.find((stage) => stage.maps.some((map) => !map.startsWith('$')));
      const stages = await createEffectStages(app, library, name);
      dimEffectStages(stages);
      shaders.set(name, {
        stages,
        tinted: first?.rgbGen === 'vertex' || first?.rgbGen === 'exactVertex',
        faded: first?.alphaGen === 'vertex',
        pool: []
      });
    }
    const mesh = createSpriteMesh(app.graphicsDevice);
    return new FloatSprites(app, camera, layers, mesh, shaders, scene);
  }

  /** Draw this frame's sprites, and nothing of the last frame's that is not among them. */
  update(sprites: readonly FloatSprite[]): void {
    const used = new Map<SpriteShader, number>();
    for (const sprite of sprites) {
      const shader = this.shaders.get(sprite.shader);
      if (!shader) continue;
      const n = used.get(shader) ?? 0;
      used.set(shader, n + 1);
      const quad = shader.pool[n] ?? this.spawn(shader, sprite.shader);

      quad.entity.enabled = true;
      quad.order.value = sprite.order;
      quad.entity.setLocalPosition(sprite.origin.x, sprite.origin.y, sprite.origin.z);
      // Turned with the camera, so the quad lies in the screen's plane, and two radii across.
      quad.entity.setRotation(this.camera.getRotation());
      const size = sprite.radius * 2;
      quad.entity.setLocalScale(size, size, size);
      setFogRadius(quad.order, sprite.radius);

      shader.stages.forEach((stage, i) => {
        const instance = quad.instances[i];
        const tinted = shader.tinted ? this.tinted(stage.material, sprite.color) : null;
        setMaterial(instance, tinted ?? stage.material);
        if (shader.faded) instance.setParameter('material_opacity', sprite.color[3]);
      });
    }
    for (const shader of this.shaders.values()) {
      for (let i = used.get(shader) ?? 0; i < shader.pool.length; i++) {
        shader.pool[i].entity.enabled = false;
      }
    }
  }

  /** A sprite of every shader, for the warm-up (`warm-up.ts`). None of their stages plays. */
  warm(): Warmed {
    let hide: (() => void) | null = null;
    return {
      at: () => {
        if (hide) return;
        for (const [name, shader] of this.shaders) {
          // Hidden, as a quad no frame asks for is, for the warm-up to show and hide again.
          if (shader.pool.length === 0) this.spawn(shader, name).entity.enabled = false;
        }
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
    for (const tints of this.tints.values()) {
      for (const material of tints.values()) material.destroy();
    }
  }

  /** Another quad for a shader, one mesh instance a stage. */
  private spawn(shader: SpriteShader, name: string): SpriteShader['pool'][number] {
    const instances = shader.stages.map((stage) => new MeshInstance(this.mesh, stage.material));
    const entity = new Entity(`float-sprite:${name}`);
    entity.addComponent('render', { meshInstances: instances, layers: this.layers });
    this.root.addChild(entity);
    const { scene } = this;
    const order = sceneEntity({ kind: 'sprite', radius: 0 });
    scene?.placeDrawing(entity.render!, 'effects', scene.shaders.handle(name, LIGHTMAP_2D), order);
    const quad = { entity, instances, order };
    shader.pool.push(quad);
    return quad;
  }

  /** A stage's material with its brightness multiplied by a colour. */
  private tinted(base: StandardMaterial, color: readonly number[]): StandardMaterial {
    let tints = this.tints.get(base);
    if (!tints) {
      tints = new Map();
      this.tints.set(base, tints);
    }
    const key = `${color[0]},${color[1]},${color[2]}`;
    let material = tints.get(key);
    if (!material) {
      material = cloneMaterial(base);
      tintGain(material, [color[0], color[1], color[2]]);
      material.update();
      tints.set(key, material);
    }
    return material;
  }
}
