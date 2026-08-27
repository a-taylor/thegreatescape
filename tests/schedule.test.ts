/**
 * dispatch_timed_event (c$A1A0), the fifteen timed events, and the route
 * assignment helpers at $A35F / $A373 / $A26E.
 */

import { describe, expect, it } from 'vitest';

import {
  CLOCK_WRAP,
  DAY_LENGTH_TICKS,
  TICKS_PER_CLOCK,
  createSchedule,
  dispatchTimedEvent,
  eventAt,
  prisonersAndGuards,
  setCastRoutesIndividual,
  setCastRoutesSplit,
  setCharacterRoute,
  setGuardsRoute,
  setHeroRoute,
  timedEvents,
  type ScheduleContext,
} from '../src/game/schedule.js';
import { characterStructs, characterStructFor } from '../src/game/characters.js';
import { createVischars } from '../src/game/vischar.js';
import { FLAGS_TARGET_IS_DOOR, characterBehaviour } from '../src/game/behaviour.js';
import { animateVischar } from '../src/game/animate.js';
import { moveCharacter, nextCharacterIndex } from '../src/game/move.js';
import { purgeInvisibleCharacters, spawnCharacters } from '../src/game/spawn.js';
import { isEmpty, npcSlots } from '../src/game/vischar.js';
import { Prng } from '../src/game/prng.js';
import { HERO_STANDING_HEIGHT, createHero, step } from '../src/game/hero.js';
import { createAutomaticState, heroIsAutomatic, noteInput } from '../src/game/events.js';
import { resetOutdoorPosition } from '../src/render/place.js';

function ctx(): ScheduleContext & { structs: ReturnType<typeof characterStructs> } {
  let s = 1;
  return {
    structs: characterStructs(),
    vischars: createVischars(),
    random: () => (s = (s * 37 + 11) & 0xff),
    room: 0,
    hero: createVischars()[0]!,
    heroPos: { x: 0, y: 0, height: 24 },
  };
}

const routeOf = (c: ReturnType<typeof ctx>, character: number) =>
  characterStructFor(c.structs, character)!.route;

describe('the clock', () => {
  it('wraps at 140 and steps every 64 frames', () => {
    // $A1A5 CP $8C, and $9DC8 AND $3F.
    expect(CLOCK_WRAP).toBe(140);
    expect(TICKS_PER_CLOCK).toBe(64);
    expect(DAY_LENGTH_TICKS).toBe(8960);
  });

  it('returns to zero after a full day', () => {
    const s = createSchedule();
    const c = ctx();
    for (let i = 0; i < CLOCK_WRAP; i++) dispatchTimedEvent(s, c);
    expect(s.clock).toBe(0);
  });
});

describe('the timed events table', () => {
  it('is fifteen entries', () => {
    expect(timedEvents).toHaveLength(15);
  });

  it('names the day the acceptance criterion describes', () => {
    const byClock = Object.fromEntries(
      timedEvents.map((e) => [e.clock, e.labels[0]]),
    );
    expect(byClock[0]).toBe('event_another_day_dawns');
    expect(byClock[8]).toBe('event_wake_up');
    expect(byClock[16]).toBe('event_go_to_roll_call');
    expect(byClock[21]).toBe('event_go_to_breakfast_time');
    expect(byClock[46]).toBe('event_go_to_exercise_time');
    expect(byClock[79]).toBe('event_go_to_time_for_bed');
    expect(byClock[100]).toBe('event_night_time');
  });

  it('fires roll call twice a day, from the same handler', () => {
    const rollCalls = timedEvents.filter((e) => e.labels[0] === 'event_go_to_roll_call');
    expect(rollCalls.map((e) => e.clock)).toEqual([16, 74]);
    expect(rollCalls[0]!.handler).toBe(rollCalls[1]!.handler);
  });

  it('matches on equality, so a skipped clock value misses its event', () => {
    // $A1B0 CP (HL). There is no "have we passed it" test, which is why a
    // debug control that jumps the clock has to land on the value exactly.
    expect(eventAt(8)).toBeDefined();
    expect(eventAt(9)).toBeUndefined();
  });
});

