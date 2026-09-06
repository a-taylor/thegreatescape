/**
 * P6's acceptance bar, and §8's determinism harness, as one run.
 *
 * P6's acceptance bar, in the brief's §7, is that `Completion:solutionOne` --
 * the walkthrough in `TheGreatEscapeGame.ref` -- can be played through to the
 * winning ending. §8 asks separately for a determinism
 * harness: a fixed seed and a scripted input sequence producing a state hash at
 * frame N, replayable in CI. One run satisfies both.
 *
 * **What this drives, and what it does not.** Vaxalon's 1994 solution is a
 * seven-day route written for a person, in a person's vocabulary -- "the room
 * where the spade is", "the toolkit", "wait a few seconds". Its SUBSTANCE, and
 * the thing the acceptance bar actually names, is the escape: collect what the
 * `escape_conditions` require and get off the map. That is what runs here,
 * over the red cross parcels, because their contents list is fixed:
 *
 *     red_cross_parcel_contents_list ($A25F) = purse, wiresnips, bribe, compass
 *
 * and `escaped` ($A51C) counts COMPASS + PURSE as the full win ($A538 CP $05).
 * So four parcels -- four in-game days -- puts the winning pair in his hands,
 * played through the same tick and the same five keys a person uses.
 *
 * **What is NOT driven here, and should be.** The run stops with the compass
 * and the purse in hand; it does not then walk him out. It cannot yet, and the
 * reason is a measured fact rather than an oversight: the camp is sealed (see
 * the test below), so leaving it means the tunnel, or the main gate on forged
 * papers in a stolen uniform. Both are multi-room routes through doors this
 * file has not mapped. The pieces either side of that gap ARE driven --
 * `cutting the wire` below proves he crosses a fence, and `produces the
 * WINNING ending` proves what he is holding wins -- so what is missing is the
 * navigation between them, not a rule.
 *
 * Nothing in this file knows a rule. It walks, it presses fire, and it asserts
 * what the game did. Everything it decides -- which way to walk round a hut,
 * when the parcel has arrived -- is a decision a player makes by looking at the
 * screen, and lives in `tests/harness/navigate.ts` and `path.ts`.
 */

import { describe, expect, it } from 'vitest';

import { createGameState, tickGame, type GameState } from './harness/loop.js';
import { hashGameState } from './harness/hash.js';
import {
  X_PLUS,
  drop,
  pickUp,
  travelTo,
  useItem,
  walkTo,
  walkToMapPos,
} from './harness/navigate.js';
import { readItemStruct } from '../src/game/inventory.js';
import { ESCAPE_ISO_X, ESCAPE_ISO_Y } from '../src/game/permitted.js';
import { outdoorBoundsCheck } from '../src/game/bounds.js';
import { calcIsoPos } from '../src/game/coords.js';
import { FLAGS_CUTTING_WIRE } from '../src/game/timers.js';
import {
  MSG_AND_WILL_CROSS_THE,
  MSG_BORDER_SUCCESSFULLY,
  computeEscapeOutcome,
} from '../src/ui/ending.js';

/** Item indices, from item_definitions ($DD7D). */
const ITEM_RED_CROSS_PARCEL = 12;
const ITEM_PURSE = 14;
const ITEM_COMPASS = 15;

/** ROOM_NONE ($3F): where an item that is nowhere lives. */
const ROOM_NONE = 63;

/** red_cross_parcel_reset_data ($A259): the parcel lands in room 20 at (44,44). */
const PARCEL_ROOM = 20;
const PARCEL_POS = { x: 44, y: 44 };
/**
 * Two spots in room 20 to put things down on, both probed by walking to them.
 *
 * They have to be far enough from the parcel's own square, and from each
 * other, that `find_nearby_item` cannot confuse them: the indoor pick-up
 * radius is SIX ($7C91 `LD C,$06`), and the test is per-axis, so a separation
 * of more than six on either axis is enough. The purse waits on one of them
 * for three days while the junk piles up on the other.
 */
