import { Entity, Layer, Mat4, Quat, type AppBase, type CameraComponent } from 'playcanvas';

import { UNITS_PER_METRE, worldToSim } from '../coords';
import type { Vec3 as Vec3Sim } from '../sim/vec3';
import { findTag, lerpTag } from '../formats/md3';
import { findShader } from '../formats/shader-script';
import { WEAPON_ASSETS, weaponModelPath } from '../formats/asset-manifest';
import type { AssetLibrary } from '../formats/asset-library';
import { DEFAULT_SETTINGS } from '../settings/registry';
import { WP, type WeaponId } from '../sim/weapons/constants';
import {
  NO_WORLD,
  keptEntityLight,
  type KeptEntityLight,
  type LightingScene
} from '../view/entity-light';
import { handPose } from '../view/hand-pose';
import { VIEW_WEAPON_PART, viewWeaponEntity } from '../view/scene-sort';
import { colorFromString, flashColor, gunColor, type Rgb } from '../view/player-color';
import { WEAPON_SHELL_SHADERS, invisible, weaponPasses } from '../view/powerup-passes';
import {
  createBarrelSpin,
  flashVisible,
  spinBarrel,
  viewmodelFovOffset,
  viewmodelLandOffset,
  viewmodelSway,
  type BarrelSpin,
  type ViewmodelFrames
} from '../view/viewmodel';
import {
  createEffectStages,
  isAnimated,
  playStage,
  takesEntityColor,
  type EffectStage
} from './effect-material';
import { createMd3Entity, faceMd3, playMd3, shadeMd3, type Md3Renderable } from './md3-mesh';
import type { SceneDraws } from './scene-draws';
import { ShellCache } from './shell-cache';
import type { SkinStage } from './skin-material';
import {
  FIRST_FRAME,
  buildStagedModel,
  drawOwnSurfaces,
  drawPlacedModel,
  lightAtEntity,
  lightInEntity,
  ownShader,
  playStagedStages,
  tagRotation,
  type StagedModel
} from './staged-model';
import { showHidden, type Warmed } from './warm-up';

/**
 * The first-person weapon rig.
 *
 * Quake 3 does not place the gun at an artist-chosen screen offset. `cg_gun_x/y/z` all
 * default to zero, and the entire visual placement comes from the hand rig's `tag_weapon`
 * (`CG_AddViewWeapon` → `CG_PositionEntityOnTag`). For the rocket launcher that tag sits at
 * `(-10.36, -4.72, -9.31)` — **behind**, right of and below the eye, so the barrel reaches
 * forward past the camera rather than the breech sitting in the lens.
 *
 * Getting that wrong is not subtle: a hand-guessed offset in front of the camera put the
 * weapon's back end filling half the screen.
 *
 * Everything under {@link ViewmodelRig.root} stays in **Quake units, Z-up**, so tag offsets
 * are used exactly as the models store them. The root alone carries the basis change and
 * the 32 u/m scale.
 */

/**
 * Rotation taking Quake's frame to the camera's local frame.
 *
 * Quake forward (+X) becomes the camera's -Z, Quake left (+Y) becomes -X, Quake up (+Z)
 * becomes +Y. Built as an explicit basis matrix rather than guessed euler angles, because
 * euler order is exactly the kind of thing that produces a weapon pointing sideways.
 */
function quakeToCameraRotation(): Quat {
  const matrix = new Mat4();
  // Column-major: each column is where a Quake basis vector lands in camera space.
  matrix.set([
    0, 0, -1, 0, // +X_quake (forward) -> -Z camera
    -1, 0, 0, 0, // +Y_quake (left)    -> -X camera
    0, 1, 0, 0, // +Z_quake (up)      -> +Y camera
    0, 0, 0, 1
  ]);
  return new Quat().setFromMat4(matrix);
}

