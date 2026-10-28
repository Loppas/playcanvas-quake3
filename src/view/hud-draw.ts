import {
  DEFER_SHADER,
  LAGOMETER_SHADER,
  MEDAL_SHADERS,
  NET_SHADER,
  NUMBER_NAMES,
  TEAM_STATUS_BAR_SHADER,
  WEAPON_ASSETS
} from '../formats/asset-manifest';
import { COLOR_TABLE } from '../formats/color-codes';
import { findItemForArmorTier, findItemForPowerup, ITEMS, type GItem } from '../sim/items';
import type { WeaponId } from '../sim/weapons/constants';
import {
  AMMO_ANCHOR,
  BAR_ANCHOR,
  type HoldableItem,
  type HudCrosshair,
  type HudField,
  type HudFrame,
  type HudSpeedometer,
  type HudText,
  type PickupItem,
  type StatusBar
} from './hud';
import type { HudDisconnect } from './hud-disconnect';
import { SCREEN_HEIGHT, SCREEN_WIDTH, type HudAnchor, type HudRect } from './hud-layout';
import type { HudScores } from './hud-scores';
import {
  AMMO_X,
  ARMOR_X,
  CHAR_HEIGHT,
  CHAR_WIDTH,
  STATUS_Y,
  iconRect,
  type Digit,
  type Rgba
} from './hud-status';
import {
  BIGCHAR_HEIGHT,
  BIGCHAR_WIDTH,
  CHARSET_CELLS,
  SHADOW_OFFSET,
  stringGlyphs,
  type Glyph
} from './hud-text';
import { lagometerBars, type HudLagometer } from './lagometer';
import type { NotifyRow } from './notify-lines';
import type { Rgb } from './player-color';
import type { PowerupTimer } from './powerup-timers';
import type { RewardFrame } from './rewards';
import { SPEED_GRAPH_COLOR, speedColumns, type SpeedGraph } from './speedometer';
import type { TeamChatFrame } from './team-chat';
import {
  SELECT_INSET,
  SELECT_SIZE,
  WEAPON_BAR_Y,
  WEAPON_ICON_SIZE,
  type WeaponBar
} from './weapon-bar';

/**
 * The HUD's draw list: every picture `CG_Draw2D` draws this frame, in its order, as
 * `trap_R_DrawStretchPic` takes one — a shader over a rectangle on Q3's grid, a part of its
 * texture, and a colour. Engine-free: the render layer writes them as quads, and a run of them in
 * one shader is one draw, as Q3's renderer merges them.
 *
 * The colour is the one the shader is drawn in. The colour `trap_R_SetColor` sets tints a stage
 * only where it reads the vertex colour (`rgbGen vertex` or `exactVertex`), and fades only one with
 * `alphaGen vertex`; to any other the vertex is white and opaque. An item drawn in another's
 * colours multiplies it by its tint, whatever the stage reads. The stage's own brightness is the
 * renderer's.
 *
 * The console's notify lines are written here too, though they are the client's and not cgame's.
 */

/** `whiteShader` (`cg_main.c:1863`): `CG_FillRect`'s, and the graphs' columns'. */
export const WHITE_SHADER = 'white';

/** `charsetShader`, `selectShader` and `noammoShader` (`cg_main.c:866–873, 1862`). */
export const CHARSET_SHADER = 'gfx/2d/bigchars';
export const SELECT_SHADER = 'gfx/2d/select';
export const NO_AMMO_SHADER = 'icons/noammo';

/** How a HUD shader takes the colour it is drawn in. */
export interface PicShader {
  /** `rgbGen vertex` or `exactVertex`: tinted by the colour. */
  tinted: boolean;
  /** `alphaGen vertex`: faded by the colour's alpha. */
  faded: boolean;
}

/** What the HUD is drawn with. */
export interface HudArt {
  /** A shader by name, or `undefined` for one with no image, which draws nothing. */
  shader(name: string): PicShader | undefined;
  /** The player's model icon, for the head in 2D (`cg_draw3dIcons 0`), or `null` for none. */
  readonly playerIcon: string | null;
}

