// The baseline's arithmetic: a frame log summarised, its hitches listed and tagged by cause, and a
// trace's collections, compiles and presents read over the same window.
//
// A frame log is what the page's harness hands over (perf-lib.mjs): columns of one row a frame,
// with `tick` the display's time for the frame, `start` and `end` when its callbacks ran, and the
// counters' change over the frame.

/** p50, p95, p99, max, mean and count of the finite values. */
export function stats(values) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (v.length === 0) return { n: 0 };
  const at = (p) => v[Math.min(v.length - 1, Math.floor(p * v.length))];
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  return { n: v.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: v[v.length - 1], mean };
}

/** Rounds every number in a value to `places`, for a record a person reads. */
export function rounded(value, places = 2) {
  const f = 10 ** places;
  return JSON.parse(JSON.stringify(value, (_, x) => (typeof x === 'number' ? Math.round(x * f) / f : x)));
}

/** The sum of a column's finite values. */
const total = (col) => col.reduce((a, b) => (Number.isFinite(b) ? a + b : a), 0);

/** Each row's interval from the frame before, the first row's NaN. */
export function intervals(log) {
  const { tick } = log.columns;
  return tick.map((t, i) => (i === 0 ? NaN : t - tick[i - 1]));
}

/**
 * A frame log over its rows, at a display rate (0 for the browser's own pace).
 *
 * - `dt`: the display's interval between frames; at a rate, the refreshes each frame took.
 * - `hitches`: frames that took more than one and a half refreshes, and over 33, 50 and 100 ms.
 * - `js`: the page's time in the frame's callbacks, `update` and `render` the engine's share.
 * - The counters' totals and their rate a frame, the heap's growth between collections as an
 *   allocation rate, and the client's stream: snapshots a second, frames drawn from prediction,
 *   and frames past the newest snapshot (the lagometer's yellow).
 *
 * @param {object} log
 * @param {number} rate
 */
export function summarise(log, rate) {
  const c = log.columns;
  const dt = intervals(log);
  const rows = log.rows;
  const seconds = rows > 1 ? (c.tick[rows - 1] - c.tick[0]) / 1000 : 0;
  const period = rate > 0 ? 1000 / rate : stats(dt).p50;
  const refreshes = {};
  if (rate > 0) {
    for (const d of dt) {
      if (!Number.isFinite(d)) continue;
      const n = Math.max(1, Math.round(d / period));
      refreshes[n] = (refreshes[n] ?? 0) + 1;
    }
  }
  const js = c.end.map((e, i) => e - c.start[i]);
  const counters = {};
  for (const name of Object.keys(log.totals ?? {})) {
    if (!c[name]) continue;
    const sum = total(c[name]);
    counters[name] = { total: sum, perFrame: rows ? sum / rows : 0 };
  }
  // The heap's growth while nothing collects, as an allocation rate; each fall as a collection.
  let grown = 0;
  let falls = 0;
  for (let i = 1; i < rows; i++) {
    const d = c.heap[i] - c.heap[i - 1];
    if (!Number.isFinite(d)) continue;
    if (d >= 0) grown += d;
    else falls++;
  }
  const passes = {};
  for (const [name, col] of Object.entries(log.passes ?? {})) passes[name] = stats(col).p50;
  return {
    rows,
    seconds,
    fps: seconds > 0 ? (rows - 1) / seconds : 0,
    dt: stats(dt),
    refreshes,
    hitches: {
      overOneAndAHalf: dt.filter((d) => d > period * 1.5).length,
      over33: dt.filter((d) => d > 33.4).length,
      over50: dt.filter((d) => d > 50).length,
      over100: dt.filter((d) => d > 100).length,
      excessMs: dt.reduce((a, d) => (Number.isFinite(d) && d > period * 1.5 ? a + d - period : a), 0)
    },
    late: stats(c.start.map((s, i) => s - c.tick[i])),
    js: stats(js),
    update: stats(c.update ?? []),
    render: stats(c.render ?? []),
    gpuFrame: stats(c.gpuFrame ?? []),
    passes,
    drawCalls: stats(c.drawCalls ?? []),
    triangles: stats(c.triangles ?? []),
    gsplats: stats(c.gsplats ?? []),
    gsplatCopyFrames: (c.gsplatCopy ?? []).filter((x) => x > 0).length,
    counters,
    heap: {
      first: c.heap[0],
      last: c.heap[rows - 1],
      allocatedMBps: seconds > 0 ? grown / seconds / 1e6 : 0,
      falls
    },
    stream: {
      snapshotsPerSecond: seconds > 0 ? total(c.snapshots ?? []) / seconds : 0,
      predictedFrames: total(c.moved ?? []),
      steppedFrames: total(c.stepped ?? []),
      extrapolatingFrames: (c.lag ?? []).filter((x) => x > 0).length,
      lag: stats(c.lag ?? [])
    },
    longAnimationFrames: (log.loaf ?? []).length
  };
}