/** State the rig needs each frame; all of it already exists in the simulation. */
export interface ViewmodelInput {
  weapon: WeaponId;
  /**
   * The hand rig's frames, taken from the player's own torso (`handFrames`): the chosen
   * model's `animation.cfg` times the drop, the raise and the recoil.
   */
  hand: ViewmodelFrames;
  /** Horizontal speed in units per second. */
  xyspeed: number;
  bobCycle: number;
  /**
   * The view's pitch, yaw and roll in degrees, as the camera was placed from them, the run and
   * bob tilts included (`cg.refdefViewAngles`). Q3 adds the sway to these.
   */
  viewAngles: Readonly<Vec3Sim>;
  /** Depth of the camera's current landing dip, negative, in units (`cg.landChange`). */
  landChange: number;
  /** When that dip started, on {@link ViewmodelInput.time}'s clock (`cg.landTime`). */
  landTime: number;
  /** Absolute time in milliseconds. */
  time: number;
  /** Absolute time of the last shot, in milliseconds. */
  lastFireTime: number;
  /** Absolute time of the railgun's last shot, in milliseconds, for its glow's return. */
  railFireTime: number;
  /** `EF_FIRING`: attack held, with ammo. */
  firing: boolean;
  /**
   * `cg.predictedPlayerEntity.currentState.powerups`: the mask of the powerups the player holds,
   * which dress the gun and its barrel in their shells (`cg_weapons.c:1268, 1285`).
   */
  powerups: number;
  /**
   * The eye's horizontal angle on the screen, in degrees, as `cg_fov` gives it: the gun drops for
   * a wide one (`cg_weapons.c:1398–1401`), and no warp under water moves it.
   */
  fov: number;
}

/** The assembled entities for one weapon. */
interface WeaponEntities {
  /** The gun and its barrel, drawing every stage of their shaders as a skin draws its own. */
  gun: StagedModel;
  barrel: StagedModel | null;
  /**
   * The gun's and the barrel's stages played every frame: those that animate, on the game clock,
   * and those that take the entity's colour, as the railgun's glow takes `color1`.
   */
  stages: SkinStage[];
  /**
   * The flash, its lit surfaces re-shaded every frame and its `deformVertexes autosprite`
   * surfaces turned at the camera.
   */
  flash: Md3Renderable | null;
  /** `tag_flash`'s own rotation, kept so the random roll can be composed onto it. */
  flashTag: Quat;
  /**
   * The flash's stages played while it shows: those that animate, on the game clock, as the
   * BFG's turns two ways and the gauntlet's flickers, and those that take the entity's
   * colour, as the railgun's takes `color1`.
   */
  flashStages: EffectStage[];
  /** `tag_barrel`'s own rotation, kept so the spin can be composed onto it each frame. */
  barrelTag: Quat | null;
  /** Spin state, created on the first frame this weapon is drawn. */
  spin: BarrelSpin | null;
  /**
   * The gun's and the barrel's shells, built on first use, each hung under the piece it covers so
   * the tag, the spin and the sway carry it.
   */
  shells: ShellCache;
}

/**
 * Depth bounds for the viewmodel camera, in metres.
 *
 * Everything the rig draws lives within about a metre of the eye, so the range is closed
 * right down around it. That is free depth precision — near and far change how depth is
 * distributed, not how anything looks — and it is the nearest equivalent to what Q3's
 * `RF_DEPTHHACK` buys with `glDepthRange(0, 0.3)`.
 */
const VIEWMODEL_NEAR_CLIP = 0.01;
const VIEWMODEL_FAR_CLIP = 4;

/** The gun's and the barrel's parts of the view weapon, in the order it adds them. */
const PIECE_PARTS = [VIEW_WEAPON_PART.gun, VIEW_WEAPON_PART.barrel];

/** Muzzle flash roll, `crandom() * 10` — `CG_AddPlayerWeapon`. */
const FLASH_ROLL_DEGREES = 10;

/** Scratch for the barrel spin and the flash roll. */
const rollRotation = new Quat();
const composedRotation = new Quat();

/**
 * Builds and drives the first-person weapon.
 *
 * One instance for the session; {@link ViewmodelRig.select} swaps which weapon is shown.
 */
