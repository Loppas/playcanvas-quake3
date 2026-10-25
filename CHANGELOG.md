# Changelog

## [0.4.3](https://github.com/Loppas/playcanvas-quake3/compare/v0.4.2...v0.4.3) (2026-10-25)


### Bug Fixes

* **deps:** update PlayCanvas to 2.23.3, which keeps a hidden canvas drawable ([3dcb7e5](https://github.com/Loppas/playcanvas-quake3/commit/3dcb7e5a48ffe71fe6ae536a4fcdf644d5d9a3f3))

## [0.4.2](https://github.com/Loppas/playcanvas-quake3/compare/v0.4.1...v0.4.2) (2026-10-25)


### Bug Fixes

* **menus:** centre the server browser's count line with its status line ([#95](https://github.com/Loppas/playcanvas-quake3/issues/95)) ([0d10ddc](https://github.com/Loppas/playcanvas-quake3/commit/0d10ddcd94dad96e2c7e0a8bd32b4db07d51435c)), closes [#77](https://github.com/Loppas/playcanvas-quake3/issues/77)
* **splat-maps:** seal an outdoor bake's box, so the box bounds the map ([#85](https://github.com/Loppas/playcanvas-quake3/issues/85)) ([c723a6f](https://github.com/Loppas/playcanvas-quake3/commit/c723a6f8e4b4644f5f52bbf26ba0bdae589f0ed1))

## [0.4.1](https://github.com/Loppas/playcanvas-quake3/compare/v0.4.0...v0.4.1) (2026-10-23)


### Bug Fixes

* **settings:** let a preset set the rules of a server hosted in a tab ([#78](https://github.com/Loppas/playcanvas-quake3/issues/78)) ([2643fb1](https://github.com/Loppas/playcanvas-quake3/commit/2643fb128de091605d500d502686a77aab35673a))

## [0.4.0](https://github.com/Loppas/playcanvas-quake3/compare/v0.3.0...v0.4.0) (2026-10-21)


### Features

* **master:** check a server by sending getinfo down the server's own link ([#66](https://github.com/Loppas/playcanvas-quake3/issues/66)) ([e01e81b](https://github.com/Loppas/playcanvas-quake3/commit/e01e81baca2c334c869c095f672f201ea8a5cb71))
* **master:** rebuild the hosted master from its open WebSockets when its object wakes ([#72](https://github.com/Loppas/playcanvas-quake3/issues/72)) ([0e630fe](https://github.com/Loppas/playcanvas-quake3/commit/0e630fe2d9ed8729cf9717424ab16a16152ca878))
* **master:** rebuild the master's state from records its WebSockets hold ([#70](https://github.com/Loppas/playcanvas-quake3/issues/70)) ([db4990c](https://github.com/Loppas/playcanvas-quake3/commit/db4990c1a5a26f2b544d99fea897af0d9b4d0f6f))
* **master:** serve the master from a Cloudflare Worker and its Durable Object ([#71](https://github.com/Loppas/playcanvas-quake3/issues/71)) ([7436892](https://github.com/Loppas/playcanvas-quake3/commit/74368925e57582f3ddb94dc473e9a12259a07fdb))
* **server:** heartbeat every master, and as soon as a link to one opens again ([#69](https://github.com/Loppas/playcanvas-quake3/issues/69)) ([0c2be96](https://github.com/Loppas/playcanvas-quake3/commit/0c2be96bb1681a640716b5f32877cf52b81c04b0))
* **server:** ping the master from a dedicated server to find a dead link ([#68](https://github.com/Loppas/playcanvas-quake3/issues/68)) ([e99a799](https://github.com/Loppas/playcanvas-quake3/commit/e99a799945b6c9e25266b46092ae17085798b3b5))
* **settings:** make the hosted master sv_master1's default ([#74](https://github.com/Loppas/playcanvas-quake3/issues/74)) ([9bbaa2e](https://github.com/Loppas/playcanvas-quake3/commit/9bbaa2ede2ef64ab37604d4d9577b0ed380fe4c9))

## [0.3.0](https://github.com/Loppas/playcanvas-quake3/compare/v0.2.0...v0.3.0) (2026-10-19)


### Features

* refuse a splat map whose layout version the port doesn't know ([#45](https://github.com/Loppas/playcanvas-quake3/issues/45)) ([615df4b](https://github.com/Loppas/playcanvas-quake3/commit/615df4bbf10c72948b9b39ee3494732321a70f7b))

## [0.2.0](https://github.com/Loppas/playcanvas-quake3/compare/v0.1.0...v0.2.0) (2026-10-19)


### Features

* **splat-maps:** make the scripts one package with a CLI ([#24](https://github.com/Loppas/playcanvas-quake3/issues/24)) ([e004336](https://github.com/Loppas/playcanvas-quake3/commit/e004336a264760f8ec4aa67f9c35ff84605d5958))


### Bug Fixes

* **pak:** end an entry's read at the next local header ([#34](https://github.com/Loppas/playcanvas-quake3/issues/34)) ([6ec0453](https://github.com/Loppas/playcanvas-quake3/commit/6ec04532ed282aed89c7f97384ff001305bcd634))

## 0.1.0 (2026-10-18)


### Features

* playcanvas-quake3, the first public tree ([ccc135a](https://github.com/Loppas/playcanvas-quake3/commit/ccc135ab7743369a07ddc508f10803a74a4fd1ba))


### Bug Fixes

* **shell:** fetch Electron's binary before packing the shell ([#2](https://github.com/Loppas/playcanvas-quake3/issues/2)) ([518687f](https://github.com/Loppas/playcanvas-quake3/commit/518687f19d7a2ea88d1f65de610c3c213ecef5b7))
