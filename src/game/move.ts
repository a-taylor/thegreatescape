/**
 * move_a_character (c$C6A0): shuffle the off-screen cast around.
 *
 * This is the counterpart to the vischar animation path. Characters near the
 * hero are drawn and animated as vischars; everyone else exists only as a
 * character struct, and this routine walks them towards their route targets a
 * couple of units at a time. It handles exactly ONE character per call --
 * "$8217" holds a rotating index -- so with 26 characters each moves once every
 * 26 frames. That is why the camp keeps changing while you are not looking at
 * it without costing anything per frame.
 *
 * A character that is on-screen is skipped entirely ($C6B6): the vischar owns
 * its position while it is spawned, and moving the struct too would fight it.
 */

import {
  CHARACTER_COMMANDANT,
  FLAG_ON_SCREEN,
  type CharacterStruct,
} from './characters.js';
import { halfDoors, resolveDoor } from './doors.js';
import { applyCharacterEvent, characterEvent } from './events.js';
import {
  ROUTE_HALT,
  advanceRoute,
  getTarget,
  reverseRoute,
  type Target,
} from './routes.js';

/** The rotating index wraps at character_26_STOVE_1 ($C6A9 CP $1A). */
export const MOVE_CHARACTER_LIMIT = 26;

/** Maximum step per axis: 2 outdoors, 6 indoors ($C723 / $C727). */
export const MAX_STEP_OUTDOORS = 2;
export const MAX_STEP_INDOORS = 6;

/**
 * move_towards (c$C79A): step one value towards another.
 *
 * Returns the new value and whether it was ALREADY there. The caller counts
 * those "already there" results across both axes and treats two as arrival
 * ($C736 CP $02), which is why this reports arrival rather than movement --
 * a character that moves on x but not y has not arrived.
 *
 * All arithmetic is 8-bit and the subtraction wraps, so a delta that crosses
 * zero reads as a large positive number and the clamp then caps it. That is
 * kept rather than widened.
 */
export function moveTowards(
  value: number,
  target: number,
  max: number,
): { value: number; arrived: boolean } {
  const delta = (value - target) & 0xff; // $C79D
  if (delta === 0) return { value, arrived: true }; // $C7A1

  // $C7A3 branches on the borrow: a set carry means value < target.
  if (value < target) {
    // $C7A5 NEG then clamp, then ADD ($C7AD).
    const step = Math.min(target - value, max);
    return { value: (value + step) & 0xff, arrived: false };
  }
  // $C7B0 clamp, then SUB ($C7B6).
  const step = Math.min(value - target, max);
  return { value: (value - step) & 0xff, arrived: false };
}

export interface MoveContext {
  /** random_nibble ($CB85), injected so tests are deterministic. */
  readonly random: () => number;
}

export interface MoveResult {
  /** Which character was considered this call. */
  readonly character: number;
  readonly moved: boolean;
  /** Set when the character reached its waypoint this call. */
  readonly arrived: boolean;
  /** Set when the route ran out and was reversed or handed to an event. */
  readonly routeEnded: boolean;
  /** Set when the character went through a door into another room. */
  readonly changedRoom: number | null;
}

/**
 * One character's turn ($C6A0).
 *
 * @param index the rotating character index; the caller advances it
 */
export function moveCharacter(
  struct: CharacterStruct,
  ctx: MoveContext,
): MoveResult {
  const idle: MoveResult = {
    character: struct.character,
    moved: false,
    arrived: false,
    routeEnded: false,
    changedRoom: null,
  };

  // $C6B4: on-screen characters are driven by their vischar instead.
  if (struct.onScreen) return idle;

  // $C6CC: routeindex_0_HALT means stand still.
  if (struct.route.index === ROUTE_HALT) return idle;

  const target = getTarget(struct.route, ctx.random);

  if (target.kind === 'ended') {
    return { ...idle, routeEnded: true, ...endRoute(struct) };
  }

  // $C723 / $C727: indoors characters move three times as far per turn.
  const max = struct.room === 0 ? MAX_STEP_OUTDOORS : MAX_STEP_INDOORS;
  const goal = targetPosition(target, struct.room);

  const x = moveTowards(struct.pos.x, goal.x, max);
  const y = moveTowards(struct.pos.y, goal.y, max);
  struct.pos = { ...struct.pos, x: x.value, y: y.value };

  // $C735: two "already there" results means arrival.
  const arrived = x.arrived && y.arrived;
  if (!arrived) {
    return { ...idle, moved: true };
  }

  if (target.kind === 'door') {
    return {
      ...idle,
      moved: true,
      arrived: true,
      changedRoom: passThroughDoor(struct, target),
    };
  }

  // $C78B: reaching a location just advances the step.
  advanceRoute(struct.route);
  return { ...idle, moved: true, arrived: true };
}

