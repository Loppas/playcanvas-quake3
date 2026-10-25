# Menus on screen

How the menus lay out: the main tree in q3_ui's placement, the in-game menu in the port's centred
one. The rules read as CSS reads. Every item is a box: its text is the content, and its bar is the
padding box that lights. A page's panel is a container fitted round what it holds. They come from
four playtests of the main tree, and one of the server browser, with its probe.

**q3_ui gives the items, their order and their grouping; the port's box model gives their places.**
q3_ui's coordinates were drawn for line-art frames on a 4:3 screen, and a line can cross a word
where a solid panel can't. Keep q3_ui's items, their grouping, and where each stands relative to the
others. Move them wherever the rules below need it. Nearly every layout defect the playtests found
was a q3_ui coordinate kept over a solid panel:
- tiles over the ring's top;
- arrows across its foot;
- a confirm's warning running out of its ring.

**Centre text by its capitals, not by its line's box.** The engine boxes a line by its glyphs'
cells, which hold the face's ascent and descent. In Segoe UI that box's middle stands 1/16 em above
the capitals' middle, so every label sat low in its bar.
- **Measure** the capitals and the cell from the face at start, since the system face differs by
  machine. Then raise the glyphs by the difference (`render/menu-font.ts`). CSS has this as
  `text-box: trim-both cap alphabetic`.
- **Fit a box by its capitals too**, so a descender reaches into the bottom margin rather than
  widening it.

**Padding is one value, the same on all four sides.** A bar keeps the same margin round its text
across as up and down.
- **Fit the bar to its text** (`width: fit-content`), rather than giving it a fixed width with the
  text centred. A 256-wide bar left 70–113 across against 8 up and down, and read as off.
- **The margin follows the bar's height**: 8 round a button's 17-size text in its 28, and 3 round
  a row's 14 in its 16.

**Spacing comes from one scale, which both menus share.** These are the design tokens:
- a button is 17 in 28 everywhere (`BUTTON_SIZE`, `BUTTON_HEIGHT`), YES and NO included;
- a panel keeps 14 round what it holds (`PADDING`), in-game and in the main tree alike;
- a bar keeps 8 round a button's text, or 3 round a row's.

A new element takes the nearest of these, never a number of its own, so a size that exists once can
change once.
- **Neighbours keep a gap from the scale, bar to bar as drawn.** A bar fitted round its text can
  outgrow the place it was given: the server browser's arrows, placed 4 from its list, stood 2.7
  from it once fitted round their glyphs. They stand a button's margin clear of it, each bar from
  its art's left.
- **Buttons edge to edge, as tabs are, stand a button's height apart.** q3_ui's tabs stand 27
  apart, which bars 28 high would overlap.

**A container fits its content, and is centred as a whole.**
- **The panel** is the box round what stands in it, plus its padding (`display: inline-block;
  padding: 14px`).
- **Its place is its content's**, moved as one to the middle of the screen across, and down
  between the page's title and its bottom buttons (`margin: auto`).
- **Why**: a fixed frame over content at absolute places left gaps from 4 to 261 round it.
- **What sits outside**: the page's title and its bottom buttons stand outside the panel, where
  they always are, so they don't move from page to page.
- **q3_ui's 320 is not the screen's middle in a panel.** The panel is centred by its content's
  middle, so what q3_ui centres on 320 lands off the middle wherever the content isn't balanced
  about 320. The status line stands in the middle of what the panel holds, and a line q3_ui
  centres with it stands with it (`withStatus`): the server browser's count line stood 24 left
  of its status line.

**A page that opens over another is a popup, as a modal `<dialog>` is.** Its box stands over the
page it was opened from, which stays drawn under it, dimmed, its own work going on, and takes no
pointer. Escape, or the box's way out, goes back to it. Use one where what a page shows of its own
would otherwise crowd the page, as the server browser's Server Information box does.

**Nothing crosses its container's edge.** Everything a panel holds stands inside its padding box,
and anything it doesn't hold stands clear of it. When something moves, check what now touches an
edge. The Player and Model pages' 3D model counts as content: its box is measured where the models
draw, since the engine draws it outside the element tree.

**Reserve room for whatever comes and goes, so the layout never shifts.** A change of state must not
move or resize anything already on screen. As cumulative layout shift does on a web page, it reads
as a defect.
- **A value that spins** is as wide as its widest, as a `<select>` sizes to its widest option, so
  its bar holds still as it spins.
- **A value typed freely** keeps the room q3_ui gives its field, its `widthInChars` cells of 8
  and one for the cursor, however much of it the text fills, as an `<input>` keeps its `size`.
  The text scrolls inside to keep the cursor shown, and the cursor draws over it. Fitted to its
  text instead, a field grows as it is typed into, and a long name runs past the screen's edge. A
  key's binding, which is chosen rather than typed, fits what it shows.
- **A value in a column**, as Server Options' slot names are, keeps the room of q3_ui's characters
  there and is cut to it, as a list's cells are. A face wider than q3_ui's carried a long name into
  the side's column.
- **A line that appears on hover**, the status line, keeps its room shown or not. The room is as
  wide as the widest the page gives.
- **A tabbed page's panel** fits every tab's content together, as tab panels stacked in one grid
  cell size to the largest. Switching tabs moves and resizes nothing.
- **A page's place is fixed at its first frame**, so what is already on screen stays put.
- **A screen another takes over shares its shape.** The connect screen stands in the load
  screen's panel, the title's line and the bar's room kept empty, so the map's load fills them in
  and nothing moves, as Q3 draws its connect lines over the load.
- **Focus draws behind, never around**: the lit bar takes no room, like `outline` rather than
  `border`, and neither does a field's cursor.

**Focus goes where the action went.** A page opened from a tab starts with its cursor on that tab,
as q3_ui's `Menu_SetCursorToItem` puts it. A page that opens with focus elsewhere lights the wrong
item until the pointer next moves. Like a roving tabindex, the chosen tab keeps focus across
the switch.

**A report is one instance of a class, so sweep every page.** Each playtest named one page, and the
same defect stood on others.
- **Measure the whole tree before designing the fix**:
  - each bar's gap to its text on all four sides;
  - each panel's gap to its content;
  - everything that crosses an edge.
- **How**: `npm run probe:layout`, which visits every page at 16:9 and 4:3, reads each element's
  `screenCorners` and finds the text's ink in a screenshot ([debugging.md](debugging.md)).
- **Numbers settle what a screenshot argues**, and the same probe, run again after the fix, is the
  accept.

**Tests pin boxes, not pixels.** A layout rule is tested on the null device, with a font of square
glyphs whose widths and capitals are known. A fitted bar's and a panel's edges then come out as
exact numbers (`menu-screen.test.ts`). jsdom has no face to draw, so the real face's metrics are
checked live. Square glyphs also run wider than any face's, so a wide page's width across is the
probe's to measure, and the tests pin its places and heights.
