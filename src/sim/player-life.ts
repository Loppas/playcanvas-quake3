import { ENTITYNUM_WORLD, MAX_CLIENTS, type PlayerState } from '../net/protocol';
import { ANIM, nextAnim } from './animations';
import { clearBodyQue, copyToBodyQue } from './body-queue';
import { DAMAGE_NO_ARMOR, GIB_HEALTH, bodyDie, damage, gibEntity } from './combat';
import { awardSprite, type GameClient } from './client';
import {
  BUTTON_ATTACK,
  CONTENTS,
  DEAD_HEIGHT,
  DF_NO_FALLING,
  EF_AWARD_EXCELLENT,
  EF_AWARD_GAUNTLET,
  FL,
  GT,
  MOD,
  PLAYEREVENT,
  PM_DEAD,
  PM_NORMAL,
  PERS,
  PMF_RESPAWNED,
  PMF_TIME_KNOCKBACK,
  STAT,
  TEAM
} from './constants';
import { EV, eventNumber, eventsSince } from './events';
import { SVF, addEvent, playerStateToEntityState, type GameEntity } from './game-entity';
import { ARMOR_TIER, MEDKIT_HEAL, PW, healthLimit, tierRule } from './items';
import { Q3_FRAME_MSEC, type Level } from './level';
import { vectorToAngles, vectorToYaw } from './pmove-math';
import { defaultRules, type Rules } from './rules';
import { checkAlmostCapture, onSameTeam, teamFragBonuses, teamReturnFlag } from './team';
import { sendPendingPredictableEvents, tempEntity } from './temp-entity';
import { playerBounds, type UserCmd } from './types';
import { unTimeShiftClient } from './unlagged';
import { copy, sub, type Vec3 } from './vec3';
import { ALL_WEAPONS, AMMO_INFINITE, MAX_WEAPONS, WEAPON_READY, WP } from './weapons/constants';

/**
 * The game's side of the player's life: spawning, dying and coming back (`g_client.c`,
 * `g_combat.c`, `g_active.c`).
 *
 * What `g_client.c`'s, `g_combat.c`'s and `g_active.c`'s functions do to one client, gathered
 * where the port has always kept them. It is not `gclient_t` — that is the slot itself, in
 * `client.ts` — and it holds no state of its own: everything it touches lives on the entity and
 * the client slot it is given, which is where Quake 3 keeps it too. Its clock is the level's.
 *
 * It runs around each `pmove` tick where `ClientThink_real` runs around `Pmove`:
 *
 * 1. {@link PlayerLife.beginTick} — the move type follows health, so a dead player moves as a
 *    corpse;
 * 2. `pmove`;
 * 3. {@link PlayerLife.clientEvents} — landings that hurt, and the shots the move fired, read out
 *    of the ring the move filled;
 * 4. {@link PlayerLife.endTick} — the respawn, or the once-a-second drain;
 * 5. {@link PlayerLife.endFrame} — the world's drowning, lava and slime, and the frame's hurts
 *    turned into feedback.
 *
 * Being hurt is not one of them. Anything can hurt the player at any time — a rocket in the
 * frame, another client's rail between frames — and it does so through `G_Damage`, which is
 * everybody's. What is the life's is what the player does about dying: the spawn gives the
 * entity `player_die`, which is what `G_Damage` calls.
 *
 * What it tells a client, it tells through `G_AddEvent` — the pain, the three deaths and the gib
 * — and the obituary, which is an event of its own that everyone is sent.
 */

/** A dead player may respawn once the death has played this long (`player_die`, g_combat.c:608). */
export const RESPAWN_DELAY = 1700;

/**
 * `CARNAGE_REWARD_TIME` (`g_local.h:39`), in milliseconds: two kills closer together than this
 * count as a carnage, and the second raises the excellent counter the scoreboard shows.
 */
export const CARNAGE_REWARD_TIME = 3000;

/**
 * `g_forcerespawn`'s own default of 20 (`g_main.c:147`), in milliseconds: after this much longer,
 * the respawn happens anyway. It is what a life is given no cvar reading takes.
 */
export const FORCE_RESPAWN = 20_000;

/**
 * A spawn starts health this far over the max, to drain back down (`g_client.c:1179`), and it is
 * `g_startingHealthBonus`'s default.
 */
export const SPAWN_HEALTH_BONUS = 25;

/** A spawn holds the player below full speed for this long (`g_client.c:1189–1191`). */
export const SPAWN_KNOCKBACK_TIME = 100;

/** At most one pain sound per this long (`P_DamageFeedback`, g_active.c:74). */
export const PAIN_DEBOUNCE = 700;

/**
 * A player's air: from a spawn, and from every frame not under water (`g_client.c:1138`,
 * `g_active.c:139`).
 */
export const AIR_OUT_TIME = 12_000;

/** The air the battle suit holds a player at under water (`g_active.c:118`). */
export const SUIT_AIR_TIME = 10_000;

/** Out of air, a player is hurt again each this long (`g_active.c:124`). */
export const DROWN_INTERVAL = 1000;

/**
 * What each breath's hurt rises by, from the same 2 a frame out of the water leaves it at, so the
 * first is 4 (`g_active.c:127, 140`).
 */
const DROWN_DAMAGE_STEP = 2;

/** The most a breath hurts (`g_active.c:128–129`). */
export const DROWN_DAMAGE_MAX = 15;

/** "Don't play a normal pain sound" for a breath's hurt (`g_active.c:131–132`). */
const DROWN_PAIN_DEBOUNCE = 200;

