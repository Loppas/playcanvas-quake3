import { describe, expect, it } from 'vitest';

import type { CvarStore } from '../net/cvar';
import { createClientSession, SPECTATOR } from './client';
import { GT, TEAM } from './constants';
import {
  initClientSessionData,
  initWorldSession,
  readClientSessionData,
  sessionCvar,
  writeClientSessionData,
  writeSessionData
} from './session';

/** The cvars, as the only thing that crosses a map change. */
function store(initial: Record<string, string> = {}): CvarStore & { values: Map<string, string> } {
  const values = new Map(Object.entries(initial));
  const counts = new Map<string, number>();
  let total = 0;
  const set = (name: string, value: string) => {
    // A cvar set to what it already holds is not a modification, which is what makes the count
    // worth keeping: it changes only when somebody actually changed something.
    if ((values.get(name) ?? '') === value) return;
    values.set(name, value);
    counts.set(name, (counts.get(name) ?? 0) + 1);
    total++;
  };
  return {
    values,
    get: (name) => values.get(name) ?? '',
    set,
    setServer: (name, value) => {
      set(name, value);
      return true;
    },
    modificationCount: (name) => counts.get(name) ?? 0,
    totalModifications: () => total
  };
}

function played(): ReturnType<typeof createClientSession> {
  const sess = createClientSession();
  sess.sessionTeam = TEAM.BLUE;
  sess.spectatorNum = 2;
  sess.spectatorState = SPECTATOR.FOLLOW;
  sess.spectatorClient = 1;
  sess.wins = 4;
  sess.losses = 2;
  sess.teamLeader = true;
  return sess;
}

describe('a session in its cvar', () => {
  it('writes the seven fields in the order the reader expects them', () => {
    const cvars = store();
    writeClientSessionData(cvars, 3, played());

    expect(cvars.values.get('session3')).toBe('2 2 2 1 4 2 1');
  });

  it('comes back the same session it went out as', () => {
    const cvars = store();
    writeClientSessionData(cvars, 0, played());

    const sess = createClientSession();
    readClientSessionData(cvars, 0, sess);

    expect(sess).toEqual(played());
  });

  it('is named after the slot, so two clients never share one', () => {
    const cvars = store();
    const first = played();
    const second = createClientSession();
    second.wins = 9;

    writeClientSessionData(cvars, 0, first);
    writeClientSessionData(cvars, 1, second);

    const read = createClientSession();
    readClientSessionData(cvars, 1, read);
    expect(read.wins).toBe(9);
    expect(sessionCvar(1)).toBe('session1');
  });

  it('leaves a session alone when its cvar was never written', () => {
    const sess = played();
    readClientSessionData(store(), 0, sess);

    expect(sess).toEqual(played());
  });

  it('keeps what it could read of a truncated cvar and leaves the rest', () => {
    const sess = createClientSession();
    sess.wins = 7;
    readClientSessionData(store({ session0: '2 5' }), 0, sess);

    expect(sess.sessionTeam).toBe(TEAM.BLUE);
    expect(sess.spectatorNum).toBe(5);
    expect(sess.wins).toBe(7);
  });
});

describe('a session across a map', () => {
  it('writes the gametype and every connected client at shutdown', () => {
    const cvars = store();
    writeSessionData(cvars, GT.TOURNAMENT, [played(), null, createClientSession()]);

    expect(cvars.values.get('session')).toBe('1');
    expect(cvars.values.get('session0')).toBe('2 2 2 1 4 2 1');
    expect(cvars.values.has('session1')).toBe(false);
    expect(cvars.values.get('session2')).toBe('0 0 0 0 0 0 0');
  });

  /** `G_InitWorldSession`'s answer, and what it printed. */
  const started = (cvars: ReturnType<typeof store>, gametype: number) => {
    const printed: string[] = [];
    return { newSession: initWorldSession(cvars, gametype, (text) => printed.push(text)), printed };
  };
  /** Its line when it throws the sessions away (`g_session.c:180–181`). */
  const CLEARED = 'Gametype changed, clearing session data.';

  it('keeps the sessions when the gametype has not changed, and says nothing', () => {
    const kept = started(store({ session: '1' }), GT.TOURNAMENT);
    expect(kept).toEqual({ newSession: false, printed: [] });
  });

  it('throws them away when it has, since a team and a record mean something else now', () => {
    const changed = started(store({ session: '1' }), GT.FFA);
    expect(changed).toEqual({ newSession: true, printed: [CLEARED] });
  });

  it('keeps them on a first ever run of a free-for-all, which reads as gametype zero', () => {
    expect(started(store(), GT.FFA)).toEqual({ newSession: false, printed: [] });
    expect(started(store(), GT.TOURNAMENT)).toEqual({ newSession: true, printed: [CLEARED] });
  });
});

