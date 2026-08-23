/**
 * Boundary checks: bounds_check, interior_bounds_check, within_camp_bounds.
 */

import { describe, expect, it } from 'vitest';

import {
  BYTE7_Y_DOMINANT,
  boundsCheck,
  interiorBoundsCheck,
  outdoorBoundsCheck,
  permittedBounds,
  roomDimensions,
  toggleYDominant,
  walls,
  withinCampBounds,
} from '../src/game/bounds.js';

describe('extracted boundary data', () => {
  it('has the 24 walls the routine iterates over', () => {
    // $B153 LD B,$18 -- 24 iterations, one per wall definition.
    expect(walls.length).toBe(24);
  });

  it('has the three permitted areas the index range allows', () => {
    // within_camp_bounds takes "Index (0..2) into permitted_bounds[]".
    expect(permittedBounds.length).toBe(3);
  });

  it('has ten room dimension entries', () => {
    expect(roomDimensions.length).toBe(10);
  });

  it('stores room dimensions in the unusual x1, x0, y1, y0 order', () => {
    // The routine's own comment at $B2AC flags this. In every entry the
    // "x1"/"y1" field is the larger of its pair, which is what proves the
    // field order rather than the naming.
    for (const d of roomDimensions) {
      expect(d.x1).toBeGreaterThan(d.x0);
      expect(d.y1).toBeGreaterThan(d.y0);
    }
  });
});

describe('outdoor bounds_check (c$B14C)', () => {
  it('blocks a position squarely inside a wall volume', () => {
    const w = walls[0]!; // Hut 0: x 106-110, y 82-98, h 0-11
    const pos = {
      x: w.minx * 8 + 8,
      y: w.miny * 8 + 8,
      height: w.minh * 8,
    };
    const r = outdoorBoundsCheck(pos);
    expect(r.blocked).toBe(true);
    expect(r.hit).toBe(0);
  });

  it('allows a position clear of every wall', () => {
    // Far corner of the map, well away from the camp buildings.
    expect(outdoorBoundsCheck({ x: 8, y: 8, height: 0 }).blocked).toBe(false);
  });

  it('applies the asymmetric x margins', () => {
    const w = walls[0]!;
    const y = w.miny * 8 + 8;
    const h = w.minh * 8;
    // x lower edge is minx*8 + 2: one below is clear, at the edge is blocked.
    expect(outdoorBoundsCheck({ x: w.minx * 8 + 1, y, height: h }).hit).not.toBe(0);
    expect(outdoorBoundsCheck({ x: w.minx * 8 + 2, y, height: h }).hit).toBe(0);
    // x upper edge is maxx*8 + 4, exclusive.
    expect(outdoorBoundsCheck({ x: w.maxx * 8 + 3, y, height: h }).hit).toBe(0);
    expect(outdoorBoundsCheck({ x: w.maxx * 8 + 4, y, height: h }).hit).not.toBe(0);
  });

  it('applies the height limits, so walking over a low wall is possible', () => {
    const w = walls[0]!;
    const x = w.minx * 8 + 8;
    const y = w.miny * 8 + 8;
    // Above maxh*8 + 2 the wall no longer blocks.
    expect(outdoorBoundsCheck({ x, y, height: w.maxh * 8 + 1 }).hit).toBe(0);
    expect(outdoorBoundsCheck({ x, y, height: w.maxh * 8 + 2 }).hit).not.toBe(0);
  });
});

describe('interior_bounds_check (c$B29F)', () => {
  const state = { boundsIndex: 0, objectBounds: [] };
  const dims = roomDimensions[0]!;

  const inside = {
    x: Math.floor((dims.x0 + 4 + dims.x1) / 2),
    y: Math.floor((dims.y0 + dims.y1 - 4) / 2),
    height: 0,
  };

  it('allows a position in the middle of the room', () => {
    expect(interiorBoundsCheck(inside, state).blocked).toBe(false);
  });

  it('blocks beyond each of the four room edges', () => {
    expect(interiorBoundsCheck({ ...inside, x: dims.x1 + 1 }, state).blocked).toBe(true);
    expect(interiorBoundsCheck({ ...inside, x: dims.x0 + 4 }, state).blocked).toBe(true);
    expect(interiorBoundsCheck({ ...inside, y: dims.y1 - 3 }, state).blocked).toBe(true);
    expect(interiorBoundsCheck({ ...inside, y: dims.y0 }, state).blocked).toBe(true);
  });

  it('blocks on furniture, and only inside it', () => {
    const box = { x0: inside.x - 2, x1: inside.x + 2, y0: inside.y - 2, y1: inside.y + 2 };
    const withFurniture = { boundsIndex: 0, objectBounds: [box] };

    expect(interiorBoundsCheck(inside, withFurniture).blocked).toBe(true);
    expect(interiorBoundsCheck(inside, withFurniture).hit).toBe(0);
    // The upper bound is exclusive.
    expect(
      interiorBoundsCheck({ ...inside, x: box.x1 }, withFurniture).blocked,
    ).toBe(false);
  });

  it('compares only the low byte, as the routine does', () => {
    // Indoors the coordinates fit in a byte; the routine reads (HL) directly.
    const high = { ...inside, x: inside.x + 0x100 };
    expect(interiorBoundsCheck(high, state).blocked).toBe(
      interiorBoundsCheck(inside, state).blocked,
    );
  });
});

describe('bounds_check dispatch', () => {
  it('uses the interior routine for any non-zero room', () => {
    // $B14F AND A / JP NZ $B29F
    const state = { boundsIndex: 0, objectBounds: [] };
    const dims = roomDimensions[0]!;
    const pos = { x: dims.x1 + 1, y: 0, height: 0 };
    expect(boundsCheck(pos, 1, state).blocked).toBe(true);
  });

  it('uses the wall table outdoors', () => {
    expect(boundsCheck({ x: 8, y: 8, height: 0 }, 0).blocked).toBe(false);
  });

  it('requires interior state when indoors', () => {
    expect(() => boundsCheck({ x: 0, y: 0, height: 0 }, 5)).toThrow();
  });
});

describe('Y_DOMINANT toggle', () => {
  it('flips bit 5 and leaves the rest alone', () => {
    // $B1AF / $B2E7: XOR $20. Repeatedly hitting a wall alternates the
    // character's preferred axis, which is how they slide along it.
    expect(toggleYDominant(0x00)).toBe(BYTE7_Y_DOMINANT);
    expect(toggleYDominant(BYTE7_Y_DOMINANT)).toBe(0x00);
    expect(toggleYDominant(0x8f)).toBe(0xaf);
    expect(toggleYDominant(toggleYDominant(0x5a))).toBe(0x5a);
  });
});

describe('within_camp_bounds (c$A01A)', () => {
  it('accepts a position inside an area', () => {
    const b = permittedBounds[0]!;
    expect(withinCampBounds(0, { x: b.x0 + 1, y: b.y0 + 1 })).toBe(true);
  });

  it('treats the lower bound as inclusive and the upper as exclusive', () => {
    const b = permittedBounds[1]!;
    expect(withinCampBounds(1, { x: b.x0, y: b.y0 })).toBe(true);
    expect(withinCampBounds(1, { x: b.x0 - 1, y: b.y0 })).toBe(false);
    expect(withinCampBounds(1, { x: b.x1, y: b.y0 })).toBe(false);
    expect(withinCampBounds(1, { x: b.x1 - 1, y: b.y1 - 1 })).toBe(true);
  });

  it('rejects an unknown area index', () => {
    expect(() => withinCampBounds(3, { x: 0, y: 0 })).toThrow();
  });
});