/** What lava and slime cost a water level (`g_active.c:156, 161`). */
export const LAVA_DAMAGE = 30;
export const SLIME_DAMAGE = 10;

/** Quake 3's frame at its own `sv_fps` of 20, on which lava and slime hurt. */
export const SIZZLE_FRAME_MSEC = Q3_FRAME_MSEC;

/** The loop a player standing in lava or slime makes (`g_main.c:428`). */
export const FRY_SOUND = 'sound/player/fry.wav';

/**
 * A fall holds off the pain sound for this long, since it plays its own (`ClientEvents`,
 * g_active.c:569).
 */
export const FALL_PAIN_DEBOUNCE = 200;

/** A medium fall's damage (`ClientEvents`, g_active.c:567). */
export const FALL_DAMAGE_MEDIUM = 5;

/** A far fall's damage (`ClientEvents`, g_active.c:565). */
export const FALL_DAMAGE_FAR = 10;

/** `ClientTimerActions` runs its actions once per this much sim time (g_active.c:412). */
const TIMER_ACTION_MSEC = 1000;

/** Regeneration's big heal, below the max (`g_active.c:443`). */
const REGEN_HEAL_LARGE = 15;

/** Its small one, from a tenth over the max up to twice it (`g_active.c:450`). */
const REGEN_HEAL_SMALL = 5;

/** The big heal stops here rather than at the max (`g_active.c:444`). */
const REGEN_OVER_MAX = 1.1;

/** `P_DamageFeedback` caps a tick's hurt at a byte (g_active.c:53). */
const DAMAGE_COUNT_MAX = 255;

/** The direction byte a hurt from the world sends, which centres the blood (g_active.c:62–63). */
const WORLD_DAMAGE_BYTE = 255;

/** The three deaths `player_die` plays in turn. */
const DEATH_ANIMS = [ANIM.BOTH_DEATH1, ANIM.BOTH_DEATH2, ANIM.BOTH_DEATH3] as const;

/**
 * The max health a handicap gives (`ClientUserinfoChanged`, g_client.c:767–771): the handicap,
 * 1 to 100, with anything else counting as 100.
 */
function maxHealthFor(handicap: number): number {
  return handicap >= 1 && handicap <= 100 ? handicap : 100;
}

/** What a life is lived in. */
export interface PlayerLifeOptions {
  /** The client's entity. Its `client` is the slot, and everything else is read off it. */
  entity: GameEntity;
  /**
   * The match, whose clock the life keeps time by, where a corpse goes, and where the death is
   * announced.
   */
  level: Level;
  /**
   * `player_die`'s own static (`g_combat.c:441`): which of the three deaths plays next.
   *
   * Quake 3 keeps one for the whole game rather than one per player, so two clients dying in a row
   * play different deaths. Passing it in is how several lives share the one counter.
   */
  deaths?: DeathCounter;
  /**
   * `ClientSpawn`: put this client in the world with a fresh life.
   *
   * The life decides *when* a player comes back — the death has played and attack is pressed, or
   * the forced respawn is up — and the lifecycle decides *where*, because choosing a spawn point
   * needs the map. Left out, the player comes back where they fell, which is what a test that has
   * no lifecycle wants.
   */
  spawnClient?: () => void;
  /**
   * `FireWeapon` (`g_weapon.c:802`): what an `EV_FIRE_WEAPON` in the move's ring means.
   *
   * The move decides that a shot went off; what the shot *does* is the game module's, and it
   * happens here rather than in the move because it needs the world the move has no access to.
   * A life given none is a player whose gun makes a noise and nothing else, which is what the
   * movement tests want.
   */
  fireWeapon?: (state: PlayerState) => void;
  /**
   * `Weapon_HookFree` (`g_combat.c:455–457`): let go of the hook this client has out.
   *
   * `player_die` frees it before anything else it does, because a hook is the one thing a player
   * leaves behind that goes on acting on them: the pull is on the player state, and a corpse
   * being reeled in is what not doing this looks like.
   */
  freeHook?: () => void;
  /**
   * `TeleportPlayer` (`g_misc.c:79–124`): the holdable's use. The move itself is the lifecycle's,
   * because it needs the map: the life only hears the event.
   *
   * A life given none is a player whose teleporter fires and goes nowhere, which is what a test
   * of the event alone wants.
   */
  teleportPlayer?: () => void;
  /**
   * `g_forcerespawn`, in milliseconds: how long a body may lie there before it comes back whether
   * its player presses anything or not, or 0 for never (`g_active.c:1002–1006`).
   *
   * Read at the death rather than captured, since the cvar may be set mid-match. A life given
   * none takes Quake 3's own {@link FORCE_RESPAWN}, which is what a test with no cvars wants.
   */
  forceRespawn?: () => number;
  /**
   * Whether the dead must stay down, as Clan Arena's do until the round is over. A life given none
   * respawns as Quake 3's does.
   */
  respawnHeld?: () => boolean;
  /**
   * `g_gametype`, as `OnSameTeam` reads it (`g_team.c:170`): the teamkill test is only a test in a
   * team game, and below `GT_TEAM` nobody shares a team. A life that is not told has no teams.
   */
  gametype?: () => number;
  /**
   * The rules of play, read as they stand at each use. A life given none plays by id's defaults.
   */
  rules?: Readonly<Rules>;
  /**
   * `AddScore` (`g_combat.c:52`): credit a kill, a suicide, a teamkill or a death nobody caused
   * to the client it belongs to, with the origin a score plum would pop from.
   *
   * The score lives on the client and its team, and `AddScore` ends in `CalculateRanks`, both of
   * which are the match's — so the life hands the scoring back rather than reaching for it. A life
   * given none is a death that leaves the score alone, which is what a life test wants.
   */
  addScore?: (target: GameEntity, origin: Vec3, score: number) => void;
  /**
   * `Cmd_Score_f` (`g_cmds.c:105-107`): send the dead player their own board, since the score
   * just changed under them. The match builds it; a life given none sends nothing.
   */
  sendScoreboard?: (clientNum: number) => void;
  /**
   * `TossClientItems` (`g_combat.c:564`): the weapon in hand and the running powerups fall out of
   * the body. It needs the item table and the map, which are the match's, so the life hands the
   * drop back. A life given none leaves nothing behind, which is what a life test wants.
   */
  tossItems?: () => void;
}

