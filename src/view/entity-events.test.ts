import { describe, expect, it } from 'vitest';

import { createEntityState, TR, type EntityState } from '../net/protocol';
import { box, createFlatWorldTrace } from '../sim/box-world';
import { NO_IMPACT_DIR, byteToDir, dirToByte } from '../sim/dir-byte';
import { SOLID_BMODEL, packSolid } from '../sim/entity-solid';
import { EV, nextEventField } from '../sim/events';
import { ET } from '../sim/game-entity';
import { CONTENTS, EF_PLAYER_EVENT, MASK, SURF } from '../sim/constants';
import { findItem, itemIndex } from '../sim/items';
import { EVENT_VALID_MSEC } from '../sim/level';
import { distinctAsks, recordingTrace } from '../sim/trace-test-fixtures';
import { playerBounds, type PointContentsFn, type TraceFn } from '../sim/types';
import { vec3, type Vec3 } from '../sim/vec3';
import { WP } from '../sim/weapons/constants';
import { ID_SHOTGUN, shotgunWire } from '../sim/weapons/hitscan';
import { brushAhead } from '../sim/weapons/weapon-test-fixtures';
import { PELLET_BUBBLE_SPACING } from './bubbles';
import { clientTrace } from './client-trace';
import { boxSolid, mapAlone } from './client-trace-test-fixtures';
import {
  checkEntityEvents,
  createEntityEvents,
  transitionEntityEvents,
  type Players
} from './entity-events';

/**
 * What a client makes of the entities it is sent: which of them are carrying something it has
 * not seen, and what each of those means on screen.
 */

/** An entity at a place, with whatever else the event needs written on it. */
function entity(number: number, fields: Partial<EntityState> = {}): EntityState {
  const state = createEntityState();
  state.number = number;
  state.pos.trType = TR.STATIONARY;
  return Object.assign(state, fields);
}

/** An entity that is nothing but an event, as `G_TempEntity` leaves one. */
function eventEntity(number: number, event: number, fields: Partial<EntityState> = {}) {
  return entity(number, { eType: ET.EVENTS + event, ...fields });
}

