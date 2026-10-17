import {
  ASPECT_MANUAL,
  BLENDEQUATION_ADD,
  BLENDMODE_DST_COLOR,
  BLENDMODE_ONE,
  BLENDMODE_ZERO,
  BUFFER_DYNAMIC,
  BUFFER_STATIC,
  BlendState,
  CULLFACE_NONE,
  Entity,
  GraphNode,
  INDEXFORMAT_UINT32,
  IndexBuffer,
  LAYERID_WORLD,
  Layer,
  Mesh,
  MeshInstance,
  PRIMITIVE_TRIANGLES,
  Quat,
  SEMANTIC_COLOR,
  SEMANTIC_NORMAL,
  SEMANTIC_POSITION,
  SEMANTIC_TEXCOORD0,
  SEMANTIC_TEXCOORD1,
  SORTMODE_MANUAL,
  StandardMaterial,
  TYPE_FLOAT32,
  TYPE_UINT8,
  VertexBuffer,
  VertexFormat,
  VertexIterator,
  type AppBase,
  type CameraComponent,
  type GraphicsDevice,
  type Texture
} from 'playcanvas';

import { UNITS_PER_METRE } from '../coords';
import { AssetLibrary } from '../formats/asset-library';
import type { LoadedMap } from '../game-map';
import { LIGHTMAP_SIZE, type Bsp, type BspDrawVerts } from '../formats/bsp';
import { readEntities } from '../formats/entity-text';
import { parseMd3 } from '../formats/md3';
import { SS_OPAQUE, findShader, type Deform, type ShaderScript } from '../formats/shader-script';
import { MAX_GENTITIES } from '../net/protocol';
import type { PakFileSystem } from '../pak/vfs';
import { MAX_SUBMODELS } from '../sim/cm/cm-local';
import { angleVectors, type ViewBasis } from '../sim/pmove-math';
import { vec3 } from '../sim/vec3';
import { moverModel2s, type BrushModelPose } from '../view/brush-models';
import type { FirstPersonView } from '../view/camera-feel';
import {
  MAX_DLIGHTS,
  projectLight,
  projectedLight,
  type DynamicLight
} from '../view/dynamic-lights';
import {
  SUN_DIRECTION,
  entityLight,
  entityLightAt,
  keptEntityLight,
  lightInEntityFrame,
  type KeptEntityLight,
  type LightingScene
} from '../view/entity-light';
import { anglesToAxis, type Axis } from '../view/hand-pose';
import { loadLightGrid, worldGridSize, type LightGrid } from '../view/light-grid';
import { identityLight, rendererStyle, sceneStyle, type RendererStyle } from '../view/overbright';
import { batchNormals } from '../view/view-terms';
import { worldRuns, type WorldRun } from '../view/world-batches';
import { loadPatchGrids, type PatchGrid } from '../view/world-curves';
import {
  WORLD_ENTITY,
  anglesToAxes,
  globalVectorToLocal,
  type DeformEntity
} from '../view/world-deforms';
import { FOG_S, FOG_T, WORLD_FRAME, fogColor, fogImage, type FogFrame } from '../view/world-fog';
import {
  WorldIndexes,
  gridBases,
  viewSpeeds,
  worldPositions,
  type BatchRange,
  type ViewSpeeds
} from '../view/world-indexes';
import { lightmapPages, shiftedVertexColors } from '../view/world-light';
import { drawnShader, remapShader, shaderSwaps } from '../view/world-remap';
import {
  DEFAULT_IMAGE,
  loadWorldShaders,
  type WorldShader,
  type WorldShaders
} from '../view/world-shaders';
import { WorldVis, type VisModel, type VisSwitches } from '../view/world-vis';
import { ClipCache, keptTriangles, type DlightSpeeds } from '../view/world-dlights';
import { WorldMarks } from '../view/world-marks';
import { MAX_POLYS, type ScenePolys } from '../view/scene-polys';
import type { SortedShader } from '../view/scene-shaders';
import {
  MAX_STEP,
  WORLD_ENTITY as REFENTITYNUM_WORLD,
  packetEntity,
  rampKey,
  sceneKey
} from '../view/scene-sort';
import { axisRotation } from './axis-rotation';
import { FogUniforms, SceneFogs, fogPassMaterial } from './bsp-fog';
import { FOG_UNIFORM } from './fog-chunks';
import { BspSky, SKY_TEXORDER, atFarPlane, type SkyMaterials } from './bsp-sky';
import type { ImageSource } from './effect-material';
import { applyQuakeTransform, createTexture, loadTexture, q3CullMode } from './md3-mesh';
import type { SkinStage } from './skin-material';
import { writeLight } from './model-chunks';
import {
  FIRST_FRAME,
  buildStagedModel,
  drawPlacedModel,
  ownShader,
  playStagedStages,
  type StagedModel
} from './staged-model';
import type { SceneDraws, SceneWorld } from './scene-draws';
import type { ResourceScope, TextureCache } from './texture-cache';
import { EYE_UNIFORM, EyeUniforms, LIGHT_UNIFORM } from './view-term-chunks';
import { showHidden, type Warmed } from './warm-up';
import { WorldDlights } from './world-dlights';
import { WorldPolys } from './world-polys';
import {
  DeformedRuns,
  type DeformedRunOptions,
  type RunDeforms,
  type WorldVertexData
} from './world-deforms';
import { OPAQUE_BLEND, WorldStages, type PolygonOffset, type WorldStage } from './world-stages';

/**
 * A map's world drawn from its BSP, as opengl1 draws it: its faces, triangle soups and curves, and
 * its brush models where each frame's scene places them, lit by its lightmaps and vertex colours,
 * each shader's surfaces in opengl1's batches and each batch stage by stage, in opengl1's order.
 *
 * Every vertex of the map is in one buffer, side by side as `drawVert_t` holds them, the points of
 * the curves' grids after the map's own, and every batch is a range of one index buffer, its
 * surfaces' indexes offset by where their vertices start, since WebGL2 has no base vertex. Each
 * stage of a batch is one draw, a shader's first two merged into one where opengl1 merges them.
 *
 * Each view finds what it sees as Q3 does (`view/world-vis.ts`), and a run whose seen surfaces or
 * curve rows changed is cut again in its place (`view/world-indexes.ts`): its draws take the new
 * ranges, those it has no use for are hidden, and only its indexes are uploaded. So the engine's
 * own cull is off for every draw here.
 *
 * The world's draws go in a layer of their own, drawn before World, in one list sorted by hand.
 * PlayCanvas files a draw under its layer's opaque or blended pass by its material's blend alone,
 * and Q3 draws a shader's stages in turn whatever they blend, so every stage here blends: an
 * opaque one as `GL_ONE GL_ZERO`, which writes what no blend writes. Split, two coplanar
 * surfaces would come out as both textures multiplied, where Q3 shows the later one.
 *
 * Each stage draws the colour opengl1 writes into its framebuffer, and the ramp pass ends the list,
 * doubling the screen once for each overbright bit as the display's gamma ramp does
 * (`view/overbright.ts`). Its moving parts play on the preview's clock each frame, for the shaders
 * the view draws (`world-stages.ts`), and so do the brush models' `model2`s.
 *
 * A sky's batches draw its box and clouds in their place in the list (`bsp-sky.ts`), and none of
 * their own triangles.
 *
 * A batch in a fog draws its fog's pass after its stages, and its blended stages may be dimmed by
 * the fog instead (`bsp-fog.ts`). Both read the fog's vectors for the view, written at each one. So
 * too a stage that reads the view reads the eye in its frame (`view-term-chunks.ts`).
 *
 * A shader the map's entities can swap (`view/world-remap.ts`) has its batches' draws made for
 * each shader it may draw instead too, in its place in the list and built with the rest, so a swap
 * compiles nothing. Only the draws of the shader a run draws now show. A sky is never swapped.
 */

/** The layer a map's world draws in. */
export const WORLD_LAYER_NAME = 'bsp-world';

/**
 * A brush model's entity's number where no pose names its mover, as a preview's do: one of the
 * last numbers a snapshot can hold, in its model's order, so two never tie.
 *
 * @param model - Its inline model's number.
 */
function unnumbered(model: number): number {
  return packetEntity(MAX_GENTITIES - MAX_SUBMODELS + model);
}

/** The part of its mover's entity a brush model's `model2` is, after the model itself. */
const MODEL2_PART = 1;

/** Where Q3's default image is read from, as a TGA of its own. */
const DEFAULT_IMAGE_PATH = `${DEFAULT_IMAGE}.tga`;

/** `DEFAULT_SIZE` (`tr_image.c:1183`). */
const DEFAULT_SIZE = 16;

/**
 * `R_CreateDefaultImage` (`tr_image.c:1190-1218`) as a TGA: every byte 32, and a border of 255
 * one texel wide all round, so the default shader shows a dark grid at each repeat.
 */
export function defaultImageTga(): Uint8Array {
  const header = 18;
  const bytes = new Uint8Array(header + DEFAULT_SIZE * DEFAULT_SIZE * 4).fill(32, header);
  bytes.fill(0, 0, header);
  bytes[2] = 2; // uncompressed true colour
  bytes[12] = DEFAULT_SIZE;
  bytes[14] = DEFAULT_SIZE;
  bytes[16] = 32;
  bytes[17] = 0x28; // eight bits of alpha, the top row first
  const last = DEFAULT_SIZE - 1;
  for (let y = 0; y < DEFAULT_SIZE; y++) {
    for (let x = 0; x < DEFAULT_SIZE; x++) {
      if (x === 0 || y === 0 || x === last || y === last) {
        const at = header + (y * DEFAULT_SIZE + x) * 4;
        bytes.fill(255, at, at + 4);
      }
    }
  }
  return bytes;
}

/** The world's images: the search path's, and Q3's default image. */
function worldImages(fs: Pick<PakFileSystem, 'resolveImage' | 'read'>): ImageSource {
  return {
    resolveImage: (reference) =>
      reference === DEFAULT_IMAGE ? DEFAULT_IMAGE_PATH : fs.resolveImage(reference),
    read: (path) => (path === DEFAULT_IMAGE_PATH ? defaultImageTga() : fs.read(path))
  };
}

