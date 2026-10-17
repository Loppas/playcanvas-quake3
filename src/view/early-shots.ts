import { MAX_CLIENTS, TR, type PlayerState } from '../net/protocol';
import { CONTENTS, SURF } from '../sim/constants';
import { EV } from '../sim/events';
import type { HitscanRules } from '../sim/rules';
import { evaluateTrajectory } from '../sim/trajectory';
import type { PointContentsFn, TraceFn } from '../sim/types';
import { delagLines, unlaggedCovers } from '../sim/unlagged';
import { madd, vec3 } from '../sim/vec3';
import { WP } from '../sim/weapons/constants';
import {
  Q3Random,
  beamEndpoint,
  bulletEndpoint,
  firingSolution,
  shotgunWire,
  snapVectorTowards,
  traceShot,
  truncVector,
  type FiringSolution,
  type ShotgunRules
} from '../sim/weapons/hitscan';
import type { SolidEntity } from './client-trace';
import { shotgunBlast, type EntityEvent, type Players, type WorldEffect } from './entity-events';
import type { ViewSnapshot } from './snapshot-pool';

/**
 * The player's own hitscan shots drawn as the client predicts them, rather than when the server's
 * events for them come back — unlagged's `CG_PredictWeaponEffects` (`cg_unlagged.c`), which
 * Excessive Plus keeps under `xp_delagWeapons`.
 *
 * Each is worked out as the server works the shot out, from the same muzzle, the same seed and the
 * same rules, so it is drawn where the server's event would have drawn it. The server's event for
 * it is then left out. Only the trace is the client's own: it has the others only where it drew
 * them, which is where the server's rewind puts them too.
 */

/** `xp_delagWeapons`' bit for each weapon it draws early. */
const DELAG_BITS: Readonly<Partial<Record<number, number>>> = {
  [WP.MACHINEGUN]: 1,
  [WP.SHOTGUN]: 2,
  [WP.RAILGUN]: 8
};

/**
 * Whether the player's shots with a weapon are drawn early: the client asks for it, and the server
 * rewinds for that weapon, without which the shot would land somewhere else.
 *
 * @param weapon - The weapon fired.
 * @param delagWeapons - `xp_delagWeapons`.
 * @param unlagged - `xp_unlagged`, as the systeminfo carried it.
 */
export function delagged(weapon: number, delagWeapons: number, unlagged: number): boolean {
  const bit = DELAG_BITS[weapon];
  return bit !== undefined && (delagWeapons & bit) !== 0 && unlaggedCovers(weapon, unlagged);
}

/** A shot to draw early: the state that fired it, and the world as the client has it. */
export interface EarlyShot {
  /** The state the shot was fired from: where, which way, with what, and by whom. */
  ps: Pick<PlayerState, 'origin' | 'viewangles' | 'viewheight' | 'weapon' | 'clientNum'>;
  /** The server's seed for it, 0–255. */
  seed: number;
  /** `CG_Trace`, with everyone where the player aimed at them. */
  trace: TraceFn;
  /** The muzzle and the hitscan numbers, as the serverinfo carries them. */
  hitscan: Readonly<HitscanRules>;
  /** The shotgun's pattern, as the serverinfo carries it. */
  shotgun: Readonly<ShotgunRules>;
  /** Who a pellet struck, and this client's rail colour. */
  players: Players;
  /** What the world has at a point, for a pellet's bubbles; nothing anywhere when absent. */
  pointContents?: PointContentsFn;
}

/**
 * What a shot draws: a machinegun round's impact or blood, a shotgun blast's pellets, or a rail's
 * beam and its impact. Any other weapon draws nothing early.
 */
export function earlyShotEffects(shot: EarlyShot): WorldEffect[] {
  const { ps } = shot;
  const solution = solve(shot);
  switch (ps.weapon) {
    case WP.MACHINEGUN:
      return bullet(shot, solution);
    case WP.SHOTGUN: {
      // From where the blast's event would be, which is the muzzle in whole units.
      const start = truncVector(solution.muzzle);
      const wire = shotgunWire(solution.forward);
      const { seed, trace, players, shotgun, pointContents } = shot;
      return shotgunBlast(start, wire, seed, ps.clientNum, trace, players, shotgun, pointContents);
    }
    case WP.RAILGUN:
      return rail(shot, solution);
    default:
      return [];
  }
}

/** The shot's muzzle and aim, as the server works them out. */
function solve({ ps, hitscan }: EarlyShot): FiringSolution {
  const { g_muzzleForward: forward, g_muzzleSnap: snap } = hitscan;
  return firingSolution(ps.origin, ps.viewangles, ps.viewheight, forward, snap !== 0);
}

/** `Bullet_Fire`'s round as the server traces it, drawn where its impact would be. */
function bullet(shot: EarlyShot, solution: FiringSolution): WorldEffect[] {
  const { ps, hitscan } = shot;
  const { muzzle } = solution;
  const random = new Q3Random(shot.seed);
  const { g_spread_mg: spread, g_range_mg: range, g_bulletImpactSnap: snap } = hitscan;
  const end = bulletEndpoint(solution, () => random.random(), spread, range);
  const struck = traceShot(shot.trace, muzzle, end, ps.clientNum);
  if (struck.surfaceFlags & SURF.NOIMPACT || !struck.hit) return [];
  const origin = truncVector(snap ? snapVectorTowards(struck.endpos, muzzle) : struck.endpos);
  // Anyone in a player's slot bleeds, as unlagged's prediction has it.
  if (struck.entityNum < MAX_CLIENTS) return [{ type: 'blood', origin }];
  return [{ type: 'impact', weapon: WP.MACHINEGUN, origin, normal: struck.normal }];
}

