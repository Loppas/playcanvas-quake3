#!/usr/bin/env node
/**
 * Record a play session in a real browser, for defects that have to be *shown*.
 *
 * Some bugs cannot be written down — "the rocket shrinks when I strafe" took four rounds of
 * prose and two wrong hypotheses. This opens the game in a headed Chromium, captures the
 * frames while you play, and lets you **bracket** the thing that goes wrong: press the key
 * when it starts, press it again when it ends.
 *
 * Bracketing replaced a point-in-time mark after the first real playtest, where 11 presses
 * across 46 s landed anywhere from 800 ms *before* the event to seconds after it. No window
 * around a single press caught what it pointed at; every sheet came out empty. Two presses
 * remove the guess.
 *
 * What it produces, and why:
 *
 * - `frames/*.jpeg` — individual frames, at full canvas resolution. **This is the deliverable**,
 *   not the video: an agent can read a still and cannot watch a `.webm`.
 * - `sheet-segment-N.png` — a contact sheet of one bracketed segment. One image to hand over
 *   instead of twenty. Tiled by screenshotting a `file://` page, because this machine has
 *   neither ffmpeg nor a Node image library.
 * - `video.webm` — the clip, for a human to scrub.
 * - `manifest.json` — frame times, marks, and every console line and page error with its
 *   elapsed time, so a log message can be lined up against the frame it happened on.
 *
 * The recorded environment is deliberately left alone: no extra Chromium flags, no relaxed
 * autoplay policy, nothing that could make the bug behave differently under recording than
 * it does when you are just playing.
 *
 * Known noise: every headed recording logs one or two `Failed to load resource: 404` console
 * errors with no URL attached. That is Chromium asking for `/favicon.ico`, which this project
 * does not have — a browser-chrome request, so it never reaches `page.on('response')` and
 * cannot be named. Confirmed by a headless run seeing all 68 page responses with no 4xx among
 * them. A 404 that *does* matter arrives as an `httperror` line, with its URL.
 *
 * Usage:
 *   npm run record                      # start (or attach to) the dev server and record
 *   npm run record -- --seconds 30      # stop automatically after 30 s
 *   npm run record -- --url "http://localhost:5173/?map=garage_cats" --fps 30
 *
 * While recording, **F8 toggles**: press when the thing starts, press again when it ends.
 * `m` + Enter in this terminal does the same. Press Enter on its own (or Ctrl-C, or close the
 * window) to stop; a segment still open at that point is closed for you.
 */

import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

import {
  contactSheetHtml,
  describeCapture,
  formatElapsed,
  frameFileName,
  frameSlot,
  framesInSegment,
  installPageRecorder,
  measuredFps,
  pairMarks,
  parseArgs,
  sheetLayout,
  shouldKeepFrame,
  slugTimestamp,
  subsample
} from './record-lib.mjs';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const DEFAULT_DEV_URL = 'http://localhost:5173/';
/** The map a recording plays, as `?map=` starts it: without one the game starts on its main menu. */
const RECORDED_MAP = 'garage_rats';

/** Target width of a contact sheet in CSS pixels, and the padding/gap it is laid out with. */
const SHEET_WIDTH = 1800;
const SHEET_GAP = 8;
const SHEET_PADDING = 16;

const DEFAULTS = {
  /** Page to record. Empty means "attach to the dev server, starting it if needed". */
  url: '',
  /** Output directory name under `recordings/`. Empty means a local timestamp. */
  name: '',
  width: 1280,
  height: 720,
  /** Backing-store scale. 2 captures at retina detail — bigger files, finer detail. */
  scale: 1,
  /**
   * Frames per second written to disk — the capture frequency. 20 is enough to read a defect
   * off a contact sheet and cheap enough to leave running; raise it when the thing being shown
   * happens inside a few frames (a projectile leaving the muzzle, a one-frame flash), lower it
   * for a long session where only the shape of the play matters. 0 keeps every frame the
   * compositor delivers, which is up to 60/s and roughly 40 MB a second.
   */
  fps: 20,
  /** Caps on what one recording may write, so a forgotten session cannot fill the disk. */
  maxFrames: 2000,
  maxMb: 750,
  /** Auto-stop after this many seconds. 0 records until told to stop. */
  seconds: 0,
  /**
   * Frame codec. `jpeg` by default because a photogrammetric splat scene is a photograph and
   * compresses like one: measured on this map, a 1280×720 frame is **4.0 MB as PNG and 669 KB
   * at jpeg 90** — six times the disk for the same 18 seconds. Use `--format png` when the
   * frames are going to be measured pixel by pixel rather than looked at.
   */
  format: 'jpeg',
  /** JPEG quality; ignored for PNG. */
  quality: 90,
  /** `KeyboardEvent.code` of the segment key. It toggles: press to start, press again to end. */
  markKey: 'F8',
  /** Lead-in and lead-out around a segment, so it shows what the event came out of. */
  segmentPad: 400,
  /** Thumbnails per segment sheet; 0 keeps every frame in the segment. */
  segmentFrames: 16,
  /** Frames on the overview sheet when no segment was marked. */
  overviewFrames: 12,
  video: true,
  help: false
};

