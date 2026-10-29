import { describe, expect, it } from 'vitest';

import {
  ALL_WEAPONS,
  AMMO_INFINITE,
  MAX_WEAPONS,
  WEAPON_FIRING,
  WEAPON_READY,
  WP
} from '../sim/weapons/constants';
import { MAX_POWERUPS } from '../net/protocol';
import {
  GT,
  PM_INTERMISSION,
  PM_SPECTATOR,
  PMF_FOLLOW,
  PMF_SCOREBOARD,
  SCORE_NOT_PRESENT,
  TEAM
} from '../sim/constants';
import type { ClientInfo } from './client-info';
import { findItem, itemIndex, PW } from '../sim/items';
import {
  centerPrint,
  createCenterPrint,
  USE_ITEM_CHAR_WIDTH,
  USE_ITEM_Y,
  type CenterPrintState
} from './center-print';
import { createRewardState, pushReward } from './rewards';
import { createAttacker } from './attacker';
import { addToTeamChat, createTeamChat } from './team-chat';
import { ICON_SIZE, STATUS_COLORS } from './hud-status';
import { SCREEN_HEIGHT, SCREEN_WIDTH } from './hud-layout';
import {
  createHudState,
  crosshairShader,
  hudFrame,
  type HudInput,
  type HudSettings
} from './hud';
import { BIGCHAR_WIDTH } from './hud-text';
import { Lagometer } from './lagometer';
import { LAGOMETER_BOX } from './speedometer';
/** `STAT_WEAPONS` with every weapon the spawn gives. */
const OWNED = ALL_WEAPONS.reduce<number>((bits, weapon) => bits | (1 << weapon), 0);

/** Ammo per weapon, the same for all. */
const ammoOf = (count: number) => new Array<number>(MAX_WEAPONS).fill(count);

/** A fresh spawn 5 s in: 125 health, no armor, the machinegun, infinite ammo. */
function input(overrides: Partial<HudInput> = {}): HudInput {
  return {
    health: 125,
    armor: 0,
    armorTier: 0,
    weapon: WP.MACHINEGUN,
    weapons: OWNED,
    ammo: ammoOf(AMMO_INFINITE),
    lowAmmo: [],
    weaponState: WEAPON_READY,
    weaponTime: 0,
    weaponSelect: WP.MACHINEGUN,
    weaponSelectTime: Number.NEGATIVE_INFINITY,
    damage: { time: Number.NEGATIVE_INFINITY, x: 0 },
    attacker: createAttacker(),
    attackerNum: 0,
    thirdPerson: false,
    speed: 0,
    peak: 0,
    time: 5000,
    realTime: 0,
    gametype: GT.FFA,
    scores1: SCORE_NOT_PRESENT,
    scores2: SCORE_NOT_PRESENT,
    score: 0,
    team: TEAM.FREE,
    clientNum: 0,
    pmFlags: 0,
    pmType: 0,
    fraglimit: 20,
    capturelimit: 8,
    roundlimit: 0,
    redflag: -1,
    blueflag: -1,
    warmup: 0,
    clientInfo: () => null,
    showScores: false,
    powerups: new Array<number>(MAX_POWERUPS).fill(0),
    powerupActive: 0,
    powerupTime: 0,
    holdable: 0,
    pickup: 0,
    pickupTime: 0,
    centerPrint: createCenterPrint(),
    rewards: createRewardState(),
    teamChat: createTeamChat(),
    ownTeam: TEAM.FREE,
    interrupted: false,
    localServer: true,
    lagometer: new Lagometer(),
    ...overrides
  };
}

/** `ps.powerups` with a few running. */
function holding(entries: readonly (readonly [number, number])[]): number[] {
  const powerups = new Array<number>(MAX_POWERUPS).fill(0);
  for (const [powerup, end] of entries) powerups[powerup] = end;
  return powerups;
}

/** Q3's defaults, with the speedometer off. */
const DEFAULTS: HudSettings = {
  draw2D: true,
  draw3dIcons: true,
  drawCrosshair: 4,
  crosshairSize: 24,
  drawFPS: false,
  lagometer: true,
  noPredict: false,
  speedometer: 0,
  centerTime: 3,
  drawRewards: true,
  teamChatHeight: 0,
  teamChatTime: 3000
};

/** One frame from a fresh HUD. */
function frame(overrides: Partial<HudInput> = {}, settings: Partial<HudSettings> = {}) {
  return hudFrame(createHudState(() => 0.5), input(overrides), { ...DEFAULTS, ...settings });
}