describe('a full day', () => {
  it('fires every event exactly once', () => {
    const s = createSchedule();
    const c = ctx();
    const fired: string[] = [];
    for (let i = 0; i < CLOCK_WRAP; i++) {
      const out = dispatchTimedEvent(s, c);
      if (out) fired.push(out.event);
    }
    // Fifteen entries, but two pairs share a clock-distinct handler, so the
    // count is the number of table rows.
    expect(fired).toHaveLength(15);
  });

  it('runs wake up, roll call, breakfast, exercise and bed in order', () => {
    const s = createSchedule();
    const c = ctx();
    const seen: string[] = [];
    for (let i = 0; i < CLOCK_WRAP; i++) {
      const out = dispatchTimedEvent(s, c);
      if (out) seen.push(out.event);
    }
    const order = ['wake up', 'roll call', 'breakfast time', 'exercise time', 'time for bed'];
    let at = -1;
    for (const name of order) {
      const next = seen.indexOf(name, at + 1);
      expect(next, `${name} follows the previous event`).toBeGreaterThan(at);
      at = next;
    }
  });

  it('gets the hero out of bed and back into it', () => {
    const s = createSchedule();
    const c = ctx();
    expect(s.heroInBed).toBe(true); // reset_game leaves him asleep

    for (let i = 0; i < CLOCK_WRAP; i++) {
      dispatchTimedEvent(s, c);
      if (s.clock === 8) expect(s.heroInBed, 'awake after wake up').toBe(false);
      if (s.clock === 9) expect(c.heroPos.x, 'moved out of bed').toBe(46);
    }
  });

  it('turns the lights off at night and on at dawn', () => {
    const s = createSchedule();
    const c = ctx();
    for (let i = 0; i < CLOCK_WRAP; i++) {
      dispatchTimedEvent(s, c);
      if (s.clock === 100) expect(s.night).toBe(true);
      if (s.clock === 0) expect(s.night).toBe(false);
    }
  });

  it('unlocks the yard gates for exercise and locks them after', () => {
    const s = createSchedule();
    const c = ctx();
    for (let i = 0; i < CLOCK_WRAP; i++) {
      dispatchTimedEvent(s, c);
      if (s.clock === 46) expect(s.gatesLocked, 'open for exercise').toBe(false);
      if (s.clock === 79) expect(s.gatesLocked, 'shut at bedtime').toBe(true);
    }
  });
});

describe('the cast', () => {
  it('is four guards and six prisoners, interleaved', () => {
    // $A27F. The order is not sorted, and that matters for the split below:
    // each half is two guards and three prisoners.
    expect(prisonersAndGuards).toEqual([12, 13, 20, 21, 22, 14, 15, 23, 24, 25]);
    expect(prisonersAndGuards.slice(0, 5)).toEqual([12, 13, 20, 21, 22]);
    expect(prisonersAndGuards.slice(5)).toEqual([14, 15, 23, 24, 25]);
  });

  it('variant A gives each character its own route', () => {
    // $A35F: index, index+1, index+2...
    const c = ctx();
    setCastRoutesIndividual(26, 0, c);
    prisonersAndGuards.forEach((character, i) => {
      expect(routeOf(c, character).index, `character ${character}`).toBe(26 + i);
    });
  });

  it('variant B splits the list after the FIFTH character', () => {
    // $A380 compares the loop counter against 6, and it counts DOWN from 10 --
    // so the bump lands after five characters, not six. The disassembly names
    // the boundary: "the character being processed is character_22_PRISONER_3
    // and the next is character_14_GUARD_14".
    const c = ctx();
    setCastRoutesSplit(16, 0, c);
    for (const character of [12, 13, 20, 21, 22]) {
      expect(routeOf(c, character).index, `first half: ${character}`).toBe(16);
    }
    for (const character of [14, 15, 23, 24, 25]) {
      expect(routeOf(c, character).index, `second half: ${character}`).toBe(17);
    }
  });

  it('gives every one of them the same step', () => {
    const c = ctx();
    setCastRoutesSplit(0x90, 3, c);
    for (const character of prisonersAndGuards) {
      expect(routeOf(c, character).step).toBe(3);
    }
  });

  it('sends only guards 12..15 to bed', () => {
    // $A26E: four consecutive characters, four consecutive routes.
    const c = ctx();
    setGuardsRoute(0xa6, 3, c);
    for (let i = 0; i < 4; i++) {
      expect(routeOf(c, 12 + i)).toEqual({ index: 0xa6 + i, step: 3 });
    }
    // The prisoners are untouched.
    expect(routeOf(c, 20).index).not.toBe(0xa6);
  });
});