const USAGE = `
Record a browser play session.

  npm run record -- [options]

  --url <url>           Page to record (default: start/attach the vite dev server)
  --name <dir>          Output directory under recordings/ (default: local timestamp)
  --width/--height <n>  Viewport size (default 1280x720)
  --scale <n>           Device pixel ratio (default 1; 2 for retina detail)
  --fps <n>             Capture frequency, frames written per second (default 20; 0 = every
                        frame). Any rate up to the compositor's own is honoured exactly, so
                        60s at --fps 30 is 1800 frames. Raise it for something that happens
                        in a few frames; the summary says what was actually captured.
  --max-frames <n>      Stop capturing after this many frames (default 2000)
  --max-mb <n>          Stop capturing after this many MB of frames (default 750)
  --seconds <n>         Auto-stop after n seconds (default 0 = manual)
  --format jpeg|png     Frame format (default jpeg; png is ~6x the disk on a splat map)
  --quality <n>         JPEG quality 0-100 (default 90; ignored for png)
  --mark-key <code>     KeyboardEvent.code of the segment key (default F8)
  --segment-pad <ms>    Lead-in/lead-out around each segment (default 400)
  --segment-frames <n>  Thumbnails per segment sheet (default 16; 0 = every frame)
  --overview-frames <n> Thumbnails on the sheet used when no segment was marked (default 12)
  --no-video            Skip the .webm
  --help

While recording, F8 **toggles**: press when the thing starts, press again when it ends, and
everything between is what gets kept. \`m\` + Enter here does the same. The badge holds a red
border while a segment is open. Enter on its own, Ctrl-C, or closing the window stops.
`.trimStart();

