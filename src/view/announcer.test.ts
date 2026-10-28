import { describe, expect, it } from 'vitest';

import { GT, PERS, PLAYEREVENT, RANK_TIED_FLAG, TEAM } from '../sim/constants';
import { GTS } from '../sim/events';
import { PW } from '../sim/items';
import {
  Announcer,
  BUFFERED_SOUND_GAP,
  MAX_SOUNDBUFFER,
  type AnnouncerMatch,
  type LocalSoundState
} from './announcer';

/** A player state as the announcer reads one: every counter and powerup at 0 but those given. */
function state(
  persistant: Partial<Record<keyof typeof PERS, number>> = {},
  powerups: Partial<Record<number, number>> = {}
): LocalSoundState {
  const pers = new Array<number>(16).fill(0);
  for (const [key, value] of Object.entries(persistant)) pers[PERS[key as keyof typeof PERS]] = value;
  const held = new Array<number>(16).fill(0);
  for (const [slot, value] of Object.entries(powerups)) held[Number(slot)] = value ?? 0;
  return { persistant: pers, powerups: held };
}

/** A free-for-all with no limits, begun at 0, unless a test says otherwise. */
function match(over: Partial<AnnouncerMatch> = {}): AnnouncerMatch {
  return {
    gametype: GT.FFA,
    fraglimit: 0,
    timelimit: 0,
    levelStartTime: 0,
    scores1: 0,
    scores2: 0,
    ...over
  };
}

/** Every voice the announcer lets out between two times, a frame each 10 ms. */
function drain(announcer: Announcer, from: number, to: number): string[] {
  const heard: string[] = [];
  for (let time = from; time <= to; time += 10) {
    announcer.play(time);
    heard.push(...announcer.take());
  }
  return heard;
}

describe('the buffered voices', () => {
  it('lets one out at a time, 750 ms apart', () => {
    const announcer = new Announcer();
    announcer.add('takenLead');
    announcer.add('twoFrag');

    announcer.play(1000);
    expect(announcer.take()).toEqual(['takenLead']);
    announcer.play(1000 + BUFFERED_SOUND_GAP);
    expect(announcer.take()).toEqual([]);
    announcer.play(1001 + BUFFERED_SOUND_GAP);
    expect(announcer.take()).toEqual(['twoFrag']);
  });

  it('drops its oldest voice when it is full, keeping one slot free', () => {
    const announcer = new Announcer();
    const cues = ['takenLead', 'tiedLead', 'lostLead'] as const;
    for (let i = 0; i < MAX_SOUNDBUFFER; i++) announcer.add(cues[i % 3]);

    const heard = drain(announcer, 1000, 1000 + MAX_SOUNDBUFFER * BUFFERED_SOUND_GAP);
    // Twenty in, nineteen out: the first was the one dropped.
    expect(heard).toHaveLength(MAX_SOUNDBUFFER - 1);
    expect(heard[0]).toBe('tiedLead');
  });

  it('wraps around its ring', () => {
    const announcer = new Announcer();
    const heard: string[] = [];
    for (let round = 0; round < MAX_SOUNDBUFFER + 5; round++) {
      announcer.add(round % 2 ? 'hit' : 'oneFrag');
      heard.push(...drain(announcer, round * 1000 + 1, round * 1000 + 1));
    }
    expect(heard).toHaveLength(MAX_SOUNDBUFFER + 5);
  });

  it('starts the talk sound at once, past any voice waiting its turn', () => {
    const announcer = new Announcer();
    announcer.add('takenLead');
    announcer.play(1000);
    announcer.add('twoFrag');
    announcer.talk();
    announcer.talk();
    announcer.play(1001);
    expect(announcer.take()).toEqual(['takenLead', 'talk', 'talk']);
  });
});

