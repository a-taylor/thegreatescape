/**
 * Red cross parcels, and the room-object pokes the day schedule makes.
 *
 * These sit together because both write into data the rest of the engine reads
 * as if it were constant: a parcel resets an itemstruct from a fixed record,
 * and waking up rewrites the bed objects inside roomdefs. In the original both
 * are literally self-modifying data -- the game pokes addresses in its own
 * tables -- so both need a mutable overlay rather than a recomputation.
 */

import geographyJson from '../../data/geography.json';
import itemsJson from '../../data/items.json';
import {
  ITEMSTRUCT_STRIDE,
  OFF_ROOM,
  type ItemState,
} from './inventory.js';
import { ROOM_MASK } from './items.js';

const items = itemsJson as unknown as {
  redCrossParcelContents: { values: number[] };
  redCrossParcelReset: { values: number[]; targetOffset: number };
};
const geography = geographyJson as unknown as {
  beds: { objects: RoomdefObjectRef[] };
  roomPokes: {
    heroBed: RoomdefObjectRef;
    blockedTunnelBoundary: RoomdefBoundRef;
    blockedTunnelObject: RoomdefObjectRef;
    messHallBenchRoom25: RoomdefObjectRef;
    messHallBenchRoom23: RoomdefObjectRef;
    heroBench: RoomdefObjectRef;
  };
};

export interface RoomdefObjectRef {
  readonly addr: string;
  readonly roomdef: string;
  readonly labels: readonly string[];
  readonly objectIndex: number;
}

export interface RoomdefBoundRef {
  readonly addr: string;
  readonly roomdef: string;
  readonly labels: readonly string[];
  readonly boundIndex: number;
  readonly field: 'x0' | 'x1' | 'y0' | 'y1';
}

/** item_RED_CROSS_PARCEL: itemstruct 12, poked at $771D. */
export const ITEM_RED_CROSS_PARCEL = 12;
/** ROOM_NONE, as the masked room value ($A22D CP $3F). */
export const ROOM_NONE = 0x3f;
/** messages_red_cross_parcel ($A254 LD B,$09). */
export const MESSAGE_RED_CROSS_PARCEL = 0x09;

/** red_cross_parcel_contents_list ($A25F): purse, wiresnips, bribe, compass. */
export const parcelContentsList: readonly number[] = items.redCrossParcelContents.values;
/** red_cross_parcel_reset_data ($A259): {room, x, y, height, isoX, isoY}. */
export const parcelResetData: readonly number[] = items.redCrossParcelReset.values;

export interface ParcelState {
  /** red_cross_parcel_current_contents ($A263). Starts as item_NONE. */
  contents: number;
}

export function createParcels(): ParcelState {
  return { contents: 0xff }; // $A263 DEFB $FF
}

/**
 * event_new_red_cross_parcel ($A228).
 *
 * Refuses while the last parcel is still in the world ($A22F), then walks the
 * four-item contents list and takes the first item that is NOWHERE -- not the
 * first item the hero has not got, but the first whose itemstruct room is
 * ROOM_NONE. An item lying on the ground counts as existing, so the parcel
 * quietly stops arriving once all four are out.
 *
 * @returns the chosen contents, or -1 if no parcel could be spawned.
 */
export function eventNewRedCrossParcel(
  s: ItemState,
  parcels: ParcelState,
  queueMessage: (index: number, c?: number) => void,
): number {
  const parcelRoom = s.structs[ITEM_RED_CROSS_PARCEL * ITEMSTRUCT_STRIDE + OFF_ROOM]!;
  if ((parcelRoom & ROOM_MASK) !== ROOM_NONE) return -1; // $A22F

  for (const item of parcelContentsList) { // $A233 LD B,$04
    const room = s.structs[item * ITEMSTRUCT_STRIDE + OFF_ROOM]!;
    if ((room & ROOM_MASK) !== ROOM_NONE) continue; // $A23F
    parcels.contents = item; // $A246

    // $A252 LDIR: six bytes over the parcel's itemstruct, starting at its ROOM
    // field ($771D), so item_and_flags is deliberately left alone.
    const o = ITEM_RED_CROSS_PARCEL * ITEMSTRUCT_STRIDE + items.redCrossParcelReset.targetOffset;
    for (let i = 0; i < parcelResetData.length; i++) s.structs[o + i] = parcelResetData[i]!;

    queueMessage(MESSAGE_RED_CROSS_PARCEL); // $A256
    return item;
  }
  return -1; // $A244, a parcel could not be spawned
}

