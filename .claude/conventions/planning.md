# Taking a stage

**Survey the tree before building a stage.** Read what is already there, and find the comments
that say they wait for this stage. It shrinks stages: `CalculateRanks`, the session's fields and
`PM_FlyMove` were already in the tree when the stages that needed them began. It also finds what
is missing outright: there was no touch and no `trigger_push` when items came to need them.

**Survey the data as well as the tree, with a probe of the stage's own.** Each renderer stage's
design ran a throwaway Vitest file over the 36 retail maps, a rough port of Q3's code kept apart
from the build, and its counts became the design's tables. The build then matched them at its first
run and pinned them, and a difference was explained before either was changed. The probe finds
what reading cannot: the cases no retail map reaches, and what each view shows.

**Survey Quake 3's C in both releases, and where they differ, before the design.** Each stage's
design read ioquake3 and id's 1.32 release side by side and listed every place the two differ in
what it ports, so that each was put with ioquake3's as the default and id's for the maintainer to
weigh.
Source not in hand is said to be, never assumed: id's renderer backend files were compared by
ioquake3's change notes, and what the survey said of id's `snd_mix.c` was marked unverified.

**Leave nothing in a stage unscheduled.** When a stage is split, every part of it gets a stage of
its own or an explicit deferral, and the stage is done when its acceptance check has passed, not
later. Item drops and the powerup look on a player turned up unscheduled only after six of their
stage's parts were built, and two finished stages were found still open when the work closed.