/**
 * `weapon_railgun_fire`'s beam as the server traces it: through everyone, to the first solid, as
 * unlagged's prediction traces it with `CONTENTS_SOLID` alone.
 */
function rail(shot: EarlyShot, solution: FiringSolution): WorldEffect[] {
  const { ps, hitscan, players } = shot;
  const { muzzle, right, up } = solution;
  const struck = shot.trace(
    muzzle,
    vec3(),
    vec3(),
    beamEndpoint(solution, hitscan.g_range_rg),
    ps.clientNum,
    CONTENTS.SOLID
  );
  // No impact on the sky, as unlagged's prediction has it and the server's trail says.
  const hit = struck.fraction < 1 && !(struck.surfaceFlags & SURF.NOIMPACT);
  const end = snapVectorTowards(struck.endpos, muzzle);
  const start = hitscan.g_railTrailOffset
    ? madd(madd(muzzle, 4, right), -1, up)
    : snapVectorTowards(muzzle, end);
  const color = players.color(ps.clientNum);
  const effects: WorldEffect[] = [
    { type: 'beam', weapon: WP.RAILGUN, start, end, hit, own: true, color }
  ];
  if (hit) {
    effects.push({ type: 'impact', weapon: WP.RAILGUN, origin: end, normal: struck.normal, color });
  }
  return effects;
}

/** The frame a shot was aimed in: what it drew the others between, and where. */
export interface AimedFrame {
  /** The time it was drawn at, which the commands it aimed carry. */
  time: number;
  /** `cg.frameInterpolation`: how far from the snapshot toward the next it was drawn. */
  frac: number;
  /** The snapshot's entities, by number, and the time it was taken. */
  snap: Pick<ViewSnapshot, 'serverTime' | 'byNumber'>;
  /** The next snapshot's, or null where there was none. */
  nextSnap: Pick<ViewSnapshot, 'serverTime' | 'byNumber'> | null;
  /** The solids, each where it drew them. */
  solids: readonly SolidEntity[];
  /** How long another player is run on past a snapshot with no next. */
  runOn: number;
}

/**
 * `cg_debugDelag`'s client half (`cg_unlagged.c`): the first player a rail strikes, traced at
 * `CONTENTS_BODY|CONTENTS_SOLID`, as the frame it was aimed in drew them. `Int:` lines for one
 * drawn between two snapshots and `Ext:` for one run on past the one, each field where the server's
 * rewind prints the same; or null for a rail that strikes no one.
 *
 * @param shot - The rail, its trace through the solids where the frame drew them.
 */
export function delagReport(shot: EarlyShot, aimed: AimedFrame): string | null {
  const { ps, hitscan } = shot;
  const solution = solve(shot);
  const end = beamEndpoint(solution, hitscan.g_range_rg);
  const mask = CONTENTS.BODY | CONTENTS.SOLID;
  const struck = shot.trace(solution.muzzle, vec3(), vec3(), end, ps.clientNum, mask);
  if (struck.fraction === 1 || (struck.contents & CONTENTS.BODY) === 0) return null;

  const { time, frac, snap, nextSnap, runOn } = aimed;
  const number = struck.entityNum;
  const state = snap.byNumber.get(number);
  const drawn = aimed.solids.find((solid) => solid.number === number);
  if (state === undefined || drawn === undefined) return null;

  const { origin } = drawn;
  const j = snap.serverTime;
  const origin1 = evaluateTrajectory(state.pos, j);
  if (nextSnap !== null) {
    const next = nextSnap.byNumber.get(number) ?? state;
    const k = nextSnap.serverTime;
    const origin2 = evaluateTrajectory(next.pos, k);
    return delagLines('^3Int', '^5', { time, j, k, origin, frac, origin1, origin2 });
  }
  const pos = { ...state.pos, trType: TR.LINEAR_STOP, trTime: j, trDuration: runOn };
  const origin2 = evaluateTrajectory(pos, j + runOn);
  return delagLines('^3Ext', '^5', { time, j, k: j, origin, frac, origin1, origin2 });
}

/**
 * Whether a world event is the player's own shot, drawn already as it was fired, which the client
 * leaves out: a bullet's impact or a rail's trail by `clientNum`, a shotgun blast by
 * `otherEntityNum`.
 *
 * @param happening - The event.
 * @param own - `cg.clientNum`: the slot the gamestate gave this client.
 * @param delagWeapons - `xp_delagWeapons`.
 * @param unlagged - `xp_unlagged`, as the systeminfo carried it.
 */
export function drawnEarly(
  { event, state }: EntityEvent,
  own: number,
  delagWeapons: number,
  unlagged: number
): boolean {
  switch (event) {
    case EV.BULLET_HIT_WALL:
    case EV.BULLET_HIT_FLESH:
      return state.clientNum === own && delagged(WP.MACHINEGUN, delagWeapons, unlagged);
    case EV.RAILTRAIL:
      return state.clientNum === own && delagged(WP.RAILGUN, delagWeapons, unlagged);
    case EV.SHOTGUN:
      return state.otherEntityNum === own && delagged(WP.SHOTGUN, delagWeapons, unlagged);
    default:
      return false;
  }
}
