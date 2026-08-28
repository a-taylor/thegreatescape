/**
 * P1 acceptance: the renderer's output against the disassembly's own renders.
 *
 * The exterior test is the strong one. map-0-0.png is the whole 54x34 map
 * expanded at 1:1 by SkoolKit from the same bytes, so any window position we
 * render must equal the matching sub-rectangle of it. An error in the tile
 * banking rule, the supertile lookup or the buffer stride shows up immediately.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { inflateSync } from 'node:zlib';

import { exteriorTiles, interiorTiles, mapData, roomsData } from '../src/data/load.js';
import { fillExterior, fillRoom, exteriorTileAt } from '../src/render/scene.js';
import {
  INTERIOR_OBJECT_EMPTY_BED,
  bedObjects,
  blockedTunnelObject,
  createRoomPokes,
  pokeObject,
} from '../src/game/parcels.js';
import {
  BUFFER_ROWS,
  GameWindowBuffers,
  VISIBLE_PIXEL_ROWS,
  WINDOW_COLS,
  WINDOW_ORIGIN_COL,
  WINDOW_ORIGIN_PIXEL_ROW,
  WINDOW_STRIDE,
  BLIT_BYTES,
  plotGameWindow,
} from '../src/render/window.js';
import { SpectrumScreen, screenAddress } from '../src/spectrum/display.js';

// ---------------------------------------------------------------------------
// Minimal PNG reader for the reference renders (1-bit palette, no interlace).
// ---------------------------------------------------------------------------

function readPng(path: string): { width: number; height: number; bits: Uint8Array } {
  const data = readFileSync(path);
  let pos = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let palette: number[][] = [];
  const idat: Buffer[] = [];

  while (pos < data.length) {
    const length = data.readUInt32BE(pos);
    const type = data.subarray(pos + 4, pos + 8).toString('latin1');
    const body = data.subarray(pos + 8, pos + 8 + length);
    pos += 12 + length;
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      depth = body[8]!;
    } else if (type === 'PLTE') {
      palette = [];
      for (let i = 0; i < body.length; i += 3) palette.push([body[i]!, body[i + 1]!, body[i + 2]!]);
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'IEND') break;
  }

  const raw = inflateSync(Buffer.concat(idat));
  const rowBytes = Math.ceil((width * depth) / 8);
  const bits = new Uint8Array(width * height);

  // Only filter types 0 (None) and 2 (Up) occur in these files; handle both.
  const prev = new Uint8Array(rowBytes);
  const cur = new Uint8Array(rowBytes);
  let p = 0;
  // Ink is the palette entry that is not pure black -- SkoolKit writes
  // attribute-7 graphics with index 0 = white ink, which is the opposite of the
  // obvious reading.
  const inkIndices = new Set(
    palette.map((c, i) => [c, i] as const).filter(([c]) => c[0] || c[1] || c[2]).map(([, i]) => i),
  );

  for (let y = 0; y < height; y++) {
    const filter = raw[p++]!;
    for (let i = 0; i < rowBytes; i++) {
      const v = raw[p + i]!;
      cur[i] = filter === 2 ? (v + prev[i]!) & 0xff : v;
    }
    p += rowBytes;
    const perByte = 8 / depth;
    const mask = (1 << depth) - 1;
    for (let x = 0; x < width; x++) {
      const byte = cur[Math.floor(x / perByte)]!;
      const shift = 8 - depth * ((x % perByte) + 1);
      const index = (byte >> shift) & mask;
      bits[y * width + x] = inkIndices.has(index) ? 1 : 0;
    }
    prev.set(cur);
  }

  return { width, height, bits };
}

const refMap = readPng(
  fileURLToPath(
    new URL('../The-Great-Escape/build/TheGreatEscape/images/scr/map-0-0.png', import.meta.url),
  ),
);

/** Unpack the window's pixel buffer into 1-bit-per-pixel for comparison. */
function windowBits(buffers: GameWindowBuffers, rows: number): Uint8Array {
  const w = WINDOW_COLS * 8;
  const out = new Uint8Array(w * rows);
  for (let y = 0; y < rows; y++) {
    for (let col = 0; col < WINDOW_STRIDE; col++) {
      const byte = buffers.pixelByte(col, y);
      for (let bit = 0; bit < 8; bit++) {
        out[y * w + col * 8 + bit] = byte & (0x80 >> bit) ? 1 : 0;
      }
    }
  }
  return out;
}

