/**
 * The scripted run's pieces: the cases Quake 3 plays, its command line and script for them, the
 * commands its log says it made, and where in its demo each case starts. No engine, so the tests
 * run them as they are (`q3-play-lib.test.mjs`).
 */

/**
 * The keys a case may hold, each as Quake 3's button command and the move it makes: 127 a side
 * under `cl_run 1`, the whole of every frame it is held (`CL_KeyMove`, `cl_input.c:317-358`).
 *
 * @type {Record<string, { button: string, move: 'forwardmove' | 'rightmove' | 'upmove',
 *   value: number }>}
 */
export const KEYS = {
  forward: { button: 'forward', move: 'forwardmove', value: 127 },
  back: { button: 'back', move: 'forwardmove', value: -127 },
  left: { button: 'moveleft', move: 'rightmove', value: -127 },
  right: { button: 'moveright', move: 'rightmove', value: 127 },
  jump: { button: 'moveup', move: 'upmove', value: 127 },
  crouch: { button: 'movedown', move: 'upmove', value: -127 }
};

/**
 * A case: a map, where `setviewpos` throws the player from (x, y, z and yaw), and the phases
 * after, each so many frames, a frame a tick, with these keys held. A map that is not retail names
 * the pak it ships in, which both sides read beside the retail ones. Quake 3's server runs at
 * `svFps`, the port's tick of 125 unless the case names its own.
 *
 * @typedef {{ name: string, map: string, paks?: string[], svFps?: number,
 *   at: [number, number, number, number],
 *   phases: { mark: string, frames: number, keys: (keyof typeof KEYS)[] }[] }} PlayCase
 */

/** Quake 3's server frame rate unless a case names its own, which is the port's tick. */
const SV_FPS = 125;

/**
 * The cases. Each starts where the port's move found what it is after: a drop from a spawn spot,
 * with `setviewpos`'s throw and landing, a walk, a jump on the run, the drop, and a stop; a swim
 * and a water jump; a slick floor; a jump pad and a teleporter, each touched by its brush; lava,
 * burning on Quake 3's own frames; a door, a plat and a button, each set off by the player; rides
 * on a bobbing platform, a sliding one and a train; and what a snapshot shows, through a door over
 * an area portal and a portal surface's camera.
 *
 * @type {PlayCase[]}
 */
