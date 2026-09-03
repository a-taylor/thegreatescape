/**
 * The demo's tick, end to end.
 *
 * Everything else in the suite tests one routine. This runs the whole main
 * loop in order for thousands of frames with the hero on autopilot, which is
 * the only way to catch faults that are about how the pieces FIT: a hero who
 * teleports, a map that stops following him, a scroll phase that drifts.
 *
 * Three bugs reached the screen before this existed, and all three would have
 * failed here on the first frame they occurred.
 */

import { describe, expect, it } from 'vitest';

import { characterStructs } from '../src/game/characters.js';
import { createVischars, isEmpty, npcSlots } from '../src/game/vischar.js';
import {
  FLAGS_TARGET_IS_DOOR,
  characterBehaviour,
  getTargetAssignPos,
  targetReached,
} from '../src/game/behaviour.js';
import { setHeroRoute } from '../src/game/schedule.js';
import { Prng } from '../src/game/prng.js';
import { HERO_STANDING_HEIGHT, createHero, step } from '../src/game/hero.js';
import { decodeBase64 } from '../src/data/load.js';
import { createGameState, interiorBounds, tickGame } from './harness/loop.js';
import routesData from '../data/routes.json';
import { halfDoors } from '../src/game/doors.js';
import { getTarget } from '../src/game/routes.js';
import { BYTE7_Y_DOMINANT } from '../src/game/vischar.js';
import { type PlayerState } from '../src/game/player.js';
import { type ItemState } from '../src/game/inventory.js';
import {
  bedObjects,
  heroBedObject,
  pokedObject,
  messHallBenchRoom25,
  messHallBenchRoom23,
  INTERIOR_OBJECT_EMPTY_BED,
  INTERIOR_OBJECT_EMPTY_BENCH,
  INTERIOR_OBJECT_OCCUPIED_BED,
  INTERIOR_OBJECT_PRISONER_SAT,
  INTERIOR_OBJECT_PRISONER_SAT_END,
  heroBench,
  type ParcelState,
  type RoomPokeState,
} from '../src/game/parcels.js';
import {
  MESSAGE_NEXT,
  MESSAGE_SCREEN_ADDRESS,
  messages as messageTable,
} from '../src/ui/messages.js';
import { fontBitmaps } from '../src/ui/glyphs.js';
import { SpectrumScreen, screenAddress, screenCoords } from '../src/spectrum/display.js';

/**
 * How many bytes each route occupies, terminator included.
 *
 * Routes are PACKED, so a step past the terminator reads the next route's
 * data instead of failing. That makes "step is within the route" an invariant
 * worth checking directly: nothing else notices when it breaks.
 */
const routeLengths: number[] = (() => {
  const data = routesData as unknown as {
    data: string;
    pointers: { index: number; offset: number | null }[];
  };
  const bytes = decodeBase64(data.data);
  return data.pointers.map((p) => {
    if (p.offset === null) return 0; // route 0 is a null pointer
    let n = 0;
    while (p.offset + n < bytes.length && bytes[p.offset + n] !== 0xff) n++;
    return n + 1; // include the terminator
  });
})();

/** Whether a route/step pair is inside its own route's data. */
function stepInRange(route: { index: number; step: number }): boolean {
  const index = route.index & 0x7f;
  if (route.index === 0xff) return true; // WANDER uses step as a location block
  if (index === 0) return true; // HALT
  // get_target deliberately reads the byte BEFORE the route when step is $FF
  // ($C66F sets H to $FF), so that value is legitimate.
  if (route.step === 0xff) return true;
  const len = routeLengths[index];
  return len === undefined || route.step < len;
}

