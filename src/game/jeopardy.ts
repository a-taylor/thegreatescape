/**
 * collision ($AFDF), accept_bribe ($B107) and solitary ($CB98).
 *
 * This is where being chased finally costs something. `touch` ($AF8F) runs
 * collision for every moving character, and when the character doing the
 * moving is PURSUING and it overlaps the hero, one of two things happens:
 * either it is the character who took the bribe, and it becomes a decoy, or
 * the hero is arrested.
 *
 * The test at $B04B reads the flags of the character that is MOVING, not of
 * the one it ran into -- so a guard walking into a stationary hero arrests
 * him, and a hero walking into a stationary guard does not.
 */

import geographyJson from '../../data/geography.json';
import { CHARACTER_RESET_HEIGHT, characterResetData, type CharacterStruct } from './characters.js';
import {
  ITEMSTRUCT_STRIDE,
  ITEM_NONE,
  OFF_ROOM,
  OFF_X,
  type ItemState,
} from './inventory.js';
import { ITEM_COUNT, ROOM_MASK } from './items.js';
import { withinCampBounds } from './permitted.js';
import { PURSUIT_PURSUE, PURSUIT_SAW_BRIBE } from './pursuit.js';
import { decreaseMorale, increaseMoraleBy10ScoreBy50, type PlayerState } from './player.js';
import { CHARACTER_NONE, type Vischar } from './vischar.js';

const geography = geographyJson as unknown as {
  solitaryPos: { values: number[] };
  solitaryCommandant: { values: number[] };
};

/** solitary_pos ($7AC6): where the hero is dumped. */
export const solitaryPos = geography.solitaryPos.values;
/** solitary_commandant_data ($CC31): {room, x, y, height, routeIndex, routeStep}. */
export const solitaryCommandant = geography.solitaryCommandant.values;

/** vischar_FLAGS_NO_COLLIDE ($AFE4 BIT 7). */
export const FLAGS_NO_COLLIDE = 0x80;
/** vischar_FLAGS_PURSUIT_MASK ($B04E AND $0F). */
export const PURSUIT_MASK = 0x0f;
/** The first "character" that is really a movable item ($AFBC / $B074 CP $1A). */
export const FIRST_MOVABLE_CHARACTER = 0x1a;
/** The collision box: +/-4 on x and y ($AFF6 / $B005). */
export const COLLISION_RADIUS = 4;
/** ...and a 24-unit window on height ($B046 CP $18). */
export const COLLISION_HEIGHT = 0x18;
/** room_24_SOLITARY ($CBE4 LD A,$18). */
export const ROOM_SOLITARY = 24;
/** The door solitary arrives through ($CBE9 LD A,$14). */
export const SOLITARY_DOOR = 20;
/** Being arrested costs 35 morale ($CBEE LD B,$23). */
export const SOLITARY_MORALE_COST = 0x23;
/** item_BRIBE ($B11A CP $05). */
export const ITEM_BRIBE = 5;
/** The first non-hostile character ($B134 CP $14). */
export const FIRST_FRIENDLY_CHARACTER = 0x14;

/** Messages solitary and accept_bribe queue. */
export const MESSAGE_YOU_ARE_IN_SOLITARY = 0x0d; // $CC01
export const MESSAGE_WAIT_FOR_RELEASE = 0x0e; // $CC06
export const MESSAGE_ANOTHER_DAY_DAWNS = 0x13; // $CC0B
export const MESSAGE_HE_TAKES_THE_BRIBE = 0x11; // $B142
export const MESSAGE_AND_ACTS_AS_DECOY = 0x12; // $B147

/**
 * The overlap test from collision ($AFF3..$B048).
 *
 * A box of +/-4 on each of x and y, and a 24-unit window on height -- so
 * characters on different floors of the tunnel system do not collide. The
 * height test takes an absolute difference ($B044 NEG); the x and y tests do
 * not, they are two separate signed comparisons.
 */
