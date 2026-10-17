import { Entity, type AppBase } from 'playcanvas';

import { parseAnimationConfig, type AnimationConfig } from '../formats/animation-config';
import type { AssetLibrary } from '../formats/asset-library';
import {
  PLAYER_PARTS,
  WEAPON_ASSETS,
  playerModelDir,
  weaponModelPath
} from '../formats/asset-manifest';
import type { Md3Model } from '../formats/md3';
import { findShader } from '../formats/shader-script';
import { parseSkin, type SkinSurface } from '../formats/skin';
import type { Vec3 } from '../sim/vec3';
import { TEAM } from '../sim/constants';
import { PW } from '../sim/items';
import { WP, type WeaponId } from '../sim/weapons/constants';
import {
  NO_WORLD,
  entityLightAt,
  keptEntityLight,
  lightInEntityFrame,
  type EntityLight,
  type LightingScene
} from '../view/entity-light';
import {
  createPlayerEntity,
  playerAngles,
  playerAnimation,
  type FrameBlend,
  type PlayerEntity
} from '../view/player-animation';
import { flashColor, gunColor, type Rgb } from '../view/player-color';
import type { ModelSkin, PlayerLook } from '../view/player-model';
import { poseWeapon, posePlayer, type PlayerModels, type Placement, type PosedModel } from '../view/player-pose';
import {
  BODY_SHELL_SHADERS,
  bodyPasses,
  hasteTrailPuff,
  invisible,
  weaponPasses
} from '../view/powerup-passes';
import { PLAYER_PART } from '../view/scene-sort';
import { createBarrelSpin, flashVisible, spinBarrel, type BarrelSpin } from '../view/viewmodel';
import {
  createEffectStages,
  isAnimated,
  playStage,
  takesEntityColor,
  type EffectStage
} from './effect-material';
import {
  applyQuakeTransform,
  createMd3Entity,
  faceMd3,
  playMd3,
  shadeMd3,
  type Md3Renderable
} from './md3-mesh';
import type { SceneDraws } from './scene-draws';
import { ShellCache, type Shell } from './shell-cache';
import type { SkinStage } from './skin-material';
import {
  FIRST_FRAME,
  buildStagedModel,
  drawStagedModel,
  ownShader,
  place,
  playStagedStages,
  type StagedLayers,
  type StagedModel
} from './staged-model';
import type { ResourceScope, TextureCache } from './texture-cache';
import { showHidden, type Warmed } from './warm-up';

/**
 * A player's body in the world: the three parts, their skin, and the weapon in hand.
 *
 * Built as `CG_Player` builds its refEntities each frame. The sim's animation numbers become each
 * part's frames (`playerAnimation`) and axis (`playerAngles`); the tag chain places the parts and
 * the weapon (`posePlayer`, `poseWeapon`). Every piece is an entity straight under the rig's
 * root, in Quake units, placed where Q3 would place its refEntity.
 *
 * Each part draws its surfaces' shared meshes, morphed on the GPU by uniforms of its own, so
 * bodies on different frames still share every mesh. The skin draws every stage of its shaders, and so does the weapon, lit by the entity light where
 * Q3 lights them (`staged-model.ts`). A body holds its textures by count and its materials
 * outright, and gives them all back when it is destroyed, so a model swap frees the old model.
 */

/** The flash's roll, `crandom() * 10` (`cg_weapons.c:1321`). */
const FLASH_ROLL_DEGREES = 10;

/** A weapon in the body's hand: the gun and what hangs off it, each placed on its own. */
interface HeldWeapon {
  id: WeaponId;
  /** The gun and its barrel, drawing every stage of their shaders as the skin draws its own. */
  gun: StagedModel;
  barrel: StagedModel | null;
  /**
   * The gun's and the barrel's stages played every frame: those that animate, on the game clock,
   * and those that take the entity's colour, as the railgun's glow takes `color1`.
   */
  stages: SkinStage[];
  /**
   * The flash, shaded by how it is turned, its `deformVertexes autosprite` surfaces turned to the
   * camera.
   */
  flash: Md3Renderable | null;
  /**
   * The flash's stages played while it shows: those that animate, on the game clock, and
   * those that take the entity's colour, as the railgun's takes `color1`.
   */
  flashStages: EffectStage[];
  /** `CG_MachinegunSpinAngle`'s state, this body's own. */
  spin: BarrelSpin | null;
  /** The gun's and the barrel's shells, built on first use. */
  shells: ShellCache;
}

