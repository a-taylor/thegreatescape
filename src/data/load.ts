/**
 * Loaders over data/*.json.
 *
 * The JSON is imported rather than fetched so Vite bundles it and the golden
 * tests can run under Node without a server. Bitmap payloads arrive base64 and
 * are decoded once into Uint8Arrays -- BUILD_PROMPT.md §5 wants real integer
 * buffers, not number arrays.
 */

import mapJson from '../../data/map.json';
import tilesJson from '../../data/tiles.json';
import roomsJson from '../../data/rooms.json';
import objectsJson from '../../data/objects.json';
import masksJson from '../../data/masks.json';
import spritesJson from '../../data/sprites.json';
import timingJson from '../../data/timing.json';
import prngJson from '../../data/prng.json';

import type {
  MapData,
  MasksData,
  ObjectsData,
  PrngData,
  RoomsData,
  SpritesData,
  TileSet,
  TilesData,
  TimingData,
} from './types.js';

export const mapData = mapJson as unknown as MapData;
export const tilesData = tilesJson as unknown as TilesData;
export const roomsData = roomsJson as unknown as RoomsData;
export const objectsData = objectsJson as unknown as ObjectsData;
export const masksData = masksJson as unknown as MasksData;
export const spritesData = spritesJson as unknown as SpritesData;
export const timingData = timingJson as unknown as TimingData;
export const prngData = prngJson as unknown as PrngData;

/** Decode base64 to bytes, in Node or the browser. */
export function decodeBase64(b64: string): Uint8Array {
  if (typeof atob === 'function') {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  // Node without atob (older runtimes).
  return Uint8Array.from(Buffer.from(b64, 'base64'));
}

/**
 * A decoded 8x8 tile set: `count` tiles of 8 bitmap bytes, back to back.
 * Row `r` of tile `n` is `bytes[n * 8 + r]`.
 */
export class TileBitmaps {
  readonly bytes: Uint8Array;
  readonly count: number;

  constructor(set: TileSet) {
    this.bytes = decodeBase64(set.data);
    this.count = set.count;
  }

  /** Byte offset of tile `n`. */
  offset(n: number): number {
    return n * 8;
  }

  row(tile: number, row: number): number {
    return this.bytes[tile * 8 + row]!;
  }
}

let exterior: TileBitmaps | undefined;
let interior: TileBitmaps | undefined;
let maskTiles: TileBitmaps | undefined;

export function exteriorTiles(): TileBitmaps {
  return (exterior ??= new TileBitmaps(tilesData.exterior));
}

export function interiorTiles(): TileBitmaps {
  return (interior ??= new TileBitmaps(tilesData.interior));
}

export function maskTileBitmaps(): TileBitmaps {
  return (maskTiles ??= new TileBitmaps(tilesData.mask));
}

/**
 * The room definition backing a 1-based room number.
 *
 * rooms_and_tunnels ($6BAD) is 1-based and heavily aliased -- 33 definitions
 * back 52 rooms -- so this indirection is load-bearing, not cosmetic.
 */
export function roomDef(room: number) {
  const entry = roomsData.rooms[room - 1];
  if (!entry) throw new Error(`no such room: ${room}`);
  const def = roomsData.roomdefs[entry.roomdefIndex];
  if (!def) throw new Error(`room ${room} points at missing roomdef`);
  return { entry, def };
}

/** The PRNG source bytes, $9000..$90FF (data, not a generator -- §6). */
export function prngBytes(): Uint8Array {
  return decodeBase64(prngData.data);
}
