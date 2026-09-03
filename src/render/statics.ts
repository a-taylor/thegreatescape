/**
 * plot_statics_and_menu_text (c$F1E0): the screen furniture, and the menu.
 *
 * Everything outside the game window that is not the score, the flag or the
 * message line: the flagpole and its grass, the window's four borders and four
 * corners, five rows of medals and three of the bell. `main` ($F163) draws it
 * once at boot and never again -- like the panel, it is persistent screen
 * memory that simply stays there.
 *
 * The same routine then plots the first EIGHT `key_choice_screenlocstrings`
 * ($F1F9 LD B,$08) as the menu text. One table, two readers: `choose_keys`
 * uses the rest.
 *
 * A static tile is the one tile set in the game with a NINE byte stride --
 * eight pixel rows and a trailing attribute byte, which `plot_static_tiles`
 * writes to the cell ($F219 multiplies the index by nine; $F23E reads the
 * ninth). So these tiles carry their own colour, which is why the medals are
 * coloured on a screen whose attributes are otherwise a flat $07.
 */

import frontendJson from '../../data/frontend.json';
import { decodeBase64, tilesData } from '../data/load.js';
import {
  ATTRIBUTE_FILE_BASE,
  DISPLAY_FILE_BASE,
  SpectrumScreen,
  nextScanlineDown,
} from '../spectrum/display.js';
import { plotGlyphs } from '../ui/glyphs.js';

interface StaticEntry {
  readonly addr: string;
  readonly labels: readonly string[];
  readonly screenAddress: string;
  readonly vertical: boolean;
  readonly tiles: readonly number[];
}

interface Screenlocstring {
  readonly screenAddress: string;
  readonly glyphs: readonly number[];
  readonly text: string;
}

const frontend = frontendJson as unknown as {
  statics: { count: number; entries: StaticEntry[] };
  menuText: { count: number };
  keyChoiceScreenlocstrings: { strings: Screenlocstring[] };
};

/** static_tiles ($7F00): 75 records of 8 pixel rows plus one attribute byte. */
export const STATIC_TILE_STRIDE = 9;
const staticTiles = decodeBase64(tilesData.static.data);
export const STATIC_TILE_COUNT = tilesData.static.count;

/** The 18 definitions, in the order $F1E0 walks them. */
export const statics: readonly StaticEntry[] = frontend.statics.entries;

/** The first 8 key_choice_screenlocstrings, which are the menu ($F1F9). */
export const menuStrings: readonly Screenlocstring[] =
  frontend.keyChoiceScreenlocstrings.strings.slice(0, frontend.menuText.count);

function parseAddr(s: string): number {
  return parseInt(s.slice(1), 16);
}

/**
 * The attribute cell for a screen address, by its high byte ($F231..$F23D).
 *
 * The routine picks the bank by comparing the high byte against $48 and $50 --
 * the thirds of the display file -- and keeps the low byte unchanged, which is
 * already `row_in_third << 5 | column`. Note it does this with D pointing at
 * the LAST plotted row, not the first; both are in the same third, so the
 * answer is the same either way.
 */
function attributeAddressFor(screenAddr: number): number {
  const high = (screenAddr >> 8) & 0xff;
  const bank = high < 0x48 ? 0x58 : high < 0x50 ? 0x59 : 0x5a;
  return ((bank << 8) | (screenAddr & 0xff)) & 0xffff;
}

/**
 * plot_static_tiles ($F20B): one definition's run of tiles.
 *
 * Each tile is eight rows written at D+1 per row -- $0100 apart, the same
 * scanline-within-a-character-row step the display file uses -- then the ninth
 * byte goes to the attribute cell. Between tiles the pointer either steps one
 * column right (horizontal) or one scanline down from the last row (vertical,
 * $F24E next_scanline_down), which is how the flagpole and the window's side
 * borders are drawn as single vertical runs.
 */
export function plotStaticTiles(
  screen: SpectrumScreen,
  screenAddress: number,
  vertical: boolean,
  tiles: ArrayLike<number>,
): void {
  let dst = screenAddress & 0xffff;

  for (let i = 0; i < tiles.length; i++) {
    const src = (tiles[i] ?? 0) * STATIC_TILE_STRIDE;
    let row = dst;
    for (let r = 0; r < 8; r++) {
      screen.display[row - DISPLAY_FILE_BASE] = staticTiles[src + r] ?? 0;
      row = (row + 0x100) & 0xffff;
    }
    // $F22F DEC D: back to the last row plotted, which is what both the
    // attribute calculation and the advance below work from.
    row = (row - 0x100) & 0xffff;

    screen.attributes[attributeAddressFor(row) - ATTRIBUTE_FILE_BASE] =
      staticTiles[src + 8] ?? 0;

    if (vertical) {
      dst = nextScanlineDown(row); // $F24E
    } else {
      // $F247: rewind the seven rows the tile spanned, then one column right.
      dst = (((row - 0x700) & 0xff00) | ((row + 1) & 0x00ff)) & 0xffff;
    }
  }
}

/**
 * plot_statics_and_menu_text ($F1E0): all 18 statics, then the menu text.
 *
 * Draws into a SpectrumScreen rather than returning anything, because that is
 * what it does -- these are pokes into the display file that stay until
 * something overwrites them.
 */
export function plotStaticsAndMenuText(screen: SpectrumScreen): void {
  for (const s of statics) {
    plotStaticTiles(screen, parseAddr(s.screenAddress), s.vertical, s.tiles);
  }
  for (const s of menuStrings) {
    plotGlyphs(screen, parseAddr(s.screenAddress), s.glyphs);
  }
}

/**
 * The statics alone, without the menu text.
 *
 * `main` only ever draws both together, but the frame around the game window
 * is wanted during PLAY as well, where the menu text is not. Splitting it here
 * keeps the demo from having to overdraw eight strings it does not want.
 */
export function plotStatics(screen: SpectrumScreen): void {
  for (const s of statics) {
    plotStaticTiles(screen, parseAddr(s.screenAddress), s.vertical, s.tiles);
  }
}