/** A weapon placed on the torso this frame, and whether its flash shows. */
interface HeldPose {
  weapon: HeldWeapon;
  pose: ReturnType<typeof poseWeapon>;
  flashing: boolean;
}

/** A body placed this frame, as {@link PlayerRig.pose} leaves it to be drawn. */
interface PosedBody {
  state: PlayerRigState;
  time: number;
  powerups: number;
  pose: ReturnType<typeof posePlayer>;
  passes: ReturnType<typeof bodyPasses>;
  held: HeldPose | null;
}

/** Where a body draws, and what faces the viewer. */
export interface PlayerRigOptions {
  /**
   * Layers for everything the body draws that writes depth: the model page's preview keeps the
   * whole body in its own. World when absent.
   */
  layers?: number[];
  /** Layers for the stages that write no depth; with the rest when absent. */
  blendedLayers?: number[];
  /**
   * The camera the body is seen from: a skin that shines or mirrors does so by it, and a sprite
   * turns to face it.
   */
  camera?: Entity;
  /**
   * The scene's light, its world's grid and its dynamic lights, which light the body where it
   * stands. A scene with no world when absent, as the model page's preview is.
   */
  lights?: LightingScene;
  /** The scene the body is placed in, where a map's world is drawn; its layers otherwise. */
  scene?: SceneDraws;
}

/** What a body is drawn from, all of it the sim's (`BG_PlayerStateToEntityState`). */
export interface PlayerRigState {
  /** `lerpOrigin`: the player's origin, 24 units above the feet. */
  origin: Readonly<Vec3>;
  /** Where the player looks: pitch, yaw and roll. */
  angles: Readonly<Vec3>;
  legsAnim: number;
  torsoAnim: number;
  movementDir: number;
  velocity: Readonly<Vec3>;
  /** `EF_DEAD`: at 0 health or below. */
  dead: boolean;
  weapon: WeaponId;
  /** `EF_FIRING`. */
  firing: boolean;
  /** When the last shot was fired, for the flash. */
  lastFireTime: number;
  /** Game time in milliseconds, which `cg.time` counts whole. */
  time: number;
  /**
   * `cent->pe.painTime` and `painDirection`: the torso twitches for 200 ms after a pain sound.
   * No hurt when absent.
   */
  painTime?: number;
  painDirection?: number;
  /**
   * `RF_THIRD_PERSON`: the player's own body while the camera is in its eyes. It is animated, so
   * the view weapon can follow its torso, and not drawn.
   */
  hidden?: boolean;
  /**
   * The player's effects colour, `color1`, which the railgun's flash and glow take. Untinted
   * when absent.
   */
  color?: Rgb;
  /**
   * When the railgun last fired, for its glow's return (`cent->pe.railFireTime`). Long ago when
   * absent.
   */
  railFireTime?: number;
  /**
   * `cent->currentState.powerups`: the bitmask of the powerups held, which draws the shells over
   * the body and plays it faster under haste. None when absent.
   */
  powerups?: number;
  /** The wearer's team, which picks the red quad's shell (`TEAM.FREE` when absent). */
  team?: number;
  /**
   * Its entity's number in a map's scene, its first part's (`packetEntity`, `scene-sort.ts`): each
   * part takes its place after it (`PLAYER_PART`). Left as it was when absent.
   */
  entity?: number;
}

/**
 * Make sure a look's models are in the library, reading from the paks any it lacks, before a body
 * is built of them (`CG_RegisterClientModelname`, `cg_players.c:522–614`).
 *
 * @throws for a model the install has not got, which sends the caller to sarge
 *   (`cg_players.c:672–694`)
 */
export async function loadLook(library: AssetLibrary, look: PlayerLook): Promise<void> {
  for (const model of new Set([look.body.model, look.head.model])) {
    if (!(await library.loadPlayerModel(model))) throw new Error(`${model}: not in the install`);
  }
}

/**
 * Where a body's draws go: its own layers, or the scene's where it is placed in one, its every
 * surface in `customShader` where one is given.
 */
