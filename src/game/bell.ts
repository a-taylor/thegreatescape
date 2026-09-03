/**
 * ring_bell (c$A09E): the alarm bell, and the little man who rings it.
 *
 * Called THREE times per main-loop iteration ($9D9C, $9DA8, $9DB1), which is
 * what makes the ringer clatter rather than tick.
 *
 * The state is one byte, `bell` ($A130), and its three meanings are documented
 * in the disassembly's own table:
 *
 *     0     ring indefinitely
 *     255   don't ring
 *     N     ring for N calls
 *
 * The quirk worth knowing is how it alternates. There is no phase counter: the
 * routine reads the ringer's own graphic back OFF THE SCREEN ($A0B0 loads
 * $518E) and compares it against $3F, which is the first byte of
 * `bell_ringer_bitmap_on`. So "which frame am I on" is answered by looking at
 * the display file, and the sound plays only on the calls that turn the ringer
 * ON ($A0C1). Three calls a frame therefore give one or two rings depending on
 * which state the frame began in.
 *
 * (The disassembly's comment at $A0C6 says "bell_ringer_bitmap_on" while the
 * instruction loads $A147, which is `bell_ringer_bitmap_off`. The address is
 * right and the comment is a slip.)
 */

/** bell_RING_PERPETUAL ($A0A5 AND A / JR Z). */
export const BELL_RING_PERPETUAL = 0x00;
/** bell_STOP ($A0A2 CP $FF). */
export const BELL_STOP = 0xff;

/** The first byte of bell_ringer_bitmap_on ($A153), which $A0B3 tests for. */
export const RINGER_ON_FIRST_BYTE = 0x3f;

/** bell ($A130). */
export interface BellState {
  counter: number;
}

export function createBell(): BellState {
  // $A130 DEFB $FF -- the shipped value is "don't ring".
  return { counter: BELL_STOP };
}

export interface BellContext {
  /**
   * The byte currently at screenaddr_bell_ringer ($518E).
   *
   * Read from the screen, not from a flag, because that is where the game
   * keeps it. Modelling it as a boolean somewhere else would be the "one game
   * field, two objects" mistake with an extra step.
   */
  ringerByte(): number;
  /** plot_ringer ($A0C9). */
  plotRinger(on: boolean): void;
  /** play_speaker with BC = $2530 ($A0C1). */
  playBell(): void;
}

export type BellResult = 'stopped' | 'turned-on' | 'turned-off';

/** One call of ring_bell. */
export function ringBell(s: BellState, ctx: BellContext): BellResult {
  if (s.counter === BELL_STOP) return 'stopped'; // $A0A2

  if (s.counter !== BELL_RING_PERPETUAL) {
    // $A0A8: count down, and stop when the count is used up.
    s.counter = (s.counter - 1) & 0xff;
    if (s.counter === 0) {
      s.counter = BELL_STOP; // $A0AC
      return 'stopped';
    }
  }

  // $A0B0: the ringer's own graphic says which half of the animation this is.
  if (ctx.ringerByte() === RINGER_ON_FIRST_BYTE) {
    ctx.plotRinger(false); // $A0C6, the OFF bitmap
    return 'turned-off';
  }

  ctx.plotRinger(true); // $A0BB
  ctx.playBell(); // $A0C1
  return 'turned-on';
}
