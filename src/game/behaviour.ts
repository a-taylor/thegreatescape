/**
 * character_behaviour (c$C918): steering a visible character.
 *
 * The design worth understanding before the details: NPCs do not have their own
 * movement code. This routine compares a vischar's position with its target and
 * produces an INPUT BYTE -- the same input the player's joystick would produce
 * -- which `animate` then feeds through the identical animindices/animation
 * machinery the hero uses. So a guard walking to a waypoint and the player
 * walking there run through exactly the same code.
 *
 * The two axes are tried one at a time, and which goes first alternates:
 *
 *   vischar_move_x ($CA11)  when x is within 2 of the target, it SETS
 *                           Y_DOMINANT so the next call tries y first
 *   vischar_move_y ($CA49)  when y is within 2, it CLEARS Y_DOMINANT
 *
 * "This is the code which makes characters alternate left/right when
 * navigating." A character blocked on one axis flips to the other, which is
 * what gets it around a corner without any pathfinding.
 */

import type { CharacterStruct } from './characters.js';
import { calcIsoPos } from './coords.js';
import { halfDoors, resolveDoor, transitionPosition } from './doors.js';
import { applyCharacterEvent, characterEvent } from './events.js';
import type { CharacterEventKind } from './events.js';
import {
  ROUTE_HALT,
  ROUTE_WANDER,
  ROUTE_REVERSED,
  getTarget,
  type Target,
} from './routes.js';
import { BYTE7_Y_DOMINANT, type Vischar } from './vischar.js';
import { resetVisibleCharacter } from './spawn.js';
import { characterSits, characterSleeps, type RoomPokeState } from './parcels.js';

/** vischar_FLAGS_MASK ($CA85). "$0F would be sufficient." */
export const FLAGS_MASK = 0x3f;
/** vischar_FLAGS_TARGET_IS_DOOR ($CB66). */
export const FLAGS_TARGET_IS_DOOR = 1 << 6;
/** vischar_FLAGS_NO_COLLIDE ($B5DD). */
export const FLAGS_NO_COLLIDE = 0x80;

/** The pursuit modes, from the header's vischar byte 1 commentary. */
export const PURSUIT_PURSUE = 1;
export const PURSUIT_HASSLE = 2;
export const PURSUIT_DOG_FOOD = 3;
export const PURSUIT_SAW_BRIBE = 4;

/** input_KICK ($C9F9): restart the animation from its first frame. */
export const INPUT_KICK = 0x80;

/**
 * The inputs the two movers return.
 *
 * These are positions in the 3x3 input grid (horizontal * 3 + vertical), not
 * bit flags -- 8 is RIGHT(6) + DOWN(2), 4 is LEFT(3) + UP(1), and so on. Each
 * moves the character along one ISOMETRIC axis, which is why a single axis of
 * world movement needs a diagonal-looking input.
 */
export const INPUT_X_INCREASING = 8; // $CA2D
export const INPUT_X_DECREASING = 4; // $CA3B
export const INPUT_Y_INCREASING = 5; // $CA65
export const INPUT_Y_DECREASING = 7; // $CA73

/**
 * How a target coordinate is scaled up to compare against mi.pos ($C9C3).
 *
 * Three cases, selected by room and by whether the target is a door:
 *   indoors            multiply_by_1 ($CB75) -- both are already tinypos
 *   outdoors, a door   multiply_by_4 ($B295) -- doors store quartered
 *   outdoors, a place  multiply_by_8 ($B1C7) -- locations store tinypos
 */
export function targetScale(room: number, flags: number): 1 | 4 | 8 {
  if (room !== 0) return 1; // $C9C9
  return flags & FLAGS_TARGET_IS_DOOR ? 4 : 8; // $C9D2 / $C9D7
}

/**
 * One axis of movement ($CA11 / $CA49).
 *
 * The dead zone is asymmetric and deliberate: a delta of 1 or 2 counts as
 * "arrived" ($CA29 CP $03, $CA36 CP $FE), so a character never oscillates
 * around its target trying to land exactly.
 *
 * @returns the input to use, or 0 when close enough
 */
function moveAxis(
  current: number,
  target: number,
  increasing: number,
  decreasing: number,
): number {
  // $CA1D: delta = current position - target position, 16-bit signed.
  const delta = current - target;
  if (delta === 0) return 0;
  if (delta > 0) return delta >= 3 ? increasing : 0;
  return delta <= -3 ? decreasing : 0;
}