describe('a spectator\'s screen', () => {
  /** Somebody watching rather than playing, whose state still has a body's numbers on it. */
  const watching = (over: Partial<HudInput> = {}) =>
    frame({ team: TEAM.SPECTATOR, ...over });

  it('has none of the player\'s own block, and keeps the crosshair', () => {
    const drawn = watching();

    expect(drawn.statusBar).toBeNull();
    expect(drawn.ammoWarning).toBeNull();
    expect(drawn.weaponBar).toBeNull();
    expect(drawn.holdable).toBeNull();
    // "the one piece of the player's own screen somebody watching still has".
    expect(drawn.crosshair).not.toBeNull();
  });

  it('keeps the crosshair even with the scoreboard up, which is before that rule', () => {
    expect(watching({ showScores: true }).crosshair).not.toBeNull();
    // Where a player's own crosshair goes with the rest of the block.
    expect(frame({ showScores: true }).crosshair).toBeNull();
  });

  it('says SPECTATOR, and what the gametype has to say under it', () => {
    expect(watching().spectator.map((line) => line.text)).toEqual(['SPECTATOR']);
    expect(watching({ gametype: GT.TOURNAMENT }).spectator.map((line) => line.text)).toEqual([
      'SPECTATOR',
      'waiting to play'
    ]);
  });

  it('says nothing of the sort to somebody playing', () => {
    expect(frame().spectator).toEqual([]);
  });

  it("gives a side's player flying as a spectator the crosshair alone, and no word of it", () => {
    // Clan Arena's dead and late arrivals keep their side, and fly with the health they had.
    for (const health of [0, 100]) {
      const drawn = frame({ team: TEAM.RED, gametype: GT.CA, pmType: PM_SPECTATOR, health });
      expect(drawn.statusBar).toBeNull();
      expect(drawn.weaponBar).toBeNull();
      expect(drawn.holdable).toBeNull();
      expect(drawn.crosshair).not.toBeNull();
      expect(drawn.spectator).toEqual([]);
    }
  });

  it('still draws what is nobody\'s own: the score boxes and the speedometer', () => {
    // Outside `CG_Draw2D`'s two branches entirely, so watching changes nothing about them.
    const drawn = frame({ team: TEAM.SPECTATOR }, { speedometer: 1 });

    expect(drawn.scores).not.toBeNull();
    expect(drawn.speedometer).not.toBeNull();
  });
});

describe('the follow line', () => {
  it('names whoever is being watched, when the state being drawn is theirs', () => {
    const drawn = frame({
      team: TEAM.SPECTATOR,
      pmFlags: PMF_FOLLOW,
      clientNum: 3,
      clientInfo: (clientNum) => (clientNum === 3 ? ({ name: 'Bones' } as ClientInfo) : null)
    });

    expect(drawn.follow.map((line) => line.text)).toEqual(['following', 'Bones']);
  });

  it('is not drawn for a state that is the client\'s own', () => {
    expect(frame({ team: TEAM.SPECTATOR }).follow).toEqual([]);
  });

  it('takes the warmup text\'s place, rather than sharing the top of the screen', () => {
    const warming = { warmup: -1, team: TEAM.SPECTATOR };
    expect(frame(warming).warmup.map((line) => line.text)).toEqual(['Waiting for players']);

    const following = frame({ ...warming, pmFlags: PMF_FOLLOW });

    expect(following.follow).toHaveLength(2);
    expect(following.warmup).toEqual([]);
  });

  it('holds the countdown still under it, since CG_DrawWarmup is not reached at all', () => {
    const state = createHudState(() => 0.5);
    const settings = { ...DEFAULTS };
    // A countdown running, which would otherwise write the second it is on into the state.
    hudFrame(state, input({ warmup: 20_000, time: 5_000 }), settings);
    expect(state.warmup.count).toBe(15);

    hudFrame(
      state,
      input({ warmup: 20_000, time: 12_000, team: TEAM.SPECTATOR, pmFlags: PMF_FOLLOW }),
      settings
    );

    expect(state.warmup.count).toBe(15);
  });

  it('says the countdown only where it draws it', () => {
    const settings = { ...DEFAULTS };
    // The countdown's third-to-last second, which is "three".
    const third = { warmup: 20_000, time: 17_500 };

    expect(hudFrame(createHudState(), input(third), settings).warmupVoice).toBe('count3');
    expect(
      hudFrame(
        createHudState(),
        input({ ...third, team: TEAM.SPECTATOR, pmFlags: PMF_FOLLOW }),
        settings
      ).warmupVoice
    ).toBeNull();
    expect(
      hudFrame(createHudState(), input(third), { ...settings, draw2D: false }).warmupVoice
    ).toBeNull();
  });
});

