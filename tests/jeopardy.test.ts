/**
 * collision ($AFDF), accept_bribe ($B107) and solitary ($CB98).
 *
 * This is where being chased costs something, so most of these are about
 * WHICH of the three outcomes fires and what each one leaves behind.
 */

import { describe, expect, it } from 'vitest';

import {
  COLLISION_HEIGHT,
  COLLISION_RADIUS,
  FIRST_MOVABLE_CHARACTER,
  FLAGS_NO_COLLIDE,
  ITEM_BRIBE,
  MESSAGE_AND_ACTS_AS_DECOY,
  MESSAGE_ANOTHER_DAY_DAWNS,
  MESSAGE_HE_TAKES_THE_BRIBE,
  MESSAGE_WAIT_FOR_RELEASE,
  MESSAGE_YOU_ARE_IN_SOLITARY,
  ROOM_SOLITARY,
  SOLITARY_DOOR,
  SOLITARY_MORALE_COST,
  acceptBribe,
  collides,
  collision,
  solitary,
  solitaryCommandant,
} from '../src/game/jeopardy.js';
import { PURSUIT_PURSUE, PURSUIT_SAW_BRIBE } from '../src/game/pursuit.js';
import { createVischars } from '../src/game/vischar.js';
import {
  ITEMSTRUCT_STRIDE,
  ITEM_NONE,
  OFF_ROOM,
  OFF_X,
  createItemState,
} from '../src/game/inventory.js';
import { ITEM_COUNT } from '../src/game/items.js';
import { createPlayer, scoreValue } from '../src/game/player.js';
import { characterStructs } from '../src/game/characters.js';
import { permittedBounds } from '../src/game/permitted.js';
import { HERO_RELEASE_ROUTE, applyCharacterEvent, characterEvent } from '../src/game/events.js';
import { setHeroRoute, setHeroRouteForce } from '../src/game/schedule.js';
import { createAutomaticState, heroIsAutomatic } from '../src/game/events.js';
import { getTargetAssignPos, targetReached } from '../src/game/behaviour.js';

function stage() {
  const vischars = createVischars();
  const hero = vischars[0]!;
  hero.character = 0;
  hero.flags = 0;
  hero.pos = { x: 100, y: 100, height: 0 };

  const guard = vischars[1]!;
  guard.character = 5;
  guard.flags = PURSUIT_PURSUE;
  guard.pos = { x: 100, y: 100, height: 0 };

  return { vischars, hero, guard, saved: { x: 100, y: 100, height: 0 } };
}

describe('the collision box', () => {
  it('is +/-4 on x and y and 24 on height', () => {
    const v = createVischars()[1]!;
    v.pos = { x: 100, y: 100, height: 0 };

    expect(collides({ x: 100, y: 100, height: 0 }, v)).toBe(true);
    expect(collides({ x: 100 + COLLISION_RADIUS, y: 100, height: 0 }, v)).toBe(false);
    expect(collides({ x: 100 - COLLISION_RADIUS, y: 100, height: 0 }, v)).toBe(true);
    expect(collides({ x: 100 - COLLISION_RADIUS - 1, y: 100, height: 0 }, v)).toBe(false);

    // Height is an ABSOLUTE difference ($B044 NEG), unlike x and y.
    expect(collides({ x: 100, y: 100, height: COLLISION_HEIGHT - 1 }, v)).toBe(true);
    expect(collides({ x: 100, y: 100, height: -(COLLISION_HEIGHT - 1) }, v)).toBe(true);
    expect(collides({ x: 100, y: 100, height: COLLISION_HEIGHT }, v)).toBe(false);
  });
});

