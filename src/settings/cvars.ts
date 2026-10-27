import { DEBUG_MODE } from '../config';
import { atoi } from '../formats/c-scan';
import { comFilter } from '../formats/com-filter';
import type { ArchivedCvar } from '../formats/q3config';
import type { CvarStore } from '../net/cvar';
import { isSysteminfoRecordKey, SERVERINFO_CVARS, SYSTEMINFO_CVARS } from '../sim/rules';
import {
  DEFAULT_SETTINGS,
  SETTINGS,
  SETTING_KEYS,
  settingForCvar,
  USERINFO_SETTINGS,
  type Settings
} from './registry';

type Key = keyof Settings;

/**
 * The systeminfo's cvars past the client's own record of it, lowercased: what a server may set in
 * this store and nothing else may. The rest go into the record, never here.
 */
const SERVER_CVARS = new Set(
  SYSTEMINFO_CVARS.filter((name) => !isSysteminfoRecordKey(name)).map((name) => name.toLowerCase())
);

/** The cvars each info string carries, lowercased: `cvarlist`'s `S`, `s` and `U`. */
const SERVERINFO = new Set(SERVERINFO_CVARS.map((name) => name.toLowerCase()));
const SYSTEMINFO = new Set(SYSTEMINFO_CVARS.map((name) => name.toLowerCase()));
const USERINFO = new Set(USERINFO_SETTINGS.map((key) => SETTINGS[key].cvar.toLowerCase()));

/**
 * One setting's strings, the file's and this tab's if the query string set it, and whether the file
 * keeps it.
 */
interface Slot {
  /** What `q3config.cfg` holds for it: the file's string, the default's, or the last one set. */
  saved: string;
  /** {@link saved}'s value, or `undefined` for a string it can't use. */
  savedValue: unknown;
  /** The query string's, in force in this tab alone and never saved. */
  url?: { raw: string; value: unknown };
  /**
   * The string its value in force was read from. A setting a reload takes up holds a newer one
   * apart from it, as Q3's `latchedString` waits beside `string`.
   */
  applied: string;
  /** `CVAR_ARCHIVE`: the registry's, or added by `seta` (`Cvar_Set_f`, `cvar.c:873–879`). */
  archive: boolean;
}

/** A cvar the port does not use, kept so the file keeps it. */
interface OtherCvar {
  /** Spelled as it was first given. */
  name: string;
  value: string;
  /** The string it was made with, its default, as `Cvar_Get` keeps a `resetString`. */
  reset: string;
  /** Set by `seta`, so written back (`Cvar_Set_f`, `cvar.c:873–879`). */
  archive: boolean;
  /** Sent by a server and never held here before: `CVAR_SERVER_CREATED | CVAR_ROM`. */
  server: boolean;
  /** Made by the console or a cfg, not by the engine, the game or a server: `CVAR_USER_CREATED`. */
  user: boolean;
}

/** The flags an {@link OtherCvar} is made or set with. */
type OtherFlag = 'server' | 'user';

/** A cvar as `cvarlist` lists it. */
interface Listed {
  name: string;
  value: string;
  flags: string;
}

export interface CvarsOptions {
  /** `DEBUG_MODE`: a parameter, so a test can turn it off. */
  debugMode?: boolean;
  /** Print to the console, as `Com_Printf` does: a refusal, a listing, a value it can't use. */
  print?: (text: string) => void;
}

/** A column of `cvarlist`'s: its letter, or a space. */
function column(on: boolean, letter: string): string {
  return on ? letter : ' ';
}

/** A cvar's own flags, as `cvarlist` shows them. */
interface OwnFlags {
  readOnly?: boolean;
  archive: boolean;
  latched?: boolean;
  cheat?: boolean;
  user?: boolean;
}

