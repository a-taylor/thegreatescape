/**
 * Movable items: the stove and the crate.
 *
 * "Unlike ordinary items such as keys and the radio the movable items can be
 * pushed around (on one axis) by the hero character walking into them.
 * Internally they use the second visible character slot." (setup_movable_items,
 * c$6939)
 *
 * There are three, one per room: stove1 in room 2, stove2 in room 4, and the
 * crate in room 9. They are characters 26, 27 and 28, which is why the
 * collision code recognises them with a single `>= character_26_STOVE_1` test
 * ($B074) rather than a list.
 */

import movablesJson from '../../data/movables.json';

import { calcIsoPos } from './coords.js';
import type { Vischar } from './vischar.js';

export interface MovableItemData {
  readonly _label: string;
  readonly _addr: string;
  readonly character: number;
  readonly pos: { readonly x: number; readonly y: number; readonly height: number };
  readonly spriteAddr: string;
  /** Index into the sprites array, resolved from the pointer at extract time. */
  readonly spriteIndex: number;
  /** The record's ninth byte -- an animation index, zero for all three. */
  readonly animIndex: number;
  readonly axis: 'x' | 'y';
  readonly centre: number;
  readonly range: number;
}

const data = movablesJson as unknown as {
  byRoom: Record<string, string>;
  items: Record<string, MovableItemData>;
};

export const movableItems = data.items;
export const movableByRoom = data.byRoom;

/** character_26_STOVE_1 -- the threshold the collision test uses ($B074). */
export const FIRST_MOVABLE_CHARACTER = 26;
export const CHARACTER_CRATE = 28;

export function isMovableCharacter(character: number): boolean {
  return character >= FIRST_MOVABLE_CHARACTER;
}

/** The movable item in a room, if it has one. */
export function movableForRoom(room: number): MovableItemData | undefined {
  const key = movableByRoom[String(room)];
  return key ? movableItems[key] : undefined;
}

export interface MovableState {
  readonly item: MovableItemData;
  /** Live position; only the item's own axis ever changes. */
  pos: { x: number; y: number; height: number };
}

export function createMovable(item: MovableItemData): MovableState {
  return { item, pos: { ...item.pos } };
}

/**
 * Push a movable item, given the direction the pusher faces ($B071..$B0B8).
 *
 * The four directions do genuinely different things, and only one of them is
 * the obvious "shove it away":
 *
 *   top left (0)      centre it. "The player is pushing the movable item from
 *                     its front, so centre it" -- one step toward the middle,
 *                     from either side.
 *   top right (1)     one step toward the maximum, if not already there.
 *   bottom right (2)  snap straight to the minimum, in one go. The disassembly
 *                     notes this "never seems to happen in practice".
 *   bottom left (3)   one step toward the minimum, if not already there.
 *
 * The crate XORs the direction with 1 first ($B08D, "swap axis left<=>right"),
 * so it responds to each direction the way a stove responds to the other member
 * of the pair.
 *
 * Positions are single bytes here: the routine operates on the low byte of
 * vischar.mi.pos directly.
 */
export function pushMovable(state: MovableState, pusherDirection: number): void {
  const { item } = state;

  // $B082/$B08D: the crate swaps 0<->1 and 2<->3 before the direction test.
  let dir = pusherDirection & 0x03;
  if (item.character === CHARACTER_CRATE) dir ^= 0x01;

  const axis = item.axis;
  const min = item.centre - item.range;
  const max = item.centre + item.range;
  const value = state.pos[axis] & 0xff;

  let next = value;
  switch (dir) {
    case 0: // $B08F: step toward the centre from whichever side we are on.
      if (value > item.centre) next = value - 1;
      else if (value < item.centre) next = value + 1;
      break;
    case 1: // $B09D: step toward the maximum.
      if (value !== max) next = value + 1;
      break;
    case 2: // $B0A9: snap to the minimum outright.
      next = min;
      break;
    default: // $B0B2: step toward the minimum.
      if (value !== min) next = value - 1;
      break;
  }

  state.pos[axis] = next;
}

/** The travel range of a movable item, for tests and debug display. */
export function movableRange(item: MovableItemData): { min: number; max: number } {
  return { min: item.centre - item.range, max: item.centre + item.range };
}

/**
 * setup_movable_item ($697D): install a movable into vischar slot 1.
 *
 * The movable is not a special case bolted onto the side of the character
 * system -- it IS a vischar, and the routine fills the slot in properly:
 * character index, the nine bytes of position and sprite, fourteen bytes of
 * reset data, the room ($6996), and finally calc_vischar_iso_pos ($699C).
 *
 * Leaving any of that out has consequences that do not look related to
 * movables at all. Marking the slot occupied but leaving its room at zero makes
 * purge_invisible_characters evict it on the very next tick -- the room test at
 * $C4A3 is the first thing it does -- after which spawn_character hands slot 1
 * to a real character while the renderer still believes slot 1 is the stove.
 * The visible symptom is a missing character, nowhere near the stove.
 *
 * @param slot vischar 1, which is where $697D writes
 */
export function installMovable(
  slot: Vischar,
  state: MovableState,
  room: number,
): void {
  slot.character = state.item.character; // $697D
  slot.flags = 0; // movable_item_reset_data byte 0
  slot.route = { index: 0, step: 0 };
  // Share the position object with the movable state, so pushMovable's writes
  // are visible through the slot without a copy step to forget.
  slot.pos = state.pos;
  // The stove and crate do not animate, so the frame index stays at zero and
  // the whole sprite is the set's base.
  slot.sprite = state.item.spriteIndex;
  slot.spriteIndex = 0;
  slot.room = room; // $6996
  slot.counterAndFlags = 0;
  refreshMovableIso(slot);
}

/**
 * Recompute the slot's projected position ($699C / $B71B).
 *
 * Needed after every push as well as at setup: purge_invisible_characters
 * reads iso_pos, not pos, so a stale value would decide the stove's fate from
 * where it used to be.
 */
export function refreshMovableIso(slot: Vischar): void {
  const iso = calcIsoPos(slot.pos);
  slot.isoPos = { x: iso.x, y: iso.y };
}
