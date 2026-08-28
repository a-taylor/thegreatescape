/**
 * Picking up, dropping and using items.
 *
 * The sixteen item_structs ($76C8) are mutable game state -- pick-up zeroes an
 * item's room, drop writes the hero's position into it, poison sets a flag --
 * so they get exactly ONE owner here, as raw bytes in their real layout.
 *
 * `itemStructs()` in `items.ts` decodes the SHIPPED table and must not be
 * called once play has started: it would rebuild the structs from the original
 * data and resurrect anything already picked up. CLAUDE.md's "one game field,
 * two objects" hazard has cost this project three bugs already; the bytes here
 * are the single owner and `readItemStruct` is a view onto them.
 *
 * Flags are kept as bits rather than booleans for the same reason. The item
 * byte carries the item index, the POISONED bit and the HELD bit together, and
 * pick_up_item reads it with a $1F mask while everything else uses $0F -- a
 * split representation would have to guess which.
 */

import {
  itemAttributes,
  ITEM_COUNT,
  ITEM_FLAG_HELD,
  ITEM_MASK,
  NEARBY_6,
  NEARBY_7,
  ROOM_MASK,
  type ItemStruct,
  itemStructs,
} from './items.js';
import { calcExteriorItemIsoPos, calcInteriorItemIsoPos } from './coords.js';
import { posToTinypos, type Pos, type TinyPos } from './math.js';
import type { PlayerState } from './player.js';
import { increaseMoraleBy5ScoreBy5 } from './player.js';

/** item_NONE ($7B39 LD A,$FF). */
export const ITEM_NONE = 0xff;
/** Seven bytes per itemstruct ($7C26 multiplies the index by seven). */
export const ITEMSTRUCT_STRIDE = 7;
/** Two held-item slots, items_held ($8215). */
export const HELD_SLOTS = 2;
/** item_UNIFORM ($7B91 CP $06). */
export const ITEM_UNIFORM = 6;
/** item_FOOD ($B3C7 LD A,$07). */
export const ITEM_FOOD = 7;

/** Byte offsets within an itemstruct. */
export const OFF_ITEM = 0;
export const OFF_ROOM = 1;
export const OFF_X = 2;
export const OFF_Y = 3;
export const OFF_HEIGHT = 4;
export const OFF_ISO_X = 5;
export const OFF_ISO_Y = 6;

export interface ItemState {
  /** item_structs ($76C8): 16 records of 7 bytes, in memory order. */
  structs: Uint8Array;
  /** items_held ($8215/$8216). Both start as item_NONE. */
  held: Uint8Array;
  /**
   * item_attributes ($DD69): the screen colour each item is drawn in.
   *
   * Mutable, and owned here rather than read from `items.json`, because
   * action_poison writes to it ($B3D8 sets the food to bright purple). It sits
   * in what otherwise looks like constant data, so poisoned food is visibly a
   * different colour with no extra flag anywhere.
   */
  attributes: Uint8Array;
}

export function createItemState(): ItemState {
  const structs = new Uint8Array(ITEM_COUNT * ITEMSTRUCT_STRIDE);
  itemStructs().forEach((s, i) => {
    const o = i * ITEMSTRUCT_STRIDE;
    structs[o + OFF_ITEM] = s.item | (s.poisoned ? 0x20 : 0) | (s.held ? ITEM_FLAG_HELD : 0);
    structs[o + OFF_ROOM] =
      (s.nowhere ? 0x3f : s.room) | (s.nearby ? NEARBY_7 | NEARBY_6 : 0);
    structs[o + OFF_X] = s.pos.x;
    structs[o + OFF_Y] = s.pos.y;
    structs[o + OFF_HEIGHT] = s.pos.height;
    structs[o + OFF_ISO_X] = s.isoPos.x;
    structs[o + OFF_ISO_Y] = s.isoPos.y;
  });
  return {
    structs,
    held: new Uint8Array([ITEM_NONE, ITEM_NONE]),
    attributes: Uint8Array.from(itemAttributes),
  };
}

/** A read-only view of one itemstruct, decoded from the owning bytes. */
export function readItemStruct(s: ItemState, index: number): ItemStruct {
  const o = index * ITEMSTRUCT_STRIDE;
  const itemByte = s.structs[o + OFF_ITEM]!;
  const roomByte = s.structs[o + OFF_ROOM]!;
  return {
    index,
    item: itemByte & ITEM_MASK,
    poisoned: (itemByte & 0x20) !== 0,
    held: (itemByte & ITEM_FLAG_HELD) !== 0,
    room: roomByte & ROOM_MASK,
    nowhere: (roomByte & ROOM_MASK) === 0x3f,
    nearby: (roomByte & NEARBY_7) !== 0 && (roomByte & NEARBY_6) !== 0,
    pos: { x: s.structs[o + OFF_X]!, y: s.structs[o + OFF_Y]!, height: s.structs[o + OFF_HEIGHT]! },
    isoPos: { x: s.structs[o + OFF_ISO_X]!, y: s.structs[o + OFF_ISO_Y]! },
  };
}

