import { describe, expect, it, vi } from 'vitest';

import { Cvars } from './cvars';
import { DEFAULT_SETTINGS, SETTINGS, SETTING_KEYS } from './registry';

/** The file's string for a cvar. */
const saved = (cvars: Cvars, name: string) => cvars.archived().find((cvar) => cvar.name === name)?.value;

/**
 * A string a setting will take that is not its default, found by trying a few: enough to cover
 * every reader the registry has — flags, whole numbers, ranges, the renderer's and the backend's
 * names and free text — without naming any setting here.
 */
const CANDIDATES = ['2', '1', '0', '25', '110', 'opengl2', 'webgl2', 'Sarge'];

function urlValue(key: (typeof SETTING_KEYS)[number]): string {
  const def = SETTINGS[key];
  const fallback = def.default;
  const base = def.read(fallback);
  for (const raw of CANDIDATES) {
    if (raw === fallback) continue;
    const reading = def.read(raw);
    // A clamped reader takes anything, and the backend's reads anything else as WebGPU, so the
    // value has to differ from the default as well.
    if ('value' in reading && 'value' in base && !Object.is(reading.value, base.value)) return raw;
  }
  throw new Error(`no value for ${def.cvar} that it takes and its default is not`);
}

describe('Cvars: what waits for vid_restart', () => {
  it('lists a latched setting whose new value is not yet in force, and not once it is set back', () => {
    const cvars = new Cvars();
    expect(cvars.waiting()).toEqual([]);
    cvars.set('cl_renderer', 'opengl2');
    expect(cvars.settings.renderer).toBe('opengl1');
    expect(cvars.waiting()).toEqual(['renderer']);
    cvars.set('cl_renderer', 'opengl1');
    expect(cvars.waiting()).toEqual([]);
  });

  it("counts a change to what the tab's address set, and one without DEBUG_MODE", () => {
    const cvars = new Cvars();
    cvars.applyUrl('?r_overBrightBits=2');
    expect(cvars.waiting()).toEqual([]);
    cvars.set('r_overBrightBits', '0');
    expect(cvars.waiting()).toEqual(['overBrightBits']);

    const plain = new Cvars({ debugMode: false, warn: () => {} });
    plain.set('r_glDriver', 'webgl2');
    expect(plain.waiting()).toEqual(['glDriver']);
  });
});

describe('Cvars: the count a map load reads', () => {
  it('counts a cvar given a value it did not hold, and not one set to the same string', () => {
    // `vmCvar_t.modificationCount` (`cvar.c:427–434`): the game module keeps the count it last
    // saw and acts when it has moved, so setting a cvar to what it already holds must leave it.
    const cvars = new Cvars();
    expect(cvars.modificationCount('fraglimit')).toBe(0);
    cvars.set('fraglimit', '10');
    expect(cvars.modificationCount('fraglimit')).toBe(1);
    cvars.set('fraglimit', '10');
    expect(cvars.modificationCount('fraglimit')).toBe(1);
    cvars.set('fraglimit', '15');
    // By the name the registry spells it with, whatever case it was asked for in.
    expect(cvars.modificationCount('FRAGLIMIT')).toBe(2);
  });

  it('counts a latched cvar where it is stored, not where it is in force', () => {
    // This is what `map_restart` reads to know the map has to be loaded again rather than
    // restarted in place: the value stored has changed while the match still runs the old
    // one, and a count that waited for the new one to take would never say so.
    const cvars = new Cvars();
    cvars.set('g_gametype', '3');
    expect(cvars.settings.gametype).toBe(DEFAULT_SETTINGS.gametype);
    expect(cvars.modificationCount('g_gametype')).toBe(1);
  });

  it('counts what the file and the address set, which the match has never been told about', () => {
    // `exec q3config.cfg` and the query string both set cvars before a match is built, so a
    // count that only moved for the console would miss everything the port started with.
    const fromFile = new Cvars();
    fromFile.load('g_gametype', '3');
    expect(fromFile.modificationCount('g_gametype')).toBe(1);

    const fromUrl = new Cvars();
    fromUrl.applyUrl('?g_gametype=3');
    expect(fromUrl.modificationCount('g_gametype')).toBe(1);

    // A cvar the port does not use too: a listen server's store elsewhere takes the page's
    // changes this way, and the game reads `g_password` and its rules by their counts.
    fromFile.load('g_password', 'secret');
    fromFile.load('g_password', 'secret');
    expect(fromFile.modificationCount('g_password')).toBe(1);
  });

  it('counts every cvar given a new value in one total, which a reader asks before a name', () => {
    // `cvar_modifiedFlags`, which any changing write sets: a frame that finds it clear asks
    // after no cvar by name.
    const cvars = new Cvars();
    const start = cvars.totalModifications();
    cvars.set('fraglimit', '10');
    cvars.set('fraglimit', '10');
    cvars.set('my_own_cvar', 'x');
    expect(cvars.totalModifications()).toBe(start + 2);

    cvars.load('g_gametype', '3');
    cvars.applyUrl('?timelimit=5');
    expect(cvars.totalModifications()).toBe(start + 4);
  });
});

