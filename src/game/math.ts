/**
 * The game's arithmetic primitives, transcribed from the Z80.
 *
 * BUILD_PROMPT.md §8 singles these out for unit testing: they are small,
 * exactly specified, and everything downstream depends on them. §5 requires
 * integer discipline throughout -- no floats in game state, explicit masking,
 * and 8-bit wraparound reproduced wherever the original relies on it.
 *
 * Several of these truncate in ways a "cleaned up" version would not. That is
 * deliberate: the truncation is observable in gameplay, so removing it would
 * change behaviour.
 */

/** Multiply A by E, giving a 16-bit result. `multiply` (c$BACD). */
export function multiply(a: number, e: number): number {
  // Shift-and-add over eight iterations. 255 * 255 = 65025, so the 16-bit
  // accumulator never overflows and the result is exact.
  let hl = 0;
  let acc = a & 0xff;
  const de = e & 0xff;
  for (let i = 0; i < 8; i++) {
    hl = (hl << 1) & 0xffff; // ADD HL,HL
    acc = (acc << 1) & 0x1ff; // RLA -- bit 8 is the carry out
    if (acc & 0x100) {
      hl = (hl + de) & 0xffff; // ADD HL,DE
      acc &= 0xff;
    }
  }
  return hl;
}

/** Multiply A by 4, giving a 16-bit result in BC. `multiply_by_4` (c$B295). */
export function multiplyBy4(a: number): number {
  return ((a & 0xff) << 2) & 0xffff;
}

/** Multiply A by 8, giving a 16-bit result in BC. `multiply_by_8` (c$B1C7). */
export function multiplyBy8(a: number): number {
  return ((a & 0xff) << 3) & 0xffff;
}

/**
 * Divide the 16-bit value (hi:lo) by 8. `divide_by_8` (c$E555).
 *
 * Three rounds of `SRL C / RRA` shift the pair right, but only A is returned --
 * anything left in C is discarded. So the result is TRUNCATED TO 8 BITS, and
 * an input of 2048 yields 0 rather than 256. That truncation is real and is
 * relied on by the callers, which is why this returns a byte, not a word.
 */
export function divideBy8(hi: number, lo: number): number {
  const value = (((hi & 0xff) << 8) | (lo & 0xff)) & 0xffff;
  return (value >>> 3) & 0xff;
}

/**
 * Divide (hi:lo) by 8, rounding to nearest. `divide_by_8_with_rounding` (c$E550).
 *
 * `ADD A,$04 / JR NC / INC C` adds 4 to the 16-bit pair before falling through
 * into divide_by_8. `INC C` wraps at 256, so the addition is modulo 65536.
 */
export function divideBy8WithRounding(hi: number, lo: number): number {
  const value = (((hi & 0xff) << 8) | (lo & 0xff)) & 0xffff;
  return (((value + 4) & 0xffff) >>> 3) & 0xff;
}

/** A 16-bit position triple: the game's `pos_t`. */
export interface Pos {
  x: number;
  y: number;
  height: number;
}

/** An 8-bit position triple: the game's `tinypos_t`. */
export interface TinyPos {
  x: number;
  y: number;
  height: number;
}

/**
 * Convert a pos_t to a tinypos_t. `pos_to_tinypos` (c$E542).
 *
 * Three 16-bit words divided by 8 with rounding, stored as bytes.
 *
 * ASSUMPTION: the routine walks its input with `INC L`, not `INC HL`, so the
 * source pointer wraps within a 256-byte page. Every pos_t the game passes it
 * sits well clear of a page boundary, so the wrap is unobservable and is not
 * modelled here. Recorded because it is a real difference from the obvious
 * reading, not an oversight.
 */
export function posToTinypos(pos: Pos): TinyPos {
  return {
    x: divideBy8WithRounding((pos.x >> 8) & 0xff, pos.x & 0xff),
    y: divideBy8WithRounding((pos.y >> 8) & 0xff, pos.y & 0xff),
    height: divideBy8WithRounding((pos.height >> 8) & 0xff, pos.height & 0xff),
  };
}

/**
 * Advance a 16-bit pointer by an 8-bit delta.
 *
 * The `A = L; A += delta; L = A; JR NC; H++` pattern documented in the
 * disassembly header (lines 67-74). It is an ordinary 16-bit addition; the
 * carry handling exists only because the Z80 lacks a direct 8-bit-to-16-bit
 * add. Wraps at 64K.
 */
export function advancePointer(hl: number, delta: number): number {
  return (hl + (delta & 0xff)) & 0xffff;
}

/**
 * `INC L`: increment only the low byte of a 16-bit pointer.
 *
 * Distinct from advancePointer -- this wraps WITHIN the 256-byte page rather
 * than carrying into the high byte. random_nibble (c$CB85) depends on exactly
 * this to keep its PRNG pointer inside $90xx.
 */
export function incLow(hl: number): number {
  return (hl & 0xff00) | ((hl + 1) & 0xff);
}

/** Signed 8-bit reading of a byte, for deltas stored as two's complement. */
export function asSigned8(byte: number): number {
  const b = byte & 0xff;
  return b >= 0x80 ? b - 0x100 : b;
}

/** Wrap to 8 bits, for the many places the original relies on byte overflow. */
export function u8(value: number): number {
  return value & 0xff;
}

/** Wrap to 16 bits. */
export function u16(value: number): number {
  return value & 0xffff;
}