export function bodyPlacement(
  { layers, blendedLayers, scene }: PlayerRigOptions,
  customShader?: string
): StagedLayers {
  return {
    layers,
    blendedLayers,
    ...(scene ? { scene: { draws: scene, group: 'models', customShader } } : {})
  };
}

/** One player model, drawn. */
export class PlayerRig {
  /** Quake units, Z-up, at the world's origin; every piece is placed under it. */
  readonly root: Entity;
  readonly model: string;
  readonly skin: string;
  readonly config: AnimationConfig;
  private readonly app: AppBase;
  private readonly library: AssetLibrary;
  private readonly scope: ResourceScope;
  private readonly options: PlayerRigOptions;
  private readonly models: PlayerModels;
  private readonly parts: { legs: StagedModel; torso: StagedModel; head: StagedModel };
  /** The skin's stages that change over time. */
  private readonly animated: SkinStage[];
  /** `playerEntity_t`: the parts' frame clocks and swings. */
  private readonly animation: PlayerEntity;
  /** Built weapons, kept by promise so a build in flight is shared. */
  private readonly weapons = new Map<WeaponId, Promise<HeldWeapon | null>>();
  private weapon: HeldWeapon | null = null;
  private requestedWeapon: WeaponId | null = null;
  private selecting: Promise<void> = Promise.resolve();
  /** The body's own shells, built on first use: `<shader>/<legs|torso|head>`. */
  private readonly shells = this.shellCache();
  /** `cent->trailTime`: when the next haste puff is due, zero on a fresh body. */
  private trailTime = 0;
  /** The body's light, and its flash's in the flash's frame, written each frame. */
  private readonly light = keptEntityLight();
  private readonly flashLight = keptEntityLight();
  /** The last frame's whole-millisecond time, for `cg.frametime`. */
  private lastTime: number | null = null;
  /** The torso's frames as the last update left them. */
  private torso: FrameBlend | null = null;
  /** The weapon's `tag_flash` as last drawn, in Quake units. */
  private muzzle: Vec3 | null = null;
  /** This frame's pose, until it is drawn. */
  private posed: PosedBody | null = null;
  private destroyed = false;

  private constructor(
    app: AppBase,
    library: AssetLibrary,
    scope: ResourceScope,
    options: PlayerRigOptions,
    root: Entity,
    model: string,
    skin: string,
    config: AnimationConfig,
    models: PlayerModels,
    parts: { legs: StagedModel; torso: StagedModel; head: StagedModel },
    animated: SkinStage[]
  ) {
    this.app = app;
    this.library = library;
    this.scope = scope;
    this.options = options;
    this.root = root;
    this.model = model;
    this.skin = skin;
    this.config = config;
    this.models = models;
    this.parts = parts;
    this.animated = animated;
    this.animation = createPlayerEntity({ x: 0, y: 0, z: 0 });
  }