export const PLAY_CASES = [
  {
    name: 'q3dm1-drop',
    map: 'q3dm1',
    // South from the western spawn, and 40 units down to the floor of the hall.
    at: [216, 1328, 24, 270],
    phases: [
      { mark: 'settle', frames: 60, keys: [] },
      { mark: 'walk', frames: 60, keys: ['forward'] },
      { mark: 'jump', frames: 10, keys: ['forward', 'jump'] },
      { mark: 'run', frames: 200, keys: ['forward'] },
      { mark: 'stop', frames: 200, keys: [] }
    ]
  },
  {
    name: 'q3dm17-fall',
    map: 'q3dm17',
    // South along the northern platform, and off its end 328 units to the floor below.
    at: [488, 1096, 352, 270],
    phases: [
      { mark: 'settle', frames: 60, keys: [] },
      { mark: 'walk', frames: 60, keys: ['forward'] },
      { mark: 'jump', frames: 10, keys: ['forward', 'jump'] },
      { mark: 'run', frames: 200, keys: ['forward'] },
      { mark: 'stop', frames: 200, keys: [] }
    ]
  },
  {
    name: 'q3dm12-swim',
    map: 'q3dm12',
    // East off the western walkway, thrown into the water channel. The swim crosses it under the
    // surface to the eastern wall, rises along the wall to the waist, and water-jumps out onto the
    // walkway there, 11 units above the water.
    at: [40, -700, -233, 0],
    phases: [
      { mark: 'settle', frames: 60, keys: [] },
      { mark: 'swim', frames: 100, keys: ['forward'] },
      { mark: 'surface', frames: 104, keys: ['forward', 'jump'] },
      { mark: 'stop', frames: 100, keys: [] }
    ]
  },
  {
    name: 'cpm18-slick',
    map: 'cpm18',
    paks: ['map_cpm18.pk3'],
    // South along the slick trench, away from the push trigger at its northern end, and off its
    // open southern end to the floor below. Nothing slows the slide but the brake, which takes
    // the air's acceleration.
    at: [20, 2398, -64, 270],
    phases: [
      { mark: 'slide', frames: 24, keys: [] },
      { mark: 'brake', frames: 40, keys: ['back'] },
      { mark: 'stop', frames: 150, keys: [] }
    ]
  },
  {
    name: 'q3dm17-pad',
    map: 'q3dm17',
    // North-west onto the platform's northern jump pad, a 20-sided disc, across its cut edge,
    // where a touch by its bounds would come 7 frames early; up to its apex, and down onto the
    // ledge beyond.
    at: [120, 648, 352, 135],
    phases: [
      { mark: 'settle', frames: 60, keys: [] },
      { mark: 'walk', frames: 40, keys: ['forward'] },
      { mark: 'fly', frames: 250, keys: [] }
    ]
  },
  {
    name: 'q3dm17-teleport',
    map: 'q3dm17',
    // North-west up the channel by the pillar into the northern teleporter, a chamfered brush,
    // where a touch by its bounds would come 17 frames early, and out on the eastern ledge facing
    // west, along a y the game module's floats leave short of zero.
    at: [330, 846, 352, 135],
    phases: [
      { mark: 'settle', frames: 60, keys: [] },
      { mark: 'walk', frames: 60, keys: ['forward'] },
      { mark: 'stop', frames: 150, keys: [] }
    ]
  },
  {
    name: 'q3dm7-lava',
    map: 'q3dm7',
    // Quake 3's own frame rate, on whose 50 ms frames lava burns.
    svFps: 20,
    // East over the lava at the foot of the pit, and down 85 units into it: it burns 30 as the
    // player lands, again 700 ms on and 50 ms after that. The walk steps up out of it before the
    // fourth burn, which would kill. No retail map has slime a player can reach.
    at: [200, -800, -300, 0],
    phases: [
      { mark: 'fall', frames: 60, keys: [] },
      { mark: 'burn', frames: 90, keys: [] },
      { mark: 'out', frames: 60, keys: ['forward'] },
      { mark: 'stop', frames: 60, keys: [] }
    ]
  },
  {
    name: 'cpma3-door',
    map: 'cpma3',
    paks: ['map_cpma3.pk3'],
    // West up the steps from the lower hall into the trigger of the sliding pair d3, through the
    // pair as it opens, and on until it has closed behind.
    at: [1300, -1152, -318, 180],
    phases: [
      { mark: 'settle', frames: 40, keys: [] },
      { mark: 'walk', frames: 140, keys: ['forward'] },
      { mark: 'stop', frames: 340, keys: [] }
    ]
  },
  {
    name: 'cpma3-plat',
    map: 'cpma3',
    paks: ['map_cpma3.pk3'],
    // East along the lower corridor onto the plat at its bottom and into its trigger, up 290
    // units, south off at the top, and the plat back down a second after.
    at: [2220, -836, -318, 0],
    phases: [
      { mark: 'settle', frames: 40, keys: [] },
      { mark: 'walk', frames: 30, keys: ['forward'] },
      { mark: 'ride', frames: 100, keys: [] },
      { mark: 'off', frames: 40, keys: ['right'] },
      { mark: 'stop', frames: 220, keys: [] }
    ]
  },
  {
    name: 'cpma3-button',
    map: 'cpma3',
    paks: ['map_cpma3.pk3'],
    // East into the button on the west room's wall, which slides a floor out over the lava pit;
    // north into the corridor, east across the floor, and on until it has slid back.
    at: [-2000, 1678, 152, 0],
    phases: [
      { mark: 'settle', frames: 40, keys: [] },
      { mark: 'walk', frames: 60, keys: ['forward'] },
      { mark: 'wait', frames: 60, keys: [] },
      { mark: 'north', frames: 52, keys: ['left'] },
      { mark: 'east', frames: 150, keys: ['forward'] },
      { mark: 'end', frames: 160, keys: [] }
    ]
  },
  {
    name: 'q3dm19-bob',
    map: 'q3dm19',
    // Above the platform beside the eastern ledge as it rises, onto it as it meets the falling
    // player; up to its peak, down 810 units to its foot and up again, ridden throughout.
    at: [-40, 536, 525, 225],
    phases: [
      { mark: 'land', frames: 60, keys: [] },
      { mark: 'ride', frames: 800, keys: [] }
    ]
  },
  {
    name: 'q3tourney6-slide',
    map: 'q3tourney6',
    // West off the arena's west edge onto the platform that slides along it at its northern end,
    // and carried south along the edge over the void.
    at: [-140, 1560, 24, 180],
    phases: [
      { mark: 'board', frames: 40, keys: [] },
      { mark: 'ride', frames: 760, keys: [] }
    ]
  },
  {
    name: 'tig_gng-raft',
    map: 'tig_gng',
    paks: ['tig_gng.pk3'],
    // Onto the raft's deck at the east bank, braking out of the throw before it carries the player
    // off the deck's far side; west across the slime river on it, left at the west bank's overhang
    // as the raft slides on beneath, and carried back as it turns.
    at: [3500, -172, 16, 90],
    phases: [
      { mark: 'brake', frames: 28, keys: ['back'] },
      { mark: 'ride', frames: 562, keys: [] }
    ]
  },
  {
    name: 'q3dm12-door',
    map: 'q3dm12',
    // North into the trigger of the pair that slides apart over the portal between areas 2 and 4,
    // which opens it; through, and on until the pair has closed it behind. The map's eleven areas
    // take two bytes of mask, and the pair's leaves more clusters than it keeps.
    at: [608, -2480, -183, 90],
    phases: [
      { mark: 'settle', frames: 40, keys: [] },
      { mark: 'walk', frames: 170, keys: ['forward'] },
      { mark: 'stop', frames: 450, keys: [] }
    ]
  },
  {
    name: 'q3dm11-portal',
    map: 'q3dm11',
    // From the spawn spot in the corridor whose clusters see the portal surface, west up the steps
    // out of their sight, and back east into it, its camera's view in each snapshot it is sent in.
    at: [216, -808, -24, 180],
    phases: [
      { mark: 'settle', frames: 40, keys: [] },
      { mark: 'west', frames: 60, keys: ['forward'] },
      { mark: 'out', frames: 60, keys: [] },
      { mark: 'east', frames: 60, keys: ['back'] },
      { mark: 'in', frames: 60, keys: [] }
    ]
  }
];

