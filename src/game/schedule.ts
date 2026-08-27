/**
 * The day: dispatch_timed_event (c$A1A0) and the fifteen events it fires.
 *
 * The clock is a single byte that advances once every 64 main-loop iterations
 * ($9DC5 `AND $3F`) and wraps at 140 ($A1A5), so a day is 140 x 64 = 8,960
 * frames. Each tick the table at $A173 is searched for an entry whose time
 * matches exactly -- there is no "have we passed it" logic, so an event whose
 * clock value is skipped never fires at all.
 *
 * Almost every event does the same thing: assign routes. The cast is the ten
 * characters in prisoners_and_guards ($A27F) -- four guards and six prisoners
 * -- plus the hero, and the day is essentially a sequence of route changes that
 * walk everyone to the yard, the mess hall and back to bed.
 *
 * Two ways of assigning them, and the difference matters:
 *
 *   variant A ($A35F)  each character gets its OWN route: the first gets the
 *                      index passed in, the second index+1, and so on. Used for
 *                      roll call, where everyone stands in a different spot.
 *   variant B ($A373)  the list is split in half at the sixth entry. The first
 *                      half shares one route and the second half shares
 *                      index+1. Used for everything else.
 */

import charactersJson from '../../data/characters.json';
import timingJson from '../../data/timing.json';

import { characterStructFor, type CharacterStruct } from './characters.js';
import { getTargetAssignPos, FLAGS_TARGET_IS_DOOR } from './behaviour.js';
import { isEmpty, npcSlots, type Vischar } from './vischar.js';

interface TimedEvent {
  readonly clock: number;
  readonly handler: string;
  readonly labels: readonly string[];
}

const timing = timingJson as unknown as {
  timedEvents: {
    clockWrap: number;
    ticksPerClock: number;
    entries: TimedEvent[];
  };
};

const characters = charactersJson as unknown as {
  prisonersAndGuards: { values: number[] };
};

export const timedEvents: readonly TimedEvent[] = timing.timedEvents.entries;

/** The clock wraps here ($A1A5 CP $8C). */
export const CLOCK_WRAP = timing.timedEvents.clockWrap;
/** One clock step per 64 main-loop iterations ($9DC8 AND $3F). */
export const TICKS_PER_CLOCK = timing.timedEvents.ticksPerClock;
/** A full day in frames. */
export const DAY_LENGTH_TICKS = CLOCK_WRAP * TICKS_PER_CLOCK;

/**
 * prisoners_and_guards ($A27F): guards 12..15 and prisoners 20..25.
 *
 * The order is not sorted, and that is load-bearing for variant B's split:
 * [12, 13, 20, 21, 22, | 14, 15, 23, 24, 25]. Each half is two guards and
 * three prisoners, which is why the two huts end up evenly populated.
 */
export const prisonersAndGuards: readonly number[] =
  characters.prisonersAndGuards.values;

export interface ScheduleState {
  /** The game clock ($A13D). */
  clock: number;
  /** day_or_night ($A146): $FF at night. */
  night: boolean;
  /** hero_in_bed ($A13F). */
  heroInBed: boolean;
  /** hero_in_breakfast ($A137). */
  heroInBreakfast: boolean;
  /** The exercise yard gates, locked outside exercise time. */
  gatesLocked: boolean;
}

/**
 * Write the low byte of x and y, leaving the high bytes alone.
 *
 * `LD (HL),$2E` at $A293 is a single-byte store into mi.pos.x's low half. Both
 * events that reposition the hero do this, and both are only ever meant to run
 * while he is indoors, where the high bytes are zero.
 */
function setPositionLowByte(
  pos: { x: number; y: number; height: number },
  x: number,
  y: number,
): void {
  pos.x = (pos.x & 0xff00) | x;
  pos.y = (pos.y & 0xff00) | y;
}

/**
 * @param heroInBed reset_game puts the hero to bed ($B794), so the game's own
 *   start state is `true`. A caller that starts him standing instead must say
 *   so, or event_wake_up will reposition someone who was never asleep.
 */