export function allItemStructs(s: ItemState): ItemStruct[] {
  return Array.from({ length: ITEM_COUNT }, (_, i) => readItemStruct(s, i));
}

/**
 * find_nearby_item ($7C82).
 *
 * "Returns the first item within range of the hero not by distance but by item
 * order" -- there is no nearest-item search, the scan simply stops at the
 * first hit, so which item you pick up in a pile is decided by item index.
 *
 * The radius is 1 outdoors and 6 indoors ($7C82/$7C8A), and the range test is
 * done on the ISO map position ($7C98 points at $81B8), not on the tinypos.
 *
 * @returns the item index, or -1.
 */
export function findNearbyItem(
  s: ItemState,
  mapPosition: { x: number; y: number },
  room: number,
): number {
  const radius = room === 0 ? 1 : 6;
  for (let i = 0; i < ITEM_COUNT; i++) {
    const o = i * ITEMSTRUCT_STRIDE;
    // $7C91 tests bit 7 only -- NOT both nearby bits, unlike the draw scan.
    if ((s.structs[o + OFF_ROOM]! & NEARBY_7) === 0) continue;

    const coords = [mapPosition.x, mapPosition.y];
    let inRange = true;
    for (let axis = 0; axis < 2; axis++) {
      const v = s.structs[o + OFF_X + axis]!;
      // $7C9E..$7CA5. Every step is 8-bit: SUB C, then two ADD A,C to get
      // back up to m + radius. Near the edges of the map the subtraction
      // wraps, and the comparison is unsigned, so a low map position can fail
      // the first test rather than succeeding trivially.
      let a = (coords[axis]! - radius) & 0xff;
      if (a >= v) { inRange = false; break; } // $7CA0 JR NC
      a = (a + radius) & 0xff;
      a = (a + radius) & 0xff;
      if (a < v) { inRange = false; break; } // $7CA5 JR C
    }
    if (inRange) return i;
  }
  return -1;
}

/**
 * pick_up_item ($7B36).
 *
 * Four things happen and the third is easy to miss: the HELD flag is set on
 * the itemstruct so the 5 morale / 5 points are awarded only on the FIRST
 * pick-up of each item ($7B70), and it is set whether or not points were
 * awarded this time.
 *
 * The item written into the held slot is masked with $1F, not $0F. The
 * disassembly flags this: "the mask used here is $1F, not $0F as seen
 * elsewhere in the code. Unsure why". Reproduced as coded -- for the shipped
 * table the two agree, because no itemstruct has bit 4 set.
 *
 * @returns the item index picked up, or -1.
 */
export function pickUpItem(
  s: ItemState,
  player: PlayerState,
  mapPosition: { x: number; y: number },
  room: number,
): number {
  // $7B3B: both slots full? Note the test passes if EITHER is item_NONE.
  if (s.held[0] !== ITEM_NONE && s.held[1] !== ITEM_NONE) return -1;

  const index = findNearbyItem(s, mapPosition, room);
  if (index < 0) return -1; // $7B43

  const o = index * ITEMSTRUCT_STRIDE;
  const slot = s.held[0] === ITEM_NONE ? 0 : 1; // $7B47..$7B4C
  s.held[slot] = s.structs[o + OFF_ITEM]! & 0x1f; // $7B4E AND $1F

  if ((s.structs[o + OFF_ITEM]! & ITEM_FLAG_HELD) === 0) {
    s.structs[o + OFF_ITEM] = s.structs[o + OFF_ITEM]! | ITEM_FLAG_HELD; // $7B70
    increaseMoraleBy5ScoreBy5(player); // $7B73
  }

  // $7B77: the item vanishes -- room zeroed, iso_pos zeroed. pos is left
  // alone, which is why a dropped item does not reappear where it was found.
  s.structs[o + OFF_ROOM] = 0;
  s.structs[o + OFF_ISO_X] = 0;
  s.structs[o + OFF_ISO_Y] = 0;
  return index;
}

