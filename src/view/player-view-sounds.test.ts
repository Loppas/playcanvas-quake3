import { describe, expect, it } from 'vitest';

import { PMOVE_MSEC } from '../sim/constants';
import { EV, eventNumber, type Event } from '../sim/events';
import type { GameEntity } from '../sim/game-entity';
import { respawnItem } from '../sim/item-touch';
import { findItem, itemIndex } from '../sim/items';
import { tempEntity } from '../sim/temp-entity';
import { spawnInto } from '../sim/trigger-test-fixtures';
import type { UserCmd } from '../sim/types';
import { vec3 } from '../sim/vec3';
import type { WorldEffect } from './entity-events';
import { TELE_IN_SOUND } from './teleport-events';
import { ViewWorld } from './view-test-fixtures';

/**
 * What the items sound like from the client's side: an item taken or coming back, the match's own
 * announcement of a powerup, and the one pickup the world never makes a sound for — the player's
 * own, which reaches them as their own event and is played by the sound bus.
 */

/** A command with nothing held and nothing pressed. */
function idle(): Omit<UserCmd, 'serverTime'> {
  return {
    forwardmove: 0,
    rightmove: 0,
    upmove: 0,
    angles: vec3(),
    buttons: 0,
    weapon: 0
  };
}

/** A world whose map places a quad where the player cannot reach it yet. */
function worldWithQuad(): ViewWorld {
  return new ViewWorld({
    origin: vec3(0, 0, 24),
    items: [{ classname: 'item_quad', origin: vec3(96, 0, 24) }]
  });
}

/** Ticks, keeping everything the client made of them: an effect belongs to the frame it is in. */
function heard(world: ViewWorld, count = 30): WorldEffect[] {
  const effects: WorldEffect[] = [];
  for (let i = 0; i < count; i++) {
    world.view.advance(PMOVE_MSEC, idle());
    effects.push(...world.view.effects);
  }
  return effects;
}

/** The item entity the map placed, by its classname. */
function placed(world: ViewWorld, classname: string): GameEntity {
  const entity = world.level.gentities.find(
    (candidate) => candidate.inuse && candidate.classname === classname
  );
  if (!entity) throw new Error(`no ${classname} on the map`);
  return entity;
}

/** The sounds of a set of effects, which is all these tests are about. */
function sounds(effects: readonly WorldEffect[]): WorldEffect[] {
  return effects.filter((effect) => effect.type === 'sound' || effect.type === 'gameSound');
}

const ANNOUNCEMENT = 'sound/items/poweruprespawn.wav';

