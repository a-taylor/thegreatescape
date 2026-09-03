import { describe, expect, it } from 'vitest';

import {
  BELL_RING_PERPETUAL,
  BELL_STOP,
  RINGER_ON_FIRST_BYTE,
  createBell,
  ringBell,
} from '../src/game/bell.js';
import { BELL_RINGER_SCREEN_ADDRESS, bellRingerOn, bellRingerOff, plotRinger } from '../src/ui/panel.js';
import { SpectrumScreen } from '../src/spectrum/display.js';

/** A context that keeps the ringer byte where the game does: on the screen. */
function context() {
  const screen = new SpectrumScreen();
  const rings: string[] = [];
  return {
    screen,
    rings,
    ctx: {
      ringerByte: () => screen.readByte(BELL_RINGER_SCREEN_ADDRESS),
      plotRinger: (on: boolean) => plotRinger(screen, on),
      playBell: () => rings.push('ring'),
    },
  };
}

describe('ring_bell ($A09E)', () => {
  it('does nothing at all while the bell is stopped', () => {
    const { ctx, rings } = context();
    const bell = createBell();
    expect(bell.counter).toBe(BELL_STOP); // $A130 DEFB $FF
    for (let i = 0; i < 10; i++) expect(ringBell(bell, ctx)).toBe('stopped');
    expect(rings).toHaveLength(0);
  });

  it('alternates the ringer, and sounds only on the ON frames', () => {
    // The alternation has no counter behind it: $A0B0 reads the ringer's own
    // graphic back off the screen and compares it with $3F, the first byte of
    // bell_ringer_bitmap_on. So this is also a test that plot_ringer actually
    // wrote to the display -- if it did not, the byte would never change and
    // the bell would ring on every single call.
    const { ctx, rings, screen } = context();
    const bell = createBell();
    bell.counter = BELL_RING_PERPETUAL;

    expect(ringBell(bell, ctx)).toBe('turned-on');
    expect(screen.readByte(BELL_RINGER_SCREEN_ADDRESS)).toBe(RINGER_ON_FIRST_BYTE);
    expect(rings).toHaveLength(1);

    expect(ringBell(bell, ctx)).toBe('turned-off');
    expect(screen.readByte(BELL_RINGER_SCREEN_ADDRESS)).toBe(bellRingerOff[0]);
    expect(rings).toHaveLength(1); // no sound on the way down

    expect(ringBell(bell, ctx)).toBe('turned-on');
    expect(rings).toHaveLength(2);
  });

  it('rings perpetually without ever counting down', () => {
    const { ctx } = context();
    const bell = createBell();
    bell.counter = BELL_RING_PERPETUAL;
    for (let i = 0; i < 50; i++) ringBell(bell, ctx);
    expect(bell.counter).toBe(BELL_RING_PERPETUAL); // $A0A6 skips the decrement
  });

  it('stops itself after N calls when given a count', () => {
    const { ctx, rings } = context();
    const bell = createBell();
    bell.counter = 5;
    const results = [0, 1, 2, 3, 4, 5, 6].map(() => ringBell(bell, ctx));
    // $A0A8 decrements first, so a count of 5 gives four working calls and
    // then stops on the one that takes it to zero.
    expect(results.slice(0, 4).every((r) => r !== 'stopped')).toBe(true);
    expect(results[4]).toBe('stopped');
    expect(bell.counter).toBe(BELL_STOP);
    expect(results.slice(5)).toEqual(['stopped', 'stopped']);
    expect(rings.length).toBeGreaterThan(0);
  });

  it('uses the two shipped ringer bitmaps, which differ', () => {
    // If they were the same the alternation would deadlock on one branch.
    expect(bellRingerOn[0]).toBe(RINGER_ON_FIRST_BYTE);
    expect(bellRingerOff[0]).not.toBe(RINGER_ON_FIRST_BYTE);
  });
});
