/**
 * The game window: tile buffer, screen buffer, and the blit to the display.
 *
 * BUILD_PROMPT.md §4 asks for the original's pipeline over real byte buffers,
 * not per-pixel canvas drawing. The two buffers below are the same sizes and
 * layouts as the game's, so masking, clipping and sub-character scroll can be
 * expressed exactly as the disassembly does.
 *
 * Geometry, verified rather than assumed (OPEN_QUESTIONS.md §2):
 *
 *   tile_buf    $F0F8   24 x 17        = 408 bytes of tile references
 *   window_buf  $F290   24 x 17 x 8    = 3,264 bytes  -> 192 x 136 pixels
 *   visible                              192 x 128 pixels
 *
 * The buffer is 17 tile rows but only 16 are ever blitted:
 * game_window_start_addresses (w$EDD3) holds exactly 128 row pointers. The
 * extra row is sub-tile scroll slack. BUILD_PROMPT §4's "24x17 characters
 * (192x136 px)" describes the BUFFER; the window is 192x128.
 */

import { screenAddress, type SpectrumScreen } from '../spectrum/display.js';

/** Tile columns across the window. */
export const WINDOW_COLS = 24;
/** Tile rows held in the buffer -- one more than is displayed. */
export const BUFFER_ROWS = 17;
/** Bytes per row of window_buf; one byte is 8 horizontal pixels. */
export const WINDOW_STRIDE = WINDOW_COLS;
/** Pixel rows held in the buffer: 17 * 8. */
export const BUFFER_PIXEL_ROWS = BUFFER_ROWS * 8;
/** Pixel rows actually blitted -- the count of game_window_start_addresses. */
export const VISIBLE_PIXEL_ROWS = 128;

/** Where the window sits on the 32x24 screen; from $4047, the first row pointer. */
export const WINDOW_ORIGIN_COL = 7;
export const WINDOW_ORIGIN_PIXEL_ROW = 16;

/**
 * The two buffers the original keeps in RAM.
 *
 * `tiles` holds tile references (what to draw); `pixels` holds the expanded
 * bitmap (what it looks like). Keeping them separate matters because the game
 * redraws only changed tiles and restores backgrounds by re-expanding from
 * `tiles` -- see restore_tiles.
 */
export class GameWindowBuffers {
  /**
   * 24 x 17 tile references.
   *
   * Deliberately 8-bit, because the game's tile_buf is: a tile reference is one
   * byte. The exterior tile set has 571 tiles, which does NOT fit in a byte --
   * the game resolves that by storing the reference RELATIVE to a bank and
   * adding the bank base at plot time (plot_tile, c$A9AD). Baking the bank in
   * here would silently truncate every tile at or above 256.
   */
  readonly tiles = new Uint8Array(WINDOW_COLS * BUFFER_ROWS);
  /**
   * Per-cell tile bank offset, for the exterior. Interiors use a single flat
   * set and leave this zero.
   */
  readonly banks = new Uint16Array(WINDOW_COLS * BUFFER_ROWS);
  /** 24 bytes x 136 pixel rows. */
  readonly pixels = new Uint8Array(WINDOW_STRIDE * BUFFER_PIXEL_ROWS);

  /** wipe_visible_tiles ($6A27): clear the tile array. */
  wipeTiles(): void {
    this.tiles.fill(0);
    this.banks.fill(0);
  }

  clearPixels(): void {
    this.pixels.fill(0);
  }

  tileAt(col: number, row: number): number {
    return this.tiles[row * WINDOW_COLS + col]!;
  }

  setTile(col: number, row: number, tile: number, bank = 0): void {
    this.tiles[row * WINDOW_COLS + col] = tile & 0xff;
    this.banks[row * WINDOW_COLS + col] = bank;
  }

  /** Bank-resolved absolute tile index for a cell. */
  resolvedTile(col: number, row: number): number {
    const i = row * WINDOW_COLS + col;
    return this.banks[i]! + this.tiles[i]!;
  }