describe('CG_ParseWarmup and CG_MapRestart', () => {
  it('says prepare when a countdown begins, from waiting or from play', () => {
    const waiting = new Announcer(-1);
    waiting.parseWarmup(15_000, GT.FFA);
    expect(waiting.take()).toEqual(['countPrepare']);

    const playing = new Announcer(0);
    playing.parseWarmup(15_000, GT.FFA);
    expect(playing.take()).toEqual(['countPrepare']);
  });

  it('says nothing for a countdown that is only moved, or for waiting', () => {
    const counting = new Announcer(15_000);
    counting.parseWarmup(20_000, GT.FFA);
    counting.parseWarmup(-1, GT.FFA);
    counting.parseWarmup(0, GT.FFA);
    expect(counting.take()).toEqual([]);
  });

  it('says fight only at the restart a countdown ends in, outside Clan Arena', () => {
    const counting = new Announcer(15_000);
    expect(counting.parseWarmup(0, GT.TEAM)).toBe(false);
    expect(counting.take()).toEqual([]);
  });

  it("says fight when a Clan Arena round's countdown runs out, and not at a restart", () => {
    const round = new Announcer(-1);
    expect(round.parseWarmup(15_000, GT.CA)).toBe(false);
    expect(round.parseWarmup(0, GT.CA)).toBe(true);
    expect(round.take()).toEqual(['countPrepare', 'countFight']);

    // A countdown given up for want of players is not one that ran out.
    const abandoned = new Announcer(15_000);
    expect(abandoned.parseWarmup(-1, GT.CA)).toBe(false);
    expect(abandoned.take()).toEqual([]);
  });

  it('says fight at a restart into play, and not into a warmup', () => {
    const played = new Announcer(0);
    expect(played.mapRestart()).toBe(true);
    expect(played.take()).toEqual(['countFight']);

    const warming = new Announcer(-1);
    expect(warming.mapRestart()).toBe(false);
    expect(warming.take()).toEqual([]);
  });

  it('says fight once a countdown has been cleared by the restart it ends in', () => {
    const announcer = new Announcer(15_000);
    announcer.parseWarmup(0, GT.FFA);
    expect(announcer.mapRestart()).toBe(true);
    expect(announcer.take()).toEqual(['countFight']);
  });

  it('says the limits again in the match a restart begins', () => {
    const announcer = new Announcer();
    const limit = match({ fraglimit: 10, scores1: 9 });
    announcer.checkLocalSounds(state(), state(), limit, 1000);
    announcer.checkLocalSounds(state(), state(), limit, 1000);
    expect(drain(announcer, 1000, 5000)).toEqual(['oneFrag']);

    announcer.mapRestart();
    announcer.take();
    announcer.checkLocalSounds(state(), state(), limit, 1000);
    expect(drain(announcer, 6000, 9000)).toEqual(['oneFrag']);
  });
});

describe("a new gamestate, as CG_Init's memset of cg", () => {
  it('drops the voices waiting, whose turn the last clock timed, and the rewards', () => {
    const announcer = new Announcer();
    announcer.add('takenLead');
    announcer.add('twoFrag');
    expect(drain(announcer, 60_000, 60_000)).toEqual(['takenLead']);
    announcer.rewards.stack = 1;
    announcer.rewards.time = 60_000;

    announcer.reset(0);
    // The new map's clock starts again, far behind the last voice's turn.
    announcer.add('tiedLead');
    expect(drain(announcer, 1000, 1000)).toEqual(['tiedLead']);
    expect([announcer.rewards.stack, announcer.rewards.time]).toEqual([0, 0]);
  });

  it('says the limits again in the new match', () => {
    const announcer = new Announcer();
    const limits = match({ fraglimit: 10, scores1: 9, timelimit: 10 });
    const told = () => {
      announcer.checkLocalSounds(state(), state(), limits, 301_000);
      return drain(announcer, 301_000, 302_000);
    };
    expect(told()).toEqual(['fiveMinute', 'oneFrag']);
    expect(told()).toEqual([]);

    announcer.reset(0);
    expect(told()).toEqual(['fiveMinute', 'oneFrag']);
  });

  it('takes the new warmup without a word, as CG_SetConfigValues does, and reads on', () => {
    const announcer = new Announcer(0);
    announcer.reset(15_000);
    expect(announcer.take()).toEqual([]);
    // A countdown only moved says nothing.
    announcer.parseWarmup(20_000, GT.FFA);
    expect(announcer.take()).toEqual([]);
  });
});

