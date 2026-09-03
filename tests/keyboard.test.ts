import { describe, expect, it } from 'vitest';

import {
  KEYBOARD_PORTS,
  KEYDEF_NAMES,
  glyphsForKey,
  keyForCode,
  keyName,
  knownCodes,
  maskBit,
  portIndex,
} from '../src/ui/keyboard.js';

describe('the keyboard matrix', () => {
  it('has the eight ports choose_keys scans, in scan order', () => {
    // keyboard_port_hi_bytes ($F2E2), zero-terminated -- the terminator is
    // dropped, and the ORDER is load-bearing twice: it is the scan order and
    // it is keycode_to_glyph's row order.
    expect([...KEYBOARD_PORTS]).toEqual([0xf7, 0xef, 0xfb, 0xdf, 0xfd, 0xbf, 0xfe, 0x7f]);
  });

  it('places every key where the real machine does', () => {
    // Spot-checked against keycode_to_glyph, which is the game's own answer:
    // port $FB bit 0 is Q and bit 4 is T, so a mapping that had the bits the
    // other way round would name every key wrongly while still "working".
    expect(keyForCode('KeyQ')).toEqual({ port: 0xfb, mask: 0x01 });
    expect(keyForCode('KeyT')).toEqual({ port: 0xfb, mask: 0x10 });
    expect(keyForCode('Digit1')).toEqual({ port: 0xf7, mask: 0x01 });
    expect(keyForCode('Digit0')).toEqual({ port: 0xef, mask: 0x01 });
    expect(keyForCode('Space')).toEqual({ port: 0x7f, mask: 0x01 });
  });

  it('names an ordinary key with one glyph', () => {
    for (const [code, name] of [
      ['KeyQ', 'Q'],
      ['KeyT', 'T'],
      ['KeyA', 'A'],
      ['KeyM', 'M'],
      ['Digit5', '5'],
      // The charset has no letter O; digit zero doubles for it.
      ['KeyO', '0'],
    ] as const) {
      expect(keyName(keyForCode(code)!), code).toBe(name);
    }
  });

  it('names the four special keys through a byte OFFSET, not an index', () => {
    // $F3DD masks the glyph with $7F to get a byte offset into
    // special_key_names, whose first byte is a length. The offsets are 0, 6,
    // 11 and 18 -- the running sum of the entries before each. Reading them as
    // indices 0..3 gives ENTER for three of the four, which looks like a
    // working table until you press CAPS.
    expect(keyName(keyForCode('Enter')!)).toBe('ENTER');
    expect(keyName(keyForCode('ShiftLeft')!)).toBe('CAPS');
    expect(keyName(keyForCode('ControlLeft')!)).toBe('SYMB0L');
    expect(keyName(keyForCode('Space')!)).toBe('SPACE');
  });

  it('gives every one of the forty keys a name', () => {
    // A gap would mean a hole in the matrix or a glyph the font cannot render,
    // and either would only show up when a player happened to press that key.
    let named = 0;
    for (const code of knownCodes()) {
      const key = keyForCode(code);
      expect(key, code).not.toBeNull();
      const glyphs = glyphsForKey(key!);
      expect(glyphs.length, code).toBeGreaterThan(0);
      named++;
    }
    expect(named).toBe(43); // 40 keys plus the three aliases
  });

  it('treats both physical modifiers as the same wire', () => {
    expect(keyForCode('ShiftRight')).toEqual(keyForCode('ShiftLeft'));
    expect(keyForCode('ControlRight')).toEqual(keyForCode('ControlLeft'));
    expect(keyForCode('NumpadEnter')).toEqual(keyForCode('Enter'));
  });

  it('refuses keys that are not on a Spectrum', () => {
    for (const code of ['Escape', 'F1', 'ArrowUp', 'Tab', 'Backspace']) {
      expect(keyForCode(code), code).toBeNull();
    }
  });

  it('knows the five definitions choose_keys asks for', () => {
    expect([...KEYDEF_NAMES]).toEqual(['left', 'right', 'up', 'down', 'fire']);
  });

  it('resolves ports and masks back to their positions', () => {
    expect(portIndex(0xfb)).toBe(2);
    expect(portIndex(0x11)).toBe(-1);
    expect(maskBit(0x10)).toBe(4);
    expect(maskBit(0x03)).toBe(-1); // two bits is not a key
  });
});
