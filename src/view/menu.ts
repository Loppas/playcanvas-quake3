import { K } from '../formats/q3-keys';
import type { EditMode } from './edit-field';
import type { PlayerLook } from './player-model';
import type { Scoreboard } from './scoreboard';

/**
 * The menu's workings: q3_ui's menu framework, `ui_qmenu.c` and the stack
 * in `ui_atoms.c`, cut to what the port's pages use. Engine- and DOM-free: `key-input.ts` hands it
 * Q3's keys, and `render/menu-screen.ts` draws it and tells it where the pointer is.
 *
 * - **The stack.** Pages are pushed over each other, eight deep at most, and pushing a page
 *   already on the stack cuts back to it (`UI_PushMenu`, `ui_atoms.c:81–127`). Popping the last
 *   page closes the menu (`UI_PopMenu`, `ui_atoms.c:134–150`).
 * - **The cursor.** A page's starts on its first live item. Up goes back, and Down and Tab go on,
 *   round from the last item to the first, passing greyed, hidden and inactive items by
 *   (`Menu_AdjustCursor`, `ui_qmenu.c:1435–1478`). The pointer moves it to the item under it
 *   (`UI_MouseEvent`, `ui_atoms.c:876–937`).
 * - **The keys** (`Menu_DefaultKey`, `ui_qmenu.c:1614–1738`). Escape and the right button go back,
 *   unless the item at the cursor has an edit under way, which they undo. The item at the cursor
 *   sees a key next, as a spin control takes left and right. Then Enter, or a click on the item
 *   under the pointer, activates it. An item is told when the cursor leaves it, which applies an
 *   edit under way.
 * - **The sounds**: in when a page opens, move when the cursor moves or an item is
 *   activated, out on the way back, and buzz from a widget that can go no further.
 *
 * The widgets are `view/menu-widgets.ts`'s, and the pages `view/menu-pages.ts`'s.
 */

/** Q3's four menu sounds, by their cues (`ui_qmenu.c:1764–1767`). */
export type MenuSound = 'in' | 'move' | 'out' | 'buzz';

/**
 * What a widget did with a key: the sound it plays, `'silent'` for a key it took quietly
 * (`menu_null_sound`), or `null` for one it leaves to the page.
 */
export type KeyResult = MenuSound | 'silent' | null;

/** `MAX_MENUDEPTH` (`ui_local.h:108`). */
export const MAX_MENU_DEPTH = 8;

/** The confirm's answers by key, as Q3 numbers the letters: lower case. */
const KEY_N = 'n'.charCodeAt(0);
const KEY_Y = 'y'.charCodeAt(0);

/**
 * The pointer over an item: `QMF_HASMOUSEFOCUS`, where it is along the item's bar, and whether it
 * is on a slider's number.
 */
export interface Pointer {
  /** From 0 at the bar's left end to 1 at its right, where that is known. */
  x?: number;
  /** Whether it is on a slider's number, right of its bar. */
  number?: boolean;
  /** From 0 at the bar's top to 1 at its foot, where that is known: a list's row. */
  y?: number;
}

/** A stretch of an item's value in one colour: red, green and blue from 0 to 1, or the value's own. */
export interface ColoredText {
  readonly text: string;
  readonly color?: readonly [number, number, number];
}

/**
 * What a scrolled list shows this frame (`ScrollList_Draw`, `ui_qmenu.c:1233–1290`): the rows in
 * its window, each a line of cells, and which of them is chosen, or −1 for none shown.
 */
export interface ListView {
  readonly rows: readonly (readonly ColoredText[])[];
  readonly selected: number;
}

/** A row of a page's table of settings. */
export interface DetailRow {
  readonly label: string;
  readonly value: string;
}

/** What a page shows of its own on what is chosen in it, apart from its items. */
export interface PageDetail {
  /** Its settings, a label and a value a row, the same rows whatever is chosen. */
  readonly settings: readonly DetailRow[];
  /** A board of scores, as a match's is drawn; null for none. */
  readonly board: Scoreboard | null;
}

