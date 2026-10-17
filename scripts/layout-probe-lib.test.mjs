import { describe, expect, it } from 'vitest';

import {
  checkView,
  connectMoves,
  crosses,
  findings,
  gaps,
  inkMargins,
  inkSearch,
  inside,
  overlaps,
  report,
  shifts,
  union
} from './layout-probe-lib.mjs';

/**
 * A view as `measurePage` gives one: a q3_ui page on a 1280×720 screen, its panel from (100,100)
 * to (300,300), and a button 8 round its text.
 */
function viewOf(shown, extra = {}) {
  return {
    page: 'setup',
    placement: 'q3ui',
    popup: false,
    viewport: [1280, 720],
    unit: 1.5,
    left: 160,
    screen: [-106.7, 0, 746.7, 480],
    cursor: 0,
    frame: [100, 100, 300, 300],
    items: [{ label: 'PLAYER', role: null, list: false, cell: false }],
    shown: [
      { name: 'menu-item-0', isText: false, box: [114, 114, 186, 142] },
      { name: 'menu-item-0-text', text: 'PLAYER', isText: true, box: [122, 122, 178, 134] },
      ...shown
    ],
    ...extra
  };
}

/** A text the view shows, by its name, what it reads and its box. */
const text = (name, read, box) => ({ name, text: read, isText: true, box });

describe('the boxes', () => {
  it('measures one inside another, side by side, and the box round several', () => {
    expect(gaps([0, 0, 100, 50], [8, 8, 90, 42])).toEqual([8, 8, 10, 8]);
    expect(
      union([
        [0, 5, 10, 20],
        [5, 0, 30, 10]
      ])
    ).toEqual([0, 0, 30, 20]);
    expect(union([])).toBeNull();
  });

  it('lets two boxes meet, or pass by half a unit, without overlapping or crossing', () => {
    expect(overlaps([0, 0, 10, 10], [10, 0, 20, 10])).toBe(false);
    expect(overlaps([0, 0, 10.4, 10], [10, 0, 20, 10])).toBe(false);
    expect(overlaps([0, 0, 11, 10], [10, 0, 20, 10])).toBe(true);
    expect(crosses([90, 10, 110, 20], [0, 0, 100, 100])).toBe(true);
    expect(crosses([90, 10, 100.4, 20], [0, 0, 100, 100])).toBe(false);
    expect(inside([0, 0, 100.4, 50], [0, 0, 100, 100])).toBe(true);
    expect(inside([0, 0, 101, 50], [0, 0, 100, 100])).toBe(false);
  });
});

describe('checkView', () => {
  it("measures a panel's padding and a bar's margin round what each holds", () => {
    const check = checkView(viewOf([]));
    expect(check.padding).toEqual([14, 14, 114, 158]);
    expect(check.margins).toEqual({ '0 PLAYER': [8, 8, 8, 8] });
    expect(findings(viewOf([]), check)).toEqual([]);
  });

  it('leaves the titles out of the padding: the banner, a page\'s and a popup\'s', () => {
    for (const name of ['menu-banner', 'menu-title', 'menu-popup-title']) {
      const titled = viewOf([text(name, 'SETUP', [101, 101, 299, 110])]);
      expect(checkView(titled).padding).toEqual([14, 14, 114, 158]);
    }
  });

  it("fits a bar round its pictures but not a field's cursor or a list's lines", () => {
    const view = viewOf([
      { name: 'menu-item-0-caret', isText: false, box: [180, 110, 181, 146] },
      { name: 'menu-item-0-icon', isText: false, box: [178, 122, 186, 134] }
    ]);
    expect(checkView(view).margins['0 PLAYER']).toEqual([8, 8, 0, 8]);
  });

  it('finds what crosses the panel or the screen, overlapping bars, and cells run together', () => {
    const view = viewOf(
      [
        { name: 'menu-item-1', isText: false, box: [180, 130, 320, 158] },
        text('menu-status', 'far', [700, 400, 760, 410]),
        text('menu-item-2-line-0-cell-0', 'LONG HOST', [110, 200, 180, 210]),
        text('menu-item-2-line-0-cell-1', 'q3dm1', [170, 200, 200, 210]),
        // The board crosses the panel's edge as it likes; its own place is checked apart.
        text('scoreboard-name', 'Sarge', [290, 150, 310, 160])
      ],
      {
        items: [
          { label: 'PLAYER', role: null, list: false, cell: false },
          { label: 'NEXT', role: 'forward', list: false, cell: false },
          { label: '', role: null, list: true, cell: false }
        ]
      }
    );
    const check = checkView(view);
    expect(check.crossings).toEqual(['menu-item-1 [180,130,320,158]']);
    expect(check.offscreen).toEqual(['menu-status "far" [700,400,760,410]']);
    expect(check.barsOverlapping).toEqual([
      '0 PLAYER [114,114,186,142] and 1 NEXT [180,130,320,158]'
    ]);
    expect(check.cellsRunTogether).toEqual([
      'menu-item-2-line-0: menu-item-2-line-0-cell-0 "LONG HOST" into ' +
        'menu-item-2-line-0-cell-1 "q3dm1"'
    ]);
    expect(check.buttonsOverPanel).toEqual(['NEXT [180,130,320,158]']);
    // A popup's own buttons stand in its box.
    expect(checkView({ ...view, popup: true }).buttonsOverPanel).toEqual([]);
  });

  it('lets cells meet, end to start', () => {
    const view = viewOf([
      text('menu-item-2-line-0-cell-0', 'HOST', [110, 200, 170, 210]),
      text('menu-item-2-line-0-cell-1', 'q3dm1', [170, 200, 200, 210])
    ]);
    expect(checkView(view).cellsRunTogether).toEqual([]);
  });

  it('checks the board: in the panel, clear of the list and the table, its texts in it', () => {
    const board = { name: 'scoreboard-panel', isText: false, box: [120, 200, 280, 290] };
    const clear = checkView(viewOf([board, text('scoreboard-score', '20', [130, 210, 140, 220])]));
    expect(clear.board).toEqual({
      box: [120, 200, 280, 290],
      insidePanel: true,
      overList: false,
      overTable: [],
      textsOutside: []
    });
    const out = checkView(
      viewOf([
        { ...board, box: [120, 200, 280, 320] },
        text('menu-table-value-0', 'Arena', [130, 205, 200, 215]),
        text('scoreboard-name', 'Sarge', [130, 322, 200, 330])
      ])
    );
    expect(findings(viewOf([]), out)).toEqual([
      'board outside the panel: [120,200,280,320]',
      'board over the table: menu-table-value-0 "Arena"',
      'board\'s text outside it: scoreboard-name "Sarge" [130,322,200,330]'
    ]);
  });
});

