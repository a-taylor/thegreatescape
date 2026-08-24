/**
 * Masked sprite plotting.
 *
 * plot_masked_sprite_16px (c$E2A2) and _24px (c$E01D) composite a sprite into
 * window_buf through TWO masks:
 *
 *   the sprite's own mask   1 = transparent, let the background survive
 *   the foreground mask     1 = sprite may draw here, 0 = scenery occludes it
 *
 * The per-byte operation, transcribed from $E30B..$E316:
 *
 *   ((~fg | mask) & screen) | (bitmap & fg)
 *
 * Note what this does NOT do: the sprite mask does not gate the bitmap. The
 * right-hand term ORs the bitmap in wherever the foreground permits, whatever
 * the sprite mask says. The mask only decides whether the background survives
 * underneath. Opaque pixels therefore rely on the data holding mask = 0 exactly
 * where bitmap = 1 -- an invariant of the sprite data, not something the
 * routine enforces.
 *
 * The foreground mask is the one that puts the hero behind huts and fences
 * rather than on top of them.
 */

import { WINDOW_STRIDE } from './window.js';

/** The foreground mask buffer ($8100) is 4 bytes wide. */
export const MASK_BUFFER_WIDTH = 4;
/** $A0 bytes total: 4 wide x 40 pixel rows (5 tile rows of 8). */
export const MASK_BUFFER_ROWS = 40;
export const MASK_BUFFER_SIZE = MASK_BUFFER_WIDTH * MASK_BUFFER_ROWS;

/**
 * Composite one byte.
 *
 * Exposed on its own because it is the single operation the whole masking
 * system reduces to, and it is far easier to reason about tested in isolation
 * than buried in a plotting loop.
 */
export function compositeByte(
  screen: number,
  bitmap: number,
  mask: number,
  foreground: number,
): number {
  const keep = (~foreground | mask) & screen; // $E30B..$E30F
  const draw = bitmap & foreground; // $E311..$E313
  return (keep | draw) & 0xff;
}

/**
 * Shift a row of sprite bytes right by `shift` pixels into a wider row.
 *
 * The Z80 does this with a self-modified jump into a chain of RR instructions
 * ($E2DB), rotating through carry so bits spill from one byte into the next and
 * out into an extra trailing byte. Expressed directly here: the row is treated
 * as one big-endian integer, shifted, and unpacked -- which produces the same
 * bytes without emulating the carry chain.
 *
 * The mask shifts in ONES ($E2D8 sets mask2 = $FF, $E2DA sets carry) because a
 * mask bit of 1 means transparent: the pixels shifted past the sprite's edge
 * must not paint. The bitmap shifts in ZEROS ($E2F0 sets bm2 = 0).
 */
export function shiftRowRight(
  bytes: readonly number[],
  shift: number,
  fillOnes: boolean,
): number[] {
  const fill = fillOnes ? 0xff : 0x00;
  // The extra trailing byte is bm2/mask2: it catches the pixels shifted off the
  // right-hand end, which is why a 16px sprite plots three bytes wide.
  const src = [...bytes.map((b) => b & 0xff), fill];
  const out: number[] = new Array(src.length);

  // `prev` is the notional byte to the left of the row. Seeding it with the
  // fill is what shifts ones into the mask and zeros into the bitmap.
  let prev = fill;
  for (let i = 0; i < src.length; i++) {
    const cur = src[i]!;
    out[i] = shift === 0 ? cur : (((prev << (8 - shift)) | (cur >> shift)) & 0xff);
    prev = cur;
  }
  return out;
}

export interface SpritePlot {
  /** Sprite bitmap, `widthBytes` per row, `height` rows. */
  readonly bitmap: Uint8Array;
  /** Sprite mask, same shape. */
  readonly mask: Uint8Array;
  readonly widthBytes: number;
  readonly height: number;
}

export interface PlotTarget {
  /** window_buf. */
  readonly pixels: Uint8Array;
  /** The foreground mask buffer for this frame. */
  readonly foreground: Uint8Array;
}

export interface PlotPlacement {
  /** Byte column within window_buf. */
  readonly column: number;
  /** Pixel row within window_buf. */
  readonly row: number;
  /** Sub-byte horizontal shift, from iso_pos.x & 7. */
  readonly shift: number;
  /** Rows to skip from the top of the sprite (clipped above). */
  readonly skipRows: number;
  /** Rows actually drawn. */
  readonly rows: number;
  /**
   * Mirror the sprite horizontally, from bit 7 of the frame's sprite index.
   *
   * Not optional in practice: the four facings are only two sets of artwork.
   * Top-left and top-right share sprites 0..3, bottom-right and bottom-left
   * share 4..7, and the right-facing pair is the left-facing pair flipped. Skip
   * this and the character faces the wrong way half the time.
   */
  readonly flip?: boolean;
}

/**
 * Plot a masked sprite into window_buf.
 *
 * `shift` is `iso_pos.x & 7` ($E2A2). Values 0..3 shift right; 4..7 are treated
 * as -4..-1 ($E2A7) and shift left, which the original reaches through a
 * separate code path. Both are handled here by shifting right by `shift` into a
 * row one byte wider and letting the placement absorb the difference.
 */
export function plotMaskedSprite(
  target: PlotTarget,
  sprite: SpritePlot,
  place: PlotPlacement,
): void {
  const outWidth = sprite.widthBytes + 1;

  for (let r = 0; r < place.rows; r++) {
    const srcRow = place.skipRows + r;
    if (srcRow >= sprite.height) break;

    const dstRow = place.row + r;
    if (dstRow < 0) continue;

    let bmRow: number[] = [];
    let mkRow: number[] = [];
    for (let c = 0; c < sprite.widthBytes; c++) {
      bmRow.push(sprite.bitmap[srcRow * sprite.widthBytes + c] ?? 0);
      mkRow.push(sprite.mask[srcRow * sprite.widthBytes + c] ?? 0xff);
    }

    // $E2CE..$E2D2: flip_16_masked_pixels runs on the loaded bitmap AND mask
    // bytes BEFORE the shift, so the order here matters.
    if (place.flip) {
      bmRow = flipRow(bmRow);
      mkRow = flipRow(mkRow);
    }

    const bm = shiftRowRight(bmRow, place.shift, false);
    const mk = shiftRowRight(mkRow, place.shift, true);

    for (let c = 0; c < outWidth; c++) {
      const col = place.column + c;
      if (col < 0 || col >= WINDOW_STRIDE) continue;

      const dst = dstRow * WINDOW_STRIDE + col;
      if (dst < 0 || dst >= target.pixels.length) continue;

      const fgIndex = r * MASK_BUFFER_WIDTH + c;
      const fg = fgIndex < target.foreground.length ? target.foreground[fgIndex]! : 0xff;

      target.pixels[dst] = compositeByte(target.pixels[dst]!, bm[c]!, mk[c]!, fg);
    }
  }
}

/**
 * flip_16_masked_pixels (c$E40F) / flip_24_masked_pixels.
 *
 * Sprites facing left and right share bitmap data; the flip flag ($81B7) mirrors
 * a row horizontally at plot time. Reversing byte order alone is not enough --
 * each byte's bits must be reversed too.
 */
export function flipRow(bytes: readonly number[]): number[] {
  return bytes.map((b) => reverseBits(b)).reverse();
}

const REVERSED = (() => {
  const t = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    let v = i;
    let r = 0;
    for (let b = 0; b < 8; b++) {
      r = (r << 1) | (v & 1);
      v >>= 1;
    }
    t[i] = r;
  }
  return t;
})();

export function reverseBits(byte: number): number {
  return REVERSED[byte & 0xff]!;
}
