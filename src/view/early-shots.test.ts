import { describe, expect, it } from 'vitest';

import { TR, createEntityState, type EntityState } from '../net/protocol';
import { box, createFlatWorldTrace } from '../sim/box-world';
import { CONTENTS, MASK, SURF } from '../sim/constants';
import { packSolid } from '../sim/entity-solid';
import { EV } from '../sim/events';
import { ET } from '../sim/game-entity';
import { ID_RULES, type Rules } from '../sim/rules';
import { distinctAsks, recordingTrace } from '../sim/trace-test-fixtures';
import { NO_CONTENTS, playerBounds, type PointContentsFn, type TraceFn } from '../sim/types';
import { vec3 } from '../sim/vec3';
import { WP, type WeaponId } from '../sim/weapons/constants';
import { brushAhead, weaponWorld } from '../sim/weapons/weapon-test-fixtures';
import { clientTrace } from './client-trace';
import { boxSolid, mapAlone } from './client-trace-test-fixtures';
import {
  delagReport,
  delagged,
  drawnEarly,
  earlyShotEffects,
  type AimedFrame,
  type EarlyShot
} from './early-shots';
import {
  checkEntityEvents,
  createEntityEvents,
  transitionEntityEvents,
  type EntityEvent,
  type Players
} from './entity-events';

/** A wall 256 units ahead of the origin, across the whole of the view. */
const WALL = createFlatWorldTrace([box(256, -512, 0, 288, 512, 512)]);

/** The seed the server is pinned to, as a command's drawn time would give it. */
const SEED = 77;

/** This client is player 0, in red; everyone else is in green. */
const PLAYERS: Players = {
  own: 0,
  color: (clientNum) => (clientNum === 0 ? [1, 0, 0] : [0, 1, 0]),
  isPlayer: (number) => number < 64
};

/** CPMA's muzzle and hitscan numbers, every one away from id's. */
const CPM: Readonly<Rules> = {
  ...ID_RULES,
  g_muzzleForward: 1,
  g_muzzleSnap: 0,
  g_spread_mg: 100,
  g_range_mg: 16384,
  g_range_rg: 4096,
  g_bulletImpactSnap: 0,
  g_railTrailOffset: 0
};

/** The shotgun's rules, as the serverinfo would carry them. */
function shotgunOf(rules: Readonly<Rules>) {
  return { pattern: rules.g_pattern_sg, pellets: rules.g_pellets_sg, spread: rules.g_spread_sg };
}

/**
 * One shot from a player standing at the origin, looking a little left and down: what the server's
 * events for it draw on a client, and what the client draws of it early.
 */
function fired(
  weapon: WeaponId,
  rules: Readonly<Rules>,
  trace: TraceFn = WALL,
  pointContents: PointContentsFn = NO_CONTENTS
) {
  const world = weaponWorld({ trace, rules, randomness: { seed: () => SEED } });
  const ps = world.owner.client!.ps;
  ps.origin = vec3(0, 0, 24);
  ps.viewheight = 26;
  ps.viewangles = vec3(5, 10, 0);
  ps.weapon = weapon;
  world.weapons.fire(ps);

  const { level } = world;
  const sent = level.gentities
    .slice(0, level.numEntities)
    .filter((entity) => entity.inuse && entity.s.eType > ET.EVENTS)
    .map((entity) => entity.s);
  const shotgun = shotgunOf(rules);
  const happened = checkEntityEvents(createEntityEvents(), sent, level.time);
  return {
    sent: transitionEntityEvents(happened, trace, PLAYERS, () => '', shotgun, pointContents),
    early: earlyShotEffects({
      ps,
      seed: SEED,
      trace,
      hitscan: rules,
      shotgun,
      players: PLAYERS,
      pointContents
    })
  };
}