describe('findings', () => {
  const uneven = viewOf([], {
    shown: [
      { name: 'menu-item-0', isText: false, box: [114, 114, 186, 142] },
      text('menu-item-0-text', 'PLAYER', [122, 124, 178, 136])
    ]
  });

  /** A view whose one bar stands `margin` round its text, each side. */
  const margined = ([left, top, right, bottom]) =>
    viewOf([], {
      shown: [
        { name: 'menu-item-0', isText: false, box: [114, 114, 186, 142] },
        text('menu-item-0-text', 'PLAYER', [114 + left, 114 + top, 186 - right, 142 - bottom])
      ]
    });

  it('names a bar whose margin is uneven, but not the room a value keeps on its right', () => {
    expect(findings(uneven, checkView(uneven))).toEqual(['margin [8,10,8,6] round 0 PLAYER']);
    // Uneven down alone, and short on its right alone.
    for (const margin of [[8, 8, 8, 6], [8, 8, 4, 8]]) {
      const view = margined(margin);
      const named = `margin ${JSON.stringify(margin)} round 0 PLAYER`;
      expect(findings(view, checkView(view))).toEqual([named]);
    }
    const roomy = viewOf([], {
      shown: [
        { name: 'menu-item-0', isText: false, box: [114, 114, 250, 142] },
        text('menu-item-0-text', 'PLAYER', [122, 122, 178, 134])
      ]
    });
    expect(findings(roomy, checkView(roomy))).toEqual([]);
  });

  it("leaves a centred page's bars, a list and a grid's cells unfitted", () => {
    const centred = { ...uneven, placement: 'centred' };
    expect(findings(centred, checkView(centred))).toEqual([]);
    const listed = { ...uneven, items: [{ label: 'PLAYER', role: null, list: true, cell: false }] };
    expect(findings(listed, checkView(listed))).toEqual([]);
  });

  it('names a panel tighter than its padding, by a little or a lot', () => {
    const tight = viewOf([], { frame: [110, 110, 300, 300] });
    expect(findings(tight, checkView(tight))).toContain("padding 4 on the panel's left, under 14");
    const close = viewOf([], { frame: [102, 100, 300, 300] });
    expect(findings(close, checkView(close))).toEqual(["padding 12 on the panel's left, under 14"]);
  });

  it('names text in capitals whose ink stands off its bar\'s middle, and no other text', () => {
    const view = viewOf([]);
    const low = { '0 PLAYER': [8, 9.5, 8, 6.5] };
    expect(findings(view, checkView(view), low)).toEqual([
      'ink [8,9.5,8,6.5] off the middle of 0 PLAYER'
    ]);
    // A label in lower case, or a glyph in a label's place, needn't fill its capitals' box.
    for (const shows of ['Player', '>']) {
      const other = viewOf([], {
        shown: [
          { name: 'menu-item-0', isText: false, box: [114, 114, 186, 142] },
          text('menu-item-0-text', shows, [122, 122, 178, 134])
        ]
      });
      expect(findings(other, checkView(other), low)).toEqual([]);
    }
  });
});

