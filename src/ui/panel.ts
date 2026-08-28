/**
 * The screen furniture around the game window: score, morale flag, bell ringer.
 *
 * None of this lives in the window buffer. `src/render/window.ts` rebuilds and
 * blits a 24x17 buffer every frame; the panel is poked straight into the
 * display file at fixed addresses and simply stays there. That is why these
 * routines take a `SpectrumScreen` and not a buffer.
 *
 * Every screen address below is an instruction operand, cited at its site --
 * they are code, not one of the parsed data tables.
 */

import panelJson from '../../data/panel.json';
import { decodeBase64 } from '../data/load.js';
import {
  ATTRIBUTE_FILE_BASE,
  SCREEN_COLS,
  SpectrumScreen,
  nextScanlineDown,
  nextScanlineUp,
} from '../spectrum/display.js';
import type { PlayerState } from '../game/player.js';
import { plotSingleGlyph } from './glyphs.js';

const panel = panelJson as unknown as {
  moraleFlag: {
    up: { widthBytes: number; height: number; data: string };
    down: { widthBytes: number; height: number; data: string };
    overlapRows: number;
  };
  bellRinger: {
    on: { widthBytes: number; height: number; data: string };
    off: { widthBytes: number; height: number; data: string };
  };
};

/** bitmap_flag_up ($DA29), 3x25 as plotted by $A06B. */
export const flagUp = decodeBase64(panel.moraleFlag.up.data);
/** bitmap_flag_down ($DA6B), 3x25. Its first three rows are flagUp's last three. */
export const flagDown = decodeBase64(panel.moraleFlag.down.data);
export const bellRingerOn = decodeBase64(panel.bellRinger.on.data);
export const bellRingerOff = decodeBase64(panel.bellRinger.off.data);

/** The flag is 3 bytes wide and 25 rows tall ($A06B LD BC,$0319). */
export const FLAG_WIDTH_BYTES = 3;
export const FLAG_HEIGHT = 25;

/** screenaddr_score ($A10E LD DE,$5094): character row 20, column 20. */
export const SCORE_SCREEN_ADDRESS = 0x5094;
/** The morale flag's starting plot address ($A141 DEFW $5002). */
export const MORALE_FLAG_START_ADDRESS = 0x5002;
/** Top-left attribute of the morale flag ($A071 LD HL,$5842). */
export const MORALE_FLAG_ATTR_ADDRESS = 0x5842;
/** The flag's attribute block is 3 wide and 19 rows tall ($A074/$A077). */
export const MORALE_FLAG_ATTR_WIDTH = 3;
export const MORALE_FLAG_ATTR_HEIGHT = 0x13;
/** screenaddr_bell_ringer ($A0C9 LD HL,$518E). */
export const BELL_RINGER_SCREEN_ADDRESS = 0x518e;

/**
 * plot_bitmap ($7CBE): copy an unmasked bitmap into the display file.
 *
 * Two details are taken literally. The column step is `INC L` ($7CC7), not
 * `INC HL`, so a row that runs past the end of a 256-byte page wraps to its
 * start instead of continuing; and the row step is next_scanline_down ($7CCC)
 * rather than a recomputed address, so the same third-of-the-screen rule
 * applies here as in the glyph plotter.
 */
export function plotBitmap(
  screen: SpectrumScreen,
  addr: number,
  widthBytes: number,
  height: number,
  data: ArrayLike<number>,
  offset = 0,
): void {
  let src = offset;
  let dst = addr;
  for (let row = 0; row < height; row++) {
    let col = dst;
    for (let b = 0; b < widthBytes; b++) {
      screen.writeByte(col, data[src]!);
      col = (col & 0xff00) | ((col + 1) & 0xff); // INC L
      src++;
    }
    dst = nextScanlineDown(dst);
  }
}

/**
 * plot_score ($A10B): five digits at $5094.
 *
 * The digits are already glyph indices -- score_digits holds 0..9, which are
 * also font glyphs 0..9 -- so no translation is needed. `INC DE` at $A118 is
 * "in addition to plot_glyph's increment", giving a one-cell gap between
 * digits; the score is drawn across ten columns, not five.
 */
export function plotScore(screen: SpectrumScreen, player: PlayerState): void {
  let addr = SCORE_SCREEN_ADDRESS;
  for (let i = 0; i < player.score.length; i++) {
    addr = plotSingleGlyph(screen, addr, player.score[i]!);
    addr = (addr + 1) & 0xffff; // $A118
  }
}

/**
 * set_morale_flag_screen_attributes ($A071).
 *
 * Three attributes per row for 19 rows, stepping by $1E ($A074) because the
 * three `INC L`s have already advanced the pointer by two.
 */
export function setMoraleFlagScreenAttributes(screen: SpectrumScreen, attr: number): void {
  let hl = MORALE_FLAG_ATTR_ADDRESS;
  for (let row = 0; row < MORALE_FLAG_ATTR_HEIGHT; row++) {
    for (let i = 0; i < MORALE_FLAG_ATTR_WIDTH; i++) {
      screen.attributes[hl - ATTRIBUTE_FILE_BASE + i] = attr & 0xff;
    }
    // $A07E ADD HL,DE. The two INC Ls between the three stores have already
    // moved the pointer to the third column, so the rowskip is 32 - 2 = $1E
    // and the total step is a full attribute row. Adding the width instead of
    // width-1 here would skew the block one cell right per row.
    hl += MORALE_FLAG_ATTR_WIDTH - 1 + 0x1e;
  }
}

/**
 * wave_morale_flag ($A035).
 *
 * Does three things, and dropping any one of them breaks the other two:
 *
 *  1. increments the game counter IN PLACE ($A038) -- this routine is where
 *     the counter advances, so it must run every frame even when the flag is
 *     not moving;
 *  2. on even counter values only ($A03A), steps the displayed morale one
 *     towards the real morale and moves the plot address one scanline the
 *     corresponding way;
 *  3. plots the flag, choosing up or down from bit 1 of the counter ($A061),
 *     which is what makes it flutter at a quarter of the frame rate.
 *
 * The early return at $A03C is AFTER the increment, so a caller that skips
 * this routine stops the game counter as well.
 */
export function waveMoraleFlag(screen: SpectrumScreen, player: PlayerState): void {
  player.gameCounter = (player.gameCounter + 1) & 0xff; // $A038
  if ((player.gameCounter & 1) !== 0) return; // $A03A, every other turn

  if (player.morale !== player.displayedMorale) {
    if (player.morale < player.displayedMorale) {
      player.displayedMorale--; // $A04A
      player.moraleFlagScreenAddress = nextScanlineDown(player.moraleFlagScreenAddress);
    } else {
      player.displayedMorale++; // $A053
      player.moraleFlagScreenAddress = nextScanlineUp(player.moraleFlagScreenAddress);
    }
  }

  // $A05D loads flag_down, then $A061 overrides with flag_up when bit 1 is set.
  const bitmap = (player.gameCounter & 0x02) !== 0 ? flagUp : flagDown;
  plotBitmap(screen, player.moraleFlagScreenAddress, FLAG_WIDTH_BYTES, FLAG_HEIGHT, bitmap);
}

/** plot_ringer ($A0C9): the bell ringer, 8x12 at $518E ($A0CC LD BC,$010C). */
export function plotRinger(screen: SpectrumScreen, ringing: boolean): void {
  plotBitmap(screen, BELL_RINGER_SCREEN_ADDRESS, 1, 12, ringing ? bellRingerOn : bellRingerOff);
}

/** Attribute-file index for a cell, for tests. */
export function attrIndex(col: number, row: number): number {
  return row * SCREEN_COLS + col;
}
