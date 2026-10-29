import { atoi } from '../formats/c-scan';
import { K } from '../formats/q3-keys';
import { tokenize } from '../formats/q3config';
import { BUTTON_TALK } from '../sim/constants';
import type { BindTable } from './binds';
import type { CommandTable } from './command-router';

/** `movespeed` in `CL_KeyMove` with `cl_run` on (`cl_input.c:326–332`): the port always runs. */
const MOVE_SPEED = 127;

/** The commands cgame runs, which wait for the frame: the weapons (`cg_consolecmds.c`). */
const CGAME_COMMANDS = new Set(['weapon', 'weapnext', 'weapprev']);

/** The moves `CL_KeyMove` reads, each a button held by its `+` command. */
const MOVE_BUTTONS = ['forward', 'back', 'moveleft', 'moveright', 'moveup', 'movedown'];

/** How many `+button<i>` commands reach a user command's button bits (`CL_CmdButtons`). */
const CMD_BUTTONS = 15;

/** What a frame with no weapon command takes, so taking none makes nothing. */
const NO_COMMANDS: readonly string[][] = Object.freeze([]);

/**
 * `CL_BindUICommand` (`cl_keys.c:1165–1175`): the commands a press runs with a catcher up, the
 * console excepted. The whole command, as `Q_stricmp` compares it.
 */
const UI_COMMANDS = new Set(['toggleconsole', 'togglemenu']);

/**
 * `KEYCATCH_*` (`q_shared.h:1043–1045`): what takes the keys from the game, as bits that can be up
 * together. CGAME is left out, as baseq3's cgame never sets it.
 */
export const KEYCATCH = { CONSOLE: 1, UI: 2, MESSAGE: 4 } as const;

/** Where a catcher's keys go: `Console_Key`, `UI_KeyEvent` or `Message_Key`. */
export interface KeyCatcher {
  /**
   * A key or a button pressed.
   *
   * @returns whether it used it, so its browser default is stopped
   */
  key(key: number): boolean;
  /**
   * The character a key typed, after its key: Q3's char event, for a field (`K_CHAR_FLAG`).
   *
   * @returns whether it used it
   */
  char?(ch: string): boolean;
  /**
   * Text pasted, for a field, as Q3's Shift+Ins and Ctrl+V paste into one (`MField_Paste`).
   *
   * @returns whether it used it
   */
  paste?(text: string): boolean;
}

/** The menu, the UI catcher. */
export interface MenuKeys extends KeyCatcher {
  /**
   * Escape with no menu up: `UI_SET_ACTIVE_MENU`'s in-game menu, or out of a match that isn't in
   * the world yet (`cl_keys.c:1294–1303`).
   */
  open(): void;
}

/** The move the held keys make this frame, as `usercmd_t` carries it. */
export interface KeyMove {
  forwardmove: number;
  rightmove: number;
  upmove: number;
}

/** A button a bind holds down: `kbutton_t` (`cl_input.c`). Up to two keys can hold it. */
class KeyButton {
  /** The keys holding it, 0 for none. */
  private readonly keys = [0, 0];
  active = false;
  /** Pressed since a frame last read it, so a tap shorter than a frame still counts. */
  wasPressed = false;

  /**
   * `IN_KeyDown` (`cl_input.c:76–110`), given the key its command names. A command typed at the
   * console names none, and holds the button until a release typed there too.
   *
   * @returns `false` for a third key, which Q3 refuses.
   */
  down(arg: string | undefined): boolean {
    const key = arg ? atoi(arg) : -1;
    if (key === this.keys[0] || key === this.keys[1]) return true;
    if (!this.keys[0]) this.keys[0] = key;
    else if (!this.keys[1]) this.keys[1] = key;
    else return false;
    if (!this.active) {
      this.active = true;
      this.wasPressed = true;
    }
    return true;
  }

  /**
   * `IN_KeyUp` (`cl_input.c:112–150`): a key that isn't holding it is passed by, and a release
   * typed at the console, naming none, lets go whatever holds it.
   */
  up(arg: string | undefined): void {
    if (!arg) {
      this.keys[0] = this.keys[1] = 0;
      this.active = false;
      return;
    }
    const key = atoi(arg);
    if (this.keys[0] === key) this.keys[0] = 0;
    else if (this.keys[1] === key) this.keys[1] = 0;
    else return;
    if (!this.keys[0] && !this.keys[1]) this.active = false;
  }
}

