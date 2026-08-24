/**
 * Masked sprite plotting.
 *
 * The shifter is checked against a literal emulation of the Z80's RR chain, so
 * the carry propagation and the ones-vs-zeros fill are verified rather than
 * argued about.
 */

import { describe, expect, it } from 'vitest';

import {
  MASK_BUFFER_WIDTH,
  compositeByte,
  flipRow,
  plotMaskedSprite,
  reverseBits,
  shiftRowRight,
} from '../src/render/sprites.js';
import { GameWindowBuffers, WINDOW_STRIDE } from '../src/render/window.js';

/**
 * $E2DD..$E2ED for masks, $E2F5..$E305 for bitmaps: `shift` rounds of rotating
 * (d, e, c) right through carry.
 *
 * Masks enter with c = $FF and carry = 1 ($E2D8/$E2DA); bitmaps enter with
 * c = 0 and carry clear ($E2F0).
 */
function z80Shift(bytes: number[], shift: number, isMask: boolean): number[] {
  const regs = [...bytes, isMask ? 0xff : 0x00];
  let carry = isMask ? 1 : 0;

  for (let round = 0; round < shift; round++) {
    let c = carry;
    for (let i = 0; i < regs.length; i++) {
      const newCarry = regs[i]! & 1;
      regs[i] = ((regs[i]! >> 1) | (c << 7)) & 0xff;
      c = newCarry;
    }
    // The bitmap path uses SRL for the first byte, which shifts in a zero
    // rather than the carry; masks use RR throughout with carry preset.
    carry = isMask ? 1 : 0;
  }
  return regs;
}

describe('the shifter', () => {
  const samples: number[][] = [
    [0x00, 0x00],
    [0xff, 0xff],
    [0b1010_1010, 0b0101_0101],
    [0x81, 0x18],
    [0x01, 0x80],
  ];

  it.each(samples)('matches the RR chain for masks: %i, %i', (a, b) => {
    for (let shift = 0; shift <= 3; shift++) {
      expect(shiftRowRight([a!, b!], shift, true), `shift ${shift}`).toEqual(
        z80Shift([a!, b!], shift, true),
      );
    }
  });

  it.each(samples)('matches the RR chain for bitmaps: %i, %i', (a, b) => {
    for (let shift = 0; shift <= 3; shift++) {
      expect(shiftRowRight([a!, b!], shift, false), `shift ${shift}`).toEqual(
        z80Shift([a!, b!], shift, false),
      );
    }
  });

  it('is the identity at shift 0, plus the trailing byte', () => {
    expect(shiftRowRight([0xab, 0xcd], 0, false)).toEqual([0xab, 0xcd, 0x00]);
    expect(shiftRowRight([0xab, 0xcd], 0, true)).toEqual([0xab, 0xcd, 0xff]);
  });

  it('shifts ones into masks and zeros into bitmaps', () => {
    // A mask must not paint outside the sprite, so the vacated bits read as
    // transparent (1). A bitmap's vacated bits are blank (0).
    expect(shiftRowRight([0x00, 0x00], 3, true)[0]).toBe(0b1110_0000);
    expect(shiftRowRight([0x00, 0x00], 3, false)[0]).toBe(0b0000_0000);
  });

  it('carries bits across the byte boundary', () => {
    // The low bit of byte 0 must appear as the high bit of byte 1.
    const [, second] = shiftRowRight([0x01, 0x00], 1, false);
    expect(second).toBe(0x80);
  });

  it('widens a 24px sprite to four bytes', () => {
    expect(shiftRowRight([1, 2, 3], 2, false)).toHaveLength(4);
  });
});

describe('compositeByte', () => {
  it('draws the sprite where the foreground allows and the mask is clear', () => {
    // fg = $FF (nothing occludes), mask = 0 (sprite opaque) -> pure bitmap.
    expect(compositeByte(0xff, 0b1010_1010, 0x00, 0xff)).toBe(0b1010_1010);
  });

  it('keeps the screen where the sprite mask is set and the bitmap is blank', () => {
    // mask = $FF is fully transparent. Real sprite data has bitmap = 0 wherever
    // the mask is 1; the composite ORs the bitmap in regardless of the mask, so
    // the mask alone does not suppress pixels -- it only decides whether the
    // screen survives underneath.
    expect(compositeByte(0b1100_1100, 0x00, 0xff, 0xff)).toBe(0b1100_1100);
  });

  it('does not suppress a bitmap that contradicts its own mask', () => {
    // Documenting the actual behaviour rather than the intuitive one: mask = 1
    // with bitmap = 1 at the same pixel still draws. That combination never
    // occurs in the game's data, but the routine does not defend against it.
    expect(compositeByte(0b1100_1100, 0xff, 0xff, 0xff)).toBe(0xff);
  });

  it('keeps the screen where the foreground occludes', () => {
    // fg = 0 means scenery is in front: the sprite must not appear at all.
    expect(compositeByte(0b0011_0011, 0xff, 0x00, 0x00)).toBe(0b0011_0011);
  });

  it('mixes per bit', () => {
    // Left nibble permitted, right nibble occluded.
    const out = compositeByte(0b0000_1111, 0b1111_0000, 0x00, 0b1111_0000);
    expect(out).toBe(0b1111_1111);
  });

  it('never sets a bit the bitmap does not have where fg permits', () => {
    for (let screen = 0; screen < 256; screen += 17) {
      for (let bm = 0; bm < 256; bm += 23) {
        // Fully permitted, fully opaque: the result is exactly the bitmap.
        expect(compositeByte(screen, bm, 0x00, 0xff)).toBe(bm);
      }
    }
  });
});

