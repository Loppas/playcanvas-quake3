import { describe, expect, it } from 'vitest';
import { ENTITYNUM_WORLD } from '../net/protocol';
import { tellCommand } from './tell-command';

describe('tellCommand', () => {
  /** The command for `argv`, and what was printed making it. */
  function tell(target: number, argv: readonly string[]) {
    const printed: string[] = [];
    return { command: tellCommand(target, argv, (text) => printed.push(text)), printed };
  }

  it('tells the target the words after the command, joined by spaces', () => {
    expect(tell(3, ['tell_attacker', 'nice', 'shot'])).toEqual({
      command: 'tell 3 nice shot',
      printed: []
    });
    expect(tell(5, ['tell_target', 'over', 'here'])).toEqual({
      command: 'tell 5 over here',
      printed: []
    });
    // The game answers this one with its usage line.
    expect(tell(3, ['tell_attacker']).command).toBe('tell 3 ');
    expect(tell(ENTITYNUM_WORLD, ['tell_attacker', 'ow']).command).toBe('tell 1022 ow');
  });

  it('sends nothing with nobody to tell', () => {
    expect(tell(-1, ['tell_attacker', 'nice'])).toEqual({ command: null, printed: [] });
    expect(tell(-1, ['tell_target', 'nice'])).toEqual({ command: null, printed: [] });
  });

  it('tells slot 0, which is a player', () => {
    expect(tell(0, ['tell_target', 'hi']).command).toBe('tell 0 hi');
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