/**
 * The trace's clock against the page's: the offset that takes a page `performance.now()` to a
 * trace timestamp in ms, from the user-timing marks both carry.
 *
 * @param {ReturnType<import('./perf-lib.mjs').readTrace>} trace
 * @param {{ name: string, time: number }[]} marks
 */
export function traceOffset(trace, marks) {
  for (const mark of marks) {
    const e = trace.events.find((x) => x.name === `perf:${mark.name}` && x.ph !== 'M');
    if (e) return e.ts / 1000 - mark.time;
  }
  return null;
}

/** The threads whose collections pause the game: the page's main thread and the server's worker. */
const PAUSED_THREADS = new Set(['CrRendererMain', 'DedicatedWorker thread']);

/**
 * Each thread's collection pauses: V8's GC phases on the thread itself (its helpers' background
 * work left out), nested phases merged into one span a pause.
 *
 * @param {ReturnType<import('./perf-lib.mjs').readTrace>} trace
 * @param {number} offset
 * @returns {Map<string, { from: number, to: number, ms: number }[]>} page-time spans by thread
 */
export function gcPauses(trace, offset) {
  const spans = new Map();
  for (const e of trace.events) {
    if (e.ph !== 'X' || !e.name.startsWith('V8.GC_') || e.name.includes('BACKGROUND')) continue;
    const thread = trace.thread(e);
    if (!PAUSED_THREADS.has(thread)) continue;
    const list = spans.get(thread) ?? [];
    list.push({ from: e.ts / 1000 - offset, to: (e.ts + (e.dur ?? 0)) / 1000 - offset });
    spans.set(thread, list);
  }
  const merged = new Map();
  for (const [thread, list] of spans) {
    list.sort((a, b) => a.from - b.from);
    const out = [];
    for (const s of list) {
      const last = out[out.length - 1];
      if (last && s.from <= last.to) last.to = Math.max(last.to, s.to);
      else out.push({ ...s });
    }
    for (const s of out) s.ms = s.to - s.from;
    merged.set(thread, out);
  }
  return merged;
}
/** Dawn's pipeline creations and the shader compiles under them. */
const COMPILE_EVENTS = new Set(['DeviceBase::APICreateRenderPipeline', 'DeviceBase::APICreateComputePipeline']);
/** A frame leaving the GPU process for the display. */
const PRESENT_EVENT = 'SkiaOutputSurfaceImplOnGpu::SwapBuffers';

/**
 * What the trace says over a window of page time: collection pauses by thread, pipelines compiled in
 * the GPU process, and the intervals between presents, which show a stall the page never sees.
 *
 * @param {ReturnType<import('./perf-lib.mjs').readTrace>} trace
 * @param {number} offset - from `traceOffset`
 * @param {number} from - page ms
 * @param {number} to - page ms
 * @param {number} period - the display's refresh, ms
 */
