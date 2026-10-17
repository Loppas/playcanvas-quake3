import { PW } from '../sim/items';
import type { Vec3 } from '../sim/vec3';
import { WP, type WeaponId } from '../sim/weapons/constants';
import type { BrushModelPose } from './brush-models';
import type { SceneLights } from './dynamic-lights';
import { explosionOrigin, type Explosion } from './explosions';

/**
 * What gives off light in Quake 3, and the gather that adds it to the frame's lights in the
 * cgame's order, before anything is shaded.
 *
 * Every value is the cgame's own. The order decides which light the cap of 32 drops: the
 * cgame adds the player's own entity first, then the snapshot's in entity number order,
 * then its local entities, oldest first, and last of all the view weapon's flash
 * (`cg_view.c:816–822`, `cg_ents.c:1082–1094`).
 *
 * Engine-free like the rest of `src/view/`.
 */

/** A light a source gives: how far it reaches, in units, and its colour, 0–1 a channel. */
export interface LightValue {
  readonly radius: number;
  readonly color: readonly [number, number, number];
}

/**
 * `rand() & 31`: the most a powerup's or a flash's light reaches past its radius, drawn again every
 * frame, so it flickers.
 */
export const LIGHT_FLICKER = 31;

/** The powerups' and the flags' light, `200 + (rand() & 31)` (`CG_PlayerPowerups`). */
export const POWERUP_LIGHT_RADIUS = 200;

/**
 * The powerups that give their holder a light, in the order `CG_PlayerPowerups` adds them
 * (`cg_players.c:1850–1892`), each at the holder's origin. The neutral flag's white light is Team
 * Arena's one-flag game's, whose powerup the port does not carry.
 */
export const POWERUP_LIGHTS: readonly { readonly powerup: number; readonly color: readonly [number, number, number] }[] = [
  { powerup: PW.QUAD, color: [0.2, 0.2, 1] },
  { powerup: PW.REDFLAG, color: [1, 0.2, 0.2] },
  { powerup: PW.BLUEFLAG, color: [0.2, 0.2, 1] }
];

/**
 * A missile's light in flight, at its origin: `missileDlight` and `missileDlightColor`
 * (`CG_RegisterWeapon`, `cg_weapons.c:699–700, 739–743`, added by `CG_Missile`,
 * `cg_ents.c:452–455`): the rocket's, and the grapple's while it flies.
 */
export const MISSILE_LIGHTS: Partial<Record<WeaponId, LightValue>> = {
  [WP.ROCKET_LAUNCHER]: { radius: 200, color: [1, 0.75, 0] },
  [WP.GRAPPLING_HOOK]: { radius: 200, color: [1, 0.75, 0] }
};

/**
 * An impact's light, at its explosion's origin, for the explosion's life: `light` and
 * `lightColor` in `CG_MissileHitWall` (`cg_weapons.c:1741–1830`). It fades as
 * {@link explosionLightRadius} has it. No other impact gives one.
 */
export const EXPLOSION_LIGHTS: Partial<Record<WeaponId, LightValue>> = {
  [WP.GRENADE_LAUNCHER]: { radius: 300, color: [1, 1, 0] },
  [WP.ROCKET_LAUNCHER]: { radius: 300, color: [1, 0.75, 0] }
};

/** A muzzle flash's light, `300 + (rand() & 31)`, at the flash (`cg_weapons.c:1342–1345`). */
export const FLASH_LIGHT_RADIUS = 300;

/**
 * Each weapon's flash light colour, `flashDlightColor` (`CG_RegisterWeapon`,
 * `cg_weapons.c:676–806`). A weapon with no flash model gives none (`:1315–1318`).
 */
export const FLASH_LIGHT_COLORS: Partial<Record<WeaponId, readonly [number, number, number]>> = {
  [WP.GAUNTLET]: [0.6, 0.6, 1],
  [WP.MACHINEGUN]: [1, 1, 0],
  [WP.SHOTGUN]: [1, 1, 0],
  [WP.GRENADE_LAUNCHER]: [1, 0.7, 0],
  [WP.ROCKET_LAUNCHER]: [1, 0.75, 0],
  [WP.LIGHTNING]: [0.6, 0.6, 1],
  [WP.RAILGUN]: [1, 0.5, 0],
  [WP.PLASMAGUN]: [0.6, 0.6, 1],
  [WP.BFG]: [1, 0.7, 1],
  [WP.GRAPPLING_HOOK]: [0.6, 0.6, 1]
};