/** One item on a page: `menucommon_s`, with its widget's parts. */
export interface MenuItem {
  /** What it reads. */
  readonly label: string;
  /**
   * Every label it reads, where its label changes with its page: its bar reaches the widest, as a
   * spin control's reaches its widest value.
   */
  readonly labels?: readonly string[];
  /** Its value, drawn after the label: a spin control's choice, or a radio button's on or off. */
  readonly value?: string;
  /**
   * Every value it goes through, for a widget with a set of them: its hit box reaches the widest
   * (`SpinControl_Init`, `RadioButton_Init`, `ui_qmenu.c`).
   */
  readonly values?: readonly string[];
  /** A slider's thumb, from 0 at the left end of its bar to 1 at the right. */
  readonly slider?: number;
  /**
   * A picture drawn for the value, by its shader's name, as Game options draws the crosshair
   * (`Crosshair_Draw`, `ui_preferences.c:173–214`).
   */
  readonly icon?: string;
  /**
   * A colour drawn for the value, red, green and blue from 0 to 1, as the Effects spin control
   * draws its bar (`PlayerSettings_DrawEffects`, `ui_playersettings.c:205–225`).
   */
  readonly swatch?: readonly [number, number, number];
  /**
   * Where a field's cursor is in its value, drawn while the cursor is on the item (`MField_Draw`),
   * over the text rather than in it.
   */
  readonly caret?: number;
  /**
   * A typed field's `widthInChars`: its value keeps room for that many of q3_ui's 8-wide cells and
   * one for the cursor, whatever it holds, and is drawn scrolled within it to keep the cursor
   * shown.
   */
  readonly widthInChars?: number;
  /**
   * Its value in colours, drawn in its place while the cursor is off it, as the Player page draws a
   * name's colour codes (`PlayerSettings_DrawName`, `ui_playersettings.c:132–151`).
   */
  readonly colored?: readonly ColoredText[];
  /** A scrolled list's rows, drawn in the item's place: `MTYPE_SCROLLLIST`. */
  readonly list?: ListView;
  /** `QMF_GRAYED`: drawn, but the cursor passes it by and nothing uses it. */
  readonly grayed?: boolean;
  /**
   * `QMF_HIDDEN` and `QMF_INACTIVE`: neither drawn nor used, as Q3's Apply is until there is
   * something to apply.
   */
  readonly hidden?: boolean;
  /**
   * `QMF_INACTIVE` alone: drawn as ever, but the cursor passes it by and nothing uses it, as
   * Server Options draws the human's slot.
   */
  readonly inactive?: boolean;
  /** Its label's colour, red, green and blue from 0 to 1, where it isn't the page's own. */
  readonly color?: readonly [number, number, number];
  /**
   * Drawn in the accent colour: a setting this tab's address set, which is never saved, or
   * a bind waiting for its key.
   */
  readonly marked?: boolean;
  /** A line about the item, drawn under the page while the cursor is on it (`statusbar`). */
  readonly status?: string;
  /** One of the page's sections, in a strip across its head; `current` is the one shown. */
  readonly tab?: 'current' | 'other';
  /**
   * A cell of a page's grid of pictures, its icon the picture: the Model page's icons, four across
   * (`ui_playermodel.c:571–604`), or Start Server's levelshots, two across, each named under it.
   */
  readonly cell?: boolean;
  /** Drawn as chosen: the model picked on the Model page, or Start Server's map (`QMF_HIGHLIGHT`). */
  readonly selected?: boolean;
  /** `QMF_SILENT`: the pointer coming to it, or its activation, plays nothing. */
  readonly silent?: boolean;
  /** `QMF_MOUSEONLY`: the pointer can rest on it, but the keys pass it by, as a list's arrows. */
  readonly mouseOnly?: boolean;
  /** `QM_ACTIVATED`: Enter, or a click on it. */
  activate?(): void;
  /**
   * The widget's own keys, which it sees before the page does (`ui_qmenu.c:1632–1663`).
   *
   * @param pointer - The pointer, while it is over the item.
   * @returns what {@link KeyResult} says, or another key to handle in this one's place, as a
   *   field turns Enter into Tab (`MenuField_Key`)
   */
  key?(key: number, pointer?: Pointer): KeyResult | number;
  /**
   * A typed character: Q3's char event, which comes after the key's (`K_CHAR_FLAG`). A field takes
   * one (`MenuField_Key`, `ui_mfield.c`), and so does a slider, for a number typed in its place.
   */
  char?(ch: string): KeyResult;
  /** Text pasted in at the cursor, as a field takes the clipboard (`MField_Paste`). */
  paste?(text: string): void;
  /**
   * An edit under way, which sees Escape and the right button before the page goes back: a
   * slider's number being typed, which they put back.
   */
  readonly editing?: boolean;
  /** The cursor has left it, for another item or with its page: an edit under way is applied. */
  blur?(): void;
  /**
   * A part it plays however the page is placed: one of q3_ui's corner buttons, BACK at the bottom
   * left or the page's way on at the bottom right, or an arrow turning a page of pictures.
   */
  readonly role?: 'back' | 'forward' | 'previous' | 'next';
  /**
   * Its place by name, for a placement that puts a page's items by name rather than in rows, as
   * Server Options' slots stand in columns.
   */
  readonly place?: string;
}

