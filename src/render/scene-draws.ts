import {
  BLEND_NONE,
  FUNC_EQUAL,
  FUNC_LESSEQUAL,
  type GraphNode,
  type Layer,
  type MeshInstance,
  type RenderComponent,
  type StandardMaterial
} from 'playcanvas';

import { UNITS_PER_METRE } from '../coords';
import type { Md3Frame } from '../formats/md3';
import {
  LOCAL_ENTITY_BASE,
  overHyperspaceKey,
  sceneKey,
  viewWeaponPart
} from '../view/scene-sort';
import type { SceneShaders, SortedShader } from '../view/scene-shaders';
import type { FogFrame } from '../view/world-fog';
import { LIGHTMAP_2D, LIGHTMAP_NONE } from '../view/world-shaders';
import { rendererStyle, sceneStyle } from '../view/overbright';
import { NO_SCENE_FOGS, type SceneFogs } from './bsp-fog';
import { FOG_UNIFORM } from './fog-chunks';
import { restyleModelChunks } from './model-chunks';
import { setFramebuffer } from './stage-gain';
import type { Warmed } from './warm-up';
import { OPAQUE_BLEND } from './world-stages';

type Vec3f = [number, number, number];

/**
 * A map's scene drawn as Quake 3 draws it: every draw of the 3D scene in the world's one list,
 * sorted by Q3's key (`view/scene-sort.ts`), at the values `opengl1` writes into its framebuffer,
 * with the ramp after the last of them. A model sorts among the world's blended shaders only
 * so, before the ramp: under water, the water blends over it, and behind glass the glass does.
 *
 * Where there is no map's world, on a splat map, each draw keeps a layer of the port's own and its
 * brightness on screen, as the splat holds a captured screen with the ramp already in it: the
 * models in World, what writes no depth in the effects' layer after the splat, and the gun in its
 * own camera's.
 *
 * Whoever builds a draw places its render component here, in the group it keeps where there is no
 * scene, and tags each of its draws with what Q3 sorts it by: its shader, its entity, and its step
 * among its entity's draws of the shader. Each frame it writes its entity's number, and
 * {@link SceneDraws.order} keys every draw in the scene before it is drawn.
 */

/**
 * How Q3 finds the fog an entity is drawn in, each frame, from where its draws are placed:
 * - `model`: an MD3, by the frame it is drawn at (`R_ComputeFogNum`), its draws reading the fog in
 *   its own frame, as `R_RotateForEntity` sets one up;
 * - `sprite`: a sprite, a beam or the rail's core, by its radius about its origin, a beam's start
 *   (`R_SpriteFogNum`);
 * - `box`: a box of polys, by its corners (`RE_AddPolyToScene`).
 * The last two read it as the world's frame has it, as Q3 draws every entity but a model there.
 */
export type FogSource =
  | {
      kind: 'model';
      frames: readonly Pick<Md3Frame, 'localOrigin' | 'radius'>[];
      /** The frame it is drawn at this frame: `refEntity.frame`, the newer. */
      frame: number;
    }
  | { kind: 'sprite'; radius: number }
  | { kind: 'box'; mins: [number, number, number]; maxs: [number, number, number] };

/** An entity's number in the scene's order, written by whoever draws it, each frame it draws. */
export interface SceneEntity {
  value: number;
  /** Its fog this frame, as the key holds it: 0 for none, else the fog's place plus one. */
  fog: number;
  /** What its draws read for their fog (`q3_fog`), in the frame they are placed in. */
  readonly fogData: Float32Array;
  /** How its fog is found each frame it is drawn; none where it is found by whoever draws it. */
  fogBy?: FogSource;
  /** The scene's frame its fog was last found in. */
  fogFound?: number;
}

/** A new entity, at the local entities' first number until it is first drawn, in no fog. */
export function sceneEntity(fogBy?: FogSource): SceneEntity {
  return { value: LOCAL_ENTITY_BASE, fog: 0, fogData: new Float32Array(12), fogBy };
}

/** A sprite's radius this frame, which its fog is found by. */
export function setFogRadius(entity: SceneEntity, radius: number): void {
  if (entity.fogBy?.kind === 'sprite') entity.fogBy.radius = radius;
}

/** What a draw sorts by in a map's scene. */
export interface SceneDraw {
  shader: SortedShader;
  entity: SceneEntity;
  /** Its step among its entity's draws of its shader (`modelStep`). */
  step: number;
  /**
   * `RF_DEPTHHACK`: the view weapon's, its depth squeezed into the front of the range
   * (`Q3_DEPTH_HACK`, `model-chunks.ts`).
   */
  depthHack?: boolean;
  /**
   * `RB_FogPass`: the fog's pass over a surface after its stages, drawn only while its entity is
   * in a fog and its shader takes one (`fogPass`).
   */
  fogPass?: boolean;
}

