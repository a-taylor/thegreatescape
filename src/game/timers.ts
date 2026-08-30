/**
 * picking_lock ($9E98) and cutting_wire ($9EB2).
 *
 * P5's action handlers set `vischar.flags` to PICKING_LOCK or CUTTING_WIRE and
 * put a deadline in `player_locked_out_until` ($A145); these run that deadline
 * down. They are reached from process_player_input ($9E1C/$9E1F) INSTEAD of
 * the normal input path, which is how the player is locked out while the hero
 * works -- he is not frozen so much as busy.
 *
 * Both compare the deadline against the GAME COUNTER ($A12F), which
 * wave_morale_flag increments once a frame. So the timers tick with the flag,
 * not with the day clock.
 */

import type { Vischar } from './vischar.js';

/** vischar_FLAGS_PICKING_LOCK / _CUTTING_WIRE ($9E11 AND $03). */
export const FLAGS_PICKING_LOCK = 0x01;
export const FLAGS_CUTTING_WIRE = 0x02;
export const FLAGS_LOCKPICK_OR_CUT = 0x03;

/** Automatic control is postponed 31 turns while he works ($9E18 LD (HL),$1F). */
export const WORKING_AUTOMATIC_DELAY = 0x1f;

/** messages_it_is_open ($9EA5 LD B,$06). */
export const MESSAGE_IT_IS_OPEN = 0x06;

/** input_KICK ($9ED7 LD (HL),$80). */
export const INPUT_KICK = 0x80;
/** The hero stands back up to height 24 after cutting ($9ED9 LD A,$18). */
export const STANDING_HEIGHT_AFTER_CUT = 0x18;

/**
 * cutting_wire_new_inputs ($9EE0), indexed by direction.
 *
 * Four bytes, each an input with input_KICK set, that walk the hero THROUGH
 * the gap he has just cut. They are transcribed constants rather than parsed
 * data because they are a four-byte table inside a code block; the values are
 * cited individually.
 */
export const CUTTING_WIRE_INPUTS: readonly number[] = [
  0x84, // $9EE0 input_UP   + input_LEFT  + KICK
  0x87, // $9EE1 input_UP   + input_RIGHT + KICK
  0x88, // $9EE2 input_DOWN + input_RIGHT + KICK
  0x85, // $9EE3 input_DOWN + input_LEFT  + KICK
];

export interface TimerContext {
  /** game_counter ($A12F), incremented by wave_morale_flag. */
  readonly gameCounter: number;
  /** player_locked_out_until ($A145). */
  readonly lockedOutUntil: number;
  /** The hero's vischar. */
  readonly hero: Vischar;
  /** locked_doors ($F05D), so picking can clear door_LOCKED. */
  readonly lockedDoors: Uint8Array;
  /** ptr_to_door_being_lockpicked ($A143), as a locked_doors index. */
  readonly doorBeingLockpicked: number;
  queueMessage(index: number, c?: number): void;
}

/**
 * clear_lockpick_wirecut_flags_and_return ($9EAA).
 *
 * `AND $FC` clears both flags at once and leaves every other bit alone --
 * TARGET_IS_DOOR and NO_COLLIDE survive, which matters because the hero may
 * have been heading for a door when he started.
 */
export function clearWorkingFlags(hero: Vischar): void {
  hero.flags = hero.flags & 0xfc; // $9EAE
}

/**
 * picking_lock ($9E98): wait for the deadline, then unlock the door.
 *
 * The test is `CP (HL) / RET NZ` -- EQUALITY against the game counter, not
 * "past it". The counter is a byte and wraps, so a deadline that is stepped
 * over is never reached; action_lockpick's `+ $FF` ($B49F) is one short of a
 * full wrap precisely so the equality lands.
 */
export function pickingLock(ctx: TimerContext): boolean {
  if (ctx.lockedOutUntil !== ctx.gameCounter) return false; // $9E9F

  // $9EA3: clear door_LOCKED on the door being picked.
  const door = ctx.doorBeingLockpicked;
  if (door >= 0 && door < ctx.lockedDoors.length) {
    ctx.lockedDoors[door] = ctx.lockedDoors[door]! & 0x7f;
  }
  ctx.queueMessage(MESSAGE_IT_IS_OPEN); // $9EA7
  clearWorkingFlags(ctx.hero); // $9EAA
  return true;
}

/**
 * cutting_wire ($9EB2).
 *
 * Three phases, keyed on how far the deadline still is from the counter:
 *
 *   > 3   nothing happens; he is still snipping ($9EBD RET NC)
 *   1..3  he is fed an input from cutting_wire_new_inputs so he walks THROUGH
 *         the gap ($9EBE..$9ECC)
 *   0     the cut completes ($9ED0)
 *
 * REPRODUCED BUG at $9ED0: the disassembly notes "an LD A,(HL) instruction is
 * missing here. A is always zero at this point, so $800E is always set to
 * zero. The hero will always face top-left after breaking through a fence."
 * The DOS port hardcodes the same thing. It is a visible quirk with no crash,
 * so BUILD_PROMPT.md §9 says reproduce it -- the hero snaps to TOP_LEFT
 * whichever way he was facing.
 */
export function cuttingWire(ctx: TimerContext): boolean {
  const remaining = (ctx.lockedOutUntil - ctx.gameCounter) & 0xff; // $9EB8

  if (remaining === 0) {
    // $9ED0..$9EDE. `AND $03` operates on an A that is already zero, so the
    // direction becomes 0 rather than being masked from the current one.
    ctx.hero.direction = 0; // $9ED5, the reproduced bug
    ctx.hero.input = INPUT_KICK; // $9ED7
    ctx.hero.pos.height = STANDING_HEIGHT_AFTER_CUT; // $9EDB
    clearWorkingFlags(ctx.hero); // $9EDE -> $9EAA
    return true;
  }

  if (remaining >= 4) return false; // $9EBD, still cutting

  // $9EBE: walk him through the gap he has made.
  const input = CUTTING_WIRE_INPUTS[ctx.hero.direction & 0x03];
  if (input !== undefined) ctx.hero.input = input; // $9ECC
  return false;
}

/**
 * The lockpick/wirecut branch of process_player_input ($9E0E..$9E1F).
 *
 * Returns true when it handled the frame, in which case the ordinary input
 * path is skipped entirely -- that is the lock-out.
 */
export function runWorkingTimers(
  ctx: TimerContext,
  postponeAutomatic: (turns: number) => void,
): boolean {
  const mode = ctx.hero.flags & FLAGS_LOCKPICK_OR_CUT; // $9E11
  if (mode === 0) return false; // $9E13

  // $9E18: keep the CPU off him while he works.
  postponeAutomatic(WORKING_AUTOMATIC_DELAY);

  if (mode === FLAGS_PICKING_LOCK) pickingLock(ctx); // $9E1C
  else cuttingWire(ctx); // $9E1F
  return true;
}