/** Is something already answering on this URL? */
async function reachable(url) {
  try {
    await fetch(url, { signal: AbortSignal.timeout(1500) });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get a dev server to record against.
 *
 * An explicit `--url` is used as given and never managed. Otherwise an already-running server
 * on the default port is reused — the common case, since the dev server is usually already
 * up — and only if nothing answers is one started and later shut down. Either is recorded at
 * {@link RECORDED_MAP}.
 *
 * The one it starts runs in this process, through Vite's API, as `scripts/shell-dev.mjs` runs
 * its own. It isn't spawned as `npm run dev`: on Windows, `spawn` without a shell looks only for
 * `npm.com` and `npm.exe`, never `npm.cmd`, and a process group can't be killed there.
 *
 * @param explicitUrl - `--url`, or empty.
 */
async function ensureDevServer(explicitUrl) {
  if (explicitUrl) return { url: explicitUrl, stop: async () => {} };

  const atMap = (url) => `${url}?map=${RECORDED_MAP}`;
  if (await reachable(DEFAULT_DEV_URL)) {
    return { url: atMap(DEFAULT_DEV_URL), stop: async () => {} };
  }

  console.log('starting the dev server…');
  const { createServer } = await import('vite');
  const endListeners = new Set(process.stdin.listeners('end'));
  // Warnings and errors only, so this terminal stays the recorder's: none of the page's console,
  // which the manifest keeps, and no clearing the screen, which would take the recorder's lines.
  const server = await createServer({
    root: REPO_ROOT,
    logLevel: 'warn',
    clearScreen: false,
    server: { forwardConsole: false }
  });
  // Vite exits the process when stdin ends, which would cut a recording off before its video
  // and sheets are written. Only `waitForStop` ends a recording, so Vite's listener comes off.
  for (const listener of process.stdin.listeners('end')) {
    if (!endListeners.has(listener)) process.stdin.off('end', listener);
  }
  await server.listen();
  const url = server.resolvedUrls?.local[0];
  if (!url) {
    await server.close();
    throw new Error('the dev server started without a local URL');
  }
  return { url: atMap(url), stop: () => server.close() };
}

/**
 * Block until the recording should end, marking whenever asked.
 *
 * Four ways to stop, because a recording that cannot be stopped cleanly loses its video:
 * Enter on stdin, Ctrl-C, closing the browser window, or `--seconds` elapsing.
 *
 * @param options - `{ page, seconds, onMark }`.
 */
function waitForStop({ page, seconds, onMark }) {
  return new Promise((resolveStop) => {
    const readline = createInterface({ input: process.stdin });
    let timer = null;

    const finish = (reason) => {
      readline.close();
      // readline leaves stdin flowing, which would hold the event loop open past the summary.
      process.stdin.pause();
      if (timer) clearTimeout(timer);
      process.off('SIGINT', onSigint);
      page.off('close', onClose);
      resolveStop(reason);
    };

    const onSigint = () => finish('interrupted');
    const onClose = () => finish('window closed');

    readline.on('line', (line) => {
      const command = line.trim().toLowerCase();
      if (command === 'm' || command === 'mark') {
        onMark();
        return;
      }
      finish('stopped from the terminal');
    });
    // stdin closing (a finished pipe) is not a stop on its own; the timer or the window is.
    process.once('SIGINT', onSigint);
    page.once('close', onClose);

    if (seconds > 0) timer = setTimeout(() => finish(`${seconds}s elapsed`), seconds * 1000);
  });
}

/**
 * Render one contact sheet by screenshotting a `file://` grid of frames.
 *
 * @param browser - A live browser to borrow a page from.
 * @param options - `{ dir, name, title, entries, frameWidth }`.
 * @returns The sheet's filename, or `null` if there was nothing to tile.
 */
async function writeContactSheet(browser, { dir, name, title, entries, frameWidth }) {
  if (entries.length === 0) return null;

  const { cols } = sheetLayout(entries.length);
  const available = SHEET_WIDTH - SHEET_PADDING * 2 - (cols - 1) * SHEET_GAP;
  const thumbWidth = Math.min(frameWidth, Math.floor(available / cols));
  const pageWidth = cols * thumbWidth + (cols - 1) * SHEET_GAP + SHEET_PADDING * 2;

  const htmlFile = `${name}.html`;
  await writeFile(join(dir, htmlFile), contactSheetHtml(entries, { title, cols, thumbWidth }));

  const context = await browser.newContext({ viewport: { width: pageWidth, height: 900 } });
  const page = await context.newPage();
  try {
    await page.goto(pathToFileURL(join(dir, htmlFile)).href);
    await page
      .waitForFunction(() => Array.from(document.images).every((image) => image.complete), null, {
        timeout: 15_000
      })
      .catch(() => console.warn(`  (sheet ${name}: some frames did not load in time)`));
    await page.screenshot({ path: join(dir, `${name}.png`), fullPage: true });
  } finally {
    await context.close();
  }
  return `${name}.png`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2), DEFAULTS);
  if (options.help) {
    console.log(USAGE);
    return;
  }

  const { chromium } = await import('playwright').catch(() => {
    throw new Error(
      'playwright is not installed. Run:\n' +
        '  npm install -D playwright && npx playwright install chromium'
    );
  });

  const label = options.name || slugTimestamp(new Date());
  const dir = join(REPO_ROOT, 'recordings', label);
  const framesDir = join(dir, 'frames');
  await mkdir(framesDir, { recursive: true });

  const server = await ensureDevServer(options.url);
  // A server this run started lives in this process, so it closes on every way out.
  try {
    await recordSession({ chromium, options, label, dir, framesDir, server });
  } finally {
    await server.stop();
  }
}

/**
 * Record one session against a server, then write its sheets, manifest and summary.
 *
 * @param run - `{ chromium, options, label, dir, framesDir, server }`.
 */
