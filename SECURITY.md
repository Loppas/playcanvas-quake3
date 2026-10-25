# Security

## Reporting a vulnerability

Report it privately, through **Report a vulnerability** on the repository's Security tab, and not
in a public issue. Say what is affected, how to reproduce it, and what it lets someone do. The
report stays private until a fix is released.

Fixes go into `main` and the next release. Only the latest release is supported.

## Scope

The code in this repository, wherever it runs:

- **The page**, in a browser or the desktop shell: what it does with what reaches it from a pk3, a
  cfg, a server or a master — the paks and their shader scripts, configs, snapshots, server
  commands, info strings and the server browser's lists.
- **The dev server's routes** (`npm run dev`), as the shell's `app://` scheme answers them too:
  `/baseq3/`, which lists the install's pk3s and reads them by `Range`; `/homepath/`, which reads
  and replaces `q3config.cfg` and `favorites.txt` in `fs_homepath` and reads its other cfgs; and
  `/maps/paks.json`. The dev server listens on `localhost` alone unless it is started with
  `--host`, and then trusts the network it is opened to; a route reached from another origin, or
  past Vite's check of the `Host` header, is in scope.
- **The desktop shell**: its `app://` scheme, with the shell's own `/install` and `/launch`, and
  its folder picker.
- **The servers**: the Node dedicated server (its connectionless packets and data channels on
  `net_port`), a page's listen server, and the master, run locally (its WebSocket on 27950) or
  hosted on Cloudflare (its Worker and Durable Object, at `sv_master1`'s default address), with
  the WebRTC signals and datagrams it passes between sockets.
- **The hosted master's deploy**: the release workflow's jobs that build it and deploy it with the
  `cloudflare` environment's token.

Out of scope: Quake III Arena itself and its mods; Cloudflare's platform, which Cloudflare takes
reports on itself; a dev server opened with `--host` on a network its owner does not trust; and a
dependency's vulnerability already published upstream, which Dependabot raises here.
