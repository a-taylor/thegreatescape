/**
 * follow_suspicious_character ($C892), guards_follow_suspicious_character
 * ($CC37) and hostiles_pursue ($CCAB).
 *
 * Three different reactions come out of these, and they are separate flags
 * rather than degrees of one -- so most of these tests are about WHICH one.
 */

import { describe, expect, it } from 'vitest';

import {
  FIRST_FRIENDLY_CHARACTER,
  ITEM_FOOD,
  PURSUIT_DOG_FOOD,
  PURSUIT_HASSLE,
  PURSUIT_PURSUE,
  PURSUIT_SAW_BRIBE,
  TOWER_HEIGHT,
  followSuspiciousCharacter,
  guardsFollowSuspiciousCharacter,
  hostilesPursue,
} from '../src/game/pursuit.js';
import { createVischars } from '../src/game/vischar.js';
import {
  ITEMSTRUCT_STRIDE,
  OFF_ROOM,
  createItemState,
} from '../src/game/inventory.js';
import { NEARBY_7 } from '../src/game/items.js';
import { tinyposStash } from '../src/game/coords.js';
import { characterBehaviour } from '../src/game/behaviour.js';
import { characterStructs } from '../src/game/characters.js';

function world(over: Record<string, unknown> = {}) {
  const vischars = createVischars();
  const items = createItemState();
  const ctx = {
    room: 0,
    redFlag: false,
    automaticPlayerCounter: 31,
    heroMapPosition: { x: 100, y: 100, height: 0 },
    heroInUniform: false,
    items,
    ...over,
  };
  return { vischars, items, ctx };
}

/** A guard standing where he can see the hero, facing the right way. */
function guard(vischars: ReturnType<typeof createVischars>, slot: number, character = 5) {
  const v = vischars[slot]!;
  v.character = character;
  v.flags = 0;
  v.pos = { x: 100 * 8, y: 100 * 8, height: 0 };
  v.direction = 0;
  return v;
}

describe('hostiles_pursue', () => {
  it('sets every hostile chasing, but not the friendly ones', () => {
    const { vischars } = world();
    guard(vischars, 1, 5); // a guard
    guard(vischars, 2, FIRST_FRIENDLY_CHARACTER); // a prisoner
    hostilesPursue(vischars);
    expect(vischars[1]!.flags).toBe(PURSUIT_PURSUE);
    expect(vischars[2]!.flags).not.toBe(PURSUIT_PURSUE);
  });

  it('leaves the tower guards on their platforms ($CCBE)', () => {
    // Excluded by HEIGHT, not by character index -- so this is about where a
    // guard is standing, not who he is.
    const { vischars } = world();
    const high = guard(vischars, 1, 5);
    high.pos.height = TOWER_HEIGHT;
    hostilesPursue(vischars);
    expect(high.flags).not.toBe(PURSUIT_PURSUE);

    high.pos.height = TOWER_HEIGHT - 1;
    hostilesPursue(vischars);
    expect(high.flags).toBe(PURSUIT_PURSUE);
  });

  it('skips the hero, who is slot 0', () => {
    const { vischars } = world();
    vischars[0]!.character = 0;
    vischars[0]!.flags = 0;
    hostilesPursue(vischars);
    expect(vischars[0]!.flags).toBe(0);
  });
});

