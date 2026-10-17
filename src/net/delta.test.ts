import { describe, expect, it } from 'vitest';

import {
  ENTITY_STATE_FIELDS,
  PLAYER_STATE_FIELDS,
  copyEntityState,
  copyPlayerState,
  readDeltaEntity,
  readDeltaPlayerState,
  readDeltaUserCmdKey,
  writeDeltaEntity,
  writeDeltaPlayerState,
  writeDeltaUserCmdKey,
  type NetField
} from './delta';
import { Message } from './msg';
import {
  GENTITYNUM_BITS,
  MAX_GENTITIES,
  createEntityState,
  createNetUserCmd,
  createPlayerState,
  type EntityState,
  type NetUserCmd,
  type PlayerState
} from './protocol';

/** Write one entity's delta and read it straight back, as the client's parser would. */
function entityRoundTrip(from: EntityState, to: EntityState | null, force = true): EntityState {
  const out = Message.write(2048);
  writeDeltaEntity(out, from, to, force);
  expect(out.overflowed).toBe(false);

  const back = Message.read(out.written.slice());
  const number = back.readBits(GENTITYNUM_BITS);
  return readDeltaEntity(back, from, createEntityState(), number);
}

/** Write one player state's delta and read it straight back. */
function playerRoundTrip(from: PlayerState | null, to: PlayerState): PlayerState {
  const out = Message.write(2048);
  writeDeltaPlayerState(out, from, to);
  expect(out.overflowed).toBe(false);

  const back = Message.read(out.written.slice());
  return readDeltaPlayerState(back, from, createPlayerState());
}

/** How many bytes one entity's delta takes. */
function entityDeltaSize(from: EntityState, to: EntityState): number {
  const out = Message.write(2048);
  writeDeltaEntity(out, from, to, true);
  return out.curSize;
}

/**
 * Set one field and check that the accessor pair reaches that field and no other.
 *
 * This is the test the ninety-nine hand-written accessors exist to be caught by: among lines that
 * differ only in a member name, the mistake to expect is two of them pointing at the same place.
 * It does not prove an accessor reaches the member its *name* claims — {@link namedMember} spot-
 * checks that separately.
 */
function checkAccessorsAreDistinct<T>(fields: readonly NetField<T>[], make: () => T): void {
  for (let i = 0; i < fields.length; i++) {
    const state = make();
    fields[i].set(state, 1);
    expect([fields[i].name, fields[i].get(state)]).toEqual([fields[i].name, 1]);

    const collisions = fields.filter((other, j) => j !== i && other.get(state) !== 0);
    expect([fields[i].name, collisions.map((other) => other.name)]).toEqual([fields[i].name, []]);
  }
}

/** Every leaf number in a state, by dotted path. */
function leaves(value: unknown, prefix = ''): Map<string, number> {
  const out = new Map<string, number>();
  if (typeof value === 'number') {
    out.set(prefix, value);
  } else if (Array.isArray(value)) {
    value.forEach((item, i) => {
      for (const [path, n] of leaves(item, `${prefix}.${i}`)) out.set(path, n);
    });
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      for (const [path, n] of leaves(item, prefix ? `${prefix}.${key}` : key)) out.set(path, n);
    }
  }
  return out;
}

/** Which member of the state a named field actually writes to. */
function namedMember<T>(fields: readonly NetField<T>[], name: string, make: () => T): string {
  const netField = fields.find((candidate) => candidate.name === name);
  if (!netField) throw new Error(`no field named ${name}`);

  const before = leaves(make());
  const state = make();
  netField.set(state, 1);
  const touched = [...leaves(state)].filter(([path, n]) => before.get(path) !== n);
  return touched.map(([path]) => path).join(',');
}

