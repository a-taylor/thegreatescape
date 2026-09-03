/**
 * A pair of hands for the walkthrough.
 *
 * `tests/harness/loop.ts` is the game; this is the player. Nothing here models
 * anything in the disassembly -- it presses the same five keys a person would,
 * and every decision it makes is one a person makes by looking at the screen.
 * It is test scaffolding, and it must stay that way: if a rule about how the
 * game behaves ends up in this file, it is in the wrong file.
 *
 * Two things about it are worth knowing before using it.
 *
 * **The four screen directions are the four world diagonals.** Measured, not
 * assumed: from a standing start, input 1 raises `pos.x`, 2 lowers it, 6 raises
 * `pos.y` and 3 lowers it. So "walk toward a target" is a choice of axis, not
 * of compass point, and the hero turns on the spot the first time he is asked
 * for a direction he is not already facing.
 *
 * **He is blocked far more often than he moves.** Inside a hut, four out of
 * five ticks are refused by `bounds_check` ($B1AF) -- furniture, walls, the bed
 * he just got out of. A navigator that only pushes toward the target presses
 * into a wall forever, which is precisely the bug CLAUDE.md records the hero
 * having had. So this one counts consecutive refusals and swaps axis, which is
 * the same wall-slide the game's own `Y_DOMINANT` alternation performs.
 */

import { halfDoor, resolveDoor } from '../../src/game/doors.js';
import { heroMapPosition } from '../../src/game/coords.js';
import { ITEM_NONE } from '../../src/game/inventory.js';
import { tickGame, type GameState, type TickResult } from './loop.js';
import { corners, findPath } from './path.js';

/** The four movement inputs, by the axis each one drives. */
export const X_PLUS = 1;
export const X_MINUS = 2;
export const Y_MINUS = 3;
export const Y_PLUS = 6;

/** process_player_input_fire's four commands ($7AC9/$7AD3/$7ADD/$7AE7). */
export const PICK_UP = 0x0a;
export const DROP = 0x0b;
export const USE_A = 0x0c;
export const USE_B = 0x0f;

export interface Journey {
  arrived: boolean;
  ticks: number;
  /** Set when the walk ended because the hero changed room. */
  enteredRoom: number | null;
  /** Where he actually ended up, in the space the walk was measured in. */
  at: { x: number; y: number };
}

export interface WalkOptions {
  /** Give up after this many ticks. */
  maxTicks?: number;
  /** How close counts as arrived, in the walk's own units. */
  tolerance?: number;
  /** Stop the moment the hero changes room, rather than walking on. */
  stopOnRoomChange?: boolean;
  /** Called after every tick, for a caller that needs to watch something. */
  onTick?: (r: TickResult) => void;
}

/**
 * Walk until `at()` reaches (tx, ty).
 *
 * The space is the caller's choice, because the game has several and the right
 * one depends on the goal. Walking to a DOOR is measured in the hero's own
 * position; walking to an ITEM has to be measured in `hero_map_position`
 * ($81B8), because that is what `find_nearby_item` compares against and it
 * ROUNDS -- `pos >> 3` lands the hero a whole tinypos unit off the item and the
 * radius-1 test outside then fails on a hero standing on top of it.
 */
export function walkUntil(
  g: GameState,
  at: () => { x: number; y: number },
  tx: number,
  ty: number,
  opts: WalkOptions = {},
): Journey {
  const maxTicks = opts.maxTicks ?? 2000;
  const tolerance = opts.tolerance ?? 0;
  let blockedRun = 0;
  let flip = false;

  for (let i = 0; i < maxTicks; i++) {
    const p = at();
    const dx = tx - p.x;
    const dy = ty - p.y;
    if (Math.abs(dx) <= tolerance && Math.abs(dy) <= tolerance) {
      return { arrived: true, ticks: i, enteredRoom: null, at: { x: p.x, y: p.y } };
    }

    // Drive the axis with further to go, unless the last few pushes were
    // refused -- then try the other one, which is how he gets round furniture.
    let useX = Math.abs(dx) >= Math.abs(dy);
    if (Math.abs(dx) <= tolerance) useX = false;
    if (Math.abs(dy) <= tolerance) useX = true;
    if (flip) useX = !useX;

    const input = useX ? (dx > 0 ? X_PLUS : X_MINUS) : dy > 0 ? Y_PLUS : Y_MINUS;
    const r = tickGame(g, input);
    opts.onTick?.(r);

    if (r.enteredRoom !== null && opts.stopOnRoomChange !== false) {
      const q = at();
      return { arrived: false, ticks: i + 1, enteredRoom: r.enteredRoom, at: { x: q.x, y: q.y } };
    }

    blockedRun = r.blocked ? blockedRun + 1 : 0;
    if (blockedRun > 6) {
      flip = !flip;
      blockedRun = 0;
    }
  }

  const p = at();
  return { arrived: false, ticks: maxTicks, enteredRoom: null, at: { x: p.x, y: p.y } };
}

