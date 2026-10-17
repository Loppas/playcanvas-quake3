import { describe, expect, it } from 'vitest';

import { GT } from '../sim/constants';
import { FLAGS_UNKNOWN, readFlagStatus } from './flag-status';

describe('CS_FLAGSTATUS', () => {
  it('reads the two digits, red first', () => {
    // "format is rb where its red/blue, 0 is at base, 1 is taken, 2 is dropped".
    expect(readFlagStatus('00', GT.CTF)).toEqual({ red: 0, blue: 0 });
    expect(readFlagStatus('12', GT.CTF)).toEqual({ red: 1, blue: 2 });
    expect(readFlagStatus('20', GT.CTF)).toEqual({ red: 2, blue: 0 });
  });

  it('says nothing for a gametype that has no flags', () => {
    for (const gametype of [GT.FFA, GT.TOURNAMENT, GT.TEAM]) {
      expect(readFlagStatus('12', gametype)).toEqual(FLAGS_UNKNOWN);
    }
  });

  it('says nothing before the match has sent a string', () => {
    expect(readFlagStatus('', GT.CTF)).toEqual({ red: -1, blue: -1 });
    expect(readFlagStatus('0', GT.CTF)).toEqual({ red: 0, blue: -1 });
  });
});
