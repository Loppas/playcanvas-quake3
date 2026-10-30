import { describe, expect, it } from 'vitest';

import { createEntityState, type EntityState } from '../net/protocol';
import { box, createFlatWorldTrace } from '../sim/box-world';
import { CONTENTS } from '../sim/constants';
import { packSolid } from '../sim/entity-solid';
import { PW } from '../sim/items';
import { NO_CONTENTS, playerBounds, type PointContentsFn, type TraceFn } from '../sim/types';
import { vec3, type Vec3 } from '../sim/vec3';
import { clientTrace, type SolidEntity } from './client-trace';
import { boxSolid, mapAlone } from './client-trace-test-fixtures';
import {
  createCrosshairPlayer,
  crosshairPlayer,
  scanForCrosshairEntity,
  type CrosshairPlayer,
  type CrosshairScan
} from './crosshair-player';

/** A standing player's box, as linking packs it. */
const STANDING = (() => {
  const { mins, maxs } = playerBounds(false);
  return packSolid({ bmodel: false, contents: CONTENTS.BODY, mins, maxs });
})();

/** A standing player, entity `number`, on the floor at `x` along the view. */
function player(number: number, x: number): SolidEntity {
  return boxSolid(number, STANDING, vec3(x, 0, 24));
}

/** The floor, and a wall across the view whose near face is at x = 300. */
const WALLED = createFlatWorldTrace([box(300, -512, 0, 316, 512, 512)]);

/** The entities a scan reads, by number. */
function states(entities: Partial<EntityState>[]): (number: number) => EntityState | undefined {
  const byNumber = new Map(
    entities.map((fields) => {
      const state = Object.assign(createEntityState(), fields);
      return [state.number, state] as const;
    })
  );
  return (number) => byNumber.get(number);
}

/** A scan from eye height at the origin, looking along +x, the player's own entity 0. */
function scan(solids: SolidEntity[], over: Partial<CrosshairScan> = {}): CrosshairScan {
  return {
    trace: clientTrace(mapAlone(WALLED), solids),
    pointContents: NO_CONTENTS,
    currentState: states(solids.map(({ number }) => ({ number }))),
    origin: vec3(0, 0, 50),
    angles: vec3(),
    clientNum: 0,
    ...over
  };
}

/** A fresh state, scanned once at `time`. */
function scanned(world: CrosshairScan, time = 5000): CrosshairPlayer {
  const state = createCrosshairPlayer();
  scanForCrosshairEntity(state, world, time);
  return state;
}

const NOBODY: CrosshairPlayer = { clientNum: 0, time: 0 };

describe('scanForCrosshairEntity', () => {
  it('takes the player under the crosshair, at the whole millisecond', () => {
    expect(scanned(scan([player(3, 200)]), 5000.7)).toEqual({ clientNum: 3, time: 5000 });
  });

  it('takes no one behind a wall, the wall itself, or nothing at all', () => {
    expect(scanned(scan([player(3, 400)]))).toEqual(NOBODY);
    expect(scanned(scan([]))).toEqual(NOBODY);
    const open = clientTrace(mapAlone(createFlatWorldTrace()), []);
    expect(scanned(scan([], { trace: open }))).toEqual(NOBODY);
  });

  it("passes the player's own entity, and takes whoever is behind it", () => {
    const solids = [player(2, 100), player(5, 200)];
    expect(scanned(scan(solids, { clientNum: 2 }))).toEqual({ clientNum: 5, time: 5000 });
    expect(scanned(scan(solids))).toEqual({ clientNum: 2, time: 5000 });
  });

  it("takes nothing past the clients' slots, as a mover is", () => {
    expect(scanned(scan([player(64, 200)]))).toEqual(NOBODY);
    expect(scanned(scan([player(63, 200)]))).toEqual({ clientNum: 63, time: 5000 });
  });

  it('takes no player where the trace stopped in fog, asking with entity 0 passed', () => {
    const asked: Array<[Vec3, number]> = [];
    const fog: PointContentsFn = (point, pass) => {
      asked.push([point, pass]);
      return CONTENTS.FOG | CONTENTS.WATER;
    };
    expect(scanned(scan([player(3, 200)], { pointContents: fog, clientNum: 1 }))).toEqual(NOBODY);
    expect(asked).toHaveLength(1);
    const [[point, pass]] = asked;
    expect([point.x, point.y, point.z, pass]).toEqual([expect.closeTo(185, 0), 0, 50, 0]);
    // Water alone is no bar.
    const water: PointContentsFn = () => CONTENTS.WATER;
    expect(scanned(scan([player(3, 200)], { pointContents: water })).clientNum).toBe(3);
  });

  it('takes no player carrying invisibility, whatever else they carry', () => {
    const invisible = states([{ number: 3, powerups: (1 << PW.INVIS) | (1 << PW.QUAD) }]);
    expect(scanned(scan([player(3, 200)], { currentState: invisible }))).toEqual(NOBODY);
    const quad = states([{ number: 3, powerups: 1 << PW.QUAD }]);
    expect(scanned(scan([player(3, 200)], { currentState: quad })).clientNum).toBe(3);
  });

  it('keeps the last player sighted when a later scan takes no one', () => {
    const state = scanned(scan([player(3, 200)]));
    scanForCrosshairEntity(state, scan([player(3, 400)]), 5500);
    expect(state).toEqual({ clientNum: 3, time: 5000 });
  });

  it("traces a point 131072 along the view's forward, past the own entity, to solids", () => {
    const calls: Parameters<TraceFn>[] = [];
    const trace: TraceFn = (...args) => {
      calls.push(args);
      return clientTrace(mapAlone(createFlatWorldTrace()), [])(...args);
    };
    const origin = vec3(10, 20, 30);
    scanned(scan([], { trace, origin, angles: vec3(0, 90, 0), clientNum: 7 }));
    expect(calls).toHaveLength(1);
    const [start, mins, maxs, end, skip, mask] = calls[0];
    expect(start).toEqual(origin);
    expect([mins, maxs]).toEqual([vec3(), vec3()]);
    // cos 90° in a float is a hair off 0, as the QVM's is.
    expect([end.x, end.y, end.z]).toEqual([expect.closeTo(10, 0), 131092, 30]);
    expect([skip, mask]).toEqual([7, CONTENTS.SOLID | CONTENTS.BODY]);
  });
});

describe('crosshairPlayer', () => {
  it('names the player sighted for a second after, then nobody', () => {
    const state: CrosshairPlayer = { clientNum: 3, time: 5000 };
    expect(crosshairPlayer(state, 6000)).toBe(3);
    expect(crosshairPlayer(state, 6000.9)).toBe(3);
    expect(crosshairPlayer(state, 6001)).toBe(-1);
  });

  it('answers 0 before any sighting while the clock is under a second, as Quake 3 does', () => {
    expect(crosshairPlayer(createCrosshairPlayer(), 1000)).toBe(0);
    expect(crosshairPlayer(createCrosshairPlayer(), 1001)).toBe(-1);
  });
});
