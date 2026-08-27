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
import {
  VISCHAR_DRAWABLE,
  createVischars,
  isEmpty,
  npcSlots,
} from '../src/game/vischar.js';
import { purgeInvisibleCharacters, spawnCharacters } from '../src/game/spawn.js';
import {
  FLAGS_TARGET_IS_DOOR,
  characterBehaviour,
  getTargetAssignPos,
  targetReached,
} from '../src/game/behaviour.js';
import { animateVischar } from '../src/game/animate.js';
import { moveCharacter, nextCharacterIndex } from '../src/game/move.js';
import {
  TICKS_PER_CLOCK,
  createSchedule,
  dispatchTimedEvent,
  heroSleeps,
  setHeroRoute,
} from '../src/game/schedule.js';
import { Prng } from '../src/game/prng.js';
import {
  createAutomaticState,
  heroIsAutomatic,
  noteInput,
} from '../src/game/events.js';
import {
  HERO_STANDING_HEIGHT,
  animations,
  createHero,
  step,
} from '../src/game/hero.js';
import { ExteriorView } from '../src/render/exterior.js';
import { isoPlacement, resetOutdoorPosition } from '../src/render/place.js';
import { vischarVisible } from '../src/render/clip.js';
import { roomsData } from '../src/data/load.js';
import { INTERIOR_MAP_POSITION, halfDoors } from '../src/game/doors.js';
import { BYTE7_Y_DOMINANT } from '../src/game/vischar.js';

/** The room state interior_bounds_check needs, per room. */
function interiorBounds(room: number) {
  if (room === 0) return undefined;
  const def = roomsData.roomdefs[roomsData.rooms[room - 1]!.roomdefIndex]!;
  return { boundsIndex: def.dimensionsIndex, objectBounds: def.bounds };
}

interface Sample {
  offWindow: number;
  roomChanges: number;
  heroMoves: number;
  firstFailure: string;
}

/** One run of the demo loop with the player idle throughout. */
function runIdle(ticks: number): Sample {
  const prng = new Prng();
  const random = () => prng.next();
  const structs = characterStructs();
  const vischars = createVischars();
  const heroSlot = vischars[0]!;
  heroSlot.character = 0;
  heroSlot.flags = 0;

  const START = { x: 100 * 8, y: 74 * 8, height: HERO_STANDING_HEIGHT };
  const hero = createHero({ ...START }, 2, 0);
  const start = resetOutdoorPosition(START);
  const view = new ExteriorView(start.x, start.y);
  view.position.x = INTERIOR_MAP_POSITION.x; view.position.y = INTERIOR_MAP_POSITION.y;
  const schedule = createSchedule(); // asleep in hut 2, as reset_game leaves him
  heroSleeps(schedule, heroSlot, hero.pos);
  const automatic = createAutomaticState();

  const out: Sample = {
    offWindow: 0,
    roomChanges: 0,
    heroMoves: 0,
    firstFailure: '',
  };
  let moveIndex = 0;
  let frame = 0;

  for (let t = 0; t < ticks; t++) {
    noteInput(automatic, 0);

    let input = 0;
    if (heroIsAutomatic(automatic)) {
      heroSlot.pos = { ...hero.pos };
      heroSlot.room = hero.room;
      // counter_and_flags is one byte in the game and has to travel both ways.
      heroSlot.counterAndFlags = hero.counterAndFlags;
      characterBehaviour(heroSlot, { random, structs, room: hero.room });
      hero.counterAndFlags = heroSlot.counterAndFlags;
      input = heroSlot.input & 0x0f;
    }
    const outcome = step(hero, input, interiorBounds(hero.room));
    if (outcome.moved) out.heroMoves++;

    moveIndex = nextCharacterIndex(moveIndex);
    const mover = structs[moveIndex];
    if (mover) moveCharacter(mover, { random });

    for (const v of npcSlots(vischars)) {
      if (!isEmpty(v)) characterBehaviour(v, { random, structs, room: hero.room });
    }
    purgeInvisibleCharacters(vischars, structs, view.position, hero.room);
    spawnCharacters(vischars, structs, view.position, hero.room, { random });
    for (const v of npcSlots(vischars)) {
      v.counterAndFlags &= ~VISCHAR_DRAWABLE & 0xff;
    }
    for (const v of npcSlots(vischars)) {
      if (!isEmpty(v)) animateVischar(v, { interior: interiorBounds(v.room) });
    }

    if (outcome.enteredRoom !== null) {
      out.roomChanges++;
      if (outcome.enteredRoom === 0) {
        const m = resetOutdoorPosition(hero.pos);
        view.position.x = m.x;
        view.position.y = m.y;
      } else {
        view.position.x = INTERIOR_MAP_POSITION.x;
        view.position.y = INTERIOR_MAP_POSITION.y;
      }
      view.moveMapY = 0;
      view.refresh();
    } else if (hero.room === 0 && outcome.moved) {
      view.moveMap(animations[hero.animation]?.header[3] ?? 0xff, hero.reverse);
    }

    frame = (frame + 1) & 0xff;
    if ((frame & (TICKS_PER_CLOCK - 1)) === 0) {
      dispatchTimedEvent(schedule, {
        structs,
        vischars,
        random,
        room: hero.room,
        hero: heroSlot,
        heroPos: hero.pos,
      });
    }

    const iso = isoPlacement(hero.pos);
    const visible = vischarVisible(
      {
        isoXBytes: iso.column,
        isoYPixels: iso.pixelRow,
        widthBytesPlusOne: 3,
        height: 27,
      },
      view.position,
    ).visible;

    // While he is in bed his position is zeroed and he is inside the bed
    // graphic, so not being drawn is correct ($A498). Only count frames where
    // he is supposed to be on screen.
    if (!visible && !schedule.heroInBed) {
      out.offWindow++;
      if (!out.firstFailure) {
        out.firstFailure =
          `t=${t} hero tiny(${hero.pos.x >> 3},${hero.pos.y >> 3}) ` +
          `room ${hero.room} map(${view.position.x},${view.position.y}) ` +
          `clock ${schedule.clock} route(${heroSlot.route.index},${heroSlot.route.step})`;
      }
    }
  }
  return out;
}

describe('the hero on autopilot', () => {
  const run = runIdle(6000);

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