export class ViewmodelRig {
  /** Quake-space root, parented to the camera. */
  readonly root: Entity;
  private readonly app: AppBase;
  private readonly library: AssetLibrary;
  /**
   * Built weapons, kept so a switch does not rebuild meshes and textures.
   *
   * Keyed to the **promise**, not the result: building is asynchronous and a switch can be
   * asked for on any frame, so an in-flight build has to be as cacheable as a finished one.
   * Otherwise scrolling the wheel quickly builds the same weapon several times over.
   */
  private readonly built = new Map<WeaponId, Promise<WeaponEntities>>();
  private current: WeaponEntities | null = null;
  private currentId: WeaponId | null = null;
  /** Most recent {@link select} argument, recorded before awaiting anything. */
  private requestedId: WeaponId | null = null;
  /** The hand, under the root: where Q3 puts it relative to the view, sway and all. */
  private readonly hand: Entity;
  /** The rig's own layer; nothing else draws into it. */
  private readonly layer: Layer;
  /** Second camera drawing that layer over the world. */
  private readonly viewCamera: Entity;
  /** The camera the rig hangs off, whose fov it follows. */
  private readonly eye: CameraComponent;
  /** The scene's light; a scene with no world when absent. */
  private readonly lights: LightingScene | undefined;
  /**
   * A piece's light where it stands, then each piece's in its own frame: the gun's, the barrel's
   * and the flash's.
   */
  private readonly standing = keptEntityLight();
  private readonly pieceLights = [keptEntityLight(), keptEntityLight()];
  private readonly flashLight = keptEntityLight();
  /** The player's effects colour, `color1`, which the railgun's flash takes. */
  playerColor: Rgb = colorFromString(DEFAULT_SETTINGS.color1);
  /** This frame's input, as {@link pose} placed the gun by it, until it is drawn. */
  private posedInput: ViewmodelInput | null = null;
  /** Whether the flash shows this frame, as {@link pose} placed it. */
  private flashing = false;
  /** The scene the gun is placed in, where a map's world is drawn. */
  private readonly scene: SceneDraws | undefined;

  /**
   * @param app - The running app.
   * @param library - Extracted weapon assets.
   * @param camera - Camera entity the rig hangs off.
   */
  /**
   * @param lights - The scene's light, which lights the gun where it is.
   * @param scene - The scene the gun is placed in, where a map's world is drawn: there it draws
   *   among the world's shaders, its depth squeezed into the range's front 30% as `RF_DEPTHHACK`
   *   squeezes it (`Q3_DEPTH_HACK`), and its own layer and camera stand empty.
   */
  constructor(
    app: AppBase,
    library: AssetLibrary,
    camera: Entity,
    lights?: LightingScene,
    scene?: SceneDraws
  ) {
    this.app = app;
    this.library = library;
    this.eye = camera.camera!;
    this.lights = lights;
    this.scene = scene;

    // `RF_DEPTHHACK` where there is no map's scene to squeeze the gun's depth in. Q3 compresses
    // the viewmodel into the front 30% of the depth range so the gun cannot poke through a wall
    // while still occluding itself correctly. Over a splat the equivalent is a second camera over
    // a layer of its own, clearing depth but not colour: the gun gets a private depth buffer,
    // drawn last, over a world it can never intersect.
    this.layer = new Layer({ name: 'viewmodel' });
    app.scene.layers.push(this.layer);
    scene?.keepOwn('gun', [this.layer]);

    this.viewCamera = new Entity('viewmodel-camera');
    this.viewCamera.addComponent('camera', {
      layers: [this.layer.id],
      clearColorBuffer: false,
      clearDepthBuffer: true,
      // Cameras render in ascending priority, so this one has to come after the world's.
      priority: this.eye.priority + 1,
      nearClip: VIEWMODEL_NEAR_CLIP,
      farClip: VIEWMODEL_FAR_CLIP
    });
    // A child of the eye, not of the hand: Q3 sways the gun, never the view.
    camera.addChild(this.viewCamera);

    this.root = new Entity('viewmodel-root');
    this.root.setLocalRotation(quakeToCameraRotation());
    const scale = 1 / UNITS_PER_METRE;
    this.root.setLocalScale(scale, scale, scale);
    camera.addChild(this.root);

    this.hand = new Entity('viewmodel-hand');
    this.root.addChild(this.hand);
  }