/** Where the pictures go, in the order they are drawn. */
export interface PicWriter {
  /**
   * `shader` over (x, y, w, h) on Q3's grid, kept to `anchor`, showing its texture from (s1, t1)
   * at the top left to (s2, t2), in `color`. The colour is rewritten for the next picture, so what
   * is kept is copied.
   */
  stretchPic(
    shader: string,
    x: number,
    y: number,
    w: number,
    h: number,
    anchor: HudAnchor,
    s1: number,
    t1: number,
    s2: number,
    t2: number,
    color: Rgba
  ): void;
}

/** The numbers' shaders, by the digit they draw, the minus last (`cg_main.c:807–834`). */
export const NUMBER_SHADERS = NUMBER_NAMES.map((name) => `gfx/2d/numbers/${name}_32b`);

/** Each weapon's icon (`CG_RegisterWeapon`'s `weaponIcon`). */
const WEAPON_ICONS: ReadonlyMap<WeaponId, string> = new Map(
  WEAPON_ASSETS.map((asset) => [asset.id, asset.icon])
);

/** The ammo box's and the armour's 2D icons, beside their numbers. */
const AMMO_ICON = iconRect(AMMO_X);
const ARMOR_ICON = iconRect(ARMOR_X);

/** `CG_DrawPowerups`' timer colour: `colors[1]`, its red (`cg_draw.c:1182`). */
const TIMER_COLOR: Rgba = [1, 0.2, 0.2, 1];

/** A `bigchars` cell's side, in texture coordinates. */
const CELL = 1 / CHARSET_CELLS;

const WHITE: Rgba = [1, 1, 1, 1];

/** The colour handed on, and the one `CG_DrawStringExt` sets for a line, each rewritten in turn. */
const handed: [number, number, number, number] = [1, 1, 1, 1];
const set: [number, number, number, number] = [1, 1, 1, 1];

/** A frame's art and its writer. */
interface Draw {
  art: HudArt;
  out: PicWriter;
}

/**
 * Write this frame's HUD, in `CG_Draw2D`'s order (`cg_draw.c:2522–2620`): a spectator's line, or
 * the player's own block; the team chat box; the lagometer and what it says of the connection; the
 * upper right; the lower right's scores and powerups; the lower left's pickup; the follow line or
 * the warmup; and the message in the middle.
 *
 * Quake Live's speedometer is not Q3's, and stands just before the lagometer, whose box it shares.
 *
 * @param speeds - The speed graph's history, which its columns are drawn from.
 * @param scale - Pixels to a unit of Q3's grid (`hudScale`): the graphs' columns are a pixel wide.
 */
export function drawHud(
  frame: HudFrame,
  speeds: SpeedGraph,
  scale: number,
  art: HudArt,
  out: PicWriter
): void {
  const draw: Draw = { art, out };
  // Only one of these is drawn: a spectator's line, or the player's own status.
  lines(draw, frame.spectator);
  statusBar(draw, frame.statusBar);
  text(draw, frame.ammoWarning);
  crosshair(draw, frame.crosshair);
  weaponBar(draw, frame.weaponBar);
  holdable(draw, frame.holdable);
  reward(draw, frame.reward);
  teamChat(draw, frame.teamChat);
  speedometer(draw, frame.speedometer, speeds, scale);
  lagometer(draw, frame.lagometer, scale);
  disconnect(draw, frame.disconnect);
  text(draw, frame.fps);
  scores(draw, frame.scores);
  powerups(draw, frame.powerups);
  pickup(draw, frame.pickup);
  // Only one of these is drawn: the warmup is not called while the follow line is.
  lines(draw, frame.follow);
  lines(draw, frame.warmup);
  lines(draw, frame.centerPrint);
}

/**
 * Write `Con_DrawNotify`'s characters (`cl_console.c:577–623`): each in its own colour, with no
 * shadow. They are laid out in the canvas's own pixels, as `SCR_DrawSmallChar` draws them, so they
 * are the same size on any screen, the size `con_scale` makes them; here they are put on Q3's grid,
 * from the left edge.
 *
 * @param rows - The lines, in the canvas's own pixels.
 * @param scale - Pixels to a unit of Q3's grid.
 */
