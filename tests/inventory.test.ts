/**
 * Pick up, drop and use.
 *
 * The cases worth pinning are the ones where the obvious implementation
 * differs: the first-pick-up-only score, the two different drop heights and
 * projections, and find_nearby_item's item-order (not nearest) scan.
 */

import { describe, expect, it } from 'vitest';

import {
  HELD_SLOTS,
  ITEMSTRUCT_STRIDE,
  ITEM_NONE,
  ITEM_UNIFORM,
  OFF_HEIGHT,
  OFF_ISO_X,
  OFF_ISO_Y,
  OFF_ROOM,
  OFF_X,
  OFF_Y,
  allItemStructs,
  createItemState,
  dropItem,
  dropItemTail,
  findNearbyItem,
  markNearbyItems,
  pickUpItem,
  processPlayerInputFire,
  readItemStruct,
  useItem,
} from '../src/game/inventory.js';
import { ITEM_COUNT, NEARBY_6, NEARBY_7, itemStructs } from '../src/game/items.js';
import { createPlayer, scoreValue } from '../src/game/player.js';
import { INPUT_FIRE, encodeInput } from '../src/game/hero.js';
import { heroMapPosition, tinyposStash } from '../src/game/coords.js';
import { calcExteriorItemIsoPos, calcInteriorItemIsoPos } from '../src/game/coords.js';

/** Put item `i` at map position (x, y) and flag it nearby. */
function placeNearby(s: ReturnType<typeof createItemState>, i: number, x: number, y: number) {
  const o = i * ITEMSTRUCT_STRIDE;
  s.structs[o + OFF_ROOM] = NEARBY_7 | NEARBY_6;
  s.structs[o + OFF_X] = x;
  s.structs[o + OFF_Y] = y;
}

describe('item state', () => {
  it('starts with two empty hands', () => {
    const s = createItemState();
    expect([...s.held]).toEqual([ITEM_NONE, ITEM_NONE]);
    expect(s.held).toHaveLength(HELD_SLOTS);
  });

  it('round-trips the shipped table through the byte owner', () => {
    const s = createItemState();
    const view = allItemStructs(s);
    expect(view).toHaveLength(ITEM_COUNT);
    // The decode must agree with the data-only decoder for the initial state.
    expect(view).toEqual(itemStructs());
  });
});

describe('find_nearby_item', () => {
  it('returns the lowest item index in range, not the nearest ($7C82)', () => {
    const s = createItemState();
    for (let i = 0; i < ITEM_COUNT; i++) s.structs[i * ITEMSTRUCT_STRIDE + OFF_ROOM] = 0;
    placeNearby(s, 9, 100, 100); // exactly on the hero
    placeNearby(s, 4, 101, 101); // one away, but a lower index

    expect(findNearbyItem(s, { x: 100, y: 100 }, 1)).toBe(4);
  });

  it('uses a radius of one outdoors and six indoors', () => {
    const s = createItemState();
    for (let i = 0; i < ITEM_COUNT; i++) s.structs[i * ITEMSTRUCT_STRIDE + OFF_ROOM] = 0;
    placeNearby(s, 3, 104, 100);

    expect(findNearbyItem(s, { x: 100, y: 100 }, 0)).toBe(-1); // outdoors, radius 1
    expect(findNearbyItem(s, { x: 100, y: 100 }, 5)).toBe(3); // indoors, radius 6
  });

  it('ignores items without the nearby flag', () => {
    const s = createItemState();
    for (let i = 0; i < ITEM_COUNT; i++) s.structs[i * ITEMSTRUCT_STRIDE + OFF_ROOM] = 0;
    placeNearby(s, 3, 100, 100);
    s.structs[3 * ITEMSTRUCT_STRIDE + OFF_ROOM] = 0;
    expect(findNearbyItem(s, { x: 100, y: 100 }, 1)).toBe(-1);
  });
});

