import {
  crossProduct,
  f,
  perpendicularVector,
  QVM_PI,
  vectorMA,
  vectorNormalize,
  vectorSubtract
} from './cm/q-math';
import { EV } from './events';
import { addEvent, setMovedir, type GameEntity } from './game-entity';
import { registerItem } from './item-spawn';
import { findItemForWeapon } from './items';
import type { Level } from './level';
import { pickTarget } from './targets';
import { qvmCrandom } from './think-time';
import type { TraceFn } from './types';
import { copy, vec3 } from './vec3';
import { WP, type WeaponId } from './weapons/constants';
import { explodeMissile, fireMissile } from './weapons/missile';

/**
 * Shooters (`g_misc.c:240–337`): a rocket, grenade or plasma launcher with no one holding it,
 * which fires one shot each time something fires it — at the entity its `target` names, or along
 * its angles — scattered by up to `random` degrees.
 *
 * The shot is the weapon's own missile, under the match's rules, and it is the shooter's: a kill
 * by it is no player's, and costs the victim a point as a fall would.
 */

/** A shooter's scatter when the map gives no `random`, in degrees (`g_misc.c:303–305`). */
export const SHOOTER_RANDOM = 1;

/**
 * How long a shooter waits before finding its target, in milliseconds (`g_misc.c:310`): "target
 * might be a moving object, so we can't set movedir for it".
 */
export const SHOOTER_TARGET_DELAY = 500;

/**
 * `InitShooter` (`g_misc.c:295–313`), for `shooter_rocket`, `shooter_grenade` and
 * `shooter_plasma`: aimed along its angles, which are cleared, its scatter made the sine of its
 * `random` in the QVM's floats, and its weapon registered so the clients load what its shots look
 * like.
 *
 * @param level - The level it is spawning into.
 * @param self - The entity the map's pairs filled in.
 * @param weapon - What it fires.
 */
export function spawnShooter(level: Level, self: GameEntity, weapon: WeaponId): void {
  self.use = (it) => useShooter(level, it);
  self.s.weapon = weapon;

  registerItem(level, findItemForWeapon(weapon));

  setMovedir(self.s.angles, self.movedir);

  if (!self.random) self.random = SHOOTER_RANDOM;
  self.random = f(Math.sin(f(f(QVM_PI * self.random) / 180)));

  if (self.target !== null) {
    // `InitShooter_Finish` (`g_misc.c:289–293`).
    self.think = (it) => {
      it.enemy = pickTarget(level, it.target, level.itemMatch.random, level.itemMatch.print);
      it.think = null;
      it.nextthink = 0;
    };
    self.nextthink = level.time + SHOOTER_TARGET_DELAY;
  }

  level.linkEntity(self);
}

/** Scratch for a shot's aim, in the game module's floats. */
const shot = { dir: [0, 0, 0], up: [0, 0, 0], right: [0, 0, 0] };

/**
 * `Use_Shooter` (`g_misc.c:248–286`): fire once, toward the target where it is now or along the
 * shooter's aim, turned off it by up and across a perpendicular, each up to the scatter.
 */
function useShooter(level: Level, self: GameEntity): void {
  const { dir, up, right } = shot;
  const origin = [self.s.origin.x, self.s.origin.y, self.s.origin.z];

  // "see if we have a target".
  const enemy = self.enemy;
  if (enemy) {
    const at = enemy.r.currentOrigin;
    vectorSubtract([at.x, at.y, at.z], origin, dir);
    vectorNormalize(dir);
  } else {
    dir[0] = self.movedir.x;
    dir[1] = self.movedir.y;
    dir[2] = self.movedir.z;
  }

  // "randomize a bit".
  perpendicularVector(up, dir);
  crossProduct(up, dir, right);
  vectorMA(dir, f(qvmCrandom(level.itemMatch.random) * self.random), up, dir);
  vectorMA(dir, f(qvmCrandom(level.itemMatch.random) * self.random), right, dir);
  vectorNormalize(dir);

  const weapon = self.s.weapon;
  if (weapon === WP.GRENADE_LAUNCHER || weapon === WP.ROCKET_LAUNCHER || weapon === WP.PLASMAGUN) {
    const trace: TraceFn = (start, mins, maxs, end, pass, mask) =>
      level.trace(start, mins, maxs, end, pass, mask);
    fireMissile(
      level,
      self,
      weapon,
      copy(self.s.origin),
      vec3(dir[0], dir[1], dir[2]),
      (missile) => explodeMissile(level, missile, trace),
      level.rules
    );
  }

  addEvent(self, EV.FIRE_WEAPON, 0, level.time);
}