/**
 * Where a menu's pages stand: `centred`, in a panel in the middle, sized to the page; or `q3ui`,
 * each item where q3_ui puts it on its 640×480 screen (`view/menu-placement.ts`).
 */
export type MenuPlacement = 'centred' | 'q3ui';

/**
 * How a page is laid out: a column of items, a settings page's rows, a confirm's question, the
 * Model page's grid of icons over a column, or a box over the page it was opened from, which is
 * drawn dimmed under it, as Team Arena's popup menus stand over theirs.
 */
export type MenuLayout = 'list' | 'form' | 'confirm' | 'grid' | 'popup';

/** A page: `menuframework_s`. */
export interface MenuPage {
  /** Which page it is, for a placement that puts each of q3_ui's pages its own way. */
  readonly id?: string;
  /** The page's head: Setup's banner, or a confirm's question. The in-game menu has none. */
  title?: string;
  items: readonly MenuItem[];
  /** `list` when absent. */
  layout?: MenuLayout;
  /**
   * The rows the page is laid out for, where it has fewer: tabs and cells aside, as many items as
   * its longest section has. The panel so keeps its size and place as a tab switches sections, as
   * Q3's frame does (`ui_controls2.c:1203–1217`). The room left goes above the last item, BACK,
   * which so stays at the foot, as Q3's stays in its corner (`ui_controls2.c:1259–1263`).
   */
  readonly rows?: number;
  /**
   * The pages its tabs switch between, itself among them. In q3_ui's placement they share one
   * panel, fitted round all of them, which so holds still as a tab switches.
   */
  readonly sections?: readonly MenuPage[];
  /** Where the cursor starts, rather than on the first live item: a confirm's NO. */
  cursor?: number;
  /** A warning under a confirm's answers, as Defaults gives one (`Setup_ResetDefaults_Draw`). */
  warning?: string;
  /** A message under the banner, wrapped, as the main menu shows an error (`Main_MenuDraw`). */
  readonly message?: string;
  /**
   * The player's model to show beside the page, animated, as the Player and Model pages show it
   * (`UI_DrawPlayer`).
   */
  preview?(): PlayerLook;
  /**
   * A line of the page's own: under the preview, the Model page's pick by its model's and skin's
   * names; under Start Server's grid, the chosen map.
   */
  readonly caption?: string;
  /**
   * A picture the page shows, by its shader's name, with lines on a strip under it, as Server
   * Options shows the chosen map (`ServerOptions_LevelshotDraw`).
   */
  readonly picture?: { readonly icon: string; readonly lines: readonly string[] };
  /**
   * The line under the page while the item at the cursor gives none: a status bar of the page's
   * own, as the server browser's says a refresh may be stopped (`ui_servers2.c:1471–1477`).
   */
  readonly status?: string;
  /**
   * What the page shows of what is chosen in it, in its placement's room for it: the server
   * browser's settings and board of the highlighted server. Null, or absent, for nothing.
   */
  readonly detail?: PageDetail | null;
  /**
   * The page's own work each frame it is on top, before it is drawn: `menuframework_s.draw`, as
   * the server browser's refresh runs from its draw (`ArenaServers_MenuDraw`).
   */
  frame?(): void;
  /**
   * The page's own keys, before anything else sees them (`menuframework_s.key`).
   *
   * @returns the key to handle as usual, perhaps another; or, for a key the page took, the sound
   *   it makes
   */
  key?(key: number): number | Exclude<KeyResult, null>;
}

