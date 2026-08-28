/**
 * Message queue and display tests.
 *
 * Two of these assert quirks rather than sensible behaviour: the dedup that
 * outlives the queue being emptied, and the fact that a full queue silently
 * drops messages.
 */

import { describe, expect, it } from 'vitest';

import { SpectrumScreen, screenAddress, screenCoords } from '../src/spectrum/display.js';
import { GLYPH_SPACE, fontBitmaps } from '../src/ui/glyphs.js';
import {
  MESSAGE_HOLD_DELAY,
  MESSAGE_NEXT,
  MESSAGE_SCREEN_ADDRESS,
  QUEUE_START,
  createMessages,
  messageDisplay,
  messages,
  nextMessage,
  queueMessage,
} from '../src/ui/messages.js';

/** Read the message line back as text, using the glyph bitmaps as the key. */
function readLine(screen: SpectrumScreen): string {
  const { col, row } = screenCoords(MESSAGE_SCREEN_ADDRESS);
  let out = '';
  for (let i = 0; i < 32; i++) {
    const rows: number[] = [];
    for (let r = 0; r < 8; r++) rows.push(screen.readByte(screenAddress(col + i, row + r)));
    let found = -1;
    for (let g = 0; g < fontBitmaps.length / 8; g++) {
      if (rows.every((b, r) => b === fontBitmaps[g * 8 + r])) { found = g; break; }
    }
    out += found < 0 ? '?' : (found === GLYPH_SPACE ? ' ' : messagesGlyphChar(found));
  }
  return out.replace(/\s+$/, '');
}

const GLYPHS = '0123456789' + 'ABCDEFGHIJKLMN' + 'PQRSTUVWXYZ' + ' .';
function messagesGlyphChar(g: number): string {
  return GLYPHS[g] ?? '?';
}

describe('the messages table', () => {
  it('holds 20 messages despite the block comment saying 19', () => {
    expect(messages).toHaveLength(20);
    expect(messages[0]!.text).toBe('MISSED R0LL CALL');
    expect(messages[15]!.text).toBe('M0RALE IS ZER0');
  });
});

describe('queue_message', () => {
  it('appends two bytes per entry', () => {
    const m = createMessages();
    queueMessage(m, 3);
    queueMessage(m, 4);
    expect(m.pointer).toBe(QUEUE_START + 4);
    expect([...m.queue.slice(2, 6)]).toEqual([3, 0, 4, 0]);
  });

  it('suppresses an immediate repeat of the same message', () => {
    const m = createMessages();
    queueMessage(m, 3);
    queueMessage(m, 3);
    expect(m.pointer).toBe(QUEUE_START + 2);
  });

  it('still suppresses a repeat AFTER the queue has drained ($7D1C)', () => {
    // The dedup reads the two bytes before the queue start. Those begin as $FF
    // sentinels but next_message shunts the consumed entry into them, so an
    // emptied queue still remembers what it last played. Asserted as the
    // quirk: a list-of-pending-indexes model would let this second queue
    // succeed.
    const m = createMessages();
    queueMessage(m, 9);
    nextMessage(m); // consume it; the queue is now empty
    expect(m.pointer).toBe(QUEUE_START);

    queueMessage(m, 9);
    expect(m.pointer).toBe(QUEUE_START); // rejected, not appended

    queueMessage(m, 10);
    expect(m.pointer).toBe(QUEUE_START + 2); // a different one gets through
  });

  it('drops messages silently once full', () => {
    const m = createMessages();
    for (let i = 0; i < 8; i++) queueMessage(m, i);
    expect(m.pointer).toBe(QUEUE_START + 16);
    queueMessage(m, 12);
    expect(m.pointer).toBe(QUEUE_START + 16); // no room, no complaint
  });
});

describe('message_display', () => {
  it('types a message out one character per turn, then holds, then wipes', () => {
    const screen = new SpectrumScreen();
    const m = createMessages();
    const index = 2; // "BREAKFAST TIME"
    const len = messages[index]!.glyphs.length;
    queueMessage(m, index);

    messageDisplay(m, screen); // fetches
    expect(m.displayIndex).toBe(0);

    for (let i = 0; i < len; i++) messageDisplay(m, screen);
    expect(readLine(screen)).toBe('BREAKFAST TIME');

    // Finished: held for 31 turns with the wipe flag set.
    expect(m.delay).toBe(MESSAGE_HOLD_DELAY);
    expect(m.displayIndex).toBe(MESSAGE_NEXT | len);

    for (let i = 0; i < MESSAGE_HOLD_DELAY; i++) messageDisplay(m, screen);
    expect(readLine(screen)).toBe('BREAKFAST TIME'); // still up

    for (let i = 0; i < len; i++) messageDisplay(m, screen);
    expect(readLine(screen)).toBe('');
    expect(m.displayIndex).toBe(MESSAGE_NEXT);
  });

  it('wipes from the right, one character at a time', () => {
    const screen = new SpectrumScreen();
    const m = createMessages();
    queueMessage(m, 8); // "R0LL CALL", 9 characters
    messageDisplay(m, screen);
    for (let i = 0; i < 9 + MESSAGE_HOLD_DELAY; i++) messageDisplay(m, screen);
    expect(readLine(screen)).toBe('R0LL CALL');
    messageDisplay(m, screen);
    expect(readLine(screen)).toBe('R0LL CAL');
    messageDisplay(m, screen);
    expect(readLine(screen)).toBe('R0LL CA');
  });

  it('plays queued messages in order', () => {
    const screen = new SpectrumScreen();
    const m = createMessages();
    queueMessage(m, 2); // BREAKFAST TIME
    queueMessage(m, 3); // EXERCISE TIME

    const play = (index: number) => {
      const len = messages[index]!.glyphs.length;
      messageDisplay(m, screen); // fetch
      for (let i = 0; i < len; i++) messageDisplay(m, screen);
      const shown = readLine(screen);
      for (let i = 0; i < MESSAGE_HOLD_DELAY + len; i++) messageDisplay(m, screen);
      return shown;
    };

    expect(play(2)).toBe('BREAKFAST TIME');
    expect(play(3)).toBe('EXERCISE TIME');
  });

  it('does nothing when the queue is empty', () => {
    const screen = new SpectrumScreen();
    const m = createMessages();
    for (let i = 0; i < 50; i++) messageDisplay(m, screen);
    expect(m.displayIndex).toBe(MESSAGE_NEXT);
    expect(readLine(screen)).toBe('');
  });
});
