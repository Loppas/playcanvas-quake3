import { atoi } from '../formats/c-scan';
import { CONFIGSTRING } from '../net/commands';
import { infoValueForKey } from '../net/info';
import { MAX_CLIENTS } from '../net/protocol';
import { GT } from '../sim/constants';
import { colorFromString, type Rgb } from './player-color';
import { playerLook, sameLook, teamLook, type PlayerLook } from './player-model';
import { serverInfo } from './server-info';

/**
 * What a client knows about each player, read out of their `CS_PLAYERS` string: `clientInfo_t`,
 * as `CG_NewClientInfo` fills it (`cg_players.c:876–1062`). Engine-free.
 *
 * A player is looked up here by `s.clientNum` rather than by entity number, which is what lets a
 * corpse in another slot wear its owner's look (`cg_players.c:2259–2266`).
 */

/** `clientInfo_t`'s fields that come from the configstring. */
export interface ClientInfo {
  /** `n`: the name, colour codes and all. */
  name: string;
  /** `c1` and `c2`, through `CG_ColorFromString`. */
  color1: Rgb;
  color2: Rgb;
  /** `skill`, which only a bot's string carries. */
  botSkill: number;
  /** `hc`: the maximum health the handicap leaves. */
  handicap: number;
  /** `w` and `l`: a tournament's wins and losses. */
  wins: number;
  losses: number;
  /** `t`: the team. */
  team: number;
  /** `tt` and `tl`: Team Arena's task, and whether they lead. */
  teamTask: number;
  teamLeader: number;
  /** `g_redteam` and `g_blueteam`, which a bot's string leaves out. */
  redTeam: string;
  blueTeam: string;
  /**
   * `modelName`, `skinName`, `headModelName` and `headSkinName`: the look `model` and `hmodel`
   * name, as chosen, which is what decides whether two clients wear the same.
   */
  named: PlayerLook;
  /**
   * What they are drawn in, and sound like: the look named, in its side's colours in a team game;
   * or, while {@link deferred}, a loaded client's (`CG_CopyClientInfoModel`,
   * `cg_players.c:741–758`).
   */
  look: PlayerLook;
  /** `deferred`: drawn in a loaded client's look until their own is loaded (`cg_deferPlayers`). */
  deferred: boolean;
}

/**
 * `CG_NewClientInfo`'s reading of a player's string.
 *
 * `cg_forceModel`, which dresses everyone in the viewer's own model, is not read: the port has no
 * such setting.
 *
 * The models are the server's pick between `model` and `team_model` (`ClientUserinfoChanged`,
 * `g_client.c:775–782`); the skins they wear are the client's own, and in a team game they are
 * the side's colours ({@link teamLook}).
 *
 * @param configstring - `CS_PLAYERS + clientNum`.
 * @param gametype - `cgs.gametype`, which decides whether the look is worn in a side's colours.
 * @returns the player's info in their own look, or `null` for an empty string: "player just
 *   left".
 */
export function newClientInfo(configstring: string, gametype: number): ClientInfo | null {
  if (configstring === '') return null;
  const value = (key: string) => infoValueForKey(configstring, key);
  const team = atoi(value('t'));
  const named = playerLook(value('model'), value('hmodel'));
  return {
    name: value('n'),
    color1: colorFromString(atoi(value('c1'))),
    color2: colorFromString(atoi(value('c2'))),
    botSkill: atoi(value('skill')),
    handicap: atoi(value('hc')),
    wins: atoi(value('w')),
    losses: atoi(value('l')),
    team,
    teamTask: atoi(value('tt')),
    teamLeader: atoi(value('tl')),
    redTeam: value('g_redteam'),
    blueTeam: value('g_blueteam'),
    named,
    look: teamLook(named, gametype, team),
    deferred: false
  };
}

/** A client as `CG_NewClientInfo` keeps them. */
export interface KeptClientInfo {
  /** Their info: in their own look, or deferred in a loaded client's. */
  info: ClientInfo;
  /** Whether their look is loaded now, as `CG_LoadClientInfo` loads it. */
  load: boolean;
}

/**
 * `CG_NewClientInfo`'s last step (`cg_players.c:1037–1062`): a client in a look a loaded client
 * already wears shares it (`CG_ScanForExistingClientInfo`, `:763–797`); otherwise their look is
 * loaded, or with `defer` put off, and a loaded client's worn meanwhile
 * (`CG_SetDeferredClientInfo`, `:806–866`).
 *
 * Put off, a look still loads at once where a loaded client wears the same body, and in a team game
 * where none of their side wears their skin, rather than show a side in the wrong colours. Quake 3
 * also defers whatever the setting when its memory runs low, which the port's cannot.
 *
 * @param info - The client as just read, in their own look.
 * @param infos - `cgs.clientinfo` before theirs is replaced, their last info among them.
 * @param defer - `cg_deferPlayers`, outside `CG_Init`'s load (`cg.loading`).
 */
export function keepClientInfo(
  info: ClientInfo,
  infos: readonly (ClientInfo | null)[],
  gametype: number,
  defer: boolean
): KeptClientInfo {
  const teamGame = gametype >= GT.TEAM;
  const valid = infos.filter((match): match is ClientInfo => match !== null);
  const loaded = valid.filter((match) => !match.deferred);
  const side = (match: ClientInfo) => !teamGame || match.team === info.team;
  const shared = loaded.some(
    (match) =>
      sameLook(match.named, info.named) &&
      match.blueTeam === info.blueTeam &&
      match.redTeam === info.redTeam &&
      side(match)
  );
  if (shared || !defer) return { info, load: !shared };

  const { body } = info.named;
  const sameSkin = (match: ClientInfo) => match.named.body.skin === body.skin && side(match);
  if (loaded.some((match) => sameSkin(match) && match.named.body.model === body.model)) {
    return { info, load: true };
  }
  const lender = teamGame ? loaded.find(sameSkin) : valid[0];
  if (lender === undefined) return { info, load: true };
  return { info: { ...info, look: lender.look, deferred: true }, load: false };
}

/** A client in their own look, as `CG_LoadClientInfo` leaves them (`cg_players.c:652–734`). */
export function loadClientInfo(info: ClientInfo, gametype: number): ClientInfo {
  return { ...info, look: teamLook(info.named, gametype, info.team), deferred: false };
}

/** One player a gamestate names. */
export interface GamestateClient {
  clientNum: number;
  info: ClientInfo;
}

/**
 * `CG_RegisterClients` (`cg_main.c:1129–1150`): everyone a gamestate names, in the order cgame
 * loads them, the client's own slot first and then every other slot with a string.
 *
 * @param configstring - `CG_ConfigString`, as the gamestate set it.
 * @param clientNum - `cg.clientNum`: the slot the gamestate says is this client's.
 */
export function gamestateClients(
  configstring: (index: number) => string,
  clientNum: number
): GamestateClient[] {
  const { gametype } = serverInfo(configstring(CONFIGSTRING.SERVERINFO));
  const clients: GamestateClient[] = [];
  const read = (slot: number) => {
    const info = newClientInfo(configstring(CONFIGSTRING.PLAYERS + slot), gametype);
    if (info) clients.push({ clientNum: slot, info });
  };
  read(clientNum);
  for (let slot = 0; slot < MAX_CLIENTS; slot++) if (slot !== clientNum) read(slot);
  return clients;
}
