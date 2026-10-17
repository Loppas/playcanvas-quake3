import { atoi } from '../formats/c-scan';
import type { Cvars } from '../settings/cvars';
import { SETTINGS, type Settings } from '../settings/registry';
import type { MenuItem } from './menu';
import { radioButton, slider, spinControl, textField, type WidgetOptions } from './menu-widgets';

/**
 * The widgets bound to settings: each reads its setting as it is in force
 * and writes it at once. A row the tab's address set is marked, and says so under the page.
 * Engine-free.
 */

/** What a row the tab's address set says. */
export const FROM_ADDRESS = "Set by this tab's address, and not saved";

/** `pcq_spawnArmor`'s choices, on both Server Options pages: up to the 200 Q3's armor stops at. */
export const ARMOR_STEPS: readonly number[] = [0, 25, 50, 75, 100, 125, 150, 175, 200];

/** What the grapple row says, on both Server Options pages. */
export const GRAPPLE_STATUS = 'Choose grapple type';

/** The settings that are switches. */
export type Flag = { [Key in keyof Settings]: Settings[Key] extends boolean ? Key : never }[keyof Settings];

/** What a row says: a line, or one read afresh as the row is drawn. */
export type Status = string | (() => string | undefined);

/**
 * A setting's row: marked where the tab's address set it, which it then says.
 *
 * @param status - What it says otherwise.
 */
export function settingOptions(
  cvars: Cvars,
  key: keyof Settings,
  label: string,
  status?: Status
): WidgetOptions {
  const says = typeof status === 'function' ? status : () => status;
  return {
    label,
    marked: () => cvars.fromUrl(key),
    status: () => (cvars.fromUrl(key) ? FROM_ADDRESS : says())
  };
}

/**
 * A switch's radio button, written as `Cvar_SetValue` writes one: 1 or 0. A latched one shows what
 * the next start will take up.
 */
export function settingSwitch(cvars: Cvars, key: Flag, label: string, status?: Status): MenuItem {
  return radioButton({
    ...settingOptions(cvars, key, label, status),
    get: () => (SETTINGS[key].latched ? pending(cvars, key) : cvars.settings[key]),
    set: (on) => cvars.set(SETTINGS[key].cvar, on ? '1' : '0')
  });
}

/** A number's slider. */
export function settingSlider(
  cvars: Cvars,
  key: 'fov' | 'crosshairSize' | 'sensitivity',
  label: string,
  range: { min: number; max: number },
  status?: string
): MenuItem {
  return slider({
    ...settingOptions(cvars, key, label, status),
    ...range,
    get: () => cvars.settings[key],
    set: (value) => cvars.setValue(SETTINGS[key].cvar, value)
  });
}

/**
 * A whole number typed into a field, as q3_ui's Server Options takes its limits: three places,
 * numbers only (`ui_startserver.c:1284–1312`).
 *
 * The field keeps the text being typed, as Q3's keeps its own buffer, and writes the cvar
 * `atoi` of it at every edit. That matters for one case: a cleared field is `""`, which a limit
 * cvar refuses outright — so a field holding the cvar's own string could never be emptied, and
 * a new number could only ever be typed around the old one. Quake 3 reads an empty buffer as 0
 * (`atoi`, then `Com_Clamp( 0, … )`, `ui_startserver.c:738–740, 784–786`), which for a limit is
 * "no limit", so that is what an empty field writes while the screen keeps showing it empty.
 *
 * The cvar is read back whenever anything else has moved it — the console, another page, or the
 * row changing which cvar it is — so the field follows the match.
 *
 * @param cvar - The cvar to write, asked for at each read: the score limit is two of them, and
 *   which one it is follows the game being played.
 */
export function settingNumberField(
  cvars: Cvars,
  options: WidgetOptions & { cvar: () => string; maxchars?: number }
): MenuItem {
  /** What is being typed, and the cvar's string as this field last left it. */
  let draft: string | null = null;
  let mirrored = '';
  const read = (): string => {
    const now = cvars.string(options.cvar()) ?? '';
    if (draft === null || now !== mirrored) {
      draft = now;
      mirrored = now;
    }
    return draft;
  };
  // Three digits, in room for three, as Server Options' limits are (`ui_startserver.c:1290–1312`).
  const maxchars = options.maxchars ?? 3;
  return textField({
    ...options,
    maxchars,
    widthInChars: maxchars,
    numbersOnly: true,
    get: read,
    set: (text) => {
      read();
      draft = text;
      mirrored = String(atoi(text));
      cvars.set(options.cvar(), mirrored);
    }
  });
}

/** A setting whose values are its choices' places from 0: a mode, or a type. */
export function settingChoice(
  cvars: Cvars,
  key: 'speedometer' | 'allowGrapple',
  label: string,
  names: readonly string[],
  status?: string
): MenuItem {
  return spinControl({
    ...settingOptions(cvars, key, label, status),
    names,
    get: () => cvars.settings[key],
    set: (index) => cvars.setValue(SETTINGS[key].cvar, index)
  });
}

/**
 * A setting as `vid_restart` will take it up: its string now, read, or the value in force for a
 * string it can't use. A latched setting's value in force is the one the page started with.
 */
export function pending<Key extends keyof Settings>(cvars: Cvars, key: Key): Settings[Key] {
  const reading = SETTINGS[key].read(cvars.string(SETTINGS[key].cvar) ?? '');
  return 'value' in reading ? reading.value : cvars.settings[key];
}

/** The place of the value nearest `value`. */
export function nearest(values: readonly number[], value: number): number {
  let best = 0;
  values.forEach((candidate, index) => {
    if (Math.abs(candidate - value) < Math.abs(values[best] - value)) best = index;
  });
  return best;
}
