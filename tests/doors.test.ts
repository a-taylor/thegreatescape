/**
 * Doors, locks and room transitions.
 */

import { describe, expect, it } from 'vitest';

import {
  DOOR_PAIRS,
  INTERIOR_MAP_POSITION,
  LOCKED_DOOR_COUNT,
  OUTDOOR_DOOR_PAIRS,
  doorInRange,
  findExteriorDoor,
  halfDoor,
  halfDoors,
  isDoorLocked,
  lockedDoors,
  transitionPosition,
  tryDoor,
} from '../src/game/doors.js';
import { multiplyBy4 } from '../src/game/math.js';

describe('doors table', () => {
  it('is 62 pairs of half-doors', () => {
    // "This is an array of 62 pairs of four-byte structs".
    expect(DOOR_PAIRS).toBe(62);
    expect(halfDoors.length).toBe(124);
  });

  it('unpacks room_and_direction into target room and direction', () => {
    // $78D6 DEFB $01 -> room_0_OUTDOORS, direction 1.
    const first = halfDoor(0);
    expect(first.addr).toBe('$78D6');
    expect(first.targetRoom).toBe(0);
    expect(first.direction).toBe(1);
    // $78DA DEFB $03 -> room 0, direction 3.
    expect(halfDoor(1).direction).toBe(3);
  });

  it('keeps every target room and direction in range', () => {
    for (const d of halfDoors) {
      expect(d.direction).toBeGreaterThanOrEqual(0);
      expect(d.direction).toBeLessThan(4);
      expect(d.targetRoom).toBeLessThan(64); // six bits
    }
  });
});

describe('is_door_locked (c$B1D4)', () => {
  it('reads exactly nine entries', () => {
    // $B1DE LD B,$09
    expect(LOCKED_DOOR_COUNT).toBe(9);
    expect(lockedDoors.length).toBe(9);
  });

  it('reports a door listed with bit 7 set as locked', () => {
    for (const entry of lockedDoors) {
      if (entry & 0x80) expect(isDoorLocked(entry & 0x7f)).toBe(true);
    }
  });

  it('treats a door absent from the table as open', () => {
    const listed = new Set(lockedDoors.map((d) => d & 0x7f));
    const absent = [...Array(62).keys()].find((i) => !listed.has(i));
    expect(absent).toBeDefined();
    expect(isDoorLocked(absent!)).toBe(false);
  });

  it('ignores bit 7 on the query, as the $7F mask does', () => {
    const locked = lockedDoors.find((d) => d & 0x80)!;
    const index = locked & 0x7f;
    expect(isDoorLocked(index)).toBe(isDoorLocked(index | 0x80));
  });
});

describe('door_in_range (c$B252)', () => {
  const door = halfDoor(0);
  const cx = multiplyBy4(door.pos.x);
  const cy = multiplyBy4(door.pos.y);

  it('accepts the door’s own scaled position', () => {
    expect(doorInRange({ x: cx, y: cy, height: 0 }, door)).toBe(true);
  });

  it('spans -3..+2 around the scaled position', () => {
    // The header states the range explicitly.
    expect(doorInRange({ x: cx + 2, y: cy, height: 0 }, door)).toBe(true);
    expect(doorInRange({ x: cx + 3, y: cy, height: 0 }, door)).toBe(false);
    expect(doorInRange({ x: cx - 3, y: cy, height: 0 }, door)).toBe(true);
    expect(doorInRange({ x: cx - 4, y: cy, height: 0 }, door)).toBe(false);
  });

  it('requires both axes', () => {
    expect(doorInRange({ x: cx, y: cy + 100, height: 0 }, door)).toBe(false);
    expect(doorInRange({ x: cx + 100, y: cy, height: 0 }, door)).toBe(false);
  });
});