describe('assigning a route to an on-screen character', () => {
  it('writes the vischar, not the struct', () => {
    // $A38F: a character with characterstruct_FLAG_ON_SCREEN lives in the
    // vischar array. Writing the struct instead would leave the visible
    // character walking to its old destination.
    const c = ctx();
    const struct = characterStructFor(c.structs, 12)!;
    struct.onScreen = true;
    const slot = c.vischars[2]!;
    slot.character = 12;
    slot.flags = 0;

    setCharacterRoute(12, { index: 26, step: 0 }, c);
    expect(slot.route).toEqual({ index: 26, step: 0 });
  });

  it('clears TARGET_IS_DOOR when the route changes', () => {
    // $A3B4. The old target may have been a door, and the flag decides both
    // the coordinate scaling and what arriving means.
    const c = ctx();
    const struct = characterStructFor(c.structs, 12)!;
    struct.onScreen = true;
    const slot = c.vischars[2]!;
    slot.character = 12;
    slot.flags = FLAGS_TARGET_IS_DOOR;

    setCharacterRoute(12, { index: 26, step: 0 }, c);
    expect(slot.flags & FLAGS_TARGET_IS_DOOR).toBeFalsy();
  });

  it('gives the vischar a target straight away', () => {
    // set_route ($A3BB) runs get_target immediately, so the character starts
    // walking on the next frame rather than after some later prompt.
    const c = ctx();
    const struct = characterStructFor(c.structs, 12)!;
    struct.onScreen = true;
    const slot = c.vischars[2]!;
    slot.character = 12;
    slot.flags = 0;
    slot.target = { x: 0, y: 0, height: 0 };

    setCharacterRoute(12, { index: 26, step: 0 }, c);
    expect(slot.target).not.toEqual({ x: 0, y: 0, height: 0 });
  });
});