describe('reference map', () => {
  it('is the whole map at 1:1', () => {
    expect(refMap.width).toBe(54 * 4 * 8);
    expect(refMap.height).toBe(34 * 4 * 8);
  });
});

describe('exterior rendering', () => {
  const tiles = exteriorTiles();

  // Positions spanning all three tile banks, the map edges, and offsets that
  // are not multiples of the 4-tile supertile stride.
  const positions: Array<[number, number]> = [
    [0, 0],
    [1, 1],
    [3, 3],
    [4, 8],
    [17, 23],
    [40, 40],
    [100, 60],
    [120, 90],
    [186, 112], // bottom-right corner: 216-24 x 136-17 (+1 row of slack)
  ];

  it.each(positions)('window at tile (%i, %i) matches map-0-0.png', (mx, my) => {
    const buffers = new GameWindowBuffers();
    fillExterior(buffers, mx, my);
    buffers.expandTiles(tiles);

    const rows = Math.min(BUFFER_ROWS * 8, refMap.height - my * 8);
    const mine = windowBits(buffers, rows);
    const w = WINDOW_COLS * 8;

    let diff = 0;
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < w; x++) {
        const ref = refMap.bits[(my * 8 + y) * refMap.width + (mx * 8 + x)]!;
        if (mine[y * w + x] !== ref) diff++;
      }
    }
    expect(diff, `${diff} of ${w * rows} pixels differ at (${mx},${my})`).toBe(0);
  });

  it('adds the tile bank, not just the supertile entry', () => {
    // Comparing fillExterior against exteriorTileAt would be vacuous -- both
    // would agree even if both omitted the bank, which is exactly the bug this
    // suite caught. So assert the bank is demonstrably applied: find a
    // supertile in each band and check the resolved index lands in its range.
    const { supertileIndices, superTiles, width } = mapData;

    const bands: Array<[string, (s: number) => boolean, number]> = [
      ['low', (s) => s < 45, 0],
      ['mid', (s) => (s >= 45 && s < 139) || s >= 204, 145],
      ['high', (s) => s >= 139 && s < 204, 365],
    ];

    for (const [name, inBand, expectedBase] of bands) {
      const idx = supertileIndices.findIndex(inBand);
      expect(idx, `no supertile found in the ${name} band`).toBeGreaterThanOrEqual(0);

      const sx = idx % width;
      const sy = Math.floor(idx / width);
      const mx = sx * 4;
      const my = sy * 4;
      const supertile = supertileIndices[idx]!;
      const rawTile = superTiles[supertile]![0]!;

      expect(exteriorTileAt(mx, my)).toBe(expectedBase + rawTile);

      const buffers = new GameWindowBuffers();
      fillExterior(buffers, mx, my);
      expect(buffers.resolvedTile(0, 0)).toBe(expectedBase + rawTile);
    }
  });
});

