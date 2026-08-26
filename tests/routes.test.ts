/**
 * get_target (c$C651), get_route (c$CB79), move_towards (c$C79A) and
 * move_a_character (c$C6A0).
 */

import { describe, expect, it } from 'vitest';

import {
  FIRST_LOCATION_BYTE,
  NULL_ROUTE_ROM_BYTE,
  ROUTE_COUNT,
  ROUTE_REVERSED,
  ROUTE_WANDER,
  advanceRoute,
  getRoute,
  getTarget,
  locations,
  reverseRoute,
  routePointers,
} from '../src/game/routes.js';
import {
  MAX_STEP_INDOORS,
  MAX_STEP_OUTDOORS,
  MOVE_CHARACTER_LIMIT,
  moveCharacter,
  moveTowards,
  nextCharacterIndex,
} from '../src/game/move.js';
import { characterStructs } from '../src/game/characters.js';
import { ROOM_OUTDOORS } from '../src/game/doors.js';
import { PRNG_BASE, Prng } from '../src/game/prng.js';

/** A deterministic stand-in for random_nibble ($CB85). */
function seeded(start = 1): () => number {
  let s = start;
  return () => (s = (s * 37 + 11) & 0xff);
}

describe('the routes table', () => {
  it('is 46 pointers', () => {
    expect(ROUTE_COUNT).toBe(46);
    expect(routePointers).toHaveLength(46);
  });

  it('has a null route at index 0', () => {
    // routeindex_0_HALT. get_route returns a zero pointer for it, which is
    // what makes the $0001 ROM read at $C667 possible.
    expect(routePointers[0]!.addr).toBe('$0000');
    expect(getRoute(0)).toBeNull();
  });

  it('discards the reversed flag when selecting', () => {
    // $CB79 ADD A,A drops bit 7 in the same instruction that doubles the
    // index, so a reversed route resolves to the same byte string.
    for (let i = 1; i < ROUTE_COUNT; i++) {
      expect(getRoute(i | ROUTE_REVERSED), `route ${i}`).toBe(getRoute(i));
    }
  });
});

describe('locations', () => {
  it('is 78 entries, matching route bytes 40..117', () => {
    expect(locations).toHaveLength(78);
    expect(FIRST_LOCATION_BYTE + locations.length - 1).toBe(117);
  });

  it('reads x from the low byte', () => {
    // $783A DEFW $6844 is commented "( 68, 104)".
    expect(locations[0]).toEqual({ x: 0x44, y: 0x68 });
  });
});

