/**
 * Routes: where a character is trying to get to.
 *
 * A route is (index, step). The index selects one of 46 byte-strings from the
 * table at $7738; the step indexes into it. Each byte names a waypoint:
 *
 *   0..39     a door index -- head for that door and go through it
 *   40..117   a location index, offset by 40 -- head for locations[byte - 40]
 *   255       routebyte_END: the route is over
 *
 * Bit 7 of the *index* is route_REVERSED, which walks the string backwards. Bit
 * 7 of a *door byte* is the door's own reverse flag, and get_target XORs the
 * two together ($C686) so a reversed route also goes through its doors the
 * other way.
 *
 * Route index 255 is not a route at all but routeindex_255_WANDER: pick one of
 * eight locations starting at route.step.
 */

import routesJson from '../../data/routes.json';
import geographyJson from '../../data/geography.json';

import { decodeBase64 } from '../data/load.js';
import { resolveDoor, halfDoors, type HalfDoor } from './doors.js';

/** routeindex_0_HALT: stand still. */
export const ROUTE_HALT = 0;
/** routeindex_255_WANDER ($C652). */
export const ROUTE_WANDER = 0xff;
/** routeindexflag_REVERSED ($C6E5). */
export const ROUTE_REVERSED = 0x80;
/** routebyte_END ($C676). */
export const ROUTE_BYTE_END = 0xff;
/** Route bytes below this are door indices ($C67D CP $28). */
export const FIRST_LOCATION_BYTE = 40;

interface RoutePointer {
  readonly index: number;
  readonly addr: string;
  readonly offset: number | null;
}

const routesData = routesJson as unknown as {
  _addr: string;
  data: string;
  pointerCount: number;
  pointers: RoutePointer[];
};

const geography = geographyJson as unknown as {
  locations: { values: number[] };
};

let blob: Uint8Array | undefined;
function routeBytes(): Uint8Array {
  return (blob ??= decodeBase64(routesData.data));
}

export const routePointers: readonly RoutePointer[] = routesData.pointers;
export const ROUTE_COUNT = routesData.pointerCount;

/**
 * locations ($783A): 78 xy_t pairs, x in the low byte.
 *
 * Two bytes each, which is why get_target doubles the index before adding
 * ($C692). These are tinypos-scale coordinates with no height.
 */
export const locations: ReadonlyArray<{ x: number; y: number }> =
  geography.locations.values.map((w) => ({ x: w & 0xff, y: (w >> 8) & 0xff }));

export interface Route {
  index: number;
  step: number;
}

/** get_route ($CB79): route index to a byte offset. Bit 7 is discarded. */
export function getRoute(index: number): number | null {
  // $CB79 ADD A,A doubles the index, dropping bit 7 off the top in the same
  // instruction -- so a reversed route resolves to the same byte string.
  const p = routePointers[index & 0x7f];
  return p ? p.offset : null;
}

export type Target =
  | { readonly kind: 'location'; readonly index: number; readonly pos: { x: number; y: number } }
  | { readonly kind: 'door'; readonly index: number; readonly door: HalfDoor }
  | { readonly kind: 'ended' };

/**
 * The value read when route.index is 0 ($C667).
 *
 * routes[0] is a null pointer, so the read comes from the Spectrum ROM at
 * $0001, which holds $AF (`XOR A`). The disassembly documents both the value
 * and how the game gets there: "the hero stands up during breakfast, is
 * pursued by guards, then when left to idle sits down and the pursuing guards
 * resume their original positions."
 *
 * $AF & $7F is 47, which is >= 40, so it reads as location 7. Reproduced with
 * the constant named rather than by modelling a 64K address space -- the value
 * is fixed and documented, and §9's prohibition is on ROM *writes*.
 */
export const NULL_ROUTE_ROM_BYTE = 0xaf;

/**
 * get_target (c$C651): the next waypoint for a route.
 *
 * @param route   the character's (index, step); WANDER mutates step in place
 * @param random  random_nibble ($CB85), injected so tests are deterministic
 */
