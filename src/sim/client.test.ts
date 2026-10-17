import { describe, expect, it } from 'vitest';

import {
  angleToShort,
  clearClientForConnect,
  clearClientForSpawn,
  CON,
  createGameClient,
  createPlayerTeamState,
  shortToAngle,
  SPECTATOR
} from './client';
import { PERS, STAT, TEAM } from './constants';

/** A client in the middle of a life, with something in every lifetime. */
function livedIn() {
  const client = createGameClient();

  client.pers.connected = CON.CONNECTED;
  client.pers.netname = 'Sarge';
  client.pers.maxHealth = 75;
  client.pers.enterTime = 4000;
  client.pers.roundSpectator = true;

  client.sess.sessionTeam = TEAM.FREE;
  client.sess.wins = 3;
  client.sess.losses = 1;
  client.sess.spectatorState = SPECTATOR.NOT;

  client.ps.persistant[PERS.SCORE] = 12;
  client.ps.persistant[PERS.SPAWN_COUNT] = 5;
  client.ps.eventSequence = 9;
  client.ps.ping = 42;
  client.ps.stats[STAT.HEALTH] = 30;
  client.accuracyShots = 80;
  client.accuracyHits = 31;
  client.damageGiven = 640;

  client.respawnTime = 3000;
  client.damageBlood = 17;
  client.latchedButtons = 1;
  client.timeResidual = 400;
  client.armorResidual = 300;

  return client;
}

describe('the three lifetimes', () => {
  describe('a spawn', () => {
    it('keeps the two outer lifetimes and nothing of the life itself', () => {
      const client = livedIn();
      clearClientForSpawn(client);

      expect(client.pers.netname).toBe('Sarge');
      expect(client.pers.maxHealth).toBe(75);
      expect(client.pers.enterTime).toBe(4000);
      // Watching a round from a side outlasts the spawn that puts the watcher in the world.
      expect(client.pers.roundSpectator).toBe(true);
      expect(client.sess.wins).toBe(3);
      expect(client.sess.losses).toBe(1);

      expect(client.respawnTime).toBe(0);
      expect(client.damageBlood).toBe(0);
      expect(client.latchedButtons).toBe(0);
      expect(client.timeResidual).toBe(0);
      expect(client.armorResidual).toBe(0);
      expect(client.ps.stats[STAT.HEALTH]).toBe(0);
    });

    it('keeps the score and the spawn count, which a death must not reset', () => {
      const client = livedIn();
      clearClientForSpawn(client);

      expect(client.ps.persistant[PERS.SCORE]).toBe(12);
      expect(client.ps.persistant[PERS.SPAWN_COUNT]).toBe(5);
    });

    it('keeps the ping, the event sequence and the match statistics', () => {
      const client = livedIn();
      clearClientForSpawn(client);

      // A client that has seen events up to 9 must not be sent a fresh event 0.
      expect(client.ps.eventSequence).toBe(9);
      expect(client.ps.ping).toBe(42);
      expect(client.accuracyShots).toBe(80);
      expect(client.accuracyHits).toBe(31);
      expect(client.damageGiven).toBe(640);
    });

    it('leaves nobody as the last client killed, since zero is a real one', () => {
      const client = createGameClient();
      client.lastkilledClient = 3;
      clearClientForSpawn(client);

      expect(client.lastkilledClient).toBe(-1);
    });

    it('keeps the whole team state, counters and clocks alike', () => {
      // The team state lives in `pers`, which a spawn does not touch at all — so a player's
      // captures and assists cross a death, and the scoreboard's capture column goes on counting.
      const client = livedIn();
      client.pers.teamState.captures = 2;
      client.pers.teamState.assists = 1;
      client.pers.teamState.flagrecovery = 4;
      client.pers.teamState.lastreturnedflag = 9000;

      clearClientForSpawn(client);

      expect(client.pers.teamState.captures).toBe(2);
      expect(client.pers.teamState.assists).toBe(1);
      expect(client.pers.teamState.flagrecovery).toBe(4);
      expect(client.pers.teamState.lastreturnedflag).toBe(9000);
    });

    it('leaves the objects in place, so anything holding the client still holds it', () => {
      const client = livedIn();
      const { ps, pers, sess } = client;

      clearClientForSpawn(client);

      expect(client.ps).toBe(ps);
      expect(client.pers).toBe(pers);
      expect(client.sess).toBe(sess);
    });
  });

  describe('a connect', () => {
    it('takes both inner lifetimes with it', () => {
      const client = livedIn();
      clearClientForConnect(client);

      expect(client.pers.connected).toBe(CON.DISCONNECTED);
      expect(client.pers.netname).toBe('');
      expect(client.pers.enterTime).toBe(0);
      expect(client.pers.roundSpectator).toBe(false);
      expect(client.damageGiven).toBe(0);
      expect(client.sess.wins).toBe(0);
      expect(client.ps.persistant[PERS.SCORE]).toBe(0);
    });

    it('clears the whole team state, so a slot keeps none of the last player’s', () => {
      // The clearing copies a zeroed persistant over the slot's, as Quake 3's `memset` does.
      // Copying `state` alone would leave the captures and assists of whoever had the slot
      // before for whoever connects into it next.
      const client = livedIn();
      client.pers.teamState.captures = 2;
      client.pers.teamState.assists = 1;
      client.pers.teamState.lastreturnedflag = 9000;

      clearClientForConnect(client);

      expect(client.pers.teamState).toEqual(createPlayerTeamState());
    });
  });
});

describe('an angle on the wire', () => {
  it('survives the trip in both directions', () => {
    for (const degrees of [0, 45, 90, 180, 270, 359]) {
      expect(Math.round(shortToAngle(angleToShort(degrees)))).toBe(degrees);
    }
  });

  it('truncates rather than rounds, as the cast to int does', () => {
    // 1 degree is 182.04 short units, and Quake 3 keeps the 182.
    expect(angleToShort(1)).toBe(182);
    expect(angleToShort(-1)).toBe(65536 - 182);
  });
});