/** `player_die`'s static, shared by every client on the map. */
export interface DeathCounter {
  /** Which of {@link DEATH_ANIMS} the next death plays. */
  next: number;
}

/**
 * What a spawn hands out beyond `ClientSpawn`'s own, which the port's settings decide.
 *
 * Quake 3 spawns a player with the machinegun and the gauntlet because everything else is a
 * pickup, and the map's items are the pickups — so this is off, and the two settings
 * here are testing aids for the maps and tests that want more than Quake 3's own spawn. Turning
 * `weapons` on is what the port did before it had items.
 */
export interface SpawnLoadout {
  /** `pcq_spawnArmor`: the armor the spawn starts with. */
  armor?: number;
  /** `pcq_spawnWeapons`: every weapon, with infinite ammo. */
  weapons?: boolean;
  /** `g_startingAmmoBonus_<w>`'s ammo, without the weapons, which a mode gives once live. */
  ammoBonus?: boolean;
  /** A mode's own spawn, which replaces Quake 3's and the settings above. */
  arena?: ArenaLoadout;
}

/** The weapons a spawn's ammo bonus is for, with the rule each reads. */
const AMMO_BONUS = [
  [WP.SHOTGUN, 'g_startingAmmoBonus_sg'],
  [WP.GRENADE_LAUNCHER, 'g_startingAmmoBonus_gl'],
  [WP.ROCKET_LAUNCHER, 'g_startingAmmoBonus_rl'],
  [WP.LIGHTNING, 'g_startingAmmoBonus_lg'],
  [WP.RAILGUN, 'g_startingAmmoBonus_rg']
] as const;

/**
 * The spawn of a mode that puts no weapons on the map: its whole rack, each with its own ammo,
 * and the gauntlet as ever.
 */
export interface ArenaLoadout {
  /** Each weapon given, with its ammo. */
  ammo: readonly (readonly [weapon: number, ammo: number])[];
  /** The one raised. */
  weapon: number;
  /** The spawn's health, in place of 25 over the max. */
  health: number;
  armor: number;
}

/** The player's life, around the move. See the module docs for the order of the calls. */
export class PlayerLife {
  /** The match the life is lived in: its clock, where a corpse goes, and who hears of a death. */
  private readonly level: Level;

  private readonly entity: GameEntity;
  private readonly client: GameClient;
  private readonly deaths: DeathCounter;
  private readonly spawnClient: () => void;
  private readonly fireWeapon: ((state: PlayerState) => void) | null;
  private readonly freeHook: (() => void) | null;
  private readonly forceRespawn: () => number;
  private readonly respawnHeld: () => boolean;
  private readonly addScore: ((target: GameEntity, origin: Vec3, score: number) => void) | null;
  private readonly sendScoreboard: ((clientNum: number) => void) | null;
  private readonly tossItems: (() => void) | null;
  private readonly gametype: () => number;
  private readonly rules: Readonly<Rules>;
  private readonly teleportPlayer: (() => void) | null;

  /** @param options - The entity the life is lived on, and what it shares with the map. */
  constructor(options: PlayerLifeOptions) {
    const client = options.entity.client;
    if (!client) throw new Error('player-life: the entity has no client slot');
    this.entity = options.entity;
    this.client = client;
    this.level = options.level;
    this.deaths = options.deaths ?? { next: 0 };
    this.spawnClient = options.spawnClient ?? (() => this.spawn());
    this.fireWeapon = options.fireWeapon ?? null;
    this.freeHook = options.freeHook ?? null;
    this.forceRespawn = options.forceRespawn ?? (() => FORCE_RESPAWN);
    this.respawnHeld = options.respawnHeld ?? (() => false);
    this.addScore = options.addScore ?? null;
    this.sendScoreboard = options.sendScoreboard ?? null;
    this.tossItems = options.tossItems ?? null;
    this.gametype = options.gametype ?? (() => GT.FFA);
    this.rules = options.rules ?? defaultRules();
    this.teleportPlayer = options.teleportPlayer ?? null;
  }

  /** `FL_GODMODE`. Live: toggling it takes effect on the next hit. */
  get god(): boolean {
    return (this.entity.flags & FL.GODMODE) !== 0;
  }

  set god(on: boolean) {
    if (on) this.entity.flags |= FL.GODMODE;
    else this.entity.flags &= ~FL.GODMODE;
  }

  /** `client->pers.maxHealth`: the handicap, as last given. */
  get handicap(): number {
    return this.client.pers.maxHealth;
  }

  /** `ET_INVISIBLE`: gibbed, so no body is drawn, no landing hurts and no hit lands. */
  private get gibbed(): boolean {
    return !this.entity.takedamage;
  }