describe('door_handling (c$B1F5)', () => {
  it('only considers the first 16 pairs outdoors', () => {
    // $B20C LD B,$10 -- "the only ones with outdoors as a destination".
    expect(OUTDOOR_DOOR_PAIRS).toBe(16);
  });

  it('finds a door when standing on it and facing its way', () => {
    const door = halfDoor(0);
    const pos = {
      x: multiplyBy4(door.pos.x),
      y: multiplyBy4(door.pos.y),
      height: 0,
    };
    const match = findExteriorDoor(pos, door.direction);
    expect(match).not.toBeNull();
    expect(match!.matched.direction).toBe(door.direction);
  });

  it('finds nothing when facing the wrong way', () => {
    const door = halfDoor(0);
    const pos = {
      x: multiplyBy4(door.pos.x),
      y: multiplyBy4(door.pos.y),
      height: 0,
    };
    // Direction 0 is never equal to this door's direction 1, and the search
    // starts from a different half for directions >= 2.
    expect(findExteriorDoor(pos, 0)).toBeNull();
  });

  it('pairs each half with its partner as the destination', () => {
    const door = halfDoor(0);
    const pos = {
      x: multiplyBy4(door.pos.x),
      y: multiplyBy4(door.pos.y),
      height: 0,
    };
    const match = findExteriorDoor(pos, door.direction)!;
    expect(match.destination).not.toBe(match.matched);
    // Directions 0-1 step forward, 2-3 step back -- either way the partner.
    const matchedIndex = halfDoors.indexOf(match.matched);
    const destIndex = halfDoors.indexOf(match.destination);
    expect(Math.abs(matchedIndex - destIndex)).toBe(1);
  });
});

describe('transition (c$68A2)', () => {
  it('multiplies outdoor destinations by four', () => {
    // "Outdoor coordinates are divided by four" in the table.
    const d = halfDoor(0);
    expect(transitionPosition(d, 0)).toEqual({
      x: multiplyBy4(d.pos.x),
      y: multiplyBy4(d.pos.y),
      height: multiplyBy4(d.pos.height),
    });
  });

  it('copies indoor destinations unchanged', () => {
    const d = halfDoor(0);
    expect(transitionPosition(d, 5)).toEqual({
      x: d.pos.x,
      y: d.pos.y,
      height: d.pos.height,
    });
  });

  it('fixes the interior map position at (116, 234)', () => {
    // enter_room: LD HL,$EA74 / LD ($81BB),HL stores L into x, H into y.
    expect(INTERIOR_MAP_POSITION).toEqual({ x: 0x74, y: 0xea });
    expect(INTERIOR_MAP_POSITION.x).toBe(116);
    expect(INTERIOR_MAP_POSITION.y).toBe(234);
  });
});

describe('tryDoor end to end', () => {
  it('returns null away from every door', () => {
    expect(tryDoor({ x: 4, y: 4, height: 0 }, 0)).toBeNull();
  });

  it('reports a locked door rather than transitioning', () => {
    // Locked door indices come straight from locked_doors.
    const lockedIndex = lockedDoors.find((d) => d & 0x80)! & 0x7f;
    if (lockedIndex < OUTDOOR_DOOR_PAIRS) {
      const half = halfDoor(lockedIndex * 2);
      const pos = {
        x: multiplyBy4(half.pos.x),
        y: multiplyBy4(half.pos.y),
        height: 0,
      };
      const r = tryDoor(pos, half.direction);
      if (r && r.locked) expect(r.pair).toBe(lockedIndex);
    }
  });

  it('transitions through an unlocked door', () => {
    const listed = new Set(lockedDoors.map((d) => d & 0x7f));
    for (let pair = 0; pair < OUTDOOR_DOOR_PAIRS; pair++) {
      if (listed.has(pair)) continue;
      const half = halfDoor(pair * 2);
      const pos = {
        x: multiplyBy4(half.pos.x),
        y: multiplyBy4(half.pos.y),
        height: 0,
      };
      const r = tryDoor(pos, half.direction);
      if (r && !r.locked) {
        expect(r.result.room).toBe(half.targetRoom);
        return;
      }
    }
    throw new Error('no unlocked outdoor door was reachable');
  });
});
