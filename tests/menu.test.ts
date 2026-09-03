import { describe, expect, it } from 'vitest';

import {
  ATTRIBUTE_BRIGHT_YELLOW_OVER_BLACK,
  ATTRIBUTE_WHITE_OVER_BLACK,
  DEVICE_COUNT,
  MAIN_INITIAL_HIGHLIGHT_INDEX,
  MENU_ITEM_ATTRIBUTES,
  MENU_ITEM_WIDTH,
  MENU_KEY_NONE,
  MENU_KEY_START,
  checkMenuKeys,
  createMenu,
  devicePicksKeys,
  drawInitialHighlight,
  menuKeyscan,
  setMenuItemAttributes,
} from '../src/ui/menu.js';
import {
  KEYDEF_COUNT,
  alreadyTaken,
  chooseKeysConfirm,
  chooseKeysKeyDown,
  chooseKeysKeyUp,
  createChooseKeys,
  drawChooseKeys,
  keyNameAddresses,
  nextSlot,
  prompts,
} from '../src/ui/keys.js';
import { keyForCode, keyName } from '../src/ui/keyboard.js';
import { ATTRIBUTE_FILE_BASE, SpectrumScreen } from '../src/spectrum/display.js';

/** Which attribute cells hold `attr`, as absolute addresses. */
function cellsWith(screen: SpectrumScreen, attr: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < screen.attributes.length; i++) {
    if (screen.attributes[i] === attr) out.push(i + ATTRIBUTE_FILE_BASE);
  }
  return out;
}

describe('set_menu_item_attributes ($F408)', () => {
  it('highlights ten cells on the row it is given', () => {
    const screen = new SpectrumScreen();
    setMenuItemAttributes(screen, 0, ATTRIBUTE_BRIGHT_YELLOW_OVER_BLACK);
    const cells = cellsWith(screen, ATTRIBUTE_BRIGHT_YELLOW_OVER_BLACK);
    expect(cells).toHaveLength(MENU_ITEM_WIDTH);
    expect(cells[0]).toBe(MENU_ITEM_ATTRIBUTES);
  });

  it('steps two attribute rows per item', () => {
    const screen = new SpectrumScreen();
    setMenuItemAttributes(screen, 3, ATTRIBUTE_BRIGHT_YELLOW_OVER_BLACK);
    expect(cellsWith(screen, ATTRIBUTE_BRIGHT_YELLOW_OVER_BLACK)[0]).toBe(
      MENU_ITEM_ATTRIBUTES + 3 * 0x40,
    );
  });

  it('wraps within the attribute page, which is what makes $F16F harmless', () => {
    // main passes index $44 where the disassembly says "it ought to be zero".
    // The row advance is done on L alone ($F40F..$F412), and 68 * $40 is 4352,
    // which is 0 mod 256 -- so L comes back to $0D and item 0 is highlighted
    // exactly as intended. A 16-bit add would land at $6A0D, outside the
    // attribute file altogether.
    const buggy = new SpectrumScreen();
    drawInitialHighlight(buggy);
    const correct = new SpectrumScreen();
    setMenuItemAttributes(correct, 0, ATTRIBUTE_BRIGHT_YELLOW_OVER_BLACK);
    expect([...buggy.attributes]).toEqual([...correct.attributes]);
    expect(MAIN_INITIAL_HIGHLIGHT_INDEX).toBe(0x44);
  });
});

describe('menu_keyscan ($F41C) and check_menu_keys ($F271)', () => {
  const down = (...codes: string[]) => (code: string) => codes.includes(code);

  it('returns 1..4 for the device keys and 0 for start', () => {
    expect(menuKeyscan(down('Digit1'))).toBe(1);
    expect(menuKeyscan(down('Digit4'))).toBe(4);
    expect(menuKeyscan(down('Digit0'))).toBe(MENU_KEY_START);
    expect(menuKeyscan(down())).toBe(MENU_KEY_NONE);
  });

  it('ignores key 5, which shares the half-row but is masked off', () => {
    // $F424 AND $0F keeps bits for 1,2,3,4 only, though 5 is read with them.
    expect(menuKeyscan(down('Digit5'))).toBe(MENU_KEY_NONE);
  });

  it('prefers a device key over start when both are held', () => {
    // $F426 only falls through to the zero check when NONE of 1-4 is pressed.
    expect(menuKeyscan(down('Digit0', 'Digit2'))).toBe(2);
  });

  it('moves the highlight from the old device to the new one', () => {
    const screen = new SpectrumScreen();
    const menu = createMenu();
    drawInitialHighlight(screen);

    expect(checkMenuKeys(menu, screen, down('Digit3'))).toBe('selected');
    expect(menu.device).toBe(2); // $F27A turns 1..4 into 0..3

    const lit = cellsWith(screen, ATTRIBUTE_BRIGHT_YELLOW_OVER_BLACK);
    expect(lit).toHaveLength(MENU_ITEM_WIDTH);
    expect(lit[0]).toBe(MENU_ITEM_ATTRIBUTES + 2 * 0x40);
    // and the row it left is back to white
    expect(cellsWith(screen, ATTRIBUTE_WHITE_OVER_BLACK)[0]).toBe(MENU_ITEM_ATTRIBUTES);
  });

  it('starts the game on key 0', () => {
    const menu = createMenu();
    expect(checkMenuKeys(menu, new SpectrumScreen(), down('Digit0'))).toBe('start');
    expect(menu.started).toBe(true);
  });

  it('does nothing at all when no menu key is held', () => {
    const screen = new SpectrumScreen();
    const menu = createMenu();
    expect(checkMenuKeys(menu, screen, down('KeyQ'))).toBe('nothing');
    expect(screen.attributes.every((a) => a === 0)).toBe(true);
  });

  it('sends only the keyboard to choose_keys', () => {
    // $F2A7 `AND A / CALL Z,$F350` -- the three joysticks skip it.
    expect(devicePicksKeys(0)).toBe(true);
    for (let d = 1; d < DEVICE_COUNT; d++) expect(devicePicksKeys(d)).toBe(false);
  });
});

