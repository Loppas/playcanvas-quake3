// The render baseline's runs side by side, as Markdown tables: the load, the moments, the scenes
// and the splat passes by view direction.
//
//     node scripts/perf/perf-report.mjs <run dir>... > report.md
//
// Each run dir is what perf-render.mjs wrote: result.json, and logs/ for the splat passes.
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { slice, stats } from './perf-analyse.mjs';

const dirs = process.argv.slice(2);
const runs = dirs.map((dir) => ({ name: basename(dir).replace(/^render-/, ''), dir, r: JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8')) }));
const f = (x, d = 1) => (x === undefined || x === null || Number.isNaN(x) ? '–' : Number(x).toFixed(d));
const row = (cells) => `| ${cells.join(' | ')} |`;
const table = (head, rows) => [row(head), row(head.map(() => '---')), ...rows.map(row)].join('\n');
const out = [];

out.push('### The runs\n');
out.push(
  table(
    ['run', 'engine', 'load s', 'canvas', 'GPU', 'problems'],
    runs.map(({ name, r }) => [name, r.engine?.replace(/\/src\/index\.js$/, '') ?? '–', f(r.loadMs / 1000), r.app?.canvas?.join('×') ?? '–', r.app?.adapter ?? '–', String(r.problems?.length ?? 0)])
  )
);

out.push('\n### The moments\n');
out.push('Per part: the page\'s longest frame, frames over 1.5 refreshes, pipelines and shader variants made, the GPU process\'s compiles (count, total ms, longest), and the longest gap between presents.\n');
for (const phase of ['start', 'turn', 'weapons', 'players']) {
  const parts = [...new Set(runs.flatMap(({ r }) => Object.keys(r.phases[phase]?.parts ?? {})))];
  out.push(`\n**${phase}**\n`);
  out.push(
    table(
      ['part', ...runs.map((x) => x.name)],
      parts.map((part) => [
        part,
        ...runs.map(({ r }) => {
          const p = r.phases[phase]?.parts?.[part];
          if (!p) return '–';
          const c = p.trace?.compiles;
          return `${f(p.dtMax, 0)} ms, ${p.hitches.overOneAndAHalf} late; ${p.pipelines ?? 0}p ${p.shaders ?? 0}s; ${c ? `${c.n} / ${f(c.ms, 0)} / ${f(c.max, 0)}` : '–'}; gap ${f(p.trace?.presents?.gap?.max, 0)}`;
        })
      ])
    )
  );
}

out.push('\n### The scenes\n');
out.push('fps (presents a second), the page\'s frame p50/p99/max, its JS p50, the GPU frame p50, draw calls, material variant lookups a frame, allocation MB/s, main-thread GC pause total and longest.\n');
const scenes = Object.keys(runs[0].r.phases).filter((k) => / (240|144|60|unpaced)$/.test(k));
for (const { name, r } of runs) {
  out.push(`\n**${name}**\n`);
  out.push(
    table(
      ['scene', 'fps (pres/s)', 'frame p50/p99/max', 'JS', 'GPU', 'draws', 'lookups', 'MB/s', 'GC ms (max)'],
      scenes.map((scene) => {
        const p = r.phases[scene];
        if (!p) return [scene, '–', '–', '–', '–', '–', '–', '–', '–'];
        const s = p.summary;
        const gc = p.trace?.gc?.CrRendererMain;
        return [
          scene,
          `${f(s.fps, 0)} (${f(p.trace?.presents ? p.trace.presents.n / s.seconds : NaN, 0)})`,
          `${f(s.dt.p50)}/${f(s.dt.p99)}/${f(s.dt.max)}`,
          f(s.js.p50, 2),
          f(s.gpuFrame.p50, 2),
          f(s.drawCalls.p50, 0),
          f(s.counters.programLookups?.perFrame),
          f(s.heap.allocatedMBps, 0),
          gc ? `${f(gc.ms, 0)} (${f(gc.max)})` : '–'
        ];
      })
    )
  );
}

out.push('\n### The splat passes by view direction\n');
out.push('GPU ms, p50 over the half second after each turn: the frame, then the passes over 0.1 ms.\n');
for (const { name, dir } of runs) {
  let log;
  try {
    log = JSON.parse(readFileSync(join(dir, 'logs', 'splat.json'), 'utf8'));
  } catch {
    continue;
  }
  // Columns folded to one value come back as `{ constant }`.
  for (const [k, v] of Object.entries(log.columns)) if (!Array.isArray(v)) log.columns[k] = new Array(log.rows).fill(v.constant);
  const marks = log.marks.filter((m) => m.name.startsWith('yaw'));
  const passNames = Object.keys(log.passes).filter((p) => stats(log.passes[p].map((x) => x ?? NaN)).p50 > 0.1);
  const rows = marks.map((m, i) => {
    const part = slice(log, m.row, i + 1 < marks.length ? marks[i + 1].row - Math.round(0.5 * 240) : log.rows);
    return [m.name, f(stats(part.columns.gpuFrame.map((x) => x ?? NaN)).p50, 2), ...passNames.map((p) => f(stats(part.passes[p].map((x) => x ?? NaN)).p50, 2))];
  });
  out.push(`\n**${name}**\n`);
  out.push(table(['view', 'frame', ...passNames], rows));
}
console.log(out.join('\n'));
