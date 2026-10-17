import { WEAPON_ASSETS } from '../formats/asset-manifest';
import { MAX_CLIENTS, MAX_GENTITIES, type EntityState } from '../net/protocol';
import { EF_FIRING } from '../sim/constants';
import { EV } from '../sim/events';
import { PW } from '../sim/items';
import { NO_CONTENTS, type PointContentsFn } from '../sim/types';
import { copy, type Vec3 } from '../sim/vec3';
import { WP, type WeaponId } from '../sim/weapons/constants';
import type { EntityEvent } from './entity-events';
import { useItemSound } from './item-sounds';
import { jumpPadEvent } from './jump-pad-events';
import {
  bodyEventSound,
  customSoundName,
  painEvent,
  waterLevel,
  type PainMemory,
  type PlayerSound
} from './player-events';
import { powerupEventSound, QUAD_SOUND } from './powerup-sounds';

/**
 * Everyone else's events, as a client plays them: `CG_EntityEvent`'s cases for the players it does
 * not predict, and for the corpses (`cg_event.c:522–1242`). The player's own are
 * `player-events.ts`', and reach the client on its player state instead.
 *
 * Each is heard from the entity it happened to, which a sound then follows as it moves, and in that
 * client's own sounds. What the client keeps of each entity between events is `cg_entities[]`'
 * `pe`, which is kept by slot: the slot the event came on, which for a player's second event of a
 * move is a slot of its own. So that shot does not flash the player's gun, as in Q3.
 *
 * Engine-free, like the rest of `src/view/`.
 */

/** `cgs.media.selectSound` (`cg_main.c:615`): a weapon change, heard from whoever made it. */
export const SELECT_SOUND = 'sound/weapons/change.wav';

/** What `CG_EntityEvent` keeps of each entity between its events, by entity slot. */
export interface EntityMemory {
  /** `cent->pe.painTime` and `painDirection`. */
  pain: PainMemory[];
  /** `cent->muzzleFlashTime`: when it last fired, which its gun's flash is drawn from. */
  muzzleFlashTime: number[];
  /** `cent->pe.railFireTime`: when its railgun last fired, for the glow's return. */
  railFireTime: number[];
  /**
   * `cent->pe.lightningFiring`: its weapon's firing loop played the frame before, which is what
   * holds back the lightning gun's fire sound after the first shot of a burst.
   */
  lightningFiring: boolean[];
}

/** A client that has seen nothing yet. */
export function createEntityMemory(): EntityMemory {
  return {
    pain: Array.from({ length: MAX_GENTITIES }, () => ({
      painTime: Number.NEGATIVE_INFINITY,
      painDirection: 0
    })),
    muzzleFlashTime: new Array<number>(MAX_GENTITIES).fill(Number.NEGATIVE_INFINITY),
    railFireTime: new Array<number>(MAX_GENTITIES).fill(Number.NEGATIVE_INFINITY),
    lightningFiring: new Array<boolean>(MAX_GENTITIES).fill(false)
  };
}

/** A sound another entity makes: one of the body's, or a weapon's shot. */
export type EntitySoundKind = PlayerSound | { type: 'fire'; weapon: WeaponId };

/** A sound started on an entity other than the player's own. */
export interface EntitySound {
  /** `es->number`: the entity it is started on, whose place it is heard from as that moves. */
  number: number;
  /** Where the entity was as it started (`CG_SetEntitySoundPosition`). */
  origin: Vec3;
  /**
   * Whose sounds it is: the slot whose model's own sound it is, or whose footsteps. Q3 looks a
   * model's sound up by the entity's number, so a corpse's would be slot 0's (`CG_CustomSound`),
   * and a footstep up by its `s.clientNum`.
   */
  voice: number;
  sound: EntitySoundKind;
}