/**
 * Where the character is heading, in its own coordinate space.
 *
 * Doors are the awkward case. A door's stored position is at the doors table's
 * own scale, and outdoors move_a_character HALVES it ($C714 RRA) before using
 * it as a target -- doors store outdoor coordinates quartered, character
 * structs hold them halved relative to that. Indoors no scaling happens at all.
 */
function targetPosition(
  target: Exclude<Target, { kind: 'ended' }>,
  room: number,
): { x: number; y: number } {
  if (target.kind === 'location') return target.pos;
  if (room === 0) {
    // $C713..$C719: RRA is a rotate through carry, but AND A clears carry
    // first, so it is a plain unsigned halving.
    return { x: target.door.pos.x >> 1, y: target.door.pos.y >> 1 };
  }
  return { x: target.door.pos.x, y: target.door.pos.y };
}

/**
 * Arriving at a door ($C739..$C76C): change room and step to the far side.
 *
 * The destination half is chosen by the door's direction rather than by a
 * stored pointer: top-left and top-right doors take the NEXT half, bottom-left
 * and bottom-right the PREVIOUS one ($C745 CP $02).
 */
function passThroughDoor(
  struct: CharacterStruct,
  target: Extract<Target, { kind: 'door' }>,
): number {
  const door = target.door;
  struct.room = door.targetRoom; // $C741

  // The far half of the pair. $C749 adds five bytes for directions 0..1,
  // $C750 subtracts three for 2..3 -- both landing on the other half's pos.
  //
  // target.index is the route's DOOR BYTE -- a pair index with the reverse
  // flag in bit 7 -- not an index into halfDoors. Stepping from the byte lands
  // on an unrelated door, and when that lookup misses entirely the character
  // keeps its old position: an indoor height of 24 carried outdoors is 192
  // world units, which draws it 168 pixels up and onto the hut roofs.
  const half = resolveDoor(target.index);
  const other = door.direction < 2 ? half + 1 : half - 1;
  const dest = halfDoors[other]?.pos;
  if (dest) {
    struct.pos =
      struct.room === 0
        ? { x: dest.x >> 1, y: dest.y >> 1, height: dest.height >> 1 } // $C763
        : { x: dest.x, y: dest.y, height: dest.height }; // $C758
  }

  advanceRoute(struct.route); // falls into $C78B
  return struct.room;
}

/**
 * The route ran out ($C6DA..$C6FA).
 *
 * Who gets to turn around and who triggers an event is decided by character
 * index, not by anything about the route:
 *
 *   commandant (0)   turns around, UNLESS on route 36 (go to solitary)
 *   characters 1..11 turn around
 *   characters 12+   trigger a character_event instead
 *
 * The event path is where the day schedule's cast ends up: having walked to
 * the yard or the mess hall, character_event is what gives them something to
 * do when they arrive.
 */
export const ROUTE_GO_TO_SOLITARY = 36;

function endRoute(struct: CharacterStruct): { changedRoom: number | null } {
  const c = struct.character;
  const reverses =
    c === CHARACTER_COMMANDANT
      ? (struct.route.index & 0x7f) !== ROUTE_GO_TO_SOLITARY // $C6F5
      : c < 12; // $C6E0 CP $0C

  if (reverses) {
    reverseRoute(struct.route);
    return { changedRoom: null };
  }

  // $C6FA: everyone else exits via character_event.
  const event = characterEvent(struct.route.index);
  applyCharacterEvent(event, struct.route, struct.character);
  return { changedRoom: null };
}

/**
 * The rotating index ($C6A5..$C6AE), advanced before use.
 *
 * Wraps at 26 so the stove and crate are never considered -- they are
 * "characters" only as far as the vischar array is concerned.
 */
export function nextCharacterIndex(current: number): number {
  const next = current + 1;
  return next === MOVE_CHARACTER_LIMIT ? 0 : next;
}

export { FLAG_ON_SCREEN };