/**
 * How the ramp pass blends: `GL_DST_COLOR GL_ONE` with white, so each channel of the framebuffer
 * doubles and clamps at 1, as the ramp's `i << 1` does to a byte (`R_SetColorMappings`,
 * `tr_image.c:1313-1329`). The framebuffer's alpha is kept.
 */
const RAMP_BLEND = new BlendState(
  true,
  BLENDEQUATION_ADD,
  BLENDMODE_DST_COLOR,
  BLENDMODE_ONE,
  BLENDEQUATION_ADD,
  BLENDMODE_ZERO,
  BLENDMODE_ONE
);

/**
 * The display's gamma ramp as draws over the whole screen, one for each overbright bit: a quad in
 * clip space, white, neither testing depth nor writing it. None at 0, as Q3 in a window has none.
 *
 */
function rampDraws(device: GraphicsDevice, scope: ResourceScope, bits: number): MeshInstance[] {
  if (bits === 0) return [];
  const mesh = new Mesh(device);
  mesh.setPositions([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]);
  mesh.setIndices([0, 1, 2, 0, 2, 3]);
  mesh.update();
  const material = scope.own(new StandardMaterial());
  material.useLighting = false;
  material.diffuse.set(0, 0, 0);
  material.emissive.set(1, 1, 1);
  material.blendState = RAMP_BLEND;
  material.depthTest = false;
  material.depthWrite = false;
  material.cull = CULLFACE_NONE;
  material.update();
  const node = new GraphNode('ramp');
  return Array.from({ length: bits }, (_, i) => {
    const instance = new MeshInstance(mesh, material, node);
    // Placed by its vertices alone, so it covers the screen wherever the camera looks.
    instance.screenSpace = true;
    instance.cull = false;
    instance.drawOrder = rampKey(i);
    return instance;
  });
}

/**
 * Whether a shader's batches take the dynamic lights' passes, as `RB_StageIteratorGeneric` gives
 * them (`tr_shade.c:1070-1073`): sorted at most opaque, and neither `surfaceparm nodlight` nor
 * `sky` by its script. Every shader but a sky's draws by that iterator, as `r_ignoreFastPath` is 1.
 */
function takesDlights(shader: WorldShader): boolean {
  const parms = shader.script?.surfaceParms ?? [];
  return (
    shader.sky === undefined &&
    shader.sort <= SS_OPAQUE &&
    !parms.includes('nodlight') &&
    !parms.includes('sky')
  );
}

/** The light passes' material for a shader's batches: by its cull, and its pull toward the eye. */
function dlightMaterial(
  dlights: WorldDlights,
  shader: WorldShader,
  additive = false
): StandardMaterial {
  const pulled = shader.script?.polygonOffset === true;
  return dlights.material(q3CullMode(shader.script?.cull), pulled, additive);
}

/** Whether a fogged run of a shader draws its stages dimmed by the fog, rather than as they are. */
const dimmedByFog = (shader: WorldShader) =>
  shader.fogAdjustments.some((adjustment) => adjustment !== 'none');

/**
 * How a shader deforms a run it draws. A sky draws none of its own triangles, and a shader that
 * drops the map draws nothing.
 */
function runDeforms(stages: WorldStages, shader: WorldShader): RunDeforms {
  const all = shader.script?.deforms ?? [];
  const deforms: readonly Deform[] =
    shader.sky || stages.drops(shader) || all.every(({ type }) => type === 'none') ? [] : all;
  return {
    deforms,
    shader: shader.name,
    clampTime: shader.script?.clampTime ?? 0,
    timeOffset: shader.timeOffset
  };
}

/**
 * A sky's materials, all drawn at the far plane. The box's sides draw their faces as `DrawSkyBox`
 * binds them (`tr_sky.c:372, 482`), at `tr.identityLight`, neither blending nor writing depth,
 * and front-sided (`:800-804`). The faces are mipmapped, clamped and picmipped whatever the shader
 * says, and one that isn't there is Q3's default image, made otherwise (`tr_shader.c:1260-1276`).
 * The clouds are the shader's stages, made as the world's are.
 */
async function skyMaterials(
  app: AppBase,
  shader: WorldShader,
  images: ImageSource,
  stages: WorldStages,
  style: RendererStyle,
  scope: ResourceScope,
  picmip: number
): Promise<SkyMaterials> {
  const clouds = await stages.build(shader, false, true);
  const faces = shader.sky?.box ?? [];
  const light = identityLight(style);
  const box: StandardMaterial[] = [];
  for (const side of faces.length > 0 ? SKY_TEXORDER : []) {
    const face = faces[side];
    const own = face !== DEFAULT_IMAGE;
    const path = images.resolveImage(face);
    const bytes = path ? await images.read(path) : undefined;
    const material = scope.own(new StandardMaterial());
    material.useLighting = false;
    material.diffuse.set(0, 0, 0);
    material.emissive.set(light, light, light);
    if (path && bytes) {
      const halvings = own ? picmip : 0;
      material.emissiveMap = await loadTexture(app, path, bytes, own, true, scope, halvings);
      material.emissiveMapUv = 1;
    }
    material.blendState = OPAQUE_BLEND;
    material.depthWrite = false;
    material.cull = q3CullMode(undefined);
    box.push(material);
  }
  for (const material of [...box, ...clouds.map((cloud) => cloud.material)]) {
    atFarPlane(material);
    material.update();
  }
  return { box, clouds };
}

/**
 * Every vertex of the map: its own first, their colours shifted as the light is and a planar face's
 * normals its plane's (`batchNormals`), then the points of each grid drawn, in lump order, as their
 * grids made them.
 *
 * @param shift - What the map's colours are shifted by (`world-light.ts`).
 * @param grids - Each surface's grid, by its index in the BSP.
 * @param bases - Where each drawn grid's points start, by its surface, in lump order.
 * @param xyz - Every vertex's place, numbered so ({@link worldPositions}).
 */
function worldVertexData(
  bsp: Bsp,
  shift: number,
  grids: readonly (PatchGrid | null)[],
  bases: ReadonlyMap<number, number>,
  xyz: Float32Array
): WorldVertexData {
  const count = xyz.length / 3;
  const normal = new Float32Array(count * 3);
  const st = new Float32Array(count * 2);
  const lightmap = new Float32Array(count * 2);
  const color = new Uint8Array(count * 4);
  const place = (from: Omit<BspDrawVerts, 'xyz'>, at: number) => {
    normal.set(from.normal, at * 3);
    st.set(from.st, at * 2);
    lightmap.set(from.lightmap, at * 2);
    color.set(from.color, at * 4);
  };
  const normals = batchNormals(bsp);
  place({ ...bsp.drawVerts, normal: normals, color: shiftedVertexColors(bsp.drawVerts.color, shift) }, 0);
  for (const [surface, base] of bases) place(grids[surface]!.verts, base);
  return { xyz, normal, st, lightmap, color };
}

/** A world vertex's fields side by side: 44 bytes each, as `drawVert_t` holds them. */
export function worldVertexFormat(device: GraphicsDevice): VertexFormat {
  return new VertexFormat(device, [
    { semantic: SEMANTIC_POSITION, components: 3, type: TYPE_FLOAT32 },
    { semantic: SEMANTIC_NORMAL, components: 3, type: TYPE_FLOAT32 },
    { semantic: SEMANTIC_TEXCOORD0, components: 2, type: TYPE_FLOAT32 },
    { semantic: SEMANTIC_TEXCOORD1, components: 2, type: TYPE_FLOAT32 },
    { semantic: SEMANTIC_COLOR, components: 4, type: TYPE_UINT8, normalize: true }
  ]);
}

/** The world's vertexes in one buffer. */
function worldVertices(device: GraphicsDevice, data: WorldVertexData): VertexBuffer {
  const { xyz, normal, st, lightmap, color } = data;
  const count = xyz.length / 3;
  const format = worldVertexFormat(device);
  const vertices = new VertexBuffer(device, format, count, { usage: BUFFER_STATIC });
  const iterator = new VertexIterator(vertices);
  iterator.writeData(SEMANTIC_POSITION, xyz, count);
  iterator.writeData(SEMANTIC_NORMAL, normal, count);
  // Texture coordinates go in unchanged, as an MD3's do (`model-frames.ts`).
  iterator.writeData(SEMANTIC_TEXCOORD0, st, count);
  iterator.writeData(SEMANTIC_TEXCOORD1, lightmap, count);
  iterator.writeData(SEMANTIC_COLOR, color, count);
  iterator.end();
  return vertices;
}

/** A brush model's `model2`, drawn as an item is, and its stages that play. */
interface Model2 {
  /** The MD3 its mover's entity text names. */
  name: string;
  model: StagedModel;
  animated: SkinStage[];
  /** Its light in its own frame: its brush model's, as cgame adds the two at one place. */
  light: KeptEntityLight;
}

/** A frame a brush model's draws are placed in, written again as it moves. */
interface ModelFrame {
  origin: [number, number, number];
  axis: Axis;
}

/** A brush model as its deforms read it, written again as it moves. */
interface ModelDeformEntity extends DeformEntity {
  origin: Float32Array;
  axis: readonly [Float32Array, Float32Array, Float32Array];
  lightDir: Float32Array;
}

/**
 * An inline model the scene may place: its node, and each copy of its pose its draws read, all
 * written in place.
 */