/** What everyone else's events this snapshot ask of the client. */
export interface OtherPlayerEvents {
  sounds: EntitySound[];
  /** `CG_GibPlayer`: where a player or a corpse went to pieces. */
  gibs: Vec3[];
  /** `EV_JUMP_PAD`: the puffs jump pads threw, each at the player who hit one. */
  puffs: Vec3[];
}

/**
 * `CG_EntityEvent` for everything but the player's own: what each event sounds and does.
 *
 * - The body's sounds are the player's own events' (`bodyEventSound`), played from the entity.
 * - `EV_PAIN` is `CG_PainEvent`, at most twice a second, which starts the torso's twitch. Q3
 *   ignores it on the player it predicts (`cg_event.c:1158–1165`).
 * - A pain or a death is gurgled or drowned where the body stands with its head under water, by
 *   `CG_WaterLevel` at where the event found it.
 * - `EV_CHANGE_WEAPON` is the select sound, and `EV_FIRE_WEAPON` is `CG_FireWeapon`.
 * - `EV_GIB_PLAYER` is the gib's splat and the pieces, where the entity is.
 * - `EV_GENERAL_SOUND` naming a model's own sound, a `*` name, is that sound in the event
 *   entity's voice (`cg_event.c:1020–1027`): past the clients, which an event entity always is,
 *   client 0's (`CG_CustomSound`, `cg_players.c:57–59`). Its other names are the world's.
 *
 * @param memory - The client's memory of each entity, updated in place.
 * @param events - What {@link checkEntityEvents} found.
 * @param ownClientNum - `cg.snap->ps.clientNum`: the player this client predicts.
 * @param time - The snapshot's time, in milliseconds.
 * @param random - `rand()`, as a number in [0, 1), for the footstep and the gurgle.
 * @param gameSound - `CG_ConfigString( CS_SOUNDS + index )`: the name a sound event carries.
 * @param pointContents - `CG_PointContents`, for how deep a body stands.
 */
export function otherPlayerEvents(
  memory: EntityMemory,
  events: readonly EntityEvent[],
  ownClientNum: number,
  time: number,
  random: () => number = Math.random,
  gameSound: (index: number) => string = () => '',
  pointContents: PointContentsFn = NO_CONTENTS
): OtherPlayerEvents {
  const sounds: EntitySound[] = [];
  const gibs: Vec3[] = [];
  const puffs: Vec3[] = [];

  for (const { state, number, event, parm, origin, soundOrigin } of events) {
    // `cent`: the slot the event came on, which is where what it leaves is kept.
    const slot = state.number;
    const play = (sound: EntitySoundKind | null, voice = clientSlot(state.clientNum)) => {
      if (sound) sounds.push({ number, origin: copy(soundOrigin), voice, sound });
    };
    const depth = () => waterLevel(origin, state.legsAnim, pointContents);

    switch (event) {
      case EV.JUMP_PAD: {
        // `CG_EntityEvent`'s `EV_JUMP_PAD` (`cg_event.c:655–674`): the pad's boing, the player's
        // own jump sound, and the puff, all from the player who hit it.
        const pad = jumpPadEvent(origin);
        for (const sound of pad.sounds) {
          play(sound, sound.type === 'custom' ? clientSlot(number) : clientSlot(state.clientNum));
        }
        puffs.push(pad.puff);
        break;
      }

      case EV.PAIN:
        if (number !== ownClientNum) {
          play(painEvent(memory.pain[slot], parm, time, depth, random), clientSlot(number));
        }
        break;

      case EV.CHANGE_WEAPON:
        play({ type: 'shared', path: SELECT_SOUND });
        break;

      case EV.FIRE_WEAPON:
        for (const sound of fireWeapon(memory, slot, state, time)) play(sound);
        break;

      case EV.POWERUP_QUAD:
      case EV.POWERUP_BATTLESUIT:
      case EV.POWERUP_REGEN: {
        // The three the server raises about a powerup: a landing quad punch, a hit the suit took,
        // and a regeneration tick (`CG_EntityEvent`, `cg_event.c:1189–1214`).
        const path = powerupEventSound(event);
        if (path) play({ type: 'shared', path });
        break;
      }

      case EV.USE_ITEM0:
      case EV.USE_ITEM1:
      case EV.USE_ITEM2: {
        // `CG_UseItem` (`cg_event.c:344–397`), for anyone but the player predicted: the sound of
        // the item they used, from them. The center print and the medkit's own model are the
        // local player's alone, and the two teleport effects are `TeleportPlayer`'s.
        const path = useItemSound(event - EV.USE_ITEM0);
        if (path) play({ type: 'shared', path });
        break;
      }

      case EV.GIB_PLAYER:
        play(bodyEventSound(event, memory.pain[slot], time, random));
        gibs.push(copy(origin));
        break;

      case EV.GENERAL_SOUND: {
        const name = customSoundName(gameSound(parm));
        if (name) play({ type: 'custom', name }, clientSlot(number));
        break;
      }

      default: {
        const sound = bodyEventSound(event, memory.pain[slot], time, random, depth);
        // A model's own sound is the entity's number's; a footstep is its client's.
        play(sound, sound?.type === 'custom' ? clientSlot(number) : clientSlot(state.clientNum));
        break;
      }
    }
  }

  return { sounds, gibs, puffs };
}

