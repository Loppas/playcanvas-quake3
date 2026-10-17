import type { PlayerState } from '../net/protocol';
import { clearClientForSpawn } from './client';
import { CONTENTS, MASK } from './constants';
import { setEntityOrigin, type GameEntity } from './game-entity';
import { Level } from './level';
import { PlayerLife, type SpawnLoadout } from './player-life';
import type { Rules } from './rules';
import { createIdlePlayerState } from './types';
import { copy, vec3, type Vec3 } from './vec3';

/**
 * A client slot with a life in it, for the tests that drive one without a game module.
 *
 * `Game.clientSpawn` is what puts a client in the world on the real path — it picks the spawn
 * point, clears the three lifetimes and links the entity. The tests below it want none of the
 * choosing: they want a player standing at a known place with a fresh life, in the world where
 * a shot or a blast can find them, which is what this is.
 */

/** A spawned client: its entity, and the life lived on it. */
export interface SpawnedClient {
  entity: GameEntity;
  life: PlayerLife;
  /** The client slot's player state, which is what `pmove` runs over. */
  state: PlayerState;
}

/**
 * Put a client in the world at a known place, as `ClientSpawn` leaves one.
 *
 * @param options - Where the client stands, what it faces, and what its spawn hands out.
 */
export function spawnClient(
  options: {
    /** Where the client's origin sits, in Q3 units. */
    origin?: Vec3;
    /** The yaw it faces, in degrees. */
    yaw?: number;
    /** The userinfo's `handicap`, which sets the max health. */
    handicap?: number;
    /** `FL_GODMODE`. */
    god?: boolean;
    /** What the spawn hands out beyond Quake 3's own. */
    loadout?: SpawnLoadout;
    /**
     * The world to stand the client up in, taking slot 0 as `G_InitGame` does. Without one the
     * client gets a bare world of its own, which is all a test with nothing else in it needs.
     * It must link what it is told to, or nothing will find the client in it.
     */
    level?: Level;
    /** The slot to take, which is 0 unless the test wants a second client. */
    slot?: number;
    /**
     * `FireWeapon`, which `ClientEvents` reaches for every fire event the move raised. Without
     * one the gun still flashes and nothing comes out of it.
     */
    fireWeapon?: (state: PlayerState) => void;
    /**
     * `Weapon_HookFree`, which `player_die` reaches before the death itself. Without one the
     * client has no hook to let go of.
     */
    freeHook?: () => void;
    /** `g_forcerespawn` in milliseconds, or Quake 3's own 20 s without one. */
    forceRespawn?: () => number;
    /** Whether the match holds the dead down; never without one. */
    respawnHeld?: () => boolean;
    /**
     * `AddScore`, which `player_die` calls for the kill, the suicide, the teamkill and the death
     * nobody is credited with. Without one a test of a death sees only what the death did to the
     * body; the match's own scoring is `game.test.ts`'s.
     */
    addScore?: (target: GameEntity, origin: Vec3, score: number) => void;
    /**
     * `Cmd_Score_f`, which `player_die` reaches once the score has moved. Without one a test of a
     * death sees only what the death did to the body; the match's own send is `game.test.ts`'s.
     */
    sendScoreboard?: (clientNum: number) => void;
    /**
     * `TossClientItems`, which `player_die` reaches before the board. Without one a death leaves
     * nothing on the floor; the match's own toss is `game.test.ts`'s.
     */
    tossItems?: () => void;
    /** `g_gametype`, which `OnSameTeam` reads. Free-for-all without one. */
    gametype?: () => number;
    /** The rules of play. id's defaults without them. */
    rules?: Readonly<Rules>;
    /**
     * `TeleportPlayer`, which `ClientEvents` reaches for a teleporter's use: choosing a spot is
     * the lifecycle's, since it needs the map. Without one the teleporter is used and goes
     * nowhere, which is what a test of the event alone wants.
     */
    teleportPlayer?: () => void;
  } = {}
): SpawnedClient {
  const yaw = options.yaw ?? 0;
  const origin = options.origin ?? vec3();
  const level = options.level ?? new Level({ rules: options.rules });
  const slot = options.slot ?? 0;
  const entity = level.gentities[slot];
  entity.client = level.clients[slot];
  entity.inuse = true;
  entity.classname = 'player';
  // `player_die` turns the dead player's view to the entity's own yaw, which a spawn sets.
  entity.s.angles.y = yaw;

  const state = entity.client.ps;
  entity.client.pers.maxHealth = options.handicap ?? 100;

  /**
   * `ClientSpawn`: the one place this client stands, with a fresh life.
   *
   * The clearing is `ClientSpawn`'s own `memset`, which is what makes a spawn a fresh life rather
   * than a move. The clock and the two numbers a move is run at are kept, because Quake 3 sets
   * them afresh from `level.time` and its cvars and there is nothing here to set them from. The
   * entity is then put at the spot, made of a body, and linked, as `ClientSpawn` leaves it.
   */
  const place = (): void => {
    const client = entity.client!;
    const { commandTime, speed, gravity, persistant, ping, eventSequence } = client.ps;
    clearClientForSpawn(client);
    Object.assign(
      client.ps,
      createIdlePlayerState({ origin: copy(origin), viewangles: vec3(0, yaw, 0) })
    );
    // What the clearing keeps, kept: a whole fresh state assigned over the slot would take the
    // scoreboard, the ping and the event sequence with it, and none of those belong to one life.
    client.ps.persistant = persistant;
    client.ps.ping = ping;
    client.ps.eventSequence = eventSequence;
    client.ps.commandTime = commandTime;
    client.ps.clientNum = slot;
    if (speed) client.ps.speed = speed;
    if (gravity) client.ps.gravity = gravity;
    life.spawn(options.loadout);
    setEntityOrigin(entity, origin);
    entity.r.contents = CONTENTS.BODY;
    entity.clipmask = MASK.PLAYERSOLID;
    level.linkEntity(entity);
  };

  const life = new PlayerLife({
    entity,
    level,
    spawnClient: place,
    fireWeapon: options.fireWeapon,
    freeHook: options.freeHook,
    forceRespawn: options.forceRespawn,
    respawnHeld: options.respawnHeld,
    addScore: options.addScore,
    sendScoreboard: options.sendScoreboard,
    tossItems: options.tossItems,
    teleportPlayer: options.teleportPlayer,
    gametype: options.gametype,
    rules: options.rules
  });
  life.god = options.god ?? false;
  place();
  return { entity, life, state };
}