export interface ClientInputOptions {
  /** Run a bind's command as the console runs it. */
  command?: (argv: readonly string[]) => void;
  /** Where a third key on one button is reported. */
  warn?: (message: string) => void;
  /** The console's keys, while {@link KEYCATCH}'s CONSOLE is up. */
  console?: KeyCatcher;
  /** The menu's keys, while UI is up, and what Escape opens while it isn't. */
  menu?: MenuKeys;
  /** The chat line's keys, while MESSAGE is up. */
  chat?: KeyCatcher;
}

/**
 * Q3's keys as the client takes them: `cl_keys.c`'s events. Each goes where the key catchers send
 * it, and otherwise a key runs its bind as `CL_ParseBinding` does (`cl_keys.c:1184–1232`), as the
 * console's commands. The buttons those hold are what each frame's move is made from
 * (`CL_KeyMove`, `CL_CmdButtons`).
 *
 * A press runs every command of its bind only with no catcher up and the mouse captured
 * ({@link active}); otherwise only what Q3 runs over a menu. A key let go always runs its bind's
 * `-` half, "to keep the character from continuing an action started before a mode switch"
 * (`cl_keys.c:1352–1358`). The catchers changing, or the mouse let go, lets every key go, as
 * `Key_ClearStates` does.
 *
 * Engine- and DOM-free: `key-input.ts` hands it Q3's key numbers.
 */
export class ClientInput {
  private readonly binds: BindTable;
  private readonly command: (argv: readonly string[]) => void;
  private readonly warn: (message: string) => void;
  private readonly console: KeyCatcher | undefined;
  private readonly menu: MenuKeys | undefined;
  private readonly chat: KeyCatcher | undefined;
  private readonly buttons = new Map<string, KeyButton>();
  /** The keys down, `keys[].down`, so they can all be let go at once. */
  private readonly down = new Set<number>();
  private readonly queued: string[][] = [];
  private mouseX = 0;
  private mouseY = 0;
  private live = false;
  /** `keyCatchers`: {@link KEYCATCH}'s bits. */
  private catching = 0;
  /** What {@link keyMove} and {@link takeMouse} give, written again each time. */
  private readonly move: KeyMove = { forwardmove: 0, rightmove: 0, upmove: 0 };
  private readonly movement = { dx: 0, dy: 0 };

  constructor(binds: BindTable, options: ClientInputOptions = {}) {
    this.binds = binds;
    this.command = options.command ?? (() => {});
    this.warn = options.warn ?? console.warn;
    this.console = options.console;
    this.menu = options.menu;
    this.chat = options.chat;
    for (const name of MOVE_BUTTONS) this.buttons.set(name, new KeyButton());
    for (let i = 0; i < CMD_BUTTONS; i++) this.buttons.set(`button${i}`, new KeyButton());
  }

  /**
   * Put the buttons in the console's table as `CL_InitInput` does (`cl_input.c:934–994`), as
   * far as the port's move reads them: `+attack` is `+button0`.
   */
  addCommands(table: CommandTable): void {
    const add = (name: string, button: KeyButton) => {
      table.add(`+${name}`, (argv) => {
        if (!button.down(argv[1])) this.warn('Three keys down for a button!');
      });
      table.add(`-${name}`, (argv) => button.up(argv[1]));
    };
    for (const [name, button] of this.buttons) add(name, button);
    add('attack', this.buttons.get('button0')!);
    // `Con_ToggleMenu_f` (`cl_console.c:94–97`).
    table.add('togglemenu', () => {
      this.keyDown(K.ESCAPE);
      this.keyUp(K.ESCAPE);
    });
  }

  /** Whether the mouse is captured: without it, a press runs only what it would over a menu. */
  get active(): boolean {
    return this.live;
  }