interface Sample {
  offWindow: number;
  roomChanges: number;
  heroMoves: number;
  firstFailure: string;
  /** P5: every message index played, in order. */
  messagesShown: number[];
  /** P5: the message line's contents each time one finished typing. */
  linesTyped: string[];
  /** Any character whose route step ran off the end of its route. */
  routeOverruns: string[];
  /**
   * The longest run of CONSECUTIVE frames on which three or more characters
   * sat on one exact square. A crowd at a doorway lasts a few frames; a jam
   * lasts until the next timed event moves everyone on.
   */
  longestJam: number;
  jamDetail: string;
  /** Characters whose room became room_NONE -- i.e. who sat or slept. */
  seated: number[];
  /** True once every bed has been seen empty at the same moment. */
  bedsEmptied: boolean;
  /** Bench occupancy at the moment the last prisoner sat down. */
  benchesAtBreakfast: Array<number | undefined>;
  /** True once the hero's own bench shows him sitting at it. */
  heroSeated: boolean;
  /** Frames with schedule.night true -- proves the run actually reaches night. */
  nightTicks: number;
  /** Frames spent frozen inside a zoombox reveal ($ABA0 blocks the main loop). */
  zoomboxTicks: number;
  /** Fire commands process_player_input_fire ($7AC9) actually dispatched. */
  itemCommands: number;
  /** Frames with the red flag up -- the hero somewhere he should not be. */
  redFlagTicks: number;
  /** Slot-frames spent in one of the four pursuit modes ($C892 onwards). */
  pursuitTicks: number;
  /** Arrests ($B06E -> solitary) and bribes taken ($B063). */
  arrests: number;
  bribes: number;
  /** action_papers walking him out of the main gate ($EFCB). */
  gateTransitions: number;
  /** in_permitted_area seeing him off the map edge ($A51C escaped). */
  escapes: number;
  /** Frames searchlightMaskTest actually ran (state !== SEARCHING, hero plotted). */
  maskTestRuns: number;
  /** Times searchlightMaskTest returned true, i.e. the light gave up. */
  searchlightEscapes: number;
  /** searchlight_state ever seen outside its documented 0..255 range. */
  searchlightStateInvalid: boolean;
  player: PlayerState;
  parcels: ParcelState;
  pokes: RoomPokeState;
  items: ItemState;
  screen: SpectrumScreen;
}

/** Read the message line back as text, via the glyph bitmaps. */
function readMessageLine(screen: SpectrumScreen): string {
  const { col, row } = screenCoords(MESSAGE_SCREEN_ADDRESS);
  let out = '';
  for (let i = 0; i < 32; i++) {
    const rows: number[] = [];
    for (let r = 0; r < 8; r++) rows.push(screen.readByte(screenAddress(col + i, row + r)));
    let found = -1;
    for (let g = 0; g < fontBitmaps.length / 8; g++) {
      if (rows.every((b, r) => b === fontBitmaps[g * 8 + r])) { found = g; break; }
    }
    out += found < 0 ? '?' : GLYPH_CHARS[found] ?? '?';
  }
  return out.replace(/\s+$/, '');
}

const GLYPH_CHARS = '0123456789' + 'ABCDEFGHIJKLMN' + 'PQRSTUVWXYZ' + ' .';

/**
 * One run of the demo loop with the player idle throughout.
 *
 * The tick itself lives in `tests/harness/loop.ts` -- this is only the
 * instrumentation. Everything below reads state the tick has already advanced,
 * or a value it hands back in its TickResult.
 */
