// The same views shot in the port on several splat maps, one server and one browser: each map
// booted in a match, the player stood at each view, held 1.5 s, and screenshot at 1920x1080. A
// view's eye is a standing player's, so the player goes to the eye less the view height
// (DEFAULT_VIEWHEIGHT, bg_public.h); a view whose eye no standing player has, one in mid-air,
// falls, and result.json records the eye each shot was really taken from.
//     node port_shots.mjs <repo> <views.json> <out dir> <map> [<map> ...]
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const VIEWHEIGHT = 26;
const [REPO, VIEWS, OUT, ...MAPS] = process.argv.slice(2);
if (!MAPS.length) throw new Error('usage: node port_shots.mjs <repo> <views.json> <out dir> <map> [<map> ...]');
const lib = await import(pathToFileURL(join(REPO, 'scripts/perf/perf-lib.mjs')).href);
const views = JSON.parse(readFileSync(VIEWS, 'utf8'));
// No 2D. The port has no cg_drawGun, so the weapon still draws at the bottom centre.
const home = lib.throwawayHome('seta cg_draw2D "0"\n');
const { server, port } = await lib.startVite('release');
const profile = mkdtempSync(join(tmpdir(), 'pcq-port-shots-'));
const context = await lib.launchChrome(profile, { width: 1920, height: 1080, scale: 1 });
await lib.installPageHarness(context, { rate: 240 });
const result = {};
try {
  for (const map of MAPS) {
    mkdirSync(join(OUT, map), { recursive: true });
    const page = await context.newPage();
    const problems = [];
    page.on('console', (m) => {
      if ((m.type() === 'error' || m.type() === 'warning') && !lib.KNOWN_NOISE.test(m.text())) problems.push(m.text().slice(0, 160));
    });
    await lib.bootMatch(page, port, map);
    await page.waitForFunction(
      () => window.pcqController?.inWorld === true && window.pcqScreens?.top === null,
      null,
      { timeout: 300000, polling: 100 }
    );
    await page.waitForTimeout(6000);
    const shots = {};
    for (const v of views) {
      await lib.place(page, 0, [v.eye[0], v.eye[1], v.eye[2] - VIEWHEIGHT], v.angles);
      await page.waitForTimeout(1500);
      await page.screenshot({ path: join(OUT, map, `${v.name}.png`) });
      const eye = await page.evaluate(() => {
        const e = window.pcqController.viewOrigin;
        return [e.x, e.y, e.z];
      });
      const off = Math.hypot(eye[0] - v.eye[0], eye[1] - v.eye[1], eye[2] - v.eye[2]);
      shots[v.name] = { eye, off: Math.round(off * 10) / 10 };
      console.log(`${map} ${v.name}: ${off < 2 ? 'at the view' : `taken ${off.toFixed(0)} units from the view, at (${eye.map((c) => c.toFixed(0)).join(' ')})`}`);
    }
    result[map] = { shots, problems: problems.slice(0, 8) };
    await page.close();
  }
} finally {
  await context.close().catch(() => {});
  await server.close();
  lib.remove(home);
  lib.remove(profile);
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'result.json'), JSON.stringify(result, null, 2));
}