export function createSchedule(heroInBed = true): ScheduleState {
  return {
    clock: 0,
    night: false,
    heroInBed,
    heroInBreakfast: false,
    gatesLocked: true,
  };
}

export interface ScheduleContext {
  readonly structs: CharacterStruct[];
  readonly vischars: Vischar[];
  readonly random: () => number;
  /** The global current room index ($68A0). */
  readonly room: number;
  /**
   * The hero's vischar (slot 0), which several events reassign.
   *
   * The route lives here rather than in a parallel object because
   * set_hero_route ($A344) does three things at once -- clear
   * TARGET_IS_DOOR, store the route, and take a target -- and the target is
   * what character_behaviour steers by. Setting the route alone leaves the
   * hero walking toward whatever target was there before, which for a fresh
   * slot is (0,0): off the top-left corner of the map.
   */
  readonly hero: Vischar;
  /** The hero's position, for the events that reposition him. */
  readonly heroPos: { x: number; y: number; height: number };
  /** in_solitary ($A13A): set_hero_route does nothing while it is set. */
  readonly inSolitary?: boolean;
}

/**
 * set_hero_route ($A33F / $A344).
 *
 * Three steps, and skipping the last is the interesting failure: the target is
 * what character_behaviour actually steers by, so a route without one sends
 * the hero to wherever the stale target points.
 *
 * $A343 also makes the whole thing a no-op while the hero is in solitary --
 * the events still fire, they just do not move him.
 */
export function setHeroRoute(
  ctx: ScheduleContext,
  index: number,
  step: number,
): void {
  if (ctx.inSolitary) return; // $A343

  ctx.hero.flags &= ~FLAGS_TARGET_IS_DOOR & 0xff; // $A347
  ctx.hero.route = { index, step }; // $A34A
  getTargetAssignPos(ctx.hero, {
    // $A34D -> set_route -> get_target
    random: ctx.random,
    structs: ctx.structs,
    room: ctx.room,
  });
}

/**
 * set_character_route ($A38C): give one character a route.
 *
 * The character may be off-screen, in which case the route goes into its
 * character struct, or on-screen, in which case it goes into the vischar AND
 * the vischar immediately takes a target ($A3BB set_route). Writing only the
 * struct would leave a visible character walking to its old destination until
 * something else disturbed it.
 */
export function setCharacterRoute(
  character: number,
  route: { index: number; step: number },
  ctx: ScheduleContext,
): void {
  const struct = characterStructFor(ctx.structs, character);

  // $A38F: on-screen characters are found in the vischar array instead.
  if (struct?.onScreen) {
    const slot = npcSlots(ctx.vischars).find(
      (v) => !isEmpty(v) && (v.character & 0x1f) === (character & 0x1f),
    );
    if (slot) {
      // $A3B4: reassigning a route clears TARGET_IS_DOOR -- the old target may
      // have been a door, and the flag decides both the coordinate scaling and
      // what arriving means.
      slot.flags &= ~FLAGS_TARGET_IS_DOOR & 0xff;
      slot.route = { ...route };
      getTargetAssignPos(slot, {
        random: ctx.random,
        structs: ctx.structs,
        room: ctx.room,
      });
      return;
    }
    // $A3A6: not found in the array despite the flag -- give up rather than
    // fall through to the struct, which is what the original does.
    return;
  }

  if (struct) struct.route = { ...route };
}

/**
 * set_prisoners_and_guards_route, variant A ($A35F).
 *
 * Every character gets its own route: index, index+1, index+2... Used only by
 * roll call, where the ten of them line up in ten different places.
 */
export function setCastRoutesIndividual(
  index: number,
  step: number,
  ctx: ScheduleContext,
): void {
  prisonersAndGuards.forEach((character, i) => {
    setCharacterRoute(character, { index: (index + i) & 0xff, step }, ctx);
  });
}