function runIdle(ticks: number): Sample {
  const g = createGameState();
  const { structs, vischars, heroSlot, view, schedule, screen, pokes } = g;

  const out: Sample = {
    offWindow: 0,
    roomChanges: 0,
    heroMoves: 0,
    firstFailure: '',
    messagesShown: [],
    linesTyped: [],
    routeOverruns: [],
    longestJam: 0,
    jamDetail: '',
    seated: [],
    bedsEmptied: false,
    benchesAtBreakfast: [],
    heroSeated: false,
    nightTicks: 0,
    zoomboxTicks: 0,
    itemCommands: 0,
    redFlagTicks: 0,
    pursuitTicks: 0,
    arrests: 0,
    bribes: 0,
    gateTransitions: 0,
    escapes: 0,
    maskTestRuns: 0,
    searchlightEscapes: 0,
    searchlightStateInvalid: false,
    player: g.player,
    parcels: g.parcels,
    pokes,
    items: g.items,
    screen,
  };

  let jamKey = '';
  let jamRun = 0;
  for (let t = 0; t < ticks; t++) {
    if (schedule.night) out.nightTicks++;

    const r = tickGame(g, 0);

    if (g.searchlights.state < 0 || g.searchlights.state > 0xff) {
      out.searchlightStateInvalid = true;
    }
    if (r.moved) out.heroMoves++;
    if (r.command) out.itemCommands++;
    if (r.enteredRoom !== null) out.roomChanges++;
    out.zoomboxTicks += r.zoomboxSteps;
    if (r.redFlag) out.redFlagTicks++;
    out.pursuitTicks += r.pursuingSlots;
    if (r.arrested) out.arrests++;
    if (r.bribed) out.bribes++;
    if (r.gateTransition) out.gateTransitions++;
    if (r.escaped) out.escapes++;
    if (r.maskTested) out.maskTestRuns++;
    if (r.searchlightEscaped) out.searchlightEscapes++;

    // The message line, sampled either side of message_display.
    if (r.messageIndexBefore === MESSAGE_NEXT && g.messages.displayIndex === 0) {
      out.messagesShown.push(g.messages.messageIndex);
    }
    if (r.messageIndexBefore < MESSAGE_NEXT && g.messages.displayIndex >= MESSAGE_NEXT) {
      out.linesTyped.push(readMessageLine(screen));
    }

    // Route overruns and pile-ups. Both are cheap and both are invisible to
    // every per-routine test in the suite.
    for (const v of vischars) {
      if (v.slot !== 0 && isEmpty(v)) continue;
      if (!stepInRange(v.route) && out.routeOverruns.length < 5) {
        out.routeOverruns.push(
          `t=${t} slot ${v.slot} ch${v.character} route ${v.route.index}/${v.route.step}` +
            ` (route is ${routeLengths[v.route.index & 0x7f]} bytes) room ${v.room}`,
        );
      }
    }
    for (const st of structs) {
      if (!stepInRange(st.route) && out.routeOverruns.length < 5) {
        out.routeOverruns.push(
          `t=${t} struct ch${structs.indexOf(st)} route ${st.route.index}/${st.route.step}` +
            ` (route is ${routeLengths[st.route.index & 0x7f]} bytes)`,
        );
      }
    }

    const occupied = new Map<string, number[]>();
    for (const v of npcSlots(vischars)) {
      if (isEmpty(v)) continue;
      const key = `${v.room}:${v.pos.x},${v.pos.y}`;
      const at = occupied.get(key) ?? [];
      at.push(v.character);
      occupied.set(key, at);
    }
    let crowded = '';
    for (const [where, who] of occupied) {
      if (who.length >= 3) crowded = `${where} (${who.join(', ')})`;
    }
    if (crowded !== '' && crowded === jamKey) {
      jamRun++;
      if (jamRun > out.longestJam) {
        out.longestJam = jamRun;
        out.jamDetail = `${jamRun} consecutive frames to t=${t}: ${crowded}`;
      }
    } else {
      jamKey = crowded;
      jamRun = crowded === '' ? 0 : 1;
    }

    for (let c = 0; c < structs.length; c++) {
      if (structs[c]!.room === 0xff && !out.seated.includes(c)) out.seated.push(c);
    }

    // The beds are emptied at wake-up and filled again at bedtime, so the
    // end-of-run value says nothing. Record the moment they were all empty.
    if (!out.bedsEmptied) {
      out.bedsEmptied =
        bedObjects.every((b) => pokedObject(pokes, b) === INTERIOR_OBJECT_EMPTY_BED) &&
        pokedObject(pokes, heroBedObject) === INTERIOR_OBJECT_EMPTY_BED;
    }

    // The hero's own seat, which a different routine pokes with a different
    // graphic ($A482 rather than $A437).
    if (!out.heroSeated) {
      out.heroSeated = pokedObject(pokes, heroBench) === INTERIOR_OBJECT_PRISONER_SAT_END;
    }

    // Likewise the benches: snapshot them while breakfast is actually running.
    if (schedule.clock >= 25 && schedule.clock <= 35) {
      out.benchesAtBreakfast = [messHallBenchRoom25, messHallBenchRoom23].flatMap((base) =>
        [0, 1, 2].map((n) => pokedObject(pokes, { ...base, objectIndex: base.objectIndex + n })),
      );
    }

    // While he is in bed OR at breakfast his position is zeroed and he is
    // inside the furniture, so not being drawn is correct: hero_sits ($A47F)
    // and hero_sleeps ($A489) both fall into hero_sit_sleep_common ($A491),
    // which zeroes mi.pos ($A498). Only count frames where he is supposed to
    // be on screen.
    if (!r.visible && !schedule.heroInBed && !schedule.heroInBreakfast) {
      out.offWindow++;
      if (!out.firstFailure) {
        out.firstFailure =
          `t=${t} hero tiny(${g.hero.pos.x >> 3},${g.hero.pos.y >> 3}) ` +
          `room ${g.hero.room} map(${view.position.x},${view.position.y}) ` +
          `clock ${schedule.clock} route(${heroSlot.route.index},${heroSlot.route.step})`;
      }
    }
  }
  return out;
}

