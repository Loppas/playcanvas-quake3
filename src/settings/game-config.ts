import { DEBUG_MODE } from '../config';
import { keyToString, stringToKey } from '../formats/q3-keys';
import { configCommands, writeConfig } from '../formats/q3config';
import { completeBind, completeCvarName, completeUnbind } from '../view/field-complete';
import { BindTable, bindWarning, defaultBinds } from './binds';
import { type CommandTable, unknownCommand } from './command-router';
import { Cvars } from './cvars';
import { SETTINGS, SETTING_KEYS } from './registry';

/**
 * The settings' commands, as `CL_InitKeyCommands` and `Cvar_Init` register them
 * (`cl_keys.c:1148–1155`, `cvar.c:1445–1463`), as far as the port has them.
 */
const CONFIG_COMMANDS = [
  'bind',
  'unbind',
  'unbindall',
  'bindlist',
  'print',
  'toggle',
  'set',
  'sets',
  'setu',
  'seta',
  'reset',
  'unset',
  'cvarlist',
  'cvar_restart'
] as const;

/** The commands whose second word is a cvar's name. */
const CVAR_NAME_COMMANDS = ['toggle', 'set', 'sets', 'setu', 'seta', 'reset', 'unset'] as const;

export interface GameConfigOptions {
  /** The saved `q3config.cfg`, or nothing on a first run. */
  config?: string;
  /** The page's query string. */
  search?: string;
  /** `DEBUG_MODE`: a parameter, so a test can turn it off. */
  debugMode?: boolean;
  /** Print to the console, as `Com_Printf` does: what the commands print, and their refusals. */
  print?: (text: string) => void;
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
  private readonly print: (text: string) => void;

