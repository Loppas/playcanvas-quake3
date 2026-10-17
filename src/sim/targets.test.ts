import { describe, expect, it } from 'vitest';

import { MAX_CLIENTS } from '../net/protocol';
import { FL } from './constants';
import type { GameEntity } from './game-entity';
import { Level } from './level';
import { findTeams, MAX_CHOICES, pickTarget, useTargets } from './targets';

/** A level with an entity per name given, each found by that name, and what was printed. */
function named(...targetnames: string[]) {
  const level = new Level();
  const entities = targetnames.map((targetname) => {
    const entity = level.spawnEntity();
    entity.targetname = targetname;
    return entity;
  });
  const prints: string[] = [];
  return { level, entities, prints, print: (text: string) => void prints.push(text) };
}

describe('pickTarget', () => {
  it('takes one of the entities the name finds, the roll scaled to how many there are', () => {
    const { level, entities, print } = named('a', 'b', 'A', 'a');
    expect(pickTarget(level, 'a', () => 0, print)).toBe(entities[0]);
    // The name is matched without regard to case, so there are three.
    expect(pickTarget(level, 'a', () => 0.5, print)).toBe(entities[2]);
    expect(pickTarget(level, 'a', () => 0.99, print)).toBe(entities[3]);
  });

  it(`chooses among the first ${MAX_CHOICES} alone`, () => {
    const { level, entities, print } = named(...Array<string>(MAX_CHOICES + 8).fill('x'));
    expect(pickTarget(level, 'x', () => 0.999, print)).toBe(entities[MAX_CHOICES - 1]);
  });

  it("says so when there is nothing to find, with Quake 3's words", () => {
    const { level, prints, print } = named('a');
    expect(pickTarget(level, 'b', () => 0, print)).toBeNull();
    expect(pickTarget(level, null, () => 0, print)).toBeNull();
    expect(prints).toEqual([
      'G_PickTarget: target b not found',
      'G_PickTarget called with NULL targetname'
    ]);
  });
});

describe('useTargets', () => {
  /** Give an entity a `use` that records who used it and who set that off. */
  function recording(entity: GameEntity, calls: string[]): void {
    entity.use = (self, other, activator) =>
      void calls.push(`${self.s.number} by ${other.s.number} for ${activator?.s.number ?? 'none'}`);
  }

  it('fires every entity the target names, in turn, and steps over one with no use', () => {
    const { level, entities, print } = named('door', 'door', 'door');
    const [first, idle, last] = entities;
    const firer = level.spawnEntity();
    firer.target = 'door';
    const player = level.gentities[0];
    const calls: string[] = [];
    recording(first, calls);
    recording(last, calls);

    useTargets(level, firer, player, print);

    expect(idle.use).toBeNull();
    expect(calls).toEqual([
      `${first.s.number} by ${firer.s.number} for 0`,
      `${last.s.number} by ${firer.s.number} for 0`
    ]);
  });

  it("fires for no one, as a train's corner does", () => {
    const { level, entities, print } = named('door');
    const corner = level.spawnEntity();
    corner.target = 'door';
    const calls: string[] = [];
    recording(entities[0], calls);

    useTargets(level, corner, null, print);

    expect(calls).toEqual([`${entities[0].s.number} by ${corner.s.number} for none`]);
  });

  it('does nothing for no entity, or for one that targets nothing', () => {
    const { level, entities, prints, print } = named('door');
    const calls: string[] = [];
    recording(entities[0], calls);

    useTargets(level, null, level.gentities[0], print);
    useTargets(level, level.spawnEntity(), level.gentities[0], print);

    expect(calls).toEqual([]);
    expect(prints).toEqual([]);
  });

  it('warns rather than fire an entity that names itself', () => {
    const { level, entities, prints, print } = named('loop');
    const [loop] = entities;
    loop.target = 'loop';
    const calls: string[] = [];
    recording(loop, calls);

    useTargets(level, loop, level.gentities[0], print);

    expect(calls).toEqual([]);
    expect(prints).toEqual(['WARNING: Entity used itself.']);
  });

  it('stops when what it fired has freed the firer', () => {
    const { level, entities, prints, print } = named('trap', 'trap');
    const firer = level.spawnEntity();
    firer.target = 'trap';
    const calls: string[] = [];
    entities[0].use = () => level.freeEntity(firer);
    recording(entities[1], calls);

    useTargets(level, firer, level.gentities[0], print);

    expect(calls).toEqual([]);
    expect(prints).toEqual(['entity was removed while using targets']);
  });
});

describe('findTeams', () => {
  /** A level with an entity per team given, in order, and what was printed. */
  function teamed(...teams: (string | null)[]) {
    const level = new Level();
    const entities = teams.map((team) => {
      const entity = level.spawnEntity();
      entity.team = team;
      return entity;
    });
    const prints: string[] = [];
    return { level, entities, prints, print: (text: string) => void prints.push(text) };
  }

  it('chains a team from its first, marking all but that one', () => {
    const { level, entities, print } = teamed('quad', 'armor', 'quad', 'quad');
    findTeams(level, print);
    const [first, , second, third] = entities;

    expect(first.teammaster).toBe(first);
    expect(first.teamchain).toBe(third);
    expect(third.teamchain).toBe(second);
    expect(second.teamchain).toBeNull();
    for (const member of [second, third]) {
      expect(member.teammaster).toBe(first);
      expect(member.flags & FL.TEAMMEMBER).toBe(FL.TEAMMEMBER);
    }
    expect(entities[1].flags & FL.TEAMMEMBER).toBe(0);
    expect(entities[1].teammaster).toBe(entities[1]);
  });

  it("moves a member's name to the master, which is what a target then finds", () => {
    const { level, entities, print } = teamed('quad', 'quad', 'quad');
    entities[2].targetname = 'button';
    findTeams(level, print);

    expect(entities[0].targetname).toBe('button');
    expect(entities[2].targetname).toBeNull();
  });

  it('leaves nameless entities and the client slots out of every team', () => {
    const { level, entities, prints, print } = teamed(null, '');
    const client = level.gentities[0];
    client.inuse = true;
    client.team = 'quad';
    findTeams(level, print);

    expect(entities[0].teammaster).toBeNull();
    expect(entities[1].teammaster).toBe(entities[1]);
    expect(client.teammaster).toBeNull();
    expect(entities[1].s.number).toBeGreaterThanOrEqual(MAX_CLIENTS);
    // An empty name is still a name, as a key with no value is: two of them share a team.
    expect(prints).toEqual(['1 teams with 1 entities']);
  });

  it('counts the teams and the entities in them, as Q3 prints it', () => {
    const { level, prints, print } = teamed('a', 'b', 'a', 'b', null);
    findTeams(level, print);
    expect(prints).toEqual(['2 teams with 4 entities']);
  });
});
