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

  it('places vertically in whole tile rows', () => {
    // $DCA7..$DCBA: (iso_pos_y - map_position_y) * 192, where iso_pos_y is the
    // /8 value and 192 bytes of a 24-wide buffer is 8 pixel rows. So every
    // placement lands on a multiple of 8.
    for (let y = 500; y < 700; y += 2) {
      const p = windowPlacement({ x: 800, y, height: 24 }, map);
      // Math.abs because -0 % 8 is -0, which Object.is distinguishes from 0.
      expect(Math.abs(p.pixelRow % 8), `world y ${y}`).toBe(0);
    }
  });

  it('does not slide the sprite against its tile-granular mask', () => {
    // Pixel-granular placement would look more precise but shifts the sprite up
    // to 7 pixels relative to the foreground mask, which is built in tile rows.
    // The result is a sprite shredded incoherently by its own occlusion mask.
    const pos = { x: 800, y: 564, height: 24 };
    const iso = isoPlacement(pos);
    const place = windowPlacement(pos, map);

    const tileGranular = ((iso.pixelRow >> 3) - map.y) * 8;
    const pixelGranular = iso.pixelRow - map.y * 8;

    expect(place.pixelRow).toBe(tileGranular);
    // At this position the two genuinely differ, so the test is not vacuous.
    expect(pixelGranular).not.toBe(tileGranular);
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