describe('Cvars: where a value comes from', () => {
  it('starts at the defaults', () => {
    expect(new Cvars().settings).toEqual(DEFAULT_SETTINGS);
  });

  it('takes the query string over the file, and the file over the default', () => {
    const cvars = new Cvars();
    cvars.load('cg_fov', '100');
    cvars.load('cg_drawFPS', '1');
    cvars.applyUrl('?cg_fov=110&cg_crosshairSize=32');
    expect(cvars.settings).toMatchObject({ fov: 110, drawFPS: true, crosshairSize: 32 });
    expect(cvars.fromUrl('fov')).toBe(true);
    expect(cvars.fromUrl('drawFPS')).toBe(false);
  });

  it('never saves the query string', () => {
    const cvars = new Cvars();
    cvars.load('cg_fov', '100');
    cvars.applyUrl('?cg_fov=110&cg_drawFPS=1');
    expect(saved(cvars, 'cg_fov')).toBe('100');
    expect(saved(cvars, 'cg_drawFPS')).toBe('0');
  });

  it('matches names in any case, and writes them as the registry spells them', () => {
    const cvars = new Cvars();
    cvars.load('CG_FOV', '100');
    cvars.applyUrl('?CG_THIRDPERSON=1&G_ALLOWGRAPPLE=2');
    expect(cvars.settings).toMatchObject({ fov: 100, thirdPerson: true, allowGrapple: 2 });
    expect(saved(cvars, 'cg_fov')).toBe('100');
  });

  it("falls back from a query string it can't use to the saved value, and says so", () => {
    const warn = vi.fn();
    const cvars = new Cvars({ warn });
    cvars.load('r_overBrightBits', '0');
    cvars.applyUrl('?r_overBrightBits=lots&g_allowGrapple=4');
    expect(cvars.settings).toMatchObject({ overBrightBits: 0, allowGrapple: 1 });
    expect(warn.mock.calls.map(([message]) => message)).toEqual([
      'r_overBrightBits "lots" is not a whole number; using 0',
      'g_allowGrapple "4" is not 0, 1, 2 or 3; using 1'
    ]);
  });

  it("falls back from a saved value it can't use to the default, and keeps the string, as Q3 does", () => {
    const warn = vi.fn();
    const cvars = new Cvars({ warn });
    cvars.load('cg_draw2D', 'yes');
    expect(cvars.settings.draw2D).toBe(true);
    expect(warn).toHaveBeenCalledWith('cg_draw2D "yes" is not a whole number; using 1');
    expect(saved(cvars, 'cg_draw2D')).toBe('yes');
  });

  it('ignores parameters that are not settings', () => {
    const cvars = new Cvars();
    cvars.applyUrl('?map=garage&debug=1');
    expect(cvars.settings).toEqual(DEFAULT_SETTINGS);
  });
});

