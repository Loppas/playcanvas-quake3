import {
  BLEND_ADDITIVE,
  CULLFACE_BACK,
  Entity,
  Mat4,
  Mesh,
  MeshInstance,
  Quat,
  StandardMaterial,
  type AppBase,
  type GraphicsDevice
} from 'playcanvas';

import { worldToSim } from '../coords';
import { findShader } from '../formats/shader-script';
import type { AssetLibrary } from '../formats/asset-library';
import type { Md3Frame } from '../formats/md3';
import { WEAPON_ASSETS } from '../formats/asset-manifest';
import { TR, type EntityState } from '../net/protocol';
import { CONTENTS, MASK } from '../sim/constants';
import { evaluateTrajectory } from '../sim/trajectory';
import { NO_CONTENTS, type PointContentsFn } from '../sim/types';
import { copy, cross, length, madd, sub, vec3, type Vec3 } from '../sim/vec3';
import { WP, type WeaponId } from '../sim/weapons/constants';
import {
  BUBBLE_RADIUS,
  MISSILE_BUBBLE_SPACING,
  WATER_BUBBLE_SHADER,
  bubbleAlpha,
  bubbleOrigin,
  bubbleTrail,
  type Bubble
} from '../view/bubbles';
import {
  NO_WORLD,
  keptEntityLight,
  type EntityLight,
  type LightingScene
} from '../view/entity-light';
import type { WorldEffect } from '../view/entity-events';
import { explosionOrigin, type Explosion } from '../view/explosions';
import { LocalEntities, type LocalEntity } from '../view/local-entities';
import type { MissileCentity } from '../view/player-view';
import {
  BARE_BFG_EXPLOSION,
  BEAM_TEXTURE_LENGTH,
  BLOOD_MS,
  BLOOD_RADIUS,
  BLOOD_SHADER,
  EXPLOSION_STYLES,
  GRAPPLE_FLARE_SHADER,
  HASTE_PUFF,
  ID_MISSILE_LOOKS,
  JUMP_PAD_PUFF,
  JUMP_PAD_PUFF_DRIFT,
  LASER_RADIUS,
  LASER_SIDES,
  LIGHTNING_BLADES,
  LIGHTNING_BLADE_STEP_DEGREES,
  LIGHTNING_FLARE_OFFSET,
  LIGHTNING_HALF_WIDTH,
  RAIL_CORE_HALF_WIDTH,
  RAIL_TRAIL_MS,
  TRAIL_STEP_MS,
  TRAIL_STYLES,
  beamSide,
  explosionRadius,
  grappleFlarePosition,
  grappleFlareRadius,
  laserFrame,
  missileAxis,
  missileSpinAngle,
  smokeAlpha,
  smokeRadius,
  type Basis,
  type DrawnLaser,
  type LightningBolt,
  type MissileLooks,
  type TrailStyle
} from '../view/effects';
import { hookColor, railCoreColor, type Rgb } from '../view/player-color';
import { PLAYER_PART, localEntity, modelStep, packetEntity } from '../view/scene-sort';
import { LIGHTMAP_2D } from '../view/world-shaders';
import { scaleTransform, type TexTransform } from '../view/shader-animation';
import {
  TELEPORT_EFFECT_DROP,
  TELEPORT_EFFECT_MODEL,
  TELEPORT_EFFECT_MS,
  TELEPORT_EFFECT_SHADER,
  teleportEffectFade
} from '../view/teleport-events';
import {
  animateEffect,
  blendOver,
  createEffectStages,
  isAnimated,
  playStage,
  type EffectStage
} from './effect-material';
import { dimEffectStages } from './bsp-fog';
import { sortAsModel } from './draw-order';
import { EffectsLayer } from './effects-layer';
import {
  sceneEntity,
  setFogRadius,
  tagDraw,
  type FogSource,
  type SceneDraws,
  type SceneEntity,
  type SceneGroup
} from './scene-draws';
import { cloneMaterial, setGain } from './stage-gain';
import {
  applyQuakeTransform,
  copyMd3,
  createMd3Entity,
  createMd3Meshes,
  faceMd3,
  playMd3,
  shadeMd3,
  type Md3Renderable
} from './md3-mesh';
import { MergedSprites, type MergedShader } from './merged-sprites';
import { lightAtEntity, lightInEntity } from './staged-model';
import type { Warmed } from './warm-up';

/**
 * Projectiles and impacts in the world.
 *
 * Everything here lives under one Quake-space root, so positions arriving from the
 * simulation are used exactly as the simulation produced them — units, Z-up, no conversion
 * at any call site. The root alone carries the basis change and the 32 u/m scale, the same
 * arrangement the viewmodel rig uses.
 *
 * Models are built once and copied. Each missile, explosion, spurt of blood and rail core draws on
 * a copy taken from a pool of its kind and given back when it ends, so once its pool has grown, a
 * shot makes nothing. Blood, rail cores, puffs, bubbles and teleports' effects each hold a place
 * among the client's local entities ({@link LocalEntities}), which may free one for a newer local
 * entity of any kind.
 *
 * A projectile's depthless parts — its glow, its smoke trail, the explosion it ends in — draw
 * in the {@link EffectsLayer}, after the splat map, and so do rail and lightning beams
 * with the lightning's impact crackle, bullet impacts and blood. A projectile's body keeps
 * World and its depth.
 *
 * Every effect draws every stage of its shader, one mesh instance per stage over the same mesh,
 * and plays each on the clock Q3 gives it: an impact and the rail core from their own start;
 * missiles, the lightning and its crackle on the game clock. The puffs and the bubbles are sprites
 * merged a shader at a time ({@link MergedSprites}).
 */

/** A missile's drawable form: an MD3 for most weapons, a camera-facing sprite for plasma. */
interface ProjectilePrototype {
  /** Built as an MD3 is; a sprite has no surfaces of its own to shade or turn. */
  model: Md3Renderable;
  /** Whether it is the plasma's sprite, drawn at the serverinfo's `g_plasmaSize`. */
  sprite: boolean;
  /** Its stages on the game clock, which every copy shares: its surfaces' or its sprite's. */
  clock: EffectStage[];
}

/** An explosion prototype's key: the weapon whose model it is, and whose shader it draws. */
function explosionKey(weapon: WeaponId, shaderOf: WeaponId): string {
  return `${weapon}/${shaderOf}`;
}

/** An impact effect waiting to be cloned. */
interface ExplosionPrototype {
  /** The shader it draws, cgame's `customShader` for it. */
  shader: string;
  stages: EffectStage[];
  /** Model to drape the shader over, or null for a sprite. */
  model: Entity | null;
  /** Which of {@link stages} each of the model's mesh instances draws, in order. */
  stageOf: number[];
  /** Its model's frames, which its fog is found by; none for a sprite. */
  frames: readonly Md3Frame[];
  /** Whether an impact of it is drawn as a sprite: its weapon's explosion style is one. */
  sprite: boolean;
}

/** How one weapon's beam is drawn — the two `RB_Surface*` cases that make a line. */
interface BeamStyle {
  shader: string;
  halfWidth: number;
  blades: number;
  /**
   * How long a trail hangs in the air after its shot — or `null` for the lightning bolt, which
   * is never left behind: `CG_LightningBolt` redraws it every frame the gun's flash shows.
   */
  trailMs: number | null;
  /**
   * The clock the beam's shader runs on — its `shaderTime`. `CG_RailTrail` starts it when the
   * trail appears; `CG_LightningBolt` sets none, so the bolt runs on the game clock.
   */
  clock: 'age' | 'game';
  /** Model drawn where the beam lands, for the lightning gun's crackle. */
  flareModel?: string;
}

const BEAM_STYLES: Partial<Record<WeaponId, BeamStyle>> = {
  [WP.RAILGUN]: {
    shader: 'railCore',
    halfWidth: RAIL_CORE_HALF_WIDTH,
    blades: 1,
    trailMs: RAIL_TRAIL_MS,
    clock: 'age'
  },
  [WP.LIGHTNING]: {
    shader: 'lightningBoltNew',
    halfWidth: LIGHTNING_HALF_WIDTH,
    blades: LIGHTNING_BLADES,
    trailMs: null,
    clock: 'game',
    flareModel: 'models/weaphits/crackle.md3'
  }
};

/** A beam prototype: its mesh, material and flare, built once. */
interface BeamPrototype {
  style: BeamStyle;
  mesh: Mesh;
  stages: EffectStage[];
  flare: Md3Renderable | null;
  /** The flare's stages on the game clock, which every copy of it shares. */
  flareClock: EffectStage[];
}

/** A drawing on its own clone of each stage's material, so that it plays them as its own. */
interface OwnDrawing {
  entity: Entity;
  materials: StandardMaterial[];
  /** Its entity's number in a map's scene. */
  order: SceneEntity;
}

/** One beam currently drawn. */
interface ActiveBeam {
  weapon: WeaponId;
  /** Its quads, from the beams given back. */
  drawing: OwnDrawing;
  stages: readonly EffectStage[];
  clock: BeamStyle['clock'];
  /** The beam's own texture coordinates: its texture repeats every 256 units of length. */
  base: TexTransform;
  start: Vec3;
  end: Vec3;
  startTime: number;
  durationMs: number;
  /** The colour it was fired in: the rail's, from `color1`, which a later change leaves alone. */
  color: Rgb;
  /** Its place among the local entities. */
  place: LocalEntity;
}

/** No tint: a beam that is not the rail's. */
const UNTINTED: Rgb = [1, 1, 1];

/** A beam's length in the warm-up, in units: twice its texture's, so its coordinates stretch. */
const WARM_BEAM_LENGTH = 2 * BEAM_TEXTURE_LENGTH;

/** A lightning bolt drawn this frame: from a gun's flash to where its trace ended. */
export interface DrawnBolt extends LightningBolt {
  /** Whose gun it comes from, by entity number, so each keeps its own quads from frame to frame. */
  key: number;
  /** The drawn gun's `tag_flash`, in simulation units. */
  muzzle: Vec3;
  /**
   * Its entity's number in a map's scene, as the gun's owner adds it: its crackle the next. The
   * owner's own body's last part by default.
   */
  order?: number;
}


