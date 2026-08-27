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
import { characterBehaviour } from '../src/game/behaviour.js';
import { animateVischar } from '../src/game/animate.js';
import { moveCharacter, nextCharacterIndex } from '../src/game/move.js';
import {
  TICKS_PER_CLOCK,
  createSchedule,
  dispatchTimedEvent,
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
import { INTERIOR_MAP_POSITION } from '../src/game/doors.js';

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
  const hero = createHero({ ...START }, 0, 0);
  const start = resetOutdoorPosition(START);
  const view = new ExteriorView(start.x, start.y);
  const schedule = createSchedule(false); // the demo starts him standing
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
      characterBehaviour(heroSlot, { random, structs, room: hero.room });
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

    if (!visible) {
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
