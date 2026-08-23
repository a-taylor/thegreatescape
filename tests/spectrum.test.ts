/**
 * Display-model tests.
 *
 * The important one here is `screenAddress` against game_window_start_addresses
 * ($EDD3). Those 128 words are the game's OWN table of screen row pointers, so
 * they are an independent oracle for the Spectrum's interleaved screen layout
 * rather than a restatement of our own arithmetic.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

import {
  ATTR_BRIGHT,
  ATTR_FLASH,
  SCREEN_COLS,
  SCREEN_HEIGHT,
  SCREEN_WIDTH,
  SpectrumScreen,
  attributeAddress,
  paletteRGB,
  screenAddress,
  screenCoords,
} from '../src/spectrum/display.js';

const timing = JSON.parse(
  readFileSync(fileURLToPath(new URL('../data/timing.json', import.meta.url)), 'utf8'),
) as {
  gameWindow: {
    rows: number;
    rowAddresses: string[];
    originColumn: number;
    originPixelRow: number;
    widthPixels: number;
    heightPixels: number;
  };
};

describe('screen address arithmetic', () => {
  it('matches the game window row table from the disassembly', () => {
    const { rowAddresses, originColumn, originPixelRow } = timing.gameWindow;
    expect(rowAddresses).toHaveLength(128);

    rowAddresses.forEach((hex, i) => {
      const expected = parseInt(hex.slice(1), 16);
      expect(screenAddress(originColumn, originPixelRow + i)).toBe(expected);
    });
  });

  it('decodes the first window pointer to column 7, pixel row 16', () => {
    // $4047 is the first entry of game_window_start_addresses.
    expect(screenCoords(0x4047)).toEqual({ col: 7, row: 16 });
  });

  it('round-trips every pixel position', () => {
    for (let y = 0; y < SCREEN_HEIGHT; y++) {
      for (let col = 0; col < SCREEN_COLS; col++) {
        expect(screenCoords(screenAddress(col, y))).toEqual({ col, row: y });
      }
    }
  });

  it('covers the display file exactly once', () => {
    const seen = new Set<number>();
    for (let y = 0; y < SCREEN_HEIGHT; y++) {
      for (let col = 0; col < SCREEN_COLS; col++) seen.add(screenAddress(col, y));
    }
    expect(seen.size).toBe(6144);
    expect(Math.min(...seen)).toBe(0x4000);
    expect(Math.max(...seen)).toBe(0x57ff);
  });

  it('places the thirds where the hardware does', () => {
    // Row 0 of each third starts at the third's base address.
    expect(screenAddress(0, 0)).toBe(0x4000);
    expect(screenAddress(0, 64)).toBe(0x4800);
    expect(screenAddress(0, 128)).toBe(0x5000);
    // Consecutive pixel rows within a character row are $100 apart.
    expect(screenAddress(0, 1) - screenAddress(0, 0)).toBe(0x100);
  });

  it('maps attribute cells linearly', () => {
    expect(attributeAddress(0, 0)).toBe(0x5800);
    expect(attributeAddress(31, 23)).toBe(0x5aff);
  });
});

describe('palette', () => {
  it('uses $D7 for normal and $FF for bright', () => {
    expect(paletteRGB(7, false)).toEqual([0xd7, 0xd7, 0xd7]); // white
    expect(paletteRGB(7, true)).toEqual([0xff, 0xff, 0xff]);
    expect(paletteRGB(2, false)).toEqual([0xd7, 0, 0]); // red
    expect(paletteRGB(4, false)).toEqual([0, 0xd7, 0]); // green
    expect(paletteRGB(1, false)).toEqual([0, 0, 0xd7]); // blue
  });

  it('keeps black black even when bright', () => {
    expect(paletteRGB(0, true)).toEqual([0, 0, 0]);
  });
});

describe('SpectrumScreen', () => {
  it('resolves ink and paper from attributes, not from the bitmap', () => {
    const s = new SpectrumScreen();
    s.clear(0x00, 0);
    // Cell (0,0): white ink on blue paper. Bitmap 0b10000000 -> first pixel ink.
    s.setAttribute(0, 0, (1 << 3) | 7);
    s.writeByte(screenAddress(0, 0), 0b1000_0000);

    const out = new Uint8ClampedArray(SCREEN_WIDTH * SCREEN_HEIGHT * 4);
    s.toImageData(out);

    expect([out[0], out[1], out[2]]).toEqual([0xd7, 0xd7, 0xd7]); // ink
    expect([out[4], out[5], out[6]]).toEqual([0, 0, 0xd7]); // paper
  });

  it('swaps ink and paper on the flash phase only when FLASH is set', () => {
    const s = new SpectrumScreen();
    s.clear(0xff, 0);
    s.setAttribute(0, 0, ATTR_FLASH | (1 << 3) | 7);
    s.setAttribute(1, 0, (1 << 3) | 7);

    const off = new Uint8ClampedArray(SCREEN_WIDTH * SCREEN_HEIGHT * 4);
    const on = new Uint8ClampedArray(SCREEN_WIDTH * SCREEN_HEIGHT * 4);
    s.toImageData(off, false);
    s.toImageData(on, true);

    // Flashing cell inverts...
    expect([off[0], off[1], off[2]]).toEqual([0xd7, 0xd7, 0xd7]);
    expect([on[0], on[1], on[2]]).toEqual([0, 0, 0xd7]);
    // ...its neighbour does not.
    const n = 8 * 4;
    expect([on[n], on[n + 1], on[n + 2]]).toEqual([0xd7, 0xd7, 0xd7]);
  });

  it('applies BRIGHT per cell', () => {
    const s = new SpectrumScreen();
    s.clear(0xff, 7);
    s.setAttribute(1, 0, ATTR_BRIGHT | 7);
    const out = new Uint8ClampedArray(SCREEN_WIDTH * SCREEN_HEIGHT * 4);
    s.toImageData(out);
    expect(out[0]).toBe(0xd7);
    expect(out[8 * 4]).toBe(0xff);
  });

  it('fills attribute rectangles without touching neighbours', () => {
    const s = new SpectrumScreen();
    s.clear(0, 0);
    s.fillAttributes(7, 2, 24, 16, 0x38);
    expect(s.getAttribute(7, 2)).toBe(0x38);
    expect(s.getAttribute(30, 17)).toBe(0x38);
    expect(s.getAttribute(6, 2)).toBe(0);
    expect(s.getAttribute(31, 2)).toBe(0);
    expect(s.getAttribute(7, 18)).toBe(0);
  });
});
