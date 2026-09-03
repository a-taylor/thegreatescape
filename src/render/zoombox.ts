/**
 * zoombox (c$ABA0): reveal the game window with a growing box.
 *
 * Called from three places, all of which have already built the window buffer
 * and want it revealed rather than snapped onto the screen: `enter_room`
 * ($6912), `screen_reset` ($A511, the escape ending) and `reset_outdoors`
 * ($B329).
 *
 * The original BLOCKS: it runs its eleven steps to completion inside the call
 * and only then returns to the main loop, so no game logic and no
 * `plot_game_window` runs while the box grows. That shape does not survive
 * into a browser, so it is split the way CLAUDE.md's searchlight note
 * prescribes -- `advanceZoombox` mutates and belongs in the tick,
 * `drawZoombox` only writes pixels and is safe to repeat, which is what the
 * demo's re-render on pause, resize and toggle requires.
 *
 * The box is measured in TILE cells of the game window: x/width across, and
 * y/height down. The fill copies straight out of window_buf, and the border is
 * six 8x8 tiles from `zoombox_tiles` ($AF5E) drawn one ring outside the fill.
 */

import { timingData, decodeBase64 } from '../data/load.js';
import { SpectrumScreen, DISPLAY_FILE_BASE, screenCoords } from '../spectrum/display.js';
import { GameWindowBuffers, WINDOW_STRIDE } from './window.js';

/** zoombox_tiles ($AF5E): six 8-byte border tiles. */
const zoomboxTiles = decodeBase64(timingData.zoomboxTiles.data);

/**
 * game_window_start_addresses ($EDD3), one screen address per PIXEL row.
 *
 * zoombox indexes it by TILE row -- `ADD A,A` four times ($AC18) is row * 16
 * BYTES into a DEFW array, which is entry row * 8.
 */
const rowAddresses = timingData.gameWindow.rowAddresses.map((s) => parseInt(s.slice(1), 16));

/** $ABA0/$ABA5: the box starts as a zero-size point at (12, 8). */
export const ZOOMBOX_INITIAL_X = 12;
export const ZOOMBOX_INITIAL_Y = 8;
/** $ABCC: width stops growing once x + width reaches 22. */
const MAX_X_PLUS_WIDTH = 0x16;
/** $ABE0: height stops growing once y + height reaches 15. */
const MAX_Y_PLUS_HEIGHT = 0x0f;
/** $ABF3: the loop ends when width + height reaches 35. */
const FINAL_SUM = 0x23;

/**
 * The initial fill rectangle's attributes ($ABAF/$ABB2), two bytes at each
 * address. $5932 and $5952 are (col 18, row 9) and (col 18, row 10) -- the
 * four corner cells of the degenerate box at window cell (12, 8), which sits
 * at screen (col 19, row 10).
 */
export const INITIAL_ATTRIBUTE_ADDRESSES = [0x5932, 0x5952] as const;

/** Border tile indices, in the order $AC6F draws them. */
const TILE_TOP_LEFT = 0;
const TILE_HORIZONTAL = 1;
const TILE_TOP_RIGHT = 2;
const TILE_VERTICAL = 3;
const TILE_BOTTOM_RIGHT = 4;
const TILE_BOTTOM_LEFT = 5;

/** zoombox_x/_width/_y/_height ($AB66..$AB69). */
export interface ZoomboxState {
  x: number;
  width: number;
  y: number;
  height: number;
  /** True once $ABF3's width + height >= 35 test has passed. */
  done: boolean;
}

export function createZoombox(): ZoomboxState {
  return { x: ZOOMBOX_INITIAL_X, width: 0, y: ZOOMBOX_INITIAL_Y, height: 0, done: false };
}