  /**
   * Build a model with one of its skins, as `CG_RegisterClientModelname` loads it
   * (`cg_players.c:522–614`): the three parts, their skins and `animation.cfg`, which must all be
   * in the library. The icon is the HUD's business, not the body's.
   *
   * @param cache - Where the textures are counted, shared with every other body.
   * @param head - The head's model and skin, from `headmodel`: `head.md3` and its skin from that
   *   model's folder (`cg_players.c:555–570`). The body's by default.
   * @throws for a model Q3 would fail, which sends the caller to sarge (`cg_players.c:672–694`)
   */
  static async create(
    app: AppBase,
    library: AssetLibrary,
    cache: TextureCache,
    model: string,
    skin = 'default',
    options: PlayerRigOptions = {},
    head: ModelSkin = { model, skin }
  ): Promise<PlayerRig> {
    const dir = playerModelDir(model);
    const headDir = playerModelDir(head.model);
    const text = (path: string) => {
      const bytes = library.read(path);
      return bytes && new TextDecoder().decode(bytes);
    };
    const configPath = `${dir}animation.cfg`;
    const configText = text(configPath);
    const config =
      configText === undefined
        ? null
        : parseAnimationConfig(configText, configPath, (message) => console.warn(message));
    if (!config) throw new Error(`${model}: no usable ${configPath}`);
    const skins = PLAYER_PARTS.map((part) => {
      const path = part === 'head' ? `${headDir}head_${head.skin}.skin` : `${dir}${part}_${skin}.skin`;
      const skinText = text(path);
      if (skinText === undefined) throw new Error(`${model}/${skin}: no ${path}`);
      return parseSkin(skinText);
    });
    const models: PlayerModels = {
      lower: library.model(`${dir}lower.md3`),
      upper: library.model(`${dir}upper.md3`),
      head: library.model(`${headDir}head.md3`)
    };

    const scope = cache.scope();
    const root = new Entity(`player-${model}-${skin}`);
    applyQuakeTransform(root);
    try {
      const animated: SkinStage[] = [];
      const build = async (name: string, part: Md3Model, pairs: readonly SkinSurface[]) => {
        // Surface names are lowercased on both sides (`tr_mesh.c:362–368`).
        const built = await buildStagedModel(
          app,
          library,
          scope,
          name,
          part,
          (surface) => pairs.find((pair) => pair.surface === surface.name)?.shader ?? '',
          bodyPlacement(options),
          animated
        );
        root.addChild(built.entity);
        return built;
      };
      const parts = {
        legs: await build('legs', models.lower, skins[0]),
        torso: await build('torso', models.upper, skins[1]),
        head: await build('head', models.head, skins[2])
      };
      app.root.addChild(root);
      return new PlayerRig(
        app, library, scope, options, root, model, skin, config, models, parts, animated
      );
    } catch (error) {
      root.destroy();
      scope.dispose();
      throw error;
    }
  }

  /** How many materials this body owns, for the memory readout. */
  get materialCount(): number {
    return this.scope.materialCount;
  }

  /** The torso's frames as the last update left them, for the view weapon; `null` before any. */
  get torsoFrames(): FrameBlend | null {
    return this.torso;
  }

  /**
   * Where a beam from this body starts: its weapon's `tag_flash` as last drawn, in Quake units
   * (`cg_weapons.c:1334–1340`); `null` with no weapon drawn.
   */
  muzzleOrigin(): Vec3 | null {
    return this.muzzle;
  }

  /**
   * Bring the body into view afresh on its next update, facing where it looks with its frames
   * cleared, as `CG_ResetPlayerEntity` does after a respawn's teleport.
   */
  reset(): void {
    this.lastTime = null;
  }

  /**
   * Forget every clock the body was run on, as the match goes or as another entity is to take it:
   * the next match's clock starts again, and the next entity's `centity_t` is not the last one's.
   */
  clear(): void {
    this.reset();
    this.trailTime = 0;
    this.torso = null;
    this.muzzle = null;
  }

  /**
   * Draw this frame: {@link pose}, then {@link draw}.
   *
   * @returns where this body's haste puff goes this frame, or `null` while it leaves none.
   */
  update(state: PlayerRigState): Vec3 | null {
    const puff = this.pose(state);
    this.draw();
    return puff;
  }

  /** The legs' yaw as the last {@link pose} turned them (`pe.legs.yawAngle`), for the shadow. */
  get legsYaw(): number {
    return this.animation.legs.yawAngle;
  }

