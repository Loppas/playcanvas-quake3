/**
 * Helpers for the browser recorder (`scripts/record.mjs`).
 *
 * Split out so the parts with real logic — frame throttling, choosing which frames sit around
 * a mark, contact-sheet layout, and the page-side mark key — are testable under Vitest rather
 * than only by launching a browser and pressing something. Nothing here touches the
 * filesystem, the network or Playwright; `installPageRecorder` is DOM-only and runs under
 * jsdom, which is exactly why it lives here and not in the CLI.
 */

/**
 * Slack, in slots, absorbed when deciding which slot a time falls in.
 *
 * This is floating-point defence, not tolerance for jitter. Frame times arrive as multiples of
 * the compositor step, so asking for the compositor's *own* rate puts every frame exactly on a
 * slot boundary — where a few ulps of error round it back into the slot before it and the frame
 * is dropped as a duplicate. Measured at `--fps 60` against a 60 Hz stream: 578 frames kept out
 * of 600. A thousandth of a slot is 0.05 ms at 20 fps, orders of magnitude above the error and
 * far below any gap a real frame could arrive in.
 */
const SLOT_EPSILON = 1e-3;

/**
 * Which capture slot an elapsed time falls in: time cut into `1000/fps` windows from t0.
 *
 * @param elapsedMs - Milliseconds since recording started.
 * @param fps - Target frames per second; must be above zero.
 */
export function frameSlot(elapsedMs, fps) {
  return Math.floor((Math.max(0, elapsedMs) * fps) / 1000 + SLOT_EPSILON);
}

/**
 * Should this screencast frame be written to disk?
 *
 * Chromium delivers frames at the compositor rate — up to 60/s, at whatever the page manages
 * — which is more than a human needs to read a defect and far more disk than it is worth.
 *
 * The throttle keeps the **first frame that lands in each slot**, rather than asking whether
 * an interval has passed since the last frame it kept. That distinction is not cosmetic. The
 * compositor only offers frames on ~16.67 ms steps, so a gap test rounds every interval up to
 * the next step and quietly hands back a lower rate than the one asked for: measured against a
 * 60 Hz stream, `--fps 24` delivered 20 and `--fps 45` delivered 30, with nothing said. Slots
 * are absolute, so the kept count is `duration x fps` whatever the compositor is doing, and
 * any rate up to the compositor's own is honoured — 24 is 24.
 *
 * @param lastSlot - Slot of the last kept frame, or `null` if none yet.
 * @param elapsedMs - Elapsed time of the frame being considered.
 * @param fps - Target frames per second; `0` or less keeps every frame.
 */
export function shouldKeepFrame(lastSlot, elapsedMs, fps) {
  if (fps <= 0) return true;
  return frameSlot(elapsedMs, fps) !== lastSlot;
}

/**
 * The rate frames were actually written at, across the captured span.
 *
 * Asking for a rate is not getting one: the screencast cannot deliver frames faster than the
 * page composites them, so `--fps 60` against a page painting 30 times a second gives 30 and
 * no amount of configuration changes that. Reporting the measured rate is what turns that from
 * a silent shortfall into a fact on the summary line.
 *
 * Measured between the first and last kept frame rather than over the recording's duration, so
 * a late start or an early cap does not skew it.
 *
 * This is the **capture cadence, not the game's frame rate** — a frame that took 80 ms to
 * render and a frame the throttle chose to skip are indistinguishable here. Frame-rate figures
 * still need a human watching a real browser.
 *
 * @param frames - Kept frames, each `{ t }` in milliseconds, in order.
 */
export function measuredFps(frames) {
  if (frames.length < 2) return 0;
  const span = frames[frames.length - 1].t - frames[0].t;
  if (span <= 0) return 0;
  return ((frames.length - 1) * 1000) / span;
}

/**
 * What the capture settings will produce, in the arithmetic a human would do anyway.
 *
 * Printed before recording starts, because the interesting number is not the flag — it is how
 * long you can play before a cap cuts the capture off, and that is `maxFrames / fps`.
 *
 * @param options - `{ fps, maxFrames, seconds }` as parsed from the command line.
 */
export function describeCapture({ fps, maxFrames, seconds }) {
  if (fps <= 0) {
    return `every frame the compositor delivers · the ${maxFrames}-frame cap arrives fast`;
  }

  const rate = `${fps} fps · one frame every ${Math.round(1000 / fps)}ms`;
  if (seconds > 0) {
    const wanted = Math.round(seconds * fps);
    return (
      `${rate} · ${seconds}s = ${Math.min(wanted, maxFrames)} frames` +
      (wanted > maxFrames ? ` (capped from ${wanted} by --max-frames)` : '')
    );
  }
  return `${rate} · the ${maxFrames}-frame cap is ${formatElapsed((maxFrames / fps) * 1000)}`;
}

/**
 * Name one frame file so it is both sort-ordered and self-describing.
 *
 * The elapsed time is in the name on purpose — correlating a frame with a mark or a console
 * line should not require opening the manifest.
 *
 * @param index - Zero-based index among kept frames.
 * @param elapsedMs - Milliseconds since recording started.
 * @param extension - `png` or `jpeg`.
 */
