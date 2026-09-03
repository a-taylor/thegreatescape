/**
 * The ZX Spectrum's one-bit speaker.
 *
 * There is no sound chip. Bit 4 of port $FE is the speaker cone's position,
 * and every sound in the game is made by a loop toggling it and counting: the
 * pitch is how long the loop waits between toggles, and the duration is how
 * many times it does so. Both are measured in loop iterations, because -- as
 * the disassembly says of `frequency_for_semitone` -- "there is no absolute
 * time to work from ... this will obviously only sound correct on a standard
 * ZX Spectrum".
 *
 * That last sentence is the whole difficulty. Turning iterations into seconds
 * needs a T-state count for the loop, which is not extracted data and cannot
 * be: it is a property of the instructions, not of any table. So the two
 * constants below are marked ASSUMPTION, derived by counting the instructions
 * in the loop, and recorded in OPEN_QUESTIONS.md. Everything else here comes
 * out of `data/audio.json`.
 *
 * The rendering is a SIMULATION rather than an oscillator. Two oscillators
 * mixed would be the obvious shortcut and it would be wrong: the two music
 * channels do not mix, they take turns. Each writes its own speaker value with
 * its own OUT ($F50C and $F51D), so the cone follows whichever channel toggled
 * most recently, and that interference IS the sound of a Spectrum playing two
 * notes at once.
 */

import audioJson from '../../data/audio.json';
import { decodeBase64 } from '../data/load.js';

const audio = audioJson as unknown as {
  channel0: { data: string };
  channel1: { data: string };
  semitoneToFrequency: { data: string };
};

/** music_channel0_data ($F546) and music_channel1_data ($F7C7). */
export const channel0: Uint8Array = decodeBase64(audio.channel0.data);
export const channel1: Uint8Array = decodeBase64(audio.channel1.data);
/** semitone_to_frequency ($FA48): 76 words. */
const semitoneTable: Uint8Array = decodeBase64(audio.semitoneToFrequency.data);

export const SEMITONE_COUNT = semitoneTable.length / 2;

/** End-of-song marker; $F4C9/$F4E2 reset the index to zero on it. */
export const END_OF_SONG = 0xff;

/**
 * ASSUMPTION: a 48K Spectrum's 3.5 MHz clock.
 *
 * Not in the disassembly, because it is a property of the machine rather than
 * of the game. See OPEN_QUESTIONS.md.
 */
export const Z80_CLOCK_HZ = 3_500_000;

/**
 * ASSUMPTION: 48 T-states per iteration of the music loop's inner loop.
 *
 * Counted from the instructions on the common path, where neither channel's
 * counter reaches zero:
 *
 *   $F502 DJNZ (taken)  13
 *   $F510 EXX            4
 *   $F511 DJNZ (taken)  13
 *   $F51F EXX            4
 *   $F520 DEC H          4
 *   $F521 JP NZ         10
 *
 * The paths that DO toggle the speaker are longer, so the real average is a
 * little above 48 and the tune comes out a little sharp. Getting it exact
 * needs full T-state accounting of a loop whose cost depends on the notes
 * being played, which is a bigger piece of work than the ear can justify.
 */
export const MUSIC_INNER_LOOP_T_STATES = 48;

export const MUSIC_ITERATIONS_PER_SECOND = Z80_CLOCK_HZ / MUSIC_INNER_LOOP_T_STATES;

/**
 * How long one note lasts, in inner-loop iterations.
 *
 * $F4FD `LD A,$18` is the major counter and $F500 `LD H,$FF` the minor, giving
 * 24 * 255 -- the disassembly's own comment says "Iterate 6,120 times".
 */
export const NOTE_ITERATIONS = 24 * 255;

/**
 * frequency_for_semitone ($F52C): iterations between speaker toggles.
 *
 * The table holds a word per semitone; $F534 loads the low byte into B and the
 * high into C, then $F537..$F53B increments BOTH and increments C a second
 * time if B wrapped. B is what DJNZ counts down and C is only decremented when
 * B reaches zero, so the number of iterations before a toggle is
 * `B + 256 * (C - 1)` -- NOT `C * 256 + B`, which reads plausibly, is out by
 * 256, and turns a clean chromatic scale into a set of frequencies that are
 * neither musical nor obviously wrong.
 */
export function semitonePeriod(semitone: number): number {
  const i = (semitone & 0xff) * 2;
  const lo = semitoneTable[i] ?? 0;
  const hi = semitoneTable[i + 1] ?? 0;

  let c = (hi + 1) & 0xff; // $F537 INC C
  const b = (lo + 1) & 0xff; // $F538 INC B
  if (b === 0) c = (c + 1) & 0xff; // $F53B, only when B rolled over
  return b + 256 * ((c - 1) & 0xff);
}

