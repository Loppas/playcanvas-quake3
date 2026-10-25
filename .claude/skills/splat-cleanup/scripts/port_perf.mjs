// Frame rate of two splat maps from their first spawn, alternating A, B, A, B on one server and one
// browser: unpaced, eight yaws at two pitches held still, then a turn, which makes the splat
// re-sort. Headless on the real GPU at the perf harness's display, the release build of the engine.
//     node port_perf.mjs <repo> <out.json> <map A> <map B> [rounds=2]
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [REPO, OUT, A, B, ROUNDS = '2'] = process.argv.slice(2);
if (!B) throw new Error('usage: node port_perf.mjs <repo> <out.json> <map A> <map B> [rounds=2]');
const lib = await import(pathToFileURL(join(REPO, 'scripts/perf/perf-lib.mjs')).href);
const { slice, summarise } = await import(pathToFileURL(join(REPO, 'scripts/perf/perf-analyse.mjs')).href);

// Frames the log holds: a run is about 57 s, and an unpaced splat map can draw 2,000 a second.
const CAPACITY = 120000;
const home = lib.throwawayHome('');
const { server, port } = await lib.startVite('release');
const profile = mkdtempSync(join(tmpdir(), 'pcq-port-perf-'));
const context = await lib.launchChrome(profile);
await lib.installPageHarness(context, { rate: 240, capacity: CAPACITY });
const results = [];

const angleDelta = (a, b) => ((((b - a + 180) % 360) + 360) % 360) - 180;

async function measure(map) {
  const page = await context.newPage();
  const problems = [];
  page.on('console', (m) => {
    if ((m.type() === 'error' || m.type() === 'warning') && !lib.KNOWN_NOISE.test(m.text())) problems.push(m.text().slice(0, 160));
  });
  const wait = (ms) => page.waitForTimeout(ms);
  const loadMs = await lib.bootMatch(page, port, map);
  await page.waitForFunction(
    () => window.pcqController?.inWorld === true && document.querySelector('.load-screen') === null,
    null,
    { timeout: 300000, polling: 100 }
  );
  await wait(8000);

  // The view's degrees per mouse count, as perf-render measures them.
  const angles = () => page.evaluate(() => ({ ...window.pcqController.viewAngles }));
  const a = await angles();
  await page.evaluate(() => window.pcqInput.mouseMove(200, 100));
  await wait(300);
  const b = await angles();
  const gains = { yawGain: angleDelta(a.y, b.y) / 200, pitchGain: angleDelta(a.x, b.x) / 100 };
  if (gains.yawGain === 0 || gains.pitchGain === 0) throw new Error(`the view did not turn: ${JSON.stringify(gains)}`);
  await page.evaluate(() => window.pcqInput.mouseMove(-200, -100));
  await wait(300);
  await page.evaluate((g) => Object.assign(window.__perf.drive, g), gains);
  const turn = async (yaw, pitch = 0, rate = 180) => {
    await page.evaluate(([y, p, r]) => Object.assign(window.__perf.drive, { yawLeft: y, pitchLeft: p, yawRate: r, pitchRate: r }), [yaw, pitch, rate]);
    await page.waitForFunction(() => window.__perf.drive.yawLeft === 0 && window.__perf.drive.pitchLeft === 0, null, { timeout: 60000, polling: 50 });
  };
  const face = async (yaw, pitch) => {
    const v = await angles();
    await turn(angleDelta(v.y, yaw), pitch - v.x);
  };

  await face(90, 0);
  await page.evaluate(() => {
    window.__perf.setRate(0);
    window.__perf.record();
    window.__perf.mark('begin');
  });
  for (const pitch of [0, -30]) {
    const v = await angles();
    await turn(0, pitch - v.x);
    for (let i = 0; i < 8; i++) {
      await turn(45);
      await wait(700);
      await page.evaluate((n) => window.__perf.mark(n), `still yaw ${90 + (i + 1) * 45} pitch ${pitch}`);
      await wait(2500);
    }
  }
  await face(90, 0);
  await wait(500);
  await page.evaluate(() => window.__perf.mark('turning'));
  await page.evaluate(() => Object.assign(window.__perf.drive, { yawLeft: 1e9, yawRate: 180 }));
  await wait(6000);
  await page.evaluate(() => Object.assign(window.__perf.drive, { yawLeft: 0, pitchLeft: 0 }));
  await page.evaluate(() => window.__perf.mark('end'));
  const log = await page.evaluate(() => window.__perf.take());
  await page.close();
  if (log.rows >= CAPACITY) throw new Error(`${map}: the frame log filled at ${CAPACITY} frames, so the run's end is missing`);

  const marks = log.marks.filter((m) => m.name !== 'begin');
  const parts = {};
  for (let i = 0; i + 1 < marks.length; i++) {
    const s = summarise(slice(log, marks[i].row, marks[i + 1].row), 0);
    parts[marks[i].name] = {
      rows: s.rows,
      fps: s.fps,
      dtP95: s.dt.p95 ?? s.dt.max,
      render: s.render.p50,
      update: s.update.p50,
      gpuFrame: s.gpuFrame.p50,
      gsplats: s.gsplats.p50
    };
  }
  const still = Object.entries(parts).filter(([k]) => k.startsWith('still')).map(([, v]) => v);
  const mean = (k) => still.reduce((t, v) => t + (v[k] ?? 0), 0) / still.length;
  const out = {
    map,
    loadMs,
    still: { fps: mean('fps'), minFps: Math.min(...still.map((v) => v.fps)), worstP95: Math.max(...still.map((v) => v.dtP95)), gpuFrame: mean('gpuFrame'), gsplats: mean('gsplats') },
    turning: parts.turning,
    parts,
    problems: problems.slice(0, 10)
  };
  console.log(
    `${map.padEnd(16)} load ${(loadMs / 1000).toFixed(1)} s | ${Math.round(out.still.gsplats).toLocaleString()} splats | still ${out.still.fps.toFixed(0)} fps ` +
      `(worst view ${out.still.minFps.toFixed(0)}), gpu ${out.still.gpuFrame?.toFixed(2)} ms, worst p95 frame ${out.still.worstP95.toFixed(2)} ms | ` +
      `turning ${parts.turning.fps.toFixed(0)} fps, p95 frame ${parts.turning.dtP95.toFixed(2)} ms` +
      (out.problems.length ? ` | problems ${JSON.stringify(out.problems)}` : '')
  );
  return out;
}

try {
  for (let r = 0; r < Number(ROUNDS); r++) for (const map of [A, B]) results.push(await measure(map));
} finally {
  await context.close().catch(() => {});
  await server.close();
  lib.remove(home);
  lib.remove(profile);
  writeFileSync(OUT, JSON.stringify(results, null, 2));
}
