import { describe, expect, it, vi } from 'vitest';

import { K } from '../formats/q3-keys';
import { BUTTON_AFFIRMATIVE, BUTTON_ATTACK } from '../sim/constants';
import { routedInput } from './input-test-fixtures';

/** A printable key's number. */
const key = (char: string) => char.charCodeAt(0);

/**
 * Input taking the default binds, or the ones given, with the game taking input, and its commands
 * run through a console of its own. `cgame` hears cgame's commands other than the weapons'.
 */
function setup(binds?: Iterable<readonly [number, string]>) {
  const cgame = vi.fn((argv: readonly string[]) => argv[0].toLowerCase().endsWith('scores'));
  const wired = routedInput(binds, cgame);
  wired.input.active = true;
  return { ...wired, cgame };
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
    const { input, printed } = setup([
      [key('w'), '+forward'],
      [K.UPARROW, '+forward'],
      [K.KP_UPARROW, '+forward']
    ]);
    input.keyDown(key('w'));
    input.keyDown(K.UPARROW);
    input.keyDown(K.KP_UPARROW);
    expect(printed).toEqual(['Three keys down for a button!\n']);
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

  it('has no button past the fifteenth, as Quake III has none', () => {
    const { input, printed } = setup([[key('1'), '+button15']]);
    input.keyDown(key('1'));
    input.keyUp(key('1'));
    expect(input.cmdButtons()).toBe(0);
    expect(printed).toEqual(['Unknown command "+button15^7"\n']);
  });

  it('fires once for a click shorter than a frame, as CL_CmdButtons reads one', () => {
    const { input } = setup();
    input.keyDown(K.MOUSE1);
    input.keyUp(K.MOUSE1);
    expect(input.cmdButtons()).toBe(BUTTON_ATTACK);
    expect(input.cmdButtons()).toBe(0);
  });

  it('takes +button0 as +attack, one button held by either', () => {
    const { input } = setup([
      [K.CTRL, '+button0'],
      [key('x'), '+attack']
    ]);
    input.keyDown(K.CTRL);
    input.keyDown(key('x'));
    input.keyUp(K.CTRL);
    expect(input.cmdButtons()).toBe(BUTTON_ATTACK);
    input.keyUp(key('x'));
    expect(input.cmdButtons()).toBe(0);
  });
});

describe('ClientInput: the buttons as console commands (cl_input.c:76–150)', () => {
  it('holds a button pressed at the console, naming no key, until a release there', () => {
    const { input, router } = setup();
    router.execute(['+forward']);
    expect(input.keyMove().forwardmove).toBe(127);
    // Pressed again, it is the same key held, as a key's repeat is.
    router.execute(['+forward']);
    input.keyDown(key('w'));
    input.keyUp(key('w'));
    expect(input.keyMove().forwardmove).toBe(127);
    router.execute(['-forward']);
    expect(input.keyMove().forwardmove).toBe(0);
  });

  it('lets go whatever keys hold a button at a release typed at the console', () => {
    const { input, router, printed } = setup([
      [key('w'), '+forward'],
      [K.UPARROW, '+forward'],
      [K.KP_UPARROW, '+forward'],
      [K.MOUSE1, '+attack']
    ]);
    input.keyDown(key('w'));
    input.keyDown(K.UPARROW);
    input.keyDown(K.MOUSE1);
    router.execute(['-FORWARD']);
    router.execute(['-attack']);
    expect(input.keyMove().forwardmove).toBe(0);
    // The click was pressed since the last frame, so the frame still sees it once.
    expect(input.cmdButtons()).toBe(BUTTON_ATTACK);
    expect(input.cmdButtons()).toBe(0);
    // Neither key holds the button now, so two others can.
    input.keyUp(key('w'));
    input.keyDown(key('w'));
    input.keyDown(K.KP_UPARROW);
    expect(input.keyMove().forwardmove).toBe(127);
    expect(printed).toEqual([]);
  });

  it('holds a button by the key a command names, and lets it go by that key alone', () => {
    const { input, router } = setup();
    router.execute(['+moveup', '200']);
    router.execute(['-moveup', '201']);
    expect(input.keyMove().upmove).toBe(127);
    router.execute(['-moveup', '200']);
    expect(input.keyMove().upmove).toBe(0);
  });

  it("leaves the buttons the port's move doesn't read unknown, as they were: +speed", () => {
    const { input, printed } = setup([[K.SHIFT, '+speed']]);
    input.keyDown(K.SHIFT);
    input.keyUp(K.SHIFT);
    expect(printed).toEqual(['Unknown command "+speed^7"\n']);
  });
});