describe('pick_up_item', () => {
  const setup = () => {
    const s = createItemState();
    for (let i = 0; i < ITEM_COUNT; i++) s.structs[i * ITEMSTRUCT_STRIDE + OFF_ROOM] = 0;
    placeNearby(s, 5, 100, 100);
    return { s, player: createPlayer() };
  };

  it('fills the first empty slot and makes the item vanish', () => {
    const { s, player } = setup();
    expect(pickUpItem(s, player, { x: 100, y: 100 }, 1)).toBe(5);
    expect([...s.held]).toEqual([5, ITEM_NONE]);

    const struct = readItemStruct(s, 5);
    expect(struct.room).toBe(0);
    expect(struct.isoPos).toEqual({ x: 0, y: 0 });
    expect(struct.held).toBe(true);
  });

  it('awards 5 morale and 5 points on the FIRST pick-up only ($7B70)', () => {
    const { s, player } = setup();
    player.morale = 0;
    pickUpItem(s, player, { x: 100, y: 100 }, 1);
    expect(player.morale).toBe(5);
    expect(scoreValue(player)).toBe(5);

    // Drop it back and take it again: the HELD flag is sticky.
    dropItem(s, 1, { x: 100, y: 100, height: 0 });
    placeNearby(s, 5, 100, 100);
    pickUpItem(s, player, { x: 100, y: 100 }, 1);
    expect(player.morale).toBe(5);
    expect(scoreValue(player)).toBe(5);
  });

  it('refuses when both hands are full', () => {
    const { s, player } = setup();
    s.held.set([1, 2]);
    expect(pickUpItem(s, player, { x: 100, y: 100 }, 1)).toBe(-1);
  });

  it('takes a second item into the second slot', () => {
    const { s, player } = setup();
    s.held.set([1, ITEM_NONE]);
    pickUpItem(s, player, { x: 100, y: 100 }, 1);
    expect([...s.held]).toEqual([1, 5]);
  });
});

describe('drop_item', () => {
  it('drops the first item and shuffles the second down ($7BA0)', () => {
    const s = createItemState();
    s.held.set([3, 8]);
    expect(dropItem(s, 1, { x: 20, y: 30, height: 0 })).toBe(3);
    expect([...s.held]).toEqual([8, ITEM_NONE]);
  });

  it('does nothing with empty hands', () => {
    const s = createItemState();
    expect(dropItem(s, 1, { x: 20, y: 30, height: 0 })).toBe(-1);
  });

  it('resets the hero sprite when the uniform is dropped ($7B96)', () => {
    const s = createItemState();
    s.held.set([ITEM_UNIFORM, ITEM_NONE]);
    let reset = 0;
    dropItem(s, 1, { x: 20, y: 30, height: 0 }, () => reset++);
    expect(reset).toBe(1);

    // Any other item leaves the sprite alone.
    s.held.set([3, ITEM_NONE]);
    dropItem(s, 1, { x: 20, y: 30, height: 0 }, () => reset++);
    expect(reset).toBe(1);
  });
});

describe('drop_item_tail', () => {
  it('uses height 0 and the exterior projection outdoors ($7BCC)', () => {
    const s = createItemState();
    const heroPos = { x: 0x0400, y: 0x0300, height: 0x0020 };
    dropItemTail(s, 2, 0, heroPos);

    const o = 2 * ITEMSTRUCT_STRIDE;
    expect(s.structs[o + OFF_ROOM]).toBe(0);
    expect(s.structs[o + OFF_HEIGHT]).toBe(0);
    // World scale divided by 8, not copied across.
    expect(s.structs[o + OFF_X]).toBe(0x80);
    expect(s.structs[o + OFF_Y]).toBe(0x60);

    const iso = calcExteriorItemIsoPos({ x: 0x80, y: 0x60, height: 0 });
    expect(s.structs[o + OFF_ISO_X]).toBe(iso.x);
    expect(s.structs[o + OFF_ISO_Y]).toBe(iso.y);
  });

  it('uses height 5 and the interior projection indoors ($7BF0)', () => {
    const s = createItemState();
    // Indoors mi.pos is already tinypos-scale -- 62, 35 is the stove's record.
    const heroPos = { x: 62, y: 35, height: 16 };
    dropItemTail(s, 2, 5, heroPos);

    const o = 2 * ITEMSTRUCT_STRIDE;
    expect(s.structs[o + OFF_ROOM]).toBe(5);
    expect(s.structs[o + OFF_HEIGHT]).toBe(5);
    expect(s.structs[o + OFF_X]).toBe(62); // copied, not divided
    expect(s.structs[o + OFF_Y]).toBe(35);

    const iso = calcInteriorItemIsoPos({ x: 62, y: 35, height: 5 });
    expect(s.structs[o + OFF_ISO_X]).toBe(iso.x);
    expect(s.structs[o + OFF_ISO_Y]).toBe(iso.y);
  });

  it('the two projections genuinely disagree', () => {
    // If they ever coincide, the tests above stop discriminating.
    const p = { x: 62, y: 35, height: 5 };
    expect(calcExteriorItemIsoPos(p)).not.toEqual(calcInteriorItemIsoPos(p));
  });
});

