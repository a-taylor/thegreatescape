/**
 * The map window: get_supertiles, plot_all_tiles and the shunt_map_* family.
 *
 * The load-bearing test here is agreement with fillExterior(), which P1 already
 * verified pixel-for-pixel against map-0-0.png. If the map_buf path produces
 * the same tile buffer, then it inherits that verification -- so this checks
 * the faithful mechanism against a known-good result rather than against
 * itself.
 */

import { describe, expect, it } from 'vitest';

import { mapData } from '../src/data/load.js';
import {
  ExteriorView,
  MAP_BUF_COLS,
  MAP_BUF_ROWS,
  MAP_ROW_BIAS,
  getSupertiles,
  tileOriginFor,
} from '../src/render/exterior.js';
import { fillExterior } from '../src/render/scene.js';
import { GameWindowBuffers } from '../src/render/window.js';

function viaMapBuf(x: number, y: number): GameWindowBuffers {
  const b = new GameWindowBuffers();
  const view = new ExteriorView(x, y);
  view.render(b);
  return b;
}

function viaAbsolute(x: number, y: number): GameWindowBuffers {
  const b = new GameWindowBuffers();
  fillExterior(b, x, y);
  return b;
}

describe('get_supertiles (c$A7C9)', () => {
  it('reads a 7x5 block starting one supertile row above the position', () => {
    // $A7DF points at map_tiles - 54, so row 0 of map_buf is (y >> 2) - 1.
    const pos = { x: 40, y: 40 };
    const buf = getSupertiles(pos);
    expect(buf.length).toBe(MAP_BUF_COLS * MAP_BUF_ROWS);

    const { width, supertileIndices } = mapData;
    const col = pos.x >> 2;
    const row = (pos.y >> 2) - 1;
    for (let r = 0; r < MAP_BUF_ROWS; r++) {
      for (let c = 0; c < MAP_BUF_COLS; c++) {
        expect(buf[r * MAP_BUF_COLS + c]).toBe(
          supertileIndices[(row + r) * width + (col + c)],
        );
      }
    }
  });

  it('clamps rather than reading outside the map', () => {
    expect(() => getSupertiles({ x: 0, y: 0 })).not.toThrow();
    expect(() => getSupertiles({ x: 210, y: 130 })).not.toThrow();
  });
});

describe('plot_all_tiles (c$A8A2)', () => {
  // Positions covering every combination of sub-supertile x and y offset, plus
  // a spread across the map so all three tile banks are exercised.
  const positions: Array<[number, number]> = [
    [8, 8],
    [9, 9],
    [10, 10],
    [11, 11],
    [12, 13],
    [40, 44],
    [41, 46],
    [100, 64],
    [120, 94],
    [150, 100],
  ];

  it.each(positions)(
    'at map position (%i, %i) agrees with the pixel-verified renderer',
    (x, y) => {
      const viaBuf = viaMapBuf(x, y);
      // tile_buf row 0 shows absolute tile row y - 4 (MAP_ROW_BIAS).
      const viaAbs = viaAbsolute(x, y - MAP_ROW_BIAS);
      expect(Array.from(viaBuf.tiles)).toEqual(Array.from(viaAbs.tiles));
      expect(Array.from(viaBuf.banks)).toEqual(Array.from(viaAbs.banks));
    },
  );

  it('exposes the four-row bias explicitly', () => {
    expect(MAP_ROW_BIAS).toBe(4);
    expect(tileOriginFor({ x: 17, y: 40 })).toEqual({ x: 17, y: 36 });
  });

  it('would disagree if the bias were dropped', () => {
    // Guards against someone "simplifying" the bias away: without it the two
    // paths show different parts of the map.
    const viaBuf = viaMapBuf(40, 44);
    const noBias = viaAbsolute(40, 44);
    expect(Array.from(viaBuf.tiles)).not.toEqual(Array.from(noBias.tiles));
  });
});

describe('shunt_map_* (c$A9E4 onward)', () => {
  it('shunting left increases the map x position', () => {
    // The names describe the map's motion, not the hero's.
    const view = new ExteriorView(40, 40);
    view.shuntLeft();
    expect(view.position).toEqual({ x: 41, y: 40 });
    view.shuntRight();
    expect(view.position).toEqual({ x: 40, y: 40 });
  });

  it('shunting up INCREASES the map y position', () => {
    // $AA4E is an INC and $AA6F a DEC -- the opposite of what the names imply,
    // because they describe the map's motion, not the viewport's. Asserting the
    // intuitive sign here hid a real bug: the world scrolled away from the hero
    // vertically, which read as jitter while walking.
    const view = new ExteriorView(40, 40);
    view.shuntUp();
    expect(view.position).toEqual({ x: 40, y: 41 });
    view.shuntDown();
    expect(view.position).toEqual({ x: 40, y: 40 });
  });

  it('the diagonals move both axes at once', () => {
    // shunt_map_up_right: x - 1, y + 1. shunt_map_down_left ($AA8D): INC L,
    // DEC H -- x + 1, y - 1.
    const view = new ExteriorView(40, 40);
    view.shuntUpRight();
    expect(view.position).toEqual({ x: 39, y: 41 });
    view.shuntDownLeft();
    expect(view.position).toEqual({ x: 40, y: 40 });
  });

  it('a shunt matches rendering the destination from scratch', () => {
    // Whatever the incremental path does, the result must equal a clean render
    // -- this is what stops scroll artefacts accumulating.
    const walked = new ExteriorView(40, 40);
    for (let i = 0; i < 5; i++) walked.shuntLeft();
    for (let i = 0; i < 3; i++) walked.shuntDown();

    const direct = new ExteriorView(45, 37);

    const a = new GameWindowBuffers();
    const b = new GameWindowBuffers();
    walked.render(a);
    direct.render(b);

    expect(walked.position).toEqual(direct.position);
    expect(Array.from(a.tiles)).toEqual(Array.from(b.tiles));
    expect(Array.from(a.banks)).toEqual(Array.from(b.banks));
  });

  it('wraps the position bytes, as INC/DEC (HL) does', () => {
    // map_position is two bytes; the routines INC/DEC them without bounds
    // checks, so wrapping is the hardware behaviour.
    const view = new ExteriorView(0, 0);
    view.shuntRight();
    expect(view.position.x).toBe(0xff);
  });
});