/** `cvarlist`'s nine columns for a cvar: the info strings that carry it, then its own flags. */
function flagColumns(name: string, own: OwnFlags): string {
  const lower = name.toLowerCase();
  return [
    column(SERVERINFO.has(lower), 'S'),
    column(SYSTEMINFO.has(lower), 's'),
    column(USERINFO.has(lower), 'U'),
    column(own.readOnly === true, 'R'),
    // `CVAR_INIT`: none of the port's cvars is write protected.
    ' ',
    column(own.archive, 'A'),
    column(own.latched === true, 'L'),
    column(own.cheat === true, 'C'),
    column(own.user === true, '?')
  ].join('');
}

/** `Cvar_Print`'s first line: the value, and the default, which a read-only cvar leaves out. */
function valueLine(name: string, value: string, reset: string | undefined): string {
  let line = `"${name}" is:"${value}^7"`;
  if (reset !== undefined) {
    line += value.toLowerCase() === reset.toLowerCase() ? ', the default' : ` default:"${reset}^7"`;
  }
  return `${line}\n`;
}

/**
 * The settings' values, from their three sources, in order: the query string, `q3config.cfg`,
 * then the default.
 *
 * Q3's cvars, cut down to what the port keeps. A setting is archived if the registry doesn't say
 * otherwise or `seta` has set it: the file has each archived one with the string it was last set
 * to (`Cvar_WriteVariables`, `cvar.c:916–946`).
 * - **The query string** sets any setting by its cvar name, in its own tab alone, and is never
 *   saved. A change to such a setting stays in the tab too, so a tab opened to
 *   compare never writes over the saved file.
 * - **The cheat settings** act at their defaults and refuse a new value while `sv_cheats` is 0, as
 *   a cheat cvar does (`cvar.c:572–576`), and a server's `sv_cheats` 0 puts them back to their
 *   defaults. `sv_cheats` is 1 until a server says otherwise, and a `DEBUG_MODE` build's host
 *   always says 1.
 * - **The latched settings** — System's Graphics, and the two a match is built around — take a new
 *   value at the next start, as `vid_restart` or a map load would apply it. The file has the new
 *   value at once, as Q3 writes a latched string (`cvar.c:927–934`).
 * - **Any other cvar** the file sets with `seta` is kept and written back, as Q3 keeps one.
 *
 * The console sets a cvar through {@link setFromConsole}, the menu and the engine through
 * {@link set}. DOM-free.
 */
export class Cvars implements CvarStore {
  readonly debugMode: boolean;
  private readonly print: (text: string) => void;
  private readonly values: Settings;
  private readonly slots = new Map<Key, Slot>();
  /** By the name in lower case. */
  private readonly others = new Map<string, OtherCvar>();
  private readonly changeListeners = new Set<(key: Key) => void>();
  /** Hear every cvar whose stored value changed, whoever changed it. */
  private readonly cvarChangeListeners = new Set<(name: string, value: string) => void>();
  /** How many times each cvar has been given a value different from the one it held. */
  private readonly modifications = new Map<string, number>();
  /** The same, for every cvar at once. */
  private modificationsOfAny = 0;
  private readonly saveListeners = new Set<() => void>();

  constructor(options: CvarsOptions = {}) {
    this.debugMode = options.debugMode ?? DEBUG_MODE;
    this.print = options.print ?? ((text) => console.warn(text.trimEnd()));
    this.values = { ...DEFAULT_SETTINGS };
    for (const key of SETTING_KEYS) {
      const def = SETTINGS[key];
      this.slots.set(key, {
        saved: def.default,
        savedValue: DEFAULT_SETTINGS[key],
        applied: def.default,
        archive: def.archive !== false
      });
    }
  }

  /** The settings in force. Live: a change is announced to {@link onChange}. */
  get settings(): Readonly<Settings> {
    return this.values;
  }

