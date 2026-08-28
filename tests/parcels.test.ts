/**
 * Red cross parcels and the roomdef pokes.
 *
 * The beds test is the one that matters most: it pins a deliberate divergence
 * from the original, which BUILD_PROMPT.md §9 requires.
 */

import { describe, expect, it } from 'vitest';

import {
  BED_COUNT,
  BED_COUNT_AS_CODED,
  INTERIOR_OBJECT_EMPTY_BED,
  ITEM_RED_CROSS_PARCEL,
  MESSAGE_RED_CROSS_PARCEL,
  ROOM_NONE,
  bedObjects,
  blockedTunnelBoundary,
  clearTunnelBlockage,
  createParcels,
  createRoomPokes,
  emptyAllBeds,
  eventNewRedCrossParcel,
  heroBedObject,
  isTunnelBlockageCleared,
  parcelContentsList,
  parcelResetData,
  pokedBound,
  pokedObject,
} from '../src/game/parcels.js';
import {
  ITEMSTRUCT_STRIDE,
  OFF_HEIGHT,
  OFF_ISO_X,
  OFF_ISO_Y,
  OFF_ITEM,
  OFF_ROOM,
  OFF_X,
  OFF_Y,
  createItemState,
} from '../src/game/inventory.js';
import { ITEM_COUNT } from '../src/game/items.js';

/** Every item nowhere, so the parcel logic has a clean slate. */
function nothingExists() {
  const s = createItemState();
  for (let i = 0; i < ITEM_COUNT; i++) {
    s.structs[i * ITEMSTRUCT_STRIDE + OFF_ROOM] = ROOM_NONE;
    s.structs[i * ITEMSTRUCT_STRIDE + OFF_ITEM] = i;
  }
  return s;
}

describe('event_new_red_cross_parcel', () => {
  it('spawns the first item on the list that is nowhere', () => {
    const s = nothingExists();
    const p = createParcels();
    const queued: number[] = [];

    expect(eventNewRedCrossParcel(s, p, (i) => queued.push(i))).toBe(parcelContentsList[0]);
    expect(p.contents).toBe(parcelContentsList[0]);
    expect(queued).toEqual([MESSAGE_RED_CROSS_PARCEL]);
  });

  it('skips contents that already exist in the world ($A23F)', () => {
    const s = nothingExists();
    // The first two entries exist somewhere; the third should be chosen.
    s.structs[parcelContentsList[0]! * ITEMSTRUCT_STRIDE + OFF_ROOM] = 5;
    s.structs[parcelContentsList[1]! * ITEMSTRUCT_STRIDE + OFF_ROOM] = 5;

    const p = createParcels();
    expect(eventNewRedCrossParcel(s, p, () => {})).toBe(parcelContentsList[2]);
  });

  it('refuses while the previous parcel is still out ($A22F)', () => {
    const s = nothingExists();
    s.structs[ITEM_RED_CROSS_PARCEL * ITEMSTRUCT_STRIDE + OFF_ROOM] = 20;
    const p = createParcels();
    const queued: number[] = [];
    expect(eventNewRedCrossParcel(s, p, (i) => queued.push(i))).toBe(-1);
    expect(queued).toEqual([]);
  });

  it('spawns nothing once every listed item exists', () => {
    const s = nothingExists();
    for (const item of parcelContentsList) {
      s.structs[item * ITEMSTRUCT_STRIDE + OFF_ROOM] = 5;
    }
    expect(eventNewRedCrossParcel(s, createParcels(), () => {})).toBe(-1);
  });

  it('resets the parcel itemstruct from the record, leaving item_and_flags alone', () => {
    const s = nothingExists();
    const o = ITEM_RED_CROSS_PARCEL * ITEMSTRUCT_STRIDE;
    s.structs[o + OFF_ITEM] = 0xab; // must survive: the LDIR starts one byte in
    eventNewRedCrossParcel(s, createParcels(), () => {});

    expect(s.structs[o + OFF_ITEM]).toBe(0xab);
    expect([
      s.structs[o + OFF_ROOM], s.structs[o + OFF_X], s.structs[o + OFF_Y],
      s.structs[o + OFF_HEIGHT], s.structs[o + OFF_ISO_X], s.structs[o + OFF_ISO_Y],
    ]).toEqual([...parcelResetData]);
  });
});

describe('the bed pokes', () => {
  it('empties six beds plus the hero\'s, NOT the seven the code asks for', () => {
    // The deliberate divergence. $A2C6 codes seven iterations over a six-entry
    // array; the seventh writes through a pointer read past the end, which the
    // disassembly identifies as ROM $1A42. BUILD_PROMPT.md §9 excludes ROM
    // writes, so six it is -- and both numbers stay in the source.
    expect(BED_COUNT_AS_CODED).toBe(7);
    expect(BED_COUNT).toBe(6);
    expect(bedObjects).toHaveLength(6);

    const s = createRoomPokes();
    emptyAllBeds(s);

    // Six prisoner beds plus the hero's, and nothing else.
    expect(s.objects.size).toBe(7);
    for (const bed of bedObjects) {
      expect(pokedObject(s, bed)).toBe(INTERIOR_OBJECT_EMPTY_BED);
    }
    expect(pokedObject(s, heroBedObject)).toBe(INTERIOR_OBJECT_EMPTY_BED);
  });

  it('puts the prisoner beds in the two right-hand huts and the hero in hut 2 left', () => {
    // Resolved from the pointers rather than assumed, so a mis-resolution in
    // the extractor shows up here.
    const rooms = new Set(bedObjects.map((b) => b.labels[0]));
    expect(rooms).toEqual(new Set(['roomdef_3_hut2_right', 'roomdef_5_hut3_right']));
    expect(heroBedObject.labels[0]).toBe('roomdef_2_hut2_left');
  });
});

describe('the shovel pokes', () => {
  it('invalidates the boundary AND removes the graphic ($B404, $B408)', () => {
    const s = createRoomPokes();
    expect(isTunnelBlockageCleared(s)).toBe(false);

    clearTunnelBlockage(s);

    expect(isTunnelBlockageCleared(s)).toBe(true);
    expect(pokedBound(s, blockedTunnelBoundary)).toBe(0xff);
    expect(blockedTunnelBoundary.field).toBe('x0');
    expect(blockedTunnelBoundary.labels[0]).toBe('roomdef_50_blocked_tunnel');
    // Both writes, not just the visible one.
    expect(s.objects.size).toBe(1);
  });
});