  /**
   * Whether the view weapon is drawn. Not in third person, where Q3 adds no view weapon at all
   * (`cg_weapons.c:1372–1376`).
   */
  get visible(): boolean {
    return this.root.enabled;
  }

  set visible(shown: boolean) {
    this.root.enabled = shown;
    this.viewCamera.enabled = shown && !this.scene?.inScene;
  }

  /**
   * Show a weapon, building its entities on first use.
   *
   * The hand rig is loaded but never drawn — it has no geometry. It is read for
   * `tag_weapon` only.
   *
   * Safe to call every frame: repeat requests for the weapon already asked for return
   * immediately, and if the player switches again while a model is still loading, the last
   * request wins rather than the last build to finish.
   */
  async select(weapon: WeaponId): Promise<void> {
    if (this.requestedId === weapon) return;
    this.requestedId = weapon;

    // A dead player's hand is empty: Q3 registers no model for `WP_NONE`, so nothing is drawn.
    if (weapon === WP.NONE) {
      if (this.current) this.current.gun.entity.enabled = false;
      this.current = null;
      this.currentId = null;
      return;
    }

    const entities = await this.entities(weapon);

    // Superseded while loading: leave it built and hidden for next time.
    if (this.requestedId !== weapon) return;

    if (this.current && this.current !== entities) this.current.gun.entity.enabled = false;
    entities.gun.entity.enabled = true;
    this.current = entities;
    this.currentId = weapon;
  }

  /**
   * Build a weapon ahead of its first use, hidden, as `CG_RegisterGraphics` registers every weapon
   * a level holds before it is played (`cg_main.c:1017–1022`). The first switch to it shows it at
   * once.
   */
  async load(weapon: WeaponId): Promise<void> {
    await this.entities(weapon);
  }

  /** A weapon's entities, built on first asking, and kept. */
  private entities(weapon: WeaponId): Promise<WeaponEntities> {
    let pending = this.built.get(weapon);
    if (!pending) {
      pending = this.build(weapon);
      this.built.set(weapon, pending);
    }
    return pending;
  }

  /** Build one weapon's entities and hang them off the rig. */
  private async build(weapon: WeaponId): Promise<WeaponEntities> {
    const asset = WEAPON_ASSETS.find((candidate) => candidate.id === weapon);
    if (!asset) throw new Error(`viewmodel: no assets for weapon ${weapon}`);

    const layers = {
      layers: [this.layer.id],
      ...(this.scene ? { scene: { draws: this.scene, group: 'gun' as const } } : {})
    };
    // The gun and its barrel draw every stage of their shaders, as a skin does. Kept for the
    // session, they belong to no scope.
    const played: SkinStage[] = [];
    const staged = (path: string) =>
      buildStagedModel(
        this.app,
        this.library,
        undefined,
        path,
        this.library.model(path),
        ownShader,
        layers,
        played
      );
    const gun = await staged(weaponModelPath(asset.dir));
    const entity = gun.entity;
    // Hidden until `select` decides this is still the weapon wanted — a build that finished
    // after the player switched away must not appear.
    entity.enabled = false;
    this.hand.addChild(entity);

    // The muzzle flash hangs off the weapon's own `tag_flash`, so it tracks the barrel.
    let flash: Md3Renderable | null = null;
    let flashTag = new Quat();
    const flashStages: EffectStage[] = [];
    const flashPath = weaponModelPath(asset.dir, '_flash');
    if (this.library.read(flashPath)) {
      // Every stage of the flash's shader.
      flash = await createMd3Entity(this.app, this.library, flashPath, {
        ...layers,
        stages: async (name) => {
          if (!findShader(this.library.shaders, name)) return null;
          const stages = await createEffectStages(this.app, this.library, name);
          flashStages.push(...stages.filter((stage) => isAnimated(stage) || takesEntityColor(stage)));
          return stages;
        }
      });
      const tag = findTag(gun.model, 'tag_flash');
      if (tag) {
        flash.entity.setLocalPosition(tag.origin[0], tag.origin[1], tag.origin[2]);
        flashTag = tagRotation(tag);
        flash.entity.setLocalRotation(flashTag);
      }
      flash.entity.enabled = false;
      entity.addChild(flash.entity);
    }

    let barrel: StagedModel | null = null;
    let barrelTag: Quat | null = null;
    if (asset.hasBarrel) {
      barrel = await staged(weaponModelPath(asset.dir, '_barrel'));
      const tag = findTag(gun.model, 'tag_barrel');
      if (tag) {
        barrel.entity.setLocalPosition(tag.origin[0], tag.origin[1], tag.origin[2]);
        barrelTag = tagRotation(tag);
        barrel.entity.setLocalRotation(barrelTag);
      }
      entity.addChild(barrel.entity);
    }

    // A powerup's shell is the gun or the barrel again under its shader, in the rig's own layer,
    // hung under the piece it covers at no offset. Kept for the session, as the gun is.
    const pieces = new Map<string, Entity>([['gun', entity]]);
    if (barrel) pieces.set('barrel', barrel.entity);
    const shells = new ShellCache('viewmodel', async (key, shader, model, piece) => {
      const shellStages: SkinStage[] = [];
      // Every surface in the refEntity's `customShader`.
      const scene = layers.scene && { ...layers.scene, customShader: shader };
      const built = await buildStagedModel(
        this.app,
        this.library,
        undefined,
        key,
        model,
        () => shader,
        { ...layers, ...(scene ? { scene } : {}) },
        shellStages
      );
      built.entity.enabled = false;
      pieces.get(piece)!.addChild(built.entity);
      return { model: built, stages: shellStages };
    });

    return {
      gun,
      barrel,
      stages: played,
      flash,
      flashTag,
      flashStages,
      barrelTag,
      spin: null,
      shells
    };
  }