  /**
   * A cvar from `q3config.cfg`, as `exec` sets it at start: saved, and in force unless the query
   * string says otherwise, or it is a cheat while `sv_cheats` is 0. A latched setting takes it too,
   * since this is the start.
   *
   * @param archive - `seta` rather than `set`: the file keeps the cvar from then on. Nothing asks
   *   for the file to be written, as Q3 clears `cvar_modifiedFlags` once its start has run the
   *   file (`common.c:2748`).
   */
  load(name: string, raw: string, archive = false): void {
    const key = settingForCvar(name);
    if (!key) {
      if (this.others.get(name.toLowerCase())?.value !== raw) this.bump(name, raw);
      this.keepOther(name, raw, { user: true });
    } else {
      const slot = this.slot(key);
      if (slot.saved !== raw) this.bump(name, raw);
      slot.saved = raw;
      slot.savedValue = this.read(key, raw, SETTINGS[key].default);
      this.settle(key);
    }
    if (archive) this.archive(name);
  }

  /**
   * The query string's settings, each in force in this tab alone and never saved.
   * Names match without regard to case, as Q3's cvars do. A parameter that is not a setting is
   * left alone, and a cheat setting is refused while `sv_cheats` is 0.
   */
  applyUrl(search: string): void {
    for (const [name, raw] of new URLSearchParams(search)) {
      const key = settingForCvar(name);
      if (!key) continue;
      if (this.isProtected(key)) {
        this.print(`${SETTINGS[key].cvar} is cheat protected.\n`);
        continue;
      }
      const slot = this.slot(key);
      const fallback = slot.savedValue === undefined ? SETTINGS[key].default : slot.saved;
      if (slot.url?.raw !== raw) this.bump(name, raw);
      slot.url = { raw, value: this.read(key, raw, fallback) };
      this.settle(key);
    }
  }

  /** Whether the query string set this one, which the menu marks. */
  fromUrl(key: Key): boolean {
    return this.slot(key).url !== undefined;
  }

  /**
   * The latched settings holding a new value that the start they wait for has not applied yet, as
   * Q3's Graphics page shows its Apply for one (`GraphicsOptions_UpdateMenuItems`,
   * `ui_video.c:567–642`). Each menu asks about its own.
   */
  waiting(): Key[] {
    return SETTING_KEYS.filter((key) => {
      if (!SETTINGS[key].latched || this.isProtected(key)) return false;
      const slot = this.slot(key);
      const value = slot.url ? slot.url.value : slot.savedValue;
      return value !== undefined && !Object.is(value, this.values[key]);
    });
  }

  /**
   * `Cvar_VariableString` (`cvar.c:171–180`): a cvar's value, or `''` for one nothing has set.
   *
   * This is the whole of what the host and the game module ask a cvar store for, beside setting
   * one — which is why they take the store rather than the settings: what the console, the menu
   * and the match read is one set of values, as it is in Quake 3.
   */
  get(name: string): string {
    return this.string(name) ?? '';
  }

  /**
   * `vmCvar_t.modificationCount`, which `trap_Cvar_Update` refreshes: how many times this cvar has
   * been given a value different from the one it had.
   *
   * It counts the value *stored*, not the value in force, so a latched setting counts as changed
   * the moment somebody changes it — which is what `map_restart` reads to know that the map has
   * to be loaded again rather than restarted in place.
   */
  modificationCount(name: string): number {
    return this.modifications.get(this.canonical(name)) ?? 0;
  }

  /** {@link modificationCount} over every cvar: whether anything changed since a reader looked. */
  totalModifications(): number {
    return this.modificationsOfAny;
  }

  /**
   * A cvar's string, as `Cvar_VariableString` gives it: this tab's for a setting the query string
   * set, else the saved one. `undefined` for a cvar nothing has set.
   */
  string(name: string): string | undefined {
    const key = settingForCvar(name);
    if (!key) return this.others.get(name.toLowerCase())?.value;
    const slot = this.slot(key);
    return slot.url?.raw ?? slot.saved;
  }

  /**
   * A cvar's name as it was registered or first made, which is how `Cvar_Command` and `Cvar_Print`
   * name it, or `undefined` for a cvar nothing has made.
   */
  nameOf(name: string): string | undefined {
    const key = settingForCvar(name);
    return key ? SETTINGS[key].cvar : this.others.get(name.toLowerCase())?.name;
  }

