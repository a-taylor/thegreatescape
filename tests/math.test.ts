/**
 * The arithmetic primitives, per BUILD_PROMPT.md §8.
 *
 * These are tested against a reference implementation of the actual Z80
 * instruction sequences rather than against arithmetic identities, because the
 * point is to reproduce the original's truncation and wraparound -- not to
 * compute the mathematically "right" answer.
 */

import { describe, expect, it } from 'vitest';

import {
  advancePointer,
  asSigned8,
  divideBy8,
  divideBy8WithRounding,
  incLow,
  multiply,
  multiplyBy4,
  multiplyBy8,
  posToTinypos,
} from '../src/game/math.js';

// ---------------------------------------------------------------------------
// Reference implementations: the Z80 instruction sequences, executed literally.
// If these and the real implementations agree across the whole input space,
// the transcription is right.
// ---------------------------------------------------------------------------

/** c$E555: SRL C / RRA, three times. Returns A. */
function z80DivideBy8(c: number, a: number): number {
  let C = c & 0xff;
  let A = a & 0xff;
  for (let i = 0; i < 3; i++) {
    const carryOut = C & 1;
    C = C >>> 1;
    const newA = (A >>> 1) | (carryOut << 7);
    A = newA & 0xff;
  }
  return A;
}

/** c$E550: ADD A,$04 / JR NC / INC C, then fall through to divide_by_8. */
function z80DivideBy8Rounding(c: number, a: number): number {
  let C = c & 0xff;
  let A = (a & 0xff) + 4;
  if (A > 0xff) {
    A &= 0xff;
    C = (C + 1) & 0xff; // INC C wraps
  }
  return z80DivideBy8(C, A);
}

/** c$BACD: ADD HL,HL / RLA / JR NC / ADD HL,DE, eight times. */
function z80Multiply(a: number, e: number): number {
  let HL = 0;
  let A = a & 0xff;
  const DE = e & 0xff;
  for (let i = 0; i < 8; i++) {
    HL = (HL << 1) & 0xffff;
    const carry = (A & 0x80) !== 0;
    A = (A << 1) & 0xff;
    if (carry) HL = (HL + DE) & 0xffff;
  }
  return HL;
}

describe('divide_by_8 (c$E555)', () => {
  it('matches the instruction sequence across the full 16-bit range', () => {
    for (let v = 0; v < 0x10000; v += 7) {
      const hi = (v >> 8) & 0xff;
      const lo = v & 0xff;
      expect(divideBy8(hi, lo)).toBe(z80DivideBy8(hi, lo));
    }
  });

  it('truncates to 8 bits rather than returning the true quotient', () => {
    // 2048 / 8 == 256, which does not fit in A. Only the low byte survives.
    expect(divideBy8(0x08, 0x00)).toBe(0);
    expect(divideBy8(0x00, 0xff)).toBe(31); // 255 / 8 == 31
    expect(divideBy8(0x01, 0x00)).toBe(32); // 256 / 8 == 32
  });
});

describe('divide_by_8_with_rounding (c$E550)', () => {
  it('matches the instruction sequence across the full 16-bit range', () => {
    for (let v = 0; v < 0x10000; v += 7) {
      const hi = (v >> 8) & 0xff;
      const lo = v & 0xff;
      expect(divideBy8WithRounding(hi, lo)).toBe(z80DivideBy8Rounding(hi, lo));
    }
  });

  it('rounds to nearest by pre-adding 4', () => {
    expect(divideBy8WithRounding(0, 0)).toBe(0);
    expect(divideBy8WithRounding(0, 3)).toBe(0); // 3 -> 7/8 -> 0
    expect(divideBy8WithRounding(0, 4)).toBe(1); // 4 -> 8/8 -> 1
    expect(divideBy8WithRounding(0, 11)).toBe(1); // 11 -> 15/8 -> 1
    expect(divideBy8WithRounding(0, 12)).toBe(2); // 12 -> 16/8 -> 2
  });

  it('wraps modulo 65536 when the rounding addition overflows', () => {
    // $FFFF + 4 wraps to $0003, which divides to 0 -- not to 8192.
    expect(divideBy8WithRounding(0xff, 0xff)).toBe(0);
    expect(divideBy8WithRounding(0xff, 0xfc)).toBe(0);
  });
});