/**
 * One iteration of the $ABBC loop: shrink the origin, grow the extent.
 *
 * The register copy matters. $ABBF reads x into A, $ABC6 decrements A along
 * with x, and $ABCB then adds the ALREADY-INCREMENTED width to it -- so the
 * clamp tests the box's new right edge, not its old one. Reading x back out of
 * the state after the decrement gives the same answer; reading it before does
 * not, and the box grows one cell too wide.
 *
 * Returns false once the box is complete.
 */
export function advanceZoombox(z: ZoomboxState): boolean {
  if (z.done) return false;

  // $ABBC: shrink x and grow width until x is 1.
  if (z.x !== 1) {
    z.x--;
    z.width++;
  }
  // $ABCA: grow width until x + width is 22.
  if (z.x + z.width < MAX_X_PLUS_WIDTH) z.width++;

  // $ABD2: the same pair for y and height, capped at 15.
  if (z.y !== 1) {
    z.y--;
    z.height++;
  }
  if (z.y + z.height < MAX_Y_PLUS_HEIGHT) z.height++;

  // $ABEC: the loop's own terminator. The box is DRAWN this iteration either
  // way -- $ABE6/$ABE9 run before the test -- so `done` means "no further
  // step", not "nothing to draw".
  z.done = z.width + z.height >= FINAL_SUM;
  return true;
}

/**
 * $AC5F: step a screen address down one character row.
 *
 * +32 lands on the next row within a third of the screen; at the bottom of a
 * third the low byte has reached $E0 and it takes $0720 to carry into the next
 * third's row 0.
 */
function charRowDown(addr: number): number {
  return ((addr & 0xff) < 0xe0 ? addr + 0x20 : addr + 0x720) & 0xffff;
}

/** $ACD8: the inverse, used by the border's two upward runs. */
function charRowUp(addr: number): number {
  return ((addr & 0xff) >= 0x20 ? addr + 0xffe0 : addr + 0xf8e0) & 0xffff;
}

/**
 * zoombox_fill ($ABF9): copy the box's cells out of window_buf.
 *
 * Source is window_buf + 1 + y * 192 + x ($AC10 points at $F291, the same
 * off-by-one `plot_game_window` blits through), where 192 is one tile row of
 * the 24-byte-wide buffer. Note it does NOT apply game_window_offset: the
 * zoombox always reads the unscrolled buffer.
 */
export function zoomboxFill(
  screen: SpectrumScreen,
  buffers: GameWindowBuffers,
  z: ZoomboxState,
): void {
  let src = 1 + z.y * WINDOW_STRIDE * 8 + z.x;
  // $AC15: entry y * 8 of the pixel-row address table is that tile row's top.
  let rowStart = (rowAddresses[z.y * 8] ?? 0) + z.x;

  for (let row = 0; row < z.height; row++) {
    // $AC3F: eight scanlines per tile row. Within a row the destination steps
    // by $0100 (INC D) and the source by the full 24-byte buffer stride --
    // `width` copied by LDIR plus the self-modified (24 - width) skip.
    let dst = rowStart;
    for (let line = 0; line < 8; line++) {
      for (let col = 0; col < z.width; col++) {
        screen.display[dst + col - DISPLAY_FILE_BASE] = buffers.pixels[src + col] ?? 0;
      }
      src += WINDOW_STRIDE;
      dst = (dst + 0x100) & 0xffff;
    }
    rowStart = charRowDown(rowStart);
  }
}

/**
 * zoombox_draw_tile ($ACFC): one 8x8 border tile, pixels and attribute.
 *
 * The attribute bank is chosen from the address's own high byte ($AD17): under
 * $48 is the top third, under $50 the middle, otherwise the bottom.
 */