/** A lightning bolt: one quad set kept for the session, with its crackle. */
interface LiveBolt extends OwnDrawing {
  flare: Md3Renderable | null;
}

/** A grappling hook drawn this frame: from its thrower's gun's flash to the hook. */
export interface DrawnHook {
  /** Who threw it, by client number, so each keeps its pointer and flare from frame to frame. */
  key: number;
  /** Where the hook is: in flight, or where it caught. */
  position: Vec3;
  /** Where the pointer starts: the thrower's drawn gun's `tag_flash`, in simulation units. */
  start: Vec3;
  /** The thrower's `color1`, which {@link hookColor} takes the pointer's and flare's from. */
  color1: Rgb;
  /** Its pointer's entity's number in a map's scene, its flare's the next; by its thrower's. */
  order?: number;
}

/** A grappling hook's flare, and the stages its colour goes into. */
interface HookFlare {
  entity: Entity;
  stages: EffectStage[];
  order: SceneEntity;
}

/** One thrower's hook: its pointer and its flare, each built on first use and kept. */
interface LiveHook {
  pointer: LiveBolt | null;
  flare: HookFlare | null;
}

/** One smoke puff drifting where a projectile passed, one a jump pad threw up, or haste's. */
interface ActivePuff {
  /** The puffs it draws among. */
  sprites: MergedSprites;
  style: TrailStyle;
  startTime: number;
  /** `refEntity.rotation`: its turn in the view's plane, in degrees, set as it is thrown. */
  rotation: number;
  /** Where it was thrown: `le->pos.trBase`. */
  origin: Vec3;
  /** Where it drifts from there, in units a second: `le->pos.trDelta`. */
  drift: Vec3;
  /** Its place among the local entities. */
  place: LocalEntity;
}

/** One bubble rising under water, and its place among the local entities. */
interface ActiveBubble {
  bubble: Bubble;
  place: LocalEntity;
}

/** One impact currently playing: the explosion it draws, and its drawing. */
interface ActiveExplosion {
  explosion: Explosion;
  /** Its prototype's key, under which its drawing is given back. */
  key: string;
  /** Its own clone of each stage's material, so it plays from its own start. */
  drawing: OwnDrawing;
  stages: readonly EffectStage[];
}

/**
 * The explosions' prototype key of a teleport's effect, which draws its model in its own shader as
 * an explosion's does, and is warmed with them.
 */
const TELEPORT_KEY = 'teleport';

/** A teleport's effect being drawn: `CG_SpawnEffect`'s `LE_FADE_RGB`. */
interface ActiveTeleport {
  drawing: OwnDrawing;
  startTime: number;
  /** Its place among the local entities. */
  place: LocalEntity;
}

/** A spurt of blood where a shot struck someone: `CG_Bleed`'s `LE_EXPLOSION`. */
interface ActiveBlood {
  entity: Entity;
  order: SceneEntity;
  /** `refEntity.rotation`: its turn in the screen's plane, in whole degrees. */
  rotation: number;
  startTime: number;
  /** Its place among the local entities. */
  place: LocalEntity;
}

/** A missile in flight: its weapon, and the copy of its model it is drawn as. */
interface LiveMissile {
  weapon: WeaponId;
  copy: Md3Renderable;
}

/** A puff's colour: white, as `CG_SmokePuff` is always handed, its alpha set puff by puff. */
const puffColor = [1, 1, 1, 0];

/** A bubble's: white (`cg_effects.c:74–77`), its alpha set bubble by bubble. */
const bubbleColor = [1, 1, 1, 0];

/** Scratch, reused every frame. */
const orientation = new Quat();
const basisMatrix = new Mat4();
const spin = new Quat();
const turned = new Quat();

/**
 * Beam geometry — `DoRailCore` (`tr_surface.c:280`), one blade or four.
 *
 * Unit length along +X so the caller can scale it to any beam, and `halfWidth` units either
 * side along the local side axis. The U coordinate runs 0..1 over that unit length; the
 * material's tiling then stretches it to `length / 256`, which is how Q3 keeps the texture
 * the same size on a short beam and a long one.
 *
 * @param blades - 1 for the rail core, 4 for a lightning bolt.
 * @param halfWidth - Distance from the axis to each edge, in Quake units.
 */
function createBeamMesh(device: GraphicsDevice, blades: number, halfWidth: number): Mesh {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  const normals: number[] = [];

  for (let blade = 0; blade < blades; blade++) {
    const angle = (blade * LIGHTNING_BLADE_STEP_DEGREES * Math.PI) / 180;
    const sy = Math.cos(angle) * halfWidth;
    const sz = Math.sin(angle) * halfWidth;
    const base = blade * 4;

    positions.push(0, sy, sz, 0, -sy, -sz, 1, sy, sz, 1, -sy, -sz);
    uvs.push(0, 0, 0, 1, 1, 0, 1, 1);
    // The quad's face normal. Unlit geometry does not sample it, but the vertex format has
    // to carry it: a mesh built without a NORMAL stream draws nothing at all.
    const nx = 0;
    const ny = -Math.sin(angle);
    const nz = Math.cos(angle);
    for (let v = 0; v < 4; v++) normals.push(nx, ny, nz);
    indices.push(base, base + 1, base + 2, base + 2, base + 1, base + 3);
  }

  const mesh = new Mesh(device);
  mesh.setPositions(positions);
  mesh.setNormals(normals);
  mesh.setUvs(0, uvs);
  mesh.setIndices(indices);
  mesh.update();
  retainSharedMesh(mesh);
  return mesh;
}

/**
 * Keep a shared mesh alive for the lifetime of the renderer.
 *
 * `MeshInstance.destroy()` reads `if (mesh.refCount < 1) mesh.destroy()`, and each instance
 * holds exactly one count. A mesh that several short-lived effects take turns using therefore
 * drops to zero the moment the *first* of them retires — and PlayCanvas frees its vertex
 * buffer out from under every effect that comes later. The symptom is not a crash: the
 * geometry simply stops appearing, so the first explosion of a session draws and none of the
 * rest do.
 *
 * One extra count, owned by the prototype and never released, is what makes a shared mesh
 * actually shareable.
 */
function retainSharedMesh(mesh: Mesh): void {
  mesh.incRefCount();
}

/**
 * A unit quad in the XY plane, billboarded by copying the camera's rotation. Kept for the
 * session, so any number of short-lived sprites can share it.
 */
