---
name: splat-cleanup
description: Agent-assisted clean-up of a built splat map's drawn splat. It surveys where players can go, shows the user what it finds, and tries splat-transform's filters on a test map. Opt-in, slow and imperfect.
disable-model-invocation: true
---

# Splat clean-up

An optional pass over a built splat map, run because the user asked for it. The documented
clean-up is by eye, in SuperSplat, before the polish
([training.md](../../../splat-maps/docs/training.md#polish), step 1), and it stays the default.
This pass assists the user's judgement after the map is built:
- it surveys where a player can go;
- it shows the user each **finding**, an artefact with where it is seen and what draws it;
- it applies splat-transform's filters only to the findings the user picks, in a **test stem**: a
  copy of the map under a name of its own, delivered beside the original.

It is slow: hours of wall time, nearly all of it rendering. It is imperfect: a filter removes
splats by their statistics, and some artefacts have no filter. What stays wrong at the end is the
**residual**, and the user gets it in full.

The scripts are in `scripts/`. Run them from the repository's root, with the `gsplat` env active:
`python .claude/skills/splat-cleanup/scripts/<script>.py`, or `node …/<script>.mjs`. Each one's
docstring says what it reads and writes. The port scripts take `<repo>`: the checkout whose
`public/maps/` the port serves, with its `node_modules`. The **work folder** is
`splat-maps/data/<project>/cleanup/<stem>/`, which git ignores with the rest of `data/`. A **view**
is an eye in Q3 units and its angles, `viewpos`'s reading. Views live in JSON files the scripts
share: `{"name", "eye": [x, y, z], "angles": [pitch, yaw, 0]}`.

## 1. Agree the run

- Name the map: its stem and its folder, `splat-maps/data/<project>/map/`.
- Ask what the user already sees wrong, each with a `viewpos` reading of where. Those become the
  first findings.
- Read the capture's `license.txt`. A test stem from an NC or ND capture stays local
  ([lessons.md](reference/lessons.md)).
- Set the expectation, with numbers. These were measured on a high-end desktop graphics card, and
  slower hardware takes longer, most of it in splat-transform's renders on the GPU. On a
  2.5M-splat map a survey pose costs about 14 s, two panoramas. A 96-unit spacing made 72 poses
  there, and the survey took 23 minutes. A try costs about a minute and a quarter for seven views.
  The whole run takes a few hours. It needs the user three times: to pick fixes (step 7), to take
  or decline a frame-rate comparison (step 9), and to judge the test map (step 10).
- Agree the budget: the survey's spacing, and so its poses, and the hours.

**Done when** the user has agreed the map and the budget, and has named what they already see,
with readings.

## 2. Check the port draws the data

[port.md](reference/port.md) says what a check in the port depends on.
- Look for the map's pk3 in the install's `baseq3`, and where there is one, hash it against
  `public/maps/`'s.
- Write each reported finding's view to `<work>/views.json`, its eye the reading's.
- Shoot them in the port with `port_shots.mjs <repo> <work>/views.json <work>/port <stem>`.
- Render them offline with `render.py <map>/<stem>.sog <work>/views.json <work>/offline`.

A finding in both pictures is the data's, so this skill can fix it. A finding only in the port is
the renderer's, and so outside this skill: tell the user.

**Done when** each reported finding is in its offline render, or has been reported to the user as
the port's.

## 3. Survey

1. `census.py <map>/<stem>.sog <work>` writes the work's splat. Each standard filter
   ([filters.md](reference/filters.md)) marks what it would remove.
2. `reach.py <map>/<stem>.sog <work> --spacing <units>` writes the poses over every patch a player
   can stand on, since the grapple and rocket jumps reach any of them:
   - a patch lies in the bake's open space, holds a square two player widths on a side, and has
     standing room above it and a voxel more;
   - each pose is the standing eye over a rest.

   It prints the poses: at about 14 s each, widen the spacing until they fit the agreed hours.
   `survey.py` prints this machine's own rate after its first pose. If that overruns the hours,
   stop it and widen the spacing.

   On a magnified interior the open space can run outside the walls
   ([lessons.md](reference/lessons.md)). Look for that in `reach.png`, and the user decides
   whether those poses stay.
3. `survey.py <work>` renders each pose's panorama, with and without everything the census marks.
   It ranks the poses by how much changed, and writes `survey/views.json`, a view from each top pose
   facing its change, pitched at most 30 degrees.

**Done when** `survey.json` ranks every pose, each lost panorama is explained, and
`survey/views.json` holds a view per top pose. A lost panorama is a pose outside the capture, or a
render that lost its splats.

## 4. Look

- Look at each top pose:
  - its panorama;
  - its `.changed` panorama;
  - its panorama without each filter alone: `box`, `cluster`, `floaters` and `harmonics`.
- Look at every tenth panorama down the rest of the ranking, for what no filter touches.
- Write each artefact as a finding in `<work>/findings.md`:
  - where it is seen: the view;
  - what it looks like;
  - its class in [artefacts.md](reference/artefacts.md);
  - the filter whose panorama clears it, if one does.
- Copy each finding's view into `<work>/views.json`, beside the **control views**, where nothing is
  wrong:
  - the first spawn's view;
  - the levelshot's view;
  - views from two of the least-changed poses, facing the map's centre.

**Done when** each top pose is a finding or marked clean, every reported finding is in
`findings.md`, and `views.json` holds every finding's view and the controls.

## 5. Attribute

For a finding that no standard filter clears, run
`attribute.py <work> <work>/views.json <view> x0,y0,x1,y1 --without <removals to be applied>`:
- the patch is in the view's 960 × 540 pixels, tight on the artefact. The summary describes
  whatever draws the patch, so a patch that takes in a surface beside the artefact describes the
  surface;
- trust it when its check passes: its composite within 12 levels of the render;
- check that `<view>.top.png`, the top splats drawn alone, draws the artefact;
- its summary characterises the splats: their opacity, axes, flatness and height.

Match that to a class in [artefacts.md](reference/artefacts.md), or describe a new one.

**Done when** every finding names what draws it: a class, or the splats `attribute.py`
characterised.

## 6. Try filters

- For each finding, try its filter from [filters.md](reference/filters.md):
  `try_filter.py <work> <work>/views.json <name> "<actions>"`.
  - `--after` names what runs before it: census filters, or earlier tries.
  - `--region` confines a filter that harms one part of the map to another.
- Each try reports four things:
  - what it removes, in splats and in drawn area;
  - the change at the finding's view, which is the fix;
  - the change at each control view, which is the damage;
  - the views before and after.

**Done when** every finding with a candidate filter has a try with all four, and every finding with
none is marked for the residual.

## 7. Present

- Per finding, make a sheet with `sheet.py`: its view and the controls, before and after.
- Then one table: finding, where, filter, splats removed, drawn area, the change at its view, the
  change at the controls.
- Ask the user which findings' tries to apply.

**Done when** the user has chosen, for each finding, to apply its try or leave it.

## 8. Build a test stem

1. Name it, at most 15 characters ([lessons.md](reference/lessons.md)), in its own folder,
   `splat-maps/data/<project>/cleanup/<test>/`.
2. Build its splat with the chosen removals: `build_splat.py <work> <folder>/<test>.sog <removal> …`.
3. Copy the original's `<stem>.ent` and `<stem>.polish.json` as `<test>.*`. Mark the
   worldspawn's `message`, as "(Cleaned)".
4. Run [maps.md](../../../splat-maps/docs/maps.md)'s steps 5 to 9 on it, with the original's own
   choices:
   - the bake's flags from `<stem>.bake.json` ([lessons.md](reference/lessons.md));
   - the arena's `--type` and `--bots` from `<stem>.arena`;
   - the package's `--author` from the original pk3's readme, `<stem>.txt`.

**Done when** `map-<test>.pk3` is delivered beside the original, its bake re-measures clean, and
its lint passes.

## 9. A/B in the port

- Shoot every view on both maps: `port_shots.mjs <repo> <work>/views.json <work>/ab <stem> <test>`.
  Then pair each view's two shots in a sheet.
- Offer the user a frame-rate comparison, about five minutes on an idle machine. A clean-up only
  removes splats, so it never costs frame rate, and the numbers say what it gains. If the user
  wants it, run `port_perf.mjs <repo> <work>/perf.json <stem> <test>`.

**Done when** both maps are shot at every view, and the user has the frame-rate numbers of both
rounds or has declined them.

## 10. Hand over

- Show the user the pairs, any frame-rate numbers, and what the test map leaves out. The user
  judges.
- Replace the original only at the user's word ([maps.md](../../../splat-maps/docs/maps.md),
  "Changing a map"):
  1. Move the original splat and its bake into `<map>/full/`. A `full/` that already holds the
     map's splat keeps the source it was first built from, so leave it as it is and overwrite the
     one being replaced.
  2. Copy the test stem's `<test>.sog` in as `<stem>.sog`.
  3. Run maps.md's steps 5 to 9 on it, as in step 8, and deliver it:
     - with `--replace` if the map was never released;
     - as `map-<stem>_v2.pk3` if it was.
- Remove the test stem from `public/maps/` at the user's word.
- End with the residual. For each finding left: why it stays, and what a pass by eye in SuperSplat
  could do for it.

**Done when** the user has the residual, and the original map is untouched or replaced at their
word.