describe('the field tables', () => {
  it("are Quake 3's, at their lengths and in their order", () => {
    expect(ENTITY_STATE_FIELDS).toHaveLength(51);
    expect(PLAYER_STATE_FIELDS).toHaveLength(48);

    // The order is the protocol, so the ends of both tables are pinned.
    expect(ENTITY_STATE_FIELDS[0].name).toBe('pos.trTime');
    expect(ENTITY_STATE_FIELDS[50].name).toBe('frame');
    expect(PLAYER_STATE_FIELDS[0].name).toBe('commandTime');
    expect(PLAYER_STATE_FIELDS[47].name).toBe('loopSound');
  });

  it('name every field once', () => {
    for (const fields of [ENTITY_STATE_FIELDS, PLAYER_STATE_FIELDS]) {
      const names = fields.map((netField) => netField.name);
      expect(new Set(names).size).toBe(names.length);
    }
  });

  it('carry the widths the protocol was measured for', () => {
    const width = (fields: readonly NetField<never>[], name: string) =>
      fields.find((netField) => netField.name === name)?.bits;

    expect(width(ENTITY_STATE_FIELDS as never, 'eFlags')).toBe(19);
    expect(width(ENTITY_STATE_FIELDS as never, 'solid')).toBe(24);
    expect(width(ENTITY_STATE_FIELDS as never, 'groundEntityNum')).toBe(GENTITYNUM_BITS);
    // The same flags, four bits narrower, because a player state cannot afford them.
    expect(width(PLAYER_STATE_FIELDS as never, 'eFlags')).toBe(16);
    // The three signed fields in the whole protocol.
    expect(width(PLAYER_STATE_FIELDS as never, 'weaponTime')).toBe(-16);
    expect(width(PLAYER_STATE_FIELDS as never, 'pm_time')).toBe(-16);
    expect(width(PLAYER_STATE_FIELDS as never, 'viewheight')).toBe(-8);
  });

  it('reach one field each, in the entity state', () => {
    checkAccessorsAreDistinct(ENTITY_STATE_FIELDS, () => createEntityState());
  });

  it('reach one field each, in the player state', () => {
    checkAccessorsAreDistinct(PLAYER_STATE_FIELDS, () => createPlayerState());
  });

  it('reach the member their Quake 3 name points at', () => {
    const entity = (name: string) => namedMember(ENTITY_STATE_FIELDS, name, createEntityState);
    const player = (name: string) => namedMember(PLAYER_STATE_FIELDS, name, createPlayerState);

    // A vector index is x, y, z in that order, and the tables index them out of order on purpose.
    expect(entity('pos.trBase[0]')).toBe('pos.trBase.x');
    expect(entity('pos.trDelta[2]')).toBe('pos.trDelta.z');
    expect(entity('apos.trBase[1]')).toBe('apos.trBase.y');
    expect(entity('origin2[1]')).toBe('origin2.y');
    expect(entity('angles2[2]')).toBe('angles2.z');
    expect(player('viewangles[1]')).toBe('viewangles.y');
    expect(player('grapplePoint[0]')).toBe('grapplePoint.x');

    // Quake 3's snake case becomes the port's camel case.
    expect(player('pm_flags')).toBe('pmFlags');
    expect(player('pm_time')).toBe('pmTime');
    expect(player('pm_type')).toBe('pmType');
    expect(player('delta_angles[2]')).toBe('deltaAngles.z');
    expect(player('jumppad_ent')).toBe('jumppadEnt');

    // The two that really are array slots rather than vector components.
    expect(player('events[1]')).toBe('events.1');
    expect(player('eventParms[0]')).toBe('eventParms.0');
  });
});