  /**
   * `ClientUserinfoChanged` (`g_client.c:767–773`): a new handicap sets the max health at once.
   * Health over it then drains a point a second, as any over the max does, and each spawn starts
   * 25 over it.
   *
   * @param handicap - The userinfo's `handicap`.
   */
  setHandicap(handicap: number): void {
    this.client.pers.maxHealth = handicap;
    this.client.ps.stats[STAT.MAX_HEALTH] = maxHealthFor(handicap);
  }

  /**
   * `ClientSpawn`'s second half (`g_client.c:1152–1243`): the life the player is given.
   *
   * Where they appear is the lifecycle's — `ClientSpawn` picks a spawn point and puts them
   * there. This is what they arrive with: health 25 over the max and draining back to it, the
   * loadout, and a body that can be hurt again and dies as a player does. Attack must be let go
   * before the gun fires or the player can jump, and for the first 100 ms they cannot reach full
   * speed.
   *
   * Q3 then runs one 100 ms think "to drop exactly to the floor"; the port leaves that to the
   * first ticks, as its first spawn always has.
   *
   * @param loadout - What the port's settings add to Quake 3's own.
   */
  spawn(loadout: SpawnLoadout = {}): void {
    const state = this.client.ps;
    const maxHealth = maxHealthFor(this.client.pers.maxHealth);
    const { arena } = loadout;

    if (arena) {
      state.stats[STAT.WEAPONS] = 1 << WP.GAUNTLET;
      for (const [id, ammo] of arena.ammo) {
        state.stats[STAT.WEAPONS] |= 1 << id;
        state.ammo[id] = ammo;
      }
    } else {
      state.stats[STAT.WEAPONS] = (1 << WP.MACHINEGUN) | (1 << WP.GAUNTLET);
      state.ammo[WP.MACHINEGUN] = 100;
    }
    state.ammo[WP.GAUNTLET] = AMMO_INFINITE;
    if (!arena && loadout.ammoBonus) {
      for (const [weapon, rule] of AMMO_BONUS) state.ammo[weapon] = this.rules[rule];
    }

    // "The highest weapon owned is the one raised" (`g_client.c:1230–1236`), which of those two
    // is the machinegun — Q3 gives you the gauntlet and never starts you with it. The rule is
    // here rather than a constant because a spawn point's own targets can hand out a weapon, and
    // that is what makes you come up holding it when a map brings them.
    for (let i = MAX_WEAPONS - 1; i > 0; i--) {
      if (state.stats[STAT.WEAPONS] & (1 << i)) {
        state.weapon = i;
        break;
      }
    }
    if (arena) state.weapon = arena.weapon;
    state.weaponstate = WEAPON_READY;

    if (!arena && (loadout.weapons ?? false)) {
      // `pcq_spawnWeapons`: the rest of the rack, for a map with no items and for the tests that
      // want a gun in hand with ammo in it. It is after the line above on purpose — it changes
      // what you own, not what you hold.
      for (const id of ALL_WEAPONS) {
        state.stats[STAT.WEAPONS] |= 1 << id;
        state.ammo[id] = AMMO_INFINITE;
      }
    }

    state.stats[STAT.MAX_HEALTH] = maxHealth;
    state.stats[STAT.HEALTH] = arena
      ? arena.health
      : healthLimit(this.rules, state.stats) + this.rules.g_startingHealthBonus;
    state.stats[STAT.ARMOR] = arena ? arena.armor : (loadout.armor ?? 0);
    state.stats[STAT.ARMOR_TIER] = ARMOR_TIER.YA;
    this.entity.health = state.stats[STAT.HEALTH];

    state.pmType = PM_NORMAL;
    state.pmFlags |= PMF_RESPAWNED | PMF_TIME_KNOCKBACK;
    state.pmTime = SPAWN_KNOCKBACK_TIME;
    state.legsAnim = ANIM.LEGS_IDLE;
    state.torsoAnim = ANIM.TORSO_STAND;

    this.client.respawnTime = this.level.time;
    this.client.timeResidual = 0;
    this.client.armorResidual = 0;
    this.client.damageBlood = 0;
    this.client.damageArmor = 0;
    this.client.damageFromWorld = false;
    this.entity.takedamage = true;
    this.entity.flags &= ~FL.NO_KNOCKBACK;
    // `ent->die = player_die` (`g_client.c:1157`), which a death swaps for the corpse's.
    this.entity.die = (_self, inflictor, attacker, _points, mod) =>
      this.playerDie(inflictor, attacker, mod);

    // The box the world links a new player with (`g_client.c:1162–1163`): a standing one, until
    // their first move gives the world the box that move ended in.
    const bounds = playerBounds(false);
    this.entity.r.mins = copy(bounds.mins);
    this.entity.r.maxs = copy(bounds.maxs);

    // `ClientSpawn` (`g_client.c:1135`). A respawn raises no event: a client sees one by the
    // count going up (`CG_TransitionPlayerState`, `cg_playerstate.c:511–513`), which works for
    // a client that missed the snapshot the spawn happened on, as an event would not.
    this.client.ps.persistant[PERS.SPAWN_COUNT]++;
  }

  /**
   * `map_restart 0`: an empty body queue, the deaths back at the first, and a fresh spawn.
   * Clearing the projectiles is the weapon system's part.
   */
  restart(): void {
    clearBodyQue(this.level);
    this.deaths.next = 0;
    this.spawnClient();
  }

