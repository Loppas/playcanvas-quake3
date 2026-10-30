import { describe, expect, it } from 'vitest';

import { configCommands } from '../formats/q3config';
import { GAME_CVARS } from '../sim/game';
import { RULE_CVARS } from '../sim/rules';
import type { HomeFolder } from './home-folder';
import {
  PRESET_DIR,
  SHIPPED_PRESETS,
  listCfgs,
  listPresets,
  readCfg,
  shippedCfg
} from './presets';
import { SETTINGS, settingForCvar } from './registry';

/** A home folder holding these files, by path. */
function home(files: Record<string, string> = {}): HomeFolder {
  return {
    read: async (path) => files[path],
    list: async (dir, extension) =>
      Object.keys(files)
        .filter((path) => dir === '' || path.startsWith(`${dir}/`))
        .map((path) => (dir === '' ? path : path.slice(dir.length + 1)))
        .filter((name) => !name.includes('/') && name.toLowerCase().endsWith(extension)),
    write: async () => false
  };
}

/** What a shipped preset sets, by cvar in lower case. */
function presetValues(name: string): Map<string, string> {
  const text = shippedCfg(`${PRESET_DIR}/${name}.cfg`);
  expect(text, name).toBeDefined();
  const values = new Map<string, string>();
  for (const [command, cvar, ...value] of configCommands(text!)) {
    expect(command, `${name}: ${command}`).toBe('seta');
    values.set(cvar.toLowerCase(), value.join(' '));
  }
  return values;
}

/** A cvar's default as the port registers it: the game module's, or the settings'. */
function registeredDefault(cvar: string): string | undefined {
  const game = GAME_CVARS.find((each) => each.name.toLowerCase() === cvar);
  if (game) return game.default;
  const key = settingForCvar(cvar);
  return key && SETTINGS[key].default;
}

describe('the shipped presets', () => {
  it('are the files in presets, one for each ruleset', () => {
    const files = Object.keys(import.meta.glob('./presets/*.cfg'));
    expect(files.sort()).toEqual(SHIPPED_PRESETS.map((name) => `./presets/${name}.cfg`).sort());
  });

  it('all set the same cvars, so a switch leaves nothing of the last one behind', () => {
    const [first, ...rest] = SHIPPED_PRESETS.map((name) => [...presetValues(name).keys()].sort());
    for (const cvars of rest) expect(cvars).toEqual(first);
  });

  it('each set every rule of play', () => {
    for (const name of SHIPPED_PRESETS) {
      const values = presetValues(name);
      for (const rule of RULE_CVARS) {
        expect(values.has(rule.name.toLowerCase()), `${name}: ${rule.name}`).toBe(true);
      }
    }
  });

  it('set only cvars the port registers', () => {
    for (const name of SHIPPED_PRESETS) {
      for (const cvar of presetValues(name).keys()) {
        expect(registeredDefault(cvar), `${name}: ${cvar}`).toBeDefined();
      }
    }
  });

  it('each write its own name into g_gamepreset', () => {
    for (const name of SHIPPED_PRESETS) {
      expect(presetValues(name).get('g_gamepreset')).toBe(name.toUpperCase());
    }
  });

  it("write the defaults for id's Quake 3", () => {
    for (const [cvar, value] of presetValues('vq3')) {
      if (cvar === 'g_gamepreset') continue;
      expect(value, cvar).toBe(registeredDefault(cvar));
    }
  });

  it('are found whatever case their path is given in', () => {
    expect(shippedCfg('Presets/CPM.cfg')).toBe(shippedCfg('presets/cpm.cfg'));
    expect(shippedCfg('presets/mine.cfg')).toBeUndefined();
  });
});

describe('readCfg', () => {
  it("reads the home folder's copy first, then the port's own", async () => {
    const mine = 'seta g_gamepreset "MINE"\n';
    expect(await readCfg('presets/cpm.cfg', home({ 'presets/cpm.cfg': mine }))).toBe(mine);
    expect(await readCfg('presets/cpm.cfg', home())).toBe(shippedCfg('presets/cpm.cfg'));
    expect(await readCfg('autoexec.cfg', home({ 'autoexec.cfg': 'seta a 1' }))).toBe('seta a 1');
    expect(await readCfg('presets/mine.cfg', home())).toBeUndefined();
  });

  it('takes a backslash for a slash, a run of them for one, and drops a leading one, as the writes do', async () => {
    const files = { 'sub/mine.cfg': 'seta a 1' };
    expect(await readCfg('sub\\mine.cfg', home(files))).toBe('seta a 1');
    expect(await readCfg('/sub//mine.cfg', home(files))).toBe('seta a 1');
    expect(await readCfg('\\presets\\cpm.cfg', home())).toBe(shippedCfg('presets/cpm.cfg'));
  });
});

describe('listCfgs', () => {
  it("lists the home folder's cfgs directly in it, then the port's own by path", async () => {
    const files = { 'autoexec.cfg': '', 'Mine.CFG': '', 'notes.txt': '', 'presets/zeta.cfg': '' };
    const listed = await listCfgs(home(files));
    expect(listed.slice(0, 2)).toEqual(['autoexec.cfg', 'Mine.CFG']);
    const shipped = SHIPPED_PRESETS.map((name) => `${PRESET_DIR}/${name}.cfg`);
    expect(listed.slice(2).sort()).toEqual(shipped.sort());
  });

  it('lists each cfg by a path readCfg reads it by', async () => {
    const files = { 'autoexec.cfg': 'seta a 1', 'presets/cpm.cfg': 'mine' };
    for (const path of await listCfgs(home(files))) {
      expect(await readCfg(path, home(files)), path).toBeDefined();
    }
  });
});

describe('listPresets', () => {
  it("offers the shipped presets in their order, then the home folder's others, sorted", async () => {
    expect(await listPresets(home())).toEqual(['vq3', 'pmc', 'cpm', 'cq3', 'dev']);
    const files = { 'presets/zeta.cfg': '', 'presets/alpha.cfg': '', 'presets/CPM.cfg': '', 'autoexec.cfg': '' };
    expect(await listPresets(home(files))).toEqual(['vq3', 'pmc', 'cpm', 'cq3', 'dev', 'alpha', 'zeta']);
  });
});
