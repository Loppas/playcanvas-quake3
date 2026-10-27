import { LocalGame } from '../local-game';
import type { PlayerState } from '../net/protocol';
import { Cvars } from '../settings/cvars';
import { createFlatWorldTrace } from '../sim/box-world';
import { angleToShort, shortToAngle } from '../sim/client';
import { SPAWN_LIFT } from '../sim/game';
import { ET, type GameEntity } from '../sim/game-entity';
import { mapOf, spawnSpot } from '../sim/map-test-fixtures';
import type { Level } from '../sim/level';
import type { PointContentsFn, TraceFn } from '../sim/types';
import { vec3, type Vec3 } from '../sim/vec3';
import { WP } from '../sim/weapons/constants';
import { PlayerView } from './player-view';

/**
 * A view over a real program, for the tests that drive one.
 *
 * `PlayerView` is a client and nothing else: everything it knows it decoded out of a snapshot, so
 * a test of one needs a server to send it. This is that server — a {@link LocalGame} over the
 * trace the test chooses, with the player standing where it asks — and the handles into the match
 * itself that a test needs, because what the client was *told* is only half of what is being
 * tested. Nothing here is a shortcut: the commands go down the wire and the snapshots come back.
 */

export interface ViewWorldOptions {
  /**
   * Where the player's origin should end up, in Q3 units. The spawn point is put 9 units below
   * it, since that is what a spawn stands a player above.
   */
  origin?: Vec3;
  /** The yaw they face, in degrees. */
  yaw?: number;
  /** The pitch they face, in degrees; positive looks **down**, as Q3's does. */
  pitch?: number;
  /** The world to move in. Without one nothing is solid and the player falls. */
  trace?: TraceFn;
  /** What the world holds at a point, for the server and the client both. Without it, no water. */
  pointContents?: PointContentsFn;
  /** Cvars set before the map starts, which is where the match reads its settings. */
  cvars?: Record<string, string>;
  /** `random()`: the match's own, which picks a spawn point and scatters a shotgun. */
  random?: () => number;
  /**
   * More spawn spots beside the player's, for bots alone to begin on, each where a player's origin
   * should end up, as {@link origin} is.
   */
  spots?: Vec3[];
  /** Items the map places, for the tests that watch them stand and come back. */
  items?: readonly { classname: string; origin: Vec3 }[];
}

/**
 * The 8 ms frames after one that the view draws what it did: the client's clock runs about 5 ms
 * behind the newest snapshot as a frame begins, so the snapshot a frame brings back is made current
 * two frames on.
 */
export const CATCH_UP = 2;

/**
 * The 8 ms frames after an `addbot` for the bot to begin, raise its gun, and have its arrival's
 * effect come and go. In a level's first two seconds a freed slot is taken again at once, and the
 * client takes a new event in a slot it saw within an event window for the one it saw there
 * (`CG_ResetEntity`), so a test's first temp entity would go unheard.
 */
export const BOT_SETTLED = 120;

/** The bots `addbot` knows: two, in the two models the tests have. */
const BOT_FILES = [
  {
    path: 'scripts/bots.txt',
    text: [
      '{ name Sarge model sarge aifile bots/sarge_c.c }',
      '{ name Grunt model grunt aifile bots/grunt_c.c }'
    ].join('\n')
  }
];

/** A client of a running match, and the match it is a client of. */
export class ViewWorld {
  /** Every setting, as one store — the real one, since the match reads it as the app's does. */
  readonly cvars: Cvars;
  /** The program: a host, the match it runs, and this client's end of the wire. */
  readonly game: LocalGame;
  /** The client, which is what is being tested. */
  readonly view: PlayerView;

