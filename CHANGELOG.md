# Changelog

## [0.5.0](https://github.com/Loppas/playcanvas-quake3/compare/v0.4.3...v0.5.0) (2026-10-30)


### Features

* **chat:** add sayto and tell_attacker ([#154](https://github.com/Loppas/playcanvas-quake3/issues/154)) ([acfe797](https://github.com/Loppas/playcanvas-quake3/commit/acfe797bb6f793d38d761640619399f4690f9a58))
* **chat:** add the chat line, messagemode to messagemode4, and tell_target ([#170](https://github.com/Loppas/playcanvas-quake3/issues/170)) ([777908a](https://github.com/Loppas/playcanvas-quake3/commit/777908ab8c6e33fa26dfb591e0512704a24aeb23))
* **chat:** add the game's say, say_team and tell ([#150](https://github.com/Loppas/playcanvas-quake3/issues/150)) ([e3c5ccf](https://github.com/Loppas/playcanvas-quake3/commit/e3c5ccfe9411d8b39b9d1d2aff40c838b73c4330))
* **chat:** bind chat to t and team chat to y, with the Controls page's chat rows ([#171](https://github.com/Loppas/playcanvas-quake3/issues/171)) ([17f3c2c](https://github.com/Loppas/playcanvas-quake3/commit/17f3c2c73a804c3b6b37d0fab127101f17e340ad))
* **chat:** show chat and team chat in cgame, with the talk sound ([#153](https://github.com/Loppas/playcanvas-quake3/issues/153)) ([9858205](https://github.com/Loppas/playcanvas-quake3/commit/98582054371d0a7d02e0790890316abac641f42d))
* **console:** add condump and writeconfig, writing to the home folder ([#145](https://github.com/Loppas/playcanvas-quake3/issues/145)) ([f06106a](https://github.com/Loppas/playcanvas-quake3/commit/f06106aef640eeef9c82120b362c28ec430e1424))
* **console:** add Quake 3's console commands for what the port has ([#144](https://github.com/Loppas/playcanvas-quake3/issues/144)) ([0932dd7](https://github.com/Loppas/playcanvas-quake3/commit/0932dd77e172a974035e2870764850baacc40c7d))
* **console:** add Quake 3's input field, for the console and the chat line ([#156](https://github.com/Loppas/playcanvas-quake3/issues/156)) ([ed7f03c](https://github.com/Loppas/playcanvas-quake3/commit/ed7f03ccd233beef20baed68372efaa06c2b6b69))
* **console:** complete a command or cvar on Tab, listing the matches ([#159](https://github.com/Loppas/playcanvas-quake3/issues/159)) ([bed3239](https://github.com/Loppas/playcanvas-quake3/commit/bed3239be22ba6b5d73b26e4d130110ac6f6bb76))
* **console:** complete commands' arguments on Tab ([#167](https://github.com/Loppas/playcanvas-quake3/issues/167)) ([21bf9f9](https://github.com/Loppas/playcanvas-quake3/commit/21bf9f90bab03aa1015166fdae39271136fd46f1))
* **console:** draw the console, opened by toggleconsole ([#149](https://github.com/Loppas/playcanvas-quake3/issues/149)) ([678fc40](https://github.com/Loppas/playcanvas-quake3/commit/678fc40adaa668cb063ac637aafa0d1614effda6))
* **console:** keep printed text in a console buffer, as ioquake3 does ([#137](https://github.com/Loppas/playcanvas-quake3/issues/137)) ([4dd983c](https://github.com/Loppas/playcanvas-quake3/commit/4dd983cb6aeb5772561d1b6314533b9112cea01c))
* **console:** print what Quake 3 prints for cvars and binds, with its cvar and bind lists ([#141](https://github.com/Loppas/playcanvas-quake3/issues/141)) ([5269469](https://github.com/Loppas/playcanvas-quake3/commit/5269469d897f1b6da02d0b055fc38f2c5b7b1304))
* **console:** run commands in Quake 3's order, and print an unknown one to the console ([#140](https://github.com/Loppas/playcanvas-quake3/issues/140)) ([5ca4716](https://github.com/Loppas/playcanvas-quake3/commit/5ca4716476cbb593d7fb26038c3b64c2713bc2a2))
* **console:** run or say the console's line on Enter, with its history and scrolling ([#157](https://github.com/Loppas/playcanvas-quake3/issues/157)) ([c7c7710](https://github.com/Loppas/playcanvas-quake3/commit/c7c7710973224f1d2a1765254debdcae33501ab3))
* **console:** send every print to the console buffer, and draw the notify lines from it ([#139](https://github.com/Loppas/playcanvas-quake3/issues/139)) ([7451837](https://github.com/Loppas/playcanvas-quake3/commit/74518370cb93bd3c77e7eddc256b3b3a0d18d7ba))
* **console:** toggle the console with its key or Shift+Escape ([#158](https://github.com/Loppas/playcanvas-quake3/issues/158)) ([896b842](https://github.com/Loppas/playcanvas-quake3/commit/896b84278fc1171dd864a500647c34313f0fd003))
* **hud:** draw the name of the player under the crosshair ([#168](https://github.com/Loppas/playcanvas-quake3/issues/168)) ([35499f1](https://github.com/Loppas/playcanvas-quake3/commit/35499f1e51be0f6007945862411dcdd4944081e9))
* **input:** press the talk button while a key catcher is up ([#147](https://github.com/Loppas/playcanvas-quake3/issues/147)) ([3c2a7e9](https://github.com/Loppas/playcanvas-quake3/commit/3c2a7e9a1ff177e9a12e80651e889d10e196a012))
* **input:** route keys through Quake 3's key catchers ([#146](https://github.com/Loppas/playcanvas-quake3/issues/146)) ([9099157](https://github.com/Loppas/playcanvas-quake3/commit/9099157ae503227b08cf78e8218ba57f9eb46af0))
* **load-screen:** draw the load and connect screens as PlayCanvas UI ([#148](https://github.com/Loppas/playcanvas-quake3/issues/148)) ([e44357c](https://github.com/Loppas/playcanvas-quake3/commit/e44357c1eabe44dab3f68648dad2abb5246d6a87))


### Bug Fixes

* **server:** sanitize a game command's arguments as ioquake3's server does ([#152](https://github.com/Loppas/playcanvas-quake3/issues/152)) ([2bfc915](https://github.com/Loppas/playcanvas-quake3/commit/2bfc9151c84d28cceb87c678e91cbb86c867b24c))
* **settings:** keep a cvar set by seta archived, as Quake 3 does ([#142](https://github.com/Loppas/playcanvas-quake3/issues/142)) ([0cd8f5c](https://github.com/Loppas/playcanvas-quake3/commit/0cd8f5c295bcb84588261b23fea2b59bb10ae09b))

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
