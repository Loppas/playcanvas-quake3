import { DEBUG_MODE } from '../config';
import { atoi } from '../formats/c-scan';
import type { ArchivedCvar } from '../formats/q3config';
import type { CvarStore } from '../net/cvar';
import { SYSTEMINFO_CVARS } from '../sim/rules';
import { DEFAULT_SETTINGS, SETTINGS, SETTING_KEYS, settingForCvar, type Settings } from './registry';

type Key = keyof Settings;

/** The systeminfo's cvars, lowercased: what a server may set in this store and nothing else may. */
const SERVER_CVARS = new Set(SYSTEMINFO_CVARS.map((name) => name.toLowerCase()));

/** One setting's strings: the file's, and this tab's if the query string set it. */
interface Slot {
  /** What `q3config.cfg` holds for it: the file's string, the default's, or the last one set. */
  saved: string;
  /** {@link saved}'s value, or `undefined` for a string it can't use. */
  savedValue: unknown;
  /** The query string's, in force in this tab alone and never saved. */
  url?: { raw: string; value: unknown };
}

/** A cvar the port does not use, kept so the file keeps it. */
interface OtherCvar {
  /** Spelled as it was first given. */
  name: string;
  value: string;
  /** Set by `seta`, so written back (`Cvar_Set_f`, `cvar.c:873–879`). */
  archive: boolean;
  /** Sent by a server and never held here before: `CVAR_SERVER_CREATED | CVAR_ROM`. */
  server?: boolean;
}

export interface CvarsOptions {
  /** `DEBUG_MODE`: a parameter, so a test can turn it off. */
  debugMode?: boolean;
  /** Where a value that can't be used is reported. */
  warn?: (message: string) => void;
}

/**
 * The settings' values, from their three sources, in order: the query string, `q3config.cfg`,
 * then the default.
 *
 * Q3's cvars, cut down to what the port keeps. A setting is archived unless the registry says
 * otherwise: the file has each one with the string it was last set to (`Cvar_WriteVariables`,
 * `cvar.c:916–946`).
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
 * DOM-free.
 */