describe('collision', () => {
  it('arrests when a PURSUING character walks into the hero ($B04B)', () => {
    const { vischars, guard, saved } = stage();
    expect(collision(guard, saved, vischars, 0xff)).toEqual({ kind: 'arrest' });
  });

  it('does NOT arrest when the hero walks into a pursuing guard', () => {
    // The flags tested are the MOVER's. A hero blundering into a guard is not
    // an arrest; the guard has to do the walking.
    const { vischars, hero, saved } = stage();
    expect(collision(hero, saved, vischars, 0xff)).toEqual({ kind: 'none' });
  });

  it('does not arrest when the guard is merely hassling', () => {
    const { vischars, guard, saved } = stage();
    guard.flags = 2; // PURSUIT_HASSLE
    expect(collision(guard, saved, vischars, 0xff)).toEqual({ kind: 'none' });
  });

  it('takes the bribe instead of arresting, when it was that character', () => {
    const { vischars, guard, saved } = stage();
    expect(collision(guard, saved, vischars, guard.character)).toEqual({
      kind: 'bribe',
      character: guard.character,
    });
  });

  it('skips anything flagged NO_COLLIDE ($AFE4)', () => {
    const { vischars, hero, guard, saved } = stage();
    hero.flags |= FLAGS_NO_COLLIDE;
    expect(collision(guard, saved, vischars, 0xff)).toEqual({ kind: 'none' });
  });

  it('pushes the stove and crate rather than colliding with them ($B074)', () => {
    const { vischars, guard, saved } = stage();
    guard.flags = 0;
    vischars[0]!.character = 0xff; // clear the hero out of the way
    const stove = vischars[2]!;
    stove.character = FIRST_MOVABLE_CHARACTER;
    stove.flags = 0;
    stove.pos = { x: 100, y: 100, height: 0 };
    expect(collision(guard, saved, vischars, 0xff)).toEqual({ kind: 'push', slot: 2 });
  });
});

describe('accept_bribe', () => {
  it('turns every hostile onto the decoy and drops the bribe item', () => {
    const vischars = createVischars();
    const bribed = vischars[1]!;
    bribed.character = 22;
    bribed.flags = PURSUIT_PURSUE;
    const guard = vischars[2]!;
    guard.character = 5;
    guard.flags = PURSUIT_PURSUE;
    const prisoner = vischars[3]!;
    prisoner.character = 21;
    prisoner.flags = 0;

    const items = createItemState();
    items.held.set([ITEM_BRIBE, ITEM_NONE]);
    const player = createPlayer();
    player.morale = 0;
    const queued: number[] = [];

    acceptBribe(bribed, vischars, items, player, (i) => queued.push(i));

    expect(bribed.flags).toBe(0); // $B10A
    expect([...items.held]).toEqual([ITEM_NONE, ITEM_NONE]);
    expect(items.structs[ITEM_BRIBE * ITEMSTRUCT_STRIDE + OFF_ROOM]).toBe(0x3f);
    expect(player.morale).toBe(10);
    expect(scoreValue(player)).toBe(50);

    // Hostiles look away; fellow prisoners are untouched.
    expect(guard.flags).toBe(PURSUIT_SAW_BRIBE);
    expect(prisoner.flags).toBe(0);

    expect(queued).toEqual([MESSAGE_HE_TAKES_THE_BRIBE, MESSAGE_AND_ACTS_AS_DECOY]);
  });
});

