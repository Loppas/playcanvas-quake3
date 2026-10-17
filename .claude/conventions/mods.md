# Mods on id's core

A mod comes to the port as its rules on id's code, not as its own code, and its
rulesets come as settings and presets.

**A mod extends id's code and leaves it as it was.** The mod's constants go in a rules record
whose defaults are id's values. id's function is split into protected steps only where a trace
shows the mod departs, and the mod's subclass (`CpmaPmove extends Pmove`) overrides each step
behind a switch of its own, falling through to id's otherwise. Where the mod departs too often
(CPMA's weapon step does at 8 of id's 13 steps), its function is written whole from pieces lifted
out of id's, in id's order. The proof is the whole existing suite, goldens included, passing
unchanged through the mod's path at the defaults.

**A mod's own "vanilla" is not id's.** Some of a mod's core changes apply under every ruleset,
its id-like one included: CPMA's VQ3 still has its step event, a 1-unit muzzle, splash lift and
health decay. Each gets a switch of its own with id's default, rather than riding a ruleset, and a
gate hidden in the mod's code (CPMA's slide stands on "accelerate > 1") becomes a switch too.

**A ruleset is settings and a preset, not a mode.** Every value and behaviour a ruleset reaches
is an archived cvar whose default is id's, so a fresh install plays id's game. A named ruleset is a
cfg run with `exec` that sets every cvar in its family with `seta`, so switching leaves nothing of
the last one behind and what it sets is saved; the default preset sets exactly the defaults, and
tests hold both. A label cvar (`g_gamepreset`) records which preset ran and applies nothing, and
no mode-switch cvar re-applies a ruleset at each start, which would wipe a player's own changes.
Rules the client needs travel as serverinfo cvars, and a serverinfo without them means id's rules.

**A new cvar takes the first name that fits:** Quake 3's own; then Quake Live's, where a source
confirms it means the same, with id's default rather than Quake Live's; then a new name in its
family's style (`g_damage_<w>`, `pmove_*`, `armor_*`). A value that can say "off" replaces a
separate switch. Names are permanent once a config has saved them, so they are settled before the
build.

**New state goes after id's, never at the mod's numbers.** New enum values, events, flags, stats
and items take the next free slot after id's: CPMA's event 66 is one of id's own, so the port's
is 83, and CPMA numbers Clan Arena 5, which is id's One Flag CTF, so the port's is `GT.CA = 8`.
Choose the zero value so that a state that never used the feature is id's state, and check every
range test a new value falls into: `GT.CA` lands in each `>= GT_CTF` branch.

**A mod that ships only compiled code can still be read.** Its QVMs answer in three layers:
- **Strings** name its cvars, its menu's labels and the assets it loads.
- **Pointer tables** in the data segment hold Q3's tables. A cvar table pairs each name with its
  default string, and a menu's list gives each value's label in order. Read them through the
  pointers, not the order the strings are pooled in, which misleads.
- **The logic** needs a disassembler, and a short one does: the VM is a stack machine of about
  60 opcodes, and `ENTER` starts each function. Code reads a cvar through a fixed address (its
  `vmCvar_t` plus 8 for `.value`, 12 for `.integer`), which finds the code that uses it. Offsets
  then decode against ioq3's structures (`playerState_t`, `pmove_t`, `pml_t`, `refEntity_t`).

Check the method against a value the mod states elsewhere, such as a default its `.cfg` files
set, before trusting what it reads.
