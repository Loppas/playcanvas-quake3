// A CPU profile of the frame standing still on the profiler build: the repo's config under
// --mode profiler on a free port with a throwaway home and cache, garage_rats at 1280x720,
// unpaced. From V8's sampling profiler (100 us), per frame, for AppBase.update and AppBase.render
// (found by line in the page's own engine bundle): the time under each, its self time split
// between the engine, the port and native code, its children, and the engine calls the game's
// own code makes, each engine function named by its class.
//
//     node scripts/perf/perf-profile.mjs <out.json> [seconds]
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { REPO, bootMatch, freePort, launchChrome, remove, servedEngine, throwawayHome } from './perf-lib.mjs';

const { createServer } = await import(pathToFileURL(`${REPO}/node_modules/vite/dist/node/index.js`).href);

const OUT = process.argv[2];
const SECONDS = Number(process.argv[3] ?? 4);
if (!OUT) throw new Error('usage: perf-profile.mjs <out.json> [seconds]');
const home = throwawayHome();
const cacheDir = mkdtempSync(join(tmpdir(), 'pcq-profile-vite-'));
const profile = mkdtempSync(join(tmpdir(), 'pcq-profile-profile-'));
const port = await freePort();
const server = await createServer({
  root: REPO,
  mode: 'profiler',
  logLevel: 'warn',
  clearScreen: false,
  cacheDir,
  server: { host: 'localhost', port, strictPort: true, forwardConsole: false, hmr: false, watch: null }
});
await server.listen();
const context = await launchChrome(profile, { width: 1280, height: 720, scale: 1 });
const page = await context.newPage();
const result = { port };
try {
  result.loadMs = await bootMatch(page, port, 'garage_rats');
  result.engine = servedEngine(server);
  await page.waitForFunction(() => window.pcqController?.player !== undefined, null, { timeout: 30000 });
  await page.waitForTimeout(8000);
  const cdp = await context.newCDPSession(page);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 100 });
  const frames0 = await page.evaluate(() => window.pcq.app.frame);
  await cdp.send('Profiler.start');
  await page.waitForTimeout(SECONDS * 1000);
  const { profile: p } = await cdp.send('Profiler.stop');
  const frames = (await page.evaluate(() => window.pcq.app.frame)) - frames0;
  result.frames = frames;

  // The bundled engine as the page loaded it, to place AppBase.update and render by line and to
  // name the class of any engine function.
  const deps = readFileSync(join(cacheDir, 'deps', 'playcanvas.js'), 'utf8').split('\n');
  const lineOf = (marker, head) => {
    const at = deps.findIndex((l) => l.includes(marker));
    for (let k = at; k >= 0; k--) if (head.test(deps[k])) return k;
    return -1;
  };
  const updateLine = lineOf('this.stats.frame.updateStart = now();', /^\s*update\(dt\) \{/);
  const renderLine = lineOf('this.stats.frame.renderStart = now();', /^\s*render\(\) \{/);
  const classAt = (line) => {
    for (let k = line; k >= 0; k--) {
      const m = /^\s*(?:var |let |const )?(?:class (\w+)|(\w+) = class)/.exec(deps[k]);
      if (m) return m[1] ?? m[2];
    }
    return '?';
  };
  result.lines = { updateLine, renderLine };
  const byId = new Map(p.nodes.map((n) => [n.id, n]));
  const parent = new Map();
  for (const n of p.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const self = new Map();
  for (let i = 0; i < p.samples.length; i++) {
    const dt = (p.timeDeltas[i + 1] ?? p.timeDeltas[i]) / 1000;
    self.set(p.samples[i], (self.get(p.samples[i]) ?? 0) + dt);
  }
  const isEngine = (n) => n.callFrame.url.includes('/deps/playcanvas.js');
  const label = (n) => {
    const f = n.callFrame;
    if (isEngine(n)) return `${classAt(f.lineNumber)}.${f.functionName || '(anonymous)'}`;
    const file = (f.url.split('/').pop() ?? '').split('?')[0];
    return `${f.functionName || '(anonymous)'} ${file || '(native)'}`;
  };
  for (const [root, line] of [['update', updateLine], ['render', renderLine]]) {
    const children = new Map();
    const engineUnderGame = new Map();
    const kinds = { engine: 0, port: 0, native: 0 };
    let total = 0;
    for (const [id, ms] of self) {
      const chain = [];
      for (let at = id; at !== undefined; at = parent.get(at)) chain.push(byId.get(at));
      const r = chain.findIndex((n) => isEngine(n) && n.callFrame.lineNumber === line);
      if (r < 0) continue;
      total += ms;
      const leaf = chain[0];
      kinds[isEngine(leaf) ? 'engine' : leaf.callFrame.url ? 'port' : 'native'] += ms;
      const child = r > 0 ? label(chain[r - 1]) : '(self)';
      const grand = r > 1 ? label(chain[r - 2]) : '';
      const key = `${child} > ${grand}`;
      children.set(key, (children.get(key) ?? 0) + ms);
      // Engine functions reached from the game's own code: the outermost engine call below a
      // port frame, inclusive.
      const below = chain.slice(0, r);
      const portAt = below.findIndex((n) => !isEngine(n) && n.callFrame.url);
      if (portAt > 0) {
        const outer = below[portAt - 1];
        if (isEngine(outer)) engineUnderGame.set(label(outer), (engineUnderGame.get(label(outer)) ?? 0) + ms);
      }
    }
    const top = (map, n) =>
      [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, ms]) => `${(ms / frames).toFixed(3)}  ${k}`);
    result[root] = {
      msPerFrame: +(total / frames).toFixed(3),
      selfByKind: Object.fromEntries(Object.entries(kinds).map(([k, v]) => [k, +(v / frames).toFixed(3)])),
      children: top(children, 20),
      engineCalledByGame: top(engineUnderGame, 25)
    };
  }
} catch (err) {
  result.error = String(err);
  result.stack = err?.stack;
} finally {
  writeFileSync(OUT, JSON.stringify(result, null, 2));
  await context.close().catch(() => {});
  await server.close();
  remove(profile);
  remove(cacheDir);
  remove(home);
}
console.log('done');
