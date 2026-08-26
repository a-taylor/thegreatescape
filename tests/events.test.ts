/**
 * character_event (c$C7C6), its handler table, and automatics (c$C8FE).
 */

import { describe, expect, it } from 'vitest';

import {
  AUTOMATIC_PLAYER_DELAY,
  FIRST_SIT_ROUTE,
  FIRST_SLEEP_ROUTE,
  LAST_SIT_ROUTE_AS_CODED,
  LAST_SIT_ROUTE_INTENDED,
  LAST_SLEEP_ROUTE,
  applyCharacterEvent,
  characterEvent,
  createAutomaticState,
  eventHandlerMap,
  heroIsAutomatic,
  noteInput,
} from '../src/game/events.js';
import { ROUTE_WANDER } from '../src/game/routes.js';

describe('the ranges character_event tests first', () => {
  it('sends routes 7..12 to sleep', () => {
    // $C7C7/$C7CB: six prisoner beds.
    for (let r = FIRST_SLEEP_ROUTE; r <= LAST_SLEEP_ROUTE; r++) {
      expect(characterEvent(r).kind, `route ${r}`).toBe('sleeps');
    }
    expect(characterEvent(6).kind).not.toBe('sleeps');
    expect(characterEvent(13).kind).not.toBe('sleeps');
  });

  it('sends routes 18..22 to sit', () => {
    for (let r = FIRST_SIT_ROUTE; r <= LAST_SIT_ROUTE_AS_CODED; r++) {
      expect(characterEvent(r).kind, `route ${r}`).toBe('sits');
    }
  });

  it('leaves the sixth prisoner standing at breakfast', () => {
    // $C7D4 CP $17 should have been $18. The disassembly states the cost
    // outright: "the sixth prisoner doesn't sit for breakfast because this
    // should be $18". Reproduced -- it is visible, not a crash.
    expect(LAST_SIT_ROUTE_AS_CODED).toBe(22);
    expect(LAST_SIT_ROUTE_INTENDED).toBe(23);
    expect(characterEvent(LAST_SIT_ROUTE_INTENDED).kind).not.toBe('sits');
  });
});

describe('the handler map', () => {
  it('is 24 entries', () => {
    expect(eventHandlerMap).toHaveLength(24);
  });

  it('keys on the UNMASKED route index', () => {
    // A reversed route ($80 | n) is a different key from its forward form, and
    // the map holds both with different handlers. Masking bit 7 off first
    // would collapse pairs the game deliberately separates.
    const forward = eventHandlerMap.find((e) => e.route === 0x0e);
    const reversed = eventHandlerMap.find((e) => e.route === 0x8e);
    expect(forward).toBeDefined();
    expect(reversed).toBeDefined();
    expect(forward!.handler).not.toBe(reversed!.handler);
  });

  it('halts a character whose route is not in the map', () => {
    // $C7E7. Most routes are absent, so this is the default, not an error.
    expect(characterEvent(0x01).kind).toBe('halt');
    const route = { index: 0x01, step: 5 };
    applyCharacterEvent(characterEvent(route.index), route);
    expect(route).toEqual({ index: 0, step: 0 });
  });
});

describe('the wander handlers', () => {
  it('pick a block of eight locations by route step', () => {
    // $C864 / $C85C / $C860 differ only in the step they store, and the step
    // is what get_target masks to choose eight consecutive locations.
    expect(characterEvent(0xa6)).toEqual({ kind: 'wander', step: 0x08 });
    expect(characterEvent(0xa8)).toEqual({ kind: 'wander', step: 0x10 });
    expect(characterEvent(0x0e)).toEqual({ kind: 'wander', step: 0x38 });
  });

  it('set the route to WANDER, not to a numbered route', () => {
    const route = { index: 0xa6, step: 0 };
    expect(applyCharacterEvent(characterEvent(route.index), route)).toBe(true);
    expect(route.index).toBe(ROUTE_WANDER);
    expect(route.step).toBe(0x08);
  });

  it('lands each block on a multiple of eight', () => {
    // get_target clears the bottom three bits ($C658) before adding a random
    // 0..7, so a step that is not a multiple of eight would shift the block.
    for (const entry of eventHandlerMap) {
      const e = characterEvent(entry.route);
      if (e.kind !== 'wander' && e.kind !== 'solitaryEnds') continue;
      expect(e.step! % 8, `route ${entry.route.toString(16)}`).toBe(0);
    }
  });
});

