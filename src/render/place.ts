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

/**
 * Where a CHARACTER sits inside the window.
 *
 * The two axes are not symmetrical:
 *
 *   horizontal  byte granularity plus a sub-byte shift. $E4F5 computes
 *               `iso_pos_x - map_position_x` in bytes, and the plotter rolls
 *               the sprite by `iso_pos.x & 7` on top ($E2A2).
 *
 *   vertical    PIXEL rows. $E4EB computes `vischar.iso_pos.y -
 *               map_position_y * 8` from the FULL 16-bit iso_pos.y, then
 *               multiplies by 24 -- and 24 bytes is one row of a 24-wide
 *               buffer, i.e. a single pixel row.
 *
 * Note this is setup_VISCHAR_plotting. setup_ITEM_plotting ($DCA7) multiplies
 * by 192 instead, placing items on whole tile rows. Applying the item rule to a
 * character quantises him to 8-pixel steps, which is invisible outdoors --
 * where the map scrolls with him -- but shows up as bouncing indoors, where
 * nothing scrolls to hide it.
 */
export function windowPlacement(
  pos: Pos,
  mapPosition: { x: number; y: number },
  widthBytes = 2,
  height = 1,
): WindowPlacement {
  const iso = isoPlacement(pos);
  const column = iso.column - mapPosition.x; // $DCBC
  const pixelRow = iso.pixelRow - mapPosition.y * 8; // $E4EB

  const visible =
    column + widthBytes > 0 &&
    column < WINDOW_COLS &&
    pixelRow + height > 0 &&
    pixelRow < BUFFER_ROWS * 8;

  return { column, pixelRow, shift: iso.shift, visible };
}

/**
 * Where an ITEM sits inside the window (setup_item_plotting, c$DC41).
 *
 * "The counterpart of, and very similar to" setup_vischar_plotting -- but the
 * vertical axis differs, and that difference is the whole reason both exist:
 *
 *   $DCA7  Y = item.iso_pos.y - map_position.y, multiplied by 192
 *   $E4EB  Y = vischar.iso_pos.y - map_position.y * 8, multiplied by 24
 *
 * 192 is eight rows of a 24-byte-wide buffer, so items land on whole TILE rows;
 * 24 is one row, so characters land on single PIXEL rows. The two are consistent
 * because they read different fields: an itemstruct's iso_pos is stored in tile
 * rows, a vischar's in pixel rows. Reading one routine and applying it to the
 * other is what made the hero bounce through all of P3.
 *
 * Two further asymmetries, both faithful:
 *   - items are never flipped ($DC54 zeroes sprite_index outright)
 *   - item plotting "only ever uses the 16 pixel plotter", so there is no
 *     24-wide path and item_definitions stores a plain width, not width+1
 */
export function itemPlacement(
  isoColumn: number,
  isoTileRow: number,
  mapPosition: { x: number; y: number },
): { column: number; pixelRow: number } {
  return {
    // $DCBC, sign-extended at $DCC6 -- so a negative column is meaningful and
    // is left for the clipper to handle rather than being clamped here.
    column: isoColumn - mapPosition.x,
    // $DCA7..$DCBA: the *192 lands on a tile row, which is *8 pixel rows.
    pixelRow: (isoTileRow - mapPosition.y) * 8,
  };
}

/**
 * reset_outdoor_position ($B2FC): centre the map on the hero, outdoors.
 *
 * Called from transition ($68EF) whenever the hero steps outside, and this is
 * the game's own initialisation of map_position -- not an approximation of it.
 * It resolves what OPEN_QUESTIONS.md §11 was open about:
 *
 *   map_position.x = iso_pos.x / 8 - 11    ($B308..$B30D)
 *   map_position.y = iso_pos.y / 8 - 6     ($B314..$B319)
 *
 * The two constants are not the same because they are not the same units: 11
 * is "the width of the game screen minus half of the hero's width" in BYTES,
 * and 6 is "the height ... minus half of the hero's height" in TILE ROWS.
 * Halving the window in each axis, which is the obvious thing to do, gives 12
 * and 8 instead and puts the hero low and slightly right of where the game
 * puts him.
 *
 * Both divisions are the no-rounding form ($E555), and both results are stored
 * into single bytes ($81BB, $81BC) with no clamping to the map -- so near an
 * edge the window really does run off it. That is reproduced.
 */
export function resetOutdoorPosition(pos: Pos): { x: number; y: number } {
  const iso = calcIsoPos(pos);
  return {
    x: ((iso.x >> 3) - 11) & 0xff,
    y: ((iso.y >> 3) - 6) & 0xff,
  };
}