/** Which of the port's own layers a draw keeps where there is no scene. */
export type SceneGroup = 'models' | 'effects' | 'gun' | 'screen';

/** A map's world as its scene holds it: the layer every draw goes in, and its own keys. */
export interface SceneWorld {
  readonly layer: Layer;
  /** Its fogs, and the view they were last drawn from. */
  readonly fog: SceneFogs;
  /** Key the world's own draws, which only a shader sorted in or a brush model moved changes. */
  key(): void;
}

/** Where a model's draws are placed. */
export interface ScenePlacement {
  draws: SceneDraws;
  /**
   * The group its draws that write depth keep where there is no scene; those that write none keep
   * the effects' where it is the models', and its own otherwise.
   */
  group: SceneGroup;
  /**
   * The refEntity's `customShader` every surface draws, which cgame registers by name; none where
   * each surface draws its own or its skin's.
   */
  customShader?: string;
}

/** The handle a model's surface's draws sort by, in a placement. */
export function surfaceShader(placement: ScenePlacement, shader: string): SortedShader {
  const { customShader, draws } = placement;
  return customShader !== undefined
    ? draws.shaders.handle(customShader, LIGHTMAP_2D)
    : draws.shaders.handle(shader, LIGHTMAP_NONE);
}

/** Draws a module adds to layers itself, which move as a component's do. */
export interface LayeredDraws {
  setLayers(layers: readonly Layer[]): void;
}

const tags = new WeakMap<MeshInstance, SceneDraw>();

/** Tag a draw with what it sorts by in a map's scene, and give it its entity's fog to read. */
export function tagDraw(instance: MeshInstance, draw: SceneDraw): void {
  tags.set(instance, draw);
  instance.setParameter(FOG_UNIFORM, draw.entity.fogData);
}

/** Scratch: where a draw is placed, in Quake's frame. */
const placed: FogFrame & { origin: Vec3f; axis: [Vec3f, Vec3f, Vec3f] } = {
  origin: [0, 0, 0],
  axis: [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0]
  ]
};

/** Scratch for a box's corners. */
const corners: [Vec3f, Vec3f] = [
  [0, 0, 0],
  [0, 0, 0]
];

/**
 * A node's frame in Quake's world, as a refEntity's origin and axes: where its own x, y and z go,
 * taken back through `worldToSim`, so a vertex of its draws is the origin plus its coordinates
 * along them. A model's node is placed in a Quake frame, so these are its forward, left and up, as
 * long as it is scaled. They count as scaled, `nonNormalizedAxes`, where the first is not unit
 * length, as cgame flags every axis it scales.
 */
function quakeFrame(node: GraphNode, out: typeof placed): typeof placed {
  const m = node.getWorldTransform().data;
  const column = (at: number, to: Vec3f) => {
    to[0] = m[at] * UNITS_PER_METRE;
    to[1] = -m[at + 2] * UNITS_PER_METRE;
    to[2] = m[at + 1] * UNITS_PER_METRE;
  };
  column(0, out.axis[0]);
  column(4, out.axis[1]);
  column(8, out.axis[2]);
  column(12, out.origin);
  const length = Math.hypot(...out.axis[0]);
  out.nonNormalizedAxes = Math.abs(length - 1) > SCALED;
  return out;
}

/** How far from unit length an axis may be and still count as unscaled. */
const SCALED = 1e-4;

/** Draws out of any fog: their entities in none, and their fog passes hidden. */
function unfog(instances: readonly MeshInstance[]): void {
  for (const instance of instances) {
    const tag = tags.get(instance);
    if (!tag) continue;
    const { entity } = tag;
    entity.fog = 0;
    entity.fogData.fill(0);
    entity.fogFound = undefined;
    if (tag.fogPass) instance.visible = false;
  }
}

/** Find an entity's fog for this frame, and write what its draws read for it. */
function findFog(entity: SceneEntity, source: FogSource, node: GraphNode, fogs: SceneFogs): void {
  if (fogs.fogs.length === 0) {
    if (entity.fog !== 0) {
      entity.fog = 0;
      entity.fogData.fill(0);
    }
    return;
  }
  const frame = quakeFrame(node, placed);
  let fog = 0;
  switch (source.kind) {
    case 'model': {
      const drawn = source.frames[source.frame];
      if (drawn) fog = fogs.modelFog(frame.origin, drawn.localOrigin, drawn.radius);
      break;
    }
    case 'sprite':
      fog = fogs.spriteFog(frame.origin, source.radius);
      break;
    case 'box':
      for (let k = 0; k < 3; k++) {
        corners[0][k] = source.mins[k];
        corners[1][k] = source.maxs[k];
      }
      fog = fogs.polyFog(corners);
      break;
  }
  entity.fog = fog;
  fogs.writeEntityData(fog, frame, entity.fogData, source.kind === 'model');
}

