/**
 * Placing a character in the game window.
 *
 * vischar_visible (c$BAF7) settles a question that is easy to get wrong:
 * map_position is in ISO space, not world or tinypos space. It is compared
 * directly against `iso_pos.x / 8` on the horizontal axis ($BAFF) and against
 * `map_position.y * 8` in pixels on the vertical ($BB33), so the exterior map's
 * tile grid IS the isometric projection -- the artwork has the projection baked
 * in, and a character is placed by projecting its world position and then
 * subtracting the window origin.
 *
 * Deriving map_position from tinypos instead puts the window in a different
 * space entirely; it looks plausible because both are "small numbers of tiles",
 * which is exactly why it is worth stating.
 */

import { calcIsoPos, type Pos } from '../game/coords.js';
import { BUFFER_ROWS, WINDOW_COLS } from './window.js';

/** Iso-space byte column and pixel row of a world position. */
export interface IsoPlacement {
  /** Byte column in iso space: iso_pos.x / 8. */
  readonly column: number;
  /** Pixel row in iso space: iso_pos.y, unscaled. */
  readonly pixelRow: number;
  /** Sub-byte horizontal shift for the sprite plotter: iso_pos.x & 7. */
  readonly shift: number;
}

export function isoPlacement(pos: Pos): IsoPlacement {
  const iso = calcIsoPos(pos);
  return {
    column: (iso.x >> 3) & 0xff, // divide_by_8, truncated to a byte ($E45E)
    pixelRow: iso.y,
    shift: iso.x & 7, // $E2A2
  };
}

/** Where a character sits inside the window, given the current map position. */
export interface WindowPlacement {
  readonly column: number;
  readonly pixelRow: number;
  readonly shift: number;
  readonly visible: boolean;
}

export function windowPlacement(
  pos: Pos,
  mapPosition: { x: number; y: number },
  widthBytes = 2,
  height = 1,
): WindowPlacement {
  const iso = isoPlacement(pos);
  const column = iso.column - mapPosition.x; // $BAFF / $BB18
  const pixelRow = iso.pixelRow - mapPosition.y * 8; // $BB33

  const visible =
    column + widthBytes > 0 &&
    column < WINDOW_COLS &&
    pixelRow + height > 0 &&
    pixelRow < BUFFER_ROWS * 8;

  return { column, pixelRow, shift: iso.shift, visible };
}

/**
 * Map position that centres a world position in the window.
 *
 * ASSUMPTION: the original does not centre. It shunts by one tile when the hero
 * crosses a threshold, so the view lags and clamps differently, especially at
 * the map edges. This is the demo's stand-in until that trigger rule is traced
 * -- see OPEN_QUESTIONS.md §11. It is at least in the RIGHT SPACE now, which
 * the tinypos-derived version was not.
 */
export function centreOn(pos: Pos, mapWidthTiles = 216, mapHeightTiles = 136): {
  x: number;
  y: number;
} {
  const iso = isoPlacement(pos);
  const x = iso.column - (WINDOW_COLS >> 1);
  const y = (iso.pixelRow >> 3) - (BUFFER_ROWS >> 1);
  return {
    x: Math.max(0, Math.min(mapWidthTiles - WINDOW_COLS, x)),
    y: Math.max(0, Math.min(mapHeightTiles - BUFFER_ROWS, y)),
  };
}