interface BrushModelSlot {
  /** What its draws and its `model2` hang from. */
  node: Entity;
  /** Its pose as the view culls it, as last placed: `NaN` until it first is. */
  vis: VisModel;
  /** The frame its fogs' vectors and its eye are worked out in. */
  frame: ModelFrame;
  /** What its deformed runs read; `null` for a model with none. */
  deform: ModelDeformEntity | null;
  /** Its mover's `model2`, if the entity text gives it one. */
  model2: Model2 | null;
  /**
   * Its light where it stands and in its own frame, written as a frame lights it, for a model
   * whose `model2` or deforms read it; none for one with neither.
   */
  lit: { standing: KeptEntityLight; framed: KeptEntityLight } | null;
  /** What its `lightingDiffuse` stages read of its light ({@link LIGHT_UNIFORM}); none for none. */
  litStages: Float32Array | null;
  /** Whether a pose has placed it for the next view. */
  placed: boolean;
  /** Its entity's number in the scene: its mover's, as the last pose to place it had it. */
  entity: number;
}

/** A batch as it draws: its mesh, its draws, and whether a brush model draws it. */
interface BatchDraw {
  mesh: Mesh;
  /** A draw for each stage, for each shader its run may draw: its own's first. */
  sets: MeshInstance[][];
  entity: boolean;
  /** Whether it draws from the deformed runs' buffers, which hold nothing until a deform. */
  deformed: boolean;
}

/** Draws in the order made, each one's batch and its step, and where each run's begin. */
interface Keyed {
  draws: MeshInstance[];
  batches: number[];
  steps: number[];
  starts: number[];
}

/** A batch's mesh drawing its range of the index buffer. */
function placeBatch(mesh: Mesh, batch: BatchRange): void {
  const primitive = mesh.primitive[0];
  primitive.base = batch.base;
  primitive.count = batch.count;
}

/**
 * The files a brush model's `model2` needs: the MD3, and the images its surfaces' shaders draw,
 * read from the search path. Empty for a model the paks haven't got, which Q3 draws as nothing.
 */
async function modelFiles(
  fs: Pick<PakFileSystem, 'resolveImage' | 'read'>,
  scripts: Map<string, ShaderScript>,
  path: string
): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>();
  const md3 = await fs.read(path);
  if (!md3) return files;
  files.set(path.toLowerCase(), md3);
  for (const surface of parseMd3(md3, path).surfaces) {
    const name = ownShader(surface);
    const script = findShader(scripts, name);
    const references = script ? script.stages.flatMap((stage) => stage.maps) : [name];
    for (const reference of references) {
      const found = reference.startsWith('$') ? undefined : fs.resolveImage(reference);
      const bytes = found && !files.has(found) ? await fs.read(found) : undefined;
      if (found && bytes) files.set(found, bytes);
    }
  }
  return files;
}

/** What a world is built from. */
export interface BspWorldOptions {
  /** The map's name, as `map <n>` takes it. */
  name: string;
  bsp: Bsp;
  /** The shader scripts, in Q3's order, as the boot parsed them. */
  scripts: Map<string, ShaderScript>;
  /** The search path, for the world's images and its brush models' MD3s. */
  fs: Pick<PakFileSystem, 'resolveImage' | 'read'>;
  /** The textures the world shares with everything else drawn. */
  cache: TextureCache;
  /** `r_picmip`. */
  picmip: number;
  /** `r_mapOverBrightBits`. */
  mapOverBrightBits: number;
  /** `r_fullbright`. */
  fullbright: boolean;
  /** `r_subdivisions`. */
  subdivisions: number;
  /** `r_ext_multitexture`: a shader's first two stages merged where they can be. */
  multitexture: boolean;
  /** `r_ext_texture_env_add`: so too where the second is added to the first. */
  textureEnvAdd: boolean;
  /** `r_detailtextures`: a shader's `detail` stages drawn; without it they are dropped. */
  detailTextures: boolean;
  /**
   * The preview's clock as the world is built, in milliseconds as Q3's `cg.time`: what its stages
   * are made at, until its first frame plays them.
   */
  time: number;
  /** `r_offsetFactor` and `r_offsetUnits`, for a `polygonOffset` shader. */
  offset: PolygonOffset;
  /** The renderer to draw like; the one set at load unless a test says otherwise. */
  style?: RendererStyle;
  /** Prints a warning the load gives, as Q3's console does. */
  warn(text: string): void;
  /** Where the movers' `model2`s are placed: the scene the world is drawn in. */
  scene?: SceneDraws;
}

/** The cvars a view's visible set is found by, as the settings hold them. */
export interface VisibleSetSettings {
  noVis: boolean;
  noCull: boolean;
  lockPvs: boolean;
  showCluster: boolean;
  facePlaneCull: boolean;
  drawEntities: boolean;
  /** `r_znear`, in units. */
  zNear: number;
  /** `r_lodCurveError`. */
  lodCurveError: number;
}

/** A map's world, in the scene, from its load to its unload. */
export class BspWorld implements LoadedMap, SceneWorld {
  readonly name: string;
  /** The map's entity text. */
  readonly entities: string;
  /** Everything the world draws hangs from this, in Quake's frame. */
  readonly root: Entity;
  readonly layer: Layer;
  /** The world's draws, in the order they are drawn, but each run's last batch's ({@link spare}).
   */
  readonly draws: readonly MeshInstance[];
  /**
   * Each run's last batch's draws, in run order: a batch only a run its lit surfaces cut in two
   * ever fills.
   */
  readonly spare: readonly MeshInstance[];
  /** The ramp pass, drawn after them: one draw for each overbright bit. */
  readonly ramp: readonly MeshInstance[];
  /** The lightmap pages, `*lightmap<n>` by index. */
  readonly lightmaps: readonly Texture[];
  /** `*fog`, for a map with fogs. */
  readonly fogImage: Texture | null;
  /** Its fogs as the models and effects drawn in its scene take them. */
  readonly fog: SceneFogs;
  /** What each view sees: the last one's surfaces, the leafs it reached and its far plane. */
  readonly vis: WorldVis;
  /** Where cgame's marks land on it (`R_MarkFragments`). */
  readonly marks: WorldMarks;
  /** The map's light grid, which lights every model on it; none where it has none, or a bad one. */
  readonly lightGrid: LightGrid | null;
  /**
   * The sun the last of its shaders' `q3map_sun`s points to, which lights every model where a scene
   * has no grid; none where none has one.
   */
  readonly sunDirection: readonly [number, number, number] | undefined;

  private readonly app: AppBase;
  private readonly camera: CameraComponent;
  private readonly style: RendererStyle;
  private readonly scope: ResourceScope;
  private readonly vertices: VertexBuffer;
  private readonly indexes: IndexBuffer;
  /** The indexes as the view's surfaces and its curves' rows cut them. */
  private readonly detail: WorldIndexes;
  /** The runs whose shaders deform them, drawn from buffers of their own; none if no run is. */
  private readonly deformed: DeformedRuns | null;
  /** Each run's shader's passes, its stages, as `r_speeds` counts them. */
  private readonly passes: Int32Array;
  /** Each run's batches' draws, as many as {@link detail} has batches; none for a sky's. */
  private readonly batchDraws: BatchDraw[][];
  /** The sky's draws, if the map has one. */
  private readonly sky: BspSky | null;
  /** The brush models' nodes, which `r_drawentities` hides with their draws. */
  private readonly models: Entity[];
  /** Every inline model but the world's, by its number less one. */
  private readonly slots: readonly BrushModelSlot[];
  /** The brush models the next view draws, in the order the scene placed them, which it reads. */
  private readonly drawnModels: VisModel[];
  /** What the fogged draws read, written at each view. */
  private readonly fogUniforms: FogUniforms;
  /** The eye in each frame, for the stages that read the view, written at each view. */
  private readonly eyes: EyeUniforms;
  /** The stages, played on the clock. */
  private readonly stages: WorldStages;
  /** The shaders, which a swap swaps. */
  private readonly shaders: WorldShaders;
  /** Each run's shaders it may draw: its own, then those a swap may draw instead. */
  private readonly runChoices: readonly (readonly WorldShader[])[];
  /** Which of its {@link runChoices} each run draws now. */
  private readonly drawing: Int32Array;
  /** Each shader's runs that draw it now, by its index, for whether a view draws it. */
  private shaderRuns: number[][];
  /** The brush models' `model2`s. */
  private readonly model2s: readonly Model2[];
  /** Prints a warning, as Q3's console does. */
  private readonly warn: (text: string) => void;
  /** Each draw's batch among its run's, and its step among the run's draws, for its key. */
  private readonly drawBatches: Int32Array;
  private readonly drawSteps: Int32Array;
  /** {@link draws}, then {@link spare}: what {@link drawBatches} and {@link drawSteps} number. */
  private readonly keyed: readonly MeshInstance[];
  /**
   * Where each run's draws start among {@link draws}, and where the last run's end; then the same
   * for its last batch's, among {@link keyed}.
   */
  private readonly runStarts: Int32Array;
  private readonly spareStarts: Int32Array;
  /**
   * The stage draws a batch of each run makes, for all the shaders it may draw: where its light
   * passes' steps begin, each shader's fog pass's after the last of them.
   */
  private readonly runStages: Int32Array;
  /** Every vertex's x, y and z, as the world's vertex buffer holds them. */
  private readonly positions: Float32Array;
  /** The passes the frame's dynamic lights draw. */
  private readonly dlights: WorldDlights;
  /** The frame's polys, cgame's marks, shadows and wakes, drawn as the world's entity. */
  private readonly polys: WorldPolys<SortedShader>;
  /**
   * The stages of each shader the polys may draw, and those in a fog's colours, by the shader
   * itself, as a registry started again places cgame's afresh.
   */
  private readonly polyStages = new Map<WorldShader, { own: WorldStage[]; fogged: WorldStage[] }>();
  /** The polys' shaders made, for the warm-up. */
  private polyShaders: readonly SortedShader[] = [];
  /** The shaders the frame's polys draw. */
  private readonly polysDrawn = new Set<WorldShader>();
  /** The frame's lights, as the last view took them. */
  private lights: readonly DynamicLight[] = [];
  /** Scratch for a light projected on a batch, and each vertex's clip bits for it. */
  private readonly projected = projectedLight();
  private readonly clipCache: ClipCache;
  private readonly deformedClipCache: ClipCache | null;
  /** `c_dlightVertexes` and `c_dlightIndexes` for the last frame's passes. */
  private dlightVertexes = 0;
  private dlightIndexes = 0;
  /** The registry's count of sorts its draws were keyed at, and whether a mover was renumbered. */
  private keyedAt = Number.NaN;
  private renumbered = false;
  /** The runs, for their keys. */
  private readonly runs: readonly WorldRun[];
  /** The scene the world is drawn in, which it leaves as it goes. */
  private readonly sceneDraws: SceneDraws | undefined;
  /**
   * Whether a view draws a shader: a run that draws it has surfaces in view, or a poly of the
   * frame's draws it.
   */
  private readonly drawn = (shader: WorldShader): boolean => {
    if (this.polysDrawn.has(shader)) return true;
    const runs = this.shaderRuns[shader.index];
    if (!runs) return false;
    for (let i = 0; i < runs.length; i++) {
      if (this.detail.runs[runs[i]].count > 0) return true;
    }
    return false;
  };
  /** The cvars a view is found by, read into it each frame. */
  private readonly switches: VisSwitches = {
    novis: false,
    nocull: false,
    lockpvs: false,
    showcluster: false,
    facePlaneCull: true,
    entities: true
  };
  /** The camera's near and far planes as the world found them, which it gives back. */
  private readonly clips: [number, number];
  /** Where a brush model stands, as its light is found. */
  private readonly standing = { x: 0, y: 0, z: 0 };
  /** A view's axes, and its eye and forward axis as the fogs take them, written at each view. */
  private readonly basis: ViewBasis = { forward: vec3(), right: vec3(), up: vec3() };
  private readonly fogEye: [number, number, number] = [0, 0, 0];
  private readonly eye: [number, number, number] = [0, 0, 0];
  private readonly fogForward: [number, number, number] = [0, 0, 0];
  private entitiesShown = true;
  /** Whether the clock has deformed the deformed batches yet, which are hidden until it has. */
  private deformedOnce = false;
  /**
   * A run cut again: its batches' draws placed, and its indexes uploaded, and its draws keyed again
   * for the batches its lit surfaces now start at. A deformed run's are placed and written as its
   * batches are deformed.
   */
  private readonly rewrite = (run: number): void => {
    this.sky?.cut(run);
    const { base, used, batches, tess } = this.detail.runs[run];
    const draws = this.batchDraws[run];
    for (let k = 0; k < draws.length; k++) {
      if (!tess) placeBatch(draws[k].mesh, batches[k]);
      this.show(draws[k], batches[k], this.drawing[run]);
    }
    if (!tess) this.indexes.unlock(base * 4, used * 4);
    this.keyRun(run);
  };

