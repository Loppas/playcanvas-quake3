/**
 * The layout probe's measuring and its rules (`npm run probe:layout`; `.claude/conventions/
 * menus.md`). Two functions run in the page, and are self-contained for `page.evaluate`: one reads
 * every element the menu shows, the other finds each text's ink in a screenshot. The rest runs here
 * and is tested: what each view breaks of menus.md's rules, what moved between two views, and the
 * report.
 *
 * Every box is in q3 units, `[left, top, right, bottom]` on the 640×480 screen from its top left,
 * and a text's box runs up and down its capitals, as the menu fits a bar to them.
 */

/** How far apart two edges may be and still meet, in q3 units. */
export const TOLERANCE = 0.5;

/** A panel's padding round what it holds (`PADDING`). */
export const PADDING = 14;

/** A bar's name: a page's item, or a popup's. */
const BAR = /^menu-(popup-)?item-\d+$/;

/**
 * A bar's parts that are not what it is fitted round: a field's cursor, a list's lines, a picture's
 * strip, a slider's bed.
 */
const NOT_FITTED = /-(caret|line-\d+.*|strip|track|thumb|pick)$/;

/** Texts outside every panel: the banner, a page's title and a popup's. */
const TITLES = new Set(['menu-banner', 'menu-title', 'menu-popup-title']);

/**
 * In the page: the menu as it is drawn this frame. Every element it shows, with its box in q3
 * units and, for a text, its whole box in the canvas's pixels for the ink; the panel's box (the
 * popup's while one is up); and the page's items. Under a popup, the popup alone: the page under
 * it is dimmed, and measured on its own view.
 */
export function measurePage() {
  const app = window.pcq.app;
  const { menu } = window.pcqMenu;
  const root = app.root;
  const canvas = app.graphicsDevice.canvas;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  const unit = h / 480;
  const left = (w - 640 * unit) / 2;
  const round = (v) => Math.round(v * 10) / 10;
  const units = (r) =>
    [(r.x0 - left) / unit, r.y0 / unit, (r.x1 - left) / unit, r.y1 / unit].map(round);
  const px = (e) => {
    const corners = e.element.screenCorners;
    const xs = corners.map((v) => v.x);
    const ys = corners.map((v) => h - v.y);
    return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
  };
  const capitals = root.findByName('menu-item-0-text')?.element?.font?.capitals ?? 0.7;
  const q3ui = Boolean(root.findByName('menu-box')?.enabled);
  const popup = root.findByName('menu-popup');
  const popped = Boolean(popup?.enabled);
  const container = popped
    ? root.findByName('menu-popup-panel')
    : root.findByName(q3ui ? 'menu-frame' : 'menu-panel');
  const whole = new Set([
    'menu-box',
    'menu-content',
    'menu-backdrop',
    'menu-popup',
    'menu-popup-box'
  ]);

  const shown = [];
  const walk = (e, prefix) => {
    if (!e.enabled) return;
    const el = e.element;
    if (el && e.name.startsWith(prefix) && e !== container && !whole.has(e.name)) {
      const isText = el.type === 'text';
      // A bar is shown whether lit or not; the board's panel in a box draws nothing, but is the
      // box its rows stand in.
      const bar = /^menu-(popup-)?item-\d+$/.test(e.name);
      const visible = isText
        ? el.text !== ''
        : bar || el.opacity > 0 || e.name === 'scoreboard-panel';
      if (visible) {
        const full = px(e);
        let r = full;
        if (isText) {
          const middle = (r.y0 + r.y1) / 2;
          const half = (capitals * el.fontSize * unit) / 2;
          r = { ...r, y0: middle - half, y1: middle + half };
        }
        const text = isText ? el.text : undefined;
        shown.push({ name: e.name, text, isText, box: units(r), px: full });
      }
    }
    for (const child of e.children) walk(child, prefix);
  };
  walk(popped ? popup : root.findByName('menu'), 'menu');
  const board = root.findByName('scoreboard');
  if (board?.enabled) walk(board, 'scoreboard');

  const page = menu.page;
  return {
    page: page?.id ?? page?.title ?? null,
    placement: q3ui ? 'q3ui' : 'centred',
    popup: popped,
    viewport: [w, h],
    unit,
    left,
    screen: units({ x0: 0, y0: 0, x1: w, y1: h }),
    cursor: menu.cursor,
    frame: container?.enabled ? units(px(container)) : null,
    items: (page?.items ?? []).map((item) => ({
      label: item.label,
      role: item.role ?? null,
      list: Boolean(item.list),
      cell: Boolean(item.cell)
    })),
    shown
  };
}