  /**
   * `Cvar_Set`: set a cvar from a string, as a bind, the menu or the engine does
   * (`cvar.c:504–600`). A setting takes only a value it can use.
   *
   * @param archive - `seta`: the file keeps the cvar from then on, whatever the set did.
   * @returns Whether the value was taken.
   */
  set(name: string, raw: string, archive = false): boolean {
    return this.assign(name, raw, archive, false);
  }

  /**
   * `Cvar_Set2` unforced, as the console's commands set a cvar (`cvar.c:504–621`). It is
   * {@link set}, but a value the cvar holds already changes nothing and says nothing, even where
   * it would be refused; a latched setting says that it waits; and a cvar made here is the
   * player's own (`CVAR_USER_CREATED`). Each line names the cvar as `name` does. The menu and the
   * engine set without the latch's line, as Q3's menu and code do (`Cvar_SetSafe`,
   * `cvar.c:637–652`).
   *
   * @param archive - `seta`: the file keeps the cvar from then on, whatever the set did.
   * @returns Whether the value was taken.
   */
  setFromConsole(name: string, raw: string, archive = false): boolean {
    return this.assign(name, raw, archive, true);
  }

  /**
   * `Cvar_Print` (`cvar.c:475–497`): a cvar's value, and its default unless it is read only; then
   * the value a reload will take up, where one waits. None of the port's cvars carries a
   * description.
   *
   * @returns Whether there is such a cvar.
   */
  printCvar(name: string): boolean {
    const key = settingForCvar(name);
    if (key) {
      const def = SETTINGS[key];
      const stored = this.string(name)!;
      const current = this.current(key);
      let text = valueLine(def.cvar, current, def.default);
      if (current !== stored) text += `latched: "${stored}"\n`;
      this.print(text);
      return true;
    }
    const other = this.others.get(name.toLowerCase());
    if (!other) return false;
    this.print(valueLine(other.name, other.value, other.server ? undefined : other.reset));
    return true;
  }

  /**
   * `Cvar_List_f` (`cvar.c:953–1021`): each cvar `filter` matches (`Com_Filter`), newest first as
   * Q3's list runs, after its flags in nine columns — `S` serverinfo, `s` systeminfo, `U`
   * userinfo, `R` read only, `I` write protected, `A` archived, `L` latched, `C` cheat, and `?`
   * the player's own — then how many cvars there are, filtered or not. Q3 counts its array's
   * slots too, which is the same number until a cvar is unset.
   */
  listCvars(filter?: string): void {
    const listed = this.listed();
    let text = '';
    for (const { name, value, flags } of listed) {
      if (filter === undefined || comFilter(filter, name)) text += `${flags} ${name} "${value}"\n`;
    }
    this.print(`${text}\n${listed.length} total cvars\n${listed.length} cvar indexes\n`);
  }

  /**
   * `Cvar_Unset` (`cvar.c:1115–1179`): remove a cvar the player made. It then reads as `''`
   * wherever it is read, and a store elsewhere is told so.
   *
   * @returns Whether it was one the player made, and so is gone.
   */
  unset(name: string): boolean {
    const lower = name.toLowerCase();
    const other = this.others.get(lower);
    if (other?.user !== true) return false;
    this.bump(name, '');
    this.others.delete(lower);
    if (other.archive) this.announceSave();
    return true;
  }

  /**
   * `Cvar_Restart` (`cvar.c:1192–1229`), newest first as Q3 goes: every setting set back to its
   * default as the console sets one, but those `cvar_restart` leaves alone, and the cvars the
   * player made removed. A cvar the engine, the game or a server made is left as it is, since the
   * port holds none of Q3's flags for it.
   */
  restart(): void {
    for (const other of [...this.others.values()].reverse()) {
      if (other.user) this.unset(other.name);
    }
    for (const key of [...SETTING_KEYS].reverse()) {
      const def = SETTINGS[key];
      if (def.noRestart !== true) this.setFromConsole(def.cvar, def.default);
    }
  }