export interface MenuOptions {
  /** Play one of the four sounds. */
  sound?: (sound: MenuSound) => void;
  /** A page went up: `UI_PushMenu`'s `trap_Key_SetCatcher( KEYCATCH_UI )` (`ui_atoms.c:112`). */
  pushed?: () => void;
  /** The last page went: `UI_ForceMenuOff`, which lets the game go on (`ui_atoms.c:152–160`). */
  closed?: () => void;
  /**
   * Insert or overstrike, shared with the client's fields as q3_ui reaches Q3's one mode
   * (`trap_Key_GetOverstrikeMode`). Without it, the menu's fields share one of their own.
   */
  editMode?: EditMode;
}

/** A page on the stack, and where its cursor is. */
interface Level {
  page: MenuPage;
  cursor: number;
}

/** Keys that activate as Enter does: keypad Enter, and the joystick's and aux buttons (`ui_qmenu.c:1709–1733`). */
function activates(key: number): boolean {
  return (
    key === K.ENTER ||
    key === K.KP_ENTER ||
    (key >= K.JOY1 && key < K.JOY1 + 4) ||
    (key >= K.AUX1 && key < K.AUX1 + 16)
  );
}

/** Whether the cursor can rest on an item and use it: neither greyed, hidden nor inactive. */
function live(item: MenuItem): boolean {
  return !item.grayed && !item.hidden && !item.inactive;
}

/** Whether the keys can move the cursor to an item: a live one that isn't the pointer's alone. */
function reachable(item: MenuItem): boolean {
  return live(item) && !item.mouseOnly;
}

/** The first item the cursor can rest on, as `UI_PushMenu` looks for it; the first item if none. */
function firstLive(page: MenuPage): number {
  return Math.max(0, page.items.findIndex(reachable));
}

/** The menu's stack of pages, its cursor, and what keys and the pointer do to them. */
export class Menu {
  private readonly stack: Level[] = [];
  private readonly sound: (sound: MenuSound) => void;
  private readonly pushed: () => void;
  private readonly closed: () => void;
  /** `QMF_HASMOUSEFOCUS` on the item at the cursor. */
  private mouse = false;
  /** Where the pointer is on the item at the cursor, while it is over it. */
  private pointer: Pointer = {};
  private placed: MenuPlacement = 'centred';
  /** Insert or overstrike, for every text field on the menu's pages. */
  readonly editMode: EditMode;

  constructor(options: MenuOptions = {}) {
    this.sound = options.sound ?? (() => {});
    this.pushed = options.pushed ?? (() => {});
    this.closed = options.closed ?? (() => {});
    this.editMode = options.editMode ?? { overstrike: false };
  }

  /** Whether the menu is up: `KEYCATCH_UI`. */
  get isOpen(): boolean {
    return this.stack.length > 0;
  }

  /** The page on top, or `null` with the menu closed. */
  get page(): MenuPage | null {
    return this.top?.page ?? null;
  }

  /** The page under the one on top, which a popup is drawn over; `null` with fewer than two. */
  get under(): MenuPage | null {
    return this.stack[this.stack.length - 2]?.page ?? null;
  }

  /** How many pages are on the stack. */
  get depth(): number {
    return this.stack.length;
  }

  /** The item at the cursor, by its place on the page; −1 with the menu closed. */
  get cursor(): number {
    return this.top?.cursor ?? -1;
  }

  /** Whether the pointer is over the item at the cursor, so that a click uses it. */
  get mouseFocus(): boolean {
    return this.mouse;
  }

  /**
   * Where the pages stand, as the menu was opened: every page pushed over the first, a confirm's
   * included, stands the same way.
   */
  get placement(): MenuPlacement {
    return this.placed;
  }

