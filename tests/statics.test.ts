import { describe, expect, it } from 'vitest';

import {
  STATIC_TILE_COUNT,
  STATIC_TILE_STRIDE,
  menuStrings,
  plotStaticTiles,
  plotStatics,
  plotStaticsAndMenuText,
  statics,
} from '../src/render/statics.js';
import {
  ATTRIBUTE_FILE_BASE,
  DISPLAY_FILE_BASE,
  SpectrumScreen,
  screenAddress,
} from '../src/spectrum/display.js';
import { tilesData, decodeBase64 } from '../src/data/load.js';
import { WINDOW_ORIGIN_COL, WINDOW_ORIGIN_PIXEL_ROW, BLIT_BYTES, VISIBLE_PIXEL_ROWS } from '../src/render/window.js';

describe('static_graphic_defs ($F076)', () => {
  it('holds the eighteen definitions $F1E0 iterates', () => {
    expect(statics).toHaveLength(18); // $F1E3 LD B,$12
  });

  it('indexes only tiles that exist', () => {
    // The stride bug put 84 tiles where there are 79, so an index near the top
    // of the range used to resolve to nonsense rather than failing. This is
    // the assertion that would have caught it.
    expect(STATIC_TILE_STRIDE).toBe(9);
    for (const s of statics) {
      for (const t of s.tiles) {
        expect(t, `${s.labels.join('/')} tile ${t}`).toBeLessThan(STATIC_TILE_COUNT);
      }
    }
  });

  it('reaches four tiles past static_tiles own extent, into the RAM block', () => {
    // statics_medals_row1 uses tile $4E = 78, and the block comment says the
    // table is "75 tiles". Tiles 75..78 sit in the variables that follow at
    // $81A4 -- saved_pos, bitmap_pointer, iso_pos, hero_map_position,
    // map_position -- and they are real 8x8 art with sensible attributes, not
    // noise. The medals are plotted once by main ($F163) before any of those
    // is live, and never redrawn.
    //
    // Asserted as the overlap it is, so that "count === documentedCount" can
    // never be quietly restored.
    expect(STATIC_TILE_COUNT).toBe(79);
    expect(tilesData.static.documentedCount).toBe(75);
    const overlapping = statics.flatMap((s) => s.tiles.filter((t) => t >= 75));
    expect([...new Set(overlapping)].sort((a, b) => a - b)).toEqual([75, 76, 77, 78]);
  });

  it('is exactly the flagpole, the window frame, the medals and the bell', () => {
    // Named from the labels rather than counted, because "18 of something" is
    // the sort of assertion that stays true while the set silently changes.
    const names = statics.map((s) => s.labels[s.labels.length - 1]);
    expect(names).toEqual([
      'statics_flagpole',
      'statics_game_window_left_border',
      'statics_game_window_right_border',
      'statics_game_window_top_border',
      'statics_game_window_bottom',
      'statics_flagpole_grass',
      'statics_medals_row0',
      'statics_medals_row1',
      'statics_medals_row2',
      'statics_medals_row3',
      'statics_medals_row4',
      'statics_bell_row0',
      'statics_bell_row1',
      'statics_bell_row2',
      'statics_corner_tl',
      'statics_corner_tr',
      'statics_corner_bl',
      'statics_corner_br',
    ]);
  });
});