/**
 * set_prisoners_and_guards_route, variant B ($A373).
 *
 * The list is split at the sixth entry: the first five share `index`, the
 * remaining five share `index + 1`. The loop counter is compared against 6
 * ($A380) -- counting DOWN from 10, so the bump happens after five characters,
 * not after six.
 */
export function setCastRoutesSplit(
  index: number,
  step: number,
  ctx: ScheduleContext,
): void {
  prisonersAndGuards.forEach((character, i) => {
    const bumped = i >= 5 ? (index + 1) & 0xff : index;
    setCharacterRoute(character, { index: bumped, step }, ctx);
  });
}

/**
 * set_guards_route ($A26E): guards 12..15 get consecutive routes.
 *
 * Shared by event_time_for_bed and event_search_light, which differ only in
 * the route they start from.
 */
export function setGuardsRoute(
  index: number,
  step: number,
  ctx: ScheduleContext,
): void {
  for (let i = 0; i < 4; i++) {
    setCharacterRoute(12 + i, { index: (index + i) & 0xff, step }, ctx);
  }
}

/** Put a run of prisoners in a room ($A2A3 / $A2FC). */
function placePrisoners(
  ctx: ScheduleContext,
  from: number,
  count: number,
  room: number,
): void {
  for (let i = 0; i < count; i++) {
    const struct = characterStructFor(ctx.structs, from + i);
    if (struct) struct.room = room;
  }
}

export interface EventOutcome {
  /** Which event fired, by label. */
  readonly event: string;
  /** Anything the demo should surface. */
  readonly note?: string;
}

/**
 * The fifteen handlers, keyed by the address the table points at.
 *
 * Everything here that is NOT implemented is listed rather than silently
 * skipped, because a day that runs but quietly omits half its events would
 * look like it worked.
 */
const handlers: Record<
  string,
  (s: ScheduleState, ctx: ScheduleContext) => EventOutcome