export function traceWindow(trace, offset, from, to, period) {
  const t0 = (from + offset) * 1000;
  const t1 = (to + offset) * 1000;
  const gc = {};
  for (const [thread, spans] of gcPauses(trace, offset)) {
    const inside = spans.filter((s) => s.from >= from && s.from <= to);
    if (inside.length === 0) continue;
    gc[thread] = {
      pauses: inside.length,
      ms: inside.reduce((a, s) => a + s.ms, 0),
      max: Math.max(...inside.map((s) => s.ms))
    };
  }
  const compiles = [];
  const presents = [];
  for (const e of trace.events) {
    if (e.ts < t0 || e.ts > t1 || (e.ph !== 'X' && e.ph !== 'B')) continue;
    if (COMPILE_EVENTS.has(e.name)) {
      compiles.push({ at: e.ts / 1000 - offset, ms: (e.dur ?? 0) / 1000 });
    } else if (e.name === PRESENT_EVENT && trace.thread(e) === 'CrGpuMain') {
      presents.push(e.ts / 1000 - offset);
    }
  }
  presents.sort((a, b) => a - b);
  const gaps = presents.slice(1).map((p, i) => p - presents[i]);
  return {
    gc,
    compiles: {
      n: compiles.length,
      ms: compiles.reduce((a, x) => a + x.ms, 0),
      max: Math.max(0, ...compiles.map((x) => x.ms))
    },
    compileList: compiles,
    presents: {
      n: presents.length,
      gap: stats(gaps),
      overOneAndAHalf: gaps.filter((g) => g > period * 1.5).length,
      longest: gaps
        .map((g, i) => ({ at: presents[i], gap: g }))
        .sort((a, b) => b.gap - a.gap)
        .slice(0, 5)
    }
  };
}

/**
 * Every frame of a log that took more than one and a half refreshes, with what may have held it:
 * - `compile`: pipelines or shader variants made in it or the frame before, or a Dawn compile
 *   in the GPU process over it;
 * - `gc`: a collection on the main thread over it;
 * - `script`: a long animation frame over it, with its longest scripts;
 * - `stream`: drawn past the newest snapshot, which points at the worker or the network.
 *
 * @param {object} log
 * @param {number} rate
 * @param {{ trace?: ReturnType<import('./perf-lib.mjs').readTrace>, offset?: number | null }} [from]
 */
export function hitches(log, rate, { trace = null, offset = null } = {}) {
  const c = log.columns;
  const dt = intervals(log);
  const period = rate > 0 ? 1000 / rate : stats(dt).p50;
  let gcSpans = [];
  const compileSpans = [];
  if (trace && offset !== null) {
    gcSpans = gcPauses(trace, offset).get('CrRendererMain') ?? [];
    for (const e of trace.events) {
      if (e.ph !== 'X' || !COMPILE_EVENTS.has(e.name)) continue;
      const from = e.ts / 1000 - offset;
      compileSpans.push({ from, to: from + (e.dur ?? 0) / 1000, ms: (e.dur ?? 0) / 1000 });
    }
  }
  const out = [];
  for (let i = 1; i < log.rows; i++) {
    if (!(dt[i] > period * 1.5)) continue;
    // The frame that ran late is the one before: it ran from row i-1's start to row i's tick.
    const from = c.start[i - 1];
    const to = c.start[i];
    const tags = [];
    const made = (n) => (c[n]?.[i - 1] ?? 0) + (c[n]?.[i] ?? 0);
    if (made('pipelines') + made('shadersGenerated') + made('computePipelines') > 0) tags.push('compile');
    const gpuCompile = compileSpans.filter((s) => s.to >= from - 50 && s.from <= to);
    if (gpuCompile.length && !tags.includes('compile')) tags.push('compile');
    // The tick found two frames' GPU work not yet done, and the frame waited for it.
    if (c.gpuHeld?.[i] > 0) tags.push('gpu wait');
    const gc = gcSpans.filter((s) => s.to >= from && s.from <= to);
    if (gc.length) tags.push('gc');
    const loaf = (log.loaf ?? []).filter((l) => l.start <= to && l.start + l.duration >= from);
    if (loaf.length) tags.push('script');
    if (c.lag?.[i] > 0 || c.lag?.[i - 1] > 0) tags.push('stream');
    out.push({
      row: i,
      at: c.tick[i],
      dt: dt[i],
      js: c.end[i - 1] - c.start[i - 1],
      update: c.update?.[i - 1],
      render: c.render?.[i - 1],
      pipelines: made('pipelines'),
      shaders: made('shadersGenerated'),
      programLookupMs: c.programLookupMs?.[i - 1],
      gpuCompileMs: gpuCompile.reduce((a, s) => a + s.ms, 0),
      gcMs: gc.reduce((a, s) => a + s.ms, 0),
      lag: c.lag?.[i],
      gpuHeld: c.gpuHeld?.[i],
      scripts: loaf.flatMap((l) => l.scripts.slice(0, 2).map((s) => `${s.source} ${Math.round(s.duration)}ms`)),
      tags
    });
  }
  return out;
}

