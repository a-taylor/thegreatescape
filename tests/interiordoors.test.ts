/**
 * door_handling_interior (c$B32D) and setup_interior_doors (c$69DC).
 */

import { describe, expect, it } from 'vitest';

import {
  DOOR_REVERSE,
  MAX_INTERIOR_DOORS,
  ROOM_OUTDOORS,
  findInteriorDoor,
  halfDoors,
  interiorDoorInRange,
  interiorDoorsForRoom,
  interiorDoorTarget,
  resolveDoor,
  tryInteriorDoor,
} from '../src/game/doors.js';

describe('setup_interior_doors', () => {
  it('never overruns the four-slot array', () => {
    // interior_doors ($81D6) is four bytes pre-filled with door_NONE. A room
    // with more than four doors would fill every slot and leave no terminator,
    // so the $B330 loop would read into interior_mask_data. No room does.
    for (let room = 1; room <= 52; room++) {
      expect(interiorDoorsForRoom(room).length, `room ${room}`)
        .toBeLessThanOrEqual(MAX_INTERIOR_DOORS);
    }
  });

  it('gives the unused rooms no doors at all', () => {
    // Rooms 26 and 27 are unreachable in the finished game.
    expect(interiorDoorsForRoom(26)).toEqual([]);
    expect(interiorDoorsForRoom(27)).toEqual([]);
  });

  it('stores the index of the OTHER half of the pair', () => {
    // $6A00 writes `C XOR $80`, so a match on half 0 is stored with
    // door_REVERSE SET and resolves to half 1. Getting this backwards sends the
    // hero to the room he is already standing in.
    for (const index of interiorDoorsForRoom(1)) {
      const resolved = resolveDoor(index);
      const matchedHalf = index & DOOR_REVERSE ? resolved - 1 : resolved + 1;
      // The half whose room field actually equals 1 is the one setup matched.
      expect(halfDoors[matchedHalf]!.targetRoom).toBe(1);
      // ...and it is NOT the half we resolve to.
      expect(resolved).not.toBe(matchedHalf);
    }
  });

  it('makes the resolved half the destination and the target the arrival spot', () => {
    // Room 1's way out: resolved half says room 0, and the destination half is
    // the outdoor position.
    const list = interiorDoorsForRoom(1);
    const out = list.map((i) => halfDoors[resolveDoor(i)]!.targetRoom);
    expect(out).toContain(ROOM_OUTDOORS);
  });
});

describe('the interior range test', () => {
  const door = { addr: '$0', direction: 0, targetRoom: 0, pos: { x: 40, y: 50, height: 0 } };

  it('accepts pos-2 through pos+3 and nothing else', () => {
    // $B350..$B358: `A = pos - 3; if A >= saved skip` then
    // `A += 6; if A < saved skip`, giving pos-3 < saved <= pos+3.
    const inRange = [];
    for (let v = 30; v <= 60; v++) {
      if (interiorDoorInRange({ x: v, y: 50, height: 0 }, door)) inRange.push(v);
    }
    expect(inRange).toEqual([38, 39, 40, 41, 42, 43]);
  });

  it('does not scale the stored position', () => {
    // The exterior test multiplies by 4 ($B258) because outdoor door positions
    // are stored quartered. Indoor ones are not, so a x4 here would put every
    // door far out of reach.
    expect(interiorDoorInRange({ x: 40, y: 50, height: 0 }, door)).toBe(true);
    expect(interiorDoorInRange({ x: 160, y: 200, height: 0 }, door)).toBe(false);
  });

  it('requires both axes', () => {
    expect(interiorDoorInRange({ x: 40, y: 99, height: 0 }, door)).toBe(false);
    expect(interiorDoorInRange({ x: 99, y: 50, height: 0 }, door)).toBe(false);
  });
});

describe('walking through an interior door', () => {
  /** Stand exactly on a door and face the way it faces. */
  function atDoor(room: number, which = 0) {
    const index = interiorDoorsForRoom(room)[which]!;
    const door = halfDoors[resolveDoor(index)]!;
    return { index, door, pos: { ...door.pos } };
  }

  it('finds a door the hero is standing on and facing', () => {
    const { door, pos } = atDoor(1);
    const match = findInteriorDoor(pos, door.direction, 1);
    expect(match).not.toBeNull();
    expect(match!.matched.targetRoom).toBe(door.targetRoom);
  });

  it('finds nothing when facing the wrong way', () => {
    const { door, pos } = atDoor(1);
    const wrong = (door.direction + 2) & 0x03;
    expect(findInteriorDoor(pos, wrong, 1)).toBeNull();
  });

  it('finds nothing when standing away from every door', () => {
    expect(findInteriorDoor({ x: 200, y: 200, height: 24 }, 0, 1)).toBeNull();
    expect(findInteriorDoor({ x: 200, y: 200, height: 24 }, 1, 1)).toBeNull();
  });

  it('lets the hero back out of every room that has a way out', () => {
    // The bug this covers: door_handling exits to a separate routine indoors
    // ($B1F9), and with only the outdoor branch implemented the hero was shut
    // in whichever room he entered.
    let escaped = 0;
    for (let room = 1; room <= 52; room++) {
      for (const index of interiorDoorsForRoom(room)) {
        const door = halfDoors[resolveDoor(index)]!;
        const r = tryInteriorDoor({ ...door.pos }, door.direction, room);
        if (r && !r.locked) {
          escaped++;
          // The hero must actually leave the room he was in.
          expect(r.result.room, `room ${room} door ${index}`).not.toBe(room);
        }
      }
    }
    expect(escaped).toBeGreaterThan(20);
  });

  it('lands the hero at the other half of the pair', () => {
    const { index, door } = atDoor(1);
    const r = tryInteriorDoor({ ...door.pos }, door.direction, 1);
    expect(r).not.toBeNull();
    if (r && !r.locked) {
      const dest = halfDoors[interiorDoorTarget(index)]!;
      // Outdoor destinations are multiplied by 4 ($68B6); indoor ones are not.
      const expected =
        r.result.room === ROOM_OUTDOORS ? dest.pos.x * 4 : dest.pos.x;
      expect(r.result.pos.x).toBe(expected);
    }
  });
});