export function collides(saved: { x: number; y: number; height: number }, v: Vischar): boolean {
  if (saved.x >= v.pos.x + COLLISION_RADIUS) return false; // $B002
  if (saved.x < v.pos.x - COLLISION_RADIUS) return false; // $B011
  if (saved.y >= v.pos.y + COLLISION_RADIUS) return false; // $B027 path
  if (saved.y < v.pos.y - COLLISION_RADIUS) return false; // $B038
  return Math.abs(saved.height - v.pos.height) < COLLISION_HEIGHT; // $B046
}

export type CollisionOutcome =
  | { kind: 'none' }
  | { kind: 'bribe'; character: number }
  | { kind: 'arrest' }
  | { kind: 'push'; slot: number };

/**
 * collision ($AFDF), for one moving character.
 *
 * @param mover the vischar that is moving -- IY in the original. Its flags
 *   decide whether an overlap is an arrest.
 * @param saved saved_pos ($81A4), where the mover is trying to go.
 */
export function collision(
  mover: Vischar,
  saved: { x: number; y: number; height: number },
  vischars: Vischar[],
  bribedCharacter: number,
): CollisionOutcome {
  for (const other of vischars) {
    if (other === mover) continue;
    if ((other.flags & FLAGS_NO_COLLIDE) !== 0) continue; // $AFE4
    if (other.character === CHARACTER_NONE) continue;
    if (!collides(saved, other)) continue;

    // $B04B: the MOVER's pursuit mode, not the one it ran into.
    if ((mover.flags & PURSUIT_MASK) === PURSUIT_PURSUE && other.slot === 0) {
      // $B05B: the character who took the bribe becomes a decoy instead of
      // making an arrest.
      if (bribedCharacter === mover.character) {
        return { kind: 'bribe', character: mover.character };
      }
      return { kind: 'arrest' }; // $B06E
    }

    // $B074: the stove and crate are pushed rather than collided with.
    if (other.character >= FIRST_MOVABLE_CHARACTER) {
      return { kind: 'push', slot: other.slot };
    }
    return { kind: 'none' };
  }
  return { kind: 'none' };
}

/**
 * accept_bribe ($B107).
 *
 * Five effects, and the last is the interesting one: EVERY hostile on screen
 * is set to PURSUIT_SAW_BRIBE ($B139), which makes them all ignore the hero
 * and follow the bribed prisoner instead. That is what "acts as decoy" means.
 */
export function acceptBribe(
  bribed: Vischar,
  vischars: Vischar[],
  items: ItemState,
  player: PlayerState,
  queueMessage: (index: number, c?: number) => void,
): void {
  increaseMoraleBy10ScoreBy50(player); // $B107
  bribed.flags = 0; // $B10A

  // $B116: the bribe item leaves the inventory and the world.
  const slot = items.held[0] === ITEM_BRIBE ? 0 : items.held[1] === ITEM_BRIBE ? 1 : -1;
  if (slot >= 0) {
    items.held[slot] = ITEM_NONE; // $B125
    const o = ITEM_BRIBE * ITEMSTRUCT_STRIDE;
    // $B126 `AND $3F` on A, which is still $FF -- so this stores $3F, room
    // NONE, and clears the nearby flags in the same instruction.
    items.structs[o + OFF_ROOM] = 0x3f;
  }

  // $B130: every hostile looks away from the hero and at the decoy.
  for (const v of vischars.slice(1)) {
    if (v.character === CHARACTER_NONE) continue;
    if ((v.character & 0x1f) >= FIRST_FRIENDLY_CHARACTER) continue; // $B134
    v.flags = PURSUIT_SAW_BRIBE; // $B139
  }

  queueMessage(MESSAGE_HE_TAKES_THE_BRIBE); // $B142
  queueMessage(MESSAGE_AND_ACTS_AS_DECOY); // $B147
}