  /**
   * Place this frame: `CG_PlayerAngles`, then `CG_PlayerAnimation`, then the parts on their tags
   * and the weapon on the torso, its flash on the weapon (`cg_players.c:2292–2590`,
   * `cg_weapons.c:1198–1347`). Nothing is lit or drawn until {@link draw}, as Q3's renderer lights
   * nothing until cgame has added every light, the flash's among them ({@link flashDlight}).
   *
   * @returns where this body's haste puff goes this frame, or `null` while it leaves none
   *   (`CG_HasteTrail`; the caller draws it as a world effect).
   */
  pose(state: PlayerRigState): Vec3 | null {
    this.posed = null;
    if (this.destroyed) return null;
    const time = Math.floor(state.time);
    // The first frame is the body coming into view, and `CG_ResetPlayerEntity` faces its parts
    // where it looks, so it does not shuffle round from facing nowhere (`cg_players.c:2606–2634`).
    if (this.lastTime === null) Object.assign(this.animation, createPlayerEntity(state.angles));
    const frametime = this.lastTime === null ? 0 : time - this.lastTime;
    this.lastTime = time;
    this.animation.painTime = state.painTime ?? Number.NEGATIVE_INFINITY;
    this.animation.painDirection = state.painDirection ?? 0;

    const powerups = state.powerups ?? 0;
    const haste = (powerups & (1 << PW.HASTE)) !== 0;
    const axes = playerAngles(this.animation, this.config, {
      angles: state.angles,
      legsAnim: state.legsAnim,
      torsoAnim: state.torsoAnim,
      movementDir: state.movementDir,
      dead: state.dead,
      velocity: state.velocity,
      time,
      frametime
    });
    const frames = playerAnimation(
      this.animation,
      this.config.animations,
      state.legsAnim,
      state.torsoAnim,
      time,
      // Haste plays both parts half again as fast (`cg_players.c:1251–1270`).
      haste ? 1.5 : 1
    );
    this.torso = frames.torso;
    void this.selectWeapon(state.weapon);

    // The trail is laid whether or not the body is drawn: `CG_Player` runs its powerups for the
    // player's own body in first person too.
    let puff: Vec3 | null = null;
    if (haste) {
      const trail = hasteTrailPuff(
        this.animation.legs.animationNumber,
        this.trailTime,
        time,
        state.origin
      );
      this.trailTime = trail.trailTime;
      puff = trail.puff;
    }

    // Q3 runs its own player's animation every frame, but draws it only in third person.
    this.root.enabled = !state.hidden;
    if (state.hidden) {
      this.muzzle = null;
      return puff;
    }

    const { origin } = state;
    const pose = posePlayer(this.models, [origin.x, origin.y, origin.z], axes, frames);
    const passes = bodyPasses(powerups, state.team ?? TEAM.FREE, time);
    const weapon = this.weapon;
    const held = weapon && this.poseWeapon(weapon, pose.torso, state, time);
    if (!held) this.muzzle = null;
    this.posed = { state, time, powerups, pose, passes, held };
    return puff;
  }

  /**
   * The light this body's flash gives off this frame, as {@link pose} placed it: at the flash,
   * in its weapon's colour, while the flash shows (`cg_weapons.c:1337–1346`); none while it does
   * not, or while the body is not drawn.
   */
  flashDlight(): { origin: Readonly<Vec3>; weapon: WeaponId } | null {
    const held = this.posed?.held;
    return held?.flashing ? { origin: this.muzzle!, weapon: held.weapon.id } : null;
  }

  /**
   * Light and draw the body as {@link pose} placed it this frame: every part with its shells, and
   * the weapon with its own, lit where the body stands.
   */
  draw(): void {
    const posed = this.posed;
    this.posed = null;
    if (!posed || this.destroyed) return;
    const { state, time, powerups, pose, passes } = posed;
    const { origin } = state;

    // A player wearing invisibility is drawn as its shell alone (`cg_players.c:2152–2154`).
    this.parts.legs.entity.enabled = !passes.hidden;
    this.parts.torso.entity.enabled = !passes.hidden;
    this.parts.head.entity.enabled = !passes.hidden;

    // A player's refEntities carry no `shaderTime`, so its stages run on the game clock.
    const seconds = time / 1000;
    // Where the viewer is, for a skin that shines or mirrors.
    const viewer = this.options.camera;
    // Every part, and all it holds, is lit at the player's origin (`RF_LIGHTING_ORIGIN`,
    // `cg_players.c:2310`; `cg_weapons.c:1215`, `1273`, `1311`).
    const light = entityLightAt(origin, this.options.lights ?? NO_WORLD, undefined, this.light);
    const entity = state.entity;
    if (entity !== undefined) {
      this.parts.legs.order.value = entity + PLAYER_PART.legs;
      this.parts.torso.order.value = entity + PLAYER_PART.torso;
      this.parts.head.order.value = entity + PLAYER_PART.head;
    }
    if (!passes.hidden) {
      drawStagedModel(this.parts.legs, pose.legs, seconds, viewer, light);
      drawStagedModel(this.parts.torso, pose.torso, seconds, viewer, light);
      drawStagedModel(this.parts.head, pose.head, seconds, viewer, light);
      playStagedStages(this.animated, seconds);
    }
    // Each part's shells after it, in the order the passes are drawn.
    const part = (first: number, shell: number) =>
      entity === undefined ? undefined : entity + first + 1 + shell;
    passes.shaders.forEach((shader, i) => {
      const shell = (piece: 'legs' | 'torso' | 'head', model: Md3Model, posed: PosedModel) => {
        const entity = part(PLAYER_PART[piece], i);
        this.drawShell(this.shells, shader, piece, model, posed, seconds, light, entity);
      };
      shell('legs', this.models.lower, pose.legs);
      shell('torso', this.models.upper, pose.torso);
      shell('head', this.models.head, pose.head);
    });
    this.shells.hideUnshown();

    if (posed.held) this.drawWeapon(posed.held, state, time, powerups, light);
  }