describe('Cvars: setting a value', () => {
  it('saves a new value, puts it in force, and announces both', () => {
    const cvars = new Cvars();
    const changed = vi.fn();
    const save = vi.fn();
    cvars.onChange(changed);
    cvars.onSave(save);

    expect(cvars.set('cg_fov', '100')).toBe(true);
    expect(cvars.settings.fov).toBe(100);
    expect(saved(cvars, 'cg_fov')).toBe('100');
    expect(changed).toHaveBeenCalledWith('fov');
    expect(save).toHaveBeenCalledOnce();

    // The same string again changes nothing.
    cvars.set('cg_fov', '100');
    expect(save).toHaveBeenCalledOnce();
  });

  it("refuses a value it can't use, and keeps the one it has", () => {
    const warn = vi.fn();
    const cvars = new Cvars({ warn });
    const save = vi.fn();
    cvars.onSave(save);
    expect(cvars.set('cg_speedometer', '9')).toBe(false);
    expect(cvars.settings.speedometer).toBe(0);
    expect(warn).toHaveBeenCalledWith('cg_speedometer "9" is not 0, 1, 2 or 3; keeping 0');
    expect(save).not.toHaveBeenCalled();
  });

  it('keeps a change to a setting the query string set in its own tab', () => {
    const cvars = new Cvars();
    const save = vi.fn();
    cvars.onSave(save);
    cvars.applyUrl('?cg_fov=110');
    cvars.set('cg_fov', '120');
    expect(cvars.settings.fov).toBe(120);
    expect(saved(cvars, 'cg_fov')).toBe('89.2');
    expect(save).not.toHaveBeenCalled();
  });

  it('writes a number as Cvar_SetValue writes it: whole, or to six places', () => {
    const cvars = new Cvars();
    cvars.setValue('s_volume', 0.1625);
    cvars.setValue('cg_fov', 90);
    expect(saved(cvars, 's_volume')).toBe('0.162500');
    expect(saved(cvars, 'cg_fov')).toBe('90');
    expect(cvars.settings).toMatchObject({ volume: 0.1625, fov: 90 });
  });

  it('toggles between 0 and 1, or through a list, as Cvar_Toggle_f does', () => {
    const cvars = new Cvars();
    cvars.toggle('cg_thirdPerson');
    expect(cvars.settings.thirdPerson).toBe(true);
    cvars.toggle('cg_thirdPerson');
    expect(cvars.settings.thirdPerson).toBe(false);

    // From 3, which is in the list only in its last place, it goes back to the first.
    const modes = ['0', '1', '3'];
    cvars.toggle('cg_speedometer', modes);
    expect(cvars.settings.speedometer).toBe(1);
    cvars.toggle('cg_speedometer', modes);
    expect(cvars.settings.speedometer).toBe(3);
    cvars.toggle('cg_speedometer', modes);
    expect(cvars.settings.speedometer).toBe(0);
  });

  it('resets a setting to its default string', () => {
    const cvars = new Cvars();
    cvars.set('m_pitch', '-0.022');
    cvars.reset('m_pitch');
    expect(saved(cvars, 'm_pitch')).toBe('0.022');
    expect(cvars.settings.mPitch).toBe(0.022);
  });

  it('saves a latched setting at once, and puts it in force at the next start', () => {
    const cvars = new Cvars();
    const changed = vi.fn();
    cvars.onChange(changed);
    cvars.set('cl_renderer', 'opengl2');
    expect(saved(cvars, 'cl_renderer')).toBe('opengl2');
    expect(cvars.settings.renderer).toBe('opengl1');
    expect(changed).not.toHaveBeenCalled();

    const next = new Cvars();
    next.load('cl_renderer', saved(cvars, 'cl_renderer')!);
    expect(next.settings.renderer).toBe('opengl2');
  });

  it('keeps and writes back a cvar the port does not use, if seta set it', () => {
    const cvars = new Cvars();
    const save = vi.fn();
    cvars.onSave(save);
    cvars.load('cg_crosshairRGB', '1 1 1 1');
    cvars.load('cg_scratch', '5', false);
    cvars.set('xp_physics', '432', true);
    expect(cvars.string('CG_CROSSHAIRRGB')).toBe('1 1 1 1');
    expect(cvars.archived().slice(-2)).toEqual([
      { name: 'cg_crosshairRGB', value: '1 1 1 1' },
      { name: 'xp_physics', value: '432' }
    ]);
    expect(save).toHaveBeenCalledOnce();
  });

  it('keeps g_gametype and sv_maxclients out of the file, taking an old line once, as Q3 archives neither', () => {
    const cvars = new Cvars();
    const save = vi.fn();
    cvars.onSave(save);
    cvars.load('g_gametype', '3');
    cvars.load('sv_maxclients', '12');
    expect([cvars.settings.gametype, cvars.settings.maxClients]).toEqual([3, 12]);
    cvars.set('g_gametype', '4');
    cvars.set('sv_maxclients', '6');
    expect(save).not.toHaveBeenCalled();
    expect([cvars.string('g_gametype'), cvars.string('sv_maxclients')]).toEqual(['4', '6']);
    expect(saved(cvars, 'g_gametype')).toBeUndefined();
    expect(saved(cvars, 'sv_maxclients')).toBeUndefined();
    cvars.set('fraglimit', '10');
    expect(save).toHaveBeenCalledOnce();
  });

  it('stops announcing once a listener is let go', () => {
    const cvars = new Cvars();
    const changed = vi.fn();
    cvars.onChange(changed)();
    cvars.set('cg_fov', '100');
    expect(changed).not.toHaveBeenCalled();
  });
});

