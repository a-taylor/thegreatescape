import { describe, expect, it } from 'vitest';

import {
  advanceZoombox,
  createZoombox,
  drawZoombox,
  zoomboxDrawBorder,
  zoomboxFill,
  ZOOMBOX_INITIAL_X,
  ZOOMBOX_INITIAL_Y,
} from '../src/render/zoombox.js';
import {
  BLIT_BYTES,
  GameWindowBuffers,
  VISIBLE_PIXEL_ROWS,
  WINDOW_ORIGIN_COL,
  WINDOW_ORIGIN_PIXEL_ROW,
  WINDOW_STRIDE,
} from '../src/render/window.js';
import { SpectrumScreen, DISPLAY_FILE_BASE, screenAddress } from '../src/spectrum/display.js';

/** Run the $ABBC loop to completion, collecting every state it draws. */
function runToCompletion(): ReturnType<typeof createZoombox>[] {
  const z = createZoombox();
  const frames: ReturnType<typeof createZoombox>[] = [];
  while (advanceZoombox(z)) frames.push({ ...z });
  return frames;
}

describe('zoombox geometry ($ABA0)', () => {
  it('starts as a zero-size point at (12, 8)', () => {
    const z = createZoombox();
    expect([z.x, z.width, z.y, z.height]).toEqual([ZOOMBOX_INITIAL_X, 0, ZOOMBOX_INITIAL_Y, 0]);
    expect(z.done).toBe(false);
  });

  it('takes eleven steps and ends at x=1 w=21 y=1 h=14', () => {
    const frames = runToCompletion();
    expect(frames).toHaveLength(11);
    const last = frames[frames.length - 1]!;
    expect([last.x, last.width, last.y, last.height]).toEqual([1, 21, 1, 14]);
    // $ABF3: the terminator is width + height >= 35, not "x reached 1".
    expect(last.width + last.height).toBeGreaterThanOrEqual(0x23);
  });

  it('clamps width using the POST-increment value, per $ABCB', () => {
    // The register copy in A is decremented alongside x ($ABC6) and then has
    // the already-incremented width added to it ($ABCB). Testing the OLD width
    // instead lets the box reach x + width == 22, one cell too wide.
    for (const f of runToCompletion()) {
      expect(f.x + f.width).toBeLessThanOrEqual(0x16);
      expect(f.y + f.height).toBeLessThanOrEqual(0x0f);
    }
  });

  it('grows monotonically and never moves an edge backwards', () => {
    const frames = runToCompletion();
    for (let i = 1; i < frames.length; i++) {
      const prev = frames[i - 1]!;
      const cur = frames[i]!;
      expect(cur.x).toBeLessThanOrEqual(prev.x);
      expect(cur.y).toBeLessThanOrEqual(prev.y);
      expect(cur.x + cur.width).toBeGreaterThanOrEqual(prev.x + prev.width);
      expect(cur.y + cur.height).toBeGreaterThanOrEqual(prev.y + prev.height);
    }
  });

  it('refuses to advance once done', () => {
    const z = createZoombox();
    while (advanceZoombox(z));
    const before = { ...z };
    expect(advanceZoombox(z)).toBe(false);
    expect({ ...z }).toEqual(before);
  });
});

