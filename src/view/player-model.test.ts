import { describe, expect, it } from 'vitest';

import { GT, TEAM } from '../sim/constants';
import { DEFAULT_LOOK, playerLook, readModel, sameLook, teamLook, teamSkin } from './player-model';

/** `model` and `headmodel`, read as cgame reads them. */

describe('readModel (CG_NewClientInfo)', () => {
  it('reads the skin after a slash, and "default" without one', () => {
    expect(readModel('sarge')).toEqual({ model: 'sarge', skin: 'default' });
    expect(readModel('sarge/red')).toEqual({ model: 'sarge', skin: 'red' });
    expect(readModel('')).toEqual({ model: '', skin: 'default' });
  });
});

describe('playerLook', () => {
  it("wears the head's own model and skin", () => {
    expect(playerLook('xaero/blue', 'sarge/red')).toEqual({
      body: { model: 'xaero', skin: 'blue' },
      head: { model: 'sarge', skin: 'red' }
    });
  });

  it("puts the body's model on a head with none, in the head's default skin (CG_RegisterClientModelname)", () => {
    expect(playerLook('xaero/blue', '').head).toEqual({ model: 'xaero', skin: 'default' });
  });

  it('knows a look it has seen', () => {
    expect(sameLook(playerLook('sarge', 'sarge'), DEFAULT_LOOK)).toBe(true);
    expect(sameLook(playerLook('sarge', 'sarge/red'), DEFAULT_LOOK)).toBe(false);
  });
});

describe('teamLook (CG_FindClientModelFile)', () => {
  it('names the side the skin is looked for in, red for everyone but blue', () => {
    expect(teamSkin(TEAM.RED)).toBe('red');
    expect(teamSkin(TEAM.BLUE)).toBe('blue');
    expect(teamSkin(TEAM.SPECTATOR)).toBe('red');
    expect(teamSkin(TEAM.FREE)).toBe('red');
  });

  it("puts both the body and the head in the side's colours, keeping the models", () => {
    const look = playerLook('xaero/gorre', 'sarge/krusade');

    expect(teamLook(look, GT.TEAM, TEAM.BLUE)).toEqual({
      body: { model: 'xaero', skin: 'blue' },
      head: { model: 'sarge', skin: 'blue' }
    });
    expect(teamLook(look, GT.CTF, TEAM.RED).body).toEqual({ model: 'xaero', skin: 'red' });
  });

  it('leaves a look alone below GT_TEAM', () => {
    const look = playerLook('xaero/gorre', 'sarge/krusade');
    for (const gametype of [GT.FFA, GT.TOURNAMENT, GT.SINGLE_PLAYER]) {
      expect(teamLook(look, gametype, TEAM.BLUE)).toEqual(look);
    }
  });
});