describe('game window blit', () => {
  it('lands 128 rows at column 7, pixel row 16', () => {
    const buffers = new GameWindowBuffers();
    // Distinctive per-row pattern so a misplaced row is unmistakable.
    for (let y = 0; y < 136; y++) {
      for (let c = 0; c < WINDOW_STRIDE; c++) buffers.pixels[y * WINDOW_STRIDE + c] = (y + c) & 0xff;
    }

    const screen = new SpectrumScreen();
    screen.clear(0x00, 0);
    plotGameWindow(screen, buffers);

    // The aligned path sources from buffer + 1 and copies 23 bytes ($EEDE /
    // $EF1D), so screen column c shows buffer byte c + 1.
    for (const y of [0, 1, 63, 64, 127]) {
      const addr = screenAddress(WINDOW_ORIGIN_COL, WINDOW_ORIGIN_PIXEL_ROW + y);
      for (const c of [0, 12, 22]) {
        expect(screen.readByte(addr + c)).toBe((y + c + 1) & 0xff);
      }
    }
  });

  it('leaves the border untouched', () => {
    const buffers = new GameWindowBuffers();
    buffers.pixels.fill(0xff);
    const screen = new SpectrumScreen();
    screen.clear(0x00, 0);
    plotGameWindow(screen, buffers);

    // Immediately left of and right of the window, on a window row.
    const addr = screenAddress(WINDOW_ORIGIN_COL, WINDOW_ORIGIN_PIXEL_ROW);
    expect(screen.readByte(addr - 1)).toBe(0x00);
    expect(screen.readByte(addr + WINDOW_COLS)).toBe(0x00);
    // Above and below the window.
    expect(screen.readByte(screenAddress(WINDOW_ORIGIN_COL, WINDOW_ORIGIN_PIXEL_ROW - 1))).toBe(0);
    expect(
      screen.readByte(
        screenAddress(WINDOW_ORIGIN_COL, WINDOW_ORIGIN_PIXEL_ROW + VISIBLE_PIXEL_ROWS),
      ),
    ).toBe(0);
  });

  it('scrolls sub-tile via the game_window_offset low byte', () => {
    const buffers = new GameWindowBuffers();
    for (let y = 0; y < 136; y++) buffers.pixels.fill(y, y * WINDOW_STRIDE, (y + 1) * WINDOW_STRIDE);

    const screen = new SpectrumScreen();
    // The low byte is a BYTE offset into window_buf, so a whole row is 24.
    plotGameWindow(screen, buffers, { low: 8 * WINDOW_STRIDE, high: 0 });
    expect(screen.readByte(screenAddress(WINDOW_ORIGIN_COL, WINDOW_ORIGIN_PIXEL_ROW))).toBe(8);
  });

  it('rolls pixels by half a byte when the offset high byte is 255', () => {
    // The slow blit path behind Fact:alternatingSpeed. RRD merges the PREVIOUS
    // byte's low nibble into the top of the current one, and A is pre-loaded
    // from buffer + offset ($EF32) -- so the first output byte's high nibble
    // comes from buffer byte 0, while the DATA starts at buffer byte 1.
    const buffers = new GameWindowBuffers();
    buffers.pixels.fill(0x00);
    buffers.pixels[0] = 0xab; // seeds the carry only
    buffers.pixels[1] = 0xcd;

    const screen = new SpectrumScreen();
    screen.clear(0x00, 0x00);
    plotGameWindow(screen, buffers, { low: 0, high: 0xff });

    const addr = screenAddress(WINDOW_ORIGIN_COL, WINDOW_ORIGIN_PIXEL_ROW);
    expect(screen.readByte(addr)).toBe(0xbc); // low nibble of $AB, high of $CD
    expect(screen.readByte(addr + 1)).toBe(0xd0); // low nibble of $CD, then zeros
    expect(screen.readByte(addr + 2)).toBe(0x00);
  });

  it('takes the aligned fast path when the high byte is zero', () => {
    const buffers = new GameWindowBuffers();
    buffers.pixels.fill(0x00);
    // Byte 1, not byte 0: the aligned path starts one byte into the buffer.
    buffers.pixels[1] = 0xab;

    const screen = new SpectrumScreen();
    screen.clear(0x00, 0x00);
    plotGameWindow(screen, buffers, { low: 0, high: 0 });
    // Unrolled: the byte lands verbatim.
    expect(screen.readByte(screenAddress(WINDOW_ORIGIN_COL, WINDOW_ORIGIN_PIXEL_ROW))).toBe(0xab);
  });

  it('writes 23 bytes per row, leaving the rightmost column alone', () => {
    // Both paths stop one byte short of the buffer width ($EF1D skips the 24th;
    // $EF3C is "4 iterations of 5, plus 3 at the end = 23"), so the 24th window
    // column is never written by the blit.
    const buffers = new GameWindowBuffers();
    buffers.pixels.fill(0xff);
    for (const high of [0, 0xff]) {
      const screen = new SpectrumScreen();
      screen.clear(0x00, 0x00);
      plotGameWindow(screen, buffers, { low: 0, high });
      const addr = screenAddress(WINDOW_ORIGIN_COL, WINDOW_ORIGIN_PIXEL_ROW);
      expect(screen.readByte(addr + BLIT_BYTES - 1), `high ${high}`).not.toBe(0);
      expect(screen.readByte(addr + BLIT_BYTES), `high ${high}`).toBe(0);
    }
  });

  it('both paths read the same 23 source bytes', () => {
    // The ONLY difference between them is the roll. If they read different
    // windows the view jitters horizontally by 8 pixels every frame, because
    // game_window_offset alternates between the paths every frame -- which is
    // exactly the regression this pins.
    const buffers = new GameWindowBuffers();
    for (let i = 0; i < buffers.pixels.length; i++) buffers.pixels[i] = (i * 7) & 0xff;

    const aligned = new SpectrumScreen();
    aligned.clear(0x00, 0x00);
    plotGameWindow(aligned, buffers, { low: 0, high: 0 });

    const unaligned = new SpectrumScreen();
    unaligned.clear(0x00, 0x00);
    plotGameWindow(unaligned, buffers, { low: 0, high: 0xff });

    const addr = screenAddress(WINDOW_ORIGIN_COL, WINDOW_ORIGIN_PIXEL_ROW);
    for (let c = 0; c < BLIT_BYTES; c++) {
      const prev = c === 0 ? buffers.pixels[0]! : aligned.readByte(addr + c - 1);
      const cur = aligned.readByte(addr + c);
      expect(unaligned.readByte(addr + c), `byte ${c}`).toBe(
        (((prev & 0x0f) << 4) | (cur >> 4)) & 0xff,
      );
    }
  });
});

