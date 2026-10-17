import { describe, expect, it } from 'vitest';

import {
  EF_AWARD_ASSIST,
  EF_AWARD_CAP,
  EF_AWARD_DEFEND,
  EF_AWARD_EXCELLENT,
  EF_AWARD_GAUNTLET,
  EF_AWARD_IMPRESSIVE,
  EF_CONNECTION,
  EF_DEAD,
  EF_TALK,
  GT,
  TEAM
} from '../sim/constants';
import { vec3 } from '../sim/vec3';
import { playerFloatSprite, playerSprite, type SpriteViewer } from './player-sprites';

const FFA: SpriteViewer = { team: TEAM.FREE, gametype: GT.FFA, drawFriend: true };
const RED: SpriteViewer = { team: TEAM.RED, gametype: GT.TEAM, drawFriend: true };

describe('CG_PlayerSprites', () => {
  it('draws nothing over a player with nothing to show', () => {
    expect(playerSprite(0, TEAM.FREE, FFA)).toBeNull();
  });

  it('puts connection trouble first, then the balloon, then the awards in their order', () => {
    const every =
      EF_TALK |
      EF_AWARD_IMPRESSIVE |
      EF_AWARD_EXCELLENT |
      EF_AWARD_GAUNTLET |
      EF_AWARD_DEFEND |
      EF_AWARD_ASSIST |
      EF_AWARD_CAP;
    expect(playerSprite(every | EF_CONNECTION, TEAM.FREE, FFA)).toBe('disconnected');
    expect(playerSprite(every, TEAM.FREE, FFA)).toBe('sprites/balloon3');
    expect(playerSprite(every & ~EF_TALK, TEAM.FREE, FFA)).toBe('medal_impressive');
    expect(playerSprite(EF_AWARD_EXCELLENT | EF_AWARD_GAUNTLET, TEAM.FREE, FFA)).toBe(
      'medal_excellent'
    );
    expect(playerSprite(EF_AWARD_GAUNTLET | EF_AWARD_DEFEND, TEAM.FREE, FFA)).toBe(
      'medal_gauntlet'
    );
    expect(playerSprite(EF_AWARD_DEFEND | EF_AWARD_ASSIST, TEAM.FREE, FFA)).toBe('medal_defend');
    expect(playerSprite(EF_AWARD_ASSIST | EF_AWARD_CAP, TEAM.FREE, FFA)).toBe('medal_assist');
    expect(playerSprite(EF_AWARD_CAP, TEAM.FREE, FFA)).toBe('medal_capture');
  });

  it("marks a live teammate in a team game, and nobody else's", () => {
    expect(playerSprite(0, TEAM.RED, RED)).toBe('sprites/foe');
    expect(playerSprite(0, TEAM.BLUE, RED)).toBeNull();
    expect(playerSprite(EF_DEAD, TEAM.RED, RED)).toBeNull();
    // Everyone is on the same side of a free-for-all, which is no side at all.
    expect(playerSprite(0, TEAM.FREE, FFA)).toBeNull();
    expect(playerSprite(0, TEAM.RED, { ...RED, gametype: GT.CTF })).toBe('sprites/foe');
  });

  it('marks nobody with cg_drawFriend off, and still shows an award', () => {
    const off = { ...RED, drawFriend: false };
    expect(playerSprite(0, TEAM.RED, off)).toBeNull();
    expect(playerSprite(EF_AWARD_CAP, TEAM.RED, off)).toBe('medal_capture');
  });

  it('floats 48 units over the origin, 20 across, untinted, as its entity', () => {
    expect(playerFloatSprite('sprites/foe', vec3(10, 20, 30), 7)).toEqual({
      shader: 'sprites/foe',
      origin: vec3(10, 20, 78),
      radius: 10,
      color: [1, 1, 1, 1],
      order: 7
    });
  });
});