/**
 * The third-party paks the cases' maps ship in, each once, which both sides read beside the
 * retail ones.
 *
 * @param {PlayCase[]} cases
 * @returns {string[]}
 */
export function casePaks(cases) {
  return [...new Set(cases.flatMap(({ paks }) => paks ?? []))];
}

/** The script Quake 3 runs, written into its home folder's `baseq3`. */
export const PLAY_SCRIPT = 'pcq-play.cfg';

/** What the script echoes to its log at each case, and at each change of keys within one. */
const CASE_MARK = 'pcq-case';
const KEY_MARK = 'pcq-mark';

/**
 * The frames Quake 3 waits after `devmap` for the map, cgame and the first snapshots, and after
 * `record` for its first snapshot, which waits for one delta'd from nothing.
 */
const LOAD_FRAMES = 200;
const RECORD_FRAMES = 30;

/** A case's demo's name, as `record` takes it: Quake 3 adds `.dm_` and its protocol. */
export function demoName(name) {
  return `pcq-${name}`;
}

/**
 * Quake 3's command line for the run: its settings, then {@link PLAY_SCRIPT}.
 *
 * - The move's tick, and a snapshot every tick: `pmove_fixed 1` and `pmove_msec 8`, as the port
 *   always moves; `sv_fps 125`, and `snaps 125` to take each, which the server holds to its own
 *   frame rate when a case slows it.
 * - A tick a frame, set by the script once cheats are on: `com_maxfps 125` here.
 * - The commands' angles stay the script's: no mouse, and no sensitivity if one were read.
 * - `+safe` reads no `q3config.cfg`, and `logfile 2` keeps all it prints in `qconsole.log`.
 *
 * @param {{ basepath: string, homepath: string }} run
 * @returns {string[]}
 */