/**
 * drop_item_tail ($7BB5): write a dropped item back into its itemstruct.
 *
 * Split out in the original "so that #R$B387 can make use of it" -- the red
 * cross parcel drops an item without going through the player's inventory.
 *
 * Outdoors the position is the hero's world position scaled down, with height
 * forced to ZERO ($7BCC); indoors it is his tinypos-scale position with height
 * FIVE ($7BF0). Two different heights and two different projections; using one
 * pair for both puts dropped items through the floor.
 */
export function dropItemTail(
  s: ItemState,
  item: number,
  room: number,
  heroPos: Pos,
): void {
  const o = item * ITEMSTRUCT_STRIDE; // $7BB5 item_to_itemstruct
  s.structs[o + OFF_ROOM] = room; // $7BBC

  let tiny: TinyPos;
  if (room === 0) {
    tiny = { ...posToTinypos(heroPos), height: 0 }; // $7BC8, $7BCC
    s.structs[o + OFF_X] = tiny.x;
    s.structs[o + OFF_Y] = tiny.y;
    s.structs[o + OFF_HEIGHT] = tiny.height;
    const iso = calcExteriorItemIsoPos(tiny);
    s.structs[o + OFF_ISO_X] = iso.x;
    s.structs[o + OFF_ISO_Y] = iso.y;
  } else {
    // $7BE4: indoors mi.pos is already tinypos-scale, so the low bytes are
    // copied straight across with no division.
    tiny = { x: heroPos.x & 0xff, y: heroPos.y & 0xff, height: 5 };
    s.structs[o + OFF_X] = tiny.x;
    s.structs[o + OFF_Y] = tiny.y;
    s.structs[o + OFF_HEIGHT] = tiny.height;
    const iso = calcInteriorItemIsoPos(tiny);
    s.structs[o + OFF_ISO_X] = iso.x;
    s.structs[o + OFF_ISO_Y] = iso.y;
  }
}

/**
 * drop_item ($7B8B): drop the FIRST held item and shuffle the second down.
 *
 * Dropping the uniform also resets the hero's sprite set ($7B96) -- the
 * disguise is the sprite, there is no separate "wearing uniform" flag.
 *
 * @returns the item dropped, or -1.
 */
export function dropItem(
  s: ItemState,
  room: number,
  heroPos: Pos,
  onUniformRemoved?: () => void,
): number {
  const item = s.held[0]!;
  if (item === ITEM_NONE) return -1; // $7B90

  if (item === ITEM_UNIFORM) onUniformRemoved?.(); // $7B91..$7B99

  s.held[0] = s.held[1]!; // $7BA0..$7BA4
  s.held[1] = ITEM_NONE;

  dropItemTail(s, item, room, heroPos);
  return item;
}

/**
 * The item_actions_jump_table ($7B16), as handler slots.
 *
 * Sixteen entries; five of them ($7B1E, $7B24, $7B30, $7B32, $7B34) point at a
 * bare RET, so those items simply do nothing when used. They are listed
 * explicitly rather than omitted, because "no handler" and "handler that
 * returns" have to look the same to `useItem`.
 */
export const ITEM_ACTION_ADDRESSES: readonly string[] = [
  '$B417', // 0  wiresnips
  '$B3F6', // 1  shovel
  '$B495', // 2  lockpick
  '$EFCB', // 3  papers
  '$7AEF', // 4  torch -- RET
  '$B3A8', // 5  bribe
  '$B3E1', // 6  uniform
  '$7AEF', // 7  food -- RET
  '$B3C4', // 8  poison
  '$B4AE', // 9  red key
  '$B4B2', // 10 yellow key
  '$B4B6', // 11 green key
  '$B387', // 12 red cross parcel
  '$7AEF', // 13 radio -- RET
  '$7AEF', // 14 purse -- RET
  '$7AEF', // 15 compass -- RET
];

export type ItemAction = (item: number) => void;

/**
 * use_item_common ($7AF8).
 *
 * Before dispatching, it copies the hero's x, y and height into saved_pos
 * ($7B0A, six bytes) -- the handlers that move him read it back. Dropping that
 * copy is invisible until a handler needs it.
 *
 * @param slot 0 for use_item_A ($7AF5), 1 for use_item_B ($7AF0).
 */
export function useItem(
  s: ItemState,
  slot: number,
  heroPos: Pos,
  savedPos: Pos,
  actions: Readonly<Record<number, ItemAction>>,
): number {
  const item = s.held[slot]!;
  if (item === ITEM_NONE) return -1; // $7AFA

  savedPos.x = heroPos.x; // $7B0A LDIR, six bytes
  savedPos.y = heroPos.y;
  savedPos.height = heroPos.height;

  actions[item]?.(item);
  return item;
}