describe('get_target', () => {
  it('returns a location for a route byte of 40 or more', () => {
    // Route 1 is [72, 73, 74, 255] -- locations 32, 33, 34.
    const t = getTarget({ index: 1, step: 0 }, seeded());
    expect(t.kind).toBe('location');
    if (t.kind === 'location') {
      expect(t.index).toBe(32);
      expect(t.pos).toEqual(locations[32]);
    }
  });

  it('returns route-ends on the terminator', () => {
    expect(getTarget({ index: 1, step: 3 }, seeded()).kind).toBe('ended');
  });

  it('walks the whole of a route in order', () => {
    const seen: number[] = [];
    for (let step = 0; step < 3; step++) {
      const t = getTarget({ index: 1, step }, seeded());
      if (t.kind === 'location') seen.push(t.index);
    }
    expect(seen).toEqual([32, 33, 34]);
  });

  it('reads the previous route\'s terminator when step is 255', () => {
    // $C66F sets the high byte to $FF so the address goes BACKWARDS one byte.
    // "Since all of the routes are packed together, this relies on being able
    // to fetch the previous route's terminator." Route 2 starts at offset 97,
    // and offset 96 is route 1's $FF.
    expect(routePointers[2]!.offset).toBe(97);
    expect(getTarget({ index: 2, step: 0xff }, seeded()).kind).toBe('ended');
  });

  it('recognises a door byte even with its reverse flag set', () => {
    // $C67B masks bit 7 off BEFORE comparing against 40, so a door byte of
    // $80|n is still a door. Find a route byte that is one.
    const withDoor = { index: 0, step: 0 };
    let found = false;
    for (let i = 1; i < ROUTE_COUNT && !found; i++) {
      for (let step = 0; step < 12; step++) {
        const t = getTarget({ index: i, step }, seeded());
        if (t.kind === 'door') {
          found = true;
          expect(t.door).toBeDefined();
          break;
        }
        if (t.kind === 'ended') break;
      }
    }
    expect(found, 'some route targets a door').toBe(true);
    expect(withDoor.step).toBe(0);
  });

  it('composes the route reversal with the door reversal', () => {
    // $C686 XORs the route's reversed flag into the door byte, so following a
    // route backwards also goes through its doors the other way.
    const findDoor = (index: number) => {
      for (let step = 0; step < 12; step++) {
        const t = getTarget({ index, step }, seeded());
        if (t.kind === 'door') return { step, index: t.index };
        if (t.kind === 'ended') return null;
      }
      return null;
    };
    for (let i = 1; i < ROUTE_COUNT; i++) {
      const fwd = findDoor(i);
      if (!fwd) continue;
      const rev = getTarget({ index: i | ROUTE_REVERSED, step: fwd.step }, seeded());
      expect(rev.kind).toBe('door');
      if (rev.kind === 'door') expect(rev.index).toBe(fwd.index ^ 0x80);
      return;
    }
    throw new Error('no route with a door found');
  });

  describe('wander', () => {
    it('picks one of eight locations from route.step', () => {
      // $C656..$C662: clear the bottom three bits, add rand(0..7).
      const route = { index: ROUTE_WANDER, step: 24 };
      const seen = new Set<number>();
      const random = seeded();
      for (let i = 0; i < 200; i++) {
        route.step = 24;
        const t = getTarget(route, random);
        if (t.kind === 'location') seen.add(t.index);
      }
      expect([...seen].every((i) => i >= 24 && i < 32)).toBe(true);
      expect(seen.size).toBeGreaterThan(1);
    });

    it('uses route.step AS the location index, without subtracting 40', () => {
      // The asymmetry: gt_wander jumps straight to gt_pick_loc, skipping the
      // SUB $28 that the normal path does at $C690.
      const route = { index: ROUTE_WANDER, step: 0 };
      const t = getTarget(route, () => 3);
      expect(t.kind).toBe('location');
      if (t.kind === 'location') expect(t.index).toBe(3);
    });
  });

  it('reads $AF for the null route, as the ROM holds', () => {
    // $C667's documented case. $AF & $7F is 47, which is >= 40, so it reads as
    // location 7.
    expect(NULL_ROUTE_ROM_BYTE).toBe(0xaf);
    const t = getTarget({ index: 0, step: 0 }, seeded());
    expect(t.kind).toBe('location');
    if (t.kind === 'location') expect(t.index).toBe(7);
  });
});

describe('stepping a route', () => {
  it('goes forwards normally and backwards when reversed', () => {
    const fwd = { index: 1, step: 4 };
    advanceRoute(fwd);
    expect(fwd.step).toBe(5); // $C796

    const rev = { index: 1 | ROUTE_REVERSED, step: 4 };
    advanceRoute(rev);
    expect(rev.step).toBe(3); // $C798
  });

  it('does not advance a wander route', () => {
    // $C790 returns early: wander re-rolls instead of stepping.
    const r = { index: ROUTE_WANDER, step: 24 };
    advanceRoute(r);
    expect(r.step).toBe(24);
  });

  it('turns around with the "[-2]+1" pattern', () => {
    // $C6E4..$C6EF. Going forward, reversing lands one BEFORE the terminator
    // rather than on it -- otherwise the route would end again immediately.
    const r = { index: 1, step: 3 };
    reverseRoute(r);
    expect(r.index).toBe(1 | ROUTE_REVERSED);
    expect(r.step).toBe(2);

    // And back again.
    reverseRoute(r);
    expect(r.index).toBe(1);
    expect(r.step).toBe(3);
  });
});

describe('move_towards', () => {
  it('reports arrival when already there', () => {
    expect(moveTowards(50, 50, 2)).toEqual({ value: 50, arrived: true });
  });

  it('steps up and down by at most the maximum', () => {
    expect(moveTowards(50, 60, 2).value).toBe(52);
    expect(moveTowards(50, 40, 2).value).toBe(48);
    expect(moveTowards(50, 60, 6).value).toBe(56);
  });

  it('does not overshoot', () => {
    expect(moveTowards(50, 51, 6).value).toBe(51);
    expect(moveTowards(50, 49, 6).value).toBe(49);
  });

  it('converges from any distance', () => {
    for (const target of [0, 37, 200, 255]) {
      let v = 128;
      for (let i = 0; i < 200; i++) v = moveTowards(v, target, 2).value;
      expect(v, `target ${target}`).toBe(target);
    }
  });
});