/**
 * How far an explosion's light reaches as it plays (`CG_AddExplosion`, `CG_AddSpriteExplosion`,
 * `cg_localents.c:483–494`, `524–535`): whole for the first half of its life, then down to
 * nothing at its end, in cgame's floats.
 *
 * @param progress - How far through its life the explosion is, 0 to 1, a float as cgame divides
 *   it.
 */
export function explosionLightRadius(radius: number, progress: number): number {
  const f = Math.fround;
  return f(f(radius) * f(progress < 0.5 ? 1 : 1 - (progress - 0.5) * 2));
}

/** A gun's flash as the gather reads one: where it is drawn this frame, and whose it is. */
export interface LitFlash {
  /** `flash.origin`: on the gun's `tag_flash`, as the frame placed it. */
  readonly origin: Readonly<Vec3>;
  readonly weapon: WeaponId;
}

/** A player as the gather reads one: where it is drawn, and what it holds. */
export interface LitPlayer {
  /** Its entity number, which orders the snapshot. */
  readonly number: number;
  /** `cent->lerpOrigin`. */
  readonly origin: Readonly<Vec3>;
  /** `currentState.powerups`: the bitmask of the powerups held. */
  readonly powerups: number;
  /** Its gun's flash while it shows and the body is drawn: none otherwise. */
  readonly flash?: LitFlash | null;
}

/** A missile in flight as the gather reads one. */
export interface LitMissile {
  readonly number: number;
  readonly weapon: WeaponId;
  /** `cent->lerpOrigin`: where its trajectory has it this frame. */
  readonly origin: Readonly<Vec3>;
}

/**
 * An entity the game gave a `constantLight`, as the gather reads one: a mover with `light` or
 * `color` keys (`InitMover`), the only entities a game gives one.
 */
export interface LitGlow {
  readonly number: number;
  /** `cent->lerpOrigin`. */
  readonly origin: Readonly<Vec3>;
  /** `currentState.constantLight`: red, green and blue bytes, then the intensity over 4. */
  readonly constantLight: number;
}

/** What lights a frame, as the cgame has it once the frame's state is known. */
export interface LightFrame {
  /** The player's own entity, `cg.predictedPlayerEntity`, which the cgame adds first. */
  readonly own: LitPlayer | null;
  /** Everyone else in the snapshot, corpses among them. */
  readonly players: readonly LitPlayer[];
  /** The missiles in the snapshot. */
  readonly missiles: readonly LitMissile[];
  /** The snapshot's entities with a `constantLight`; none where none has. */
  readonly glows?: readonly LitGlow[];
  /** The explosions playing, oldest first. */
  readonly explosions: readonly Explosion[];
  /** The view weapon's flash, while it shows (`CG_AddViewWeapon`); none otherwise. */
  readonly viewWeapon?: LitFlash | null;
  /** The game clock, in milliseconds, which the explosions fade by. */
  readonly time: number;
}

/** What a snapshot entity's light comes from, in the order `CG_AddCEntity` adds them. */
const GLOW = 0;
const PLAYER = 1;
const MISSILE = 2;

/** How a sort key holds an entity: its number, then its kind, then its place in its list. */
const KIND_SPAN = 1 << 12;
const NUMBER_SPAN = 4 * KIND_SPAN;

/** The snapshot's lit entities as sort keys, kept from frame to frame. */
const keys: number[] = [];
const NO_GLOWS: readonly LitGlow[] = [];
const byKey = (a: number, b: number): number => a - b;

/**
 * Fill the frame's lights from its state, in the cgame's order: the player's own entity's; then
 * the snapshot's entities by number (`CG_AddPacketEntities`), each's `constantLight` first
 * (`CG_EntityEffects`, `cg_ents.c:141–153`), then a player's flash and powerups or a missile's
 * light; then the explosions, oldest first (`CG_AddLocalEntities`); and last the view weapon's
 * flash (`CG_AddViewWeapon`, `cg_view.c:822`).
 *
 * @param random - Uniform over [0, 1), for `rand()`; injectable so a test can pin it.
 */
