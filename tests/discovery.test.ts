/**
 * Item discovery.
 *
 * Three coded bugs are reproduced here, so three of these tests assert the
 * wrong-looking answer on purpose. Each says which address it is pinning.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_LOCATION_STRIDE,
  DISCOVERY_MORALE_COST,
  ITEM_FOOD,
  ITEM_GREEN_KEY,
  ITEM_RED_CROSS_PARCEL,
  MESSAGE_ITEM_DISCOVERED,
  defaultItemLocations,
  isItemDiscoverable,
  isItemDiscoverableExterior,
  isItemDiscoverableInterior,
  itemDiscovered,
} from '../src/game/discovery.js';
import {
  ITEMSTRUCT_STRIDE,
  OFF_HEIGHT,
  OFF_ISO_Y,
  OFF_ITEM,
  OFF_ROOM,
  OFF_X,
  OFF_Y,
  createItemState,
} from '../src/game/inventory.js';
import { ITEM_COUNT, ITEM_FLAG_HELD, NEARBY_7 } from '../src/game/items.js';
import { createPlayer } from '../src/game/player.js';

/** Clear every item out of the world so each test controls the whole array. */
function emptyWorld() {
  const s = createItemState();
  for (let i = 0; i < ITEM_COUNT; i++) {
    s.structs[i * ITEMSTRUCT_STRIDE + OFF_ROOM] = 0;
    s.structs[i * ITEMSTRUCT_STRIDE + OFF_ITEM] = i;
  }
  return s;
}

describe('is_item_discoverable, outdoors', () => {
  it('finds a nearby item that is neither the green key nor food', () => {
    const s = emptyWorld();
    s.structs[3 * ITEMSTRUCT_STRIDE + OFF_ROOM] = NEARBY_7;
    expect(isItemDiscoverableExterior(s)).toBe(3);
  });

  it('ignores the green key and food ($CCEF, $CCF3)', () => {
    for (const item of [ITEM_GREEN_KEY, ITEM_FOOD]) {
      const s = emptyWorld();
      s.structs[item * ITEMSTRUCT_STRIDE + OFF_ROOM] = NEARBY_7;
      expect({ item, found: isItemDiscoverableExterior(s) }).toEqual({ item, found: -1 });
    }
  });

  it('finds nothing in an empty camp', () => {
    expect(isItemDiscoverableExterior(emptyWorld())).toBe(-1);
  });

  it('goes off by one after skipping the green key ($CCEB DEC HL)', () => {
    // The reproduced bug. After the green key is skipped, `ADD HL,DE` advances
    // from the ITEM byte instead of the room byte, so every later iteration is
    // one byte early. From then on the scan:
    //   - tests bit 7 of struct N's ITEM byte -- ITEM_FLAG_HELD, not NEARBY_7
    //   - and reads its "item index" from struct N-1's iso_pos.y
    //
    // Both of those are set explicitly here so the expected answer comes from
    // the arithmetic and not from whatever the shipped table happens to hold.
    const s = emptyWorld();
    s.structs[ITEM_GREEN_KEY * ITEMSTRUCT_STRIDE + OFF_ROOM] = NEARBY_7;

    const victim = ITEM_GREEN_KEY + 1;
    s.structs[victim * ITEMSTRUCT_STRIDE + OFF_ROOM] = 0; // NOT nearby
    s.structs[victim * ITEMSTRUCT_STRIDE + OFF_ITEM] = victim | ITEM_FLAG_HELD;
    // struct N-1's iso_pos.y is the byte the shifted read lands on.
    s.structs[ITEM_GREEN_KEY * ITEMSTRUCT_STRIDE + OFF_ISO_Y] = 0x33;

    // 0x33 & $0F == 3: the scan reports "item 3" from a byte that is not an
    // item index at all, for an item that was never nearby.
    expect(isItemDiscoverableExterior(s)).toBe(3);

    // Without the drift there is nothing to find: the victim is not nearby and
    // the green key is exempt.
    const clean = emptyWorld();
    clean.structs[victim * ITEMSTRUCT_STRIDE + OFF_ROOM] = 0;
    expect(isItemDiscoverableExterior(clean)).toBe(-1);
  });

  it('never reads outside item_structs, however far the pointer drifts', () => {
    // What keeps the bug on the reproduce side of BUILD_PROMPT.md §9. Make
    // every item both nearby and a green key so the drift is maximal.
    const s = emptyWorld();
    for (let i = 0; i < ITEM_COUNT; i++) {
      s.structs[i * ITEMSTRUCT_STRIDE + OFF_ROOM] = NEARBY_7;
      s.structs[i * ITEMSTRUCT_STRIDE + OFF_ITEM] = ITEM_GREEN_KEY;
    }
    // If the scan ever indexed past the array it would read undefined and the
    // masks would silently yield 0, which is item 0 -- a false positive.
    expect(isItemDiscoverableExterior(s)).toBe(-1);
    expect(s.structs.length).toBe(ITEM_COUNT * ITEMSTRUCT_STRIDE);
  });
});