describe('solitary', () => {
  function arrest(over: Record<string, unknown> = {}) {
    const vischars = createVischars();
    const hero = vischars[0]!;
    hero.character = 0;
    hero.room = 0;
    const items = createItemState();
    const player = createPlayer();
    const structs = characterStructs();
    const calls = {
      queued: [] as number[],
      discovered: [] as number[],
      bells: 0,
      resets: 0,
      transitions: 0,
      forcedAutomatic: 0,
    };
    const state = { inSolitary: false, currentDoor: -1 };
    const ctx = {
      hero,
      items,
      player,
      vischars,
      structs,
      queueMessage: (i: number) => calls.queued.push(i),
      discoverItem: (i: number) => calls.discovered.push(i),
      silenceBell: () => calls.bells++,
      resetCast: () => calls.resets++,
      forceAutomatic: () => calls.forcedAutomatic++,
      transitionToSolitary: () => calls.transitions++,
      ...over,
    };
    return { state, ctx, calls, hero, items, player, structs };
  }

  it('makes all fourteen of its writes', () => {
    const { state, ctx, calls, hero, player } = arrest();
    player.morale = 100;
    ctx.items.held.set([3, 8]);

    solitary(state, ctx);

    expect(calls.bells).toBe(1);
    expect([...ctx.items.held]).toEqual([ITEM_NONE, ITEM_NONE]);
    expect(calls.discovered).toContain(3);
    expect(calls.discovered).toContain(8);
    expect(hero.room).toBe(ROOM_SOLITARY);
    expect(state.currentDoor).toBe(SOLITARY_DOOR);
    expect(player.morale).toBe(100 - SOLITARY_MORALE_COST);
    expect(calls.resets).toBe(1);
    expect(state.inSolitary).toBe(true);
    expect(calls.forcedAutomatic).toBe(1);
    expect(hero.direction).toBe(3);
    expect(hero.route).toEqual({ index: 0, step: 0 });
    expect(calls.transitions).toBe(1);
    expect(calls.queued).toEqual([
      MESSAGE_YOU_ARE_IN_SOLITARY,
      MESSAGE_WAIT_FOR_RELEASE,
      MESSAGE_ANOTHER_DAY_DAWNS,
    ]);
  });

  it('sends the commandant to collect him, on route 36 ($CBF6)', () => {
    const { state, ctx, structs } = arrest();
    solitary(state, ctx);
    const [room, x, y, height, routeIndex, routeStep] = solitaryCommandant;
    expect(structs[0]!.room).toBe(room);
    expect(structs[0]!.pos).toEqual({ x, y, height });
    expect(structs[0]!.route).toEqual({ index: routeIndex, step: routeStep });
    expect(routeIndex).toBe(36); // routeindex_36_GO_TO_SOLITARY
  });

  it('finds items dropped INSIDE the camp but not outside it ($CBC4)', () => {
    // The sweep is what makes the walkthrough possible: everything cached
    // through the wire or down the tunnel survives being arrested, and
    // everything left lying in the compound does not.
    const { state, ctx, calls, items } = arrest();
    for (let i = 0; i < ITEM_COUNT; i++) {
      items.structs[i * ITEMSTRUCT_STRIDE + OFF_ROOM] = 0x3f; // nowhere
    }

    const inside = permittedBounds[1]!;
    const put = (item: number, room: number, x: number, y: number) => {
      const o = item * ITEMSTRUCT_STRIDE;
      items.structs[o] = item;
      items.structs[o + OFF_ROOM] = room;
      items.structs[o + OFF_X] = x;
      items.structs[o + OFF_X + 1] = y;
      items.structs[o + OFF_X + 2] = 0;
    };
    put(1, 0, inside.x0, inside.y0); // outdoors, inside the camp
    put(2, 0, 250, 250); // outdoors, well outside every area
    put(3, 5, 0, 0); // indoors -- skipped before the bounds test

    solitary(state, ctx);

    expect(calls.discovered).toContain(1);
    expect(calls.discovered).not.toContain(2);
    expect(calls.discovered).not.toContain(3);
  });
});

describe('being released', () => {
  it('route 37 ends solitary; route 36 releases the hero ($C83F / $C84C)', () => {
    // Two different handlers, on two adjacent routes, and they are easy to
    // mix up. Route 36 is the COMMANDANT walking to the cell, and finishing
    // it releases the hero ($C852 zeroes the automatic player counter). Route
    // 37 is what clears in_solitary ($C840) and sends him wandering.
    expect(characterEvent(36).kind).toBe('heroRelease');
    expect(characterEvent(37).kind).toBe('solitaryEnds');
  });

  it('solitaryEnds puts the character back to WANDER ($C843)', () => {
    // in_solitary is one byte: solitary sets it, this clears it, and
    // in_permitted_area, automatics and set_hero_route all read it. Left set,
    // the hero never gets control back.
    const route = { index: 37, step: 0 };
    expect(applyCharacterEvent(characterEvent(37), route, 0)).toBe(true);
    expect(route.index).toBe(0xff); // charevnt_wander_top
  });
});

