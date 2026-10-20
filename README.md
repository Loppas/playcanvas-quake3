# playcanvas-quake3

Quake III Arena, ported from [ioquake3](https://github.com/ioquake/ioq3) to TypeScript on the
[PlayCanvas](https://github.com/playcanvas/engine) engine, for the browser and the desktop. It
plays Quake 3's own maps, and maps made from Gaussian-splat captures of real spaces.

To play, you need your own copy of Quake III Arena: none of id Software's data ships with the port
(see [Licence and credits](#licence-and-credits)).

## Quick start

### Play

Open [loppas.github.io/playcanvas-quake3](https://loppas.github.io/playcanvas-quake3/) in Chrome
or Edge, and choose the folder that holds your Quake 3 `baseq3` when the page asks. Every map in
your paks plays ([The web build](#the-web-build)).

The port's garage maps are on
[their release](https://github.com/Loppas/playcanvas-quake3/releases/tag/splat-maps-v0.1.0),
about 180 MB each:
[`map-garage_cats.pk3`](https://github.com/Loppas/playcanvas-quake3/releases/download/splat-maps-v0.1.0/map-garage_cats.pk3)
and
[`map-garage_rats.pk3`](https://github.com/Loppas/playcanvas-quake3/releases/download/splat-maps-v0.1.0/map-garage_rats.pk3).
Put them in your `baseq3` first, then start one from Start Server, or with `?map=garage_cats` on
the end of the address.

On Windows, the desktop shell reads your install where it sits: unzip it from the newest `v…`
release on [Releases](https://github.com/Loppas/playcanvas-quake3/releases) and run
`playcanvas-quake3.exe` ([The desktop shell](#the-desktop-shell)).

### Run from source

With Node ([Requirements](#requirements)):

```bash
git clone https://github.com/Loppas/playcanvas-quake3.git
cd playcanvas-quake3
npm install
```

Copy `.env.example` to `.env.local`, and set its `PCQ_FS_BASEPATH` to the folder that holds your
`baseq3` ([Quake 3 assets](#quake-3-assets)). Download the garage maps into `public/maps/`, the
same in cmd and bash (in PowerShell, `curl.exe`):

```bash
curl -L --create-dirs -o public/maps/map-garage_cats.pk3 https://github.com/Loppas/playcanvas-quake3/releases/download/splat-maps-v0.1.0/map-garage_cats.pk3
curl -L --create-dirs -o public/maps/map-garage_rats.pk3 https://github.com/Loppas/playcanvas-quake3/releases/download/splat-maps-v0.1.0/map-garage_rats.pk3
```

Then run `npm run dev`, and open the address it prints with `?map=garage_cats` on the end
([Run](#run)).

### Make a map

[`splat-maps/`](splat-maps/) makes a map from a capture of a real space. Its
[quick start](splat-maps/README.md#quick-start) builds `garage_cats` from the garage's capture,
then a map from your own video.

## Status

The game plays against bots, on Quake 3's maps and the port's own:

- **Single player**, through Start Server as q3_ui has it: Free For All, Team Deathmatch,
  Tournament and Capture the Flag, and CPMA's Clan Arena, on any map in your paks or the port's,
  with bots picked on SELECT BOT or added with `addbot`.
- **Quake 3's game:** its movement, the nine weapons and an off-hand grappling hook, the items and
  powerups, lag-compensated hits, and rulesets run with `exec` (`vq3`, `cpm` and others).
- **Quake 3's maps**, drawn as its `opengl1` renderer draws them, with its collision, triggers,
  movers, sounds and light grid.
- **Splat maps:** a capture's splat with a baked voxel collision, packaged as a pk3 by the
  pipeline in [`splat-maps/`](splat-maps/).
- **Multiplayer:** a listen server in the tab, which other browsers join over WebRTC; the Node
  dedicated server; and a master to find them by.
- **The desktop shell:** an Electron window that reads your install where it sits.

Not yet: a console and chat; bot AI, so a bot stands where it spawned; recording demos; votes; and
the single-player ladder and Team Arena's modes.

## Requirements

- Node `^20.19.0 || >=22.12.0`
- A browser with WebGPU (Chrome/Edge 113+); WebGL2 is used automatically otherwise
- Quake III Arena's `baseq3` paks, from your own copy

## Run

```bash
npm install && npm run dev
```

Then open the printed URL, which starts on the main menu, as Quake 3 does. Add `?map=garage_rats`
to the address to start straight in a map. In a match, click the canvas to capture the pointer.
The default binds: `WASD` to move, `space` to jump, `shift` to crouch, the left button to fire,
`1`–`9` and the wheel for the weapons, `Tab` for the scores, `Enter` to use the held item, and `F`
for the grapple. `Esc` releases the pointer and opens the menu, and SETUP's CONTROLS binds the
rest.

`npm run dev` serves PlayCanvas's debug build, whose checks around every WebGPU draw cost frames.
`npm run play` serves the same game on the release build, the one a player gets: play on it, and
chase a draw that goes wrong on `npm run dev`.

Both run the port's debug mode: the cheats, and the menu's DEBUG page, whose Status line shows the
frame rate, the graphics backend and the splat count. A build — the web build, the desktop shell
and the dedicated server — runs without it. GAME OPTIONS' Draw FPS shows Quake 3's own counter.

The dev server answers on `localhost` alone. `npm run dev -- --host` opens it to your network, for
another machine to play from by its address; reaching it by a name instead takes the name in
Vite's `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS`.

### Frame rate

With vertical sync on, as it is by default (`r_swapInterval 1`), the game draws a frame at each of
the display's refreshes. With it off, `com_maxfps` caps the frames, 125 by default, as ioquake3's
caps them: each at least `1000 / com_maxfps` whole milliseconds after the last, an overrun paid
back from the next, and 0 for no cap. A browser draws no faster than its display, so there the
cap can only lower the rate. The desktop shell started with vertical sync off draws past it, so in
the shell a change of vertical sync takes its full effect when the shell next starts.
`com_maxfpsUnfocused` caps a window that has lost its focus, vertical sync or not. SYSTEM's
DISPLAY tab has Vertical sync and Max FPS. The move steps at `pmove_msec` whatever the frame rate,
so a jump is the same at any cap.

## The map asset

A map ships as a pk3 in Quake 3's layout, with the splat and its collision octree where a BSP
would be: `maps/<n>.sog`, `maps/<n>.voxel.*`, the entities in `maps/<n>.ent`, and
`scripts/<n>.arena`. The [splat-maps](splat-maps/) pipeline builds one from a capture of a real
space and delivers it here, from `splat-maps\`:

```bash
splat-maps deliver data/garage_rats/map/map-garage_rats.pk3
```

Every `public/maps/*.pk3` is mounted at the bottom of the search path, under the Quake 3 paks,
and read by `Range` as they are. The game reads the whole map through it: the splat, the octree,
the debug collision mesh, the entities, and every arena. A map without its splat, its octree or
its `.ent` does not start. Loose files beside the pk3s are not read. The pk3s and the splats in
`public/maps/` are gitignored, at hundreds of MB. A check's override pak, `zz-*.pk3`, is mounted
under the dev server and left out of every build.

A map is started with `?map=<n>` in the address, as Quake 3's command line takes `+map`, or
changed to in the game with `map <n>`, bound to a key in `q3config.cfg`:

```
bind F9 "map garage_cats"
```

`garage_rats` is a 4.53 × 8.29 × 3.00 m garage at 17.5× life size, so the 1.75 m player is 10 cm
tall inside it; `garage_cats` is the same garage at 3.5×. Both are on
[their release](https://github.com/Loppas/playcanvas-quake3/releases/tag/splat-maps-v0.1.0), and
their parts are in [`splat-maps/examples/`](splat-maps/examples/).

A map that is not there says so in the browser's console, and the page stays on the main menu,
as Quake 3's does. One that fails to load, or fails in play, drops the match to the main menu,
which shows the error until a key is pressed.

A tab hosting players elsewhere tells them nothing when its match drops or when it leaves the
arena, as Quake 3 tells them nothing: their game stops until they time out. Closing the tab tells
them the server quit.

The map being played is freed before the next is read, under a load screen of its own.

Bots join as Quake 3's do, by name from the paks' `scripts/bots.txt`, and stay across `map` and
`map_restart` until they are kicked. The menu's ADD BOTS and REMOVE BOTS are Quake 3's own two
pages: a list of every bot the install names, with a skill to join on, and a list of the bots in
the match to take one out of.

The same through the binds:

```
bind F7 "addbot sarge"
bind F8 "kickbots"
```

`kick <name>` and `clientkick <n>` remove one. The port has no bot AI yet, so a bot stands where
it spawned. It is solid: it stops you and your shots, and a rail goes through it to the wall
behind. Shots and blasts hurt it, and a bot killed lies as a corpse until the forced respawn
21.7 s later, since it never clicks to come back. It is drawn in its own model, read from the paks
when it joins, and so is every corpse it leaves. Its pain and its death are heard in its model's
own sounds, from where it is. It bleeds where your shots strike it, and your lightning bolt stops
at it.

Who killed whom, and who joined, left or was renamed, shows for three seconds at the top left, as
Quake 3's console notify lines show it, and goes to the browser's console too.

## Quake 3 assets

No Quake 3 data ships in this repo or its builds. The game reads the weapons, their sounds and
the shader scripts from your own paks at runtime.

In dev, the server reads them from a Quake 3 install. Point it at one in `.env.local`, which is
gitignored ([`.env.example`](.env.example) lists what it takes):

```
PCQ_FS_BASEPATH=C:\Games\Quake3
```

The value means what ioquake3's `fs_basepath` means: the folder that *holds* `baseq3`, not
`baseq3` itself. Unset, it is the repo root, so a `baseq3/` folder in the checkout works as it
always has. The dev server logs the folder it serves when it starts.

Every `.pk3` in that `baseq3` is mounted in ioquake3's order and read where it sits. The page
fetches each pak's directory, then only the files it needs, by HTTP `Range`: nothing is copied,
no pak is read whole, and nothing is cached, so a replaced pak is simply read on the next boot.
A pak that will not open is skipped with a console warning, as ioquake3 skips one.

Without an install — and in any browser build — the page asks for yours. In a browser with a
folder picker, choose the folder that holds `baseq3`, and the game reads it where it is.
Otherwise drop `pak0.pk3` and its point releases on the page: it reads what it needs from them the
same way, and caches that subset in the browser.

## Tests

`npm test` runs the suite. The tests that read Quake 3's data, or the port's own map pk3, skip
without it, and the rest run, as they do in CI, which has none of it:

| Needs | Tests |
|---|---|
| `pak0.pk3` | Models, images, animations and sounds read from it, and scripted runs on q3dm1, q3dm7, q3dm12, q3dm17 and q3dm19 |
| `pak0.pk3` to `pak8.pk3`: the retail paks and the 1.32 point release | Sweeps of the 36 retail maps — their BSPs, shaders, entities, collision, lights, marks and sounds — and the dedicated server on one |
| `map_cpma3.pk3` | A scripted run on cpma3 |
| `public/maps/map-garage_rats.pk3` | The voxel octree, and the dedicated server, on the port's own map |

They read the install `PCQ_FS_BASEPATH` names, from `.env.local` or the environment:

**Windows (PowerShell)**

```powershell
$env:PCQ_FS_BASEPATH = 'C:\Games\Quake3'; npm test
```

**Linux/macOS (bash)**

```bash
PCQ_FS_BASEPATH=/usr/local/games/quake3 npm test
```

No test needs a GPU or the Internet. The network tests open data channels through
node-datachannel's native module, which `npm install` fetches prebuilt, and bind fixed ports on
this machine.

## Quake 3 maps

A map in your paks that has a BSP and no splat, such as `q3dm17`, is played as any map is:
`map q3dm17`, `?map=q3dm17`, or Start Server's FIGHT. Its world is drawn as Quake 3's `opengl1`
renderer draws it: the map's surfaces and curves, its lightmaps, sky and fog, and its shaders
moving on the match's clock, culled by the map's own PVS, with models lit by its light grid.
Players, shots and items meet its brushes and curves through Quake 3's own collision, and a shot
into the sky is lost there, leaving no mark or blast. Its jump pads, teleporters and triggers
work, and its doors, platforms, trains and the other movers move, carry and crush as Quake 3's
do. Its speakers play.

Players wade, swim and water-jump in its water, lava and slime, slide on its slick floors, and
land quietly on floors that never hurt. The water is heard as Quake 3's is, from the splash in to
the gasp at the surface, with a wake at a swimmer's waist, and metal floors clank; the view wavers
under the surface, and rockets, grenades and shotgun pellets leave bubbles there. Lava and slime
burn and fry in Quake 3's own rhythm, a player under water drowns once their air runs out, and
nothing dropped, no body and no gib is left where the map says nothing may lie. A client of a
server elsewhere loads the map from its own paks, and one without it is dropped with
`Couldn't load maps/q3dm17.bsp`, as Quake 3's is. A map that ships a splat as well is played on
its splat.

While the cheat `pcq_preview` is 1, as `?map=q3dm17&pcq_preview=1` sets it, the map opens as a
preview instead: its world alone, for a free camera flown through your binds, with no game. The
cached subset an install-less browser keeps holds no BSP, so it plays and previews none.

`npm run reference` draws the capture maps in your installed Quake 3 and in the port, at the same
view and time, and compares them texel by texel (`scripts/q3-reference.mjs`).

`npm run q3-play` has your installed Quake 3 walk, jump, fall, swim, slide and burn on its maps,
and ride its jump pads, teleporters, doors, platforms and other movers, in a small window for a
few seconds a case, and the port's server play the same keys from the same place: every snapshot
of Quake 3's demo is held to the port's player, its health too (`scripts/q3-play.mjs`). Beside
the retail paks, its cases need `map_cpm18.pk3`, `map_cpma3.pk3` and `tig_gng.pk3` in your
install's `baseq3`; `--cases` runs a few alone.

## The web build

`npm run build:pages` builds the page for GitHub Pages, which serves it at
[loppas.github.io/playcanvas-quake3](https://loppas.github.io/playcanvas-quake3/), the
repository's project site, so the build's paths start with `/playcanvas-quake3/`. `npm run build`
and the shell's build stay at the root.

What plays there is what your paks hold. In a browser with a folder picker, such as Chrome or
Edge, choose your Quake 3 folder, and every map in it plays, at every visit, read where it sits.
Elsewhere, drop `pak0.pk3` and its point releases: that visit plays their maps, and later visits
start from the subset the browser kept of them, which holds no BSP, so they play the port's own
maps alone.

The port's maps stay out of the Pages build, whose site is capped at 1 GB. A host of their own
serves them, and the build is given their folder as `VITE_MAPS_URL`:

```bash
VITE_MAPS_URL=https://maps.example.com/q3/ npm run build:pages
```

The folder holds the map pk3s and their listing, `paks.json`, as `npm run build` writes them into
`dist/maps`. The host answers CORS for the page's origin, allowing the `Range` header, and answers
`Range` with a 206 and the bytes uncompressed. Without `VITE_MAPS_URL`, a build reads the maps from
`maps/` below its own base, and the Pages build has none there: until the maps have a host, it
plays the maps in your paks.

An owner's project sites on `github.io` share one origin, and with it the browser's storage, so a
build keeps its cache, `q3config.cfg` and the install folder below its own base. The drop screen
says whose the game is, and links the source at the commit built, the licence, `NOTICE`,
`CREDITS.md` and the bundled packages' licences, which the build carries beside `index.html`:
`LICENSE` and `NOTICE` as `.txt` files, which a static host shows rather than downloads.

## The desktop shell

The shell is an Electron window around the same web build. It reads the Quake 3 install where it
sits, and keeps `q3config.cfg` and `favorites.txt` in `%LOCALAPPDATA%\playcanvas-quake3`, the
folder the dev server writes them to (`~/Library/Application Support/playcanvas-quake3` on macOS,
`$XDG_CONFIG_HOME/playcanvas-quake3` or `~/.config/playcanvas-quake3` on Linux).

On its first start it asks where Quake 3 is installed: pick the folder that holds `baseq3`, or
`baseq3` itself. The pick is kept in `shell.json` beside `q3config.cfg`, and the shell asks again
when that folder no longer holds a pak. SETUP's GAME DATA picks a different install for the next
start.

`npm run shell` runs it over the Vite dev server, from the sources; F12 opens the developer tools
there. `npm run shell:build` builds an unsigned Windows folder, `release/win-unpacked`: run
`playcanvas-quake3.exe` in it. The build holds Electron, the web build and the map pk3s, and no
Quake 3 data. Beside the exe are the licence, `NOTICE`, `CREDITS.md`, and the bundled packages'
licences in `THIRD-PARTY-NOTICES.md`.

## The dedicated server

`npm run dedicated` builds and runs the Node dedicated server, the port's `ioq3ded`: the same
server a page's listen server runs, with no player of its own. Its command line is Quake 3's,
behind npm's `--`:

```bash
npm run dedicated -- +set dedicated 1 +map garage_rats
```

`+set` and `+seta` set cvars before anything reads one, and every other `+` word is a console
command, run in order once the server is up. It boots with no map, as Quake 3's does, and answers
nobody until `+map` or `map` spawns one. As a build, it runs without the port's debug mode, so
`sv_cheats` is Quake 3's: 0 under `map`, 1 under `devmap`.

An error in a frame, or a map that fails to load, ends the match as Quake 3's `ERR_DROP` does:
the error is printed between rows of stars, the server shuts down without telling its players,
who time out, and it waits at its console for the next `map`. Errors that keep coming, each
within 100 ms of the last, end the program instead, with exit code 3. Its terminal gets each
error's stack as well.

It reads the paks from the same folders as the dev server: the `baseq3` that `PCQ_FS_BASEPATH`
names, from the environment or `.env.local`, and the port's own `public/maps`. Its home folder is
the one the dev server keeps `q3config.cfg` in, or `PCQ_FS_HOMEPATH` where that is set. It reads
`q3config.cfg` there as it boots and never writes it, and `exec` finds cfgs there before the
port's own presets.

`dedicated` decides who can find it:

| Value | Server |
|---|---|
| `1`, the default | A LAN server. It registers with both masters and sends no heartbeat, so it shows in the server browser's Local list for players on its network. |
| `2` | An Internet server. It heartbeats to both masters as well, so it shows in the Internet list too. |
| `0` | Stops the server, as Ctrl+C does. |

Players find it under MULTIPLAYER, or reach it with `connect <address>` from a bind. Either way
they reach it through a master, so one has to be running: `npm run master` beside it, or
`+set sv_runMaster 1` on its command line (see the master, below). Every player's data channel
comes in on one UDP port, `net_port`: 27960, or the first free one of the nine above it.

Its terminal is its console. Each line typed there is a command, and its own are Quake 3's:

| Command | Does |
|---|---|
| `map <name>`, `devmap <name>` | Change map. `devmap` leaves `sv_cheats` at 1 and starts without the bots. |
| `map_restart [delay]` | Restart the match in place, or load the map again when `sv_maxclients` or `g_gametype` changed. |
| `addbot <name> [skill 1-5] [team] [msec delay] [altname]` | Add a bot from the paks' `scripts/bots.txt`. |
| `kick <name>`, `clientkick <n>`, `kickbots` | Remove a player, a slot, or every bot. |
| `status`, `serverinfo` | Print the map and its players, or the serverinfo. |
| `heartbeat` | Heartbeat to the masters now (see below). |
| `exec <file>`, `wait` | Run a cfg, or wait a frame. |
| `set`, `seta`, `toggle`, `reset`, `<cvar> <value>` | Set a cvar. |

## The master

Servers are found through a master, the port's dpmaster. `npm run master` runs one on this
machine, on port 27950, which both `sv_master` slots name by default. The Node dedicated server
can run one inside itself instead:

```bash
npm run dedicated -- +set dedicated 2 +set sv_runMaster 1 +map garage_rats
```

The master has no console and takes no flags. It logs every message it handles to its terminal,
as `> 127.0.0.1:27960 ---> heartbeat (DarkPlaces)`. It answers dpmaster's messages, as dpmaster's
[techinfo.txt](https://github.com/kphillisjr/dpmaster/blob/master/doc/techinfo.txt) describes
them, over a WebSocket rather than UDP:

| Message | From | Answer |
|---|---|---|
| `heartbeat DarkPlaces` | A server | `getinfo <challenge>`, down a data channel the master dials to the server. Any other tag is refused. |
| `infoResponse` | A server, to that `getinfo` | The server listed for 15 minutes, if its challenge, protocol and game name check out. |
| `getservers <game> <protocol> [words]` | A client | `getserversResponse`: the listed servers' IPv4 addresses. |
| `getserversExt <game> <protocol> [words]` | A client | `getserversExtResponse`: the listed servers of both families. |

The game is `PlayCanvasQuake`, and a query for any other is refused. The words filter the list:

| Word | Lists |
|---|---|
| `empty`, `full` | Empty or full servers too, which are left out otherwise. |
| `ffa`, `tourney`, `team`, `ctf`, `gametype=<n>` | One gametype only. |
| `ipv4`, `ipv6` | One family only, with `getserversExt`. |
| `local` | The port's own: every server registered from the asker's network, heartbeat or not. It is how a browser finds the servers on its LAN. |

Beside these, the port's own frames (`src/net/master-protocol.ts`) grant a server the port it
registers, look a name up for a client, and pass WebRTC signals and connectionless datagrams
between sockets that have no data channel to each other.

The commands that reach a master, from a bind or the dedicated server's terminal:

| Command | Does |
|---|---|
| `globalservers <0-1> <protocol> [words]` | Asks `sv_master1` for its list, as the server browser's Internet source does. 0 asks every Internet master, which is `sv_master1` alone. |
| `localservers` | Asks `sv_master2` for the servers on your network, or `sv_master1` when that slot is empty or its master can't be reached. |
| `heartbeat` | On a server at `dedicated 2`, heartbeats to both masters now, rather than waiting out the five minutes between heartbeats. |

And the cvars:

| Cvar | Default | Is |
|---|---|---|
| `sv_master1` | `localhost` | The Internet's master, which `globalservers` asks. |
| `sv_master2` | `localhost` | The LAN's master, which `localservers` asks first. |
| `sv_runMaster` | `0` | The Node dedicated server runs a master inside itself, on 27950. |

Every server registers with both masters, and one at `dedicated 2` heartbeats to both, as Quake 3's
does to every slot; two slots that name one master share its link and its heartbeat. The Node
dedicated server pings each master every 30 seconds, and closes and opens again a link that hasn't
answered by the next ping. A master forgets a server whose link closes, so a server at
`dedicated 2` heartbeats as soon as a link opens again. A slot is `host[:port]`, reached by `ws://`
on `localhost` or a private address and by `wss://` otherwise, or a `ws://` or `wss://` URL taken
as given.

## Scripts

| Command | Does |
|---|---|
| `npm run dev` | Vite dev server with HMR, on PlayCanvas's debug build |
| `npm run play` | The dev server on PlayCanvas's release build, to play on |
| `npm run shell` | The desktop shell, over the dev server |
| `npm run shell:build` | Build the shell for Windows into `release/win-unpacked` |
| `npm run dedicated` | Build and run the Node dedicated server (see above) |
| `npm run build:dedicated` | Build the dedicated server into `build/`, without running it |
| `npm run master` | Build and run the master (see above) |
| `npm run build:master` | Build the master into `build/`, without running it |
| `npm run deploy:master` | Deploy the master to Cloudflare as a Worker (`master/cloudflare/`); `-- --dry-run` bundles it without an account |
| `npm run record` | Record a play session — frames, contact sheets, video (see below) |
| `npm run probe:layout` | Measure every menu page against the layout rules, at 16:9 and 4:3 |
| `npm run reference` | Draw the capture maps in Quake 3 and the port, and compare them (see above) |
| `npm run q3-play` | Play the same moves in Quake 3 and the port, and compare (see above) |
| `npm test` | Run the Vitest suite once |
| `npm run test:watch` | Vitest in watch mode |
| `npm run typecheck` | `tsc --noEmit`, for the page, the shell's main process and the master's Worker |
| `npm run build` | Typecheck + production build to `dist/` |
| `npm run build:pages` | Typecheck + the GitHub Pages build to `dist/`, without the maps (see above) |
| `npm run preview` | Serve the production build |

## Recording a play session

Some defects cannot be written down — "the rocket shrinks when I strafe" is a sentence that
took four rounds of prose and two wrong hypotheses. `npm run record` opens the game in a real
headed Chromium, captures it while you play, and lets you mark the moment it happens.

```bash
npm run record
```

It starts the dev server if one is not already up, on `garage_rats` unless `--url` names another
page.

**F8 toggles.** Press it in the browser when the thing starts, press it again when it ends —
everything between is one segment, and that is what gets kept. Press Enter, Ctrl-C, or close
the window to stop; a segment still open is closed for you. The badge in the bottom-left
holds a red border for as long as a segment is open, so there is never any doubt which state
you are in. `m` + Enter in the terminal does the same as the key.

Bracketing replaced a point-in-time mark after the first real playtest: 11 presses across
46 s landed anywhere from 800 ms *before* the event to seconds after it, so no fixed window
around them caught what they pointed at and every sheet came out empty. Two presses remove
the guess.

Output lands in `recordings/<timestamp>/` (gitignored):

| File | For |
|---|---|
| `sheet-segment-N.png` | **The one to hand over.** A labelled grid of one bracketed segment. |
| `frames/*.jpeg` | Every captured frame at full canvas resolution, named with its elapsed time. |
| `video.webm` | The clip, for scrubbing by eye. |
| `manifest.json` | Frame times, segments, and every console line / page error / HTTP error stamped on the same clock. |

The contact sheet exists because an agent can read a PNG and cannot watch a video. Paste its
path into a Claude Code session and the defect is *shown* rather than described.

A sheet is for **locating** the moment, not for reading fine detail — thumbnails are ~440 px
wide, so anything small (a projectile, a thin beam) averages away. Once the sheet says which
frames matter, read those `frames/*.jpeg` directly: they are captured at the display's real
backing resolution, which is where the detail actually is.

### Capture frequency

`--fps` sets how many frames a second are written. The default of 20 is enough to *locate* a
moment and not enough to *watch* one — a rocket at 900 ups crosses this map in under a second,
so twenty frames is the entire flight. Raise it when the thing you need to show happens inside
a handful of frames:

```bash
npm run record -- --fps 60 --max-frames 4000
```

Any rate up to the browser's own composite rate is honoured exactly, so 60 s at `--fps 30` is
1800 frames and at `--fps 60` is 3600 — past the default 2000-frame cap, hence `--max-frames`
above. `--fps 0` keeps every frame the compositor delivers. The tool prints the arithmetic
before it starts (`20 fps · one frame every 50ms · the 2000-frame cap is 100.00s`) and prints
what it actually captured when it stops. If that is below what you asked for, the page was not
compositing that fast and no flag will change it. That number is the capture cadence, not the
game's frame rate.

High rates cost disk quickly — a frame of this map is ~670 KB at JPEG 90, so `--fps 45` writes
30 MB a second and reaches the default 750 MB cap in about 25 s. Both caps stop the capture,
not the recording; the session keeps running and says so once.

Frames default to JPEG: a photogrammetric splat frame is a photograph and compresses like one
(4.0 MB as PNG against 669 KB at quality 90). Use `--format png` when frames are going to be
measured pixel by pixel. `npm run record -- --help` lists the rest — viewport, duration, device
scale, caps.

Every headed recording logs one or two `Failed to load resource: 404` console errors with no
URL. That is Chromium asking for a favicon this project does not have; a 404 that matters
shows up as an `httperror` line with the URL on it.

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md) covers setting up, working without Quake 3, and pull requests;
[SECURITY.md](SECURITY.md) says how to report a vulnerability. Agents working in the repository
follow [AGENTS.md](AGENTS.md).

## Licence and credits

The port is free software under the GNU General Public License, version 2 or (at your option) any
later version: see [LICENSE](LICENSE). It translates ioquake3 and other GPL code, whose copyright
lines are in [NOTICE](NOTICE). [CREDITS.md](CREDITS.md) credits the mods, specifications, tools and
map capture it draws on, and each build lists the packages it bundles, with their licences, in its
`THIRD-PARTY-NOTICES.md`.

No Quake III Arena data ships with the port: to play, you need your own copy of Quake III Arena.

This is a fan project, not affiliated with or endorsed by id Software, ZeniMax Media, Bethesda,
Microsoft, PlayCanvas or Snap. Quake and Quake III Arena are trademarks of id Software LLC.