/** interiorobject_EMPTY_BED ($A2C1 LD A,$09). */
export const INTERIOR_OBJECT_EMPTY_BED = 9;

/** The six prisoner beds ($6B79), resolved to roomdef object references. */
export const bedObjects: readonly RoomdefObjectRef[] = geography.beds.objects;
/** The hero's own bed, poked separately at $A2CF. */
export const heroBedObject: RoomdefObjectRef = geography.roomPokes.heroBed;
/** The two writes action_shovel makes ($B404 / $B408). */
export const blockedTunnelBoundary: RoomdefBoundRef = geography.roomPokes.blockedTunnelBoundary;
export const blockedTunnelObject: RoomdefObjectRef = geography.roomPokes.blockedTunnelObject;

/**
 * The iteration count `wake_up` codes for the beds loop ($A2C6 LD B,$07).
 *
 * DIVERGED. There are only six entries in `beds`, and the seventh iteration
 * reads a pointer from past the end and writes through it -- the disassembly
 * names the destination: "a spurious write to ROM location $1A42".
 * BUILD_PROMPT.md §9 excludes ROM writes explicitly, so {@link BED_COUNT} is
 * six. Both numbers are kept so the divergence stays visible in the source.
 */
export const BED_COUNT_AS_CODED = 7;
export const BED_COUNT = 6;

/**
 * A mutable overlay over the roomdef tables, for the addresses the game pokes.
 *
 * Keyed by "roomdef:index" rather than by address, because the engine works in
 * parsed roomdefs; the addresses stay in the data as provenance.
 */
export interface RoomPokeState {
  objects: Map<string, number>;
  bounds: Map<string, number>;
}

export function createRoomPokes(): RoomPokeState {
  return { objects: new Map(), bounds: new Map() };
}

function objectKey(ref: RoomdefObjectRef): string {
  return `${ref.roomdef}:${ref.objectIndex}`;
}

function boundKey(ref: RoomdefBoundRef): string {
  return `${ref.roomdef}:${ref.boundIndex}:${ref.field}`;
}

export function pokeObject(s: RoomPokeState, ref: RoomdefObjectRef, value: number): void {
  s.objects.set(objectKey(ref), value & 0xff);
}

export function pokedObject(s: RoomPokeState, ref: RoomdefObjectRef): number | undefined {
  return s.objects.get(objectKey(ref));
}

/**
 * The same lookup keyed by roomdef ADDRESS and object index.
 *
 * The renderer walks a roomdef's object list by position and has no
 * RoomdefObjectRef to hand, so it needs this shape. Both go through the same
 * key, so a poke made through one is visible through the other.
 */
export function pokedObjectIn(
  s: RoomPokeState,
  roomdefAddr: string,
  objectIndex: number,
): number | undefined {
  return s.objects.get(`${roomdefAddr}:${objectIndex}`);
}

export function pokeBound(s: RoomPokeState, ref: RoomdefBoundRef, value: number): void {
  s.bounds.set(boundKey(ref), value & 0xff);
}

export function pokedBound(s: RoomPokeState, ref: RoomdefBoundRef): number | undefined {
  return s.bounds.get(boundKey(ref));
}

/**
 * The bed-emptying half of wake_up ($A2C1..$A2D2).
 *
 * Six beds plus the hero's, all set to interiorobject_EMPTY_BED. The hero's
 * bed is a separate write because it is not in the `beds` array -- roomdef 2 is
 * hut 2 LEFT, where he sleeps alone.
 */
export function emptyAllBeds(s: RoomPokeState): void {
  for (let i = 0; i < BED_COUNT; i++) { // $A2C6, six not seven
    pokeObject(s, bedObjects[i]!, INTERIOR_OBJECT_EMPTY_BED);
  }
  pokeObject(s, heroBedObject, INTERIOR_OBJECT_EMPTY_BED); // $A2D2
}