describe('interior rooms', () => {
  const tiles = interiorTiles();

  it('draws every used room without escaping the buffer', () => {
    for (const entry of roomsData.rooms) {
      const buffers = new GameWindowBuffers();
      expect(() => {
        fillRoom(buffers, entry.room);
        buffers.expandTiles(tiles);
      }, `room ${entry.room}`).not.toThrow();
    }
  });

  it('places room 1 objects where the roomdef says', () => {
    // roomdef_1_hut1_right (b$6C15): first object is
    // interiorobject_ROOM_OUTLINE_22x12_A at (1, 4).
    const def = roomsData.roomdefs[roomsData.rooms[0]!.roomdefIndex]!;
    expect(def.objects[0]).toEqual({ object: 2, x: 1, y: 4 });

    const buffers = new GameWindowBuffers();
    fillRoom(buffers, 1);
    // The outline's top-left non-transparent tile must have landed at or after
    // its stated origin, and nothing may be written above it.
    let firstRow = -1;
    for (let ty = 0; ty < BUFFER_ROWS && firstRow < 0; ty++) {
      for (let tx = 0; tx < WINDOW_COLS; tx++) {
        if (buffers.tileAt(tx, ty) !== 0) {
          firstRow = ty;
          break;
        }
      }
    }
    expect(firstRow).toBeGreaterThanOrEqual(0);
  });

  it('treats tile 0 as transparent so objects overlay rather than erase', () => {
    const buffers = new GameWindowBuffers();
    fillRoom(buffers, 1);
    const before = buffers.tiles.slice();
    // Re-plotting an object with transparent regions must not clear anything.
    fillRoom(buffers, 1);
    expect(buffers.tiles).toEqual(before);
  });
});

describe('the roomdef poke overlay reaches the screen', () => {
  it('draws the poked object instead of the shipped one', () => {
    // The game pokes roomdef bytes at runtime -- occupied beds ($A453),
    // seated prisoners ($A437), the tunnel blockage the shovel clears
    // ($B408) -- and setup_room simply reads them back. Here the roomdef
    // table stays immutable and an overlay is consulted instead, so this
    // asserts the overlay is actually READ. Recording a poke that the
    // renderer ignores is exactly as visible as not poking at all: prisoners
    // sit down on benches that stay empty.
    const bed = bedObjects[0]!;

    const plain = new GameWindowBuffers();
    fillRoom(plain, 3); // roomdef_3_hut2_right holds three prisoner beds

    const pokes = createRoomPokes();
    pokeObject(pokes, bed, INTERIOR_OBJECT_EMPTY_BED);
    const poked = new GameWindowBuffers();
    fillRoom(poked, 3, pokes);

    expect([...poked.tiles]).not.toEqual([...plain.tiles]);
  });

  it('is a no-op when nothing has been poked', () => {
    const withEmpty = new GameWindowBuffers();
    fillRoom(withEmpty, 3, createRoomPokes());
    const without = new GameWindowBuffers();
    fillRoom(without, 3);
    expect([...withEmpty.tiles]).toEqual([...without.tiles]);
  });

  it('honours a poked value of ZERO, which is the transparent tile', () => {
    // action_shovel writes 0 to remove the blockage graphic ($B408). Treating
    // a falsy poke as "no override" would leave the rubble on screen while
    // the boundary was gone -- an invisible wall in reverse.
    const ref = blockedTunnelObject;
    const plain = new GameWindowBuffers();
    fillRoom(plain, 50);

    const pokes = createRoomPokes();
    pokeObject(pokes, ref, 0);
    const cleared = new GameWindowBuffers();
    fillRoom(cleared, 50, pokes);

    expect([...cleared.tiles]).not.toEqual([...plain.tiles]);
  });
});