/** A shot along +x from a player at the origin, number 3 unless asked. */
function shot(weapon: WeaponId, trace: TraceFn, fields: Partial<EarlyShot> = {}): EarlyShot {
  return {
    ps: { origin: vec3(0, 0, 24), viewangles: vec3(), viewheight: 26, weapon, clientNum: 3 },
    seed: SEED,
    trace,
    hitscan: ID_RULES,
    shotgun: shotgunOf(ID_RULES),
    players: PLAYERS,
    ...fields
  };
}

/** The wall, and a player's box 128 units out in front of it, in slot `number`. */
function standing(number: number): TraceFn {
  const { mins, maxs } = playerBounds(false);
  const solid = packSolid({ bmodel: false, contents: CONTENTS.BODY, mins, maxs });
  return clientTrace(mapAlone(WALL), [boxSolid(number, solid, vec3(128, 0, 24))]);
}

describe('delagged', () => {
  it.each([
    [WP.MACHINEGUN, 1],
    [WP.SHOTGUN, 2],
    [WP.RAILGUN, 8]
  ])('draws weapon %i early at its bit, %i, and not without it', (weapon, bit) => {
    expect(delagged(weapon, bit, 1)).toBe(true);
    expect(delagged(weapon, 0xff & ~bit, 1)).toBe(false);
  });

  it('draws no other weapon early, whatever the mask', () => {
    for (const weapon of [WP.GAUNTLET, WP.LIGHTNING, WP.ROCKET_LAUNCHER, WP.PLASMAGUN]) {
      expect(delagged(weapon, 0xff, 1), `weapon ${weapon}`).toBe(false);
    }
  });

  it('draws a weapon early only where xp_unlagged rewinds for it', () => {
    expect(delagged(WP.MACHINEGUN, 1, 0)).toBe(false);
    expect(delagged(WP.MACHINEGUN, 1, 1 << WP.MACHINEGUN)).toBe(true);
    expect(delagged(WP.MACHINEGUN, 1, 1 << WP.SHOTGUN)).toBe(false);
  });
});

