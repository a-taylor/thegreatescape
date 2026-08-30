/**
 * in_permitted_area (c$9F21): is the hero somewhere he is allowed to be?
 *
 * Runs once per main-loop iteration and does four jobs at once, which is why
 * it is the spine of P6 rather than a predicate:
 *
 *  1. maintains hero_map_position ($81B8) from his vischar position;
 *  2. detects the hero walking off the edge of the map, which is the escape;
 *  3. decides the morale flag's colour and sets red_flag ($A138), which is
 *     what the guards read to decide whether to chase him;
 *  4. can PUT HIM BACK ON ROUTE ($9FD5) -- if he is somewhere his current
 *     route does not permit but which appears later in the same list, the
 *     route step is advanced to match rather than the flag going red.
 *
 * Whether the flag is red is not cosmetic: guards_follow_suspicious_character
 * keys off it, so getting this wrong makes the camp either blind or
 * permanently hostile.
 */

import geographyJson from '../../data/geography.json';
import { heroMapPosition } from './coords.js';
import type { Pos, TinyPos } from './math.js';
import type { Vischar } from './vischar.js';

const geography = geographyJson as unknown as {
  permittedBounds: { entries: Array<{ x0: number; x1: number; y0: number; y1: number }> };
  routeToPermitted: { entries: Array<{ route: number; places: number[] }> };
};

/** permitted_bounds ($9F15): three areas of {x0, x1, y0, y1} in tinypos. */
export const permittedBounds = geography.permittedBounds.entries;
/** route_to_permitted ($9EE4): seven routes, each with a list of places. */
export const routeToPermitted = geography.routeToPermitted.entries;

/** A place with bit 7 set is a room index, not an area index ($A00A). */
export const PLACE_IS_ROOM = 0x80;
export const PLACE_MASK = 0x7f;

/** attribute_BRIGHT_GREEN_OVER_BLACK / _RED_ ($9FDF / $9FF8). */
export const FLAG_GREEN = 0x44;
export const FLAG_RED = 0x42;

/** vischar_FLAGS_PICKING_LOCK | _CUTTING_WIRE ($9F54 AND $03). */
export const FLAGS_PICKING_OR_CUTTING = 0x03;

/** Night falls at clock 100 ($9F5C CP $64). */
export const NIGHT_CLOCK = 100;
/** room_2_HUT2LEFT, the only safe room at night ($9F63 CP $02). */
export const HOME_ROOM = 2;

/**
 * The escape edges ($9F34 / $9F3F): iso_pos.x >= 217*8 or iso_pos.y >= 137*8.
 *
 * ASSUMPTION: both comparisons are `SBC HL,DE` with no preceding `AND A`, so
 * they inherit whatever carry pos_to_tinypos left. For every position the
 * routine actually sees the carry is clear and this is a plain unsigned
 * compare; modelled as one, on the same reading as $DC13 in the draw order.
 */
export const ESCAPE_ISO_X = 217 * 8;
export const ESCAPE_ISO_Y = 137 * 8;

export interface PermittedState {
  /** red_flag ($A138): $FF when the hero is somewhere he should not be. */
  redFlag: boolean;
  /** The morale flag's current attribute, as read back from $5842. */
  flagAttribute: number;
}

export function createPermitted(): PermittedState {
  // reset_game paints the flag green before the game starts ($F16A).
  return { redFlag: false, flagAttribute: FLAG_GREEN };
}

export interface PermittedContext {
  /** The global current room index ($68A0). */
  readonly room: number;
  /** The game clock ($A13D). */
  readonly clock: number;
  /** in_solitary ($A13A). */
  readonly inSolitary: boolean;
  /** The hero's vischar: flags, route, input and iso_pos are all read. */
  readonly hero: Vischar;
  /** Where to write hero_map_position ($81B8). */
  readonly mapPosition: TinyPos;
  /** set_hero_route ($A33F), for the put-him-back-on-route case. */
  setHeroRoute(index: number, step: number): void;
  /** $A51C: he has walked off the map. */
  onEscaped(): void;
  /** $9FF1: reaching a green flag silences the bell. */
  silenceBell(): void;
}

/**
 * in_permitted_area_end_bit ($A007) + within_camp_bounds ($A01A).
 *
 * A place is either a room ("are you in it?") or an area index. An area only
 * means anything OUTDOORS: indoors the routine returns NZ immediately ($A015),
 * so an indoor hero fails every area test and passes only room tests.
 */
export function inPlace(place: number, room: number, pos: TinyPos): boolean {
  if (place & PLACE_IS_ROOM) return (place & PLACE_MASK) === room; // $A010
  if (room !== 0) return false; // $A015, areas are outdoors only
  return withinCampBounds(place, pos);
}

