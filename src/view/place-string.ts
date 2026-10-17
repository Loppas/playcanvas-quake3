import { RANK_TIED_FLAG } from '../sim/constants';

/**
 * `CG_PlaceString` (`cg_event.c:40–75`): a place as the scoreboard and the kill message write it —
 * `1st`, `2nd`, `Tied for 3rd` — with the first three places coloured, as Quake 3 colours them.
 */

/** `S_COLOR_*` (`q_shared.h:407–413`), which the places below are drawn in. */
const BLUE = '^4';
const RED = '^1';
const YELLOW = '^3';
const WHITE = '^7';

/**
 * A place, from 1, as `CG_PlaceString` writes it.
 *
 * @param rank - The place, 1-based, with {@link RANK_TIED_FLAG} for a tie.
 * @returns the text, with Q3's colour escapes around the first three places.
 */
export function placeString(rank: number): string {
  const tied = (rank & RANK_TIED_FLAG) !== 0;
  const place = tied ? rank & ~RANK_TIED_FLAG : rank;

  let text: string;
  if (place === 1) text = `${BLUE}1st${WHITE}`;
  else if (place === 2) text = `${RED}2nd${WHITE}`;
  else if (place === 3) text = `${YELLOW}3rd${WHITE}`;
  // 11, 12 and 13 are the teens that are not `st`, `nd` and `rd`.
  else if (place === 11) text = '11th';
  else if (place === 12) text = '12th';
  else if (place === 13) text = '13th';
  else if (place % 10 === 1) text = `${place}st`;
  else if (place % 10 === 2) text = `${place}nd`;
  else if (place % 10 === 3) text = `${place}rd`;
  else text = `${place}th`;

  return tied ? `Tied for ${text}` : text;
}