/**
 * A paced phase judged by the page's own frames: a late frame fails where it is tagged a compile
 * or a script, or its own script or GPU time passes 1.5 refreshes. The rest — held for the GPU,
 * a collection, or nothing found — are counted beside, by their tags, as what the page's work did
 * not cause.
 *
 * @param {ReturnType<typeof hitches>} late - The phase's {@link hitches}.
 * @returns {{ failing: object[], beside: Record<string, number> }}
 */
export function floor(log, late, rate) {
  const limit = (1.5 * 1000) / rate;
  const gpuFrame = log.columns.gpuFrame ?? [];
  const failing = [];
  const beside = {};
  for (const h of late) {
    // The late frame is the row before the one that found it late.
    const gpu = gpuFrame[h.row - 1];
    const own = h.js > limit || gpu > limit;
    if (own || h.tags.includes('compile') || h.tags.includes('script')) {
      failing.push({ row: h.row, dt: h.dt, js: h.js, gpu, tags: h.tags });
    } else {
      const key = h.tags.join('+') || 'untagged';
      beside[key] = (beside[key] ?? 0) + 1;
    }
  }
  return { failing, beside };
}

/** The rows of a log between two marks, as a log of its own. */
export function slice(log, from, to = log.rows) {
  const columns = {};
  for (const [name, col] of Object.entries(log.columns)) columns[name] = col.slice(from, to);
  const passes = {};
  for (const [name, col] of Object.entries(log.passes ?? {})) passes[name] = col.slice(from, to);
  const start = log.columns.start[from] ?? -Infinity;
  const end = log.columns.end[to - 1] ?? Infinity;
  return {
    ...log,
    rows: to - from,
    columns,
    passes,
    loaf: (log.loaf ?? []).filter((l) => l.start >= start && l.start <= end),
    marks: (log.marks ?? []).filter((m) => m.row >= from && m.row < to).map((m) => ({ ...m, row: m.row - from }))
  };
}

/**
 * A log made small enough to keep: rows rounded to 0.01, columns that never changed folded to one
 * value, and the empty ones dropped.
 */
export function compact(log) {
  const columns = {};
  for (const [name, col] of Object.entries(log.columns)) {
    const finite = col.filter(Number.isFinite);
    if (finite.length === 0) continue;
    const r = col.map((x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null));
    columns[name] = r.every((x) => x === r[0]) ? { constant: r[0] } : r;
  }
  const passes = {};
  for (const [name, col] of Object.entries(log.passes ?? {})) {
    passes[name] = col.map((x) => (Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null));
  }
  return { ...log, columns, passes };
}