describe('ClientInput: commands', () => {
  it('keeps the weapon commands for the frame, the number row and the wheel alike', () => {
    const { input, printed } = setup();
    for (const pressed of [key('5'), K.MWHEELUP, K.MWHEELDOWN]) {
      input.keyDown(pressed);
      input.keyUp(pressed);
    }
    expect(input.takeCommands()).toEqual([['weapon', '5'], ['weapprev'], ['weapnext']]);
    expect(input.takeCommands()).toEqual([]);
    expect(printed).toEqual([]);
  });

  it("keeps the console's weapon commands for the frame as a bind's, input taken or not", () => {
    const { input } = setup();
    input.active = false;
    expect(input.cgameCommand(['weapon', '5'])).toBe(true);
    expect(input.cgameCommand(['WEAPNEXT'])).toBe(true);
    expect(input.cgameCommand(['cg_fov', '100'])).toBe(false);
    expect(input.cgameCommand([])).toBe(false);
    expect(input.takeCommands()).toEqual([['weapon', '5'], ['WEAPNEXT']]);
  });

  it('makes nothing for a frame with no command to take', () => {
    const { input } = setup();
    const none = input.takeCommands();
    expect(input.takeCommands()).toBe(none);
    input.keyDown(key('5'));
    expect(input.takeCommands()).toEqual([['weapon', '5']]);
    expect(none).toEqual([]);
  });

  it('runs +scores on the press and -scores on the release, each given its key, as CL_ParseBinding does', () => {
    const { input, cgame } = setup([[K.TAB, '+scores']]);
    input.keyDown(K.TAB);
    expect(cgame).toHaveBeenCalledWith(['+scores', '9']);

    cgame.mockClear();
    input.keyUp(K.TAB);
    expect(cgame).toHaveBeenCalledWith(['-scores', '9']);
  });

  it('runs the -scores half even with input out, as the - half of a bind', () => {
    const { input, cgame } = setup([[K.TAB, '+scores']]);
    input.keyDown(K.TAB);
    cgame.mockClear();

    // Going out lets every key go, and a `-` command still runs (`cl_keys.c:1352–1358`).
    input.active = false;
    expect(cgame).toHaveBeenCalledWith(['-scores', '9']);
  });

  it("runs any other command at once, on the press alone: C's toggle", () => {
    const { input, config } = setup();
    input.keyDown(key('c'));
    input.keyUp(key('c'));
    expect(config.cvars.settings.drawCollision).toBe(true);
  });

  it('runs each command of a bind split at its semicolons', () => {
    const { input, config } = setup([[key('x'), '+attack; weapon 7;cg_fov 100']]);
    input.keyDown(key('x'));
    expect(input.cmdButtons()).toBe(BUTTON_ATTACK);
    expect(input.takeCommands()).toEqual([['weapon', '7']]);
    expect(config.cvars.settings.fov).toBe(100);
    input.keyUp(key('x'));
    expect(input.cmdButtons()).toBe(0);
  });

  it("prints a command nothing takes, and a press nothing takes but not its release", () => {
    const { input, printed } = setup([
      [key('x'), 'nosuch go'],
      [key('y'), '+nosuch']
    ]);
    input.keyDown(key('x'));
    input.keyDown(key('y'));
    input.keyUp(key('y'));
    expect(printed).toEqual(['Unknown command "nosuch^7"\n', 'Unknown command "+nosuch^7"\n']);
  });

  it('leaves Escape to the menu, whatever it is bound to', () => {
    const { input, printed } = setup([[K.ESCAPE, 'togglemenu']]);
    input.keyDown(K.ESCAPE);
    expect(printed).toEqual([]);
  });
});

describe('ClientInput: when the game takes input', () => {
  it('runs nothing while the game does not take input', () => {
    const { input, config, printed } = setup();
    input.active = false;
    for (const pressed of [key('w'), key('c'), key('5'), K.MOUSE1]) input.keyDown(pressed);
    expect(input.keyMove().forwardmove).toBe(0);
    expect(input.cmdButtons()).toBe(0);
    expect(input.takeCommands()).toEqual([]);
    expect(config.cvars.settings.drawCollision).toBe(false);
    expect(printed).toEqual([]);
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
