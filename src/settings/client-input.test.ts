import { describe, expect, it, vi } from 'vitest';

import { K } from '../formats/q3-keys';
import { BUTTON_AFFIRMATIVE, BUTTON_ATTACK, BUTTON_TALK } from '../sim/constants';
import { KEYCATCH } from './client-input';
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

  it('says whether it took a key, so its browser default is stopped: a bound one in game', () => {
    const { input } = setup();
    expect(input.keyDown(key('w'))).toBe(true);
    expect(input.keyDown(key('z'))).toBe(false);
    input.active = false;
    expect(input.keyDown(key('w'))).toBe(false);
  });
});

/** Which catchers are up, as bits, and which of them a key goes to. */
const SETS: [string, number, string][] = [
  ['the console', KEYCATCH.CONSOLE, 'console'],
  ['the menu', KEYCATCH.UI, 'menu'],
  ['the chat line', KEYCATCH.MESSAGE, 'chat'],
  ['the console over the menu', KEYCATCH.CONSOLE | KEYCATCH.UI, 'console'],
  ['the menu and the chat line', KEYCATCH.UI | KEYCATCH.MESSAGE, 'menu'],
  ['the console and the chat line', KEYCATCH.CONSOLE | KEYCATCH.MESSAGE, 'console'],
  ['all three', KEYCATCH.CONSOLE | KEYCATCH.UI | KEYCATCH.MESSAGE, 'console']
];

/**
 * Input with a catcher of each kind, each recording what reaches it in `heard` and using it, and
 * `+probe` and `toggleconsole` in the console, recorded there too. The menu's `open` is Escape's.
 */
function catching(binds?: Iterable<readonly [number, string]>) {
  const heard: string[] = [];
  const catcher = (name: string) => ({
    key: vi.fn((pressed: number) => heard.push(`${name} key ${pressed}`) > 0),
    char: vi.fn((ch: string) => heard.push(`${name} char ${ch}`) > 0),
    paste: vi.fn((text: string) => heard.push(`${name} paste ${text}`) > 0)
  });
  const menu = { ...catcher('menu'), open: vi.fn(() => void heard.push('menu open')) };
  const wired = routedInput(binds, undefined, {
    console: catcher('console'),
    menu,
    chat: catcher('chat')
  });
  for (const name of ['+probe', '-probe', 'toggleconsole']) {
    wired.router.add(name, (argv) => void heard.push(argv.join(' ')));
  }
  wired.input.active = true;
  return { ...wired, heard, menu };
}

describe('ClientInput: the key catchers', () => {
  it.each(SETS)('gives a key to %s, and runs none of its bind', (_, catchers, who) => {
    const { input, heard } = catching([[key('w'), '+forward']]);
    input.setCatcher(catchers);
    expect(input.keyDown(key('w'))).toBe(true);
    expect(heard).toEqual([`${who} key ${key('w')}`]);
    expect(input.keyMove().forwardmove).toBe(0);
  });

  it.each(SETS)("gives a key's character, after it, and a paste to %s", (_, catchers, who) => {
    const { input, heard } = catching();
    input.setCatcher(catchers);
    expect(input.keyDown(key('q'), 'q')).toBe(true);
    expect(input.paste('203.0.113.9')).toBe(true);
    expect(heard).toEqual([`${who} key ${key('q')}`, `${who} char q`, `${who} paste 203.0.113.9`]);
  });

  it('runs the bind with none up, and gives no catcher the key, the character or the paste', () => {
    const { input, heard } = catching([[key('w'), '+forward']]);
    input.keyDown(key('w'), 'w');
    expect(input.paste('x')).toBe(false);
    expect(input.keyMove().forwardmove).toBe(127);
    expect(heard).toEqual([]);
  });

  it.each(SETS)("runs a key's release with %s up, which no catcher sees", (_, catchers) => {
    const { input, heard } = catching([[key('w'), '+probe']]);
    input.setCatcher(catchers);
    input.keyDown(key('w'));
    heard.length = 0;
    input.keyUp(key('w'));
    expect(heard).toEqual([`-probe ${key('w')}`]);
  });

  it('lets every key go when the catchers change, and not when they are set as they were', () => {
    const { input, heard } = catching([[key('w'), '+probe']]);
    input.keyDown(key('w'));
    input.setCatcher(0);
    expect(heard).toEqual([`+probe ${key('w')}`]);
    input.setCatcher(KEYCATCH.UI);
    expect(heard).toEqual([`+probe ${key('w')}`, `-probe ${key('w')}`]);
    expect(input.catchers).toBe(KEYCATCH.UI);

    input.keyDown(key('w'));
    heard.length = 0;
    input.setCatcher(KEYCATCH.UI);
    expect(heard).toEqual([]);
    input.setCatcher(KEYCATCH.UI | KEYCATCH.CONSOLE);
    expect(heard).toEqual([`-probe ${key('w')}`]);
  });

  it('turns the view with the mouse unless the menu is up, as CL_MouseEvent does', () => {
    const { input } = catching();
    for (const catchers of [0, KEYCATCH.CONSOLE, KEYCATCH.MESSAGE]) {
      input.setCatcher(catchers);
      input.mouseMove(2, 3);
      expect(input.takeMouse()).toEqual({ dx: 2, dy: 3 });
    }
    for (const catchers of [KEYCATCH.UI, KEYCATCH.UI | KEYCATCH.CONSOLE]) {
      input.setCatcher(catchers);
      input.mouseMove(2, 3);
      expect(input.takeMouse()).toEqual({ dx: 0, dy: 0 });
    }
  });
});