  private constructor(
    app: AppBase,
    camera: CameraComponent,
    parts: {
      name: string;
      entities: string;
      root: Entity;
      layer: Layer;
      draws: MeshInstance[];
      spare: MeshInstance[];
      ramp: MeshInstance[];
      batchDraws: BatchDraw[][];
      sky: BspSky | null;
      slots: BrushModelSlot[];
      drawnModels: VisModel[];
      lightmaps: Texture[];
      fogImage: Texture | null;
      fogUniforms: FogUniforms;
      eyes: EyeUniforms;
      stages: WorldStages;
      shaders: WorldShaders;
      runChoices: WorldShader[][];
      runs: WorldRun[];
      drawBatches: Int32Array;
      drawSteps: Int32Array;
      runStarts: Int32Array;
      spareStarts: Int32Array;
      runStages: Int32Array;
      positions: Float32Array;
      dlights: WorldDlights;
      sceneDraws: SceneDraws | undefined;
      model2s: Model2[];
      warn: (text: string) => void;
      scope: ResourceScope;
      vertices: VertexBuffer;
      indexes: IndexBuffer;
      detail: WorldIndexes;
      deformed: DeformedRuns | null;
      passes: Int32Array;
      vis: WorldVis;
      marks: WorldMarks;
      lightGrid: LightGrid | null;
      sunDirection: [number, number, number] | undefined;
      style: RendererStyle;
    }
  ) {
    this.app = app;
    this.camera = camera;
    this.vis = parts.vis;
    this.marks = parts.marks;
    this.lightGrid = parts.lightGrid;
    this.sunDirection = parts.sunDirection;
    this.style = parts.style;
    this.clips = [camera.nearClip, camera.farClip];
    this.name = parts.name;
    this.entities = parts.entities;
    this.root = parts.root;
    this.layer = parts.layer;
    this.draws = parts.draws;
    this.spare = parts.spare;
    this.keyed = [...parts.draws, ...parts.spare];
    this.ramp = parts.ramp;
    this.lightmaps = parts.lightmaps;
    this.fogImage = parts.fogImage;
    this.fogUniforms = parts.fogUniforms;
    const { fogs } = parts.shaders;
    const light = identityLight(parts.style);
    this.fog = new SceneFogs(
      fogs,
      fogs.map((fog) => fogColor(fog.parms, light))
    );
    this.eyes = parts.eyes;
    this.stages = parts.stages;
    this.shaders = parts.shaders;
    this.runChoices = parts.runChoices;
    this.runs = parts.runs;
    this.sceneDraws = parts.sceneDraws;
    this.drawBatches = parts.drawBatches;
    this.drawSteps = parts.drawSteps;
    this.runStarts = parts.runStarts;
    this.spareStarts = parts.spareStarts;
    this.runStages = parts.runStages;
    this.positions = parts.positions;
    this.dlights = parts.dlights;
    this.clipCache = new ClipCache(parts.positions.length / 3);
    this.deformedClipCache = parts.deformed && new ClipCache(parts.deformed.vertices.numVertices);
    this.drawing = new Int32Array(parts.runChoices.length);
    this.shaderRuns = this.drawnRuns();
    this.model2s = parts.model2s;
    this.warn = parts.warn;
    this.batchDraws = parts.batchDraws;
    this.sky = parts.sky;
    this.slots = parts.slots;
    this.models = parts.slots.map((slot) => slot.node);
    this.drawnModels = parts.drawnModels;
    this.scope = parts.scope;
    this.vertices = parts.vertices;
    this.indexes = parts.indexes;
    this.detail = parts.detail;
    this.deformed = parts.deformed;
    this.passes = parts.passes;
    const world = this.slots.length;
    this.polys = new WorldPolys<SortedShader>(
      app.graphicsDevice,
      this.layer,
      this.root,
      this.vertices.format,
      (handle, fogged) => {
        const made = handle.shader && this.polyStages.get(handle.shader);
        if (!made) return null;
        return fogged && made.fogged.length > 0 ? made.fogged : made.own;
      },
      (handle) => this.sceneDraws?.shaders.place(handle) ?? 0,
      (fog) => this.fogUniforms.data(fog - 1, world, WORLD_FRAME),
      this.eyes.data(world, WORLD_FRAME),
      MAX_POLYS
    );
    this.key();
  }

