/**
 * What a message is made of — Quake 3's `qcommon.h:283–315`, and the limits around it.
 *
 * Every message between a host and a client is a sequence of commands, each one a byte followed by
 * whatever that byte implies. The server's commands are `svc_*` and the client's are `clc_*`, and
 * the two sets are numbered independently because a message only ever travels one way.
 *
 * The numbers are the protocol's, so they are fixed: a byte read off the wire means what Quake 3
 * says it means. Everything named here is a wire fact rather than a port decision.
 */

/** `svc_ops_e` (`qcommon.h:283–298`): a command from the server to a client. */
export const SVC = {
  /** Never sent. A zero byte means the message has gone wrong. */
  BAD: 0,
  /** Nothing, used only to pad a packet out for rate debugging. */
  NOP: 1,
  /** Everything a client needs before it can play: the configstrings and the baselines. */
  GAMESTATE: 2,
  /** `[short index] [string]`. Only inside a gamestate. */
  CONFIGSTRING: 3,
  /** An entity's starting state, which later deltas are measured from. Only inside a gamestate. */
  BASELINE: 4,
  /** `[long sequence] [string]`: a reliable command for the client's game module to run. */
  SERVER_COMMAND: 5,
  /** `[short size] [size bytes]` of a file the client is downloading. */
  DOWNLOAD: 6,
  /** The world as of one server frame: the player state, then the entities. */
  SNAPSHOT: 7,
  /** The end of the message. */
  EOF: 8
} as const;

/** `clc_ops_e` (`qcommon.h:304–315`): a command from a client to the server. */
export const CLC = {
  BAD: 0,
  NOP: 1,
  /** A run of user commands, delta'd against each other and keyed. */
  MOVE: 2,
  /** The same, but asking for a snapshot that is not delta'd against anything. */
  MOVE_NO_DELTA: 3,
  /** `[string]`: a reliable command for the server's game module to run. */
  CLIENT_COMMAND: 4,
  EOF: 5
} as const;

/** `snapFlags` (`q_shared.h:1075–1077`): what a client should know about the snapshot itself. */
export const SNAPFLAG = {
  /** The snapshot was held back to stay inside the client's rate, so time has passed. */
  RATE_DELAYED: 1,
  /** The client is connecting, or is a zombie: the snapshot is not a playable one. */
  NOT_ACTIVE: 2,
  /** Toggled on every map restart, which is how a client notices one happened. */
  SERVERCOUNT: 4
} as const;

/**
 * `PACKET_BACKUP` (`qcommon.h:123`): how many sent snapshots each side keeps.
 *
 * The server keeps them to delta the next one against; the client keeps them because the server
 * may delta against any of them. Thirty-two at the snapshot rate is about a second and a half,
 * which is how long a connection can stay silent before it has to start again from nothing.
 */
export const PACKET_BACKUP = 32;

/** `PACKET_MASK` (`qcommon.h:125`): the ring index of a sequence number. */
export const PACKET_MASK = PACKET_BACKUP - 1;

/** `MAX_PACKET_USERCMDS` (`qcommon.h:127`): user commands one message may carry. */
export const MAX_PACKET_USERCMDS = 32;

/** `MAX_SNAPSHOT_ENTITIES` (`qcommon.h:129`): entities one snapshot may carry. */
export const MAX_SNAPSHOT_ENTITIES = 256;

/**
 * `MAX_PARSE_ENTITIES` (`client.h:89`): the client's ring of decoded entity states.
 *
 * Every entity of every kept snapshot lives here at once, because a snapshot is only a window onto
 * this ring. A snapshot that delta'd from a frame whose entities have since rolled out of the ring
 * cannot be decoded at all, which is the second of the two reasons a client asks for a full one.
 */
export const MAX_PARSE_ENTITIES = PACKET_BACKUP * MAX_SNAPSHOT_ENTITIES;

/** `MAX_RELIABLE_COMMANDS` (`qcommon.h:133`): server commands held for retransmission. */
export const MAX_RELIABLE_COMMANDS = 64;