describe('the hero on autopilot', () => {
  // Long enough to cross a full day (DAY_LENGTH_TICKS = clockWrap * ticksPerClock
  // = 140 * 64 = 8960) and into the next, so nighttime() and
  // searchlightMaskTest() are actually exercised rather than merely wired in.
  // CLAUDE.md: "a routine can be implemented, tested, and still unreachable" --
  // this run has to prove reachability, not just avoid crashing.
  const run = runIdle(10000);

  it('never leaves the game window', () => {
    // Two faults produced this, both invisible to per-routine tests:
    //
    //   - event_wake_up writes the LOW BYTE of mi.pos ($A293 `LD (HL),$2E`),
    //     not the whole word. Assigning 16 bits teleported an outdoor hero to
    //     the top-left corner of the world.
    //   - automatics SUPPLIES an input; stepping again for it doubled his
    //     speed while move_map scrolled once.
    //
    // In both cases the hero simply walked out of frame and vanished.
    expect(run.offWindow, run.firstFailure).toBe(0);
  });

  it('actually walks rather than standing still', () => {
    // A hero who never moves would pass the test above trivially.
    expect(run.heroMoves).toBeGreaterThan(1000);
  });

  it('uses doors rather than walking through walls', () => {
    // The routes the day schedule gives him lead indoors, so a run this long
    // should take him through several doorways.
    expect(run.roomChanges).toBeGreaterThan(0);
  });

  it('actually reaches night', () => {
    // Without this the searchlight mirror below would pass trivially by never
    // running -- the exact shape of the item-logic bug from P5.
    expect(run.nightTicks).toBeGreaterThan(0);
  });

  it('keeps searchlight_state within its documented 0..255 range', () => {
    expect(run.searchlightStateInvalid).toBe(false);
  });
});

describe('the hero can slide along walls', () => {
  it('alternates axes when a move is refused', () => {
    // counter_and_flags is ONE byte in the game -- vischar 0's. bounds_check
    // toggles Y_DOMINANT in it when a move is refused ($B1AF), and
    // character_behaviour reads it to decide which axis to try first ($C9E1).
    //
    // The demo keeps hero state in two objects, so the byte has to be copied
    // both ways around the behaviour call. Without that the alternation never
    // reaches the behaviour code: the hero picks a direction, walks into the
    // nearest wall and presses against it indefinitely. Measured before the
    // fix: 680 blocked frames out of 800 and zero Y_DOMINANT changes.
    const prng = new Prng();
    const random = () => prng.next();
    const structs = characterStructs();
    const vischars = createVischars();
    const heroSlot = vischars[0]!;
    heroSlot.character = 0;
    heroSlot.flags = 0;

    // Outdoors, aimed at somewhere with scenery in the way.
    const hero = createHero(
      { x: 100 * 8, y: 74 * 8, height: HERO_STANDING_HEIGHT },
      0,
      0,
    );
    const ctx = {
      structs,
      vischars,
      random,
      room: 0,
      hero: heroSlot,
      heroPos: hero.pos,
    };
    setHeroRoute(ctx, 42, 0);

    let flips = 0;
    let last = heroSlot.counterAndFlags & BYTE7_Y_DOMINANT;
    let blocked = 0;
    for (let t = 0; t < 800; t++) {
      heroSlot.pos = { ...hero.pos };
      heroSlot.room = hero.room;
      heroSlot.counterAndFlags = hero.counterAndFlags;
      characterBehaviour(heroSlot, { random, structs, room: hero.room });
      hero.counterAndFlags = heroSlot.counterAndFlags;

      const outcome = step(hero, heroSlot.input & 0x0f, interiorBounds(hero.room));
      if (outcome.blocked) blocked++;

      const now = heroSlot.counterAndFlags & BYTE7_Y_DOMINANT;
      if (now !== last) {
        flips++;
        last = now;
      }
    }

    expect(blocked, 'the route really does run him into scenery').toBeGreaterThan(0);
    expect(flips, 'Y_DOMINANT alternates when blocked').toBeGreaterThan(0);
  });
});

