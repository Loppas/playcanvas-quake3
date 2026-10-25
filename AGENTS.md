# Agents

Rules for an agent working in this repository, whatever the task: the design principles, when to
stop and ask, how the work is tracked, working memory, comments, and git. The repository's own
rules sit beside them in `.claude/`: [`code-standards.md`](.claude/code-standards.md) (how code is
written here), [`conventions.md`](.claude/conventions.md) (what porting Quake 3 has taught, by
theme) and [`testing.md`](.claude/testing.md) (how a change is proved). Read the ones a change
touches, and read the files a change touches before changing them. Where those and this file
differ, theirs, being more specific, win.

## Design principles

### The three

**SOLID.** Standard reading. In practice the two that get violated are single responsibility (a
class that both decides and reports, or both resolves and caches) and dependency inversion (a
shared component reaching for a concrete type only one consumer has).

**KISS.** The simplest thing that satisfies the requirement, not the most general one.

**YAGNI.** Build what the work asks for. A hook, flag, or extension point added for a future that
has not been scoped is not free — it is a branch nobody exercises, and it will be wrong when that
future arrives with different requirements than the ones imagined.

### Tie-breakers

**Readability beats efficiency.** When two implementations both work, take the one that reads
plainly. Efficiency wins only where a measurement says it must — not where a hunch says it might.

**Do not add moving parts.** Every new class, cache, worker, timer, retry, background task or
configuration knob is a thing that can fail, and it fails in combination with everything else. A
feature carried by fewer parts is a feature with fewer failure modes, and the parts you did not add
need no tests and no explanation.

Beware the shapes that look like diligence and are really scope:

- state kept solely to make logging cleverer
- a configuration property for a value the requirement states as fixed
- a cache in front of something that is not slow
- an abstraction with exactly one implementation and no second one in sight
- a helper that wraps a single call

### Define once what must agree

When two callers have to produce the **same** result for the system to be correct, define that once
and route both through it. Not to save typing — a rule enforced in one place cannot drift, and a
rule written down in two places eventually will.

The test is whether divergence would be a **defect**, not whether the code looks alike. The same
limit resolved by the server and the client, the same message written by one side and parsed by
the other, the same validation on both sides of a boundary: one definition. Code that merely
resembles other code and could diverge harmlessly stays separate — merging that is the
abstraction-with-one-implementation shape listed above.

This is the boundary with *do not add moving parts*. That rule asks whether a part earns its
existence; this one answers yes when its existence is what makes agreement structural instead of
remembered. Distance sharpens it: callers in different processes — the page, its worker, the
dedicated server, the master, the desktop shell — cannot see each other's copy, so nothing
surfaces the drift until behaviour disagrees.

### Keeping a shared definition shared

A single definition only holds while everyone actually goes through it. Two things erode that, and
both are cheap to prevent while the code is being written.

**Make the shared path the only path.** If the primitive it wraps stays reachable, the next caller
reaches for it and you have written a convention rather than enforced a rule.

**State the purpose as the agreement it guarantees**, not as a consequence of centralising — what a
component says it is for licenses the changes people make near it. Two tests:

- *Imagine someone ignores the component and hand-writes the thing, correctly. Is your purpose
  sentence still true?* If it is, you described a consequence — the property survives without the
  component, so nothing in the sentence requires using it.
- *Who is on the other side?* Not your callers — they are on your side. The other party is whoever
  independently holds the same expectation and breaks on disagreement: another process, a
  file format's other reader, Quake 3 itself. If you cannot name who you would be disagreeing
  with, you have not found an agreement.

The second is not a rephrasing of the first: it catches two implementations of one contract
drifting apart with nobody bypassing anything.

## Where to stop and ask

Some decisions are not the agent's to take alone. Stop and ask the maintainer:

1. **A readability-versus-efficiency tie-break** — where the faster option is meaningfully harder
   to read, or the clearer option is meaningfully slower.
2. **Introducing a new moving part** — a new class, cache, worker, timer, retry or configuration
   knob that the work did not ask for.
3. **A standard in the way of a requirement** — as
   [`code-standards.md`](.claude/code-standards.md) says: which standard, which requirement, and
   the options.