  /**
   * Expand every tile reference into the pixel buffer.
   *
   * Mirrors plot_interior_tiles / the plot_*_tiles_common family: each tile
   * contributes 8 bytes, one per pixel row, at a stride of 24. The bank is
   * added here rather than stored, exactly as plot_tile (c$A9AD) does.
   */
  expandTiles(tileBitmaps: { row(tile: number, row: number): number }): void {
    for (let ty = 0; ty < BUFFER_ROWS; ty++) {
      for (let tx = 0; tx < WINDOW_COLS; tx++) {
        const tile = this.resolvedTile(tx, ty);
        let dst = ty * 8 * WINDOW_STRIDE + tx;
        for (let row = 0; row < 8; row++) {
          this.pixels[dst] = tileBitmaps.row(tile, row);
          dst += WINDOW_STRIDE;
        }
      }
    }
  }

  /** One 8-pixel byte from the pixel buffer. */
  pixelByte(col: number, pixelRow: number): number {
    return this.pixels[pixelRow * WINDOW_STRIDE + col]!;
  }
}

/**
 * plot_game_window ($E0DC area): copy the screen buffer to the display.
 *
 * `rowOffset` is the sub-tile vertical scroll -- which of the buffer's 136
 * pixel rows becomes the top of the visible 128. It is why the buffer carries a
 * 17th tile row.
 *
 * The original has two paths here: an aligned fast copy and a slow one that
 * rolls each byte by a nibble when the buffer is not byte-aligned with the
 * screen. That asymmetry is the documented variable-game-speed quirk
 * (Fact:alternatingSpeed) and belongs in the timing model rather than here --
 * the OUTPUT of both paths is identical, only their cost differs.
 */
export function plotGameWindow(
  screen: SpectrumScreen,
  buffers: GameWindowBuffers,
  offset: GameWindowOffset = NO_OFFSET,
): void {
  const rollNibble = offset.high === 0xff;

  for (let y = 0; y < VISIBLE_PIXEL_ROWS; y++) {
    const src = offset.low + y * WINDOW_STRIDE;
    const addr = screenAddress(WINDOW_ORIGIN_COL, WINDOW_ORIGIN_PIXEL_ROW + y);
    const dst = addr - 0x4000;

    if (!rollNibble) {
      // Aligned fast path: a window row is 24 contiguous bytes on screen, since
      // the display file's column index occupies the low 5 bits and columns
      // 7..30 do not cross a row boundary.
      screen.display.set(buffers.pixels.subarray(src, src + WINDOW_STRIDE), dst);
      continue;
    }

    // Unaligned slow path: roll each byte right by half a byte, carrying the
    // low nibble of the previous byte into the high nibble of this one. This is
    // the source of Fact:alternatingSpeed -- the game visibly runs slower when
    // the buffer is not byte-aligned with the screen, because every byte goes
    // through this instead of a block copy.
    let carry = 0;
    for (let c = 0; c < WINDOW_STRIDE; c++) {
      const byte = buffers.pixels[src + c] ?? 0;
      screen.display[dst + c] = ((carry << 4) | (byte >> 4)) & 0xff;
      carry = byte & 0x0f;
    }
  }
}

/**
 * game_window_offset ($A7C7), set by move_map.
 *
 * The low byte is a byte offset added to the window_buf source pointer, which
 * scrolls the view vertically by whole pixel rows without moving the map. The
 * high byte being 255 means the blit rolls every byte by half a byte, scrolling
 * horizontally by four pixels.
 *
 * Between them these provide the sub-tile motion: the map itself only shunts a
 * whole tile every fourth animation frame, and this fills in the steps between.
 * Without it the terrain jumps eight pixels at a time while the hero moves two
 * or four, which reads as jitter.
 */
export interface GameWindowOffset {
  readonly low: number;
  readonly high: number;
}

export const NO_OFFSET: GameWindowOffset = { low: 0, high: 0 };

/** Set the window's attribute block. choose_game_window_attributes picks the value. */
export function setWindowAttributes(screen: SpectrumScreen, attribute: number): void {
  screen.fillAttributes(
    WINDOW_ORIGIN_COL,
    WINDOW_ORIGIN_PIXEL_ROW >> 3,
    WINDOW_COLS,
    VISIBLE_PIXEL_ROWS >> 3,
    attribute,
  );
}