/**
 * $F4EE..$F4FA: a channel-1 note whose low byte is $FF plays channel 0's.
 *
 * The test is on B -- the frequency's low byte after the increments -- so it
 * catches exactly the semitones whose table entry ends $FE. Semitone 0 is the
 * only one, which makes it channel 1's rest: "when the second channel is
 * silent use the first channel's frequency".
 */
export function channel1FollowsChannel0(semitone: number): boolean {
  const lo = semitoneTable[(semitone & 0xff) * 2] ?? 0;
  return ((lo + 1) & 0xff) === 0xff;
}

/** How many notes the tune has, up to its end-of-song marker. */
export function tuneLength(): number {
  const end = channel0.indexOf(END_OF_SONG);
  return end < 0 ? channel0.length : end;
}

/**
 * Simulate the speaker over one note and return its samples.
 *
 * Each channel counts down its own period and flips its own copy of the
 * speaker bit; the cone takes whichever value was written last. Samples are
 * box-averaged over the iterations they span rather than point-sampled, which
 * costs nothing and keeps a 700 Hz square wave from aliasing against 44.1 kHz.
 */
function renderNote(
  out: Float32Array<ArrayBuffer>,
  offset: number,
  samples: number,
  period0: number,
  period1: number,
  iterationsPerSample: number,
  state: { speaker: number; c0: number; c1: number; l0: number; l1: number },
): void {
  let carry = 0;
  for (let s = 0; s < samples; s++) {
    let steps = iterationsPerSample + carry;
    const whole = Math.floor(steps);
    carry = steps - whole;
    steps = whole;

    let sum = 0;
    for (let i = 0; i < steps; i++) {
      if (--state.c0 <= 0) {
        state.c0 = period0;
        state.l0 ^= 1; // $F509 XOR $10
        state.speaker = state.l0; // $F50C OUT ($FE),A
      }
      if (--state.c1 <= 0) {
        state.c1 = period1;
        state.l1 ^= 1; // $F51A
        state.speaker = state.l1; // $F51D -- the LAST writer wins
      }
      sum += state.speaker;
    }
    out[offset + s] = steps > 0 ? (sum / steps) * 2 - 1 : state.speaker * 2 - 1;
  }
}

export interface TuneOptions {
  /** Stop after this many notes. Defaults to the whole tune. */
  notes?: number;
  /** Peak amplitude. The beeper is loud; 0.15 is comfortable. */
  gain?: number;
}

/**
 * menu_screen's tune ($F4B7), rendered to mono samples.
 *
 * Both channels walk their own byte array of semitones, restarting at the
 * $FF marker ($F4CD / $F4E6), and every note lasts NOTE_ITERATIONS.
 */
export function renderTune(sampleRate: number, opts: TuneOptions = {}): Float32Array<ArrayBuffer> {
  const notes = opts.notes ?? tuneLength();
  const gain = opts.gain ?? 0.15;
  const iterationsPerSample = MUSIC_ITERATIONS_PER_SECOND / sampleRate;
  const samplesPerNote = Math.round(NOTE_ITERATIONS / iterationsPerSample);

  const out = new Float32Array(new ArrayBuffer(notes * samplesPerNote * 4));
  const state = { speaker: 0, c0: 1, c1: 1, l0: 0, l1: 0 };

  for (let n = 0; n < notes; n++) {
    // $F4C4 / $F4DD: each channel indexes its own array, and $FF restarts it.
    const s0 = channel0[n % channel0.length] ?? 0;
    const s1 = channel1[n % channel1.length] ?? 0;
    const period0 = semitonePeriod(s0 === END_OF_SONG ? 0 : s0);
    const period1 = channel1FollowsChannel0(s1)
      ? period0
      : semitonePeriod(s1 === END_OF_SONG ? 0 : s1);

    state.c0 = period0;
    state.c1 = period1;
    renderNote(out, n * samplesPerNote, samplesPerNote, period0, period1,
      iterationsPerSample, state);
  }

  for (let i = 0; i < out.length; i++) out[i]! *= gain;
  return out;
}

/**
 * play_speaker ($A11D): B square-wave half-periods with a delay of C.
 *
 * The delay is a `DEC C / JR NZ` loop, 4 + 12 T-states per turn, wrapped in
 * the OUT, the XOR and the DJNZ. So a half-period is roughly `16 * delay + 31`
 * T-states -- another ASSUMPTION of the same kind as the music loop's, and
 * recorded in the same place.
 */
export const SPEAKER_DELAY_T_STATES = 16;
export const SPEAKER_OVERHEAD_T_STATES = 31;

