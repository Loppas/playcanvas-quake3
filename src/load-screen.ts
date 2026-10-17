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
 * cgame's lines about the server and the match (`cg_info.c:188–294`).
 *
 * It is part of the page, over the canvas, as the drop screen is. So it shows before the graphics
 * device is up, and the drop screen covers it while it asks for the game data. The connect screen
 * before a map's load looks the same.
 */

/** A download's detail: the megabytes in, to a tenth, and of how many where that is known. */
export function downloaded(received: number, total: number): string {
  const megabytes = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);
  return total > 0 ? `${megabytes(received)} of ${megabytes(total)} MB` : `${megabytes(received)} MB`;
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

/**
 * The load screen's panel, which the connect screen shares: the title and server, the bar and its
 * lines, and cgame's under it.
 */
const LOAD_PANEL = `
  <div class="load-panel">
    <h1 class="load-title"></h1>
    <p class="load-server"></p>
    <div class="load-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100">
      <div class="load-fill"></div>
    </div>
    <p class="load-text"></p>
    <p class="load-file"></p>
    <div class="load-info"></div>
  </div>
`;

/** A screen's layer over the page, holding its panel. */
function overlay(host: HTMLElement, panel: string): HTMLElement {
  const element = document.createElement('div');
  element.className = 'load-screen';
  element.innerHTML = panel;
  host.appendChild(element);
  return element;
}

/** What the connect screen reads of the connection: its share of `uiClientState_t`. */
type ConnectionState = Pick<ClientConnection, 'state' | 'connectPacketCount' | 'serverMessage'>;

/**
 * q3_ui's connect screen (`UI_DrawConnectScreen`, `ui_connect.c:162–253`), from a `connect` until
 * the map its server names starts to load: the server as it was named, how far the connection has
 * got, and what the server printed. It stands in the load screen's panel, its title's line and the
 * bar's room kept empty, since Q3 draws it over the map's load too and nothing on it moves.
 */
export class ConnectScreen {
  private readonly element: HTMLElement;
  private readonly state: HTMLElement;
  private readonly message: HTMLElement;

  /**
   * @param host - What it covers: the page's root, which holds the canvas.
   * @param server - The server as it was named.
   */
  constructor(host: HTMLElement, server: string) {
    this.element = overlay(host, LOAD_PANEL);
    this.element.querySelector('.load-server')!.textContent = connectingTo(server);
    // Nothing loads yet, but the bar keeps its room.
    this.element.querySelector<HTMLElement>('.load-bar')!.style.visibility = 'hidden';
    this.state = this.element.querySelector<HTMLElement>('.load-text')!;
    this.message = document.createElement('p');
    this.message.className = 'load-message';
    this.element.querySelector('.load-info')!.appendChild(this.message);
  }

  /**
   * The connection as it stands, each frame. A line is written only when it changes.
   *
   * @param connection - The connection, or `null` while its server is being looked up.
   */
  show(connection: ConnectionState | null): void {
    const state = connection ? connectState(connection.state, connection.connectPacketCount) : '';
    const message = connection ? connectMessage(connection.state, connection.serverMessage) : '';
    if (this.state.textContent !== state) this.state.textContent = state;
    if (this.message.textContent !== message) this.message.textContent = message;
  }

  /** Take the screen away, for the map's own load. */
  close(): void {
    this.element.remove();
  }
}

/** The screen, its bar, and the steps it waits for. */
export class LoadScreen {
  private readonly element: HTMLElement;
  private readonly server: HTMLElement;
  private readonly bar: HTMLElement;
  private readonly fill: HTMLElement;
  private readonly text: HTMLElement;
  private readonly file: HTMLElement;
  private readonly info: HTMLElement;
  private readonly list: LoadStep[] = [];

  /**
   * @param host - What it covers: the page's root, which holds the canvas.
   * @param title - The map's name.
   */
  constructor(host: HTMLElement, title: string) {
    this.element = overlay(host, LOAD_PANEL);
    this.element.querySelector('.load-title')!.textContent = title;
    this.server = this.element.querySelector<HTMLElement>('.load-server')!;
    this.bar = this.element.querySelector<HTMLElement>('.load-bar')!;
    this.fill = this.element.querySelector<HTMLElement>('.load-fill')!;
    this.text = this.element.querySelector<HTMLElement>('.load-text')!;
    this.file = this.element.querySelector<HTMLElement>('.load-file')!;
    this.info = this.element.querySelector<HTMLElement>('.load-info')!;
    this.render();
  }

  /** The server the map is loading for, under the title. Its line is kept from the start. */
  showServer(server: string): void {
    this.server.textContent = connectingTo(server);
  }

  /** cgame's lines, under the panel: the server's group, then the match's. */
  showInformation(lines: MatchLines): void {
    const group = (texts: readonly string[]) => {
      const element = document.createElement('div');
      element.className = 'load-group';
      for (const text of texts) {
        const line = document.createElement('p');
        line.textContent = text;
        element.appendChild(line);
      }
      return element;
    };
    const groups = [lines.server, lines.match].filter((texts) => texts.length > 0);
    this.info.replaceChildren(...groups.map(group));
  }

  /**
   * A step to wait for, named as `CG_LoadingString` names what loads, with its share of the bar.
   * Every step is added before any comes in, so the bar never goes back.
   */
  step(label: string, weight = 1): LoadStep {
    const step = new LoadStep(label, weight, () => this.render());
    this.list.push(step);
    this.render();
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

  /** Take the screen away, for the game to start. */
  close(): void {
    this.element.remove();
  }

  private render(): void {
    const fraction = this.fraction;
    this.fill.style.width = `${fraction * 100}%`;
    this.bar.setAttribute('aria-valuenow', String(Math.round(fraction * 100)));
    const loading = this.loading;
    this.text.textContent = loading ? `Loading... ${loading.label}` : '';
    this.file.textContent = loading?.detail ?? '';
  }
}
