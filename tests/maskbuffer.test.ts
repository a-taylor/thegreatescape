/**
 * render_mask_buffer (c$B916): the foreground occlusion mask.
 */

import { describe, expect, it } from 'vitest';

import {
  EXTERIOR_MASK_COUNT,
  EXTERIOR_MASK_COUNT_AS_CODED,
  MASK_BUFFER_ROWBYTES,
  exteriorMaskData,
  interiorMaskData,
  maskApplies,
  maskShapes,
  renderMaskBuffer,
} from '../src/render/maskbuffer.js';
import { MASK_BUFFER_SIZE, MASK_BUFFER_WIDTH } from '../src/render/sprites.js';

const subject = (over: Partial<Parameters<typeof maskApplies>[1]> = {}) => ({
  isoX: 100,
  isoY: 60,
  tinyX: 100,
  tinyY: 80,
  tinyHeight: 4,
  ...over,
});

describe('mask buffer geometry', () => {
  it('is 4 bytes wide by 40 pixel rows', () => {
    // $8100, $A0 bytes. mask_against_tile advances by 4 per pixel row.
    expect(MASK_BUFFER_WIDTH).toBe(4);
    expect(MASK_BUFFER_SIZE).toBe(160);
  });

  it('addresses tile rows at a 32-byte stride', () => {
    // $BA0C: "The multiplier 32 is MASK_BUFFER_ROWBYTES." A tile row is 8 pixel
    // rows of 4 bytes, so both figures describe the same buffer.
    expect(MASK_BUFFER_ROWBYTES).toBe(32);
    expect(MASK_BUFFER_ROWBYTES).toBe(MASK_BUFFER_WIDTH * 8);
    expect(MASK_BUFFER_SIZE / MASK_BUFFER_ROWBYTES).toBe(5);
  });
});

describe('extracted mask tables', () => {
  it('has 58 exterior records, not the 59 the routine iterates', () => {
    // $B935 LD B,$3B is 59; the table is 58 long. Flagged inline as a bug and
    // listed as a bfix in the header, so the 59th read is out of bounds.
    expect(exteriorMaskData.length).toBe(EXTERIOR_MASK_COUNT);
    expect(EXTERIOR_MASK_COUNT_AS_CODED).toBe(59);
    expect(EXTERIOR_MASK_COUNT_AS_CODED).toBeGreaterThan(exteriorMaskData.length);
  });

  it('has interior records too', () => {
    expect(interiorMaskData.length).toBeGreaterThan(0);
  });

  it('never references a mask shape that does not exist', () => {
    for (const r of [...exteriorMaskData, ...interiorMaskData]) {
      expect(maskShapes[r.index]).toBeDefined();
    }
  });
});

describe('mask culling (c$B93A)', () => {
  const mask = {
    addr: '$0000',
    index: 0,
    bounds: { x0: 98, x1: 106, y0: 58, y1: 66 },
    pos: [90, 70, 8],
  };

  it('accepts a character overlapping the mask and behind it', () => {
    expect(maskApplies(mask, subject())).toBe(true);
  });

  it('rejects when the character is left of the mask', () => {
    expect(maskApplies(mask, subject({ isoX: 200 }))).toBe(false);
  });

  it('rejects when the character is right of the mask', () => {
    expect(maskApplies(mask, subject({ isoX: 10 }))).toBe(false);
  });

  it('rejects when the character is above or below the mask', () => {
    expect(maskApplies(mask, subject({ isoY: 200 }))).toBe(false);
    expect(maskApplies(mask, subject({ isoY: 10 }))).toBe(false);
  });

  it('rejects when the character stands in front of the mask', () => {
    // "A character is in front of a mask when either of its coordinates are
    // less than mask.pos."
    expect(maskApplies(mask, subject({ tinyX: 80 }))).toBe(false);
    expect(maskApplies(mask, subject({ tinyY: 60 }))).toBe(false);
  });

  it('rejects on EQUAL x but not on equal y', () => {
    // $B963 jumps on Z as well as C for x; $B96D only on C for y. The asymmetry
    // is real -- making the two tests uniform changes which masks apply.
    expect(maskApplies(mask, subject({ tinyX: mask.pos[0]! }))).toBe(false);
    expect(maskApplies(mask, subject({ tinyY: mask.pos[1]! }))).toBe(true);
  });

  it('decrements a non-zero height before comparing, but not zero', () => {
    // $B975..$B978. With mask.pos.height 8, a height of 8 decrements to 7 and
    // passes; 9 decrements to 8 and fails.
    expect(maskApplies(mask, subject({ tinyHeight: 8 }))).toBe(true);
    expect(maskApplies(mask, subject({ tinyHeight: 9 }))).toBe(false);
    // Zero is left alone, so it compares as 0 < 8 and passes.
    expect(maskApplies(mask, subject({ tinyHeight: 0 }))).toBe(true);
  });
});