/**
 * In the page: each box's ink in a screenshot, in pixels, or null where it has none. The ink is
 * what differs from the colour round the box: its border's middle colour, a pixel outside it.
 *
 * @param args - The screenshot as base64 PNG, and the boxes, each `{ x0, y0, x1, y1 }` in pixels.
 */
export async function inkInPage([png, boxes]) {
  const blob = await (await fetch(`data:image/png;base64,${png}`)).blob();
  const image = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(image.width, image.height);
  const g = canvas.getContext('2d');
  g.drawImage(image, 0, 0);
  const data = g.getImageData(0, 0, image.width, image.height).data;
  const at = (x, y) => {
    const i = (y * image.width + x) * 4;
    return [data[i], data[i + 1], data[i + 2]];
  };
  return boxes.map((r) => {
    const x0 = Math.max(0, Math.floor(r.x0) - 1);
    const y0 = Math.max(0, Math.floor(r.y0) - 1);
    const x1 = Math.min(image.width - 1, Math.ceil(r.x1) + 1);
    const y1 = Math.min(image.height - 1, Math.ceil(r.y1) + 1);
    const ring = [];
    for (let x = x0; x <= x1; x++) ring.push(at(x, y0), at(x, y1));
    for (let y = y0; y <= y1; y++) ring.push(at(x0, y), at(x1, y));
    const middle = [0, 1, 2].map(
      (c) => ring.map((p) => p[c]).sort((a, b) => a - b)[ring.length >> 1]
    );
    let ink = null;
    for (let y = y0 + 1; y < y1; y++) {
      for (let x = x0 + 1; x < x1; x++) {
        const p = at(x, y);
        if (Math.max(...p.map((v, c) => Math.abs(v - middle[c]))) < 48) continue;
        ink ??= { x0: x, y0: y, x1: x + 1, y1: y + 1 };
        ink.x0 = Math.min(ink.x0, x);
        ink.y0 = Math.min(ink.y0, y);
        ink.x1 = Math.max(ink.x1, x + 1);
        ink.y1 = Math.max(ink.y1, y + 1);
      }
    }
    return ink;
  });
}

/**
 * Where to look for a text's ink, in pixels: across its own box, and down from a little over its
 * capitals to under its descenders, so a row 16 under the last doesn't lend it the last's.
 */
export function inkSearch(text, unit) {
  const [, top, , bottom] = text.box;
  const size = (bottom - top) / 0.7;
  return {
    x0: text.px.x0,
    x1: text.px.x1,
    y0: (top - 0.15 * size) * unit,
    y1: (bottom + 0.3 * size) * unit
  };
}

/** A box's edges in q3 units, from one in pixels. */
export function toUnits(r, { unit, left }) {
  const round = (v) => Math.round(v * 10) / 10;
  return [(r.x0 - left) / unit, r.y0 / unit, (r.x1 - left) / unit, r.y1 / unit].map(round);
}

/** The box round several, or null for none. */
export function union(boxes) {
  if (boxes.length === 0) return null;
  return [
    Math.min(...boxes.map((b) => b[0])),
    Math.min(...boxes.map((b) => b[1])),
    Math.max(...boxes.map((b) => b[2])),
    Math.max(...boxes.map((b) => b[3]))
  ];
}

/** How far `inner` stands inside `outer` on each side: left, top, right, bottom. */
export function gaps(outer, inner) {
  const round = (v) => Math.round(v * 10) / 10;
  const [left, top] = [inner[0] - outer[0], inner[1] - outer[1]];
  return [left, top, outer[2] - inner[2], outer[3] - inner[3]].map(round);
}