export function playArguments({ basepath, homepath }) {
  const sets = {
    fs_basepath: basepath,
    fs_homepath: homepath,
    cl_renderer: 'opengl1',
    r_fullscreen: '0',
    r_mode: '-1',
    r_customwidth: '640',
    r_customheight: '480',
    s_initsound: '0',
    in_nograb: '1',
    in_mouse: '0',
    sensitivity: '0',
    cl_run: '1',
    com_maxfps: '125',
    sv_fps: String(SV_FPS),
    snaps: String(SV_FPS),
    pmove_fixed: '1',
    pmove_msec: '8',
    g_synchronousClients: '0',
    cl_noprint: '1',
    logfile: '2'
  };
  return [
    '+safe',
    ...Object.entries(sets).flatMap(([name, value]) => ['+set', name, value]),
    '+exec',
    PLAY_SCRIPT
  ];
}

/** The variable a set of held keys is pressed again through, every frame. */
const pressName = (keys) => `pcqKeys_${keys.join('_')}`;

/**
 * {@link PLAY_SCRIPT}: each case recorded in turn, then quit.
 *
 * A case's map is started with `devmap` at the case's server frame rate, which allows `fixedtime
 * 8`, a tick a frame, `give health`, which holds the health at the max where nothing drains it,
 * and `setviewpos`. `cg_showmiss 2` has cgame print each frame's command time
 * (`cg_predict.c:595-597`), and an echo marks the case and each change of keys, so the log says
 * which keys each command was made with ({@link readPlayLog}).
 *
 * A held key is let go and pressed again every frame. Held, `CL_KeyState` counts it in real
 * milliseconds and a frame that took none makes a command without it (`cl_input.c:161-193`);
 * pressed that frame, it counts the whole frame. `wait 2` is one frame, as `Com_Frame` runs the
 * buffer twice (`common.c:3174, 3220`).
 *
 * @param {PlayCase[]} cases
 * @returns {string}
 */
export function playScript(cases) {
  const sets = new Map();
  const runs = cases.flatMap(({ name, map, svFps, at, phases }) => {
    const lines = [
      `sv_fps ${svFps ?? SV_FPS}`,
      `devmap ${map}`,
      `wait ${2 * LOAD_FRAMES}`,
      'fixedtime 8',
      'cg_showmiss 2',
      `echo ${CASE_MARK} ${name}`,
      `record ${demoName(name)}`,
      `wait ${2 * RECORD_FRAMES}`,
      'give health',
      `echo ${KEY_MARK} start`,
      `setviewpos ${at.join(' ')}`
    ];
    let held = [];
    for (const { mark, frames, keys } of phases) {
      lines.push(`echo ${KEY_MARK} ${mark}`);
      for (const key of held) if (!keys.includes(key)) lines.push(`-${KEYS[key].button}`);
      if (keys.length === 0) {
        lines.push(`wait ${2 * frames}`);
      } else {
        const press = keys.map((key) => `-${KEYS[key].button};+${KEYS[key].button}`);
        sets.set(pressName(keys), `${press.join(';')};wait 2`);
        for (let i = 0; i < frames; i++) lines.push(`vstr ${pressName(keys)}`);
      }
      held = keys;
    }
    for (const key of held) lines.push(`-${KEYS[key].button}`);
    lines.push(`echo ${KEY_MARK} end`, 'stoprecord', 'wait 30', 'cg_showmiss 0', 'fixedtime 0');
    return lines;
  });
  const variables = [...sets].map(([variable, text]) => `set ${variable} "${text}"`);
  return [...variables, ...runs, 'quit', ''].join('\n');
}