describe('is_item_discoverable, indoors', () => {
  it('finds an item that has been moved out of its default room', () => {
    const s = emptyWorld();
    // Item 5's default room, then put it somewhere else.
    const home = defaultItemLocations[5 * DEFAULT_LOCATION_STRIDE]!;
    const elsewhere = home === 7 ? 8 : 7;
    s.structs[5 * ITEMSTRUCT_STRIDE + OFF_ROOM] = elsewhere;
    s.structs[5 * ITEMSTRUCT_STRIDE + OFF_ITEM] = 5;

    expect(isItemDiscoverableInterior(s, elsewhere)).toBe(5);
  });

  it('ignores an item sitting in its own default room', () => {
    const s = emptyWorld();
    const home = defaultItemLocations[5 * DEFAULT_LOCATION_STRIDE]!;
    s.structs[5 * ITEMSTRUCT_STRIDE + OFF_ROOM] = home;
    s.structs[5 * ITEMSTRUCT_STRIDE + OFF_ITEM] = 5;
    expect(isItemDiscoverableInterior(s, home)).toBe(-1);
  });

  it('exempts the red cross parcel ($CD27)', () => {
    const s = emptyWorld();
    s.structs[ITEM_RED_CROSS_PARCEL * ITEMSTRUCT_STRIDE + OFF_ROOM] = 9;
    s.structs[ITEM_RED_CROSS_PARCEL * ITEMSTRUCT_STRIDE + OFF_ITEM] = ITEM_RED_CROSS_PARCEL;
    expect(isItemDiscoverableInterior(s, 9)).toBe(-1);
  });

  it('compares the default room UNMASKED, which only affects the wiresnips', () => {
    // $CD17. The wiresnips are item 0 and their default room byte is $FF --
    // room 63 with both flag bits set. Masked it would be ROOM_NONE; unmasked
    // it is $FF, which cannot equal any room index, so they always read as
    // "moved". Asserted as the quirk, and as the reason it is confined to one
    // item: no other default location has flag bits set.
    expect(defaultItemLocations[0]).toBe(0xff);
    const withFlags = [];
    for (let i = 0; i < ITEM_COUNT; i++) {
      const b = defaultItemLocations[i * DEFAULT_LOCATION_STRIDE]!;
      if ((b & 0xc0) !== 0) withFlags.push(i);
    }
    expect(withFlags).toEqual([0]);

    const s = emptyWorld();
    s.structs[0 * ITEMSTRUCT_STRIDE + OFF_ROOM] = 0x3f; // ROOM_NONE, unflagged
    s.structs[0 * ITEMSTRUCT_STRIDE + OFF_ITEM] = 0;
    expect(isItemDiscoverableInterior(s, 0x3f)).toBe(0);
  });
});