describe('guards_follow_suspicious_character', () => {
  it('is fooled by the uniform, except by the commandant ($CC3B)', () => {
    const { vischars, ctx } = world({ heroInUniform: true, room: 5 });
    const g = guard(vischars, 1, 5);
    guardsFollowSuspiciousCharacter(g, vischars, ctx);
    expect(g.flags).toBe(0);

    const commandant = guard(vischars, 2, 0);
    guardsFollowSuspiciousCharacter(commandant, vischars, ctx);
    expect(commandant.flags).toBe(PURSUIT_HASSLE);
  });

  it('looks away if it watched the bribe change hands ($CC48)', () => {
    const { vischars, ctx } = world({ room: 5 });
    const g = guard(vischars, 1, 5);
    g.flags = PURSUIT_SAW_BRIBE;
    guardsFollowSuspiciousCharacter(g, vischars, ctx);
    expect(g.flags).toBe(PURSUIT_SAW_BRIBE);
  });

  it('skips line of sight entirely while indoors ($CC57)', () => {
    // Indoors the guard reacts on the flag alone -- position and facing are
    // never consulted, which is why a guard in a corridor always notices.
    const { vischars, ctx } = world({ room: 5 });
    const g = guard(vischars, 1, 5);
    g.pos = { x: 0, y: 0, height: 0 };
    ctx.heroMapPosition = { x: 200, y: 200, height: 0 };
    guardsFollowSuspiciousCharacter(g, vischars, ctx);
    expect(g.flags).toBe(PURSUIT_HASSLE);
  });

  it('outdoors, needs the hero within one unit on the scanned axis', () => {
    const { vischars, ctx } = world({ room: 0 });
    const g = guard(vischars, 1, 5);
    g.direction = 0; // TOP_LEFT -> scans along y
    const mine = tinyposStash(g.pos, true);

    // In the corridor and on the facing side. Hand-traced from $CC76: for
    // direction 0 the guard sees the hero only at a LARGER x.
    ctx.heroMapPosition = { x: mine.x + 5, y: mine.y, height: 0 };
    guardsFollowSuspiciousCharacter(g, vischars, ctx);
    expect(g.flags).toBe(PURSUIT_HASSLE);

    // Two units off the corridor: not seen.
    const away = guard(vischars, 2, 5);
    away.direction = 0;
    ctx.heroMapPosition = { x: mine.x + 5, y: mine.y + 2, height: 0 };
    guardsFollowSuspiciousCharacter(away, vischars, ctx);
    expect(away.flags).toBe(0);

    // And on the wrong side of him, in the corridor: also not seen.
    const behind = guard(vischars, 3, 5);
    behind.direction = 0;
    ctx.heroMapPosition = { x: mine.x - 5, y: mine.y, height: 0 };
    guardsFollowSuspiciousCharacter(behind, vischars, ctx);
    expect(behind.flags).toBe(0);
  });

  it('only sees the side it is facing, and the two directions disagree', () => {
    // $CC78: bit 1 of the direction inverts the side test, so TOP_LEFT and
    // BOTTOM_RIGHT scan the same corridor in opposite directions. Asserted as
    // the pair, because either alone would pass a one-sided implementation.
    const { vischars, ctx } = world({ room: 0 });
    const tl = guard(vischars, 1, 5);
    tl.direction = 0; // TOP_LEFT
    const br = guard(vischars, 2, 5);
    br.direction = 2; // BOTTOM_RIGHT
    const mine = tinyposStash(tl.pos, true);

    // One position, two guards facing opposite ways: exactly one sees him.
    ctx.heroMapPosition = { x: mine.x + 5, y: mine.y, height: 0 };
    guardsFollowSuspiciousCharacter(tl, vischars, ctx);
    guardsFollowSuspiciousCharacter(br, vischars, ctx);
    expect([tl.flags, br.flags]).toEqual([PURSUIT_HASSLE, 0]);

    // Move him to the other side and the roles swap.
    const tl2 = guard(vischars, 4, 5); tl2.direction = 0;
    const br2 = guard(vischars, 5, 5); br2.direction = 2;
    ctx.heroMapPosition = { x: mine.x - 5, y: mine.y, height: 0 };
    guardsFollowSuspiciousCharacter(tl2, vischars, ctx);
    guardsFollowSuspiciousCharacter(br2, vischars, ctx);
    expect([tl2.flags, br2.flags]).toEqual([0, PURSUIT_HASSLE]);
  });

  it('hassles when the flag is green and PURSUES when it is red ($CC92)', () => {
    const calm = world({ room: 5, redFlag: false });
    const a = guard(calm.vischars, 1, 5);
    expect(guardsFollowSuspiciousCharacter(a, calm.vischars, calm.ctx).ringBell).toBe(false);
    expect(a.flags).toBe(PURSUIT_HASSLE);

    const alarm = world({ room: 5, redFlag: true });
    const b = guard(alarm.vischars, 1, 5);
    const other = guard(alarm.vischars, 3, 6);
    expect(guardsFollowSuspiciousCharacter(b, alarm.vischars, alarm.ctx).ringBell).toBe(true);
    // EVERY hostile converges, not just the one that saw him.
    expect(b.flags).toBe(PURSUIT_PURSUE);
    expect(other.flags).toBe(PURSUIT_PURSUE);
  });
});