describe('Cvars with a server whose sv_cheats is 0', () => {
  it('puts every cheat setting at its default, whatever the file or the query string says', () => {
    const warn = vi.fn();
    const cvars = new Cvars({ debugMode: true, warn });
    cvars.set('sv_cheats', '0');
    cvars.load('pcq_god', '1');
    cvars.load('cg_thirdPerson', '1');
    cvars.applyUrl('?pcq_drawCollision=1');
    expect(cvars.settings).toEqual(DEFAULT_SETTINGS);
    expect(warn).toHaveBeenCalledWith('pcq_drawCollision is cheat protected.');
  });

  it("takes every setting there is from the tab's address, the cheat ones included", () => {
    // The address is the port's `+set`: anything the registry has can be set for one tab, from
    // the game the match plays to the renderer's own. This sweeps the registry rather than
    // naming settings, so a new one is covered the day it is added. `sv_cheats` is 1 until a
    // server says otherwise, so the cheat-flagged ones are open.
    const warn = vi.fn();
    const cvars = new Cvars({ debugMode: true, warn });
    const search = SETTING_KEYS.map((key) => `${SETTINGS[key].cvar}=${urlValue(key)}`).join('&');

    cvars.applyUrl(`?${search}`);

    for (const key of SETTING_KEYS) {
      const { cvar } = SETTINGS[key];
      const reading = SETTINGS[key].read(urlValue(key));
      expect(cvars.string(cvar), cvar).toBe(urlValue(key));
      expect(cvars.fromUrl(key), cvar).toBe(true);
      // In force at once, latched or not: the address is read before the game is built.
      expect(cvars.settings[key], cvar).toEqual('value' in reading ? reading.value : undefined);
    }
    expect(warn).not.toHaveBeenCalled();
    // And none of it reaches `q3config.cfg`, which is what makes a tab safe to test in: the
    // file still holds every default.
    for (const key of SETTING_KEYS) {
      const { cvar, archive } = SETTINGS[key];
      expect(saved(cvars, cvar), cvar).toBe(archive === false ? undefined : SETTINGS[key].default);
    }
  });

  it('refuses a new cheat value, as Q3 refuses a `CVAR_CHEAT` without `sv_cheats`', () => {
    const warn = vi.fn();
    const cvars = new Cvars({ debugMode: true, warn });
    cvars.set('sv_cheats', '0');
    expect(cvars.toggle('pcq_drawCollision')).toBe(false);
    expect(cvars.settings.drawCollision).toBe(false);
    // The packet delays are Q3's `CVAR_CHEAT` too (`common.c:2775–2776`).
    expect(cvars.set('cl_packetdelay', '100')).toBe(false);
    expect(cvars.get('cl_packetdelay')).toBe('0');
    expect(warn).toHaveBeenCalledWith('pcq_drawCollision is cheat protected.');
  });

  it("writes the reset's defaults back to the file, as `Cvar_SetCheatState` does", () => {
    const cvars = new Cvars({ debugMode: true });
    cvars.load('pcq_god', '1');
    cvars.load('cg_thirdPerson', '1');
    expect(saved(cvars, 'pcq_god')).toBe('1');

    cvars.set('sv_cheats', '0');
    expect(saved(cvars, 'pcq_god')).toBe('0');
    expect(saved(cvars, 'cg_thirdPerson')).toBe('0');
  });

  it("still takes the settings that are not cheat ones, Graphics' among them", () => {
    const cvars = new Cvars({ debugMode: true });
    cvars.set('sv_cheats', '0');
    cvars.load('cg_fov', '100');
    cvars.load('cl_renderer', 'opengl2');
    cvars.applyUrl('?cg_speedometer=2&r_glDriver=webgl2');
    expect(cvars.settings).toMatchObject({ fov: 100, speedometer: 2, renderer: 'opengl2', glDriver: 'webgl2' });
  });
});