describe('the reward', () => {
  /** A reward waiting, as the announcer pushes it. */
  function waiting() {
    const rewards = createRewardState();
    pushReward(rewards, { sound: 'impressive', medal: 'impressive', count: 2 });
    return rewards;
  }

  it('comes up in the status block, with its medals and its voice', () => {
    const reward = frame({ rewards: waiting(), time: 5000 }).reward;
    expect(reward).toMatchObject({ medal: 'impressive', voice: 'impressive' });
    expect(reward?.medals).toHaveLength(2);
  });

  it('waits, unsaid, while the player is dead, holding the scores key, or spectating', () => {
    for (const over of [{ health: 0 }, { showScores: true }, { team: TEAM.SPECTATOR }]) {
      const rewards = waiting();
      expect(frame({ ...over, rewards, time: 5000 }).reward).toBeNull();
      expect(rewards.stack).toBe(1);
      // And comes up once the player is back.
      expect(frame({ rewards, time: 6000 }).reward?.voice).toBe('impressive');
    }
  });

  it('waits with cg_drawRewards off', () => {
    const rewards = waiting();
    expect(frame({ rewards, time: 5000 }, { drawRewards: false }).reward).toBeNull();
    expect(rewards.stack).toBe(1);
  });
});

describe('the team chat box', () => {
  const FOUR_LINES: Partial<HudSettings> = { teamChatHeight: 4 };

  /** A box with one line in it, said at `time`. */
  function box(time = 4500) {
    const teamChat = createTeamChat();
    addToTeamChat(teamChat, 'on me', { teamChatHeight: 4, teamChatTime: 3000 }, time);
    return teamChat;
  }

  it('draws in a team game, the player alive, dead, spectating or holding the scores key', () => {
    for (const over of [{}, { health: 0 }, { team: TEAM.SPECTATOR }, { showScores: true }]) {
      const chat = frame({ gametype: GT.TEAM, teamChat: box(), ...over }, FOUR_LINES).teamChat;
      expect(chat?.lines.map(({ text }) => text)).toEqual(['on me']);
    }
  });

  it("is tinted by the player's own team, not the followed player's", () => {
    const following = { team: TEAM.RED, pmFlags: PMF_FOLLOW, ownTeam: TEAM.SPECTATOR };
    const chat = frame({ gametype: GT.TEAM, teamChat: box(), ...following }, FOUR_LINES).teamChat;
    expect(chat?.color).toEqual([0, 1, 0, 0.33]);
  });

  it('draws nothing, and lets nothing go, below a team game, at the intermission, or off', () => {
    const cases: [Partial<HudInput>, Partial<HudSettings>][] = [
      [{ gametype: GT.FFA }, FOUR_LINES],
      [{ gametype: GT.TEAM, pmType: PM_INTERMISSION }, FOUR_LINES],
      [{ gametype: GT.TEAM }, { teamChatHeight: 0 }],
      [{ gametype: GT.TEAM }, { ...FOUR_LINES, draw2D: false }]
    ];
    for (const [over, settings] of cases) {
      const teamChat = box(1000);
      expect(frame({ ...over, teamChat }, settings).teamChat).toBeNull();
      expect(teamChat.lastPos).toBe(0);
    }
    // Drawn, the line said long enough ago goes.
    const teamChat = box(1000);
    expect(frame({ gametype: GT.TEAM, teamChat }, FOUR_LINES).teamChat).toBeNull();
    expect(teamChat.lastPos).toBe(1);
  });
});

describe('the last attacker', () => {
  /** Bones, in slot 3, hurt the player at 1000; what is left of the time after a frame at 20 s. */
  function after(over: Partial<HudInput> = {}, settings: Partial<HudSettings> = {}): number {
    const attacker = { time: 1000 };
    const bones = (clientNum: number) =>
      clientNum === 3 ? ({ name: 'Bones' } as ClientInfo) : null;
    frame({ attacker, attackerNum: 3, clientInfo: bones, time: 20_000, ...over }, settings);
    return attacker.time;
  }

  it('is let go where the upper right draws: alive, spectating or holding the scores key', () => {
    for (const over of [{}, { team: TEAM.SPECTATOR }, { showScores: true }]) {
      expect(after(over)).toBe(0);
    }
    expect(after({ time: 11_000 })).toBe(1000);
  });

  it("is kept at the intermission, at a spectator's board, or with cg_draw2D off", () => {
    expect(after({ pmType: PM_INTERMISSION })).toBe(1000);
    expect(after({ team: TEAM.SPECTATOR, pmFlags: PMF_SCOREBOARD })).toBe(1000);
    expect(after({}, { draw2D: false })).toBe(1000);
  });
});