export function drawNotify(
  rows: readonly NotifyRow[],
  scale: number,
  art: HudArt,
  out: PicWriter
): void {
  const draw: Draw = { art, out };
  for (const row of rows) {
    const w = row.charWidth / scale;
    const h = row.charHeight / scale;
    for (const glyph of row.glyphs) {
      const [r, g, b] = COLOR_TABLE[glyph.color];
      set[0] = r;
      set[1] = g;
      set[2] = b;
      set[3] = 1;
      char(draw, glyph, glyph.x / scale, row.y / scale, w, h, 'left', set);
    }
  }
}

/**
 * One picture, in the colour its shader takes: `color` tints it only where the shader reads the
 * vertex colour, and fades it only where it reads the vertex alpha; `tint` multiplies it either
 * way. Nothing for a shader with no image.
 */
function pic(
  draw: Draw,
  shader: string,
  x: number,
  y: number,
  w: number,
  h: number,
  anchor: HudAnchor,
  s1: number,
  t1: number,
  s2: number,
  t2: number,
  color: Rgba,
  tint?: Rgb
): void {
  const taken = draw.art.shader(shader);
  if (!taken) return;
  for (let i = 0; i < 3; i++) handed[i] = (tint ? tint[i] : 1) * (taken.tinted ? color[i] : 1);
  handed[3] = taken.faded ? color[3] : 1;
  draw.out.stretchPic(shader, x, y, w, h, anchor, s1, t1, s2, t2, handed);
}

/** `CG_DrawPic`: a whole picture over (x, y, w, h). */
function image(
  draw: Draw,
  shader: string,
  x: number,
  y: number,
  w: number,
  h: number,
  anchor: HudAnchor,
  color: Rgba = WHITE,
  tint?: Rgb
): void {
  pic(draw, shader, x, y, w, h, anchor, 0, 0, 1, 1, color, tint);
}

/** A whole picture over a rectangle. */
function imageOver(
  draw: Draw,
  shader: string,
  rect: HudRect,
  anchor: HudAnchor,
  color: Rgba = WHITE,
  tint?: Rgb
): void {
  image(draw, shader, rect.x, rect.y, rect.w, rect.h, anchor, color, tint);
}

/** An item's icon over a rectangle, in its tint (`cg_items[...].icon`). */
function itemIcon(draw: Draw, item: GItem, rect: HudRect, anchor: HudAnchor, color: Rgba): void {
  imageOver(draw, item.icon, rect, anchor, color, item.tint);
}

/** `CG_FillRect`: `whiteShader` over a rectangle, in `color` (`cg_drawtools.c:54–61`). */
function fill(draw: Draw, rect: HudRect, anchor: HudAnchor, color: Rgba): void {
  pic(draw, WHITE_SHADER, rect.x, rect.y, rect.w, rect.h, anchor, 0, 0, 0, 0, color);
}

/** `CG_DrawChar`: a character, cut from its cell of `bigchars` (`cg_drawtools.c:122–151`). */
function char(
  draw: Draw,
  glyph: Glyph,
  x: number,
  y: number,
  w: number,
  h: number,
  anchor: HudAnchor,
  color: Rgba
): void {
  const s = glyph.col * CELL;
  const t = glyph.row * CELL;
  pic(draw, CHARSET_SHADER, x, y, w, h, anchor, s, t, s + CELL, t + CELL, color);
}

/**
 * `CG_DrawStringExt` (`cg_drawtools.c:164–215`): the shadow under the whole line first, black at
 * the line's alpha, 2 right and 2 down; then each character, in the colour a `^` code before it
 * sets, at the line's alpha, or else the line's own.
 */
function text(draw: Draw, line: HudText | null): void {
  if (!line) return;
  const glyphs = stringGlyphs(line.text, line.x, line.charWidth);
  const { y, charWidth: w, charHeight: h, anchor, color } = line;
  if (line.shadow) {
    set[0] = set[1] = set[2] = 0;
    set[3] = color[3];
    for (const glyph of glyphs) {
      char(draw, glyph, glyph.x + SHADOW_OFFSET, y + SHADOW_OFFSET, w, h, anchor, set);
    }
  }
  for (const glyph of glyphs) {
    if (glyph.color === undefined) {
      char(draw, glyph, glyph.x, y, w, h, anchor, color);
      continue;
    }
    const [r, g, b] = COLOR_TABLE[glyph.color];
    set[0] = r;
    set[1] = g;
    set[2] = b;
    set[3] = color[3];
    char(draw, glyph, glyph.x, y, w, h, anchor, set);
  }
}