  constructor(options: GameConfigOptions = {}) {
    const debugMode = options.debugMode ?? DEBUG_MODE;
    this.print = options.print ?? ((text) => console.warn(text.trimEnd()));
    this.shell = options.shell ?? false;
    this.cvars = new Cvars({ debugMode, print: this.print });
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
   * Run one of the commands a config or the console holds: the binds' and the cvars' own, or a
   * cvar's name and a value.
   *
   * @returns Whether it was one of those.
   */
  command(argv: readonly string[]): boolean {
    return this.runCommand(argv, false);
  }

  /**
   * Put the settings' commands in the console's table, Tab completing a cvar's name after those
   * that take one and a key's after `bind` and `unbind`, as `Cvar_Init` and `CL_InitKeyCommands`
   * have it (`cvar.c:1447–1459`, `cl_keys.c:1151–1153`).
   */
  addCommands(table: CommandTable): void {
    for (const name of CONFIG_COMMANDS) table.add(name, (argv) => void this.runCommand(argv, false));
    for (const name of CVAR_NAME_COMMANDS) table.setCompletion(name, completeCvarName);
    table.setCompletion('bind', completeBind);
    table.setCompletion('unbind', completeUnbind);
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
    if (warning) this.print(`${warning}\n`);
  }

  private run(text: string, loading: boolean): void {
    for (const argv of configCommands(text)) {
      if (!this.runCommand(argv, loading)) this.print(`${unknownCommand(argv[0])}\n`);
    }
  }

  /**
   * Each usage line names the command as it was typed, as `Cmd_Argv(0)` does.
   *
   * @param loading - At start, a cvar is loaded from the file rather than set, so a latched one
   *   takes it now.
   */
  private runCommand(argv: readonly string[], loading: boolean): boolean {
    const [name, ...args] = argv;
    const command = name.toLowerCase();
    switch (command) {
      case 'unbindall':
        this.binds.clear();
        return true;
      case 'bind':
        this.bindKey(args, loading);
        return true;
      case 'unbind':
        this.unbindKey(args);
        return true;
      case 'bindlist':
        // `Key_Bindlist_f` (`cl_keys.c:1077–1085`).
        for (const [key, bound] of this.binds.entries()) {
          this.print(`${keyToString(key)} "${bound}"\n`);
        }
        return true;
      case 'set':
      case 'seta':
      case 'sets':
      case 'setu':
        // `Cvar_Set_f` (`cvar.c:852–893`): a name alone prints the cvar, as `print` does.
        if (args.length === 0) this.print(`usage: ${name} <variable> <value>\n`);
        else if (args.length === 1) this.printCvar(args[0]);
        else this.setCvar(args[0], args.slice(1).join(' '), command === 'seta', loading);
        return true;
      case 'print':
        // `Cvar_Print_f` (`cvar.c:779–798`).
        if (args.length === 1) this.printCvar(args[0]);
        else this.print('usage: print <variable>\n');
        return true;
      case 'toggle':
        // `Cvar_Toggle_f` (`cvar.c:808–842`).
        if (args.length > 0) this.cvars.toggle(args[0], args.slice(1));
        else this.print('usage: toggle <variable> [value1, value2, ...]\n');
        return true;
      case 'reset':
        // `Cvar_Reset_f` (`cvar.c:900–906`).
        if (args.length === 1) this.cvars.resetFromConsole(args[0]);
        else this.print('usage: reset <variable>\n');
        return true;
      case 'unset':
        this.unset(name, args);
        return true;
      case 'cvarlist':
        // `Cvar_List_f` (`cvar.c:953–962`): the word after it filters, and any more are ignored.
        this.cvars.listCvars(args[0]);
        return true;
      case 'cvar_restart':
        this.cvars.restart();
        return true;
      default:
        return this.cvarByName(argv, loading);
    }
  }

  /** `Key_Bind_f` (`cl_keys.c:1009–1047`): a key alone prints what it is bound to. */
  private bindKey(args: readonly string[], loading: boolean): void {
    if (args.length === 0) {
      this.print('bind <key> [command] : attach a command to a key\n');
      return;
    }
    const key = stringToKey(args[0]);
    if (key === -1) {
      this.print(`"${args[0]}" isn't a valid key\n`);
    } else if (args.length > 1) {
      this.bind(key, args.slice(1).join(' '), loading);
    } else {
      const named = keyToString(key);
      const bound = this.binds.get(key);
      this.print(bound ? `"${named}" = "${bound}"\n` : `"${named}" is not bound\n`);
    }
  }

  /** `Key_Unbind_f` (`cl_keys.c:969–987`). */
  private unbindKey(args: readonly string[]): void {
    if (args.length !== 1) {
      this.print('unbind <key> : remove commands from a key\n');
      return;
    }
    const key = stringToKey(args[0]);
    if (key === -1) this.print(`"${args[0]}" isn't a valid key\n`);
    else this.binds.set(key, '');
  }

  /** `Cvar_Print_f`'s print (`cvar.c:792–797`). */
  private printCvar(name: string): void {
    if (!this.cvars.printCvar(name)) this.print(`Cvar ${name} does not exist.\n`);
  }

  /** `Cvar_Unset_f` (`cvar.c:1160–1179`): a cvar nothing has made says nothing. */
  private unset(command: string, args: readonly string[]): void {
    if (args.length !== 1) {
      this.print(`Usage: ${command} <varname>\n`);
      return;
    }
    const held = this.cvars.nameOf(args[0]);
    if (held !== undefined && !this.cvars.unset(args[0])) {
      this.print(`Error: ${command}: Variable ${held} is not user created.\n`);
    }
  }

  /**
   * {@link cvarCommand}, loading the value instead while the saved file is read at start. The cvar
   * is named as it was made, not as it was typed.
   */
  private cvarByName(argv: readonly string[], loading: boolean): boolean {
    const [typed, ...args] = argv;
    const name = this.cvars.nameOf(typed);
    if (name === undefined) return false;
    if (args.length === 0) this.cvars.printCvar(name);
    else this.setCvar(name, args.join(' '), false, loading);
    return true;
  }

  private setCvar(name: string, value: string, archive: boolean, loading: boolean): void {
    if (loading) this.cvars.load(name, value, archive);
    else this.cvars.setFromConsole(name, value, archive);
  }
}