describe('is_item_discoverable', () => {
  it('picks the exterior search for room 0 and the interior one otherwise', () => {
    const s = emptyWorld();
    s.structs[3 * ITEMSTRUCT_STRIDE + OFF_ROOM] = NEARBY_7;
    expect(isItemDiscoverable(s, 0)).toBe(3);

    // Indoors the NEARBY flag is irrelevant; what matters is the room. Put the
    // item in its own default room and the interior search ignores it.
    const home = defaultItemLocations[3 * DEFAULT_LOCATION_STRIDE]!;
    s.structs[3 * ITEMSTRUCT_STRIDE + OFF_ROOM] = NEARBY_7 | home;
    s.structs[3 * ITEMSTRUCT_STRIDE + OFF_ITEM] = 3;
    expect(isItemDiscoverable(s, home)).toBe(-1);
  });
});

describe('item_discovered', () => {
  it('does nothing for item_NONE ($CD34)', () => {
    const s = emptyWorld();
    const p = createPlayer();
    const queued: number[] = [];
    itemDiscovered(s, p, 0xff, (i) => queued.push(i));
    expect(queued).toEqual([]);
    expect(p.morale).toBe(112);
  });

  it('queues the message, costs 5 morale, and sends the item home', () => {
    const s = emptyWorld();
    const p = createPlayer();
    const queued: number[] = [];
    const item = 5;
    s.structs[item * ITEMSTRUCT_STRIDE + OFF_ITEM] = item | ITEM_FLAG_HELD;

    itemDiscovered(s, p, item, (i) => queued.push(i));

    expect(queued).toEqual([MESSAGE_ITEM_DISCOVERED]);
    expect(p.morale).toBe(112 - DISCOVERY_MORALE_COST);

    const o = item * ITEMSTRUCT_STRIDE;
    const d = item * DEFAULT_LOCATION_STRIDE;
    expect(s.structs[o + OFF_ROOM]).toBe(defaultItemLocations[d]);
    expect(s.structs[o + OFF_X]).toBe(defaultItemLocations[d + 1]);
    expect(s.structs[o + OFF_Y]).toBe(defaultItemLocations[d + 2]);
    // The HELD flag is cleared so the item can score again ($CD53).
    expect(s.structs[o + OFF_ITEM]! & ITEM_FLAG_HELD).toBe(0);
  });

  it('uses height 0 outdoors and height 5 indoors ($CD61 / $CD65)', () => {
    // Find one item whose default room is outdoors and one whose is not.
    let outdoor = -1;
    let indoor = -1;
    for (let i = 0; i < ITEM_COUNT; i++) {
      const room = defaultItemLocations[i * DEFAULT_LOCATION_STRIDE]!;
      if (room === 0 && outdoor < 0) outdoor = i;
      if (room !== 0 && indoor < 0) indoor = i;
    }
    expect(outdoor).toBeGreaterThanOrEqual(0);
    expect(indoor).toBeGreaterThanOrEqual(0);

    const s = emptyWorld();
    const p = createPlayer();
    itemDiscovered(s, p, outdoor, () => {});
    itemDiscovered(s, p, indoor, () => {});

    expect(s.structs[outdoor * ITEMSTRUCT_STRIDE + OFF_HEIGHT]).toBe(0);
    expect(s.structs[indoor * ITEMSTRUCT_STRIDE + OFF_HEIGHT]).toBe(5);
  });

  it('sends the wiresnips indoors, because their room byte is $FF not 0', () => {
    // The unmasked test at $CD5E again: $FF is non-zero, so the wiresnips take
    // the interior path even though room 63 is ROOM_NONE.
    const s = emptyWorld();
    const p = createPlayer();
    itemDiscovered(s, p, 0, () => {});
    expect(s.structs[0 * ITEMSTRUCT_STRIDE + OFF_ROOM]).toBe(0xff);
    expect(s.structs[0 * ITEMSTRUCT_STRIDE + OFF_HEIGHT]).toBe(5);
  });
});