/** Lines of text, in turn. */
function lines(draw: Draw, texts: readonly HudText[]): void {
  for (const line of texts) text(draw, line);
}

/** `CG_DrawField`: a number's digits, 32×48 each, along `y` (`cg_draw.c:206–258`). */
function digits(
  draw: Draw,
  shown: readonly Digit[],
  y: number,
  anchor: HudAnchor,
  color: Rgba
): void {
  for (const digit of shown) {
    image(draw, NUMBER_SHADERS[digit.frame], digit.x, y, CHAR_WIDTH, CHAR_HEIGHT, anchor, color);
  }
}

/** A number on the status bar. */
function field(draw: Draw, number: HudField | null, anchor: HudAnchor): void {
  if (number) digits(draw, number.digits, STATUS_Y, anchor, number.color);
}

/**
 * `CG_DrawStatusBar`'s 2D half (`cg_draw.c:519–644`): the head's icon and the cross over a head of
 * either kind, then each number and its icon.
 */
function statusBar(draw: Draw, bar: StatusBar | null): void {
  if (!bar) return;
  const { head } = bar;
  const icon = draw.art.playerIcon;
  if (!head.model && icon) image(draw, icon, head.x, head.y, head.size, head.size, BAR_ANCHOR);
  if (head.deferred) {
    image(draw, DEFER_SHADER, head.x, head.y, head.size, head.size, BAR_ANCHOR);
  }
  field(draw, bar.ammo, AMMO_ANCHOR);
  const ammoIcon = bar.ammoIcon === null ? undefined : WEAPON_ICONS.get(bar.ammoIcon);
  if (ammoIcon) imageOver(draw, ammoIcon, AMMO_ICON, AMMO_ANCHOR);
  field(draw, bar.health, BAR_ANCHOR);
  field(draw, bar.armor, BAR_ANCHOR);
  // The armour's item by its tier: for the yellow, Q3's own `armorIcon` (`cg_main.c:956`).
  const armor = bar.armorIcon ? findItemForArmorTier(bar.armorTier) : null;
  if (armor) itemIcon(draw, armor, ARMOR_ICON, BAR_ANCHOR, WHITE);
}

/** `CG_DrawCrosshair` (`cg_draw.c:1864–1919`): centred on the view. */
function crosshair(draw: Draw, crosshair: HudCrosshair | null): void {
  if (!crosshair) return;
  const { size } = crosshair;
  const x = (SCREEN_WIDTH - size) / 2;
  const y = (SCREEN_HEIGHT - size) / 2;
  image(draw, crosshair.shader, x, y, size, size, 'centre', crosshair.color);
}

/**
 * `CG_DrawWeaponSelect` (`cg_weapons.c:1452–1520`): each weapon's icon, then the marker round the
 * one asked for, then its cross for no ammo; then the name. All are drawn in the bar's fade, which
 * only the stages that take the vertex colour follow.
 */
function weaponBar(draw: Draw, bar: WeaponBar | null): void {
  if (!bar) return;
  const color: Rgba = [1, 1, 1, bar.alpha];
  const size = WEAPON_ICON_SIZE;
  for (const slot of bar.slots) {
    const icon = WEAPON_ICONS.get(slot.weapon);
    if (icon) image(draw, icon, slot.x, WEAPON_BAR_Y, size, size, BAR_ANCHOR, color);
    if (slot.selected) {
      const x = slot.x - SELECT_INSET;
      const y = WEAPON_BAR_Y - SELECT_INSET;
      image(draw, SELECT_SHADER, x, y, SELECT_SIZE, SELECT_SIZE, BAR_ANCHOR, color);
    }
    if (slot.noAmmo) image(draw, NO_AMMO_SHADER, slot.x, WEAPON_BAR_Y, size, size, BAR_ANCHOR, color);
  }
  const { name } = bar;
  if (!name) return;
  text(draw, {
    ...name,
    charWidth: BIGCHAR_WIDTH,
    charHeight: BIGCHAR_HEIGHT,
    color,
    shadow: true,
    anchor: BAR_ANCHOR
  });
}

/** `CG_DrawHoldableItem` (`cg_draw.c:1417–1426`): the item carried. */
function holdable(draw: Draw, held: HoldableItem | null): void {
  const item = held ? ITEMS[held.item] : undefined;
  if (held && item) itemIcon(draw, item, held.icon, 'right', WHITE);
}

