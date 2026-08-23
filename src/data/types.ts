/**
 * Typed shapes over data/*.json.
 *
 * BUILD_PROMPT.md §3: src/ contains ZERO literal game data. Everything here is
 * an interface describing what the Python extractor emits; no values. The
 * accompanying test in tests/no-literal-data.test.ts enforces that.
 *
 * Every table carries provenance -- `_label` and `_addr` -- so a value in the
 * running game can be traced back to a line of the disassembly (§0).
 */

/** Provenance carried by every extracted table. */
export interface Provenance {
  readonly _label: string;
  /** Address in the original memory map, e.g. "$6C15". */
  readonly _addr: string;
  readonly _bytes: number;
}

/** A bounding box; the disassembly's `bounds_t`. */
export interface Bounds {
  readonly x0: number;
  readonly x1: number;
  readonly y0: number;
  readonly y1: number;
}

// ---------------------------------------------------------------- map --------

export interface MapData extends Provenance {
  readonly width: number;
  readonly height: number;
  /** width*height supertile indices. */
  readonly supertileIndices: readonly number[];
  /** 218 supertiles, each 16 tile references in a 4x4 grid. */
  readonly superTiles: ReadonlyArray<readonly number[]>;
  readonly unusedSuperTiles: readonly number[];
  /**
   * Tile-set offset per supertile, pre-resolved from plot_tile (c$A9AD) so the
   * engine never chases addresses: 0, 145 or 365.
   */
  readonly tileBankForSuperTile: readonly number[];
}

// -------------------------------------------------------------- tiles --------

export interface TileSet extends Provenance {
  readonly count: number;
  readonly bytesPerTile: number;
  /** base64 of count*8 bitmap bytes. */
  readonly data: string;
}

export interface TilesData {
  readonly exterior: TileSet;
  readonly interior: TileSet;
  readonly mask: TileSet;
  readonly static: TileSet;
}

// -------------------------------------------------------------- rooms --------

export interface RoomObject {
  readonly object: number;
  readonly x: number;
  readonly y: number;
}

export interface RoomDef {
  readonly addr: string;
  readonly labels: readonly string[];
  readonly dimensionsIndex: number;
  readonly bounds: readonly Bounds[];
  readonly masks: readonly number[];
  readonly objects: readonly RoomObject[];
  readonly bytes: number;
}

export interface RoomEntry {
  /** 1-based: rooms_and_tunnels ($6BAD) starts at room 1, not room 0. */
  readonly room: number;
  readonly roomdefIndex: number;
  readonly unused: boolean;
  /** Set when this room reuses an earlier room's definition. */
  readonly aliasOf: number | null;
}

export interface RoomDimensions {
  readonly x0: number;
  readonly x1: number;
  readonly y0: number;
  readonly y1: number;
}

export interface RoomsData extends Provenance {
  readonly note: string;
  readonly dimensions: Provenance & { readonly entries: readonly RoomDimensions[] };
  readonly roomdefs: readonly RoomDef[];
  readonly rooms: readonly RoomEntry[];
  readonly unusedRooms: readonly number[];
}

// ------------------------------------------------------------ objects --------

export interface InteriorObject {
  readonly index: number;
  readonly addr: string;
  readonly width: number;
  readonly height: number;
  /** width*height tile refs; 0 means transparent (the write is skipped). */
  readonly tiles: readonly number[];
  readonly unused: boolean;
}

export interface ObjectsData extends Provenance {
  readonly objects: readonly InteriorObject[];
  readonly unusedObjects: readonly number[];
  readonly note: string;
}

// -------------------------------------------------------------- masks --------

export interface MaskRecord {
  readonly addr: string;
  readonly index: number;
  readonly bounds: Bounds;
  readonly pos: readonly number[];
}

export interface MaskShape {
  readonly index: number;
  readonly addr: string;
  readonly kind: 'exterior' | 'interior';
  readonly width: number;
  readonly height: number;
  readonly tiles: readonly number[];
}

export interface MasksData extends Provenance {
  readonly masks: readonly MaskShape[];
  readonly exteriorMaskData: readonly MaskRecord[];
  readonly interiorMaskDataSource: readonly MaskRecord[];
  readonly unreferencedMasks: readonly number[];
}

// ------------------------------------------------------------ sprites --------

export interface SpriteRecord {
  readonly addr: string;
  /** Stored as width-in-bytes PLUS ONE; already decremented here. */
  readonly widthBytes: number;
  readonly widthPixels: number;
  readonly height: number;
  readonly bitmapAddr: string;
  readonly maskAddr: string;
  readonly bitmapLabels: readonly string[];
  readonly maskLabels: readonly string[];
}

export interface SpritesData extends Provenance {
  readonly count: number;
  readonly sprites: readonly SpriteRecord[];
  readonly knownGlitches: readonly string[];
}

// ------------------------------------------------------------- timing --------

export interface GameWindowGeometry extends Provenance {
  readonly rows: number;
  readonly rowAddresses: readonly string[];
  readonly originColumn: number;
  readonly originPixelRow: number;
  readonly widthPixels: number;
  readonly heightPixels: number;
  readonly note: string;
}

export interface TimingData {
  readonly timedEvents: Provenance & { readonly values: readonly number[] };
  readonly searchlightMovements: Provenance & { readonly values: readonly number[] };
  readonly searchlightShape: Provenance & { readonly data: string };
  readonly zoomboxTiles: Provenance & { readonly data: string };
  readonly gameWindow: GameWindowGeometry;
}

// ---------------------------------------------------------------- prng -------

export interface PrngData {
  readonly _addr: string;
  readonly _bytes: number;
  readonly containedIn: string;
  readonly data: string;
  readonly pointerInit: string;
  readonly note: string;
}
