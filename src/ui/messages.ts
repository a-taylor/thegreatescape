/**
 * The message queue and the one-character-at-a-time message line.
 *
 * Messages type themselves onto the bottom row of the screen a character per
 * frame, sit for 31 frames, then wipe themselves backwards a character per
 * frame. One byte drives all three phases: message_display_index ($7D10) is
 * the character position while below 128, the signal to fetch the next message
 * when exactly 128, and the wipe cursor when above it.
 *
 * The queue itself is modelled as the real 19 bytes rather than as a list,
 * because two of its behaviours are properties of the memory layout:
 *
 *  - the two $FF bytes at $7CFC/$7CFD sit BEFORE the declared queue start, and
 *    queue_message reads them ($7D1C steps back two) when deduplicating
 *    against an empty queue;
 *  - next_message discards the head by shunting the whole queue two bytes
 *    DOWN, into those same two bytes, so after the first message has played
 *    they no longer hold $FF -- they hold the message just consumed, and the
 *    dedup silently suppresses an immediate repeat of it.
 *
 * A list-of-pending-indexes model gets the second one wrong.
 */

import textJson from '../../data/text.json';
import { SpectrumScreen } from '../spectrum/display.js';
import { GLYPH_SPACE, plotSingleGlyph } from './glyphs.js';

const text = textJson as unknown as {
  messagesTable: {
    messages: Array<{ index: number; addr: string; labels: string[]; glyphs: number[]; text: string }>;
  };
};

export const messages = text.messagesTable.messages;

/** message_QUEUE_END ($7D18 LD A,$FF). */
export const QUEUE_END = 0xff;
/** message_NEXT ($7D57 CP $80): the display index value meaning "fetch". */
export const MESSAGE_NEXT = 0x80;
/** How long a completed message sits before wiping ($7D75 LD A,$1F). */
export const MESSAGE_HOLD_DELAY = 0x1f;
/** screenaddr_messages ($7D60 LD DE,$50E0): character row 23, column 0. */
export const MESSAGE_SCREEN_ADDRESS = 0x50e0;

/**
 * The queue's memory image, $7CFC..$7D0E inclusive.
 *
 * Index 0 and 1 are the pre-start sentinels; the queue proper is indices 2..17
 * (eight two-byte entries); index 18 is the $FF terminator that makes the
 * "queue full" test work.
 */
const QUEUE_BYTES = 19;
/** message_queue_pointer's initial value, $7CFE, as an index. */
export const QUEUE_START = 2;
const QUEUE_TERMINATOR = 18;

export interface MessageState {
  /** message_queue ($7CFC), as bytes. */
  queue: Uint8Array;
  /** message_queue_pointer ($7D11), as an index into `queue`. */
  pointer: number;
  /** message_display_delay ($7D0F). */
  delay: number;
  /** message_display_index ($7D10). Starts at 128 -- "go and fetch one". */
  displayIndex: number;
  /** current_message_character ($7D13), split into which message and how far. */
  messageIndex: number;
  charIndex: number;
}

export function createMessages(): MessageState {
  const queue = new Uint8Array(QUEUE_BYTES);
  queue[0] = QUEUE_END; // $7CFC DEFB $FF
  queue[1] = QUEUE_END; // $7CFD
  queue[QUEUE_TERMINATOR] = QUEUE_END; // $7D0E
  return {
    queue,
    pointer: QUEUE_START,
    delay: 0,
    displayIndex: MESSAGE_NEXT, // $7D10 DEFB $80
    messageIndex: 0,
    charIndex: 0,
  };
}

/**
 * queue_message ($7D15).
 *
 * `c` is the second byte of the entry. The disassembly calls its use
 * "puzzling": only check_morale ($9DD5 LD BC,$0F00) sets it deliberately, and
 * every other caller passes whatever happened to be in C. It is never read
 * back for anything except this deduplication, so the default of 0 matches the
 * one caller that means it and keeps the dedup comparing like with like.
 */
export function queueMessage(m: MessageState, index: number, c = 0): void {
  if (m.queue[m.pointer] === QUEUE_END) return; // $7D1B, queue full

  // $7D1C: compare against the entry two bytes back -- which on an empty queue
  // is the pair of sentinels, and after the first shunt is the last message
  // consumed.
  if (m.queue[m.pointer - 2] === index && m.queue[m.pointer - 1] === c) return; // $7D25

  m.queue[m.pointer] = index; // $7D27
  m.queue[m.pointer + 1] = c; // $7D29
  m.pointer += 2;
}

/**
 * next_message ($7D99): pull the head of the queue and start displaying it.
 *
 * The second byte of the entry is loaded at $7DA5 and then never used -- the
 * disassembly marks it "Bug: C is loaded here but not used. This could be a
 * hangover from 16-bit message IDs". Nothing observable depends on it, so it
 * is simply not read here.
 */
export function nextMessage(m: MessageState): void {
  if (m.pointer === QUEUE_START) return; // $7DA1, nothing queued

  m.messageIndex = m.queue[QUEUE_START]!; // $7DA3
  m.charIndex = 0;

  // $7DB5 LDIR: 16 bytes from $7CFE down to $7CFC. The head is overwritten
  // into the sentinel slots and every later entry moves up one place.
  m.queue.copyWithin(0, QUEUE_START, QUEUE_START + 16);

  m.pointer -= 2; // $7DC3
  m.displayIndex = 0; // $7DC8
}

/** wipe_message ($7D87): erase one character, from the right. */
export function wipeMessage(m: MessageState, screen: SpectrumScreen): void {
  m.displayIndex = (m.displayIndex - 1) & 0xff; // $7D8A
  // $7D91 OR E against $E0: bit 7 of the index is absorbed by the $E0, so the
  // column is the low five bits and the wipe walks back to column 0 exactly as
  // the display walked forward.
  const addr = (MESSAGE_SCREEN_ADDRESS & 0xff00) | (m.displayIndex | 0xe0);
  plotSingleGlyph(screen, addr, GLYPH_SPACE); // $7D93
}

/**
 * message_display ($7D48): the whole thing, called once per main-loop turn.
 */
export function messageDisplay(m: MessageState, screen: SpectrumScreen): void {
  if (m.delay !== 0) {
    m.delay--; // $7D4F
    return;
  }

  if (m.displayIndex === MESSAGE_NEXT) {
    nextMessage(m); // $7D59
    return;
  }
  if (m.displayIndex > MESSAGE_NEXT) {
    wipeMessage(m, screen); // $7D5B
    return;
  }

  const glyphs = messages[m.messageIndex]!.glyphs;
  const addr = (MESSAGE_SCREEN_ADDRESS & 0xff00) | (m.displayIndex | 0xe0);
  plotSingleGlyph(screen, addr, glyphs[m.charIndex]!);
  m.displayIndex = (m.displayIndex + 1) & 0x1f; // $7D69 AND $1F

  if (m.charIndex + 1 >= glyphs.length) {
    // $7D70: the next byte is the $FF terminator.
    m.delay = MESSAGE_HOLD_DELAY; // $7D75
    m.displayIndex |= MESSAGE_NEXT; // $7D7D
    return;
  }
  m.charIndex++; // $7D83
}

/** Whether anything is currently on the message line, for the debug overlay. */
export function messageOnScreen(m: MessageState): boolean {
  return m.displayIndex !== MESSAGE_NEXT;
}
