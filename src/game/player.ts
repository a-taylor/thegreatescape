/**
 * Player state: morale, score, and the flags that hang off them.
 *
 * Morale is one byte ($A13C) clamped to 0..112, and the flag on the left of
 * the screen is a SECOND byte ($A140) that chases it one step per two frames.
 * Keeping both is not redundancy -- wave_morale_flag ($A035) reads the
 * difference to decide which way to move the flag, so collapsing them to a
 * single value would freeze the flag at its starting height. Same rule as
 * CLAUDE.md's "one game field, one owner": these are genuinely two fields.
 *
 * The score is five decimal DIGITS ($A132), not a number. increase_score
 * ($A0F9) increments the last digit B times, carrying by hand, so the score
 * saturates at 99999 by silently dropping the carry off the top rather than
 * wrapping -- and a large B costs a loop iteration per point.
 */

/** morale_MAX ($A0D6 CP $70). */
export const MORALE_MAX = 112;
/** morale_MIN ($A0E6 XOR A). */
export const MORALE_MIN = 0;
/** Five digits at score_digits ($A132). */
export const SCORE_DIGITS = 5;

export interface PlayerState {
  /** morale ($A13C), 0..112. reset_game starts it at $70. */
  morale: number;
  /** displayed_morale ($A140): what the flag currently shows. Starts at 0. */
  displayedMorale: number;
  /**
   * moraleflag_screen_address ($A141). The flag's plot position IS the
   * animation state -- there is no height variable, just this pointer moving
   * one scanline at a time.
   */
  moraleFlagScreenAddress: number;
  /** morale_exhausted ($A13B): inhibits player input once morale hits zero. */
  moraleExhausted: boolean;
  /** score_digits ($A132), most significant first. */
  score: Uint8Array;
  /** game_counter ($A12F), incremented by wave_morale_flag. */
  gameCounter: number;
  /** automatic_player_counter ($A139). */
  automaticPlayerCounter: number;
}

export function createPlayer(): PlayerState {
  return {
    morale: MORALE_MAX, // $A13C DEFB $70
    displayedMorale: 0, // $A140 DEFB $00
    moraleFlagScreenAddress: 0x5002, // $A141 DEFW $5002
    moraleExhausted: false, // $A13B DEFB $00
    score: new Uint8Array(SCORE_DIGITS), // $A132 DEFB $00 x5
    gameCounter: 0, // $A12F DEFB $00
    automaticPlayerCounter: 0, // $A139 DEFB $00
  };
}

/** set_morale ($A0DC). */
export function setMorale(p: PlayerState, morale: number): void {
  p.morale = morale;
}

/** increase_morale ($A0D2): add, clamping at the top. */
export function increaseMorale(p: PlayerState, amount: number): void {
  const next = p.morale + amount;
  setMorale(p, next > MORALE_MAX ? MORALE_MAX : next);
}

/**
 * decrease_morale ($A0E0): subtract, clamping at the bottom.
 *
 * The clamp is `JR NC` on the borrow ($A0E4), so it catches the underflow
 * rather than testing for a negative result -- same outcome here, but the
 * reason there is no wrap is the carry flag, not a comparison.
 */
export function decreaseMorale(p: PlayerState, amount: number): void {
  const next = p.morale - amount;
  setMorale(p, next < MORALE_MIN ? MORALE_MIN : next);
}

/**
 * increase_score ($A0F9).
 *
 * Digit-wise in base 10, one full carry pass per point, from the last digit
 * backwards. A carry off the leading digit is simply dropped -- `DEC HL` walks
 * off the front of score_digits into `bell` ($A130) and the unreferenced byte
 * at $A131 on a real overflow, but reaching 100000 needs a score the game
 * cannot award, so this stops at the array edge rather than modelling a read
 * of neighbouring state that never happens.
 */
export function increaseScore(p: PlayerState, amount: number): void {
  for (let n = 0; n < amount; n++) {
    for (let d = SCORE_DIGITS - 1; d >= 0; d--) {
      const v = p.score[d]! + 1;
      if (v !== 10) {
        p.score[d] = v;
        break;
      }
      p.score[d] = 0; // $A103, carry into the next digit up
    }
  }
}

/** The score as a number, for tests and the debug overlay. */
export function scoreValue(p: PlayerState): number {
  return p.score.reduce((acc, d) => acc * 10 + d, 0);
}

/** increase_morale_by_10_score_by_50 ($A0E9). */
export function increaseMoraleBy10ScoreBy50(p: PlayerState): void {
  increaseMorale(p, 10);
  increaseScore(p, 50);
}

/** increase_morale_by_5_score_by_5 ($A0F2). */
export function increaseMoraleBy5ScoreBy5(p: PlayerState): void {
  increaseMorale(p, 5);
  increaseScore(p, 5);
}

/**
 * Message index 15, messages_morale_is_zero ($9DD5 LD BC,$0F00).
 *
 * check_morale is the one caller that sets C deliberately; the disassembly
 * notes every other caller passes whatever was left in it ($7D15).
 */
export const MESSAGE_MORALE_IS_ZERO = 0x0f;

/**
 * check_morale ($9DCF): the game-over check, run once per main-loop turn.
 *
 * Fires at morale 0 OR 1 -- the test is `CP $02 / RET NC` ($9DD2), not a
 * comparison against zero, so the last point of morale is already too late.
 *
 * It does three things and all three matter: queue the message, set the
 * exhausted flag that inhibits input, and zero the automatic player counter so
 * the CPU takes the hero over IMMEDIATELY rather than after the usual 31
 * idle turns ($9DE0).
 *
 * `src/game/` does not import `src/ui/`, so the queue arrives as a callback.
 */
export function checkMorale(p: PlayerState, queue: (index: number, c?: number) => void): void {
  if (p.morale >= 2) return; // $9DD4 RET NC
  queue(MESSAGE_MORALE_IS_ZERO, 0);
  p.moraleExhausted = true; // $A13B <- $FF
  p.automaticPlayerCounter = 0; // $9DE1
}
