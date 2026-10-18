# Contributing

Thanks for wanting to help. The port follows ioquake3's C closely: a change to how the game plays
is held to what Quake III Arena does, and cites the C it follows as `file.c:line`. Where the port
departs from Quake 3 on purpose, the code says so.

## Licence

The port is under the GNU General Public License, version 2 or (at your option) any later version.
A contribution is offered under the same licence, as
[GitHub's terms](https://docs.github.com/en/site-policy/github-terms/github-terms-of-service#6-contributions-under-repository-license)
have it (inbound equals outbound), so contribute only what you have the right to: your own work,
or code from a
GPL-compatible source whose copyright line goes into [`NOTICE`](NOTICE) with it. There is no CLA.

Never commit Quake III Arena's data, or anything extracted from it — no pk3s, textures, models,
sounds, shader scripts or maps — and never attach them to an issue. [`AGENTS.md`](AGENTS.md#git)
lists what else stays out of a commit.

## Setting up

You need Node (`.nvmrc` has the version), and to play, your own copy of Quake III Arena.

```bash
npm install
npm run dev
```

Copy [`.env.example`](.env.example) to `.env.local` and point `PCQ_FS_BASEPATH` at your install,
the folder that holds `baseq3`. Without one, the page asks for `pak0.pk3` to be dropped on it.

### Without Quake 3

Much of the port can be worked on without the game's data: the movement, the collision, the
network, the file formats and the menus' logic are all tested headless. `npm run typecheck`,
`npm test` and `npm run build` run anywhere; the tests that read the paks, or the port's own map
pk3s, skip without them, as they do in CI.

## Making a change

Read [`AGENTS.md`](AGENTS.md), then the conventions a change touches:
[`code-standards.md`](.claude/code-standards.md) for how code is written here,
[`conventions.md`](.claude/conventions.md) for what porting Quake 3 has taught, and
[`testing.md`](.claude/testing.md) for how a change is proved.

- **Tests come with the change**, unit and integration, against the real code wherever it can run
  headless.
- **Docs come with it too**: what the README or a convention says of the behaviour changes in the
  same pull request.
- **Before opening a pull request**, run `npm run typecheck`, `npm test` and `npm run build`, and
  for a change to `splat-maps/`, its tests, as [its README](splat-maps/README.md#tests) says.
- **The pull request's title is a [Conventional Commit](https://www.conventionalcommits.org/)**
  (`fix(render): …`), as it becomes the squashed commit's subject, and releases are cut from it:
  [`splat-maps/`'s own](splat-maps/README.md#versions) from changes under it, and the app's from
  the rest.
- **CI checks it all again** on every pull request: the title; the typecheck, the suite on Linux
  and the web, Pages, dedicated and master builds, unless every change is under `splat-maps/`;
  the Windows shell where it changed; and `splat-maps/`'s tests on Linux, macOS and Windows where
  it changed. Its `ci` check must pass before a merge.

## Reporting

Bugs and ideas go in the issue forms. A security problem goes through [`SECURITY.md`](SECURITY.md)
instead, privately.