describe('plot_static_tiles ($F20B)', () => {
  const tiles = decodeBase64(tilesData.static.data);

  it('writes eight pixel rows and the NINTH byte as the attribute', () => {
    const screen = new SpectrumScreen();
    const addr = screenAddress(4, 40); // an arbitrary character-row start
    plotStaticTiles(screen, addr, false, [3]);

    for (let r = 0; r < 8; r++) {
      expect(screen.display[addr + r * 0x100 - DISPLAY_FILE_BASE]).toBe(
        tiles[3 * STATIC_TILE_STRIDE + r],
      );
    }
    // $F23E: "the attribute byte which follows the tile data". Reading eight
    // bytes and leaving the attribute alone is the failure this catches.
    const last = addr + 7 * 0x100;
    const bank = ((last >> 8) & 0xff) < 0x48 ? 0x58 : ((last >> 8) & 0xff) < 0x50 ? 0x59 : 0x5a;
    const attr = ((bank << 8) | (last & 0xff)) - ATTRIBUTE_FILE_BASE;
    expect(screen.attributes[attr]).toBe(tiles[3 * STATIC_TILE_STRIDE + 8]);
  });

  it('steps one column right between horizontal tiles ($F247)', () => {
    const screen = new SpectrumScreen();
    const addr = screenAddress(4, 40);
    plotStaticTiles(screen, addr, false, [3, 4]);
    expect(screen.display[addr + 1 - DISPLAY_FILE_BASE]).toBe(tiles[4 * STATIC_TILE_STRIDE]);
  });

  it('steps one character row down between vertical tiles ($F24E)', () => {
    const screen = new SpectrumScreen();
    const addr = screenAddress(4, 40);
    plotStaticTiles(screen, addr, true, [3, 4]);
    // next_scanline_down from the LAST row of the first tile is the first row
    // of the next character row -- 8 pixel rows below where it started.
    expect(screen.display[screenAddress(4, 48) - DISPLAY_FILE_BASE]).toBe(
      tiles[4 * STATIC_TILE_STRIDE],
    );
  });

  it('draws vertical runs down a single column, not across', () => {
    // The flagpole is 20 tiles tall in one column. If the direction flag were
    // read the wrong way round it would come out as a 20-tile horizontal bar,
    // which still "draws something" and still passes a pixel-count check.
    const screen = new SpectrumScreen();
    const flagpole = statics[0]!;
    expect(flagpole.vertical).toBe(true);
    plotStaticTiles(screen, parseInt(flagpole.screenAddress.slice(1), 16), true, flagpole.tiles);

    const columns = new Set<number>();
    for (let i = 0; i < screen.display.length; i++) {
      if (screen.display[i] !== 0) columns.add(i & 0x1f);
    }
    expect(columns.size).toBe(1);
  });
});

describe('plot_statics_and_menu_text ($F1E0)', () => {
  function windowBytes(): Set<number> {
    const inWindow = new Set<number>();
    for (let y = 0; y < VISIBLE_PIXEL_ROWS; y++) {
      const addr = screenAddress(WINDOW_ORIGIN_COL, WINDOW_ORIGIN_PIXEL_ROW + y);
      for (let c = 0; c < BLIT_BYTES; c++) inWindow.add(addr + c - DISPLAY_FILE_BASE);
    }
    return inWindow;
  }

  it('leaves the game window untouched -- the FURNITURE does', () => {
    // The frame goes AROUND the window, which is blitted over the middle of it
    // every frame. A static that strayed inside would be repainted away each
    // frame and would read as flicker rather than as a bug, so it is worth
    // pinning that none does.
    const screen = new SpectrumScreen();
    plotStatics(screen);
    for (const i of windowBytes()) expect(screen.display[i]).toBe(0);
  });

  it('but the MENU TEXT is drawn inside it, which is correct', () => {
    // At menu time there is no game window -- main ($F163) draws the frame and
    // then writes the menu into the space the window will later occupy, and
    // the first blit covers it. Measured rather than assumed: separating the
    // two was what showed the earlier "statics overlap the window" reading was
    // the menu, not the furniture.
    const screen = new SpectrumScreen();
    plotStaticsAndMenuText(screen);
    const window = windowBytes();
    let inside = 0;
    for (const i of window) if (screen.display[i] !== 0) inside++;
    expect(inside).toBeGreaterThan(0);
  });

  it('plots the menu text, which is the first eight key_choice strings', () => {
    expect(menuStrings.map((s) => s.text)).toEqual([
      'C0NTR0LS',
      '0 SELECT',
      '1 KEYB0ARD',
      '2 KEMPST0N',
      '3 SINCLAIR',
      '4 PR0TEK',
      'BREAK 0R CAPS AND SPACE',
      'F0R NEW GAME',
    ]);
  });

  it('draws something on well over half the screen rows', () => {
    // A weak assertion deliberately: the point is that all 18 definitions
    // actually reached the display file, not what they look like. The frame
    // spans the full height of the screen, so a definition silently skipped
    // shows up as a gap.
    const screen = new SpectrumScreen();
    plotStaticsAndMenuText(screen);
    const rows = new Set<number>();
    for (let y = 0; y < 192; y++) {
      for (let col = 0; col < 32; col++) {
        if (screen.display[screenAddress(col, y) - DISPLAY_FILE_BASE] !== 0) {
          rows.add(y);
          break;
        }
      }
    }
    expect(rows.size).toBeGreaterThan(96);
  });
});