describe("Cvars: what a server's systeminfo may set", () => {
  it("takes the systeminfo's cvars, a listen server's own among them", () => {
    const warn = vi.fn();
    const cvars = new Cvars({ debugMode: true, warn });
    // A listen server's game module has registered its rules in the one store already.
    cvars.set('pmove_JumpVelocity', '270');

    expect(cvars.setServer('pmove_JumpVelocity', '300')).toBe(true);
    expect(cvars.get('pmove_JumpVelocity')).toBe('300');
    // The server's own cvar stays the console's to set, as Q3's `CVAR_SYSTEMINFO` ones are.
    expect(cvars.set('pmove_JumpVelocity', '310')).toBe(true);
    // The grapple style is a setting the server sends, and it is taken too.
    expect(cvars.setServer('g_allowGrapple', '3')).toBe(true);
    expect(cvars.get('g_allowGrapple')).toBe('3');
    expect(warn).not.toHaveBeenCalled();
  });

  it("refuses a cvar that is the client's own", () => {
    const cvars = new Cvars({ debugMode: true, warn: () => {} });
    cvars.load('name', 'Sarge');

    expect(cvars.setServer('name', 'Grunt')).toBe(false);
    expect(cvars.get('name')).toBe('Sarge');
    // A cvar the client has and the server has never sent is refused too.
    cvars.set('my_cvar', 'mine');
    expect(cvars.setServer('my_cvar', 'theirs')).toBe(false);
    expect(cvars.get('my_cvar')).toBe('mine');
  });

  it('creates a key it has never held read-only, and the server may change it after', () => {
    const warn = vi.fn();
    const cvars = new Cvars({ debugMode: true, warn });

    expect(cvars.setServer('sv_customRule', '1')).toBe(true);
    expect(cvars.get('sv_customRule')).toBe('1');
    // `CVAR_ROM`: the console may not set it, and says Q3's words.
    expect(cvars.set('sv_customRule', '2')).toBe(false);
    expect(cvars.get('sv_customRule')).toBe('1');
    expect(warn).toHaveBeenCalledWith('sv_customRule is read only.');
    // The server's own update is `Cvar_SetSafe`, which the read-only flag does not stop.
    expect(cvars.setServer('sv_customRule', '3')).toBe(true);
    expect(cvars.get('sv_customRule')).toBe('3');
  });

  it("leaves a listen server's frame and move step the console's to set after a systeminfo", () => {
    const warn = vi.fn();
    const cvars = new Cvars({ debugMode: true, warn });
    expect(cvars.setServer('sv_fps', '125')).toBe(true);
    expect(cvars.setServer('pmove_msec', '8')).toBe(true);

    expect(cvars.set('sv_fps', '60')).toBe(true);
    expect(cvars.set('pmove_msec', '16')).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    // A server elsewhere sets them as any systeminfo does, and they stay so after it, as in Q3's
    // one store.
    expect(cvars.setServer('sv_fps', '20')).toBe(true);
    expect(cvars.get('sv_fps')).toBe('20');
  });

  it("resets the cheat settings when the systeminfo's sv_cheats is 0", () => {
    const cvars = new Cvars({ debugMode: true });
    cvars.load('pcq_god', '1');
    expect(cvars.settings.god).toBe(true);

    expect(cvars.setServer('sv_cheats', '0')).toBe(true);

    expect(cvars.settings.god).toBe(false);
    expect(cvars.get('sv_cheats')).toBe('0');
  });
});

