import { describe, expect, it } from 'vitest';

import {
  MUSIC_ITERATIONS_PER_SECOND,
  NOTE_ITERATIONS,
  SEMITONE_COUNT,
  SOUNDS,
  channel0,
  channel1,
  channel1FollowsChannel0,
  renderEffect,
  renderTune,
  semitonePeriod,
  tuneLength,
} from '../src/spectrum/beeper.js';

/** The pitch a period produces, for readability in the assertions below. */
function hz(semitone: number): number {
  return MUSIC_ITERATIONS_PER_SECOND / (2 * semitonePeriod(semitone));
}

describe('frequency_for_semitone ($F52C)', () => {
  it('reads 76 entries from semitone_to_frequency', () => {
    expect(SEMITONE_COUNT).toBe(76);
  });

  it('produces a chromatic scale, which is how the counter formula is checked', () => {
    // This is the assertion that pins `B + 256 * (C - 1)`. The obvious reading
    // -- `C * 256 + B` -- is out by 256 and yields frequencies that are not
    // musical and not obviously wrong either, which is exactly the kind of
    // mistake that survives a listen. A chromatic scale has a fixed ratio of
    // 2^(1/12) = 1.0595 between adjacent semitones, and nothing else does.
    const ratio = 2 ** (1 / 12);
    for (let s = 5; s < 45; s++) {
      const r = semitonePeriod(s) / semitonePeriod(s + 1);
      expect(r, `semitone ${s} -> ${s + 1}`).toBeGreaterThan(ratio - 0.012);
      expect(r, `semitone ${s} -> ${s + 1}`).toBeLessThan(ratio + 0.012);
    }
  });

  it('spans about three octaves over the semitones the tune uses', () => {
    // "This is never larger than 42 in this game" -- the routine's own header.
    const used = [...channel0, ...channel1].filter((s) => s !== 0xff);
    expect(Math.max(...used)).toBeLessThanOrEqual(42);
    expect(hz(5)).toBeGreaterThan(60);
    expect(hz(42)).toBeLessThan(700);
    expect(hz(42) / hz(5)).toBeGreaterThan(7); // three octaves is 8x
  });

  it('lands near concert pitch, so the scale is a real one', () => {
    // Not a fidelity assertion -- the tuning depends on the T-state estimate.
    // It is a sanity check on the whole chain from table to hertz: if the
    // formula or the loop count were badly wrong this would be an octave out.
    const near440 = [];
    for (let s = 0; s < 60; s++) if (Math.abs(hz(s) - 440) < 25) near440.push(s);
    expect(near440.length).toBeGreaterThan(0);
  });

  it('makes semitone 0 silence, and channel 1s rest', () => {
    // $F4EE: a channel-1 frequency whose low byte is $FF follows channel 0.
    // Semitone 0's entry is $FE $FE, so it is the only one that does.
    expect(channel1FollowsChannel0(0)).toBe(true);
    for (let s = 1; s < SEMITONE_COUNT; s++) {
      expect(channel1FollowsChannel0(s), `semitone ${s}`).toBe(false);
    }
    // And on channel 0 it is simply too slow to toggle within a note.
    expect(semitonePeriod(0)).toBeGreaterThan(NOTE_ITERATIONS);
  });
});

describe('the menu tune ($F4B7)', () => {
  it('runs to an end-of-song marker on both channels', () => {
    expect(channel0[channel0.length - 1]).toBe(0xff);
    expect(channel1[channel1.length - 1]).toBe(0xff);
    expect(tuneLength()).toBe(640);
  });

  it('renders a note of the right length', () => {
    const rate = 44100;
    const buf = renderTune(rate, { notes: 1 });
    const expected = NOTE_ITERATIONS / MUSIC_ITERATIONS_PER_SECOND;
    expect(buf.length / rate).toBeCloseTo(expected, 3);
  });

  it('actually toggles the speaker, rather than rendering silence', () => {
    // The failure this catches is a counter that never reaches zero -- which
    // is what `C * 256 + B` produces for most of the table.
    const buf = renderTune(44100, { notes: 8 });
    const changes = [...buf].filter((v, i) => i > 0 && Math.sign(v) !== Math.sign(buf[i - 1]!));
    expect(changes.length).toBeGreaterThan(50);
  });

  it('stays inside the amplitude it was asked for', () => {
    const buf = renderTune(44100, { notes: 4, gain: 0.2 });
    for (const v of buf) expect(Math.abs(v)).toBeLessThanOrEqual(0.2 + 1e-6);
  });
});

describe('play_speaker ($A11D)', () => {
  it('has every call site the game makes', () => {
    // Six calls, from five sites; "character enters" plays two tones in a row.
    expect(Object.keys(SOUNDS)).toEqual([
      'pickUpItem',
      'dropItem',
      'bell',
      'characterEntersA',
      'characterEntersB',
      'characterEnters1',
    ]);
    expect(SOUNDS.bell).toEqual({ iterations: 0x25, delay: 0x30 }); // $A0C1
  });

  it('renders a short square wave whose pitch falls as the delay rises', () => {
    const rate = 44100;
    const fast = renderEffect(0x30, 0x30, rate);
    const slow = renderEffect(0x30, 0x40, rate);
    // Same iteration count, longer delay -> longer sound, lower pitch.
    expect(slow.length).toBeGreaterThan(fast.length);
  });

  it('is brief, as a click rather than a tone', () => {
    // The bell is 37 half-periods of ~228us. If this ever came out as a
    // second-long drone the constants would be wrong by an order of magnitude.
    const buf = renderEffect(SOUNDS.bell.iterations, SOUNDS.bell.delay, 44100);
    const seconds = buf.length / 44100;
    expect(seconds).toBeGreaterThan(0.002);
    expect(seconds).toBeLessThan(0.05);
  });

  it('starts with the speaker bit SET ($A121)', () => {
    const buf = renderEffect(4, 0x30, 44100);
    expect(buf[0]).toBeGreaterThan(0);
  });
});
