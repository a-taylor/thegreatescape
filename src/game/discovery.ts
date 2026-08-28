/**
 * Item discovery: the guards noticing something the hero has moved.
 *
 * Two searches with different rules. Outdoors, `is_item_discoverable` looks for
 * any item flagged NEARBY that is not the green key or food. Indoors,
 * `is_item_discoverable_interior` looks for an item that is in THIS room but
 * whose default location says it belongs somewhere else -- so an item is
 * incriminating because it has been moved, not because it is lying about.
 *
 * `item_discovered` then teleports the item back to its default location and
 * costs the hero 5 morale.
 *
 * Three coded bugs live in these forty instructions. All three are reproduced;
 * see FIDELITY.md for why each is on the reproduce side of BUILD_PROMPT.md §9.
 */

import itemsJson from '../../data/items.json';
import { calcExteriorItemIsoPos, calcInteriorItemIsoPos } from './coords.js';
import {
  ITEMSTRUCT_STRIDE,
  OFF_HEIGHT,
  OFF_ISO_X,
  OFF_ISO_Y,
  OFF_ITEM,
  OFF_ROOM,
  OFF_X,
  OFF_Y,
  type ItemState,
} from './inventory.js';
import { ITEM_COUNT, ITEM_FLAG_HELD, ITEM_MASK, NEARBY_7, ROOM_MASK } from './items.js';
import { decreaseMorale, type PlayerState } from './player.js';

const items = itemsJson as unknown as {
  defaultLocations: { values: number[] };
};

/** default_item_locations ($CD6A): 16 records of {room_and_flags, x, y}. */
export const defaultItemLocations: readonly number[] = items.defaultLocations.values;
export const DEFAULT_LOCATION_STRIDE = 3;

/** item_GREEN_KEY ($CCEF CP $0B) and item_FOOD ($CCF3 CP $07). */
export const ITEM_GREEN_KEY = 0x0b;
export const ITEM_FOOD = 0x07;
/** item_RED_CROSS_PARCEL ($CD27 CP $0C). */
export const ITEM_RED_CROSS_PARCEL = 0x0c;
/** messages_item_discovered ($CD38 LD B,$10). */
export const MESSAGE_ITEM_DISCOVERED = 0x10;
/** The morale cost of being found out ($CD3D LD B,$05). */
export const DISCOVERY_MORALE_COST = 5;

/**
 * is_item_discoverable, exterior half ($CCDB).
 *
 * Walks item_structs' ROOM bytes looking for the NEARBY_7 flag, then reads the
 * item index from the byte before.
 *
 * **The $CCEB off-by-one is reproduced.** `DEC HL` steps back to the item byte
 * and is never undone, so when the item turns out to be the green key or food
 * the `ADD HL,DE` at $CCE7 advances from the ITEM byte rather than the room
 * byte. Every later iteration is then shifted one byte early: it tests bit 7 of
 * struct N's ITEM byte -- which is ITEM_FLAG_HELD, not NEARBY_7 -- and, when
 * that is set, reads its "item index" from struct N-1's iso_pos.y. So a held
 * item that is nowhere near the hero can report a nonsense index. The
 * disassembly guesses the consequence: "I think it'll screw up when multiple
 * items are in range."
 *
 * It is reproduced rather than fixed because it cannot read outside the array.
 * The pointer only ever drifts backwards by one per green-key/food hit while
 * advancing seven, so across sixteen iterations it stays inside the 112 bytes
 * of item_structs. BUILD_PROMPT.md §9 excludes crashes and out-of-bounds
 * reads; this is neither, so the visible quirk stands.
 *
 * @returns the offending item index, or -1.
 */
export function isItemDiscoverableExterior(s: ItemState): number {
  let p = OFF_ROOM; // $CCDB, item_structs[0].room
  for (let i = 0; i < ITEM_COUNT; i++) { // $CCE1 LD B,$10
    if ((s.structs[p]! & NEARBY_7) === 0) { // $CCE3 BIT 7
      p += ITEMSTRUCT_STRIDE; // $CCE7
      continue;
    }
    p -= 1; // $CCEB DEC HL -- and never restored
    const item = s.structs[p]! & ITEM_MASK; // $CCEC/$CCED
    if (item === ITEM_GREEN_KEY || item === ITEM_FOOD) { // $CCEF / $CCF3
      p += ITEMSTRUCT_STRIDE; // $CCE7, now advancing from the wrong byte
      continue;
    }
    return item; // $CCF7 hostiles_pursue_prisoners
  }
  return -1;
}

