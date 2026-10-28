import type { ClientConnection } from './net/connection';
import { connectingTo, connectMessage, connectState, type MatchLines } from './view/load-info';

/**
 * The load screen: nothing plays until everything the game draws and plays is in, as cgame
 * registers a level's media before its first frame (`CG_Init`, `cg_main.c:1897–1918`). A bar fills
 * as each step comes in, over Q3's line naming the first still loading (`CG_LoadingString`,
 * `CG_DrawInformation`; `cg_info.c:68–72, 178–180`). Under that line is what the step is doing:
 * - the file it has reached and how many of how many, as Q3's line names each item and player in
 *   turn (`CG_LoadingItem`, `CG_LoadingClient`; `cg_info.c:79–88, 96–137`);
 * - a download's megabytes, as they come in;
 * - or the part it is building.
 *
 * Under the title is the server it is connecting to, which q3_ui draws over a map's load so that
 * it doesn't flash away (`SCR_DrawScreenField`, `cl_scrn.c:515–525`). Under the panel are
 * cgame's lines about the server and the match (`cg_info.c:188–294`). The connect screen before a
 * map's load stands in the same panel.
 *
 * This is what the screens say; `render/load-panel-screen.ts` draws the one on top. A screen is
 * kept from the page's start, before there is a device to draw it on.
 */

/** A download's detail: the megabytes in, to a tenth, and of how many where that is known. */
export function downloaded(received: number, total: number): string {
  const megabytes = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);
  return total > 0 ? `${megabytes(received)} of ${megabytes(total)} MB` : `${megabytes(received)} MB`;
}

/** What the panel shows of a screen: the parts the load and connect screens share. */
export interface Panel {
  /** The map's name, kept empty on a connect. */
  readonly title: string;
  /** The server it is connecting to. */
  readonly server: string;
  /** Whether the bar is drawn: a connect keeps its room, empty. */
  readonly bar: boolean;
  /** How much of the load is in, from 0 to 1. */
  readonly fraction: number;
  /** What loads, or how far a connect has got. */
  readonly line: string;
  /** What the step on the line is doing. */
  readonly detail: string;
  /** cgame's lines, in their groups, or the server's print. */
  readonly groups: readonly (readonly string[])[];
  /** Moves whenever any of the above changes, and only then. */
  readonly revision: number;
}

/**
 * The load and connect screens up, the newest on top, as a page stacks what it adds over itself:
 * a map's load comes up before the connect screen under it goes.
 */
export class LoadScreens {
  private readonly list: Panel[] = [];

  /** The screen on top, which the panel draws, or `null` with none up. */
  get top(): Panel | null {
    return this.list.at(-1) ?? null;
  }

  /** Put a screen up, over any already up. */
  open(screen: Panel): void {
    this.list.push(screen);
  }

  /** Take a screen down, wherever it stands. One not up is let be. */
  close(screen: Panel): void {
    const index = this.list.indexOf(screen);
    if (index >= 0) this.list.splice(index, 1);
  }
}

/** One thing the load waits for, and its share of the bar. */
export class LoadStep {
  readonly weight: number;
  private name: string;
  private fraction = 0;
  private said = '';
  private readonly changed: () => void;

  constructor(label: string, weight: number, changed: () => void) {
    this.name = label;
    this.weight = weight;
    this.changed = changed;
  }

  /** What the line calls it while it loads. */
  get label(): string {
    return this.name;
  }

  /**
   * Call it by another name: a step added before what it loads is known, as a boot's map is
   * before the search path can say what the map ships.
   */
  rename(label: string): void {
    if (label === this.name) return;
    this.name = label;
    this.changed();
  }

  /** How far it has got, from 0 to 1. */
  get progress(): number {
    return this.fraction;
  }

  /** Whether it is in. */
  get finished(): boolean {
    return this.fraction >= 1;
  }

  /** What it is doing now, which the screen shows under the line: the file it has reached. */
  get detail(): string {
    return this.said;
  }

  /**
   * Move it on, to a fraction from 0 to 1. It never goes back.
   *
   * @param detail - What it is doing now. The last one given stands until another is.
   */
  advance(fraction: number, detail = this.said): void {
    const next = Math.min(1, Math.max(this.fraction, fraction));
    if (next === this.fraction && detail === this.said) return;
    this.fraction = next;
    this.said = detail;
    this.changed();
  }

  /** It is in, or has failed: either way the load goes on without waiting for it. */
  finish(): void {
    this.advance(1);
  }