describe('the status bar', () => {
  it('shows a fresh spawn as Q3 does: a white 125, the ammo box spinning, no count, no armor', () => {
    const bar = frame().statusBar!;
    expect(bar.health.digits).toEqual([
      { x: 187, frame: 1 },
      { x: 219, frame: 2 },
      { x: 251, frame: 5 }
    ]);
    expect(bar.health.color).toBe(STATUS_COLORS.over);
    // The infinite −1 hides the count, and the box spins anyway.
    expect(bar.ammo).toBeNull();
    expect(bar.ammoModel).toEqual({
      weapon: WP.MACHINEGUN,
      origin: [70, 0, 0],
      angles: [0, 90 + 20 * Math.sin(5), 0]
    });
    expect(bar.ammoIcon).toBeNull();
    expect([bar.armor, bar.armorModel, bar.armorIcon]).toEqual([null, null, false]);
    expect(bar.head).toMatchObject({ x: 285, y: 420, size: 60, model: true });
  });

  it('draws icons for models with cg_draw3dIcons 0, the ammo icon only beside a count', () => {
    const infinite = frame({}, { draw3dIcons: false }).statusBar!;
    expect([infinite.ammoModel, infinite.ammoIcon, infinite.head.model]).toEqual([null, null, false]);

    const counted = frame({ ammo: ammoOf(50) }, { draw3dIcons: false }).statusBar!;
    expect(counted.ammo).toEqual({
      digits: [
        { x: 34, frame: 5 },
        { x: 66, frame: 0 }
      ],
      color: STATUS_COLORS.normal
    });
    expect(counted.ammoIcon).toBe(WP.MACHINEGUN);
  });

  it("crosses out the head of the state's client while they are drawn in another's look", () => {
    const deferred = (clientNum: number) => ({ deferred: clientNum === 3 }) as ClientInfo;
    const watched = frame({ clientNum: 3, clientInfo: deferred }).statusBar!;
    expect(watched.head.deferred).toBe(true);
    expect(frame({ clientNum: 2, clientInfo: deferred }).statusBar!.head.deferred).toBe(false);
    expect(frame().statusBar!.head.deferred).toBe(false);
  });

  it('greys the ammo count while a shot holds the gun', () => {
    const bar = frame({ ammo: ammoOf(50), weaponState: WEAPON_FIRING, weaponTime: 150 }).statusBar!;
    expect(bar.ammo!.color).toBe(STATUS_COLORS.firing);
  });

  it('spins no ammo box for the gauntlet', () => {
    expect(frame({ weapon: WP.GAUNTLET }).statusBar!.ammoModel).toBeNull();
  });

  it('shows armor as an amber count with the spinning armor, or its icon', () => {
    const bar = frame({ armor: 75 }).statusBar!;
    expect(bar.armor).toEqual({
      digits: [
        { x: 404, frame: 7 },
        { x: 436, frame: 5 }
      ],
      color: STATUS_COLORS.normal
    });
    // 5000 ms is 904 into its 2048 ms turn.
    expect(bar.armorModel).toEqual({ origin: [90, 0, -10], angles: [0, (904 * 360) / 2048, 0] });
    expect(bar.armorIcon).toBe(false);

    const flat = frame({ armor: 75 }, { draw3dIcons: false }).statusBar!;
    expect([flat.armorModel, flat.armorIcon]).toEqual([null, true]);
  });

  it("hands on the armour's tier, which picks the model and the icon", () => {
    expect(frame({ armor: 75 }).statusBar!.armorTier).toBe(0);
    expect(frame({ armor: 75, armorTier: 2 }).statusBar!.armorTier).toBe(2);
  });
});