describe('choose_keys ($F350)', () => {
  it('asks for the five directions, with a heading', () => {
    expect(prompts.map((p) => p.text)).toEqual([
      'CH00SE KEYS',
      'LEFT.',
      'RIGHT.',
      'UP.',
      'D0WN.',
      'FIRE.',
    ]);
    expect(keyNameAddresses).toHaveLength(KEYDEF_COUNT);
  });

  it('fills the slots in order', () => {
    const s = createChooseKeys();
    expect(nextSlot(s)).toBe(0);
    for (const code of ['KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyT']) {
      chooseKeysKeyDown(s, code);
      chooseKeysKeyUp(s);
    }
    expect(s.keydefs.map((k) => (k ? keyName(k) : null))).toEqual(['Q', 'W', 'E', 'R', 'T']);
    expect(s.phase).toBe('confirming');
  });

  it('takes only ONE key while a key is held down', () => {
    // $F389's debounce flag. Without it, a held key fills every slot at once.
    const s = createChooseKeys();
    chooseKeysKeyDown(s, 'KeyQ');
    chooseKeysKeyDown(s, 'KeyW');
    chooseKeysKeyDown(s, 'KeyE');
    expect(s.keydefs.filter(Boolean)).toHaveLength(1);
    chooseKeysKeyUp(s);
    chooseKeysKeyDown(s, 'KeyW');
    expect(s.keydefs.filter(Boolean)).toHaveLength(2);
  });

  it('refuses a key that is already one of the directions', () => {
    // $F3AE..$F3BE walks the table for a matching (port, mask) and loops back.
    const s = createChooseKeys();
    chooseKeysKeyDown(s, 'KeyQ');
    chooseKeysKeyUp(s);
    expect(alreadyTaken(s, keyForCode('KeyQ')!)).toBe(true);
    chooseKeysKeyDown(s, 'KeyQ');
    chooseKeysKeyUp(s);
    expect(s.keydefs.filter(Boolean)).toHaveLength(1);
  });

  it('treats the two shift keys as the SAME key, because the wire is', () => {
    const s = createChooseKeys();
    chooseKeysKeyDown(s, 'ShiftLeft');
    chooseKeysKeyUp(s);
    chooseKeysKeyDown(s, 'ShiftRight');
    chooseKeysKeyUp(s);
    expect(s.keydefs.filter(Boolean)).toHaveLength(1);
  });

  it('ignores keys that are not on a Spectrum keyboard', () => {
    const s = createChooseKeys();
    for (const code of ['Escape', 'F5', 'ArrowLeft', 'Tab']) {
      chooseKeysKeyDown(s, code);
      chooseKeysKeyUp(s);
    }
    expect(s.keydefs.filter(Boolean)).toHaveLength(0);
  });

  it('starts the whole screen over on N, and finishes on Y', () => {
    const define = (s: ReturnType<typeof createChooseKeys>) => {
      for (const code of ['KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyT']) {
        chooseKeysKeyDown(s, code);
        chooseKeysKeyUp(s);
      }
    };
    const s = createChooseKeys();
    define(s);
    expect(chooseKeysConfirm(s, 'KeyN')).toBe(false);
    // $F405 JP NZ,$F350: the table is cleared as well as the phase.
    expect(s.phase).toBe('choosing');
    expect(s.keydefs.filter(Boolean)).toHaveLength(0);

    chooseKeysKeyUp(s);
    define(s);
    expect(chooseKeysConfirm(s, 'KeyY')).toBe(true);
    expect(s.phase).toBe('done');
  });

  it('draws the prompts, and each key name as it is taken', () => {
    const screen = new SpectrumScreen();
    const s = createChooseKeys();
    drawChooseKeys(screen, s);
    const beforePixels = screen.display.reduce((n, b) => n + (b !== 0 ? 1 : 0), 0);
    expect(beforePixels).toBeGreaterThan(0); // the six prompts

    chooseKeysKeyDown(s, 'KeyQ');
    drawChooseKeys(screen, s);
    const afterPixels = screen.display.reduce((n, b) => n + (b !== 0 ? 1 : 0), 0);
    expect(afterPixels).toBeGreaterThan(beforePixels); // plus "Q"
  });
});