/** What a draw sorts by in a map's scene, if it was tagged. */
export function sceneDraw(instance: MeshInstance): SceneDraw | undefined {
  return tags.get(instance);
}

/** The define the model chunks squeeze a draw's depth by. */
export const DEPTH_HACK_DEFINE = 'Q3_DEPTH_HACK';

/** The colour a fog's pass draws in: its material's emissive, which the draw's own overrides. */
const PASS_COLOR = 'material_emissive';

/** The scene a map's draws are placed in, and the layers they keep where there is none. */
export class SceneDraws {
  readonly shaders: SceneShaders;
  /**
   * `RDF_HYPERSPACE`: Q3 draws the view weapon alone over a grey this frame, so its draws key
   * after the grey's, which covers the rest (`hyperspace-screen.ts`).
   */
  hyperspace = false;
  /** The map's scene's layer; none where no map's world is drawn. */
  private scene: Layer | null = null;
  private world: SceneWorld | null = null;
  private readonly own: Record<SceneGroup, readonly Layer[]>;
  private readonly components = new Map<RenderComponent, SceneGroup>();
  private readonly batches = new Map<LayeredDraws, SceneGroup>();
  /** The materials drawn in the scene, at the framebuffer's values. */
  private readonly drawn = new Set<StandardMaterial>();
  /** Those opaque where there is no scene, which blend `GL_ONE GL_ZERO` in it. */
  private readonly opaque = new WeakSet<StandardMaterial>();
  /** Those whose depth is squeezed in it. */
  private readonly hacked = new WeakSet<StandardMaterial>();
  /** Counts the frames keyed, so an entity's fog is found once a frame. */
  private frame = 0;
  /** Whether a warm-up is drawing, which shows every fog pass not yet drawn, on a map with fogs. */
  private warming = false;
  /** The fog passes' materials drawn once, whose shaders and pipelines the device has for good. */
  private readonly passesDrawn = new WeakSet<StandardMaterial>();

  /**
   * @param shaders - The shaders' order the draws are keyed by.
   * @param own - The layers each group keeps where there is no scene.
   */
  constructor(shaders: SceneShaders, own: Readonly<Record<SceneGroup, readonly Layer[]>>) {
    this.shaders = shaders;
    this.own = { ...own };
  }

  /** The layers a group keeps where there is no scene, from now on: one made after the rest. */
  keepOwn(group: SceneGroup, layers: readonly Layer[]): void {
    this.own[group] = layers;
    if (this.scene) return;
    for (const [render, placed] of this.components) {
      if (placed === group) render.layers = this.layerIds(group);
    }
    for (const [draws, placed] of this.batches) if (placed === group) draws.setLayers(layers);
  }

  /**
   * Place a drawing's render component, and tag its draws as one entity's of one shader, step by
   * step in their order.
   *
   * @returns Its entity, for whoever draws it to number each frame.
   */
  placeDrawing(
    render: RenderComponent,
    group: SceneGroup,
    shader: SortedShader,
    entity: SceneEntity = sceneEntity()
  ): SceneEntity {
    this.place(render, group);
    render.meshInstances.forEach((instance, step) => tagDraw(instance, { shader, entity, step }));
    return entity;
  }

  /** The layers a group draws in now: the scene's, or its own. */
  layersOf(group: SceneGroup): readonly Layer[] {
    return this.scene ? [this.scene] : this.own[group];
  }

  /** {@link layersOf}, by their ids, as a render component takes them. */
  layerIds(group: SceneGroup): number[] {
    return this.layersOf(group).map((layer) => layer.id);
  }

  /** Whether a map's scene is drawn: its draws in the world's list, at the framebuffer's values. */
  get inScene(): boolean {
    return this.scene !== null;
  }

  /** The scene's fogs: its world's, or none where no map's world is drawn. */
  get fog(): SceneFogs {
    return this.world?.fog ?? NO_SCENE_FOGS;
  }

  /** Put a render component's draws in the group's layers, now and at each change of scene. */
  place(render: RenderComponent, group: SceneGroup): void {
    render.layers = this.layerIds(group);
    if (this.components.has(render)) {
      this.components.set(render, group);
      return;
    }
    this.components.set(render, group);
    render.entity.once('destroy', () => this.components.delete(render));
  }

  /** Put draws a module adds itself in the group's layers, now and at each change of scene. */
  placeBatch(draws: LayeredDraws, group: SceneGroup): void {
    draws.setLayers(this.layersOf(group));
    this.batches.set(draws, group);
  }

  /** Let go of draws placed with {@link placeBatch}, which are going. */
  release(draws: LayeredDraws): void {
    this.batches.delete(draws);
  }