export function frameFileName(index, elapsedMs, extension) {
  const n = String(index).padStart(4, '0');
  const t = String(Math.max(0, Math.round(elapsedMs))).padStart(6, '0');
  return `f${n}_t${t}ms.${extension}`;
}

/**
 * Reduce a list to at most `count` items, evenly spread and keeping both ends.
 *
 * @param items - Source list, in order.
 * @param count - Maximum to return.
 */
export function subsample(items, count) {
  if (count <= 0 || items.length === 0) return [];
  if (items.length <= count) return [...items];
  if (count === 1) return [items[Math.floor((items.length - 1) / 2)]];
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push(items[Math.round((i * (items.length - 1)) / (count - 1))]);
  }
  return out;
}

/**
 * Pair mark presses into segments: press once to open, press again to close.
 *
 * A point-in-time mark turned out not to survive contact with a human. Across a real 46 s
 * playtest the presses landed anywhere from 800 ms *before* the event to seconds after it,
 * so no fixed window around them caught what they were pointing at. Bracketing removes the
 * guess entirely — whatever is between the two presses is what gets kept.
 *
 * An odd final press leaves a segment open; it closes at the end of the recording rather
 * than being discarded, and is flagged so the caller can say so.
 *
 * @param markTimes - Press times in milliseconds, in order.
 * @param endMs - End of the recording, used to close a trailing open segment.
 */
export function pairMarks(markTimes, endMs) {
  const segments = [];
  for (let i = 0; i < markTimes.length; i += 2) {
    const open = i + 1 >= markTimes.length;
    segments.push({
      index: segments.length + 1,
      start: markTimes[i],
      end: open ? endMs : markTimes[i + 1],
      open
    });
  }
  return segments;
}

/**
 * The frames belonging to one segment, padded either side.
 *
 * The pad exists because a press is never exactly on the boundary — a little lead-in and
 * lead-out makes the segment show what the event came out of and settled into.
 *
 * Reports `total` alongside the (possibly subsampled) frames so a caller can say how many
 * were dropped. A silent truncation reads as "here is the whole event" when it is not.
 *
 * @param frames - All kept frames, each `{ t }` in milliseconds, in order.
 * @param segment - `{ start, end }` in milliseconds.
 * @param options - `{ pad, count }`; `count` of 0 or less keeps every frame.
 */
export function framesInSegment(frames, segment, { pad, count }) {
  const inRange = frames.filter((f) => f.t >= segment.start - pad && f.t <= segment.end + pad);
  const kept = count > 0 ? subsample(inRange, count) : inRange;
  return { frames: kept, total: inRange.length, subsampled: kept.length < inRange.length };
}

/**
 * Grid shape for a contact sheet of `count` thumbnails.
 *
 * Capped at five columns so thumbnails stay large enough to read a defect in.
 *
 * @param count - Number of thumbnails.
 */
export function sheetLayout(count) {
  if (count <= 0) return { cols: 0, rows: 0 };
  const cols = Math.min(5, Math.ceil(Math.sqrt(count)));
  return { cols, rows: Math.ceil(count / cols) };
}

/** Escape text for use as HTML content or an attribute value. */
export function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Build the contact-sheet page: a labelled grid of frame thumbnails.
 *
 * Rendered from a `file://` URL in the recording directory and screenshotted, which is how
 * the tool tiles images without ffmpeg or a Node image library (there is neither on this
 * machine). Fixed pixel widths, so the screenshot is deterministic.
 *
 * @param entries - `{ src, label }` per thumbnail; `src` is relative to the sheet.
 * @param options - `{ title, cols, thumbWidth }`.
 */
export function contactSheetHtml(entries, { title, cols, thumbWidth }) {
  const cells = entries
    .map(
      (entry) =>
        `<figure><img src="${escapeHtml(entry.src)}" width="${thumbWidth}">` +
        `<figcaption>${escapeHtml(entry.label)}</figcaption></figure>`
    )
    .join('');

  return `<!doctype html>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
  body { margin: 0; background: #111; color: #eee;
         font: 13px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; }
  h1 { font-size: 15px; margin: 0; padding: 10px 12px; background: #000; }
  .grid { display: grid; grid-template-columns: repeat(${cols}, ${thumbWidth}px);
          gap: 8px; padding: 8px; width: max-content; }
  figure { margin: 0; }
  img { display: block; width: ${thumbWidth}px; height: auto; background: #000; }
  figcaption { padding: 3px 2px; color: #9fd6ff; }
</style>
<h1>${escapeHtml(title)}</h1>
<div class="grid">${cells}</div>
`;
}

/**
 * Local-time stamp usable as a directory name: `2026-08-03-14-22-09`.
 *
 * Local rather than ISO/UTC because the name is read by a human comparing it against when
 * they hit record.
 *
 * @param date - The moment to stamp.
 */
