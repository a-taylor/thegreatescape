/**
 * The ZX Spectrum display model.
 *
 * BUILD_PROMPT.md §4: reproduce the display rather than approximate it. That
 * means a 256x192 bitmap at ONE BIT PER PIXEL plus a separate 32x24 grid of
 * attribute bytes. Colour exists only in the attributes -- the bitmap knows
 * nothing about it. Getting this wrong at the start is expensive to undo,
 * because the masking, clipping and sub-character scrolling downstream all
 * depend on operating over real bytes.
 */

export const SCREEN_WIDTH = 256;
export const SCREEN_HEIGHT = 192;
export const SCREEN_COLS = SCREEN_WIDTH / 8; // 32
export const SCREEN_ROWS = SCREEN_HEIGHT / 8; // 24

/** Display file: $4000..$57FF (6144 bytes). */
export const DISPLAY_FILE_BASE = 0x4000;
export const DISPLAY_FILE_SIZE = 0x1800;

/** Attribute file: $5800..$5AFF (768 bytes). */
export const ATTRIBUTE_FILE_BASE = 0x5800;
export const ATTRIBUTE_FILE_SIZE = 0x300;

/**
 * Attribute byte layout:
 *
 *   bit 7  FLASH
 *   bit 6  BRIGHT
 *   bits 5..3  PAPER (background colour 0..7)
 *   bits 2..0  INK   (foreground colour 0..7)
 */
export const ATTR_INK_MASK = 0b0000_0111;
export const ATTR_PAPER_SHIFT = 3;
export const ATTR_PAPER_MASK = 0b0011_1000;
export const ATTR_BRIGHT = 0b0100_0000;
export const ATTR_FLASH = 0b1000_0000;

/**
 * The hardware palette. Non-bright components are $D7, bright are $FF -- the
 * Spectrum's ULA drives them at two levels, not a scaled ramp, so bright black
 * is still black.
 */
const LEVEL_NORMAL = 0xd7;
const LEVEL_BRIGHT = 0xff;

/** Colour index -> (blue, red, green) bit flags, in the ULA's own bit order. */
const COLOUR_BITS: ReadonlyArray<readonly [number, number, number]> = [
  [0, 0, 0], // 0 black
  [1, 0, 0], // 1 blue
  [0, 1, 0], // 2 red
  [1, 1, 0], // 3 magenta
  [0, 0, 1], // 4 green
  [1, 0, 1], // 5 cyan
  [0, 1, 1], // 6 yellow
  [1, 1, 1], // 7 white
];

/** Resolve an attribute colour to RGB. */
export function paletteRGB(colour: number, bright: boolean): [number, number, number] {
  const bits = COLOUR_BITS[colour & 7]!;
  const level = bright ? LEVEL_BRIGHT : LEVEL_NORMAL;
  const [b, r, g] = bits;
  return [r * level, g * level, b * level];
}

/**
 * Screen address for a pixel row, the Spectrum's famously non-linear layout.
 *
 * The display file is split into three 2KB thirds. Within a third, the byte
 * address interleaves the scanline-within-character-row into bits 8..10, so
 * consecutive memory is NOT consecutive on screen:
 *
 *   addr = $4000
 *        | (y & 0b1100_0000) << 5     third        (bits 11..12)
 *        | (y & 0b0000_0111) << 8     scanline     (bits 8..10)
 *        | (y & 0b0011_1000) << 2     char row     (bits 5..7)
 *        | x                          column       (bits 0..4)
 *
 * Verified against game_window_start_addresses (w$EDD3): its first entry is
 * $4047, which this decodes to column 7, pixel row 16.
 */
export function screenAddress(x: number, y: number): number {
  return (
    DISPLAY_FILE_BASE |
    ((y & 0b1100_0000) << 5) |
    ((y & 0b0000_0111) << 8) |
    ((y & 0b0011_1000) << 2) |
    (x & 0b0001_1111)
  );
}

/** Inverse of {@link screenAddress}: address -> (column, pixel row). */
export function screenCoords(addr: number): { col: number; row: number } {
  const o = addr - DISPLAY_FILE_BASE;
  return {
    col: o & 0b0001_1111,
    row: ((o & 0b0001_1000_0000_0000) >> 5) | ((o & 0b0000_0111_0000_0000) >> 8) | ((o & 0b0000_0000_1110_0000) >> 2),
  };
}

/** Attribute file address for a character cell. */
export function attributeAddress(col: number, row: number): number {
  return ATTRIBUTE_FILE_BASE + row * SCREEN_COLS + col;
}

/**
 * A Spectrum screen: the display file and attribute file as real byte arrays.
 *
 * Everything upstream writes bytes here. Only {@link toImageData} knows about
 * pixels or colour.
 */
export class SpectrumScreen {
  /** 6144 bytes, 1bpp, in the hardware's interleaved order. */
  readonly display = new Uint8Array(DISPLAY_FILE_SIZE);
  /** 768 bytes, one per 8x8 character cell. */
  readonly attributes = new Uint8Array(ATTRIBUTE_FILE_SIZE);

  clear(pixelByte = 0x00, attribute = 0x00): void {
    this.display.fill(pixelByte);
    this.attributes.fill(attribute);
  }

  /** Write one byte of pixels (8 horizontal pixels) at a screen address. */
  writeByte(addr: number, value: number): void {
    this.display[addr - DISPLAY_FILE_BASE] = value & 0xff;
  }

  readByte(addr: number): number {
    return this.display[addr - DISPLAY_FILE_BASE]!;
  }

  setAttribute(col: number, row: number, attr: number): void {
    this.attributes[row * SCREEN_COLS + col] = attr & 0xff;
  }

  getAttribute(col: number, row: number): number {
    return this.attributes[row * SCREEN_COLS + col]!;
  }

  /** Fill a rectangle of character cells with one attribute. */
  fillAttributes(col: number, row: number, cols: number, rows: number, attr: number): void {
    for (let r = 0; r < rows; r++) {
      const base = (row + r) * SCREEN_COLS + col;
      this.attributes.fill(attr & 0xff, base, base + cols);
    }
  }

  /**
   * Resolve display + attributes into RGBA pixels.
   *
   * `flashPhase` swaps ink and paper in cells with the FLASH bit set; the real
   * machine toggles it every 16 frames off the 50Hz interrupt.
   */
  toImageData(target: Uint8ClampedArray, flashPhase = false): void {
    for (let y = 0; y < SCREEN_HEIGHT; y++) {
      const charRow = y >> 3;
      for (let col = 0; col < SCREEN_COLS; col++) {
        const attr = this.attributes[charRow * SCREEN_COLS + col]!;
        const bright = (attr & ATTR_BRIGHT) !== 0;
        const swap = flashPhase && (attr & ATTR_FLASH) !== 0;

        const inkIndex = attr & ATTR_INK_MASK;
        const paperIndex = (attr & ATTR_PAPER_MASK) >> ATTR_PAPER_SHIFT;
        const ink = paletteRGB(swap ? paperIndex : inkIndex, bright);
        const paper = paletteRGB(swap ? inkIndex : paperIndex, bright);

        const bits = this.display[screenAddress(col, y) - DISPLAY_FILE_BASE]!;
        let o = (y * SCREEN_WIDTH + col * 8) * 4;
        for (let bit = 0; bit < 8; bit++) {
          const set = (bits & (0x80 >> bit)) !== 0;
          const [r, g, b] = set ? ink : paper;
          target[o] = r;
          target[o + 1] = g;
          target[o + 2] = b;
          target[o + 3] = 255;
          o += 4;
        }
      }
    }
  }
}