describe('use_item', () => {
  it('dispatches on the held item and saves the hero position ($7B0A)', () => {
    const s = createItemState();
    s.held.set([6, 9]);
    const heroPos = { x: 111, y: 222, height: 33 };
    const savedPos = { x: 0, y: 0, height: 0 };
    const used: number[] = [];

    expect(useItem(s, 0, heroPos, savedPos, { 6: (i) => used.push(i) })).toBe(6);
    expect(used).toEqual([6]);
    expect(savedPos).toEqual({ x: 111, y: 222, height: 33 });

    expect(useItem(s, 1, heroPos, savedPos, { 9: (i) => used.push(i) })).toBe(9);
    expect(used).toEqual([6, 9]);
  });

  it('does nothing for an empty slot', () => {
    const s = createItemState();
    const savedPos = { x: 0, y: 0, height: 0 };
    expect(useItem(s, 0, { x: 1, y: 2, height: 3 }, savedPos, {})).toBe(-1);
    expect(savedPos).toEqual({ x: 0, y: 0, height: 0 });
  });

  it('is a no-op for the items whose jump-table entry is a bare RET', () => {
    const s = createItemState();
    s.held.set([4, ITEM_NONE]); // torch -> $7AEF RET
    const savedPos = { x: 0, y: 0, height: 0 };
    expect(useItem(s, 0, { x: 1, y: 2, height: 3 }, savedPos, {})).toBe(4);
    // The position copy still happens -- it is before the dispatch.
    expect(savedPos).toEqual({ x: 1, y: 2, height: 3 });
  });
});

describe('process_player_input_fire', () => {
  const base = () => {
    const s = createItemState();
    for (let i = 0; i < ITEM_COUNT; i++) s.structs[i * ITEMSTRUCT_STRIDE + OFF_ROOM] = 0;
    placeNearby(s, 5, 100, 100);
    return {
      s,
      ctx: {
        player: createPlayer(),
        room: 1,
        mapPosition: { x: 100, y: 100 },
        heroPos: { x: 100, y: 100, height: 0 },
        savedPos: { x: 0, y: 0, height: 0 },
        actions: {} as Record<number, (item: number) => void>,
      },
    };
  };

  it('maps the four fire inputs to the four commands ($7AC9)', () => {
    const { s, ctx } = base();
    expect(processPlayerInputFire(s, 0x0a, ctx)).toEqual({ command: 'pick up', item: 5 });
    expect(processPlayerInputFire(s, 0x0b, ctx)).toEqual({ command: 'drop', item: 5 });

    s.held.set([6, 7]);
    expect(processPlayerInputFire(s, 0x0c, ctx)?.command).toBe('use A');
    expect(processPlayerInputFire(s, 0x0f, ctx)?.command).toBe('use B');
  });

  it('ignores fire alone and every fire diagonal', () => {
    // $7AC9 tests only $0A, $0B, $0C and $0F. Fire alone (9) and the four
    // diagonals (13, 14, 16, 17) fall through to the RET at $7AEF. Asserted
    // because it is a real gameplay quirk: holding two arrows when you press
    // fire silently does nothing.
    const { s, ctx } = base();
    for (const input of [0x09, 0x0d, 0x0e, 0x10, 0x11]) {
      expect({ input, r: processPlayerInputFire(s, input, ctx) }).toEqual({ input, r: null });
    }
    expect([...s.held]).toEqual([ITEM_NONE, ITEM_NONE]); // nothing happened
  });

  it('encodeInput produces exactly the values the routine tests for', () => {
    // The two halves have to agree or the commands are unreachable. This is
    // the join between src/game/hero.ts and $7AC9.
    expect(encodeInput(true, false, false, false, true)).toBe(0x0a); // fire + up
    expect(encodeInput(false, true, false, false, true)).toBe(0x0b); // fire + down
    expect(encodeInput(false, false, true, false, true)).toBe(0x0c); // fire + left
    expect(encodeInput(false, false, false, true, true)).toBe(0x0f); // fire + right
  });

  it('leaves movement to a separate input, since fire becomes KICK ($9E8D)', () => {
    // A fire command must not also walk the hero. lookupAnimation takes
    // `input % 9`, so passing fire+up (10) straight through would read as
    // plain up (1) and move him a step while picking something up.
    expect(0x0a % 9).toBe(1);
    expect(INPUT_FIRE).toBe(9);
  });
});

describe('hero_map_position is not map_position', () => {
  it('scales outdoors and copies low bytes indoors ($9F2E / $9F49)', () => {
    // $81B8 is the hero's own tinypos; $81BB, two bytes later, is the view
    // scroll. The item range checks read the FORMER. Outdoors it is the
    // vischar position divided by 8 with rounding; indoors mi.pos is already
    // tinypos-scale and only the low byte is copied.
    const outdoor = { x: 0x0400, y: 0x0300, height: 0x0020 };
    expect(heroMapPosition(outdoor, true)).toEqual({ x: 0x80, y: 0x60, height: 4 });

    const indoor = { x: 62, y: 35, height: 16 };
    expect(heroMapPosition(indoor, false)).toEqual({ x: 62, y: 35, height: 16 });

    // And it is NOT tinyposStash ($E42D), which truncates y and height.
    const awkward = { x: 12, y: 12, height: 12 };
    expect(heroMapPosition(awkward, true)).not.toEqual(tinyposStash(awkward, true));
  });
});