  /**
   * Draw the gun and its barrel where they now sit, each lit where it is and as it is turned, and
   * mirroring by where the eye is. The hand gives them no lighting origin (`cg_weapons.c:1433`),
   * so each takes the scene's dynamic lights at its own origin, where a body's weapon takes them
   * at the body's. `CG_AddPlayerWeapon` gives the gun no `shaderTime`, so its
   * stages play on the game clock, and `rgbGen entity` takes the colour it gives the gun
   * (`cg_weapons.c:1219–1232`). Then each shell a powerup draws over them
   * (`CG_AddWeaponWithPowerups`, `cg_weapons.c:1169–1186`): an invisible player's gun and barrel
   * are drawn as their shells alone.
   */
  private drawPieces(current: WeaponEntities, weapon: WeaponId, input: ViewmodelInput): void {
    const seconds = input.time / 1000;
    const eye = this.eye.entity;
    const parts: [string, StagedModel][] = [['gun', current.gun]];
    if (current.barrel) parts.push(['barrel', current.barrel]);

    const shown = !invisible(input.powerups);
    const lit = this.pieceLights;
    for (let k = 0; k < parts.length; k++) {
      const part = parts[k][1];
      part.order.value = viewWeaponEntity(PIECE_PARTS[k]);
      this.lightOf(part.entity, lit[k]);
      drawOwnSurfaces(part, shown);
      if (shown) drawPlacedModel(part, FIRST_FRAME, lit[k], seconds, eye);
    }
    if (shown) {
      const color = gunColor(weapon, this.playerColor, input.time, input.railFireTime);
      playStagedStages(current.stages, seconds, color);
    }

    for (const [i, shader] of weaponPasses(input.powerups).entries()) {
      for (let k = 0; k < parts.length; k++) {
        const [piece, part] = parts[k];
        const shell = current.shells.show(shader, piece, part.model);
        if (!shell) continue;
        shell.model.order.value = viewWeaponEntity(PIECE_PARTS[k] + 1 + i);
        // A copy of the piece, where the piece is (`CG_AddWeaponWithPowerups`).
        drawPlacedModel(shell.model, FIRST_FRAME, lit[k], seconds, eye);
        playStagedStages(shell.stages, seconds);
      }
    }
    current.shells.hideUnshown();
  }

