// The playtest pak: a spread of items in a ring around the garage's centre spawn, and — for
// Capture the Flag alone — two bases on opposite sides of it.
//
// Reads the port's map, appends one of each item a playtest needs to see, writes it as
// `public/maps/zz-items.pk3` — which mounts above the map, later paks winning — boots the match and
// reads every item back: where it stands, that it is in the world, and that the client draws it.
// The pak is left in place; this is the playtest fixture. Run it from the repo:
//
//     node scripts/items-pak.mjs
//
// It finds the repo by where it sits, so a checkout may live anywhere.
import { mkdirSync, mkdtempSync, openSync, readSync, closeSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(tmpdir(), 'pcq-items-pak');
const PAK = join(REPO, 'public/maps/zz-items.pk3');
const CENTRE = { x: -4, y: -4 };
const RADIUS = 128;
const HEIGHT = 43;

/** In the order the walk should take them: the tools, the armour, the health, the powerups. */
const ITEMS = [
  'weapon_rocketlauncher',
  'ammo_rockets',
  'weapon_railgun',
  'ammo_slugs',
  'weapon_shotgun',
  'ammo_shells',
  'item_armor_shard',
  'item_armor_combat',
  'item_armor_body',
  'item_health_small',
  'item_health',
  'item_health_large',
  'item_health_mega',
  'item_quad',
  'item_haste',
  'item_regen',
  'item_enviro',
  'item_invis',
  'item_flight',
  'holdable_medkit',
  'holdable_teleporter'
];

/** How far out the two bases sit: a little beyond the ring of items, which is {@link RADIUS}. */
const BASE = 200;

/**
 * CTF's two bases: the flags at opposite ends of a line through the origin, and each side's own
 * spawn spots behind its flag, looking at the other one.
 *
 * Every block carries Quake 3's own `gametype` key (`g_spawn.c:410–463`), so the bases exist in
 * Capture the Flag and in nothing else — the map plays exactly as it did in every other mode.
 */
const BASES = [
  { classname: 'team_CTF_redflag', x: 0, y: BASE },
  { classname: 'team_CTF_blueflag', x: 0, y: -BASE },
  { classname: 'team_CTF_redplayer', x: 0, y: BASE + 50, angle: 270 },
  { classname: 'team_CTF_blueplayer', x: 0, y: -BASE - 50, angle: 90 },
  { classname: 'team_CTF_redspawn', x: -40, y: BASE + 60, angle: 270 },
  { classname: 'team_CTF_redspawn', x: 40, y: BASE + 60, angle: 270 },
  { classname: 'team_CTF_bluespawn', x: -40, y: -BASE - 60, angle: 90 },
  { classname: 'team_CTF_bluespawn', x: 40, y: -BASE - 60, angle: 90 }
];

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.on('error', reject);
    probe.listen(0, 'localhost', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function slice(fd, offset, length) {
  const bytes = Buffer.alloc(length);
  readSync(fd, bytes, 0, length, offset);
  return bytes;
}

/** The entry `name` of the zip at `path`, inflated if it is deflated. */
function readZipEntry(path, name) {
  const fd = openSync(path, 'r');
  try {
    const size = statSync(path).size;
    const tail = slice(fd, Math.max(0, size - 65557), Math.min(size, 65557));
    const eocd = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    const count = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    const cd = slice(fd, cdOffset, cdSize);
    let at = 0;
    for (let i = 0; i < count; i++) {
      const method = cd.readUInt16LE(at + 10);
      const csize = cd.readUInt32LE(at + 20);
      const nameLen = cd.readUInt16LE(at + 28);
      const extraLen = cd.readUInt16LE(at + 30);
      const commentLen = cd.readUInt16LE(at + 32);
      const local = cd.readUInt32LE(at + 42);
      const entryName = cd.subarray(at + 46, at + 46 + nameLen).toString('utf8');
      if (entryName.toLowerCase() === name.toLowerCase()) {
        const header = slice(fd, local, 30);
        const data = slice(fd, local + 30 + header.readUInt16LE(26) + header.readUInt16LE(28), csize);
        return method === 8 ? inflateRawSync(data) : data;
      }
      at += 46 + nameLen + extraLen + commentLen;
    }
    throw new Error(`${name} not in ${path}`);
  } finally {
    closeSync(fd);
  }
}

const CRC_TABLE = Array.from({ length: 256 }, (_unused, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A zip holding this one stored entry. */
function writeStoredPk3(path, name, bytes) {
  const nameBytes = Buffer.from(name, 'utf8');
  const crc = crc32(bytes);
  const local = Buffer.alloc(30 + nameBytes.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE((1 << 5) | 1, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(bytes.length, 18);
  local.writeUInt32LE(bytes.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  nameBytes.copy(local, 30);

  const central = Buffer.alloc(46 + nameBytes.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE((1 << 5) | 1, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(bytes.length, 20);
  central.writeUInt32LE(bytes.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  nameBytes.copy(central, 46);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(local.length + bytes.length, 16);
  writeFileSync(path, Buffer.concat([local, bytes, central, end]));
}

/** The map's own entity text, with the ring of items appended. */
function mapWithItems() {
  const original = readZipEntry(join(REPO, 'public/maps/map-garage_rats.pk3'), 'maps/garage_rats.ent');
  let text = original.toString('utf8');
  if (!text.endsWith('\n')) text += '\n';
  const step = (Math.PI * 2) / ITEMS.length;
  ITEMS.forEach((classname, i) => {
    const angle = i * step;
    const x = (CENTRE.x + Math.cos(angle) * RADIUS).toFixed(1);
    const y = (CENTRE.y + Math.sin(angle) * RADIUS).toFixed(1);
    text += `// entity ${12 + i}\n{\n"classname" "${classname}"\n"origin" "${x} ${y} ${HEIGHT}"\n}\n`;
  });
  BASES.forEach((base, i) => {
    const angle = base.angle === undefined ? '' : `"angle" "${base.angle}"\n`;
    text +=
      `// entity ${12 + ITEMS.length + i}\n{\n"classname" "${base.classname}"\n` +
      `"origin" "${base.x} ${base.y} ${HEIGHT}"\n${angle}"gametype" "ctf"\n}\n`;
  });
  return text;
}

const home = mkdtempSync(join(tmpdir(), 'pcq-home-'));
process.env.PCQ_FS_HOMEPATH = home;
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const result = {};
const problems = [];
let page;
let browser;
let server;
try {
  const text = mapWithItems();
  writeStoredPk3(PAK, 'maps/garage_rats.ent', Buffer.from(text, 'utf8'));
  result.pak = { path: PAK, size: statSync(PAK).size, items: ITEMS.length };

  const port = await freePort();
  result.port = port;
  server = await (await import(pathToFileURL(`${REPO}/node_modules/vite/dist/node/index.js`).href))
    .createServer({
      root: REPO,
      logLevel: 'warn',
      clearScreen: false,
      server: { host: 'localhost', port, strictPort: true, forwardConsole: false }
    });
  await server.listen();

  const { chromium } = createRequire(`${REPO}/package.json`)('playwright');
  browser = await chromium.launch({
    channel: 'chromium',
    headless: true,
    args: ['--enable-unsafe-webgpu', '--autoplay-policy=no-user-gesture-required']
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));

  await page.goto(`http://localhost:${port}/?map=garage_rats&g_doWarmup=0`);
  await page.waitForFunction(
    () => Boolean(window.pcq?.app && window.pcqController && window.pcqPlayers && window.pcqInput),
    null,
    { timeout: 240_000 }
  );
  await page.waitForTimeout(2000);

  /** Every map item the level holds, with what a player would see and touch. */
  async function items() {
    return page.evaluate(() => {
      const level = window.pcqController.game.game.level;
      const out = [];
      for (let i = 0; i < level.numEntities; i++) {
        const entity = level.gentities[i];
        if (!entity.inuse || !entity.item) continue;
        out.push({
          classname: entity.classname,
          modelindex: entity.s.modelindex,
          eFlags: entity.s.eFlags,
          contents: entity.r.contents,
          origin: [
            Number(entity.r.currentOrigin.x.toFixed(1)),
            Number(entity.r.currentOrigin.y.toFixed(1)),
            Number(entity.r.currentOrigin.z.toFixed(1))
          ],
          inWorld: (entity.s.eFlags & 1) === 0 && entity.r.contents !== 0
        });
      }
      return out;
    });
  }

  result.standing = await items();
  result.clientDrawn = await page.evaluate(() => window.pcqController.items().length);

  // The powerups wait their 45 +- 15 seconds before their first appearance. Force that wind
  // forward, as the match's own timer would, to read the far side of it too.
  result.forced = await page.evaluate(() => {
    const level = window.pcqController.game.game.level;
    let forced = 0;
    for (let i = 0; i < level.numEntities; i++) {
      const entity = level.gentities[i];
      if (entity.inuse && entity.item && entity.item.giType === 5) {
        entity.think(entity);
        forced++;
      }
    }
    return forced;
  });
  await page.waitForTimeout(600);
  result.appeared = (await items()).filter((item) => item.inWorld);

  // A look around from the spawn: four quarters of the ring, from the player's own eye.
  const eye = await page.evaluate(() => {
    const level = window.pcqController.game.game.level;
    return {
      origin: [level.clients[0].ps.origin.x, level.clients[0].ps.origin.y, level.clients[0].ps.origin.z]
    };
  });
  result.eye = eye;
  for (const yaw of [0, 90, 180, 270]) {
    await page.evaluate((angle) => {
      const level = window.pcqController.game.game.level;
      const ps = level.clients[0].ps;
      const player = level.gentities[0];
      ps.viewangles.y = angle;
      player.s.apos.trBase.y = angle;
      player.s.apos.trDelta.y = 0;
    }, yaw);
    await page.waitForTimeout(350);
    await page.screenshot({ path: join(OUT, `ring-${String(yaw).padStart(3, '0')}.png`) });
  }
} finally {
  if (page) await page.close().catch(() => {});
  if (browser) await browser.close().catch(() => {});
  if (server) await server.close().catch(() => {});
  rmSync(home, { recursive: true, force: true });
  result.problems = problems.slice(0, 20);
  writeFileSync(join(OUT, 'result.json'), JSON.stringify(result, null, 2));
}

const standing = result.standing ?? [];
const appeared = result.appeared ?? [];
// eslint-disable-next-line no-console
console.log(`pak: ${PAK} (${result.pak?.size} bytes, ${result.pak?.items} items)`);
for (const item of standing) {
  // eslint-disable-next-line no-console
  console.log(
    `${item.classname.padEnd(22)} ${item.origin.map((n) => String(n).padStart(7)).join(' ')}  ` +
      `${item.inWorld ? 'stands' : 'waiting'}  model ${item.modelindex}  contents ${item.contents}`
  );
}
// eslint-disable-next-line no-console
console.log(`\nstanding: ${standing.filter((item) => item.inWorld).length}/${standing.length}`);
// eslint-disable-next-line no-console
console.log(`forced forward: ${result.forced}; then standing: ${appeared.length}/${standing.length}`);
// eslint-disable-next-line no-console
console.log(`client draws: ${result.clientDrawn} items; eye at ${JSON.stringify(result.eye?.origin)}`);
// eslint-disable-next-line no-console
console.log(`problems: ${JSON.stringify(result.problems)}`);