function drawTile(screen: SpectrumScreen, addr: number, tile: number, attribute: number): void {
  const base = tile * 8;
  let dst = addr;
  for (let row = 0; row < 8; row++) {
    screen.display[dst - DISPLAY_FILE_BASE] = zoomboxTiles[base + row] ?? 0;
    dst = (dst + 0x100) & 0xffff;
  }
  // $AD12: D after eight INCs, less one, is the last scanline's high byte --
  // which is in the same third as the first, so this identifies the third.
  const high = ((dst >> 8) - 1) & 0xff;
  const bank = high < 0x48 ? 0x58 : high < 0x50 ? 0x59 : 0x5a;
  screen.attributes[((bank << 8) | (addr & 0xff)) - 0x5800] = attribute & 0xff;
}

/**
 * zoombox_draw_border ($AC6F): the ring one cell outside the fill area.
 *
 * Drawn as a single walk -- top-left corner, right along the top, down the
 * right side, left along the bottom, up the left side -- so the horizontal
 * runs step by INC/DEC L and the vertical ones by a character row.
 */
export function zoomboxDrawBorder(
  screen: SpectrumScreen,
  z: ZoomboxState,
  attribute: number,
): void {
  // $AC72: one row above and one column left of the fill.
  let addr = (rowAddresses[(z.y - 1) * 8] ?? 0) + (z.x - 1);

  drawTile(screen, addr, TILE_TOP_LEFT, attribute);
  addr++;
  for (let i = 0; i < z.width; i++) {
    drawTile(screen, addr, TILE_HORIZONTAL, attribute);
    addr++;
  }
  drawTile(screen, addr, TILE_TOP_RIGHT, attribute);

  addr = charRowDown(addr);
  for (let i = 0; i < z.height; i++) {
    drawTile(screen, addr, TILE_VERTICAL, attribute);
    addr = charRowDown(addr);
  }

  drawTile(screen, addr, TILE_BOTTOM_RIGHT, attribute);
  addr--;
  for (let i = 0; i < z.width; i++) {
    drawTile(screen, addr, TILE_HORIZONTAL, attribute);
    addr--;
  }
  drawTile(screen, addr, TILE_BOTTOM_LEFT, attribute);

  addr = charRowUp(addr);
  for (let i = 0; i < z.height; i++) {
    drawTile(screen, addr, TILE_VERTICAL, attribute);
    addr = charRowUp(addr);
  }
}

/**
 * $ABE6/$ABE9: draw one frame of the box. Pure -- no state is mutated, so a
 * re-render cannot advance the animation.
 *
 * One deliberate divergence, and it is the demo's bookkeeping rather than the
 * game's. The original never writes attributes over the fill area: it only
 * attributes border tiles, and the revealed region ends up correct because
 * each step's border is overwritten by the next step's fill while its
 * attribute cell survives. This demo clears the whole screen every frame (see
 * `render()` in src/main.ts, and CLAUDE.md on the renderer running more than
 * once per frame), so nothing accumulates and the fill area would be left on
 * the cleared attribute. Attributing the whole box here reproduces the
 * original's ACCUMULATED result -- same pixels on screen, different
 * bookkeeping.
 */
export function drawZoombox(
  screen: SpectrumScreen,
  buffers: GameWindowBuffers,
  z: ZoomboxState,
  attribute: number,
): void {
  zoomboxFill(screen, buffers, z);
  zoomboxDrawBorder(screen, z, attribute);
  attributeBox(screen, z, attribute);
}

/** The accumulated attribute footprint described on `drawZoombox`. */
function attributeBox(screen: SpectrumScreen, z: ZoomboxState, attribute: number): void {
  const topLeft = (rowAddresses[(z.y - 1) * 8] ?? 0) + (z.x - 1);
  // The border ring is one cell wider and taller than the fill on each side.
  // screenCoords returns the PIXEL row; the attribute grid wants the
  // character row, and topLeft is always a character row's first scanline.
  const { col, row: pixelRow } = screenCoords(topLeft);
  const row = pixelRow >> 3;
  for (let r = 0; r <= z.height + 1; r++) {
    for (let c = 0; c <= z.width + 1; c++) {
      screen.setAttribute(col + c, row + r, attribute);
    }
  }
}
