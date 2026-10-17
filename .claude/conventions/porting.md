# Porting fidelity

How the port stays Quake 3: measure rather than derive, read the source rather than a claim about
it, and port what id wrote, as it wrote it.

## Measurement over derivation

**A golden value is measured from the port's own behaviour, then pinned by test.** Do not compute
it from a textbook formula and assert it. A plan once predicted a 45.56u jump apex from `v²/2g`
and got 48.53u; the port was right and the plan was wrong. Another assumed fall-damage bands at
`0.16 × distance` from `g = 800` and measured `0.15 ×`.

**When a test disagrees with the port, suspect the expectation first.** Four of the movement
port's first assertions were wrong rather than the code. A divergence from theory is a finding to
explain, not a bug to fix — reproducing Q3's actual behaviour is the whole point.

**A claim about Quake 3 is a guess until it is read at the source.** Plan decisions, research
summaries, comments (id's and the port's) and line citations were each wrong about Quake 3 more
than a dozen times in one cycle. The port's own comments said players never block each other and
that `CS_SERVERINFO` goes out only at a map load, and a trace of CPMA's code corrected rules an
earlier stage had already built. Read the function before building on the claim, not after. A
mod's code outranks its docs, its tables and its changelog. baseq3 also carries dead code and Team
Arena's names (`CG_ScoreboardMessage`, `EF_KAMIKAZE`; `CTF_FLAG_RETURN_TIME` is never read), so
read a value where it is used, and check that a function has a caller.

**Probe, then delete the probe.** Throwaway scripts are the right way to find a real constant;
what ships is the constant plus a comment explaining the mechanism, not the scaffolding.

**Choose a metric that measures the defect, not motion in general.** The camera's first
smoothness check (largest per-frame eye movement) failed on the glide itself, which is legitimate
motion. The metric that worked measured eye movement *only on frames where the origin teleported*. A metric
that flags correct behaviour will get tuned away and take the real defect with it.

## The velocity snap is physics, not rounding

**The per-tick integer velocity snap changes the simulation and must be preserved** in id's move,
which is `pmove_SnapVelocity 1`, the default. CPMA's move leaves it out, and with it off gravity is
the configured 800 and the fall bands are where `v² / 2g` puts them. At the fixed
125 Hz tick, gravity takes 6.4 ups per 8 ms and the snap rounds 263.6 *up*, so vertical speed
falls by 6 — an effective gravity of **750, not the configured 800**. This raises the jump apex
 and pushes the fall-damage bands about 6% further in distance (47 / 267 / 400 units rather
than 44 / 250 / 375).

This *is* Q3's frame-rate-dependent jump height — at 60 fps the rounding goes the other way and
the apex drops. Reproduce it; do not correct it. Anything derived from gravity under id's move
must use 750.

## Porting a function

**Every movement constant is named as in `bg_pmove.c`, with its source file and line.** Constants
that diverge from source values need both a pinning test and a logged decision (code-standards).

**Port a function whole, in id's order, through id's own helpers.** When the port behaves
differently from Quake 3, the cause has almost always been a line of id's left out, a step moved,
or a guard id's code hasn't got, not a difference worth keeping. `G_InitGentity`'s `s.number`
line was left out because the number "never changes", and a bot's spawn went to slot 0: the bot
had no body, and the player was thrown across the map. `PMF_RESPAWNED` was dropped once attack was
let go, where id's waits for attack and use both. A pitch clamp on the client broke the spawn's
facing, which works through `delta_angles`. Port the setup that follows a clear, too: the spawn's
`memset` left `commandTime` at 0, so the first command moved for as long as the match had run.

**C's number types are behaviour.** Port the types behind the arithmetic, not only the formula:
`int` truncates, a `short` sign-extends, a `float` product is single precision (`Math.fround`, and
`Object.is` where −0 matters), and text becomes a number through `atoi` or `atof`, never `Number`.
`SHORT2ANGLE` masked where it should sign-extend, so looking up read as 350° rather than −10°, and
the armour rescale came out a point off in doubles. Test at an input where float32 and double
disagree, or the test cannot tell them apart. The velocity snap above is this rule, applied to one
line of `bg_pmove.c`. Read a value worked from the clock late in the clock too: in doubles,
`q3dm19`'s bobber parts from the QVM's by 2.3e-4 units in 10 s and 0.03 at ten minutes, so the
movers' twin reads each one hours in.

**Pointers and memory are literal.** A client's slot is its index, `e - g_entities` or
`client - level.clients`, never `s.number`: while a client is connecting,
`BG_PlayerStateToEntityState` writes a zeroed `clientNum` over its entity's number, and `SetTeam`,
which runs inside `ClientConnect`, read the wrong slot from it. A `memset` clears in place, so the
object keeps its identity, and `*to = *from` copies the whole struct: copying one field of it left
the previous player's CTF stats in a slot. Entity 0 is a client, so 0 never means "none".