export function vischarMoveX(v: Vischar, scale: number): number {
  const input = moveAxis(
    v.pos.x,
    v.target.x * scale,
    INPUT_X_INCREASING,
    INPUT_X_DECREASING,
  );
  // $CA43: landing in the dead zone sets Y_DOMINANT, so next time y is tried
  // first. This is half of the alternation.
  if (input === 0) v.counterAndFlags |= BYTE7_Y_DOMINANT;
  return input;
}

export function vischarMoveY(v: Vischar, scale: number): number {
  const input = moveAxis(
    v.pos.y,
    v.target.y * scale,
    INPUT_Y_INCREASING,
    INPUT_Y_DECREASING,
  );
  // $CA7B: and the other half -- y clears what x sets.
  if (input === 0) v.counterAndFlags &= ~BYTE7_Y_DOMINANT & 0xff;
  return input;
}

export interface BehaviourContext {
  readonly random: () => number;
  readonly structs: CharacterStruct[];
  /** The global current room index ($68A0). */
  readonly room: number;
  /**
   * The roomdef poke overlay, for character_sits / character_sleeps ($A420 /
   * $A444). Optional: a caller that only wants to know where a character walks
   * need not stand one up, and without it the seat graphic simply is not
   * poked -- the route still halts, which is what the movement depends on.
   */
  readonly pokes?: RoomPokeState;
}

export interface BehaviourResult {
  /** True when the vischar reached its target this call. */
  readonly targetReached: boolean;
  /** Set when the character should move to another room. */
  readonly enterRoom: number | null;
  /** Set when the route ran out. */
  readonly routeEnded: boolean;
  /**
   * The character_event that fired, when one did and it could not be applied
   * as a route change alone.
   *
   * hero_sits and hero_sleeps ($A47F / $A489) halt the route AND zero the
   * position so the character is inside the bench or bed graphic. The caller
   * owns the hero's position, so it has to do that part -- and reporting the
   * kind is what stops it being silently dropped, which leaves the hero
   * standing in the mess hall with nothing to walk to.
   */
  readonly event?: CharacterEventKind;
}

const IDLE: BehaviourResult = {
  targetReached: false,
  enterRoom: null,
  routeEnded: false,
};

/** What routeEnded decided, so targetReached can pass it up. */
let lastEventKind: CharacterEventKind | undefined;

/**
 * get_target_assign_pos (c$CB23): fetch the next waypoint into vischar.target.
 *
 * Also sets or leaves vischar_FLAGS_TARGET_IS_DOOR, which is what later decides
 * the coordinate scaling and whether arriving means a room change.
 */
export function getTargetAssignPos(
  v: Vischar,
  ctx: BehaviourContext,
): { routeEnded: boolean } {
  const target = getTarget(v.route, ctx.random);
  if (target.kind === 'ended') return { routeEnded: true }; // $CB29

  if (target.kind === 'door') {
    v.flags |= FLAGS_TARGET_IS_DOOR; // $CB66
    v.target = { x: target.door.pos.x, y: target.door.pos.y, height: 0 };
  } else {
    // handle_target only ever SETS the flag ($CB66); nothing clears it here,
    // so a character that once headed for a door keeps the flag until
    // target_reached deals with it. Reproduced rather than tidied.
    v.target = { x: target.pos.x, y: target.pos.y, height: 0 };
  }
  return { routeEnded: false };
}

/**
 * route_ended (c$CB2D).
 *
 * The first test is the one to get right: `$CB2D LD A,L; CP $02` identifies
 * the HERO by his SLOT -- vischar 0's route field sits at $8002, so its low
 * byte is 2 -- and only after that does the routine look at the character
 * index at all.
 *
 * That distinction is invisible if you go by character index, because the
 * hero's vischar also carries character 0, which is the commandant's index.
 * Treat him as the commandant and he takes the "turn around and walk it
 * backwards" branch instead of character_event. After breakfast that means
 * reversing route 16, whose first waypoint is an outdoor LOCATION, while he is
 * standing in a mess hall: he walks into the nearest corner and stays there.
 *
 * After the hero: the commandant turns around unless he is on route 36, guards
 * 1..11 turn around, and everyone else goes to character_event.
 */
