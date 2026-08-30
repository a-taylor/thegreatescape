/**
 * Morale, score, and the panel that draws them.
 *
 * The interesting cases are the ones where a plausible simplification gives a
 * different answer: the score is digits rather than a number, the flag chases
 * morale rather than tracking it, and the flag's attribute block steps by a
 * full row only because the write loop already advanced the pointer.
 */

import { describe, expect, it } from 'vitest';

import {
  MESSAGE_MORALE_IS_ZERO,
  MORALE_MAX,
  MORALE_MIN,
  checkMorale,
  createPlayer,
  decreaseMorale,
  increaseMorale,
  increaseMoraleBy5ScoreBy5,
  increaseMoraleBy10ScoreBy50,
  increaseScore,
  scoreValue,
} from '../src/game/player.js';
import {
  SpectrumScreen,
  nextScanlineDown,
  nextScanlineUp,
  screenAddress,
  screenCoords,
} from '../src/spectrum/display.js';
import {
  FLAG_HEIGHT,
  MORALE_FLAG_START_ADDRESS,
  SCORE_SCREEN_ADDRESS,
  flagDown,
  flagUp,
  plotBitmap,
  plotScore,
  setMoraleFlagScreenAttributes,
  waveMoraleFlag,
} from '../src/ui/panel.js';
import { fontBitmaps } from '../src/ui/glyphs.js';

describe('morale', () => {
  it('starts at the maximum ($A13C DEFB $70)', () => {
    expect(createPlayer().morale).toBe(MORALE_MAX);
    expect(MORALE_MAX).toBe(112);
  });

  it('clamps rather than wrapping at both ends', () => {
    const p = createPlayer();
    increaseMorale(p, 50);
    expect(p.morale).toBe(MORALE_MAX);

    p.morale = 3;
    decreaseMorale(p, 10);
    expect(p.morale).toBe(MORALE_MIN);

    // The clamp is on the borrow ($A0E4 JR NC), so an exact zero is not a
    // special case and must not clamp to something else.
    p.morale = 10;
    decreaseMorale(p, 10);
    expect(p.morale).toBe(0);
  });
});

describe('score', () => {
  it('is five digits, carried by hand', () => {
    const p = createPlayer();
    increaseScore(p, 9);
    expect([...p.score]).toEqual([0, 0, 0, 0, 9]);
    increaseScore(p, 1);
    expect([...p.score]).toEqual([0, 0, 0, 1, 0]);
    increaseScore(p, 90);
    expect([...p.score]).toEqual([0, 0, 1, 0, 0]);
    expect(scoreValue(p)).toBe(100);
  });

  it('carries through several digits at once', () => {
    const p = createPlayer();
    p.score.set([0, 9, 9, 9, 9]);
    increaseScore(p, 1);
    expect([...p.score]).toEqual([1, 0, 0, 0, 0]);
  });

  it('saturates at 99999 by dropping the carry off the top', () => {
    const p = createPlayer();
    p.score.set([9, 9, 9, 9, 9]);
    increaseScore(p, 1);
    // Every digit rolls to zero and the carry has nowhere to go.
    expect([...p.score]).toEqual([0, 0, 0, 0, 0]);
  });

  it('awards the two combined helpers exactly ($A0E9, $A0F2)', () => {
    const a = createPlayer();
    a.morale = 0;
    increaseMoraleBy10ScoreBy50(a);
    expect(a.morale).toBe(10);
    expect(scoreValue(a)).toBe(50);

    const b = createPlayer();
    b.morale = 0;
    increaseMoraleBy5ScoreBy5(b);
    expect(b.morale).toBe(5);
    expect(scoreValue(b)).toBe(5);
  });
});

describe('scanline stepping', () => {
  it('agrees with screenAddress across every row of a column', () => {
    for (let y = 0; y < 191; y++) {
      expect(nextScanlineDown(screenAddress(5, y))).toBe(screenAddress(5, y + 1));
    }
    for (let y = 1; y < 192; y++) {
      expect(nextScanlineUp(screenAddress(5, y))).toBe(screenAddress(5, y - 1));
    }
  });

  it('crosses the boundary between thirds', () => {
    // Pixel row 63 -> 64 is the point where INC H alone gives the wrong answer.
    expect(nextScanlineDown(screenAddress(2, 63))).toBe(screenAddress(2, 64));
    expect(nextScanlineUp(screenAddress(2, 64))).toBe(screenAddress(2, 63));
  });
});

describe('plot_score', () => {
  it('leaves a one-cell gap between digits ($A118 INC DE)', () => {
    const screen = new SpectrumScreen();
    const p = createPlayer();
    p.score.set([1, 2, 3, 4, 5]);
    plotScore(screen, p);

    const { col, row } = screenCoords(SCORE_SCREEN_ADDRESS);
    expect({ col, row }).toEqual({ col: 20, row: 160 });

    // Digits land on every OTHER column, not five adjacent ones.
    for (let i = 0; i < 5; i++) {
      const digit = i + 1;
      for (let r = 0; r < 8; r++) {
        expect(screen.readByte(screenAddress(col + i * 2, row + r))).toBe(fontBitmaps[digit * 8 + r]);
      }
      // The gap column stays blank.
      if (i < 4) expect(screen.readByte(screenAddress(col + i * 2 + 1, row))).toBe(0);
    }
  });
});

