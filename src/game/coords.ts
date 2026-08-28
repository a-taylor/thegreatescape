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

import { divideBy8, divideBy8WithRounding, posToTinypos, type Pos, type TinyPos } from './math.js';

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

/**
 * Project an OUTDOOR item's tinypos to its iso_pos.
 * `calc_exterior_item_iso_pos` (c$7BD0).
 *
 *   iso_pos.x = ($40 + pos.y - pos.x) * 2
 *   iso_pos.y =  $00 - pos.x - pos.y - pos.height
 *
 * Not a smaller version of {@link calcIsoPos}: the whole thing is done in the
 * 8-bit accumulator, so both results WRAP at 256 rather than being computed
 * wide and narrowed. The constants differ too -- $40 and an implicit zero
 * where the vischar routine uses $200 and $800. The disassembly explains the
 * zero at $7BD8: "this acts like $200 for our purposes", because the answer is
 * only ever used a byte at a time.
 *
 * @param pos tinypos (byte scale), NOT world scale.
 */
export function calcExteriorItemIsoPos(pos: TinyPos): IsoPos {
  const x = (0x40 + pos.y - pos.x) & 0xff; // $7BD1..$7BD5
  return {
    x: ((x + x) & 0xff), // $7BD6 ADD A,A
    y: (0 - pos.x - pos.y - pos.height) & 0xff, // $7BD8..$7BDD
  };
}

/**
 * Project an INDOOR item's tinypos to its iso_pos.
 * `calc_interior_item_iso_pos` (c$7BF2).
 *
 *   iso_pos.x = (($200 + pos.y - pos.x) * 2) / 8, rounded
 *   iso_pos.y =  ($800 - pos.x - pos.y - pos.height) / 8, rounded
 *
 * The disassembly's own note: "unlike the exterior version of this routine at
 * #R$7BD0, this version scales the result down with rounding to nearest". So
 * the two are not interchangeable and neither is a special case of the other.
 *
 * The three subtractions in the y term are `SBC HL,BC` with the carry cleared
 * only before the first ($7C0D), so a borrow in one step takes an extra 1 off
 * the next -- the same chain as calc_vischar_iso_pos_from_state, reproduced
 * for the same reason.
 */
export function calcInteriorItemIsoPos(pos: TinyPos): IsoPos {
  // x: $7BF3..$7C02
  const wide = ((0x200 + pos.y - pos.x) & 0xffff) * 2;
  const isoX = divideBy8WithRounding((wide >> 8) & 0xff, wide & 0xff);

  // y: $7C06..$7C1C, carry chained across the three subtractions.
  let acc = 0x0800;
  let borrow = 0;
  for (const term of [pos.x, pos.y, pos.height]) {
    const next = acc - term - borrow;
    borrow = next < 0 ? 1 : 0;
    acc = next & 0xffff;
  }
  const isoY = divideBy8WithRounding((acc >> 8) & 0xff, acc & 0xff);

  return { x: isoX, y: isoY };
}

/**
 * hero_map_position ($81B8), as `in_permitted_area` maintains it ($9F21).
 *
 * This is the hero's own tinypos, and it is what `find_nearby_item` ($7C98),
 * `action_wiresnips` ($B41A) and `action_papers` ($EFCE) all range-check
 * against. It is NOT `map_position` ($81BB), which is the view's scroll
 * position and lives two bytes further on -- reading that one instead compares
 * the hero against the camera.
 *
 * Outdoors it is pos_to_tinypos of the vischar position ($9F2E, a divide by 8
 * with rounding on all three axes). Indoors it is three `LDI`s with an
 * `INC L` between them ($9F49), copying the LOW BYTE of each word and
 * skipping the high one -- no scaling, because indoors mi.pos is already at
 * tinypos scale.
 *
 * Also not the same as {@link tinyposStash} ($E42D), which rounds x but
 * truncates y and height. Three routines, three different scalings.
 */
export function heroMapPosition(pos: Pos, outdoors: boolean): TinyPos {
  if (!outdoors) {
    return { x: pos.x & 0xff, y: pos.y & 0xff, height: pos.height & 0xff }; // $9F49
  }
  return posToTinypos(pos); // $9F2E
}