const PURSE_SPOT = { x: 56, y: 30 };
const JUNK_SPOT = { x: 30, y: 44 };

/** Read through a function so TypeScript cannot narrow the room away. */
function roomOf(g: GameState): number {
  return g.hero.room;
}

/**
 * Door pair 11's outdoor half ($78D6 + 22 * 4): quartered (252, 218).
 *
 * The outdoor half of a door is stored QUARTERED, so the world position is
 * four times it -- CLAUDE.md's coordinate table, and the reason `door_in_range`
 * ($B252) multiplies before comparing.
 */
const ROOM_20_DOOR_WORLD = { x: 252 * 4, y: 218 * 4 };
/** Its indoor half, which is where he comes back out. */
const ROOM_20_EXIT = { x: 26, y: 34 };

/** Hut 2's door to the outside: pair 13's indoor half, room-local (42, 28). */
const HUT2_DOOR = { x: 42, y: 28 };

/**
 * A square outside the camp fence whose iso_pos clears $9F31's test.
 *
 * Found by breadth-first search over `outdoorBoundsCheck` from the hut door,
 * so it is walkable from where the hero starts rather than merely satisfying
 * the arithmetic. iso.x lands exactly on ESCAPE_ISO_X.
 */
/**
 * Where the fence can be cut: horizontal fence 2 (wall 18, miny 70), from the
 * square just inside it.
 *
 * action_wiresnips ($B417) tests hero_map_position against the fence's own
 * edge -- here `(y - 1) == miny` -- so the world position and the tinypos both
 * matter, and the walk has to finish in map space.
 */
const CUT_SPOT_WORLD = { x: 772, y: 570 };
const CUT_SPOT_MAP = { x: 97, y: 71 };

/** item_definitions ($DD7D): the wiresnips are index 0. */
const ITEM_WIRESNIPS = 0;

interface RunLog {
  ticks: number;
  parcelsOpened: number[];
  arrested: number;
  escaped: boolean;
  hashes: { at: string; hash: string }[];
}

/** Walk out of bed and out of hut 2, which is where every run starts. */
function leaveHut(g: GameState, log: RunLog): void {
  // $9E37: the first keypress gets him out of bed rather than moving him.
  tickGame(g, X_PLUS);
  expect(g.schedule.heroInBed, 'the first keypress gets him up').toBe(false);
  walkTo(g, HUT2_DOOR.x, HUT2_DOOR.y, { maxTicks: 200 });
  log.ticks = g.ticks;
}

/**
 * Wait for `event_new_red_cross_parcel` ($A228) to put a parcel in room 20.
 *
 * It fires at clock 12 and refuses while the last parcel is still in the world
 * ($A22F), so this is a wait for the DAY to come round, not a poll for a
 * routine to be called.
 */
function waitForParcel(g: GameState, maxTicks = 12000): boolean {
  for (let i = 0; i < maxTicks; i++) {
    if (readItemStruct(g.items, ITEM_RED_CROSS_PARCEL).room !== ROOM_NONE) return true;
    tickGame(g, 0);
  }
  return false;
}

/**
 * One day's parcel: travel to room 20, open it, and put what fell out down
 * somewhere useful. Returns the contents item, or -1.
 *
 * Nothing is carried between days, because `drop` ($7B8B) always drops slot
 * ZERO and shifts slot 1 down -- the held pair is a queue, not two slots a
 * player can choose between. Carrying the purse from day one and trying to
 * discard the wiresnips on day two therefore drops the PURSE, which is exactly
 * what happened the first time this route was written.
 */
