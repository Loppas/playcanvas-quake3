import { describe, expect, it, vi } from 'vitest';

import { infoValueForKey } from '../net/info';
import { GT } from '../sim/constants';
import { gametypeBits, gametypeMaps, menuArenas, shownMapName } from './arena-list';

/** An arena's info string, with the read-order `num` `loadArenas` gives it. */
function arena(map: string, type?: string, special?: string, num = 0): string {
  return [
    ...(special === undefined ? [] : [`\\special\\${special}`]),
    ...(type === undefined ? [] : [`\\type\\${type}`]),
    `\\map\\${map}\\num\\${num}`
  ].join('');
}

const maps = (infos: readonly string[]) => infos.map((info) => infoValueForKey(info, 'map'));
const nums = (infos: readonly string[]) => infos.map((info) => infoValueForKey(info, 'num'));

describe('menuArenas', () => {
  it("puts Single Player's arenas first, then the specials, then the rest as read", () => {
    const infos = [
      arena('dm_a', 'ffa'),
      arena('q3dm0', 'single', 'training'),
      arena('q3dm1', 'single ffa'),
      arena('dm_b', 'team'),
      arena('q3dm2', 'single'),
      arena('q3tourney1', 'tourney single'),
      arena('q3tourney6', 'single', 'final'),
      arena('q3dm3', 'single')
    ];
    const ordered = menuArenas(infos, () => {});
    expect(maps(ordered)).toEqual([
      'q3dm1',
      'q3dm2',
      'q3tourney1',
      'q3dm3',
      'q3dm0',
      'q3tourney6',
      'dm_a',
      'dm_b'
    ]);
    expect(nums(ordered)).toEqual(['0', '1', '2', '3', '4', '5', '6', '7']);
  });

  it('numbers an arena with no type among the rest', () => {
    const singles = ['s1', 's2', 's3', 's4'].map((map) => arena(map, 'single'));
    const ordered = menuArenas([arena('bare'), ...singles, arena('dm', 'ffa')], () => {});
    expect(maps(ordered)).toEqual(['s1', 's2', 's3', 's4', 'bare', 'dm']);
  });

  it("finds Single Player's anywhere in the type, as strstr does, and only in lower case", () => {
    const ordered = menuArenas(
      [
        arena('upper', 'SINGLE'),
        arena('s1', 'single'),
        arena('s2', 'single'),
        arena('s3', 'single'),
        arena('inside', 'nosingles')
      ],
      () => {}
    );
    expect(maps(ordered)).toEqual(['s1', 's2', 's3', 'inside', 'upper']);
  });

  it('cuts the count to whole tiers, saying so, and keeps every arena where two share a number', () => {
    const print = vi.fn();
    const infos = [
      arena('s1', 'single'),
      arena('s2', 'single'),
      arena('s3', 'single'),
      arena('s4', 'single'),
      arena('s5', 'single'),
      arena('sp', 'single', 'final'),
      arena('dm', 'ffa')
    ];
    const ordered = menuArenas(infos, print);
    expect(print).toHaveBeenCalledWith('1 arenas ignored to make count divisible by 4');
    // s5 is 4, as is the special numbered from the cut count; the one read first comes first.
    expect(maps(ordered)).toEqual(['s1', 's2', 's3', 's4', 's5', 'sp', 'dm']);
    expect(nums(ordered)).toEqual(['0', '1', '2', '3', '4', '4', '5']);
  });

  it('says nothing where the count is whole tiers', () => {
    const print = vi.fn();
    menuArenas([arena('dm', 'ffa')], print);
    expect(print).not.toHaveBeenCalled();
  });
});

describe('gametypeBits', () => {
  it("reads each game the type names, without regard to case, Clan Arena's among them", () => {
    expect(gametypeBits('ffa tourney team')).toBe((1 << GT.FFA) | (1 << GT.TOURNAMENT) | (1 << GT.TEAM));
    expect(gametypeBits('CTF Single')).toBe((1 << GT.CTF) | (1 << GT.SINGLE_PLAYER));
    expect(gametypeBits('clanarena')).toBe(1 << GT.CA);
  });

  it('names nothing for no type, or words it does not know', () => {
    expect(gametypeBits('')).toBe(0);
    expect(gametypeBits('oneflag harvester')).toBe(0);
  });
});

describe('gametypeMaps', () => {
  const ordered = [
    arena('q3dm1', 'single ffa'),
    arena('q3tourney2', 'single tourney'),
    arena('q3ctf1', 'ctf'),
    arena('garage_cats', 'ffa tourney team clanarena'),
    arena('bare')
  ];

  it("lists Single Player's under Free For All, in the arenas' order", () => {
    expect(gametypeMaps(ordered, GT.FFA)).toEqual(['q3dm1', 'q3tourney2', 'garage_cats']);
  });

  it('lists the maps each other game type names', () => {
    expect(gametypeMaps(ordered, GT.TOURNAMENT)).toEqual(['q3tourney2', 'garage_cats']);
    expect(gametypeMaps(ordered, GT.TEAM)).toEqual(['garage_cats']);
    expect(gametypeMaps(ordered, GT.CTF)).toEqual(['q3ctf1']);
    expect(gametypeMaps(ordered, GT.CA)).toEqual(['garage_cats']);
  });
});

describe('shownMapName', () => {
  it("cuts a name to q3_ui's fifteen characters, in capitals", () => {
    expect(shownMapName('q3dm17')).toBe('Q3DM17');
    expect(shownMapName('orichalcianebot')).toBe('ORICHALCIANEBOT');
    expect(shownMapName('a_very_long_map_name')).toBe('A_VERY_LONG_MAP');
  });
});
