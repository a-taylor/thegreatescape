/**
 * The item action handlers.
 *
 * Several handlers only set state that P6 will read; those are tested for the
 * writes they make, which is all the original does at this point.
 */

import { describe, expect, it } from 'vitest';

import {
  CHARACTER_PRISONER_1,
  FLAGS_CUTTING_WIRE,
  FLAGS_PICKING_LOCK,
  INPUT_KICK,
  ITEM_FLAG_POISONED,
  ITEM_RED_CROSS_PARCEL,
  KEY_ROOM_GREEN,
  KEY_ROOM_RED,
  MESSAGE_CUTTING_THE_WIRE,
  MESSAGE_INCORRECT_KEY,
  MESSAGE_IT_IS_OPEN,
  MESSAGE_PICKING_THE_LOCK,
  MESSAGE_YOU_OPEN_THE_BOX,
  PURSUIT_PURSUE,
  ROOM_BLOCKED_TUNNEL,
  ROOM_NONE,
  type ActionContext,
  actionBribe,
  actionKey,
  actionLockpick,
  actionPapers,
  actionPoison,
  actionRedCrossParcel,
  actionShovel,
  actionUniform,
  FIRST_HORIZONTAL_FENCE,
  FIRST_VERTICAL_FENCE,
  actionWiresnips,
  walls,
  createLockedDoors,
  getNearestDoor,
  redCrossParcelContentsList,
} from '../src/game/actions.js';
import {
  ITEMSTRUCT_STRIDE,
  ITEM_NONE,
  OFF_ITEM,
  OFF_ROOM,
  createItemState,
} from '../src/game/inventory.js';
import { createPlayer, scoreValue } from '../src/game/player.js';
import { createVischars } from '../src/game/vischar.js';
import { halfDoor } from '../src/game/doors.js';
import { multiplyBy4 } from '../src/game/math.js';

interface TestContext extends ActionContext {
  messages: number[];
  dropped: number[];
  sprite: 'prisoner' | 'guard';
  refreshed: number;
  blockageCleared: boolean;
  solitaryCalls: number;
  transitions: number;
}

function makeContext(over: Partial<ActionContext> = {}): TestContext {
  const vischars = createVischars();
  const ctx: TestContext = {
    items: createItemState(),
    player: createPlayer(),
    room: 1,
    hero: vischars[0]!,
    mapPosition: { x: 0, y: 0 },
    savedPos: { x: 0, y: 0, height: 0 },
    vischars,
    interiorDoors: [],
    lockedDoors: createLockedDoors(),
    redCrossParcelContents: redCrossParcelContentsList[0]!,
    playerLockedOutUntil: 0,
    bribedCharacter: 0xff,
    doorBeingLockpicked: -1,

    messages: [],
    dropped: [],
    sprite: 'prisoner',
    refreshed: 0,
    blockageCleared: false,
    solitaryCalls: 0,
    transitions: 0,

    queueMessage(index: number): void { ctx.messages.push(index); },
    dropItemTail(item: number): void { ctx.dropped.push(item); },
    setHeroSprite(sprite: 'prisoner' | 'guard'): void { ctx.sprite = sprite; },
    heroSpriteIsGuard(): boolean { return ctx.sprite === 'guard'; },
    refreshRoom(): void { ctx.refreshed++; },
    clearTunnelBlockage(): void { ctx.blockageCleared = true; },
    isTunnelBlockageCleared(): boolean { return ctx.blockageCleared; },
    solitary(): void { ctx.solitaryCalls++; },
    transitionOutsideMainGate(): void { ctx.transitions++; },
    ...over,
  };
  return ctx;
}

/**
 * Where the hero must stand for get_nearest_door to match locked_doors[entry].
 *
 * Derived from the door's own record rather than swept for or hard-coded:
 * outdoor door positions are stored quartered and door_in_range scales them
 * back up by four ($B252), so the world position IS the stored one times four.
 */
function atLockedDoor(ctx: ActionContext, entry: number): { x: number; y: number; height: number } {
  const index = ctx.lockedDoors[entry]! & 0x7f;
  const door = halfDoor(index * 2);
  return { x: multiplyBy4(door.pos.x), y: multiplyBy4(door.pos.y), height: 0 };
}