/**
 * is_item_discoverable_interior ($CCFB).
 *
 * An item counts as discovered when it is in `room` but its default location
 * names a different room. The red cross parcel is exempt ($CD27), because the
 * hero is meant to open it wherever he likes.
 *
 * **The $CD17 comparison is unmasked, and that is reproduced.** The default
 * location's room byte is compared whole against the room index, flags
 * included, while the itemstruct's room was masked with $3F two instructions
 * earlier. The disassembly notes it and adds "the only default_item which uses
 * the flags is the wiresnips. The DOS version of the game fixes this." So the
 * effect is confined to one item: the wiresnips' default is $FF, which never
 * equals a room index, so they read as "moved" wherever they are.
 *
 * @returns the item index, or -1.
 */
export function isItemDiscoverableInterior(s: ItemState, room: number): number {
  for (let i = 0; i < ITEM_COUNT; i++) { // $CCFF LD B,$10
    const o = i * ITEMSTRUCT_STRIDE;
    if ((s.structs[o + OFF_ROOM]! & ROOM_MASK) !== room) continue; // $CD05

    const item = s.structs[o + OFF_ITEM]! & ITEM_MASK; // $CD0A
    const defaultRoom = defaultItemLocations[item * DEFAULT_LOCATION_STRIDE]!;
    if (defaultRoom === room) continue; // $CD17, deliberately unmasked

    // $CD22: re-read the item byte, then exempt the parcel.
    const found = s.structs[o + OFF_ITEM]! & ITEM_MASK;
    if (found === ITEM_RED_CROSS_PARCEL) continue; // $CD29
    return found; // $CD2E
  }
  return -1;
}

/** is_item_discoverable ($CCCD): pick the search that matches the room. */
export function isItemDiscoverable(s: ItemState, room: number): number {
  return room === 0
    ? isItemDiscoverableExterior(s) // $CCDB
    : isItemDiscoverableInterior(s, room); // $CCD3
}

/**
 * item_discovered ($CD31): send an item home and dock the hero 5 morale.
 *
 * Everything it writes, in order, because dropping any of it leaves the item
 * half-moved: the message, the morale, the HELD flag cleared ($CD53), then
 * room, x and y copied from default_item_locations ($CD5A LDIR, three bytes),
 * then a height of 0 outdoors or 5 indoors, then the matching projection.
 *
 * **The unmasked `C` at $CD44 and $CD4F is reproduced.** The index is masked to
 * $0F at $CD35 and pushed, but the two address calculations both add the
 * ORIGINAL byte back in: `A = 2*(C & $0F) + C` for the default-location offset,
 * and the raw `C` for item_to_itemstruct. The disassembly flags the second
 * ("Bug: C is not masked, so could go out of range"). For any C below 16 the
 * masked and unmasked values agree, and every caller passes one, so the
 * divergence is unreachable in play -- but it is coded here rather than
 * normalised, so a future caller that passes a flagged index behaves as the
 * original would.
 *
 * The outdoors test at $CD5E looks at the WHOLE default room byte, flags
 * included. The wiresnips' default is $FF, so they take the interior path.
 */
export function itemDiscovered(
  s: ItemState,
  player: PlayerState,
  item: number,
  queueMessage: (index: number, c?: number) => void,
): void {
  if (item === 0xff) return; // $CD34, item_NONE

  const masked = item & ITEM_MASK; // $CD35
  queueMessage(MESSAGE_ITEM_DISCOVERED); // $CD3A
  decreaseMorale(player, DISCOVERY_MORALE_COST); // $CD3F

  // $CD43 ADD A,A / $CD44 ADD A,C -- the second operand is the unmasked index.
  const d = (masked + masked + item) & 0xff;
  const roomAndFlags = defaultItemLocations[d]!;

  const o = (item & 0xff) * ITEMSTRUCT_STRIDE; // $CD50, also unmasked
  s.structs[o + OFF_ITEM] = s.structs[o + OFF_ITEM]! & ~ITEM_FLAG_HELD; // $CD53

  // $CD5A LDIR: room_and_flags, x, y -- three bytes, flags and all.
  s.structs[o + OFF_ROOM] = roomAndFlags;
  s.structs[o + OFF_X] = defaultItemLocations[d + 1]!;
  s.structs[o + OFF_Y] = defaultItemLocations[d + 2]!;

  const pos = {
    x: s.structs[o + OFF_X]!,
    y: s.structs[o + OFF_Y]!,
    height: 0,
  };

  if (roomAndFlags === 0) { // $CD5E AND A, on the whole byte
    pos.height = 0; // $CD61
    s.structs[o + OFF_HEIGHT] = 0;
    const iso = calcExteriorItemIsoPos(pos); // $CD62
    s.structs[o + OFF_ISO_X] = iso.x;
    s.structs[o + OFF_ISO_Y] = iso.y;
  } else {
    pos.height = 5; // $CD65
    s.structs[o + OFF_HEIGHT] = 5;
    const iso = calcInteriorItemIsoPos(pos); // $CD67
    s.structs[o + OFF_ISO_X] = iso.x;
    s.structs[o + OFF_ISO_Y] = iso.y;
  }
}