describe('CG_CheckLocalSounds', () => {
  it('beeps for a hit, and differently for a teammate hit', () => {
    const announcer = new Announcer();
    const team = match({ gametype: GT.TEAM });
    announcer.checkLocalSounds(state({ HITS: 3 }), state({ HITS: 2 }), team, 0);
    announcer.checkLocalSounds(state({ HITS: 1 }), state({ HITS: 2 }), team, 0);
    expect(announcer.take()).toEqual(['hit', 'hitTeam']);
  });

  it('beeps the plain hit for a count that falls outside a team game', () => {
    // A restart takes the count back to 0, and the teammate's sound is never registered there.
    const announcer = new Announcer();
    announcer.checkLocalSounds(state({ HITS: 0 }), state({ HITS: 4 }), match(), 0);
    announcer.checkLocalSounds(state({ HITS: 0 }), state({ HITS: 4 }), match({ gametype: GT.TOURNAMENT }), 0);
    expect(announcer.take()).toEqual(['hit', 'hit']);
  });

  it('says nothing at all in the snapshot the team changed', () => {
    const announcer = new Announcer();
    announcer.checkLocalSounds(
      state({ TEAM: TEAM.RED, HITS: 3 }),
      state({ TEAM: TEAM.SPECTATOR, HITS: 2 }),
      match({ gametype: GT.TEAM, fraglimit: 10, scores1: 9 }),
      0
    );
    expect(drain(announcer, 0, 3000)).toEqual([]);
  });

  describe('the lead', () => {
    const lead = (rank: number, before: number, over: Partial<AnnouncerMatch> = {}) => {
      const announcer = new Announcer();
      announcer.checkLocalSounds(state({ RANK: rank }), state({ RANK: before }), match(over), 0);
      return drain(announcer, 1000, 3000);
    };

    it('is taken, tied and lost', () => {
      expect(lead(0, 1)).toEqual(['takenLead']);
      expect(lead(RANK_TIED_FLAG, 1)).toEqual(['tiedLead']);
      expect(lead(1, 0)).toEqual(['lostLead']);
      // Lost from a tie for first, too.
      expect(lead(1, RANK_TIED_FLAG)).toEqual(['lostLead']);
    });

    it('is not told of a move below first', () => {
      expect(lead(2, 1)).toEqual([]);
      expect(lead(1 | RANK_TIED_FLAG, 2)).toEqual([]);
    });

    it('is a free-for-all’s and a tournament’s, not a team game’s', () => {
      expect(lead(0, 1, { gametype: GT.TOURNAMENT })).toEqual(['takenLead']);
      expect(lead(0, 1, { gametype: GT.TEAM })).toEqual([]);
      expect(lead(0, 1, { gametype: GT.CTF })).toEqual([]);
    });

    it('is never told in a warmup', () => {
      const announcer = new Announcer(-1);
      announcer.checkLocalSounds(state({ RANK: 0 }), state({ RANK: 1 }), match(), 0);
      expect(drain(announcer, 1000, 3000)).toEqual([]);
    });
  });

  describe('the time limit', () => {
    /** What the warnings say over a match of `timelimit` minutes, checked each second. */
    const told = (timelimit: number, levelStartTime = 0): string[] => {
      const announcer = new Announcer();
      const heard: string[] = [];
      for (let time = 0; time <= levelStartTime + (timelimit * 60 + 5) * 1000; time += 1000) {
        announcer.checkLocalSounds(state(), state(), match({ timelimit, levelStartTime }), time);
        heard.push(...announcer.take().map((cue) => `${cue}@${time / 1000}`));
      }
      return heard;
    };

    it('warns at five minutes and one minute left, and at sudden death past the limit', () => {
      expect(told(10)).toEqual(['fiveMinute@301', 'oneMinute@541', 'suddenDeath@603']);
    });

    it('has no five-minute warning for a limit of five or less', () => {
      expect(told(5)).toEqual(['oneMinute@241', 'suddenDeath@303']);
    });

    it('counts from the level start', () => {
      expect(told(2, 30_000)).toEqual(['oneMinute@91', 'suddenDeath@153']);
    });
  });

  describe('the frag limit', () => {
    const told = (scores: number[], over: Partial<AnnouncerMatch> = {}): string[] => {
      const announcer = new Announcer();
      for (const score of scores) {
        announcer.checkLocalSounds(state(), state(), match({ fraglimit: 10, scores1: score, ...over }), 0);
      }
      return drain(announcer, 1000, 6000);
    };

    it('counts three, two and one frags left, each once', () => {
      expect(told([6, 7, 7, 8, 9, 9])).toEqual(['threeFrag', 'twoFrag', 'oneFrag']);
    });

    it('marks the earlier ones said when a later one comes first', () => {
      expect(told([9, 7, 8])).toEqual(['oneFrag']);
    });

    it('measures a team deathmatch on the higher team', () => {
      expect(told([3], { gametype: GT.TEAM, scores2: 9 })).toEqual(['oneFrag']);
    });

    it('is not a capture the flag match’s', () => {
      expect(told([9], { gametype: GT.CTF })).toEqual([]);
    });

    it('has no three- or two-frag warning a limit that low cannot reach', () => {
      expect(told([0, 1], { fraglimit: 2 })).toEqual(['oneFrag']);
      expect(told([0, 1, 2], { fraglimit: 3 })).toEqual(['twoFrag', 'oneFrag']);
    });
  });

  it('tells the player who took a flag that they have it, in capture the flag', () => {
    const announcer = new Announcer();
    const ctf = match({ gametype: GT.CTF });
    announcer.checkLocalSounds(state({}, { [PW.BLUEFLAG]: 1 }), state(), ctf, 0);
    // Still held, so nothing new.
    announcer.checkLocalSounds(state({}, { [PW.BLUEFLAG]: 1 }), state({}, { [PW.BLUEFLAG]: 1 }), ctf, 0);
    announcer.checkLocalSounds(state({}, { [PW.REDFLAG]: 1 }), state(), match({ gametype: GT.TEAM }), 0);
    expect(announcer.take()).toEqual(['youHaveFlag']);
  });
});