async function recordSession({ chromium, options, label, dir, framesDir, server }) {
  const viewport = { width: options.width, height: options.height };

  const browser = await chromium.launch({
    headless: false,
    args: [`--window-size=${options.width},${options.height + 120}`]
  });
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: options.scale,
    recordVideo: options.video ? { dir, size: viewport } : undefined
  });
  const page = await context.newPage();

  const frames = [];
  const markTimes = [];
  const consoleLines = [];
  // One clock for everything: frames carry Chromium's own capture time, marks and console
  // lines are stamped in Node. A few ms of IPC skew is nothing at a 50 ms frame interval, and
  // sharing an origin is what lets a log line be lined up against the frame it happened on.
  let t0 = Date.now();
  const elapsed = () => Date.now() - t0;

  page.on('console', (message) =>
    consoleLines.push({ t: elapsed(), type: message.type(), text: message.text() })
  );
  page.on('pageerror', (error) =>
    consoleLines.push({ t: elapsed(), type: 'pageerror', text: String(error) })
  );
  page.on('requestfailed', (request) =>
    consoleLines.push({
      t: elapsed(),
      type: 'requestfailed',
      text: `${request.url()} — ${request.failure()?.errorText ?? 'failed'}`
    })
  );
  // A 404 is a *successful* response, so `requestfailed` never sees it, and the console line
  // Chromium logs for one omits the URL — leaving "Failed to load resource: 404" and nothing
  // to act on. This is the listener that names the file.
  page.on('response', (response) => {
    if (response.status() < 400) return;
    consoleLines.push({
      t: elapsed(),
      type: 'httperror',
      text: `${response.status()} ${response.url()}`
    });
  });

  const takeMark = () => {
    const at = elapsed();
    markTimes.push(at);
    const opening = markTimes.length % 2 === 1;
    const index = Math.ceil(markTimes.length / 2);
    console.log(
      opening
        ? `  segment ${index} open at ${formatElapsed(at)}`
        : `  segment ${index} closed at ${formatElapsed(at)} ` +
          `(${formatElapsed(at - markTimes[markTimes.length - 2])})`
    );
  };

  await page.exposeFunction('__pcqRecorderMark', takeMark);
  await page.addInitScript(installPageRecorder, { markKey: options.markKey });

  // Zero the clock at navigation, not at screencast start, so the load itself is on the
  // timeline — an asset that 404s is often the whole explanation for what follows.
  t0 = Date.now();
  await page.goto(server.url, { waitUntil: 'domcontentloaded' });

  const cdp = await context.newCDPSession(page);
  const extension = options.format === 'jpeg' ? 'jpeg' : 'png';

  // Frames are written through one chain rather than in parallel, so the queue cannot grow
  // without bound while the disk catches up, and the files land in capture order.
  let writes = Promise.resolve();
  let lastSlot = null;
  let bytes = 0;
  let capped = false;

  /** Why capture should stop, or `null` to keep going. */
  const capReason = () => {
    if (frames.length >= options.maxFrames) return `frame cap (${options.maxFrames})`;
    if (bytes >= options.maxMb * 1e6) return `size cap (${options.maxMb} MB)`;
    return null;
  };

  cdp.on('Page.screencastFrame', (event) => {
    // Ack first and unconditionally: Chromium stops sending until the frame is acknowledged.
    cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {});

    const at = event.metadata?.timestamp ? event.metadata.timestamp * 1000 - t0 : elapsed();
    if (at < 0 || !shouldKeepFrame(lastSlot, at, options.fps)) return;

    const reason = capReason();
    if (reason) {
      if (!capped) {
        capped = true;
        console.warn(`  ${reason} reached — recording on, no longer capturing frames`);
      }
      return;
    }

    lastSlot = options.fps > 0 ? frameSlot(at, options.fps) : null;
    const file = frameFileName(frames.length, at, extension);
    frames.push({ file, t: Math.round(at) });
    const data = Buffer.from(event.data, 'base64');
    bytes += data.length;
    // Caught per link so one failed write cannot poison the rest of the chain.
    writes = writes
      .then(() => writeFile(join(framesDir, file), data))
      .catch((error) => console.warn(`  frame ${file} not written: ${error.message}`));
  });

  await cdp.send('Page.startScreencast', {
    format: extension,
    quality: options.quality,
    everyNthFrame: 1
  });

  console.log(`recording ${server.url} -> recordings/${label}`);
  console.log(`  ${describeCapture(options)}`);
  console.log(
    `  ${options.markKey} in the browser starts a segment, ${options.markKey} again ends it ` +
      '("m" + Enter here does too)'
  );
  console.log('  Enter stops.');

  const reason = await waitForStop({
    page,
    seconds: options.seconds,
    onMark: () => {
      takeMark();
      page.evaluate(() => window.__pcqRecorderNoteMark?.()).catch(() => {});
    }
  });
  const durationMs = elapsed();
  console.log(`stopping — ${reason}`);

  await cdp.send('Page.stopScreencast').catch(() => {});
  await writes;

  const video = page.video();
  await context.close(); // flushes the .webm
  let videoFile = null;
  if (video) {
    const from = await video.path().catch(() => null);
    if (from) {
      await rename(from, join(dir, 'video.webm'));
      videoFile = 'video.webm';
    }
  }

  // Sheets, so there is one image to hand over rather than a directory of them. With nothing
  // bracketed there is no event to show, so the whole recording is sampled evenly instead.
  const frameWidth = options.width * options.scale;
  const segments = pairMarks(markTimes, durationMs);
  const picked = segments.map((segment) => ({
    segment,
    ...framesInSegment(frames, segment, { pad: options.segmentPad, count: options.segmentFrames })
  }));

  const groups = picked.length
    ? picked.map(({ segment, frames: shown, total, subsampled }) => ({
        name: `sheet-segment-${segment.index}`,
        title:
          `segment ${segment.index} — ${formatElapsed(segment.start)} to ` +
          `${formatElapsed(segment.end)} (${formatElapsed(segment.end - segment.start)})` +
          `${segment.open ? ', left open — closed at the end of the recording' : ''}` +
          `, +/-${options.segmentPad}ms pad` +
          `${subsampled ? ` — showing ${shown.length} of ${total} frames` : ` — all ${total} frames`}`,
        frames: shown
      }))
    : [
        {
          name: 'sheet-overview',
          title: `overview — ${formatElapsed(durationMs)}, nothing bracketed`,
          frames: subsample(frames, options.overviewFrames)
        }
      ];

  const sheets = [];
  for (const group of groups) {
    const sheet = await writeContactSheet(browser, {
      dir,
      name: group.name,
      title: group.title,
      frameWidth,
      entries: group.frames.map((frame) => ({
        src: `frames/${frame.file}`,
        label: formatElapsed(frame.t)
      }))
    });
    if (sheet) sheets.push(sheet);
  }

  await browser.close();

  await writeFile(
    join(dir, 'manifest.json'),
    `${JSON.stringify(
      {
        url: server.url,
        durationMs,
        viewport,
        deviceScaleFactor: options.scale,
        fps: options.fps,
        capturedFps: Number(measuredFps(frames).toFixed(2)),
        format: extension,
        quality: extension === 'jpeg' ? options.quality : undefined,
        frameBytes: bytes,
        stoppedBecause: reason,
        cappedEarly: capped,
        video: videoFile,
        sheets,
        markTimes,
        segments: picked.map(({ segment, frames: shown, total, subsampled }) => ({
          ...segment,
          frameCount: total,
          subsampled,
          frames: shown.map((frame) => `frames/${frame.file}`)
        })),
        frames,
        console: consoleLines
      },
      null,
      2
    )}\n`
  );

  const problems = consoleLines.filter((line) => line.type !== 'log' && line.type !== 'debug');
  const captured = measuredFps(frames);
  console.log('');
  console.log(`recordings/${label}`);
  console.log(
    `  ${frames.length} frames · ${captured.toFixed(1)} fps · ` +
      `${segments.length} segment${segments.length === 1 ? '' : 's'} · ` +
      `${formatElapsed(durationMs)} · ${(bytes / 1e6).toFixed(0)} MB` +
      `${videoFile ? ' · video.webm' : ''}` +
      `${problems.length ? ` · ${problems.length} console problem(s)` : ''}`
  );
  // The requested rate is a ceiling, not a promise — the screencast cannot hand over frames the
  // page never composited. Saying so beats letting a quiet shortfall look like the setting.
  if (options.fps > 0 && captured > 0 && captured < options.fps * 0.9) {
    console.warn(
      `  wrote ${captured.toFixed(1)} fps against --fps ${options.fps} — the page did not ` +
        'composite faster (capture cadence, not the game frame rate)'
    );
  }
  // Say what was dropped. A sheet that silently subsamples reads as the whole event.
  for (const { segment, frames: shown, total, subsampled } of picked) {
    if (segment.open) {
      console.warn(
        `  segment ${segment.index} was left open — closed at ${formatElapsed(segment.end)}`
      );
    }
    if (subsampled) {
      console.warn(
        `  segment ${segment.index} sheet shows ${shown.length} of ${total} frames — ` +
          `raise --segment-frames, or read frames/ directly`
      );
    }
  }
  for (const problem of problems.slice(0, 5)) {
    console.log(`    ${problem.t}ms ${problem.type}: ${problem.text.slice(0, 100)}`);
  }
  if (problems.length > 5) console.log(`    …and ${problems.length - 5} more in manifest.json`);
  if (frames.length === 0) {
    console.warn('  no frames captured — was the window visible and rendering?');
  }
  if (sheets.length > 0) {
    console.log('  show these:');
    for (const sheet of sheets) console.log(`    recordings/${label}/${sheet}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
