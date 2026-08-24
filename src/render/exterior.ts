/**
 * The exterior map window: map_position, map_buf, and the shunt_map_* family.
 *
 * The game does not re-render the whole window when the hero walks. It keeps a
 * 7x5 buffer of supertile indices (map_buf, $FF58) covering rather more than
 * the visible 24x17 tiles, and when the view moves by one tile it memmoves both
 * buffers by a byte and redraws only the newly exposed edge. That is what the
 * shunt_map_* routines do, and it is why the buffers are the sizes they are.
 */

import { mapData } from '../data/load.js';
import {
  BUFFER_ROWS,
  NO_OFFSET,
  WINDOW_COLS,
  type GameWindowBuffers,
  type GameWindowOffset,
} from './window.js';

/** map_buf is 7 supertiles wide by 5 tall ($FF58). */
export const MAP_BUF_COLS = 7;
export const MAP_BUF_ROWS = 5;
export const SUPERTILE_SIDE = 4;

/** map_position ($81BB x, $81BC y), in TILES. Both are single bytes. */
export interface MapPosition {
  x: number;
  y: number;
}

/**
 * The absolute tile row that tile_buf row 0 displays.
 *
 * get_supertiles ($A7DF) points at `map_tiles - 54`, i.e. one whole row BEFORE
 * the map position's supertile row, so map_buf row 0 is supertile row
 * (y >> 2) - 1. plot_vertical_tiles_common ($A8FA) then starts the leading edge
 * at row offset (y & 3) within that supertile. Combining:
 *
 *   ((y >> 2) - 1) * 4 + (y & 3)  ==  (y & ~3) - 4 + (y & 3)  ==  y - 4
 *
 * The four-row bias is easy to miss and shifts the whole view vertically.
 */
export const MAP_ROW_BIAS = 4;

export function tileOriginFor(pos: MapPosition): { x: number; y: number } {
  return { x: pos.x, y: pos.y - MAP_ROW_BIAS };
}

/**
 * get_supertiles ($A7C9): copy a 7x5 block of supertile indices into map_buf.
 *
 * The routine computes its source pointer as
 *   map_tiles - 54 + (y & $FC) * 13.5 + (x >> 2)
 * where the 13.5 is just (y >> 2) * 54 expressed without a multiply -- the
 * value is pre-rounded to a multiple of four, so halving it is exact.
 */
export function getSupertiles(pos: MapPosition, out = new Uint8Array(MAP_BUF_COLS * MAP_BUF_ROWS)): Uint8Array {
  const { width, height, supertileIndices } = mapData;
  const col = (pos.x >> 2) & 0x3f;
  const row = ((pos.y & 0xfc) >> 2) - 1; // the "- a whole row" of $A7DF

  for (let r = 0; r < MAP_BUF_ROWS; r++) {
    const sy = row + r;
    for (let c = 0; c < MAP_BUF_COLS; c++) {
      const sx = col + c;
      out[r * MAP_BUF_COLS + c] =
        sx < 0 || sy < 0 || sx >= width || sy >= height
          ? 0
          : supertileIndices[sy * width + sx]!;
    }
  }
  return out;
}

/**
 * plot_all_tiles ($A8A2): fill tile_buf from map_buf.
 *
 * Each column walks map_buf top to bottom as a leading partial supertile, three
 * whole ones, then a trailing partial -- 4/3/2/1 leading rows for a y offset of
 * 0/1/2/3 respectively ($A913, "turn 0,4,8,12 into 4,3,2,1"). Horizontally the
 * map_buf pointer advances every time the map x position crosses a multiple of
 * four ($A8C3).
 *
 * The tile reference stays 8-bit and the bank travels alongside, exactly as
 * plot_tile (c$A9AD) requires -- see GameWindowBuffers.tiles.
 */
export function plotAllTiles(
  buffers: GameWindowBuffers,
  pos: MapPosition,
  mapBuf: Uint8Array,
): void {
  const { superTiles, tileBankForSuperTile } = mapData;
  const colOffset = pos.x & 3;
  const rowOffset = pos.y & 3;

  for (let tx = 0; tx < WINDOW_COLS; tx++) {
    // Which map_buf column this screen column falls in, and where inside it.
    const absCol = colOffset + tx;
    const bufCol = absCol >> 2;
    const inCol = absCol & 3;

    for (let ty = 0; ty < BUFFER_ROWS; ty++) {
      const absRow = rowOffset + ty;
      const bufRow = absRow >> 2;
      const inRow = absRow & 3;

      const supertile =
        bufCol < MAP_BUF_COLS && bufRow < MAP_BUF_ROWS
          ? mapBuf[bufRow * MAP_BUF_COLS + bufCol]!
          : 0;

      const tile = superTiles[supertile]![inRow * SUPERTILE_SIDE + inCol]!;
      buffers.setTile(tx, ty, tile, tileBankForSuperTile[supertile]!);
    }
  }
}

/**
 * The exterior view: map position plus its supertile window.
 *
 * The shunt operations mutate in place and mark which edge needs redrawing,
 * mirroring the original's "memmove then plot one edge" structure rather than
 * re-rendering everything.
 */
export class ExteriorView {
  readonly position: MapPosition;
  readonly mapBuf = new Uint8Array(MAP_BUF_COLS * MAP_BUF_ROWS);
  /** move_map_y ($A7C6): the 0..3 shunt-pattern counter. */
  moveMapY = 0;
  /** game_window_offset ($A7C7): the sub-tile scroll for this frame. */
  gameWindowOffset: GameWindowOffset = NO_OFFSET;