describe('the morale flag', () => {
  it('shares three rows between the up and down bitmaps ($A063)', () => {
    // bitmap_flag_down starts 66 bytes after bitmap_flag_up but 75 are plotted,
    // so the tail of one IS the head of the other. Asserted as the quirk.
    expect(flagUp.length).toBe(FLAG_HEIGHT * 3);
    expect([...flagUp.slice(66, 75)]).toEqual([...flagDown.slice(0, 9)]);
  });

  it('chases morale one step per two frames, and only then', () => {
    const screen = new SpectrumScreen();
    const p = createPlayer();
    p.morale = 4;
    p.displayedMorale = 0;
    p.moraleFlagScreenAddress = MORALE_FLAG_START_ADDRESS;
    const startRow = screenCoords(MORALE_FLAG_START_ADDRESS).row;

    waveMoraleFlag(screen, p); // counter 1: odd, returns early
    expect(p.displayedMorale).toBe(0);
    expect(p.gameCounter).toBe(1);

    waveMoraleFlag(screen, p); // counter 2: steps
    expect(p.displayedMorale).toBe(1);
    // Rising morale moves the flag UP the screen.
    expect(screenCoords(p.moraleFlagScreenAddress).row).toBe(startRow - 1);
  });

  it('still advances the game counter on the frames it does nothing', () => {
    // The increment at $A038 is before the early return at $A03C, so the
    // counter must move on every call -- the day schedule depends on it.
    const screen = new SpectrumScreen();
    const p = createPlayer();
    p.morale = p.displayedMorale;
    for (let i = 0; i < 10; i++) waveMoraleFlag(screen, p);
    expect(p.gameCounter).toBe(10);
  });

  it('falls back down when morale drops', () => {
    const screen = new SpectrumScreen();
    const p = createPlayer();
    p.morale = 0;
    p.displayedMorale = 5;
    p.moraleFlagScreenAddress = MORALE_FLAG_START_ADDRESS;
    const startRow = screenCoords(MORALE_FLAG_START_ADDRESS).row;
    waveMoraleFlag(screen, p);
    waveMoraleFlag(screen, p);
    expect(p.displayedMorale).toBe(4);
    expect(screenCoords(p.moraleFlagScreenAddress).row).toBe(startRow + 1);
  });

  it('flutters between the two bitmaps on bit 1 of the counter ($A061)', () => {
    const seen: string[] = [];
    const screen = new SpectrumScreen();
    const p = createPlayer();
    p.morale = p.displayedMorale;
    for (let i = 0; i < 8; i++) {
      const before = screen.display.slice();
      waveMoraleFlag(screen, p);
      if (screen.display.every((b, n) => b === before[n]) && (p.gameCounter & 1) === 1) continue;
      seen.push((p.gameCounter & 0x02) !== 0 ? 'up' : 'down');
    }
    // Counter 2,4,6,8 -> bit1 set, clear, set, clear.
    expect(seen).toEqual(['up', 'down', 'up', 'down']);
  });
});

describe('set_morale_flag_screen_attributes', () => {
  it('paints 3x19 cells stepping one full attribute row at a time', () => {
    const screen = new SpectrumScreen();
    setMoraleFlagScreenAttributes(screen, 0x45);

    const painted: Array<[number, number]> = [];
    for (let row = 0; row < 24; row++) {
      for (let col = 0; col < 32; col++) {
        if (screen.getAttribute(col, row) === 0x45) painted.push([col, row]);
      }
    }
    expect(painted).toHaveLength(3 * 19);
    // $5842 is attribute cell (2, 2); the block must be a straight rectangle,
    // not a staircase.
    expect(painted[0]).toEqual([2, 2]);
    expect(new Set(painted.map(([c]) => c))).toEqual(new Set([2, 3, 4]));
    expect(new Set(painted.map(([, r]) => r)).size).toBe(19);
  });
});

describe('plot_bitmap', () => {
  it('steps columns with INC L, so a row wraps within its page ($7CC7)', () => {
    const screen = new SpectrumScreen();
    // Start two bytes before the end of a page: the third byte of the row
    // wraps back to the start of the same page rather than moving on.
    const start = 0x40fe;
    plotBitmap(screen, start, 3, 1, [0x11, 0x22, 0x33]);
    expect(screen.readByte(0x40fe)).toBe(0x11);
    expect(screen.readByte(0x40ff)).toBe(0x22);
    expect(screen.readByte(0x4000)).toBe(0x33);
    expect(screen.readByte(0x4100)).toBe(0x00);
  });
});

describe('check_morale', () => {
  it('fires at morale 1 as well as 0 ($9DD2 CP $02)', () => {
    for (const [morale, expected] of [[0, true], [1, true], [2, false], [50, false]] as const) {
      const p = createPlayer();
      p.morale = morale;
      const queued: number[] = [];
      checkMorale(p, (i) => queued.push(i));
      expect({ morale, fired: p.moraleExhausted }).toEqual({ morale, fired: expected });
      expect(queued).toEqual(expected ? [MESSAGE_MORALE_IS_ZERO] : []);
    }
  });

  it('hands the hero to the CPU immediately, not after the usual idle wait', () => {
    // $9DE1 zeroes automatic_player_counter ($A139). That byte lives on
    // AutomaticState -- the copy heroIsAutomatic reads -- so this arrives as
    // a callback. A second copy on PlayerState would be a byte the game
    // never consults.
    const p = createPlayer();
    p.morale = 0;
    let forced = 0;
    checkMorale(p, () => {}, () => { forced++; });
    expect(forced).toBe(1);

    const calm = createPlayer();
    calm.morale = 50;
    let notForced = 0;
    checkMorale(calm, () => {}, () => { notForced++; });
    expect(notForced).toBe(0);
  });
});