  /**
   * `Cvar_Reset` (`cvar.c:700–702`): a cvar back to its default, as the console sets one. A cvar
   * nothing has made stays unmade.
   */
  resetFromConsole(name: string): void {
    const key = settingForCvar(name);
    const reset = key ? SETTINGS[key].default : this.others.get(name.toLowerCase())?.reset;
    if (reset !== undefined) this.setFromConsole(name, reset);
  }

  /**
   * `CL_SystemInfoChanged`'s apply of one key (`cl_parse.c:388–430`): `Cvar_SetSafe`, and the
   * `Cvar_Get` that precedes it for a key the client has never held.
   *
   * A server may set the cvars its systeminfo carries past the client's own record of it
   * ({@link SERVER_CVARS}), and no other the client holds. A key the client has never held
   * becomes the server's own, read-only to everything but the server, as
   * `CVAR_SERVER_CREATED | CVAR_ROM` is in Q3.
   *
   * @returns Whether the value was taken; `false` is Q3's warning.
   */
  setServer(name: string, raw: string): boolean {
    const lower = name.toLowerCase();
    const key = settingForCvar(name);
    if (key) return SERVER_CVARS.has(lower) ? this.set(name, raw) : false;

    const before = this.others.get(lower);
    if (before !== undefined && !before.server && !SERVER_CVARS.has(lower)) return false;
    // A cvar the store already held keeps its flags: a listen server's own stay writable by its
    // console, as Q3's `CVAR_SYSTEMINFO` cvars are (`cvar.c:558–570`).
    this.keepOther(name, raw, { server: before?.server ?? true });
    if (before?.value !== raw) this.bump(name, raw);
    // The systeminfo's `sv_cheats` 0 is `Cvar_SetCheatState`'s call (`cl_parse.c:373–377`).
    if (lower === 'sv_cheats' && atoi(raw) === 0) this.resetCheats();
    return true;
  }

  /**
   * A cvar as a listen server's store elsewhere now holds it, held here the same, so this store
   * holds what Quake 3's one store would after the server or the game set it.
   *
   * That store's rules have taken the value already, so none of this one's refuses it: not a cheat
   * setting's protection, not a server cvar's read-only flag, and a string a setting can't use is
   * held unused without a second warning. Otherwise it is {@link set}'s: the query string's value
   * takes it in this tab alone, a latched setting waits for its start, an archived one wants the
   * file written, and a cvar keeps the flags it has here. One this store has never held is made as
   * the game or the server registered it there: the console's to set, as qagame's rules are though
   * the systeminfo carries them, except `sv_cheats`, which Q3 registers `CVAR_ROM` (`cvar.c:1443`).
   */
  mirror(name: string, raw: string): void {
    const key = settingForCvar(name);
    if (!key) {
      const lower = name.toLowerCase();
      const before = this.others.get(lower);
      this.keepOther(name, raw, { server: before === undefined && lower === 'sv_cheats' });
      if (before?.value !== raw) {
        this.bump(name, raw);
        if (before?.archive === true) this.announceSave();
      }
      if (lower === 'sv_cheats' && atoi(raw) === 0) this.resetCheats();
      return;
    }
    const def = SETTINGS[key];
    const reading = def.read(raw);
    const value = 'value' in reading ? reading.value : undefined;
    const slot = this.slot(key);
    if (slot.url) {
      if (slot.url.raw === raw) return;
      slot.url = { raw, value };
    } else {
      if (slot.saved === raw) return;
      slot.saved = raw;
      slot.savedValue = value;
      if (slot.archive) this.announceSave();
    }
    this.bump(name, raw);
    if (!def.latched) this.settle(key);
  }