  /**
   * Build a map's world and put it in the scene: its shaders registered and its surfaces checked
   * as `RE_LoadWorldMap` does, every inline model registered as cgame registers them
   * (`cg_main.c:1034-1045`), with each mover's `model2`, and its batches drawn through `camera`. No
   * brush model shows until {@link placeModels} places it.
   *
   * @throws in Q3's words for a surface Q3 refuses
   */
  static async load(
    app: AppBase,
    camera: CameraComponent,
    options: BspWorldOptions
  ): Promise<BspWorld> {
    const { bsp, fs, cache, picmip, scripts } = options;
    const style = options.style ?? rendererStyle();
    const shift = options.mapOverBrightBits - style.overBrightBits;
    const { multitexture, textureEnvAdd, detailTextures } = options;
    const entities = readEntities(bsp.entityString);
    const shaders = loadWorldShaders(
      bsp,
      { scripts, hasImage: (name) => fs.resolveImage(name) !== undefined, warn: options.warn },
      options.fullbright,
      { multitexture, textureEnvAdd, detailTextures },
      shaderSwaps(entities)
    );
    const grids = loadPatchGrids(bsp, shift, options.subdivisions);
    // After the surfaces, as `RE_LoadWorldMap` reads the worldspawn and the grid last.
    const [worldModel] = bsp.models;
    const gridSize = worldGridSize(bsp.entityString, options.warn);
    const lightGrid = loadLightGrid(
      bsp.lightGrid,
      worldModel.mins,
      worldModel.maxs,
      gridSize,
      shift,
      options.warn
    );
    // Each an entity of its own, by its number less one, so their runs in a shader draw in their
    // models' order: the order the game numbers their movers in, as Q3's sort key has them.
    const inline =Array.from({ length: Math.max(0, bsp.models.length - 1) }, (_, i) => i + 1);
    const runs = worldRuns(bsp, shaders, inline, grids);
    // A sky draws its own, and no run swaps to one.
    const runChoices = runs.map((run) => {
      const shader = shaders.shaders[run.shader];
      if (shader.sky) return [shader];
      const targets = shaders.swapTargets.get(shader) ?? [];
      return [shader, ...targets.filter((target) => !target.sky)];
    });

    const device = app.graphicsDevice;
    const scope = cache.scope();
    const root = new Entity(`world ${options.name}`);
    applyQuakeTransform(root);
    const layer = new Layer({
      name: WORLD_LAYER_NAME,
      opaqueSortMode: SORTMODE_MANUAL,
      transparentSortMode: SORTMODE_MANUAL
    });
    let vertices: VertexBuffer | undefined;
    let indexes: IndexBuffer | undefined;
    let dlights: WorldDlights | undefined;
    let deformed: DeformedRuns | null = null;
    let sky: BspSky | null = null;
    const draws: MeshInstance[] = [];
    const spare: MeshInstance[] = [];
    let ramp: MeshInstance[] = [];
    const lightmaps: Texture[] = [];
    let fogTexture: Texture | null = null;
    try {
      // Unmipped, filtered, clamped and never picmipped (`tr_bsp.c:202-204`).
      for (const [i, texels] of lightmapPages(bsp.lightmaps, shift).entries()) {
        const page = {
          width: LIGHTMAP_SIZE,
          height: LIGHTMAP_SIZE,
          pixels: new Uint8ClampedArray(texels.buffer)
        };
        lightmaps.push(createTexture(device, `*lightmap${i}`, page, true, false));
      }
      const { fogs } = shaders;
      if (fogs.length > 0) {
        // So too the fog's (`tr_image.c:1180`).
        const pixels = new Uint8ClampedArray(fogImage().buffer);
        const image = { width: FOG_S, height: FOG_T, pixels };
        fogTexture = createTexture(device, '*fog', image, true, false);
      }
      const images = worldImages(fs);
      const sources = { images, lightmaps, style, scope, picmip, offset: options.offset };
      const stages = new WorldStages(app, sources, options.time);
      const materials = new Map<number, WorldStage[]>();
      /** A shader's stages for its runs in a fog, where the fog dims any. */
      const foggedMaterials = new Map<number, WorldStage[]>();
      const skies = new Map<number, SkyMaterials>();
      // A sky draws none of its triangles (`RB_StageIteratorSky`, `tr_sky.c:779-826`).
      const isSky = (run: WorldRun) => shaders.shaders[run.shader].sky !== undefined;
      for (const [r, run] of runs.entries()) {
        const shader = shaders.shaders[run.shader];
        if (isSky(run)) {
          if (skies.has(run.shader)) continue;
          skies.set(run.shader, await skyMaterials(app, shader, images, stages, style, scope, picmip));
          continue;
        }
        for (const drawn of runChoices[r]) {
          if (!materials.has(drawn.index)) materials.set(drawn.index, await stages.build(drawn));
          if (run.fog > 0 && dimmedByFog(drawn) && !foggedMaterials.has(drawn.index)) {
            foggedMaterials.set(drawn.index, await stages.build(drawn, true));
          }
        }
      }
      const fogUniforms = new FogUniforms(fogs);
      const eyes = new EyeUniforms();
      const fogPasses = new Map<string, StandardMaterial>();
      const light = identityLight(style);
      /**
       * A fogged run's pass, if the shader it draws has one: one material for each fog, pass, cull
       * and whether the shader pulls it towards the viewer.
       */
      const fogPass = (run: WorldRun, shader: WorldShader): StandardMaterial | null => {
        if (run.fog === 0 || shader.fogPass === 'none') return null;
        const cull = q3CullMode(shader.script?.cull);
        const pulled = shader.script?.polygonOffset === true;
        const key = `${run.fog} ${shader.fogPass} ${cull} ${pulled}`;
        let made = fogPasses.get(key);
        if (!made) {
          const color = fogColor(fogs[run.fog - 1].parms, light);
          made = fogPassMaterial(fogTexture!, color, shader.fogPass, cull, scope);
          if (pulled) {
            stages.pull(made);
            made.update();
          }
          fogPasses.set(key, made);
        }
        return made;
      };

      const slots = inline.map(brushModelSlot);
      for (const { node } of slots) root.addChild(node);
      const drawnModels: VisModel[] = [];
      const bases = gridBases(bsp, grids, new Set(runs.flatMap((run) => run.surfaces)));
      const xyz = worldPositions(bsp, grids, bases);
      const data = worldVertexData(bsp, shift, grids, bases, xyz);
      vertices = worldVertices(device, data);
      // Each run a shader it may draw deforms, from buffers of its own.
      const deformsOf = (shader: WorldShader) => runDeforms(stages, shader).deforms;
      const tessellated = runChoices.map((choices) =>
        choices.some((shader) => deformsOf(shader).length > 0)
      );
      const unplaced = inline.map((model): BrushModelPose => ({
        model,
        origin: [0, 0, 0],
        angles: [0, 0, 0]
      }));
      const detail = new WorldIndexes(bsp, runs, grids, bases, unplaced, tessellated);
      const deformedRuns: DeformedRunOptions[] = [];
      for (const [r, run] of runs.entries()) {
        if (!tessellated[r]) continue;
        const stamping = (shader: WorldShader) =>
          deformsOf(shader).some(({ type }) => type === 'autosprite');
        deformedRuns.push({
          run: r,
          ...runDeforms(stages, runChoices[r][0]),
          stamps: runChoices[r].some(stamping),
          entity:
            run.entity < slots.length ? (slots[run.entity].deform ??= deformEntity()) : WORLD_ENTITY
        });
      }
      if (deformedRuns.length > 0) {
        deformed = new DeformedRuns(device, vertices.format, data, detail, deformedRuns);
      }
      if (skies.size > 0) {
        // A sky shader has read its cloud height, so the table has been made.
        sky = new BspSky(device, runs.map(isSky), detail, xyz, shaders.cloudHeight!);
        root.addChild(sky.node);
      }
      // Its storage is the array the level of detail writes, so a run cut again uploads in place.
      indexes = new IndexBuffer(
        device,
        INDEXFORMAT_UINT32,
        detail.indexes.length,
        BUFFER_DYNAMIC,
        detail.indexes.buffer
      );
      dlights = new WorldDlights(device, layer, scope, (material) => stages.pull(material));
      /** Where each run's draws start; each draw's batch, and its step among its run's draws. */
      // A run's last batch's draws are kept apart: only a run its lit surfaces cut in two fills
      // it. Each draw's batch and its step among its run's draws are kept for its key.
      const own: Keyed = { draws, batches: [], steps: [], starts: [] };
      const last: Keyed = { draws: spare, batches: [], steps: [], starts: [] };
      const runStages: number[] = [];
      const batchDraws = runs.map((run, r) => {
        own.starts.push(draws.length);
        last.starts.push(spare.length);
        const entity = run.entity < slots.length;
        if (isSky(run)) {
          // The clouds' points are in the world's frame, whatever draws them.
          const worldEye = eyes.data(slots.length, WORLD_FRAME);
          const first = draws.length;
          const firstSpare = spare.length;
          const skyMaterials = skies.get(run.shader)!;
          sky!.addDraws(r, skyMaterials, entity, worldEye, own, last);
          for (let i = first; i < draws.length; i++) own.steps.push(i - first);
          for (let i = firstSpare; i < spare.length; i++) {
            last.steps.push(draws.length - first + i - firstSpare);
          }
          runStages.push(0);
          return [];
        }
        const frame: FogFrame = entity ? slots[run.entity].frame : WORLD_FRAME;
        const fog = run.fog > 0 ? fogUniforms.data(run.fog - 1, run.entity, frame) : null;
        const drawnBy = runChoices[r].map((shader) => {
          const own = (fog && foggedMaterials.get(shader.index)) || materials.get(shader.index)!;
          // A shader whose draws drop the map has none, and its first draw drops it.
          if (stages.drops(shader)) return { own, pass: null };
          // Its light passes' materials, made with the rest.
          if (takesDlights(shader)) dlightMaterial(dlights!, shader);
          return { own, pass: fogPass(run, shader) };
        });
        // A batch's steps: the stages of each shader it may draw, a light's pass for each light
        // after them, then each shader's fog pass.
        const offsets: number[] = [];
        let stageSteps = 0;
        for (const { own: stages } of drawnBy) {
          offsets.push(stageSteps);
          stageSteps += stages.length;
        }
        runStages.push(stageSteps);
        const stride = stageSteps + MAX_DLIGHTS + drawnBy.length;
        const deformedMeshes = deformed?.meshes(r);
        // A brush model's lit stages read its light, and the world's the world entity's, never set.
        let light: Float32Array = NO_LIGHT;
        if (entity && drawnBy.some(({ own }) => own.some((stage) => stage.lit))) {
          const slot = slots[run.entity];
          slot.lit ??= { standing: keptEntityLight(), framed: entityLight(style) };
          // The ambient's byte's alpha, 255 for any entity lit.
          light = slot.litStages ??= Float32Array.of(0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0);
        }
        const { batches } = detail.runs[r];
        return batches.map((batch, k): BatchDraw => {
          const mesh = deformedMeshes?.[k] ?? worldMesh(device, vertices!, indexes!, batch);
          const node = entity ? slots[run.entity].node : root;
          const into = k === batches.length - 1 ? last : own;
          const sets = drawnBy.map(({ own: stages, pass }, choice) => {
            const drawn = pass
              ? [...stages, { material: pass, parameters: [], eye: false, lit: false }]
              : stages;
            return drawn.map(({ material, parameters, eye, lit }, j) => {
              into.batches.push(k);
              const slot =
                j < stages.length ? offsets[choice] + j : stageSteps + MAX_DLIGHTS + choice;
              into.steps.push(Math.min(k * stride + slot, MAX_STEP));
              const instance = new MeshInstance(mesh, material, node);
              instance.drawOrder = into.draws.length;
              // What it draws is what the view sees, so the engine has nothing to cull.
              instance.cull = false;
              // Its run's own shader's alone, and a spare batch has nothing to draw until a view
              // cuts its run into it, and a deformed one until the clock first deforms it.
              instance.visible = choice === 0 && batch.count > 0 && !deformedMeshes;
              // Its fog's vectors, for the pass and any stage the fog dims.
              if (fog) instance.setParameter(FOG_UNIFORM, fog);
              // Its textures' coordinates, which the frame writes in place.
              for (const [name, data] of parameters) instance.setParameter(name, data);
              // The eye in its frame, for a stage that reads the view.
              if (eye) instance.setParameter(EYE_UNIFORM, eyes.data(run.entity, frame));
              // Its entity's light, for a stage it lights.
              if (lit) instance.setParameter(LIGHT_UNIFORM, light);
              into.draws.push(instance);
              return instance;
            });
          });
          return { mesh, sets, entity, deformed: deformedMeshes !== undefined };
        });
      });
      own.starts.push(draws.length);
      last.starts.push(spare.length);
      ramp = rampDraws(device, scope, style.overBrightBits);
      layer.addMeshInstances([...draws, ...spare, ...ramp], true);

      // Each `model2` as an item is drawn, lit as its brush model is. A mover sets no `shaderTime`,
      // so its stages play on the world's clock.
      const library = new AssetLibrary(new Map(), { shaders: scripts });
      const model2s: Model2[] = [];
      for (const [inlineModel, name] of moverModel2s(entities, bsp.models.length)) {
        for (const [path, bytes] of await modelFiles(fs, scripts, name)) {
          library.files.set(path, bytes);
        }
        if (!library.read(name)) continue;
        const animated: SkinStage[] = [];
        const model = await buildStagedModel(
          app,
          library,
          scope,
          name,
          library.model(name),
          ownShader,
          options.scene ? { scene: { draws: options.scene, group: 'models' } } : {},
          animated
        );
        const slot = slots[inlineModel - 1];
        slot.node.addChild(model.entity);
        // Shown only while a pose hands its mover in with it.
        model.entity.enabled = false;
        slot.lit ??= { standing: keptEntityLight(), framed: entityLight(style) };
        const model2 = { name, model, animated, light: slot.lit.framed };
        playModel2(model2, options.time * 0.001);
        slot.model2 = model2;
        model2s.push(model2);
      }
      for (const slot of slots) {
        if (slot.deform) slot.lit ??= { standing: keptEntityLight(), framed: entityLight(style) };
      }

      app.root.addChild(root);
      const composition = app.scene.layers;
      const world = composition.getLayerById(LAYERID_WORLD)!;
      composition.insertTransparent(layer, composition.getOpaqueIndex(world));
      // A camera draws only the layers it lists.
      camera.layers = [...camera.layers, layer.id];
      return new BspWorld(app, camera, {
        name: options.name,
        entities: bsp.entityString,
        root,
        layer,
        draws,
        ramp,
        batchDraws,
        sky,
        slots,
        drawnModels,
        lightmaps,
        fogImage: fogTexture,
        fogUniforms,
        eyes,
        stages,
        shaders,
        runChoices,
        runs,
        spare,
        drawBatches: Int32Array.from([...own.batches, ...last.batches]),
        drawSteps: Int32Array.from([...own.steps, ...last.steps]),
        runStarts: Int32Array.from(own.starts),
        spareStarts: Int32Array.from(last.starts, (start) => draws.length + start),
        runStages: Int32Array.from(runStages),
        positions: xyz,
        dlights: dlights!,
        sceneDraws: options.scene,
        model2s,
        warn: options.warn,
        scope,
        vertices,
        indexes,
        detail,
        deformed,
        passes: Int32Array.from(runs, (run) => shaders.shaders[run.shader].stages.length),
        vis: new WorldVis(bsp, shaders, grids, drawnModels, options.warn),
        marks: new WorldMarks(bsp, shaders, grids),
        lightGrid,
        sunDirection: shaders.sunDirection,
        style
      });
    } catch (error) {
      for (const instance of [...draws, ...spare, ...ramp]) instance.destroy();
      root.destroy();
      scope.dispose();
      for (const page of lightmaps) page.destroy();
      fogTexture?.destroy();
      dlights?.destroy();
      vertices?.destroy();
      indexes?.destroy();
      deformed?.destroy();
      sky?.destroy();
      throw error;
    }
  }