describe('mark_nearby_items', () => {
  it('flags an item inside the window and clears one outside it ($DB9E)', () => {
    const s = createItemState();
    const o = 3 * ITEMSTRUCT_STRIDE;
    s.structs[o + OFF_ROOM] = 5;
    s.structs[o + OFF_ISO_X] = 50;
    s.structs[o + OFF_ISO_Y] = 40;

    markNearbyItems(s, { x: 48, y: 39 }, 5);
    expect(readItemStruct(s, 3).nearby).toBe(true);

    // Push the window well past it.
    markNearbyItems(s, { x: 200, y: 200 }, 5);
    expect(readItemStruct(s, 3).nearby).toBe(false);
  });

  it('only ever flags items in the current room', () => {
    const s = createItemState();
    const o = 3 * ITEMSTRUCT_STRIDE;
    s.structs[o + OFF_ROOM] = 5;
    s.structs[o + OFF_ISO_X] = 50;
    s.structs[o + OFF_ISO_Y] = 40;

    markNearbyItems(s, { x: 48, y: 39 }, 6); // different room, same window
    expect(readItemStruct(s, 3).nearby).toBe(false);
  });

  it('uses the bounds the instructions give, not the block comment', () => {
    // The comment says "(-1..22, 0..15)"; the code computes mapX-2..mapX+23
    // and mapY-1..mapY+16. Asserted at all four edges.
    const at = (isoX: number, isoY: number) => {
      const s = createItemState();
      const o = 0;
      s.structs[o + OFF_ROOM] = 5;
      s.structs[o + OFF_ISO_X] = isoX;
      s.structs[o + OFF_ISO_Y] = isoY;
      markNearbyItems(s, { x: 100, y: 100 }, 5);
      return readItemStruct(s, 0).nearby;
    };
    expect(at(98, 100)).toBe(true); // mapX - 2, the lower edge
    expect(at(97, 100)).toBe(false); // one beyond
    expect(at(123, 100)).toBe(true); // mapX + 23, the upper edge
    expect(at(124, 100)).toBe(false);
    expect(at(100, 99)).toBe(true); // mapY - 1
    expect(at(100, 98)).toBe(false);
    expect(at(100, 116)).toBe(true); // mapY + 16
    expect(at(100, 117)).toBe(false);
  });

  it('sets and clears BOTH nearby bits together ($DBD6 / $DBDD)', () => {
    // find_nearby_item tests bit 7 alone; the draw scan requires both. They
    // only stay consistent because this routine always moves them as a pair.
    const s = createItemState();
    const o = 3 * ITEMSTRUCT_STRIDE;
    s.structs[o + OFF_ROOM] = 5;
    s.structs[o + OFF_ISO_X] = 50;
    s.structs[o + OFF_ISO_Y] = 40;

    markNearbyItems(s, { x: 48, y: 39 }, 5);
    expect(s.structs[o + OFF_ROOM]! & (NEARBY_7 | NEARBY_6)).toBe(NEARBY_7 | NEARBY_6);
    markNearbyItems(s, { x: 200, y: 200 }, 5);
    expect(s.structs[o + OFF_ROOM]! & (NEARBY_7 | NEARBY_6)).toBe(0);
    expect(s.structs[o + OFF_ROOM]! & 0x3f).toBe(5); // the room survives
  });

  it('makes pick-up reachable, which it is not without this routine', () => {
    // The join that was missing: no shipped itemstruct has NEARBY_7 set, so
    // until mark_nearby_items runs, find_nearby_item can never return anything.
    const s = createItemState();
    const o = 3 * ITEMSTRUCT_STRIDE;
    s.structs[o + OFF_ROOM] = 5;
    s.structs[o + OFF_ISO_X] = 50;
    s.structs[o + OFF_ISO_Y] = 40;
    s.structs[o + OFF_X] = 100;
    s.structs[o + OFF_Y] = 100;

    expect(findNearbyItem(s, { x: 100, y: 100 }, 5)).toBe(-1); // flags unset
    markNearbyItems(s, { x: 48, y: 39 }, 5);
    expect(findNearbyItem(s, { x: 100, y: 100 }, 5)).toBe(3);
  });
});