describe('the acceptance criterion: a full in-game day', () => {
  /**
   * The whole pipeline for one frame, in main_loop order:
   * move_a_character ($9D8D), character_behaviour ($9D90), purge ($9D93),
   * spawn ($9D96), animate ($9D9F), dispatch_timed_event ($9DC5).
   */
  it('runs wake up, roll call, breakfast, exercise and bed with the cast moving', () => {
    const prng = new Prng();
    const random = () => prng.next();
    const structs = characterStructs();
    const vischars = createVischars();
    const heroPos = { x: 100 * 8, y: 74 * 8, height: 24 };
    const heroSlot = createVischars()[0]!;
    const s = createSchedule();

    let moveIndex = 0;
    let frame = 0;
    let offScreenMoves = 0;
    const events: string[] = [];
    const roomsOccupied = new Set<number>();

    for (let t = 0; t < DAY_LENGTH_TICKS; t++) {
      const map = resetOutdoorPosition(heroPos);

      moveIndex = nextCharacterIndex(moveIndex);
      const mover = structs[moveIndex];
      if (mover && moveCharacter(mover, { random }).moved) offScreenMoves++;

      for (const v of npcSlots(vischars)) {
        if (!isEmpty(v)) characterBehaviour(v, { random, structs, room: 0 });
      }
      purgeInvisibleCharacters(vischars, structs, map, 0);
      spawnCharacters(vischars, structs, map, 0, { random });
      for (const v of npcSlots(vischars)) {
        if (!isEmpty(v)) animateVischar(v);
      }

      frame = (frame + 1) & 0xff;
      if ((frame & (TICKS_PER_CLOCK - 1)) === 0) {
        const fired = dispatchTimedEvent(s, {
          structs,
          vischars,
          random,
          room: 0,
          hero: heroSlot,
          heroPos,
        });
        if (fired) events.push(fired.event);
      }
      for (const st of structs) roomsOccupied.add(st.room);
    }

    // Every event fires, once, in schedule order.
    expect(events).toHaveLength(15);
    expect(events[0]).toBe('wake up');
    expect(events.at(-1)).toBe('another day dawns');

    // The cast genuinely walks: off-screen characters cover ground...
    expect(offScreenMoves).toBeGreaterThan(1000);
    // ...and the day takes them through the huts and both mess halls rather
    // than leaving them where they started.
    expect(roomsOccupied.has(23), 'someone reached mess hall 23').toBe(true);
    expect(roomsOccupied.has(25), 'someone reached mess hall 25').toBe(true);
    expect(roomsOccupied.size).toBeGreaterThan(15);

    // And the clock comes back round.
    expect(s.clock).toBe(0);
    expect(s.night).toBe(false);
  });
});

describe('set_hero_route ($A344)', () => {
  it('assigns a TARGET, not just a route', () => {
    // The bug this covers: character_behaviour steers by vischar.target, not
    // by the route. Setting the route alone leaves the hero walking toward
    // whatever target was there before -- for a fresh slot that is (0,0),
    // which is off the top-left corner of the map. He walks out of the world,
    // vanishes from the window, and the map clamps to (x, 0).
    const c = ctx();
    expect(c.hero.target).toEqual({ x: 0, y: 0, height: 0 });

    setHeroRoute(c, 14, 0); // routeindex_14_GO_TO_YARD
    expect(c.hero.route).toEqual({ index: 14, step: 0 });
    expect(c.hero.target).not.toEqual({ x: 0, y: 0, height: 0 });
  });

  it('clears TARGET_IS_DOOR first', () => {
    // $A347. The flag decides the coordinate scaling, so a stale one makes the
    // hero aim at the target multiplied by the wrong factor.
    const c = ctx();
    c.hero.flags = FLAGS_TARGET_IS_DOOR;
    setHeroRoute(c, 14, 0);
    expect(c.hero.flags & FLAGS_TARGET_IS_DOOR).toBeFalsy();
  });

  it('does nothing while the hero is in solitary', () => {
    // $A343: the events still fire, they just do not move him.
    const c = { ...ctx(), inSolitary: true };
    setHeroRoute(c, 14, 0);
    expect(c.hero.route).toEqual({ index: 0, step: 0 });
  });

  it('gives the hero a target at every event that reroutes him', () => {
    // Walk a whole day and check he is never left aiming at the origin.
    const s = createSchedule();
    const c = ctx();
    for (let i = 0; i < CLOCK_WRAP; i++) {
      dispatchTimedEvent(s, c);
      if (c.hero.route.index === 0) continue; // not yet rerouted
      expect(c.hero.target, `clock ${s.clock}`).not.toEqual({ x: 0, y: 0, height: 0 });
    }
  });
});