  /**
   * Start a tick, before `pmove`: `ClientThink_real`'s preamble. A player at no health moves
   * as a corpse (`g_active.c:834–838`).
   */
  beginTick(): void {
    const state = this.client.ps;
    state.pmType = state.stats[STAT.HEALTH] <= 0 ? PM_DEAD : PM_NORMAL;
  }

  /**
   * `ClientEvents` (`g_active.c:537–571`): the landings that hurt, and the shots the move fired.
   * A medium fall costs 5 and a far one 10, from the world. The landing plays its own sound, so
   * it holds off the pain sound first.
   *
   * The events come out of the move's own ring rather than from a return value, which is why the
   * caller has to say where it had got to: the ring is two deep and the sequence only rises, so
   * "since when" is the only question that has an answer.
   *
   * @param since - `ps.eventSequence` as it stood before the move ran.
   */
  clientEvents(since: number): void {
    const state = this.client.ps;
    for (const { event } of eventsSince(state, since)) {
      switch (eventNumber(event)) {
        case EV.FALL_MEDIUM:
        case EV.FALL_FAR: {
          // `s.eType != ET_PLAYER`: a gibbed player has nothing left to land. Then `dmflags`
          // (`g_active.c:562`), and Clan Arena has no falling damage (`fallingdamage 0`).
          if (this.gibbed || this.rules.dmflags & DF_NO_FALLING || this.gametype() === GT.CA) break;
          const far = eventNumber(event) === EV.FALL_FAR;
          this.entity.painDebounceTime = this.level.time + FALL_PAIN_DEBOUNCE;
          damage(
            this.level,
            this.entity,
            null,
            null,
            null,
            far ? FALL_DAMAGE_FAR : FALL_DAMAGE_MEDIUM,
            0,
            MOD.FALLING
          );
          break;
        }

        case EV.FIRE_WEAPON:
          this.fireWeapon?.(state);
          break;

        // The teleporter (`g_active.c:577–628`): the flags it drops are the teams'; the
        // spawn-point choice and the move itself need the map, so the lifecycle owns them.
        case EV.USE_ITEM1:
          this.teleportPlayer?.();
          break;

        // The medkit (`g_active.c:630–633`) sets health to 25 over the limit, from wherever it
        // was — over the limit is exactly where it can be used, the refusal being the move's.
        case EV.USE_ITEM2:
          state.stats[STAT.HEALTH] = healthLimit(this.rules, state.stats) + MEDKIT_HEAL;
          this.entity.health = state.stats[STAT.HEALTH];
          break;

        default:
          break;
      }
    }
  }

  /**
   * The tail of `ClientThink_real` (`g_active.c:997–1019`), after the move and the weapons.
   *
   * A dead player respawns once the death has played for 1.7 s and attack is pressed, or 20 s
   * after that whatever is pressed (`g_active.c:997–1014`); a living one gets the
   * once-a-second actions instead.
   *
   * @param cmd - This tick's input; only the attack button is read.
   * @param msec - Length of the tick.
   */
  endTick(cmd: Pick<UserCmd, 'buttons'>, msec: number): void {
    const state = this.client.ps;
    const time = this.level.time;
    if (state.stats[STAT.HEALTH] <= 0) {
      if (time > this.client.respawnTime && !this.respawnHeld()) {
        // `g_forcerespawn` 0 is never: the player waits for the button however long it takes, and
        // a bot, which presses nothing, stays where it fell.
        const after = this.forceRespawn();
        const forced = after > 0 && time - this.client.respawnTime > after;
        if (forced || cmd.buttons & BUTTON_ATTACK) this.respawn();
      }
    } else {
      this.timerActions(state, msec);
    }
  }

  /**
   * `ClientEndFrame` (`g_active.c:1085–1155`), reduced to what the port has: the world's effects
   * on the player, the frame's hurts become what the view shows, the fry's loop is set, and
   * everybody else's picture of this player is rebuilt.
   *
   * It is a frame's work rather than a think's, which is why it is not the line above. A client
   * may think several times in one frame or not at all, and the feedback is what the client is
   * shown once, at the end, however many hurts reached it.
   *
   * The rebuild is the think's again, for what came after it: a hurt's event, and a move's third.
   * The entity state is only ever made out of the player state, so the two cannot drift — and it
   * snaps the origin and the angles to whole units, as `ClientEndFrame` asks it to, which is why a
   * corpse lies at a whole number. A second event pending goes out on its own, as the think's does.
   */
  endFrame(): void {
    this.worldEffects();
    this.damageFeedback(this.client.ps);
    // "FIXME: get rid of ent->health" is Quake 3's own note on this line. What still needs it is
    // a corpse, which is handed the health the player died with and has no player state to read.
    this.entity.health = this.client.ps.stats[STAT.HEALTH];
    this.setClientSound();
    playerStateToEntityState(this.client.ps, this.entity.s, true);
    sendPendingPredictableEvents(this.level, this.client.ps);
  }