describe('flipping', () => {
  it('reverses bits within a byte', () => {
    expect(reverseBits(0b1000_0000)).toBe(0b0000_0001);
    expect(reverseBits(0b1010_0000)).toBe(0b0000_0101);
    expect(reverseBits(0x00)).toBe(0x00);
    expect(reverseBits(0xff)).toBe(0xff);
  });

  it('is its own inverse', () => {
    for (let i = 0; i < 256; i++) expect(reverseBits(reverseBits(i))).toBe(i);
  });

  it('reverses byte order as well as bits', () => {
    // Mirroring a row needs both, or the sprite comes out in the wrong order.
    expect(flipRow([0b1000_0000, 0b0000_0001])).toEqual([0b1000_0000, 0b0000_0001]);
    expect(flipRow([0xf0, 0x00])).toEqual([0x00, 0x0f]);
  });
});

describe('plotMaskedSprite', () => {
  function blank() {
    const buffers = new GameWindowBuffers();
    buffers.pixels.fill(0x00);
    return buffers;
  }

  const solid = {
    bitmap: new Uint8Array([0xff, 0xff]),
    mask: new Uint8Array([0x00, 0x00]),
    widthBytes: 2,
    height: 1,
  };

  it('draws an opaque sprite into the window buffer', () => {
    const buffers = blank();
    const foreground = new Uint8Array(MASK_BUFFER_WIDTH * 8).fill(0xff);
    plotMaskedSprite({ pixels: buffers.pixels, foreground }, solid, {
      column: 4,
      row: 10,
      shift: 0,
      skipRows: 0,
      rows: 1,
    });
    expect(buffers.pixelByte(4, 10)).toBe(0xff);
    expect(buffers.pixelByte(5, 10)).toBe(0xff);
    expect(buffers.pixelByte(3, 10)).toBe(0x00); // untouched
  });

  it('is suppressed entirely where the foreground mask is clear', () => {
    const buffers = blank();
    const foreground = new Uint8Array(MASK_BUFFER_WIDTH * 8).fill(0x00);
    plotMaskedSprite({ pixels: buffers.pixels, foreground }, solid, {
      column: 4,
      row: 10,
      shift: 0,
      skipRows: 0,
      rows: 1,
    });
    expect(buffers.pixelByte(4, 10)).toBe(0x00);
    expect(buffers.pixelByte(5, 10)).toBe(0x00);
  });

  it('honours skipRows for sprites clipped at the top', () => {
    const tall = {
      bitmap: new Uint8Array([0x0f, 0x0f, 0xf0, 0xf0]),
      mask: new Uint8Array([0x00, 0x00, 0x00, 0x00]),
      widthBytes: 2,
      height: 2,
    };
    const buffers = blank();
    const foreground = new Uint8Array(MASK_BUFFER_WIDTH * 8).fill(0xff);
    plotMaskedSprite({ pixels: buffers.pixels, foreground }, tall, {
      column: 2,
      row: 0,
      shift: 0,
      skipRows: 1, // drop the first sprite row
      rows: 1,
    });
    expect(buffers.pixelByte(2, 0)).toBe(0xf0); // the SECOND row's data
  });

  it('clips at the right-hand edge instead of wrapping', () => {
    const buffers = blank();
    const foreground = new Uint8Array(MASK_BUFFER_WIDTH * 8).fill(0xff);
    plotMaskedSprite({ pixels: buffers.pixels, foreground }, solid, {
      column: WINDOW_STRIDE - 1,
      row: 5,
      shift: 0,
      skipRows: 0,
      rows: 1,
    });
    expect(buffers.pixelByte(WINDOW_STRIDE - 1, 5)).toBe(0xff);
    // Nothing may have spilled onto the next row's first byte.
    expect(buffers.pixelByte(0, 6)).toBe(0x00);
  });
});
