# Settings

**Settings are cvars, named after the ones they stand for** (`src/settings/registry.ts`): Q3's,
a mod's where the setting is the mod's, or the port's own under `pcq_`. `q3config.cfg` keeps
them in Q3's `seta` and `bind` lines, rewritten on every change and read at start. A change
applies at once, except to the renderer's settings that Q3 latches, `cl_renderer` and
`r_overBrightBits` among them: they apply through `vid_restart`, Q3's own apply, which here saves
the settings and reloads the page. Any setting can also come from the address, by its cvar name:
`?cl_renderer=opengl2&r_overBrightBits=0` draws like `opengl2` without overbright, and
`?g_allowGrapple=3`, the CorkScrew mod's cvar, throws the Quake II CTF hook. The address's value
wins in its own tab and is never saved, so two tabs with different parameters still give a quick
side-by-side, and the status line shows the settings in force.

**A setting takes effect at one of four times.**
- **At once**, read where it is used: `g_speed` and `g_gravity` at every think, and every preset's
  values. The server's rules record is re-read at the top of a frame when a cvar's modification
  count moves, so a change reaches the next frame, as a `vmCvar_t` does. A client predicts by the
  rules its server sends (below), so on the tab's own server a change reaches prediction a few
  frames later, once the systeminfo comes back.
- **Latched until `map` or `map_restart`**: `g_gametype` and `sv_maxclients`, read only as the
  game module starts. A restart that finds one changed becomes a full map load, and the
  menu's APPLY is that restart.
- **Fixed at a map load**: worldspawn sets `g_gravity` at every load, and an item a switch
  gates spawns only if the switch was on then.
- **At the shell's next launch**: Chromium takes its switches only as it starts, so the shell reads
  `q3config.cfg` before it does, and tells the page what it read (`/launch`). `r_swapInterval` off
  starts it unpaced; the page takes the setting at once, but cannot draw past the display's rate
  until then.

A mod's ruleset changes all at once and never mid-match. The port's switches are separate cvars,
so each switch that holds state has a written rule for a change mid-state: a slide ends on the
next move, and a grenade in flight bounces by the rules in force when it bounces.

**A server's systeminfo never sets the player's rules.** Quake 3's `CL_SystemInfoChanged` sets each
key it carries as a cvar (id's `cl_parse.c:373`; ioquake3's, `:411–430`, refuses a key a server may
not set and makes one the client never held read-only). Here the rules are the player's own
settings, archived, which a preset sets and the tab's own server boots from, so a server elsewhere
that set them would leave its rules in the player's file and in their next match. The client reads
the rules, and the hook, the rewind and `sv_fps` beside them, into a record on its connection
instead (`readSysteminfoRecord`, `src/sim/rules.ts`), rebuilt from each systeminfo the server sends.
The port's servers send every one; a key a server leaves out reads as id's value, as a game without
that rule runs, and a missing `sv_fps` as the port's 125. The other keys are set as ioquake3 sets
them, Quake 3's own `pmove_msec` and `sv_cheats` among them, and client code reads a rule from the
record, never from the store. The fidelity given up is the systeminfo held in the client's cvars: on
a server elsewhere the store holds the player's setting, not the rule in force, so the console and
the menu's rows show the player's, where Quake 3's shows the server's.

**A new default bind never reaches an existing player.** A saved `q3config.cfg` starts with
`unbindall`, as Quake 3's does, so a bind added to the defaults later is lost at the next load:
Tab for the scores and Enter for the held item were both missed that way. A report that a new key
does nothing usually means an old config. The fix, as in Quake 3, is a row on the Controls page,
not patching configs at load.

**Every cvar the port registers is read, where it is used.** `g_forcerespawn` was registered
and never read: the 20 s was a constant, and Quake 3's 0, never force, did nothing. A test that
sets the cvar away from its default is what shows it is read.

**Every cvar Quake 3 registers is registered, an empty one too.** The console sets a cvar by its
name only once it exists: `net_dropsim 5`, unregistered, went to the server as a client command,
where ioquake3 registers it empty (`net_ip.c:1488`).