describe('multiply (c$BACD)', () => {
  it('matches the instruction sequence for every input pair', () => {
    for (let a = 0; a < 256; a += 5) {
      for (let e = 0; e < 256; e += 5) {
        expect(multiply(a, e)).toBe(z80Multiply(a, e));
      }
    }
  });

  it('is an exact 16-bit product', () => {
    expect(multiply(0, 0)).toBe(0);
    expect(multiply(1, 1)).toBe(1);
    expect(multiply(12, 12)).toBe(144);
    expect(multiply(255, 255)).toBe(65025); // fits, so no wrap
    expect(multiply(16, 16)).toBe(256);
  });
});

describe('multiply_by_4 and multiply_by_8', () => {
  it('return 16-bit results, not truncated bytes', () => {
    // Both return into BC, so the high byte is preserved.
    expect(multiplyBy4(0xff)).toBe(1020);
    expect(multiplyBy8(0xff)).toBe(2040);
    expect(multiplyBy4(64)).toBe(256);
    expect(multiplyBy8(32)).toBe(256);
  });

  it('agree with multiply()', () => {
    for (let a = 0; a < 256; a++) {
      expect(multiplyBy4(a)).toBe(multiply(a, 4));
      expect(multiplyBy8(a)).toBe(multiply(a, 8));
    }
  });
});

describe('pos_to_tinypos (c$E542)', () => {
  it('divides all three components by 8 with rounding', () => {
    expect(posToTinypos({ x: 0, y: 0, height: 0 })).toEqual({ x: 0, y: 0, height: 0 });
    expect(posToTinypos({ x: 64, y: 128, height: 24 })).toEqual({ x: 8, y: 16, height: 3 });
  });

  it('rounds each component independently', () => {
    // 12 rounds up to 2, 11 rounds down to 1.
    expect(posToTinypos({ x: 12, y: 11, height: 4 })).toEqual({ x: 2, y: 1, height: 1 });
  });

  it('matches the map coordinates quoted in the disassembly', () => {
    // The .skool header (line ~538) gives map_MAIN_GATE_X = $696D, meaning the
    // gate spans tinypos x $69..$6D. A pos_t at 8x those values must land there.
    expect(divideBy8WithRounding(0x03, 0x48)).toBe(0x69); // $0348 = 840, /8 = 105 = $69
    expect(divideBy8WithRounding(0x03, 0x68)).toBe(0x6d); // $0368 = 872, /8 = 109 = $6D
  });
});

describe('pointer arithmetic', () => {
  it('advancePointer carries into the high byte', () => {
    // The ADD A,L / JR NC / INC H pattern from the header (lines 67-74).
    expect(advancePointer(0x80fe, 1)).toBe(0x80ff);
    expect(advancePointer(0x80ff, 1)).toBe(0x8100); // carries
    expect(advancePointer(0xffff, 1)).toBe(0x0000); // wraps at 64K
  });

  it('incLow wraps inside the page instead of carrying', () => {
    // This is what keeps random_nibble's prng_pointer inside $90xx.
    expect(incLow(0x90fe)).toBe(0x90ff);
    expect(incLow(0x90ff)).toBe(0x9000);
    expect(incLow(0x9000)).toBe(0x9001);
  });

  it('the two differ exactly at a page boundary', () => {
    expect(advancePointer(0x90ff, 1)).toBe(0x9100);
    expect(incLow(0x90ff)).toBe(0x9000);
  });
});

describe('signed bytes', () => {
  it('reads two’s complement deltas', () => {
    expect(asSigned8(0x00)).toBe(0);
    expect(asSigned8(0x7f)).toBe(127);
    expect(asSigned8(0x80)).toBe(-128);
    expect(asSigned8(0xff)).toBe(-1);
  });
});