describe('the automatic hero stays on the map', () => {
  it('walks toward his target rather than off the world', () => {
    const prng = new Prng();
    const random = () => prng.next();
    const structs = characterStructs();
    const vischars = createVischars();
    const heroSlot = vischars[0]!;
    heroSlot.character = 0;
    heroSlot.flags = 0;
    const hero = createHero(
      { x: 100 * 8, y: 74 * 8, height: HERO_STANDING_HEIGHT },
      0,
      0,
    );
    const auto = createAutomaticState();
    const c: ScheduleContext = {
      structs,
      vischars,
      random,
      room: 0,
      hero: heroSlot,
      heroPos: hero.pos,
    };
    setHeroRoute(c, 14, 0);

    for (let i = 0; i < 3000; i++) {
      noteInput(auto, 0);
      let input = 0;
      if (heroIsAutomatic(auto)) {
        heroSlot.pos = { ...hero.pos };
        heroSlot.room = hero.room;
        characterBehaviour(heroSlot, { random, structs, room: 0 });
        input = heroSlot.input & 0x0f;
      }
      // ONE step per tick. Stepping again for the automatic input would double
      // his speed while move_map scrolled once, walking him out of the window.
      step(hero, input, undefined);

      const tinyX = hero.pos.x >> 3;
      const tinyY = hero.pos.y >> 3;
      expect(tinyX, `tick ${i}`).toBeGreaterThanOrEqual(0);
      expect(tinyX).toBeLessThanOrEqual(255);
      expect(tinyY).toBeGreaterThanOrEqual(0);
      expect(tinyY).toBeLessThanOrEqual(255);
    }
  });
});

describe('the events that reposition the hero', () => {
  /** A context with the hero in bed and an OUTDOOR position. */
  function inBed() {
    const c = ctx();
    // A world-scale position: high bytes non-zero, as outdoors.
    c.heroPos.x = 100 * 8;
    c.heroPos.y = 74 * 8;
    return c;
  }

  it('writes only the LOW BYTE of x and y', () => {
    // $A293 `LD (HL),$2E` is a one-byte store into mi.pos.x's low half, and
    // $A297 does the same for y. The high bytes are untouched.
    //
    // Indoors -- where this is meant to fire -- they are zero and the result
    // reads as (46, 46). Assign the whole 16-bit value instead and an OUTDOOR
    // hero is teleported to the top-left corner of the world, walks out of the
    // window and disappears.
    const s = createSchedule(true);
    const c = inBed();
    const beforeHighX = c.heroPos.x & 0xff00;
    const beforeHighY = c.heroPos.y & 0xff00;

    for (let i = 0; i < 9; i++) dispatchTimedEvent(s, c); // clock 8: wake up

    expect(c.heroPos.x & 0x00ff).toBe(0x2e);
    expect(c.heroPos.y & 0x00ff).toBe(0x2e);
    expect(c.heroPos.x & 0xff00, 'high byte preserved').toBe(beforeHighX);
    expect(c.heroPos.y & 0xff00, 'high byte preserved').toBe(beforeHighY);
  });

  it('reads as (46, 46) for a hero who really is indoors', () => {
    // The case the write was designed for: the high bytes are already zero.
    const s = createSchedule(true);
    const c = ctx();
    c.heroPos.x = 60;
    c.heroPos.y = 60;
    for (let i = 0; i < 9; i++) dispatchTimedEvent(s, c);
    expect(c.heroPos).toEqual({ x: 46, y: 46, height: 24 });
  });

  it('leaves a hero who was never in bed exactly where he is', () => {
    // $A28D skips the write when hero_in_bed is clear. The demo starts him
    // standing, so its schedule is built with the flag false -- otherwise
    // wake_up repositions someone who was never asleep.
    const s = createSchedule(false);
    const c = inBed();
    const before = { ...c.heroPos };
    for (let i = 0; i < 9; i++) dispatchTimedEvent(s, c);
    expect(c.heroPos).toEqual(before);
  });

  it('does the same one-byte write at the end of breakfast', () => {
    // $A2E9..$A2F0, to (52, 62).
    const s = createSchedule(false);
    const c = inBed();
    s.heroInBreakfast = true;
    for (let i = 0; i < 37; i++) dispatchTimedEvent(s, c); // clock 36
    expect(c.heroPos.x & 0x00ff).toBe(0x34);
    expect(c.heroPos.y & 0x00ff).toBe(0x3e);
    expect(c.heroPos.x & 0xff00).toBe(100 * 8 & 0xff00);
  });
});