  /** @param options - Where the player stands, what they move through, and the match's settings. */
  constructor(options: ViewWorldOptions = {}) {
    const origin = options.origin ?? vec3(0, 0, 24);
    // Debug mode on, because `pcq_god` is a cheat and a store without it refuses to set one.
    this.cvars = new Cvars({ debugMode: true, print: () => {} });
    // The testing loadout, because the tests that drive this world fire guns the map would
    // otherwise hand out; a test of the loadout itself overrides it.
    this.cvars.set('pcq_spawnWeapons', '1');
    for (const [name, value] of Object.entries(options.cvars ?? {})) this.cvars.set(name, value);

    const trace = options.trace ?? createFlatWorldTrace();
    this.game = new LocalGame({
      cvars: this.cvars,
      map: {
        name: 'test',
        entities: mapOf(
          spawnSpot(
            vec3(origin.x, origin.y, origin.z - SPAWN_LIFT),
            options.yaw ?? 0,
            options.pitch ?? 0
          ),
          // `nohumans`, so the player still begins on theirs.
          ...(options.spots ?? []).map((spot) => ({
            ...spawnSpot(vec3(spot.x, spot.y, spot.z - SPAWN_LIFT)),
            nohumans: '1'
          })),
          ...(options.items ?? []).map((item) => ({
            classname: item.classname,
            origin: `${item.origin.x} ${item.origin.y} ${item.origin.z}`
          }))
        ),
        trace,
        pointContents: options.pointContents
      },
      random: options.random ?? (() => 0.5),
      botFiles: BOT_FILES
    });
    this.view = new PlayerView(this.game, trace, undefined, options.pointContents);
  }

  /** The world the match runs in, which a restart replaces. */
  get level(): Level {
    return this.game.game.level;
  }

  /**
   * Load the map again under the view, as a server's own `map` does: a latched setting turns the
   * restart into a load. Runs the test's frames until the view has the new gamestate.
   *
   * @param frame - One of the test's frames.
   */
  load(frame: () => void): void {
    const gamestate = this.game.gamestateMessageNum;
    this.cvars.set('sv_maxclients', '4');
    this.view.restart();
    for (let i = 0; i < 20 && this.game.gamestateMessageNum === gamestate; i++) frame();
    if (this.game.gamestateMessageNum === gamestate) throw new Error('no new gamestate came');
  }

  /** The client's entity in the match. */
  get entity(): GameEntity {
    return this.level.gentities[this.game.clientNum];
  }

  /**
   * The client's live player state in the match, which is what each snapshot is built from.
   *
   * A test that wants the player hurt, armed or moving writes it here rather than on the view:
   * the view's own copy is replaced by the next snapshot, as a client's is.
   */
  get state(): PlayerState {
    return this.level.clients[this.game.clientNum].ps;
  }

  /**
   * The command angles that would point the view where asked, given whatever `delta_angles` the
   * server has turned this client by.
   *
   * A spawn and a death both set those deltas — that is how a server points a client's view
   * without the next command putting it back — so a client that wants to go on looking somewhere
   * after one has to move its own angles to suit. A player does it with the mouse; a test does it
   * here.
   *
   * @param angles - Where the view should end up, in degrees.
   */
  aim(angles: Vec3): Vec3 {
    const { deltaAngles } = this.state;
    const held = (degrees: number, delta: number): number =>
      shortToAngle((((angleToShort(degrees) - delta) & 0xffff) << 16) >> 16);
    return vec3(
      held(angles.x, deltaAngles.x),
      held(angles.y, deltaAngles.y),
      held(angles.z, deltaAngles.z)
    );
  }

  /** The missiles in flight, as the entities the match holds rather than as they were sent. */
  missiles(): GameEntity[] {
    return this.entities((entity) => entity.s.eType === ET.MISSILE);
  }

  /**
   * This client's hook, in flight or caught, or `null` for none — as the match holds it.
   *
   * `ET_MISSILE` while it flies and `ET_GRAPPLE` once it has caught, which is also how a client
   * tells the two apart.
   */
  hook(): GameEntity | null {
    const found = this.entities(
      (entity) =>
        entity.s.weapon === WP.GRAPPLING_HOOK &&
        (entity.s.eType === ET.MISSILE || entity.s.eType === ET.GRAPPLE) &&
        entity.s.otherEntityNum === this.game.clientNum
    );
    return found[0] ?? null;
  }

  /** How this client's hook is doing, as `grapple.test.ts` names the three states. */
  hookPhase(): 'idle' | 'flying' | 'attached' {
    const hook = this.hook();
    if (!hook) return 'idle';
    return hook.s.eType === ET.GRAPPLE ? 'attached' : 'flying';
  }

  /** The entities in use that match, in increasing entity number. */
  private entities(wanted: (entity: GameEntity) => boolean): GameEntity[] {
    const found: GameEntity[] = [];
    for (let i = 0; i < this.level.numEntities; i++) {
      const entity = this.level.gentities[i];
      if (entity.inuse && wanted(entity)) found.push(entity);
    }
    return found;
  }
}