  /**
   * Open the menu at a page, on an empty stack: `UI_SetActiveMenu`, "the ONLY way the menu system
   * is brought up", which puts the in-game menu up as the only page (`ui_atoms.c:808–834`,
   * `ui_ingame.c:339–349`).
   */
  open(page: MenuPage, placement: MenuPlacement = 'centred'): void {
    this.leave(this.top);
    this.stack.length = 0;
    this.placed = placement;
    this.push(page);
  }

  /** `UI_PushMenu`: a page over the others, its cursor on its first live item, with the in sound. */
  push(page: MenuPage): void {
    this.leave(this.top);
    const at = this.stack.findIndex((level) => level.page === page);
    if (at >= 0) this.stack.length = at;
    else if (this.stack.length >= MAX_MENU_DEPTH) throw new Error('UI_PushMenu: menu stack overflow');
    this.stack.push({ page, cursor: page.cursor ?? firstLive(page) });
    this.mouse = false;
    // `m_entersound`, which Q3 plays once the page has first drawn (`ui_atoms.c:1250–1254`).
    this.sound('in');
    this.pushed();
  }

  /**
   * `UI_ForceMenuOff` (`ui_atoms.c:836–842`): the whole menu goes, however deep it stands.
   *
   * Silently, and without the page under it coming back: a page that sends the player somewhere
   * — the team page's rows — wants them looking at the game rather than at the menu they came
   * through.
   */
  forceOff(): void {
    if (!this.isOpen) return;
    this.leave(this.top);
    this.stack.length = 0;
    this.mouse = false;
    this.closed();
  }

  /** `UI_PopMenu`: back a page, with the out sound, and out of the menu from the last. */
  pop(): void {
    if (!this.isOpen) return;
    this.leave(this.top);
    this.sound('out');
    this.stack.pop();
    this.mouse = false;
    if (!this.isOpen) this.closed();
  }

  /**
   * Put the cursor on an item, quietly, as `Menu_SetCursor` does: the Model page turns its pages
   * with it.
   */
  select(index: number): void {
    const level = this.top;
    if (!level) return;
    if (index !== level.cursor) this.leave(level);
    level.cursor = index;
    this.mouse = false;
  }

  /**
   * Put another page in the top one's place, silently, as Controls shows another of its sections
   * (`Controls_MenuEvent`, `ui_controls2.c:1042–1076`).
   *
   * @param cursor - Where its cursor goes: on the tab that chose it.
   */
  replace(page: MenuPage, cursor: number = page.cursor ?? firstLive(page)): void {
    if (!this.isOpen) return;
    this.leave(this.top);
    this.stack[this.stack.length - 1] = { page, cursor };
  }

  /**
   * A key for the menu: the page's own handling, then `Menu_DefaultKey`, with the sound it makes
   * (`UI_KeyEvent`, `ui_atoms.c:851–869`). A click is `MOUSE1`, which uses the item under the
   * pointer.
   *
   * @returns whether the menu used it
   */
  key(key: number): boolean {
    const level = this.top;
    if (!level) return false;
    const passed = level.page.key ? level.page.key(key) : key;
    if (typeof passed !== 'number') {
      if (passed !== 'silent') this.sound(passed);
      return true;
    }

    const item = level.page.items[level.cursor];
    const usable = item !== undefined && live(item);
    if ((passed === K.ESCAPE || passed === K.MOUSE2) && !(usable && item.editing)) {
      this.pop();
      return true;
    }

    const pointer = this.mouse ? { ...this.pointer } : undefined;
    const result = usable && item.key ? item.key(passed, pointer) : null;
    if (typeof result !== 'number' && result) {
      if (result !== 'silent') this.sound(result);
      return true;
    }
    const pressed = typeof result === 'number' ? result : passed;

    switch (pressed) {
      case K.UPARROW:
      case K.KP_UPARROW:
        this.move(level, -1);
        return true;
      case K.TAB:
      case K.DOWNARROW:
      case K.KP_DOWNARROW:
        this.move(level, 1);
        return true;
      case K.MOUSE1:
      case K.MOUSE3:
        if (usable && this.mouse) this.activate(item);
        return true;
    }
    if (!activates(pressed)) return false;
    if (usable) this.activate(item);
    return true;
  }

