/**
 * vischar_visible (c$BAF7): clip a character to the game window.
 *
 * Five cases per axis, as the routine's own header sets out:
 *
 *   (A) entirely off the left/top      -> not drawn
 *   (B) clipped on its left/top        -> skip into the sprite
 *   (C) entirely visible               -> no clipping
 *   (D) clipped on its right/bottom    -> draw fewer bytes/rows
 *   (E) entirely off the right/bottom  -> not drawn
 *
 * "Note that no vischar will ever be wider than the window so we never need to
 * consider if clipping will occur on both sides."
 *
 * The two axes work in DIFFERENT UNITS, which is the thing to keep hold of:
 * horizontal is in bytes and uses state.iso_pos_x (the /8 value), vertical is
 * in pixel rows and uses vischar.iso_pos.y (the full 16-bit value) against
 * map_position.y * 8.
 */

import { BUFFER_ROWS, WINDOW_COLS } from './window.js';

export interface ClipResult {
  readonly visible: boolean;
  /** Bytes to skip from the left of the sprite (case B). */
  readonly leftSkip: number;
  /** Bytes actually drawn. */
  readonly clippedWidth: number;
  /** Rows to skip from the top of the sprite (case B). */
  readonly topSkip: number;
  /** Rows actually drawn. */
  readonly clippedHeight: number;
}

const INVISIBLE: ClipResult = {
  visible: false,
  leftSkip: 0,
  clippedWidth: 0,
  topSkip: 0,
  clippedHeight: 0,
};

export interface ClipSubject {
  /** state.iso_pos_x ($81B5): vischar.iso_pos.x / 8, in bytes. */
  readonly isoXBytes: number;
  /** vischar.iso_pos.y ($801A): the FULL 16-bit value, in pixel rows. */
  readonly isoYPixels: number;
  /**
   * vischar.width_bytes ($801E) -- which the struct table defines as "Copy of
   * sprite width in bytes + 1", because the plotter emits one extra byte to
   * catch the sub-byte shift.
   */
  readonly widthBytesPlusOne: number;
  /** vischar.height ($801F), in rows. */
  readonly height: number;
}

/**
 * Horizontal half ($BAF7..$BB30). All quantities are in bytes.
 */
function clipHorizontal(
  s: ClipSubject,
  mapX: number,
): { visible: boolean; leftSkip: number; clippedWidth: number } {
  // $BAFD: the window's right edge, 24 bytes from the map position.
  const availableRight = mapX + WINDOW_COLS - s.isoXBytes;

  // Case (E): left edge at or beyond the right edge. Note ZERO also fails.
  if (availableRight <= 0) return { visible: false, leftSkip: 0, clippedWidth: 0 };

  // Case (D): runs off the right.
  if (availableRight < s.widthBytesPlusOne) {
    return { visible: true, leftSkip: 0, clippedWidth: availableRight };
  }

  // $BB11: the sprite's right edge, relative to the window's left edge.
  const availableLeft = s.isoXBytes + s.widthBytesPlusOne - mapX;

  // Case (A): right edge at or beyond the left edge.
  if (availableLeft <= 0) return { visible: false, leftSkip: 0, clippedWidth: 0 };

  // Case (B): runs off the left.
  if (availableLeft < s.widthBytesPlusOne) {
    return {
      visible: true,
      leftSkip: s.widthBytesPlusOne - availableLeft,
      clippedWidth: availableLeft,
    };
  }

  // Case (C).
  return { visible: true, leftSkip: 0, clippedWidth: s.widthBytesPlusOne };
}

/**
 * Vertical half ($BB33..$BB92). All quantities are in PIXEL ROWS.
 *
 * The `>= 256` rejections ($BB4D, $BB78) are not redundant: these are 16-bit
 * subtractions whose result is then used as a byte, so a large positive value
 * would wrap and read as a small one.
 */
function clipVertical(
  s: ClipSubject,
  mapY: number,
): { visible: boolean; topSkip: number; clippedHeight: number } {
  // $BB33: the window's bottom edge. 17 rows, not 16 -- the buffer's height.
  const windowBottom = (mapY + BUFFER_ROWS) * 8;
  const availableBottom = windowBottom - s.isoYPixels;

  // Case (E), plus the out-of-range guard.
  if (availableBottom <= 0 || availableBottom >= 256) {
    return { visible: false, topSkip: 0, clippedHeight: 0 };
  }

  // Case (D): runs off the bottom.
  if (availableBottom < s.height) {
    return { visible: true, topSkip: 0, clippedHeight: availableBottom };
  }

  // $BB5E: the sprite's bottom edge, relative to the window's top.
  const availableTop = s.isoYPixels + s.height - mapY * 8;

  // Case (A).
  if (availableTop <= 0 || availableTop >= 256) {
    return { visible: false, topSkip: 0, clippedHeight: 0 };
  }

  // Case (B): runs off the top.
  if (availableTop < s.height) {
    return {
      visible: true,
      topSkip: s.height - availableTop,
      clippedHeight: availableTop,
    };
  }

  // Case (C).
  return { visible: true, topSkip: 0, clippedHeight: s.height };
}

export function vischarVisible(
  s: ClipSubject,
  mapPosition: { x: number; y: number },
): ClipResult {
  const h = clipHorizontal(s, mapPosition.x);
  if (!h.visible) return INVISIBLE;

  const v = clipVertical(s, mapPosition.y);
  if (!v.visible) return INVISIBLE;

  return {
    visible: true,
    leftSkip: h.leftSkip,
    clippedWidth: h.clippedWidth,
    topSkip: v.topSkip,
    clippedHeight: v.clippedHeight,
  };
}

/**
 * Where a clipped character starts in window_buf, in PIXEL rows.
 *
 * setup_vischar_plotting has a shortcut worth knowing about ($E4D2..$E4D8):
 * when there is a top skip the vertical position is left at ZERO, because "the
 * sprite always starts at the top of the screen" in that case. So a character
 * clipped at the top is drawn at buffer row 0 with the skip applied to the
 * sprite data, rather than at a negative row.
 */
export function clippedBufferRow(
  topSkip: number,
  isoYPixels: number,
  mapY: number,
): number {
  if (topSkip !== 0) return 0; // $E4D8
  return isoYPixels - mapY * 8; // $E4EB
}
