/**
 * vischar_visible (c$BAF7): the five clip cases per axis.
 *
 * The routine's header names them: (A) off the left/top, (B) clipped on the
 * left/top, (C) fully visible, (D) clipped on the right/bottom, (E) off the
 * right/bottom.
 */

import { describe, expect, it } from 'vitest';

import { clippedBufferRow, vischarVisible, type ClipSubject } from '../src/render/clip.js';
import { BUFFER_ROWS, WINDOW_COLS } from '../src/render/window.js';

const map = { x: 40, y: 40 };

/** A 16px-wide, 27-row sprite: width_bytes + 1 is 3, as the vischar stores it. */
function subject(over: Partial<ClipSubject> = {}): ClipSubject {
  return {
    isoXBytes: map.x + 10,
    isoYPixels: map.y * 8 + 40,
    widthBytesPlusOne: 3,
    height: 27,
    ...over,
  };
}

describe('horizontal clipping', () => {
  it('(C) draws the whole sprite when it fits', () => {
    const r = vischarVisible(subject(), map);
    expect(r.visible).toBe(true);
    expect(r.leftSkip).toBe(0);
    expect(r.clippedWidth).toBe(3);
  });

  it('(E) rejects a sprite at or beyond the right edge', () => {
    // available_right == 0 fails too: $BB00 jumps on Z as well as C.
    expect(vischarVisible(subject({ isoXBytes: map.x + WINDOW_COLS }), map).visible).toBe(
      false,
    );
    expect(
      vischarVisible(subject({ isoXBytes: map.x + WINDOW_COLS + 5 }), map).visible,
    ).toBe(false);
  });

  it('(D) narrows a sprite running off the right', () => {
    // Two bytes of room left: draw two, skip nothing.
    const r = vischarVisible(subject({ isoXBytes: map.x + WINDOW_COLS - 2 }), map);
    expect(r.visible).toBe(true);
    expect(r.leftSkip).toBe(0);
    expect(r.clippedWidth).toBe(2);
  });

  it('(A) rejects a sprite at or beyond the left edge', () => {
    // The sprite's RIGHT edge is what is tested, and zero fails ($BB19).
    expect(vischarVisible(subject({ isoXBytes: map.x - 3 }), map).visible).toBe(false);
    expect(vischarVisible(subject({ isoXBytes: map.x - 9 }), map).visible).toBe(false);
  });

  it('(B) skips into a sprite running off the left', () => {
    // Right edge one byte past the window's left edge: draw 1, skip 2.
    const r = vischarVisible(subject({ isoXBytes: map.x - 2 }), map);
    expect(r.visible).toBe(true);
    expect(r.clippedWidth).toBe(1);
    expect(r.leftSkip).toBe(2);
  });

  it('the skip and the width always account for the whole sprite', () => {
    for (let x = map.x - 4; x < map.x + WINDOW_COLS + 4; x++) {
      const r = vischarVisible(subject({ isoXBytes: x }), map);
      if (!r.visible) continue;
      expect(r.leftSkip + r.clippedWidth, `x ${x}`).toBeLessThanOrEqual(3);
      expect(r.clippedWidth).toBeGreaterThan(0);
    }
  });
});

describe('vertical clipping', () => {
  const top = map.y * 8;
  const bottom = (map.y + BUFFER_ROWS) * 8;

  it('(C) draws the whole sprite when it fits', () => {
    const r = vischarVisible(subject(), map);
    expect(r.topSkip).toBe(0);
    expect(r.clippedHeight).toBe(27);
  });

  it('(E) rejects a sprite at or below the bottom edge', () => {
    expect(vischarVisible(subject({ isoYPixels: bottom }), map).visible).toBe(false);
    expect(vischarVisible(subject({ isoYPixels: bottom + 20 }), map).visible).toBe(false);
  });

  it('(D) shortens a sprite running off the bottom', () => {
    const r = vischarVisible(subject({ isoYPixels: bottom - 10 }), map);
    expect(r.visible).toBe(true);
    expect(r.topSkip).toBe(0);
    expect(r.clippedHeight).toBe(10);
  });

  it('(A) rejects a sprite at or above the top edge', () => {
    expect(vischarVisible(subject({ isoYPixels: top - 27 }), map).visible).toBe(false);
    expect(vischarVisible(subject({ isoYPixels: top - 50 }), map).visible).toBe(false);
  });

  it('(B) skips into a sprite running off the top', () => {
    // Bottom edge 7 rows below the window top: draw 7, skip 20.
    const r = vischarVisible(subject({ isoYPixels: top - 20 }), map);
    expect(r.visible).toBe(true);
    expect(r.clippedHeight).toBe(7);
    expect(r.topSkip).toBe(20);
  });

  it('rejects results that would wrap a byte', () => {
    // $BB4D and $BB78 guard against a 16-bit difference of 256 or more, which
    // would read as a small value once truncated.
    expect(vischarVisible(subject({ isoYPixels: top - 400 }), map).visible).toBe(false);
  });

  it('uses 17 rows, the buffer height, not the 16 displayed', () => {
    // $BB36 adds 17. A sprite in the 17th row is clipped, not rejected.
    const inSlack = vischarVisible(subject({ isoYPixels: (map.y + 16) * 8 + 4 }), map);
    expect(inSlack.visible).toBe(true);
  });
});

describe('clipped sprites start at buffer row 0', () => {
  it('places a top-clipped sprite at row 0, not a negative row', () => {
    // $DC9F..$DCA5: with a top skip the Y computation is skipped entirely and
    // "the sprite always starts at top of the screen".
    expect(clippedBufferRow(20, 5, 40)).toBe(0);
  });

  it('computes the tile-aligned row when nothing is clipped', () => {
    expect(clippedBufferRow(0, 45, 40)).toBe(40);
  });
});

describe('both axes together', () => {
  it('rejects when either axis rejects', () => {
    // A sprite off the right is invisible regardless of a fine vertical fit.
    expect(
      vischarVisible(subject({ isoXBytes: map.x + WINDOW_COLS + 1 }), map).visible,
    ).toBe(false);
    expect(vischarVisible(subject({ isoYPixels: map.y * 8 - 100 }), map).visible).toBe(
      false,
    );
  });

  it('clips both axes at once in a corner', () => {
    const r = vischarVisible(
      subject({ isoXBytes: map.x - 2, isoYPixels: map.y * 8 - 20 }),
      map,
    );
    expect(r.visible).toBe(true);
    expect(r.leftSkip).toBeGreaterThan(0);
    expect(r.topSkip).toBeGreaterThan(0);
  });

  it('is visible across the whole window interior', () => {
    let visible = 0;
    for (let x = map.x; x < map.x + WINDOW_COLS - 3; x++) {
      for (let y = map.y * 8; y < (map.y + BUFFER_ROWS) * 8 - 27; y += 4) {
        if (vischarVisible(subject({ isoXBytes: x, isoYPixels: y }), map).visible) {
          visible++;
        }
      }
    }
    expect(visible).toBeGreaterThan(0);
  });
});