export function createSpriteMesh(device: GraphicsDevice): Mesh {
  const mesh = new Mesh(device);
  mesh.setPositions([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]);
  // Present but unused: an unlit material never samples these, and a mesh built without a
  // NORMAL stream draws nothing at all.
  mesh.setNormals([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
  // v = 0 is the top of the image, matching how every texture here is uploaded.
  mesh.setUvs(0, [0, 1, 1, 1, 1, 0, 0, 0]);
  // Wound as Q3's quad stamp (`RB_AddQuadStampExt`): clockwise as the eye sees it, the side Q3's
  // default culling keeps. So a sprite whose shader keeps that culling shows, as the blood's do;
  // one with `cull none`, as every weapon effect's is, shows either way.
  mesh.setIndices([0, 2, 1, 0, 3, 2]);
  mesh.update();
  retainSharedMesh(mesh);
  return mesh;
}

/**
 * A laser's tube (`RB_SurfaceBeam`, `tr_surface.c:284–334`): a hexagon of {@link LASER_RADIUS}
 * about +X at 0 and again at 1, the caller stretching it to the beam, its first corner along +Y
 * and each next turned toward +Z, as {@link laserFrame} lays a tube. Wound to face out, so that
 * culled it shows its near side alone, as the culling Quake 3's world leaves set keeps it.
 */
function createLaserMesh(device: GraphicsDevice): Mesh {
  const positions: number[] = [];
  const normals: number[] = [];
  for (const x of [0, 1]) {
    for (let i = 0; i < LASER_SIDES; i++) {
      const angle = (2 * Math.PI * i) / LASER_SIDES;
      positions.push(x, Math.cos(angle) * LASER_RADIUS, Math.sin(angle) * LASER_RADIUS);
      // Unlit, but a mesh built without a NORMAL stream draws nothing at all.
      normals.push(0, Math.cos(angle), Math.sin(angle));
    }
  }
  const indices: number[] = [];
  for (let i = 0; i < LASER_SIDES; i++) {
    const next = (i + 1) % LASER_SIDES;
    indices.push(i, next, LASER_SIDES + next, i, LASER_SIDES + next, LASER_SIDES + i);
  }
  const mesh = new Mesh(device);
  mesh.setPositions(positions);
  mesh.setNormals(normals);
  mesh.setIndices(indices);
  mesh.update();
  retainSharedMesh(mesh);
  return mesh;
}

/** `RB_SurfaceBeam`'s colour: `qglColor3f( 1, 0, 0 )`. */
const LASER_RED = [1, 0, 0] as const;

/** `RB_SurfaceBeam`'s draw: pure red, added to what is behind it, writing no depth. */
function createLaserMaterial(): StandardMaterial {
  const material = new StandardMaterial();
  material.useLighting = false;
  material.diffuse.set(0, 0, 0);
  setGain(material, null, { color: LASER_RED });
  material.blendType = BLEND_ADDITIVE;
  material.depthWrite = false;
  material.cull = CULLFACE_BACK;
  material.update();
  return material;
}

/** Lay a laser's tube from its start, along its frame. */
function placeLaser(
  entity: Entity,
  start: Vec3,
  { basis, length: reach }: { basis: Basis; length: number }
): void {
  entity.enabled = true;
  entity.setLocalPosition(start.x, start.y, start.z);
  entity.setLocalRotation(basisRotation(basis));
  entity.setLocalScale(reach, 1, 1);
}

/**
 * Play stages that every copy of a drawing shares, with the ripples and deforms of the model they
 * draw on. `CG_Missile`, `CG_LightningBolt` and `CG_Bleed` set no `shaderTime`, so every copy shows
 * the same moment: played once a frame, and only while a copy is drawn.
 */
function playShared(
  stages: readonly EffectStage[],
  model: Md3Renderable | null,
  seconds: number
): void {
  for (const stage of stages) playStage(stage.material, stage, seconds);
  if (model) playMd3(model, seconds);
}

/** Turn a Quake-convention basis into a rotation. */
function basisRotation(basis: Basis): Quat {
  const { forward, left, up } = basis;
  // Column-major: each column is where a local axis lands. MD3 geometry is X-forward,
  // Y-left, Z-up, so the columns are the basis vectors themselves.
  basisMatrix.set([
    forward.x, forward.y, forward.z, 0,
    left.x, left.y, left.z, 0,
    up.x, up.y, up.z, 0,
    0, 0, 0, 1
  ]);
  return orientation.setFromMat4(basisMatrix);
}

/** A drawing given back under `key`, or one `make` makes when none is waiting. */
function take<K, T>(pools: Map<K, T[]>, key: K, make: () => T): T {
  return pools.get(key)?.pop() ?? make();
}

/** Give a drawing back under `key`, for the next effect of its kind. */
function giveBack<K, T>(pools: Map<K, T[]>, key: K, drawing: T): void {
  const pool = pools.get(key);
  if (pool) pool.push(drawing);
  else pools.set(key, [drawing]);
}

export class WorldEffects {
  /** Quake-space root: units, Z-up, everything below it untransformed. */
  private readonly root: Entity;
  private readonly camera: Entity;
  /**
   * The scene's light, its grid and its lights, which light a missile where it flies; a scene with
   * no world when absent.
   */
  private readonly lights: LightingScene | undefined;
  /** A model's light where it stands, then in its own frame, written for each model shaded. */
  private readonly standing = keptEntityLight();
  private readonly framed = keptEntityLight();
  private readonly projectilePrototypes: Map<WeaponId, ProjectilePrototype>;
  private readonly explosionPrototypes: Map<string, ExplosionPrototype>;
  private readonly beamPrototypes: Map<WeaponId, BeamPrototype>;
  /** The places the blood, the rail cores and the puffs take among the local entities. */
  private readonly localEntities: LocalEntities;
  /** Each projectile in flight, by entity number: a copy of its prototype. */
  private readonly live = new Map<number, LiveMissile>();
  /** Each explosion drawn, by the explosion it draws. */
  private readonly explosions = new Map<Explosion, ActiveExplosion>();
  private readonly beams: ActiveBeam[] = [];
  /**
   * The drawings given back, hidden under the root, each taken again before another is made: the
   * missiles' copies by weapon, the explosions' by prototype, the rail cores' by weapon, and the
   * blood's.
   */
  private readonly missilePool = new Map<WeaponId, Md3Renderable[]>();
  private readonly explosionPool = new Map<string, OwnDrawing[]>();
  private readonly beamPool = new Map<WeaponId, OwnDrawing[]>();
  private readonly bloodPool: { entity: Entity; order: SceneEntity }[] = [];
  /**
   * The blood sprite's stages, which every spurt shares, since all of them play on the game
   * clock; `null` when the paks have no `bloodExplosion`.
   */
  private readonly bloodStages: EffectStage[] | null;
  /** Those of {@link bloodStages} that animate. */
  private readonly bloodClock: EffectStage[];
  private readonly bleeds: ActiveBlood[] = [];
  /** The teleport's effect, or `null` when the paks have no `teleportEffect` or its model. */
  private readonly teleportPrototype: ExplosionPrototype | null;
  private readonly teleports: ActiveTeleport[] = [];
  /**
   * Each gun's lightning bolt, by whose gun it is: built on first use and re-placed every frame
   * the gun's flash shows.
   */
  private readonly bolts = new Map<number, LiveBolt>();
  /** Each thrower's grappling hook, by client number, kept for the session. */
  private readonly hooks = new Map<number, LiveHook>();
  /** Each laser's tube, by entity number: built on first use and laid every frame it is sent. */
  private readonly lasers = new Map<number, { entity: Entity; order: SceneEntity }>();
  /** The tube every laser draws, and its draw; made with the first. */
  private laserMesh: Mesh | null = null;
  private readonly laserMaterial = createLaserMaterial();
  /**
   * The stages of the flare at a hook's end, which each hook draws its own copy of, or `null` when
   * the paks have no grate lamp to borrow.
   */
  private readonly flareStages: EffectStage[] | null;
  /** Every puff, in the order thrown. */
  private readonly puffs: ActivePuff[] = [];
  /** Trail time already emitted for each missile — `ent->trailTime`. */
  private readonly trailed = new Map<number, number>();
  /** The trails' and the jump pads' puffs, in `smokePuff`. */
  private readonly smoke: MergedSprites;
  /** Haste's puffs, in `hasteSmokePuff` (`cg_main.c:882`). */
  private readonly haste: MergedSprites;
  /** Every bubble, in the order laid. */
  private readonly bubbles: ActiveBubble[] = [];
  /** The bubbles, in `waterBubble` (`cg_main.c:863`). */
  private readonly water: MergedSprites;
  /** What the world has at a point: `CG_PointContents`, for the trails in a liquid. */
  private readonly pointContents: PointContentsFn;
  /** Quad shared by every sprite. */
  private readonly spriteMesh: Mesh;
  /** Where a projectile's depthless parts draw. */
  private readonly effects: EffectsLayer;
  /** {@link effects} as a render component's `layers` list. */
  private readonly effectLayers: number[];
  /** The scene each drawing is placed in, where one is drawn. */
  private readonly scene: SceneDraws | undefined;

  private constructor(
    camera: Entity,
    root: Entity,
    effects: EffectsLayer,
    spriteMesh: Mesh,
    smoke: MergedSprites,
    haste: MergedSprites,
    water: MergedSprites,
    projectiles: Map<WeaponId, ProjectilePrototype>,
    explosions: Map<string, ExplosionPrototype>,
    beams: Map<WeaponId, BeamPrototype>,
    flareStages: EffectStage[] | null,
    blood: EffectStage[] | null,
    lights: LightingScene | undefined,
    localEntities: LocalEntities,
    pointContents: PointContentsFn,
    scene: SceneDraws | undefined
  ) {
    this.scene = scene;
    this.camera = camera;
    this.lights = lights;
    this.localEntities = localEntities;
    this.pointContents = pointContents;
    this.water = water;
    this.bloodStages = blood;
    this.bloodClock = blood?.filter(isAnimated) ?? [];
    this.effects = effects;
    this.effectLayers = [effects.layer.id];
    this.spriteMesh = spriteMesh;
    this.smoke = smoke;
    this.haste = haste;
    this.projectilePrototypes = projectiles;
    this.explosionPrototypes = explosions;
    this.teleportPrototype = explosions.get(TELEPORT_KEY) ?? null;
    this.beamPrototypes = beams;
    this.root = root;
    this.flareStages = flareStages;
  }

  /**
   * Build every prototype the manifest describes, then the renderer.
   *
   * Asynchronous because textures are decoded here — once, up front, rather than on the
   * frame a rocket happens to land.
   *
   * @param app - The running app.
   * @param library - Extracted weapon assets.
   * @param camera - Camera entity: sprites face it, and the effects layer joins its list.
   * @param lights - The scene's light, which lights a missile where it flies.
   * @param localEntities - The pool the blood, the rail cores, the puffs and the bubbles take
   *   places in.
   * @param pointContents - `CG_PointContents`, which a trail in a liquid asks.
   * @param scene - The scene each drawing is placed in, where a map's world is drawn; the effects'
   *   layer is its effects' own.
   */
  static async create(
    app: AppBase,
    library: AssetLibrary,
    camera: Entity,
    lights?: LightingScene,
    localEntities = new LocalEntities(),
    pointContents: PointContentsFn = NO_CONTENTS,
    scene?: SceneDraws
  ): Promise<WorldEffects> {
    // Before any prototype: a render component takes its layers when it is made, and every
    // clone keeps them.
    const effects = new EffectsLayer(app, camera);
    const effectLayers = [effects.layer.id];
    scene?.keepOwn('effects', [effects.layer]);
    /** A model's draws in the scene, where there is one. */
    const placed = (group: SceneGroup) => (scene ? { scene: { draws: scene, group } } : {});
    const spriteMesh = createSpriteMesh(app.graphicsDevice);
    const projectiles = new Map<WeaponId, ProjectilePrototype>();
    const explosions = new Map<string, ExplosionPrototype>();
    const beams = new Map<WeaponId, BeamPrototype>();
    /** Every stage of an effect model's surfaces, keeping the ones that animate in `clock`. */
    const surfaceStages =
      (clock: EffectStage[]) =>
      async (name: string): Promise<EffectStage[] | null> => {
        if (!findShader(library.shaders, name)) return null;
        const stages = await createEffectStages(app, library, name);
        clock.push(...stages.filter(isAnimated));
        return stages;
      };

    /** An impact's model with every surface drawing `stages`, or `null` with none to draw. */
    const explosionModel = (path: string | undefined, stages: EffectStage[]) => {
      if (!path || !library.read(path)) return null;
      // Every surface draws the explosion shader, stage by stage, and never its own:
      // `CG_MakeExplosion` sets `customShader`.
      const meshes = createMd3Meshes(app.graphicsDevice, library.model(path));
      const instances: MeshInstance[] = [];
      const stageOf: number[] = [];
      for (const mesh of meshes) {
        stages.forEach((stage, index) => {
          instances.push(new MeshInstance(mesh, stage.material));
          stageOf.push(index);
        });
      }
      const model = new Entity(path);
      model.addComponent('render', { meshInstances: instances });
      model.enabled = false;
      return { model, stageOf, frames: library.model(path).frames };
    };

    for (const asset of WEAPON_ASSETS) {
      if (asset.missileModel && library.read(asset.missileModel)) {
        const clock: EffectStage[] = [];
        const model = await createMd3Entity(app, library, asset.missileModel, {
          blendedLayers: effectLayers,
          stages: surfaceStages(clock),
          ...placed('models')
        });
        model.entity.enabled = false;
        projectiles.set(asset.id, { model, sprite: false, clock });
      }

      const beamStyle = BEAM_STYLES[asset.id];
      if (beamStyle) {
        const stages = await createEffectStages(app, library, beamStyle.shader);
        dimEffectStages(stages);
        let flare: Md3Renderable | null = null;
        const flareClock: EffectStage[] = [];
        if (beamStyle.flareModel && library.read(beamStyle.flareModel)) {
          flare = await createMd3Entity(app, library, beamStyle.flareModel, {
            blendedLayers: effectLayers,
            stages: surfaceStages(flareClock),
            ...placed('models')
          });
          flare.entity.enabled = false;
        }
        beams.set(asset.id, {
          style: beamStyle,
          mesh: createBeamMesh(app.graphicsDevice, beamStyle.blades, beamStyle.halfWidth),
          stages,
          flare,
          flareClock
        });
      }

      if (asset.explosionShader) {
        const stages = await createEffectStages(app, library, asset.explosionShader);
        dimEffectStages(stages);
        const style = EXPLOSION_STYLES[asset.id];
        const drawn = style && !style.sprite ? explosionModel(asset.explosionModel, stages) : null;
        explosions.set(explosionKey(asset.id, asset.id), {
          shader: asset.explosionShader,
          stages,
          model: drawn?.model ?? null,
          stageOf: drawn?.stageOf ?? [],
          frames: drawn?.frames ?? [],
          sprite: style?.sprite === true
        });
      }
    }

    // CPMA's BFG impact without a blast: the BFG's model in another weapon's shader.
    const bareShader = BARE_BFG_EXPLOSION.shaderOf!;
    const bareOf = explosions.get(explosionKey(bareShader, bareShader));
    const bareStages = bareOf?.stages;
    const bfgModel = WEAPON_ASSETS.find((asset) => asset.id === WP.BFG)?.explosionModel;
    const bare = bareStages ? explosionModel(bfgModel, bareStages) : null;
    if (bareOf && bareStages && bare) {
      explosions.set(explosionKey(WP.BFG, bareShader), {
        shader: bareOf.shader,
        stages: bareStages,
        ...bare,
        sprite: BARE_BFG_EXPLOSION.sprite
      });
    }

    // A teleport's effect: its model with every surface drawing `teleportEffect`, as
    // `CG_SpawnEffect` sets `customShader`.
    if (findShader(library.shaders, TELEPORT_EFFECT_SHADER)) {
      const stages = await createEffectStages(app, library, TELEPORT_EFFECT_SHADER);
      dimEffectStages(stages);
      const drawn = explosionModel(TELEPORT_EFFECT_MODEL, stages);
      if (drawn) {
        explosions.set(TELEPORT_KEY, {
          shader: TELEPORT_EFFECT_SHADER,
          stages,
          ...drawn,
          sprite: false
        });
      }
    }

    // The plasma bolt has no model at all — `CG_Missile` draws it as a sprite, on the game clock
    // like every missile.
    const plasma = await createEffectStages(app, library, 'sprites/plasma1');
    dimEffectStages(plasma);
    const plasmaEntity = new Entity('plasma-bolt');
    plasmaEntity.addComponent('render', {
      meshInstances: plasma.map((stage) => new MeshInstance(spriteMesh, stage.material)),
      layers: effectLayers
    });
    plasmaEntity.enabled = false;
    // `CG_Missile`'s sprite, in cgame's `plasmaBallShader`.
    const plasmaOrder = sceneEntity({ kind: 'sprite', radius: 0 });
    scene?.placeDrawing(
      plasmaEntity.render!,
      'effects',
      scene.shaders.handle('sprites/plasma1', LIGHTMAP_2D),
      plasmaOrder
    );
    projectiles.set(WP.PLASMAGUN, {
      model: {
        entity: plasmaEntity,
        light: null,
        litMaterial: null,
        order: plasmaOrder,
        ...(scene ? { placement: { draws: scene, group: 'effects' as const } } : {}),
        view: null,
        viewer: null,
        turbulent: [],
        deforming: []
      },
      sprite: true,
      clock: plasma.filter(isAnimated)
    });

    // The grappling hook's flare: the grate lamp's, drawn as a sprite over what is behind
    // it, so that it shows on a white map too. Each hook's colour is its thrower's, set as it
    // draws, on a copy of its own.
    let flareStages: EffectStage[] | null = null;
    if (findShader(library.shaders, GRAPPLE_FLARE_SHADER)) {
      flareStages = await createEffectStages(app, library, GRAPPLE_FLARE_SHADER);
      dimEffectStages(flareStages);
      for (const stage of flareStages) blendOver(stage.material);
    }

    // `CG_Bleed` sets no `shaderTime`, so the blood's frames run on the game clock.
    let blood: EffectStage[] | null = null;
    if (findShader(library.shaders, BLOOD_SHADER)) {
      blood = await createEffectStages(app, library, BLOOD_SHADER);
      dimEffectStages(blood);
    }

    const root = new Entity('world-effects');
    applyQuakeTransform(root);
    app.root.addChild(root);
    const merged = (shader: MergedShader) =>
      MergedSprites.create(app, library, shader, root, [effects.layer], camera, scene);
    return new WorldEffects(
      camera,
      root,
      effects,
      spriteMesh,
      await merged('smokePuff'),
      await merged('hasteSmokePuff'),
      await merged(WATER_BUBBLE_SHADER),
      projectiles,
      explosions,
      beams,
      flareStages,
      blood,
      lights,
      localEntities,
      pointContents,
      scene
    );
  }

  /**
   * Draw this frame.
   *
   * @param effects - What happened in the world this frame, as the client read it.
   * @param missiles - The projectiles in flight: the entity state a client is sent for each, and
   *   where the view draws it.
   * @param time - Simulation time in milliseconds.
   * @param muzzle - The viewmodel's `tag_flash`, in simulation units, where the player's own
   *   beams start.
   * @param bolts - Every lightning bolt drawn this frame: the player's own, and anyone else's.
   * @param hooks - Every grappling hook drawn this frame, with its cable: the player's own, and
   *   anyone else's.
   * @param eye - `cg.refdef.vieworg`: where the view is, for the puffs it is inside of, or
   *   `null` when nothing is drawn.
   * @param explosions - The impacts' explosions playing (`view/explosions.ts`), which the frame's
   *   lights read too. An `impact` effect draws nothing here itself.
   * @param looks - How the serverinfo's rules have the missiles drawn.
   * @param lasers - Every laser the snapshot carried.
   */
  update(
    effects: readonly WorldEffect[],
    missiles: readonly MissileCentity[],
    time: number,
    muzzle: Vec3 | null = null,
    bolts: readonly DrawnBolt[] = [],
    hooks: readonly DrawnHook[] = [],
    eye: Vec3 | null = null,
    explosions: readonly Explosion[] = [],
    looks: MissileLooks = ID_MISSILE_LOOKS,
    lasers: readonly DrawnLaser[] = []
  ): void {
    for (const effect of effects) {
      switch (effect.type) {
        case 'blood':
          this.spawnBlood(effect.origin, time);
          break;

        case 'puff':
          // `EV_JUMP_PAD`'s `CG_SmokePuff`: a fixed-size puff that drifts up from where the
          // player hit the pad (`cg_event.c:662–668`).
          this.spawnPuff(this.smoke, effect.origin, JUMP_PAD_PUFF, time, JUMP_PAD_PUFF_DRIFT);
          break;

        case 'hastePuff':
          // `CG_HasteTrail`'s, thrown at the runner's feet and growing as it fades
          // (`cg_players.c:1522–1532`).
          this.spawnPuff(this.haste, effect.origin, HASTE_PUFF, time);
          break;

        case 'bubbles':
          // A shotgun pellet's, under water (`CG_ShotgunPellet`).
          this.spawnBubbles(effect.start, effect.end, effect.spacing, time);
          break;

        case 'teleport':
          this.spawnTeleport(effect.origin, time);
          break;

        case 'beam':
          // The lightning shot draws nothing: its bolt is redrawn every frame from a trace of
          // its own (`drawBolt`), and its hit leaves only a sound.
          if (BEAM_STYLES[effect.weapon]?.trailMs == null) break;
          // The player's own is drawn from the **viewmodel's** muzzle, not the simulation's. Q3
          // does the same for the lightning — `CG_AddPlayerWeapon` hands `CG_LightningBolt` the
          // `tag_flash` origin — and it is the difference between seeing your own beam and not:
          // the simulation's muzzle sits on the view axis, so a quad spanning it contains the eye
          // and is edge-on to it. Anyone else's starts where their shot did, as Q3's rail does.
          this.spawnBeam(
            effect.weapon,
            effect.own ? (muzzle ?? effect.start) : effect.start,
            effect.end,
            time,
            effect.color
          );
          break;

        default:
          break;
      }
    }

    this.drawBolts(bolts, time);
    this.drawHooks(hooks, time);
    this.drawLasers(lasers);

    this.moveProjectiles(missiles, time, looks.plasmaSize);
    this.drawExplosions(explosions, time);
    this.advanceBlood(time);
    this.advanceTeleports(time);
    this.advanceBeams(time);
    this.advancePuffs(time, eye);
    this.advanceBubbles(time);
  }

  /**
   * The layers a draw that writes no depth goes in, after the splat map: for anything else
   * in the world with such a draw, a player's skin among them.
   */
  get blendedLayers(): number[] {
    return this.effectLayers;
  }

  /**
   * Take every impact, beam, puff, bubble and teleport away, as a restart does (`CG_MapRestart`
   * clears cgame's local entities). The projectiles and the lasers go with the simulation's, at
   * the next update.
   */
  clear(): void {
    for (const drawn of this.explosions.values()) this.retireExplosion(drawn);
    this.explosions.clear();
    for (let i = this.bleeds.length - 1; i >= 0; i--) this.retireBlood(i);
    for (let i = this.teleports.length - 1; i >= 0; i--) this.retireTeleport(i);
    for (let i = this.beams.length - 1; i >= 0; i--) this.retireBeam(i);
    for (const puff of this.puffs) this.localEntities.free(puff.place);
    this.puffs.length = 0;
    for (const { place } of this.bubbles) this.localEntities.free(place);
    this.bubbles.length = 0;
    this.smoke.clear();
    this.haste.clear();
    this.water.clear();
  }

  /**
   * One of everything this draws, for the warm-up (`warm-up.ts`): a copy of each projectile, each
   * explosion as an impact of it is drawn, a rail beam, a lightning bolt with its crackle, a
   * grappling hook's pointer and flare, a laser's tube, a spurt of blood, a puff of each smoke and
   * a bubble, each in its own layer. Each plays on its own clock, as in play. What play takes
   * from a pool is taken from it and given back to it, so the first of each in play makes
   * nothing; the rest is made for the warm-up, and goes with it.
   */
  warm(): Warmed {
    const puffs = [this.smoke.warm(), this.haste.warm(), this.water.warm()];
    const entities: Entity[] = [];
    const materials: StandardMaterial[] = [];
    /** How each pool's drawing goes back to it. */
    const lent: (() => void)[] = [];
    /** How each drawing with materials of its own plays them. */
    const plays: ((seconds: number) => void)[] = [];
    const show = () => {
      const shown = (entity: Entity) => {
        entity.enabled = true;
        entities.push(entity);
      };
      for (const [weapon, prototype] of this.projectilePrototypes) {
        const copy = this.takeMissile(weapon, prototype);
        lent.push(() => this.giveMissile(weapon, copy));
      }
      for (const [key, prototype] of this.explosionPrototypes) {
        if (!prototype.sprite && !prototype.model) continue;
        const drawn = this.takeExplosion(key, prototype);
        lent.push(() => this.giveExplosion(key, drawn));
        plays.push((seconds) =>
          prototype.stages.forEach((stage, index) => {
            if (isAnimated(stage)) playStage(drawn.materials[index], stage, seconds);
          })
        );
      }
      // A beam's own coordinates, which its length stretches, as `spawnBeam` lays them.
      const base = scaleTransform(WARM_BEAM_LENGTH / BEAM_TEXTURE_LENGTH, 1);
      /** A beam's quads on their own clones, played as `play` has it. */
      const beam = (
        prototype: BeamPrototype,
        drawing: OwnDrawing,
        play: (stage: EffectStage, material: StandardMaterial, seconds: number) => void
      ) =>
        plays.push((seconds) =>
          prototype.stages.forEach((stage, index) => play(stage, drawing.materials[index], seconds))
        );
      /** A beam's quads made for the warm-up alone. */
      const made = (prototype: BeamPrototype, name: string, crackle: boolean): LiveBolt => {
        const bolt = this.createBolt(prototype, name, crackle);
        shown(bolt.entity);
        if (bolt.flare) shown(bolt.flare.entity);
        materials.push(...bolt.materials);
        return bolt;
      };
      const rail = this.beamPrototypes.get(WP.RAILGUN);
      if (rail) {
        const core = this.takeBeam(WP.RAILGUN, rail);
        lent.push(() => this.giveBeam(WP.RAILGUN, core));
        beam(rail, core, (stage, material, seconds) =>
          playStage(material, stage, seconds, { base, color: UNTINTED })
        );
        const pointer = made(rail, 'grapple-pointer', false);
        for (const material of pointer.materials) blendOver(material);
        beam(rail, pointer, (stage, material, seconds) =>
          animateEffect(material, stage.animation, seconds, { base, color: UNTINTED })
        );
      }
      const lightning = this.beamPrototypes.get(WP.LIGHTNING);
      if (lightning) {
        beam(lightning, made(lightning, 'lightning-bolt', true), (stage, material, seconds) =>
          playStage(material, stage, seconds, { base })
        );
      }
      if (this.flareStages) {
        const flare = this.createFlare(this.flareStages);
        shown(flare.entity);
        materials.push(...flare.stages.map((stage) => stage.material));
        // A hook's flare always shows its stages' first moment.
        for (const stage of flare.stages) animateEffect(stage.material, stage.animation, 0);
      }
      // A laser's tube, on the draw every laser shares.
      const laser = this.createLaser().entity;
      placeLaser(laser, vec3(), laserFrame(vec3(), vec3(WARM_BEAM_LENGTH, 0, 0))!);
      shown(laser);
      if (this.bloodStages) {
        const blood = this.takeBlood(this.bloodStages);
        lent.push(() => this.giveBlood(blood));
      }
    };
    let showing = false;
    return {
      at: (seconds) => {
        if (!showing) show();
        showing = true;
        for (const { clock, model } of this.projectilePrototypes.values()) {
          playShared(clock, model, seconds);
        }
        for (const { flareClock, flare } of this.beamPrototypes.values()) {
          playShared(flareClock, flare, seconds);
        }
        playShared(this.bloodClock, null, seconds);
        for (const play of plays) play(seconds);
        for (const puff of puffs) puff.at(seconds);
      },
      end: () => {
        for (const puff of puffs) puff.end();
        for (const back of lent) back();
        for (const entity of entities) entity.destroy();
        for (const material of materials) material.destroy();
        lent.length = 0;
        entities.length = 0;
        materials.length = 0;
        plays.length = 0;
        showing = false;
      }
    };
  }

  /** Remove everything from the scene, the pools' drawings and their materials with it. */
  destroy(): void {
    this.clear();
    for (const pool of [...this.explosionPool.values(), ...this.beamPool.values()]) {
      for (const drawing of pool) for (const material of drawing.materials) material.destroy();
    }
    this.smoke.destroy();
    this.haste.destroy();
    this.water.destroy();
    this.root.destroy();
    this.laserMaterial.destroy();
    this.effects.destroy();
  }

  /** A model's light, lit where it is, its direction in its own frame, until the next asked. */
  private lightOf(entity: Entity): EntityLight {
    lightAtEntity(entity, this.lights ?? NO_WORLD, this.standing);
    return lightInEntity(entity, this.standing, this.framed);
  }

  /** Draw a missile on a copy of its prototype, and start tracking it. */
  private spawnProjectile(missile: EntityState): void {
    const weapon = missile.weapon as WeaponId;
    const prototype = this.projectilePrototypes.get(weapon);
    if (!prototype || this.live.has(missile.number)) return;
    this.live.set(missile.number, { weapon, copy: this.takeMissile(weapon, prototype) });
  }

  private removeProjectile(id: number): void {
    const missile = this.live.get(id);
    if (missile) this.giveMissile(missile.weapon, missile.copy);
    this.live.delete(id);
    this.trailed.delete(id);
  }

  /** A copy of a missile's model, shown: one given back, or one made. */
  private takeMissile(weapon: WeaponId, prototype: ProjectilePrototype): Md3Renderable {
    const copy = take(this.missilePool, weapon, () => {
      const made = copyMd3(prototype.model);
      this.root.addChild(made.entity);
      return made;
    });
    copy.entity.enabled = true;
    return copy;
  }

  private giveMissile(weapon: WeaponId, copy: Md3Renderable): void {
    copy.entity.enabled = false;
    giveBack(this.missilePool, weapon, copy);
  }

  /**
   * Place and spin every live projectile — `CG_Missile`.
   *
   * The position is where the view draws it, its trajectory at this instant or the nudge's ahead
   * of that, and the orientation is the velocity that trajectory carries. Nothing is integrated
   * here: the formula is the same one the simulation runs, which is why the two cannot disagree.
   */
  private moveProjectiles(
    missiles: readonly MissileCentity[],
    time: number,
    plasmaSize: number
  ): void {
    const seen = new Set<number>();
    const played = new Set<ProjectilePrototype>();
    for (const { state: missile, origin, trailTime } of missiles) {
      seen.add(missile.number);
      this.spawnProjectile(missile);
      const projectile = this.live.get(missile.number)?.copy;
      if (!projectile) continue;
      const { entity } = projectile;
      projectile.order.value = packetEntity(missile.number);

      entity.setLocalPosition(origin.x, origin.y, origin.z);

      const prototype = this.projectilePrototypes.get(missile.weapon as WeaponId);
      if (prototype && !played.has(prototype)) {
        played.add(prototype);
        playShared(prototype.clock, prototype.model, time / 1000);
      }
      if (prototype?.sprite) {
        this.billboard(entity, plasmaSize * 2);
        setFogRadius(projectile.order, plasmaSize);
      } else {
        entity.setLocalRotation(
          basisRotation(missileAxis(missile.pos.trDelta, missileSpinAngle(time)))
        );
        // Lit where it is and as it is turned, as Q3 lights every entity
        // (`R_SetupEntityLighting`): a rocket by its own light among the rest.
        shadeMd3(projectile, this.lightOf(entity));
      }

      // `deformVertexes autosprite` — the BFG ball's `bfg01`, stamped as a square facing the
      // camera.
      faceMd3(projectile, this.camera);

      this.trail(missile, trailTime, time);
    }

    // A missile that has gone off stops being one, so it is simply no longer here: what it
    // left behind is the impact's own entity. Sweeping is how the drawing follows.
    for (const id of [...this.live.keys()]) {
      if (!seen.has(id)) this.removeProjectile(id);
    }
  }

  /**
   * Lay down smoke behind a projectile — `CG_RocketTrail`.
   *
   * Puffs are placed at fixed 50 ms marks on the *simulation* clock, not one per rendered
   * frame, and each is put where the trajectory says the missile was at that instant. So the
   * trail has the same spacing at 30 fps as at 300, and it lies along the missile's real path
   * rather than along a chord between two frames. It runs to the trajectory at the frame's time,
   * as Quake 3's does, so a nudged missile is drawn ahead of its smoke.
   *
   * A grenade at rest lays none. A missile in a liquid lays none either, and instead bubbles from
   * where it was the frame before when both are in water (`cg_weapons.c:355–373`).
   *
   * @param trailTime - Where its smoke starts from at its first drawing, as the view reset it:
   *   from then on, the last frame's time.
   */
  private trail(missile: EntityState, trailTime: number, time: number): void {
    const style = TRAIL_STYLES[missile.weapon as WeaponId];
    if (!style) return;

    const last = this.trailed.get(missile.number) ?? trailTime;
    this.trailed.set(missile.number, time);
    if (missile.pos.trType === TR.STATIONARY) return;

    const origin = evaluateTrajectory(missile.pos, time);
    const contents = this.pointContents(origin, -1);
    if (contents & MASK.WATER) {
      const lastPos = evaluateTrajectory(missile.pos, last);
      if (contents & this.pointContents(lastPos, -1) & CONTENTS.WATER) {
        this.spawnBubbles(lastPos, origin, MISSILE_BUBBLE_SPACING, time);
      }
      return;
    }

    // `t = step * ((startTime + step) / step)` with integer division — the first mark
    // *strictly after* `last`. Rounding up instead re-emits the mark already laid whenever
    // `last` lands exactly on one, which it does every 200 ms at an 8 ms tick.
    for (
      let at = Math.floor((last + TRAIL_STEP_MS) / TRAIL_STEP_MS) * TRAIL_STEP_MS;
      at <= time;
      at += TRAIL_STEP_MS
    ) {
      this.spawnPuff(this.smoke, evaluateTrajectory(missile.pos, at), style, at);
    }
  }

  /** `CG_BubbleTrail`: bubbles along a line under water, each with its place. */
  private spawnBubbles(start: Vec3, end: Vec3, spacing: number, time: number): void {
    for (const bubble of bubbleTrail(start, end, spacing, time, Math.random)) {
      this.bubbles.push({ bubble, place: this.localEntities.alloc() });
    }
  }

  /**
   * Move and fade every bubble, and draw it — `CG_AddMoveScaleFade` under `LEF_PUFF_DONT_SCALE`.
   * One whose time is up goes, and one whose place the pool freed for a newer local entity.
   *
   * @param time - Simulation time in milliseconds.
   */
  private advanceBubbles(time: number): void {
    this.water.begin();
    let kept = 0;
    for (const active of this.bubbles) {
      const { bubble, place } = active;
      if (place.freed || time >= bubble.endTime) {
        this.localEntities.free(place);
        continue;
      }
      this.bubbles[kept++] = active;
      bubbleColor[3] = bubbleAlpha(bubble, time);
      const order = localEntity(place.serial);
      this.water.add(bubbleOrigin(bubble, time), BUBBLE_RADIUS, 0, bubbleColor, order);
    }
    this.bubbles.length = kept;
    this.water.end();
  }

  /** One puff, turned at random as `CG_SmokePuff` turns it (`cg_effects.c:117`). */
  private spawnPuff(
    sprites: MergedSprites,
    origin: Vec3,
    style: TrailStyle,
    time: number,
    drift: Vec3 = vec3()
  ): void {
    this.puffs.push({
      sprites,
      style,
      startTime: time,
      rotation: Math.random() * 360,
      origin: copy(origin),
      drift,
      place: this.localEntities.alloc()
    });
  }

  /**
   * Move, grow and fade every puff, and draw it — `CG_AddMoveScaleFade` and `CG_AddScaleFade`.
   *
   * A puff drifts along its trajectory, which for a trail is nowhere and for a jump pad is one
   * unit a second upward. It fades through its colour's alpha, which `alphaGen vertex` reads.
   *
   * A puff the view is inside is let go, as Q3's does, "so it doesn't add too much overdraw" —
   * and because a jump pad's puff is thrown at the player's own feet, that is what keeps it out
   * of a first-person view. So is one whose place the pool freed for a newer local entity.
   *
   * @param time - Simulation time in milliseconds.
   * @param eye - `cg.refdef.vieworg`, or `null` when nothing is drawn.
   */
  private advancePuffs(time: number, eye: Vec3 | null): void {
    this.smoke.begin();
    this.haste.begin();
    let kept = 0;
    for (const puff of this.puffs) {
      const progress = (time - puff.startTime) / puff.style.lifetimeMs;
      const seconds = (time - puff.startTime) / 1000;
      const at = madd(puff.origin, seconds, puff.drift);
      if (
        puff.place.freed ||
        progress >= 1 ||
        progress < 0 ||
        (eye && length(sub(at, eye)) < puff.style.radius)
      ) {
        this.localEntities.free(puff.place);
        continue;
      }

      this.puffs[kept++] = puff;
      const radius =
        puff.style.grow === false ? puff.style.radius : smokeRadius(puff.style, progress);
      puffColor[3] = smokeAlpha(progress, puff.style.alpha);
      puff.sprites.add(at, radius, puff.rotation, puffColor, localEntity(puff.place.serial));
    }
    this.puffs.length = kept;
    this.smoke.end();
    this.haste.end();
  }

  /**
   * Start drawing an explosion, `CG_MakeExplosion`'s refEntity, or `null` for one there is
   * nothing to draw with.
   */
  private spawnExplosion(explosion: Explosion): ActiveExplosion | null {
    const { weapon, shaderOf, origin, normal, scale } = explosion;
    const key = explosionKey(weapon, shaderOf);
    const prototype = this.explosionPrototypes.get(key);
    if (!prototype || (!explosion.sprite && !prototype.model)) return null;

    const drawing = this.takeExplosion(key, prototype);
    const { entity } = drawing;
    if (explosion.sprite) {
      // Lifted clear of the surface, or half the fireball is inside the wall.
      const at = explosionOrigin(explosion);
      entity.setLocalPosition(at.x, at.y, at.z);
    } else {
      entity.setLocalPosition(origin.x, origin.y, origin.z);
      // Pointing out of the surface with a random roll, as `CG_MakeExplosion` does.
      entity.setLocalRotation(basisRotation(missileAxis(normal, Math.random() * 360)));
      entity.setLocalScale(scale, scale, scale);
    }
    return { explosion, key, drawing, stages: prototype.stages };
  }

  /** An explosion's drawing, shown: one given back, or one made. */
  private takeExplosion(key: string, prototype: ExplosionPrototype): OwnDrawing {
    const drawing = take(this.explosionPool, key, () => this.makeExplosion(prototype));
    drawing.entity.enabled = true;
    return drawing;
  }

  private giveExplosion(key: string, drawing: OwnDrawing): void {
    drawing.entity.enabled = false;
    giveBack(this.explosionPool, key, drawing);
  }

  /**
   * An explosion's drawing under the root, in the effects layer, with one clone of each stage's
   * material so that it plays its shader from its own start: a sprite, or its model. In the effects
   * layer like every other impact: in World, the splat map painted over any impact farther along
   * the view than its sort point.
   */
  private makeExplosion(prototype: ExplosionPrototype): OwnDrawing {
    const materials = prototype.stages.map((stage) => cloneMaterial(stage.material));
    let entity: Entity;
    if (prototype.sprite) {
      entity = new Entity('explosion');
      entity.addComponent('render', {
        meshInstances: materials.map((material) => new MeshInstance(this.spriteMesh, material))
      });
    } else {
      entity = prototype.model!.clone();
      // Each draw takes its own stage's clone, and its place in Q3's order, which a clone loses.
      entity.render?.meshInstances.forEach((instance, index) => {
        instance.material = materials[prototype.stageOf[index]];
        instance.drawOrder = index;
      });
      sortAsModel(entity.render?.meshInstances ?? [], entity);
    }
    entity.render!.layers = this.effectLayers;
    this.root.addChild(entity);
    const order = sceneEntity(
      prototype.sprite
        ? { kind: 'sprite', radius: 0 }
        : { kind: 'model', frames: prototype.frames, frame: 0 }
    );
    const { scene } = this;
    if (scene) {
      // Every surface in cgame's `customShader`, stage by stage over the model's surfaces.
      scene.place(entity.render!, 'effects');
      const shader = scene.shaders.handle(prototype.shader, LIGHTMAP_2D);
      const stages = prototype.stages.length;
      entity.render!.meshInstances.forEach((instance, index) => {
        const step = prototype.sprite
          ? index
          : modelStep(prototype.stageOf[index], Math.floor(index / stages));
        tagDraw(instance, { shader, entity: order, step });
      });
    }
    return { entity, materials, order };
  }

  /**
   * Draw every explosion playing, as `CG_AddLocalEntities` adds each: one just begun is drawn
   * from here on, and one whose time is up goes with its drawing.
   */
  private drawExplosions(explosions: readonly Explosion[], time: number): void {
    const playing = new Set(explosions);
    for (const [explosion, drawn] of this.explosions) {
      if (playing.has(explosion)) continue;
      this.retireExplosion(drawn);
      this.explosions.delete(explosion);
    }
    for (const explosion of explosions) {
      let drawn = this.explosions.get(explosion);
      if (!drawn) {
        const spawned = this.spawnExplosion(explosion);
        if (!spawned) continue;
        drawn = spawned;
        this.explosions.set(explosion, drawn);
      }
      drawn.drawing.order.value = localEntity(explosion.serial);
      // Its start is set back by up to 63 ms, so it may begin partway along.
      const elapsed = time - explosion.startTime;
      // A sprite grows on `CG_AddSpriteExplosion`'s curve. Its 0.33 alpha goes to additive
      // `rgbGen wave` shaders that never read it, so neither kind of impact fades by anything
      // but its shader.
      if (explosion.sprite) {
        const radius = explosionRadius(elapsed / explosion.durationMs);
        this.billboard(drawn.drawing.entity, radius * 2);
        setFogRadius(drawn.drawing.order, radius);
      }
      // `shaderTime` is the impact's start, so every stage plays from its own beginning.
      const { materials } = drawn.drawing;
      drawn.stages.forEach((stage, index) => {
        if (isAnimated(stage)) playStage(materials[index], stage, elapsed / 1000);
      });
    }
  }

  /** Give an explosion's drawing back. */
  private retireExplosion(drawn: ActiveExplosion): void {
    this.giveExplosion(drawn.key, drawn.drawing);
  }

  /**
   * Start a spurt of blood — `CG_Bleed`: a sprite of `bloodExplosion`, turned a random whole
   * number of degrees in the screen's plane (`rand() % 360`).
   */
  private spawnBlood(origin: Vec3, time: number): void {
    if (!this.bloodStages) return;
    const { entity, order } = this.takeBlood(this.bloodStages);
    entity.setLocalPosition(origin.x, origin.y, origin.z);
    this.bleeds.push({
      entity,
      order,
      rotation: Math.floor(Math.random() * 360),
      startTime: time,
      place: this.localEntities.alloc()
    });
  }

  /** A blood sprite, shown: one given back, or one made over the stages every spurt shares. */
  private takeBlood(stages: readonly EffectStage[]): { entity: Entity; order: SceneEntity } {
    let blood = this.bloodPool.pop();
    if (!blood) {
      const entity = new Entity('blood');
      entity.addComponent('render', {
        meshInstances: stages.map((stage) => new MeshInstance(this.spriteMesh, stage.material)),
        layers: this.effectLayers
      });
      this.root.addChild(entity);
      const fogBy = { kind: 'sprite', radius: BLOOD_RADIUS } as const;
      blood = { entity, order: this.placeDrawing(entity, BLOOD_SHADER, fogBy) };
    }
    blood.entity.enabled = true;
    return blood;
  }

  private giveBlood(blood: { entity: Entity; order: SceneEntity }): void {
    blood.entity.enabled = false;
    this.bloodPool.push(blood);
  }

  /**
   * Place a sprite or a beam drawing one shader in the effects, its draws tagged with cgame's
   * `customShader` for it, stage by stage.
   *
   * @param fogBy - How its fog is found; none for a draw Q3 fogs nothing of.
   * @returns Its entity, for each frame to number.
   */
  private placeDrawing(entity: Entity, shader: string, fogBy?: FogSource): SceneEntity {
    const order = sceneEntity(fogBy);
    const { scene } = this;
    if (!scene) return order;
    const handle = scene.shaders.handle(shader, LIGHTMAP_2D);
    return scene.placeDrawing(entity.render!, 'effects', handle, order);
  }

  /**
   * Face every spurt at the camera and retire the finished ones — `CG_AddExplosion`, which draws
   * a sprite as it was made until `endTime` — and any whose place the pool freed.
   */
  private advanceBlood(time: number): void {
    for (let i = this.bleeds.length - 1; i >= 0; i--) {
      const blood = this.bleeds[i];
      const elapsed = time - blood.startTime;
      if (blood.place.freed || elapsed >= BLOOD_MS || elapsed < 0) {
        this.retireBlood(i);
        continue;
      }
      blood.order.value = localEntity(blood.place.serial);
      this.billboard(blood.entity, BLOOD_RADIUS * 2, blood.rotation);
    }
    if (this.bleeds.length > 0) playShared(this.bloodClock, null, time / 1000);
  }

  private retireBlood(index: number): void {
    const blood = this.bleeds[index];
    this.giveBlood(blood);
    this.localEntities.free(blood.place);
    this.bleeds.splice(index, 1);
  }

  /**
   * Start a teleport's effect — `CG_SpawnEffect`: its model upright, below the event, played from
   * its own start.
   */
  private spawnTeleport(origin: Vec3, time: number): void {
    const prototype = this.teleportPrototype;
    if (!prototype) return;
    const drawing = this.takeExplosion(TELEPORT_KEY, prototype);
    // `AxisClear`: the model as it was built, unturned.
    drawing.entity.setLocalPosition(origin.x, origin.y, origin.z - TELEPORT_EFFECT_DROP);
    drawing.entity.setLocalEulerAngles(0, 0, 0);
    this.teleports.push({ drawing, startTime: time, place: this.localEntities.alloc() });
  }

  /**
   * Play every teleport's effect and retire the finished ones, and any whose place the pool freed.
   * `LE_FADE_RGB` dims it by its colour, which `rgbGen entity` takes, and its `shaderTime` is
   * its start.
   */
  private advanceTeleports(time: number): void {
    const prototype = this.teleportPrototype;
    for (let i = this.teleports.length - 1; i >= 0; i--) {
      const teleport = this.teleports[i];
      const elapsed = time - teleport.startTime;
      if (!prototype || teleport.place.freed || elapsed >= TELEPORT_EFFECT_MS || elapsed < 0) {
        this.retireTeleport(i);
        continue;
      }
      const brightness = teleportEffectFade(elapsed);
      const { materials } = teleport.drawing;
      teleport.drawing.order.value = localEntity(teleport.place.serial);
      prototype.stages.forEach((stage, index) => {
        playStage(materials[index], stage, elapsed / 1000, { brightness });
      });
    }
  }

  private retireTeleport(index: number): void {
    const teleport = this.teleports[index];
    this.giveExplosion(TELEPORT_KEY, teleport.drawing);
    this.localEntities.free(teleport.place);
    this.teleports.splice(index, 1);
  }

  /**
   * Start a beam — `CG_RailTrail`.
   *
   * @param color - The `color1` of whoever fired it, which a rail's core takes.
   */
  private spawnBeam(weapon: WeaponId, start: Vec3, end: Vec3, time: number, color: Rgb): void {
    const prototype = this.beamPrototypes.get(weapon);
    if (!prototype) return;

    // Its own clone of each stage: each beam has its own length, and the rail its own start.
    const drawing = this.takeBeam(weapon, prototype);
    const length = Math.hypot(end.x - start.x, end.y - start.y, end.z - start.z);
    // One with no length is laid nowhere, so it stays hidden rather than show where its quads were
    // last laid.
    drawing.entity.enabled = length > 0;

    this.beams.push({
      weapon,
      drawing,
      stages: prototype.stages,
      clock: prototype.style.clock,
      // `t = len / 256` in `DoRailCore`: the texture repeats every 256 units however long the
      // beam is.
      base: scaleTransform(length / BEAM_TEXTURE_LENGTH, 1),
      // Copied: a beam outlives the frame that produced it, and nothing here should depend on
      // the simulation leaving its vectors alone afterwards.
      start: copy(start),
      end: copy(end),
      startTime: time,
      durationMs: prototype.style.trailMs ?? 0,
      color: weapon === WP.RAILGUN ? railCoreColor(color) : UNTINTED,
      place: this.localEntities.alloc()
    });
  }

  /** A beam's quads, shown: one given back, or one made. */
  private takeBeam(weapon: WeaponId, prototype: BeamPrototype): OwnDrawing {
    const drawing = take(this.beamPool, weapon, () => this.createBolt(prototype, 'beam', false));
    drawing.entity.enabled = true;
    return drawing;
  }

  private giveBeam(weapon: WeaponId, drawing: OwnDrawing): void {
    drawing.entity.enabled = false;
    giveBack(this.beamPool, weapon, drawing);
  }

  /**
   * Re-aim every live beam at the camera and fade it out, and retire one whose time is up or
   * whose place the pool freed.
   *
   * The orientation cannot be set once and left: a beam's quad has to face wherever the
   * viewer is *now*, so walking around a rail trail keeps it broadside instead of letting it
   * thin to a line.
   */
  private advanceBeams(time: number): void {
    if (this.beams.length === 0) return;

    const world = this.camera.getPosition();
    const eye = worldToSim(world.x, world.y, world.z);

    for (let i = this.beams.length - 1; i >= 0; i--) {
      const beam = this.beams[i];
      const elapsed = time - beam.startTime;
      if (beam.place.freed || elapsed >= beam.durationMs || elapsed < 0) {
        this.retireBeam(i);
        continue;
      }

      if (this.placeBeam(beam.drawing.entity, beam.start, beam.end, eye) === 0) continue;
      beam.drawing.order.value = localEntity(beam.place.serial);

      // `LE_FADE_RGB` — and the name is the instruction: the trail dims by losing colour,
      // not by losing alpha, which an additive blend would ignore anyway. It reaches the rail
      // core through `rgbGen vertex`.
      const fade = 1 - elapsed / beam.durationMs;
      const seconds = (beam.clock === 'age' ? elapsed : time) / 1000;
      beam.stages.forEach((stage, index) => {
        playStage(beam.drawing.materials[index], stage, seconds, {
          base: beam.base,
          brightness: fade,
          color: beam.color
        });
      });
    }
  }

  /**
   * Lay a beam's quads from `start` to `end`, turned broadside to the viewer.
   *
   * @returns The beam's length, or 0 for one too short to lay.
   */
  private placeBeam(entity: Entity, start: Vec3, end: Vec3, eye: Vec3): number {
    const length = Math.hypot(end.x - start.x, end.y - start.y, end.z - start.z);
    if (length === 0) return 0;

    const direction = {
      x: (end.x - start.x) / length,
      y: (end.y - start.y) / length,
      z: (end.z - start.z) / length
    };
    const side = beamSide(start, end, eye);
    entity.setLocalPosition(start.x, start.y, start.z);
    // The mesh is a unit length along +X, `halfWidth` units either side along +Y.
    entity.setLocalRotation(
      basisRotation({ forward: direction, left: side, up: cross(direction, side) })
    );
    entity.setLocalScale(length, 1, 1);
    return length;
  }

  /**
   * Draw this frame's lightning bolts, and hide the rest — `CG_LightningBolt`.
   *
   * One bolt per gun, kept and re-placed every frame rather than spawned per shot: from the gun's
   * `tag_flash` to where this frame's trace ended, at full strength, with the crackle re-rolled
   * wherever it hit. Nothing of one outlives the frame its gun's flash goes out.
   *
   * @param bolts - Every bolt drawn this frame.
   * @param time - Simulation time in milliseconds: the bolt's shaders run on the game clock.
   */
  private drawBolts(bolts: readonly DrawnBolt[], time: number): void {
    const drawn = new Set<number>();
    const prototype = this.beamPrototypes.get(WP.LIGHTNING);
    if (prototype) {
      let crackled = false;
      for (const bolt of bolts) {
        drawn.add(bolt.key);
        let live = this.bolts.get(bolt.key);
        if (!live) {
          live = this.createBolt(prototype);
          this.bolts.set(bolt.key, live);
        }
        live.order.value = bolt.order ?? packetEntity(bolt.key, PLAYER_PART.bolt);
        if (live.flare) live.flare.order.value = live.order.value + 1;
        if (this.drawBolt(live, prototype, bolt, time)) crackled = true;
      }
      if (crackled) playShared(prototype.flareClock, prototype.flare, time / 1000);
    }
    for (const [key, live] of this.bolts) {
      if (!drawn.has(key)) this.hideBolt(live);
    }
  }

  /**
   * Lay one bolt from its gun's flash to its end, with its crackle where it hit.
   *
   * @returns Whether its crackle shows.
   */
  private drawBolt(
    live: LiveBolt,
    prototype: BeamPrototype,
    { muzzle, end, hit }: DrawnBolt,
    time: number
  ): boolean {
    const { entity, materials, flare } = live;
    const world = this.camera.getPosition();
    const length = this.placeBeam(entity, muzzle, end, worldToSim(world.x, world.y, world.z));
    if (length === 0) {
      this.hideBolt(live);
      return false;
    }
    entity.enabled = true;

    // The texture repeats every 256 units of the bolt, however long it is this frame.
    const base = scaleTransform(length / BEAM_TEXTURE_LENGTH, 1);
    prototype.stages.forEach((stage, index) => {
      playStage(materials[index], stage, time / 1000, { base });
    });

    // The crackle sits 16 units back from where the bolt landed, all three angles re-rolled
    // every frame.
    if (!flare) return false;
    flare.entity.enabled = hit;
    if (!hit) return false;
    const back = LIGHTNING_FLARE_OFFSET / length;
    flare.entity.setLocalPosition(
      end.x - (end.x - muzzle.x) * back,
      end.y - (end.y - muzzle.y) * back,
      end.z - (end.z - muzzle.z) * back
    );
    flare.entity.setLocalEulerAngles(
      Math.random() * 360,
      Math.random() * 360,
      Math.random() * 360
    );
    shadeMd3(flare, this.lightOf(flare.entity));
    return true;
  }

  /**
   * Build a lightning bolt's quads, hidden, in the effects layer: with the gun's crackle, or
   * without it for the grapple's pointer.
   */
  private createBolt(prototype: BeamPrototype, name = 'lightning-bolt', crackle = true): LiveBolt {
    const materials = prototype.stages.map((stage) => cloneMaterial(stage.material));
    const entity = new Entity(name);
    entity.addComponent('render', {
      meshInstances: materials.map((material) => new MeshInstance(prototype.mesh, material)),
      layers: this.effectLayers
    });
    entity.enabled = false;
    this.root.addChild(entity);
    // `R_SpriteFogNum` at its start, its radius 0.
    const order = this.placeDrawing(entity, prototype.style.shader, { kind: 'sprite', radius: 0 });

    let flare: Md3Renderable | null = null;
    if (crackle && prototype.flare) {
      flare = copyMd3(prototype.flare);
      flare.entity.enabled = false;
      this.root.addChild(flare.entity);
    }
    return { entity, materials, flare, order };
  }

  private hideBolt(bolt: LiveBolt): void {
    bolt.entity.enabled = false;
    if (bolt.flare) bolt.flare.entity.enabled = false;
  }

  /**
   * Draw every grappling hook, and put away those no longer out — CorkScrew's
   * `CG_GrappleTrail`, which draws a hook alike in flight and once it has caught, whoever threw
   * it.
   *
   * A hook is a pointer: the rail core's beam from its thrower's gun's flash to wherever the hook
   * is, on the game clock, with the grate lamp's flare at its end. CorkScrew draws no model for
   * it, and draws both in the thrower's rail colour, green and blue at three-quarters. The port
   * draws them over what is behind them rather than added to it, so that they show on a white
   * map as well as a dark one.
   *
   * @param hooks - Every hook drawn this frame.
   * @param time - Simulation time in milliseconds.
   */
  private drawHooks(hooks: readonly DrawnHook[], time: number): void {
    const drawn = new Set<number>();
    for (const hook of hooks) {
      drawn.add(hook.key);
      let live = this.hooks.get(hook.key);
      if (!live) {
        live = { pointer: null, flare: null };
        this.hooks.set(hook.key, live);
      }
      this.drawHook(live, hook, time);
    }
    for (const [key, live] of this.hooks) {
      if (!drawn.has(key)) this.hideHook(live);
    }
  }

  /** Lay one hook's pointer from its thrower's flash to the hook, with its flare at the end. */
  private drawHook(live: LiveHook, hook: DrawnHook, time: number): void {
    const world = this.camera.getPosition();
    const eye = worldToSim(world.x, world.y, world.z);
    const color = hookColor(hook.color1);
    const order = hook.order ?? packetEntity(hook.key, PLAYER_PART.hook);

    const prototype = this.beamPrototypes.get(WP.RAILGUN);
    if (prototype) {
      if (!live.pointer) {
        live.pointer = this.createBolt(prototype, 'grapple-pointer', false);
        for (const material of live.pointer.materials) blendOver(material);
      }
      const { entity, materials } = live.pointer;
      live.pointer.order.value = order;
      const length = this.placeBeam(entity, hook.start, hook.position, eye);
      entity.enabled = length > 0;
      if (length > 0) {
        // The texture repeats every 256 units of the pointer, however long it is this frame.
        // Played without a flipbook binding, which would put back the map `blendOver` took.
        const base = scaleTransform(length / BEAM_TEXTURE_LENGTH, 1);
        prototype.stages.forEach((stage, index) => {
          animateEffect(materials[index], stage.animation, time / 1000, { base, color });
        });
      }
    }

    if (this.flareStages) {
      live.flare ??= this.createFlare(this.flareStages);
      const at = grappleFlarePosition(hook.position, eye);
      const { entity, stages } = live.flare;
      live.flare.order.value = order + 1;
      entity.enabled = true;
      entity.setLocalPosition(at.x, at.y, at.z);
      this.billboard(entity, grappleFlareRadius() * 2);
      for (const stage of stages) animateEffect(stage.material, stage.animation, 0, { color });
    }
  }

  /** A hook's flare, hidden, in the effects layer, on its own copy of each stage's material. */
  private createFlare(prototype: readonly EffectStage[]): HookFlare {
    const stages = prototype.map((stage) => ({
      ...stage,
      material: cloneMaterial(stage.material)
    }));
    const entity = new Entity('grapple-flare');
    entity.addComponent('render', {
      meshInstances: stages.map((stage) => new MeshInstance(this.spriteMesh, stage.material)),
      layers: this.effectLayers
    });
    entity.enabled = false;
    this.root.addChild(entity);
    const fogBy = { kind: 'sprite', radius: grappleFlareRadius() } as const;
    return { entity, stages, order: this.placeDrawing(entity, GRAPPLE_FLARE_SHADER, fogBy) };
  }

  private hideHook(live: LiveHook): void {
    if (live.pointer) this.hideBolt(live.pointer);
    if (live.flare) live.flare.entity.enabled = false;
  }

  /**
   * Draw every laser's beam, and hide those no longer sent — `CG_Beam` (`cg_ents.c:605–622`), as
   * `RB_SurfaceBeam` draws it, but from the laser to where its beam stopped.
   *
   * @param lasers - Every laser the snapshot carried.
   */
  private drawLasers(lasers: readonly DrawnLaser[]): void {
    const drawn = new Set<number>();
    for (const laser of lasers) {
      const frame = laserFrame(laser.start, laser.end);
      if (!frame) continue;
      drawn.add(laser.key);
      let live = this.lasers.get(laser.key);
      if (!live) {
        live = this.createLaser();
        this.lasers.set(laser.key, live);
      }
      live.order.value = packetEntity(laser.key);
      placeLaser(live.entity, laser.start, frame);
    }
    for (const [key, { entity }] of this.lasers) {
      if (!drawn.has(key)) entity.enabled = false;
    }
  }

  /**
   * A laser's tube, hidden, in the effects layer: `RT_BEAM`, which takes the default shader's place
   * (`R_AddEntitySurfaces`, `tr_main.c:1213-1228`).
   */
  private createLaser(): { entity: Entity; order: SceneEntity } {
    this.laserMesh ??= createLaserMesh(this.spriteMesh.device);
    const entity = new Entity('target-laser');
    entity.addComponent('render', {
      meshInstances: [new MeshInstance(this.laserMesh, this.laserMaterial)],
      layers: this.effectLayers
    });
    entity.enabled = false;
    this.root.addChild(entity);
    return { entity, order: this.placeDrawing(entity, '') };
  }

  private retireBeam(index: number): void {
    const beam = this.beams[index];
    this.giveBeam(beam.weapon, beam.drawing);
    this.localEntities.free(beam.place);
    this.beams.splice(index, 1);
  }

  /**
   * Face a sprite at the camera and size it.
   *
   * The world rotation is taken straight from the camera, so the quad's plane is the screen's
   * plane. Scale is local and the root's own scale is uniform, so Quake units go in unchanged.
   *
   * @param entity - Sprite to orient.
   * @param size - Edge length in Quake units.
   * @param rotation - `refEntity.rotation`: its turn in the screen's plane, in degrees.
   */
  private billboard(entity: Entity, size: number, rotation = 0): void {
    spin.setFromEulerAngles(0, 0, rotation);
    entity.setRotation(turned.copy(this.camera.getRotation()).mul(spin));
    entity.setLocalScale(size, size, size);
  }
}

