/**
 * The Spectrum's keyboard matrix, and a browser key's place in it.
 *
 * `choose_keys` ($F350) does not record "the player pressed Q". It records a
 * PORT and a BIT MASK -- the half-row and the wire -- because that is all the
 * hardware offers, and everything downstream is built on that: `keydefs`
 * ($F06B) stores five (port, mask) pairs, `keycode_to_glyph` ($F303) is indexed
 * by the same two numbers, and the input routines scan the ports directly.
 *
 * So rather than invent a browser-shaped key representation and a second table
 * to name keys with, this models the matrix. A `KeyboardEvent.code` resolves to
 * a (port, mask), and from there the game's own tables do the rest unchanged --
 * including `special_key_names`, whose four entries are reached through a byte
 * offset packed into the high bit of the glyph table.
 *
 * The one ASSUMPTION is the mapping itself, and it is as dull as it can be:
 * Q is Q. The two Spectrum keys with no obvious modern equivalent are CAPS
 * SHIFT (the shift keys) and SYMBOL SHIFT (the control keys). Recorded in
 * OPEN_QUESTIONS.md.
 */

import frontendJson from '../../data/frontend.json';
import textJson from '../../data/text.json';
import { decodeGlyphs } from './glyphs.js';

const frontend = frontendJson as unknown as {
  keyboardPortHiBytes: { values: number[] };
  specialKeyNames: { names: { glyphs: number[]; text: string }[] };
  keydefs: { entries: { name: string; port: number; mask: number }[] };
};
const text = textJson as unknown as {
  keycodeToGlyph: { values: number[] };
  glyphSet: { chars: string[] };
};

/**
 * keyboard_port_hi_bytes ($F2E2), zero-terminated.
 *
 * The order matters twice over: it is the order `choose_keys` scans in AND the
 * order `keycode_to_glyph`'s rows are in, five glyphs per port.
 */
export const KEYBOARD_PORTS: readonly number[] = frontend.keyboardPortHiBytes.values.filter(
  (v) => v !== 0,
);

/** keycode_to_glyph ($F303): 8 ports x 5 bits. */
const keycodeToGlyph: readonly number[] = text.keycodeToGlyph.values;

/** special_key_names ($F2EB), as one byte run, indexed by the offsets below. */
const specialKeyNames: readonly { glyphs: number[]; text: string }[] =
  frontend.specialKeyNames.names;

/** The five keys the game asks the player to define, in prompt order. */
export const KEYDEF_NAMES: readonly string[] = frontend.keydefs.entries.map((e) => e.name);

/** A key, as the hardware sees it. */
export interface SpectrumKey {
  /** The port's high byte, one of KEYBOARD_PORTS. */
  readonly port: number;
  /** A single set bit, 0..4 of the half-row. */
  readonly mask: number;
}

/**
 * ASSUMPTION: which browser key stands for which Spectrum key.
 *
 * Laid out as the matrix is -- one row per port, five keys in bit order 0..4 --
 * so it can be read against `keycode_to_glyph` above and against any Spectrum
 * keyboard diagram. Nothing here is game data; it is the bridge to a keyboard
 * the game never saw.
 */
const MATRIX: ReadonlyArray<readonly [number, readonly string[]]> = [
  [0xf7, ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5']],
  [0xef, ['Digit0', 'Digit9', 'Digit8', 'Digit7', 'Digit6']],
  [0xfb, ['KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyT']],
  [0xdf, ['KeyP', 'KeyO', 'KeyI', 'KeyU', 'KeyY']],
  [0xfd, ['KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG']],
  [0xbf, ['Enter', 'KeyL', 'KeyK', 'KeyJ', 'KeyH']],
  [0xfe, ['ShiftLeft', 'KeyZ', 'KeyX', 'KeyC', 'KeyV']],
  [0x7f, ['Space', 'ControlLeft', 'KeyM', 'KeyN', 'KeyB']],
];

/** The modifiers each have two physical keys; both reach the same wire. */
const ALIASES: Readonly<Record<string, string>> = {
  ShiftRight: 'ShiftLeft',
  ControlRight: 'ControlLeft',
  NumpadEnter: 'Enter',
};

const byCode = new Map<string, SpectrumKey>();
for (const [port, codes] of MATRIX) {
  codes.forEach((code, bit) => byCode.set(code, { port, mask: 1 << bit }));
}

/** Where a browser key sits in the matrix, or null if it has no place. */
export function keyForCode(code: string): SpectrumKey | null {
  return byCode.get(ALIASES[code] ?? code) ?? null;
}

/** The port's position in the scan order, which is also its glyph row. */
export function portIndex(port: number): number {
  return KEYBOARD_PORTS.indexOf(port);
}

/** Which of the five bits is set, 0..4. $F3D1 finds it by shifting. */
export function maskBit(mask: number): number {
  for (let bit = 0; bit < 5; bit++) if (mask === 1 << bit) return bit;
  return -1;
}

export function isSpectrumKey(k: SpectrumKey | null): k is SpectrumKey {
  return k !== null && portIndex(k.port) >= 0 && maskBit(k.mask) >= 0;
}

/**
 * ck_find_key_glyph ($F3D1): the glyphs that name a key.
 *
 * One glyph for an ordinary key. For the four with the top bit set the low
 * seven bits are a BYTE OFFSET into `special_key_names` ($F3DD `AND $7F`),
 * whose first byte is the length -- so ENTER is at 0, CAPS at 6, SYMBOL at 11
 * and SPACE at 18, each offset being the sum of the lengths before it. It is
 * an offset, not an index, and treating it as an index gives "ENTER" for three
 * of the four.
 */
export function glyphsForKey(key: SpectrumKey): number[] {
  const row = portIndex(key.port);
  const bit = maskBit(key.mask);
  if (row < 0 || bit < 0) return [];

  const glyph = keycodeToGlyph[row * 5 + bit] ?? 0;
  if ((glyph & 0x80) === 0) return [glyph]; // $F3D6 LD B,$01

  const offset = glyph & 0x7f;
  let at = 0;
  for (const name of specialKeyNames) {
    if (at === offset) return [...name.glyphs];
    at += 1 + name.glyphs.length; // the length byte plus the glyphs
  }
  return [];
}

/** The same, as text, for the status line and for tests. */
export function keyName(key: SpectrumKey): string {
  return decodeGlyphs(glyphsForKey(key));
}

/** Every browser key code the matrix accepts, for a "press any game key" test. */
export function knownCodes(): string[] {
  return [...byCode.keys(), ...Object.keys(ALIASES)];
}