describe('the rewards', () => {
  /** What the stack holds behind the one showing, oldest first. */
  const waiting = (announcer: Announcer) =>
    announcer.rewards.rewards.slice(1, announcer.rewards.stack + 1);

  it("pushes each counter that moved, in Q3's order, at the count it is now at", () => {
    const announcer = new Announcer();
    announcer.checkLocalSounds(
      state({ ASSIST_COUNT: 1, IMPRESSIVE_COUNT: 3, CAPTURES: 2 }),
      state({ IMPRESSIVE_COUNT: 2, CAPTURES: 1 }),
      match({ gametype: GT.CTF }),
      0
    );
    expect(waiting(announcer)).toEqual([
      { sound: 'captureAward', medal: 'capture', count: 2 },
      { sound: 'impressive', medal: 'impressive', count: 3 },
      { sound: 'assist', medal: 'assist', count: 1 }
    ]);
    // Said as their medals come up, not now.
    expect(announcer.take()).toEqual([]);
  });

  it('names each of the six after its own voice and medal', () => {
    const announcer = new Announcer();
    announcer.checkLocalSounds(
      state({
        EXCELLENT_COUNT: 1,
        GAUNTLET_FRAG_COUNT: 1,
        DEFEND_COUNT: 1
      }),
      state(),
      match(),
      0
    );
    expect(waiting(announcer).map((reward) => `${reward?.sound}/${reward?.medal}`)).toEqual([
      'excellent/excellent',
      'humiliation/gauntlet',
      'defend/defend'
    ]);
  });

  it('pushes a count a restart took back to 0, which is still said', () => {
    const announcer = new Announcer();
    announcer.checkLocalSounds(state(), state({ EXCELLENT_COUNT: 4 }), match(), 0);
    expect(waiting(announcer)).toEqual([{ sound: 'excellent', medal: 'excellent', count: 0 }]);
  });

  it('says a player event at once, the first of its bits to have flipped', () => {
    const said = (now: number, before = 0) => {
      const announcer = new Announcer();
      announcer.checkLocalSounds(
        state({ PLAYEREVENTS: now }),
        state({ PLAYEREVENTS: before }),
        match({ gametype: GT.CTF }),
        0
      );
      return announcer.take();
    };
    expect(said(PLAYEREVENT.DENIEDREWARD)).toEqual(['denied']);
    expect(said(PLAYEREVENT.GAUNTLETREWARD)).toEqual(['humiliation']);
    expect(said(PLAYEREVENT.HOLYSHIT)).toEqual(['holyShit']);
    // Flipped back is a flip too.
    expect(said(0, PLAYEREVENT.GAUNTLETREWARD)).toEqual(['humiliation']);
    expect(said(PLAYEREVENT.GAUNTLETREWARD | PLAYEREVENT.HOLYSHIT)).toEqual(['humiliation']);
    expect(said(PLAYEREVENT.DENIEDREWARD | PLAYEREVENT.GAUNTLETREWARD)).toEqual(['denied']);
    expect(said(PLAYEREVENT.DENIEDREWARD | PLAYEREVENT.HOLYSHIT)).toEqual(['denied']);
  });

  it('holds the lead back for a reward or a player event in the same snapshot', () => {
    const lead = (now: LocalSoundState, before: LocalSoundState) => {
      const announcer = new Announcer();
      announcer.checkLocalSounds(now, before, match(), 0);
      return drain(announcer, 1000, 3000);
    };
    expect(lead(state({ RANK: 0, EXCELLENT_COUNT: 1 }), state({ RANK: 1 }))).toEqual([]);
    expect(
      lead(state({ RANK: 0, PLAYEREVENTS: PLAYEREVENT.DENIEDREWARD }), state({ RANK: 1 }))
    ).toEqual(['denied']);
  });

  it('drops what is waiting at a restart', () => {
    const announcer = new Announcer();
    announcer.checkLocalSounds(state({ IMPRESSIVE_COUNT: 1 }), state(), match(), 0);
    announcer.mapRestart();
    expect(announcer.rewards.stack).toBe(0);
  });
});

