/**
 * Doors and room transitions.
 *
 * The doors table ($78D6) is 62 PAIRS of half-doors. Each half records the
 * room you arrive in, the direction the door faces, and where it is. Walking
 * through means matching one half and then taking the OTHER half's position as
 * your destination -- which is why door_handling steps forward five bytes or
 * back three at the end.
 */

import geographyJson from '../../data/geography.json';

import { multiplyBy4 } from './math.js';
import type { Pos } from './coords.js';

export interface HalfDoor {
  readonly addr: string;
  readonly targetRoom: number;
  readonly direction: number;
  readonly pos: { readonly x: number; readonly y: number; readonly height: number };
}

const geography = geographyJson as unknown as {
  doors: { pairCount: number; halfDoors: HalfDoor[] };
  lockedDoors: { values: number[] };
};

export const halfDoors: readonly HalfDoor[] = geography.doors.halfDoors;
export const DOOR_PAIRS = geography.doors.pairCount;

/**
 * Only the first 16 pairs lead outdoors, so door_handling considers just those
 * when the hero is outside ($B20C LD B,$10).
 */
export const OUTDOOR_DOOR_PAIRS = 16;

/** door_LOCKED / door_REVERSE both live in bit 7 of their respective fields. */
export const DOOR_LOCKED = 0x80;
export const DOOR_REVERSE = 0x80;
/** is_door_locked masks with the complement of door_REVERSE ($7F). */
export const DOOR_INDEX_MASK = 0x7f;

/** locked_doors ($F05D). The routine reads exactly nine ($B1DE LD B,$09). */
export const LOCKED_DOOR_COUNT = 9;
export const lockedDoors: readonly number[] = geography.lockedDoors.values.slice(
  0,
  LOCKED_DOOR_COUNT,
);

export const ROOM_OUTDOORS = 0;
export const DIRECTION_BOTTOM_RIGHT = 2;

/** A half-door by flat index; pair n occupies indices 2n and 2n+1. */
export function halfDoor(index: number): HalfDoor {
  const d = halfDoors[index];
  if (!d) throw new Error(`no half-door at index ${index}`);
  return d;
}

/**
 * is_door_locked (c$B1D4).
 *
 * Scans the nine locked_doors entries for one whose index matches the current
 * door, ignoring bit 7 on both sides, then reports bit 7 of the stored entry.
 * A door absent from the table is open.
 */
export function isDoorLocked(currentDoor: number): boolean {
  const want = currentDoor & DOOR_INDEX_MASK;
  for (let i = 0; i < LOCKED_DOOR_COUNT; i++) {
    const entry = lockedDoors[i]!;
    if ((entry & DOOR_INDEX_MASK) === want) {
      return (entry & DOOR_LOCKED) !== 0;
    }
  }
  return false;
}

/**
 * door_in_range (c$B252).
 *
 * "A door is in range if (saved_X,saved_Y) is within -3..+2 of its position
 * (once scaled)" -- the position is stored quartered, so it is multiplied by 4
 * first.
 *
 * The routine builds `pos * 4 - 3` by subtracting 3 from the low byte and
 * borrowing into the high byte, then runs `SBC HL,BC` WITHOUT clearing carry.
 * When the low byte was under 3 the borrow is still set and the comparison
 * subtracts an extra 1, shifting the effective lower edge by one. That is
 * reproduced here rather than smoothed out, because it decides whether a door
 * is reachable at particular positions.
 */
export function doorInRange(pos: Pos, door: HalfDoor): boolean {
  return axisInRange(pos.x, door.pos.x) && axisInRange(pos.y, door.pos.y);
}

function axisInRange(value: number, doorCoord: number): boolean {
  const scaled = multiplyBy4(doorCoord);

  // low = scaled - 3, computed the way $B258..$B25E does, tracking the borrow.
  const lowByte = scaled & 0xff;
  const borrow = lowByte < 3 ? 1 : 0;
  const low = (scaled - 3) & 0xffff;

  // $B262 SBC HL,BC with the borrow still live.
  if (((value - low - borrow) & 0x10000) !== 0 || value - low - borrow < 0) return false;

  // $B265 adds 6 to reach scaled + 3; the comparison is exclusive via CCF.
  const high = (low + 6) & 0xffff;
  return value < high;
}

export interface DoorMatch {
  /** Index into the 62 pairs, as stored in current_door ($68A1). */
  readonly pair: number;
  /** The half we matched. */
  readonly matched: HalfDoor;
  /** The half whose position we arrive at. */
  readonly destination: HalfDoor;
}

/**
 * door_handling (c$B1F5), the outdoor case.
 *
 * Starts at half-door 0 or 1 depending on which way the hero faces ($B1FF), and
 * walks 16 pairs looking for one facing the same way and within range. On a
 * match, the destination is the OTHER half of the pair: forward five bytes for
 * directions 0-1, back three for 2-3 ($B244 / $B24C).
 */
export function findExteriorDoor(pos: Pos, direction: number): DoorMatch | null {
  const startHalf = direction >= DIRECTION_BOTTOM_RIGHT ? 1 : 0;

  for (let i = 0; i < OUTDOOR_DOOR_PAIRS; i++) {
    const index = startHalf + i * 2;
    const door = halfDoors[index];
    if (!door) break;
    if (door.direction !== direction) continue;
    if (!doorInRange(pos, door)) continue;

    // $B229: current door = 16 - iterations remaining.
    const otherIndex = door.direction >= DIRECTION_BOTTOM_RIGHT ? index - 1 : index + 1;
    const destination = halfDoors[otherIndex];
    if (!destination) continue;

    return { pair: i, matched: door, destination };
  }
  return null;
}

/**
 * transition (c$68A2): place the character at a door's destination.
 *
 * Outdoor destinations multiply the stored position by 4 ($68B6); indoor ones
 * widen the bytes to words unchanged ($68C5). That asymmetry is why the doors
 * table stores outdoor coordinates quartered.
 */
export function transitionPosition(destination: HalfDoor, targetRoom: number): Pos {
  const p = destination.pos;
  if (targetRoom === ROOM_OUTDOORS) {
    return { x: multiplyBy4(p.x), y: multiplyBy4(p.y), height: multiplyBy4(p.height) };
  }
  return { x: p.x, y: p.y, height: p.height };
}

export interface TransitionResult {
  readonly room: number;
  readonly pos: Pos;
  /** Outdoors, transition clears the crawl flag and kicks the hero ($68E8). */
  readonly clearCrawl: boolean;
}

/**
 * The complete outdoor door interaction: find, check the lock, and transition.
 *
 * Returns null when there is no door in range, and a locked result when there
 * is one but it is locked -- the caller queues "THE DOOR IS LOCKED" in that
 * case, as $B1E8 does.
 */
export function tryDoor(
  pos: Pos,
  direction: number,
): { locked: true; pair: number } | { locked: false; result: TransitionResult } | null {
  const match = findExteriorDoor(pos, direction);
  if (!match) return null;

  if (isDoorLocked(match.pair)) {
    return { locked: true, pair: match.pair };
  }

  const room = match.matched.targetRoom;
  return {
    locked: false,
    result: {
      room,
      pos: transitionPosition(match.destination, room),
      clearCrawl: room === ROOM_OUTDOORS,
    },
  };
}

/**
 * enter_room (c$68F4) fixes the map position for interiors.
 *
 * `LD HL,$EA74 / LD ($81BB),HL` stores L into map_position.x and H into .y,
 * giving (116, 234). Interiors do not scroll, so this is constant.
 */
export const INTERIOR_MAP_POSITION = { x: 0x74, y: 0xea } as const;