  /**
   * `P_WorldEffects` (`g_active.c:99–166`): the air a player has left and what being out of it
   * costs, then what lava and slime cost.
   *
   * Under water the air runs out 12 s after the last frame out of it, the battle suit keeping it
   * topped up, and then each second hurts, through armor: 4 the first time and 2 more each time
   * after, up to 15. Each hurt holds off the pain event everyone else would hear; the hurt
   * player's own client hears it in their health, and gurgles it, or drowns, with the head under
   * (cgame's `CG_WaterLevel`). The count is kept on the entity and only a frame out of the water
   * resets it, so a respawn under water starts where the last life left off.
   */
  private worldEffects(): void {
    const { client, entity, level } = this;
    const time = level.time;
    if (client.noclip) {
      client.airOutTime = time + AIR_OUT_TIME;
      return;
    }

    const state = client.ps;
    const envirosuit = state.powerups[PW.BATTLESUIT] > time;

    if (entity.waterlevel === 3) {
      if (envirosuit) client.airOutTime = time + SUIT_AIR_TIME;
      if (client.airOutTime < time) {
        client.airOutTime += DROWN_INTERVAL;
        if (state.stats[STAT.HEALTH] > 0) {
          entity.damage = Math.min(entity.damage + DROWN_DAMAGE_STEP, DROWN_DAMAGE_MAX);
          entity.painDebounceTime = time + DROWN_PAIN_DEBOUNCE;
          damage(level, entity, null, null, null, entity.damage, DAMAGE_NO_ARMOR, MOD.WATER);
        }
      }
    } else {
      client.airOutTime = time + AIR_OUT_TIME;
      entity.damage = DROWN_DAMAGE_STEP;
    }

    if (entity.waterlevel && entity.watertype & (CONTENTS.LAVA | CONTENTS.SLIME)) {
      this.sizzle(envirosuit);
    }
  }

  /**
   * `P_WorldEffects`' lava and slime (`g_active.c:146–165`), in Quake 3's rhythm: 30 and 10 a
   * water level, or the battle suit's pulse in their place, once a debounce has run out.
   *
   * Quake 3's debounce is the pain sound's, which `P_DamageFeedback` re-arms at the frame's end,
   * and only on a frame strictly after it. At Quake 3's 50 ms frame the hits come two 50 ms apart
   * every 750 ms, and the suit pulses 20 times a second; at the port's 8 ms, Quake 3's code would
   * hurt once every 704 ms. So the check runs on the first of the port's frames in each of Quake
   * 3's ({@link Level.q3FrameTime}), against a debounce of its own that only these hurts re-arm,
   * at those frames' times. Other pain does not move it, where in Quake 3 it would.
   */
  private sizzle(envirosuit: boolean): void {
    const { client, entity, level } = this;
    const frameTime = level.q3FrameTime();
    if (level.previousTime >= frameTime) return;

    const state = client.ps;
    if (state.stats[STAT.HEALTH] <= 0 || entity.sizzleDebounceTime > frameTime) return;
    if (envirosuit) {
      addEvent(entity, EV.POWERUP_BATTLESUIT, 0, level.time);
      return;
    }

    const before = client.damageBlood + client.damageArmor;
    const { waterlevel, watertype } = entity;
    if (watertype & CONTENTS.LAVA) {
      damage(level, entity, null, null, null, LAVA_DAMAGE * waterlevel, 0, MOD.LAVA);
    }
    if (watertype & CONTENTS.SLIME) {
      damage(level, entity, null, null, null, SLIME_DAMAGE * waterlevel, 0, MOD.SLIME);
    }
    // `P_DamageFeedback`'s re-arm: a hurt that was taken, by a player it has not killed.
    const hurt = client.damageBlood + client.damageArmor > before;
    if (hurt && state.pmType !== PM_DEAD && frameTime > entity.sizzleDebounceTime) {
      entity.sizzleDebounceTime = frameTime + PAIN_DEBOUNCE;
    }
  }

  /**
   * `G_SetClientSound` (`g_active.c:175–187`): the fry's loop while the player stands in lava or
   * slime, which the entity state carries to everyone, and nothing otherwise.
   */
  private setClientSound(): void {
    const { entity } = this;
    const frying = entity.waterlevel && entity.watertype & (CONTENTS.LAVA | CONTENTS.SLIME);
    this.client.ps.loopSound = frying ? this.level.sndFry : 0;
  }

  /** `ClientRespawn` (`g_client.c:530–534`): leave the body behind, then spawn afresh. */
  private respawn(): void {
    copyToBodyQue(this.level, this.entity);
    this.spawnClient();
  }