export function routeEnded(v: Vischar, ctx: BehaviourContext): boolean {
  const isHero = v.slot === 0; // $CB2E CP $02
  const character = v.character & 0x1f;
  const reverses =
    isHero
      ? false // $CB30 jumps straight to do_character_event
      : character === 0
        ? (v.route.index & 0x7f) !== 36 // $CB3D, routeindex_36_GO_TO_SOLITARY
        : character < 12; // $CB44 CP $0C

  if (!reverses) {
    // $CB47: character_event decides what an arrived character does next.
    const event = characterEvent(v.route.index);
    lastEventKind = event.kind;

    // character_sits ($A420) and character_sleeps ($A444) both end in
    // character_sit_sleep_common ($A462), which makes THREE writes. All three
    // are needed and they fail in different ways:
    //
    //   $A463  route.index = HALT. Skip it and the character keeps a route
    //          whose step already sits on the terminator; the next
    //          target_reached steps PAST it and, because routes are packed,
    //          starts walking the following route -- the mess hall jam.
    //   $A470  room = room_NONE, which is how the character disappears INTO
    //          the bench or bed. Skip it and he stands next to the furniture
    //          instead of sitting in it.
    //   $A437  the bench or bed object is poked so the graphic shows someone
    //          seated. Skip it and the seat stays empty however many
    //          prisoners are sitting on it.
    if (event.kind === 'sits') {
      characterSits(ctx.pokes, v, v.route.index);
      return true;
    }
    if (event.kind === 'sleeps') {
      characterSleeps(ctx.pokes, v, v.route.index);
      return true;
    }

    const changed = applyCharacterEvent(event, v.route, v.character);
    if (changed && v.route.index !== 0) {
      // $CB4E: a non-halt result re-enters get_target_assign_pos so the
      // character starts on its new route immediately.
      getTargetAssignPos(v, ctx);
      return false;
    }
    return true;
  }

  // $CB50..$CB5B, the same "[-2]+1" pattern as elsewhere.
  v.route.index ^= ROUTE_REVERSED;
  if (v.route.index & ROUTE_REVERSED) v.route.step = (v.route.step - 2) & 0xff;
  v.route.step = (v.route.step + 1) & 0xff;

  getTargetAssignPos(v, ctx);
  return false;
}

/**
 * target_reached (c$CA81), restricted to the non-pursuit path.
 *
 * Pursuit modes lead into bribes, solitary and poisoned dogs -- P5 material.
 * They are detected and left alone rather than silently falling through into
 * the ordinary path, which would make a pursuing guard behave like a patrolling
 * one.
 */
export function targetReached(
  v: Vischar,
  ctx: BehaviourContext,
): BehaviourResult {
  // $CA85: any pursuit mode set means this is not our case.
  if ((v.flags & FLAGS_MASK) !== 0) {
    return { ...IDLE, targetReached: true };
  }

  // $CAB6: arriving at a door means going through it.
  if (v.flags & FLAGS_TARGET_IS_DOOR) {
    const room = enterDoor(v, ctx);
    return { targetReached: true, enterRoom: room, routeEnded: false };
  }

  // $CB13 tr_set_route: step the route on, then take the next target.
  if (v.route.index !== ROUTE_WANDER) {
    if (v.route.index & ROUTE_REVERSED) v.route.step = (v.route.step - 2) & 0xff;
    v.route.step = (v.route.step + 1) & 0xff;
  }

  const { routeEnded: ended } = getTargetAssignPos(v, ctx);
  if (!ended) return { ...IDLE, targetReached: true };

  lastEventKind = undefined;
  const halted = routeEnded(v, ctx);
  return {
    targetReached: true,
    enterRoom: null,
    routeEnded: halted,
    ...(lastEventKind ? { event: lastEventKind } : {}),
  };
}

/**
 * The door half of target_reached ($CABA..$CB12).
 *
 * Re-reads the route byte to recover the door index -- the vischar only stored
 * the door's POSITION, not which door it was -- then steps the route and moves
 * the character to the far side.
 */