export function getTarget(route: Route, random: () => number): Target {
  // routeindex_255_WANDER: "one of eight random locations starting from
  // route.step" ($C656..$C662).
  if (route.index === ROUTE_WANDER) {
    route.step = ((route.step & 0xf8) + (random() & 0x07)) & 0xff;
    // Note the asymmetry: the wander path uses route.step AS the location
    // index, where the normal path subtracts 40 first.
    return locationTarget(route.step);
  }

  const offset = getRoute(route.index);
  const bytes = routeBytes();

  // $C66A..$C672: the high byte is zero unless route.step is $FF, when it is
  // $FF too -- so a step of 255 reads the byte BEFORE the route. "Since all of
  // the routes are packed together, this relies on being able to fetch the
  // previous route's terminator."
  const delta = route.step === 0xff ? -1 : route.step;

  let byte: number;
  if (offset === null) {
    // The null-route case; see NULL_ROUTE_ROM_BYTE.
    byte = NULL_ROUTE_ROM_BYTE;
  } else {
    const at = offset + delta;
    if (at < 0 || at >= bytes.length) return { kind: 'ended' };
    byte = bytes[at]!;
  }

  if (byte === ROUTE_BYTE_END) return { kind: 'ended' }; // $C679

  // $C67B masks off bit 7 before the comparison, so a door byte with its
  // reverse flag set is still recognised as a door.
  if ((byte & 0x7f) < FIRST_LOCATION_BYTE) {
    // $C681 re-reads the byte to get the flag back, then XORs in the route's
    // own reversed flag ($C686), so both reversals compose.
    let doorByte = byte;
    if (route.index & ROUTE_REVERSED) doorByte ^= 0x80;
    const door = halfDoors[resolveDoor(doorByte)];
    if (!door) return { kind: 'ended' };
    return { kind: 'door', index: doorByte, door };
  }

  return locationTarget((byte - FIRST_LOCATION_BYTE) & 0xff); // $C690
}

/**
 * gt_pick_loc ($C692): index locations[] by the value in A.
 *
 * The doubling is 8-BIT (`ADD A,A`), so the index wraps at 128 before the
 * table is even reached. That is not a detail that can be skipped: the null
 * route delivers $AF here, which as a full-width subtraction would be entry
 * 135 and off the end of a 78-entry table, but wraps to entry 7 -- a real
 * location, which is what the game actually targets.
 *
 * `(a * 2 & 0xff) >> 1` is `a & 0x7f`.
 *
 * Entries 78..127 are inside the wrapped range but past the end of locations;
 * $C698's carry into H means the original reads whatever follows the table.
 * Not reproducible outside a flat 64K image, so those report route-ends.
 */
function locationTarget(a: number): Target {
  const index = a & 0x7f;
  const pos = locations[index];
  if (!pos) return { kind: 'ended' };
  return { kind: 'location', index, pos };
}

/**
 * Step a route forward, or backward when reversed ($C791..$C799).
 *
 * WANDER never advances -- it re-rolls instead, so $C790 returns early.
 */
export function advanceRoute(route: Route): void {
  if (route.index === ROUTE_WANDER) return; // $C790
  if (route.index & ROUTE_REVERSED) {
    route.step = (route.step - 1) & 0xff; // $C798
  } else {
    route.step = (route.step + 1) & 0xff; // $C796
  }
}

/**
 * Turn a route around when it runs out ($C6E4..$C6EF).
 *
 * The comment calls the step adjustment "Pattern: [-2]+1": going forward it is
 * a plain increment, but having just reversed direction it is decremented
 * twice and then incremented, i.e. a net -1. That lands on the waypoint before
 * the terminator rather than on the terminator itself, which would end the
 * route again immediately.
 */
export function reverseRoute(route: Route): void {
  route.index ^= ROUTE_REVERSED; // $C6E5
  if (route.index & ROUTE_REVERSED) {
    route.step = (route.step - 2) & 0xff; // $C6ED/$C6EE
  }
  route.step = (route.step + 1) & 0xff; // $C6EF
}