describe('what draws when', () => {
  it("hides the player's own status when dead, but not the frame rate or the speedometer", () => {
    const hud = createHudState(() => 0.5);
    const settings = { ...DEFAULTS, drawFPS: true, speedometer: 3 as const };
    let dead = hudFrame(hud, input({ health: 0, weaponSelectTime: 4900 }), settings);
    for (let i = 1; i <= 4; i++) {
      dead = hudFrame(hud, input({ health: 0, weaponSelectTime: 4900, realTime: i * 16 }), settings);
    }
    expect([dead.statusBar, dead.ammoWarning, dead.crosshair, dead.weaponBar]).toEqual([
      null,
      null,
      null,
      null
    ]);
    expect(dead.fps).not.toBeNull();
    expect(dead.speedometer).not.toBeNull();
  });

  it('draws nothing at all with cg_draw2D 0', () => {
    const hud = frame({ weaponSelectTime: 4900 }, { draw2D: false, drawFPS: true });
    expect(
      Object.values(hud).every(
        (part) => part === null || (Array.isArray(part) && part.length === 0)
      )
    ).toBe(true);
  });

  it('keeps the speed graph running whether it is drawn or not', () => {
    const hud = createHudState();
    hudFrame(hud, input({ speed: 250 }), { ...DEFAULTS, draw2D: false });
    expect(hud.speeds.sample(0)).toBe(250);
  });
});

describe('the crosshair', () => {
  it('draws crosshair e, 24 square, white at full health', () => {
    expect(frame().crosshair).toEqual({
      shader: 'gfx/2d/crosshaire',
      size: 24,
      color: [1, 1, 1, 1]
    });
  });

  it('turns toward red as health goes', () => {
    expect(frame({ health: 45 }).crosshair!.color).toEqual([1, 0.5, 0, 1]);
  });

  it('draws none in third person, or at cg_drawCrosshair 0', () => {
    expect(frame({ thirdPerson: true }).crosshair).toBeNull();
    expect(frame({}, { drawCrosshair: 0 }).crosshair).toBeNull();
  });

  it('counts crosshairs round by ten, a negative setting drawing a', () => {
    expect(crosshairShader(10)).toBe('gfx/2d/crosshaira');
    expect(crosshairShader(13)).toBe('gfx/2d/crosshaird');
    expect(crosshairShader(-3)).toBe('gfx/2d/crosshaira');
  });
});

describe('the weapon bar and the ammo warning', () => {
  it('shows the bar after a switch', () => {
    expect(frame({ weaponSelectTime: 4500 }).weaponBar!.slots).toHaveLength(9);
    expect(frame().weaponBar).toBeNull();
  });

  it('warns of low ammo, and of none, centred at y 64', () => {
    expect(frame({ ammo: ammoOf(1) }).ammoWarning).toMatchObject({
      text: 'LOW AMMO WARNING',
      x: 192,
      y: 64,
      shadow: true
    });
    expect(frame({ ammo: ammoOf(0) }).ammoWarning).toMatchObject({ text: 'OUT OF AMMO', x: 232 });
    expect(frame().ammoWarning).toBeNull();
  });

  it("warns by the weapon in hand under the serverinfo's marks, and reds its count", () => {
    const marks = ammoOf(0);
    marks[WP.MACHINEGUN] = 50;
    const low = frame({ ammo: ammoOf(30), lowAmmo: marks });
    expect(low.ammoWarning).toMatchObject({ text: 'LOW AMMO WARNING' });
    expect(low.statusBar!.ammo!.color).toBe(STATUS_COLORS.low);
    // id's rule counts every weapon's, which is plenty.
    const id = frame({ ammo: ammoOf(30) });
    expect(id.ammoWarning).toBeNull();
    expect(id.statusBar!.ammo!.color).toBe(STATUS_COLORS.normal);
  });
});

describe('the speedometer and the frame rate', () => {
  it('writes the speed under the crosshair, and its peak under that', () => {
    const { readout, graph } = frame({ speed: 320.4, peak: 451.6 }, { speedometer: 3 }).speedometer!;
    expect(readout).toMatchObject([
      { text: '320', x: 296, y: 264, charWidth: 16, shadow: true, anchor: 'centre' },
      { text: 'peak 452', x: 288, y: 282, charWidth: 8, charHeight: 16, shadow: false }
    ]);
    expect(graph).toBeNull();
  });

  it("draws mode 1's graph alone, in the lagometer's box", () => {
    expect(frame({}, { speedometer: 1 }).speedometer).toEqual({
      readout: [],
      graph: { rect: LAGOMETER_BOX, anchor: 'right' }
    });
    expect(frame({}, { speedometer: 0 }).speedometer).toBeNull();
  });

  it('writes the frame rate at the top right from the fifth frame', () => {
    const hud = createHudState();
    const settings = { ...DEFAULTS, drawFPS: true };
    const counts = [1000, 1016, 1032, 1048, 1064].map(
      (realTime) => hudFrame(hud, input({ realTime }), settings).fps
    );
    expect(counts.slice(0, 4)).toEqual([null, null, null, null]);
    expect(counts[4]).toMatchObject({ text: '62fps', x: 555, y: 2, anchor: 'right' });
  });
});