describe('move_a_character', () => {
  const ctx = { random: seeded() };

  it('skips a character that is on-screen', () => {
    // $C6B6: the vischar owns the position while spawned.
    const s = characterStructs()[1]!;
    s.onScreen = true;
    const before = { ...s.pos };
    expect(moveCharacter(s, ctx).moved).toBe(false);
    expect(s.pos).toEqual(before);
  });

  it('skips a halted character', () => {
    // $C6CC: routeindex_0_HALT.
    const s = characterStructs()[5]!;
    expect(s.route.index).toBe(0);
    const before = { ...s.pos };
    expect(moveCharacter(s, ctx).moved).toBe(false);
    expect(s.pos).toEqual(before);
  });

  it('moves at most two units per call outdoors', () => {
    expect(MAX_STEP_OUTDOORS).toBe(2);
    expect(MAX_STEP_INDOORS).toBe(6);

    // Guard 1 starts exactly ON his first waypoint -- locations[32] is
    // (102,68), which is his character struct position -- so the first call
    // is an arrival with no movement. Step past it, then measure.
    const s = characterStructs()[1]!;
    expect(locations[32]).toEqual({ x: s.pos.x, y: s.pos.y });

    let sawMovement = false;
    for (let i = 0; i < 20; i++) {
      const before = { ...s.pos };
      moveCharacter(s, ctx);
      const dx = Math.abs(s.pos.x - before.x);
      const dy = Math.abs(s.pos.y - before.y);
      expect(dx).toBeLessThanOrEqual(MAX_STEP_OUTDOORS);
      expect(dy).toBeLessThanOrEqual(MAX_STEP_OUTDOORS);
      if (dx + dy > 0) sawMovement = true;
    }
    expect(sawMovement).toBe(true);
  });

  it('walks guard 1 between the waypoints his route names', () => {
    // Route 1 is locations 32, 33, 34. He should actually reach them.
    const s = characterStructs()[1]!;
    const reached: string[] = [];
    for (let i = 0; i < 400; i++) {
      if (moveCharacter(s, ctx).arrived) reached.push(`${s.pos.x},${s.pos.y}`);
    }
    expect(reached.length).toBeGreaterThan(4);
    const names = new Set(reached);
    // He patrols rather than sitting on one spot.
    expect(names.size).toBeGreaterThan(1);
    for (const n of names) {
      const [x, y] = n.split(',').map(Number);
      expect(
        locations.some((l) => l.x === x && l.y === y),
        `${n} is a real location`,
      ).toBe(true);
    }
  });

  it('turns guards 1..11 around at the end of a route', () => {
    // $C6E0 CP $0C: characters below 12 reverse.
    const s = characterStructs()[1]!;
    const startIndex = s.route.index;
    let reversed = false;
    for (let i = 0; i < 400 && !reversed; i++) {
      moveCharacter(s, ctx);
      if ((s.route.index & ROUTE_REVERSED) !== (startIndex & ROUTE_REVERSED)) {
        reversed = true;
      }
    }
    expect(reversed).toBe(true);
  });

  it('leaves characters 12 and up for the event handler', () => {
    // $C6E2 jumps to character_event instead of reversing. Until that lands
    // they stop, which must not corrupt the route.
    const s = characterStructs()[13]!;
    s.route = { index: 1, step: 3 }; // sitting on route 1's terminator
    const r = moveCharacter(s, ctx);
    expect(r.routeEnded).toBe(true);
    expect(s.route).toEqual({ index: 1, step: 3 });
  });

  it('never leaves a character on a position that is not a byte', () => {
    const structs = characterStructs();
    const random = seeded(7);
    for (let i = 0; i < 2000; i++) {
      const s = structs[i % structs.length]!;
      moveCharacter(s, { random });
      expect(Number.isInteger(s.pos.x)).toBe(true);
      expect(s.pos.x).toBeGreaterThanOrEqual(0);
      expect(s.pos.x).toBeLessThanOrEqual(255);
      expect(s.pos.y).toBeGreaterThanOrEqual(0);
      expect(s.pos.y).toBeLessThanOrEqual(255);
    }
  });
});

