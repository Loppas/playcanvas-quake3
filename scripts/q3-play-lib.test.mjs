import { describe, expect, it } from 'vitest';

import {
  KEYS,
  PLAY_CASES,
  PLAY_SCRIPT,
  caseCommands,
  casePaks,
  demoName,
  playArguments,
  playScript,
  readPlayLog,
  startSnapshot
} from './q3-play-lib.mjs';

/** A short case: settle, walk, a jump on the walk, then stand. */
const CASE = {
  name: 'test-walk',
  map: 'q3dm1',
  at: [216, 1328, 24, 270],
  phases: [
    { mark: 'settle', frames: 2, keys: [] },
    { mark: 'walk', frames: 2, keys: ['forward'] },
    { mark: 'jump', frames: 1, keys: ['forward', 'jump'] },
    { mark: 'stop', frames: 2, keys: [] }
  ]
};

describe("Quake 3's side", () => {
  /** A command line's `+set`s, by name. */
  const sets = (args) =>
    Object.fromEntries(
      args.flatMap((arg, i) => (arg === '+set' ? [[args[i + 1], args[i + 2]]] : []))
    );

  it("starts safe, moves on the port's tick with a snapshot each, and runs its script", () => {
    const args = playArguments({ basepath: 'C:/clean', homepath: 'C:/home' });
    expect(args[0]).toBe('+safe');
    expect(sets(args)).toMatchObject({
      fs_basepath: 'C:/clean',
      fs_homepath: 'C:/home',
      r_fullscreen: '0',
      pmove_fixed: '1',
      pmove_msec: '8',
      sv_fps: '125',
      snaps: '125',
      com_maxfps: '125',
      in_mouse: '0',
      cl_run: '1',
      logfile: '2'
    });
    expect(args.slice(-2)).toEqual(['+exec', PLAY_SCRIPT]);
  });

  it('records each case from before setviewpos, a tick a frame, its marks echoed', () => {
    const lines = playScript([CASE]).split('\n');
    const at = (line) => lines.indexOf(line);
    expect(lines.slice(at('devmap q3dm1'), at('devmap q3dm1') + 2)).toEqual([
      'devmap q3dm1',
      expect.stringMatching(/^wait \d+$/)
    ]);
    // Cheats are on once `devmap` has the map, and then the case is marked and recorded.
    expect(at('fixedtime 8')).toBeGreaterThan(at('devmap q3dm1'));
    expect(at('cg_showmiss 2')).toBeLessThan(at('echo pcq-case test-walk'));
    expect(at('echo pcq-case test-walk')).toBeLessThan(at(`record ${demoName('test-walk')}`));
    expect(at('echo pcq-mark start')).toBeLessThan(at('setviewpos 216 1328 24 270'));
    expect(at('echo pcq-mark end')).toBeLessThan(at('stoprecord'));
    expect(lines.at(-2)).toBe('quit');
    // The health at the max, recorded, before the case starts.
    expect(at('give health')).toBeGreaterThan(at(`record ${demoName('test-walk')}`));
    expect(at('give health')).toBeLessThan(at('echo pcq-mark start'));
  });

  it("runs each case's server at its own frame rate, or at the port's tick", () => {
    const slowed = { ...CASE, name: 'slow', svFps: 20 };
    const lines = playScript([CASE, slowed]).split('\n');
    const maps = lines.flatMap((line, i) => (line === 'devmap q3dm1' ? [lines[i - 1]] : []));
    expect(maps).toEqual(['sv_fps 125', 'sv_fps 20']);
    // Lava's case at Quake 3's own frame rate, whose frames it burns on.
    expect(PLAY_CASES.find(({ name }) => name === 'q3dm7-lava')?.svFps).toBe(20);
  });

  it('presses each held key again every frame, waits out idle frames, and lets go', () => {
    const lines = playScript([CASE]).split('\n');
    const phase = (mark, next) =>
      lines.slice(
        lines.indexOf(`echo pcq-mark ${mark}`) + 1,
        lines.indexOf(`echo pcq-mark ${next}`)
      );

    expect(lines).toContain('set pcqKeys_forward "-forward;+forward;wait 2"');
    expect(lines).toContain('set pcqKeys_forward_jump "-forward;+forward;-moveup;+moveup;wait 2"');
    expect(phase('settle', 'walk')).toEqual(['wait 4']);
    expect(phase('walk', 'jump')).toEqual(['vstr pcqKeys_forward', 'vstr pcqKeys_forward']);
    expect(phase('jump', 'stop')).toEqual(['vstr pcqKeys_forward_jump']);
    expect(phase('stop', 'end')).toEqual(['-forward', '-moveup', 'wait 4']);
  });

  it('lets go of what the last phase held before the end', () => {
    const held = { ...CASE, phases: [{ mark: 'walk', frames: 1, keys: ['back'] }] };
    const lines = playScript([held]).split('\n');
    expect(lines.indexOf('-back')).toBeLessThan(lines.indexOf('echo pcq-mark end'));
    expect(lines.indexOf('-back')).toBeGreaterThan(lines.indexOf('vstr pcqKeys_back'));
  });

  it("names every case's keys among Quake 3's buttons", () => {
    for (const { phases } of PLAY_CASES) {
      for (const { keys } of phases) for (const key of keys) expect(KEYS[key]).toBeDefined();
    }
    expect(new Set(PLAY_CASES.map(({ name }) => name)).size).toBe(PLAY_CASES.length);
  });

  it("gathers the cases' map paks, each once, and none for the retail maps", () => {
    const slick = { ...CASE, name: 'b', paks: ['map_cpm18.pk3'] };
    expect(casePaks([CASE, slick, { ...slick, name: 'c' }])).toEqual(['map_cpm18.pk3']);
    expect(casePaks([CASE])).toEqual([]);
  });
});

