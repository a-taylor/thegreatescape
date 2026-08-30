/**
 * picking_lock ($9E98) and cutting_wire ($9EB2).
 *
 * P5's action handlers arm these; these run them out. One of the assertions
 * pins a reproduced bug rather than the sensible behaviour.
 */

import { describe, expect, it } from 'vitest';

import {
  CUTTING_WIRE_INPUTS,
  FLAGS_CUTTING_WIRE,
  FLAGS_PICKING_LOCK,
  INPUT_KICK,
  MESSAGE_IT_IS_OPEN,
  STANDING_HEIGHT_AFTER_CUT,
  WORKING_AUTOMATIC_DELAY,
  clearWorkingFlags,
  cuttingWire,
  pickingLock,
  runWorkingTimers,
} from '../src/game/timers.js';
import { createVischars } from '../src/game/vischar.js';
import { createLockedDoors } from '../src/game/actions.js';

function ctx(over: Record<string, unknown> = {}) {
  const hero = createVischars()[0]!;
  hero.character = 0;
  hero.flags = 0;
  hero.direction = 2;
  hero.input = 0;
  hero.pos = { x: 0, y: 0, height: 12 };
  const queued: number[] = [];
  return {
    queued,
    hero,
    ctx: {
      gameCounter: 100,
      lockedOutUntil: 100,
      hero,
      lockedDoors: createLockedDoors(),
      doorBeingLockpicked: 2,
      queueMessage: (i: number) => queued.push(i),
      ...over,
    },
  };
}

describe('picking_lock', () => {
  it('waits for EQUALITY with the game counter, not for it to pass ($9E9F)', () => {
    // The counter is a byte and wraps, so "past the deadline" never happens --
    // action_lockpick's `+ $FF` is one short of a full wrap so the equality
    // lands. A `>=` test here would open the door immediately.
    const early = ctx({ gameCounter: 99, lockedOutUntil: 100 });
    expect(pickingLock(early.ctx)).toBe(false);

    const late = ctx({ gameCounter: 101, lockedOutUntil: 100 });
    expect(pickingLock(late.ctx)).toBe(false);

    const now = ctx({ gameCounter: 100, lockedOutUntil: 100 });
    expect(pickingLock(now.ctx)).toBe(true);
  });

  it('unlocks the door being picked, and says so', () => {
    const { ctx: c, queued } = ctx();
    c.lockedDoors[2] = 0x80 | 12; // locked
    expect(pickingLock(c)).toBe(true);
    expect(c.lockedDoors[2]! & 0x80).toBe(0);
    expect(c.lockedDoors[2]! & 0x7f).toBe(12); // the index survives
    expect(queued).toEqual([MESSAGE_IT_IS_OPEN]);
  });

  it('clears both working flags but leaves the others ($9EAE AND $FC)', () => {
    const { hero } = ctx();
    hero.flags = FLAGS_PICKING_LOCK | 0x40 | 0x80; // + TARGET_IS_DOOR, NO_COLLIDE
    clearWorkingFlags(hero);
    expect(hero.flags).toBe(0xc0);
  });
});

describe('cutting_wire', () => {
  it('does nothing while more than three turns remain ($9EBD)', () => {
    const { ctx: c, hero } = ctx({ gameCounter: 100, lockedOutUntil: 104 });
    expect(cuttingWire(c)).toBe(false);
    expect(hero.input).toBe(0);
    expect(hero.flags).toBe(0);
  });

  it('walks him THROUGH the gap over the last three turns ($9EBE)', () => {
    for (let remaining = 1; remaining <= 3; remaining++) {
      const { ctx: c, hero } = ctx({ gameCounter: 100, lockedOutUntil: 100 + remaining });
      hero.direction = 2;
      expect(cuttingWire(c)).toBe(false);
      expect(hero.input).toBe(CUTTING_WIRE_INPUTS[2]);
    }
  });

  it('picks the input by direction, and every one carries input_KICK', () => {
    for (let dir = 0; dir < 4; dir++) {
      const { ctx: c, hero } = ctx({ gameCounter: 100, lockedOutUntil: 101 });
      hero.direction = dir;
      cuttingWire(c);
      expect(hero.input).toBe(CUTTING_WIRE_INPUTS[dir]);
      expect(hero.input & INPUT_KICK).toBe(INPUT_KICK);
    }
  });

  it('completes on equality, standing him back up', () => {
    const { ctx: c, hero } = ctx({ gameCounter: 100, lockedOutUntil: 100 });
    hero.flags = FLAGS_CUTTING_WIRE;
    expect(cuttingWire(c)).toBe(true);
    expect(hero.input).toBe(INPUT_KICK);
    expect(hero.pos.height).toBe(STANDING_HEIGHT_AFTER_CUT);
    expect(hero.flags & 0x03).toBe(0);
  });

  it('always faces him TOP_LEFT afterwards -- the missing LD A,(HL) ($9ED0)', () => {
    // Reproduced, not fixed. The disassembly: "an LD A,(HL) instruction is
    // missing here. A is always zero at this point, so $800E is always set to
    // zero. The hero will always face top-left after breaking through a
    // fence." The DOS port hardcodes the same thing. Asserted as the quirk --
    // a test expecting the direction to be preserved would read as
    // confirmation that we got it right.
    for (let dir = 0; dir < 4; dir++) {
      const { ctx: c, hero } = ctx({ gameCounter: 100, lockedOutUntil: 100 });
      hero.direction = dir;
      cuttingWire(c);
      expect({ dir, after: hero.direction }).toEqual({ dir, after: 0 });
    }
  });
});

describe('the lock-out branch of process_player_input', () => {
  it('takes over the frame entirely while either flag is set ($9E13)', () => {
    const idle = ctx();
    expect(runWorkingTimers(idle.ctx, () => {})).toBe(false);

    const busy = ctx();
    busy.hero.flags = FLAGS_CUTTING_WIRE;
    expect(runWorkingTimers(busy.ctx, () => {})).toBe(true);
  });

  it('postpones automatic control for 31 turns while he works ($9E18)', () => {
    const { ctx: c, hero } = ctx();
    hero.flags = FLAGS_PICKING_LOCK;
    const postponed: number[] = [];
    runWorkingTimers(c, (t) => postponed.push(t));
    expect(postponed).toEqual([WORKING_AUTOMATIC_DELAY]);
  });

  it('routes to the right timer for each flag ($9E1C / $9E1F)', () => {
    const lock = ctx({ gameCounter: 100, lockedOutUntil: 100 });
    lock.hero.flags = FLAGS_PICKING_LOCK;
    runWorkingTimers(lock.ctx, () => {});
    expect(lock.queued).toEqual([MESSAGE_IT_IS_OPEN]); // picking_lock ran

    const cut = ctx({ gameCounter: 100, lockedOutUntil: 100 });
    cut.hero.flags = FLAGS_CUTTING_WIRE;
    runWorkingTimers(cut.ctx, () => {});
    expect(cut.queued).toEqual([]); // cutting_wire queues nothing
    expect(cut.hero.pos.height).toBe(STANDING_HEIGHT_AFTER_CUT);
  });
});
