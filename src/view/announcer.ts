import { ANNOUNCER_SOUNDS } from '../formats/asset-manifest';
import { GT, PERS, PLAYEREVENT, RANK_TIED_FLAG, TEAM } from '../sim/constants';
import { GTS } from '../sim/events';
import { PW } from '../sim/items';
import {
  clearRewards,
  createRewardState,
  pushReward,
  type Medal,
  type RewardState
} from './rewards';

/**
 * cgame's announcer: the match's voices, the rewards, the hit beeps and chat's talk sound, which
 * Quake 3 plays as local sounds — unplaced, at full volume — rather than from anywhere in the
 * world. Engine-free.
 *
 * Some start at once. The news queues in `cg.soundBuffer`, which lets one out every 750 ms, so that
 * two pieces of it never talk over each other (`cg_view.c:720–750`); a reward waits on its own
 * stack, and is said as its medals come up.
 */

/** One of the voices, by the name cgame's media keeps it under. */
export type AnnouncerCue = keyof typeof ANNOUNCER_SOUNDS;

/** `MAX_SOUNDBUFFER` (`cg_local.h:442`). */
export const MAX_SOUNDBUFFER = 20;

/** How long a buffered voice has to itself before the next is let out (`cg_view.c:747`). */
export const BUFFERED_SOUND_GAP = 750;

/**
 * The counters a reward is heard in, in `CG_CheckLocalSounds`' order (`cg_playerstate.c:344–402`),
 * with each one's voice and medal.
 */
const REWARDS: readonly (readonly [number, AnnouncerCue, Medal])[] = [
  [PERS.CAPTURES, 'captureAward', 'capture'],
  [PERS.IMPRESSIVE_COUNT, 'impressive', 'impressive'],
  [PERS.EXCELLENT_COUNT, 'excellent', 'excellent'],
  [PERS.GAUNTLET_FRAG_COUNT, 'humiliation', 'gauntlet'],
  [PERS.DEFEND_COUNT, 'defend', 'defend'],
  [PERS.ASSIST_COUNT, 'assist', 'assist']
];

/** The part of a player state that `CG_CheckLocalSounds` compares. */
export interface LocalSoundState {
  persistant: readonly number[];
  powerups: readonly number[];
}

/** What `cgs` holds of the match, which the limits' warnings are measured against. */
export interface AnnouncerMatch {
  gametype: number;
  /** `cgs.fraglimit`, or 0 for none. */
  fraglimit: number;
  /** `cgs.timelimit`, in minutes, or 0 for none. */
  timelimit: number;
  /** `cgs.levelStartTime`: when the match began, on the server's clock. */
  levelStartTime: number;
  /** `cgs.scores1` and `cgs.scores2`: the top two scores, or the two teams'. */
  scores1: number;
  scores2: number;
}

export class Announcer {
  /** `cg.soundBuffer`, and where it is written and read. */
  private readonly buffer = new Array<AnnouncerCue | null>(MAX_SOUNDBUFFER).fill(null);
  private bufferIn = 0;
  private bufferOut = 0;
  /** `cg.soundTime`: when the next buffered voice may be let out. */
  private soundTime = 0;
  /** `cg.fraglimitWarnings`: 1, 2 and 4 once three, two and one frags left have been said. */
  private fraglimitWarnings = 0;
  /** `cg.timelimitWarnings`: 1, 2 and 4 once five minutes, one minute and sudden death have. */
  private timelimitWarnings = 0;
  /** `cg.warmup`, as `CG_ParseWarmup` last read `CS_WARMUP`. */
  private warmup: number;
  /** The voices started since {@link take} was last asked, oldest first. */
  private started: AnnouncerCue[] = [];
  /** `cg.rewardStack` and its arrays: the rewards waiting for the row at the top of the screen. */
  readonly rewards: RewardState = createRewardState();

  /**
   * @param warmup - `CS_WARMUP` as the client starts, which is taken without a word
   *   (`CG_SetConfigValues`, `cg_servercmds.c:230`).
   */
  constructor(warmup = 0) {
    this.warmup = warmup;
  }

  /** The voices started since this was last asked, oldest first. */
  take(): AnnouncerCue[] {
    const started = this.started;
    this.started = [];
    return started;
  }

  /** `CG_ServerCommand`'s talk sound, started at once as a chat line comes in. */
  talk(): void {
    this.started.push('talk');
  }

  /**
   * `CG_AddBufferedSound` (`cg_view.c:726–734`): a voice that waits its turn.
   *
   * A full ring drops its oldest voice. Quake 3's does that by stepping its read index on with the
   * one increment there that does not wrap, which can leave it past the end; this one wraps.
   */
  add(cue: AnnouncerCue): void {
    this.buffer[this.bufferIn] = cue;
    this.bufferIn = (this.bufferIn + 1) % MAX_SOUNDBUFFER;
    if (this.bufferIn === this.bufferOut) this.bufferOut = (this.bufferOut + 1) % MAX_SOUNDBUFFER;
  }