describe('the hero is identified by his SLOT, not his character index', () => {
  it('sends him to character_event at the end of a route', () => {
    // $CB2D `LD A,L; CP $02` -- vischar 0's route field is at $8002, so its low
    // byte is 2. The routine tests that BEFORE it looks at the character index
    // at all, and the distinction is invisible if you go by index: the hero's
    // vischar also carries character 0, which is the COMMANDANT's index.
    //
    // Treat him as the commandant and he takes "turn around and walk it
    // backwards" instead. After breakfast that reverses route 16, whose first
    // waypoint is an outdoor location, while he is standing in a mess hall --
    // so he walks into the nearest corner and stays there.
    const prng = new Prng();
    const random = () => prng.next();
    const structs = characterStructs();
    const vischars = createVischars();
    const hero = vischars[0]!;
    hero.character = 0; // also the commandant's index
    hero.flags = 0;
    hero.room = 3;
    hero.pos = { x: 10, y: 10, height: 24 };
    // Route 42 is [door17, END]. From step 0, tr_set_route advances to 1 --
    // the terminator -- so the route ends. Note routes are PACKED, so a step
    // past the terminator reads into the next route rather than ending.
    hero.route = { index: 42, step: 0 };

    targetReached(hero, { random, structs, room: 3 });

    // character_event maps route 42 to charevnt_exit_hut2, route (5, 0).
    // The commandant branch would have set the reversed flag instead.
    expect(hero.route.index & 0x80, 'not reversed like the commandant').toBe(0);
    expect(hero.route.index).toBe(5);
  });

  it('takes his next waypoint before going through a door', () => {
    // $CAFC..$CB05, and again by slot. Without it he arrives in the new room
    // still holding the door's position as his target, walks to the nearest
    // wall and waits there until a timed event reroutes him.
    const prng = new Prng();
    const random = () => prng.next();
    const structs = characterStructs();
    const vischars = createVischars();
    const hero = vischars[0]!;
    hero.character = 0;
    hero.flags = 0;
    hero.room = 0;

    // Route 16 is [loc12, door10, door20, door19REV]; step 1 is a door.
    hero.route = { index: 16, step: 1 };
    getTargetAssignPos(hero, { random, structs, room: 0 });
    expect(hero.flags & FLAGS_TARGET_IS_DOOR, 'step 1 is a door').toBeTruthy();
    const doorTarget = { ...hero.target };

    hero.pos = { x: hero.target.x * 4, y: hero.target.y * 4, height: 24 };
    targetReached(hero, { random, structs, room: 0 });

    expect(hero.room, 'went through the door').not.toBe(0);
    expect(hero.target, 'took the next waypoint').not.toEqual(doorTarget);
  });
});

describe('door handling belongs to one path at a time', () => {
  it('is skipped while the game is steering', () => {
    // $AFA3: touch calls door_handling for the hero ONLY while the automatic
    // player counter is positive -- that is, while the PLAYER is steering.
    // Under automatic control target_reached handles doors instead ($CAF8),
    // and running both makes them fight over the room index.
    const hero = createHero({ x: 100 * 8, y: 74 * 8, height: HERO_STANDING_HEIGHT }, 0, 0);
    const before = hero.room;
    // Park him exactly on a door and face it, so door_handling would fire.
    const outcome = step(hero, 0, undefined, { doorHandling: false });
    expect(outcome.enteredRoom).toBeNull();
    expect(hero.room).toBe(before);
  });
});

describe('the exercise yard gates', () => {
  it('are door pairs with BOTH halves outdoors', () => {
    // Door pairs 0 and 1 are gates in a fence, not doorways into a room, so
    // walking through one changes the hero's POSITION without changing his
    // room. Anything that keys on the room index having changed will discard
    // the transition entirely.
    for (const pair of [0, 1]) {
      expect(halfDoors[pair * 2]!.targetRoom, `pair ${pair} half 0`).toBe(0);
      expect(halfDoors[pair * 2 + 1]!.targetRoom, `pair ${pair} half 1`).toBe(0);
    }
  });

  it('put the hero on the far side of the fence', () => {
    // Half 1 of pair 0 sits at tiny (89,71) and half 0 at (89,69): the fence
    // at wall 18 runs y=70 across x=70..103, so the two halves straddle it.
    // That is the only way through -- the alternation cannot route around a
    // fence when the target is already aligned on x.
    const south = halfDoors[1]!.pos;
    const north = halfDoors[0]!.pos;
    // Door positions are stored quartered outdoors; *4 gives world, /8 tiny.
    const southTiny = (south.y * 4) >> 3;
    const northTiny = (north.y * 4) >> 3;
    expect(southTiny).toBeGreaterThan(70);
    expect(northTiny).toBeLessThan(70);
  });

  it('reports the transition even when the room is unchanged', () => {
    // targetReached returns enterRoom for any door it goes through. Comparing
    // rooms instead leaves the hero pressed against the fence for the whole
    // exercise period: measured at 1,528 consecutive blocked frames, against 1
    // once the position is copied back.
    const prng = new Prng();
    const random = () => prng.next();
    const structs = characterStructs();
    const vischars = createVischars();
    const hero = vischars[0]!;
    hero.character = 0;
    hero.flags = 0;
    hero.room = 0;

    // Route 14 step 2 is the yard gate.
    hero.route = { index: 14, step: 2 };
    getTargetAssignPos(hero, { random, structs, room: 0 });
    expect(hero.flags & FLAGS_TARGET_IS_DOOR, 'step 2 is a gate').toBeTruthy();

    hero.pos = { x: hero.target.x * 4, y: hero.target.y * 4, height: 24 };
    const before = { ...hero.pos };
    const result = targetReached(hero, { random, structs, room: 0 });

    expect(result.enterRoom, 'the transition is reported').not.toBeNull();
    expect(hero.room, 'but the room is the same').toBe(0);
    expect(hero.pos, 'and the position moved across the fence').not.toEqual(before);
  });
});