describe('Cvars: what a store elsewhere is given', () => {
  it('lists every cvar it holds, as `get` answers it: the settings, then the others', () => {
    const cvars = new Cvars({ debugMode: true, warn: () => {} });
    cvars.set('fraglimit', '10');
    cvars.set('s_volume', '0.500000');
    // A cvar that is no setting of the port's: the host's own pause flag.
    cvars.set('sv_paused', '1');

    const byName = new Map(cvars.all().map(({ name, value }) => [name, value]));
    expect(byName.get('s_volume')).toBe('0.500000');
    expect(byName.get('fraglimit')).toBe('10');
    expect(byName.get('sv_paused')).toBe('1');
    // Every setting is in it, a cvar nothing set at the default string `get` gives it.
    for (const key of SETTING_KEYS) {
      expect(byName.get(SETTINGS[key].cvar)).toBe(cvars.get(SETTINGS[key].cvar));
    }
  });

  it('tells every cvar whose value changed, whoever set it, and only when it did', () => {
    const cvars = new Cvars({ debugMode: true, warn: () => {} });
    const heard: [string, string][] = [];
    const stop = cvars.onCvarChange((name, value) => heard.push([name, value]));

    // The console's `set`, a menu's, an `exec`'s `load`, a server's, a reset: all of them.
    cvars.set('fraglimit', '10');
    expect(heard.at(-1)).toEqual(['fraglimit', '10']);
    cvars.load('s_volume', '0.500000');
    expect(heard.at(-1)).toEqual(['s_volume', '0.500000']);
    cvars.setServer('sv_cheats', '0');
    expect(heard.at(-1)).toEqual(['sv_cheats', '0']);
    const count = heard.length;
    cvars.reset('fraglimit');
    expect(heard).toHaveLength(count + 1);
    expect(heard.at(-1)).toEqual(['fraglimit', cvars.get('fraglimit')]);

    // Setting a cvar to what it already holds is not a change.
    cvars.set('fraglimit', cvars.get('fraglimit'));
    expect(heard).toHaveLength(count + 1);

    stop();
    cvars.set('fraglimit', '25');
    expect(heard).toHaveLength(count + 1);
  });
});