describe('action_red_cross_parcel', () => {
  it('voids the parcel itself and drops its CONTENTS ($B389, $B39D)', () => {
    const ctx = makeContext();
    ctx.items.held.set([ITEM_RED_CROSS_PARCEL, 3]);
    ctx.player.morale = 0;
    actionRedCrossParcel(ctx);

    const o = ITEM_RED_CROSS_PARCEL * ITEMSTRUCT_STRIDE;
    expect(ctx.items.structs[o + OFF_ROOM]).toBe(ROOM_NONE);
    expect([...ctx.items.held]).toEqual([ITEM_NONE, 3]);
    expect(ctx.dropped).toEqual([redCrossParcelContentsList[0]]);
    expect(ctx.messages).toEqual([MESSAGE_YOU_OPEN_THE_BOX]);
    expect(ctx.player.morale).toBe(10);
    expect(scoreValue(ctx.player)).toBe(50);
  });

  it('finds the parcel in the second slot too', () => {
    const ctx = makeContext();
    ctx.items.held.set([3, ITEM_RED_CROSS_PARCEL]);
    actionRedCrossParcel(ctx);
    expect([...ctx.items.held]).toEqual([3, ITEM_NONE]);
  });
});

describe('action_bribe', () => {
  it('bribes the first FELLOW PRISONER, skipping guards ($B3B2)', () => {
    const ctx = makeContext();
    ctx.vischars[1]!.character = 13; // a guard
    ctx.vischars[2]!.character = CHARACTER_PRISONER_1 + 1;
    actionBribe(ctx);

    expect(ctx.bribedCharacter).toBe(CHARACTER_PRISONER_1 + 1);
    expect(ctx.vischars[2]!.flags).toBe(PURSUIT_PURSUE);
    expect(ctx.vischars[1]!.flags).not.toBe(PURSUIT_PURSUE);
  });

  it('never bribes the hero, who is in slot 0 ($B3A8 starts at $8020)', () => {
    const ctx = makeContext();
    ctx.hero.character = CHARACTER_PRISONER_1 + 2;
    for (let i = 1; i < 8; i++) ctx.vischars[i]!.character = 0xff;
    actionBribe(ctx);
    expect(ctx.bribedCharacter).toBe(0xff);
  });
});

describe('action_poison', () => {
  const ITEM_FOOD = 7;

  it('poisons food in hand once, and only once ($B3D1)', () => {
    const ctx = makeContext();
    ctx.items.held.set([ITEM_FOOD, ITEM_NONE]);
    ctx.player.morale = 0;
    const attrs = new Uint8Array(20);

    actionPoison(ctx, attrs);
    const o = ITEM_FOOD * ITEMSTRUCT_STRIDE;
    expect(ctx.items.structs[o + OFF_ITEM]! & ITEM_FLAG_POISONED).toBeTruthy();
    expect(attrs[ITEM_FOOD]).toBe(0x43);
    expect(scoreValue(ctx.player)).toBe(50);

    actionPoison(ctx, attrs); // again
    expect(scoreValue(ctx.player)).toBe(50); // no second award
  });

  it('does nothing without food in hand', () => {
    const ctx = makeContext();
    ctx.items.held.set([1, 2]);
    actionPoison(ctx, new Uint8Array(20));
    expect(scoreValue(ctx.player)).toBe(0);
  });
});

describe('action_uniform', () => {
  it('swaps the hero sprite and scores, once', () => {
    const ctx = makeContext();
    ctx.player.morale = 0;
    actionUniform(ctx);
    expect(ctx.sprite).toBe('guard');
    expect(scoreValue(ctx.player)).toBe(50);

    actionUniform(ctx);
    expect(scoreValue(ctx.player)).toBe(50); // already wearing it
  });

  it('refuses in the tunnels, room 29 and above ($B3ED)', () => {
    for (const [room, expected] of [[28, 'guard'], [29, 'prisoner'], [50, 'prisoner']] as const) {
      const ctx = makeContext({ room });
      actionUniform(ctx);
      expect({ room, sprite: ctx.sprite }).toEqual({ room, sprite: expected });
    }
  });
});

describe('action_shovel', () => {
  it('clears the blockage only in room 50, and only once', () => {
    const ctx = makeContext({ room: ROOM_BLOCKED_TUNNEL });
    actionShovel(ctx);
    expect(ctx.blockageCleared).toBe(true);
    expect(ctx.refreshed).toBe(1);
    expect(scoreValue(ctx.player)).toBe(50);

    actionShovel(ctx);
    expect(ctx.refreshed).toBe(1); // already cleared
    expect(scoreValue(ctx.player)).toBe(50);
  });

  it('does nothing in any other room', () => {
    const ctx = makeContext({ room: 49 });
    actionShovel(ctx);
    expect(ctx.blockageCleared).toBe(false);
  });
});