  /**
   * The brush models the next view draws, as `CG_Mover` adds each (`cg_ents.c:571-605`): each
   * pose's inline model where it stands, and its `model2` while the pose names the one its mover's
   * entity text gave. A model no pose places shows nothing, nor does one that isn't the map's; one
   * placed twice stands where it was first. Before {@link see}, which culls them.
   *
   * @param poses - In the order the scene adds them, by entity number.
   */
  placeModels(poses: readonly BrushModelPose[]): void {
    const { slots, drawnModels } = this;
    for (let s = 0; s < slots.length; s++) slots[s].placed = false;
    let count = 0;
    for (let i = 0; i < poses.length; i++) {
      const pose = poses[i];
      const s = pose.model - 1;
      const slot = slots[s];
      if (!slot || slot.placed) continue;
      slot.placed = true;
      drawnModels[count++] = slot.vis;
      this.place(s, pose);
      // `CG_Mover` adds the model, then its `model2`, as its entity.
      const entity = pose.number === undefined ? unnumbered(pose.model) : packetEntity(pose.number);
      if (entity !== slot.entity) {
        slot.entity = entity;
        this.renumbered = true;
        if (slot.model2) slot.model2.model.order.value = entity + MODEL2_PART;
      }
      if (slot.model2) slot.model2.model.entity.enabled = pose.model2 === slot.model2.name;
    }
    drawnModels.length = count;
    for (let s = 0; s < slots.length; s++) {
      const { placed, model2 } = slots[s];
      if (!placed && model2) model2.model.entity.enabled = false;
    }
  }

  /**
   * A brush model stood where a pose has it: its node, its place for the view's cull and its
   * curves' rows, the frame its fogs and eye are worked out in, and what its deforms read. Nothing
   * is written again for a model that has not moved.
   */
  private place(s: number, { origin, angles }: BrushModelPose): void {
    const { node, vis, frame, deform } = this.slots[s];
    const moved =
      origin[0] !== vis.origin[0] || origin[1] !== vis.origin[1] || origin[2] !== vis.origin[2];
    const turned =
      angles[0] !== vis.angles[0] || angles[1] !== vis.angles[1] || angles[2] !== vis.angles[2];
    if (!moved && !turned) return;
    for (let j = 0; j < 3; j++) {
      vis.origin[j] = origin[j];
      vis.angles[j] = angles[j];
      frame.origin[j] = origin[j];
    }
    node.setLocalPosition(origin[0], origin[1], origin[2]);
    this.detail.orient(s, vis);
    if (deform) deform.origin.set(origin);
    if (!turned) return;
    const [pitch, yaw, roll] = angles;
    node.setLocalRotation(axisRotation(anglesToAxis(pitch, yaw, roll, frame.axis), rotation));
    if (deform) anglesToAxes(pitch, yaw, roll, deform.axis);
  }

  /**
   * Each brush model placed lit where it stands, as ioquake3 lights one (`tr_world.c:333`), and
   * not id's: `R_SetupEntityLighting`, then its direction in the model's frame. Its `model2` takes
   * the same light, its deforms the direction, and its `lightingDiffuse` stages both.
   */
  private lightModels(scene: LightingScene): void {
    const { slots, standing } = this;
    for (let s = 0; s < slots.length; s++) {
      const { placed, lit, vis, frame, deform, litStages } = slots[s];
      if (!placed || !lit) continue;
      standing.x = vis.origin[0];
      standing.y = vis.origin[1];
      standing.z = vis.origin[2];
      // As `opengl1` lights it, under either style, as the world is drawn.
      entityLightAt(standing, scene, sceneStyle(this.style), lit.standing);
      lightInEntityFrame(frame.axis, lit.standing, lit.framed);
      if (deform) deform.lightDir.set(lit.framed.direction);
      if (litStages) writeLight(lit.framed, litStages);
    }
  }

  /**
   * Play the world on the preview's clock, after {@link see}: the brush models placed lit by the
   * scene, the deformed batches the view draws deformed, the stages of each shader it draws, and
   * each `model2` shown. The first drawn shader opengl1 drops the map for drops it here.
   *
   * @param time - The clock, in milliseconds.
   * @param scene - What the scene lights its entities by: this frame's lights.
   * @throws Q3's drop for a shader the view draws
   */
  animate(time: number, scene: LightingScene): void {
    this.lightModels(scene);
    this.deform(time);
    this.projectLights();
    this.stages.play(time, this.drawn);
    for (let i = 0; i < this.model2s.length; i++) {
      const model2 = this.model2s[i];
      if (model2.model.entity.enabled) playModel2(model2, time * 0.001);
    }
  }

  /**
   * The frame's light passes, as each batch's `ProjectDlightTexture` draws them
   * (`tr_shade.c:407-557`): each batch drawn, of a shader that takes them, whose bits hold a light
   * of the frame, drawn again for that light over the triangles it reaches, its key after the
   * batch's stages. A deformed batch is projected as its deform left it.
   */
  private projectLights(): void {
    const { dlights, vis, detail, lights } = this;
    dlights.begin();
    this.dlightVertexes = 0;
    this.dlightIndexes = 0;
    const n = vis.numLights;
    if (n > 0) {
      const taken = n >= 32 ? -1 : (1 << n) - 1;
      for (let r = 0; r < detail.runs.length; r++) {
        const { count, batches } = detail.runs[r];
        if (count === 0) continue;
        const shader = this.runChoices[r][this.drawing[r]];
        if (!takesDlights(shader) || this.stages.drops(shader)) continue;
        const draws = this.batchDraws[r];
        for (let k = 0; k < draws.length; k++) {
          // Under `r_drawentities 0` the view adds no brush model's surfaces, so their batches
          // hold none.
          if (batches[k].count === 0) continue;
          if (draws[k].deformed && !this.deformedOnce) continue;
          const bits = detail.dlightBits(r, k, vis.dlightBits) & taken;
          for (let l = 0; bits !== 0 && l < n; l++) {
            if (bits & (1 << l)) this.projectLight(r, k, l, shader, lights[l]);
          }
        }
      }
    }
    dlights.end();
  }

