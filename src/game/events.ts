/**
 * character_event (c$C7C6): what happens when a route runs out.
 *
 * move_a_character and route_ended both hand characters here when their route
 * ends and they are not one of the ones that simply turns around. The route
 * index decides what happens, in two stages.
 *
 * First, two RANGES are checked directly:
 *
 *   7..12    character_sleeps ($A444) -- the six prisoner beds
 *   18..22   character_sits   ($A420) -- the mess hall benches
 *
 * The second range is one short. `$C7D4 CP $17` should be `$18`, and the
 * disassembly says what that costs: "the sixth prisoner doesn't sit for
 * breakfast because this should be $18". Reproduced -- it is a visible quirk,
 * not a crash.
 *
 * Everything else falls through to a lookup in
 * character_to_event_handler_index_map ($C7F9), 24 pairs of (route index,
 * handler index). A route not in the map halts the character outright ($C7E7),
 * which is the default rather than an error.
 *
 * Note the index is compared UNMASKED, so a reversed route ($80 | n) is a
 * different key from its forward form -- and the map does contain both, with
 * different handlers. Masking bit 7 off first would collapse pairs that the
 * game deliberately keeps apart.
 */

import charactersJson from '../../data/characters.json';

import { ROUTE_WANDER } from './routes.js';

const characters = charactersJson as unknown as {
  eventHandlerIndexMap: { values: number[] };
};

/** routeindex_7 upward are the sleeping prisoners ($C7C7). */
export const FIRST_SLEEP_ROUTE = 7;
export const LAST_SLEEP_ROUTE = 12;
/** routeindex_18 upward are the seated prisoners ($C7D2). */
export const FIRST_SIT_ROUTE = 18;
/**
 * The sitting range's upper bound, AS CODED ($C7D4 CP $17).
 *
 * 23 would be the sixth prisoner. The comparison stops at 22, so that
 * prisoner never sits down for breakfast.
 */
export const LAST_SIT_ROUTE_AS_CODED = 22;
/** What the bound should have been, kept for the test that documents it. */
export const LAST_SIT_ROUTE_INTENDED = 23;

export interface EventMapEntry {
  readonly route: number;
  readonly handler: number;
}

export const eventHandlerMap: readonly EventMapEntry[] = (() => {
  const v = characters.eventHandlerIndexMap.values;
  const out: EventMapEntry[] = [];
  for (let i = 0; i < v.length; i += 2) {
    out.push({ route: v[i]!, handler: v[i + 1]! });
  }
  return out;
})();

export type CharacterEventKind =
  | 'sleeps'
  | 'sits'
  | 'halt'
  | 'wander'
  | 'setRoute'
  | 'bed'
  | 'breakfast'
  | 'heroSits'
  | 'heroSleeps'
  | 'heroRelease'
  | 'solitaryEnds'
  | 'commandantToYard';

/**
 * The route charevnt_hero_release forces onto the HERO ($C856 LD BC,$2500).
 *
 * Route 37 is the walk out of the cell; finishing it fires
 * charevnt_solitary_ends ($C83F), which is the only thing that ever clears
 * in_solitary. Miss this and the hero never leaves solitary.
 */
export const HERO_RELEASE_ROUTE = { index: 0x25, step: 0x00 };

export interface CharacterEvent {
  readonly kind: CharacterEventKind;
  /** For 'wander': the route step, which picks the block of eight locations. */
  readonly step?: number;
  /** For 'setRoute': the route to adopt. */
  readonly route?: { index: number; step: number };
}

/**
 * The eleven handlers at $C829, by index.
 *
 * Five of them are "wander from location block N" ($C85C/$C860/$C864), which
 * set the route to (routeindex_255_WANDER, step). The step is what selects the
 * block: 8 is locations 8..15, 16 is 16..23, 56 is 56..63.
 */