describe('a session starting for the first time', () => {
  const init = {
    gametype: GT.FFA,
    maxGameClients: 0,
    numNonSpectatorClients: 0,
    localClient: false
  };

  it('puts a free-for-all client straight into the game', () => {
    const cvars = store();
    const sess = createClientSession();
    initClientSessionData(cvars, 0, sess, '', init);

    expect(sess.sessionTeam).toBe(TEAM.FREE);
    expect(sess.spectatorState).toBe(SPECTATOR.FREE);
    // Written out at once, so a restart before anything else happens still finds it.
    expect(cvars.values.get('session0')).toBe('0 0 1 0 0 0 0');
  });

  it('seats a free-for-all client out once g_maxGameClients is full', () => {
    const sess = createClientSession();
    initClientSessionData(store(), 0, sess, '', {
      ...init,
      maxGameClients: 2,
      numNonSpectatorClients: 2
    });

    expect(sess.sessionTeam).toBe(TEAM.SPECTATOR);
  });

  it('seats a tournament client out once two are already playing', () => {
    const waiting = createClientSession();
    initClientSessionData(store(), 0, waiting, '', {
      ...init,
      gametype: GT.TOURNAMENT,
      numNonSpectatorClients: 2
    });
    expect(waiting.sessionTeam).toBe(TEAM.SPECTATOR);

    const playing = createClientSession();
    initClientSessionData(store(), 0, playing, '', {
      ...init,
      gametype: GT.TOURNAMENT,
      numNonSpectatorClients: 1
    });
    expect(playing.sessionTeam).toBe(TEAM.FREE);
  });

  it('takes a client at its word when it asked to spectate', () => {
    const sess = createClientSession();
    initClientSessionData(store(), 0, sess, '\\teampref\\s', init);

    expect(sess.sessionTeam).toBe(TEAM.SPECTATOR);
  });

  it('starts a team game spectating, since nobody has picked a side yet', () => {
    const sess = createClientSession();
    initClientSessionData(store(), 0, sess, '', { ...init, gametype: GT.TEAM });

    expect(sess.sessionTeam).toBe(TEAM.SPECTATOR);
    expect(sess.spectatorState).toBe(SPECTATOR.FREE);
  });

  it('hands a team game’s preference back for the match to act on', () => {
    const sess = createClientSession();
    const joins = initClientSessionData(store(), 0, sess, '\\teampref\\red', {
      ...init,
      gametype: GT.TEAM
    });

    // The side itself is `SetTeam`'s to give, and it is still a spectator until it does.
    expect(sess.sessionTeam).toBe(TEAM.SPECTATOR);
    expect(joins).toBe('red');
  });

  it('asks for a side with no word in it while g_teamAutoJoin is on', () => {
    const joins = initClientSessionData(
      store({ g_teamAutoJoin: '1' }),
      0,
      createClientSession(),
      '',
      { ...init, gametype: GT.TEAM }
    );

    expect(joins).toBe('');
  });

  it('asks for no side when neither the client nor the match wants one', () => {
    const joins = initClientSessionData(store(), 0, createClientSession(), '', {
      ...init,
      gametype: GT.TEAM
    });

    expect(joins).toBeNull();
  });

  it('asks for none at all in a game without sides, whatever was preferred', () => {
    const joins = initClientSessionData(
      store({ g_teamAutoJoin: '1' }),
      0,
      createClientSession(),
      '\\teampref\\red',
      init
    );

    expect(joins).toBeNull();
  });

  it('spends the menu’s team preference the first time it is read', () => {
    const cvars = store({ g_localTeamPref: 's' });
    const sess = createClientSession();
    initClientSessionData(cvars, 0, sess, '', { ...init, localClient: true });

    expect(sess.sessionTeam).toBe(TEAM.SPECTATOR);
    expect(cvars.values.get('g_localTeamPref')).toBe('');
  });

  it('does not spend it on a client that is not in this process', () => {
    const cvars = store({ g_localTeamPref: 's' });
    const sess = createClientSession();
    initClientSessionData(cvars, 0, sess, '', init);

    expect(sess.sessionTeam).toBe(TEAM.FREE);
    expect(cvars.values.get('g_localTeamPref')).toBe('s');
  });
});