describe('follow_suspicious_character', () => {
  const hooks = () => {
    const calls = { discoverable: 0, expired: 0 };
    return {
      calls,
      hooks: {
        checkItemDiscoverable() { calls.discoverable++; },
        foodExpired() { calls.expired++; },
      },
    };
  };

  it('ignores an ACTIVE, well-behaved player ($C8CE)', () => {
    // The gate on the whole thing: red flag, or the player idle enough for the
    // CPU to be driving. Neither, and the guards do not look.
    const { vischars, ctx } = world({ room: 5, redFlag: false, automaticPlayerCounter: 0 });
    const g = guard(vischars, 1, 5);
    const h = hooks();
    followSuspiciousCharacter(vischars, ctx, { foodDiscoveredCounter: 0, bellRingingPerpetually: false }, h.hooks);
    expect(g.flags).toBe(0);
  });

  it('keeps everyone chasing while the bell rings perpetually ($C89A)', () => {
    const { vischars, ctx } = world();
    const g = guard(vischars, 1, 5);
    const h = hooks();
    followSuspiciousCharacter(vischars, ctx, { foodDiscoveredCounter: 0, bellRingingPerpetually: true }, h.hooks);
    expect(g.flags).toBe(PURSUIT_PURSUE);
  });

  it('ages the poisoned food and discovers it when it expires ($C8A4)', () => {
    const { vischars, ctx, items } = world();
    const o = ITEM_FOOD * ITEMSTRUCT_STRIDE;
    items.structs[o] = items.structs[o]! | 0x20; // poisoned
    const h = hooks();
    const state = { foodDiscoveredCounter: 2, bellRingingPerpetually: false };

    followSuspiciousCharacter(vischars, ctx, state, h.hooks);
    expect(state.foodDiscoveredCounter).toBe(1);
    expect(h.calls.expired).toBe(0);
    expect(items.structs[o]! & 0x20).toBeTruthy();

    followSuspiciousCharacter(vischars, ctx, state, h.hooks);
    expect(state.foodDiscoveredCounter).toBe(0);
    expect(h.calls.expired).toBe(1);
    expect(items.structs[o]! & 0x20).toBe(0); // the poison wore off
  });

  it('sends a DOG after the food, and only a dog ($C8DC)', () => {
    const { vischars, ctx, items } = world({ room: 5, automaticPlayerCounter: 0 });
    items.structs[ITEM_FOOD * ITEMSTRUCT_STRIDE + OFF_ROOM] = NEARBY_7;

    const dog = guard(vischars, 1, 16); // character_16_GUARD_DOG_1
    const man = guard(vischars, 2, 5); // an ordinary guard
    const h = hooks();
    followSuspiciousCharacter(vischars, ctx, { foodDiscoveredCounter: 0, bellRingingPerpetually: false }, h.hooks);

    expect(dog.flags).toBe(PURSUIT_DOG_FOOD);
    expect(man.flags).not.toBe(PURSUIT_DOG_FOOD);
  });

  it('checks for discoverable items once per hostile ($C8CB)', () => {
    const { vischars, ctx } = world({ automaticPlayerCounter: 0 });
    guard(vischars, 1, 5);
    guard(vischars, 2, 6);
    guard(vischars, 3, FIRST_FRIENDLY_CHARACTER); // not hostile
    const h = hooks();
    followSuspiciousCharacter(vischars, ctx, { foodDiscoveredCounter: 0, bellRingingPerpetually: false }, h.hooks);
    expect(h.calls.discoverable).toBe(2);
  });
});