/** within_camp_bounds ($A01A): `x0 <= x < x1 && y0 <= y < y1`. */
export function withinCampBounds(area: number, pos: TinyPos): boolean {
  const b = permittedBounds[area];
  if (!b) return false;
  // $A026 `CP (HL) / RET C` then `CP (HL) / JR C` -- inclusive lower bound,
  // exclusive upper, on both axes.
  if (pos.x < b.x0 || pos.x >= b.x1) return false;
  if (pos.y < b.y0 || pos.y >= b.y1) return false;
  return true;
}

/**
 * in_permitted_area ($9F21).
 *
 * @returns whether the flag ended up red.
 */
export function inPermittedArea(s: PermittedState, ctx: PermittedContext): boolean {
  const { hero } = ctx;

  // $9F27: maintain hero_map_position, scaled outdoors and copied indoors.
  const outdoors = ctx.room === 0;
  const mapped = heroMapPosition(hero.pos as Pos, outdoors);
  ctx.mapPosition.x = mapped.x;
  ctx.mapPosition.y = mapped.y;
  ctx.mapPosition.height = mapped.height;

  if (outdoors) {
    // $9F31: off the edge of the map is the escape. Only possible outdoors.
    if (hero.isoPos.x >= ESCAPE_ISO_X || hero.isoPos.y >= ESCAPE_ISO_Y) {
      ctx.onEscaped();
      return s.redFlag;
    }
  }

  // $9F54: picking a lock or cutting wire is suspicious in itself.
  if ((hero.flags & FLAGS_PICKING_OR_CUTTING) !== 0) return setRed(s, ctx);

  // $9F5C: after clock 100 the only safe place is his own hut.
  if (ctx.clock >= NIGHT_CLOCK) {
    return ctx.room === HOME_ROOM ? setGreen(s, ctx) : setRed(s, ctx);
  }

  // $9F6F: solitary bypasses every check -- he is where they put him.
  if (ctx.inSolitary) return setGreen(s, ctx);

  const routeIndex = hero.route.index;
  // $9F78: a reversed route is one step further along than it reads.
  let step = hero.route.step;
  if (routeIndex & 0x80) step = (step + 1) & 0xff;

  // $9F7D: wandering characters get an area from the step's block instead of
  // a route list -- block 8 is the huts, anything else the exercise yard.
  if (routeIndex === 0xff) {
    const area = (hero.route.step & 0xf8) === 0x08 ? 1 : 2; // $9F84
    return inPlace(area, ctx.room, ctx.mapPosition) ? setGreen(s, ctx) : setRed(s, ctx);
  }

  // $9F93: find the route's permitted list. Absent means unrestricted.
  const entry = routeToPermitted.find((e) => e.route === (routeIndex & 0x7f));
  if (!entry) return setGreen(s, ctx); // $9FA2

  // $9FAB: the place this step is supposed to be at.
  const here = entry.places[step];
  if (here !== undefined && inPlace(here, ctx.room, ctx.mapPosition)) {
    return setGreen(s, ctx);
  }

  // $9FB4: he is not where the route says. Look for anywhere in the list he IS
  // allowed to be and MOVE THE ROUTE to match, rather than going red. A
  // reversed route starts the search one place in ($9FBB).
  const from = routeIndex & 0x80 ? 1 : 0;
  for (let i = 0; ; i++) {
    const place = entry.places[from + i];
    if (place === undefined) return setRed(s, ctx); // $9FC5, hit the $FF
    if (inPlace(place, ctx.room, ctx.mapPosition)) {
      // $9FD1: set_hero_route with the ORIGINAL index (reverse flag included)
      // and the index we matched at.
      ctx.setHeroRoute(routeIndex, i);
      return setGreen(s, ctx);
    }
  }
}

/**
 * ipa_set_flag_green ($9FDE) and ipa_flag_select ($9FE1).
 *
 * red_flag is written BEFORE the "is it already that colour" early return, so
 * green always records itself even when nothing repaints.
 */
function setGreen(s: PermittedState, ctx: PermittedContext): boolean {
  s.redFlag = false; // $9FE1
  if (s.flagAttribute === FLAG_GREEN) return false; // $9FE9
  s.flagAttribute = FLAG_GREEN;
  ctx.silenceBell(); // $9FF1, only on the transition TO green
  return false;
}

/**
 * ipa_set_flag_red ($9FF8).
 *
 * NOT the mirror of setGreen. The early return happens FIRST, so a flag that
 * is already red leaves red_flag untouched and does not re-clear the hero's
 * input; and the input clear ($A000) happens only on the transition, which is
 * what stops the player being frozen for as long as he is out of bounds.
 */
function setRed(s: PermittedState, ctx: PermittedContext): boolean {
  if (s.flagAttribute === FLAG_RED) return s.redFlag; // $9FFE
  ctx.hero.input = 0; // $A000
  s.redFlag = true; // $9FE1 with A = $FF
  s.flagAttribute = FLAG_RED;
  return true;
}