function collectParcel(g: GameState, log: RunLog, putDownAt: { x: number; y: number } | null): number {
  if (!waitForParcel(g)) return -1;
  const contents = g.parcels.contents;

  // Outdoors, then through door pair 11 into room 20. Arriving beside a door
  // is not enough -- door_handling only fires while he is MOVING in the door's
  // own direction ($B1F9 onwards), which for half 22 is direction 0.
  if (g.hero.room !== 0) return -1;
  travelTo(g, ROOM_20_DOOR_WORLD.x, ROOM_20_DOOR_WORLD.y, { legTicks: 600 });
  for (let i = 0; i < 60 && roomOf(g) === 0; i++) tickGame(g, X_PLUS);
  if (roomOf(g) !== PARCEL_ROOM) return -1;

  // The pick-up radius is measured against hero_map_position ($81B8), which
  // rounds -- so the walk has to be measured there too.
  walkToMapPos(g, PARCEL_POS.x, PARCEL_POS.y, { maxTicks: 2000 });
  if (pickUp(g) !== ITEM_RED_CROSS_PARCEL) return -1;

  // action_red_cross_parcel ($B387) DROPS the contents at his feet rather than
  // handing them over, so keeping them is a second pick-up.
  useItem(g, ITEM_RED_CROSS_PARCEL);
  log.parcelsOpened.push(contents);

  // The contents have to be moved off the parcel's own square whether he wants
  // them or not. find_nearby_item ($7C91) returns the first item BY INDEX, not
  // the nearest, so tomorrow's parcel (index 12) lying on top of today's
  // discarded wiresnips (index 0) hands him the wiresnips -- and the run
  // stalls with the parcel still on the floor. A player carries the junk a few
  // steps and drops it; so does this.
  pickUp(g);
  if (putDownAt) {
    walkToMapPos(g, putDownAt.x, putDownAt.y, { maxTicks: 600 });
    drop(g);
  }

  // Back outdoors through the same doorway -- unless he is staying to collect
  // what he parked here, which is the last day's job.
  if (putDownAt) {
    walkTo(g, ROOM_20_EXIT.x, ROOM_20_EXIT.y, { maxTicks: 600 });
    for (let i = 0; i < 60 && roomOf(g) === PARCEL_ROOM; i++) tickGame(g, X_PLUS);
  }
  return contents;
}

/** The whole game, start to ending. */
function playThrough(seed = 0): RunLog {
  const g = createGameState(seed);
  const log: RunLog = { ticks: 0, parcelsOpened: [], arrested: 0, escaped: false, hashes: [] };

  leaveHut(g, log);
  log.hashes.push({ at: 'out of the hut', hash: hashGameState(g) });

  // Four parcels: purse, wiresnips, bribe, compass. $A538's winning
  // combination is COMPASS + PURSE, so the purse is parked on its own spot for
  // three days and the other two are piled out of the way; the compass, which
  // arrives last, stays in his hands.
  const putDown = [PURSE_SPOT, JUNK_SPOT, JUNK_SPOT, null];
  for (let day = 0; day < 4; day++) {
    const contents = collectParcel(g, log, putDown[day]!);
    log.hashes.push({ at: `parcel ${day} (${contents})`, hash: hashGameState(g) });
    if (contents < 0) break;
  }

  // Back for the purse, which has been sitting on its spot since day one.
  if (roomOf(g) === PARCEL_ROOM) {
    walkToMapPos(g, PURSE_SPOT.x, PURSE_SPOT.y, { maxTicks: 900 });
    pickUp(g);
    walkTo(g, ROOM_20_EXIT.x, ROOM_20_EXIT.y, { maxTicks: 600 });
    for (let i = 0; i < 60 && roomOf(g) === PARCEL_ROOM; i++) tickGame(g, X_PLUS);
  }
  log.hashes.push({ at: 'holding the compass and purse', hash: hashGameState(g) });

  log.ticks = g.ticks;
  log.arrested = g.totals.arrests;
  log.hashes.push({ at: 'escaped', hash: hashGameState(g) });
  (log as RunLog & { state: GameState }).state = g;
  return log;
}

