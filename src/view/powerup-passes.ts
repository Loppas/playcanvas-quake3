import { ANIM, ANIM_TOGGLEBIT } from '../sim/animations';
import { TEAM } from '../sim/constants';
import { PW } from '../sim/items';
import { vec3, type Vec3 } from '../sim/vec3';

/**
 * What a held powerup draws on the body wearing it: `CG_AddRefEntityWithPowerups`
 * (`cg_players.c:2150–2187`), `CG_AddWeaponWithPowerups` (`cg_weapons.c:1169–1186`) and
 * `CG_HasteTrail` (`cg_players.c:1501–1533`).
 *
 * A powerup draws its holder's body a second time with a shader of its own — a shell — and a
 * player wearing invisibility is drawn *only* that way. Which shells show, in what order, is
 * worked out here; the rig builds and draws them. The quad's dlight (`cg_players.c:1850–1852`)
 * has no counterpart yet: the port has no dynamic lights.
 */

/** `cgs.media.invisShader` (`cg_main.c:880`). */
export const INVIS_SHADER = 'powerups/invisibility';

/** `cgs.media.quadShader` (`cg_main.c:876`). */
export const QUAD_SHADER = 'powerups/quad';

/**
 * `cgs.media.redQuadShader`, which is `powerups/blueflag` (`cg_main.c:948`): a quadded red
 * player's shell is drawn from the flag shader.
 */
export const RED_QUAD_SHADER = 'powerups/blueflag';

/** `cgs.media.regenShader` (`cg_main.c:881`). */
export const REGEN_SHADER = 'powerups/regen';

/** `cgs.media.battleSuitShader` (`cg_main.c:878`). */
export const BATTLE_SUIT_SHADER = 'powerups/battleSuit';

/** `cgs.media.quadWeaponShader` (`cg_main.c:877`). */
export const QUAD_WEAPON_SHADER = 'powerups/quadWeapon';

/** `cgs.media.battleWeaponShader` (`cg_main.c:879`). */
export const BATTLE_WEAPON_SHADER = 'powerups/battleWeapon';

/** Every shader {@link bodyPasses} can draw a body's shell with. */
export const BODY_SHELL_SHADERS: readonly string[] = [
  INVIS_SHADER,
  QUAD_SHADER,
  RED_QUAD_SHADER,
  REGEN_SHADER,
  BATTLE_SUIT_SHADER
];

/** Every shader {@link weaponPasses} can draw a gun's shell with. */
export const WEAPON_SHELL_SHADERS: readonly string[] = [
  INVIS_SHADER,
  BATTLE_WEAPON_SHADER,
  QUAD_WEAPON_SHADER
];

/** How often a hasted runner leaves a puff: `cent->trailTime += 100` (`cg_players.c:1514`). */
export const HASTE_TRAIL_STEP_MS = 100;

/** Whether a player's entity says they are invisible: `1 << PW_INVIS`. */
export function invisible(powerups: number): boolean {
  return (powerups & (1 << PW.INVIS)) !== 0;
}

/**
 * Whether regeneration's shell shows this instant: `((cg.time / 100) % 10) == 1`
 * (`cg_players.c:2177`) — a tenth of a second in every second.
 */
export function regenVisible(time: number): boolean {
  return Math.trunc(time / 100) % 10 === 1;
}

/** What a body draws with: whether its own model is drawn, and the shells over it. */
export interface BodyPasses {
  /** `PW_INVIS`: the body is not drawn, only {@link BodyPasses.shaders}' one. */
  hidden: boolean;
  /** The shaders its parts are drawn again with, in order. */
  shaders: string[];
}

/**
 * `CG_AddRefEntityWithPowerups` for a player's body: invisibility draws the shell alone, and
 * otherwise the quad, regeneration's tenth-of-a-second flash and the battle suit draw over the
 * body, in that order.
 *
 * @param powerups - `cent->currentState.powerups`, the bitmask.
 * @param team - The wearer's team, which picks the red quad's shader.
 * @param time - `cg.time`, in milliseconds.
 */
export function bodyPasses(powerups: number, team: number, time: number): BodyPasses {
  if (invisible(powerups)) return { hidden: true, shaders: [INVIS_SHADER] };
  const shaders: string[] = [];
  if (powerups & (1 << PW.QUAD)) {
    shaders.push(team === TEAM.RED ? RED_QUAD_SHADER : QUAD_SHADER);
  }
  if (powerups & (1 << PW.REGEN) && regenVisible(time)) shaders.push(REGEN_SHADER);
  if (powerups & (1 << PW.BATTLESUIT)) shaders.push(BATTLE_SUIT_SHADER);
  return { hidden: false, shaders };
}

/**
 * `CG_AddWeaponWithPowerups` (`cg_weapons.c:1169–1186`) for the gun in a body's hand:
 * invisibility draws the gun's shell alone; otherwise the battle suit's weapon shell draws
 * before the quad's.
 */
export function weaponPasses(powerups: number): string[] {
  if (invisible(powerups)) return [INVIS_SHADER];
  const shaders: string[] = [];
  if (powerups & (1 << PW.BATTLESUIT)) shaders.push(BATTLE_WEAPON_SHADER);
  if (powerups & (1 << PW.QUAD)) shaders.push(QUAD_WEAPON_SHADER);
  return shaders;
}

/** The puff a hasted runner left, and the trail clock it leaves behind. */
export interface HasteTrail {
  /** Where the puff goes: the player's origin, 16 units down (`cg_players.c:1519–1520`). */
  puff: Vec3 | null;
  /** `cent->trailTime` after this frame. */
  trailTime: number;
}

/**
 * `CG_HasteTrail` (`cg_players.c:1501–1533`): a hasted player running forwards or backwards
 * leaves a smoke puff at their feet every {@link HASTE_TRAIL_STEP_MS}, on a clock of its own
 * that starts at zero and is pulled up to `cg.time` when a stalled frame lets it fall behind.
 *
 * @param legsAnimation - `cent->pe.legs.animationNumber`, toggle bit and all.
 * @param trailTime - `cent->trailTime`, zero on a fresh body.
 * @param time - `cg.time`, in milliseconds.
 * @param origin - `cent->lerpOrigin`: the player's origin, 24 units above their feet.
 */
export function hasteTrailPuff(
  legsAnimation: number,
  trailTime: number,
  time: number,
  origin: Readonly<Vec3>
): HasteTrail {
  if (trailTime > time) return { puff: null, trailTime };
  const anim = legsAnimation & ~ANIM_TOGGLEBIT;
  if (anim !== ANIM.LEGS_RUN && anim !== ANIM.LEGS_BACK) return { puff: null, trailTime };

  trailTime += HASTE_TRAIL_STEP_MS;
  if (trailTime < time) trailTime = time;
  return { puff: vec3(origin.x, origin.y, origin.z - 16), trailTime };
}
