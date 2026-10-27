import { DEBUG_MODE } from '../config';
import { stringToKey } from '../formats/q3-keys';
import { configCommands, writeConfig } from '../formats/q3config';
import { BindTable, bindWarning, defaultBinds } from './binds';
import { type CommandTable, unknownCommand } from './command-router';
import { Cvars } from './cvars';
import { SETTINGS, SETTING_KEYS, settingForCvar } from './registry';

/**
 * The settings' commands, as `CL_InitKeyCommands` and `Cvar_Init` register them
 * (`cl_keys.c:1148–1155`, `cvar.c:1445–1463`), as far as the port has them.
 */
const CONFIG_COMMANDS = [
  'bind',
  'unbind',
  'unbindall',
  'toggle',
  'set',
  'sets',
  'setu',
  'seta',
  'reset'
] as const;

export interface GameConfigOptions {
  /** The saved `q3config.cfg`, or nothing on a first run. */
  config?: string;
  /** The page's query string. */
  search?: string;
  /** `DEBUG_MODE`: a parameter, so a test can turn it off. */
  debugMode?: boolean;
  /** Where a line or a value that can't be used is reported. */
  warn?: (message: string) => void;
  /** In the desktop shell, which owns its menu, so no bind warns of a key the browser keeps. */
  shell?: boolean;
}

/**
 * The settings and the binds together: what `q3config.cfg` holds.
 *
 * At start the defaults come first, as `Cvar_Get` registers them and pak0's `default.cfg` binds
 * the keys; then the saved file, run as `exec q3config.cfg` runs it (`common.c:2378`); then the
 * query string. {@link text} is the file to save, and {@link onSave} says when it changed.
 */
export class GameConfig {
  readonly cvars: Cvars;
  readonly binds: BindTable;
  /** In the desktop shell, where no bind warns of a key the browser keeps. */
  readonly shell: boolean;
  private readonly warn: (message: string) => void;

  constructor(options: GameConfigOptions = {}) {
    const debugMode = options.debugMode ?? DEBUG_MODE;
    this.warn = options.warn ?? console.warn;
    this.shell = options.shell ?? false;
    this.cvars = new Cvars({ debugMode, warn: this.warn });
    this.binds = new BindTable(defaultBinds(debugMode));
    this.run(options.config ?? '', true);
    this.cvars.applyUrl(options.search ?? '');
  }

  /**
   * `exec`: run a config's commands now, as an import does. A latched setting waits for the next
   * start.
   */
  exec(text: string): void {
    this.run(text, false);
  }

  /**
   * Setup's Defaults: `exec default.cfg` and `cvar_restart` (`ui_setup.c:78–85`). Every key
   * is bound as a fresh config binds it, and every setting goes back to its default, but for a
   * Debug one without `DEBUG_MODE`, which the file keeps. A cvar the port does not use is
   * kept too, as the file keeps it.
   */
  restoreDefaults(): void {
    this.binds.clear();
    for (const [key, command] of defaultBinds(this.cvars.debugMode)) this.binds.set(key, command);
    for (const key of SETTING_KEYS) {
      if (SETTINGS[key].section === 'debug' && !this.cvars.debugMode) continue;
      this.cvars.reset(SETTINGS[key].cvar);
    }
  }

  /**
   * Run one of the commands a config or the console holds: `bind`, `unbind`, `unbindall`,
   * `set` and `seta` and their kin, `toggle`, `reset`, or a cvar's name and a value.
   *
   * @returns Whether it was one of those.
   */
  command(argv: readonly string[]): boolean {
    return this.runCommand(argv, false);
  }

  /** Put the settings' commands in the console's table. */
  addCommands(table: CommandTable): void {
    for (const name of CONFIG_COMMANDS) table.add(name, (argv) => void this.runCommand(argv, false));
  }

  /**
   * `Cvar_Command` (`cvar.c:750–768`): a cvar's name, and a value to set it to.
   *
   * @returns Whether it was a cvar's name.
   */
  cvarCommand(argv: readonly string[]): boolean {
    return this.cvarByName(argv, false);
  }

  /** The file, as Q3 writes it (`Com_WriteConfigToFile`). */
  text(): string {
    return writeConfig(this.binds.entries(), this.cvars.archived());
  }

  /**
   * Hear that the file changed, so it wants writing.
   *
   * @returns A function that stops it.
   */
  onSave(listener: () => void): () => void {
    const stopCvars = this.cvars.onSave(listener);
    const stopBinds = this.binds.onChange(listener);
    return () => {
      stopCvars();
      stopBinds();
    };
  }

  /**
   * Bind a key. A bind made as the game runs warns of a key the browser keeps; one the file
   * had at start doesn't, or it would every start.
   */
  private bind(key: number, command: string, loading: boolean): void {
    this.binds.set(key, command);
    const warning = loading ? null : bindWarning(key, this.shell);
    if (warning) this.warn(warning);
  }

  private run(text: string, loading: boolean): void {
    for (const argv of configCommands(text)) {
      if (!this.runCommand(argv, loading)) this.warn(unknownCommand(argv[0]));
    }
  }

  /**
   * @param loading - At start, a cvar is loaded from the file rather than set, so a latched one
   *   takes it now.
   */
  private runCommand(argv: readonly string[], loading: boolean): boolean {
    const [name, ...args] = argv;
    switch (name.toLowerCase()) {
      case 'unbindall':
        this.binds.clear();
        return true;
      case 'bind':
      case 'unbind': {
        // `Key_Bind_f` and `Key_Unbind_f` (`cl_keys.c:969–1047`). A key alone only prints its bind.
        if (args.length === 0) return true;
        const key = stringToKey(args[0]);
        if (key === -1) this.warn(`"${args[0]}" isn't a valid key`);
        else if (name.toLowerCase() === 'unbind') this.binds.set(key, '');
        else if (args.length > 1) this.bind(key, args.slice(1).join(' '), loading);
        return true;
      }
      case 'set':
      case 'seta':
      case 'sets':
      case 'setu':
        // `Cvar_Set_f` (`cvar.c:852–893`): a name alone only prints its value.
        if (args.length >= 2) {
          this.setCvar(args[0], args.slice(1).join(' '), name.toLowerCase() === 'seta', loading);
        }
        return true;
      case 'toggle':
        if (args.length > 0) this.cvars.toggle(args[0], args.slice(1));
        return true;
      case 'reset':
        if (args.length === 1) this.cvars.reset(args[0]);
        return true;
      default:
        return this.cvarByName(argv, loading);
    }
  }

  /** {@link cvarCommand}, loading the value instead while the saved file is read at start. */
  private cvarByName(argv: readonly string[], loading: boolean): boolean {
    const [name, ...args] = argv;
    if (!settingForCvar(name) && this.cvars.string(name) === undefined) return false;
    if (args.length > 0) this.setCvar(name, args.join(' '), false, loading);
    return true;
  }

  private setCvar(name: string, value: string, archive: boolean, loading: boolean): void {
    if (loading) this.cvars.load(name, value, archive);
    else this.cvars.set(name, value, archive);
  }
}