describe('Connection Interrupted', () => {
  /** This frame's, for a connection that has stopped answering. */
  const interrupted = (over: Partial<HudInput> = {}, settings: Partial<HudSettings> = {}) =>
    frame({ interrupted: true, ...over }, settings).disconnect;

  it('says so across the top, centred, in shadowed white big characters', () => {
    expect(frame().disconnect).toBeNull();
    expect(interrupted()!.text).toEqual({
      text: 'Connection Interrupted',
      x: 320 - (22 * 16) / 2,
      y: 100,
      charWidth: 16,
      charHeight: 16,
      color: [1, 1, 1, 1],
      shadow: true,
      anchor: 'centre'
    });
  });

  it("blinks the net icon in the lagometer's box, 512 ms on and 512 off", () => {
    const icon = (time: number) => interrupted({ time })!.icon;
    expect(icon(5120)).toEqual({ x: 592, y: 432, w: 48, h: 48 });
    expect(icon(5631.9)).toBe(LAGOMETER_BOX);
    expect(icon(5632)).toBeNull();
    expect(icon(6143)).toBeNull();
    expect(icon(6144)).toBe(LAGOMETER_BOX);
    // The line stays up while the icon is off.
    expect(interrupted({ time: 5632 })!.text.text).toBe('Connection Interrupted');
  });

  it('draws outside the status block: dead, spectating, flying or with the scores up', () => {
    const cases: Partial<HudInput>[] = [
      { health: 0 },
      { team: TEAM.SPECTATOR },
      { pmType: PM_SPECTATOR },
      { showScores: true },
      { pmFlags: PMF_FOLLOW }
    ];
    for (const over of cases) expect(interrupted(over), JSON.stringify(over)).not.toBeNull();
  });

  it("draws nothing where the board takes the screen: the intermission's and a spectator's", () => {
    expect(interrupted({ pmType: PM_INTERMISSION })).toBeNull();
    expect(interrupted({ team: TEAM.SPECTATOR, pmFlags: PMF_SCOREBOARD })).toBeNull();
    // The flag is a spectator's board only on a spectator.
    expect(interrupted({ pmFlags: PMF_SCOREBOARD })).not.toBeNull();
  });

  it('draws nothing with cg_draw2D 0', () => {
    expect(interrupted({}, { draw2D: false })).toBeNull();
  });
});

describe('the lagometer', () => {
  const samples = new Lagometer();
  /** This frame's, for a client whose server is elsewhere. */
  const remote = (over: Partial<HudInput> = {}, settings: Partial<HudSettings> = {}) =>
    frame({ localServer: false, lagometer: samples, ...over }, settings).lagometer;

  it("draws in its box on a client whose server is elsewhere, from the view's samples", () => {
    expect(remote()).toEqual({ rect: { x: 592, y: 432, w: 48, h: 48 }, samples, snc: null });
  });

  it('draws nothing on a local server, or with cg_lagometer 0', () => {
    expect(remote({ localServer: true })).toBeNull();
    expect(remote({}, { lagometer: false })).toBeNull();
  });

  it('writes snc over its corner under cg_nopredict', () => {
    expect(remote({}, { noPredict: true })!.snc).toMatchObject({ text: 'snc', x: 592, y: 432 });
  });

  it('draws outside the status block: dead, spectating, flying or with the scores up', () => {
    const cases: Partial<HudInput>[] = [
      { health: 0 },
      { team: TEAM.SPECTATOR },
      { pmType: PM_SPECTATOR },
      { showScores: true },
      { pmFlags: PMF_FOLLOW },
      { pmFlags: PMF_SCOREBOARD }
    ];
    for (const over of cases) expect(remote(over), JSON.stringify(over)).not.toBeNull();
  });

  it("draws nothing where the board takes the screen, nor with cg_draw2D 0", () => {
    expect(remote({ pmType: PM_INTERMISSION })).toBeNull();
    expect(remote({ team: TEAM.SPECTATOR, pmFlags: PMF_SCOREBOARD })).toBeNull();
    expect(remote({}, { draw2D: false })).toBeNull();
  });

  it("stands the speedometer's graph in the box beside it wherever it is on, only there", () => {
    const graph = (over: Partial<HudInput>, settings: Partial<HudSettings> = {}) =>
      frame({ localServer: false, ...over }, { speedometer: 1, ...settings }).speedometer!.graph;
    const beside = { rect: { x: 544, y: 432, w: 48, h: 48 }, anchor: 'right' };
    expect(graph({})).toEqual(beside);
    // Where the board hides the lagometer, the graph keeps its place.
    expect(graph({ pmType: PM_INTERMISSION })).toEqual(beside);
    expect(graph({ localServer: true })).toEqual({ rect: LAGOMETER_BOX, anchor: 'right' });
    expect(graph({}, { lagometer: false })).toEqual({ rect: LAGOMETER_BOX, anchor: 'right' });
  });
});

