import { K, keyToString } from '../formats/q3-keys';
import { bindWarning, type BindTable } from '../settings/binds';
import type { GameConfig } from '../settings/game-config';
import type { Menu, MenuItem, MenuPage, MenuSound } from './menu';
import { settingOptions, settingSlider } from './menu-settings';
import { back, radioButton, tab } from './menu-widgets';

/**
 * Controls: q3_ui's page of binds and mouse settings
 * (`ui_controls2.c`), with the actions the port has. Its sections, Look, Move, Shoot and Misc,
 * switch in place, as Q3's do (`Controls_MenuEvent`, `ui_controls2.c:1042–1076`), and it opens at
 * Look (`ui_controls2.c:1640`).
 *
 * Every section is laid out for the longest, Shoot, so the panel keeps its size and place as they
 * switch. Their rows start under the tabs, where Q3 centres each section's on the screen
 * (`ui_controls2.c:577–581`), and BACK stays at the foot.
 *
 * A bind row shows the first two keys bound to its command, in key order, as
 * `Controls_GetKeyAssignment` finds them (`ui_controls2.c:757–779`). It takes a key by Q3's capture
 * (`Controls_MenuKey`, `ui_controls2.c:895–1010`):
 * - Enter or a click waits for a key, and every other item is greyed until it comes.
 * - Escape cancels, and the backquote is passed over.
 * - Any other key, a mouse button or the wheel too, leaves whatever it did before and fills the
 *   first of the command's two slots that is empty. With both full, it takes the command alone.
 * - Backspace or Delete, while nothing waits, clears the row's two keys.
 *
 * Each change goes to the binds at once, and so to `q3config.cfg`, where Q3 writes them on leaving
 * the page (`Controls_SetConfig`). The player's model, which acts each action out on Q3's page, is
 * the Model page's. Engine-free.
 */

/** A bind row's command, and the label Q3 gives it (`g_bindings`, `ui_controls2.c:230–268`). */
interface Action {
  command: string;
  label: string;
}

/** The Move section's actions the port has, in Q3's order (`ui_controls2.c:283–297`). */
const MOVE: readonly Action[] = [
  { command: '+forward', label: 'walk forward' },
  { command: '+back', label: 'backpedal' },
  { command: '+moveleft', label: 'step left' },
  { command: '+moveright', label: 'step right' },
  { command: '+moveup', label: 'up / jump' },
  { command: '+movedown', label: 'down / crouch' }
];

/**
 * The Shoot section's (`ui_controls2.c:299–314`), with CorkScrew's grapple, which its readme binds
 * where the weapons are, under the name its menu gives it.
 */
const SHOOT: readonly Action[] = [
  { command: '+attack', label: 'attack' },
  { command: 'weapnext', label: 'next weapon' },
  { command: 'weapprev', label: 'prev weapon' },
  { command: 'weapon 1', label: 'gauntlet' },
  { command: 'weapon 2', label: 'machinegun' },
  { command: 'weapon 3', label: 'shotgun' },
  { command: 'weapon 4', label: 'grenade launcher' },
  { command: 'weapon 5', label: 'rocket launcher' },
  { command: 'weapon 6', label: 'lightning' },
  { command: 'weapon 7', label: 'railgun' },
  { command: 'weapon 8', label: 'plasma gun' },
  { command: 'weapon 9', label: 'BFG' },
  { command: '+button5', label: 'Fire grapple' }
];

/**
 * The Misc section's first two rows, which are Q3's own (`g_misc_controls`, `ui_controls2.c:331–334`),
 * under the commands and labels its bind table gives them (`:232–233`). The port's collision
 * overlay follows them under `DEBUG_MODE`; none of Q3's other Misc actions is the port's.
 */
const MISC: readonly Action[] = [
  { command: '+scores', label: 'show scores' },
  { command: '+button2', label: 'use item' }
];
/** The port's own Misc row, under `DEBUG_MODE`. */
const MISC_DEBUG: readonly Action[] = [{ command: 'toggle pcq_drawCollision', label: 'collision overlay' }];

/** `Controls_StatusBar` (`ui_controls2.c:725–728`), under a radio button or a slider. */
const ARROWS_HELP = 'Use Arrow Keys or CLICK to change';
/** `Controls_DrawKeyBinding`'s lines under a bind row (`ui_controls2.c:693–703`), each joined into one. */
const CHANGE_HELP = 'Press ENTER or CLICK to change, BACKSPACE to clear';
const WAITING = 'Waiting for new key ... ESCAPE to cancel';
/** Mouse speed's ends (`ui_controls2.c:1498–1499`). */
const SENSITIVITY_RANGE = { min: 2, max: 30 };
const BACKQUOTE = '`'.charCodeAt(0);

/** The command waiting for its key: `waitingforkey`, and the row it waits on. */
interface Capture {
  command: string | null;
}

/**
 * `Controls_DrawKeyBinding`'s reading of a command's keys: the first two, each named in upper case,
 * with "or" between, and "???" for none (`ui_controls2.c:667–684`).
 */
