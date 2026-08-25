/**
 * render_mask_buffer (c$B916): build the foreground occlusion mask.
 *
 * This is what puts the hero BEHIND huts, fences and walls. Each frame it
 * starts from an all-permitting buffer and ANDs in every scenery mask that both
 * overlaps the character on screen and sits in front of him in the world. The
 * result is the `foreground` input to plot_masked_sprite: 1 means "the sprite
 * may draw here", 0 means "scenery occludes it".
 *
 * The buffer is 4 bytes wide by 40 pixel rows ($8100, $A0 bytes). It is
 * addressed two ways, which is easy to trip over: mask_against_tile advances by
 * 4 per PIXEL row ($BAEF..$BAF2), while the initial pointer is computed in
 * 32-byte TILE rows ($BA0C, "The multiplier 32 is MASK_BUFFER_ROWBYTES").
 * Both are consistent -- a tile row is 8 pixel rows of 4 bytes.
 */

import masksJson from '../../data/masks.json';
import { tilesData } from '../data/load.js';
import { decodeBase64 } from '../data/load.js';

import { MASK_BUFFER_SIZE, MASK_BUFFER_WIDTH } from './sprites.js';

/** MASK_BUFFER_ROWBYTES ($BA0C): bytes per TILE row, i.e. 8 pixel rows of 4. */
export const MASK_BUFFER_ROWBYTES = 32;