describe('the scores and the warmup', () => {
  it('hides the player\'s own status, warning, crosshair and weapon bar while the scores key is held', () => {
    // `cg_draw.c:2557`: "don't draw any status if dead or the scoreboard is being explicitly shown".
    // A weapon just picked, so the bar is in its select time and draws.
    expect(frame({ weaponSelectTime: 4900 }).statusBar).not.toBeNull();
    expect(frame({ weaponSelectTime: 4900 }).crosshair).not.toBeNull();
    expect(frame({ weaponSelectTime: 4900 }).weaponBar).not.toBeNull();

    const held = frame({ showScores: true, armor: 50, speed: 300, weaponSelectTime: 4900 });
    expect(held.statusBar).toBeNull();
    expect(held.ammoWarning).toBeNull();
    expect(held.crosshair).toBeNull();
    expect(held.weaponBar).toBeNull();
    // The score area and the warmup are outside that block, and still draw.
    expect(held.scores).not.toBeNull();
  });

  it('draws the score area alive and dead alike', () => {
    const alive = frame({ scores1: 12, score: 9 }).scores!;
    expect(alive.boxes.map((box) => box.text.text)).toEqual([' 9', '12']);

    const dead = frame({ health: 0, scores1: 12, score: 9 }).scores!;
    expect(dead.boxes).toHaveLength(2);
  });

  it('draws the warmup block while a match waits', () => {
    const lines = frame({ warmup: -1 }).warmup;
    expect(lines.map((line) => line.text)).toEqual(['Waiting for players']);
  });

  it('draws no warmup once play is on', () => {
    expect(frame().warmup).toEqual([]);
  });
});