describe("Cvars: what a listen server's store elsewhere set", () => {
  it('holds a cvar as it is held there, with the spelling and the archive it has here', () => {
    const cvars = new Cvars({ debugMode: true, warn: () => {} });
    cvars.set('g_localTeamPref', 'red');
    cvars.set('My_Cvar', 'a', true);
    const saves = vi.fn();
    cvars.onSave(saves);
    const heard: [string, string][] = [];
    cvars.onCvarChange((name, value) => heard.push([name, value]));
    const count = cvars.modificationCount('g_localTeamPref');

    // The game spends the Start Server's side as it reads it, in the store the page holds too.
    cvars.mirror('g_localteampref', '');
    expect(cvars.get('g_localTeamPref')).toBe('');
    expect(cvars.modificationCount('g_localTeamPref')).toBe(count + 1);
    expect(heard).toEqual([['g_localteampref', '']]);
    expect(saves).not.toHaveBeenCalled();

    // A cvar `seta` archived here is written back with its new value.
    cvars.mirror('my_cvar', 'b');
    expect(cvars.archived()).toContainEqual({ name: 'My_Cvar', value: 'b' });
    expect(saves).toHaveBeenCalledTimes(1);

    // The string it already holds is no change.
    cvars.mirror('my_cvar', 'b');
    expect(heard).toHaveLength(2);
  });

  it('makes one it never held as the systeminfo would, read-only if the systeminfo has it', () => {
    const warn = vi.fn();
    const cvars = new Cvars({ debugMode: true, warn });

    cvars.mirror('sv_cheats', '1');
    expect(cvars.set('sv_cheats', '0')).toBe(false);
    expect(warn).toHaveBeenCalledWith('sv_cheats is read only.');
    // The server's own writes still reach it, by its systeminfo or its store.
    expect(cvars.setServer('sv_cheats', '1')).toBe(true);
    cvars.mirror('sv_cheats', '0');
    expect(cvars.get('sv_cheats')).toBe('0');

    // One the systeminfo never carries stays the console's, as `nextmap` is an operator's.
    cvars.mirror('nextmap', 'map_restart 0');
    expect(cvars.set('nextmap', 'map q3dm7')).toBe(true);
    expect(cvars.archived().some(({ name }) => name === 'nextmap')).toBe(false);

    // One this store held first keeps the flags it had.
    const held = new Cvars({ debugMode: true, warn: () => {} });
    held.set('sv_cheats', '1');
    held.mirror('sv_cheats', '0');
    expect(held.set('sv_cheats', '1')).toBe(true);
  });

  it("resets the cheats on the server's sv_cheats 0, and refuses none of its resets", () => {
    const warn = vi.fn();
    const cvars = new Cvars({ debugMode: true, warn });
    cvars.load('pcq_god', '1');

    cvars.mirror('sv_cheats', '0');
    expect(cvars.settings.god).toBe(false);
    // The server's store resets its own next, and they arrive as no change here.
    cvars.mirror('pcq_god', '0');
    // A value that store holds is held here even while protected, at its default in force.
    cvars.mirror('cg_thirdPerson', '1');
    expect(cvars.get('cg_thirdPerson')).toBe('1');
    expect(cvars.settings.thirdPerson).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it("keeps a setting the tab's address set in the tab, and a latched one for its start", () => {
    const cvars = new Cvars({ debugMode: true, warn: () => {} });
    cvars.applyUrl('?fraglimit=5');
    const saves = vi.fn();
    cvars.onSave(saves);

    cvars.mirror('fraglimit', '10');
    expect(cvars.get('fraglimit')).toBe('10');
    expect(cvars.settings.fragLimit).toBe(10);
    expect(saved(cvars, 'fraglimit')).toBe(SETTINGS.fragLimit.default);
    expect(saves).not.toHaveBeenCalled();

    // Without the address, an archived setting's new value is the file's, once, and counted once
    // for the readers here that go by the count.
    const count = cvars.modificationCount('timelimit');
    cvars.mirror('timelimit', '15');
    cvars.mirror('timelimit', '15');
    expect(saved(cvars, 'timelimit')).toBe('15');
    expect(saves).toHaveBeenCalledTimes(1);
    expect(cvars.modificationCount('timelimit')).toBe(count + 1);

    cvars.mirror('sv_maxclients', '4');
    expect(cvars.get('sv_maxclients')).toBe('4');
    expect(cvars.settings.maxClients).toBe(DEFAULT_SETTINGS.maxClients);
  });

  it("holds a string a setting can't use, unused, without a second warning", () => {
    const warn = vi.fn();
    const cvars = new Cvars({ debugMode: true, warn });
    cvars.mirror('fraglimit', 'lots');
    expect(cvars.get('fraglimit')).toBe('lots');
    expect(cvars.settings.fragLimit).toBe(DEFAULT_SETTINGS.fragLimit);
    expect(warn).not.toHaveBeenCalled();
  });
});
