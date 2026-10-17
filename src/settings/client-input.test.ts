import { describe, expect, it, vi } from 'vitest';

import { K } from '../formats/q3-keys';
import { BUTTON_AFFIRMATIVE, BUTTON_ATTACK } from '../sim/constants';
import { BindTable, defaultBinds } from './binds';
import { ClientInput } from './client-input';

/** A printable key's number. */
const key = (char: string) => char.charCodeAt(0);

/** Input taking the default binds, or the ones given, with the game taking input. */
function setup(binds: Iterable<readonly [number, string]> = defaultBinds(true), taken = true) {
  const command = vi.fn(() => taken);
  const warn = vi.fn();
  const input = new ClientInput(new BindTable(binds), { command, warn });
  input.active = true;
  return { input, command, warn };
}

describe('ClientInput: the move', () => {
  it("moves on WASD, jumps on Space and crouches on Shift, through the default binds", () => {
    const { input } = setup();
    input.keyDown(key('w'));
    input.keyDown(key('d'));
    input.keyDown(K.SPACE);
    expect(input.keyMove()).toEqual({ forwardmove: 127, rightmove: 127, upmove: 127 });

    input.keyUp(key('w'));
    input.keyUp(key('d'));
    input.keyUp(K.SPACE);
    input.keyDown(key('s'));
    input.keyDown(key('a'));
    input.keyDown(K.SHIFT);
    expect(input.keyMove()).toEqual({ forwardmove: -127, rightmove: -127, upmove: -127 });
  });

  it('cancels keys pulling opposite ways, jump and crouch as well, as CL_KeyMove sums them', () => {
    const { input } = setup();
    for (const held of [key('w'), key('s'), K.SPACE, K.SHIFT]) input.keyDown(held);
    expect(input.keyMove()).toEqual({ forwardmove: 0, rightmove: 0, upmove: 0 });
  });

  it('holds a button while either of two keys holds it, as kbutton_t does', () => {
    const { input } = setup([
      [key('w'), '+forward'],
      [K.UPARROW, '+forward']
    ]);
    input.keyDown(key('w'));
    input.keyDown(K.UPARROW);
    input.keyUp(key('w'));
    expect(input.keyMove().forwardmove).toBe(127);
    input.keyUp(K.UPARROW);
    expect(input.keyMove().forwardmove).toBe(0);
  });

  it('gives the move in one object, written again, so a frame asking makes nothing', () => {
    const { input } = setup();
    const move = input.keyMove();
    input.keyDown(key('w'));
    expect(input.keyMove()).toBe(move);
    expect(move).toEqual({ forwardmove: 127, rightmove: 0, upmove: 0 });
  });

  it('refuses a third key on one button, as Q3 does', () => {
    const { input, warn } = setup([
      [key('w'), '+forward'],
      [K.UPARROW, '+forward'],
      [K.KP_UPARROW, '+forward']
    ]);
    input.keyDown(key('w'));
    input.keyDown(K.UPARROW);
    input.keyDown(K.KP_UPARROW);
    expect(warn).toHaveBeenCalledWith('Three keys down for a button!');
    input.keyUp(key('w'));
    input.keyUp(K.UPARROW);
    expect(input.keyMove().forwardmove).toBe(0);
  });
});

describe('ClientInput: the buttons', () => {
  it('attacks on the left button, and holds the grapple on F', () => {
    const { input } = setup();
    input.keyDown(K.MOUSE1);
    input.keyDown(key('f'));
    expect(input.cmdButtons()).toBe(BUTTON_ATTACK | BUTTON_AFFIRMATIVE);
    input.keyUp(K.MOUSE1);
    expect(input.cmdButtons()).toBe(BUTTON_AFFIRMATIVE);
  });

  it('puts +button<i> on bit i, which is what makes the grapple key a button', () => {
    // `CL_CmdButtons` numbers them and nothing else does: `+button5` is bit 5, which the game
    // module reads as `BUTTON_AFFIRMATIVE` without ever hearing what key was pressed.
    const { input } = setup([
      [key('1'), '+button3'],
      [key('2'), '+button5'],
      [key('3'), '+button14']
    ]);
    input.keyDown(key('1'));
    input.keyDown(key('2'));
    input.keyDown(key('3'));
    expect(input.cmdButtons()).toBe(8 | BUTTON_AFFIRMATIVE | 16384);
  });

  it('leaves a button past the fifteenth off the command, as Quake III does', () => {
    const { input } = setup([[key('1'), '+button15']]);
    input.keyDown(key('1'));
    expect(input.cmdButtons()).toBe(0);
  });

  it('fires once for a click shorter than a frame, as CL_CmdButtons reads one', () => {
    const { input } = setup();
    input.keyDown(K.MOUSE1);
    input.keyUp(K.MOUSE1);
    expect(input.cmdButtons()).toBe(BUTTON_ATTACK);
    expect(input.cmdButtons()).toBe(0);
  });

  it('takes +button0 as +attack', () => {
    const { input } = setup([[K.CTRL, '+button0']]);
    input.keyDown(K.CTRL);
    expect(input.cmdButtons()).toBe(BUTTON_ATTACK);
  });
});

