# Server and game

The port builds Quake 3's split whole: a host with client slots, a game module, and a client
that reads real snapshots over a loopback, even with one human in one page. These rules keep it
Quake 3's.

**The client learns the match only from the wire.** What it draws and says comes through Quake
3's own channels: entity state, player-state events, configstrings and server commands. Never
through a side channel, `level.clients` read past the host, or a local cvar; a latched cvar's
local copy keeps the value the page started with. The wire's timings are behaviour too:
- `CS_SERVERINFO` goes out again from any frame that finds a serverinfo cvar changed (`SV_Frame`).
- A map load sends a gamestate. A `map_restart` sends `cs` lines instead, each arriving before the
  restart that follows it.
- The client must take up `sv_serverid`, or the server drops every move it sends.

A splat map's data is Quake 3's own text beside it, `maps/<n>.ent` and `scripts/<n>.arena`, read
by the readers a BSP's would go through.

**Each piece of state has one home, where Quake 3 keeps it.** No mirror copy and no parallel
state machine: the match's phase is `level.warmupTime` alone, a latch holds no pending value, and
`PlayerLife` keeps no state of its own. A second copy is a second answer, and the two drift.

**The page and its worker keep one store between them, as Quake 3's one process keeps one.** The
page's server runs in a worker with a store of its own, so every write crosses: a page change
reaches the worker counted, as a read by modification count needs, and what the game or the server
sets there crosses back, held on the page as the worker holds it and not sent again. With the
way back missing, `g_localTeamPref`, cleared in the worker and kept on the page, seated the human
as a spectator in 34 of 35 CTF runs; with the count missing, a page change to `g_speed` or a
`pmove_*` rule reached the game only at the next map. The worker also runs on while the page
loads a map, which Quake 3's server, on the client's thread, cannot: after a load of 9 s or more
cgame warns that its snapshots are out of range.

**The numbers Quake 3 hands out in order are behaviour, so keep and free exactly what it does.**
While a map spawns, `G_Spawn` takes a freed slot again at once, so an entity freed where Quake 3
keeps it, or kept where it frees it, renumbers every entity after it; a rider's ground, a
snapshot's entities and the world's draw order are all read by number. `cpma3`'s two
`func_static`s, left for a later stage, put its plat at 303 where Quake 3's rider stands on 305.
A configstring's slot follows the same rule: `jumppad.wav` is registered at the pad's spawn
and `poweruprespawn.wav` at the powerup's, or every later `CS_SOUNDS` slot is one off.
Hold a map's spawn to Quake 3's own `entitylist` before building on its numbers.

**Quake 3's frame order is behaviour.** A client's command runs as it arrives, against the world
the last frame left, and entities move afterwards in `G_RunFrame`, so a missile first moves on the
frame after it is fired. `G_RunFrame` does nothing while `level.restarted` is set, so a tournament
seat changes hands on the restarted map. Goldens a tick out, or out by a small distance, are the
sign of an order got wrong. So is the order of its lists: `SV_AreaEntities` walks its sector tree,
newest link first, and that order picks the one blocker a crusher hurts in a frame, whether a door
pops an item before it reverses on a player, and the order of touches and of a blast's deaths.

**The game frame is `sv_fps`'s, 8 ms by default, where Quake 3's is 50** (`sv_fps` 125 against
20). What is counted in frames runs 6.25 times as often, and what is timed in milliseconds lands on
the frame that finds it due: a mover's next leg starts 0–7 ms late here against Quake 3's 0–49. The
leg, a held door's close and a timer's think keep the code as written, which is Quake 3 at
`sv_fps 125`. A rhythm that rests on Quake 3's 50 ms frames is kept on them: lava, slime,
`trigger_hurt`, the laser and a crusher judge their re-arm by `Level.q3FrameTime()`, so lava hurts
twice every 750 ms where the code at 8 ms hurts once every 704. A Quake 3 bug that
repeats every frame repeats six times as fast here, as the tournament seat offered and refused in a
loop did, so fix it at its rule, not by slowing the frame, which is the port's clock.

**The client does what cgame does, when cgame does it.** What is drawn, dressed and voiced
follows the snapshot's `ps.clientNum`, and a change of it starts over rather than blending:
following a bot once showed the watcher's own model and voice, replayed a death, and slid the view
across the map. Assets load when Quake 3 loads them, a look's models as its `CS_PLAYERS` string
arrives, not at first use, which cost 150 ms and spawned a bot with no body and no sound.

**cgame adds what it draws afresh each frame, so what the port keeps is hidden once it is not
drawn.** Quake 3 has no hide: a weapon put away, a powerup lost and a body handed on are simply not
added in the next frame (`cg_weapons.c:1169–1211`). The port keeps its entities, so each piece
drawn for an owner is hidden when the owner stops drawing it, above all a piece hung beside the
owner rather than under it: a weapon's powerup shells, hung on the body's root, drew the last gun
in the quad's blue wherever that body went next.

**Every way out of the page shuts the game down first, as `Com_Quit_f` does.** Its `disconnect`s,
or a host's "Server quit", go before the page closes or stops. EXIT GAME closed the page without
them, and the server kept the player standing for `sv_timeout`'s 200 s.

**The page draws frames while a map loads, so what a frame reads must hold at every point of the
load.** A BSP match draws under its load screen before its warm-up: its deformed batches drew over
buffers not yet written, and WebGPU refused three frames' submits. A gamestate read in the
controller's update freed the world that the same frame then drew, which left the next map the
last one's clip planes, and a frame mid-load asked the next map's inline models for the last
snapshot's brush model, and threw. Draw a world only while no map loads, and work out what a
snapshot names as it is read, from its own map.
