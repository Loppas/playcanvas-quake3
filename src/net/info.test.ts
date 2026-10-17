import { describe, expect, it, vi } from 'vitest';

import {
  MAX_INFO_STRING,
  infoPairs,
  infoPrintLines,
  infoRemoveKey,
  infoRemoveKeyBig,
  infoSetValueForKey,
  infoSetValueForKeyBig,
  infoValidate,
  infoValueForKey
} from './info';
import { BIG_INFO_STRING } from './msg';

describe('infoPrintLines', () => {
  it('prints a pair to a line, the key padded to twenty and never cut', () => {
    const long = 'a_key_longer_than_twenty';
    expect(infoPrintLines(`\\mapname\\q3dm17\\${long}\\1\\`)).toEqual([
      `${'mapname'.padEnd(20)} q3dm17`,
      `${long} 1`
    ]);
  });

  it('ends at a key with no value', () => {
    expect(infoPrintLines('\\a\\1\\b')).toEqual([
      `${'a'.padEnd(20)} 1`,
      `${'b'.padEnd(20)} MISSING VALUE`
    ]);
    expect(infoPrintLines('')).toEqual([]);
  });
});

describe('infoValueForKey', () => {
  it('finds a key without regard to case, as Q_stricmp does', () => {
    expect(infoValueForKey('\\map\\q3dm17\\type\\ffa', 'MAP')).toBe('q3dm17');
    expect(infoValueForKey('\\Map\\q3dm17', 'map')).toBe('q3dm17');
  });

  it('gives an empty string for a key that is not there, or has no value', () => {
    expect(infoValueForKey('\\map\\q3dm17', 'type')).toBe('');
    expect(infoValueForKey('\\map\\q3dm17\\type', 'type')).toBe('');
    expect(infoValueForKey('', 'map')).toBe('');
  });
});

describe('infoRemoveKey', () => {
  it('takes out the first pair whose key matches, and leaves the rest as they were', () => {
    expect(infoRemoveKey('\\a\\1\\b\\2\\c\\3', 'B')).toBe('\\a\\1\\c\\3');
    expect(infoRemoveKey('\\a\\1', 'a')).toBe('');
    expect(infoRemoveKey('\\a\\1', 'z')).toBe('\\a\\1');
  });
});

describe('infoSetValueForKey', () => {
  it('puts the new pair first, as Q3 does', () => {
    let info = infoSetValueForKey('', 'name', 'Sarge');
    info = infoSetValueForKey(info, 'model', 'sarge/krusade');
    expect(info).toBe('\\model\\sarge/krusade\\name\\Sarge');
  });

  it('replaces a key wherever it was, matching it without regard to case', () => {
    const info = infoSetValueForKey('\\name\\Sarge\\model\\sarge', 'NAME', 'Grunt');
    expect(info).toBe('\\NAME\\Grunt\\model\\sarge');
  });

  it('removes a key set to an empty value', () => {
    expect(infoSetValueForKey('\\name\\Sarge\\model\\sarge', 'name', '')).toBe('\\model\\sarge');
  });

  it("refuses a backslash, a semicolon or a quote with Q3's message, and changes nothing", () => {
    const warn = vi.fn();
    for (const [key, value, banned] of [
      ['a\\b', 'x', '\\'],
      ['name', 'x;quit', ';'],
      ['name', 'say "hi"', '"']
    ]) {
      expect(infoSetValueForKey('\\name\\Sarge', key, value, warn)).toBe('\\name\\Sarge');
      expect(warn).toHaveBeenLastCalledWith(`Can't use keys or values with a '${banned}': ${key} = ${value}`);
    }
  });

  it('refuses a pair that would take the string to 1024 bytes, with the old pair gone', () => {
    const warn = vi.fn();
    const long = 'x'.repeat(MAX_INFO_STRING - '\\name\\'.length - 1);
    // One byte under the limit fits exactly: the string and its NUL make 1024.
    expect(infoSetValueForKey('', 'name', long, warn)).toHaveLength(MAX_INFO_STRING - 1);
    expect(warn).not.toHaveBeenCalled();

    // Q3 takes the key out before it measures, so a refused replacement loses the old value too.
    const info = infoSetValueForKey('\\name\\Sarge\\model\\sarge', 'name', `${long}yy`, warn);
    expect(info).toBe('\\model\\sarge');
    expect(warn).toHaveBeenCalledWith('Info string length exceeded');
  });

  it('throws for a string already at the limit, as Q3 drops the server', () => {
    expect(() => infoSetValueForKey('x'.repeat(MAX_INFO_STRING), 'a', 'b')).toThrow(
      'Info_SetValueForKey: oversize infostring'
    );
  });
});

describe('infoPairs', () => {
  it('walks every pair in the string, in order', () => {
    expect(infoPairs('\\name\\Sarge\\model\\sarge')).toEqual([
      ['name', 'Sarge'],
      ['model', 'sarge']
    ]);
    expect(infoPairs('')).toEqual([]);
  });

  it("ends at a lone key, as Q3's reader breaks on it", () => {
    expect(infoPairs('\\a\\1\\b')).toEqual([['a', '1']]);
  });
});

describe('the big info string', () => {
  it("takes a pair past MAX_INFO_STRING, which a systeminfo's rule list needs", () => {
    const long = 'x'.repeat(1500);
    const info = infoSetValueForKeyBig('', 'sv_serverid', long);
    expect(info.length).toBeGreaterThan(MAX_INFO_STRING);
    expect(infoValueForKey(info, 'sv_serverid')).toBe(long);
  });

  it('replaces and removes keys in a string already past MAX_INFO_STRING', () => {
    const long = 'x'.repeat(1500);
    let info = infoSetValueForKeyBig('', 'a', long);
    info = infoSetValueForKeyBig(info, 'b', long);
    info = infoSetValueForKeyBig(info, 'a', '5');
    expect(infoValueForKey(info, 'a')).toBe('5');
    expect(infoValueForKey(info, 'b')).toBe(long);

    const shorter = infoRemoveKeyBig(info, 'b');
    expect(infoValueForKey(shorter, 'b')).toBe('');
    expect(shorter.length).toBeLessThan(MAX_INFO_STRING);
  });

  it('refuses a pair that would take the string to BIG_INFO_STRING, as Q3 says so', () => {
    const warn = vi.fn();
    const long = 'x'.repeat(BIG_INFO_STRING);
    expect(infoSetValueForKeyBig('', 'a', long, warn)).toBe('');
    expect(warn).toHaveBeenCalledWith('BIG Info string length exceeded');
  });

  it('throws for a string already at BIG_INFO_STRING, as Q3 drops the server', () => {
    expect(() => infoSetValueForKeyBig('x'.repeat(BIG_INFO_STRING), 'a', 'b')).toThrow(
      'Info_SetValueForKey: oversize infostring'
    );
    expect(() => infoRemoveKeyBig('x'.repeat(BIG_INFO_STRING), 'a')).toThrow(
      'Info_RemoveKey: oversize infostring'
    );
  });
});

describe('infoValidate', () => {
  it('refuses a quote or a semicolon anywhere', () => {
    expect(infoValidate('\\name\\Sarge')).toBe(true);
    expect(infoValidate('\\name\\Sarge;quit')).toBe(false);
    expect(infoValidate('\\name\\"Sarge')).toBe(false);
  });
});