/** The game clock reset_map_and_characters forces ($B7AD LD A,$07). */
export const RESET_CLOCK = 7;
/** interiorobject_COLLAPSED_TUNNEL_SW_NE ($B7B9 LD A,$14). */
export const INTERIOR_OBJECT_COLLAPSED_TUNNEL = 0x14;
/** The blocked-tunnel boundary's original x0 ($B7BE LD A,$34). */
export const BLOCKED_TUNNEL_BOUND = 0x34;

export interface SolitaryContext {
  readonly hero: Vischar;
  readonly items: ItemState;
  readonly player: PlayerState;
  readonly vischars: Vischar[];
  /** character_structs, so the commandant can be sent to collect him. */
  readonly structs: Array<{ room: number; pos: { x: number; y: number; height: number }; route: { index: number; step: number } }>;
  queueMessage(index: number, c?: number): void;
  /** item_discovered ($CD31). */
  discoverItem(item: number): void;
  /** The bell ($A130), silenced at $CB9A. */
  silenceBell(): void;
  /** reset_visible_characters etc. ($B79B). */
  resetCast(): void;
  /** transition ($68A2) to solitary_pos. */
  transitionToSolitary(): void;
  /**
   * $CC16: zero automatic_player_counter ($A139) so the CPU drives him.
   *
   * A callback, not a field, because $A139 has ONE owner and it is not on
   * PlayerState. Writing a second copy is how the release silently failed:
   * the hero never auto-walked route 37 out of the cell, so
   * charevnt_solitary_ends never fired and in_solitary was never cleared.
   */
  forceAutomatic(): void;
}

export interface SolitaryState {
  /** in_solitary ($A13A). */
  inSolitary: boolean;
  /** The global current door ($68A1). */
  currentDoor: number;
}

/**
 * solitary ($CB98): the arrest.
 *
 * Fourteen distinct writes. Enumerated here because dropping any one of them
 * leaves the hero half-arrested, and several are not obviously part of "being
 * caught" -- the commandant's route, the current door, the sprite reset.
 *
 * The item sweep at $CBB1 is the subtle one: every item lying OUTDOORS is
 * tested against all three camp areas and discovered if it is inside any of
 * them. Items dropped OUTSIDE the camp -- through the cut wire, at the far end
 * of the tunnel -- are not found, which is exactly what makes the walkthrough
 * possible.
 */
export function solitary(s: SolitaryState, ctx: SolitaryContext): void {
  ctx.silenceBell(); // $CB9A

  // $CB9D: both held items are confiscated and discovered.
  for (const slot of [0, 1]) {
    const item = ctx.items.held[slot]!;
    ctx.items.held[slot] = ITEM_NONE;
    ctx.discoverItem(item);
  }

  // $CBB1: and every item lying loose INSIDE the camp.
  for (let i = 0; i < ITEM_COUNT; i++) {
    const o = i * ITEMSTRUCT_STRIDE;
    if ((ctx.items.structs[o + OFF_ROOM]! & ROOM_MASK) !== 0) continue; // $CBBB, indoors
    const pos = {
      x: ctx.items.structs[o + OFF_X]!,
      y: ctx.items.structs[o + OFF_X + 1]!,
      height: ctx.items.structs[o + OFF_X + 2]!,
    };
    // $CBC4: tried against each of the three areas in turn.
    for (let area = 0; area < 3; area++) {
      if (withinCampBounds(area, pos)) {
        ctx.discoverItem(ctx.items.structs[o]! & 0x0f); // $CBD9
        break;
      }
    }
  }

  ctx.hero.room = ROOM_SOLITARY; // $CBE4
  s.currentDoor = SOLITARY_DOOR; // $CBE9
  decreaseMorale(ctx.player, SOLITARY_MORALE_COST); // $CBF0
  ctx.resetCast(); // $CBF3

  // $CBF6: the commandant is sent on route 36 to come and collect him. The
  // six bytes overwrite his characterstruct from its ROOM field onward.
  const commandant = ctx.structs[0];
  if (commandant) {
    const [room, x, y, height, routeIndex, routeStep] = solitaryCommandant as number[];
    commandant.room = room!;
    commandant.pos = { x: x!, y: y!, height: height! };
    commandant.route = { index: routeIndex!, step: routeStep! };
  }

  ctx.queueMessage(MESSAGE_YOU_ARE_IN_SOLITARY); // $CC01
  ctx.queueMessage(MESSAGE_WAIT_FOR_RELEASE); // $CC06
  ctx.queueMessage(MESSAGE_ANOTHER_DAY_DAWNS); // $CC0B

  s.inSolitary = true; // $CC12
  ctx.forceAutomatic(); // $CC16, the CPU takes over at once
  ctx.hero.direction = 3; // $CC26, direction_BOTTOM_LEFT
  ctx.hero.route = { index: 0, step: 0 }; // $CC2A, routeindex_0_HALT
  ctx.transitionToSolitary(); // $CC2E
}