  /**
   * A typed character: Q3's char event, which reaches the item at the cursor after its key
   * (`K_CHAR_FLAG`, `MenuField_Key`). A field takes one, and so does a slider.
   *
   * @returns whether the item took it
   */
  char(ch: string): boolean {
    const level = this.top;
    const item = level?.page.items[level.cursor];
    if (!item || !live(item) || !item.char) return false;
    const result = item.char(ch);
    if (result && result !== 'silent') this.sound(result);
    return result !== null;
  }

  /**
   * Text pasted while the menu is up: the item at the cursor takes it, as a field does the
   * clipboard's (`MField_Paste`).
   *
   * @returns whether the item took it
   */
  paste(text: string): boolean {
    const level = this.top;
    const item = level?.page.items[level.cursor];
    if (!item || !live(item) || !item.paste) return false;
    item.paste(text);
    return true;
  }

  /** The page on top's own work for this frame, before it is drawn. */
  frame(): void {
    this.top?.page.frame?.();
  }

  /**
   * Where the pointer is: over an item, by its place on the page, or over none (`UI_MouseEvent`).
   * The item under it takes the cursor, with the move sound unless it is silent. Over a greyed or
   * hidden item, or none, the cursor stays where it was, and a click uses nothing.
   *
   * @param pointer - Where it is on the item: along its bar, and whether on a slider's number.
   */
  hover(index: number | null, pointer: Pointer = {}): void {
    const level = this.top;
    if (!level) return;
    const item = index === null ? undefined : level.page.items[index];
    if (index === null || !item || !live(item)) {
      this.mouse = false;
      return;
    }
    if (level.cursor !== index) {
      this.leave(level);
      level.cursor = index;
      if (!item.silent) this.sound('move');
    }
    this.mouse = true;
    this.pointer = pointer;
  }

  /**
   * Ask a question: `UI_ConfirmMenu` (`ui_confirm.c:65–243`). The cursor starts on NO; left and
   * right move between the answers, and Y and N give one at once. Either answer goes back a page
   * first, and YES then runs `action`.
   *
   * @param warning - A line under the answers, as Defaults warns what it does.
   */
  confirm(question: string, action: () => void, warning?: string): void {
    const answer = (yes: boolean) => {
      this.pop();
      if (yes) action();
    };
    this.push({
      title: question,
      layout: 'confirm',
      warning,
      items: [
        { label: 'YES', activate: () => answer(true) },
        { label: 'NO', activate: () => answer(false) }
      ],
      cursor: 1,
      key: (key) => {
        switch (key) {
          case K.LEFTARROW:
          case K.KP_LEFTARROW:
          case K.RIGHTARROW:
          case K.KP_RIGHTARROW:
            return K.TAB;
          // Going back has made its sound.
          case KEY_N:
            answer(false);
            return 'silent';
          case KEY_Y:
            answer(true);
            return 'silent';
          default:
            return key;
        }
      }
    });
  }

  private get top(): Level | undefined {
    return this.stack[this.stack.length - 1];
  }

  /**
   * `Menu_AdjustCursor`: on to the next live item that way, round the end of the page, passing by
   * those only the pointer reaches.
   */
  private move(level: Level, step: 1 | -1): void {
    const { items } = level.page;
    let cursor = level.cursor;
    for (let tried = 0; tried < items.length; tried++) {
      cursor = (cursor + step + items.length) % items.length;
      if (reachable(items[cursor])) break;
    }
    if (cursor === level.cursor || !reachable(items[cursor])) return;
    this.leave(level);
    level.cursor = cursor;
    this.mouse = false;
    this.sound('move');
  }

  /** The cursor leaves the item it is on, for another or with its page: its `blur`. */
  private leave(level: Level | undefined): void {
    level?.page.items[level.cursor]?.blur?.();
  }

  /** `Menu_ActivateItem`: the item's action, then the move sound unless it is silent. */
  private activate(item: MenuItem): void {
    if (!item.activate) return;
    item.activate();
    if (!item.silent) this.sound('move');
  }
}