  /**
   * `CG_PlayBufferedSounds` (`cg_view.c:741–751`): let the next buffered voice out, once the last
   * has had its time. Run once a frame, on the frame's clock.
   */
  play(time: number): void {
    if (this.soundTime >= time) return;
    const cue = this.buffer[this.bufferOut];
    if (this.bufferOut === this.bufferIn || cue === null) return;
    this.started.push(cue);
    this.buffer[this.bufferOut] = null;
    this.bufferOut = (this.bufferOut + 1) % MAX_SOUNDBUFFER;
    this.soundTime = time + BUFFERED_SOUND_GAP;
  }

  /**
   * `CG_ParseWarmup` (`cg_servercmds.c:181–202`): "prepare" when a countdown begins, whether the
   * match was waiting for players or being played.
   *
   * Clan Arena's rounds are counted down in the same value, and CPMA's client says "fight" when a
   * countdown has run out rather than at a restart.
   *
   * @param gametype - `g_gametype`, as the serverinfo has it.
   * @returns whether it said "fight", which is when "FIGHT!" goes up in the middle of the screen.
   */
  parseWarmup(warmup: number, gametype: number): boolean {
    const fight = gametype === GT.CA && warmup === 0 && this.warmup > 0;
    if (warmup > 0 && this.warmup <= 0) this.started.push('countPrepare');
    if (fight) this.started.push('countFight');
    this.warmup = warmup;
    return fight;
  }

  /**
   * `CG_MapRestart`'s share (`cg_servercmds.c:466–489`): the limits' warnings are said again in
   * the match that starts, the rewards waiting are dropped, and "fight" is said if the match starts
   * at once rather than into a warmup.
   *
   * @returns whether it said "fight", which is when "FIGHT!" goes up in the middle of the screen.
   */
  mapRestart(): boolean {
    this.fraglimitWarnings = 0;
    this.timelimitWarnings = 0;
    clearRewards(this.rewards);
    if (this.warmup !== 0) return false;
    this.started.push('countFight');
    return true;
  }

  /**
   * `CG_Init`'s memset of `cg` at a new gamestate (`cg_main.c:1851`): the voices waiting and the
   * rewards go, the limits' warnings are said again, and the gamestate's `CS_WARMUP` is taken
   * without a word (`CG_SetConfigValues`, `cg_servercmds.c:230`).
   */
  reset(warmup: number): void {
    this.bufferIn = 0;
    this.bufferOut = 0;
    this.soundTime = 0;
    this.fraglimitWarnings = 0;
    this.timelimitWarnings = 0;
    this.warmup = warmup;
    clearRewards(this.rewards);
  }

