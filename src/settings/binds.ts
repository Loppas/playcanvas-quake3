import { DEBUG_MODE } from '../config';
import { K, keyToString } from '../formats/q3-keys';

/** A printable key's number: its lowercased ASCII. */
const key = (char: string) => char.charCodeAt(0);

/**
 * The binds a fresh config starts with: the port's keys, bound to Q3's commands.
 * - W, A, S and D move, Space jumps, and Shift crouches.
 * - The left button attacks, and 1–9 pick the weapons.
 * - Tab shows the scores, and Enter uses the held item, as pak0's `default.cfg` binds both.
 * - The wheel goes as pak0's `default.cfg:31–32` binds it: up for the previous weapon, down for
 *   the next.
 * - F throws CorkScrew's off-hand grapple, which fires on `+button5`.
 * - Under `DEBUG_MODE`, C toggles the collision overlay, and P prints `viewpos`, which places a
 *   splat map's entities. pak0's `default.cfg` binds neither key.
 */
export function defaultBinds(debugMode: boolean = DEBUG_MODE): Map<number, string> {
  const binds = new Map<number, string>([
    [key('w'), '+forward'],
    [key('s'), '+back'],
    [key('a'), '+moveleft'],
    [key('d'), '+moveright'],
    [K.SPACE, '+moveup'],
    [K.SHIFT, '+movedown'],
    [K.MOUSE1, '+attack'],
    [K.TAB, '+scores'],
    [K.ENTER, '+button2'],
    [K.MWHEELUP, 'weapprev'],
    [K.MWHEELDOWN, 'weapnext'],
    [key('f'), '+button5']
  ]);
  for (let slot = 1; slot <= 9; slot++) binds.set(key(String(slot)), `weapon ${slot}`);
  if (debugMode) {
    binds.set(key('c'), 'toggle pcq_drawCollision');
    binds.set(key('p'), 'viewpos');
  }
  return binds;
}

/**
 * The warning a bind to a key carries. A browser keeps Ctrl+W, Ctrl+T and Ctrl+N for
 * itself, and Cmd's on a Mac, and no page can have them, so with the key held, W can close the
 * tab. The desktop shell owns its menu, so there the keys are the game's.
 *
 * @param shell - In the desktop shell.
 * @returns The warning, or `null` for a key that needs none.
 */
export function bindWarning(key: number, shell = false): string | null {
  if (shell || (key !== K.CTRL && key !== K.SUPER && key !== K.COMMAND)) return null;
  const name = keyToString(key);
  return (
    `${name}: a browser keeps Ctrl+W, Ctrl+T and Ctrl+N for itself, and Cmd+W, Cmd+T and ` +
    `Cmd+N on a Mac, so with ${name} held, W can close the tab`
  );
}

/**
 * Which command each key runs: Q3's `keys[].binding` (`cl_keys.c`), with Q3's command names.
 * Every change is announced, as `Key_SetBinding` marks the config for writing
 * (`cl_keys.c:913–929`).
 */
export class BindTable {
  private readonly binds: Map<number, string>;
  private readonly listeners = new Set<() => void>();

  /** @param binds - Each key's command; a fresh config's by default. */
  constructor(binds: Iterable<readonly [number, string]> = defaultBinds()) {
    this.binds = new Map(binds);
  }

  /** The command a key runs, or `undefined` for an unbound key. */
  get(key: number): string | undefined {
    return this.binds.get(key);
  }

  /** `bind`: give a key a command. An empty one unbinds it, as `unbind` does. */
  set(key: number, command: string): void {
    if (command === '') {
      if (!this.binds.delete(key)) return;
    } else {
      if (this.binds.get(key) === command) return;
      this.binds.set(key, command);
    }
    this.announce();
  }

  /** `unbindall` (`cl_keys.c:994–1001`). */
  clear(): void {
    if (this.binds.size === 0) return;
    this.binds.clear();
    this.announce();
  }

  /** The keys bound to a command, in key order, matched without regard to case as `Key_GetKey` does. */
  keysFor(command: string): number[] {
    const wanted = command.toLowerCase();
    return this.entries()
      .filter(([, bound]) => bound.toLowerCase() === wanted)
      .map(([key]) => key);
  }

  /** Every bound key and its command, in key order, as `Key_WriteBindings` goes through them. */
  entries(): [number, string][] {
    return [...this.binds].sort(([a], [b]) => a - b);
  }

  /**
   * Hear of every change.
   *
   * @returns A function that stops it.
   */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private announce(): void {
    for (const listener of this.listeners) listener();
  }
}
