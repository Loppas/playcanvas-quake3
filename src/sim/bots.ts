import { loadInfos, type InfoFile } from '../formats/arena';
import { infoSetValueForKey, infoValueForKey } from '../net/info';

/**
 * Bots, as Quake 3's `g_bot.c` has them, as far as a bot with no AI needs: the bot files, the
 * userinfo a bot joins with, and the queue a bot waits in when `addbot` gives it a delay.
 *
 * A bot's AI needs the map's AAS, which a splat map has not got, so nothing here thinks for one.
 * A bot is a client whose commands come from the game module rather than from a connection, and
 * with no AI those commands are empty.
 */

/** The bot file read first, where the cvar `g_botsFile` names none (`g_bot.c:946–952`). */
export const BOTS_FILE = 'scripts/bots.txt';

/** `MAX_BOTS` (`bg_public.h:718`): the bots that may be loaded together. */
export const MAX_BOTS = 1024;

/** `MAX_BOTS_TEXT` (`bg_public.h:719`): a bot file's size, and one for its NUL. */
export const MAX_BOTS_TEXT = 8192;

/** The room for `.bot` names in `G_LoadBots`' `dirlist`, in bytes (`g_bot.c:936, 956`). */
export const BOT_LIST = 1024;

/** `BOT_SPAWN_QUEUE_DEPTH` (`g_bot.c:39`): how many bots may wait to begin at once. */
export const BOT_SPAWN_QUEUE_DEPTH = 16;

/**
 * `G_LoadBots` (`g_bot.c:932–965`) over files already read: `scripts/bots.txt`, then every
 * `scripts/*.bot` in the order the file system lists them.
 *
 * @param files - The files, in the order Q3 loads them.
 * @param print - Where Q3's console messages go.
 * @returns each bot's info string
 */
export function loadBots(files: readonly InfoFile[], print: (message: string) => void): string[] {
  const infos = loadInfos(files, MAX_BOTS, MAX_BOTS_TEXT, print);
  print(`${infos.length} bots parsed`);
  return infos;
}

/**
 * `G_GetBotInfoByName` (`g_bot.c:988–1000`): the bot whose `name` is this one, matched without
 * regard to case.
 *
 * @returns the first such bot's info string, or `null`
 */
export function botInfoByName(infos: readonly string[], name: string): string | null {
  const wanted = name.toLowerCase();
  return infos.find((info) => infoValueForKey(info, 'name').toLowerCase() === wanted) ?? null;
}

/**
 * The models `G_AddBot` dresses a bot in (`g_bot.c:653–731`): its `model`, or visor's, and its
 * `headmodel`, or the body's model. Each is a model's name with its skin after a slash.
 */
export function botModels(botinfo: string): { model: string; headmodel: string } {
  const model = infoValueForKey(botinfo, 'model') || 'visor/default';
  return { model, headmodel: infoValueForKey(botinfo, 'headmodel') || model };
}

/** What `addbot` asks for, past the bot's name. */
export interface BotRequest {
  /** 1 to 5. */
  skill: number;
  /** The team it prefers, which `G_AddBot` has already chosen when none was given. */
  team: string;
  /** A name to go by instead of the bot's own, or `''`. */
  altname: string;
}

/**
 * The userinfo `G_AddBot` builds for a bot (`g_bot.c:653–731`): the name it goes by, the model it
 * wears, and a handicap by its skill.
 *
 * @param botinfo - The bot's block from the bot files.
 * @param request - Its skill, team and name, from `addbot`.
 * @returns the userinfo, or the error Q3 prints for a bot with no AI file
 */
export function botUserinfo(
  botinfo: string,
  request: BotRequest
): { userinfo: string } | { error: string } {
  const { skill, team, altname } = request;
  let userinfo = '';
  const set = (key: string, value: string) => {
    userinfo = infoSetValueForKey(userinfo, key, value);
  };

  const funname = infoValueForKey(botinfo, 'funname');
  set('name', altname || funname || infoValueForKey(botinfo, 'name'));
  set('rate', '25000');
  set('snaps', '20');
  set('skill', skill.toFixed(2));
  set('teampref', team);

  // The weaker a bot, the less health it has to lose.
  if (skill >= 1 && skill < 2) set('handicap', '50');
  else if (skill >= 2 && skill < 3) set('handicap', '70');
  else if (skill >= 3 && skill < 4) set('handicap', '90');

  const { model, headmodel } = botModels(botinfo);
  set('model', model);
  set('team_model', model);
  set('headmodel', headmodel);
  set('team_headmodel', headmodel);

  set('sex', infoValueForKey(botinfo, 'gender') || 'male');
  set('color1', infoValueForKey(botinfo, 'color1') || '4');
  set('color2', infoValueForKey(botinfo, 'color2') || '5');

  const aifile = infoValueForKey(botinfo, 'aifile');
  if (!aifile) return { error: 'Error: bot has no aifile specified' };
  set('characterfile', aifile);

  // A bot is not sent the team overlay, because it cannot read it.
  set('teamoverlay', '0');
  return { userinfo };
}

/**
 * `botSpawnQueue` (`g_bot.c:41–46`): the bots `addbot` gave a delay, waiting to begin.
 *
 * A slot is free while its time is 0. A slot keeps its client number once it is free, which is
 * why {@link remove} can land on a free slot and leave a waiting one alone: it takes the first
 * slot with the number, as Q3's does.
 */
export class BotSpawnQueue {
  private readonly slots = Array.from({ length: BOT_SPAWN_QUEUE_DEPTH }, () => ({
    clientNum: 0,
    spawnTime: 0
  }));

  /**
   * `AddBotToSpawnQueue` (`g_bot.c:519–531`): hold this bot until the time.
   *
   * @returns false when the queue is full, and the bot must begin at once
   */
  add(clientNum: number, spawnTime: number): boolean {
    const slot = this.slots.find((each) => !each.spawnTime);
    if (!slot) return false;
    slot.spawnTime = spawnTime;
    slot.clientNum = clientNum;
    return true;
  }

  /**
   * `G_CheckBotSpawn`'s loop (`g_bot.c:496–510`): the bots whose time has come, in the queue's
   * order, each taken off it.
   */
  due(time: number): number[] {
    const due: number[] = [];
    for (const slot of this.slots) {
      if (!slot.spawnTime || slot.spawnTime > time) continue;
      due.push(slot.clientNum);
      slot.spawnTime = 0;
    }
    return due;
  }

  /** `G_RemoveQueuedBotBegin` (`g_bot.c:543–552`): a bot that left before its time. */
  remove(clientNum: number): void {
    const slot = this.slots.find((each) => each.clientNum === clientNum);
    if (slot) slot.spawnTime = 0;
  }

  /** Empty, as a game module loaded afresh starts it. */
  clear(): void {
    for (const slot of this.slots) {
      slot.clientNum = 0;
      slot.spawnTime = 0;
    }
  }
}