describe('action_wiresnips', () => {
  it('returns -1 when the hero is nowhere near a fence', () => {
    const ctx = makeContext({ mapPosition: { x: 0, y: 0 } });
    expect(actionWiresnips(ctx)).toBe(-1);
    expect(ctx.messages).toEqual([]);
  });

  it('sets up the crawl when adjacent to a fence, and drops any disguise', () => {
    // Derived from the wall record, not swept for and not hard-coded: a
    // vertical fence is cut from x == maxx, anywhere in [miny, maxy).
    const fence = walls[FIRST_VERTICAL_FENCE]!;
    const at = { x: fence.maxx, y: fence.miny };

    const ctx = makeContext({ mapPosition: at });
    ctx.sprite = 'guard';
    ctx.player.gameCounter = 10;
    const dir = actionWiresnips(ctx);

    expect(dir).toBe(4); // direction_TOP_LEFT + CRAWL ($B462)
    expect(ctx.hero.direction).toBe(dir);
    expect(ctx.hero.input).toBe(INPUT_KICK);
    expect(ctx.hero.flags).toBe(FLAGS_CUTTING_WIRE);
    expect(ctx.hero.pos.height).toBe(12);
    expect(ctx.sprite).toBe('prisoner'); // $B482 -- the disguise is lost
    expect(ctx.playerLockedOutUntil).toBe((10 + 0x60) & 0xff);
    expect(ctx.messages).toEqual([MESSAGE_CUTTING_THE_WIRE]);
  });

  it('cuts from the far side too, with the opposite crawl direction ($B430)', () => {
    const fence = walls[FIRST_VERTICAL_FENCE]!;
    const ctx = makeContext({ mapPosition: { x: fence.maxx + 1, y: fence.miny } });
    expect(actionWiresnips(ctx)).toBe(6); // direction_BOTTOM_RIGHT + CRAWL
  });

  it('has fences that are all single lines, which makes $B453 moot', () => {
    // The disassembly's comment at $B453 says the second comparison is against
    // "maxy" but the instruction reads the same byte as the line above it
    // (miny). That discrepancy cannot be observed: every vertical fence has
    // minx == maxx and every horizontal fence has miny == maxy, so the two
    // readings agree on all seven fences. Recorded as a fact about the data,
    // so that if it ever stops being true the ambiguity resurfaces here.
    for (let i = 0; i < 4; i++) {
      const w = walls[FIRST_VERTICAL_FENCE + i]!;
      expect({ i, equal: w.minx === w.maxx }).toEqual({ i, equal: true });
    }
    for (let i = 0; i < 3; i++) {
      const w = walls[FIRST_HORIZONTAL_FENCE + i]!;
      expect({ i, equal: w.miny === w.maxy }).toEqual({ i, equal: true });
    }
  });

  it('cuts a horizontal fence from either side', () => {
    // The vertical fences are checked FIRST ($B41F before $B443), and two of
    // them cross this one, so pick a span of the fence no vertical fence
    // claims rather than assuming its first column is free.
    const fence = walls[FIRST_HORIZONTAL_FENCE]!;
    let x = -1;
    for (let probe = fence.minx; probe < fence.maxx; probe++) {
      const ctx = makeContext({ mapPosition: { x: probe, y: fence.miny } });
      if (actionWiresnips(ctx) === 5) { x = probe; break; }
    }
    expect(x).toBeGreaterThanOrEqual(0);

    const near = makeContext({ mapPosition: { x, y: fence.miny } });
    expect(actionWiresnips(near)).toBe(5); // TOP_RIGHT + CRAWL ($B466)

    const far = makeContext({ mapPosition: { x, y: fence.miny + 1 } });
    expect(actionWiresnips(far)).toBe(7); // BOTTOM_LEFT + CRAWL ($B46E)
  });
});

describe('get_nearest_door', () => {
  it('finds nothing when the hero is far from every locked door', () => {
    const ctx = makeContext({ room: 0, savedPos: { x: 0, y: 0, height: 0 } });
    expect(getNearestDoor(ctx)).toBe(-1);
  });

  it('runs eight indoor iterations over a nine-entry table ($B500)', () => {
    // The reproduced overrun. The eighth iteration reads locked_doors[9],
    // which is one of the two zero bytes the disassembly labels "unused", so
    // it searches for door index 0 and finds nothing. Asserted as the quirk:
    // the extra read must be harmless, not absent.
    const ctx = makeContext({ room: 5, interiorDoors: [0x00, 0xff] });
    expect(ctx.lockedDoors.length).toBe(11);
    expect(ctx.lockedDoors[9]).toBe(0);
    expect(() => getNearestDoor(ctx)).not.toThrow();
  });
});

