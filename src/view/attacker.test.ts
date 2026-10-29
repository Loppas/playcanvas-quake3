import { describe, expect, it } from 'vitest';
import { ENTITYNUM_WORLD, MAX_CLIENTS } from '../net/protocol';
import {
  createAttacker,
  expireAttacker,
  lastAttacker,
  tellAttackerCommand,
  type AttackerState
} from './attacker';
import type { ClientInfo } from './client-info';

/** Slot 3 is Bones; every other slot is empty. */
const bones = (clientNum: number) => (clientNum === 3 ? ({ name: 'Bones' } as ClientInfo) : null);

describe('lastAttacker', () => {
  it('names PERS_ATTACKER while the attacker time holds, and nobody before any hurt', () => {
    expect(lastAttacker(createAttacker(), 3)).toBe(-1);
    expect(lastAttacker({ time: 1000 }, 3)).toBe(3);
    expect(lastAttacker({ time: 1000 }, ENTITYNUM_WORLD)).toBe(ENTITYNUM_WORLD);
  });
});

describe('expireAttacker', () => {
  /** Bones hurt the player, slot 0, at 1000; what is left of the time after this frame. */
  function after(over: Partial<Parameters<typeof expireAttacker>[1]>): number {
    const state: AttackerState = { time: 1000 };
    const input = { health: 100, attackerNum: 3, clientNum: 0, time: 2000, clientInfo: bones };
    expireAttacker(state, { ...input, ...over });
    return state.time;
  }

  it('lets the attacker go once the hurt is more than 10 s old', () => {
    expect(after({ time: 11_000 })).toBe(1000);
    // `cg.time` is whole milliseconds.
    expect(after({ time: 11_000.5 })).toBe(1000);
    expect(after({ time: 11_001 })).toBe(0);
  });

  it("lets the attacker go at once when their info has gone", () => {
    expect(after({ clientInfo: () => null })).toBe(0);
  });

  it('keeps the attacker while the player is dead', () => {
    expect(after({ health: 0, time: 20000 })).toBe(1000);
    expect(after({ health: 1, time: 20000 })).toBe(0);
  });

  it('keeps a hurt by the world, or by the player themself, however old', () => {
    expect(after({ attackerNum: ENTITYNUM_WORLD, time: 20000 })).toBe(1000);
    expect(after({ attackerNum: MAX_CLIENTS, time: 20000 })).toBe(1000);
    expect(after({ attackerNum: -1, time: 20000 })).toBe(1000);
    expect(after({ attackerNum: 3, clientNum: 3, time: 20000 })).toBe(1000);
    expect(after({ attackerNum: MAX_CLIENTS - 1, clientInfo: () => null })).toBe(0);
  });
});

describe('tellAttackerCommand', () => {
  /** The command for `argv`, and what was printed making it. */
  function tell(attacker: number, argv: readonly string[]) {
    const printed: string[] = [];
    return { command: tellAttackerCommand(attacker, argv, (text) => printed.push(text)), printed };
  }

  it('tells the attacker the words after it, joined by spaces', () => {
    expect(tell(3, ['tell_attacker', 'nice', 'shot'])).toEqual({
      command: 'tell 3 nice shot',
      printed: []
    });
    // The game answers this one with its usage line.
    expect(tell(3, ['tell_attacker']).command).toBe('tell 3 ');
    expect(tell(ENTITYNUM_WORLD, ['tell_attacker', 'ow']).command).toBe('tell 1022 ow');
  });

  it('sends nothing with nobody to tell', () => {
    expect(tell(-1, ['tell_attacker', 'nice'])).toEqual({ command: null, printed: [] });
  });

  it("cuts the words, then the command, to 127 bytes, and says the command's cut", () => {
    // "tell 3 " and 120 more fill 127.
    expect(tell(3, ['tell_attacker', 'a'.repeat(120)])).toEqual({
      command: `tell 3 ${'a'.repeat(120)}`,
      printed: []
    });
    expect(tell(3, ['tell_attacker', 'a'.repeat(121)])).toEqual({
      command: `tell 3 ${'a'.repeat(120)}`,
      printed: ['Com_sprintf: Output length 128 too short, require 129 bytes.\n']
    });
    // The words are cut to 127 before the command is written: 7 + 127 and the NUL.
    expect(tell(3, ['tell_attacker', 'a'.repeat(100), 'b'.repeat(100)]).printed).toEqual([
      'Com_sprintf: Output length 128 too short, require 135 bytes.\n'
    ]);
  });
});