> = {
  // $A1D3: clear the night flag. The message queue and morale are P5.
  $A1D3: (s) => {
    s.night = false;
    return { event: 'another day dawns', note: 'morale -25 pending P5' };
  },

  // $A1E7 -> wake_up ($A289).
  $A1E7: (s, ctx) => {
    // $A290..$A297: the hero climbs out of bed. Note this writes the LOW BYTE
    // of mi.pos.x and mi.pos.y only -- `LD (HL),$2E` is one byte, and the high
    // bytes are left alone. Indoors, where this is meant to fire, they are
    // zero and it reads as (46, 46). Assigning the whole 16-bit value instead
    // teleports an OUTDOOR hero to the top-left corner of the world.
    if (s.heroInBed) {
      setPositionLowByte(ctx.heroPos, 0x2e, 0x2e);
    }
    s.heroInBed = false;
    setHeroRoute(ctx, 42, 0); // routeindex_42_HUT2_LEFT_TO_RIGHT

    // $A2A3: prisoners 20..22 to hut 2 right, 23..25 to hut 3 right.
    placePrisoners(ctx, 20, 3, 3);
    placePrisoners(ctx, 23, 3, 5);
    setCastRoutesSplit(5, 0, ctx); // $A2B9

    // $A2C1 empties the beds. The iteration count there is 7 over a six-entry
    // array and writes to ROM at $1A42 -- see FIDELITY.md; we use six.
    return { event: 'wake up' };
  },

  // $A228: red cross parcels are P5.
  $A228: () => ({ event: 'new red cross parcel', note: 'parcels are P5' }),

  // $A1F0 -> go_to_roll_call ($A4FD).
  $A1F0: (_s, ctx) => {
    setCastRoutesIndividual(26, 0, ctx); // routeindex_26_GUARD_12_ROLL_CALL
    setHeroRoute(ctx, 45, 0); // routeindex_45_HERO_ROLL_CALL
    return { event: 'roll call' };
  },

  // $EF9A: the roll call check itself is P5 (it decides whether the hero is
  // missed, which needs morale and solitary).
  $EF9A: () => ({ event: 'roll call check', note: 'the check itself is P5' }),

  // $A1F9 -> set_route_go_to_breakfast ($A4C5).
  $A1F9: (_s, ctx) => {
    setHeroRoute(ctx, 16, 0); // routeindex_16_BREAKFAST_25
    setCastRoutesSplit(16, 0, ctx);
    return { event: 'breakfast time' };
  },

  // $A202 -> end_of_breakfast ($A2E2).
  $A202: (s, ctx) => {
    // $A2E9..$A2F0: the same low-byte write as wake_up's.
    if (s.heroInBreakfast) {
      setPositionLowByte(ctx.heroPos, 0x34, 0x3e);
    }
    s.heroInBreakfast = false;
    setHeroRoute(ctx, 0x90, 3); // REVERSED routeindex_16

    placePrisoners(ctx, 20, 3, 25); // room_25_MESS_HALL
    placePrisoners(ctx, 23, 3, 23); // room_23_MESS_HALL
    setCastRoutesSplit(0x90, 3, ctx);
    return { event: 'end of breakfast' };
  },

  // $A206 -> set_route_go_to_yard ($A4A9), having unlocked the gates.
  $A206: (s, ctx) => {
    s.gatesLocked = false; // $A20C
    setHeroRoute(ctx, 14, 0); // routeindex_14_GO_TO_YARD
    setCastRoutesSplit(14, 0, ctx);
    return { event: 'exercise time' };
  },

  // $A215 -> set_route_go_to_yard_reversed ($A4B7).
  $A215: (_s, ctx) => {
    setHeroRoute(ctx, 0x8e, 4); // REVERSED routeindex_14
    setCastRoutesSplit(0x8e, 4, ctx);
    return { event: 'end of exercise' };
  },

  // $A219 -> go_to_time_for_bed ($A351), having locked the gates.
  $A219: (s, ctx) => {
    s.gatesLocked = true; // $A21A
    setHeroRoute(ctx, 0x85, 2); // REVERSED routeindex_5_EXIT_HUT2
    setCastRoutesSplit(0x85, 2, ctx);
    return { event: 'time for bed' };
  },

  // $A264: guards 12..15 head into the huts.
  $A264: (_s, ctx) => {
    setGuardsRoute(0xa6, 3, ctx); // REVERSED routeindex_38_GUARD_12_BED
    return { event: 'guards to bed' };
  },

  // $A1C3 -> event_night_time.
  $A1C3: (s, ctx) => {
    if (!s.heroInBed) {
      setHeroRoute(ctx, 44, 1); // routeindex_44_HUT2_RIGHT_TO_LEFT
    }
    s.night = true;
    return { event: 'night time' };
  },

  // $A26A: guards 12..15 leave the huts again.
  $A26A: (_s, ctx) => {
    setGuardsRoute(0x26, 0, ctx); // routeindex_38_GUARD_12_BED
    return { event: 'searchlight' };
  },
};

/**
 * dispatch_timed_event (c$A1A0): advance the clock and fire any match.
 *
 * The comparison is for EQUALITY ($A1B0 CP (HL)), so an event is missed
 * entirely if its clock value is skipped. That matters for any debug control
 * that jumps the clock: it must land on the value, not past it.
 */
export function dispatchTimedEvent(
  s: ScheduleState,
  ctx: ScheduleContext,
): EventOutcome | null {
  // $A1A3..$A1AA: increment, wrapping at 140.
  s.clock = s.clock + 1 === CLOCK_WRAP ? 0 : s.clock + 1;

  const entry = timedEvents.find((e) => e.clock === s.clock);
  if (!entry) return null;

  const handler = handlers[entry.handler];
  if (!handler) return { event: entry.labels[0] ?? entry.handler, note: 'unimplemented' };
  return handler(s, ctx);
}

/** The event that will fire at a given clock value, for the demo's controls. */
export function eventAt(clock: number): TimedEvent | undefined {
  return timedEvents.find((e) => e.clock === clock);
}
