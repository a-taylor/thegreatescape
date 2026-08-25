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
  INTERIOR_MAP_POSITION,
} from '../src/game/doors.js';
import { calcIsoPos } from '../src/game/coords.js';
import { resetOutdoorPosition } from '../src/render/place.js';

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

describe('reset_outdoor_position (c$B2FC)', () => {
  it('subtracts 11 on x and 6 on y, not half the window on both', () => {
    // $B30B SUB $0B is in BYTES ("width of the game screen minus half of the
    // hero's width"); $B317 SUB $06 is in TILE ROWS. Halving the window in
    // both axes gives 12 and 8, which is close enough to look right and wrong
    // enough to misplace the hero.
    const pos = { x: 100 * 8, y: 74 * 8, height: 24 };
    const iso = calcIsoPos(pos);
    const m = resetOutdoorPosition(pos);
    expect(m.x).toBe(((iso.x >> 3) - 11) & 0xff);
    expect(m.y).toBe(((iso.y >> 3) - 6) & 0xff);
  });

  it('puts every outdoor door arrival inside the map', () => {
    // The corruption this covers: stepping outside left map_position at the
    // interior's constant (116, 234), which is far outside a 216x136 map, so
    // the exterior renderer walked supertiles from nowhere.
    let checked = 0;
    for (let room = 1; room <= 52; room++) {
      // Room 6 is unused and its door pair carries a degenerate (0,0)
      // position, which projects to map y 250. That is the unused data being
      // unused, not a placement bug -- the room is unreachable in the finished
      // game, so nothing ever calls this with it.
      if (room === 6) continue;

      for (const index of interiorDoorsForRoom(room)) {
        const door = halfDoors[resolveDoor(index)]!;
        const r = tryInteriorDoor({ ...door.pos }, door.direction, room);
        if (!r || r.locked || r.result.room !== ROOM_OUTDOORS) continue;

        checked++;
        const m = resetOutdoorPosition(r.result.pos);
        expect(m.x, `room ${room} -> outdoors, map x`).toBeLessThan(216);
        expect(m.y, `room ${room} -> outdoors, map y`).toBeLessThan(136);
      }
    }
    expect(checked).toBeGreaterThan(5);
  });

  it('projects the unused room 6 door off the map, as its data implies', () => {
    // Pinned rather than glossed over: pair 15's outdoor half sits at (0,0),
    // so iso_pos.y is $800 and the map position lands at 250. Recorded so the
    // exclusion above is evidence, not a convenience.
    // The door exists and does lead outdoors; it is the ARRIVAL position that
    // is degenerate. Half-door 30 (pair 15, half 0) is all zeroes.
    expect(halfDoors[30]!.pos).toEqual({ x: 0, y: 0, height: 0 });
    expect(halfDoors[30]!.targetRoom).toBe(6);

    const index = interiorDoorsForRoom(6)[0]!;
    const dest = halfDoors[interiorDoorTarget(index)]!;
    expect(dest.pos).toEqual({ x: 0, y: 0, height: 0 });
    // $800 - 0 - 0 - 0, divided by 8, less 6.
    expect(resetOutdoorPosition({ x: 0, y: 0, height: 0 }).y).toBe(250);
  });

  it('is nowhere near the interior constant', () => {
    // INTERIOR_MAP_POSITION is (116, 234). y=234 alone is past the map height.
    expect(INTERIOR_MAP_POSITION.y).toBeGreaterThan(136);
    const m = resetOutdoorPosition({ x: 100 * 8, y: 74 * 8, height: 24 });
    expect(m.y).toBeLessThan(136);
  });
});
