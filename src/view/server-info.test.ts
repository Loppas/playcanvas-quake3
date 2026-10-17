import { describe, expect, it } from 'vitest';

import { ID_MISSILE_LOOKS } from './effects';
import { serverInfo } from './server-info';

describe('CG_ParseServerinfo', () => {
  it("reads the match, the weapons' numbers and the missiles' looks from the string", () => {
    const info = serverInfo(
      '\\g_gametype\\4\\fraglimit\\20\\timelimit\\15\\capturelimit\\8\\roundlimit\\5\\sv_maxclients\\12' +
        '\\g_pellets_sg\\16\\g_spread_sg\\650.5\\g_pattern_sg\\2\\mapname\\garage_rats' +
        '\\g_muzzleForward\\1.5\\g_muzzleSnap\\0\\g_spread_mg\\350\\g_range_mg\\8192' +
        '\\g_range_rg\\4096.5\\g_bulletImpactSnap\\0\\g_railTrailOffset\\0' +
        '\\g_plasmaSize\\12.5\\g_plasmaMarkSize\\8\\g_splashradius_bfg\\0' +
        '\\g_lowAmmo_mg\\25\\g_lowAmmo_rl\\5\\g_lowAmmo_bfg\\3'
    );

    expect(info).toEqual({
      gametype: 4,
      fraglimit: 20,
      timelimit: 15,
      capturelimit: 8,
      roundlimit: 5,
      maxclients: 12,
      shotgun: { pattern: 2, pellets: 16, spread: 650.5 },
      hitscan: {
        g_muzzleForward: 1.5,
        g_muzzleSnap: 0,
        g_spread_mg: 350,
        g_range_mg: 8192,
        g_range_rg: 4096.5,
        g_bulletImpactSnap: 0,
        g_railTrailOffset: 0
      },
      missiles: { plasmaSize: 12.5, plasmaMarkSize: 8, bfgSplashRadius: 0 },
      lowAmmo: [0, 0, 25, 0, 0, 5, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0]
    });
  });

  it("reads a key the string does not carry as nothing, and the weapons' rules as id's", () => {
    expect(serverInfo('')).toEqual({
      gametype: 0,
      fraglimit: 0,
      timelimit: 0,
      capturelimit: 0,
      roundlimit: 0,
      maxclients: 0,
      shotgun: { pattern: 0, pellets: 11, spread: 700 },
      hitscan: {
        g_muzzleForward: 14,
        g_muzzleSnap: 1,
        g_spread_mg: 200,
        g_range_mg: 131072,
        g_range_rg: 8192,
        g_bulletImpactSnap: 1,
        g_railTrailOffset: 1
      },
      missiles: { plasmaSize: 16, plasmaMarkSize: 16, bfgSplashRadius: 120 },
      lowAmmo: new Array<number>(16).fill(0)
    });
    expect(serverInfo('').missiles).toEqual(ID_MISSILE_LOOKS);
  });

  it('reads each hitscan rule as its cvar is read: the switches as whole numbers', () => {
    const { hitscan } = serverInfo(
      '\\g_muzzleForward\\2.5\\g_muzzleSnap\\0.5\\g_bulletImpactSnap\\1.75' +
        '\\g_railTrailOffset\\0.25\\g_range_mg\\100.5'
    );
    expect(hitscan).toMatchObject({
      g_muzzleForward: 2.5,
      g_muzzleSnap: 0,
      g_bulletImpactSnap: 1,
      g_railTrailOffset: 0,
      g_range_mg: 100.5
    });
  });
});