  /**
   * `Cvar_SetValue` (`cvar.c:668–676`): a number, written as Q3 writes one, whole or to six
   * places, as the menu's sliders leave `s_volume "0.162500"`.
   */
  setValue(name: string, value: number): boolean {
    return this.set(name, Number.isInteger(value) ? String(value) : value.toFixed(6));
  }

  /**
   * `toggle` (`Cvar_Toggle_f`, `cvar.c:808–842`), as the console sets a cvar: with no values, 1
   * if the cvar reads as 0 and 0 otherwise; with several, the one after the current, or else the
   * first.
   */
  toggle(name: string, values: readonly string[] = []): boolean {
    if (values.length === 0) {
      // `atof`: anything that isn't a number reads as 0.
      const current = Number.parseFloat(this.string(name) ?? '') || 0;
      return this.setFromConsole(name, current === 0 ? '1' : '0');
    }
    if (values.length === 1) {
      this.print('toggle: nothing to toggle to\n');
      return false;
    }
    const current = this.string(name);
    const at = values.slice(0, -1).indexOf(current ?? '');
    return this.setFromConsole(name, values[at + 1]);
  }

  /** A setting back to its default string, as the menu's defaults put one, through {@link set}. */
  reset(name: string): boolean {
    const key = settingForCvar(name);
    if (!key) return false;
    return this.set(name, SETTINGS[key].default);
  }

  /**
   * The archived cvars, as the file has them: each archived setting with its saved string, never
   * this tab's, then the other cvars `seta` kept.
   */
  archived(): ArchivedCvar[] {
    const cvars = SETTING_KEYS.filter((key) => this.slot(key).archive).map((key) => ({
      name: SETTINGS[key].cvar,
      value: this.slot(key).saved
    }));
    for (const other of this.others.values()) {
      if (other.archive) cvars.push({ name: other.name, value: other.value });
    }
    return cvars;
  }

  /**
   * Every cvar this store holds, as {@link get} answers it: the settings in force, then the
   * others. It is what a store elsewhere is given so that it holds the same values — a listen
   * server's program in a worker is handed its page's store this way.
   */
  all(): { name: string; value: string }[] {
    const cvars = SETTING_KEYS.map((key) => ({
      name: SETTINGS[key].cvar,
      value: this.get(SETTINGS[key].cvar)
    }));
    for (const other of this.others.values()) cvars.push({ name: other.name, value: other.value });
    return cvars;
  }