/**
 * `CG_DrawReward` (`cg_draw.c:1454–1519`): the medals across the top middle, and the count under a
 * lone one, in the reward's fade.
 */
function reward(draw: Draw, frame: RewardFrame | null): void {
  if (!frame) return;
  const color: Rgba = [1, 1, 1, frame.alpha];
  const shader = MEDAL_SHADERS[frame.medal];
  for (const medal of frame.medals) imageOver(draw, shader, medal, 'centre', color);
  text(draw, frame.count);
}

/** `CG_DrawTeamInfo`: the band in the team's colour, across the screen, then the lines over it. */
function teamChat(draw: Draw, frame: TeamChatFrame | null): void {
  if (!frame) return;
  imageOver(draw, TEAM_STATUS_BAR_SHADER, frame.band, 'stretch', frame.color);
  lines(draw, frame.lines);
}

/** The speedometer's number and peak line, then its graph's columns in yellow. */
function speedometer(
  draw: Draw,
  frame: HudSpeedometer | null,
  speeds: SpeedGraph,
  scale: number
): void {
  if (!frame) return;
  lines(draw, frame.readout);
  const { graph } = frame;
  if (!graph) return;
  for (const column of speedColumns(speeds, graph.rect, scale)) {
    fill(draw, column, graph.anchor, SPEED_GRAPH_COLOR);
  }
}

/**
 * `CG_DrawLagometer` (`cg_draw.c:1634–1739`): the picture, then the graphs' columns in their
 * colours, then "snc", all kept to the right edge.
 */
function lagometer(draw: Draw, frame: HudLagometer | null, scale: number): void {
  if (!frame) return;
  imageOver(draw, LAGOMETER_SHADER, frame.rect, 'right');
  for (const bar of lagometerBars(frame.samples, frame.rect, scale)) {
    fill(draw, bar, 'right', bar.color);
  }
  text(draw, frame.snc);
}

/**
 * `CG_DrawDisconnect` (`cg_draw.c:1589–1623`), which the lagometer calls last: the line, then the
 * icon over the lagometer's box.
 */
function disconnect(draw: Draw, frame: HudDisconnect | null): void {
  if (!frame) return;
  text(draw, frame.text);
  if (frame.icon) imageOver(draw, NET_SHADER, frame.icon, 'right');
}

/**
 * `CG_DrawScores` (`cg_draw.c:1018–1161`): each box in turn, rightmost first — its fill, the
 * player's frame, its number, then its side's flag over it — and then the limit.
 */
function scores(draw: Draw, frame: HudScores | null): void {
  if (!frame) return;
  for (const box of frame.boxes) {
    fill(draw, box.rect, 'right', box.color);
    if (box.framed) imageOver(draw, SELECT_SHADER, box.rect, 'right');
    text(draw, box.text);
    if (box.flag) imageOver(draw, box.flag.icon, box.flag.rect, 'right');
  }
  text(draw, frame.limit);
}

/**
 * `CG_DrawPowerups` (`cg_draw.c:1171–1268`): each timer's number in red, then its icon, against the
 * right edge.
 *
 * The blink sets all four of the icon's colour to its fraction (`cg_draw.c:1247–1250`). Only a
 * stage that takes the vertex colour shows it, and retail's item icons do not, so Q3 draws them at
 * full brightness however the blink runs.
 */
function powerups(draw: Draw, timers: readonly PowerupTimer[]): void {
  for (const timer of timers) {
    digits(draw, timer.digits, timer.y, 'right', TIMER_COLOR);
    const item = findItemForPowerup(timer.powerup);
    if (!item) continue;
    const f = timer.alpha;
    itemIcon(draw, item, timer.icon, 'right', f === null ? WHITE : [f, f, f, f]);
  }
}

/** `CG_DrawPickupItem` (`cg_draw.c:1298–1321`): the icon in its fade, and its name. */
function pickup(draw: Draw, frame: PickupItem | null): void {
  const item = frame ? ITEMS[frame.item] : undefined;
  if (!frame || !item) return;
  itemIcon(draw, item, frame.icon, 'left', [1, 1, 1, frame.alpha]);
  text(draw, frame.name);
}