describe('the log', () => {
  /** A log as `cg_showmiss 2` and the script's echoes leave it, one line run into the next. */
  const LOG = [
    'pcq-case test-walk',
    '[96 : 90] [104 : 98] pcq-mark start',
    'pcq-mark settle',
    '[112 : 106] [120 : 114] pcq-mark walk',
    '[128 : 122] [136 : 130] pcq-mark jump',
    '[144 : 138] pcq-mark stop',
    '[152 : 146] [160 : 154] pcq-mark end',
    '[168 : 162] ',
    'pcq-case other',
    '[8 : 2] '
  ].join('\n');

  it("reads each case's command times, and where each mark fell among them", () => {
    const runs = readPlayLog(`[0 : 0] before\n${LOG}`);
    expect([...runs.keys()]).toEqual(['test-walk', 'other']);
    expect(runs.get('test-walk')).toEqual({
      times: [96, 104, 112, 120, 128, 136, 144, 152, 160, 168],
      marks: [
        { mark: 'start', at: 2 },
        { mark: 'settle', at: 2 },
        { mark: 'walk', at: 4 },
        { mark: 'jump', at: 6 },
        { mark: 'stop', at: 7 },
        { mark: 'end', at: 9 }
      ]
    });
    expect(runs.get('other').times).toEqual([8]);
  });

  it('gives each command the keys of the phase whose mark came before it, up to the end', () => {
    const commands = caseCommands(CASE, readPlayLog(LOG).get('test-walk'));
    expect(commands.map(({ serverTime, forwardmove, upmove }) => [serverTime, forwardmove, upmove]))
      .toEqual([
        [96, 0, 0],
        [104, 0, 0],
        [112, 0, 0],
        [120, 0, 0],
        [128, 127, 0],
        [136, 127, 0],
        [144, 127, 127],
        [152, 0, 0],
        [160, 0, 0]
      ]);
    expect(commands.every(({ rightmove }) => rightmove === 0)).toBe(true);
  });

  it("refuses a run whose marks are not the case's", () => {
    const short = readPlayLog(LOG.replace('pcq-mark jump', '')).get('test-walk');
    expect(() => caseCommands(CASE, short)).toThrow(
      "test-walk: the log's marks are start settle walk stop end"
    );
  });
});

describe('startSnapshot', () => {
  const snapshot = (eFlags) => ({ ps: { eFlags } });

  it('finds the first snapshot after setviewpos by the teleport bit it toggles', () => {
    expect(startSnapshot([snapshot(0), snapshot(0), snapshot(4), snapshot(4)])).toBe(2);
    expect(startSnapshot([snapshot(4 | 1), snapshot(1)])).toBe(1);
  });

  it('refuses a demo in which the player was never put anywhere', () => {
    expect(() => startSnapshot([snapshot(0), snapshot(0)])).toThrow('no snapshot after setviewpos');
  });
});