describe('writeDeltaEntity', () => {
  it('writes nothing at all for an entity that did not change', () => {
    const state = createEntityState(7);
    const out = Message.write(64);
    writeDeltaEntity(out, state, copyEntityState(state, createEntityState()), false);
    expect(out.curSize).toBe(0);
  });

  it('writes a bare header when forced, and it reads back unchanged', () => {
    const from = createEntityState(7);
    from.origin.x = 42;
    const to = copyEntityState(from, createEntityState());

    expect(entityRoundTrip(from, to)).toEqual(to);
  });

  it('removes an entity by number and a single bit', () => {
    const from = createEntityState(9);
    from.origin.x = 1;

    const removed = entityRoundTrip(from, null);
    expect(removed.number).toBe(MAX_GENTITIES - 1);
    expect(removed.origin.x).toBe(0);
  });

  it('zeroes the state a removal is read into, whatever it held', () => {
    const from = createEntityState(9);
    const out = Message.write(64);
    writeDeltaEntity(out, from, null, true);

    const into = createEntityState(9);
    into.eType = 3;
    into.origin.x = 1;
    into.pos.trBase.y = 5;
    const back = Message.read(out.written.slice());
    readDeltaEntity(back, from, into, back.readBits(GENTITYNUM_BITS));
    expect(into).toEqual(createEntityState(MAX_GENTITIES - 1));
  });

  it('round-trips an entity that changed everywhere', () => {
    const from = createEntityState(3);
    const to = createEntityState(3);
    to.eType = 2;
    to.eFlags = 0x40000; // needs all nineteen bits
    to.pos.trType = 2;
    to.pos.trTime = 1234;
    to.pos.trDuration = 500;
    to.pos.trBase = { x: 16, y: -32, z: 64 };
    to.pos.trDelta = { x: 0.5, y: -0.25, z: 128 };
    to.apos.trBase = { x: 0, y: 90, z: 0 };
    to.origin = { x: 100, y: 200, z: 300 };
    to.angles = { x: 1, y: 2, z: 3 };
    to.groundEntityNum = 1022;
    to.otherEntityNum = 5;
    to.solid = 0xabcdef;
    to.powerups = 0x8001;
    to.weapon = 7;
    to.clientNum = 3;
    to.frame = 40000;
    to.constantLight = -1;
    to.event = 900;
    to.eventParm = 200;

    expect(entityRoundTrip(from, to)).toEqual(to);
  });

  it('only covers fields up to the last one that moved', () => {
    const from = createEntityState(1);
    const first = copyEntityState(from, createEntityState());
    first.pos.trTime = 5; // field 0

    const last = copyEntityState(from, createEntityState());
    last.frame = 5; // field 50

    expect(entityDeltaSize(from, first)).toBeLessThan(entityDeltaSize(from, last));
    expect(entityRoundTrip(from, first)).toEqual(first);
    expect(entityRoundTrip(from, last)).toEqual(last);
  });

  it('refuses an entity number the wire cannot carry', () => {
    const out = Message.write(64);
    const to = createEntityState(MAX_GENTITIES);
    expect(() => writeDeltaEntity(out, null, to, true)).toThrow(/bad entity number/);
  });
});

describe('the float encoding', () => {
  const roundTripOrigin = (x: number): number => {
    const from = createEntityState(1);
    const to = createEntityState(1);
    to.origin.x = x;
    return entityRoundTrip(from, to).origin.x;
  };

  it('sends a whole number in range as thirteen bits', () => {
    for (const value of [1, -1, 4095, -4096, 1000]) {
      expect(roundTripOrigin(value)).toBe(value);
    }
  });

  it('sends a whole number out of range at full width', () => {
    for (const value of [4096, -4097, 1_000_000]) {
      expect(roundTripOrigin(value)).toBe(value);
    }
  });

  it('sends a fraction at full width, rounded to the 32 bits the wire holds', () => {
    expect(roundTripOrigin(0.5)).toBe(0.5);
    expect(roundTripOrigin(-0.25)).toBe(-0.25);
    expect(roundTripOrigin(0.1)).toBe(Math.fround(0.1));
  });

  it('spends a whole number far less than a fraction', () => {
    const from = createEntityState(1);
    const whole = createEntityState(1);
    whole.origin.x = 100;
    const fraction = createEntityState(1);
    fraction.origin.x = 100.5;

    expect(entityDeltaSize(from, whole)).toBeLessThan(entityDeltaSize(from, fraction));
  });

  it('treats a change too small for the wire to carry as no change', () => {
    const from = createEntityState(1);
    from.origin.x = 1;
    const to = copyEntityState(from, createEntityState());
    // Below the precision of a 32-bit float at this magnitude, so Quake 3's bit comparison,
    // which the port reproduces by rounding first, sees no difference.
    to.origin.x = 1 + 1e-12;

    const out = Message.write(64);
    writeDeltaEntity(out, from, to, false);
    expect(out.curSize).toBe(0);
  });
});