/** What the log says of a frame's command, under `cg_showmiss 2`, and of the script's marks. */
const LOG_TOKENS = new RegExp(
  [String.raw`\[(-?\d+) : -?\d+\] `, `${CASE_MARK} (\\S+)`, `${KEY_MARK} (\\S+)`].join('|'),
  'g'
);

/**
 * Each case's commands as Quake 3's log tells them: every frame's command time, in order, and
 * where among them each mark fell, as the count of commands before it.
 *
 * @param {string} log
 * @returns {Map<string, { times: number[], marks: { mark: string, at: number }[] }>}
 */
export function readPlayLog(log) {
  const runs = new Map();
  let run = null;
  for (const [, time, name, mark] of log.matchAll(LOG_TOKENS)) {
    if (name !== undefined) {
      run = { times: [], marks: [] };
      runs.set(name, run);
    } else if (run === null) {
      continue;
    } else if (mark !== undefined) {
      run.marks.push({ mark, at: run.times.length });
    } else {
      run.times.push(Number(time));
    }
  }
  return runs;
}

/**
 * A case's commands, as Quake 3 made them: each frame's time, and the moves of the keys its
 * phase held, up to the case's end.
 *
 * @param {PlayCase} playCase
 * @param {{ times: number[], marks: { mark: string, at: number }[] }} run - From
 *   {@link readPlayLog}.
 * @returns {{ serverTime: number, forwardmove: number, rightmove: number, upmove: number }[]}
 * @throws for a run whose marks are not the case's
 */
export function caseCommands(playCase, run) {
  const marks = ['start', ...playCase.phases.map(({ mark }) => mark), 'end'];
  const found = run.marks.map(({ mark }) => mark);
  if (found.join(' ') !== marks.join(' ')) {
    const said = `${found.join(' ')}, not ${marks.join(' ')}`;
    throw new Error(`${playCase.name}: the log's marks are ${said}`);
  }
  const end = run.marks.at(-1).at;
  const commands = [];
  for (let i = 0; i < end; i++) {
    const command = { serverTime: run.times[i], forwardmove: 0, rightmove: 0, upmove: 0 };
    // The phase in force: the last whose mark came before this command, `start` holding nothing.
    const phase = run.marks.findLastIndex(({ at }) => at <= i);
    for (const key of phase > 0 ? playCase.phases[phase - 1].keys : []) {
      command[KEYS[key].move] = KEYS[key].value;
    }
    commands.push(command);
  }
  return commands;
}

/** Quake 3's `EF_TELEPORT_BIT` (`bg_public.h:251`), toggled whenever the origin jumps. */
const EF_TELEPORT_BIT = 4;

/**
 * Where a case starts in its demo: the first snapshot after `setviewpos`, which toggles the
 * teleport bit.
 *
 * @param {{ ps: { eFlags: number } }[]} snapshots
 * @returns {number} Its index.
 * @throws for a demo in which the player was never put anywhere
 */
export function startSnapshot(snapshots) {
  for (let i = 1; i < snapshots.length; i++) {
    const was = snapshots[i - 1].ps.eFlags & EF_TELEPORT_BIT;
    if ((snapshots[i].ps.eFlags & EF_TELEPORT_BIT) !== was) return i;
  }
  throw new Error('the demo has no snapshot after setviewpos');
}
