/**
 * escaped ($A51C): the win/lose screen shown when the hero walks off the edge
 * of the map (in_permitted_area's onEscaped, $9F31).
 *
 * The routine always prints three intro lines ("WELL DONE" / "YOU HAVE
 * ESCAPED" / "FROM THE CAMP"), then looks at the two held-item slots to pick
 * an ending. Every held item is worth one bit -- compass, papers, purse,
 * uniform -- and the SUM of the two slots' bits decides everything else:
 *
 *   compass+purse    ($A538 CP $05)  win, "AND WILL CROSS THE BORDER
 *                                     SUCCESSFULLY"
 *   compass+papers   ($A53C CP $03)  win, no extra line
 *   anything with the uniform bit set ($A557 CP $08/JR NC) loses as
 *     "AND SHOT AS A SPY", uniform or not, whatever else is held
 *   nothing at all    ($A55E)        loses as "TOTALLY UNPREPARED"
 *   no compass, not the two cases above ($A564 BIT 0,A) loses as
 *     "TOTALLY LOST"
 *   compass alone     (falls through)  loses as "DUE TO LACK OF PAPERS"
 *
 * After "PRESS ANY KEY" the original either resets the whole game
 * ($A581/$A586 -- a win, or a uniform-wearing capture) or sends the hero to
 * solitary ($A589 JP $CB98 -- every other capture).
 */

import textJson from '../../data/text.json';
import { decodeBase64 } from '../data/load.js';
import type { SpectrumScreen } from '../spectrum/display.js';
import { plotGlyphs } from './glyphs.js';

const text = textJson as unknown as {
  escapeStrings: { data: string };
};

/**
 * screenlocstring: {word screen_address; byte count; byte glyphs[count]},
 * repeated back to back with no count of its own -- escape_strings ($A5CE)
 * runs straight into bitmap_font, so the block's extent IS the data, and
 * parsing walks it to exhaustion rather than trusting a transcribed count of
 * strings. Verified against the extracted bytes: eleven records, consumed
 * exactly, in the order WELL DONE / YOU HAVE ESCAPED / FROM THE CAMP / AND
 * WILL CROSS THE / BORDER SUCCESSFULLY / BUT WERE RECAPTURED / AND SHOT AS A
 * SPY / TOTALLY UNPREPARED / TOTALLY LOST / DUE TO LACK OF PAPERS / PRESS ANY
 * KEY.
 */
export interface EscapeString {
  readonly screenAddress: number;
  readonly glyphs: readonly number[];
}

function parseEscapeStrings(): EscapeString[] {
  const bytes = decodeBase64(text.escapeStrings.data);
  const out: EscapeString[] = [];
  let i = 0;
  while (i < bytes.length) {
    const screenAddress = bytes[i]! | (bytes[i + 1]! << 8);
    const count = bytes[i + 2]!;
    out.push({ screenAddress, glyphs: Array.from(bytes.slice(i + 3, i + 3 + count)) });
    i += 3 + count;
  }
  return out;
}

export const escapeStrings: readonly EscapeString[] = parseEscapeStrings();

// Fixed indices into escapeStrings, in the order they sit in the ROM from
// $A5CE upward -- see the per-record comments in the disassembly.
export const MSG_WELL_DONE = 0;
export const MSG_YOU_HAVE_ESCAPED = 1;
export const MSG_FROM_THE_CAMP = 2;
export const MSG_AND_WILL_CROSS_THE = 3;
export const MSG_BORDER_SUCCESSFULLY = 4;
export const MSG_BUT_WERE_RECAPTURED = 5;
export const MSG_AND_SHOT_AS_A_SPY = 6;
export const MSG_TOTALLY_UNPREPARED = 7;
export const MSG_TOTALLY_LOST = 8;
export const MSG_DUE_TO_LACK_OF_PAPERS = 9;
export const MSG_PRESS_ANY_KEY = 10;

/** item_to_escapeitem's four interesting items ($A5A3). */
const ITEM_PAPERS = 0x03;
const ITEM_UNIFORM = 0x06;
const ITEM_PURSE = 0x0e;
const ITEM_COMPASS = 0x0f;

/** escapeitem_* flags ($A5A7/$A5AE/$A5B5/$A5BA). */
export const ESCAPEITEM_COMPASS = 0x01;
export const ESCAPEITEM_PAPERS = 0x02;
export const ESCAPEITEM_PURSE = 0x04;
export const ESCAPEITEM_UNIFORM = 0x08;

/** item_to_escapeitem ($A5A3): everything else is worth nothing ($A5BD). */
function itemToEscapeFlag(item: number): number {
  if (item === ITEM_COMPASS) return ESCAPEITEM_COMPASS;
  if (item === ITEM_PAPERS) return ESCAPEITEM_PAPERS;
  if (item === ITEM_PURSE) return ESCAPEITEM_PURSE;
  if (item === ITEM_UNIFORM) return ESCAPEITEM_UNIFORM;
  return 0;
}

export interface EscapeOutcome {
  /** The lines to print, in order -- always the three intro lines first. */
  readonly lines: readonly number[];
  readonly won: boolean;
  /** $A57F/$A584: true resets the whole game; false sends the hero to solitary. */
  readonly resetsGame: boolean;
}

const INTRO = [MSG_WELL_DONE, MSG_YOU_HAVE_ESCAPED, MSG_FROM_THE_CAMP];

/**
 * escaped ($A51C), minus the screen I/O and the keypress wait: which lines
 * print, and what happens once the player has seen them.
 */
export function computeEscapeOutcome(held: ArrayLike<number>): EscapeOutcome {
  // $A52D-$A537: join_item_to_escapeitem on both held slots.
  const flags = itemToEscapeFlag(held[0]!) + itemToEscapeFlag(held[1]!);

  if (flags === (ESCAPEITEM_COMPASS | ESCAPEITEM_PURSE)) { // $A538 CP $05
    return {
      lines: [...INTRO, MSG_AND_WILL_CROSS_THE, MSG_BORDER_SUCCESSFULLY],
      won: true,
      resetsGame: true, // $A549 LD A,$FF
    };
  }
  if (flags === (ESCAPEITEM_COMPASS | ESCAPEITEM_PAPERS)) { // $A53C CP $03
    return { lines: INTRO, won: true, resetsGame: true };
  }

  // $A54E onward: recaptured. The uniform test is `CP $08 / JR NC`, an
  // unsigned compare against the whole flag byte, not a bit test -- so it
  // catches every combination that includes the uniform, not just the
  // uniform alone.
  let line: number;
  if (flags >= ESCAPEITEM_UNIFORM) line = MSG_AND_SHOT_AS_A_SPY; // $A557
  else if (flags === 0) line = MSG_TOTALLY_UNPREPARED; // $A55E
  else if ((flags & ESCAPEITEM_COMPASS) === 0) line = MSG_TOTALLY_LOST; // $A564 BIT 0,A
  else line = MSG_DUE_TO_LACK_OF_PAPERS; // $A568, compass held but nothing else matched

  return {
    lines: [...INTRO, MSG_BUT_WERE_RECAPTURED, line],
    won: false,
    resetsGame: flags >= ESCAPEITEM_UNIFORM, // $A584 CP $08 / JP NC
  };
}

/** screenlocstring_plot ($A5BF), one record. */
export function drawEscapeString(screen: SpectrumScreen, index: number): void {
  const s = escapeStrings[index];
  if (!s) return;
  plotGlyphs(screen, s.screenAddress, s.glyphs);
}
