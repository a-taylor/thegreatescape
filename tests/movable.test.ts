/**
 * The stove and crate: pushable along one axis ($B071..$B0B8).
 */

import { describe, expect, it } from 'vitest';

import {
  FIRST_MOVABLE_CHARACTER,
  createMovable,
  installMovable,
  isMovableCharacter,
  movableByRoom,
  movableForRoom,
  movableItems,
  movableRange,
  pushMovable,
  refreshMovableIso,
} from '../src/game/movable.js';
import { spritesData } from '../src/data/load.js';
import { createVischars } from '../src/game/vischar.js';
import { calcIsoPos } from '../src/game/coords.js';

describe('movable item data', () => {
  it('is three items, one per room', () => {
    // setup_movable_items ($693C..$6958): room 2 -> stove1, 4 -> stove2,
    // 9 -> crate. No other room has one.
    expect(Object.keys(movableItems).sort()).toEqual(['crate', 'stove1', 'stove2']);
    expect(movableByRoom).toEqual({ '2': 'stove1', '4': 'stove2', '9': 'crate' });
  });

  it('uses characters 26, 27 and 28', () => {
    expect(movableItems.stove1!.character).toBe(26);
    expect(movableItems.stove2!.character).toBe(27);
    expect(movableItems.crate!.character).toBe(28);
  });

  it('recognises movables by a single threshold, as the routine does', () => {
    // $B074 CP $1A -- one comparison, not a list, which is why the three
    // characters are numbered contiguously at the end of the range.
    expect(FIRST_MOVABLE_CHARACTER).toBe(26);
    expect(isMovableCharacter(25)).toBe(false);
    expect(isMovableCharacter(26)).toBe(true);
    expect(isMovableCharacter(28)).toBe(true);
  });

  it('moves stoves on Y and the crate on X', () => {
    expect(movableItems.stove1!.axis).toBe('y');
    expect(movableItems.stove2!.axis).toBe('y');
    expect(movableItems.crate!.axis).toBe('x');
  });

  it('has the ranges the immediates give', () => {
    // $B07F LD BC,$0723 -- range 7, centre 35 for the stove.
    // $B08B LD C,$36    -- centre 54 for the crate.
    expect(movableRange(movableItems.stove1!)).toEqual({ min: 28, max: 42 });
    expect(movableRange(movableItems.crate!)).toEqual({ min: 47, max: 61 });
  });

  it('points at its own sprite, resolved to an index', () => {
    // $69B4 DEFW $CE22 (sprite_stove), $69BD DEFW $CE28 (sprite_crate). The
    // sprites array starts at $CE22 with 6-byte records, so those are 0 and 1.
    expect(movableItems.stove1!.spriteAddr).toBe('$CE22');
    expect(movableItems.crate!.spriteAddr).toBe('$CE28');
    expect(movableItems.stove1!.spriteIndex).toBe(0);
    expect(movableItems.stove2!.spriteIndex).toBe(0);
    expect(movableItems.crate!.spriteIndex).toBe(1);
    expect(spritesData.sprites[0]!.bitmapLabels).toContain('bitmap_stove');
    expect(spritesData.sprites[1]!.bitmapLabels).toContain('bitmap_crate');
  });

  it("stores zero in the record's ninth byte", () => {
    // The struct's trailing `byte index` is the vischar animation index, not a
    // sprite selector -- an easy field to misread, since it sits next to the
    // sprite pointer. All three movables store 0.
    for (const item of Object.values(movableItems)) expect(item.animIndex).toBe(0);
  });

  it('is absent from rooms that have none', () => {
    expect(movableForRoom(2)).toBeDefined();
    expect(movableForRoom(4)).toBeDefined();
    expect(movableForRoom(9)).toBeDefined();
    expect(movableForRoom(1)).toBeUndefined();
    expect(movableForRoom(0)).toBeUndefined();
  });
});