describe('EV_GLOBAL_TEAM_SOUND', () => {
  const told = (sound: number, ps: LocalSoundState): string[] => {
    const announcer = new Announcer();
    announcer.teamSound(sound, ps);
    return drain(announcer, 1000, 4000);
  };
  const red = state({ TEAM: TEAM.RED });
  const blue = state({ TEAM: TEAM.BLUE });

  it('tells a capture to each side its own way', () => {
    expect(told(GTS.RED_CAPTURE, red)).toEqual(['captureYourTeam']);
    expect(told(GTS.RED_CAPTURE, blue)).toEqual(['captureOpponent']);
    expect(told(GTS.BLUE_CAPTURE, blue)).toEqual(['captureYourTeam']);
    expect(told(GTS.BLUE_CAPTURE, red)).toEqual(['captureOpponent']);
  });

  it('tells a return with its side, then names the flag', () => {
    expect(told(GTS.RED_RETURN, red)).toEqual(['returnYourTeam', 'blueFlagReturned']);
    expect(told(GTS.RED_RETURN, blue)).toEqual(['returnOpponent', 'blueFlagReturned']);
    expect(told(GTS.BLUE_RETURN, blue)).toEqual(['returnYourTeam', 'redFlagReturned']);
  });

  it('tells a taken flag to both sides, but not to whoever took it', () => {
    expect(told(GTS.RED_TAKEN, blue)).toEqual(['enemyTookYourFlag']);
    expect(told(GTS.RED_TAKEN, red)).toEqual(['yourTeamTookEnemyFlag']);
    expect(told(GTS.BLUE_TAKEN, red)).toEqual(['enemyTookYourFlag']);
    expect(told(GTS.RED_TAKEN, state({ TEAM: TEAM.RED }, { [PW.BLUEFLAG]: 1 }))).toEqual([]);
    expect(told(GTS.BLUE_TAKEN, state({ TEAM: TEAM.BLUE }, { [PW.REDFLAG]: 1 }))).toEqual([]);
    expect(told(GTS.RED_TAKEN, state({ TEAM: TEAM.SPECTATOR }))).toEqual([]);
  });

  it('tells the team scores to everyone alike', () => {
    for (const ps of [red, blue, state({ TEAM: TEAM.SPECTATOR })]) {
      expect(told(GTS.REDTEAM_SCORED, ps)).toEqual(['redScored']);
      expect(told(GTS.BLUETEAM_SCORED, ps)).toEqual(['blueScored']);
      expect(told(GTS.REDTEAM_TOOK_LEAD, ps)).toEqual(['redLeads']);
      expect(told(GTS.BLUETEAM_TOOK_LEAD, ps)).toEqual(['blueLeads']);
      expect(told(GTS.TEAMS_ARE_TIED, ps)).toEqual(['teamsTied']);
    }
  });
});
