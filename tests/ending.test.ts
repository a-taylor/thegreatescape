/**
 * escaped ($A51C): the win/lose screen tests.
 *
 * The combination table is transcribed directly from the disassembly's own
 * comment above escaped_success/escaped_captured ($A540/$A54E), which lists
 * all eleven reachable combinations of the two held-item slots. Testing
 * every row is what catches a single miscompared bit rather than just the
 * two combinations a smoke test would happen to pick.
 */

import { describe, expect, it } from 'vitest';

import { ITEM_NONE } from '../src/game/inventory.js';
import { SpectrumScreen, screenAddress, screenCoords } from '../src/spectrum/display.js';
import { fontBitmaps, glyphChars } from '../src/ui/glyphs.js';
import {
  MSG_AND_SHOT_AS_A_SPY,
  MSG_AND_WILL_CROSS_THE,
  MSG_BORDER_SUCCESSFULLY,
  MSG_BUT_WERE_RECAPTURED,
  MSG_DUE_TO_LACK_OF_PAPERS,
  MSG_FROM_THE_CAMP,
  MSG_PRESS_ANY_KEY,
  MSG_TOTALLY_LOST,
  MSG_TOTALLY_UNPREPARED,
  MSG_WELL_DONE,
  MSG_YOU_HAVE_ESCAPED,
  computeEscapeOutcome,
  drawEscapeString,
  escapeStrings,
} from '../src/ui/ending.js';

// item_to_escapeitem's four interesting items ($A5A3).
const ITEM_COMPASS = 0x0f;
const ITEM_PAPERS = 0x03;
const ITEM_PURSE = 0x0e;
const ITEM_UNIFORM = 0x06;

/** Decode a screenlocstring's glyphs back to text, for readable assertions. */
function glyphText(glyphs: readonly number[]): string {
  return glyphs.map((g) => glyphChars[g] ?? '?').join('');
}

describe('escapeStrings ($A5CE)', () => {
  it('parses all eleven screenlocstrings, in ROM order', () => {
    // The font has no letter "O" -- digit zero doubles for it (glyphs.ts,
    // FIDELITY.md) -- so every decoded "O" below is correctly a "0".
    expect(escapeStrings).toHaveLength(11);
    expect(glyphText(escapeStrings[MSG_WELL_DONE]!.glyphs)).toBe('WELL D0NE');
    expect(glyphText(escapeStrings[MSG_YOU_HAVE_ESCAPED]!.glyphs)).toBe('Y0U HAVE ESCAPED');
    expect(glyphText(escapeStrings[MSG_FROM_THE_CAMP]!.glyphs)).toBe('FR0M THE CAMP');
    expect(glyphText(escapeStrings[MSG_AND_WILL_CROSS_THE]!.glyphs)).toBe('AND WILL CR0SS THE');
    expect(glyphText(escapeStrings[MSG_BORDER_SUCCESSFULLY]!.glyphs)).toBe('B0RDER SUCCESSFULLY');
    expect(glyphText(escapeStrings[MSG_BUT_WERE_RECAPTURED]!.glyphs)).toBe('BUT WERE RECAPTURED');
    expect(glyphText(escapeStrings[MSG_AND_SHOT_AS_A_SPY]!.glyphs)).toBe('AND SH0T AS A SPY');
    expect(glyphText(escapeStrings[MSG_TOTALLY_UNPREPARED]!.glyphs)).toBe('T0TALLY UNPREPARED');
    expect(glyphText(escapeStrings[MSG_TOTALLY_LOST]!.glyphs)).toBe('T0TALLY L0ST');
    expect(glyphText(escapeStrings[MSG_DUE_TO_LACK_OF_PAPERS]!.glyphs)).toBe('DUE T0 LACK 0F PAPERS');
    expect(glyphText(escapeStrings[MSG_PRESS_ANY_KEY]!.glyphs)).toBe('PRESS ANY KEY');
  });

  it('draws a string at its own screen address, glyph by glyph', () => {
    const screen = new SpectrumScreen();
    drawEscapeString(screen, MSG_PRESS_ANY_KEY);

    const s = escapeStrings[MSG_PRESS_ANY_KEY]!;
    const { col, row } = screenCoords(s.screenAddress);
    let out = '';
    for (let i = 0; i < s.glyphs.length; i++) {
      const rows: number[] = [];
      for (let r = 0; r < 8; r++) rows.push(screen.readByte(screenAddress(col + i, row + r)));
      let found = -1;
      for (let g = 0; g < fontBitmaps.length / 8; g++) {
        if (rows.every((b, r) => b === fontBitmaps[g * 8 + r])) { found = g; break; }
      }
      out += found < 0 ? '?' : glyphChars[found] ?? '?';
    }
    expect(out).toBe('PRESS ANY KEY');
  });
});

describe('computeEscapeOutcome ($A51C)', () => {
  const intro = [MSG_WELL_DONE, MSG_YOU_HAVE_ESCAPED, MSG_FROM_THE_CAMP];

  it('wins with compass + purse: "AND WILL CROSS THE BORDER SUCCESSFULLY" ($A538)', () => {
    const out = computeEscapeOutcome([ITEM_COMPASS, ITEM_PURSE]);
    expect(out).toEqual({
      lines: [...intro, MSG_AND_WILL_CROSS_THE, MSG_BORDER_SUCCESSFULLY],
      won: true,
      resetsGame: true,
    });
  });

  it('wins with compass + papers, and offers no extra message ($A53C)', () => {
    const out = computeEscapeOutcome([ITEM_COMPASS, ITEM_PAPERS]);
    expect(out).toEqual({ lines: intro, won: true, resetsGame: true });
  });

  it.each([
    ['nothing', ITEM_NONE, ITEM_NONE, MSG_TOTALLY_UNPREPARED],
    ['compass alone', ITEM_COMPASS, ITEM_NONE, MSG_DUE_TO_LACK_OF_PAPERS],
    ['papers alone', ITEM_PAPERS, ITEM_NONE, MSG_TOTALLY_LOST],
    ['purse alone', ITEM_PURSE, ITEM_NONE, MSG_TOTALLY_LOST],
    ['purse + papers', ITEM_PURSE, ITEM_PAPERS, MSG_TOTALLY_LOST],
  ] as const)('loses to solitary with %s: the matching message', (_label, a, b, message) => {
    const out = computeEscapeOutcome([a, b]);
    expect(out.won).toBe(false);
    expect(out.resetsGame).toBe(false); // $A584: not wearing the uniform
    expect(out.lines).toEqual([...intro, MSG_BUT_WERE_RECAPTURED, message]);
  });

  it.each([
    ['uniform alone', ITEM_UNIFORM, ITEM_NONE],
    ['uniform + compass', ITEM_UNIFORM, ITEM_COMPASS],
    ['uniform + papers', ITEM_UNIFORM, ITEM_PAPERS],
    ['uniform + purse', ITEM_UNIFORM, ITEM_PURSE],
  ] as const)('loses AND resets when caught wearing the uniform: %s ($A557/$A584)', (_label, a, b) => {
    const out = computeEscapeOutcome([a, b]);
    expect(out.won).toBe(false);
    expect(out.resetsGame).toBe(true);
    expect(out.lines).toEqual([...intro, MSG_BUT_WERE_RECAPTURED, MSG_AND_SHOT_AS_A_SPY]);
  });
});