Ask before writing it, not after. Removing something is not gated the same way, but say what was
removed and why.

## How the work is tracked

Work is planned in private notes and tracked in public, on the Project linked to the repository.

- **The work's notes** are its plan (decisions, stages with their checklists, open questions) and
  its log (an entry per session). They are the working notes that [never go in a
  commit](#what-does-not-belong-in-a-commit), and nothing public names them or quotes from them.
- **Issues come from outside**, through the issue forms (bugs and ideas), or are a started cycle's
  stages and tickets. Work that is planned but not started is not filed: its milestone says what
  it is, and the detail stays in the notes.
- **A cycle of work is a milestone**, whose description says what the cycle is for. When a cycle
  starts, its plan is filed under the milestone, drafted from the plan as it stands then:
  - **each stage as an issue** labelled `stage`, saying what the stage delivers and how it is
    accepted;
  - **each item of the stage's checklist as a ticket**, a sub-issue of the stage's. A ticket is the
    smallest change that builds and passes on its own: usually one item, while items that only
    build together share one. Its title says what the change does, not where it sits in the
    plan, and the plan notes its number beside the item.
- **Every unit of work is done in a pull request**, whatever its size, and the pull request closes
  its ticket where it has one. Tickets are worked in the plan's order, each branched from `main`
  once the one before it has merged.
- **An outside issue that a cycle takes up** goes under the cycle's milestone, and the pull request
  that does the work closes it. An issue need not belong to a milestone; the ticket for its work
  then links to it and carries its labels.
- **On the Project**, a ticket is In Progress while it is worked on, and its pull request is In
  Review while it is open; the merge moves both to Done. The Project takes in new issues by
  itself but not pull requests, so add each one when it opens. A stage's issue is closed once
  its last ticket has merged and its accept holds.
- **Every issue and pull request body is checked before it goes out**, against
  [what does not belong in a commit](#what-does-not-belong-in-a-commit).

## Context and compaction

An agent's context window is a working set, not an archive. The budget: **stay under ~50% of the
context window**, and treat crossing it as a signal to act, not a threshold to drift past.

- **Compact at natural breaking points**, not mid-thought. Good breaking points: a stage of the
  work completed, a decision resolved with the maintainer, a verification pass finished, or just
  before a large exploration whose raw output will not be needed afterwards. Recommend these
  points proactively rather than waiting to be asked.
- **Check headroom before committing to a new unit of work.** If the next stage, review, or
  exploration plausibly will not fit in the remaining budget, compact first — abandoning a unit
  halfway because the window filled costs more than the pause.
- **Make state durable before compacting.** Everything the next session needs must already be in
  the work's notes: its plan (decisions, checklists, open questions) and its log (an entry for the
  session). The context window is the only place work is allowed to be lost from.
- Prefer delegating broad read-heavy sweeps to sub-agents that return conclusions, keeping raw
  file dumps out of the main window in the first place.

## Breaking points when implementing

Planning and implementing fill the window differently. Planning accumulates *decisions*, which
compact well — they are already summaries. Implementing accumulates *file state*: source read to
make an edit, build output, test failures. That is bulky, and most of it is dead weight the moment
the edit lands. So an implementing agent should break more often than a planning one, and the
breaks fall in different places.

**Break at these points, in preference order:**

- **A ticket's end.** The natural one: its pull request is open, its item is ticked in the plan,
  the log entry is written, and nothing is half-edited.
- **A green build.** Typecheck, the suite and the build passing is the cheapest possible resume
  point: the next session re-reads only what it is about to change. Never break on a red build
  without recording the failure verbatim in the log — a remembered error message is not a real
  one.
- **Before a wide mechanical sweep.** Wiring one change into twenty call sites, or a rename across
  the tree, will consume the window with near-identical diffs. Break first, then do the sweep as
  the session's single unit of work.
- **After a discovery that invalidates the plan.** Write the finding into the plan (a decision or
  an open question) and stop. Carrying a contradiction forward in working memory is how a session
  ends up implementing two incompatible designs.

**Do not break** mid-edit across a set of files that only compile together, between writing a test
and running it, or while an unrecorded decision exists only in the conversation.

**Before breaking, the durability check is stricter than in planning.** Uncommitted work is
invisible to the next session, so: every actioned change is ticked in the plan's checklist, the
log entry names the files touched and why, anything discovered-but-not-done is an open question
rather than an intention, and the working tree is either committed or its state is described in
the log. The next session should be able to start from `git status` plus the log alone.

## Comments

A comment earns its place by saying something the code cannot: a load-bearing ordering, a rule
owned by an external system, a non-obvious failure mode. One or two lines is usually enough.
Prefer a link to the source — ioquake3's `file.c:line`, a specification, the vendor's
documentation — over transcribing it.

Write about the code, not about the work that produced it. **The test: would this still be true,
and still useful, to someone reading the file in a year with no knowledge of the work?** An agent
finishes a piece of work holding a great deal of context that the file's next reader will not
have, and the pull is to write that context down where the work happened. It belongs in the work's
notes, or its pull request.

Six shapes that fail the test. They are ordered by how often they turn up in review:

- **Migration rationale** — why a value is what it is *relative to what came before*. Keep only the
  fact that prevents the mistake; the arithmetic and the before-state go in the pull request.
- **Today's consumer list** — "both callers", "used by X and Y". True this quarter, wrong on the
  next consumer, and nothing will prompt anyone to update it. Describe the rule, not the roster.
- **Domain vocabulary in generic code** — a shared helper that names one map, mode or menu has
  quietly scoped itself to the caller that happened to need it first.
- **Plan steps** — "this widens when…", "the second stage will…". Not a property of the code, and
  stale the moment the plan changes.
- **The same explanation in several places** — three copies mean three places to update and three
  chances to disagree. State it once where it is load-bearing and reference it elsewhere.
- **The work's context** — issue numbers, stage or decision identifiers, paths into the working
  notes, or the rationale for something settled in review.

Rewriting one of these usually means deleting most of it, not rephrasing it — the surviving
sentence is the one that changes what a reader would otherwise do.

## Git

### Commit messages

[Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/):
`<type>[optional scope]: <description>`, e.g. `feat(pmove): add air acceleration`. Types: `feat`,
`fix`, `docs`, `refactor`, `test`, `chore`, `perf`, `build`, `ci`, `style`, `revert`. Breaking
changes take a `!` before the colon and a `BREAKING CHANGE:` footer. The description is
imperative, with no trailing full stop. Releases are cut from these types, so the type is the
change's, not the files'.

The body is a blank line, then one `*` bullet per granular change, naming the file or part and
what changed in it. One bullet per thing a reviewer would go looking for: a one-line fix needs no
body; a change that touches twenty files needs a bullet for each part someone could otherwise
miss. Where a change is not self-evident, put the reason in the bullet — the diff shows what
changed, not why it had to.

```
fix(shell): pack home-cfg-route.mjs, which the main process imports

* electron-builder.config.mjs: list scripts/home-cfg-route.mjs, which
  electron/app-protocol.mjs imports; without it the packed shell died
  at start with ERR_MODULE_NOT_FOUND
* scripts/electron-builder-config.test.mjs: walk the main process's
  static imports from package.json's main, and check each is packed
```

### Branches and pull requests

`main` changes through pull requests alone, merged by squashing, so a pull request's title becomes
the commit's subject and is a Conventional Commit itself. Branch from `main` as
`<type>/<short-name>`, with the issue's number where there is one: `fix/42-rail-through-bots`.

### What does not belong in a commit

- **Quake 3's data, in any form**: pk3s, and anything extracted from them — textures, models,
  sounds, shader scripts, maps. The game reads them from the player's own install at runtime;
  `.gitignore` keeps `*.pk3`, `baseq3/` and `public/maps/` out.
- **An agent's working notes**: `.claude/plans/` is gitignored. What must travel with a change goes
  in its pull request, the README or the conventions.
- **Personal detail**: anyone's names, user folders, machine, network or install paths. Examples use
  `C:\Games\Quake3`.
- **Secrets**: none belong in the tree. A secret that reached a remote is compromised and needs
  rotating, not deleting.
- **Captures without a licence to publish them**: a map's splat ships only under terms that allow
  it, credited in [`CREDITS.md`](CREDITS.md).

Text that never touches git is held to the same rule: issue and pull request bodies, review
comments, and CI logs.
