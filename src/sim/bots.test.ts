import { describe, expect, it, vi } from 'vitest';

import { infoValueForKey } from '../net/info';
import {
  BOT_SPAWN_QUEUE_DEPTH,
  BotSpawnQueue,
  botInfoByName,
  botModels,
  botUserinfo,
  loadBots,
  MAX_BOTS_TEXT
} from './bots';

/** Two bots as `scripts/bots.txt` writes them, the second with every key a block may carry. */
const BOTS_TXT = `
{
name		Sarge
model		sarge
aifile		bots/sarge_c.c
}
{
name		Crash
funname		^1Crash
model		crash/red
headmodel	major
gender		female
color1		1
color2		2
aifile		bots/crash_c.c
}
`;

describe('loadBots', () => {
  it('loads bots.txt and then each .bot file, and says how many', () => {
    const print = vi.fn();
    const infos = loadBots(
      [
        { path: 'scripts/bots.txt', text: BOTS_TXT },
        { path: 'scripts/extra.bot', text: '{ name Grunt model grunt aifile bots/grunt_c.c }' }
      ],
      print
    );
    expect(infos.map((info) => infoValueForKey(info, 'name'))).toEqual(['Sarge', 'Crash', 'Grunt']);
    expect(print).toHaveBeenCalledWith('3 bots parsed');
  });

  it('skips a missing file and one too large, with Q3 words', () => {
    const print = vi.fn();
    const huge = `{ name Big }${' '.repeat(MAX_BOTS_TEXT)}`;
    const infos = loadBots(
      [
        { path: 'scripts/bots.txt', text: undefined },
        { path: 'scripts/huge.bot', text: huge }
      ],
      print
    );
    expect(infos).toEqual([]);
    expect(print.mock.calls.map(([line]) => line)).toEqual([
      'file not found: scripts/bots.txt',
      `file too large: scripts/huge.bot is ${huge.length}, max allowed is ${MAX_BOTS_TEXT}`,
      '0 bots parsed'
    ]);
  });
});

describe('botInfoByName', () => {
  const infos = loadBots([{ path: 'scripts/bots.txt', text: BOTS_TXT }], () => {});

  it('finds a bot by its name, whatever the case, and not by its funname', () => {
    expect(infoValueForKey(botInfoByName(infos, 'sARGE')!, 'model')).toBe('sarge');
    expect(botInfoByName(infos, '^1Crash')).toBeNull();
    expect(botInfoByName(infos, 'Doom')).toBeNull();
  });
});

describe('botModels', () => {
  it("dresses a bot in its model and head, the body's model for a head it lacks, and visor's for neither", () => {
    const infos = loadBots([{ path: 'scripts/bots.txt', text: BOTS_TXT }], () => {});
    expect(botModels(botInfoByName(infos, 'Crash')!)).toEqual({ model: 'crash/red', headmodel: 'major' });
    expect(botModels(botInfoByName(infos, 'Sarge')!)).toEqual({ model: 'sarge', headmodel: 'sarge' });
    expect(botModels('\\name\\Blank')).toEqual({ model: 'visor/default', headmodel: 'visor/default' });
  });
});

describe('botUserinfo', () => {
  const infos = loadBots([{ path: 'scripts/bots.txt', text: BOTS_TXT }], () => {});
  const sarge = botInfoByName(infos, 'Sarge')!;
  const crash = botInfoByName(infos, 'Crash')!;

  function userinfo(botinfo: string, skill = 4, team = 'free', altname = ''): string {
    const built = botUserinfo(botinfo, { skill, team, altname });
    if ('error' in built) throw new Error(built.error);
    return built.userinfo;
  }

  it("fills in Q3's defaults for what a block leaves out", () => {
    const info = userinfo(sarge);
    const keys = [
      'name',
      'rate',
      'snaps',
      'skill',
      'teampref',
      'handicap',
      'model',
      'team_model',
      'headmodel',
      'team_headmodel',
      'sex',
      'color1',
      'color2',
      'characterfile',
      'teamoverlay'
    ];
    expect(Object.fromEntries(keys.map((key) => [key, infoValueForKey(info, key)]))).toEqual({
      name: 'Sarge',
      rate: '25000',
      snaps: '20',
      skill: '4.00',
      teampref: 'free',
      // A bot of skill 4 or more has the whole of its health.
      handicap: '',
      model: 'sarge',
      team_model: 'sarge',
      headmodel: 'sarge',
      team_headmodel: 'sarge',
      sex: 'male',
      color1: '4',
      color2: '5',
      characterfile: 'bots/sarge_c.c',
      teamoverlay: '0'
    });
  });

  it("takes a block's own funname, head, gender and colours", () => {
    const info = userinfo(crash);
    expect(infoValueForKey(info, 'name')).toBe('^1Crash');
    expect(infoValueForKey(info, 'model')).toBe('crash/red');
    expect(infoValueForKey(info, 'headmodel')).toBe('major');
    expect(infoValueForKey(info, 'team_headmodel')).toBe('major');
    expect(infoValueForKey(info, 'sex')).toBe('female');
    expect(infoValueForKey(info, 'color1')).toBe('1');
    expect(infoValueForKey(info, 'color2')).toBe('2');
  });

  it("goes by the name addbot gives it, over its own", () => {
    expect(infoValueForKey(userinfo(crash, 4, 'free', 'Dummy'), 'name')).toBe('Dummy');
  });

  it('takes health away from a weaker bot', () => {
    const handicap = (skill: number) => infoValueForKey(userinfo(sarge, skill), 'handicap');
    const skills = [1, 1.5, 2, 3, 3.99, 4, 5];
    expect(skills.map(handicap)).toEqual(['50', '50', '70', '90', '90', '', '']);
    expect(infoValueForKey(userinfo(sarge, 2.5), 'skill')).toBe('2.50');
  });

  it("wears Q3's own default model when its block names none", () => {
    const info = userinfo('\\name\\Blank\\aifile\\bots/blank_c.c');
    expect(infoValueForKey(info, 'model')).toBe('visor/default');
    expect(infoValueForKey(info, 'headmodel')).toBe('visor/default');
  });

  it('refuses a bot with no AI file', () => {
    const request = { skill: 4, team: 'free', altname: '' };
    expect(botUserinfo('\\name\\Blank\\model\\sarge', request)).toEqual({
      error: 'Error: bot has no aifile specified'
    });
  });
});

describe('BotSpawnQueue', () => {
  it('lets each bot begin once its time has come, and not before', () => {
    const queue = new BotSpawnQueue();
    expect(queue.add(1, 500)).toBe(true);
    expect(queue.add(2, 300)).toBe(true);
    expect(queue.due(299)).toEqual([]);
    expect(queue.due(300)).toEqual([2]);
    expect(queue.due(1000)).toEqual([1]);
    expect(queue.due(2000)).toEqual([]);
  });

  it('forgets a bot that left before its time', () => {
    const queue = new BotSpawnQueue();
    queue.add(3, 500);
    queue.remove(3);
    expect(queue.due(1000)).toEqual([]);
  });

  it('says when it is full, so the bot can begin at once instead', () => {
    const queue = new BotSpawnQueue();
    for (let i = 0; i < BOT_SPAWN_QUEUE_DEPTH; i++) expect(queue.add(i, 100)).toBe(true);
    expect(queue.add(99, 100)).toBe(false);
    queue.clear();
    expect(queue.due(1000)).toEqual([]);
    expect(queue.add(99, 100)).toBe(true);
  });
});