  /** One light's pass over a batch, if it reaches any of its triangles. */
  private projectLight(
    r: number,
    k: number,
    l: number,
    shader: WorldShader,
    light: DynamicLight
  ): void {
    const { vis, detail, dlights, projected } = this;
    const run = this.runs[r];
    // `R_TransformDlights` into the batch's frame: a brush model's, or the world's, where it is
    // the light's own origin.
    const model = run.entity < this.slots.length;
    const at = model ? (run.model * MAX_DLIGHTS + l) * 3 : l * 4;
    const origins = model ? vis.modelLights : vis.lights;
    projectLight(light, origins[at], origins[at + 1], origins[at + 2], projected);
    const batch = detail.runs[r].batches[k];
    const meshes = this.deformed?.meshes(r);
    const deformed = this.deformed;
    let kept: number;
    if (meshes && deformed) {
      const { base, count } = meshes[k].primitive[0];
      this.dlightVertexes += deformed.vertexesOf(r, k);
      const out = dlights.room(count);
      kept = keptTriangles(
        projected,
        deformed.positions,
        deformed.stride,
        deformed.xyz,
        deformed.indexStorage,
        base,
        count,
        out,
        dlights.written,
        this.deformedClipCache!
      );
    } else {
      this.dlightVertexes += batch.vertexes;
      const out = dlights.room(batch.count);
      kept = keptTriangles(
        projected,
        this.positions,
        3,
        0,
        detail.indexes,
        batch.base,
        batch.count,
        out,
        dlights.written,
        this.clipCache
      );
    }
    if (kept === 0) return;
    this.dlightIndexes += kept;
    const material = dlightMaterial(dlights, shader, light.additive);
    const vertices = meshes && deformed ? deformed.vertices : this.vertices;
    const node = model ? this.slots[run.entity].node : this.root;
    const pass = dlights.draw(material, kept, vertices, node, projected);
    pass.run = r;
    pass.batch = k;
    pass.light = l;
    pass.instance.drawOrder = this.passKey(r, k, l);
  }

  /** The registry of the shaders the world is drawn with, which cgame's join in its scene. */
  get registry(): WorldShaders {
    return this.shaders;
  }

  /**
   * The stages of the shaders cgame's polys draw, made under the load screen as the world's are,
   * each found in the registry, and in a fog's colours too on a map with fogs where a stage takes
   * the fog in them. A shader whose draws drop the map has none.
   */
  async preparePolys(handles: readonly SortedShader[]): Promise<void> {
    const scene = this.sceneDraws?.shaders;
    if (!scene) return;
    for (const handle of handles) {
      scene.place(handle);
      const shader = handle.shader;
      if (!shader || this.polyStages.has(shader)) continue;
      const drops = this.stages.drops(shader);
      const own = drops ? [] : await this.stages.build(shader);
      const fogs = this.shaders.fogs.length > 0 && dimmedByFog(shader) && !drops;
      const fogged = fogs ? await this.stages.build(shader, true) : [];
      this.polyStages.set(shader, { own, fogged });
    }
    const added = handles.filter((handle) => !this.polyShaders.includes(handle));
    this.polyShaders = [...this.polyShaders, ...added];
  }

  /**
   * Draw the frame's polys (`world-polys.ts`), after cgame has added them all and before
   * {@link animate} plays the stages of the shaders they draw.
   */
  drawPolys(polys: ScenePolys<SortedShader>): void {
    // Drawn first, which finds each poly's shader in this map's registry.
    this.polys.draw(polys);
    this.polysDrawn.clear();
    for (let i = 0; i < polys.count; i++) {
      const shader = polys.shaders[i]?.shader;
      if (shader) this.polysDrawn.add(shader);
    }
  }

  /**
   * Key each of the world's draws as Q3 sorts it (`scene-sort.ts`): its run's shader's place, its
   * entity, the brush model's mover or the world, and its fog, then its step among its run's draws.
   * Only a shader sorted in, which moves the places after it, or a mover renumbered changes them.
   */
  key(): void {
    const { generation } = this.shaders;
    if (generation === this.keyedAt && !this.renumbered) return;
    this.keyedAt = generation;
    this.renumbered = false;
    for (let r = 0; r < this.runs.length; r++) this.keyRun(r);
    const { given, count } = this.dlights;
    for (let i = 0; i < count; i++) {
      const { instance, run, batch, light } = given[i];
      instance.drawOrder = this.passKey(run, batch, light);
    }
    this.polys.key();
  }

  /**
   * A run's draws keyed, the light's bit in the key of each batch of the surfaces a light touches,
   * which come after the rest.
   */
  private keyRun(r: number): void {
    const run = this.runs[r];
    const entity = this.runEntity(run);
    const place = this.shaders.shaders[run.shader].sortedIndex;
    const { litBatch } = this.detail.runs[r];
    const { keyed, drawBatches, drawSteps, runStarts, spareStarts } = this;
    for (let part = 0; part < 2; part++) {
      const starts = part === 0 ? runStarts : spareStarts;
      for (let i = starts[r]; i < starts[r + 1]; i++) {
        const lit = drawBatches[i] >= litBatch;
        keyed[i].drawOrder = sceneKey(place, entity, run.fog, lit, drawSteps[i]);
      }
    }
  }

  /** The key of a light's pass over a run's batch: after its stages, before its fog's pass. */
  private passKey(r: number, batch: number, light: number): number {
    const run = this.runs[r];
    const place = this.shaders.shaders[run.shader].sortedIndex;
    const lit = batch >= this.detail.runs[r].litBatch;
    const stages = this.runStages[r];
    const stride = stages + MAX_DLIGHTS + this.runChoices[r].length;
    const step = Math.min(batch * stride + stages + light, MAX_STEP);
    return sceneKey(place, this.runEntity(run), run.fog, lit, step);
  }

  /** A run's entity in the scene: its brush model's mover's, or the world's. */
  private runEntity(run: WorldRun): number {
    return run.entity < this.slots.length ? this.slots[run.entity].entity : REFENTITYNUM_WORLD;
  }

  /** `r_offsetFactor` and `r_offsetUnits`, read each frame as Q3 reads them at each draw. */
  offset(offset: PolygonOffset): void {
    this.stages.offset(offset);
  }

  /**
   * `R_RemapShader` on the world, as cgame asks for a swap (`view/world-remap.ts`): from the next
   * frame each run draws the shader its own now draws instead, on that shader's clock. A swap the
   * map's entities could not make leaves the runs it reaches drawing their own.
   *
   * @param timeOffset - The swap's time in seconds, as written.
   * @throws a shader's `ERR_DROP`, as its parse gives it when the swap registers it
   */
  remapShader(oldShader: string, newShader: string, timeOffset: string): void {
    remapShader(this.shaders, oldShader, newShader, timeOffset, this.warn);
    this.redraw();
  }

  /**
   * The world's shaders as its load left them, nothing swapped, as a renderer started again has
   * them: for a gamestate whose map was in hand already.
   */
  unswap(): void {
    this.shaders.reset();
    this.redraw();
  }

  /** Each run's draws of the shader it draws now, and that shader's clock for its deforms. */
  private redraw(): void {
    let changed = false;
    for (let run = 0; run < this.runChoices.length; run++) {
      const choices = this.runChoices[run];
      const choice = Math.max(0, choices.indexOf(drawnShader(choices[0])));
      // A shader's clock may have moved without its run changing what it draws.
      if (this.deformed?.meshes(run)) {
        this.deformed.drawWith(run, runDeforms(this.stages, choices[choice]));
      }
      if (choice === this.drawing[run]) continue;
      changed = true;
      this.drawing[run] = choice;
      this.passes[run] = choices[choice].stages.length;
      const draws = this.batchDraws[run];
      const { batches } = this.detail.runs[run];
      for (let k = 0; k < draws.length; k++) this.show(draws[k], batches[k], choice);
    }
    if (changed) this.shaderRuns = this.drawnRuns();
  }

  /**
   * `r_drawentities` (`tr_main.c:1186-1188`): with it off, no brush model or `model2` is drawn,
   * and the world's tree still is.
   */
  showEntities(shown: boolean): void {
    if (shown === this.entitiesShown) return;
    this.entitiesShown = shown;
    this.showAll();
    this.sky?.showEntities(shown);
    for (const model of this.models) model.enabled = shown;
  }

  /**
   * Draw what a view sees: its surfaces found (`view/world-vis.ts`), each seen curve's rows chosen
   * as `RB_SurfaceGrid` chooses them (`tr_surface.c:870-908`), and each run whose seen surfaces or
   * rows changed cut again. The camera's near and far planes are set as `R_SetupProjectionZ` sets
   * them (`tr_main.c:569-581`): at `r_znear`, and at the farthest corner of the leafs it reached.
   * Its frustum is the camera's, at the canvas's aspect or the one the camera was given, as the
   * warp under water gives one. The eye is written in each frame for the stages that read the
   * view, and the view's axes for the deforms.
   *
   * @param areamask - The areas closed to the view, as the current snapshot has them.
   * @param lights - The frame's dynamic lights, every one cgame added (`tr.refdef.dlights`).
   */
  see(
    view: FirstPersonView,
    settings: VisibleSetSettings,
    areamask: Uint8Array,
    lights: readonly DynamicLight[] = []
  ): void {
    const switches = this.switches;
    switches.novis = settings.noVis;
    switches.nocull = settings.noCull;
    switches.lockpvs = settings.lockPvs;
    switches.showcluster = settings.showCluster;
    switches.facePlaneCull = settings.facePlaneCull;
    switches.entities = settings.drawEntities;
    const { width, height } = this.app.graphicsDevice;
    const { fov: fovY, aspectRatioMode, aspectRatio } = this.camera;
    const aspect = aspectRatioMode === ASPECT_MANUAL ? aspectRatio : width / height;
    const fovX = (Math.atan(Math.tan((fovY * Math.PI) / 360) * aspect) * 360) / Math.PI;
    this.vis.view(view, fovX, fovY, switches, areamask, lights);
    this.lights = lights;
    const { forward } = angleVectors(view.angles, this.basis);
    this.detail.view(this.vis, view.origin, forward, settings.lodCurveError, this.rewrite);
    this.camera.nearClip = settings.zNear / UNITS_PER_METRE;
    this.camera.farClip = this.vis.zFar / UNITS_PER_METRE;
    const { eye } = this;
    eye[0] = view.origin.x;
    eye[1] = view.origin.y;
    eye[2] = view.origin.z;
    this.eyes.view(eye);
    if (this.deformed) {
      const { angles } = view;
      anglesToAxes(angles.x, angles.y, angles.z, this.deformed.view);
    }
  }