describe('the route-setting handlers', () => {
  it('sends the commandant to the yard on route (3, 21)', () => {
    // Route $A4 maps to handler 6, charevnt_commandant_to_yard ($C845), which
    // writes route (3, $15).
    const route = { index: 0xa4, step: 0 };
    const e = characterEvent(0xa4);
    expect(e.kind).toBe('commandantToYard');
    expect(e.route).toEqual({ index: 0x03, step: 0x15 });
    applyCharacterEvent(e, route);
    expect(route).toEqual({ index: 0x03, step: 0x15 });
  });

  it('releases the hero onto route ($A4, 3)', () => {
    // A different handler and a different route: $24 maps to handler 10,
    // charevnt_hero_release ($C84C). Easy to conflate with the one above --
    // its route index IS $A4, which is the other handler's KEY.
    const e = characterEvent(0x24);
    expect(e.kind).toBe('heroRelease');
    expect(e.route).toEqual({ index: 0xa4, step: 0x03 });
  });

  it('sends a character out of hut 2 on route (5, 0)', () => {
    // $C882 charevnt_exit_hut2.
    const e = characterEvent(0x2a);
    expect(e.kind).toBe('setRoute');
    expect(e.route).toEqual({ index: 0x05, step: 0x00 });
  });

  it('reports the handlers that still need P5 state', () => {
    // bed, breakfast, sitting and sleeping also poke interior objects and
    // move the character to a specific room. applyCharacterEvent returns false
    // for those rather than silently doing half the job.
    for (const kind of ['bed', 'breakfast'] as const) {
      const entry = eventHandlerMap.find((e) => characterEvent(e.route).kind === kind);
      expect(entry, `some route maps to ${kind}`).toBeDefined();
      const route = { index: entry!.route, step: 0 };
      const before = { ...route };
      expect(applyCharacterEvent(characterEvent(route.index), route)).toBe(false);
      expect(route, 'left untouched rather than half-applied').toEqual(before);
    }
  });
});

describe('automatics', () => {
  it('gives the player 31 turns before taking over', () => {
    // $9E34 sets the counter on any input; $9E30 counts it down.
    const s = createAutomaticState();
    noteInput(s, 4);
    expect(s.counter).toBe(AUTOMATIC_PLAYER_DELAY);
    expect(heroIsAutomatic(s)).toBe(false);

    for (let i = 0; i < AUTOMATIC_PLAYER_DELAY; i++) noteInput(s, 0);
    expect(s.counter).toBe(0);
    expect(heroIsAutomatic(s)).toBe(true);
  });

  it('hands control straight back on any input', () => {
    const s = createAutomaticState();
    expect(heroIsAutomatic(s)).toBe(true);
    noteInput(s, 8);
    expect(heroIsAutomatic(s)).toBe(false);
  });

  it('does not count below zero', () => {
    const s = createAutomaticState();
    for (let i = 0; i < 100; i++) noteInput(s, 0);
    expect(s.counter).toBe(0);
  });

  it('forces automatic control in solitary, whatever the counter says', () => {
    // $C909 jumps straight to the call: the player is not allowed to steer.
    const s = createAutomaticState();
    noteInput(s, 4);
    expect(heroIsAutomatic(s)).toBe(false);
    s.inSolitary = true;
    expect(heroIsAutomatic(s)).toBe(true);
  });

  it('suspends automatic control entirely while the flag is red', () => {
    // $C902 returns before either other test.
    const s = createAutomaticState();
    s.redFlag = true;
    expect(heroIsAutomatic(s)).toBe(false);
    s.inSolitary = true;
    expect(heroIsAutomatic(s), 'red flag beats solitary').toBe(false);
  });
});