function enterDoor(v: Vischar, ctx: BehaviourContext): number | null {
  const target = getTarget(v.route, ctx.random);
  if (target.kind !== 'door') {
    v.flags &= ~FLAGS_TARGET_IS_DOOR & 0xff;
    return null;
  }

  // $CAD1..$CAD9: step the route before going through.
  if (v.route.index & ROUTE_REVERSED) v.route.step = (v.route.step - 2) & 0xff;
  v.route.step = (v.route.step + 1) & 0xff;

  const room = target.door.targetRoom; // $CAE3
  v.room = room;

  // $CAF8..$CB09: step to the far half of the pair, then transition. The half
  // is chosen by the door's direction -- next for top-left/top-right,
  // previous otherwise ($C745) -- and indexed from the RESOLVED half, not from
  // the route's door byte, which carries the reverse flag in bit 7.
  const half = resolveDoor(target.index);
  const other = target.door.direction < 2 ? half + 1 : half - 1;
  const dest = halfDoors[other];
  if (dest) {
    // transition ($68B6) multiplies by 4 for a vischar, where
    // move_a_character halves for a character struct. Both land on the same
    // spot: a vischar holds world coordinates and a struct holds tinypos.
    v.pos = transitionPosition(dest, room);
    const iso = calcIsoPos(v.pos);
    v.isoPos = { x: iso.x, y: iso.y };
  }

  // $CAFC..$CB05: the HERO ONLY -- identified by his SLOT, as everywhere else
  // in this routine. He clears TARGET_IS_DOOR ($CB02) and takes the next
  // waypoint immediately. Both of those are INSIDE the hero branch: $CAFE
  // jumps over them for anyone else.
  //
  // get_target_assign_pos FALLS THROUGH into route_ended when the route has
  // run out ($CB29), so the end has to be handled here too. A route whose last
  // waypoint IS the door -- route 16, the walk to breakfast, is exactly that
  // -- otherwise leaves the character holding a finished route. He then
  // arrives, finds both axes in the dead zone, and target_reached advances the
  // step PAST the terminator into the next route's bytes, because routes are
  // packed. Route 16 step 5 reads route 17's first waypoint: an outdoor
  // location, chased from inside a mess hall.
  if (v.slot === 0) {
    v.flags &= ~FLAGS_TARGET_IS_DOOR & 0xff; // $CB02
    const { routeEnded: ended } = getTargetAssignPos(v, { ...ctx, room });
    if (ended) routeEnded(v, { ...ctx, room });
    return room;
  }

  // $68CE..$68D4: transition ends differently for everyone else. `AND A / JP Z`
  // takes the hero to the hero path; anybody else exits via
  // reset_visible_character ($C5D3), which hands the SLOT BACK -- writing the
  // new room, the new position and the advanced route into the character
  // struct and marking the vischar empty.
  //
  // This is the whole mechanism by which an NPC survives a doorway. Leave it
  // out and the vischar keeps a target that is still the door it just walked
  // through, in the coordinate space of the room it just left; target_reached
  // fires again immediately, advances the route again, and the character
  // cascades through waypoints until it runs off the end of its route into the
  // next one. Five characters converging on route 17's first location from
  // inside a mess hall is what that looks like.
  resetVisibleCharacter(v, ctx.structs);
  return room;
}

/**
 * character_behaviour (c$C918).
 *
 * @returns what happened, for the caller to act on
 */
export function characterBehaviour(
  v: Vischar,
  ctx: BehaviourContext,
): BehaviourResult {
  // $C91C: the bottom nibble is a delay counter. "This stops characters
  // navigating around obstacles too quickly."
  if ((v.counterAndFlags & 0x0f) !== 0) {
    v.counterAndFlags = (v.counterAndFlags - 1) & 0xff;
    return IDLE;
  }

  // $C92A: a non-zero flags byte means a pursuit mode. Those need bribes,
  // solitary and dog food, none of which exist yet, so they are left alone --
  // NOT quietly treated as ordinary movement.
  if ((v.flags & FLAGS_MASK) !== 0) return IDLE;

  // $C9BA: routeindex_0_HALT means stand still, with input 0.
  if (v.route.index === ROUTE_HALT) {
    setInput(v, 0);
    return IDLE;
  }

  const scale = targetScale(ctx.room, v.flags);

  // $C9E1: Y_DOMINANT decides which axis is tried first.
  const yFirst = (v.counterAndFlags & BYTE7_Y_DOMINANT) !== 0;
  let input = yFirst ? vischarMoveY(v, scale) : vischarMoveX(v, scale);
  if (input === 0) {
    input = yFirst ? vischarMoveX(v, scale) : vischarMoveY(v, scale);
  }

  if (input === 0) {
    // $C9F2 / $CA0E: neither axis could move, so we are there.
    const result = targetReached(v, ctx);
    setInput(v, 0);
    return result;
  }

  setInput(v, input);
  return IDLE;
}

/**
 * cb_set_input ($C9F5): store a new input, with input_KICK.
 *
 * The kick bit is only set when the input CHANGES ($C9F8 returns early
 * otherwise). animate reads it as "restart the animation from frame zero", so
 * setting it every frame would freeze the character on its first frame.
 */
export function setInput(v: Vischar, input: number): void {
  if (input === v.input) return; // $C9F8
  v.input = (input | INPUT_KICK) & 0xff; // $C9F9
}

export type { Target };