describe('ClientInput: the talk button (cl_input.c:540–542)', () => {
  it.each(SETS)('presses it with %s up', (_, catchers) => {
    const { input } = catching();
    input.setCatcher(catchers);
    expect(input.talkButton()).toBe(BUTTON_TALK);
    expect(input.cmdButtons()).toBe(BUTTON_TALK);
  });

  it('presses nothing with none up', () => {
    const { input } = catching();
    expect(input.talkButton()).toBe(0);
    expect(input.cmdButtons()).toBe(0);
  });

  it('goes with the buttons held, and as the catcher goes: +attack typed at the console', () => {
    const { input, router } = catching();
    input.setCatcher(KEYCATCH.CONSOLE);
    router.execute(['+attack']);
    expect(input.cmdButtons()).toBe(BUTTON_ATTACK | BUTTON_TALK);
    // Typed, it names no key, so the catcher going lets nothing go.
    input.setCatcher(0);
    expect(input.cmdButtons()).toBe(BUTTON_ATTACK);
  });
});

describe('ClientInput: Escape', () => {
  it.each([
    ['closes the chat line first, the console and the menu up too', 7, 'chat key 27'],
    ['goes to the menu while it is up, the console over it', 3, 'menu key 27'],
    ['opens the menu with the console alone up', 1, 'menu open'],
    ['opens the menu with nothing up', 0, 'menu open']
  ])('%s, and never runs its bind', (_, catchers, heardAs) => {
    const { input, heard, printed } = catching([[K.ESCAPE, 'echo bound']]);
    input.setCatcher(catchers);
    expect(input.keyDown(K.ESCAPE)).toBe(true);
    expect(heard).toEqual([heardAs]);
    expect(printed).toEqual([]);
  });

  it('runs its bind\'s release on the way up, as CL_KeyUpEvent does for any key', () => {
    const { input, heard } = catching([[K.ESCAPE, '+probe']]);
    input.keyDown(K.ESCAPE);
    input.keyUp(K.ESCAPE);
    expect(heard).toEqual(['menu open', `-probe ${K.ESCAPE}`]);
  });
});

describe('ClientInput: binds over a catcher', () => {
  const binds: [number, string][] = [
    [key('m'), 'togglemenu'],
    [key('n'), 'TOGGLECONSOLE'],
    [key('b'), 'echo hi'],
    [key('v'), 'togglemenu x'],
    [key('w'), '+forward']
  ];

  it('runs togglemenu and toggleconsole on a press over the menu, after the menu has the key', () => {
    const { input, heard, printed } = catching(binds);
    input.setCatcher(KEYCATCH.UI);
    expect(input.keyDown(key('m'))).toBe(true);
    expect(input.keyDown(key('n'))).toBe(true);
    input.keyDown(key('b'));
    input.keyDown(key('v'));
    expect(heard).toEqual([
      `menu key ${key('m')}`,
      'menu key 27',
      `menu key ${key('n')}`,
      'TOGGLECONSOLE',
      `menu key ${key('b')}`,
      `menu key ${key('v')}`
    ]);
    expect(printed).toEqual([]);
  });

  it("gives the key's character where the key went, and runs the bind after, as Q3 does", () => {
    const heard: string[] = [];
    const { input, router } = routedInput([[key('k'), 'toggleconsole']], undefined, {
      console: { key: () => false, char: (ch) => heard.push(`console char ${ch}`) > 0 }
    });
    router.add('toggleconsole', () => input.setCatcher(input.catchers ^ KEYCATCH.CONSOLE));
    // The key that drops the console types nothing into it.
    input.keyDown(key('k'), 'k');
    expect(input.catchers).toBe(KEYCATCH.CONSOLE);
    expect(heard).toEqual([]);
    // With the console down, the key is the console's, and so is its character.
    input.keyDown(key('k'), 'k');
    expect([input.catchers, heard]).toEqual([KEYCATCH.CONSOLE, ['console char k']]);
  });

  it('runs neither with the console up', () => {
    const { input, heard } = catching(binds);
    input.setCatcher(KEYCATCH.CONSOLE | KEYCATCH.UI);
    input.keyDown(key('m'));
    input.keyDown(key('n'));
    expect(heard).toEqual([`console key ${key('m')}`, `console key ${key('n')}`]);
  });

  it('runs togglemenu over the chat line, whose Escape closes it', () => {
    const { input, heard } = catching(binds);
    input.setCatcher(KEYCATCH.MESSAGE);
    input.keyDown(key('m'));
    expect(heard).toEqual([`chat key ${key('m')}`, 'chat key 27']);
  });

  it('decides the commands before the menu has the key, so the click that closes it fires nothing', () => {
    const { input, menu } = catching();
    input.setCatcher(KEYCATCH.UI);
    menu.key.mockImplementation(() => {
      input.setCatcher(0);
      return true;
    });
    input.keyDown(K.MOUSE1);
    expect(input.catchers).toBe(0);
    expect(input.cmdButtons()).toBe(0);
  });

  it('runs on a press without the mouse only what it would over the menu, with nothing up', () => {
    const { input, heard, printed } = catching(binds);
    input.active = false;
    input.keyDown(key('b'));
    input.keyDown(key('w'));
    expect(input.keyDown(key('m'))).toBe(true);
    expect(heard).toEqual(['menu open']);
    expect(printed).toEqual([]);
    expect(input.keyMove().forwardmove).toBe(0);
  });
});

describe('ClientInput: togglemenu', () => {
  it('is an Escape pressed and let go: it opens the menu, and goes to the menu while up', () => {
    const { input, router, heard } = catching();
    router.execute(['togglemenu']);
    input.setCatcher(KEYCATCH.UI);
    router.execute(['togglemenu']);
    expect(heard).toEqual(['menu open', 'menu key 27']);
  });
});