function handlerEffect(index: number): CharacterEvent {
  switch (index) {
    case 0: // $C864 charevnt_wander_top -- locations 8..15
      return { kind: 'wander', step: 0x08 };
    case 1: // $C85C charevnt_wander_left -- locations 16..23
      return { kind: 'wander', step: 0x10 };
    case 2: // $C860 charevnt_wander_yard -- locations 56..63
      return { kind: 'wander', step: 0x38 };
    case 3: // $C86C charevnt_bed
      return { kind: 'bed' };
    case 4: // $C83F charevnt_solitary_ends -- clears in_solitary, then wanders
      return { kind: 'solitaryEnds', step: 0x08 };
    case 5: // $C877 charevnt_breakfast
      return { kind: 'breakfast' };
    case 6: // $C845 charevnt_commandant_to_yard -- route (3, 21)
      return { kind: 'commandantToYard', route: { index: 0x03, step: 0x15 } };
    case 7: // $C882 charevnt_exit_hut2 -- route (5, 0)
      return { kind: 'setRoute', route: { index: 0x05, step: 0x00 } };
    case 8: // $C88D charevnt_hero_sleeps
      return { kind: 'heroSleeps' };
    case 9: // $C889 charevnt_hero_sits
      return { kind: 'heroSits' };
    // $C84C charevnt_hero_release. It sets THIS character's route to
    // ($A4, 3) and then does two things to the HERO: zeroes the automatic
    // player counter ($C853) and FORCES his route to (37, 0) via $A344
    // ($C859). Those two are side effects on global state, so the caller
    // applies them -- see HERO_RELEASE_ROUTE.
    case 10:
      return { kind: 'heroRelease', route: { index: 0xa4, step: 0x03 } };
    default:
      return { kind: 'halt' };
  }
}

/**
 * Decide what a character does when its route ends ($C7C6).
 *
 * @param routeIndex the route index, WITH its reversed flag intact
 */
export function characterEvent(routeIndex: number): CharacterEvent {
  // $C7C7..$C7CD: the sleeping range is tested first, and only for indices
  // that are at least 7 -- a smaller index skips straight to the sit test.
  if (routeIndex >= FIRST_SLEEP_ROUTE && routeIndex <= LAST_SLEEP_ROUTE) {
    return { kind: 'sleeps' };
  }

  // $C7D2..$C7D6. The upper bound is 22, not 23; see LAST_SIT_ROUTE_AS_CODED.
  if (routeIndex >= FIRST_SIT_ROUTE && routeIndex <= LAST_SIT_ROUTE_AS_CODED) {
    return { kind: 'sits' };
  }

  const entry = eventHandlerMap.find((e) => e.route === routeIndex);
  // $C7E7: an unmapped route halts the character. Not an error path -- most
  // routes are not in the map.
  if (!entry) return { kind: 'halt' };

  return handlerEffect(entry.handler);
}

/**
 * Apply an event's route change, where it has one.
 *
 * The bed, breakfast, sit and sleep events also poke interior objects --
 * OCCUPIED_BED, OCCUPIED_BENCH -- and move the character into a specific room.
 * That belongs with the room-object work in P5; here they resolve to a route
 * change only, and the caller is told which kind it was so nothing is silently
 * dropped.
 */
/**
 * character_bed_common ($A404) and charevnt_breakfast_common ($A4E4).
 *
 * Both do the same shape of thing: step to zero, then a route index derived
 * from the character index. The split is at 19 -- "is the character index less
 * than or equal to character_19_GUARD_DOG_4" -- so hostiles get a shared pair
 * of routes and prisoners get one each.
 *
 *   bed        hostile: 13, or 13|REVERSED with step 1 when the index is odd
 *              prisoner: index - 13, so 20..25 map to routes 7..12
 *   breakfast  hostile: 24 when even, 25 when odd
 *              prisoner: index - 2, so 20..25 map to routes 18..23
 *
 * The commandant is handled before this, in the vischar path ($A3FB / $A4DB),
 * and gets route 44 for bed or 43 for breakfast. The HERO takes that branch
 * too: his vischar also carries character 0. Route 43 then maps to
 * charevnt_hero_sits and 44 to charevnt_hero_sleeps, which is how he ends up
 * sitting down rather than standing about.
 */
