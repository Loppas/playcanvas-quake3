import { describe, expect, it } from 'vitest';

import { MAX_CLIENTS, TR } from '../net/protocol';
import { EV } from './events';
import { ET, type GameEntity } from './game-entity';
import { EVENT_VALID_MSEC, Level } from './level';
import { tempEntity } from './temp-entity';
import { vec3 } from './vec3';

/**
 * An entity that exists only to say that something happened somewhere, and is gone as soon as
 * everyone has been told.
 */

/** A level with a link trap, so a test can see what reached the server. */
function world(): { level: Level; linked: number[] } {
  const linked: number[] = [];
  const level = new Level({
    handlers: {
      linkEntity: (entity: GameEntity) => {
        entity.r.linked = true;
        linked.push(entity.s.number);
      },
      unlinkEntity: (entity: GameEntity) => {
        entity.r.linked = false;
      }
    }
  });
  return { level, linked };
}

describe('tempEntity', () => {
  it('carries its event in its type, which is what makes it an event and nothing else', () => {
    const { level } = world();
    const spark = tempEntity(level, vec3(64, 0, 32), EV.BULLET_HIT_WALL);

    expect(spark.s.eType).toBe(ET.EVENTS + EV.BULLET_HIT_WALL);
    // Not on `s.event`: an entity that is only an event needs no counter, because it is new.
    expect(spark.s.event).toBe(0);
    expect(spark.classname).toBe('tempEntity');
  });

  it('takes a slot above the clients, as anything the game spawns does', () => {
    const { level } = world();
    const spark = tempEntity(level, vec3(), EV.MISSILE_MISS);

    expect(spark.inuse).toBe(true);
    expect(spark.s.number).toBeGreaterThanOrEqual(MAX_CLIENTS);
  });

  it('snaps its origin to whole units, because the wire charges for the difference', () => {
    const { level } = world();
    const spark = tempEntity(level, vec3(64.7, -12.2, 32.9), EV.BULLET_HIT_WALL);

    expect(spark.r.currentOrigin).toEqual(vec3(64, -12, 32));
    // Both halves, so collision and the wire agree: `G_SetOrigin` writes the trajectory too.
    expect(spark.s.pos.trBase).toEqual(vec3(64, -12, 32));
    expect(spark.s.pos.trType).toBe(TR.STATIONARY);
  });

  it('links itself, since an entity nothing has linked reaches nobody', () => {
    const { level, linked } = world();
    const spark = tempEntity(level, vec3(), EV.MISSILE_MISS);

    expect(linked).toEqual([spark.s.number]);
    expect(spark.r.linked).toBe(true);
  });

  it('is freed once every client has had time to see it, and not before', () => {
    const { level } = world();
    level.runFrame(1000);
    const spark = tempEntity(level, vec3(), EV.MISSILE_MISS);
    expect(spark.eventTime).toBe(1000);

    level.runFrame(1000 + EVENT_VALID_MSEC);
    expect(spark.inuse).toBe(true);

    level.runFrame(1000 + EVENT_VALID_MSEC + 8);
    expect(spark.inuse).toBe(false);
    expect(spark.r.linked).toBe(false);
  });

  it('does nothing else while it waits: it is not a thing in the world', () => {
    // The frame skips anything carrying an event it has not finished showing, so a temp entity
    // never thinks, moves or is run as whatever its type would otherwise have made it.
    const { level } = world();
    let thoughts = 0;
    const spark = tempEntity(level, vec3(), EV.MISSILE_MISS);
    spark.nextthink = 8;
    spark.think = () => {
      thoughts++;
    };

    for (let time = 8; time <= EVENT_VALID_MSEC; time += 8) level.runFrame(time);

    expect(thoughts).toBe(0);
  });

  it('leaves what the event carries to the caller, because that is the event\'s business', () => {
    const { level } = world();
    const blast = tempEntity(level, vec3(), EV.SHOTGUN);
    blast.s.eventParm = 231;
    blast.s.otherEntityNum = 3;
    blast.s.origin2 = vec3(4096, 0, 0);

    expect(blast.s.eventParm).toBe(231);
    expect(blast.s.otherEntityNum).toBe(3);
    expect(blast.s.origin2).toEqual(vec3(4096, 0, 0));
  });
});
