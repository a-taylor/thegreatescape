/**
 * Filling the tile buffer: exterior map and interior rooms.
 *
 * Both write tile references into GameWindowBuffers.tiles; expanding those to
 * pixels is the buffer's job. That split is the original's own
 * (setup_room/plot_interior_tiles vs the plot_*_tiles_common family) and it is
 * what makes restore_tiles cheap later.
 */

import { mapData, objectsData, roomDef } from '../data/load.js';
import { BUFFER_ROWS, WINDOW_COLS, type GameWindowBuffers } from './window.js';

/** Supertiles are 4x4 tiles. */
const SUPERTILE_SIDE = 4;

/**
 * Tile-set offset for a supertile, from plot_tile (c$A9AD):
 *
 *   $A9B3 CP $2D / JR C    supertile <  45   -> exterior_tiles[0]
 *   $A9BA CP $8B / JR C    supertile < 139   -> exterior_tiles[145]
 *   $A9BE CP $CC / JR NC   supertile >= 204  -> exterior_tiles[145]
 *                          otherwise          -> exterior_tiles[365]
 *
 * The extractor pre-resolves this per supertile, so the engine reads it rather
 * than recomputing. Note 365, not the 366 stated in TheGreatEscapeGraphics.ref
 * line 205 -- $90F8 - $8590 = 2920, and 2920 / 8 = 365.
 */
export function tileBankForSupertile(supertile: number): number {
  return mapData.tileBankForSuperTile[supertile]!;
}

/**
 * Fill the tile buffer from the exterior map at a tile-granular position.
 *
 * `mapX`/`mapY` are in TILES from the map's top-left. The game tracks a
 * coarser map_position plus a 7x5 supertile window (map_buf) and shunts it as
 * the hero walks; expressing it directly in tiles here gives the same result
 * for a static frame, and the shunt_map_* family lands in P2 on top of it.
 */
export function fillExterior(buffers: GameWindowBuffers, mapX: number, mapY: number): void {
  const { width, height, supertileIndices, superTiles } = mapData;

  for (let ty = 0; ty < BUFFER_ROWS; ty++) {
    const ay = mapY + ty;
    const sy = Math.floor(ay / SUPERTILE_SIDE);
    for (let tx = 0; tx < WINDOW_COLS; tx++) {
      const ax = mapX + tx;
      const sx = Math.floor(ax / SUPERTILE_SIDE);

      if (sx < 0 || sy < 0 || sx >= width || sy >= height) {
        buffers.setTile(tx, ty, 0);
        continue;
      }

      const supertile = supertileIndices[sy * width + sx]!;
      const cell = superTiles[supertile]!;
      // The tile reference stays 8-bit, as it is in the game's tile_buf; the
      // bank travels alongside and is added when the tile is plotted. Resolving
      // it here instead would overflow the byte for any tile at or above 256.
      buffers.setTile(
        tx,
        ty,
        cell[(ay & 3) * SUPERTILE_SIDE + (ax & 3)]!,
        tileBankForSupertile(supertile),
      );
    }
  }
}

/** Bank-resolved tile index at a map position, in tiles from the map origin. */
export function exteriorTileAt(mapX: number, mapY: number): number {
  const { width, supertileIndices, superTiles } = mapData;
  const supertile = supertileIndices[Math.floor(mapY / 4) * width + Math.floor(mapX / 4)]!;
  return tileBankForSupertile(supertile) + superTiles[supertile]![(mapY & 3) * 4 + (mapX & 3)]!;
}

/**
 * Draw one interior object into the tile buffer at (x, y) in tiles.
 *
 * Tile 0 is transparent: expand_object ($6ADE AND A / JR Z) skips the write but
 * still advances the cursor, which is how furniture overlays a room outline
 * without erasing it.
 */
export function plotObject(
  buffers: GameWindowBuffers,
  objectIndex: number,
  x: number,
  y: number,
): void {
  const obj = objectsData.objects[objectIndex];
  if (!obj) throw new Error(`no such interior object: ${objectIndex}`);

  for (let oy = 0; oy < obj.height; oy++) {
    const ty = y + oy;
    if (ty < 0 || ty >= BUFFER_ROWS) continue;
    for (let ox = 0; ox < obj.width; ox++) {
      const tx = x + ox;
      if (tx < 0 || tx >= WINDOW_COLS) continue;
      const tile = obj.tiles[oy * obj.width + ox]!;
      if (tile === 0) continue; // transparent
      buffers.setTile(tx, ty, tile);
    }
  }
}

/**
 * Fill the tile buffer for an interior room.
 *
 * Objects are drawn in the roomdef's stored order so later ones overlay
 * earlier, matching setup_room. `room` is 1-based: rooms_and_tunnels ($6BAD)
 * starts at room 1.
 */
export function fillRoom(buffers: GameWindowBuffers, room: number): void {
  const { def } = roomDef(room);
  buffers.wipeTiles();
  for (const o of def.objects) plotObject(buffers, o.object, o.x, o.y);
}