/** Every play_speaker call in the game, by the BC its caller loads. */
export const SOUNDS = {
  /** $7B84 LD BC,$3030 */
  pickUpItem: { iterations: 0x30, delay: 0x30 },
  /** $7BA8 LD BC,$3040 */
  dropItem: { iterations: 0x30, delay: 0x40 },
  /** $A0C1 LD BC,$2530 */
  bell: { iterations: 0x25, delay: 0x30 },
  /** $C57C LD BC,$2040 then $C582 LD BC,$2030 -- two tones, in that order. */
  characterEntersA: { iterations: 0x20, delay: 0x40 },
  characterEntersB: { iterations: 0x20, delay: 0x30 },
  /** $CB0C LD BC,$2030 */
  characterEnters1: { iterations: 0x20, delay: 0x30 },
} as const;

export type SoundName = keyof typeof SOUNDS;

/** Render one play_speaker call to mono samples. */
export function renderEffect(
  iterations: number,
  delay: number,
  sampleRate: number,
  gain = 0.15,
): Float32Array<ArrayBuffer> {
  const halfPeriodT = SPEAKER_DELAY_T_STATES * delay + SPEAKER_OVERHEAD_T_STATES;
  const halfPeriodSamples = (halfPeriodT / Z80_CLOCK_HZ) * sampleRate;
  const total = Math.max(1, Math.round(halfPeriodSamples * iterations));

  const out = new Float32Array(new ArrayBuffer(total * 4));
  for (let i = 0; i < total; i++) {
    // $A121 starts with the bit SET, and $A12A toggles after each delay.
    const half = Math.floor(i / halfPeriodSamples);
    out[i] = (half % 2 === 0 ? 1 : -1) * gain;
  }
  return out;
}

/**
 * Web Audio playback for the two things above.
 *
 * Kept apart from the rendering so that everything with a right answer can be
 * tested without an AudioContext. This half has none: it schedules buffers.
 *
 * Two deliberate deviations, both browser rather than game:
 *
 * - **Nothing plays until the user has interacted with the page.** Browsers
 *   refuse to start an AudioContext otherwise. `resume()` is therefore called
 *   from the first key or click, and until then `start()` records the
 *   intention and does nothing audible.
 * - **The tune is rendered once and looped.** The original re-derives every
 *   note from the tables on every pass round menu_screen's infinite loop;
 *   there is no way to hear the difference, and 54 seconds of samples is
 *   cheaper to hold than to recompute.
 */
export class Beeper {
  private ctx: AudioContext | null = null;
  private tune: AudioBufferSourceNode | null = null;
  private tuneBuffer: AudioBuffer | null = null;
  private wantTune = false;

  /** True once the browser has let us start. */
  get running(): boolean {
    return this.ctx !== null && this.ctx.state === 'running';
  }

  /**
   * Called from a user gesture. Safe to call repeatedly.
   *
   * Creating the context lazily rather than at module load matters: a context
   * created before any interaction starts life suspended, and some browsers
   * never let it out again.
   */
  resume(): void {
    if (!this.ctx) {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!Ctor) return; // no Web Audio at all; every call below is a no-op
      this.ctx = new Ctor();
    }
    void this.ctx.resume();
    if (this.wantTune) this.startTune();
  }

  /** menu_screen's music. Idempotent. */
  startTune(): void {
    this.wantTune = true;
    if (!this.ctx || this.ctx.state !== 'running' || this.tune) return;

    if (!this.tuneBuffer) {
      const samples = renderTune(this.ctx.sampleRate);
      this.tuneBuffer = this.ctx.createBuffer(1, samples.length, this.ctx.sampleRate);
      this.tuneBuffer.copyToChannel(samples, 0);
    }
    const node = this.ctx.createBufferSource();
    node.buffer = this.tuneBuffer;
    node.loop = true;
    node.connect(this.ctx.destination);
    node.start();
    this.tune = node;
  }

  /** $F271: starting a game is what stops the music. */
  stopTune(): void {
    this.wantTune = false;
    this.tune?.stop();
    this.tune?.disconnect();
    this.tune = null;
  }

  /** One play_speaker call ($A11D). */
  play(sound: SoundName): void {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const { iterations, delay } = SOUNDS[sound];
    const samples = renderEffect(iterations, delay, this.ctx.sampleRate);
    const buffer = this.ctx.createBuffer(1, samples.length, this.ctx.sampleRate);
    buffer.copyToChannel(samples, 0);
    const node = this.ctx.createBufferSource();
    node.buffer = buffer;
    node.connect(this.ctx.destination);
    node.start();
  }

  /**
   * ring_bell ($A09E) plots the ringer and plays the bell on alternate calls.
   *
   * The alternation is the GAME's, driven by reading the ringer's own graphic
   * back off the screen ($A0B0) -- so this only makes the sound, and the
   * caller decides when.
   */
  ringBell(): void {
    this.play('bell');
  }
}