export function slugTimestamp(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `-${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
  );
}

/** `4520` -> `4.52s`, for labels a human reads against the on-screen timer. */
export function formatElapsed(ms) {
  return `${(ms / 1000).toFixed(2)}s`;
}

const camelCase = (name) => name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());

/**
 * Minimal flag parser: `--flag`, `--no-flag`, `--key value`, `--key=value`.
 *
 * The *default's* type decides how a value is read, so the defaults object doubles as the
 * option schema — an unknown flag or an unparseable number is an error rather than a silent
 * misconfiguration halfway through a recording.
 *
 * @param argv - Arguments after the script name.
 * @param defaults - Option names (camelCase) mapped to their default values.
 */
export function parseArgs(argv, defaults) {
  const out = { ...defaults };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) throw new Error(`unexpected argument: ${token}`);

    const equals = token.indexOf('=');
    const name = equals === -1 ? token.slice(2) : token.slice(2, equals);
    let raw = equals === -1 ? undefined : token.slice(equals + 1);

    const negated = name.startsWith('no-') && typeof defaults[camelCase(name.slice(3))] === 'boolean';
    const key = camelCase(negated ? name.slice(3) : name);
    if (!(key in out)) throw new Error(`unknown option: --${name}`);

    const kind = typeof defaults[key];
    if (kind === 'boolean') {
      out[key] = negated ? false : raw === undefined ? true : raw !== 'false';
      continue;
    }

    if (raw === undefined) raw = argv[++i];
    if (raw === undefined) throw new Error(`--${name} needs a value`);

    if (kind === 'number') {
      const value = Number(raw);
      if (!Number.isFinite(value)) throw new Error(`--${name} needs a number, got "${raw}"`);
      out[key] = value;
    } else {
      out[key] = raw;
    }
  }

  return out;
}

/**
 * Page-side recorder: the segment key and the status overlay.
 *
 * Installed through `addInitScript`, so it survives reloads. The keydown listener is in the
 * capture phase and calls `preventDefault`, so the key never reaches the game.
 *
 * The key **toggles**: press to open a segment, press again to close it. The badge holds a
 * red border for as long as a segment is open, so there is never any doubt about which state
 * you are in — that feedback is the whole reason bracketing beats a point-in-time mark.
 *
 * Idempotent by construction. A second install tears the first one down rather than stacking
 * a second listener on the same window — otherwise one keypress would count as two, which is
 * exactly the kind of quiet doubling that makes a bug report worse than no bug report.
 *
 * @param options - `{ markKey }`, serialized across the Playwright boundary.
 */
export function installPageRecorder({ markKey }) {
  if (window !== window.top) return;
  window.__pcqRecorderTeardown?.();

  const started = performance.now();
  let marks = 0;
  let openedAt = 0;
  let flashUntil = 0;
  let badge = null;
  let ticker = null;

  /** Toggle the segment and flash the badge; called by the key and by the terminal path. */
  window.__pcqRecorderNoteMark = () => {
    marks++;
    if (marks % 2 === 1) openedAt = performance.now();
    flashUntil = performance.now() + 400;
  };

  const onKeyDown = (event) => {
    if (event.code !== markKey || event.repeat) return;
    event.preventDefault();
    event.stopPropagation();
    window.__pcqRecorderNoteMark();
    window.__pcqRecorderMark?.();
  };
  window.addEventListener('keydown', onKeyDown, true);

  window.__pcqRecorderTeardown = () => {
    window.removeEventListener('keydown', onKeyDown, true);
    if (ticker !== null) clearInterval(ticker);
    if (badge) badge.remove();
    delete window.__pcqRecorderNoteMark;
    delete window.__pcqRecorderTeardown;
  };

  const install = () => {
    badge = document.createElement('div');
    badge.style.cssText = [
      'position:fixed',
      'left:8px',
      'bottom:8px',
      'z-index:2147483647',
      'pointer-events:none',
      'font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace',
      'color:#fff',
      'background:rgba(0,0,0,.6)',
      'padding:3px 7px',
      'border-radius:4px',
      'border:1px solid transparent'
    ].join(';');
    document.body.appendChild(badge);

    // setInterval rather than requestAnimationFrame: the badge must not join the render loop
    // it is there to observe.
    ticker = setInterval(() => {
      const now = performance.now();
      const elapsed = ((now - started) / 1000).toFixed(1);
      const open = marks % 2 === 1;
      const segment = Math.ceil(marks / 2);

      badge.style.borderColor = open || now < flashUntil ? '#ff5a5a' : 'transparent';
      badge.textContent = open
        ? `● REC ${elapsed}s · ⏺ segment ${segment} · ${((now - openedAt) / 1000).toFixed(1)}s` +
          ` · ${markKey} to end`
        : `● REC ${elapsed}s · ${markKey} to start a segment` +
          (segment > 0 ? ` · ${segment} kept` : '');
    }, 100);
  };

  if (document.body) install();
  else document.addEventListener('DOMContentLoaded', install, { once: true });
}
