/**
 * `.skin` files: which shader each surface of a player model draws.
 *
 * A port of the parse in `RE_RegisterSkin` (`tr_image.c:1562–1611`) and of the `CommaParse` it
 * reads with (`tr_image.c:1401–1496`). A skin is `surface,shader` pairs. Surface names are
 * lowercased, as the renderer compares them; shaders are kept as written, for `R_FindShader` to
 * strip and look up.
 *
 * Two of Q3's rules show in odd files. A pair whose surface token contains `tag_` anywhere is
 * skipped, which drops the tag lines every retail skin carries. And a token ends at whitespace
 * or a comma, where whitespace takes in line breaks, so a pair that names no shader takes the
 * next line's first token as its shader.
 *
 * Engine-free, like the other parsers: text in, pairs out.
 */

/** One pair: an MD3 surface, lowercased, and the shader it draws. */
export interface SkinSurface {
  surface: string;
  shader: string;
}

/** Pairs kept per skin; Q3 drops the rest with a warning (`MAX_SKIN_SURFACES`, `tr_local.h:426`). */
export const MAX_SKIN_SURFACES = 256;

/** `MAX_QPATH` less its NUL: surface names are cut to this length, as `Q_strncpyz` cuts them. */
const MAX_NAME = 63;

/**
 * Parse a `.skin` file's text.
 *
 * @returns its pairs in file order; none for a file with no usable pair, which Q3 replaces with
 *   the default skin (`tr_image.c:1609–1612`)
 */
export function parseSkin(text: string): SkinSurface[] {
  const surfaces: SkinSurface[] = [];
  const reader = { text, at: 0 };
  while (reader.at < text.length) {
    const surface = commaParse(reader);
    if (!surface) break;
    if (text[reader.at] === ',') reader.at++;
    if (surface.includes('tag_')) continue;
    const shader = commaParse(reader);
    if (surfaces.length < MAX_SKIN_SURFACES) {
      surfaces.push({ surface: surface.slice(0, MAX_NAME).toLowerCase(), shader });
    }
  }
  return surfaces;
}

/**
 * The next token, as `CommaParse` reads it: past whitespace and `//` or `/* *​/` comments, then
 * a quoted string, or a word that runs to whitespace or a comma. `''` at the end of the text.
 */
function commaParse(reader: { text: string; at: number }): string {
  const { text } = reader;
  let at = reader.at;
  for (;;) {
    while (at < text.length && text.charCodeAt(at) <= 32) at++;
    if (text.startsWith('//', at)) {
      at += 2;
      while (at < text.length && text[at] !== '\n') at++;
    } else if (text.startsWith('/*', at)) {
      at += 2;
      while (at < text.length && !text.startsWith('*/', at)) at++;
      if (at < text.length) at += 2;
    } else {
      break;
    }
  }
  if (at >= text.length) {
    reader.at = at;
    return '';
  }

  if (text[at] === '"') {
    const close = text.indexOf('"', at + 1);
    const end = close < 0 ? text.length : close;
    reader.at = Math.min(end + 1, text.length);
    return text.slice(at + 1, end);
  }

  // A word keeps its first character whatever it is, a comma included, as the C's do-while does.
  const start = at;
  do at++;
  while (at < text.length && text.charCodeAt(at) > 32 && text[at] !== ',');
  reader.at = at;
  return text.slice(start, at);
}