describe('pushing a stove (Y axis, centre 35)', () => {
  const fresh = (y: number) => {
    const s = createMovable(movableItems.stove1!);
    s.pos.y = y;
    return s;
  };

  it('direction 0 centres it from either side', () => {
    // "The player is pushing the movable item from its front, so centre it."
    const above = fresh(40);
    pushMovable(above, 0);
    expect(above.pos.y).toBe(39);

    const below = fresh(30);
    pushMovable(below, 0);
    expect(below.pos.y).toBe(31);
  });

  it('direction 0 does nothing once centred', () => {
    const at = fresh(35);
    pushMovable(at, 0);
    expect(at.pos.y).toBe(35);
  });

  it('direction 1 steps toward the maximum and stops there', () => {
    const s = fresh(41);
    pushMovable(s, 1);
    expect(s.pos.y).toBe(42);
    pushMovable(s, 1);
    expect(s.pos.y).toBe(42); // clamped
  });

  it('direction 3 steps toward the minimum and stops there', () => {
    const s = fresh(29);
    pushMovable(s, 3);
    expect(s.pos.y).toBe(28);
    pushMovable(s, 3);
    expect(s.pos.y).toBe(28); // clamped
  });

  it('direction 2 snaps straight to the minimum', () => {
    // $B0AD..$B0AF sets the position outright rather than stepping. The
    // disassembly notes this "never seems to happen in practice in the game",
    // but it is what the code does.
    const s = fresh(42);
    pushMovable(s, 2);
    expect(s.pos.y).toBe(28);
  });

  it('never leaves its axis', () => {
    const s = fresh(35);
    const { x, height } = s.pos;
    for (const d of [0, 1, 2, 3]) pushMovable(s, d);
    expect(s.pos.x).toBe(x);
    expect(s.pos.height).toBe(height);
  });

  it('stays within range however much it is pushed', () => {
    const { min, max } = movableRange(movableItems.stove1!);
    const s = fresh(35);
    for (let i = 0; i < 40; i++) {
      pushMovable(s, i % 4);
      expect(s.pos.y).toBeGreaterThanOrEqual(min);
      expect(s.pos.y).toBeLessThanOrEqual(max);
    }
  });
});

describe('pushing the crate (X axis, centre 54)', () => {
  const fresh = (x: number) => {
    const s = createMovable(movableItems.crate!);
    s.pos.x = x;
    return s;
  };

  it('swaps the direction pairs before responding', () => {
    // $B08D XOR $01 -- "swap axis left<=>right". So the crate answers direction
    // 1 the way a stove answers direction 0, and vice versa.
    const s = fresh(60);
    pushMovable(s, 1); // behaves as a stove's direction 0: centre it
    expect(s.pos.x).toBe(59);

    const t = fresh(60);
    pushMovable(t, 0); // behaves as direction 1: toward the maximum
    expect(t.pos.x).toBe(61);
  });

  it('pushes on X, not Y', () => {
    const s = fresh(54);
    const { y, height } = s.pos;
    pushMovable(s, 0);
    expect(s.pos.x).not.toBe(54);
    expect(s.pos.y).toBe(y);
    expect(s.pos.height).toBe(height);
  });

  it('respects its own range of 47..61', () => {
    const { min, max } = movableRange(movableItems.crate!);
    expect(min).toBe(47);
    expect(max).toBe(61);
    const s = fresh(61);
    pushMovable(s, 0); // toward the maximum, already there
    expect(s.pos.x).toBe(61);
  });
});

describe('installing a movable into vischar 1', () => {
  it('shares the position object rather than copying it', () => {
    // This is a contract, not an incidental detail. setup_movable_item ($697D)
    // copies the movable's data INTO the vischar, and from then on the vischar
    // is the single source of truth. Modelling that as a shared reference means
    // pushMovable's writes are visible through the slot with no sync step.
    //
    // The failure it guards against: a caller that re-creates the movable state
    // after installing it leaves the slot pointing at the old object, so pushes
    // mutate one position while the renderer draws the other and the stove
    // looks immovable.
    const state = createMovable(movableItems.stove1!);
    const slot = createVischars()[1]!;
    installMovable(slot, state, 2);

    expect(slot.pos).toBe(state.pos);

    pushMovable(state, 1);
    expect(slot.pos.y).toBe(state.pos.y);
  });

  it('fills in everything purge and the renderer read', () => {
    const state = createMovable(movableItems.crate!);
    const slot = createVischars()[1]!;
    installMovable(slot, state, 9);

    expect(slot.character).toBe(movableItems.crate!.character);
    expect(slot.room).toBe(9); // $6996
    expect(slot.spriteIndex).toBe(movableItems.crate!.spriteIndex);
    expect(slot.isoPos).toEqual(calcIsoPos(state.pos)); // $699C
    expect(slot.flags).toBe(0);
  });

  it('keeps the projection current across a push', () => {
    const state = createMovable(movableItems.stove1!);
    const slot = createVischars()[1]!;
    installMovable(slot, state, 2);

    for (let i = 0; i < 5; i++) {
      pushMovable(state, 1);
      refreshMovableIso(slot);
      expect(slot.isoPos).toEqual(calcIsoPos(state.pos));
    }
  });
});