/**
 * action_shovel's two pokes ($B402..$B408).
 *
 * The boundary's x0 becomes 255 so `x < bounds->x0` can never pass, which
 * deletes the wall rather than moving it; the object becomes 0, which is the
 * transparent tile, removing the rubble.
 */
export function clearTunnelBlockage(s: RoomPokeState): void {
  pokeBound(s, blockedTunnelBoundary, 0xff); // $B404
  pokeObject(s, blockedTunnelObject, 0); // $B408
}

export function isTunnelBlockageCleared(s: RoomPokeState): boolean {
  return pokedBound(s, blockedTunnelBoundary) === 0xff; // $B3FF
}

/** interiorobject_PRISONER_SAT_MID_TABLE ($A437 LD (HL),$05). */
export const INTERIOR_OBJECT_PRISONER_SAT = 5;
/** interiorobject_OCCUPIED_BED ($A453 LD A,$17). */
export const INTERIOR_OBJECT_OCCUPIED_BED = 0x17;
/** room_NONE, written to the room field when a character vanishes ($A470). */
export const ROOM_NONE_BYTE = 0xff;

/** The first of three consecutive bench objects in each mess hall ($A424/$A42B). */
export const messHallBenchRoom25: RoomdefObjectRef = geography.roomPokes.messHallBenchRoom25;
export const messHallBenchRoom23: RoomdefObjectRef = geography.roomPokes.messHallBenchRoom23;
/** The hero's own bench, poked separately ($9E52 / $A47F). */
export const heroBench: RoomdefObjectRef = geography.roomPokes.heroBench;

/** routeindex_18 is the first seated prisoner ($A422 SUB $12). */
export const FIRST_SIT_ROUTE = 18;
/** routeindex_7 is the first sleeping prisoner ($A445 SUB $07). */
export const FIRST_SLEEP_ROUTE = 7;

/**
 * character_sits ($A420): which bench object a seated route index pokes.
 *
 * Routes 18..20 take the first three objects from room 25's bench_D; routes
 * 21 and up take them from room 23's bench_A, after a second subtraction
 * ($A42E). The pointer advances by THREE bytes per index -- one object record
 * -- which is why these resolve as an objectIndex plus an offset rather than
 * as three separate addresses.
 *
 * The room is decided from the UNBIASED route index ($A43C CP $15): below 21
 * it is room 25, otherwise room 23.
 */
export function seatForSitRoute(routeIndex: number): { object: RoomdefObjectRef; room: number } {
  const biased = routeIndex - FIRST_SIT_ROUTE; // $A422
  const base = biased < 3 ? messHallBenchRoom25 : messHallBenchRoom23; // $A427
  const n = biased < 3 ? biased : biased - 3; // $A42E
  return {
    object: { ...base, objectIndex: base.objectIndex + n }, // $A436
    room: routeIndex < 21 ? 25 : 23, // $A43C
  };
}

/**
 * character_sleeps ($A444): which bed object a sleeping route index pokes.
 *
 * Route indices 7..12 map onto beds 0..5. The room comes from the route index
 * again ($A457 CP $0A): below 10 it is hut 2 right, otherwise hut 3 right.
 */
export function bedForSleepRoute(routeIndex: number): { object: RoomdefObjectRef; room: number } {
  const n = routeIndex - FIRST_SLEEP_ROUTE; // $A445
  return {
    object: bedObjects[n] ?? bedObjects[0]!,
    room: routeIndex < 10 ? 3 : 5, // $A457
  };
}

/**
 * character_sit_sleep_common ($A462).
 *
 * Three writes, and the FIRST is the one that matters most:
 *
 *  1. `LD (HL),$00` ($A463) sets the character's route index to HALT. Without
 *     it the character keeps a route whose step is already sitting on the
 *     terminator; the next target_reached steps PAST it, and because routes
 *     are packed it starts walking the next route's waypoints. Six prisoners
 *     doing that at once is what a jammed mess hall looks like.
 *  2. the room becomes room_NONE ($A470 / $A477), which is how the character
 *     disappears into the furniture rather than standing on top of it.
 *  3. the bench or bed object is poked so the graphic shows them seated.
 *
 * The disassembly notes the route pointer "is within either a characterstruct
 * or a vischar", so this is deliberately written against whichever one the
 * caller holds.
 */