  /**
   * `player_die` (`g_combat.c:434–664`), reduced to what the port has: the player's
   * {@link GameEntity.die} from their spawn to their death.
   *
   * Everyone is told of it, by an obituary sent to every client, naming the dead, the killer and
   * the means. The killer is the attacker if a client did it, and the world otherwise — a fall,
   * or the world's own entity standing in for nobody.
   *
   * The view turns level, to the yaw the player last spawned facing, because it is copied from
   * the entity's own angles and nothing but a spawn sets those here. The death camera looks
   * along the dead yaw instead, which `LookAtKiller` points at whoever did it. A death that takes
   * health to −40 or below gibs; any other plays the next of the three deaths, and leaves a body
   * that `body_die` gibs once it is hurt past −40.
   *
   * @param inflictor - What did it, or the world's entity.
   * @param attacker - Who answers for it, or the world's entity.
   * @param mod - The `MOD_*` it carries.
   */
  private playerDie(inflictor: GameEntity, attacker: GameEntity, mod: number): void {
    const state = this.client.ps;
    const self = this.entity;
    if (state.pmType === PM_DEAD) return;
    if (this.level.intermissiontime) return;

    // A shot that moved the player back for its traces puts them where they are first, so the body
    // falls there, and the shot's own restore passes them by (unlagged's `player_die`).
    unTimeShiftClient(this.level, self);

    checkAlmostCapture(this.level, self, attacker);

    // Before the death itself, where `g_combat.c:455–457` has it: a hook left out would go on
    // hauling the body around, the pull being on the player state rather than on the hook.
    this.freeHook?.();

    state.pmType = PM_DEAD;

    let killer = attacker.s.number;
    if (killer < 0 || killer >= MAX_CLIENTS) killer = ENTITYNUM_WORLD;

    // "Broadcast the death event to everyone."
    const obituary = tempEntity(this.level, self.r.currentOrigin, EV.OBITUARY);
    obituary.s.eventParm = mod;
    obituary.s.otherEntityNum = self.s.number;
    obituary.s.otherEntityNum2 = killer;
    obituary.r.svFlags = SVF.BROADCAST;

    self.enemy = attacker;
    state.persistant[PERS.KILLED]++;

    // Scoring (`g_combat.c:505–543`). Whose kill it is decides the sign: a kill by someone else
    // is worth one to them, and anything else — the victim's own hand, a team mate, or a death
    // with no client behind it — is worth one less to whoever is nearest to blame.
    if (attacker.client) {
      attacker.client.lastkilledClient = self.s.number;
      if (attacker === self || onSameTeam(this.gametype(), self, attacker)) {
        this.addScore?.(attacker, self.r.currentOrigin, -1);
      } else {
        this.addScore?.(attacker, self.r.currentOrigin, 1);

        // The gauntlet's humiliation (`g_combat.c:513–525`), which the one killed hears too, and
        // two kills close enough together (`:529–538`).
        if (mod === MOD.GAUNTLET) {
          attacker.client.ps.persistant[PERS.GAUNTLET_FRAG_COUNT]++;
          awardSprite(attacker.client, EF_AWARD_GAUNTLET, this.level.time);
          state.persistant[PERS.PLAYEREVENTS] ^= PLAYEREVENT.GAUNTLETREWARD;
        }
        if (this.level.time - attacker.client.lastKillTime < CARNAGE_REWARD_TIME) {
          attacker.client.ps.persistant[PERS.EXCELLENT_COUNT]++;
          awardSprite(attacker.client, EF_AWARD_EXCELLENT, this.level.time);
        }
        attacker.client.lastKillTime = this.level.time;
      }
    } else {
      this.addScore?.(self, self.r.currentOrigin, -1);
    }

    // `Team_FragBonuses( self, inflictor, attacker )` (`g_combat.c:549`): what the kill was
    // worth to Capture the Flag, which is not cumulative with the frag and not with itself.
    teamFragBonuses(this.level, self, attacker);

    // "If I committed suicide, the flag does not fall, it returns" (`g_combat.c:547–561`).
    // The powerup is cleared here and not left to the clearing further down, because
    // `TossClientItems` runs in between and would drop the flag that has just gone home.
    if (mod === MOD.SUICIDE) {
      if (state.powerups[PW.REDFLAG]) {
        teamReturnFlag(this.level, TEAM.RED);
        state.powerups[PW.REDFLAG] = 0;
      } else if (state.powerups[PW.BLUEFLAG]) {
        teamReturnFlag(this.level, TEAM.BLUE);
        state.powerups[PW.BLUEFLAG] = 0;
      }
    }

    // `TossClientItems( self )`: the weapon in hand and every running powerup fall out of the body.
    // It runs *here*, before the powerups are cleared a few lines down, which is the whole of why
    // the C calls it where it does. It tosses in nodrop too (`g_combat.c:564`), where what lands
    // is taken away and a flag sent home.
    this.tossItems?.();

    // `Cmd_Score_f( self )` (`g_combat.c:571`): the board the player is about to be shown, sent as
    // they die, since their own score and their killer's have just moved.
    this.sendScoreboard?.(self.s.number);

    // "Can still be gibbed."
    self.takedamage = true;

    self.s.weapon = WP.NONE;
    self.s.powerups = 0;
    // What the world sees of them now (`g_combat.c:594, 604`): a corpse, which a shot still hits
    // and the living walk through, and no taller than one.
    self.r.contents = CONTENTS.CORPSE;

    self.s.angles.x = 0;
    self.s.angles.z = 0;
    this.lookAtKiller(inflictor, attacker);
    state.viewangles = copy(self.s.angles);

    self.s.loopSound = 0;
    self.r.maxs.z = DEAD_HEIGHT;

    this.client.respawnTime = this.level.time + RESPAWN_DELAY;
    state.powerups.fill(0);

    // "Never gib in a nodrop" (`g_combat.c:613–616`), but always for a suicide. `g_blood` is not
    // ported, and is always on.
    const contents = this.level.pointContents(self.r.currentOrigin, -1);
    if ((self.health <= GIB_HEALTH && !(contents & CONTENTS.NODROP)) || mod === MOD.SUICIDE) {
      gibEntity(this.level, self, killer);
    } else {
      // A death past gibbing is held a point short of it (`g_combat.c:638–640`), so the body is
      // still whole to be shot apart.
      if (self.health <= GIB_HEALTH) {
        self.health = GIB_HEALTH + 1;
        state.stats[STAT.HEALTH] = self.health;
      }
      const anim = DEATH_ANIMS[this.deaths.next];
      state.legsAnim = nextAnim(state.legsAnim, anim);
      state.torsoAnim = nextAnim(state.torsoAnim, anim);
      // `EV_DEATH1 + lastDeath` (`g_combat.c:647`): the three deaths are three consecutive
      // events, so which one played is the event itself rather than anything it carries.
      addEvent(self, EV.DEATH1 + this.deaths.next, killer, this.level.time);
      // "The body can still be gibbed."
      self.die = (body) => bodyDie(this.level, body);
      this.deaths.next = (this.deaths.next + 1) % DEATH_ANIMS.length;
    }

    this.level.linkEntity(self);
  }