describe('the rotating character index', () => {
  it('wraps at 26, never reaching the stove', () => {
    // $C6A9 CP $1A: character_26_STOVE_1 is the wrap point, so the movables
    // are never considered by this routine.
    expect(MOVE_CHARACTER_LIMIT).toBe(26);
    expect(nextCharacterIndex(24)).toBe(25);
    expect(nextCharacterIndex(25)).toBe(0);
  });

  it('visits every character once per cycle', () => {
    const seen = new Set<number>();
    let i = 0;
    for (let n = 0; n < MOVE_CHARACTER_LIMIT; n++) {
      i = nextCharacterIndex(i);
      seen.add(i);
    }
    expect(seen.size).toBe(MOVE_CHARACTER_LIMIT);
  });
});

describe('random_nibble (c$CB85)', () => {
  it('returns a nibble', () => {
    const p = new Prng();
    for (let i = 0; i < 300; i++) {
      const v = p.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(15);
    }
  });

  it('increments before reading, so it never returns $9000\'s nibble first', () => {
    // $CB89 INC L comes BEFORE $CB8A LD A,(HL).
    const p = new Prng(0);
    expect(p.pointer).toBe(PRNG_BASE);
    p.next();
    expect(p.pointer).toBe(PRNG_BASE + 1);
  });

  it('wraps within 256 bytes rather than walking into the next page', () => {
    // INC L has no carry into H, so the high byte never changes.
    const p = new Prng(0xff);
    p.next();
    expect(p.pointer).toBe(PRNG_BASE);
  });

  it('cycles with a period of 256', () => {
    const a = new Prng(0);
    const b = new Prng(0);
    const first = Array.from({ length: 256 }, () => a.next());
    for (let i = 0; i < 256; i++) b.next();
    const second = Array.from({ length: 256 }, () => b.next());
    expect(second).toEqual(first);
  });

  it('is not constant -- it really is reading artwork', () => {
    const p = new Prng();
    const seen = new Set(Array.from({ length: 256 }, () => p.next()));
    expect(seen.size).toBeGreaterThan(4);
  });
});

describe('walking through a door lands on the far side', () => {
  it('never leaves a character outdoors at an indoor height', () => {
    // The bug this covers: passThroughDoor indexed halfDoors with the route's
    // DOOR BYTE -- a pair index carrying the reverse flag in bit 7 -- rather
    // than the resolved half-door index. That lands on an unrelated door, and
    // when the lookup misses entirely the character keeps its old position.
    // An indoor height of 24 carried outdoors is 192 world units, which draws
    // the character 168 pixels up: on top of the hut roofs.
    const random = seeded();
    const structs = characterStructs();
    let transitions = 0;
    for (const s of structs) {
      for (let i = 0; i < 3000; i++) {
        const r = moveCharacter(s, { random });
        if (r.changedRoom === null) continue;
        transitions++;
        if (s.room === ROOM_OUTDOORS) {
          // Outdoor character structs sit at tinypos heights of a few units;
          // 24 is an indoor value and would put the character in the air.
          expect(s.pos.height, `char ${s.character} stepped outdoors`)
            .toBeLessThanOrEqual(8);
        }
      }
    }
    expect(transitions).toBeGreaterThan(100);
  });

  it('actually moves the character when it changes room', () => {
    // A missed lookup left the position untouched, so a character "walked
    // through" a door without going anywhere.
    const random = seeded();
    const structs = characterStructs();
    const s = structs[3]!; // starts in room 16, walks a route through doors
    let moved = 0;
    let changes = 0;
    for (let i = 0; i < 3000; i++) {
      const before = { ...s.pos };
      const r = moveCharacter(s, { random });
      if (r.changedRoom === null) continue;
      changes++;
      if (before.x !== s.pos.x || before.y !== s.pos.y || before.height !== s.pos.height) {
        moved++;
      }
    }
    expect(changes).toBeGreaterThan(5);
    expect(moved).toBe(changes);
  });
});