export interface ResetMapContext {
  readonly vischars: Vischar[];
  /** character_structs, so the ten guards and prisoners can be put back at spawn. */
  readonly structs: CharacterStruct[];
  /** The hero's vischar, whose flags are cleared ($B7B6). */
  readonly hero: Vischar;
  /** The schedule, for the clock and night flag ($B7AD / $B7B2). */
  readonly schedule: { clock: number; night: boolean };
  /** locked_doors ($F05D), all nine re-locked ($B7C8). */
  readonly lockedDoors: Uint8Array;
  resetVisible(v: Vischar): void;
  /** Re-occupy the beds, empty the benches, restore the tunnel blockage. */
  restoreRoomObjects(): void;
}

/**
 * reset_map_and_characters ($B79B).
 *
 * Called by solitary ($CBF3) and by reset_game. It is much more than "reset
 * the cast", and every one of these matters after an arrest:
 *
 *   $B7A2  every NPC vischar handed back
 *   $B7AD  the game clock forced to 7 -- the day starts over
 *   $B7B2  the night flag cleared
 *   $B7B6  the HERO's vischar flags cleared -- he is no longer cutting wire
 *          or picking a lock, and no pursuit mode survives the arrest
 *   $B7B9  the tunnel blockage put back
 *   $B7C8  all nine locked doors re-locked
 *   $B7D4  the six beds re-occupied
 *   $B7DD  all seven benches emptied
 *   $B7F2  the four guards (12..15) and six prisoners (20..25) put back at
 *          their character_reset_data spawn points, height forced to 18 (a
 *          reproduced bug -- see CHARACTER_RESET_HEIGHT) and route halted
 *
 * Implementing only the first is what left a commandant stuck in a pursuit
 * mode after an arrest: a character in a pursuit mode ignores its route
 * entirely ($C92A), so route 36 never ended and the hero was never released.
 * The last step (character_reset_data) was the same shape of gap: `structs`
 * was already threaded through every caller but never read here, so an
 * arrest put the cast's VISCHARS back without ever moving the underlying
 * character_structs they get re-spawned from -- invisible until the next
 * spawn pulled a stale position.
 */
export function resetMapAndCharacters(ctx: ResetMapContext): void {
  for (const v of ctx.vischars.slice(1)) ctx.resetVisible(v); // $B7A2
  ctx.schedule.clock = RESET_CLOCK; // $B7AD
  ctx.schedule.night = false; // $B7B2
  ctx.hero.flags = 0; // $B7B6
  for (let i = 0; i < ctx.lockedDoors.length; i++) {
    ctx.lockedDoors[i] = ctx.lockedDoors[i]! | 0x80; // $B7C8
  }
  ctx.restoreRoomObjects(); // $B7B9, $B7D4, $B7DD
  for (const entry of characterResetData) { // $B7F2
    const s = ctx.structs[entry.character];
    if (!s) continue;
    s.room = entry.room;
    s.pos = { x: entry.x, y: entry.y, height: CHARACTER_RESET_HEIGHT };
    s.route = { index: 0, step: 0 }; // $B806, routeindex_0_HALT
  }
}