describe('ClientInput: commands', () => {
  it('keeps the weapon commands for the frame, the number row and the wheel alike', () => {
    const { input, command } = setup();
    for (const pressed of [key('5'), K.MWHEELUP, K.MWHEELDOWN]) {
      input.keyDown(pressed);
      input.keyUp(pressed);
    }
    expect(input.takeCommands()).toEqual([['weapon', '5'], ['weapprev'], ['weapnext']]);
    expect(input.takeCommands()).toEqual([]);
    expect(command).not.toHaveBeenCalled();
  });

  it("keeps the console's weapon commands for the frame as a bind's, input taken or not", () => {
    const { input, command } = setup();
    input.active = false;
    expect(input.cgameCommand(['weapon', '5'])).toBe(true);
    expect(input.cgameCommand(['WEAPNEXT'])).toBe(true);
    expect(input.cgameCommand(['cg_fov', '100'])).toBe(false);
    expect(input.cgameCommand([])).toBe(false);
    expect(input.takeCommands()).toEqual([['weapon', '5'], ['WEAPNEXT']]);
    expect(command).not.toHaveBeenCalled();
  });

  it('makes nothing for a frame with no command to take', () => {
    const { input } = setup();
    const none = input.takeCommands();
    expect(input.takeCommands()).toBe(none);
    input.keyDown(key('5'));
    expect(input.takeCommands()).toEqual([['weapon', '5']]);
    expect(none).toEqual([]);
  });

  it('runs +scores on the press and -scores on the release, as Q3 runs a +command', () => {
    const { input, command } = setup([[K.TAB, '+scores']]);
    input.keyDown(K.TAB);
    expect(command).toHaveBeenCalledWith(['+scores']);

    command.mockClear();
    input.keyUp(K.TAB);
    expect(command).toHaveBeenCalledWith(['-scores']);
  });

  it('runs the -scores half even with input out, as the - half of a bind', () => {
    const { input, command } = setup([[K.TAB, '+scores']]);
    input.keyDown(K.TAB);
    command.mockClear();

    // Going out lets every key go, and a `-` command still runs (`cl_keys.c:1352–1358`).
    input.active = false;
    expect(command).toHaveBeenCalledWith(['-scores']);
  });

  it("keeps the client's own buttons out of the console: +forward and +button5 run nothing", () => {
    const { input, command } = setup();
    for (const pressed of [key('w'), key('f')]) {
      input.keyDown(pressed);
      input.keyUp(pressed);
    }
    expect(command).not.toHaveBeenCalled();
  });

  it("runs any other command at once, on the press alone: C's toggle", () => {
    const { input, command } = setup();
    input.keyDown(key('c'));
    input.keyUp(key('c'));
    expect(command).toHaveBeenCalledOnce();
    expect(command).toHaveBeenCalledWith(['toggle', 'pcq_drawCollision']);
  });

  it('runs each command of a bind split at its semicolons', () => {
    const { input, command } = setup([[key('x'), '+attack; weapon 7;cg_fov 100']]);
    input.keyDown(key('x'));
    expect(input.cmdButtons()).toBe(BUTTON_ATTACK);
    expect(input.takeCommands()).toEqual([['weapon', '7']]);
    expect(command).toHaveBeenCalledWith(['cg_fov', '100']);
    input.keyUp(key('x'));
    expect(input.cmdButtons()).toBe(0);
  });

  it('reports a command nothing takes', () => {
    const { input, warn } = setup([[key('x'), 'vstr go']], false);
    input.keyDown(key('x'));
    expect(warn).toHaveBeenCalledWith('Unknown command "vstr"');
  });

  it('leaves Escape to the menu, whatever it is bound to', () => {
    const { input, command } = setup([[K.ESCAPE, 'togglemenu']]);
    input.keyDown(K.ESCAPE);
    expect(command).not.toHaveBeenCalled();
  });
});

describe('ClientInput: when the game takes input', () => {
  it('runs nothing while the game does not take input', () => {
    const { input, command } = setup();
    input.active = false;
    for (const pressed of [key('w'), key('c'), key('5'), K.MOUSE1]) input.keyDown(pressed);
    expect(input.keyMove().forwardmove).toBe(0);
    expect(input.cmdButtons()).toBe(0);
    expect(input.takeCommands()).toEqual([]);
    expect(command).not.toHaveBeenCalled();
  });

  it('lets every key go when the game stops taking input, as Key_ClearStates does', () => {
    const { input } = setup();
    input.keyDown(key('w'));
    input.keyDown(key('f'));
    input.active = false;
    expect(input.keyMove().forwardmove).toBe(0);
    // The press made before still counts once.
    expect(input.cmdButtons()).toBe(BUTTON_AFFIRMATIVE);
    expect(input.cmdButtons()).toBe(0);
  });

  it('passes by the release of a key it never took, such as the click that caught the mouse', () => {
    const { input } = setup();
    input.keyUp(K.MOUSE1);
    expect(input.cmdButtons()).toBe(0);
  });

  it('gathers mouse movement for the frame while the game takes input, and drops it otherwise', () => {
    const { input } = setup();
    input.mouseMove(3, -2);
    input.mouseMove(4, 1);
    expect(input.takeMouse()).toEqual({ dx: 7, dy: -1 });
    expect(input.takeMouse()).toEqual({ dx: 0, dy: 0 });

    input.mouseMove(5, 5);
    input.active = false;
    input.mouseMove(9, 9);
    expect(input.takeMouse()).toEqual({ dx: 0, dy: 0 });
  });

  it('gives the movement in one object, written again at each taking', () => {
    const { input } = setup();
    const movement = input.takeMouse();
    input.mouseMove(2, 3);
    expect(input.takeMouse()).toBe(movement);
    expect(movement).toEqual({ dx: 2, dy: 3 });
  });

  it('says which keys are bound', () => {
    const { input } = setup();
    expect(input.bound(key('w'))).toBe(true);
    expect(input.bound(key('z'))).toBe(false);
  });
});