describe('the item displays', () => {
  const QUAD = itemIndex(findItem('item_quad')!);
  const MEDKIT = itemIndex(findItem('holdable_medkit')!);

  it('shows the last item taken: its icon at the lower left, its name at full strength', () => {
    const shown = frame({ pickup: QUAD, pickupTime: 5_000 }).pickup!;
    expect(shown.item).toBe(QUAD);
    expect(shown.icon).toEqual({
      x: 8,
      y: SCREEN_HEIGHT - 2 * ICON_SIZE,
      w: ICON_SIZE,
      h: ICON_SIZE
    });
    expect(shown.alpha).toBe(1);
    expect(shown.name).toMatchObject({
      text: 'Quad Damage',
      x: ICON_SIZE + 16,
      charWidth: BIGCHAR_WIDTH,
      shadow: true
    });
    // Q3 hands `CG_DrawBigString` `fadeColor[0]`, which is 1 however the icon is fading.
    expect(shown.name.color[3]).toBe(1);
  });

  it('fades the icon over the last of its three seconds, and draws nothing after', () => {
    expect(frame({ pickup: QUAD, pickupTime: 5_000, time: 7_900 }).pickup!.alpha).toBeCloseTo(0.5, 6);
    expect(frame({ pickup: QUAD, pickupTime: 5_000, time: 8_000 }).pickup).toBeNull();
    // `cg.itemPickupTime` 0 is "never taken one", which `CG_FadeColor` answers nothing for — at
    // any time, even one that a fade from 0 would call full.
    expect(frame({ pickup: QUAD, pickupTime: 0, time: 1_000 }).pickup).toBeNull();
    expect(frame({ pickup: 0, pickupTime: 5_000 }).pickup).toBeNull();
  });

  it('shows no pickup to a dead player, but does with the scores up', () => {
    // `CG_DrawLowerLeft` is outside the scoreboard's block, and `CG_DrawPickupItem` is the one
    // that checks health.
    expect(frame({ pickup: QUAD, pickupTime: 5_000, health: 0 }).pickup).toBeNull();
    expect(frame({ pickup: QUAD, pickupTime: 5_000, showScores: true }).pickup).not.toBeNull();
  });

  it('draws the powerups held over the scores, and the carried holdable on the right', () => {
    const powerups = holding([
      [PW.QUAD, 20_000],
      [PW.HASTE, 8_000]
    ]);
    const hud = frame({ powerups, time: 5_000 });
    expect(hud.powerups.map((timer) => timer.powerup)).toEqual([PW.HASTE, PW.QUAD]);

    // The holdable is in the scoreboard's block, unlike the powerups and the pickup.
    const shown = frame({ holdable: MEDKIT }).holdable!;
    expect(shown.item).toBe(MEDKIT);
    expect(shown.icon).toEqual({
      x: SCREEN_WIDTH - ICON_SIZE,
      y: (SCREEN_HEIGHT - ICON_SIZE) / 2,
      w: ICON_SIZE,
      h: ICON_SIZE
    });
    expect(frame({ holdable: 0 }).holdable).toBeNull();
    expect(frame({ holdable: MEDKIT, showScores: true }).holdable).toBeNull();
    expect(frame({ holdable: MEDKIT, health: 0 }).holdable).toBeNull();
  });

  it('stops the powerup timers for a dead player, and draws none of it with cg_draw2D off', () => {
    const powerups = holding([[PW.QUAD, 20_000]]);
    expect(frame({ powerups, health: 0, time: 5_000 }).powerups).toEqual([]);
    // A CTF flag's timer never runs out, and Q3 draws no timer for one.
    expect(frame({ powerups: holding([[PW.REDFLAG, 0x7fffffff]]), time: 5_000 }).powerups).toEqual(
      []
    );

    const off = frame(
      { powerups, holdable: MEDKIT, pickup: QUAD, pickupTime: 5_000, time: 5_000 },
      { draw2D: false }
    );
    expect([off.pickup, off.holdable, off.powerups]).toEqual([null, null, []]);
  });
});

describe('the center print', () => {
  /** A message raised at 5000 ms, as `CG_UseItem` raises one. */
  function raised(text: string, time = 5_000): CenterPrintState {
    const state = createCenterPrint();
    centerPrint(state, text, USE_ITEM_Y, USE_ITEM_CHAR_WIDTH, time);
    return state;
  }

  it('draws the message centred, in its fade, and with no shadow', () => {
    const [line] = frame({ centerPrint: raised('Use Medkit') }).centerPrint;
    expect(line).toEqual({
      text: 'Use Medkit',
      x: 240,
      y: 136,
      charWidth: BIGCHAR_WIDTH,
      charHeight: 24,
      color: [1, 1, 1, 1],
      shadow: false,
      anchor: 'centre'
    });
  });

  it('goes with cg_centertime, which Q3 leaves at three seconds', () => {
    expect(frame({ centerPrint: raised('Use Medkit'), time: 7_900 }).centerPrint[0].color[3]).toBeCloseTo(0.5, 6);
    expect(frame({ centerPrint: raised('Use Medkit'), time: 8_000 }).centerPrint).toEqual([]);
    // The setting is the duration: half a second in, half a second later it is gone.
    const short = frame({ centerPrint: raised('Use Medkit'), time: 5_450 }, { centerTime: 0.5 });
    expect(short.centerPrint[0].color[3]).toBeCloseTo(0.25, 6);
    expect(
      frame({ centerPrint: raised('Use Medkit'), time: 5_500 }, { centerTime: 0.5 }).centerPrint
    ).toEqual([]);
  });

  it('hides behind the scoreboard, which Q3 checks just before drawing it', () => {
    // `CG_DrawCenterString` is drawn only when `cg.scoreBoardShowing` is false
    // (`cg_draw.c:2615–2619`); it is not health-gated, unlike the pickup.
    expect(frame({ centerPrint: raised('Use Medkit'), showScores: true }).centerPrint).toEqual([]);
    expect(frame({ centerPrint: raised('Use Medkit'), health: 0 }).centerPrint).not.toEqual([]);
  });

  it('draws none of it with cg_draw2D off', () => {
    expect(frame({ centerPrint: raised('Use Medkit') }, { draw2D: false }).centerPrint).toEqual([]);
  });
});
