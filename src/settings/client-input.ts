import { K } from '../formats/q3-keys';
import { tokenize } from '../formats/q3config';
import type { BindTable } from './binds';

/** `movespeed` in `CL_KeyMove` with `cl_run` on (`cl_input.c:326–332`): the port always runs. */
const MOVE_SPEED = 127;

/** The commands cgame runs, which wait for the frame: the weapons (`cg_consolecmds.c`). */
const CGAME_COMMANDS = new Set(['weapon', 'weapnext', 'weapprev']);

/** Buttons with two names: `+attack` is `+button0` (`cl_input.c:961–963`). */
const BUTTON_ALIASES = new Map([['attack', 'button0']]);

/** The moves the client reads by name (`CL_KeyMove`), which are button state and no command. */
const MOVE_BUTTONS = new Set(['forward', 'back', 'moveleft', 'moveright', 'moveup', 'movedown']);

/**
 * Whether a `+`-command is one of the client's own buttons, which only the move and the button
 * bits read. Every other one — `+scores` among them — runs as the console's, as Q3 runs each
 * (`cl_keys.c:1208–1218`).
 */
function isButtonCommand(name: string): boolean {
  return MOVE_BUTTONS.has(name) || BUTTON_ALIASES.has(name) || /^button\d+$/.test(name);
}

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
   * `IN_KeyDown` (`cl_input.c:76–110`).
   *
   * @returns `false` for a third key, which Q3 refuses.
   */
  down(key: number): boolean {
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

  /** `IN_KeyUp` (`cl_input.c:112–150`): a key that isn't holding it is passed by. */
  up(key: number): void {
    if (this.keys[0] === key) this.keys[0] = 0;
    else if (this.keys[1] === key) this.keys[1] = 0;
    else return;
    if (!this.keys[0] && !this.keys[1]) this.active = false;
  }
}

export interface ClientInputOptions {
  /** Run a command that is neither a button nor cgame's: `toggle`, a cvar's name, `bind`. */
  command?: (argv: readonly string[]) => boolean;
  /** Where a command nothing takes is reported. */
  warn?: (message: string) => void;
}

/**
 * Q3's keys as the client takes them. A key runs its bind as `CL_ParseBinding`
 * does (`cl_keys.c:1184–1232`), and the binds hold Q3's buttons, which each frame's move is made
 * from (`CL_KeyMove`, `CL_CmdButtons`).
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
  private readonly command: (argv: readonly string[]) => boolean;
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
    this.command = options.command ?? (() => false);
    this.warn = options.warn ?? console.warn;
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
      const button = this.buttons.get(`button${i}`);
      if (!button) continue;
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
    return this.buttons.get(name)?.active ? MOVE_SPEED : 0;
  }

  /** `CL_ParseBinding`: each of a bind's commands, split at its semicolons. */
  private parseBinding(key: number, down: boolean): void {
    const binding = this.binds.get(key);
    if (!binding) return;
    for (const part of binding.split(';')) {
      const command = part.trimStart();
      if (command.startsWith('+')) {
        if (this.live || !down) this.press(command.slice(1), key, down);
        // Q3 runs a `+`-command as a console command too: `+scores` on the press and `-scores` on
        // the release (`cl_keys.c:1208–1218`). A button of the client's own runs no command.
        const name = command.slice(1);
        if (isButtonCommand(name)) continue;
        if (down && this.live) this.run(tokenize(`+${name}`));
        else if (!down) this.run(tokenize(`-${name}`));
      } else if (down && this.live) {
        this.run(tokenize(command));
      }
    }
  }

  private press(command: string, key: number, down: boolean): void {
    const name = tokenize(command)[0]?.toLowerCase();
    if (!name) return;
    const id = BUTTON_ALIASES.get(name) ?? name;
    let button = this.buttons.get(id);
    if (!button) {
      button = new KeyButton();
      this.buttons.set(id, button);
    }
    if (!down) button.up(key);
    else if (!button.down(key)) this.warn('Three keys down for a button!');
  }

  private run(argv: string[]): void {
    if (argv.length === 0) return;
    if (!this.cgameCommand(argv) && !this.command(argv)) this.warn(`Unknown command "${argv[0]}"`);
  }
}
