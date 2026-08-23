/**
 * Coordinate systems and the isometric projection.
 *
 * calc_vischar_iso_pos_from_state (c$B729) is checked against a literal
 * transcription of its SBC chain, so the borrow propagation is verified rather
 * than assumed to be irrelevant.
 */

import { describe, expect, it } from 'vitest';

import {
  DIRECTION_BOTTOM_LEFT,
  DIRECTION_CRAWL,
  DIRECTION_TOP_LEFT,
  VISCHAR,
  VISCHAR_BASE,
  VISCHAR_SIZE,
  calcIsoPos,
  directionOf,
  fromTinyPos,
  isCrawling,
  toTinyPos,
  vischarFieldPointer,
} from '../src/game/coords.js';

/** $B743..$B753 executed literally, carry included. */
function z80IsoY(x: number, y: number, height: number): number {
  let hl = 0x0800;
  let carry = 0; // $B746 AND A clears it

  for (const operand of [x, height, y]) {
    const result = hl - operand - carry;
    carry = result < 0 ? 1 : 0;
    hl = result & 0xffff;
  }
  return hl;
}

/** $B72E..$B73C executed literally. */
function z80IsoX(x: number, y: number): number {
  const hl = (y + 0x200) & 0xffff;
  const diff = (hl - x) & 0xffff;
  return (diff * 2) & 0xffff;
}

describe('calc_vischar_iso_pos (c$B729)', () => {
  it('matches the instruction sequence over a wide sample', () => {
    for (let x = 0; x < 0x900; x += 37) {
      for (let y = 0; y < 0x900; y += 53) {
        for (const h of [0, 8, 24, 0x100]) {
          const got = calcIsoPos({ x, y, height: h });
          expect(got.x, `x at (${x},${y},${h})`).toBe(z80IsoX(x, y));
          expect(got.y, `y at (${x},${y},${h})`).toBe(z80IsoY(x, y, h));
        }
      }
    }
  });

  it('implements the documented formulae', () => {
    // "Set vischar.iso_pos.x to ($200 - saved_pos_x + saved_pos_y) * 2"
    const p = { x: 0x100, y: 0x080, height: 0 };
    expect(calcIsoPos(p).x).toBe((0x200 - 0x100 + 0x080) * 2);
    // "Set vischar.iso_pos_y = $800 - saved_pos_x - saved_pos_y - saved_height"
    expect(calcIsoPos({ x: 0x100, y: 0x080, height: 0x18 }).y).toBe(
      0x800 - 0x100 - 0x080 - 0x18,
    );
  });

  it('moves along the two screen diagonals as the axes describe', () => {
    const origin = calcIsoPos({ x: 0x200, y: 0x200, height: 0 });
    // Increasing x moves toward the top left: screen x decreases, y decreases.
    const alongX = calcIsoPos({ x: 0x208, y: 0x200, height: 0 });
    expect(alongX.x).toBeLessThan(origin.x);
    expect(alongX.y).toBeLessThan(origin.y);
    // Increasing y moves toward the top right: screen x increases, y decreases.
    const alongY = calcIsoPos({ x: 0x200, y: 0x208, height: 0 });
    expect(alongY.x).toBeGreaterThan(origin.x);
    expect(alongY.y).toBeLessThan(origin.y);
  });

  it('raises the sprite on screen as height increases', () => {
    // Height only affects the vertical axis, and more height means further up.
    const low = calcIsoPos({ x: 0x200, y: 0x200, height: 0 });
    const high = calcIsoPos({ x: 0x200, y: 0x200, height: 0x18 });
    expect(high.x).toBe(low.x);
    expect(high.y).toBe(low.y - 0x18);
  });

  it('propagates the borrow through the chained subtractions', () => {
    // x alone exceeds $800, so the first SBC borrows and the next subtracts an
    // extra 1. Plain subtraction would give a different answer.
    const x = 0x900;
    const y = 0x10;
    const h = 0x10;
    const naive = (0x800 - x - h - y) & 0xffff;
    const actual = calcIsoPos({ x, y, height: h }).y;
    expect(actual).toBe(z80IsoY(x, y, h));
    expect(actual).not.toBe(naive);
  });
});

describe('pos <-> tinypos', () => {
  it('scales by 8 with rounding', () => {
    expect(toTinyPos({ x: 0, y: 0, height: 0 })).toEqual({ x: 0, y: 0, height: 0 });
    expect(toTinyPos({ x: 800, y: 872, height: 24 })).toEqual({
      x: 100,
      y: 109,
      height: 3,
    });
  });

  it('round-trips only when the pos is a multiple of 8', () => {
    const exact = { x: 64, y: 128, height: 24 };
    expect(fromTinyPos(toTinyPos(exact))).toEqual(exact);
    // 12 rounds to 2, which scales back to 16 -- the conversion is lossy.
    expect(fromTinyPos(toTinyPos({ x: 12, y: 0, height: 0 })).x).toBe(16);
  });
});

describe('vischar layout', () => {
  it('matches the struct table in the disassembly header', () => {
    expect(VISCHAR_SIZE).toBe(32);
    expect(VISCHAR.character).toBe(0x00);
    expect(VISCHAR.route).toBe(0x02);
    expect(VISCHAR.mi).toBe(0x0f);
    expect(VISCHAR.isoPos).toBe(0x18);
    expect(VISCHAR.room).toBe(0x1c);
    // The header's per-field notes name these addresses for vischar 0.
    expect(VISCHAR_BASE + VISCHAR.direction).toBe(0x800e);
    expect(VISCHAR_BASE + VISCHAR.mi).toBe(0x800f);
    expect(VISCHAR_BASE + VISCHAR.room).toBe(0x801c);
  });

  it('field pointers wrap within the page, as $B72A does', () => {
    // Eight 32-byte vischars occupy $8000..$80FF, so this never bites in
    // practice -- but the shortcut is real and is modelled.
    expect(vischarFieldPointer(0x80e0, VISCHAR.isoPos)).toBe(0x80f8);
    expect(vischarFieldPointer(0x80f0, 0x18)).toBe(0x8008); // wraps, no carry
  });
});

describe('direction field', () => {
  it('isolates direction from the crawl flag', () => {
    expect(directionOf(DIRECTION_TOP_LEFT)).toBe(0);
    expect(directionOf(DIRECTION_BOTTOM_LEFT)).toBe(3);
    expect(directionOf(DIRECTION_BOTTOM_LEFT | DIRECTION_CRAWL)).toBe(3);
    expect(isCrawling(DIRECTION_BOTTOM_LEFT)).toBe(false);
    expect(isCrawling(DIRECTION_BOTTOM_LEFT | DIRECTION_CRAWL)).toBe(true);
  });

  it('matches the constants block: 4..7 are the crawling directions', () => {
    // "$04 -> character faces top left (crawling)" etc.
    for (let d = 0; d < 4; d++) {
      expect(directionOf(d + 4)).toBe(d);
      expect(isCrawling(d + 4)).toBe(true);
    }
  });
});