  /** A cache for this body's shells, or its gun's. */
  private shellCache(): ShellCache {
    return new ShellCache('player', (key, shader, model) => this.buildShell(key, shader, model));
  }

  /**
   * Draw one piece again with a powerup's shader, building the shell the first time it is asked
   * for; a shell still building shows from the frame it lands.
   *
   * @param cache - Whose shells: the body's own, or the held weapon's.
   * @param light - The body's light, in the world's frame.
   * @param entity - Its entity's number in a map's scene; left as it was when absent.
   */
  private drawShell(
    cache: ShellCache,
    shader: string,
    piece: string,
    model: Md3Model,
    pose: Placement & FrameBlend,
    seconds: number,
    light: EntityLight,
    entity?: number
  ): void {
    const shell = cache.show(shader, piece, model);
    if (!shell) return;
    if (entity !== undefined) shell.model.order.value = entity;
    drawStagedModel(shell.model, pose, seconds, this.options.camera, light);
    playStagedStages(shell.stages, seconds);
  }

  /** Build one shell: the model again, every surface of it under the powerup's shader. */
  private async buildShell(key: string, shader: string, model: Md3Model): Promise<Shell> {
    const stages: SkinStage[] = [];
    const built = await buildStagedModel(
      this.app,
      this.library,
      this.scope,
      key,
      model,
      () => shader,
      // A shell's stages write no depth: the blended layers, as the body's own are. Its every
      // surface draws the refEntity's `customShader`.
      { ...bodyPlacement(this.options, shader), layers: undefined },
      stages
    );
    built.entity.enabled = false;
    this.root.addChild(built.entity);
    return { model: built, stages };
  }

  /**
   * The body, for the warm-up (`warm-up.ts`): its parts, every weapon built for it, and a shell of
   * each powerup a body can wear, played on the game clock. A shell's shader is the powerup's
   * whatever part it covers, so the shells are built on the legs alone, and kept.
   *
   * @param shells - Whether this body is the one to build the shells on; one body's serve all.
   */
  async warm(shells = true): Promise<Warmed> {
    if (shells) await this.shells.prepare(BODY_SHELL_SHADERS, 'legs', this.models.lower);
    const weapons: HeldWeapon[] = [];
    for (const built of await Promise.allSettled(this.weapons.values())) {
      if (built.status === 'fulfilled' && built.value) weapons.push(built.value);
    }
    let hide: (() => void) | null = null;
    return {
      at: (seconds) => {
        if (this.destroyed) return;
        hide ??= showHidden(this.root);
        playStagedStages(this.animated, seconds);
        for (const shell of this.shells.built()) playStagedStages(shell.stages, seconds);
        for (const weapon of weapons) {
          playStagedStages(weapon.stages, seconds);
          for (const stage of weapon.flashStages) playStage(stage.material, stage, seconds);
          if (weapon.flash) playMd3(weapon.flash, seconds);
          for (const shell of weapon.shells.built()) playStagedStages(shell.stages, seconds);
        }
      },
      end: () => {
        hide?.();
        hide = null;
      }
    };
  }

  /**
   * @returns once every shell and weapon still building has landed, its own shells included
   */
  async settled(): Promise<void> {
    await this.shells.settled();
    const weapons = await Promise.allSettled(this.weapons.values());
    for (const weapon of weapons) {
      if (weapon.status === 'fulfilled' && weapon.value) await weapon.value.shells.settled();
    }
  }