export function characterSitSleepCommon(
  pokes: RoomPokeState | undefined,
  target: { route: { index: number; step: number }; room: number },
  seat: { object: RoomdefObjectRef; room: number },
  objectValue: number,
): void {
  if (pokes) pokeObject(pokes, seat.object, objectValue); // $A437
  target.route.index = 0; // $A463, routeindex_0_HALT
  target.route.step = 0;
  target.room = ROOM_NONE_BYTE; // $A470 / $A477
}

/** character_sits ($A420), applied to a vischar or a character struct. */
export function characterSits(
  pokes: RoomPokeState | undefined,
  target: { route: { index: number; step: number }; room: number },
  routeIndex: number,
): void {
  characterSitSleepCommon(pokes, target, seatForSitRoute(routeIndex), INTERIOR_OBJECT_PRISONER_SAT);
}

/** character_sleeps ($A444). */
export function characterSleeps(
  pokes: RoomPokeState | undefined,
  target: { route: { index: number; step: number }; room: number },
  routeIndex: number,
): void {
  characterSitSleepCommon(pokes, target, bedForSleepRoute(routeIndex), INTERIOR_OBJECT_OCCUPIED_BED);
}

/** interiorobject_PRISONER_SAT_DOWN_END_TABLE ($A482 LD (HL),$13). */
export const INTERIOR_OBJECT_PRISONER_SAT_END = 0x13;
/** interiorobject_EMPTY_BENCH ($9E55 / $A31A LD A,$0D). */
export const INTERIOR_OBJECT_EMPTY_BENCH = 0x0d;

/**
 * All seven bench objects, in the order end_of_breakfast clears them ($A31C).
 *
 * Six seat prisoners; the seventh, bench_G, is the hero's, and it is poked by
 * a DIFFERENT routine with a DIFFERENT object -- $13 rather than $05, because
 * he sits at the end of the table rather than in the middle. Two routines,
 * two graphics, one shared list only at clear-down time.
 */
export const allBenchObjects: readonly RoomdefObjectRef[] = [
  ...[0, 1, 2].map((n) => ({
    ...messHallBenchRoom23,
    objectIndex: messHallBenchRoom23.objectIndex + n,
  })),
  ...[0, 1, 2].map((n) => ({
    ...messHallBenchRoom25,
    objectIndex: messHallBenchRoom25.objectIndex + n,
  })),
  heroBench,
];

/**
 * hero_sits ($A47F): the hero's own seat graphic.
 *
 * Separate from character_sits because the hero sits at the END of the table.
 * The rest of hero_sits -- the flag, the halt, the zeroed position -- lives in
 * `schedule.ts`, which owns his state; this is only the poke.
 */
export function heroSitsPoke(pokes: RoomPokeState | undefined): void {
  if (pokes) pokeObject(pokes, heroBench, INTERIOR_OBJECT_PRISONER_SAT_END); // $A482
}

/** hero_sleeps ($A489): the hero's bed becomes occupied. */
export function heroSleepsPoke(pokes: RoomPokeState | undefined): void {
  if (pokes) pokeObject(pokes, heroBedObject, INTERIOR_OBJECT_OCCUPIED_BED); // $A48C
}

/** The hero standing up from breakfast ($9E52): his bench empties again. */
export function heroLeavesBenchPoke(pokes: RoomPokeState | undefined): void {
  if (pokes) pokeObject(pokes, heroBench, INTERIOR_OBJECT_EMPTY_BENCH); // $9E55
}

/** The hero getting out of bed on a keypress ($9E75). */
export function heroLeavesBedPoke(pokes: RoomPokeState | undefined): void {
  if (pokes) pokeObject(pokes, heroBedObject, INTERIOR_OBJECT_EMPTY_BED); // $9E78
}

/**
 * end_of_breakfast ($A31A..$A32E): every bench empties, all seven of them.
 *
 * Including the hero's, which is why this is one list rather than the
 * per-character pokes reversed.
 */
export function clearAllBenches(pokes: RoomPokeState | undefined): void {
  if (!pokes) return;
  for (const bench of allBenchObjects) {
    pokeObject(pokes, bench, INTERIOR_OBJECT_EMPTY_BENCH);
  }
}