describe('writeDeltaPlayerState', () => {
  it('round-trips a state that changed everywhere', () => {
    const from = createPlayerState();
    const to = createPlayerState();
    to.commandTime = 123456;
    to.pmType = 1;
    to.bobCycle = 200;
    to.pmFlags = 0x8001;
    to.pmTime = -1;
    to.origin = { x: 10, y: 20, z: 30 };
    to.velocity = { x: -320, y: 0.5, z: 100 };
    to.weaponTime = -400;
    to.gravity = 800;
    to.speed = 320;
    to.deltaAngles = { x: 1, y: 2, z: 3 };
    to.groundEntityNum = 1023;
    to.legsAnim = 12;
    to.torsoAnim = 13;
    to.torsoTimer = 4000;
    to.movementDir = 6;
    to.grapplePoint = { x: 1, y: 2, z: 3 };
    to.eFlags = 0x8000;
    to.eventSequence = 60000;
    to.events = [11, 22];
    to.eventParms = [33, 44];
    to.externalEvent = 900;
    to.viewangles = { x: -20, y: 170.5, z: 0 };
    to.viewheight = -16;
    to.damageEvent = 3;
    to.damageCount = 255;
    to.weapon = 31;
    to.weaponstate = 3;
    to.clientNum = 5;
    to.jumppadEnt = 77;
    to.loopSound = 40000;

    expect(playerRoundTrip(from, to)).toEqual(to);
  });

  it("sign-extends the protocol's three signed fields", () => {
    const from = createPlayerState();
    const to = createPlayerState();
    to.weaponTime = -1;
    to.pmTime = -32768;
    to.viewheight = -16;

    const back = playerRoundTrip(from, to);
    expect(back.weaponTime).toBe(-1);
    expect(back.pmTime).toBe(-32768);
    expect(back.viewheight).toBe(-16);
  });

  it('sends only the array entries that moved, and keeps the rest', () => {
    const from = createPlayerState();
    from.stats[0] = 100;
    from.stats[3] = 50;
    from.ammo[2] = 200;

    const to = copyPlayerState(from, createPlayerState());
    to.stats[0] = 75;

    const back = playerRoundTrip(from, to);
    expect(back.stats[0]).toBe(75);
    expect(back.stats[3]).toBe(50);
    expect(back.ammo[2]).toBe(200);
  });

  it('holds a health of -999 and an infinite ammo of -1, both as shorts', () => {
    const from = createPlayerState();
    const to = createPlayerState();
    to.stats[0] = -999;
    to.persistant[1] = -1;
    to.ammo[4] = -1;

    const back = playerRoundTrip(from, to);
    expect(back.stats[0]).toBe(-999);
    expect(back.persistant[1]).toBe(-1);
    expect(back.ammo[4]).toBe(-1);
  });

  it('holds a powerup expiry beyond a short, because powerups go as longs', () => {
    const from = createPlayerState();
    const to = createPlayerState();
    to.powerups[2] = 1_800_000;

    expect(playerRoundTrip(from, to).powerups[2]).toBe(1_800_000);
  });

  it('spends one bit on the arrays when none of them moved', () => {
    const from = createPlayerState();
    const to = copyPlayerState(from, createPlayerState());
    to.commandTime = 8;

    const out = Message.write(256);
    writeDeltaPlayerState(out, from, to);
    // The count byte, one changed bit, the time's field, and one bit to say the arrays held.
    expect(out.curSize).toBeLessThan(10);
  });

  it('carries the fields the table never reaches across from the last state', () => {
    const from = createPlayerState();
    from.ping = 42;
    from.pmoveFramecount = 7;
    const to = copyPlayerState(from, createPlayerState());
    to.commandTime = 8;

    const back = playerRoundTrip(from, to);
    expect(back.ping).toBe(42);
    expect(back.pmoveFramecount).toBe(7);
  });

  it('deltas against a state of nothing when there is no previous one', () => {
    const to = createPlayerState();
    to.origin = { x: 1, y: 2, z: 3 };
    to.stats[0] = 100;

    expect(playerRoundTrip(null, to)).toEqual(to);
  });
});