  /**
   * Finish once this work settles, either way.
   *
   * @returns the work, for the caller to await
   */
  track<T>(work: Promise<T>): Promise<T> {
    const finish = () => this.finish();
    work.then(finish, finish);
    return work;
  }
}

/** What the connect screen reads of the connection: its share of `uiClientState_t`. */
type ConnectionState = Pick<ClientConnection, 'state' | 'connectPacketCount' | 'serverMessage'>;

/**
 * q3_ui's connect screen (`UI_DrawConnectScreen`, `ui_connect.c:162–253`), from a `connect` until
 * the map its server names starts to load: the server as it was named, how far the connection has
 * got, and what the server printed. Its title's line and the bar's room are kept empty, since Q3
 * draws it over the map's load too and nothing on it moves.
 */
export class ConnectScreen implements Panel {
  readonly title = '';
  readonly server: string;
  readonly bar = false;
  readonly fraction = 0;
  readonly detail = '';
  private state = '';
  private printed = '';
  private changes = 0;
  private readonly screens: LoadScreens;

  /**
   * @param screens - The screens up, which it goes on top of.
   * @param server - The server as it was named.
   */
  constructor(screens: LoadScreens, server: string) {
    this.screens = screens;
    this.server = connectingTo(server);
    screens.open(this);
  }

  get line(): string {
    return this.state;
  }

  /** What the server printed, alone under the panel. */
  get message(): string {
    return this.printed;
  }

  get groups(): readonly (readonly string[])[] {
    return [[this.printed]];
  }

  get revision(): number {
    return this.changes;
  }

  /**
   * The connection as it stands, each frame. The screen changes only when a line does.
   *
   * @param connection - The connection, or `null` while its server is being looked up.
   */
  show(connection: ConnectionState | null): void {
    const state = connection ? connectState(connection.state, connection.connectPacketCount) : '';
    const message = connection ? connectMessage(connection.state, connection.serverMessage) : '';
    if (state === this.state && message === this.printed) return;
    this.state = state;
    this.printed = message;
    this.changes++;
  }

  /** Take the screen away, for the map's own load. */
  close(): void {
    this.screens.close(this);
  }
}

/** The screen, its bar, and the steps it waits for. */
export class LoadScreen implements Panel {
  readonly title: string;
  readonly bar = true;
  private shownServer = '';
  private information: readonly (readonly string[])[] = [];
  private readonly list: LoadStep[] = [];
  private changes = 0;
  private readonly screens: LoadScreens;

  /**
   * @param screens - The screens up, which it goes on top of.
   * @param title - The map's name.
   */
  constructor(screens: LoadScreens, title: string) {
    this.screens = screens;
    this.title = title;
    screens.open(this);
  }

  get server(): string {
    return this.shownServer;
  }

  get groups(): readonly (readonly string[])[] {
    return this.information;
  }

  get revision(): number {
    return this.changes;
  }

  /** The server the map is loading for, under the title. Its line is kept from the start. */
  showServer(server: string): void {
    this.shownServer = connectingTo(server);
    this.changes++;
  }

  /** cgame's lines, under the panel: the server's group, then the match's, with no group for none. */
  showInformation(lines: MatchLines): void {
    this.information = [lines.server, lines.match].filter((texts) => texts.length > 0);
    this.changes++;
  }

  /**
   * A step to wait for, named as `CG_LoadingString` names what loads, with its share of the bar.
   * Every step is added before any comes in, so the bar never goes back.
   */
  step(label: string, weight = 1): LoadStep {
    const step = new LoadStep(label, weight, () => this.changes++);
    this.list.push(step);
    this.changes++;
    return step;
  }

  /** Every step, in the order they were added. */
  get steps(): readonly LoadStep[] {
    return this.list;
  }

  /** How much of the load is in, from 0 to 1, each step counted by its weight. */
  get fraction(): number {
    let total = 0;
    let done = 0;
    for (const step of this.steps) {
      total += step.weight;
      done += step.weight * step.progress;
    }
    return total > 0 ? done / total : 0;
  }

  /** The first step still loading, which the line names, or `null` once every one is in. */
  get loading(): LoadStep | null {
    return this.steps.find((step) => !step.finished) ?? null;
  }

  get line(): string {
    const loading = this.loading;
    return loading ? `Loading... ${loading.label}` : '';
  }

  get detail(): string {
    return this.loading?.detail ?? '';
  }

  /** Take the screen away, for the game to start. */
  close(): void {
    this.screens.close(this);
  }
}