export class Cvars implements CvarStore {
  readonly debugMode: boolean;
  private readonly warn: (message: string) => void;
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
    this.warn = options.warn ?? console.warn;
    this.values = { ...DEFAULT_SETTINGS };
    for (const key of SETTING_KEYS) {
      this.slots.set(key, { saved: SETTINGS[key].default, savedValue: DEFAULT_SETTINGS[key] });
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
   * @param archive - Whether a cvar the port does not use is written back: `seta` rather than `set`.
   */
  load(name: string, raw: string, archive = true): void {
    const key = settingForCvar(name);
    if (!key) {
      if (this.others.get(name.toLowerCase())?.value !== raw) this.bump(name, raw);
      this.keepOther(name, raw, archive);
      return;
    }
    const slot = this.slot(key);
    if (slot.saved !== raw) this.bump(name, raw);
    slot.saved = raw;
    slot.savedValue = this.read(key, raw, SETTINGS[key].default);
    this.settle(key);
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
        this.warn(`${SETTINGS[key].cvar} is cheat protected.`);
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
   * `Cvar_Set`: set a cvar from a string, as the console, a bind or the menu does
   * (`cvar.c:504–600`). A setting takes only a value it can use.
   *
   * @param archive - `seta`: a cvar the port does not use is then written back.
   * @returns Whether the value was taken.
   */
  set(name: string, raw: string, archive = false): boolean {
    const key = settingForCvar(name);
    if (!key) {
      // A cvar the server sent and the client never held is the server's, and read-only
      // (`CVAR_ROM`, `cvar.c:558–564`) — the console's set is what it refuses.
      if (this.others.get(name.toLowerCase())?.server === true) {
        this.warn(`${name} is read only.`);
        return false;
      }
      this.setOther(name, raw, archive);
      // A server whose `sv_cheats` is 0 puts every cheat-flagged cvar back to its default, as the
      // client does when a systeminfo says so (`CL_SystemInfoChanged` → `Cvar_SetCheatState`).
      if (name.toLowerCase() === 'sv_cheats' && atoi(raw) === 0) this.resetCheats();
      return true;
    }
    const def = SETTINGS[key];
    if (this.isProtected(key)) {
      this.warn(`${def.cvar} is cheat protected.`);
      return false;
    }
    const reading = def.read(raw);
    if (!('value' in reading)) {
      this.warn(`${def.cvar} "${raw}" ${reading.problem}; keeping ${this.string(def.cvar)}`);
      return false;
    }

    const slot = this.slot(key);
    if (slot.url) {
      if (slot.url.raw === raw) return true;
      slot.url = { raw, value: reading.value };
    } else {
      // An unchanged string changes nothing, and marks nothing for writing (`cvar.c:585–600`).
      if (slot.saved === raw) return true;
      slot.saved = raw;
      slot.savedValue = reading.value;
      if (def.archive !== false) this.announceSave();
    }
    this.bump(name, raw);
    if (!def.latched) this.settle(key);
    return true;
  }

  /**
   * `CL_SystemInfoChanged`'s apply of one key (`cl_parse.c:388–430`): `Cvar_SetSafe`, and the
   * `Cvar_Get` that precedes it for a key the client has never held.
   *
   * A server may set the cvars its systeminfo carries — the rules and the two the replay reads
   * beside them ({@link SYSTEMINFO_CVARS}) — and no other the client holds. A key the client has
   * never held becomes the server's own, read-only to everything but the server, as
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
    // A cvar the store already held keeps its flags: a listen server's own rules stay writable by
    // its console, as Q3's `CVAR_SYSTEMINFO` cvars are (`cvar.c:558–570`).
    this.keepOther(name, raw, false, before?.server ?? true);
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
   * the systeminfo would make it: read-only if the systeminfo carries it.
   */
  mirror(name: string, raw: string): void {
    const key = settingForCvar(name);
    if (!key) {
      const lower = name.toLowerCase();
      const before = this.others.get(lower);
      this.keepOther(name, raw, false, before === undefined && SERVER_CVARS.has(lower));
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
      if (def.archive !== false) this.announceSave();
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
   * `toggle` (`Cvar_Toggle_f`, `cvar.c:808–842`): with no values, 1 if the cvar reads as 0 and 0
   * otherwise; with several, the one after the current, or else the first.
   */
  toggle(name: string, values: readonly string[] = []): boolean {
    if (values.length === 0) {
      // `atof`: anything that isn't a number reads as 0.
      const current = Number.parseFloat(this.string(name) ?? '') || 0;
      return this.set(name, current === 0 ? '1' : '0');
    }
    if (values.length === 1) {
      this.warn('toggle: nothing to toggle to');
      return false;
    }
    const current = this.string(name);
    const at = values.slice(0, -1).indexOf(current ?? '');
    return this.set(name, values[at + 1]);
  }

  /** `reset` (`Cvar_Reset`, `cvar.c:700`): back to the default string. */
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
    const cvars = SETTING_KEYS.filter((key) => SETTINGS[key].archive !== false).map((key) => ({
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

  /** A cvar's name as the count is kept under: the setting's own spelling, or the name given. */
  private canonical(name: string): string {
    const key = settingForCvar(name);
    return (key ? SETTINGS[key].cvar : name).toLowerCase();
  }

  /** Count a cvar's change, and tell whoever hears every change. */
  private bump(name: string, value: string): void {
    const at = this.canonical(name);
    this.modifications.set(at, (this.modifications.get(at) ?? 0) + 1);
    this.modificationsOfAny++;
    for (const listener of this.cvarChangeListeners) listener(at, value);
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
        if (def.archive !== false) this.announceSave();
        this.bump(def.cvar, raw);
      }
      this.settle(key);
    }
  }

  /** A string's value, or `undefined` with a report naming what is used instead. */
  private read(key: Key, raw: string, fallback: string): unknown {
    const reading = SETTINGS[key].read(raw);
    if ('value' in reading) return reading.value;
    this.warn(`${SETTINGS[key].cvar} "${raw}" ${reading.problem}; using ${fallback}`);
    return undefined;
  }

  /** Put a setting's value in force from its sources, and announce it if it changed. */
  private settle(key: Key): void {
    const slot = this.slot(key);
    const value = this.isProtected(key)
      ? DEFAULT_SETTINGS[key]
      : (slot.url?.value ?? slot.savedValue ?? DEFAULT_SETTINGS[key]);
    if (Object.is(value, this.values[key])) return;
    (this.values as Record<Key, unknown>)[key] = value;
    for (const listener of this.changeListeners) listener(key);
  }

  private keepOther(name: string, raw: string, archive: boolean, server = false): void {
    const lower = name.toLowerCase();
    const before = this.others.get(lower);
    this.others.set(lower, {
      name: before?.name ?? name,
      value: raw,
      archive: archive || before?.archive === true,
      server: server || before?.server === true
    });
  }

  private setOther(name: string, raw: string, archive: boolean): void {
    const before = this.others.get(name.toLowerCase());
    if (before?.value !== raw) this.bump(name, raw);
    this.keepOther(name, raw, archive);
    const archived = archive || before?.archive === true;
    if (archived && (before?.value !== raw || !before.archive)) this.announceSave();
  }

  private announceSave(): void {
    for (const listener of this.saveListeners) listener();
  }
}