/** Whether two boxes share more than an edge. */
export function overlaps(a, b) {
  const t = TOLERANCE;
  return a[2] > b[0] + t && a[0] < b[2] - t && a[3] > b[1] + t && a[1] < b[3] - t;
}

/** Whether a box runs across one of a frame's edges. */
export function crosses(box, frame) {
  const t = TOLERANCE;
  const across = (lo, hi, edge) => lo < edge - t && hi > edge + t;
  return (
    across(box[0], box[2], frame[0]) ||
    across(box[0], box[2], frame[2]) ||
    across(box[1], box[3], frame[1]) ||
    across(box[1], box[3], frame[3])
  );
}

/** Whether a box stands within another. */
export function inside(box, frame) {
  const t = TOLERANCE;
  const across = box[0] >= frame[0] - t && box[2] <= frame[2] + t;
  return across && box[1] >= frame[1] - t && box[3] <= frame[3] + t;
}

/** An element as a report names it: its name, and what it reads. */
const named = (s) => (s.text !== undefined ? `${s.name} ${JSON.stringify(s.text)}` : s.name);

/**
 * Each bar of a view, with what it is fitted round: its texts, pictures and colours, but not a
 * field's cursor, a list's lines or a picture's strip.
 */
export function barsOf(view) {
  return view.shown
    .filter((s) => BAR.test(s.name))
    .map((bar) => {
      const index = Number(/(\d+)$/.exec(bar.name)[1]);
      const item = view.items[index] ?? { label: '?', role: null, list: false, cell: false };
      const parts = view.shown.filter(
        (s) => s.name.startsWith(`${bar.name}-`) && !NOT_FITTED.test(s.name)
      );
      return { key: `${index} ${item.label}`, bar, item, parts };
    });
}

/**
 * What a view measures against menus.md's rules.
 * - `padding`: the panel's padding round what it holds, each side.
 * - `margins`: each bar's margin round what it is fitted to, each side, by the elements' boxes.
 * - `crossings`, `offscreen`, `barsOverlapping`, `cellsRunTogether`, `buttonsOverPanel`: what
 *   crosses the panel's edge, goes off the screen, overlaps another bar, runs into the next cell of
 *   a list's line, or, of the corner buttons, stands over a q3_ui page's panel.
 * - `board`: the scoreboard's place, where one is drawn.
 */