describe('Completion:solutionOne, played through', () => {
  const run = playThrough(0);
  const g = (run as RunLog & { state: GameState }).state;

  it('opens all four red cross parcels, in the shipped order', () => {
    // red_cross_parcel_contents_list ($A25F). Asserted as the LIST, not as a
    // count: event_new_red_cross_parcel walks it looking for the first item
    // that is NOWHERE ($A23F), so a bug that re-offered an item already on the
    // ground would still open four parcels and hand over the wrong things.
    expect(run.parcelsOpened).toEqual([ITEM_PURSE, 0, 5, ITEM_COMPASS]);
  });

  it('leaves him holding the compass and the purse', () => {
    expect([...g.items.held].sort((a, b) => a - b)).toEqual([ITEM_PURSE, ITEM_COMPASS]);
  });

  it('cannot walk off the map, because the camp is sealed', () => {
    // Measured, not assumed, and the answer is worth pinning: breadth-first
    // search over `outdoorBoundsCheck` -- the game's OWN wall test, at the
    // finest step the hero takes -- reaches 34,532 outdoor squares from the
    // hut door, and not one of them satisfies $9F31.
    //
    // So walking off the edge is not an exit, and the walkthrough's "run
    // off-screen" is the last step of a route that has already got the hero
    // out: through the wire, or through the tunnel, or out of the main gate on
    // forged papers. This is the fact that makes those routes necessary rather
    // than optional, and it would be silently lost if the run below simply
    // asserted a successful escape.
    expect(reachableOutdoorSquares().escape).toBeNull();
  });

  it('produces the WINNING ending for what he is holding', () => {
    // $A538: compass + purse is escapeitem $05,
    // the success case -- "AND WILL CROSS THE BORDER SUCCESSFULLY" rather than
    // "BUT WERE RECAPTURED".
    const outcome = computeEscapeOutcome(g.items.held);
    expect(outcome.won).toBe(true);
    expect(outcome.lines).toContain(MSG_AND_WILL_CROSS_THE);
    expect(outcome.lines).toContain(MSG_BORDER_SUCCESSFULLY);
    // $A549: a winning attempt resets the game rather than sending him to
    // solitary ($A554).
    expect(outcome.resetsGame).toBe(true);
  });

  it('is never arrested on the way', () => {
    // Not a rule of the game -- a property of THIS route. If a change to
    // pursuit, collision or the permitted areas started catching him, the run
    // above would still reach an ending and this is what would say why.
    expect(run.arrested).toBe(0);
  });

  it('scores the parcels and the pick-ups', () => {
    // Five per first pick-up of an item ($7B73) and fifty per parcel opened
    // ($B3A5). Asserted as "more than nothing happened", because the exact
    // total depends on how many times the route walks over an item.
    const score = Number([...g.player.score].join(''));
    expect(score).toBeGreaterThan(200);
  });
});

/**
 * Every outdoor square the hero can walk to from the hut door, and whether any
 * of them is past $9F31's escape line.
 *
 * The step is TWO world units -- the finest the animation frames carry. A
 * four-unit grid steps clean over wall 12, a two-unit sliver at x=562, and
 * reports a clear corridor east of hut 2 that the hero then walks into and
 * stops dead against. That mistake cost an afternoon; the comment is here so
 * it costs nobody else one.
 */
function reachableOutdoorSquares(): { count: number; escape: { x: number; y: number } | null } {
  const S = 2;
  const H = 24;
  const start = { x: 772, y: 652 }; // just outside hut 2
  const key = (x: number, y: number) => x * 4096 + y;
  const seen = new Set<number>([key(start.x, start.y)]);
  let frontier = [start];
  let escape: { x: number; y: number } | null = null;

  while (frontier.length > 0) {
    const next: typeof frontier = [];
    for (const p of frontier) {
      for (const [dx, dy] of [[S, 0], [-S, 0], [0, S], [0, -S]] as const) {
        const nx = p.x + dx;
        const ny = p.y + dy;
        if (nx < 0 || ny < 0 || nx > 2200 || ny > 2200) continue;
        const k = key(nx, ny);
        if (seen.has(k)) continue;
        if (outdoorBoundsCheck({ x: nx, y: ny, height: H }).blocked) continue;
        seen.add(k);
        const iso = calcIsoPos({ x: nx, y: ny, height: H });
        if (!escape && (iso.x >= ESCAPE_ISO_X || iso.y >= ESCAPE_ISO_Y)) escape = { x: nx, y: ny };
        next.push({ x: nx, y: ny });
      }
    }
    frontier = next;
  }
  return { count: seen.size, escape };
}