  /**
   * What `r_speeds 1` and `r_speeds 5` would print of the last view, which a check reads as Q3's
   * console prints them (`view/world-indexes.ts`).
   */
  speeds(): ViewSpeeds {
    const speeds = viewSpeeds(this.vis, this.detail.runs, this.passes, this.dlightIndexes);
    // The polys' batches, as `RB_EndSurface` counts any batch (`tr_shade.c:1293-1320`).
    const polys = this.polys.speeds;
    speeds.shaders += polys.batches;
    speeds.surfaces += polys.polys;
    speeds.vertexes += polys.vertexes;
    speeds.triangles += polys.indexes / 3;
    speeds.passTriangles += polys.passIndexes / 3;
    return speeds;
  }

  /** The draws of the last frame's polys, in the order they were given out. */
  get polyDraws(): MeshInstance[] {
    return this.polys.drawn;
  }

  /** The light passes the last frame drew, in the order they were given out. */
  get lightPasses(): MeshInstance[] {
    const { given, count } = this.dlights;
    return given.slice(0, count).map((pass) => pass.instance);
  }

  /**
   * What `r_speeds 4` would print of the last frame (`tr_cmds.c:51-56`): the surfaces a test left
   * a light on and those it left none on, then the vertexes the passes projected and the triangles
   * they drew. Q3 prints it only where a vertex was projected.
   */
  dlightSpeeds(): DlightSpeeds {
    return {
      surfaces: this.vis.dlightSurfaces,
      culled: this.vis.dlightSurfacesCulled,
      vertexes: this.dlightVertexes,
      triangles: this.dlightIndexes / 3
    };
  }

  /**
   * Draw the sky as `RB_StageIteratorSky` does (`tr_sky.c:779-826`): nothing under `r_fastsky`,
   * and otherwise the blocks its seen triangles cover from the eye. After {@link see}, as a sky's
   * run it cuts again is clipped again here.
   *
   * @param fastSky - `r_fastsky`.
   */
  drawSky(view: FirstPersonView, fastSky: boolean): void {
    this.sky?.view(view.origin, this.vis.zFar, fastSky);
  }

  /**
   * Draw the fogs from the eye: each fog's vectors written for the view, in each frame its draws
   * are placed in, as `RB_CalcFogTexCoords` works them out (`tr_shade_calc.c:805-881`), and for
   * the models and effects of its scene drawn after.
   */
  drawFog(view: FirstPersonView): void {
    const { origin } = view;
    const { forward } = angleVectors(view.angles, this.basis);
    const { fogEye: eye, fogForward: along } = this;
    eye[0] = origin.x;
    eye[1] = origin.y;
    eye[2] = origin.z;
    along[0] = forward.x;
    along[1] = forward.y;
    along[2] = forward.z;
    this.fogUniforms.view(eye, along);
    this.fog.view(eye, along);
  }

  /**
   * Every draw shown for the warm-up, every run of all its surfaces with every curve whole, the
   * sky over its whole box and whatever `r_drawentities` or `r_fastsky` hides, and put back after;
   * then each flipbook's frames in turn. The next view finds what it sees, the curves' rows and the
   * sky's blocks again, and the next play binds each flipbook's frame at the clock's time.
   *
   * A run's spare batches, which have nothing to draw with all its surfaces, are left out: they
   * draw with its materials, which its other batches warm.
   */
  warm(): Warmed {
    let restore: (() => void) | null = null;
    return {
      at: (seconds) => {
        this.detail.whole(this.rewrite);
        this.sky?.whole();
        // Every shader a run may draw, so a swap compiles nothing.
        this.batchDraws.forEach((draws, run) => {
          const { batches } = this.detail.runs[run];
          draws.forEach((draw, k) => {
            for (const set of draw.sets) {
              for (const instance of set) instance.visible = batches[k].count > 0;
            }
          });
        });
        restore ??= showHidden(this.root);
        this.deformed?.deform(seconds * 1000);
        // Deformed, the deformed batches show as any other from the warm-up's end on.
        this.deformedOnce = true;
        // Every stage at the moment, none dropping the map: nothing is drawn in play yet.
        this.stages.play(seconds * 1000, this.drawn, false);
        for (const model2 of this.model2s) playModel2(model2, seconds);
        this.warmPasses();
        this.polys.warm(this.polyShaders, this.shaders.fogs.length);
      },
      frames: () => this.stages.flipbookFrames(),
      frame: (k) => this.stages.flip(k),
      end: () => {
        restore?.();
        restore = null;
        this.showAll();
        this.sky?.showAll();
        // Hidden until a frame's lights give them out, and its polys.
        this.dlights.begin();
        this.dlights.end();
        this.polys.hide();
      }
    };
  }

  /**
   * A light's pass of each material the map's shaders take one in, over a batch of the world's,
   * lit by nothing, so each is made under the load screen and not at the first light.
   */
  private warmPasses(): void {
    const { dlights, detail } = this;
    dlights.begin();
    const r = detail.runs.findIndex(
      (run, i) =>
        run.batches[0].count > 0 && this.batchDraws[i].length > 0 && !this.deformed?.meshes(i)
    );
    if (r >= 0) {
      const { base, count } = detail.runs[r].batches[0];
      for (const material of dlights.made) {
        const out = dlights.room(count);
        out.set(detail.indexes.subarray(base, base + count), dlights.written);
        const pass = dlights.draw(material, count, this.vertices, this.root, projectedLight());
        pass.run = r;
        pass.batch = 0;
        pass.light = 0;
        pass.instance.drawOrder = this.passKey(r, 0, 0);
      }
    }
    dlights.end();
  }

  /**
   * Show a batch's draws of the shader its run draws if it draws anything, a brush model's only
   * under `r_drawentities`, and a deformed one only once the clock has deformed it.
   *
   * @param choice - Which of its run's shaders it draws.
   */
  private show(draw: BatchDraw, batch: BatchRange, choice: number): void {
    const shown =
      batch.count > 0 &&
      (!draw.entity || this.entitiesShown) &&
      (!draw.deformed || this.deformedOnce);
    const { sets } = draw;
    for (let s = 0; s < sets.length; s++) {
      for (const instance of sets[s]) instance.visible = shown && s === choice;
    }
  }

  /** The deformed batches the view draws, deformed at `time`, and shown once they first are. */
  private deform(time: number): void {
    if (!this.deformed) return;
    this.deformed.deform(time);
    if (this.deformedOnce) return;
    this.deformedOnce = true;
    this.showAll();
  }

  private showAll(): void {
    this.batchDraws.forEach((draws, run) => {
      const choice = this.drawing[run];
      draws.forEach((draw, k) => this.show(draw, this.detail.runs[run].batches[k], choice));
    });
  }

  /** Each shader's runs that draw it now, by its index. */
  private drawnRuns(): number[][] {
    const runs: number[][] = [];
    this.runChoices.forEach((choices, run) => {
      (runs[choices[this.drawing[run]].index] ??= []).push(run);
    });
    return runs;
  }

  /**
   * Take the world out of the scene and free it: the draws first, then the entities, then the
   * materials and the textures given back (`engine.md`), then the buffers.
   */
  async destroy(): Promise<void> {
    // Every draw placed in its scene goes back to its own layer first.
    this.sceneDraws?.leave(this);
    this.dlights.destroy();
    this.polys.destroy();
    const drawn = [...this.draws, ...this.spare, ...this.ramp];
    this.layer.removeMeshInstances(drawn, true);
    for (const instance of drawn) instance.destroy();
    this.camera.layers = this.camera.layers.filter((id) => id !== this.layer.id);
    [this.camera.nearClip, this.camera.farClip] = this.clips;
    this.app.scene.layers.remove(this.layer);
    this.root.destroy();
    this.scope.dispose();
    for (const page of this.lightmaps) page.destroy();
    this.fogImage?.destroy();
    this.vertices.destroy();
    this.indexes.destroy();
    this.deformed?.destroy();
    this.sky?.destroy();
  }
}

/** A `model2` drawn at `seconds` on the world's clock: its deforms, coordinates and stages. */
function playModel2({ model, animated, light }: Model2, seconds: number): void {
  drawPlacedModel(model, FIRST_FRAME, light, seconds);
  playStagedStages(animated, seconds);
}

/**
 * A batch's mesh over the world's buffers, drawing its range of the indexes, held by the world too:
 * releasing every draw would otherwise free the shared buffers.
 */
function worldMesh(
  device: GraphicsDevice,
  vertices: VertexBuffer,
  indexes: IndexBuffer,
  batch: BatchRange
): Mesh {
  const mesh = new Mesh(device);
  mesh.vertexBuffer = vertices;
  mesh.indexBuffer[0] = indexes;
  mesh.primitive[0] = { type: PRIMITIVE_TRIANGLES, base: 0, baseVertex: 0, count: 0, indexed: true };
  placeBatch(mesh, batch);
  mesh.incRefCount();
  return mesh;
}

/** Scratch for a brush model's turn. */
const rotation = new Quat();

/** The world entity's light, which a `lightingDiffuse` stage on the world reads: none, ever. */
const NO_LIGHT = new Float32Array(12);

/**
 * A brush model as its deforms read it, at the world's origin until placed: its axes in floats as
 * `AnglesToAxis` gives them, and the sun's direction until a frame lights it. No mover casts a
 * shadow plane.
 */
function deformEntity(): ModelDeformEntity {
  const axis = [
    new Float32Array([1, 0, 0]),
    new Float32Array([0, 1, 0]),
    new Float32Array([0, 0, 1])
  ] as const;
  return {
    world: false,
    origin: new Float32Array(3),
    axis,
    lightDir: globalVectorToLocal(SUN_DIRECTION, axis, new Float32Array(3)),
    shadowPlane: 0
  };
}

/** An inline model's slot, its node at the world's origin, never placed. */
function brushModelSlot(model: number): BrushModelSlot {
  return {
    node: new Entity(`*${model}`),
    vis: { model, origin: [NaN, NaN, NaN], angles: [NaN, NaN, NaN] },
    frame: {
      origin: [0, 0, 0],
      axis: [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1]
      ]
    },
    deform: null,
    model2: null,
    lit: null,
    litStages: null,
    placed: false,
    entity: unnumbered(model)
  };
}