describe('zoombox_fill ($ABF9)', () => {
  it('reads window_buf + 1 + y * 192 + x, the same off-by-one as the blit', () => {
    const buffers = new GameWindowBuffers();
    // Make every buffer byte identify its own offset, modulo 251 so the
    // pattern does not repeat within a row or a tile row.
    for (let i = 0; i < buffers.pixels.length; i++) buffers.pixels[i] = i % 251;

    const screen = new SpectrumScreen();
    const z = { x: 3, width: 2, y: 5, height: 1, done: false };
    zoomboxFill(screen, buffers, z);

    // $AC10 points at $F291 -- window buffer + ONE. Reading from $F290
    // instead shifts the whole reveal one byte left.
    const src = 1 + 5 * WINDOW_STRIDE * 8 + 3;
    for (let line = 0; line < 8; line++) {
      const addr = screenAddress(WINDOW_ORIGIN_COL + 3, WINDOW_ORIGIN_PIXEL_ROW + 5 * 8 + line);
      expect(screen.display[addr - DISPLAY_FILE_BASE]).toBe((src + line * WINDOW_STRIDE) % 251);
      expect(screen.display[addr + 1 - DISPLAY_FILE_BASE]).toBe(
        (src + 1 + line * WINDOW_STRIDE) % 251,
      );
    }
  });

  it('writes exactly width x height cells and nothing beyond them', () => {
    const buffers = new GameWindowBuffers();
    buffers.pixels.fill(0xff);
    const screen = new SpectrumScreen();
    const z = { x: 4, width: 3, y: 2, height: 2, done: false };
    zoomboxFill(screen, buffers, z);

    let written = 0;
    for (const byte of screen.display) if (byte !== 0) written++;
    expect(written).toBe(3 * 2 * 8);
  });

  it('crosses a screen third correctly', () => {
    // Rows 2..17 of the window straddle the $48xx boundary at char row 8, so
    // a fill tall enough to cross it proves the $0720 carry at $AC67.
    const buffers = new GameWindowBuffers();
    buffers.pixels.fill(0xff);
    const screen = new SpectrumScreen();
    zoomboxFill(screen, buffers, { x: 1, width: 21, y: 1, height: 14, done: true });

    for (let row = 0; row < 14; row++) {
      for (let col = 0; col < 21; col++) {
        const addr = screenAddress(
          WINDOW_ORIGIN_COL + 1 + col,
          WINDOW_ORIGIN_PIXEL_ROW + (1 + row) * 8,
        );
        expect(screen.display[addr - DISPLAY_FILE_BASE]).toBe(0xff);
      }
    }
  });
});

describe('zoombox_draw_border ($AC6F)', () => {
  it('rings the fill area one cell out, and attributes every tile it draws', () => {
    const screen = new SpectrumScreen();
    const z = { x: 4, width: 3, y: 3, height: 2, done: false };
    zoomboxDrawBorder(screen, z, 0x41);

    // The ring is (width + 2) x (height + 2) minus the (width x height) hole.
    let attributed = 0;
    for (const attr of screen.attributes) if (attr === 0x41) attributed++;
    expect(attributed).toBe((3 + 2) * (2 + 2) - 3 * 2);
  });

  it('leaves the fill area untouched', () => {
    const screen = new SpectrumScreen();
    const z = { x: 4, width: 3, y: 3, height: 2, done: false };
    zoomboxDrawBorder(screen, z, 0x41);

    for (let row = 0; row < 2; row++) {
      for (let col = 0; col < 3; col++) {
        const addr = screenAddress(
          WINDOW_ORIGIN_COL + 4 + col,
          WINDOW_ORIGIN_PIXEL_ROW + (3 + row) * 8,
        );
        expect(screen.display[addr - DISPLAY_FILE_BASE]).toBe(0);
      }
    }
  });
});

describe('the finished box and the blit agree', () => {
  it('covers exactly the cells plot_game_window writes, and no others', () => {
    // The point of the whole routine: the reveal must land on the window, not
    // beside it. Derived independently at each end -- the box from $ABA0's own
    // arithmetic, the window from game_window_start_addresses.
    const buffers = new GameWindowBuffers();
    buffers.pixels.fill(0xff);

    const zoomed = new SpectrumScreen();
    const z = createZoombox();
    while (advanceZoombox(z));
    drawZoombox(zoomed, buffers, z, 0x07);

    const blitted = new Set<number>();
    for (let y = 0; y < VISIBLE_PIXEL_ROWS; y++) {
      const addr = screenAddress(WINDOW_ORIGIN_COL, WINDOW_ORIGIN_PIXEL_ROW + y);
      for (let c = 0; c < BLIT_BYTES; c++) blitted.add(addr + c - DISPLAY_FILE_BASE);
    }

    const touched = new Set<number>();
    for (let i = 0; i < zoomed.display.length; i++) if (zoomed.display[i] !== 0) touched.add(i);

    // Every byte the box paints is a byte the window owns.
    for (const i of touched) expect(blitted.has(i)).toBe(true);
    // And the box's own footprint is the full 23 x 16 cells: the border tiles
    // are mostly blank, so compare cells rather than non-zero bytes.
    expect(z.width + 2).toBe(BLIT_BYTES);
    expect((z.height + 2) * 8).toBe(VISIBLE_PIXEL_ROWS);
  });
});
