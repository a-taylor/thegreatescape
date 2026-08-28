/**
 * Glyph plotter tests.
 *
 * The font itself is gated pixel-exactly against the reference build's
 * font.png by the goldens suite, so these cover the PLOTTER: where the eight
 * rows land, and the `INC D` address walk that decides it.
 */

import { describe, expect, it } from 'vitest';

import { SpectrumScreen, screenAddress, screenCoords } from '../src/spectrum/display.js';
import {
  GLYPH_COUNT,
  GLYPH_HEIGHT,
  GLYPH_SPACE,
  fontBitmaps,
  glyphChars,
  plotGlyphs,
  plotSingleGlyph,
} from '../src/ui/glyphs.js';

describe('the font', () => {
  it('is 37 glyphs of 8 rows (bitmap_font $A69E, 296 bytes)', () => {
    expect(fontBitmaps.length).toBe(296);
    expect(GLYPH_COUNT).toBe(37);
    expect(GLYPH_HEIGHT).toBe(8);
  });

  it('has no letter O -- digit zero doubles for it', () => {
    // FIDELITY.md keeps this as a reproduced quirk, so assert the quirk.
    expect(glyphChars).not.toContain('O');
    expect(glyphChars[0]).toBe('0');
    // A..N then P: the gap is exactly where O would be.
    expect(glyphChars[10]).toBe('A');
    expect(glyphChars[23]).toBe('N');
    expect(glyphChars[24]).toBe('P');
  });

  it('has a blank glyph at the index wipe_message uses for space ($7D93)', () => {
    expect(GLYPH_SPACE).toBe(0x23);
    expect(glyphChars[GLYPH_SPACE]).toBe(' ');
    const rows = fontBitmaps.slice(GLYPH_SPACE * 8, GLYPH_SPACE * 8 + 8);
    expect([...rows]).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });
});

describe('plotSingleGlyph', () => {
  it('lands eight rows down one character cell, from a char-aligned address', () => {
    const screen = new SpectrumScreen();
    // $50E0 is the message line: character row 23, column 0 ($7D60).
    const start = 0x50e0;
    expect(screenCoords(start)).toEqual({ col: 0, row: 184 });

    const glyph = 10; // "A"
    plotSingleGlyph(screen, start, glyph);

    for (let row = 0; row < 8; row++) {
      const addr = screenAddress(0, 184 + row);
      expect(screen.readByte(addr)).toBe(fontBitmaps[glyph * 8 + row]);
    }
  });

  it('returns the next character position to the right ($7D45 INC DE)', () => {
    const screen = new SpectrumScreen();
    expect(plotSingleGlyph(screen, 0x50e0, 10)).toBe(0x50e1);
  });

  it('walks by INC D, so a misaligned start jumps to another third', () => {
    // The disassembly warns the routine "will only work for screen addresses
    // that stay within their respective third" ($7D30). Bits 8..10 of a
    // display-file address hold the scanline WITHIN a character row, so the
    // high-byte increment walks down a cell only while those three bits have
    // room; past that it carries into the third-select bits and the glyph
    // reappears 61 pixel rows away.
    //
    // Asserted as the quirk: from scanline 3 the rows are NOT 3..10. Both of
    // the game's own call sites are character-aligned ($50E0 for the message
    // line, $5094 for the score), so this is unreachable in play -- the test
    // pins the address arithmetic, not a behaviour to rely on.
    const screen = new SpectrumScreen();
    screen.display.fill(0xaa);
    const start = screenAddress(0, 3); // scanline 3 of character row 0
    expect(start).toBe(0x4300);

    // The space glyph is eight zero bytes, so a cleared byte marks a write.
    plotSingleGlyph(screen, start, GLYPH_SPACE);

    const rows: number[] = [];
    for (let addr = 0x4000; addr < 0x5800; addr++) {
      if (screen.readByte(addr) === 0) rows.push(screenCoords(addr).row);
    }
    rows.sort((a, b) => a - b);
    expect(rows).not.toEqual([3, 4, 5, 6, 7, 8, 9, 10]);
    expect(rows).toEqual([3, 4, 5, 6, 7, 64, 65, 66]);
  });
});

describe('plotGlyphs', () => {
  it('advances one cell per glyph and returns the address after the last', () => {
    const screen = new SpectrumScreen();
    const end = plotGlyphs(screen, 0x50e0, [10, 11, 12]);
    expect(end).toBe(0x50e3);
    for (let i = 0; i < 3; i++) {
      expect(screen.readByte(screenAddress(i, 184))).toBe(fontBitmaps[(10 + i) * 8]);
    }
  });
});