  /**
   * A map's load: its world's scene, every placed draw moved into its layer, or none, every draw
   * back in its own layer at its brightness on screen.
   */
  enter(world: SceneWorld | null): void {
    if (world !== this.world) {
      // Out of the last world's fogs, until the new one finds its own.
      for (const render of this.components.keys()) unfog(render.meshInstances);
    }
    this.world = world;
    const scene = world?.layer ?? null;
    if (scene === this.scene) return;
    this.scene = scene;
    if (!scene) {
      for (const material of this.drawn) this.restore(material);
      this.drawn.clear();
    }
    for (const [render, group] of this.components) render.layers = this.layerIds(group);
    for (const [draws, group] of this.batches) draws.setLayers(this.layersOf(group));
  }

  /** A world going: no scene from now on, if it was the one drawn. */
  leave(world: SceneWorld): void {
    if (this.world === world) this.enter(null);
  }

  /**
   * Key every draw in the scene by Q3's sort, before the frame is drawn, each drawn the first time
   * at the framebuffer's values, and each entity's fog found for the frame. A draw no one tagged is
   * the world's own, which keys itself.
   */
  order(): void {
    const { scene, shaders } = this;
    if (!scene) return;
    const fogs = this.fog;
    const frame = ++this.frame;
    const instances = scene.meshInstances;
    for (let i = 0; i < instances.length; i++) {
      const instance = instances[i];
      const tag = tags.get(instance);
      if (!tag) continue;
      const material = instance.material as StandardMaterial;
      if (!this.drawn.has(material)) this.draw(material, tag);
      const place = shaders.place(tag.shader);
      const { entity } = tag;
      if (entity.fogBy && entity.fogFound !== frame) {
        entity.fogFound = frame;
        findFog(entity, entity.fogBy, instance.node, fogs);
      }
      if (tag.fogPass) this.pass(instance, tag, fogs);
      instance.drawOrder =
        this.hyperspace && tag.depthHack
          ? overHyperspaceKey(place, viewWeaponPart(entity.value), tag.step)
          : sceneKey(place, entity.value, entity.fog, false, tag.step);
    }
    // After every first use, which may have sorted a shader in and moved the world's places.
    this.world?.key();
  }

  /**
   * A fog's pass over a surface, shown while its entity is in a fog its shader takes one for
   * (`fogPass`), in that fog's colour, its depth tested as the shader's pass says.
   */
  private pass(instance: MeshInstance, tag: SceneDraw, fogs: SceneFogs): void {
    const { fog } = tag.entity;
    const taken = tag.shader.shader?.fogPass ?? 'none';
    const material = instance.material as StandardMaterial;
    const shown =
      taken !== 'none' &&
      (this.warming ? fogs.fogs.length > 0 && !this.passesDrawn.has(material) : fog > 0);
    instance.visible = shown;
    if (!shown) return;
    this.passesDrawn.add(material);
    if (fog > 0) instance.setParameter(PASS_COLOR, fogs.passColor(fog));
    const depthFunc = taken === 'lessEqual' ? FUNC_LESSEQUAL : FUNC_EQUAL;
    if (material.depthFunc !== depthFunc) {
      material.depthFunc = depthFunc;
      material.update();
    }
  }

  /**
   * Every fog pass not yet drawn whose shader takes one shown for a warm-up, on a map with fogs, so
   * that each is made under the load screen and not as a model first walks into a fog: a new look's
   * at its own.
   */
  warm(): Warmed {
    return {
      at: () => {
        this.warming = true;
      },
      end: () => {
        this.warming = false;
      }
    };
  }

  /**
   * A material drawn in the scene: at the framebuffer's values, an opaque one blended, a model's
   * shaded as `opengl1` shades it under either style.
   */
  private draw(material: StandardMaterial, tag: SceneDraw): void {
    this.drawn.add(material);
    setFramebuffer(material, true);
    const style = rendererStyle();
    if (style.renderer !== 'opengl1') restyleModelChunks(material, sceneStyle(style));
    if (!material.transparent) {
      this.opaque.add(material);
      material.blendState = OPAQUE_BLEND;
    }
    if (tag.depthHack) {
      this.hacked.add(material);
      material.setDefine(DEPTH_HACK_DEFINE, true);
    }
    material.update();
  }

  /**
   * A material out of the scene: its brightness on screen, opaque again, its depth its own, shaded
   * in the style's own way.
   */
  private restore(material: StandardMaterial): void {
    setFramebuffer(material, false);
    const style = rendererStyle();
    if (style.renderer !== 'opengl1') restyleModelChunks(material, style);
    if (this.opaque.has(material)) {
      this.opaque.delete(material);
      material.blendType = BLEND_NONE;
    }
    if (this.hacked.has(material)) {
      this.hacked.delete(material);
      material.setDefine(DEPTH_HACK_DEFINE, false);
    }
    material.update();
  }
}