export function gatherLights(scene: SceneLights, frame: LightFrame, random: () => number = Math.random): void {
  scene.clear();
  if (frame.own) addPlayerLights(scene, frame.own, random);
  const { players, missiles, glows = NO_GLOWS } = frame;
  keys.length = 0;
  for (let i = 0; i < glows.length; i++) {
    keys.push(glows[i].number * NUMBER_SPAN + GLOW * KIND_SPAN + i);
  }
  for (let i = 0; i < players.length; i++) {
    keys.push(players[i].number * NUMBER_SPAN + PLAYER * KIND_SPAN + i);
  }
  for (let i = 0; i < missiles.length; i++) {
    keys.push(missiles[i].number * NUMBER_SPAN + MISSILE * KIND_SPAN + i);
  }
  keys.sort(byKey);
  for (let k = 0; k < keys.length; k++) {
    const key = keys[k];
    const at = key % KIND_SPAN;
    const kind = Math.floor(key / KIND_SPAN) % 4;
    if (kind === GLOW) addGlow(scene, glows[at]);
    else if (kind === PLAYER) addPlayerLights(scene, players[at], random);
    else addMissileLight(scene, missiles[at]);
  }
  for (const explosion of frame.explosions) addExplosionLight(scene, explosion, frame.time);
  if (frame.viewWeapon) addFlashLight(scene, frame.viewWeapon, random);
}

/** The movers placed this frame that glow: each with a `constantLight`, at its origin. */
export function moverGlows(poses: readonly BrushModelPose[]): LitGlow[] {
  const glows: LitGlow[] = [];
  for (const { number, origin, constantLight } of poses) {
    if (!constantLight || number === undefined) continue;
    glows.push({ number, origin: { x: origin[0], y: origin[1], z: origin[2] }, constantLight });
  }
  return glows;
}

/** `rand() & 31`. */
function flicker(random: () => number): number {
  return Math.floor(random() * (LIGHT_FLICKER + 1));
}

/** `CG_EntityEffects`' constant light glow, at the entity, its intensity times 4. */
function addGlow(scene: SceneLights, { origin, constantLight }: LitGlow): void {
  const color: [number, number, number] = [
    (constantLight & 0xff) / 255,
    ((constantLight >>> 8) & 0xff) / 255,
    ((constantLight >>> 16) & 0xff) / 255
  ];
  scene.add(origin, ((constantLight >>> 24) & 0xff) * 4, color);
}

/**
 * `CG_Player`'s lights: its gun's flash (`CG_AddPlayerWeapon`), then its powerups'
 * (`CG_PlayerPowerups`, `cg_players.c:2590–2593`).
 */
function addPlayerLights(scene: SceneLights, player: LitPlayer, random: () => number): void {
  if (player.flash) addFlashLight(scene, player.flash, random);
  addPowerupLights(scene, player, random);
}

/** A flash's light, `300 + (rand() & 31)` in its weapon's colour (`cg_weapons.c:1342–1345`). */
function addFlashLight(
  scene: SceneLights,
  { origin, weapon }: LitFlash,
  random: () => number
): void {
  const color = FLASH_LIGHT_COLORS[weapon];
  if (color) scene.add(origin, FLASH_LIGHT_RADIUS + flicker(random), color);
}

/** `CG_Missile`'s light, at the missile, for a weapon whose missile gives one. */
function addMissileLight(scene: SceneLights, missile: LitMissile): void {
  const light = MISSILE_LIGHTS[missile.weapon];
  if (light) scene.add(missile.origin, light.radius, light.color);
}

/**
 * `CG_AddExplosion`'s and `CG_AddSpriteExplosion`'s light, at the explosion, for an impact that
 * gives one, fading over the explosion's second half.
 */
function addExplosionLight(scene: SceneLights, explosion: Explosion, time: number): void {
  const light = EXPLOSION_LIGHTS[explosion.weapon];
  if (!light) return;
  // `(float)( cg.time - ex->startTime ) / ( ex->endTime - ex->startTime )`.
  const progress = Math.fround(Math.fround(time - explosion.startTime) / explosion.durationMs);
  scene.add(explosionOrigin(explosion), explosionLightRadius(light.radius, progress), light.color);
}

/** `CG_PlayerPowerups`' lights: one at the holder for each powerup that gives one. */
function addPowerupLights(scene: SceneLights, player: LitPlayer, random: () => number): void {
  for (const { powerup, color } of POWERUP_LIGHTS) {
    if (player.powerups & (1 << powerup)) {
      scene.add(player.origin, POWERUP_LIGHT_RADIUS + flicker(random), color);
    }
  }
}