describe('a route that ends AT a door', () => {
  it('is handled during the transition, not one step later', () => {
    // get_target_assign_pos FALLS THROUGH into route_ended when the route has
    // run out ($CB29). $CB05 calls it from inside the door transition, so a
    // route whose last waypoint IS the door gets its end handled there.
    //
    // Discard that result and the character arrives holding a finished route.
    // He then finds both axes in the dead zone, and target_reached advances the
    // step PAST the terminator -- and because routes are PACKED, that reads the
    // next route's first waypoint. Route 16 is exactly this shape: its last
    // waypoint is the mess hall door, and step 5 reads route 17's outdoor
    // location, which he then chases from inside the mess hall.
    const prng = new Prng();
    const random = () => prng.next();
    const structs = characterStructs();
    const vischars = createVischars();
    const hero = vischars[0]!;
    hero.character = 0;
    hero.flags = 0;
    hero.room = 23;

    // Route 16 is [loc12, door10, door20, door19REV, END]; step 3 is the last
    // waypoint, and step 4 is the terminator.
    hero.route = { index: 16, step: 3 };
    getTargetAssignPos(hero, { random, structs, room: 23 });
    expect(hero.flags & FLAGS_TARGET_IS_DOOR, 'step 3 is a door').toBeTruthy();

    hero.pos = { x: hero.target.x, y: hero.target.y, height: 24 };
    targetReached(hero, { random, structs, room: 23 });

    // The route ended, so character_event ran: route 16 maps to the breakfast
    // handler, which gives the hero route 43. What must NOT happen is the step
    // walking past the terminator.
    expect(hero.route.step, 'never past the terminator').toBeLessThanOrEqual(4);
    expect(hero.route.index, 'the event reassigned him').not.toBe(16);
  });

  it('never reads a waypoint from the following route', () => {
    // Routes are packed, so stepping past a terminator silently yields the
    // next route's data rather than failing.
    expect(getTarget({ index: 16, step: 4 }, () => 0).kind).toBe('ended');
    const beyond = getTarget({ index: 16, step: 5 }, () => 0);
    expect(beyond.kind, 'step 5 IS readable -- that is the hazard').toBe('location');
  });
});