export function checkView(view) {
  const { frame, shown } = view;
  const out = {
    padding: null,
    margins: {},
    crossings: [],
    offscreen: [],
    barsOverlapping: [],
    cellsRunTogether: [],
    buttonsOverPanel: [],
    board: null
  };
  for (const s of shown) {
    if (!inside(s.box, view.screen)) out.offscreen.push(`${named(s)} ${JSON.stringify(s.box)}`);
    const board = s.name.startsWith('scoreboard');
    if (frame && !board && overlaps(s.box, frame) && crosses(s.box, frame)) {
      out.crossings.push(`${named(s)} ${JSON.stringify(s.box)}`);
    }
  }
  if (frame) {
    const held = shown.filter((s) => inside(s.box, frame) && !TITLES.has(s.name));
    const content = union(held.map((s) => s.box));
    if (content) out.padding = gaps(frame, content);
  }
  const bars = barsOf(view);
  for (const { key, bar, parts } of bars) {
    const content = union(parts.map((s) => s.box));
    if (content) out.margins[key] = gaps(bar.box, content);
  }
  if (frame && view.placement === 'q3ui' && !view.popup) {
    for (const { bar, item } of bars) {
      if ((item.role === 'back' || item.role === 'forward') && overlaps(bar.box, frame)) {
        out.buttonsOverPanel.push(`${item.label} ${JSON.stringify(bar.box)}`);
      }
    }
  }
  for (let i = 0; i < bars.length; i++) {
    for (let j = i + 1; j < bars.length; j++) {
      if (overlaps(bars[i].bar.box, bars[j].bar.box)) {
        const [a, b] = [bars[i], bars[j]];
        const at = (each) => `${each.key} ${JSON.stringify(each.bar.box)}`;
        out.barsOverlapping.push(`${at(a)} and ${at(b)}`);
      }
    }
  }
  const lines = new Map();
  for (const s of shown) {
    const m = /^(menu-item-\d+-line-\d+)-cell-\d+$/.exec(s.name);
    if (!m || !s.isText) continue;
    if (!lines.has(m[1])) lines.set(m[1], []);
    lines.get(m[1]).push(s);
  }
  for (const [line, cells] of lines) {
    cells.sort((a, b) => a.box[0] - b.box[0]);
    for (let i = 1; i < cells.length; i++) {
      if (cells[i - 1].box[2] > cells[i].box[0] + TOLERANCE) {
        out.cellsRunTogether.push(`${line}: ${named(cells[i - 1])} into ${named(cells[i])}`);
      }
    }
  }
  const boardPanel = shown.find((s) => s.name === 'scoreboard-panel');
  if (boardPanel) {
    const list = bars.find(({ item }) => item.list);
    const table = shown.filter((s) => s.name.startsWith('menu-table-') && s.isText);
    out.board = {
      box: boardPanel.box,
      insidePanel: frame ? inside(boardPanel.box, frame) : null,
      overList: list ? overlaps(boardPanel.box, list.bar.box) : false,
      overTable: table.filter((s) => overlaps(s.box, boardPanel.box)).map(named),
      textsOutside: shown
        .filter((s) => s.name.startsWith('scoreboard-') && s.isText)
        .filter((s) => !inside(s.box, boardPanel.box))
        .map((s) => `${named(s)} ${JSON.stringify(s.box)}`)
    };
  }
  return out;
}

/**
 * Each bar's margin round the ink of its texts, each side, from their ink in pixels, named as
 * `checkView`'s margins are.
 *
 * @param inks - Each text's ink in pixels, or null, in the order the view shows its texts.
 */
export function inkMargins(view, inks) {
  const texts = view.shown.filter((s) => s.isText);
  const inkOf = new Map(texts.map((s, i) => [s.name, inks[i]]));
  const out = {};
  for (const { key, bar, parts } of barsOf(view)) {
    const found = parts.map((s) => inkOf.get(s.name)).filter(Boolean);
    if (found.length === 0) continue;
    out[key] = gaps(bar.box, union(found.map((r) => toUnits(r, view))));
  }
  return out;
}

/**
 * What a view breaks, a line each. A fitted bar keeps one margin round its capitals but on its
 * right, where a value's or a label's room may be kept; a panel keeps at least its padding; a
 * label in capitals has its ink in the middle of its bar. A list and a grid's cells are not fitted,
 * and neither is a centred page's bar.
 */
export function findings(view, check, inks = {}) {
  const out = [
    ...check.crossings.map((s) => `crosses the panel: ${s}`),
    ...check.offscreen.map((s) => `off the screen: ${s}`),
    ...check.barsOverlapping.map((s) => `bars overlap: ${s}`),
    ...check.cellsRunTogether.map((s) => `cells run together: ${s}`),
    ...check.buttonsOverPanel.map((s) => `corner button over the panel: ${s}`)
  ];
  if (check.padding) {
    const sides = ['left', 'top', 'right', 'bottom'];
    check.padding.forEach((gap, i) => {
      if (gap < PADDING - 2 * TOLERANCE) {
        out.push(`padding ${gap} on the panel's ${sides[i]}, under ${PADDING}`);
      }
    });
  }
  if (view.placement === 'q3ui') {
    for (const { key, bar, item, parts } of barsOf(view)) {
      const margin = check.margins[key];
      if (!margin || item.list || item.cell) continue;
      const [left, top, right, bottom] = margin;
      const near = (a, b) => Math.abs(a - b) <= 2 * TOLERANCE;
      if (!near(top, bottom) || !near(left, top) || right < top - 2 * TOLERANCE) {
        out.push(`margin ${JSON.stringify(margin)} round ${key}`);
      }
      // Capitals alone fill their box from top to foot; a glyph in a label's place needn't.
      const shows = parts.find((s) => s.name === `${bar.name}-text`)?.text ?? '';
      const ink = inks[key];
      if (ink && /^[A-Z0-9 ]{2,}$/.test(shows) && Math.abs(ink[1] - ink[3]) > 1.2) {
        out.push(`ink ${JSON.stringify(ink)} off the middle of ${key}`);
      }
    }
  }
  const { board } = check;
  if (board) {
    if (board.insidePanel === false) {
      out.push(`board outside the panel: ${JSON.stringify(board.box)}`);
    }
    if (board.overList) out.push('board over the list');
    for (const s of board.overTable) out.push(`board over the table: ${s}`);
    for (const s of board.textsOutside) out.push(`board's text outside it: ${s}`);
  }
  return out;
}