/**
 * `CG_AddPlayerWeapon`'s `pe.lightningFiring` for each player drawn (`cg_weapons.c:1238–1249`):
 * whether their weapon's firing loop is playing, which the next shot's sound reads.
 *
 * Q3 sets it as it draws each player, after the snapshot's events have played, so an event reads
 * what the frame before left. Nothing is set for a player with no weapon, whose gun is never drawn.
 *
 * @param players - Every player drawn this frame.
 */
export function addPlayerWeapons(memory: EntityMemory, players: readonly EntityState[]): void {
  for (const state of players) {
    if (state.weapon === WP.NONE) continue;
    memory.lightningFiring[state.number] =
      (state.eFlags & EF_FIRING) !== 0 && firingSound(state.weapon as WeaponId);
  }
}

/**
 * `CG_FireWeapon` (`cg_weapons.c:1678–1731`): the flash, the quad's sound, and the shot's own.
 * The lightning gun sounds only the first shot of a burst, while its firing loop takes over from
 * there — and the early return that makes that so comes before the quad's sound as well, which
 * is why a quadded burst says nothing after its first shot. The railgun dims its glow, and the
 * port ejects no brass.
 *
 * @returns the sounds, in the order they are started, or none
 */
function fireWeapon(
  memory: EntityMemory,
  slot: number,
  state: EntityState,
  time: number
): EntitySoundKind[] {
  const weapon = state.weapon;
  if (weapon === WP.NONE) return [];
  memory.muzzleFlashTime[slot] = time;
  if (weapon === WP.LIGHTNING && memory.lightningFiring[slot]) return [];
  if (weapon === WP.RAILGUN) memory.railFireTime[slot] = time;

  const sounds: EntitySoundKind[] = [];
  // "Play quad sound if needed" (`cg_weapons.c:1708–1711`): the shooter's entity state carries
  // the powerup's bit, which is how everyone else's client knows to play it.
  if ((state.powerups & (1 << PW.QUAD)) !== 0) {
    sounds.push({ type: 'shared', path: QUAD_SOUND });
  }
  sounds.push({ type: 'fire', weapon: weapon as WeaponId });
  return sounds;
}

/** Whether a weapon has a firing loop of its own: the gauntlet and the lightning gun. */
function firingSound(weapon: WeaponId): boolean {
  return WEAPON_ASSETS.find((asset) => asset.id === weapon)?.firingSound !== undefined;
}

/** A slot as `CG_EntityEvent` and `CG_CustomSound` take one: 0 for anything past the clients. */
function clientSlot(clientNum: number): number {
  return clientNum >= 0 && clientNum < MAX_CLIENTS ? clientNum : 0;
}