  /**
   * Every weapon built, for the warm-up (`warm-up.ts`): each gun, barrel and flash, in the rig's
   * own layer and through its own camera, and a shell of each powerup a gun can wear, played on the
   * game clock. A shell's shader is the powerup's whatever piece it covers, so the shells are built
   * on the first gun alone, and kept.
   */
  async warm(): Promise<Warmed> {
    const weapons: WeaponEntities[] = [];
    for (const pending of this.built.values()) {
      const [built] = await Promise.allSettled([pending]);
      if (built.status === 'fulfilled') weapons.push(built.value);
    }
    const [first] = weapons;
    if (first) await first.shells.prepare(WEAPON_SHELL_SHADERS, 'gun', first.gun.model);
    let hide: (() => void) | null = null;
    return {
      at: (seconds) => {
        if (!hide) {
          const camera = this.viewCamera.enabled;
          this.viewCamera.enabled = true;
          const hidden = showHidden(this.root);
          hide = () => {
            hidden();
            this.viewCamera.enabled = camera;
          };
        }
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

  /** @returns once the shells of every weapon built so far have landed */
  async settled(): Promise<void> {
    for (const pending of this.built.values()) {
      const [entities] = await Promise.allSettled([pending]);
      if (entities.status === 'fulfilled') await entities.value.shells.settled();
    }
  }

  /** Shade the flash for this frame, as {@link draw} shades the gun. */
  private shade(): void {
    const flash = this.current?.flash;
    if (flash) shadeMd3(flash, this.lightOf(flash.entity, this.flashLight));
  }

  /**
   * A piece's light, lit where it is, its direction in its own frame.
   *
   * @param out - Where it is written.
   */
  private lightOf(entity: Entity, out: KeptEntityLight): KeptEntityLight {
    lightAtEntity(entity, this.lights ?? NO_WORLD, this.standing);
    return lightInEntity(entity, this.standing, out);
  }

  /** Place and draw the weapon for this frame: {@link pose}, then {@link draw}. */
  update(input: ViewmodelInput): void {
    this.pose(input);
    this.draw();
  }

  /**
   * The light the flash gives off this frame, as {@link pose} placed it: at the flash, in the
   * weapon's colour, while the flash shows and the gun is drawn (`cg_weapons.c:1337–1346, 1436`).
   */
  flashDlight(): { origin: Readonly<Vec3Sim>; weapon: WeaponId } | null {
    if (!this.posedInput || !this.flashing || !this.visible || this.currentId === null) return null;
    return { origin: this.muzzleOrigin()!, weapon: this.currentId };
  }

  /** Light and draw the weapon as {@link pose} placed it this frame. */
  draw(): void {
    const input = this.posedInput;
    this.posedInput = null;
    if (!input || !this.current || this.currentId === null) return;
    this.drawPieces(this.current, this.currentId, input);
    this.shade();
  }

  /**
   * Place the weapon for this frame; nothing is lit or drawn until {@link draw}.
   *
   * Reproduces `CG_PositionEntityOnTag`: the weapon sits at the hand rig's interpolated
   * `tag_weapon`, in the hand's own frame — which here is the hand node, in Quake units, so the
   * tag origin is used verbatim.
   */
  pose(input: ViewmodelInput): void {
    this.posedInput = null;
    this.flashing = false;
    if (!this.current || this.currentId === null) return;

    const asset = WEAPON_ASSETS.find((candidate) => candidate.id === this.currentId)!;
    const hand = this.library.model(weaponModelPath(asset.dir, '_hand'));

    const frames = input.hand;
    const tag = lerpTag(hand, 'tag_weapon', frames.from, frames.to, frames.frac);
    if (tag) {
      this.current.gun.entity.setLocalPosition(tag.origin[0], tag.origin[1], tag.origin[2]);
      this.current.gun.entity.setLocalRotation(tagRotation(tag));
    }

    // Bob and idle drift, added to the view's own angles, the drop for a wide fov and the gun's
    // own landing dip: the hand goes where Q3 puts it (`handPose`), in the root's Quake frame
    // like the tags under it.
    const sway = viewmodelSway({
      xyspeed: input.xyspeed,
      bobCycle: input.bobCycle,
      time: input.time
    });
    const pose = handPose(
      input.viewAngles,
      sway,
      viewmodelFovOffset(input.fov),
      viewmodelLandOffset(input.landChange, input.time - input.landTime)
    );
    this.hand.setLocalPosition(pose.origin[0], pose.origin[1], pose.origin[2]);
    this.hand.setLocalRotation(tagRotation(pose));

    // The viewmodel camera shares the eye's projection, so a fov change reaches it too, and the
    // warp under water, which Q3's single refdef gives the gun as well.
    const lens = this.viewCamera.camera!;
    lens.fov = this.eye.fov;
    lens.horizontalFov = this.eye.horizontalFov;
    lens.aspectRatioMode = this.eye.aspectRatioMode;
    lens.aspectRatio = this.eye.aspectRatio;

    // `EF_FIRING`, which Q3's continuous flash and spinning barrel both read.
    const firing = input.firing;

    // Spinning barrel — gauntlet, machinegun and BFG are the three that ship one. It rolls
    // about the barrel's own forward axis, which is Quake +X.
    if (this.current.barrel && this.current.barrelTag) {
      this.current.spin ??= createBarrelSpin(input.time);
      const angle = spinBarrel(this.current.spin, input.time, firing);
      rollRotation.setFromEulerAngles(angle, 0, 0);
      // Tag last: the spin happens in the barrel's frame, then the tag places that frame.
      composedRotation.copy(this.current.barrelTag).mul(rollRotation);
      this.current.barrel.entity.setLocalRotation(composedRotation);
    }

    // Muzzle flash: 20 ms one-shot (`MUZZLE_FLASH_TIME`), continuous while a beam weapon is
    // firing.
    if (this.current.flash) {
      const sinceFire = input.time - input.lastFireTime;
      const visible = flashVisible(this.currentId, firing, sinceFire);
      this.flashing = visible;
      this.current.flash.entity.enabled = visible;
      this.current.flash.order.value = viewWeaponEntity(VIEW_WEAPON_PART.flash);
      // Re-rolled every frame it is drawn, as Q3 does, so a continuous flash flickers
      // instead of sitting still.
      if (visible) {
        const roll = (Math.random() * 2 - 1) * FLASH_ROLL_DEGREES;
        rollRotation.setFromEulerAngles(roll, 0, 0);
        composedRotation.copy(this.current.flashTag).mul(rollRotation);
        this.current.flash.entity.setLocalRotation(composedRotation);
        // `CG_AddPlayerWeapon` gives the flash no `shaderTime`, so it plays on the game clock,
        // and colours the railgun's with `color1` (`cg_weapons.c:1324–1332`).
        const color = flashColor(this.currentId, this.playerColor);
        for (const stage of this.current.flashStages) {
          const tint = color && takesEntityColor(stage) ? { color } : undefined;
          playStage(stage.material, stage, input.time / 1000, tint);
        }
        playMd3(this.current.flash, input.time / 1000);
      }
    }

    // After the transforms, so anything derived from them reads this frame's values.
    if (this.current.flash) faceMd3(this.current.flash, this.eye.entity);
    this.posedInput = input;
  }

  /**
   * Where the current weapon's muzzle is, in **simulation** units — the viewmodel's own
   * `tag_flash`, not the simulation's.
   *
   * This is the point Q3 draws a beam from: `CG_AddPlayerWeapon` positions the flash on
   * `tag_flash` and hands that origin to `CG_LightningBolt`. It matters because the
   * simulation's muzzle sits exactly on the view axis, and a camera-facing quad spanning an
   * axis through the eye is edge-on to it — your own beam would be invisible.
   *
   * @returns The muzzle in Quake units, or `null` if no weapon is up yet.
   */
  muzzleOrigin(): Vec3Sim | null {
    const flash = this.current?.flash;
    if (!flash) return null;
    const world = flash.entity.getPosition();
    return worldToSim(world.x, world.y, world.z);
  }

  /**
   * Forget the barrels' spins as the match goes: each starts again on the next match's clock, as
   * a fresh cgame's weapons do.
   */
  clear(): void {
    for (const building of this.built.values()) {
      void building.then(
        (weapon) => (weapon.spin = null),
        () => {}
      );
    }
  }

  /** Remove the rig from the scene. */
  destroy(): void {
    this.root.destroy();
    this.viewCamera.destroy();
    this.app.scene.layers.remove(this.layer);
  }
}