describe('action_key', () => {
  it('opens the door when the key index matches, and says so', () => {
    const probe = makeContext();
    const savedPos = atLockedDoor(probe, 0);
    const ctx = makeContext({ room: 0, savedPos });
    expect(getNearestDoor(ctx)).toBe(0);

    // $B4C1 compares the door INDEX against the key's room number -- the game
    // conflates the two, so the "right" key for this door is its own index.
    const index = ctx.lockedDoors[0]! & 0x7f;
    actionKey(ctx, index);

    expect(ctx.lockedDoors[0]! & 0x80).toBe(0); // door_LOCKED cleared
    expect(ctx.messages).toEqual([MESSAGE_IT_IS_OPEN]);
    expect(scoreValue(ctx.player)).toBe(50);
  });

  it('says INCORRECT KEY and leaves the door locked otherwise', () => {
    const probe = makeContext();
    const ctx = makeContext({ room: 0, savedPos: atLockedDoor(probe, 0) });
    const before = ctx.lockedDoors[0]!;
    // No outdoor gate has index 22, so the red key is always wrong here.
    expect(before & 0x7f).not.toBe(KEY_ROOM_RED);

    actionKey(ctx, KEY_ROOM_RED);
    expect(ctx.lockedDoors[0]).toBe(before);
    expect(ctx.messages).toEqual([MESSAGE_INCORRECT_KEY]);
    expect(scoreValue(ctx.player)).toBe(0);
  });

  it('does nothing at all when no door is near', () => {
    const ctx = makeContext({ room: 0, savedPos: { x: 0, y: 0, height: 0 } });
    actionKey(ctx, KEY_ROOM_RED);
    expect(ctx.messages).toEqual([]);
    expect(scoreValue(ctx.player)).toBe(0);
  });

  it('the green key is for room 14 and the red for 22 ($B4B6 / $B4AE)', () => {
    expect(KEY_ROOM_RED).toBe(22);
    expect(KEY_ROOM_GREEN).toBe(14);
  });
});

describe('action_lockpick', () => {
  it('records the door and locks the player out for 255 ticks ($B49F)', () => {
    const probe = makeContext();
    const ctx = makeContext({ room: 0, savedPos: atLockedDoor(probe, 0) });
    ctx.player.gameCounter = 4;
    actionLockpick(ctx);

    expect(ctx.doorBeingLockpicked).toBe(0);
    expect(ctx.hero.flags).toBe(FLAGS_PICKING_LOCK);
    expect(ctx.playerLockedOutUntil).toBe((4 + 0xff) & 0xff);
    expect(ctx.messages).toEqual([MESSAGE_PICKING_THE_LOCK]);
  });

  it('does nothing when no door is near', () => {
    const ctx = makeContext({ room: 0, savedPos: { x: 0, y: 0, height: 0 } });
    actionLockpick(ctx);
    expect(ctx.doorBeingLockpicked).toBe(-1);
    expect(ctx.messages).toEqual([]);
  });
});

describe('action_papers', () => {
  const inside = { x: 0x6a, y: 0x4a };

  it('sends the hero to solitary when not in uniform ($EFE5)', () => {
    const ctx = makeContext({ mapPosition: inside });
    actionPapers(ctx);
    expect(ctx.solitaryCalls).toBe(1);
    expect(ctx.transitions).toBe(0);
  });

  it('transports him out of the gate when in uniform', () => {
    const ctx = makeContext({ mapPosition: inside });
    ctx.sprite = 'guard';
    ctx.player.morale = 0;
    actionPapers(ctx);
    expect(ctx.transitions).toBe(1);
    expect(ctx.hero.room).toBe(0);
    expect(scoreValue(ctx.player)).toBe(50);
  });

  it('does nothing away from the main gate, and the top edge is exclusive', () => {
    for (const p of [{ x: 0x68, y: 0x4a }, { x: 0x6d, y: 0x4a }, { x: 0x6a, y: 0x4b }]) {
      const ctx = makeContext({ mapPosition: p });
      ctx.sprite = 'guard';
      actionPapers(ctx);
      expect({ p, solitary: ctx.solitaryCalls, out: ctx.transitions }).toEqual({
        p, solitary: 0, out: 0,
      });
    }
  });
});