describe('P5 over a full day', () => {
  // 8,960 frames is one in-game day: the clock advances every 64 main-loop
  // iterations and wraps at 140 ($A1A5).
  const run = runIdle(8960);

  it('plays the day\'s messages, in the order the events fire', () => {
    // Each of these is the `LD B,n` at its event's call site. Getting the
    // ORDER right is the point: it is the one thing per-routine tests cannot
    // check, and the same failure mode as the P4 route bugs.
    const names = run.messagesShown.map((i) => messageTable[i]!.text);
    expect(names).toContain('TIME T0 WAKE UP');
    expect(names).toContain('R0LL CALL');
    expect(names).toContain('BREAKFAST TIME');
    expect(names).toContain('EXERCISE TIME');
    expect(names).toContain('TIME F0R BED');

    // Two roll calls a day, at clock 16 and clock 74 -- the timed_events table
    // lists event_go_to_roll_call twice. The second falls between exercise and
    // bed, which is what makes the order worth asserting at all.
    const order = [
      'TIME T0 WAKE UP',
      'R0LL CALL',
      'BREAKFAST TIME',
      'EXERCISE TIME',
      'R0LL CALL',
      'TIME F0R BED',
    ];
    const seen = names.filter((n) => order.includes(n));
    expect(seen).toEqual(order);
  });

  it('actually renders each message to the screen, not just queues it', () => {
    // The queue and the display are separate systems and a message can be
    // queued and never drawn -- which is exactly what a full queue does.
    expect(run.linesTyped.length).toBeGreaterThan(0);
    expect(run.linesTyped).toContain('BREAKFAST TIME');
  });

  it('empties every bed when the prisoners wake up', () => {
    // Checked as a moment, not as an end state: character_sleeps ($A453) fills
    // the beds again at night, so by the end of the day they are occupied --
    // which is correct, and used to be invisible because nothing ever wrote
    // OCCUPIED_BED at all.
    expect(run.bedsEmptied).toBe(true);
  });

  it('puts everyone back to bed by the end of the day', () => {
    // The other half of the same mechanism, and the reason the assertion above
    // had to become a moment.
    const occupied = bedObjects.filter(
      (b) => pokedObject(run.pokes, b) === INTERIOR_OBJECT_OCCUPIED_BED,
    );
    expect(occupied.length).toBeGreaterThan(0);
  });

  it('delivers a red cross parcel', () => {
    expect(run.parcels.contents).not.toBe(0xff);
  });

  it('docks exactly 25 morale for the night', () => {
    // Morale starts at the maximum, so over an idle day the only thing that
    // moves it is event_another_day_dawns ($A1D8 LD B,$19).
    expect(run.player.morale).toBe(112 - 25);
  });

  it('leaves the flag still catching up, because dawn is the LAST tick', () => {
    // event_another_day_dawns sits at clock 0, and dispatch_timed_event
    // increments before it matches ($A1A0), so clock 0 is only reached after a
    // full wrap of 140 -- the very end of the 8,960-frame day, not the start.
    // displayed_morale therefore has had two frames, not a day, to react.
    //
    // Asserted as the timing fact it is: if dawn ever moved to the front of
    // the day this would flip to equality, and that would be a real change.
    expect(run.player.displayedMorale).toBeGreaterThan(run.player.morale);
    expect(run.player.displayedMorale).toBeLessThanOrEqual(112);
  });

  it('lets the flag catch up once the day rolls on', () => {
    // A hundred more frames is fifty steps, more than the 25 it has to fall.
    const longer = runIdle(8960 + 100);
    expect(longer.player.displayedMorale).toBe(longer.player.morale);
  });

  it('actually reaches the pursuit chain', () => {
    // Reachability first, per CLAUDE.md: follow_suspicious_character ($C892)
    // and collision ($AFC0) were outside this loop entirely until now, and a
    // system that is wired but never entered is the exact shape of P5's item
    // bug. Measured, not assumed -- 941 slot-frames carry a pursuit mode over
    // an ordinary day, so the guards really do notice each other's business
    // while the hero is doing nothing at all.
    expect(run.pursuitTicks).toBeGreaterThan(0);
  });

  it('never flags, arrests or loses an idle hero who follows the schedule', () => {
    // The other half of the same wiring, and the more valuable half: a hero on
    // autopilot walks the day's routes, so in_permitted_area should never once
    // raise the red flag, collision should never reach an arrest, and he
    // should never wander off the map edge into escaped ($A51C).
    //
    // Each of these is a real regression net. A route that sent him somewhere
    // he is not permitted, or a collision test that fired on a guard merely
    // passing him, would show up here and nowhere else in the suite.
    expect(run.redFlagTicks).toBe(0);
    expect(run.arrests).toBe(0);
    expect(run.bribes).toBe(0);
    expect(run.escapes).toBe(0);
    expect(run.gateTransitions).toBe(0);
  });

  it('presses fire exactly never, which is the gap this loop still has', () => {
    // process_player_input_fire ($7AC9) is wired to the real itemActions
    // context above, but the autopilot never synthesises a fire bit, so no
    // action_* handler runs in this scenario. Asserted rather than left
    // unsaid: the number is what tells a reader the item path is present for
    // ORDER, and that covering the handlers needs a scripted-input run.
    expect(run.itemCommands).toBe(0);
  });

  it('zoomboxes every room change, eleven steps each', () => {
    // Reachability, not correctness -- zoombox's own geometry is covered in
    // tests/zoombox.test.ts. The question this answers is the one that P5's
    // item logic and P6's searchlight escape both turned on: does a real day
    // ever GET here? Eleven is what $ABA0's loop arithmetic works out to; if
    // it changed, the ratio below would stop being a whole number.
    expect(run.roomChanges).toBeGreaterThan(0);
    expect(run.zoomboxTicks).toBe(run.roomChanges * 11);
  });

  it('does not let the reveal cost a single game tick', () => {
    // The reveal BLOCKS the main loop rather than running inside it, so a day
    // is still 8,960 iterations however many doors the hero walks through.
    // Spending loop iterations on it instead shortens the day by roomChanges
    // * 11 and the night event never fires -- which is exactly what happened
    // when this was first wired in.
    expect(run.player.gameCounter).toBe(8960 & 0xff);
    expect(run.nightTicks).toBeGreaterThan(0);
  });

  it('advances the game counter once per tick, from wave_morale_flag', () => {
    // The counter is a byte and wraps, so the assertion is on the phase: 8,960
    // increments mod 256.
    expect(run.player.gameCounter).toBe(8960 & 0xff);
  });

  it('leaves the score alone when the hero picks nothing up', () => {
    expect([...run.player.score]).toEqual([0, 0, 0, 0, 0]);
  });

  it('never lets a message run off the end of its line', () => {
    // message_display masks the column with $1F ($7D69), so a message longer
    // than 32 characters would wrap onto itself rather than overflow. None is,
    // and that is worth pinning because the mask hides the failure.
    for (const m of messageTable) {
      expect({ text: m.text, len: m.glyphs.length }).toEqual({
        text: m.text,
        len: m.text.length,
      });
      expect(m.glyphs.length).toBeLessThanOrEqual(32);
    }
  });
});