  constructor(x = 0, y = 0) {
    this.position = { x: x & 0xff, y: y & 0xff };
    this.refresh();
  }

  /** get_supertiles: repopulate map_buf for the current position. */
  refresh(): void {
    getSupertiles(this.position, this.mapBuf);
  }

  /** Fill the tile buffer for the current position. */
  render(buffers: GameWindowBuffers): void {
    plotAllTiles(buffers, this.position, this.mapBuf);
  }

  /**
   * shunt_map_left ($A9E4): INC map_position.x.
   *
   * The names describe the MAP's motion, not the hero's -- shunting the map
   * left brings the terrain to the right of the window into view, so the x
   * position increases.
   */
  shuntLeft(): void {
    this.position.x = (this.position.x + 1) & 0xff;
    this.refresh();
  }

  /** shunt_map_right ($AA05): DEC map_position.x. */
  shuntRight(): void {
    this.position.x = (this.position.x - 1) & 0xff;
    this.refresh();
  }

  /**
   * shunt_map_up ($AA4B): INCREMENTS map_position.y.
   *
   * The sign is the opposite of what the name suggests, on both vertical
   * routines: "up" moves the MAP up, which brings lower rows of terrain into
   * view, so the position increases. Guessing the sign scrolls the world the
   * wrong way and shows up as the view sliding away from the hero.
   */
  shuntUp(): void {
    this.position.y = (this.position.y + 1) & 0xff;
    this.refresh();
  }

  /** shunt_map_down ($AA6C): DECREMENTS map_position.y. */
  shuntDown(): void {
    this.position.y = (this.position.y - 1) & 0xff;
    this.refresh();
  }

  /** shunt_map_up_right ($AA26): x - 1, y + 1. */
  shuntUpRight(): void {
    this.position.x = (this.position.x - 1) & 0xff;
    this.position.y = (this.position.y + 1) & 0xff;
    this.refresh();
  }

  /** shunt_map_down_left ($AA8D): INC L / DEC H, i.e. x + 1, y - 1. */
  shuntDownLeft(): void {
    this.position.x = (this.position.x + 1) & 0xff;
    this.position.y = (this.position.y - 1) & 0xff;
    this.refresh();
  }

  /**
   * move_map ($AAB2): scroll the map in response to the hero's animation.
   *
   * "The map is shunted around in the opposite direction to the apparent
   * character motion." The direction comes from the animation's own header --
   * byte 3, the map direction field ($AAC8) -- with 255 meaning "don't move".
   * Reversing the animation exchanges up and down ($AAD0 XOR $02).
   *
   * The subtlety that makes motion smooth: it does NOT shunt every frame. A
   * counter, move_map_y ($A7C6), cycles 0..3 and selects both which shunt (if
   * any) happens and a game_window_offset that scrolls sub-tile at blit time.
   * Over four frames that yields one tile of travel on each axis, matching the
   * hero's own four-frame walk cycle.
   *
   * @returns the game_window_offset for this frame
   */
  moveMap(mapDirection: number, reverse: boolean): GameWindowOffset {
    if (mapDirection === 0xff) return this.gameWindowOffset; // $AAC9

    let dir = mapDirection & 0x03;
    if (reverse) dir ^= 0x02; // $AACC..$AAD0

    // $AAE2..$AAF3: the clamp beyond which we would render off the map.
    const limitX = dir === 1 || dir === 2 ? 0x00 : 0xc0;
    const limitY = dir >= 2 ? 0x00 : 0x7c;

    // $AAF8 / $AAFF: at either limit, do nothing at all.
    if (this.position.x === limitX) return this.gameWindowOffset;
    if (this.position.y === limitY) return this.gameWindowOffset;

    // $AB04..$AB13: forwards for the TOP directions, backwards for BOTTOM.
    this.moveMapY = (dir < 2 ? this.moveMapY + 1 : this.moveMapY - 1) & 0x03;

    // $AB15..$AB2A.
    this.gameWindowOffset =
      this.moveMapY === 0
        ? { low: 0x00, high: 0x00 }
        : this.moveMapY === 1
          ? { low: 0x30, high: 0xff }
          : this.moveMapY === 2
            ? { low: 0x60, high: 0x00 }
            : { low: 0x90, high: 0xff };

    // $AB31 jump table -> move_map_up_left / _up_right / _down_right / _down_left.
    const y = this.moveMapY;
    switch (dir) {
      case 0: // move_map_up_left ($AB39): up / none / left / left
        if (y === 0) this.shuntUp();
        else if (y !== 2) this.shuntLeft();
        break;
      case 1: // move_map_up_right ($AB44): up-right / none / right / none
        if (y === 0) this.shuntUpRight();
        else if (y === 2) this.shuntRight();
        break;
      case 2: // move_map_down_right ($AB4F): right / none / right / down
        if (y === 3) this.shuntDown();
        else if ((y & 1) === 0) this.shuntRight();
        break;
      case 3: // move_map_down_left ($AB5A): none / left / none / down-left
        if (y === 1) this.shuntLeft();
        else if (y === 3) this.shuntDownLeft();
        break;
      default:
        break;
    }

    return this.gameWindowOffset;
  }
}