describe('character_behaviour under a pursuit mode ($C92A)', () => {
  const base = () => {
    const vischars = createVischars();
    const v = vischars[1]!;
    v.character = 5;
    v.pos = { x: 100 * 8, y: 100 * 8, height: 0 };
    v.target = { x: 0, y: 0, height: 7 };
    v.counterAndFlags = 0;
    v.route = { index: 1, step: 0 };
    return { vischars, v };
  };
  const ctx = (over: Record<string, unknown> = {}) => ({
    random: () => 0,
    structs: characterStructs(),
    room: 0,
    heroMapPosition: { x: 55, y: 66 },
    automaticPlayerCounter: 31,
    vischars: undefined,
    ...over,
  });

  it('PURSUE steers by the hero position, refreshed every frame ($C938)', () => {
    const { vischars, v } = base();
    v.flags = PURSUIT_PURSUE;
    characterBehaviour(v, ctx({ vischars }) as never);
    expect({ x: v.target.x, y: v.target.y }).toEqual({ x: 55, y: 66 });

    // It re-reads rather than latching, so a moving hero drags the target.
    const c2 = ctx({ vischars, heroMapPosition: { x: 70, y: 80 } });
    characterBehaviour(v, c2 as never);
    expect({ x: v.target.x, y: v.target.y }).toEqual({ x: 70, y: 80 });
  });

  it('leaves target.height alone -- only x and y are copied ($C93B)', () => {
    const { vischars, v } = base();
    v.flags = PURSUIT_PURSUE;
    characterBehaviour(v, ctx({ vischars }) as never);
    expect(v.target.height).toBe(7);
  });

  it('HASSLE follows only while the CPU drives the hero ($C947)', () => {
    const idle = base();
    idle.v.flags = PURSUIT_HASSLE;
    characterBehaviour(idle.v, ctx({ vischars: idle.vischars }) as never);
    expect(idle.v.flags).toBe(PURSUIT_HASSLE);
    expect({ x: idle.v.target.x, y: idle.v.target.y }).toEqual({ x: 55, y: 66 });

    // The player takes control: the guard loses interest at once. This is why
    // walking about shakes off a curious guard but not a pursuing one.
    const active = base();
    active.v.flags = PURSUIT_HASSLE;
    characterBehaviour(
      active.v,
      ctx({ vischars: active.vischars, automaticPlayerCounter: 0 }) as never,
    );
    expect(active.v.flags).toBe(0);
  });

  it('DOG_FOOD steers by the food, then goes back to WANDER ($C96C)', () => {
    const near = base();
    near.v.flags = PURSUIT_DOG_FOOD;
    characterBehaviour(
      near.v,
      ctx({ vischars: near.vischars, foodItem: { nearby: true, x: 12, y: 34 } }) as never,
    );
    expect({ x: near.v.target.x, y: near.v.target.y }).toEqual({ x: 12, y: 34 });

    // Food gone: the dog does not resume its old route, it WANDERS ($C970).
    const gone = base();
    gone.v.flags = PURSUIT_DOG_FOOD;
    gone.v.route = { index: 3, step: 2 };
    characterBehaviour(
      gone.v,
      ctx({ vischars: gone.vischars, foodItem: { nearby: false, x: 0, y: 0 } }) as never,
    );
    expect(gone.v.flags).toBe(0);
    expect(gone.v.route.index).toBe(0xff);
    expect(gone.v.route.step).toBe(0);
  });

  it('SAW_BRIBE heads for the bribed character, and gives up without one', () => {
    const { vischars, v } = base();
    const bribed = vischars[3]!;
    bribed.character = 22;
    bribed.pos = { x: 0x0400, y: 0x0300, height: 0 };

    v.flags = PURSUIT_SAW_BRIBE;
    characterBehaviour(v, ctx({ vischars, bribedCharacter: 22 }) as never);
    // Outdoors the position is scaled down to tinypos ($C9AD).
    expect({ x: v.target.x, y: v.target.y }).toEqual({ x: 0x80, y: 0x60 });

    const none = base();
    none.v.flags = PURSUIT_SAW_BRIBE;
    characterBehaviour(none.v, ctx({ vischars: none.vischars, bribedCharacter: 0xff }) as never);
    expect(none.v.flags).toBe(0);
  });

  it('treats a flags byte that is not a mode as an ordinary route ($C97B)', () => {
    // The comparisons are on the WHOLE byte, so TARGET_IS_DOOR ($40) and
    // NO_COLLIDE ($80) fall through to the route path rather than being
    // mistaken for a mode. Getting this wrong stops every character that is
    // walking to a door.
    const { vischars, v } = base();
    v.flags = 0x40;
    v.target = { x: 0, y: 0, height: 0 };
    characterBehaviour(v, ctx({ vischars }) as never);
    expect(v.flags).toBe(0x40);
    // It took a route target, not the hero's position.
    expect({ x: v.target.x, y: v.target.y }).not.toEqual({ x: 55, y: 66 });
  });
});
