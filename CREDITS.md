# Credits

The port is built on other people's work. [NOTICE](NOTICE) holds the copyright lines of the code
it translates; this file credits everything it draws on, whether a licence asks for it or not.
Each build's `THIRD-PARTY-NOTICES.md` lists the packages it bundles, with their licences.

## Source code

- **[ioquake3](https://github.com/ioquake/ioq3)**, the ioquake3 project, from id Software's
  Quake III Arena. Almost all of the port's game, client, server, renderer and menus follow it,
  read at commit `5883936`, and the source names the file and line each part comes from.
- **[Quake III Arena](https://github.com/id-Software/Quake-III-Arena)**, id Software's source
  release 1.32b, where it differs from ioquake3: the console, and the q3_ui and Team Arena menus.
- **[Quake II](https://github.com/id-Software/Quake-2)**, id Software's source release: the CTF
  grappling hook (`ctf/g_ctf.c`), its speed and its pull.
- **[dpmaster](https://github.com/kphillisjr/dpmaster)**, Mathieu Olivier: the master server, its
  messages as its
  [techinfo.txt](https://github.com/kphillisjr/dpmaster/blob/master/doc/techinfo.txt) describes
  them, and its timeouts and challenges.
- **[PlayCanvas](https://github.com/playcanvas/engine)**, PlayCanvas Ltd.: the engine the port
  runs on. Its `GSplatSogIterator` is what the port's SOG decoding follows.

## Mods and games

The mods below were read through their documentation, their configs and their compiled game code.
The port reimplements their rules and numbers as its own code, and includes no code or data of
theirs, except Unlagged's, which is GPL and translated (see [NOTICE](NOTICE)).

- **Unlagged 2.01**, Copyright (C) 2006-2007 Neil "haste" Toronto, GPL-2.0-or-later: lag
  compensation. The server's rewind of its players and their history, true ping, smoothing, and
  the predicted weapon effects. Its code was read through XreaL and OpenArena. See his
  ['"Lag" Compensation Technique'](https://www.ra.is/unlagged/).
- **[Excessive Plus](https://www.excessiveplus.net/) 2.3**, the Excessive Plus team (programming
  by beast, easy, panda and cid; management by beast, easy and edy): the lag-compensation settings
  `xp_unlagged` and `xp_delagWeapons`, the hit boxes' look, and the slide that smooths a client
  between snapshots.
- **[Challenge ProMode Arena](https://playmorepromode.com/) 1.48**, the Promode Team: CPM physics,
  Clan Arena, the weapon and armour balance, and the ruleset presets.
- **The CorkScrew Mod 2.16**, Firestarter (2002): the off-hand grappling hook, its speeds and pull,
  `g_allowGrapple`, and its trail and flare.
- **Quake Live**, id Software: `cg_fov` at 4:3, `cg_speedometer`, `cl_maxpackets` at 125,
  `roundlimit`, and the factory and cvar names, as these describe them:
  - ["Advanced Client Options"](https://www.esreality.com/post/1767848/advanced-client-options/),
    Mav_ (2009);
  - ["Commands in Quake Live"](https://steamcommunity.com/sharedfiles/filedetails/?id=788871701),
    Splush;
  - ["High Upload - Upload tied to Fps?"](https://steamcommunity.com/app/282440/discussions/0/1744479698803871347/),
    .S4NT.;
  - id's `factories.txt`, through
    [cstewart90's gist](https://gist.github.com/cstewart90/a1163bad196977e351eb) and
    [quakelive-server-standards](https://github.com/quakelive-server-standards/quakelive-server-standards).

## The garage maps

`garage_rats` and `garage_cats` are adapted from
["Garage - High Detail Test"](https://superspl.at/scene/8f4d8e05) by
[Ethan](https://superspl.at/user?id=ethan3111), licensed
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Changes: levelled, rescaled, voxel
collision baked, and Quake 3 entities added. Both maps' parts are in `splat-maps/examples/`,
and their pk3s on [their release](https://github.com/Loppas/playcanvas-quake3/releases/tag/splat-maps-v0.1.0),
under the same licence.

## Papers, specifications, formats and posts

- Bernhard Kerbl, Georgios Kopanas, Thomas Leimkühler and George Drettakis's ["3D Gaussian
  Splatting for Real-Time Radiance Field Rendering"](https://arxiv.org/abs/2308.04079) (ACM
  Transactions on Graphics, 2023): the technique the splat maps are made of and drawn by.
- Will Eastcott's
  [post on collision for splats](https://x.com/willeastcott/status/2070110425648128245) (2026):
  the voxel collision the splat maps play on.
- PlayCanvas's [SOG format](https://developer.playcanvas.com/user-manual/gaussian-splatting/formats/sog/)
  and splat-transform's
  [voxel format](https://developer.playcanvas.com/user-manual/splat-transform/voxel-format/): how
  a splat map's splat and collision are read.
- [WebGPU](https://www.w3.org/TR/webgpu/), the W3C: its buffer usage flags.
- [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110), HTTP Semantics: range requests, which every
  pak is read by.
- [glTF 2.0](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html), Khronos: the GLB files
  the map tools read.
- PKWARE's [APPNOTE](https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT), the zip format,
  as ioquake3's `files.c` reads it.

## Tools

The splat maps were made with these tools, which `splat-maps/` runs. None is bundled with the
port.

- [splat-transform](https://github.com/playcanvas/splat-transform) and
  [SuperSplat](https://github.com/playcanvas/supersplat), PlayCanvas: the SOG conversion, the
  polish, the collision bake, the levelshots, and the cleanup by hand.
- [FFmpeg](https://ffmpeg.org): the frames a video is cut into.
- [NetRadiant-custom](https://github.com/Garux/netradiant-custom) and its q3map2, Garux: the
  entities, and the layout of a map's files. With them, the
  [Q3Radiant manual](https://icculus.org/gtkradiant/documentation/q3radiant_manual/index.htm), id
  Software, and the OpenArena wiki's
  ["Readme model"](https://openarena.fandom.com/wiki/Readme_model) and
  ["Compiling and packaging"](https://openarena.fandom.com/wiki/Mapping_manual/Compiling_and_packaging).
- [gsplat](https://github.com/nerfstudio-project/gsplat), the nerfstudio project, described in
  Vickie Ye et al.'s ["gsplat: An Open-Source Library for Gaussian
  Splatting"](https://arxiv.org/abs/2409.06765): the training. Its MCMC strategy is Shakiba
  Kheradmand et al.'s ["3D Gaussian Splatting as Markov Chain Monte
  Carlo"](https://arxiv.org/abs/2404.09591), and its antialiased rendering is Zehao Yu et al.'s
  ["Mip-Splatting: Alias-free 3D Gaussian Splatting"](https://arxiv.org/abs/2311.16493).
- [COLMAP](https://colmap.github.io), ETH Zurich, UNC Chapel Hill and its contributors: the
  structure from motion, after Johannes L. Schönberger and Jan-Michael Frahm's
  ["Structure-from-Motion Revisited"](https://openaccess.thecvf.com/content_cvpr_2016/html/Schonberger_Structure-From-Motion_Revisited_CVPR_2016_paper.html)
  (CVPR 2016). With it, [pycolmap](https://github.com/rmbrualla/pycolmap) (rmbrualla's fork),
  [fused-ssim](https://github.com/rahul-goel/fused-ssim), Rahul Goel, and
  [nerfview](https://github.com/nerfstudio-project/nerfview).

Beside the maps, [node-datachannel](https://github.com/murat-dogan/node-datachannel), Murat Doğan,
on [libdatachannel](https://github.com/paullouisageneau/libdatachannel), Paul-Louis Ageneau, is
the dedicated server's and the master's WebRTC, and Cloudflare's public STUN server is their
default ICE server.

## Further reading

Consulted along the way, though nothing was taken from them:
[QuakeJS](https://github.com/inolen/quakejs) and
[begleysm's fork](https://github.com/begleysm/quakejs);
[jdarpinian's ioq3](https://github.com/jdarpinian/ioq3);
[openarenalive-dedicated](https://github.com/hauxir/openarenalive-dedicated); the Quake 3
movement ports by [WiggleWizard](https://github.com/WiggleWizard/quake3-movement-unity3d) and
[IsaiahKelly](https://github.com/IsaiahKelly/quake3-movement-for-unity), and rhulha's; toji's
[webgl-quake3](https://github.com/toji/webgl-quake3) and
[WebGPU best practices](https://toji.dev/webgpu-best-practices/);
[WolfcamQL](https://github.com/brugal/wolfcamql); Adrian Biagioli's "Bunnyhopping from the
Programmer's Perspective", and injx's strafing and circle-jump theory; Glenn Fiedler's
[Gaffer On Games](https://gafferongames.com/), Bruce Dawson's
[Random ASCII](https://randomascii.wordpress.com/) and Nicholas Zakas's posts;
[Quake Wiki](https://quakewiki.org/), the
[Q3Map2 wikibook](https://en.wikibooks.org/wiki/Q3Map2) and the
[Quake III Arena Shader Manual](https://icculus.org/gtkradiant/documentation/Q3AShader_Manual/).

And these papers, on splats' surfaces and on poses without structure from motion:

- Antoine Guédon and Vincent Lepetit, ["SuGaR: Surface-Aligned Gaussian Splatting for Efficient
  3D Mesh Reconstruction and High-Quality Mesh Rendering"](https://arxiv.org/abs/2311.12775);
- Binbin Huang et al., ["2D Gaussian Splatting for Geometrically Accurate Radiance
  Fields"](https://arxiv.org/abs/2403.17888);
- Zehao Yu, Torsten Sattler and Andreas Geiger, ["Gaussian Opacity Fields: Efficient Adaptive
  Surface Reconstruction in Unbounded Scenes"](https://arxiv.org/abs/2404.10772);
- Wanting Zhang et al., ["2DGS-Room: Seed-Guided 2D Gaussian Splatting with Geometric Constrains
  for High-Fidelity Indoor Scene Reconstruction"](https://arxiv.org/abs/2412.03428);
- Prajwal Gupta C. R. et al., ["2D-SuGaR: Surface-Aware Gaussian Splatting for Geometrically
  Accurate Mesh Reconstruction"](https://arxiv.org/abs/2605.00569) (Eurographics 2026 Short
  Papers);
- Jianyuan Wang et al., ["VGGT: Visual Geometry Grounded
  Transformer"](https://arxiv.org/abs/2503.11651) (CVPR 2025).