describe('earlyShotEffects', () => {
  it.each([
    ['id', ID_RULES],
    ['CPMA', CPM]
  ])("draws each shot where the server's events for it are drawn, by %s's numbers", (_, rules) => {
    for (const weapon of [WP.MACHINEGUN, WP.SHOTGUN, WP.RAILGUN]) {
      const { sent, early } = fired(weapon, rules);
      expect(sent.length, `weapon ${weapon}`).toBeGreaterThan(0);
      expect(early, `weapon ${weapon}`).toEqual(sent);
    }
  });

  it("leaves a blast's bubbles under water as the server's event does", () => {
    const { sent, early } = fired(WP.SHOTGUN, ID_RULES, WALL, () => CONTENTS.WATER);
    expect(early).toEqual(sent);
    expect(early.filter(({ type }) => type === 'bubbles')).toHaveLength(11);
    // And none from a client that asks nothing of the world's contents.
    const dry = earlyShotEffects(shot(WP.SHOTGUN, WALL));
    expect(dry.map(({ type }) => type)).not.toContain('bubbles');
  });

  it("draws a rail out of reach of the wall as the server's event does, striking nothing", () => {
    // The rail's reach falls short of the wall, and the machinegun's does not.
    const short = { ...ID_RULES, g_range_rg: 128 };
    const { sent, early } = fired(WP.RAILGUN, short);
    expect(early).toEqual(sent);
    expect(early).toEqual([expect.objectContaining({ type: 'beam', hit: false })]);
  });

  it("draws nothing on the sky but a rail's trail, as the server's events draw", () => {
    const sky = brushAhead(SURF.SKY | SURF.NOIMPACT);
    for (const weapon of [WP.MACHINEGUN, WP.SHOTGUN, WP.RAILGUN]) {
      const { sent, early } = fired(weapon, ID_RULES, sky);
      expect(early, `weapon ${weapon}`).toEqual(sent);
    }
    expect(fired(WP.MACHINEGUN, ID_RULES, sky).early).toEqual([]);
    expect(fired(WP.SHOTGUN, ID_RULES, sky).early).toEqual([]);
    const [beam, ...rest] = fired(WP.RAILGUN, ID_RULES, sky).early;
    expect(beam).toMatchObject({ type: 'beam', hit: false });
    expect(beam.type === 'beam' && beam.end.x).toBe(255);
    expect(rest).toEqual([]);
  });

  it("draws the rail through everyone, to the wall, in this client's colour", () => {
    const own = shot(WP.RAILGUN, standing(1));
    const effects = earlyShotEffects({ ...own, ps: { ...own.ps, clientNum: 0 } });
    expect(effects).toEqual([
      expect.objectContaining({ type: 'beam', hit: true, own: true, color: [1, 0, 0] }),
      // Its mark in the same colour.
      expect.objectContaining({ type: 'impact', weapon: WP.RAILGUN, color: [1, 0, 0] })
    ]);
    // Just short of the face it struck, snapped back toward the muzzle.
    expect(effects[0].type === 'beam' && effects[0].end.x).toBe(255);
  });

  it("bleeds whoever a round strikes in a player's slot, and marks anything else", () => {
    const [blood] = earlyShotEffects(shot(WP.MACHINEGUN, standing(1)));
    expect(blood.type).toBe('blood');
    // Just short of the box's face, a player's half-width short of them, snapped back a unit.
    expect(blood.type === 'blood' && blood.origin.x).toBe(128 - 15 - 1);

    const [mark] = earlyShotEffects(shot(WP.MACHINEGUN, standing(70)));
    expect(mark).toMatchObject({ type: 'impact', weapon: WP.MACHINEGUN });
  });

  it('traces past the shooter: a round and a pellet at MASK_SHOT, a rail at CONTENTS_SOLID', () => {
    const asks = (weapon: WeaponId) => {
      const { trace, asked } = recordingTrace(WALL);
      earlyShotEffects(shot(weapon, trace));
      return distinctAsks(asked);
    };
    expect(asks(WP.MACHINEGUN)).toEqual([{ passEntityNum: 3, contentmask: MASK.SHOT }]);
    expect(asks(WP.SHOTGUN)).toEqual([{ passEntityNum: 3, contentmask: MASK.SHOT }]);
    expect(asks(WP.RAILGUN)).toEqual([{ passEntityNum: 3, contentmask: CONTENTS.SOLID }]);
  });

  it('draws nothing for a round that struck nothing, or for any other weapon', () => {
    const sky = { ...shot(WP.MACHINEGUN, WALL).ps, viewangles: vec3(-90, 0, 0) };
    expect(earlyShotEffects(shot(WP.MACHINEGUN, WALL, { ps: sky }))).toEqual([]);
    expect(earlyShotEffects(shot(WP.ROCKET_LAUNCHER, WALL))).toEqual([]);
  });
});