  set active(on: boolean) {
    if (on === this.live) return;
    this.live = on;
    if (!on) {
      this.clear();
      this.mouseX = 0;
      this.mouseY = 0;
    }
  }

  /** `Key_GetCatcher`: the catchers up, as {@link KEYCATCH}'s bits. */
  get catchers(): number {
    return this.catching;
  }

  /** `Key_SetCatcher` (`cl_keys.c:1452–1458`): a change lets every key down go. */
  setCatcher(catchers: number): void {
    if (catchers !== this.catching) this.clear();
    this.catching = catchers;
  }

  /**
   * A key goes down: `CL_KeyDownEvent` (`cl_keys.c:1241–1329`), and the character it types, if
   * any: `CL_CharEvent` (`cl_keys.c:1388–1412`). The console key, or Shift+Escape, toggles the
   * console over everything and lets every key go, so no bind can take it. Escape is handled next,
   * and is never a bind; any other key runs its bind and goes to the catcher on top, and its
   * character after it.
   *
   * @param typed - The character the key types, or none.
   * @returns whether the key or its character was taken, so its browser default is stopped
   */
  keyDown(key: number, typed = ''): boolean {
    this.down.add(key);
    if (this.togglesConsole(key)) {
      this.command(['toggleconsole']);
      this.clear();
      return true;
    }
    if (key === K.ESCAPE) return this.escape();
    // Decided before the catcher has the key, which may take the catcher down, so the click that
    // closes the menu fires nothing; and run after it and the character, as Q3's command buffer
    // runs them once the frame's events are in, so a key bound to toggleconsole types nothing into
    // the console it drops.
    const commands = this.binding(key, true);
    const used = this.catcher()?.key(key) ?? false;
    const took = typed !== '' && (this.catcher()?.char?.(typed) ?? false);
    for (const command of commands) this.run(command);
    return used || took || commands.length > 0;
  }

  /**
   * A key comes up: `CL_KeyUpEvent` (`cl_keys.c:1338–1365`), which runs its bind's release,
   * unless it toggles the console. No catcher has it, as q3_ui drops a key-up
   * (`ui_atoms.c:858–860`).
   */
  keyUp(key: number): void {
    this.down.delete(key);
    if (this.togglesConsole(key)) return;
    for (const command of this.binding(key, false)) this.run(command);
  }

  /**
   * Text pasted, which goes where a character would.
   *
   * @returns whether a catcher used it
   */
  paste(text: string): boolean {
    return this.catcher()?.paste?.(text) ?? false;
  }

  /** `Key_IsDown`: whether a key is held. */
  isDown(key: number): boolean {
    return this.down.has(key);
  }

  /** Let every key down go, as `Key_ClearStates` does (`cl_keys.c:1420–1434`). */
  clear(): void {
    for (const key of [...this.down]) this.keyUp(key);
  }

  /**
   * Mouse movement, gathered until the frame takes it, unless the menu has it (`CL_MouseEvent`,
   * `cl_input.c:362–371`).
   */
  mouseMove(dx: number, dy: number): void {
    if (!this.live || this.catching & KEYCATCH.UI) return;
    this.mouseX += dx;
    this.mouseY += dy;
  }

  /**
   * The mouse movement since the frame last took it: the same object each time, written again, so
   * a frame taking it makes nothing.
   */
  takeMouse(): { readonly dx: number; readonly dy: number } {
    const movement = this.movement;
    movement.dx = this.mouseX;
    movement.dy = this.mouseY;
    this.mouseX = 0;
    this.mouseY = 0;
    return movement;
  }

  /**
   * `CL_KeyMove` (`cl_input.c:317–355`): the move the held buttons make, always at a run. Keys
   * pulling opposite ways cancel, jump and crouch as well. A held key counts whole: Q3's fraction
   * of the frame it was down for (`CL_KeyState`) is left out.
   *
   * The same object each time, written again, as {@link takeMouse}'s is.
   */
  keyMove(): Readonly<KeyMove> {
    const move = this.move;
    move.forwardmove = this.held('forward') - this.held('back');
    move.rightmove = this.held('moveright') - this.held('moveleft');
    move.upmove = this.held('moveup') - this.held('movedown');
    return move;
  }