describe('the user command delta', () => {
  const KEY = 0x5a5a1234;

  function commandRoundTrip(from: NetUserCmd, to: NetUserCmd, key = KEY): NetUserCmd {
    const out = Message.write(256);
    writeDeltaUserCmdKey(out, KEY, from, to);
    const back = Message.read(out.written.slice());
    return readDeltaUserCmdKey(back, key, from, createNetUserCmd());
  }

  it('costs a flag and eight bits for a command within a quarter-second of the last', () => {
    const from = createNetUserCmd();
    const to = createNetUserCmd();
    to.serverTime = 8;

    const out = Message.write(256);
    writeDeltaUserCmdKey(out, KEY, from, to);
    // One bit for the short form, eight for the difference, one to say nothing else moved.
    expect(out.curSize).toBeLessThanOrEqual(3);
    expect(commandRoundTrip(from, to)).toEqual(to);
  });

  it('falls back to the full time when the gap is a quarter-second or more', () => {
    const from = createNetUserCmd();
    const to = createNetUserCmd();
    to.serverTime = 256;

    expect(commandRoundTrip(from, to).serverTime).toBe(256);
  });

  it('round-trips a command with everything held', () => {
    const from = createNetUserCmd();
    from.serverTime = 1000;
    const to: NetUserCmd = {
      serverTime: 1008,
      angles: [0xf000, 0x4000, 0],
      buttons: 0x8001,
      weapon: 7,
      forwardmove: 127,
      rightmove: -127,
      upmove: 20,
      drawnTime: 1003,
      drawnSnapTime: 950,
      drawnNextSnapTime: 1000
    };

    expect(commandRoundTrip(from, to)).toEqual(to);
  });

  it('carries the frame the input was read under, each time a byte back from its own', () => {
    const from = createNetUserCmd();
    from.serverTime = 1000;
    const to = createNetUserCmd();
    to.serverTime = 1008;
    to.drawnTime = 1003;
    to.drawnSnapTime = 1008 - 127;
    to.drawnNextSnapTime = 1008 + 128;
    expect(commandRoundTrip(from, to)).toEqual(to);

    // Past a byte either way, the whole time goes.
    to.drawnSnapTime = 1008 - 128;
    to.drawnNextSnapTime = 1008 + 129;
    to.drawnTime = 0;
    expect(commandRoundTrip(from, to)).toEqual(to);
  });

  it("carries the drawn time's part of a millisecond in 256ths, a byte back or whole", () => {
    const from = createNetUserCmd();
    from.serverTime = 1000;
    const to = createNetUserCmd();
    to.serverTime = 1008;
    to.drawnSnapTime = 950;
    to.drawnNextSnapTime = 1000;
    for (const drawnTime of [1003 + 77 / 256, 1007 + 255 / 256, 5000.5]) {
      to.drawnTime = drawnTime;
      expect(commandRoundTrip(from, to).drawnTime).toBe(drawnTime);
    }
  });

  it("sends the last command's frame as one bit, as every command of a long frame has it", () => {
    const from = createNetUserCmd();
    from.serverTime = 1000;
    from.drawnTime = 990;
    from.drawnSnapTime = 950;
    from.drawnNextSnapTime = 1000;
    const same = { ...from, angles: [0, 0, 0] as [number, number, number], serverTime: 1008 };
    const next = { ...same, drawnTime: 1003 };

    const sizes = [same, next].map((to) => {
      const out = Message.write(256);
      writeDeltaUserCmdKey(out, KEY, from, to);
      return out.curSize;
    });
    expect(sizes).toEqual([2, 5]);
    expect(commandRoundTrip(from, same)).toEqual(same);
    expect(commandRoundTrip(from, next)).toEqual(next);
  });

  it('sends the frame when only its snapshot or its next snapshot moved', () => {
    const from = createNetUserCmd();
    from.serverTime = 1000;
    from.drawnTime = 990;
    from.drawnSnapTime = 950;
    from.drawnNextSnapTime = 1000;
    const same = { ...from, angles: [0, 0, 0] as [number, number, number], serverTime: 1008 };

    for (const moved of [{ drawnSnapTime: 1000 }, { drawnNextSnapTime: 1050 }]) {
      const to = { ...same, ...moved };
      expect(commandRoundTrip(from, to)).toEqual(to);
    }
  });

  it('corrects a move axis of -128, which would outrun the player’s own speed', () => {
    const from = createNetUserCmd();
    const to = createNetUserCmd();
    to.serverTime = 8;
    to.forwardmove = -128;

    expect(commandRoundTrip(from, to).forwardmove).toBe(-127);
  });

  it('decodes to nonsense under the wrong key, which is the point of the key', () => {
    const from = createNetUserCmd();
    const to = createNetUserCmd();
    to.serverTime = 8;
    to.angles = [0x1234, 0x5678, 0];
    to.buttons = 1;

    expect(commandRoundTrip(from, to, KEY)).toEqual(to);
    expect(commandRoundTrip(from, to, KEY ^ 0xff).angles[0]).not.toBe(to.angles[0]);
  });
});

describe('a snapshot-sized delta', () => {
  it('costs a handful of bytes for a player who only moved', () => {
    const from = createPlayerState();
    from.origin = { x: 100, y: 200, z: 24 };
    from.velocity = { x: 320, y: 0, z: 0 };
    from.commandTime = 10_000;
    from.stats[0] = 100;

    const to = copyPlayerState(from, createPlayerState());
    to.commandTime = 10_008;
    to.origin.x = 103;
    to.bobCycle = 8;

    const out = Message.write(2048);
    writeDeltaPlayerState(out, from, to);
    expect(out.curSize).toBeLessThan(16);
    expect(playerRoundTrip(from, to)).toEqual(to);
  });
});