/** `MAX_CONFIGSTRINGS` (`q_shared.h:1100`): the shared strings a client is told at connect. */
export const MAX_CONFIGSTRINGS = 1024;

/** `MAX_SOUNDS` (`q_shared.h:1097`): the block of {@link CONFIGSTRING.SOUNDS}, "so they cannot be blindly increased". */
export const MAX_SOUNDS = 256;

/** `MAX_MODELS` (`q_shared.h:1096`): the block of {@link CONFIGSTRING.MODELS}. */
export const MAX_MODELS = 256;

/**
 * What lives at each configstring index: the two the protocol reserves (`q_shared.h:1102–1104`)
 * and the ones the game module fills in (`bg_public.h:40–70`).
 *
 * Quake 3 splits these across two headers and the port keeps them in one place, because they
 * index one array and a gap in the middle is easier to see than to remember. Quake 3 calls them
 * `CS_*`, which in its own source collides with the `CS_` of a client's state — `q_shared.h` and
 * `server.h` never meet, so it never has to choose. The port does, and calls them what they are.
 *
 * The blocks are not tidy. {@link CONFIGSTRING.SOUNDS} is where it is because 256 models come
 * first, and {@link CONFIGSTRING.PLAYERS} because 256 sounds come after those; a client reads a
 * model index straight out of an entity state and looks it up here, so the arithmetic is on the
 * wire whether it is written down or not.
 */
export const CONFIGSTRING = {
  /** What the server advertises: its name, the gametype, the map. */
  SERVERINFO: 0,
  /** What a client must agree with to play at all, including the server id. */
  SYSTEMINFO: 1,
  MUSIC: 2,
  /** The worldspawn's message: the map's name as it is announced. */
  MESSAGE: 3,
  /** `g_motd`. */
  MOTD: 4,
  /** The time the match restarts at, which is what a client counts a warmup down from. */
  WARMUP: 5,
  /** The two leading scores, or {@link import('../sim/constants').SCORE_NOT_PRESENT}. */
  SCORES1: 6,
  SCORES2: 7,
  VOTE_TIME: 8,
  VOTE_STRING: 9,
  VOTE_YES: 10,
  VOTE_NO: 11,
  /** Four apiece, one per team, from here to 19. */
  TEAMVOTE_TIME: 12,
  TEAMVOTE_STRING: 14,
  TEAMVOTE_YES: 16,
  TEAMVOTE_NO: 18,
  GAME_VERSION: 20,
  /** So the match clock counts this match rather than the session. */
  LEVEL_START_TIME: 21,
  /** 1 once a limit has been reached and the intermission is a second or two away. */
  INTERMISSION: 22,
  FLAGSTATUS: 23,
  SHADERSTATE: 24,
  BOTINFO: 25,
  /** A string of 0s and 1s saying which items this map has. */
  ITEMS: 27,
  /** 256 of them. */
  MODELS: 32,
  /** 256 of them. */
  SOUNDS: 288,
  /** One per client slot: the name, model and score another client draws a scoreboard from. */
  PLAYERS: 544,
  LOCATIONS: 608,
  PARTICLES: 672,
  /** One past the last, which must stay under {@link MAX_CONFIGSTRINGS}. */
  MAX: 736
} as const;

/**
 * `MAX_MAP_AREA_BYTES` (`q_shared.h:270`): the area visibility bits a snapshot carries.
 *
 * A BSP map is cut into areas that doors join, and these bits say which of them the viewer cannot
 * see into. The server sends as many bytes as its map's areas fill, and the client keeps all 32,
 * clear past those.
 */
export const MAX_MAP_AREA_BYTES = 32;

/**
 * `MAX_SAY_TEXT` (`q_shared.h:256`): a chat line's buffer, NUL and all. The game cuts what was said
 * to it, and cgame the whole line it is sent.
 */
export const MAX_SAY_TEXT = 150;

/**
 * `EC` (`g_cmds.c:869`): the byte the game sets around a chat line's name and before its colon,
 * which cgame takes out before printing the line (`CG_RemoveChatEscapeChar`).
 */
export const CHAT_ESCAPE = '\x19';