/** Every element's box by its name and what it reads, for comparing views. */
export function boxesOf(view) {
  const key = (s) => (s.text !== undefined ? `${s.name}|${s.text}` : s.name);
  return Object.fromEntries(view.shown.map((s) => [key(s), s.box]));
}

/**
 * What moved or resized between two views: every element shown in both, a text only where it
 * reads the same. A field's cursor moves as it is typed, so it is left out.
 */
export function shifts(from, to) {
  const moved = [];
  for (const [key, a] of Object.entries(from)) {
    const b = to[key];
    if (!b || key.endsWith('-caret')) continue;
    if (a.some((v, i) => Math.abs(v - b[i]) > TOLERANCE)) {
      moved.push(`${key}: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`);
    }
  }
  return moved;
}

/**
 * What changed of the connect screen's panel from one sample to the next: a part that moved or
 * resized while it was shown in both, by its class. The last part may grow at its foot, as lines
 * come under everything else, and moves nothing.
 *
 * @param samples - Each `{ panel, parts }`, `parts` each `{ name, box }` in CSS pixels, a box
 *   `[x, y, width, height]`.
 */
export function connectMoves(samples) {
  const moves = [];
  for (let i = 1; i < samples.length; i++) {
    const [a, b] = [samples[i - 1], samples[i]];
    if (!a.panel || !b.panel) continue;
    if (a.panel.some((v, n) => v !== b.panel[n])) {
      moves.push(`panel ${JSON.stringify(a.panel)} -> ${JSON.stringify(b.panel)}`);
    }
    b.parts.forEach((part, index) => {
      const before = a.parts.find((p) => p.name === part.name);
      const held = index === b.parts.length - 1 ? 3 : 4;
      if (before && before.box.slice(0, held).some((v, n) => v !== part.box[n])) {
        moves.push(`${part.name} ${JSON.stringify(before.box)} -> ${JSON.stringify(part.box)}`);
      }
    });
  }
  return moves;
}

/** The report: each view's findings, what moved between views, and the connect screen. */
export function report(result) {
  const lines = [];
  let count = 0;
  for (const view of result.views) {
    if (view.findings.length === 0) continue;
    lines.push(`${view.name} (${view.viewport.join('x')}, ${view.page}):`);
    for (const line of view.findings) lines.push(`  ${line}`);
    count += view.findings.length;
  }
  for (const { from, to, moved } of result.shifts) {
    if (moved.length === 0) continue;
    lines.push(`moved from ${from} to ${to}:`);
    for (const line of moved) lines.push(`  ${line}`);
    count += moved.length;
  }
  if (result.connect.length > 0) {
    lines.push('moved on the connect screen as the map loaded:');
    for (const line of result.connect) lines.push(`  ${line}`);
    count += result.connect.length;
  }
  for (const line of result.skipped) lines.push(`not reached: ${line}`);
  for (const line of result.problems) lines.push(`problem: ${line}`);
  if (result.error) lines.push(`the run stopped: ${result.error}`);
  const head = `Layout probe, ${result.views.length} views, written to ${result.out}`;
  const total = count === 0 ? 'Nothing found.' : `${count} found.`;
  return [head, ...(lines.length > 0 ? ['', ...lines] : []), '', total].join('\n');
}
