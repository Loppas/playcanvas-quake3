import { describe, expect, it } from 'vitest';

import {
  contactSheetHtml,
  describeCapture,
  escapeHtml,
  formatElapsed,
  frameFileName,
  frameSlot,
  framesInSegment,
  measuredFps,
  pairMarks,
  parseArgs,
  sheetLayout,
  shouldKeepFrame,
  slugTimestamp,
  subsample
} from './record-lib.mjs';

/** A frame list at a steady rate, as the screencast delivers them. */
const framesAt = (stepMs, count) =>
  Array.from({ length: count }, (_, i) => ({ t: i * stepMs, file: frameFileName(i, i * stepMs, 'png') }));

/** Frames kept from `seconds` of a compositor running at `hz`, at a requested rate. */
function keptFrom(fps, { seconds = 1, hz = 60 } = {}) {
  const kept = [];
  let last = null;
  for (let i = 0; i < seconds * hz; i++) {
    const t = (i * 1000) / hz;
    if (!shouldKeepFrame(last, t, fps)) continue;
    last = fps > 0 ? frameSlot(t, fps) : null;
    kept.push(t);
  }
  return kept;
}

describe('shouldKeepFrame', () => {
  it('keeps everything when the rate is unlimited', () => {
    expect(shouldKeepFrame(0, 1, 0)).toBe(true);
    expect(shouldKeepFrame(0, 1, -1)).toBe(true);
  });

  it('always keeps the first frame', () => {
    expect(shouldKeepFrame(null, 0, 20)).toBe(true);
  });

  it('keeps one frame per slot and drops the rest', () => {
    expect(shouldKeepFrame(0, 33, 20)).toBe(false); // still slot 0
    expect(shouldKeepFrame(0, 50, 20)).toBe(true); // slot 1
    expect(shouldKeepFrame(1, 50, 20)).toBe(false); // slot 1 already taken
  });

  // The whole point of the change. A gap test ("has 1000/fps passed since the last one?")
  // rounds each interval up to the next 16.67 ms compositor step, so it only ever produced
  // rates that divide 60 — 24 came out as 20 and 45 as 30, silently.
  it.each([
    [10, 10],
    [15, 15],
    [20, 20],
    [24, 24],
    [30, 30],
    [45, 45]
  ])('delivers the rate it was asked for: --fps %i -> %i', (fps, expected) => {
    expect(keptFrom(fps).length).toBe(expected);
  });

  it('halves the frames when the frequency is halved', () => {
    const full = keptFrom(60, { seconds: 10 }).length;
    expect(keptFrom(30, { seconds: 10 }).length).toBe(full / 2);
  });

  it('cannot exceed what the compositor offers', () => {
    expect(keptFrom(120, { hz: 30 }).length).toBe(30);
  });

  it('keeps every frame at fps 0', () => {
    expect(keptFrom(0).length).toBe(60);
  });
});

describe('measuredFps', () => {
  it('measures across the captured span, not the recording', () => {
    expect(measuredFps(framesAt(50, 21))).toBeCloseTo(20, 5);
    expect(measuredFps(framesAt(1000 / 24, 25))).toBeCloseTo(24, 5);
  });

  it('has nothing to measure from fewer than two frames', () => {
    expect(measuredFps([])).toBe(0);
    expect(measuredFps([{ t: 0 }])).toBe(0);
    expect(measuredFps([{ t: 5 }, { t: 5 }])).toBe(0);
  });
});

describe('describeCapture', () => {
  it('says how long the frame cap allows at this rate', () => {
    expect(describeCapture({ fps: 20, maxFrames: 2000, seconds: 0 })).toBe(
      '20 fps · one frame every 50ms · the 2000-frame cap is 100.00s'
    );
  });

  it('does the arithmetic when the duration is fixed', () => {
    expect(describeCapture({ fps: 30, maxFrames: 2000, seconds: 60 })).toBe(
      '30 fps · one frame every 33ms · 60s = 1800 frames'
    );
  });

  it('says so when the frame cap will cut a fixed duration short', () => {
    expect(describeCapture({ fps: 60, maxFrames: 2000, seconds: 60 })).toBe(
      '60 fps · one frame every 17ms · 60s = 2000 frames (capped from 3600 by --max-frames)'
    );
  });

  it('describes an unthrottled capture', () => {
    expect(describeCapture({ fps: 0, maxFrames: 2000, seconds: 0 })).toMatch(/every frame/);
  });
});