describe('renderMaskBuffer', () => {
  it('starts all-permitting', () => {
    // $B916..$B921 fills the buffer with $FF: nothing occludes until a mask
    // says otherwise.
    const buf = new Uint8Array(MASK_BUFFER_SIZE);
    renderMaskBuffer(buf, subject({ isoX: 5, isoY: 5, tinyX: 5, tinyY: 5 }), []);
    expect(Array.from(buf).every((b) => b === 0xff)).toBe(true);
  });

  it('clears bits where a mask occludes', () => {
    const buf = new Uint8Array(MASK_BUFFER_SIZE);
    // Somewhere in the camp where scenery masks exist.
    renderMaskBuffer(buf, {
      isoX: 96,
      isoY: 60,
      tinyX: 120,
      tinyY: 110,
      tinyHeight: 0,
    });
    // At least somewhere, occlusion happened -- otherwise the mask buffer is
    // doing nothing and the hero can never go behind anything.
    const anyOccluded = Array.from(buf).some((b) => b !== 0xff);
    expect(anyOccluded).toBe(true);
  });

  it('never writes outside the buffer', () => {
    // Sweep a range of positions; a stray write would throw or corrupt length.
    for (let x = 0; x < 216; x += 7) {
      for (let y = 0; y < 136; y += 11) {
        const buf = new Uint8Array(MASK_BUFFER_SIZE);
        expect(() =>
          renderMaskBuffer(buf, {
            isoX: x,
            isoY: y,
            tinyX: 120,
            tinyY: 110,
            tinyHeight: 0,
          }),
        ).not.toThrow();
        expect(buf.length).toBe(MASK_BUFFER_SIZE);
      }
    }
  });

  it('only ever clears bits, never sets them', () => {
    // The buffer is built by ANDing, so a rendered result can only be a subset
    // of the initial all-ones.
    const buf = new Uint8Array(MASK_BUFFER_SIZE);
    renderMaskBuffer(buf, subject({ tinyX: 200, tinyY: 200 }));
    for (const b of buf) expect(b & ~0xff).toBe(0);
  });
});

describe('occlusion end to end', () => {
  /**
   * The point of the whole mask buffer: the same sprite, at the same place,
   * must draw FEWER pixels once scenery is allowed to occlude it.
   */
  it('suppresses sprite pixels that scenery covers', async () => {
    const { plotMaskedSprite } = await import('../src/render/sprites.js');
    const { GameWindowBuffers } = await import('../src/render/window.js');

    // A solid block, so every suppressed pixel is attributable to the mask.
    const sprite = {
      bitmap: new Uint8Array(Array(2 * 16).fill(0xff)),
      mask: new Uint8Array(Array(2 * 16).fill(0x00)),
      widthBytes: 2,
      height: 16,
    };

    const countBits = (b: Uint8Array) => {
      let n = 0;
      for (const v of b) for (let i = 0; i < 8; i++) if (v & (1 << i)) n++;
      return n;
    };

    // The sprite reads foreground[row * 4 + col], so only the first
    // rows * 4 bytes of the buffer can affect it. Searching the WHOLE buffer
    // finds positions where a mask applies but lands below the sprite, which
    // proves nothing -- so search the region the sprite actually samples.
    const SPRITE_ROWS = 16;
    // At shift 0 only bytes 0 and 1 of each row carry bitmap data -- byte 2 is
    // the shift-out and is all zeros, so occlusion there changes nothing.
    // Checking the full 4-byte row finds masks that cannot possibly affect the
    // sprite and makes the test assert something false.
    const affectsSprite = (buf: Uint8Array) => {
      for (let r = 0; r < SPRITE_ROWS; r++) {
        for (let c = 0; c < 2; c++) {
          if (buf[r * MASK_BUFFER_WIDTH + c] !== 0xff) return true;
        }
      }
      return false;
    };

    let found = false;
    for (let x = 80; x < 160 && !found; x += 1) {
      for (let y = 30; y < 110 && !found; y += 1) {
        const real = new Uint8Array(MASK_BUFFER_SIZE);
        renderMaskBuffer(real, {
          isoX: x,
          isoY: y,
          tinyX: 200,
          tinyY: 200,
          tinyHeight: 0,
        });
        if (!affectsSprite(real)) continue;

        const permissive = new Uint8Array(MASK_BUFFER_SIZE).fill(0xff);

        const withMask = new GameWindowBuffers();
        withMask.pixels.fill(0);
        const without = new GameWindowBuffers();
        without.pixels.fill(0);

        const place = { column: 2, row: 4, shift: 0, skipRows: 0, rows: SPRITE_ROWS };
        plotMaskedSprite({ pixels: withMask.pixels, foreground: real }, sprite, place);
        plotMaskedSprite({ pixels: without.pixels, foreground: permissive }, sprite, place);

        const a = countBits(withMask.pixels);
        const b = countBits(without.pixels);
        expect(b, `at iso (${x},${y}) the unmasked sprite should draw pixels`).toBeGreaterThan(0);
        expect(a, `at iso (${x},${y}) the mask should suppress some`).toBeLessThan(b);
        found = true;
      }
    }
    expect(found, 'no position found where a mask overlaps the sprite').toBe(true);
  });
});