  /**
   * Hear of each setting whose value in force changes.
   *
   * @returns A function that stops it.
   */
  onChange(listener: (key: Key) => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  /**
   * Hear every cvar whose stored value changed, whatever set it — the console's `set`/`seta`, a
   * menu, an `exec`, a systeminfo — with its name and the value it now holds. A listen server
   * whose program is elsewhere is given its own store's changes this way, so that a cvar set on
   * the page reaches the server that reads it, and its store's own come back the same way.
   *
   * @returns A function that stops it.
   */
  onCvarChange(listener: (name: string, value: string) => void): () => void {
    this.cvarChangeListeners.add(listener);
    return () => this.cvarChangeListeners.delete(listener);
  }

  /**
   * Hear that the file's contents changed, so it wants writing, as Q3 marks
   * `cvar_modifiedFlags` (`common.c:2957–2962`).
   *
   * @returns A function that stops it.
   */
  onSave(listener: () => void): () => void {
    this.saveListeners.add(listener);
    return () => this.saveListeners.delete(listener);
  }

  private slot(key: Key): Slot {
    return this.slots.get(key)!;
  }

  /**
   * {@link set} and {@link setFromConsole}: `Cvar_Set2` forced, or not, then `seta`'s flag,
   * whatever the set did (`Cvar_Set_f`, `cvar.c:869–879`).
   */
  private assign(name: string, raw: string, archive: boolean, console: boolean): boolean {
    const taken = this.setString(name, raw, console);
    if (archive && this.archive(name)) this.announceSave();
    return taken;
  }

  /** `Cvar_Set2` forced, or not. */
  private setString(name: string, raw: string, console: boolean): boolean {
    const key = settingForCvar(name);
    if (!key) {
      const lower = name.toLowerCase();
      const before = this.others.get(lower);
      // A cvar the server sent and the client never held is the server's, and read-only
      // (`CVAR_ROM`, `cvar.c:558–564`) — the console's set is what it refuses.
      if (before?.server === true) {
        if (console && before.value === raw) return true;
        this.print(`${name} is read only.\n`);
        return false;
      }
      this.setOther(name, raw, console && before === undefined);
      // A server whose `sv_cheats` is 0 puts every cheat-flagged cvar back to its default, as the
      // client does when a systeminfo says so (`CL_SystemInfoChanged` → `Cvar_SetCheatState`).
      if (lower === 'sv_cheats' && atoi(raw) === 0) this.resetCheats();
      return true;
    }
    const def = SETTINGS[key];
    const slot = this.slot(key);
    // Going back to the string in force calls off a reload's wait, without a word or a check
    // (`cvar.c:540–551`).
    const callingOff = console && def.latched === 'reload' && raw === slot.applied;
    if (console && raw === this.string(name)) return true;
    if (!callingOff && this.isProtected(key)) {
      this.print(`${console ? name : def.cvar} is cheat protected.\n`);
      return false;
    }
    const reading = def.read(raw);
    if (!('value' in reading)) {
      this.print(`${def.cvar} "${raw}" ${reading.problem}; keeping ${this.string(def.cvar)}\n`);
      return false;
    }

    if (slot.url) {
      if (slot.url.raw === raw) return true;
      slot.url = { raw, value: reading.value };
    } else {
      // An unchanged string changes nothing, and marks nothing for writing (`cvar.c:585–600`).
      if (slot.saved === raw) return true;
      slot.saved = raw;
      slot.savedValue = reading.value;
      if (slot.archive) this.announceSave();
    }
    this.bump(name, raw);
    if (!def.latched) this.settle(key);
    else if (console && !callingOff) this.print(`${name} will be changed upon restarting.\n`);
    return true;
  }

  /**
   * A setting's string as `Cvar_Print` and `cvarlist` give it, Q3's `string`: for one a reload
   * takes up, the one in force, and otherwise the one stored.
   */
  private current(key: Key): string {
    const def = SETTINGS[key];
    return def.latched === 'reload' ? this.slot(key).applied : this.string(def.cvar)!;
  }

  /** Every cvar, newest first, as `cvarlist` lists it: the others, then the settings. */
  private listed(): Listed[] {
    const others = [...this.others.values()].reverse().map((other) => {
      const own = { readOnly: other.server, archive: other.archive, user: other.user };
      return { name: other.name, value: other.value, flags: flagColumns(other.name, own) };
    });
    const settings = [...SETTING_KEYS].reverse().map((key) => {
      const def = SETTINGS[key];
      const flags = flagColumns(def.cvar, {
        archive: this.slot(key).archive,
        latched: def.latched !== undefined,
        cheat: def.cheat
      });
      return { name: def.cvar, value: this.current(key), flags };
    });
    return [...others, ...settings];
  }

  /** A cvar's name as the count is kept under: the setting's own spelling, or the name given. */
  private canonical(name: string): string {
    const key = settingForCvar(name);
    return (key ? SETTINGS[key].cvar : name).toLowerCase();
  }

  /** Count a cvar's change, and tell whoever hears every change, by the name as spelled here. */
  private bump(name: string, value: string): void {
    const at = this.canonical(name);
    this.modifications.set(at, (this.modifications.get(at) ?? 0) + 1);
    this.modificationsOfAny++;
    const key = settingForCvar(name);
    const spelled = key ? SETTINGS[key].cvar : (this.others.get(at)?.name ?? name);
    for (const listener of this.cvarChangeListeners) listener(spelled, value);
  }

  private isProtected(key: Key): boolean {
    if (SETTINGS[key].cheat !== true) return false;
    // `sv_cheats` is 1 until a server says otherwise (`cvar.c:1443`), and a DEBUG_MODE build's
    // host always says 1.
    return atoi(this.string('sv_cheats') ?? '1') === 0;
  }

  /**
   * `Cvar_SetCheatState` (`cvar.c:721–741`): every cheat-flagged setting back to its default,
   * dropping this tab's own value for it. The client does this when a systeminfo carries
   * `sv_cheats` 0.
   */
  private resetCheats(): void {
    for (const key of SETTING_KEYS) {
      const def = SETTINGS[key];
      if (def.cheat !== true) continue;
      const raw = def.default;
      const slot = this.slot(key);
      slot.url = undefined;
      if (slot.saved !== raw) {
        slot.saved = raw;
        const reading = def.read(raw);
        slot.savedValue = 'value' in reading ? reading.value : undefined;
        if (slot.archive) this.announceSave();
        this.bump(def.cvar, raw);
      }
      this.settle(key);
    }
  }

  /** A string's value, or `undefined` with a report naming what is used instead. */
  private read(key: Key, raw: string, fallback: string): unknown {
    const reading = SETTINGS[key].read(raw);
    if ('value' in reading) return reading.value;
    this.print(`${SETTINGS[key].cvar} "${raw}" ${reading.problem}; using ${fallback}\n`);
    return undefined;
  }

  /** Put a setting's value in force from its sources, and announce it if it changed. */
  private settle(key: Key): void {
    const slot = this.slot(key);
    const value = this.isProtected(key)
      ? DEFAULT_SETTINGS[key]
      : (slot.url?.value ?? slot.savedValue ?? DEFAULT_SETTINGS[key]);
    slot.applied = this.isProtected(key)
      ? SETTINGS[key].default
      : slot.url && slot.url.value !== undefined
        ? slot.url.raw
        : slot.savedValue !== undefined
          ? slot.saved
          : SETTINGS[key].default;
    if (Object.is(value, this.values[key])) return;
    (this.values as Record<Key, unknown>)[key] = value;
    for (const listener of this.changeListeners) listener(key);
  }

  /**
   * Hold a cvar the port does not use. A flag given is added to those it has; whether the player
   * made it, and its default, are settled when it is first made.
   */
  private keepOther(
    name: string,
    raw: string,
    { server = false, user = false }: Partial<Pick<OtherCvar, OtherFlag>>
  ): void {
    const lower = name.toLowerCase();
    const before = this.others.get(lower);
    this.others.set(lower, {
      name: before?.name ?? name,
      value: raw,
      reset: before?.reset ?? raw,
      archive: before?.archive === true,
      server: server || before?.server === true,
      user: before?.user ?? user
    });
  }

  /** @param user - Whether a cvar made here is the player's own. */
  private setOther(name: string, raw: string, user: boolean): void {
    const before = this.others.get(name.toLowerCase());
    if (before?.value !== raw) this.bump(name, raw);
    this.keepOther(name, raw, { user });
    if (before?.archive === true && before.value !== raw) this.announceSave();
  }

  /**
   * `seta`'s flag (`Cvar_Set_f`, `cvar.c:873–879`): the file keeps the cvar from now on. A setting
   * the query string set is left out, as its value stays in the tab. So is a cvar a server made:
   * the file's line would make it the player's at the next start, and {@link setServer} takes one
   * of the player's only among the systeminfo's own, where Q3's client takes any
   * (`cl_parse.c:411–428`).
   *
   * @returns Whether the flag is new, so the file wants writing.
   */
  private archive(name: string): boolean {
    const key = settingForCvar(name);
    if (key) {
      const slot = this.slot(key);
      if (slot.archive || slot.url) return false;
      slot.archive = true;
      return true;
    }
    const other = this.others.get(name.toLowerCase());
    if (other === undefined || other.archive || other.server) return false;
    other.archive = true;
    return true;
  }

  private announceSave(): void {
    for (const listener of this.saveListeners) listener();
  }
}