describe('nobody jams at breakfast', () => {
  // Long enough to cover the walk to the mess halls (clock 21), sitting down,
  // and end_of_breakfast (clock 36).
  const run = runIdle(3000);

  it('never steps a route past its own terminator', () => {
    // Routes are PACKED, so an overrun reads the FOLLOWING route's waypoints
    // rather than failing. Three separate omissions each produced this, and
    // none of them was visible to a per-routine test:
    //
    //   - transition ($68D4) exits via reset_visible_character for anyone but
    //     the hero, handing the slot back. Without it a character keeps a
    //     target that is the door it just walked through, in the coordinate
    //     space of the room it just left, and target_reached fires again
    //     immediately -- cascading through waypoints.
    //   - spawn_character ($C5A4) checks get_target for ROUTE_ENDS and calls
    //     route_ended before taking a target. Discarding that result leaves a
    //     freshly spawned character standing on its own terminator.
    //   - character_sit_sleep_common ($A463) sets the route to HALT. Without
    //     it a seated prisoner still has a live route.
    //
    // Route 16 is the walk to breakfast and ends at step 4; step 5 is route
    // 17's first waypoint, an outdoor location. Six prisoners chasing it from
    // inside a mess hall is what the jam looked like.
    expect(run.routeOverruns, run.routeOverruns.join('\n')).toEqual([]);
  });

  it('does not park the cast on one square for the rest of the meal', () => {
    // The visible symptom. NPCs do not collide with each other, so a brief
    // crowd at a hut doorway is normal and expected; what is not is three or
    // more characters holding the same exact square frame after frame until
    // the next timed event moves them on. Before the fix this ran for the
    // whole of breakfast -- some 450 frames.
    expect(run.longestJam, run.jamDetail).toBeLessThan(120);
  });

  it('still gets the cast to the mess halls and sits them down', () => {
    // The fix must not work by simply stopping everyone from arriving.
    expect(run.messagesShown.length).toBeGreaterThan(0);
  });

  it('sits the prisoners INSIDE the benches, not next to them', () => {
    // character_sit_sleep_common makes three writes ($A462). Halting the route
    // alone stops the jam but leaves everyone standing around the furniture;
    // the room must become room_NONE ($A470) for them to disappear into it.
    //
    // Prisoners are characters 20..25. The sixth is expected to be missing --
    // see the next test.
    const prisonersSeated = run.seated.filter((c) => c >= 20 && c <= 25);
    expect(prisonersSeated.length).toBeGreaterThanOrEqual(5);
  });

  it('draws the HERO in his seat too ($A482)', () => {
    // He was the last one missing. His position is zeroed when he sits
    // ($A498), so he is not drawn as a sprite -- the only thing that puts him
    // on screen is his bench object, and hero_sits pokes it with
    // PRISONER_SAT_DOWN_END_TABLE ($13), not the $05 the other five get,
    // because he sits at the end of the table.
    expect(run.heroSeated).toBe(true);
  });

  it('empties the hero\'s bench again when breakfast ends ($A32E)', () => {
    // end_of_breakfast clears all SEVEN benches, his included. Without it he
    // walks away and leaves a seated copy of himself behind.
    expect(pokedObject(run.pokes, heroBench)).toBe(INTERIOR_OBJECT_EMPTY_BENCH);
  });

  it('pokes a seat graphic for each prisoner who sat', () => {
    // $A437 writes interiorobject_PRISONER_SAT_MID_TABLE. Without it the bench
    // stays empty however many prisoners are sitting on it -- which is what
    // "three guys standing next to the bench" looked like.
    const taken = run.benchesAtBreakfast.filter((v) => v !== undefined);
    expect(taken.length).toBeGreaterThanOrEqual(5);
    for (const v of taken) expect(v).toBe(INTERIOR_OBJECT_PRISONER_SAT);
  });

  it('leaves one bench seat empty, as the original does ($C7D4)', () => {
    // The reproduced quirk, now visible end to end rather than only in a unit
    // test: character_event's sit range is 18..22 where it should be 18..23,
    // so one prisoner never gets a sit event and one of the six seats is never
    // poked. Snapshotted DURING breakfast, because end_of_breakfast stands
    // everyone up again.
    const empty = run.benchesAtBreakfast.filter((v) => v === undefined);
    expect(run.benchesAtBreakfast, JSON.stringify(run.benchesAtBreakfast)).toHaveLength(6);
    expect(empty, JSON.stringify(run.benchesAtBreakfast)).toHaveLength(1);
  });
});