  /**
   * `CL_CmdButtons` (`cl_input.c:525–549`): the button half of a user command.
   *
   * Bit `i` is `+button<i>`, down if it is held or was pressed since the last frame, so a click
   * shorter than a frame still fires once. Reading it takes those presses. The {@link talkButton}
   * goes with them.
   *
   * Every button rides in one number rather than being asked for by name, because that number is
   * what a user command carries: the game module reads the bits, and what the key was called is
   * the client's business alone.
   */
  cmdButtons(): number {
    let buttons = 0;
    for (let i = 0; i < CMD_BUTTONS; i++) {
      const button = this.buttons.get(`button${i}`)!;
      if (button.active || button.wasPressed) buttons |= 1 << i;
      button.wasPressed = false;
    }
    return buttons | this.talkButton();
  }

  /**
   * `BUTTON_TALK` while any catcher is up, else nothing (`cl_input.c:540–542`): the player is
   * typing or in a menu, so Pmove holds them still and the others see a balloon over them. Every
   * user command carries it, whatever else it holds.
   */
  talkButton(): number {
    return this.catching ? BUTTON_TALK : 0;
  }

  /** The weapon commands since the frame last took them, which cgame runs at the frame. */
  takeCommands(): readonly string[][] {
    return this.queued.length === 0 ? NO_COMMANDS : this.queued.splice(0);
  }

  /**
   * `CL_GameCommand` (`cl_cgame.c:780–786`): one of cgame's commands, from a bind or the console,
   * kept for the frame. Whether it was one.
   */
  cgameCommand(argv: readonly string[]): boolean {
    if (!CGAME_COMMANDS.has(argv[0]?.toLowerCase() ?? '')) return false;
    this.queued.push([...argv]);
    return true;
  }

  /** A move button's speed: {@link MOVE_SPEED} while it is held. */
  private held(name: string): number {
    return this.buttons.get(name)!.active ? MOVE_SPEED : 0;
  }

  /** "console key is hardcoded, so the user can never unbind it" (`cl_keys.c:1260–1266`). */
  private togglesConsole(key: number): boolean {
    return key === K.CONSOLE || (key === K.ESCAPE && this.down.has(K.SHIFT));
  }

  /** The catcher a key or a character goes to: the console, else the menu, else the chat line. */
  private catcher(): KeyCatcher | undefined {
    if (this.catching & KEYCATCH.CONSOLE) return this.console;
    if (this.catching & KEYCATCH.UI) return this.menu;
    if (this.catching & KEYCATCH.MESSAGE) return this.chat;
    return undefined;
  }

  /** Escape (`cl_keys.c:1279–1308`): the chat line's, else it opens the menu, else the menu's. */
  private escape(): boolean {
    if (this.catching & KEYCATCH.MESSAGE) return this.chat?.key(K.ESCAPE) ?? false;
    if (!(this.catching & KEYCATCH.UI)) {
      this.menu?.open();
      return true;
    }
    return this.menu?.key(K.ESCAPE) ?? false;
  }

  /**
   * `CL_ParseBinding`: the commands of a bind that run, split at its semicolons. A `+` command
   * runs on the press as itself and on the release with a `-`, each given the key, so that two
   * keys holding one button let it go apart. Q3 gives the time as well, for the part of a frame
   * the key was down, which the port's move leaves out.
   */
  private binding(key: number, down: boolean): string[] {
    const binding = this.binds.get(key);
    if (!binding) return [];
    const all = this.live && this.catching === 0;
    const commands: string[] = [];
    for (const part of binding.split(';')) {
      const command = part.trimStart();
      if (command.startsWith('+')) {
        if (all || !down) commands.push(`${down ? '+' : '-'}${command.slice(1)} ${key}`);
      } else if (down && (all || this.uiCommand(command))) {
        commands.push(command);
      }
    }
    return commands;
  }

  private uiCommand(command: string): boolean {
    return !(this.catching & KEYCATCH.CONSOLE) && UI_COMMANDS.has(command.toLowerCase());
  }

  private run(line: string): void {
    const argv = tokenize(line);
    if (argv.length > 0) this.command(argv);
  }
}