describe('checkEntityEvents', () => {
  it('reads an event-only entity out of its type', () => {
    const events = createEntityEvents();
    const spark = eventEntity(70, EV.BULLET_HIT_WALL, { eventParm: 12 });

    const [found] = checkEntityEvents(events, [spark], 100);

    expect(found.event).toBe(EV.BULLET_HIT_WALL);
    expect(found.parm).toBe(12);
    expect(found.state).toBe(spark);
  });

  it("hears a player's event sent on its own from the player, and keeps it on its own slot", () => {
    // `CG_CheckEvents`: an `EF_PLAYER_EVENT` entity is the player's, by `otherEntityNum`.
    const events = createEntityEvents();
    const shot = eventEntity(70, EV.FIRE_WEAPON, { eFlags: EF_PLAYER_EVENT, otherEntityNum: 3 });

    const [found] = checkEntityEvents(events, [shot], 100);

    expect(found.number).toBe(3);
    expect(found.state.number).toBe(70);
    expect(found.event).toBe(EV.FIRE_WEAPON);
  });

  it('hears any other event from the entity carrying it', () => {
    // The flag's bit is a missile's `EF_BOUNCE` too, which only an event-only entity reads as
    // the player's.
    const events = createEntityEvents();
    const grenade = entity(70, {
      eType: ET.MISSILE,
      eFlags: EF_PLAYER_EVENT,
      otherEntityNum: 3,
      event: nextEventField(0, EV.GRENADE_BOUNCE)
    });
    const spark = eventEntity(71, EV.BULLET_HIT_WALL, { otherEntityNum: 3 });

    expect(checkEntityEvents(events, [grenade, spark], 100).map((found) => found.number)).toEqual([
      70, 71
    ]);
  });

  it('fires an event-only entity once, however many frames it stays in', () => {
    const events = createEntityEvents();
    const spark = eventEntity(70, EV.BULLET_HIT_WALL);

    expect(checkEntityEvents(events, [spark], 100)).toHaveLength(1);
    for (let time = 108; time <= 100 + EVENT_VALID_MSEC; time += 8) {
      expect(checkEntityEvents(events, [spark], time), `at ${time}`).toEqual([]);
    }
  });

  it('fires an event riding on a lasting entity whenever the field changes', () => {
    // A grenade bouncing twice: the same event, and the counter in its top two bits is the whole
    // of how a client tells the second from the first.
    const events = createEntityEvents();
    const grenade = entity(70, { eType: ET.MISSILE });

    grenade.event = nextEventField(0, EV.GRENADE_BOUNCE);
    expect(checkEntityEvents(events, [grenade], 100)).toHaveLength(1);
    expect(checkEntityEvents(events, [grenade], 108)).toEqual([]);

    grenade.event = nextEventField(grenade.event, EV.GRENADE_BOUNCE);
    const [second] = checkEntityEvents(events, [grenade], 116);
    expect(second.event).toBe(EV.GRENADE_BOUNCE);
  });

  it('ignores an entity carrying no event at all', () => {
    const events = createEntityEvents();
    expect(checkEntityEvents(events, [entity(70, { eType: ET.MISSILE })], 100)).toEqual([]);
  });

  it('treats a slot nobody has seen for an event window as a different entity', () => {
    // `CG_ResetEntity`: by then the server has freed whatever was there, and the slot may hold
    // something else. Without this a second temp entity in a reused slot would never fire.
    const events = createEntityEvents();
    const first = eventEntity(70, EV.BULLET_HIT_WALL);
    expect(checkEntityEvents(events, [first], 100)).toHaveLength(1);
    // Still the same entity for as long as the server keeps sending it: one event, once.
    expect(checkEntityEvents(events, [first], 100 + EVENT_VALID_MSEC)).toEqual([]);

    // Then the slot goes quiet — the server freed it — and comes back holding something else.
    const second = eventEntity(70, EV.MISSILE_MISS);
    const later = 100 + 2 * EVENT_VALID_MSEC + 8;
    expect(checkEntityEvents(events, [second], later)).toHaveLength(1);
  });

  it('puts the event where the trajectory has the entity now', () => {
    const events = createEntityEvents();
    const grenade = entity(70, { eType: ET.MISSILE });
    grenade.pos.trType = TR.LINEAR;
    grenade.pos.trTime = 100;
    grenade.pos.trBase = vec3(0, 0, 0);
    grenade.pos.trDelta = vec3(1000, 0, 0);
    grenade.event = nextEventField(0, EV.GRENADE_BOUNCE);

    const [found] = checkEntityEvents(events, [grenade], 150);

    expect(found.origin.x).toBeCloseTo(50, 6);
  });
});