  /**
   * Put a weapon in the body's hand, building it on first use, as `CG_RegisterWeapon` does. Safe
   * to call every frame; if the weapon changes again while one is building, the last asked for
   * wins.
   *
   * @returns once the weapon asked for is in hand, or will not be
   */
  selectWeapon(id: WeaponId): Promise<void> {
    if (this.requestedWeapon === id) return this.selecting;
    this.requestedWeapon = id;
    if (this.weapon) this.showWeapon(this.weapon, false);
    this.weapon = null;
    if (id === WP.NONE) return (this.selecting = Promise.resolve());

    let pending = this.weapons.get(id);
    if (!pending) {
      pending = this.buildWeapon(id).catch((error: unknown) => {
        console.warn(`player: no world model for weapon ${id}`, error);
        return null;
      });
      this.weapons.set(id, pending);
    }
    this.selecting = pending.then((weapon) => {
      if (this.destroyed || this.requestedWeapon !== id || !weapon) return;
      this.showWeapon(weapon, true);
      this.weapon = weapon;
    });
    return this.selecting;
  }

  /**
   * Build a weapon's world model: the gun and its barrel as the view weapon draws them, every stage
   * of their shaders as the skin draws its own, and its flash with every stage of its own.
   */
  private async buildWeapon(id: WeaponId): Promise<HeldWeapon | null> {
    const asset = WEAPON_ASSETS.find((candidate) => candidate.id === id);
    if (!asset) return null;
    const path = weaponModelPath(asset.dir);
    if (!this.library.read(path)) return null;

    const { app, library, scope } = this;
    const layers = bodyPlacement(this.options);
    const pieces: Entity[] = [];
    const played: SkinStage[] = [];
    const stagedPiece = async (piecePath: string) => {
      const built = await buildStagedModel(
        app,
        library,
        scope,
        piecePath,
        library.model(piecePath),
        ownShader,
        layers,
        played
      );
      this.root.addChild(built.entity);
      pieces.push(built.entity);
      return built;
    };
    const gun = await stagedPiece(path);
    const barrelPath = weaponModelPath(asset.dir, '_barrel');
    const barrel = asset.hasBarrel && library.read(barrelPath) ? await stagedPiece(barrelPath) : null;

    let flash: Md3Renderable | null = null;
    const flashStages: EffectStage[] = [];
    const flashPath = weaponModelPath(asset.dir, '_flash');
    if (library.read(flashPath)) {
      flash = await createMd3Entity(app, library, flashPath, {
        ...layers,
        scope,
        stages: async (name) => {
          if (!findShader(library.shaders, name)) return null;
          const stages = await createEffectStages(app, library, name, scope);
          flashStages.push(...stages.filter((stage) => isAnimated(stage) || takesEntityColor(stage)));
          return stages;
        }
      });
      this.root.addChild(flash.entity);
      pieces.push(flash.entity);
    }

    for (const piece of pieces) piece.enabled = false;
    return {
      id,
      gun,
      barrel,
      stages: played,
      flash,
      flashStages,
      spin: null,
      shells: this.shellCache()
    };
  }

  private showWeapon(weapon: HeldWeapon, shown: boolean): void {
    weapon.gun.entity.enabled = shown;
    if (weapon.barrel) weapon.barrel.entity.enabled = shown;
    if (shown) return;
    // The flash shows only when a shot says so, and the shells only while a powerup does. The
    // shells hang on the root rather than the gun, so they are not hidden with it.
    if (weapon.flash) weapon.flash.entity.enabled = false;
    weapon.shells.hide();
  }

  /**
   * Hang the weapon on the torso, spin its barrel and place its flash, as `CG_AddPlayerWeapon` does
   * for a body seen from outside (`cg_weapons.c:1198–1347`).
   */
  private poseWeapon(
    weapon: HeldWeapon,
    torso: PosedModel,
    state: PlayerRigState,
    time: number
  ): HeldPose {
    let barrelRoll: number | null = null;
    if (weapon.barrel) {
      weapon.spin ??= createBarrelSpin(time);
      barrelRoll = spinBarrel(weapon.spin, time, state.firing);
    }
    const flashing =
      weapon.flash !== null && flashVisible(weapon.id, state.firing, time - state.lastFireTime);
    // Placed on `tag_flash` whether it shows or not, for where this body's beams start.
    const flashRoll = flashing ? (Math.random() * 2 - 1) * FLASH_ROLL_DEGREES : 0;
    const pose = poseWeapon(torso, weapon.gun.model, barrelRoll, flashRoll);
    const flash = pose.flash!;
    this.muzzle = { x: flash.origin[0], y: flash.origin[1], z: flash.origin[2] };
    return { weapon, pose, flashing };
  }