export function bindText(keys: readonly number[]): string {
  if (keys.length === 0) return '???';
  return keys
    .slice(0, 2)
    .map((key) => keyToString(key).toUpperCase())
    .join(' or ');
}

/**
 * The Controls page, at Look. Its other sections are pages of their own, each with the strip of
 * tabs, and a tab puts its section in the page's place.
 */
export function controlsPage(menu: Menu, config: GameConfig): MenuPage {
  const { binds, cvars } = config;
  const capture: Capture = { command: null };
  /** The command of each bind row, for Backspace. */
  const commands = new Map<MenuItem, string>();

  const look = (): MenuItem[] => [
    settingSlider(cvars, 'sensitivity', 'mouse speed', SENSITIVITY_RANGE, ARROWS_HELP),
    radioButton({
      ...settingOptions(cvars, 'mPitch', 'invert mouse', ARROWS_HELP),
      get: () => cvars.settings.mPitch < 0,
      // `Controls_SetConfig` (`ui_controls2.c:843–846`).
      set: (on) => cvars.setValue('m_pitch', (on ? -1 : 1) * Math.abs(cvars.settings.mPitch))
    })
  ];
  const bindRows = (actions: readonly Action[]): MenuItem[] =>
    actions.map((action) => {
      const row = bindRow(config, capture, action);
      commands.set(row, action.command);
      return row;
    });
  const sections: { name: string; rows: MenuItem[] }[] = [
    { name: 'LOOK', rows: look().map((row) => lockable(capture, row)) },
    { name: 'MOVE', rows: bindRows(MOVE) },
    { name: 'SHOOT', rows: bindRows(SHOOT) },
    { name: 'MISC', rows: bindRows(cvars.debugMode ? [...MISC, ...MISC_DEBUG] : MISC) }
  ];
  // Room for the longest section's rows, and BACK.
  const rows = Math.max(...sections.map((section) => section.rows.length)) + 1;

  const pages: MenuPage[] = [];
  const key = (pressed: number): number | MenuSound | 'silent' => {
    const waiting = capture.command;
    if (waiting === null) {
      if (pressed !== K.BACKSPACE && pressed !== K.DEL && pressed !== K.KP_DEL) return pressed;
      const command = commands.get(menu.page?.items[menu.cursor] as MenuItem);
      if (command === undefined) return pressed;
      clear(binds, command);
      return 'out';
    }
    if (pressed === K.ESCAPE) {
      capture.command = null;
      return 'out';
    }
    if (pressed === BACKQUOTE) return 'silent';
    assign(binds, waiting, pressed);
    capture.command = null;
    return 'out';
  };
  sections.forEach((section, index) => {
    const tabs = sections.map((other, at) =>
      lockable(
        capture,
        tab(other.name, at === index, () => menu.replace(pages[at], at))
      )
    );
    pages.push({
      id: 'controls',
      title: 'CONTROLS',
      layout: 'form',
      rows,
      sections: pages,
      items: [...tabs, ...section.rows, lockable(capture, back(menu))],
      key
    });
  });
  return pages[0];
}

/** A bind row: its command's keys, and its capture. */
function bindRow(config: GameConfig, capture: Capture, action: Action): MenuItem {
  const { binds } = config;
  const waiting = () => capture.command === action.command;
  return {
    label: action.label,
    get value() {
      return bindText(binds.keysFor(action.command));
    },
    // `Controls_Update` greys every row but the waiting one (`ui_controls2.c:588–600`).
    get grayed() {
      return capture.command !== null && !waiting();
    },
    get marked() {
      return waiting();
    },
    get status() {
      if (waiting()) return WAITING;
      // A key a browser keeps, on the row that has it.
      const warning = binds
        .keysFor(action.command)
        .slice(0, 2)
        .map((key) => bindWarning(key, config.shell))
        .find((each) => each !== null);
      return warning ?? CHANGE_HELP;
    },
    // `Controls_ActionEvent`: Enter or a click waits for a key (`ui_controls2.c:1140–1144`).
    activate: () => {
      capture.command = action.command;
    }
  };
}

/** An item greyed while a bind waits for its key, as `Controls_Update` greys it. */
function lockable(capture: Capture, item: MenuItem): MenuItem {
  return Object.create(item, {
    grayed: { get: () => capture.command !== null, enumerable: true }
  }) as MenuItem;
}

/**
 * `Controls_MenuKey`'s capture (`ui_controls2.c:939–998`): the key leaves whatever it did, then
 * fills the first empty slot of the command's two. With both full, they let go, and the key takes
 * the command alone.
 */
function assign(binds: BindTable, command: string, key: number): void {
  let [first = -1, second = -1] = binds.keysFor(command);
  if (second === key) second = -1;
  if (first === key) {
    first = second;
    second = -1;
  }
  if (first !== -1 && second !== -1) {
    binds.set(first, '');
    binds.set(second, '');
  }
  binds.set(key, command);
}

/** Backspace: the command's two keys let go (`ui_controls2.c:972–981`). */
function clear(binds: BindTable, command: string): void {
  for (const key of binds.keysFor(command).slice(0, 2)) binds.set(key, '');
}
