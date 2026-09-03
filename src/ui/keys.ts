/**
 * choose_keys (c$F350): the key redefinition screen.
 *
 * Wipe the game window, draw six prompts -- CHOOSE KEYS, then LEFT, RIGHT, UP,
 * DOWN, FIRE -- and wait for five keypresses, naming each one on screen as it
 * is taken. Then ask the player to confirm, and start again if they say no.
 *
 * Three rules come out of the keyscan loop and none of them is obvious from
 * the prompts:
 *
 * - **A key must be RELEASED before the next one counts.** $F389 sets a
 *   debounce flag to $FF and only $F395 clears it, on a full pass of the
 *   keyboard with nothing held. Hold a key down and it defines one direction,
 *   not five.
 * - **A key already taken is silently ignored.** $F3AE walks the keydefs
 *   looking for a matching (port, mask) and loops back if it finds one
 *   ($F3BE), so the same key cannot be two directions.
 * - **The first empty slot is the one that gets filled.** $F3B3 tests the
 *   port for zero, which is why $F376 clears the whole table first. There is
 *   no separate "which prompt am I on" counter; the table IS the counter.
 *
 * Reproduced as a state machine rather than a blocking loop, for the same
 * reason the zoombox is: a browser cannot block. The rules above are
 * unchanged.
 */

import frontendJson from '../../data/frontend.json';
import { SpectrumScreen, screenCoords } from '../spectrum/display.js';
import { VISIBLE_PIXEL_ROWS, WINDOW_ORIGIN_COL, wipeGameWindow } from '../render/window.js';
import { plotGlyphs } from './glyphs.js';
import {
  KEYDEF_NAMES,
  type SpectrumKey,
  glyphsForKey,
  isSpectrumKey,
  keyForCode,
} from './keyboard.js';
import { ATTRIBUTE_WHITE_OVER_BLACK } from './menu.js';

interface Screenlocstring {
  readonly screenAddress: string;
  readonly glyphs: readonly number[];
  readonly text: string;
}

const frontend = frontendJson as unknown as {
  defineKeyPrompts: { strings: Screenlocstring[] };
  keyNameScreenAddrs: { values: string[] };
  confirmQuery: { strings: Screenlocstring[] };
};

/** define_key_prompts ($F2AD): CHOOSE KEYS, LEFT, RIGHT, UP, DOWN, FIRE. */
export const prompts: readonly Screenlocstring[] = frontend.defineKeyPrompts.strings;
/** key_name_screen_addrs ($F32B): where each chosen key's name is plotted. */
export const keyNameAddresses: readonly number[] = frontend.keyNameScreenAddrs.values.map(
  (s) => parseInt(s.slice(1), 16),
);
/** confirm_query ($F014). */
export const confirmQuery: Screenlocstring | undefined = frontend.confirmQuery.strings[0];

/** How many keys the player defines. */
export const KEYDEF_COUNT = KEYDEF_NAMES.length;

export type ChooseKeysPhase = 'choosing' | 'confirming' | 'done';

/** keydefs ($F06B), as the screen fills them in. */
export interface ChooseKeysState {
  phase: ChooseKeysPhase;
  /** One slot per direction; null is $F3B3's "port is zero" empty slot. */
  keydefs: (SpectrumKey | null)[];
  /** $F389: a key must be released before the next is taken. */
  armed: boolean;
}

export function createChooseKeys(): ChooseKeysState {
  // $F376 ck_clear_keydef: the table is wiped before anything is read.
  return { phase: 'choosing', keydefs: Array(KEYDEF_COUNT).fill(null), armed: true };
}

/** The next slot to fill, or -1 when they are all taken ($F3B1 walk). */
export function nextSlot(s: ChooseKeysState): number {
  return s.keydefs.findIndex((k) => k === null);
}

/** $F3B6/$F3BB: is this exact (port, mask) already spoken for? */
export function alreadyTaken(s: ChooseKeysState, key: SpectrumKey): boolean {
  return s.keydefs.some((k) => k !== null && k.port === key.port && k.mask === key.mask);
}

/**
 * One keypress.
 *
 * `code` is a browser key code; it becomes a (port, mask) through the matrix,
 * and anything not on a Spectrum keyboard is simply not a key here.
 */
export function chooseKeysKeyDown(s: ChooseKeysState, code: string): void {
  if (s.phase !== 'choosing') return;
  if (!s.armed) return; // $F3A9: still waiting for the last key to come up

  const key = keyForCode(code);
  if (!isSpectrumKey(key)) return;
  if (alreadyTaken(s, key)) return; // $F3BE

  const slot = nextSlot(s);
  if (slot < 0) return;
  s.keydefs[slot] = key; // $F3C1/$F3C3
  s.armed = false;

  if (nextSlot(s) < 0) s.phase = 'confirming'; // $F401 -> user_confirm
}

/** Any key coming up re-arms the scan ($F395 clears the debounce flag). */
export function chooseKeysKeyUp(s: ChooseKeysState): void {
  s.armed = true;
}

/**
 * user_confirm ($EFFC): Y accepts, N starts the screen over.
 *
 * Y is port $DFFE bit 4 and N is port $7FFE bit 3; modelled by key code, since
 * the matrix is only needed where the game stores a matrix position.
 */
export function chooseKeysConfirm(s: ChooseKeysState, code: string): boolean {
  if (s.phase !== 'confirming') return false;
  if (code === 'KeyY') {
    s.phase = 'done';
    return true;
  }
  if (code === 'KeyN') {
    // $F405 JP NZ,$F350 -- the whole screen runs again, table and all.
    s.phase = 'choosing';
    s.keydefs = Array(KEYDEF_COUNT).fill(null);
    s.armed = false;
  }
  return false;
}

/**
 * Draw the screen: $F350's wipe, its prompts, and every key named so far.
 *
 * Pure, so it can be called every frame -- the original draws the prompts once
 * and each key name as it is taken, but redrawing the lot is the same pixels.
 */
export function drawChooseKeys(screen: SpectrumScreen, s: ChooseKeysState): void {
  wipeGameWindow(screen); // $F350 CALL $F335
  setWindowAttributesWhite(screen); // $F355 -> attribute_WHITE_OVER_BLACK

  for (const p of prompts) {
    plotGlyphs(screen, parseInt(p.screenAddress.slice(1), 16), p.glyphs);
  }
  s.keydefs.forEach((key, i) => {
    if (!key) return;
    const addr = keyNameAddresses[i];
    if (addr !== undefined) plotGlyphs(screen, addr, glyphsForKey(key));
  });

  if (s.phase === 'confirming' && confirmQuery) {
    plotGlyphs(
      screen,
      parseInt(confirmQuery.screenAddress.slice(1), 16),
      confirmQuery.glyphs,
    );
  }
}

/** $F355: the game window's attributes go white over black for this screen. */
function setWindowAttributesWhite(screen: SpectrumScreen): void {
  const { row } = screenCoords(0x4047); // the window's first row address
  screen.fillAttributes(
    WINDOW_ORIGIN_COL,
    row >> 3,
    23,
    VISIBLE_PIXEL_ROWS >> 3,
    ATTRIBUTE_WHITE_OVER_BLACK,
  );
}