describe('the ink', () => {
  it("measures a bar's margin round its texts' ink, from pixels", () => {
    const view = viewOf([]);
    // The text's ink in pixels: (123,123) to (177,133) in units, at 1.5 a unit from 160 across.
    const ink = { x0: 160 + 123 * 1.5, y0: 123 * 1.5, x1: 160 + 177 * 1.5, y1: 133 * 1.5 };
    expect(inkMargins(view, [ink])).toEqual({ '0 PLAYER': [9, 9, 9, 9] });
    expect(inkMargins(view, [null])).toEqual({});
  });

  it("looks for a text's ink down from over its capitals to under its descenders", () => {
    const search = inkSearch({ box: [122, 122, 178, 129], px: { x0: 343, x1: 427 } }, 1.5);
    expect([search.x0, search.x1]).toEqual([343, 427]);
    // Capitals 7 high, of a face about 10: 1.5 over them, and 3 under.
    expect(search.y0).toBeCloseTo((122 - 1.5) * 1.5);
    expect(search.y1).toBeCloseTo((129 + 3) * 1.5);
  });
});

describe('shifts', () => {
  it("names what moved or resized between views, not a field's cursor or a changed text", () => {
    const from = {
      'menu-item-0': [0, 0, 10, 10],
      'menu-item-0-caret': [5, 0, 6, 10],
      'menu-item-1-text|a': [0, 20, 5, 25]
    };
    const to = {
      'menu-item-0': [0, 0, 12, 10],
      'menu-item-0-caret': [8, 0, 9, 10],
      'menu-item-1-text|ab': [0, 20, 9, 25]
    };
    expect(shifts(from, to)).toEqual(['menu-item-0: [0,0,10,10] -> [0,0,12,10]']);
    expect(shifts(from, { ...from, 'menu-item-0': [0.4, 0, 10.4, 10] })).toEqual([]);
  });

  it("names a connect screen's panel or part that moved or resized as the map loaded", () => {
    const part = (name, box) => ({ name, box });
    const title = part('load-title', [400, 330, 448, 23]);
    const info = part('load-info', [400, 381, 448, 44]);
    const samples = [
      { panel: [400, 330, 448, 51], parts: [title, info] },
      { panel: [400, 330, 448, 51], parts: [title, info] },
      {
        panel: [400, 304, 448, 112],
        parts: [part('load-title', [400, 304, 448, 23]), part('load-bar', [0, 0, 1, 1]), info]
      }
    ];
    expect(connectMoves(samples)).toEqual([
      'panel [400,330,448,51] -> [400,304,448,112]',
      'load-title [400,330,448,23] -> [400,304,448,23]'
    ]);
    expect(connectMoves(samples.slice(0, 2))).toEqual([]);
    // The last part grows at its foot as its lines come, and moves nothing; any other that grows
    // pushes what follows it.
    const grown = { ...samples[1], parts: [title, part('load-info', [400, 381, 448, 138])] };
    expect(connectMoves([samples[1], grown])).toEqual([]);
    const taller = { ...samples[1], parts: [part('load-title', [400, 330, 448, 46]), info] };
    expect(connectMoves([samples[1], taller])).toEqual([
      'load-title [400,330,448,23] -> [400,330,448,46]'
    ]);
    const moved = { ...samples[1], parts: [title, part('load-info', [400, 390, 448, 44])] };
    expect(connectMoves([samples[1], moved])).toEqual([
      'load-info [400,381,448,44] -> [400,390,448,44]'
    ]);
  });
});

describe('report', () => {
  const view = (name, found) => ({ name, viewport: [1280, 720], page: name, findings: found });
  const none = { out: 'out', shifts: [], connect: [], skipped: [], problems: [], error: null };

  it('says nothing was found on a clean run', () => {
    const clean = report({ ...none, views: [view('main', [])] });
    expect(clean).toBe('Layout probe, 1 views, written to out\n\nNothing found.');
  });

  it("lists each view's findings, what moved, what wasn't reached, and counts them", () => {
    const text = report({
      ...none,
      views: [view('setup', ['bars overlap: a and b'])],
      shifts: [{ from: 'a', to: 'b', moved: ['menu-item-0: [0,0,1,1] -> [0,0,2,1]'] }],
      skipped: ['debug: "DEBUG" missing']
    });
    expect(text.split('\n')).toEqual([
      'Layout probe, 1 views, written to out',
      '',
      'setup (1280x720, setup):',
      '  bars overlap: a and b',
      'moved from a to b:',
      '  menu-item-0: [0,0,1,1] -> [0,0,2,1]',
      'not reached: debug: "DEBUG" missing',
      '',
      '2 found.'
    ]);
  });
});
