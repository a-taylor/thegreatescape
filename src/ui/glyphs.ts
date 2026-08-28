/**
 * The game's font, and the glyph plotter that draws it.
 *
 * This is the first code in the project that draws OUTSIDE the game window.
 * The window buffer (`src/render/window.ts`) is rebuilt wholesale every frame
 * and blitted through `game_window_start_addresses`; the score, the message
 * line and the morale flag are not in it. They are poked directly into the
 * display file at fixed addresses and persist until something overwrites them,
 * which is why they need a different path in rather than a bigger buffer.
 *
 * The font is 37 glyphs of 8 rows ($A69E, 296 bytes). There is no letter "O" --
 * digit zero doubles for it -- so the messages read "R0LL CALL". That is the
 * original's character set, not a decoding error; see FIDELITY.md.
 */

import textJson from '../../data/text.json';
import { decodeBase64 } from '../data/load.js';
import type { SpectrumScreen } from '../spectrum/display.js';

/** Rows per glyph: plot_single_glyph draws 8 ($7D3C LD B,$08). */
export const GLYPH_HEIGHT = 8;

/** Glyph index of space, from wipe_message ($7D93 LD A,$23). */
export const GLYPH_SPACE = 0x23;

const font = textJson as unknown as {
  bitmapFont: { _addr: string; _label: string; data: string };
  glyphSet: { chars: string[]; note: string };
};

/** bitmap_font ($A69E): glyph `n` row `r` is `fontBitmaps[n * 8 + r]`. */
export const fontBitmaps: Uint8Array = decodeBase64(font.bitmapFont.data);

export const GLYPH_COUNT = fontBitmaps.length / GLYPH_HEIGHT;

/** The printable character for each glyph index, for tests and debugging. */
export const glyphChars: readonly string[] = font.glyphSet.chars;

/**
 * plot_single_glyph ($7D30).
 *
 * Draws one glyph at a screen address and returns the address one character to
 * the right ($7D44: `POP DE` / `INC DE`).
 *
 * The row walk is `INC D` ($7D40), NOT a recomputed screen address, and that
 * difference is load-bearing. Bits 8..10 of a display-file address hold the
 * scanline WITHIN a character row, so incrementing the high byte only walks
 * down a character cell while those three bits have room -- i.e. only from a
 * character-aligned address. The disassembly says as much: "this will only work
 * for screen addresses that stay within their respective third of the screen"
 * ($7D30). Modelled literally so a misaligned caller gets the original's
 * scattered output rather than a tidy corrected glyph.
 */
export function plotSingleGlyph(screen: SpectrumScreen, addr: number, glyph: number): number {
  let src = glyph * GLYPH_HEIGHT;
  let dst = addr;
  for (let row = 0; row < GLYPH_HEIGHT; row++) {
    screen.writeByte(dst, fontBitmaps[src]!);
    dst = (dst + 0x100) & 0xffff; // INC D
    src++;
  }
  return (addr + 1) & 0xffff;
}

/**
 * plot_glyph ($7D2F).
 *
 * The same thing one indirection out: the Z80 entry point takes a POINTER to a
 * glyph index and falls through into plot_single_glyph. Here the caller has the
 * bytes already, so this is a thin wrapper kept for the address citation.
 */
export function plotGlyph(screen: SpectrumScreen, addr: number, glyphs: ArrayLike<number>, index: number): number {
  return plotSingleGlyph(screen, addr, glyphs[index]!);
}

/** Plot a run of glyphs left to right, returning the address after the last. */
export function plotGlyphs(screen: SpectrumScreen, addr: number, glyphs: ArrayLike<number>): number {
  let dst = addr;
  for (let i = 0; i < glyphs.length; i++) dst = plotSingleGlyph(screen, dst, glyphs[i]!);
  return dst;
}
