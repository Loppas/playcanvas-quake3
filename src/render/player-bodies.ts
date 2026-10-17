import type { AppBase } from 'playcanvas';

import type { AnimationConfig } from '../formats/animation-config';
import type { AssetLibrary } from '../formats/asset-library';
import type { PlayerState } from '../net/protocol';
import { STAT } from '../sim/constants';
import { powerupMask } from '../sim/items';
import type { Vec3 } from '../sim/vec3';
import type { WeaponId } from '../sim/weapons/constants';
import type { Rgb } from '../view/player-color';
import type { PlayerLook } from '../view/player-model';
import { predictedEntity } from '../view/scene-sort';
import { IDLE_HAND, handFrames, type ViewmodelFrames } from '../view/viewmodel';
import { PlayerRig, loadLook, type PlayerRigOptions } from './player-rig';
import type { TextureCache } from './texture-cache';
import type { Warmed } from './warm-up';

/**
 * The body the player lives in: `CG_Player` for the player cgame predicts. It runs every frame,
 * but draws only in third person (`RF_THIRD_PERSON`, `cg_players.c:2275–2279`). In first person
 * its torso still plays, because the view weapon's frames follow it. A player state that makes no
 * body — gibbed, spectating, at the intermission — has none to draw either (`ET_INVISIBLE`).
 *
 * It is dressed from the player's own settings, and dressed again behind the pause when they
 * change. Everyone else's bodies, and the corpses the player leaves, are `PlayerEntities`', in
 * the looks the server says each client wears.
 */

/** What the bodies are drawn from this frame. */
export interface PlayerBodiesInput {
  /** The player, as the last tick left them. */
  player: Readonly<PlayerState>;
  /** Where their body is drawn: the origin interpolated between ticks (`lerpOrigin`). */
  origin: Vec3;
  /** When the last pain sound played, and which way the torso twitches for it. */
  pain: { time: number; direction: number };
  /** Whether their body is drawn: third person, and a state that has one. Otherwise it only plays. */
  shown: boolean;
  /** Whether they respawned this frame, which brings the body into view afresh. */
  respawned: boolean;
  /** `EF_FIRING`. */
  firing: boolean;
  /** When the last shot was fired, for the flash. */
  lastFireTime: number;
  /** When the railgun last fired, for its glow's return. */
  railFireTime: number;
  /** Game time in milliseconds. */
  time: number;
  /** The player's effects colour, `color1`, which the railgun's flash and glow take. */
  color?: Rgb;
  /** The player's team, which picks the red quad's shell (`PERS_TEAM`). */
  team?: number;
}

/** The player's own body. */
export class PlayerBodies {
  /** The body the player lives in. */
  readonly own: PlayerRig;
  /** What they wear: `model` and `headmodel`. */
  readonly look: PlayerLook;
  private destroyed = false;

  private constructor(look: PlayerLook, own: PlayerRig) {
    this.look = look;
    this.own = own;
  }

  /**
   * Build the player's own body, its models read first.
   *
   * @throws for a model the install has not got, or one Q3 would fail (`PlayerRig.create`)
   */
  static async create(
    app: AppBase,
    library: AssetLibrary,
    cache: TextureCache,
    look: PlayerLook,
    options: PlayerRigOptions = {}
  ): Promise<PlayerBodies> {
    await loadLook(library, look);
    const own = await PlayerRig.create(
      app,
      library,
      cache,
      look.body.model,
      look.body.skin,
      options,
      look.head
    );
    return new PlayerBodies(look, own);
  }

  /** The model's `animation.cfg`: its footsteps for the sounds, and its rows for the hand. */
  get config(): AnimationConfig {
    return this.own.config;
  }

  /** Draw this frame, and answer with where the player's haste puff goes, if one is due. */
  update(input: PlayerBodiesInput): Vec3 | null {
    const puff = this.pose(input);
    this.draw();
    return puff;
  }

  /** Draw the body as {@link pose} placed it this frame, lit by the frame's lights. */
  draw(): void {
    this.own.draw();
  }

  /**
   * Place the body this frame, and answer with where the player's haste puff goes, if one is due;
   * nothing is lit or drawn until {@link draw}.
   */
  pose(input: PlayerBodiesInput): Vec3 | null {
    const { player } = input;
    // A respawn's teleport brings the body into view afresh (`CG_ResetPlayerEntity`).
    if (input.respawned) this.own.reset();
    return this.own.pose({
      origin: input.origin,
      angles: player.viewangles,
      legsAnim: player.legsAnim,
      torsoAnim: player.torsoAnim,
      movementDir: player.movementDir,
      velocity: player.velocity,
      dead: player.stats[STAT.HEALTH] <= 0,
      weapon: player.weapon as WeaponId,
      firing: input.firing,
      lastFireTime: input.lastFireTime,
      railFireTime: input.railFireTime,
      time: input.time,
      painTime: input.pain.time,
      painDirection: input.pain.direction,
      hidden: !input.shown,
      color: input.color,
      powerups: powerupMask(player.powerups),
      team: input.team,
      // `cg.predictedPlayerEntity`, which `CG_AddPacketEntities` adds before the snapshot's.
      entity: predictedEntity()
    });
  }

  /** The body, for the warm-up (`warm-up.ts`). */
  warm(): Promise<Warmed> {
    return this.own.warm();
  }

  /** Forget the clocks the last match ran the body on, as the match goes. */
  clear(): void {
    this.own.clear();
  }

  /**
   * The view weapon's frames, taken from the player's own torso as the last update left it
   * (`CG_AddViewWeapon`); the hand at rest before it has played.
   */
  handFrames(): ViewmodelFrames {
    const torso = this.own.torsoFrames;
    return torso ? handFrames(this.own.config.animations, torso) : IDLE_HAND;
  }

  /** Where a beam from the player's own body starts, while it is drawn: its weapon's `tag_flash`. */
  muzzleOrigin(): Vec3 | null {
    return this.own.muzzleOrigin();
  }

  /** The light the body's flash gives off as {@link pose} placed it, while it is drawn. */
  flashDlight(): { origin: Readonly<Vec3>; weapon: WeaponId } | null {
    return this.own.flashDlight();
  }

  /** Take the body away, giving back all it holds. */
  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    await this.own.destroy();
  }
}