interface Bounds {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

interface MaskRecord {
  addr: string;
  index: number;
  bounds: Bounds;
  pos: number[];
}

interface MaskShape {
  index: number;
  addr: string;
  kind: string;
  width: number;
  height: number;
  tiles: number[];
}

const masks = masksJson as unknown as {
  masks: MaskShape[];
  exteriorMaskData: MaskRecord[];
  interiorMaskDataSource: MaskRecord[];
};

export const exteriorMaskData: readonly MaskRecord[] = masks.exteriorMaskData;
export const interiorMaskData: readonly MaskRecord[] = masks.interiorMaskDataSource;
export const maskShapes: readonly MaskShape[] = masks.masks;

let maskTileBytes: Uint8Array | undefined;
function maskTiles(): Uint8Array {
  return (maskTileBytes ??= decodeBase64(tilesData.mask.data));
}

/** The character's projected position, as setup_vischar_plotting leaves it. */
export interface MaskSubject {
  /** state.iso_pos.x ($81B5): vischar.iso_pos.x / 8. */
  readonly isoX: number;
  /** state.iso_pos.y ($81B6): vischar.iso_pos.y / 8. */
  readonly isoY: number;
  /** tinypos_stash ($81B2..$81B4). */
  readonly tinyX: number;
  readonly tinyY: number;
  readonly tinyHeight: number;
}

/**
 * Should this mask affect this character?
 *
 * Two independent rejections, per the routine's own commentary: masks whose
 * bounding box does not overlap the character on screen, and masks the
 * character is standing IN FRONT of in world space.
 *
 * The comparisons are deliberately asymmetric -- x rejects on equality
 * ($B963 JP Z) where y does not, and height is decremented first but only when
 * non-zero ($B975..$B978). Tidying either into a uniform test changes which
 * masks apply.
 */
export function maskApplies(mask: MaskRecord, s: MaskSubject): boolean {
  const b = mask.bounds;

  // X overlap, using iso_pos_x - 1 ($B93C).
  const x = (s.isoX - 1) & 0xff;
  if (x >= b.x1) return false; // $B940
  if (x + 4 < b.x0) return false; // $B947

  // Y overlap, using iso_pos_y - 1 and a span of 5 ($B94E, $B956).
  const y = (s.isoY - 1) & 0xff;
  if (y >= b.y1) return false; // $B952
  if (y + 5 < b.y0) return false; // $B959

  // In front of the mask? Then it must not occlude.
  const [px = 0, py = 0, ph = 0] = mask.pos;
  if (s.tinyX <= px) return false; // $B962: rejects on equal too
  if (s.tinyY < py) return false; // $B96D: does not
  const h = s.tinyHeight !== 0 ? s.tinyHeight - 1 : 0; // $B975..$B978
  if (h >= ph) return false; // $B979

  return true;
}

interface Clip {
  readonly skip: number;
  readonly run: number;
  readonly bufSkip: number;
}

/**
 * One axis of the clip, shared by the x ($B984) and y ($B9B6) halves.
 *
 * @param iso   iso_pos on this axis
 * @param lo    mask.bounds low on this axis
 * @param hi    mask.bounds high on this axis
 * @param limit 4 for x (buffer is 4 bytes wide), 5 for y (5 tile rows)
 */
function clipAxis(iso: number, lo: number, hi: number, limit: number): Clip {
  if (iso >= lo) {
    // The mask starts beyond the buffer's edge: skip into it.
    const skip = iso - lo;
    let run = hi - iso;
    if (run >= limit - 1) run = limit - 1;
    run += 1;
    return { skip, run, bufSkip: 0 };
  }
  // The mask starts inside the buffer: no skip, but offset where it lands.
  const remaining = limit - (lo - iso);
  const total = hi - lo + 1;
  return { skip: 0, run: Math.min(total, remaining), bufSkip: lo - iso };
}

/**
 * Fill the mask buffer for one character.
 *
 * @param buffer 160 bytes; overwritten
 * @param subject the character's projected position
 * @param records exterior_mask_data outdoors, interior_mask_data indoors
 */
export function renderMaskBuffer(
  buffer: Uint8Array,
  subject: MaskSubject,
  records: readonly MaskRecord[] = exteriorMaskData,
): void {
  // $B916..$B921: a rolling fill setting every byte to $FF -- nothing occludes
  // until a mask says otherwise.
  buffer.fill(0xff);

  const tiles = maskTiles();

  for (const record of records) {
    if (!maskApplies(record, subject)) continue;

    const b = record.bounds;
    const cx = clipAxis(subject.isoX, b.x0, b.x1, 4);
    const cy = clipAxis(subject.isoY, b.y0, b.y1, 5);

    const shape = maskShapes[record.index];
    if (!shape) continue;

    // $BA0C: the initial pointer is in 32-byte tile rows.
    const base = cy.bufSkip * MASK_BUFFER_ROWBYTES + cx.bufSkip;

    for (let row = 0; row < cy.run; row++) {
      const srcRow = cy.skip + row;
      if (srcRow >= shape.height) break;

      for (let col = 0; col < cx.run; col++) {
        const srcCol = cx.skip + col;
        if (srcCol >= shape.width) break;

        const tile = shape.tiles[srcRow * shape.width + srcCol] ?? 0;
        if (tile === 0) continue; // $BA7E: tile 0 is blank, skip the call

        // mask_against_tile ($BADC): AND eight rows in, four bytes apart.
        const bufIndex = base + row * MASK_BUFFER_ROWBYTES + col;
        const tileBase = tile * 8;
        for (let r = 0; r < 8; r++) {
          const dst = bufIndex + r * MASK_BUFFER_WIDTH;
          if (dst < 0 || dst >= MASK_BUFFER_SIZE) continue;
          buffer[dst] = buffer[dst]! & (tiles[tileBase + r] ?? 0xff);
        }
      }
    }
  }
}

/**
 * The number of exterior mask records the routine actually iterates.
 *
 * $B935 sets 59, but exterior_mask_data holds only 58 -- flagged inline in the
 * disassembly as a bug and listed as a bfix in the header. The 59th iteration
 * reads past the end of the table. We use 58: §9 says to reproduce visible
 * quirks but not out-of-bounds reads, and the extra record's contents are
 * whatever happens to follow in memory, which is not meaningfully reproducible
 * outside a flat 64K image.
 */
export const EXTERIOR_MASK_COUNT = 58;
export const EXTERIOR_MASK_COUNT_AS_CODED = 59;

/**
 * The interior mask records that apply to one room.
 *
 * Indoors, render_mask_buffer iterates `interior_mask_data` (`g$81DA`) -- RAM
 * state that setup_room fills from the roomdef's own mask list, which is a list
 * of indices into interior_mask_data_source (`b$EA7C`). So the masks in play
 * are per-room, not the whole table.
 */
export function interiorMasksForRoom(maskIndices: readonly number[]): MaskRecord[] {
  const out: MaskRecord[] = [];
  for (const i of maskIndices) {
    const rec = interiorMaskData[i];
    if (rec) out.push(rec);
  }
  return out;
}
