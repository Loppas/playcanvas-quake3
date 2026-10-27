import { atoi } from '../formats/c-scan';
import { K } from '../formats/q3-keys';
import { tokenize } from '../formats/q3config';
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
}

/**
 * Q3's keys as the client takes them. A key runs its bind as `CL_ParseBinding`
 * does (`cl_keys.c:1184–1232`), as the console's commands, and the buttons those hold are what
 * each frame's move is made from (`CL_KeyMove`, `CL_CmdButtons`).
 *
 * Input reaches the game only while it is {@link active}: the mouse captured and no menu up. Going
 * out lets every key go, as `Key_ClearStates` does. While out, a key pressed runs nothing, but a
 * key let go still lets its button go, as Q3 runs a bind's `-` half with a menu up, "to keep the
 * character from continuing an action started before a mode switch" (`cl_keys.c:1352–1358`).
 *
 * Engine- and DOM-free: `key-input.ts` hands it Q3's key numbers.
 */
export class ClientInput {
  private readonly binds: BindTable;
  private readonly command: (argv: readonly string[]) => void;
  private readonly warn: (message: string) => void;
  private readonly buttons = new Map<string, KeyButton>();
  /** The keys down, `keys[].down`, so they can all be let go at once. */
  private readonly down = new Set<number>();
  private readonly queued: string[][] = [];
  private mouseX = 0;
  private mouseY = 0;
  private live = false;
  /** What {@link keyMove} and {@link takeMouse} give, written again each time. */
  private readonly move: KeyMove = { forwardmove: 0, rightmove: 0, upmove: 0 };
  private readonly movement = { dx: 0, dy: 0 };

  constructor(binds: BindTable, options: ClientInputOptions = {}) {
    this.binds = binds;
    this.command = options.command ?? (() => {});
    this.warn = options.warn ?? console.warn;
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
  }

  /** Whether input reaches the game: the mouse captured and no menu up. */
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

  /** Whether a key is bound, so its browser default can be stopped. */
  bound(key: number): boolean {
    return this.binds.get(key) !== undefined;
  }

  /** A key goes down: `CL_KeyDownEvent` (`cl_keys.c:1241–1329`). */
  keyDown(key: number): void {
    this.down.add(key);
    // Escape is the menu's, whatever it is bound to (`cl_keys.c:1279–1308`).
    if (key === K.ESCAPE) return;
    this.parseBinding(key, true);
  }

  /** A key comes up: `CL_KeyUpEvent` (`cl_keys.c:1338–1365`). */
  keyUp(key: number): void {
    this.down.delete(key);
    this.parseBinding(key, false);
  }

  /** Let every key down go, as `Key_ClearStates` does (`cl_keys.c:1420–1434`). */
  clear(): void {
    for (const key of [...this.down]) this.keyUp(key);
  }

  /** Mouse movement, gathered until the frame takes it (`CL_MouseEvent`, `cl_input.c:362–371`). */
  mouseMove(dx: number, dy: number): void {
    if (!this.live) return;
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
   * shorter than a frame still fires once. Reading it takes those presses.
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
    return buttons;
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

  /**
   * `CL_ParseBinding`: each of a bind's commands, split at its semicolons. A `+` command runs on
   * the press as itself and on the release with a `-`, each given the key, so that two keys
   * holding one button let it go apart. Q3 gives the time as well, for the part of a frame the key
   * was down, which the port's move leaves out.
   */
  private parseBinding(key: number, down: boolean): void {
    const binding = this.binds.get(key);
    if (!binding) return;
    for (const part of binding.split(';')) {
      const command = part.trimStart();
      if (command.startsWith('+')) {
        if (this.live || !down) this.run(`${down ? '+' : '-'}${command.slice(1)} ${key}`);
      } else if (down && this.live) {
        this.run(command);
      }
    }
  }

  private run(line: string): void {
    const argv = tokenize(line);
    if (argv.length > 0) this.command(argv);
  }
}
