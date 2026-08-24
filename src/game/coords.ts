/**
 * The three coordinate systems, and the conversions between them.
 *
 * The game carries a character's position in three forms at once:
 *
 *   pos_t      three 16-bit words: the authoritative world position
 *   tinypos_t  three bytes: pos / 8, used for coarse proximity and route work
 *   iso_pos    two 16-bit words: the isometric projection onto the screen
 *
 * The world axes are not screen axes. From the vischar notes in the .skool
 * header (lines 692-693): x runs "along the line of bottom right to top left of
 * screen" and y "bottom left to top right". Height is a separate third axis, so
 * the projection is a genuine 3D-to-2D flattening, not a rotation.
 */

import { divideBy8, divideBy8WithRounding, type Pos, type TinyPos } from './math.js';

export type { Pos, TinyPos };

/** Screen-space position; the vischar's `iso_pos` (BigXY, 4 bytes). */
export interface IsoPos {
  x: number;
  y: number;
}

/** pos_to_tinypos (c$E542). */
export function toTinyPos(pos: Pos): TinyPos {
  return {
    x: divideBy8WithRounding((pos.x >> 8) & 0xff, pos.x & 0xff),
    y: divideBy8WithRounding((pos.y >> 8) & 0xff, pos.y & 0xff),
    height: divideBy8WithRounding((pos.height >> 8) & 0xff, pos.height & 0xff),
  };
}

/**
 * tinypos_stash, as setup_vischar_plotting builds it outdoors (c$E438).
 *
 * NOT the same as toTinyPos: only x is rounded ($E43B calls
 * divide_by_8_with_rounding), while y and height are truncated ($E446 calls
 * divide_by_8 with no rounding). The difference is at most 1, but it lands
 * directly on the mask culling tests -- `tinypos.y < mask.pos.y` decides
 * whether a character is in front of a mask, so rounding y makes occlusion
 * start and stop a step early.
 *
 * Indoors the routine copies the low bytes without scaling at all ($E42D).
 */
export function tinyposStash(pos: Pos, outdoors = true): TinyPos {
  if (!outdoors) {
    return { x: pos.x & 0xff, y: pos.y & 0xff, height: pos.height & 0xff };
  }
  return {
    x: divideBy8WithRounding((pos.x >> 8) & 0xff, pos.x & 0xff),
    y: divideBy8((pos.y >> 8) & 0xff, pos.y & 0xff),
    height: divideBy8((pos.height >> 8) & 0xff, pos.height & 0xff),
  };
}

/** A tinypos scaled back up to a pos. The inverse is lossy: tinypos is pos/8. */
export function fromTinyPos(tiny: TinyPos): Pos {
  return {
    x: (tiny.x * 8) & 0xffff,
    y: (tiny.y * 8) & 0xffff,
    height: (tiny.height * 8) & 0xffff,
  };
}

/**
 * Project a world position to screen space.
 * `calc_vischar_iso_pos_from_state` (c$B729).
 *
 *   iso_pos.x = ($200 - pos.x + pos.y) * 2
 *   iso_pos.y = $800 - pos.x - pos.height - pos.y
 *
 * The y computation is a chain of three `SBC HL,BC` with the carry cleared only
 * before the first ($B746 AND A). The second and third therefore subtract an
 * additional 1 whenever the previous step borrowed. For in-range positions no
 * borrow occurs and the chain behaves as plain subtraction, but the borrow is
 * reproduced here because the original's behaviour at the extremes is defined
 * by it, not by the arithmetic it resembles.
 */
export function calcIsoPos(pos: Pos): IsoPos {
  const x = pos.x & 0xffff;
  const y = pos.y & 0xffff;
  const height = pos.height & 0xffff;

  // iso_pos.x -- $B72E..$B73C
  const sumX = (y + 0x200) & 0xffff;
  const isoX = ((sumX - x) & 0xffff) * 2;

  // iso_pos.y -- $B743..$B753, carry chained across the three subtractions.
  let acc = 0x0800;
  let borrow = 0;

  let next = acc - x - borrow;
  borrow = next < 0 ? 1 : 0;
  acc = next & 0xffff;

  next = acc - height - borrow;
  borrow = next < 0 ? 1 : 0;
  acc = next & 0xffff;

  next = acc - y - borrow;
  acc = next & 0xffff;

  return { x: isoX & 0xffff, y: acc };
}

/**
 * Advance a pointer into a vischar by an 8-bit offset, WITHOUT carrying.
 *
 * $B72A: "LD A,$18 / ADD A,E / LD E,A -- note shortcut - no rollover into high
 * byte". The eight vischars live at $8000..$80FF, so a 32-byte structure never
 * straddles a page and the shortcut is safe. Modelled explicitly so that if a
 * future change moves the vischar table, the breakage is visible rather than
 * silent.
 */
export function vischarFieldPointer(base: number, offset: number): number {
  return (base & 0xff00) | ((base + offset) & 0xff);
}

/** Field offsets within a 32-byte vischar, from the struct table in the header. */
export const VISCHAR = {
  character: 0x00,
  flags: 0x01,
  route: 0x02,
  target: 0x04,
  counterAndFlags: 0x07,
  animbase: 0x08,
  anim: 0x0a,
  animindex: 0x0c,
  input: 0x0d,
  direction: 0x0e,
  mi: 0x0f, // MovableItem: pos (6) + current sprite (2) + sprite index (1)
  isoPos: 0x18,
  room: 0x1c,
  widthBytes: 0x1e,
  height: 0x1f,
} as const;

export const VISCHAR_SIZE = 32;
export const VISCHAR_COUNT = 8;
export const VISCHAR_BASE = 0x8000;

/** Direction field values (bits 0..1), from the constants block. */
export const DIRECTION_TOP_LEFT = 0;
export const DIRECTION_TOP_RIGHT = 1;
export const DIRECTION_BOTTOM_RIGHT = 2;
export const DIRECTION_BOTTOM_LEFT = 3;

export const DIRECTION_MASK = 0x03;
/** Bit 2 of the direction field marks crawling. */
export const DIRECTION_CRAWL = 1 << 2;

export function directionOf(field: number): number {
  return field & DIRECTION_MASK;
}

export function isCrawling(field: number): boolean {
  return (field & DIRECTION_CRAWL) !== 0;
}
