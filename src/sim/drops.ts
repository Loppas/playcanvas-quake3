import { GT, STAT } from './constants';
import type { GameEntity } from './game-entity';
import { dropItem } from './item-spawn';
import {
  AMMO_SUFFIX,
  findItemForAmmo,
  findItemForPowerup,
  findItemForWeapon,
  pickupAmount,
  PW,
  type GItem
} from './items';
import type { Level } from './level';
import { WEAPON_DROPPING, WP } from './weapons/constants';

/**
 * `TossClientItems` (`g_combat.c:69–127`): what a player leaves behind when they die
 * (`player_die`, `:564`) or leave (`ClientDisconnect`, `g_client.c:1287–1289`).
 *
 * Two things drop, and they drop for different reasons. The weapon in hand drops so that a fight
 * has something in it to pick up: the gauntlet and the machinegun never do, and neither does a
 * weapon with no ammo in it — but a player killed mid-switch drops what they were *raising*, so a
 * weapon picked up a moment before the shot that killed them is not lost. A powerup drops so that
 * a fight over it continues after the holder is gone: every one that is still running, fanned out
 * around the body so they do not land in a heap, each carrying its seconds left in `count` so a
 * quad picked up with three seconds on it is worth three seconds. Team games keep them.
 *
 * The flags ride the same loop: a carried flag is a powerup held until `INT_MAX`
 * (`BG_FindItemForPowerup` answers for it), so CTF's flag drop is here and only its rules are
 * `team.ts`'s.
 *
 * Under `g_dropWeaponAmmo` the weapon goes as a pack of the dropper's ammo, as CPMA's does, and a
 * player with no weapon to drop leaves the pack as an ammo box.
 */

/**
 * @param level - The level the drops land in.
 * @param entity - The player who is dying or leaving, with their client.
 */
export function tossClientItems(level: Level, entity: GameEntity): void {
  const client = entity.client;
  if (!client) return;
  // CPMA's modes drop nothing, and Clan Arena's leaves it so.
  const gametype = level.itemMatch.gametype();
  if (gametype === GT.CA) return;
  const ps = client.ps;
  const packs = level.rules.g_dropWeaponAmmo !== 0 && gametype !== GT.FFA;

  // "drop the weapon if not a gauntlet or machinegun"
  let weapon = entity.s.weapon;

  // "make a special check to see if they are changing to a new weapon that isn't the mg or
  // gauntlet": without it a client can pick up a weapon, be killed, and not drop it because the
  // switch has not finished and they are still holding the machinegun.
  if (weapon === WP.MACHINEGUN || weapon === WP.GRAPPLING_HOOK) {
    if (ps.weaponstate === WEAPON_DROPPING) weapon = client.pers.cmd.weapon;
    if (!(ps.stats[STAT.WEAPONS] & (1 << weapon))) weapon = WP.NONE;
  }

  if (weapon > WP.MACHINEGUN && weapon !== WP.GRAPPLING_HOOK && ps.ammo[weapon]) {
    const drop = dropItem(level, entity, findItemForWeapon(weapon), 0);
    if (packs) drop.pack = packAmmo(level, gametype, ps.ammo);
  } else if (packs) {
    const box = bestAmmoBox(ps.ammo);
    if (box) dropItem(level, entity, box, 0).pack = packAmmo(level, gametype, ps.ammo);
  }

  // "drop all the powerups if not in teamplay"
  if (gametype !== GT.TEAM) {
    let angle = 45;
    for (let i = 1; i < PW.NUM_POWERUPS; i++) {
      if (ps.powerups[i] > level.time) {
        const item = findItemForPowerup(i);
        // A slot with no item — Team Arena's — is passed over *without* taking a fan angle, as the
        // C's `continue` does.
        if (!item) continue;
        const drop = dropItem(level, entity, item, angle);
        // "decide how many seconds it has left", and never less than one.
        drop.count = Math.trunc((ps.powerups[i] - level.time) / 1000);
        if (drop.count < 1) drop.count = 1;
        angle += 45;
      }
    }
  }
}

/**
 * What a pack carries, by weapon: the ammo held, up to what the weapon's box gives, or in team
 * deathmatch what the weapon itself gives there.
 */
function packAmmo(level: Level, gametype: number, ammo: readonly number[]): number[] {
  const pack = ammo.map(() => 0);
  const family = gametype === GT.TEAM ? 'g_weaponPickup' : 'g_ammoPickup';
  for (const weapon of AMMO_SUFFIX.keys()) {
    const cap = pickupAmount(level.rules, family, findItemForWeapon(weapon), gametype);
    pack[weapon] = Math.min(Math.max(ammo[weapon], 0), cap);
  }
  return pack;
}

/** The box of the best weapon with any ammo, from the BFG's down to the machinegun's, or none. */
function bestAmmoBox(ammo: readonly number[]): GItem | null {
  for (let weapon: number = WP.BFG; weapon >= WP.MACHINEGUN; weapon--) {
    if (ammo[weapon]) return findItemForAmmo(weapon);
  }
  return null;
}