  /**
   * `CG_CheckLocalSounds` (`cg_playerstate.c:300–489`): what a new player state has to say that
   * the last did not. Its pain is the player's own events'.
   *
   * `CG_TransitionPlayerState` asks only below the intermission and off the spectator team
   * (`cg_playerstate.c:519–522`), which is the caller's to test. Its return "if we are going into
   * the intermission" never fires, since ioq3's cgame never raises the flag it reads.
   *
   * @param ps - The state just taken.
   * @param ops - The one before it, which is the same one when the view has just moved to
   *   somebody else's.
   * @param match - The mode, the limits, and the scores they are measured on.
   * @param time - `cg.time`: the snapshot's.
   */
  checkLocalSounds(
    ps: LocalSoundState,
    ops: LocalSoundState,
    match: AnnouncerMatch,
    time: number
  ): void {
    // "don't play the sounds if the player just changed teams"
    if (ps.persistant[PERS.TEAM] !== ops.persistant[PERS.TEAM]) return;

    // A hit raises `PERS_HITS` and a teammate's lowers it (`g_combat.c:919–927`), and so does a
    // restart, which starts it again from 0. Outside a team game `hitTeamSound` is never
    // registered (`cg_main.c:565–571`), and the handle it keeps, 0, is the mixer's first sound,
    // which ioq3 makes `hit.wav` (`snd_dma.c:402`).
    if (ps.persistant[PERS.HITS] > ops.persistant[PERS.HITS]) this.started.push('hit');
    else if (ps.persistant[PERS.HITS] < ops.persistant[PERS.HITS]) {
      this.started.push(match.gametype >= GT.TEAM ? 'hitTeam' : 'hit');
    }

    // Each reward counter that moved pushes its voice and its medal, at the count it is now at —
    // which a restart takes back to 0, and is still said. A player event is said at once, the
    // first of its bits to have flipped (`cg_playerstate.c:403–418`). Either holds the lead's news
    // back.
    let reward = false;
    for (const [pers, sound, medal] of REWARDS) {
      if (ps.persistant[pers] === ops.persistant[pers]) continue;
      pushReward(this.rewards, { sound, medal, count: ps.persistant[pers] });
      reward = true;
    }
    const flipped = ps.persistant[PERS.PLAYEREVENTS] ^ ops.persistant[PERS.PLAYEREVENTS];
    if (flipped) {
      if (flipped & PLAYEREVENT.DENIEDREWARD) this.started.push('denied');
      else if (flipped & PLAYEREVENT.GAUNTLETREWARD) this.started.push('humiliation');
      else if (flipped & PLAYEREVENT.HOLYSHIT) this.started.push('holyShit');
      reward = true;
    }

    // "check for flag pickup". Team Arena's neutral flag is the third Quake 3 looks at.
    if (match.gametype > GT.TEAM) {
      const took = (flag: number) => ps.powerups[flag] !== ops.powerups[flag] && ps.powerups[flag];
      if (took(PW.REDFLAG) || took(PW.BLUEFLAG)) this.started.push('youHaveFlag');
    }

    // "never play lead changes during warmup", and only in the modes a player leads alone.
    const rank = ps.persistant[PERS.RANK];
    const moved = rank !== ops.persistant[PERS.RANK];
    if (!reward && !this.warmup && moved && match.gametype < GT.TEAM) {
      if (rank === 0) this.add('takenLead');
      else if (rank === RANK_TIED_FLAG) this.add('tiedLead');
      else if ((ops.persistant[PERS.RANK] & ~RANK_TIED_FLAG) === 0) this.add('lostLead');
    }

    // Each warning is said once, and a later one marks the earlier ones said.
    if (match.timelimit > 0) {
      const msec = time - match.levelStartTime;
      if (!(this.timelimitWarnings & 4) && msec > (match.timelimit * 60 + 2) * 1000) {
        this.timelimitWarnings |= 1 | 2 | 4;
        this.started.push('suddenDeath');
      } else if (!(this.timelimitWarnings & 2) && msec > (match.timelimit - 1) * 60 * 1000) {
        this.timelimitWarnings |= 1 | 2;
        this.started.push('oneMinute');
      } else if (
        match.timelimit > 5 &&
        !(this.timelimitWarnings & 1) &&
        msec > (match.timelimit - 5) * 60 * 1000
      ) {
        this.timelimitWarnings |= 1;
        this.started.push('fiveMinute');
      }
    }

    // Capture the Flag is played to its capture limit, so the frags are not counted down.
    if (match.fraglimit > 0 && match.gametype < GT.CTF) {
      let highScore = match.scores1;
      if (match.gametype === GT.TEAM && match.scores2 > highScore) highScore = match.scores2;
      if (!(this.fraglimitWarnings & 4) && highScore === match.fraglimit - 1) {
        this.fraglimitWarnings |= 1 | 2 | 4;
        this.add('oneFrag');
      } else if (
        match.fraglimit > 2 &&
        !(this.fraglimitWarnings & 2) &&
        highScore === match.fraglimit - 2
      ) {
        this.fraglimitWarnings |= 1 | 2;
        this.add('twoFrag');
      } else if (
        match.fraglimit > 3 &&
        !(this.fraglimitWarnings & 1) &&
        highScore === match.fraglimit - 3
      ) {
        this.fraglimitWarnings |= 1;
        this.add('threeFrag');
      }
    }
  }

  /**
   * `EV_GLOBAL_TEAM_SOUND` (`cg_event.c:1037–1150`): a flag's news, told to each side its own
   * way, and the team scores'. All of it waits its turn.
   *
   * A taken flag is not announced to the player who took it: "you have the flag" is theirs
   * instead. Team Arena's neutral flag is the other flag Quake 3 looks for there.
   *
   * @param sound - The event's `GTS_*`.
   * @param ps - `cg.snap->ps`: whose side the news is told to.
   */
  teamSound(sound: number, ps: LocalSoundState): void {
    const team = ps.persistant[PERS.TEAM];
    switch (sound) {
      case GTS.RED_CAPTURE:
        this.add(team === TEAM.RED ? 'captureYourTeam' : 'captureOpponent');
        break;
      case GTS.BLUE_CAPTURE:
        this.add(team === TEAM.BLUE ? 'captureYourTeam' : 'captureOpponent');
        break;
      case GTS.RED_RETURN:
        this.add(team === TEAM.RED ? 'returnYourTeam' : 'returnOpponent');
        this.add('blueFlagReturned');
        break;
      case GTS.BLUE_RETURN:
        this.add(team === TEAM.BLUE ? 'returnYourTeam' : 'returnOpponent');
        this.add('redFlagReturned');
        break;
      case GTS.RED_TAKEN:
        if (ps.powerups[PW.BLUEFLAG]) break;
        if (team === TEAM.BLUE) this.add('enemyTookYourFlag');
        else if (team === TEAM.RED) this.add('yourTeamTookEnemyFlag');
        break;
      case GTS.BLUE_TAKEN:
        if (ps.powerups[PW.REDFLAG]) break;
        if (team === TEAM.RED) this.add('enemyTookYourFlag');
        else if (team === TEAM.BLUE) this.add('yourTeamTookEnemyFlag');
        break;
      case GTS.REDTEAM_SCORED:
        this.add('redScored');
        break;
      case GTS.BLUETEAM_SCORED:
        this.add('blueScored');
        break;
      case GTS.REDTEAM_TOOK_LEAD:
        this.add('redLeads');
        break;
      case GTS.BLUETEAM_TOOK_LEAD:
        this.add('blueLeads');
        break;
      case GTS.TEAMS_ARE_TIED:
        this.add('teamsTied');
        break;
    }
  }
}
