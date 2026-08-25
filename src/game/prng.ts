/**
 * random_nibble (c$CB85): the game's only source of randomness.
 *
 * Not a generator at all -- it walks a 256-byte window of the exterior tile
 * bitmaps and returns the low nibble of whatever it finds. The bytes are
 * artwork being read as entropy.
 *
 * Two details decide the sequence, and both are easy to get wrong:
 *
 *   $CB89 INC L   increments the LOW BYTE ONLY, so the pointer wraps within
 *                 $9000..$90FF and the high byte never changes. There is no
 *                 carry, so this is a 256-entry ring, not a walk through
 *                 memory.
 *   $CB89 comes BEFORE the read, so the first value ever returned is from
 *                 $9001 rather than $9000.
 *
 * The window sits inside exterior_tiles ($8590..$9768), which is why the data
 * is extracted as an address slice rather than as a table of its own -- see
 * OPEN_QUESTIONS.md §7.
 */

import prngJson from '../../data/prng.json';

import { decodeBase64 } from '../data/load.js';

const data = prngJson as unknown as {
  _addr: string;
  data: string;
  pointerInit: string;
};

/** prng_pointer's value on load ($C41A, initialised to $9000). */
export const PRNG_BASE = parseInt(data.pointerInit.slice(1), 16);

let bytes: Uint8Array | undefined;
function prngBytes(): Uint8Array {
  return (bytes ??= decodeBase64(data.data));
}

export class Prng {
  /** The low byte of prng_pointer; the high byte is fixed. */
  private low: number;

  constructor(low = 0) {
    this.low = low & 0xff;
  }

  /** One call of random_nibble: 0..15. */
  next(): number {
    this.low = (this.low + 1) & 0xff; // $CB89, before the read
    return prngBytes()[this.low]! & 0x0f; // $CB8B
  }

  /** Exposed so a demo can show it, and so tests can pin a starting point. */
  get pointer(): number {
    return PRNG_BASE + this.low;
  }

  set pointer(addr: number) {
    this.low = addr & 0xff;
  }
}

/** A shared instance, matching the game's single global pointer. */
export const prng = new Prng();