describe('delagReport', () => {
  /** Player 1 as two snapshots 50 ms apart carried them, walking down +x at 320 a second. */
  function walking(x: number, at: number) {
    const state = createEntityState();
    state.number = 1;
    state.pos.trType = TR.INTERPOLATE;
    state.pos.trBase = vec3(x, 0, 24);
    state.pos.trDelta = vec3(320, 0, 0);
    return { serverTime: at, byNumber: new Map([[1, state]]) };
  }

  /** A frame drawn at 1010, a quarter of the way from the snapshot at 1000 to the one at 1050. */
  function aimedAt(nextSnap: AimedFrame['nextSnap'], y = 0): AimedFrame {
    const { mins, maxs } = playerBounds(false);
    const solid = packSolid({ bmodel: false, contents: CONTENTS.BODY, mins, maxs });
    return {
      time: 1010,
      frac: nextSnap === null ? 0 : 0.25,
      snap: walking(120, 1000),
      nextSnap,
      solids: [boxSolid(1, solid, vec3(128, y, 24))],
      runOn: 50
    };
  }

  /** The rail, traced through the frame's solids. */
  function railAt(aimed: AimedFrame): EarlyShot {
    return shot(WP.RAILGUN, clientTrace(mapAlone(WALL), aimed.solids));
  }

  it('prints where the frame drew the player struck, between the two snapshots', () => {
    const aimed = aimedAt(walking(152, 1050));
    expect(delagReport(railAt(aimed), aimed)).toBe(
      '^3Int: time: 1010, j: 1000, k: 1050, origin: 128.00 0.00 24.00\n' +
        '^5frac: 0.2500, origin1: 120.00 0.00 24.00, origin2: 152.00 0.00 24.00\n'
    );
  });

  it('prints one run on past the snapshot, a gap on, without a next', () => {
    const aimed = aimedAt(null);
    expect(delagReport(railAt(aimed), aimed)).toBe(
      '^3Ext: time: 1010, j: 1000, k: 1000, origin: 128.00 0.00 24.00\n' +
        '^5frac: 0.0000, origin1: 120.00 0.00 24.00, origin2: 136.00 0.00 24.00\n'
    );
  });

  it('prints nothing for a rail that strikes no one', () => {
    const aimed = aimedAt(walking(152, 1050), 200);
    expect(delagReport(railAt(aimed), aimed)).toBeNull();
  });
});

describe('drawnEarly', () => {
  /** An event a temp entity carries, with the fields that say whose it was. */
  function happening(event: number, fields: Partial<EntityState> = {}): EntityEvent {
    const state = { ...createEntityState(), number: 70, eType: ET.EVENTS + event, ...fields };
    return { state, number: 70, event, parm: 0, origin: vec3(), soundOrigin: vec3() };
  }

  /** Every weapon drawn early, on a server that rewinds for all of them. */
  const all = (event: EntityEvent) => drawnEarly(event, 0, 11, 1);

  it("leaves out the player's own rounds and rails by clientNum, blasts by otherEntityNum", () => {
    expect(all(happening(EV.BULLET_HIT_WALL, { clientNum: 0, otherEntityNum: 2 }))).toBe(true);
    expect(all(happening(EV.BULLET_HIT_FLESH, { clientNum: 0, otherEntityNum: 2 }))).toBe(true);
    expect(all(happening(EV.RAILTRAIL, { clientNum: 0, otherEntityNum: 2 }))).toBe(true);
    expect(all(happening(EV.SHOTGUN, { clientNum: 2, otherEntityNum: 0 }))).toBe(true);

    expect(all(happening(EV.BULLET_HIT_WALL, { clientNum: 2, otherEntityNum: 0 }))).toBe(false);
    expect(all(happening(EV.RAILTRAIL, { clientNum: 2, otherEntityNum: 0 }))).toBe(false);
    expect(all(happening(EV.SHOTGUN, { clientNum: 0, otherEntityNum: 2 }))).toBe(false);
  });

  it.each([
    [EV.BULLET_HIT_WALL, 1],
    [EV.BULLET_HIT_FLESH, 1],
    [EV.SHOTGUN, 2],
    [EV.RAILTRAIL, 8]
  ])("leaves out event %i by its own weapon's bit, %i, and by no other", (event, bit) => {
    const own = happening(event, { clientNum: 0, otherEntityNum: 0 });
    expect(drawnEarly(own, 0, bit, 1)).toBe(true);
    expect(drawnEarly(own, 0, 11 & ~bit, 1)).toBe(false);
  });

  it('keeps a weapon drawn late, and every other event', () => {
    const wall = happening(EV.BULLET_HIT_WALL, { clientNum: 0 });
    expect(drawnEarly(wall, 0, 2 | 8, 1)).toBe(false);
    expect(drawnEarly(wall, 0, 1, 0)).toBe(false);
    expect(all(happening(EV.MISSILE_MISS, { clientNum: 0, otherEntityNum: 0 }))).toBe(false);
  });
});