describe('frameFileName', () => {
  it('pads both fields so the names sort in capture order', () => {
    expect(frameFileName(0, 0, 'png')).toBe('f0000_t000000ms.png');
    expect(frameFileName(7, 1234.6, 'png')).toBe('f0007_t001235ms.png');
    expect(frameFileName(1234, 98765, 'jpeg')).toBe('f1234_t098765ms.jpeg');
  });

  it('clamps a negative elapsed time rather than emitting a minus sign', () => {
    expect(frameFileName(0, -5, 'png')).toBe('f0000_t000000ms.png');
  });
});

describe('subsample', () => {
  it('returns everything when it already fits', () => {
    expect(subsample([1, 2, 3], 5)).toEqual([1, 2, 3]);
  });

  it('keeps both ends and spreads the rest', () => {
    expect(subsample([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 5)).toEqual([0, 2, 5, 7, 9]);
  });

  it('takes the middle when only one is wanted', () => {
    expect(subsample([0, 1, 2, 3, 4], 1)).toEqual([2]);
  });

  it('handles the empty and zero cases', () => {
    expect(subsample([], 5)).toEqual([]);
    expect(subsample([1, 2], 0)).toEqual([]);
  });
});

describe('pairMarks', () => {
  it('pairs presses into open/close segments', () => {
    expect(pairMarks([1000, 2000, 5000, 5500], 9000)).toEqual([
      { index: 1, start: 1000, end: 2000, open: false },
      { index: 2, start: 5000, end: 5500, open: false }
    ]);
  });

  // Stopping mid-segment is a normal way to end a session; discarding it would throw away
  // exactly the take the user was in the middle of capturing.
  it('closes a trailing open segment at the end of the recording, and flags it', () => {
    expect(pairMarks([1000, 2000, 7000], 9000)).toEqual([
      { index: 1, start: 1000, end: 2000, open: false },
      { index: 2, start: 7000, end: 9000, open: true }
    ]);
  });

  it('has no segments when nothing was bracketed', () => {
    expect(pairMarks([], 9000)).toEqual([]);
  });

  it('handles a single press as one open segment', () => {
    expect(pairMarks([500], 4000)).toEqual([{ index: 1, start: 500, end: 4000, open: true }]);
  });
});

describe('framesInSegment', () => {
  const frames = framesAt(50, 100); // 5 s at 20 fps
  const segment = { start: 2000, end: 2400 };

  it('keeps every frame between the two presses, plus the pad', () => {
    const { frames: picked, total, subsampled } = framesInSegment(frames, segment, {
      pad: 200,
      count: 0
    });
    expect(picked[0].t).toBe(1800);
    expect(picked.at(-1).t).toBe(2600);
    expect(total).toBe(17);
    expect(subsampled).toBe(false);
  });

  it('subsamples a long segment and says so', () => {
    const { frames: picked, total, subsampled } = framesInSegment(
      frames,
      { start: 0, end: 5000 },
      { pad: 0, count: 16 }
    );
    expect(picked).toHaveLength(16);
    expect(total).toBe(100);
    expect(subsampled).toBe(true);
  });

  it('does not report subsampling when the segment already fits', () => {
    const { subsampled, total } = framesInSegment(frames, segment, { pad: 0, count: 16 });
    expect(total).toBe(9);
    expect(subsampled).toBe(false);
  });

  it('clips the pad at the start of the recording', () => {
    const { frames: picked } = framesInSegment(frames, { start: 100, end: 200 }, {
      pad: 1000,
      count: 0
    });
    expect(picked[0].t).toBe(0);
  });

  it('is empty when the segment sits outside the captured frames', () => {
    const { frames: picked, total } = framesInSegment(frames, { start: 60_000, end: 61_000 }, {
      pad: 100,
      count: 12
    });
    expect(picked).toEqual([]);
    expect(total).toBe(0);
  });
});

describe('sheetLayout', () => {
  it('is square-ish up to the column cap', () => {
    expect(sheetLayout(1)).toEqual({ cols: 1, rows: 1 });
    expect(sheetLayout(4)).toEqual({ cols: 2, rows: 2 });
    expect(sheetLayout(12)).toEqual({ cols: 4, rows: 3 });
  });

  it('caps at five columns so thumbnails stay readable', () => {
    expect(sheetLayout(64)).toEqual({ cols: 5, rows: 13 });
  });

  it('is empty for no thumbnails', () => {
    expect(sheetLayout(0)).toEqual({ cols: 0, rows: 0 });
  });
});

describe('contactSheetHtml', () => {
  const entries = [
    { src: 'frames/f0000_t000000ms.png', label: '0.00s' },
    { src: 'frames/f0001_t000050ms.png', label: '0.05s' }
  ];

  it('lays the grid out at the requested column count and width', () => {
    const html = contactSheetHtml(entries, { title: 'mark 1', cols: 2, thumbWidth: 440 });
    expect(html).toContain('grid-template-columns: repeat(2, 440px)');
    expect(html).toContain('src="frames/f0000_t000000ms.png"');
    expect(html).toContain('<figcaption>0.05s</figcaption>');
  });

  it('escapes the title and labels', () => {
    const html = contactSheetHtml([{ src: 'a.png', label: '<b>&"' }], {
      title: '<script>',
      cols: 1,
      thumbWidth: 100
    });
    expect(html).toContain('<title>&lt;script&gt;</title>');
    expect(html).toContain('&lt;b&gt;&amp;&quot;');
    expect(html).not.toContain('<script>');
  });
});

describe('escapeHtml', () => {
  it('covers the four characters that break markup', () => {
    expect(escapeHtml('<a href="x">&</a>')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
  });
});

describe('slugTimestamp', () => {
  it('stamps local time in a filename-safe order', () => {
    expect(slugTimestamp(new Date(2026, 7, 3, 14, 22, 9))).toBe('2026-08-03-14-22-09');
  });
});

describe('formatElapsed', () => {
  it('reads in seconds to two places', () => {
    expect(formatElapsed(4520)).toBe('4.52s');
    expect(formatElapsed(0)).toBe('0.00s');
  });
});

describe('parseArgs', () => {
  const defaults = { url: '', fps: 20, video: true, name: '' };

  it('returns the defaults when given nothing', () => {
    expect(parseArgs([], defaults)).toEqual(defaults);
  });

  it('accepts separated and joined values', () => {
    expect(parseArgs(['--fps', '10'], defaults).fps).toBe(10);
    expect(parseArgs(['--fps=10'], defaults).fps).toBe(10);
  });

  it('treats a bare boolean flag as true and --no-x as false', () => {
    expect(parseArgs(['--video'], { ...defaults, video: false }).video).toBe(true);
    expect(parseArgs(['--no-video'], defaults).video).toBe(false);
    expect(parseArgs(['--video=false'], defaults).video).toBe(false);
  });

  it('camel-cases hyphenated names', () => {
    expect(parseArgs(['--max-frames', '5'], { maxFrames: 1 }).maxFrames).toBe(5);
  });

  it('rejects unknown options, missing values and bad numbers', () => {
    expect(() => parseArgs(['--nope'], defaults)).toThrow(/unknown option/);
    expect(() => parseArgs(['--fps'], defaults)).toThrow(/needs a value/);
    expect(() => parseArgs(['--fps', 'fast'], defaults)).toThrow(/needs a number/);
    expect(() => parseArgs(['frames'], defaults)).toThrow(/unexpected argument/);
  });

  it('does not mutate the defaults object', () => {
    parseArgs(['--fps', '5'], defaults);
    expect(defaults.fps).toBe(20);
  });
});
