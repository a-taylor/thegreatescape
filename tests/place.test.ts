/**
 * Placing a character in the game window.
 *
 * The asymmetry between the axes is the whole point of these tests: horizontal
 * placement is byte-granular with a sub-byte shift on top, vertical placement
 * is whole tile rows with no sub-tile component at all.
 */

import { describe, expect, it } from 'vitest';

import { tinyposStash, toTinyPos } from '../src/game/coords.js';
import { isoPlacement, windowPlacement } from '../src/render/place.js';

describe('windowPlacement', () => {
  const map = { x: 57, y: 74 };

  it('places CHARACTERS at pixel granularity, not whole tile rows', () => {
    // setup_vischar_plotting ($E4EB) multiplies by 24 -- one row of a 24-wide
    // buffer, i.e. a single pixel row. setup_ITEM_plotting ($DCA7) multiplies
    // by 192 instead and so quantises items to tiles. Using the item rule for a
    // character makes him move in 8-pixel steps, which the map scroll hides
    // outdoors but which is plainly visible indoors.
    const seen = new Set<number>();
    for (let y = 500; y < 700; y += 2) {
      seen.add(windowPlacement({ x: 800, y, height: 24 }, map).pixelRow % 8);
    }
    expect(seen.size, 'placement should not be a multiple of 8').toBeGreaterThan(1);
  });

  it('is exactly iso_pos.y minus the window origin in pixels', () => {
    const pos = { x: 800, y: 564, height: 24 };
    const iso = isoPlacement(pos);
    expect(windowPlacement(pos, map).pixelRow).toBe(iso.pixelRow - map.y * 8);
  });

  it('moves one pixel row per pixel of iso_pos.y', () => {
    // The property that matters: no quantisation, so walking is smooth.
    const a = windowPlacement({ x: 800, y: 564, height: 24 }, map);
    const b = windowPlacement({ x: 800, y: 566, height: 24 }, map);
    expect(Math.abs(a.pixelRow - b.pixelRow)).toBe(2);
  });

  it('places horizontally in bytes, with the shift carried separately', () => {
    // $DCBC is byte-granular; the sub-byte offset reaches the plotter as
    // iso_pos.x & 7 ($E2A2), not as part of the column.
    const pos = { x: 803, y: 561, height: 24 };
    const iso = isoPlacement(pos);
    const place = windowPlacement(pos, map);
    expect(place.column).toBe(iso.column - map.x);
    expect(place.shift).toBe(iso.shift);
    expect(place.shift).toBeGreaterThanOrEqual(0);
    expect(place.shift).toBeLessThan(8);
  });
});

describe('tinypos_stash vs pos_to_tinypos', () => {
  it('rounds x but truncates y and height', () => {
    // setup_vischar_plotting: $E43B calls divide_by_8_with_rounding for x,
    // $E446 calls divide_by_8 for y and height. pos_to_tinypos rounds all
    // three, so the two are NOT interchangeable.
    const pos = { x: 12, y: 12, height: 12 };
    expect(toTinyPos(pos)).toEqual({ x: 2, y: 2, height: 2 });
    expect(tinyposStash(pos)).toEqual({ x: 2, y: 1, height: 1 });
  });

  it('agrees with pos_to_tinypos on exact multiples of 8', () => {
    const pos = { x: 800, y: 564, height: 24 };
    expect(tinyposStash(pos).x).toBe(toTinyPos(pos).x);
    // 564 is not a multiple of 8: rounding gives 71, truncation gives 70.
    expect(toTinyPos(pos).y).toBe(71);
    expect(tinyposStash(pos).y).toBe(70);
  });

  it('copies bytes unscaled indoors', () => {
    // $E42D: indoors the routine narrows without scaling.
    expect(tinyposStash({ x: 50, y: 60, height: 24 }, false)).toEqual({
      x: 50,
      y: 60,
      height: 24,
    });
  });
});