/** Walk to a position in the hero's own coordinates -- doors, mostly. */
export function walkTo(g: GameState, tx: number, ty: number, opts: WalkOptions = {}): Journey {
  return walkUntil(g, () => g.hero.pos, tx, ty, opts);
}

/**
 * Walk until `hero_map_position` ($81B8) is on the given tinypos.
 *
 * This is the one to use before a pick-up. See walkUntil's note on why
 * `pos >> 3` is not the same thing.
 */
export function walkToMapPos(
  g: GameState,
  tx: number,
  ty: number,
  opts: WalkOptions = {},
): Journey {
  return walkUntil(
    g,
    () => heroMapPosition(g.hero.pos, g.hero.room === 0),
    tx,
    ty,
    opts,
  );
}

/**
 * Walk into one of the doors `interiorDoorsForRoom` lists, until it opens.
 *
 * The index is the one the room's list holds, which is deliberately the OTHER
 * half of the pair ($6A00 writes `C XOR $80`) -- so it has to go through
 * `resolveDoor` before its position means anything.
 */
export function walkThroughDoor(
  g: GameState,
  doorIndex: number,
  opts: WalkOptions = {},
): Journey {
  const door = halfDoor(resolveDoor(doorIndex));
  return walkTo(g, door.pos.x, door.pos.y, { maxTicks: 600, ...opts });
}

/** Stand still for a while -- the walkthrough's "wait a few seconds". */
export function idle(g: GameState, ticks: number, onTick?: (r: TickResult) => void): void {
  for (let i = 0; i < ticks; i++) onTick?.(tickGame(g, 0));
}

/** Space + up ($7AC9). Returns the item index taken, or -1. */
export function pickUp(g: GameState): number {
  return tickGame(g, PICK_UP).command?.item ?? -1;
}

/** Space + down ($7AD3). */
export function drop(g: GameState): number {
  return tickGame(g, DROP).command?.item ?? -1;
}

/** Space + left / right ($7ADD / $7AE7): use the first or second held item. */
export function useSlot(g: GameState, slot: 0 | 1): number {
  return tickGame(g, slot === 0 ? USE_A : USE_B).command?.item ?? -1;
}

/** Use whichever slot holds `item`, or -1 if he is not carrying it. */
export function useItem(g: GameState, item: number): number {
  if (g.items.held[0] === item) return useSlot(g, 0);
  if (g.items.held[1] === item) return useSlot(g, 1);
  return -1;
}

/**
 * Walk the whole way to an outdoor position, routing round the camp.
 *
 * `walkTo` on its own presses into the first fence between here and there.
 * This finds a route with `findPath` over the game's own wall test and walks
 * its corners in turn, which is what a person does by looking at the map.
 *
 * Stops early and reports it if the hero changes room -- walking into a door
 * on the way is a real outcome, not an error.
 */
export function travelTo(
  g: GameState,
  tx: number,
  ty: number,
  opts: WalkOptions & { legTicks?: number } = {},
): Journey {
  const route = findPath(g.hero.pos, { x: tx, y: ty }, g.hero.pos.height);
  if (!route) {
    return { arrived: false, ticks: 0, enteredRoom: null, at: { ...g.hero.pos } };
  }

  let ticks = 0;
  // The BFS grid is snapped to the stride, so the hero can land a unit or two
  // off a waypoint and still be exactly where it meant.
  for (const wp of corners(route)) {
    const j = walkTo(g, wp.x, wp.y, {
      ...opts,
      tolerance: opts.tolerance ?? 2,
      maxTicks: opts.legTicks ?? 400,
    });
    ticks += j.ticks;
    if (j.enteredRoom !== null) return { ...j, ticks };
  }

  const dx = Math.abs(g.hero.pos.x - tx);
  const dy = Math.abs(g.hero.pos.y - ty);
  return {
    arrived: dx <= (opts.tolerance ?? 2) && dy <= (opts.tolerance ?? 2),
    ticks,
    enteredRoom: null,
    at: { x: g.hero.pos.x, y: g.hero.pos.y },
  };
}

export function isHolding(g: GameState, item: number): boolean {
  return g.items.held[0] === item || g.items.held[1] === item;
}

export function handsFull(g: GameState): boolean {
  return g.items.held[0] !== ITEM_NONE && g.items.held[1] !== ITEM_NONE;
}
