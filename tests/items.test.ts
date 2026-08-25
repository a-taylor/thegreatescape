/**
 * Items: item_structs ($76C8), item_definitions ($DD7D) and
 * setup_item_plotting (c$DC41).
 */

import { describe, expect, it } from 'vitest';

import {
  ITEM_COUNT,
  ITEM_FOUND_FLAG,
  ITEM_INDEX_MASK,
  ROOM_NONE,
  itemDefinitions,
  itemIndexFromDrawable,
  itemStructs,
} from '../src/game/items.js';
import { itemPlacement, windowPlacement } from '../src/render/place.js';

describe('item_definitions', () => {
  const defs = itemDefinitions;

  it('is one 6-byte spritedef per item', () => {
    expect(defs).toHaveLength(ITEM_COUNT);
    expect(defs[0]!.addr).toBe('$DD7D');
    // $DC55..$DC5D multiplies the index by 6 to reach the record.
    expect(parseInt(defs[1]!.addr.slice(1), 16) - parseInt(defs[0]!.addr.slice(1), 16))
      .toBe(6);
  });

  it('stores a plain width, not width-plus-one', () => {
    // The sprites table stores width+1; this one does not, because item
    // plotting "only ever uses the 16 pixel plotter" and never needs the extra
    // byte. Every item is 2 bytes -- 16 pixels -- exactly as that implies.
    for (const d of defs) {
      expect(d.widthBytes).toBe(2);
      expect(d.widthPixels).toBe(16);
    }
  });

  it('carries as many bitmap bytes as width x height', () => {
    for (const d of defs) {
      // base64 of width*height bytes; decode length is what matters.
      const bytes = atob(d.bitmap).length;
      expect(bytes, `item ${d.index}`).toBe(d.widthBytes * d.height);
      expect(atob(d.mask).length, `item ${d.index} mask`).toBe(bytes);
    }
  });

  it('shares artwork between the three keys', () => {
    // Items 9, 10 and 11 are all bitmap_key with the shovel's mask.
    expect(defs[9]!.bitmapLabels).toContain('bitmap_key');
    expect(defs[10]!.bitmapAddr).toBe(defs[9]!.bitmapAddr);
    expect(defs[11]!.bitmapAddr).toBe(defs[9]!.bitmapAddr);
    expect(defs[1]!.maskLabels).toContain('mask_shovel_key');
    expect(defs[9]!.maskAddr).toBe(defs[1]!.maskAddr);
  });
});

describe('item_structs', () => {
  const structs = itemStructs();

  it('is sixteen seven-byte records', () => {
    expect(structs).toHaveLength(ITEM_COUNT);
  });

  it('decodes the first record as the disassembly comments it', () => {
    // $76C8 DEFB $00,$FF,$40,$20,$02,$78,$F4
    //   { item_WIRESNIPS, room_NONE, (64, 32, 2), (0x78, 0xF4) }
    const w = structs[0]!;
    expect(w.item).toBe(0);
    expect(w.pos).toEqual({ x: 0x40, y: 0x20, height: 0x02 });
    expect(w.isoPos).toEqual({ x: 0x78, y: 0xf4 });
  });

  it('reads room_NONE as nowhere, not as room 63', () => {
    // $FF masks to $3F, which IS itemstruct_ROOM_NONE -- the wiresnips and the
    // bribe start nowhere. Masking without checking for $3F would place them in
    // a room that does not exist.
    expect(structs[0]!.room).toBe(ROOM_NONE);
    expect(structs[0]!.nowhere).toBe(true);
    expect(structs[1]!.nowhere).toBe(false); // shovel, room 9
    expect(structs[1]!.room).toBe(9);
  });

  it('separates the room from the NEARBY flags', () => {
    // $FF has both flag bits set, but that is room_NONE's bit pattern, not a
    // claim that the wiresnips are nearby at startup.
    expect(structs[0]!.nearby).toBe(true);
    expect(structs[0]!.room).toBe(0x3f);
    // A plain room byte has neither flag.
    expect(structs[1]!.nearby).toBe(false);
  });

  it('starts with nothing held and nothing poisoned', () => {
    expect(structs.some((s) => s.held)).toBe(false);
    expect(structs.some((s) => s.poisoned)).toBe(false);
  });

  it('gives every placed item a room that exists', () => {
    for (const s of structs) {
      if (s.nowhere) continue;
      expect(s.room, `item ${s.index}`).toBeLessThan(ROOM_NONE);
    }
  });

  it('places the green key outdoors', () => {
    // $7715 DEFB $0B,$00,... -- room_0_OUTDOORS, a real placement and not a
    // "nowhere" sentinel. Room 0 is a legitimate room number for an item, so
    // "placed" cannot be tested as room != 0; only $3F means nowhere.
    const green = structs[11]!;
    expect(green.room).toBe(0);
    expect(green.nowhere).toBe(false);
    expect(green.pos).toEqual({ x: 0x4a, y: 0x48, height: 0 });
  });
});

describe('the item index mask', () => {
  it('strips item_FOUND', () => {
    // $DC33 ORs in $40; $DC41 masks with $3F, which removes it.
    expect(itemIndexFromDrawable(7 | ITEM_FOUND_FLAG)).toBe(7);
    expect(itemIndexFromDrawable(15 | ITEM_FOUND_FLAG)).toBe(15);
  });

  it('uses $3F where $1F would do, as coded', () => {
    // The disassembly flags this as a potential bug. Reproduced, because the
    // wider mask is unreachable rather than wrong...
    expect(ITEM_INDEX_MASK).toBe(0x3f);
    // ...and this is why: the scan only ever produces 0..15 plus bit 6, so
    // every reachable input already lands inside item_definitions.
    for (let i = 0; i < ITEM_COUNT; i++) {
      expect(itemIndexFromDrawable(i | ITEM_FOUND_FLAG)).toBeLessThan(ITEM_COUNT);
    }
  });
});

describe('setup_item_plotting places on tile rows', () => {
  const map = { x: 100, y: 40 };

  it('subtracts the map position on both axes', () => {
    const p = itemPlacement(110, 45, map);
    expect(p.column).toBe(10); // $DCBC
    expect(p.pixelRow).toBe(40); // $DCA7: five tile rows down, 8 pixels each
  });

  it('always lands on a multiple of eight', () => {
    // The *192 at $DCAE..$DCBA is eight buffer rows, so items cannot sit at a
    // sub-tile vertical offset the way characters can.
    for (let row = 40; row < 56; row++) {
      expect(itemPlacement(100, row, map).pixelRow % 8).toBe(0);
    }
  });

  it('keeps a negative column rather than clamping it', () => {
    // $DCC6 sign-extends, leaving the clipper to decide ($DD02).
    expect(itemPlacement(97, 45, map).column).toBe(-3);
  });

  it('differs from the character rule, which is the point of both existing', () => {
    // A character at the same iso row gets single-pixel granularity ($E4EB
    // multiplies by 24); an item gets whole tiles ($DCAE multiplies by 192).
    // Applying the item rule to a character quantises him to 8-pixel steps.
    const asItem = itemPlacement(110, 45, map).pixelRow;
    const asCharacter = windowPlacement(
      { x: 0, y: 0, height: 0 },
      map,
    ).pixelRow;
    expect(asItem % 8).toBe(0);
    // The character path works from pixel rows, so it is free to be non-aligned.
    expect(asCharacter).not.toBe(asItem);
  });
});