  /**
   * Draw the weapon as {@link poseWeapon} placed it, with the shells a powerup draws over it
   * (`CG_AddWeaponWithPowerups`), lit as the body is.
   */
  private drawWeapon(
    { weapon, pose, flashing }: HeldPose,
    state: PlayerRigState,
    time: number,
    powerups: number,
    light: EntityLight
  ): void {
    const flash = pose.flash!;

    // On the game clock, as the body's stages are, and in the colour Q3 gives the gun: the
    // railgun's `color1`, coming back after a shot (`cg_weapons.c:1219–1232`).
    const seconds = time / 1000;
    const viewer = this.options.camera;
    // An invisible player's gun is drawn as its shell alone (`cg_weapons.c:1171–1173`).
    const gunShown = !invisible(powerups);
    weapon.gun.entity.enabled = gunShown;
    if (weapon.barrel) weapon.barrel.entity.enabled = gunShown;
    if (gunShown) {
      drawStagedModel(weapon.gun, pose.gun, seconds, viewer, light);
      // The barrel's refEntity is cleared, so it shows frame 0.
      if (weapon.barrel && pose.barrel) {
        drawStagedModel(weapon.barrel, { ...pose.barrel, ...FIRST_FRAME }, seconds, viewer, light);
      }
      const railFireTime = state.railFireTime ?? Number.NEGATIVE_INFINITY;
      const glow = state.color && gunColor(weapon.id, state.color, time, railFireTime);
      playStagedStages(weapon.stages, seconds, glow);
    }
    const entity = state.entity;
    const part = (first: number, shell: number) =>
      entity === undefined ? undefined : entity + first + 1 + shell;
    if (entity !== undefined) {
      weapon.gun.order.value = entity + PLAYER_PART.gun;
      if (weapon.barrel) weapon.barrel.order.value = entity + PLAYER_PART.barrel;
      if (weapon.flash) weapon.flash.order.value = entity + PLAYER_PART.flash;
    }
    weaponPasses(powerups).forEach((shader, i) => {
      const gun = part(PLAYER_PART.gun, i);
      this.drawShell(weapon.shells, shader, 'gun', weapon.gun.model, pose.gun, seconds, light, gun);
      if (weapon.barrel && pose.barrel) {
        this.drawShell(
          weapon.shells,
          shader,
          'barrel',
          weapon.barrel.model,
          // The barrel's refEntity is cleared, so it shows frame 0.
          { ...pose.barrel, ...FIRST_FRAME },
          seconds,
          light,
          part(PLAYER_PART.barrel, i)
        );
      }
    });
    weapon.shells.hideUnshown();
    if (weapon.flash) {
      weapon.flash.entity.enabled = flashing;
      if (flashing) {
        place(weapon.flash.entity, flash);
        shadeMd3(weapon.flash, lightInEntityFrame(flash.axis, light, this.flashLight));
        playMd3(weapon.flash, seconds);
        // The railgun's is coloured with `color1` (`cg_weapons.c:1324–1332`).
        const color = state.color && flashColor(weapon.id, state.color);
        for (const stage of weapon.flashStages) {
          const tint = color && takesEntityColor(stage) ? { color } : undefined;
          playStage(stage.material, stage, time / 1000, tint);
        }
      }
    }
    const camera = this.options.camera;
    if (camera && weapon.flash) faceMd3(weapon.flash, camera);
  }

  /**
   * Take the body out of the world and give back everything it holds: its meshes, its materials,
   * and its counts on the textures.
   *
   * @returns once a weapon still building has landed and gone too
   */
  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    this.root.enabled = false;
    await Promise.allSettled(this.weapons.values());
    // Meshes go with their last instance; then nothing draws with the materials.
    this.root.destroy();
    this.scope.dispose();
  }
}