describe('the items a client hears', () => {
  it('hears a powerup arrive as the sound the match named, from the listener', () => {
    const world = worldWithQuad();
    heard(world);

    respawnItem(world.level, placed(world, 'item_quad'));

    // The announcement comes through `CS_SOUNDS`, so this also pins the block itself: the index
    // the server wrote is the one the client reads its name back from. The quad named it as it
    // spawned.
    expect(sounds(heard(world))).toContainEqual({
      type: 'gameSound',
      index: world.game.game.soundIndex(ANNOUNCEMENT),
      name: ANNOUNCEMENT,
      number: world.game.clientNum,
      origin: null
    });
  });

  it('hears the item itself come back where it stands, as well as the announcement', () => {
    const world = worldWithQuad();
    heard(world);

    respawnItem(world.level, placed(world, 'item_quad'));

    const respawn = sounds(heard(world)).find(
      (effect) => effect.type === 'sound' && effect.path === 'sound/items/respawn1.wav'
    )!;
    expect(respawn).toBeDefined();
    if (respawn.type !== 'sound' || !respawn.origin) throw new Error('no respawn at a place');
    // The item is on the garage floor, its own radius up from it.
    expect(respawn.origin.x).toBeCloseTo(96, 1);
    expect(respawn.origin.z).toBeCloseTo(15, 0);
  });

  it('hears a sound the match named where the entity carrying it stands', () => {
    const world = new ViewWorld();
    heard(world, 3);
    const index = world.game.game.soundIndex(ANNOUNCEMENT);

    const temp = tempEntity(world.level, vec3(64, 0, 40), EV.GENERAL_SOUND);
    temp.s.eventParm = index;

    expect(sounds(heard(world, 3))).toContainEqual({
      type: 'gameSound',
      index,
      name: ANNOUNCEMENT,
      number: temp.s.number,
      origin: vec3(64, 0, 40)
    });
  });

  it("voices a `*` sound the match named as a model's own, in client 0's voice", () => {
    const world = new ViewWorld();
    heard(world, 3);
    const index = world.game.game.soundIndex('*drown.wav');

    tempEntity(world.level, vec3(64, 0, 40), EV.GENERAL_SOUND).s.eventParm = index;

    const voiced = [];
    for (let i = 0; i < 3; i++) {
      world.view.advance(PMOVE_MSEC, idle());
      voiced.push(...world.view.entitySounds);
    }
    expect(voiced.map(({ voice, sound }) => ({ voice, sound }))).toContainEqual({
      voice: 0,
      sound: { type: 'custom', name: 'drown' }
    });
  });

  it('hears a global one from the listener, wherever it happened', () => {
    const world = new ViewWorld();
    heard(world, 3);
    const index = world.game.game.soundIndex(ANNOUNCEMENT);

    tempEntity(world.level, vec3(64, 0, 40), EV.GLOBAL_SOUND).s.eventParm = index;

    expect(sounds(heard(world, 3))).toContainEqual({
      type: 'gameSound',
      index,
      name: ANNOUNCEMENT,
      number: world.game.clientNum,
      origin: null
    });
  });

  it('leaves its own pickup to its own events: the world makes no sound of it', () => {
    // A pickup by the player is on their player state (`G_AddEvent` on a client writes
    // `ps.externalEvent`), so the client hears it from its own body rather than from the world —
    // and the world must say nothing, or it would be heard twice.
    const world = new ViewWorld({
      origin: vec3(0, 0, 24),
      items: [{ classname: 'ammo_bullets', origin: vec3(0, 0, 24) }]
    });

    let pickup: Event | undefined;
    let effectsAtPickup: readonly WorldEffect[] = [];
    for (let i = 0; i < 30 && !pickup; i++) {
      const played = world.view.advance(PMOVE_MSEC, idle());
      pickup = played.find(({ event }) => eventNumber(event) === EV.ITEM_PICKUP);
      if (pickup) effectsAtPickup = [...world.view.effects];
    }

    expect(pickup?.parm).toBe(itemIndex(findItem('ammo_bullets')!));
    // The world's one sound is the player's own arrival at the spawn, which came with the pickup.
    expect(sounds(effectsAtPickup)).toEqual([
      { type: 'sound', path: TELE_IN_SOUND, number: expect.any(Number), origin: vec3(0, 0, 24) }
    ]);
  });
});

describe('the world a client hears', () => {
  it('hands the bus each speaker the snapshot carries, its sound named by a cs', () => {
    const world = new ViewWorld();
    heard(world, 3);
    world.view.takeSoundChanges();
    const name = 'sound/world/fire1.wav';
    spawnInto(world.level, [
      {
        classname: 'target_speaker',
        origin: '128 64 32',
        noise: name,
        spawnflags: '1',
        wait: '2',
        random: '1.5'
      }
    ]);
    heard(world, 3);

    const index = world.game.game.soundIndex(name);
    expect(world.view.takeSoundChanges()).toEqual([{ index, name }]);
    expect(world.view.soundEntities().find((entity) => entity.speaker)).toMatchObject({
      origin: vec3(128, 64, 32),
      soundOrigin: vec3(128, 64, 32),
      loopSound: index,
      eventParm: index,
      frame: 20,
      clientNum: 15
    });
  });
});