function bedOrBreakfastRoute(
  kind: 'bed' | 'breakfast',
  character: number,
): { index: number; step: number } {
  const c = character & 0x1f;

  // $A3FB / $A4DB: commandant -- and the hero, who shares the index.
  if (c === 0) return { index: kind === 'bed' ? 0x2c : 0x2b, step: 0 };

  // $A407 / $A4E7: `CP $13` then JP Z / JP C, so 19 and below are hostile.
  const hostile = c <= 19;
  if (!hostile) {
    return { index: c - (kind === 'bed' ? 13 : 2), step: 0 }; // $A40F / $A4EF
  }

  if (kind === 'breakfast') {
    return { index: c & 1 ? 25 : 24, step: 0 }; // $A4F5..$A4F9
  }
  // $A413..$A41B: an odd hostile walks its bed route backwards, from step 1.
  return c & 1
    ? { index: 13 | 0x80, step: 1 }
    : { index: 13, step: 0 };
}

export function applyCharacterEvent(
  event: CharacterEvent,
  route: { index: number; step: number },
  character = 0xff,
): boolean {
  switch (event.kind) {
    case 'wander':
    case 'solitaryEnds':
      // $C866: route becomes (routeindex_255_WANDER, block).
      route.index = ROUTE_WANDER;
      route.step = event.step ?? 0;
      return true;
    case 'setRoute':
    case 'commandantToYard':
    case 'heroRelease':
      if (event.route) {
        route.index = event.route.index;
        route.step = event.route.step;
      }
      return true;
    case 'halt':
      route.index = 0; // routeindex_0_HALT
      route.step = 0;
      return true;
    case 'bed':
    case 'breakfast': {
      if (character === 0xff) return false; // caller did not supply one
      const next = bedOrBreakfastRoute(event.kind, character);
      route.index = next.index;
      route.step = next.step;
      return true;
    }
    default:
      // sleeps / sits / heroSits / heroSleeps also poke interior objects and
      // hide the character inside the furniture. The caller is told which
      // happened so it can apply the flag and position.
      return false;
  }
}

/* -------------------------------------------------------------------------
 * automatics
 * ---------------------------------------------------------------------- */

/** Turns of idleness before the game takes the hero over ($9E34 / $9E18). */
export const AUTOMATIC_PLAYER_DELAY = 31;

export interface AutomaticState {
  /** automatic_player_counter ($A139). */
  counter: number;
  /** in_solitary ($A13A). */
  inSolitary: boolean;
  /** red_flag ($A138). */
  redFlag: boolean;
}

export function createAutomaticState(): AutomaticState {
  return { counter: 0, inSolitary: false, redFlag: false };
}

/**
 * process_player_input's counter half ($9E22..$9E35).
 *
 * Any input resets the counter to 31; idleness counts it down. The hero is
 * under player control while it is positive.
 */
export function noteInput(s: AutomaticState, input: number): void {
  if (input !== 0) {
    s.counter = AUTOMATIC_PLAYER_DELAY; // $9E34
    return;
  }
  if (s.counter === 0) return; // $9E2F
  s.counter -= 1; // $9E30
}

/**
 * automatics ($C8FE): should the game drive the hero this frame?
 *
 * Three tests in order, and the middle one is the interesting one: being in
 * solitary forces automatic control REGARDLESS of the counter ($C909 jumps
 * straight to the call), because the player is not allowed to steer.
 */
export function heroIsAutomatic(s: AutomaticState): boolean {
  if (s.redFlag) return false; // $C902
  if (s.inSolitary) return true; // $C909
  return s.counter === 0; // $C90F
}
