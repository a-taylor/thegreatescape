/**
 * The menu screen: check_menu_keys ($F271), menu_keyscan ($F41C) and
 * set_menu_item_attributes ($F408).
 *
 * Four input devices to choose between and one key to start. The menu text
 * itself is the first eight `key_choice_screenlocstrings`, drawn by
 * `plot_statics_and_menu_text` -- see src/render/statics.ts. All this adds is
 * the highlight and the keys.
 *
 * The highlight is done entirely in attributes: ten cells go bright yellow on
 * the chosen row and back to white on the one it left. There is no redraw of
 * the text at all.
 */

import { ATTRIBUTE_FILE_BASE, SpectrumScreen } from '../spectrum/display.js';

/** attribute_WHITE_OVER_BLACK ($F27F LD E,$07). */
export const ATTRIBUTE_WHITE_OVER_BLACK = 0x07;
/** attribute_BRIGHT_YELLOW_OVER_BLACK ($F16F / $F288 LD E,$46). */
export const ATTRIBUTE_BRIGHT_YELLOW_OVER_BLACK = 0x46;
/** attribute_BRIGHT_GREEN_OVER_BLACK ($F16A LD A,$44), for the morale flag. */
export const ATTRIBUTE_BRIGHT_GREEN_OVER_BLACK = 0x44;

/** $F408 LD HL,$590D -- the first menu item's attributes. */
export const MENU_ITEM_ATTRIBUTES = 0x590d;
/** $F410 ADD A,$40 -- two attribute rows per menu item. */
export const MENU_ITEM_STRIDE = 0x40;
/** $F415 LD B,$0A -- ten cells wide, which is "1 KEYB0ARD". */
export const MENU_ITEM_WIDTH = 0x0a;

/** The four devices, in the order chosen_input_device ($F445) numbers them. */
export const DEVICE_COUNT = 4;

/**
 * set_menu_item_attributes ($F408).
 *
 * Both the row advance and the ten-cell fill are done on L ALONE -- $F40F..
 * $F412 is `LD A,L / ADD A,$40 / LD L,A`, and $F418 is `INC L`. So everything
 * wraps inside the attribute file's $59xx page and never carries into H.
 *
 * That is not a detail to tidy away, because it is what makes a documented bug
 * harmless. main ($F16F) passes index $44 where "it ought to be zero" -- and
 * 68 rows of $40 is 4352, which is 0 mod 256, so L comes back to where it
 * started and item 0 is highlighted exactly as intended. Carry the addition
 * into H and the boot highlight lands somewhere else entirely.
 */
export function setMenuItemAttributes(
  screen: SpectrumScreen,
  index: number,
  attribute: number,
): void {
  let addr = MENU_ITEM_ATTRIBUTES;
  for (let i = 0; i < (index & 0xff); i++) {
    addr = (addr & 0xff00) | ((addr + MENU_ITEM_STRIDE) & 0x00ff);
  }
  for (let i = 0; i < MENU_ITEM_WIDTH; i++) {
    screen.attributes[addr - ATTRIBUTE_FILE_BASE] = attribute & 0xff;
    addr = (addr & 0xff00) | ((addr + 1) & 0x00ff);
  }
}

/** menu_keyscan's "nothing relevant is pressed" ($F43A LD A,$FF). */
export const MENU_KEY_NONE = 0xff;
/** Key 0 starts the game ($F277 AND A / JR Z). */
export const MENU_KEY_START = 0;

/**
 * menu_keyscan ($F41C): which of 0..4 is held, or $FF.
 *
 * Reads port $F7FE for keys 1-5 and, only if none of 1-4 is down, port $EFFE
 * for key 0. Keys 1..4 return 1..4; key 0 returns 0.
 *
 * Note it masks $0F ($F424), so key 5 -- bit 4 of the same half-row -- is not
 * a menu key even though it is read.
 */
export function menuKeyscan(isDown: (code: string) => boolean): number {
  for (let i = 0; i < DEVICE_COUNT; i++) {
    if (isDown(`Digit${i + 1}`)) return i + 1; // $F42A..$F430
  }
  return isDown('Digit0') ? MENU_KEY_START : MENU_KEY_NONE; // $F432
}

/** chosen_input_device ($F445). */
export interface MenuState {
  device: number;
  started: boolean;
}

export function createMenu(): MenuState {
  return { device: 0, started: false }; // $F445 DEFB $00
}

/**
 * Draw the menu's initial highlight, as main does at $F16F.
 *
 * The index it passes is the documented bug; passing it through rather than
 * "correcting" it to zero is the point, and setMenuItemAttributes explains why
 * the result is identical.
 */
export const MAIN_INITIAL_HIGHLIGHT_INDEX = 0x44;

export function drawInitialHighlight(screen: SpectrumScreen): void {
  setMenuItemAttributes(
    screen,
    MAIN_INITIAL_HIGHLIGHT_INDEX,
    ATTRIBUTE_BRIGHT_YELLOW_OVER_BLACK,
  );
}

export type MenuResult = 'nothing' | 'selected' | 'start';

/**
 * check_menu_keys ($F271): one pass of the menu's key handling.
 *
 * Returns what happened so the caller can act on 'start'; the original never
 * returns from that case at all, because it goes on to run the game.
 */
export function checkMenuKeys(
  s: MenuState,
  screen: SpectrumScreen,
  isDown: (code: string) => boolean,
): MenuResult {
  const key = menuKeyscan(isDown);
  if (key === MENU_KEY_NONE) return 'nothing'; // $F274
  if (key === MENU_KEY_START) {
    s.started = true; // $F278 -> cmk_cpy_rout
    return 'start';
  }

  const index = key - 1; // $F27A, turn 1..4 into 0..3
  // $F27C: un-highlight whatever was chosen before, then highlight the new
  // one. Doing it in this order matters when the two are the same row.
  setMenuItemAttributes(screen, s.device, ATTRIBUTE_WHITE_OVER_BLACK);
  s.device = index; // $F285
  setMenuItemAttributes(screen, index, ATTRIBUTE_BRIGHT_YELLOW_OVER_BLACK);
  return 'selected';
}

/**
 * $F2A7: only the KEYBOARD runs choose_keys.
 *
 * `AND A / CALL Z,$F350` -- the test is on the device index, so the three
 * joystick options start the game immediately on whatever keydefs are already
 * there. In a browser that is the whole difference between them, since there
 * is no joystick port to read: see OPEN_QUESTIONS.md.
 */
export function devicePicksKeys(device: number): boolean {
  return device === 0;
}