describe('the release chain', () => {
  it('set_hero_route REFUSES in solitary; the force entry does not', () => {
    // $A33F tests in_solitary and returns; $A344 is the same routine one
    // instruction later. charevnt_hero_release jumps to $A344 ($C859)
    // precisely because the hero IS in solitary at that moment. Route the
    // release through $A33F and it silently does nothing -- the hero stays in
    // the cell for the rest of the game, unable to move.
    const vischars = createVischars();
    const hero = vischars[0]!;
    hero.character = 0;
    hero.flags = 0;
    hero.route = { index: 0, step: 0 };
    const ctx = {
      structs: characterStructs(),
      vischars,
      random: () => 0,
      room: 0,
      hero,
      heroPos: hero.pos,
      inSolitary: true,
    };

    setHeroRoute(ctx, HERO_RELEASE_ROUTE.index, HERO_RELEASE_ROUTE.step);
    expect(hero.route).toEqual({ index: 0, step: 0 }); // refused

    setHeroRouteForce(ctx, HERO_RELEASE_ROUTE.index, HERO_RELEASE_ROUTE.step);
    expect(hero.route).toEqual({ index: 37, step: 0 }); // forced through
  });

  it('routes the hero to 37, whose end is the only thing that clears solitary', () => {
    // The chain is: commandant finishes route 36 -> charevnt_hero_release
    // gives the HERO route 37 -> the hero finishes 37 -> charevnt_solitary_ends
    // clears in_solitary. Break any link and he never gets out.
    expect(characterEvent(36).kind).toBe('heroRelease');
    expect(HERO_RELEASE_ROUTE.index).toBe(37);
    expect(characterEvent(HERO_RELEASE_ROUTE.index).kind).toBe('solitaryEnds');
  });
});

describe('automatic_player_counter has exactly one owner', () => {
  it('solitary forces automatic control through the SAME byte heroIsAutomatic reads', () => {
    // $CC16 and $C853 both zero $A139 to hand the hero to the CPU at once.
    // The release depends on it: he has to AUTO-walk route 37 out of the
    // cell, and if the player has touched a key recently the counter is 31
    // and he will not. Writing a second copy on PlayerState leaves the hero
    // in solitary for the rest of the game -- charevnt_solitary_ends never
    // fires because route 37 is never finished.
    const automatic = createAutomaticState();
    automatic.counter = 31; // as if the player just pressed something
    automatic.inSolitary = false;

    const { state, ctx } = (() => {
      const vischars = createVischars();
      const hero = vischars[0]!;
      hero.character = 0;
      return {
        state: { inSolitary: false, currentDoor: -1 },
        ctx: {
          hero,
          items: createItemState(),
          player: createPlayer(),
          vischars,
          structs: characterStructs(),
          queueMessage: () => {},
          discoverItem: () => {},
          silenceBell: () => {},
          resetCast: () => {},
          forceAutomatic: () => { automatic.counter = 0; },
          transitionToSolitary: () => {},
        },
      };
    })();

    solitary(state, ctx);

    expect(automatic.counter).toBe(0);
    automatic.inSolitary = state.inSolitary;
    expect(heroIsAutomatic(automatic)).toBe(true);
  });
});

describe('a character event raised AT a door still reaches the caller', () => {
  it('surfaces solitaryEnds when the route ends at a doorway ($CB05)', () => {
    // enterDoor runs route_ended for the HERO, so a route whose last waypoint
    // IS a door raises its character event inside the door branch of
    // target_reached. That branch used to return without the event, so the
    // caller never learned in_solitary should be cleared: the hero was set
    // wandering by charevnt_solitary_ends and then left wandering forever,
    // unrouteable by the day schedule and unsteerable by the player.
    //
    // Route 37 -- the walk out of the solitary cell -- is exactly such a
    // route, which is why this only ever showed up after an arrest.
    const vischars = createVischars();
    const structs = characterStructs();
    const hero = vischars[0]!;
    hero.character = 0;
    hero.flags = 0;
    hero.room = ROOM_SOLITARY;

    // Put him on the last step of route 37, standing on its door.
    hero.route = { index: HERO_RELEASE_ROUTE.index, step: 0 };
    const ctx = { random: () => 0, structs, room: hero.room };
    getTargetAssignPos(hero, ctx);

    // Walk the route to its end, collecting any event the caller would see.
    let sawSolitaryEnds = false;
    for (let i = 0; i < 40; i++) {
      hero.pos = { x: hero.target.x, y: hero.target.y, height: hero.pos.height };
      const r = targetReached(hero, ctx);
      if (r.event === 'solitaryEnds') { sawSolitaryEnds = true; break; }
      if (hero.route.index === 0xff) break; // already wandering
    }

    // Either it surfaced, or the route never ended -- and if the route DID
    // end (he is now wandering) the event must have surfaced with it.
    if (hero.route.index === 0xff) expect(sawSolitaryEnds).toBe(true);
  });
});
