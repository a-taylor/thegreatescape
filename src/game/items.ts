/**
 * Items: the sixteen things lying around the camp.
 *
 * Two tables, and they are indexed the same way but shaped differently:
 *
 *   item_structs      ($76C8) 7 bytes each -- where an item currently IS:
 *                     {item_and_flags, room_and_flags, pos.x/y/height,
 *                      iso_pos.x/y}
 *   item_definitions  ($DD7D) 6 bytes each -- what an item LOOKS like:
 *                     {width, height, bitmap, mask}
 *
 * The definition's width is a plain byte count, unlike the `sprites` table's
 * width-plus-one, because setup_item_plotting never needs the extra byte --
 * "item plotting only ever uses the 16 pixel plotter" ($DC41). This is gated by
 * a pixel-exact golden comparison against the reference build's 27 item images.
 */

import itemsJson from '../../data/items.json';

/** item__LIMIT ($DC30 LD A,$10). */
export const ITEM_COUNT = 16;

export interface ItemDefinition {
  readonly index: number;
  readonly addr: string;
  /** A plain byte count -- NOT width-plus-one. See the module comment. */
  readonly widthBytes: number;
  readonly widthPixels: number;
  readonly height: number;
  readonly bitmapAddr: string;
  readonly maskAddr: string;
  readonly bitmapLabels: readonly string[];
  readonly maskLabels: readonly string[];
  readonly bitmap: string;
  readonly mask: string;
}

const data = itemsJson as unknown as {
  count: number;
  structStride: number;
  structs: number[][];
  definitions: { records: ItemDefinition[] };
};

export const itemDefinitions: readonly ItemDefinition[] = data.definitions.records;

/**
 * One itemstruct, decoded ($76C8, seven bytes).
 *
 * The two flag bytes carry more than their names suggest: the room byte's top
 * two bits are the NEARBY flags the draw-order scan tests ($DBF1/$DBF5), not
 * part of the room number, so the room must be masked out of it.
 */
export interface ItemStruct {
  readonly index: number;
  /** itemstruct_ITEM_MASK -- bits 0..3 of byte 0. */
  readonly item: number;
  /** itemstruct_ITEM_FLAG_POISONED (bit 5), set on food to stall a dog. */
  readonly poisoned: boolean;
  /** itemstruct_ITEM_FLAG_HELD (bit 7), set on first pickup, for scoring. */
  readonly held: boolean;
  /** itemstruct_ROOM_MASK -- bits 0..5 of byte 1. */
  readonly room: number;
  /** room $3F is itemstruct_ROOM_NONE: the item is nowhere. */
  readonly nowhere: boolean;
  /** itemstruct_ROOM_FLAG_NEARBY_7 and _6 -- both required to draw. */
  readonly nearby: boolean;
  /** tinypos: bytes, an eighth of world scale. */
  readonly pos: { readonly x: number; readonly y: number; readonly height: number };
  /** iso_pos, stored in TILE rows -- see itemPlacement. */
  readonly isoPos: { readonly x: number; readonly y: number };
}

export const ITEM_MASK = 0x0f;
export const ITEM_FLAG_POISONED = 1 << 5;
export const ITEM_FLAG_HELD = 1 << 7;
export const ROOM_MASK = 0x3f;
/** (item_NONE & itemstruct_ROOM_MASK) -- the item is nowhere. */
export const ROOM_NONE = 0x3f;
export const NEARBY_6 = 1 << 6;
export const NEARBY_7 = 1 << 7;

export function itemStructs(): ItemStruct[] {
  return data.structs.map((r, index) => {
    const itemByte = r[0]!;
    const roomByte = r[1]!;
    return {
      index,
      item: itemByte & ITEM_MASK,
      poisoned: (itemByte & ITEM_FLAG_POISONED) !== 0,
      held: (itemByte & ITEM_FLAG_HELD) !== 0,
      room: roomByte & ROOM_MASK,
      nowhere: (roomByte & ROOM_MASK) === ROOM_NONE,
      // $DBF1 and $DBF5 test the two bits separately but require both.
      nearby: (roomByte & NEARBY_7) !== 0 && (roomByte & NEARBY_6) !== 0,
      pos: { x: r[2]!, y: r[3]!, height: r[4]! },
      isoPos: { x: r[5]!, y: r[6]! },
    };
  });
}

/**
 * The item index setup_item_plotting actually uses ($DC41 `AND $3F`).
 *
 * The disassembly flags this: "The $3F mask here looks like it ought to be $1F
 * (item__LIMIT - 1). Potential bug: the use of A later on does not re-clamp it
 * to $1F." $3F leaves bit 5 set, so an index above 31 would run off the end of
 * item_definitions. In practice the scan never produces one -- it counts to 16
 * ($DC30) and ORs in only bit 6 as the found flag -- so the wider mask is
 * unreachable rather than wrong. Reproduced as coded, with the reachable range
 * asserted in the tests.
 */
export const ITEM_INDEX_MASK = 0x3f;

/** item_FOUND ($DC33 `OR $40`), stripped by the mask above. */
export const ITEM_FOUND_FLAG = 0x40;

export function itemIndexFromDrawable(a: number): number {
  return a & ITEM_INDEX_MASK;
}