  /**
   * `LookAtKiller` (`g_combat.c:217–230`): turn the death camera towards whoever did it, or
   * failing that towards what did, from where each was last linked. A player who is both looks
   * along their own yaw.
   *
   * A player killed by their own blast, or by a fall, faces the world's entity, whose origin is
   * the map's (0, 0, 0).
   */
  private lookAtKiller(inflictor: GameEntity, attacker: GameEntity): void {
    const self = this.entity;
    let dir: Vec3;
    if (attacker !== self) {
      dir = sub(attacker.s.pos.trBase, self.s.pos.trBase);
    } else if (inflictor !== self) {
      dir = sub(inflictor.s.pos.trBase, self.s.pos.trBase);
    } else {
      this.client.ps.stats[STAT.DEAD_YAW] = Math.trunc(self.s.angles.y);
      return;
    }
    // Into an int stat, which truncates.
    this.client.ps.stats[STAT.DEAD_YAW] = Math.trunc(vectorToYaw(dir));
  }

  /**
   * `ClientTimerActions` (`g_active.c:403–467`): once a second, regeneration heals or the health
   * over the limit drains, and the armor over the limit drains either way.
   *
   * The heal has two speeds (`:441–454`): below the limit it is 15 a second, capped at a tenth
   * over it, and from there to twice the limit it is 5, capped there. Each heal raises
   * `EV_POWERUP_REGEN`, which is what plays its sound and pulses its icon. The drain is the heal's
   * `else`, so a regenerating player's health never counts down — the armor's is apart from both,
   * so armor is still lost while it runs.
   *
   * Under `g_countdownHold` the seconds of a round's countdown pass with nothing done in them.
   *
   * The armor loses a point per its tier's `armor_decayTime`, 0 being none, on a clock of its own.
   * It runs from the spawn as the second's does, so at id's 1000 its points fall on the second's
   * ticks, and a countdown does not hold it.
   */
  private timerActions(state: PlayerState, msec: number): void {
    const held = this.rules.g_countdownHold !== 0 && this.level.roundTime > 0;
    this.client.timeResidual += msec;
    while (this.client.timeResidual >= TIMER_ACTION_MSEC) {
      this.client.timeResidual -= TIMER_ACTION_MSEC;
      if (held) continue;

      const max = healthLimit(this.rules, state.stats);
      if (state.powerups[PW.REGEN]) {
        if (state.stats[STAT.HEALTH] < max) {
          state.stats[STAT.HEALTH] += REGEN_HEAL_LARGE;
          if (state.stats[STAT.HEALTH] > max * REGEN_OVER_MAX) {
            state.stats[STAT.HEALTH] = Math.trunc(max * REGEN_OVER_MAX);
          }
          addEvent(this.entity, EV.POWERUP_REGEN, 0, this.level.time);
        } else if (state.stats[STAT.HEALTH] < max * 2) {
          state.stats[STAT.HEALTH] += REGEN_HEAL_SMALL;
          if (state.stats[STAT.HEALTH] > max * 2) state.stats[STAT.HEALTH] = max * 2;
          addEvent(this.entity, EV.POWERUP_REGEN, 0, this.level.time);
        }
      } else if (state.stats[STAT.HEALTH] > max) {
        state.stats[STAT.HEALTH]--;
      }
    }

    const interval = tierRule(this.rules, 'decayTime', state.stats[STAT.ARMOR_TIER]);
    if (interval <= 0) {
      this.client.armorResidual = 0;
      return;
    }
    this.client.armorResidual += msec;
    while (this.client.armorResidual >= interval) {
      this.client.armorResidual -= interval;
      if (state.stats[STAT.ARMOR] > healthLimit(this.rules, state.stats)) state.stats[STAT.ARMOR]--;
    }
  }

  /**
   * `P_DamageFeedback` (`g_active.c:37–88`): turn the frame's hurts into what the view shows —
   * how much, and from where — and a pain sound, at most one every 700 ms. A dead player gets
   * none; the death has its own sound.
   */
  private damageFeedback(state: PlayerState): void {
    if (state.pmType === PM_DEAD) return;

    const count = Math.min(this.client.damageBlood + this.client.damageArmor, DAMAGE_COUNT_MAX);
    if (count === 0) return;

    if (this.client.damageFromWorld) {
      state.damagePitch = WORLD_DAMAGE_BYTE;
      state.damageYaw = WORLD_DAMAGE_BYTE;
      this.client.damageFromWorld = false;
    } else {
      const angles = vectorToAngles(this.client.damageFrom);
      state.damagePitch = angleByte(angles.x);
      state.damageYaw = angleByte(angles.y);
    }

    const time = this.level.time;
    if (time > this.entity.painDebounceTime && !this.god) {
      this.entity.painDebounceTime = time + PAIN_DEBOUNCE;
      // `EV_PAIN` carries the health that is left, which is what picks the grunt (`CG_PainEvent`).
      addEvent(this.entity, EV.PAIN, state.stats[STAT.HEALTH], time);
      state.damageEvent++;
    }

    state.damageCount = count;
    this.client.damageBlood = 0;
    this.client.damageArmor = 0;
    this.client.damageKnockback = 0;
  }
}

/**
 * An angle as the byte Q3 sends it: a 256th of a turn, truncated into an int, then masked to
 * the 8 bits the player state carries it in. `vectoangles`' negative pitches wrap round.
 */
function angleByte(degrees: number): number {
  return Math.trunc((degrees / 360) * 256) & 255;
}