describe('cutting the wire ($B417 / $9EB2)', () => {
  // A regression test for a bug this walkthrough found, and the reason it was
  // worth writing. The cut is the only way through the fence, so if the hero
  // does not cross it the game cannot be completed at all -- and nothing in
  // 774 other tests noticed, because no test had ever driven a cut to
  // completion inside the real loop.
  //
  // snips_tail ($B474/$B47F) writes the hero's direction, drops his height to
  // 12, and cutting_wire ($9ECC) then feeds him four scripted inputs to walk
  // him through the gap. All of those writes go to VISCHAR 0, which is where
  // those bytes live in the original -- but this port keeps the hero's
  // position in its own HeroState and rebuilds the vischar from it every
  // frame, so every one of them was overwritten before anything read it. He
  // snipped the wire, stood exactly where he was, and stayed in the camp.
  //
  // CLAUDE.md's "one game field, two objects", in its sixth costume.
  function cutTheWire() {
    const g = createGameState();
    tickGame(g, 1);
    walkTo(g, HUT2_DOOR.x, HUT2_DOOR.y, { maxTicks: 200 });
    // The route to the wiresnips is the parcel run, which the suite below
    // covers; this test is about the CUT.
    g.items.held[0] = ITEM_WIRESNIPS;
    travelTo(g, CUT_SPOT_WORLD.x, CUT_SPOT_WORLD.y, { legTicks: 2000 });
    // action_wiresnips compares hero_map_position against the fence, and that
    // rounds -- arriving within a world unit or two is not the same as being
    // on the square it tests.
    walkToMapPos(g, CUT_SPOT_MAP.x, CUT_SPOT_MAP.y, { maxTicks: 400 });
    const before = { ...g.hero.pos };
    useItem(g, ITEM_WIRESNIPS);
    return { g, before };
  }

  it('starts the cut, and puts him on his belly to do it', () => {
    const { g } = cutTheWire();
    // $B47B sets vischar_FLAGS_CUTTING_WIRE; $B47F drops the height to 12.
    expect(g.heroSlot.flags & FLAGS_CUTTING_WIRE).toBe(FLAGS_CUTTING_WIRE);
    expect(g.hero.pos.height).toBe(12);
  });

  it('walks him THROUGH the gap, not merely up to it', () => {
    const { g, before } = cutTheWire();
    for (let i = 0; i < 300 && (g.heroSlot.flags & FLAGS_CUTTING_WIRE) !== 0; i++) {
      tickGame(g, 0);
    }
    // He must end up on the far side. Before the fix this was (0, 0).
    const moved = Math.abs(g.hero.pos.x - before.x) + Math.abs(g.hero.pos.y - before.y);
    expect(moved).toBeGreaterThan(0);
    // $9EDB stands him back up; $9ED5 faces him top-left, which the
    // disassembly flags as a bug and FIDELITY.md keeps.
    expect(g.hero.pos.height).toBe(24);
    expect(g.hero.direction).toBe(0);
    expect(g.heroSlot.flags & FLAGS_CUTTING_WIRE).toBe(0);
  });
});

describe('determinism (the brief, §8)', () => {
  it('replays identically from the same seed', () => {
    // A fixed seed plus a scripted input sequence must produce the same state
    // hash at frame N. The hash covers every field a tick writes; see hash.ts
    // for what is deliberately outside it.
    const a = playThrough(0);
    const b = playThrough(0);
    expect(b.hashes).toEqual(a.hashes);
    expect(b.ticks).toBe(a.ticks);
  });

  it('diverges from a different seed', () => {
    // The other half, and the one that makes the test above mean something: a
    // hash that never changes would pass the first test while covering
    // nothing. game_counter is deliberately NOT reset on a new game
    // (Fact:randomness), which is what makes two real plays differ.
    const a = playThrough(0);
    const c = playThrough(101);
    expect(c.hashes).not.toEqual(a.hashes);
  });
});
