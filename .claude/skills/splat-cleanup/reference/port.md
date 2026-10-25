# The map in the port

What a check in the port has to know before its pictures or numbers mean anything.

- **Which pk3 the port serves.** The port reads the install's `baseq3` as well as `public/maps/`, and
  a `map-<stem>.pk3` in the install shadows the one in `public/maps/`. An old copy there once made a
  rebuilt map look unchanged. Before shooting a map, look for its pk3 in the install (the
  `PCQ_FS_BASEPATH` in `.env.local`, as `C:\Games\Quake3\baseq3`), and hash both copies. When
  their bytes differ, ask the user before moving theirs aside.
- **The splat renderer adds nothing in motion.** The engine sorts the splats on the GPU every frame.
  On `vegetables_mice` a still shot at a pose from a recorded lap matched the lap's moving frame, and
  splat-transform's rasteriser drew the same fog. So an artefact the offline render shows at the
  same view is the data's.
- **The offline view is the port's.** `splatlib.camera` renders 73.74 degrees tall, as the port
  draws, from the same eye and angles, so a port shot and an offline render at one view frame the
  same scene. Three things differ, so compare them by eye:
  - the port always draws the player's weapon at the bottom centre, since it has no `cg_drawGun`;
  - its background is near black, (13, 13, 15), where the offline render's is black;
  - its colours sit a few levels apart from the offline render's.

  On `vegetables_mice`, 3 to 12% of a view's pixels moved by more than 24 levels between the two.
  Between two maps holding the same splat in the port, under 1% did.
- **The Browser pane cannot read the map pk3s.** Play a splat map headless in Playwright, as
  `port_shots.mjs` and `port_perf.mjs` do, on the repository's perf harness
  (`scripts/perf/perf-lib.mjs`).
- **A dev server the user has running keeps the splat it loaded.** A variant under its own stem
  never touches it.
- **Frame rate swings between runs.** Run the two maps alternating, on an idle machine, and judge
  across the rounds, not on one pair.