**Port Quake 3's resets with what they reset, and keep across one only what Quake 3 keeps.** A
map load wipes `sv` whole (`SV_ClearServer`), a new world's first snapshot resets every entity
(`CG_SetInitialSnapshot`), the renderer registers its shaders afresh at a gamestate, and a match's
end stops every sound, a one-shot playing too (`S_StopAllSounds`). Kept across a load, the
server's clock started only the first map at 400, a `map_restart` still counting down fired on the
next map, and the last map's sounds held their `CS_SOUNDS` slots until enough map changes would
have overflowed them. A world kept in hand registered cgame's shaders again, so a kept index
came to name another shader, and the view kept the last world's pairs into the next one's
first snapshot. A `map_restart` keeps the portal counts and `CS_SHADERSTATE`, as Quake 3's
does. A new gamestate starts cgame afresh, as `CG_Init`'s memsets do: the last map's
centre print, timed on its clock, drew "FIGHT!" on the next map until the new clock passed it,
67.9 s.

**Port the C as ioquake3's x86-64 build runs it.** A byte past 127 is whitespace, as a signed
`char` reads it; `ri.ftol` truncates as `cvttss2si` does; the stitcher's read past a
table's end takes the zone's trailer that follows it. Where Q3's result rests on its heap's
layout, run the corpus both ways and keep the reading they agree on. A read past an array
that stays inside the map's data is ported as it reads: for a point in solid, `SV_inPVS` takes the
last byte of the row before the eye's. One that leaves for the stack or the hunk reads 0, as
the twin's zeroed buffer has it, and is recorded, as a byte past a sound file's end is.
A null pointer is no one, where the QVM reads whatever lies near address 0.

The game module and cgame are the exception: ioquake3 runs both as QVMs by default, as the
scripted run does, and q3lcc's `double` is a float. So `AimAtTarget`'s `.5` and its quotient are
floats and a root is a trap's double rounded to one, and `M_PI` is `q_shared.h`'s float, so
the game's `AngleVectors` turns otherwise than the engine's. cgame's movers, rider carry,
marks and listener are worked in those floats on the client too; pmove keeps
its doubles, a departure the scripted run bounds.

**A failure is Quake 3's, in its words and in its order.** Checks run in the order Q3's loaders
make them, collision's before the renderer's, so a map with several faults stops on the one Q3
reports, worded as the first loader to read the lump words it. A drop Q3 makes at a draw is
made at the draw. Where Q3 reads past a lump into whatever lies there, the port refuses in
words of its own rather than throw a bare `RangeError`.

**A fallback never catches a failure Quake 3 requires.** The fly camera once caught every error
from building the controller, so a map with no spawn point opened the fly camera where Quake 3
stops with "Couldn't find a spawn point". Catch the one failure the fallback exists for, and
let the rest stop the load.

## Departures and scope

**A departure from Quake 3 is a decision, and says what it costs.** It names the difference, its
cost, and the fidelity claim it gives up, and a pinned test that rests on an inferred value is
removed rather than guessed at. Where one of the port's own differences makes id's code show what
Quake 3 never shows, restore what id's code expects rather than adding an exception inside it:
bots that never think sent no commands and wore the connection-trouble icon, so each is now sent
an idle command every frame, as a thinking bot is. Where ioquake3 differs from id's release,
ioquake3's is the default, its changes being fixes to long-standing faults, and id's the
alternative to weigh; the choice is logged either way. The scripted run's Quake 3 runs the retail
game module, which is id's, so the run cannot hold an ioquake3 game change where the two differ.

**Scope the port explicitly.** What is left out is named, with the reason. Flight left that list
with the items, which brought `PM_FlyMove` with it; the shots' flags came with Quake 3's collision;
and water and the surface flags pmove reads (`SURF_SLICK`, `SURF_NODAMAGE` and the footsteps') came
with point contents on both sides, the game's drowning, lava, slime and `CONTENTS_NODROP`
with them, and the client's water, heard, warped and bubbling, with its gibs in nodrop.
`com_maxfps` paces the frame again, with vertical sync to lift it. Absence is a decision, not
an oversight.
Port only what can run here. A branch nothing can reach (`EV_GLOBAL_SOUND`'s model sound, which
no game sends), a mod setting with nothing in the port to act on, and a feature the port's design
already answers are recorded as not ported, with the reason, rather than built. A function waits
for its first caller: `Team_FreeEntity` came with nodrop, and `trap_InPVS` with the server's areas.