describe('transitionEntityEvents', () => {
  const flat = createFlatWorldTrace();
  const wall = createFlatWorldTrace([box(256, -512, 0, 288, 512, 512)]);
  const events = createEntityEvents();
  const facingBack = dirToByte(vec3(-1, 0, 0));

  /** This client is player 0, player 1 is in the game, and nobody has a colour. */
  const PLAYERS: Players = { own: 0, color: () => [0, 0, 0], isPlayer: (number) => number === 1 };

  /** Read one entity's events and turn them into what to draw. */
  function read(state: EntityState, trace = flat, players = PLAYERS) {
    return transitionEntityEvents(
      checkEntityEvents(createEntityEvents(), [state], 100),
      trace,
      players
    );
  }

  it('draws a missile impact with the weapon that fired it and the surface it struck', () => {
    const rocket = entity(70, {
      eType: ET.GENERAL,
      weapon: WP.ROCKET_LAUNCHER,
      event: nextEventField(0, EV.MISSILE_MISS),
      eventParm: facingBack
    });
    rocket.pos.trBase = vec3(256, 0, 40);

    const [impact] = read(rocket);
    expect(impact).toMatchObject({
      type: 'impact',
      weapon: WP.ROCKET_LAUNCHER,
      origin: vec3(256, 0, 40)
    });
    // Unpacked from the byte, so it is the table's nearest direction rather than the surface's
    // own — within the 10.6 degrees the table can be out by.
    expect(impact.type === 'impact' && impact.normal).toEqual(byteToDir(facingBack));
    expect(impact.type === 'impact' && impact.normal.x).toBeLessThan(-0.98);
  });

  it('draws an impact that names no weapon as the lightning gun\'s', () => {
    // `CG_MissileHitWall`'s `default` label sits on the lightning gun's case, and the lightning
    // gun is exactly what sends a miss with no weapon on it.
    const [impact] = read(eventEntity(70, EV.MISSILE_MISS, { eventParm: facingBack }));
    expect(impact).toMatchObject({ type: 'impact', weapon: WP.LIGHTNING });
  });

  it("draws a bullet that struck a wall as the machinegun's impact", () => {
    const [impact] = read(eventEntity(70, EV.BULLET_HIT_WALL, { eventParm: facingBack }));
    expect(impact).toMatchObject({ type: 'impact', weapon: WP.MACHINEGUN });
  });

  it('bleeds a player a bullet struck, whose number its parm is, and marks nothing', () => {
    // `CG_Bullet` bleeds flesh rather than marking it. A mark would be a hole in the air, turned
    // by a slot number.
    const hit = eventEntity(70, EV.BULLET_HIT_FLESH, { eventParm: 1 });
    hit.pos.trBase = vec3(64, 0, 40);
    expect(read(hit)).toEqual([{ type: 'blood', origin: vec3(64, 0, 40) }]);
  });

  it('never shows this client its own blood', () => {
    // `CG_Bleed` flags it `RF_THIRD_PERSON`, which Q3 draws only in a mirror, even with the
    // camera behind the body.
    expect(read(eventEntity(70, EV.BULLET_HIT_FLESH, { eventParm: 0 }))).toEqual([]);
    for (const weapon of [WP.LIGHTNING, WP.ROCKET_LAUNCHER]) {
      const hit = eventEntity(70, EV.MISSILE_HIT, { eventParm: facingBack, weapon });
      expect(read(hit).map(({ type }) => type), `weapon ${weapon}`).not.toContain('blood');
    }
  });

  it('bleeds a player a missile hit, and explodes a grenade or a rocket there as well', () => {
    // `CG_MissileHitPlayer`: the blood, then for those two their explosion.
    const hit = (weapon: number) => {
      const state = eventEntity(70, EV.MISSILE_HIT, {
        eventParm: facingBack,
        weapon,
        otherEntityNum: 1
      });
      state.pos.trBase = vec3(64, 0, 40);
      return state;
    };
    for (const weapon of [WP.GRENADE_LAUNCHER, WP.ROCKET_LAUNCHER]) {
      expect(read(hit(weapon)), `weapon ${weapon}`).toEqual([
        { type: 'blood', origin: vec3(64, 0, 40) },
        { type: 'impact', weapon, origin: vec3(64, 0, 40), normal: byteToDir(facingBack) }
      ]);
    }
    // The plasma, the BFG, the lightning, the gauntlet, and the hook that names no weapon.
    for (const weapon of [WP.PLASMAGUN, WP.BFG, WP.LIGHTNING, WP.GAUNTLET, WP.NONE]) {
      expect(read(hit(weapon)), `weapon ${weapon}`).toEqual([
        { type: 'blood', origin: vec3(64, 0, 40) }
      ]);
    }
  });

  it('traces the shotgun\'s eleven pellets itself, from the seed and the aim it was sent', () => {
    const blast = eventEntity(70, EV.SHOTGUN, {
      eventParm: 231,
      origin2: shotgunWire(vec3(1, 0, 0))
    });
    blast.pos.trBase = vec3(0, 0, 26);

    const pellets = read(blast, wall);

    expect(pellets).toHaveLength(11);
    for (const pellet of pellets) {
      expect(pellet.type).toBe('impact');
      if (pellet.type !== 'impact') continue;
      expect(pellet.weapon).toBe(WP.SHOTGUN);
      expect(pellet.origin.x).toBeCloseTo(256, 0);
    }
    // Spread, not eleven copies of the crosshair.
    expect(new Set(pellets.map((p) => p.type === 'impact' && p.origin.y)).size).toBeGreaterThan(5);
  });

  it("draws the pattern the serverinfo names, on the aim's axes as CPMA's client does", () => {
    const blast = eventEntity(70, EV.SHOTGUN, {
      eventParm: 231,
      origin2: shotgunWire(vec3(1, 0, 0))
    });
    blast.pos.trBase = vec3(0, 0, 26);
    const pattern = { pattern: 1, pellets: 16, spread: 700 };

    const pellets = transitionEntityEvents(
      checkEntityEvents(createEntityEvents(), [blast], 100),
      wall,
      PLAYERS,
      () => '',
      pattern
    );

    expect(pellets).toHaveLength(16);
    // The first is 250 along the aim's right, which is +Y where the view's is -Y, and 100 up, at
    // the wall 256 out.
    const [first] = pellets;
    expect(first.type === 'impact' && first.origin.y).toBeCloseTo((250 * 256) / 8192, 1);
    expect(first.type === 'impact' && first.origin.z).toBeCloseTo(26 + (100 * 256) / 8192, 1);
  });

  it('traces each pellet past whoever fired it, stopped at MASK_SHOT', () => {
    const { trace, asked } = recordingTrace(wall);
    const blast = eventEntity(70, EV.SHOTGUN, {
      eventParm: 231,
      origin2: shotgunWire(vec3(1, 0, 0)),
      otherEntityNum: 3
    });

    read(blast, trace);

    expect(distinctAsks(asked)).toEqual([{ passEntityNum: 3, contentmask: MASK.SHOT }]);
  });

  it('gives the same eleven pellets to every client, because the seed is what was sent', () => {
    const blast = (seed: number) =>
      eventEntity(70, EV.SHOTGUN, { eventParm: seed, origin2: shotgunWire(vec3(1, 0, 0)) });
    expect(read(blast(231), wall)).toEqual(read(blast(231), wall));
    // And the seed is what decides them: a client that ignored it would draw marks the server
    // never traced, which is the one thing this arrangement exists to prevent.
    expect(read(blast(231), wall)).not.toEqual(read(blast(12), wall));
  });

  /** A blast from the eye along +x, at a box standing 128 out in front of the wall. */
  function blastAtBox(): { blast: EntityState; trace: TraceFn } {
    const blast = eventEntity(70, EV.SHOTGUN, {
      eventParm: 231,
      origin2: shotgunWire(vec3(1, 0, 0)),
      otherEntityNum: 0
    });
    blast.pos.trBase = vec3(0, 0, 26);
    const { mins, maxs } = playerBounds(false);
    const solid = packSolid({ bmodel: false, contents: CONTENTS.BODY, mins, maxs });
    return { blast, trace: clientTrace(mapAlone(wall), [boxSolid(1, solid, vec3(128, 0, 24))]) };
  }

  it('bleeds a player the pellets strike, where they strike, and marks nothing behind them', () => {
    // `CG_ShotgunPellet`: the entity the pellet stopped at is a player, so `CG_MissileHitPlayer`,
    // which for the shotgun is the blood alone. At 128 units the spread is inside a player's box.
    const { blast, trace } = blastAtBox();

    const pellets = read(blast, trace);

    expect(pellets).toHaveLength(11);
    for (const pellet of pellets) {
      expect(pellet.type).toBe('blood');
      // On the box's face, a player's half-width short of them.
      expect(pellet.type === 'blood' && pellet.origin.x).toBeCloseTo(128 - 15, 0);
    }
  });

  it('marks a solid that is not a player as it would the wall', () => {
    const { blast, trace } = blastAtBox();
    const nobody: Players = { ...PLAYERS, isPlayer: () => false };

    const pellets = read(blast, trace, nobody);

    expect(pellets.map(({ type }) => type)).toEqual(new Array(11).fill('impact'));
    expect(pellets[0].type === 'impact' && pellets[0].origin.x).toBeCloseTo(128 - 15, 0);
  });

  it('shows nothing for a pellet into the sky, and marks metal as anything else', () => {
    const blast = eventEntity(70, EV.SHOTGUN, {
      eventParm: 231,
      origin2: shotgunWire(vec3(1, 0, 0))
    });
    blast.pos.trBase = vec3(0, 0, 26);

    expect(read(blast, brushAhead(SURF.SKY | SURF.NOIMPACT))).toEqual([]);
    const metal = read(blast, brushAhead(SURF.METALSTEPS));
    expect(metal.map(({ type }) => type)).toEqual(new Array(11).fill('impact'));
    expect(metal.every((pellet) => pellet.type === 'impact' && pellet.weapon === WP.SHOTGUN)).toBe(
      true
    );
  });

  it('draws a miss on metal as any other miss, as baseq3 does', () => {
    const miss = (event: number) => {
      const state = eventEntity(70, event, { eventParm: facingBack, weapon: WP.ROCKET_LAUNCHER });
      state.pos.trBase = vec3(256, 0, 40);
      return read(state);
    };
    expect(miss(EV.MISSILE_MISS_METAL)).toEqual(miss(EV.MISSILE_MISS));
    expect(miss(EV.MISSILE_MISS_METAL)).toHaveLength(1);
  });

  it('shows nothing for a pellet that struck nothing', () => {
    // Fired at the sky over a floor: every pellet runs to the end of its range and marks nothing.
    const blast = eventEntity(70, EV.SHOTGUN, {
      eventParm: 231,
      origin2: shotgunWire(vec3(0, 0, 1))
    });
    blast.pos.trBase = vec3(0, 0, 26);
    expect(read(blast, flat)).toEqual([]);
  });

  describe('under water', () => {
    /** Water everywhere: both ends of every pellet's line are in it. */
    const flooded: PointContentsFn = () => CONTENTS.WATER;

    /** A blast from the eye along `aim`, read with the world's contents. */
    function wet(aim: Vec3, trace: TraceFn, contents = flooded) {
      const blast = eventEntity(70, EV.SHOTGUN, { eventParm: 231, origin2: shotgunWire(aim) });
      blast.pos.trBase = vec3(0, 0, 26);
      const happened = checkEntityEvents(createEntityEvents(), [blast], 100);
      return transitionEntityEvents(happened, trace, PLAYERS, () => '', ID_SHOTGUN, contents);
    }

    it('leaves bubbles 32 apart along each pellet, before the mark it makes', () => {
      const effects = wet(vec3(1, 0, 0), wall);
      expect(effects.map(({ type }) => type)).toEqual(
        Array.from({ length: 11 }, () => ['bubbles', 'impact']).flat()
      );
      for (let i = 0; i < effects.length; i += 2) {
        const [bubbles, impact] = [effects[i], effects[i + 1]];
        if (bubbles.type !== 'bubbles' || impact.type !== 'impact') throw new Error('out of order');
        expect([bubbles.start, bubbles.end, bubbles.spacing]).toEqual([
          vec3(0, 0, 26),
          impact.origin,
          PELLET_BUBBLE_SPACING
        ]);
      }
    });

    it('leaves them where a pellet marks nothing: the sky, or nothing struck', () => {
      const sky = wet(vec3(1, 0, 0), brushAhead(SURF.SKY | SURF.NOIMPACT));
      const nothing = wet(vec3(0, 0, 1), flat);
      for (const effects of [sky, nothing]) {
        expect(effects.map(({ type }) => type)).toEqual(new Array(11).fill('bubbles'));
      }
    });

    it('leaves none in a dry world, or one whose contents nobody asked', () => {
      expect(wet(vec3(1, 0, 0), wall, () => 0).map(({ type }) => type)).toEqual(
        new Array(11).fill('impact')
      );
      const blast = eventEntity(70, EV.SHOTGUN, {
        eventParm: 231,
        origin2: shotgunWire(vec3(1, 0, 0))
      });
      expect(read(blast, wall).map(({ type }) => type)).not.toContain('bubbles');
    });
  });

  it('draws the rail beam from the muzzle it was sent, with the impact at its far end', () => {
    const beam = eventEntity(70, EV.RAILTRAIL, {
      eventParm: facingBack,
      origin2: vec3(0, 0, 26)
    });
    beam.pos.trBase = vec3(256, 0, 26);

    const effects = read(beam);

    expect(effects[0]).toMatchObject({
      type: 'beam',
      weapon: WP.RAILGUN,
      start: vec3(0, 0, 26),
      end: vec3(256, 0, 26),
      hit: true
    });
    expect(effects[1]).toMatchObject({ type: 'impact', weapon: WP.RAILGUN });
  });

  it("draws a rail in its shooter's colour, and says whether it was this client's", () => {
    // `CG_RailTrail( ci, ... )`, `ci` being the clientinfo of the rail's `s.clientNum`.
    const colours = new Map([
      [0, [1, 0, 0] as const],
      [2, [0, 1, 0] as const]
    ]);
    const players: Players = {
      own: 0,
      color: (clientNum) => colours.get(clientNum) ?? [0, 0, 0],
      isPlayer: () => false
    };
    const rail = (clientNum: number, eventParm = NO_IMPACT_DIR) =>
      transitionEntityEvents(
        checkEntityEvents(
          createEntityEvents(),
          [eventEntity(70, EV.RAILTRAIL, { eventParm, clientNum })],
          100
        ),
        flat,
        players
      );

    expect(rail(0)[0]).toMatchObject({ own: true, color: [1, 0, 0] });
    expect(rail(2)[0]).toMatchObject({ own: false, color: [0, 1, 0] });
    // Its mark in the shooter's colour too (`CG_MissileHitWall`, `cg_weapons.c:1928-1933`).
    expect(rail(2, facingBack)[1]).toMatchObject({ type: 'impact', color: [0, 1, 0] });
  });

  it('draws a rail beam that landed on nothing without an impact at its end', () => {
    const beam = eventEntity(70, EV.RAILTRAIL, {
      eventParm: NO_IMPACT_DIR,
      origin2: vec3(0, 0, 26)
    });

    const effects = read(beam);

    expect(effects).toHaveLength(1);
    expect(effects[0]).toMatchObject({ type: 'beam', hit: false });
  });

  it('shows nothing for an event it has no picture of', () => {
    // A grenade bouncing is heard, not seen, and the port has no sound for it yet; an event the
    // client does not draw has to pass through rather than throw.
    const grenade = entity(70, {
      eType: ET.MISSILE,
      event: nextEventField(0, EV.GRENADE_BOUNCE)
    });
    expect(transitionEntityEvents(checkEntityEvents(events, [grenade], 100), flat)).toEqual([]);
  });

  /** The item table's slot for a classname, which is what a pickup's parm carries. */
  const slot = (classname: string) => itemIndex(findItem(classname)!);

  it('hears an ordinary pickup where the one who took it stands', () => {
    const bullets = entity(3, {
      eType: ET.PLAYER,
      event: nextEventField(0, EV.ITEM_PICKUP),
      eventParm: slot('ammo_bullets')
    });
    bullets.pos.trBase = vec3(64, 0, 40);
    expect(read(bullets)).toEqual([
      { type: 'sound', path: 'sound/misc/am_pkup.wav', number: 3, origin: vec3(64, 0, 40) }
    ]);
  });

  it('hears a powerup or a team item as the health sound, which is its prediction-time one', () => {
    for (const classname of ['item_quad', 'team_CTF_redflag']) {
      const taken = entity(3, {
        eType: ET.PLAYER,
        event: nextEventField(0, EV.ITEM_PICKUP),
        eventParm: slot(classname)
      });
      expect(read(taken), classname).toEqual([
        { type: 'sound', path: 'sound/items/n_health.wav', number: 3, origin: vec3(0, 0, 0) }
      ]);
    }
  });

  it("hears a powerup's own sound from the listener, by the whole match", () => {
    // `EV_GLOBAL_ITEM_PICKUP` is a broadcast temp entity, and Q3 plays it from
    // `cg.snap->ps.clientNum`, so every client hears it as its own.
    const announced = eventEntity(70, EV.GLOBAL_ITEM_PICKUP, { eventParm: slot('item_quad') });
    announced.pos.trBase = vec3(256, 0, 40);
    expect(read(announced, flat, { ...PLAYERS, own: 5 })).toEqual([
      { type: 'sound', path: 'sound/items/quaddamage.wav', number: 5, origin: null }
    ]);
  });

  it('hears an item come back where it stands', () => {
    const shard = entity(70, {
      eType: ET.ITEM,
      event: nextEventField(0, EV.ITEM_RESPAWN)
    });
    shard.pos.trBase = vec3(64, 0, 40);
    expect(read(shard)).toEqual([
      { type: 'sound', path: 'sound/items/respawn1.wav', number: 70, origin: vec3(64, 0, 40) }
    ]);
  });

  it("plays each end of a teleport's sound, and draws its effect, where the event is", () => {
    const at = vec3(816, 64, 348);
    const out = eventEntity(70, EV.PLAYER_TELEPORT_OUT, { clientNum: 3 });
    const into = eventEntity(71, EV.PLAYER_TELEPORT_IN, { clientNum: 3 });
    out.pos.trBase = vec3(10, 20, 30);
    into.pos.trBase = at;
    expect(read(out)).toEqual([
      { type: 'sound', path: 'sound/world/teleout.wav', number: 70, origin: vec3(10, 20, 30) },
      { type: 'teleport', origin: vec3(10, 20, 30) }
    ]);
    expect(read(into)).toEqual([
      { type: 'sound', path: 'sound/world/telein.wav', number: 71, origin: at },
      { type: 'teleport', origin: at }
    ]);
  });

  it('plays a sound the match names where its event says, and a global one at the listener', () => {
    const named = (state: EntityState) =>
      transitionEntityEvents(
        checkEntityEvents(createEntityEvents(), [state], 100),
        flat,
        { ...PLAYERS, own: 5 },
        (index) => (index === 4 ? 'sound/items/poweruprespawn.wav' : '')
      );
    const name = 'sound/items/poweruprespawn.wav';
    expect(named(eventEntity(70, EV.GENERAL_SOUND, { eventParm: 4 }))).toEqual([
      { type: 'gameSound', index: 4, name, number: 70, origin: vec3(0, 0, 0) }
    ]);
    // On the listener's own entity, which it does not move.
    expect(named(eventEntity(70, EV.GLOBAL_SOUND, { eventParm: 4 }))).toEqual([
      { type: 'gameSound', index: 4, name, number: 5, origin: null }
    ]);
    // A slot that names nothing holds handle 0, and its empty name is played as handle 0 is.
    expect(named(eventEntity(70, EV.GENERAL_SOUND, { eventParm: 9 }))).toEqual([
      { type: 'gameSound', index: 9, name: '', number: 70, origin: vec3(0, 0, 0) }
    ]);
  });

  it("hears a brush model's events from its model's midpoint, wherever the model moved", () => {
    const door = entity(80, {
      eType: ET.MOVER,
      solid: SOLID_BMODEL,
      modelindex: 3,
      event: nextEventField(0, EV.GENERAL_SOUND),
      eventParm: 4
    });
    door.pos.trBase = vec3(0, 0, 8);
    const midpoint = (model: number) => (model === 3 ? vec3(512, -64, 96) : vec3());
    const happened = checkEntityEvents(createEntityEvents(), [door], 100, midpoint);
    expect(happened[0]).toMatchObject({ origin: vec3(0, 0, 8), soundOrigin: vec3(512, -64, 104) });
    const effects = transitionEntityEvents(happened, flat, PLAYERS, () => 'sound/movers/door.wav');
    expect(effects).toEqual([
      {
        type: 'gameSound',
        index: 4,
        name: 'sound/movers/door.wav',
        number: 80,
        origin: vec3(512, -64, 104)
      }
    ]);
  });

  it("leaves a model's own sound, a `*` name, to the voice that plays it", () => {
    const named = (event: number) =>
      transitionEntityEvents(
        checkEntityEvents(createEntityEvents(), [eventEntity(70, event, { eventParm: 4 })], 100),
        flat,
        PLAYERS,
        (index) => (index === 4 ? '*drown.wav' : '')
      );
    expect(named(EV.GENERAL_SOUND)).toEqual([]);
    expect(named(EV.GLOBAL_SOUND)).toEqual([]);
  });

  it('hears nothing more of a flag, which has no sound of its own to announce', () => {
    // `if ( item->pickup_sound )` is what the global event plays, and a flag's is NULL.
    const announced = eventEntity(70, EV.GLOBAL_ITEM_PICKUP, { eventParm: slot('team_CTF_redflag') });
    expect(read(announced)).toEqual([]);
  });

  it('hears nothing for a pickup outside the table', () => {
    for (const parm of [0, 999]) {
      const nowhere = entity(3, {
        eType: ET.PLAYER,
        event: nextEventField(0, EV.ITEM_PICKUP),
        eventParm: parm
      });
      expect(read(nowhere), `parm ${parm}`).toEqual([]);
    }
  });
});
