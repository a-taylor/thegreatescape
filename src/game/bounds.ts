/**
 * Collision and permitted-area tests.
 *
 * Three separate checks, used in different situations:
 *
 *   bounds_check           (c$B14C)  outdoors: 24 wall volumes
 *   interior_bounds_check  (c$B29F)  indoors: room extent + furniture
 *   within_camp_bounds     (c$A01A)  is a position inside a permitted area
 *
 * The first two share a quirk worth knowing about: on collision they TOGGLE the
 * vischar's Y_DOMINANT flag rather than just reporting a blockage. That flag
 * decides which axis a character prefers to move along, so repeatedly walking
 * into a wall makes it alternate axis preference -- which is how characters
 * slide along walls instead of sticking. It is a behaviour, not bookkeeping.
 */

import geographyJson from '../../data/geography.json';
import roomsJson from '../../data/rooms.json';

import { multiplyBy8 } from './math.js';
import type { Pos } from './coords.js';

interface WallEntry {
  minx: number;
  maxx: number;
  miny: number;
  maxy: number;
  minh: number;
  maxh: number;
}

interface AreaBounds {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

interface RoomDimensions {
  x1: number;
  x0: number;
  y1: number;
  y0: number;
}

const geography = geographyJson as unknown as {
  walls: { entries: WallEntry[] };
  permittedBounds: { entries: AreaBounds[] };
};

const rooms = roomsJson as unknown as {
  dimensions: { entries: RoomDimensions[] };
};

export const walls: readonly WallEntry[] = geography.walls.entries;
export const permittedBounds: readonly AreaBounds[] = geography.permittedBounds.entries;
export const roomDimensions: readonly RoomDimensions[] = rooms.dimensions.entries;

export const ROOM_OUTDOORS = 0;
/** vischar_BYTE7_Y_DOMINANT, bit 5 of counter_and_flags. */
export const BYTE7_Y_DOMINANT = 1 << 5;

export interface BoundsResult {
  /** True when the position is in contact with a boundary. */
  readonly blocked: boolean;
  /** Index of the wall or object hit, for debugging; -1 when clear. */
  readonly hit: number;
}

/**
 * bounds_check (c$B14C), the outdoor case.
 *
 * Tests the position against all 24 wall volumes. A wall is "hit" when the
 * position lies inside its box on all three axes, with the asymmetric margins
 * the routine applies:
 *
 *   x: [minx*8 + 2, maxx*8 + 4)
 *   y: [miny*8,     maxy*8 + 4)
 *   h: [minh*8,     maxh*8 + 2)
 *
 * The margins are not symmetrical and are not a rounding artefact -- they give
 * the character a small body rather than treating it as a point.
 */
export function outdoorBoundsCheck(pos: Pos): BoundsResult {
  for (let i = 0; i < walls.length; i++) {
    const w = walls[i]!;

    if (pos.x < multiplyBy8(w.minx) + 2) continue; // $B163 JR C
    if (pos.x >= multiplyBy8(w.maxx) + 4) continue; // $B173 JR NC
    if (pos.y < multiplyBy8(w.miny)) continue; // $B17F JR C
    if (pos.y >= multiplyBy8(w.maxy) + 4) continue; // $B18F JR NC
    if (pos.height < multiplyBy8(w.minh)) continue; // $B19B JR C
    if (pos.height >= multiplyBy8(w.maxh) + 2) continue; // $B1A9 JR NC

    return { blocked: true, hit: i };
  }
  return { blocked: false, hit: -1 };
}

/** Room state that setup_room derives from the roomdef, used indoors. */
export interface InteriorBoundsState {
  /** roomdef_bounds_index ($81BE): which entry of roomdef_dimensions applies. */
  readonly boundsIndex: number;
  /** roomdef_object_bounds ($81C0), up to four furniture boxes. */
  readonly objectBounds: ReadonlyArray<AreaBounds>;
}

/**
 * interior_bounds_check (c$B29F).
 *
 * Two stages. First the room's own extent, from roomdef_dimensions ($6B85) --
 * note the fields are stored in the unusual order x1, x0, y1, y0, as the
 * routine's own comment points out. Then each furniture box in
 * roomdef_object_bounds.
 *
 * Positions are compared as bytes: indoors the coordinates are small enough
 * that the low byte of the 16-bit pos is the whole value.
 *
 * A stray `INC DE` at $B2BC is documented in the disassembly as dead code --
 * the register is never used afterwards, so nothing here reproduces it.
 */
export function interiorBoundsCheck(pos: Pos, state: InteriorBoundsState): BoundsResult {
  const dims = roomDimensions[state.boundsIndex];
  if (!dims) throw new Error(`no room dimensions at index ${state.boundsIndex}`);

  const x = pos.x & 0xff;
  const y = pos.y & 0xff;

  // Room extent. The +4 / -4 margins are asymmetric between the axes.
  if (dims.x1 < x) return { blocked: true, hit: -1 }; // $B2B1
  if (dims.x0 + 4 >= x) return { blocked: true, hit: -1 }; // $B2B8
  if (dims.y1 - 4 < y) return { blocked: true, hit: -1 }; // $B2C2
  if (dims.y0 >= y) return { blocked: true, hit: -1 }; // $B2C7

  // Furniture. Inside a box on BOTH axes means blocked.
  for (let i = 0; i < state.objectBounds.length; i++) {
    const b = state.objectBounds[i]!;
    if (x >= b.x0 && x < b.x1 && y >= b.y0 && y < b.y1) {
      return { blocked: true, hit: i };
    }
  }

  return { blocked: false, hit: -1 };
}

/**
 * bounds_check (c$B14C) proper: dispatches indoors or out.
 *
 * `$B14F AND A / JP NZ` -- any room index other than 0 means indoors.
 */
export function boundsCheck(
  pos: Pos,
  room: number,
  interior?: InteriorBoundsState,
): BoundsResult {
  if (room !== ROOM_OUTDOORS) {
    if (!interior) throw new Error('interior bounds state required indoors');
    return interiorBoundsCheck(pos, interior);
  }
  return outdoorBoundsCheck(pos);
}

/**
 * The collision side effect: toggle Y_DOMINANT on the vischar.
 *
 * Both bounds routines do this before returning "blocked" ($B1AF and $B2E7).
 * Returning the new flags rather than mutating keeps the caller explicit about
 * applying it.
 */
export function toggleYDominant(counterAndFlags: number): number {
  return (counterAndFlags ^ BYTE7_Y_DOMINANT) & 0xff;
}

/**
 * within_camp_bounds (c$A01A).
 *
 * @param area 0..2, indexing permitted_bounds ($9F15)
 * @param pos  a tinypos-scale position
 * @returns true when inside (the routine returns Z set)
 */
export function withinCampBounds(area: number, pos: { x: number; y: number }): boolean {
  const b = permittedBounds[area];
  if (!b) throw new Error(`no permitted area ${area}`);
  // Lower bound inclusive, upper bound exclusive, on both axes.
  return pos.x >= b.x0 && pos.x < b.x1 && pos.y >= b.y0 && pos.y < b.y1;
}