/**
 * process_player_input_fire ($7AC9): the four fire+direction commands.
 *
 * Only four of the nine fire combinations are tested. Fire alone and all four
 * diagonals fall through to the return at $7AEF, so they do nothing -- see
 * INPUT_FIRE_* in actions.ts.
 *
 * @returns what happened, for the demo's status line. `null` when the input
 *   was not one of the four, so a caller can tell "not a command" from
 *   "command that did nothing".
 */
export function processPlayerInputFire(
  s: ItemState,
  input: number,
  ctx: {
    player: PlayerState;
    room: number;
    mapPosition: { x: number; y: number };
    heroPos: Pos;
    savedPos: Pos;
    actions: Readonly<Record<number, ItemAction>>;
    onUniformRemoved?: () => void;
  },
): { command: 'pick up' | 'drop' | 'use A' | 'use B'; item: number } | null {
  switch (input) {
    case 0x0a: // $7AC9 fire + up
      return { command: 'pick up', item: pickUpItem(s, ctx.player, ctx.mapPosition, ctx.room) };
    case 0x0b: // $7AD3 fire + down
      return { command: 'drop', item: dropItem(s, ctx.room, ctx.heroPos, ctx.onUniformRemoved) };
    case 0x0c: // $7ADD fire + left
      return { command: 'use A', item: useItem(s, 0, ctx.heroPos, ctx.savedPos, ctx.actions) };
    case 0x0f: // $7AE7 fire + right
      return { command: 'use B', item: useItem(s, 1, ctx.heroPos, ctx.savedPos, ctx.actions) };
    default:
      return null;
  }
}

/**
 * mark_nearby_items ($DB9E): recompute every item's NEARBY flags.
 *
 * Called once per main-loop iteration ($9D7B) and on entering a room ($6939).
 * Without it no item is ever flagged nearby, and both `find_nearby_item` and
 * the exterior half of `is_item_discoverable` silently find nothing forever.
 *
 * The comparison is against `map_position` ($81BB) -- the VIEW's scroll
 * position -- and against the item's `iso_pos`, not its tinypos. That makes
 * this the one place in the item code where the camera is the right thing to
 * read; `find_nearby_item` two routines away reads `hero_map_position`
 * ($81B8) instead, and the two are two bytes apart in memory.
 *
 * The bounds are taken from the instructions, not from the block comment,
 * which describes them as "(-1..22, 0..15)":
 *
 *   x: mapX - 2  <= iso_pos.x <= mapX + 23   ($DBBC / $DBC3 ADD A,$19)
 *   y: mapY - 1  <= iso_pos.y <= mapY + 16   ($DBCA / $DBD0 ADD A,$11)
 *
 * Every step is 8-bit and the comparisons are unsigned, so near the origin the
 * subtractions wrap and the test behaves differently from the signed reading
 * the comment suggests. Reproduced as coded.
 */
export function markNearbyItems(
  s: ItemState,
  mapPosition: { x: number; y: number },
  room: number,
): void {
  // $DBA1: room_NONE is treated as outdoors.
  const current = room === 0xff ? 0 : room;

  for (let i = 0; i < ITEM_COUNT; i++) {
    const o = i * ITEMSTRUCT_STRIDE;
    const roomByte = s.structs[o + OFF_ROOM]!;
    let near = (roomByte & 0x3f) === current; // $DBB4

    if (near) {
      const isoX = s.structs[o + OFF_ISO_X]!;
      let a = (mapPosition.x - 2) & 0xff; // $DBBC, two DEC A
      if (a !== isoX && a > isoX) near = false; // $DBBF JR Z / $DBC1 JR NC
      if (near) {
        a = (a + 0x19) & 0xff; // $DBC3
        if (a < isoX) near = false; // $DBC6 JR C
      }
    }
    if (near) {
      const isoY = s.structs[o + OFF_ISO_Y]!;
      let a = (mapPosition.y - 1) & 0xff; // $DBCA
      if (a !== isoY && a > isoY) near = false; // $DBCC / $DBCE
      if (near) {
        a = (a + 0x11) & 0xff; // $DBD0
        if (a < isoY) near = false; // $DBD3 JR C
      }
    }

    // $DBD6 sets BOTH bits, $DBDD clears both. They always move together here,
    // which is why the draw scan can afford to test them separately.
    s.structs[o + OFF_ROOM] = near
      ? roomByte | NEARBY_7 | NEARBY_6
      : roomByte & ~(NEARBY_7 | NEARBY_6) & 0xff;
  }
}
