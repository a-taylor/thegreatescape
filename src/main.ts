/**
 * P3 demo: a walkable hero, drawn through the game's own rendering chain.
 *
 * The hero moves through the real path -- input -> animindices -> animation
 * frames -> position -> bounds check -> door handling -- and reaches the screen
 * through render_mask_buffer and plot_masked_sprite, so scenery occludes him
 * rather than the other way round. The map scrolls through move_map rather than
 * by chasing him. Rooms 2, 4 and 9 carry a pushable stove or crate; ten rooms
 * hold an item lying on the floor. Depth order between all of them comes from
 * get_next_drawable, which sorts characters and items into one sequence.
 *
 * What is still stubbed, and marked ASSUMPTION where it is: the push trigger,
 * which really lives in `touch`'s collision handling (P4), and the initial
 * map_position, which the demo centres rather than taking from enter_room (see
 * OPEN_QUESTIONS.md §11).
 */

import { exteriorTiles, interiorTiles, roomsData, spritesData, decodeBase64 } from './data/load.js';
import { tinyposStash, toTinyPos } from './game/coords.js';
import { INTERIOR_MAP_POSITION } from './game/doors.js';
import { itemDefinitions, itemStructs, type ItemStruct } from './game/items.js';
import {
  HERO_STANDING_HEIGHT,
  animations,
  createHero,
  encodeInput,
  step,
} from './game/hero.js';
import {
  createMovable,
  movableForRoom,
  pushMovable,
  type MovableState,
} from './game/movable.js';
import { chooseGameWindowAttributes } from './render/attributes.js';
import { drawOrder, type Drawable } from './render/drawlist.js';
import { ExteriorView } from './render/exterior.js';
import { isoPlacement, itemPlacement, windowPlacement } from './render/place.js';
import { clippedBufferRow, vischarVisible } from './render/clip.js';
import { MASK_BUFFER_SIZE, plotMaskedSprite } from './render/sprites.js';
import { interiorMasksForRoom, renderMaskBuffer } from './render/maskbuffer.js';
import { fillRoom } from './render/scene.js';
import {
  GameWindowBuffers,
  NO_OFFSET,
  VISIBLE_PIXEL_ROWS,
  WINDOW_COLS,
  plotGameWindow,
  setWindowAttributes,
} from './render/window.js';
import { CanvasPresenter } from './spectrum/canvas.js';
import { SpectrumScreen } from './spectrum/display.js';

const canvas = document.querySelector<HTMLCanvasElement>('#screen')!;
const statusEl = document.querySelector<HTMLParagraphElement>('#status')!;
const btnNight = document.querySelector<HTMLButtonElement>('#night')!;
const btnTorch = document.querySelector<HTMLButtonElement>('#torch')!;
const btnReset = document.querySelector<HTMLButtonElement>('#reset')!;
const roomSelect = document.querySelector<HTMLSelectElement>('#room')!;

const presenter = new CanvasPresenter(canvas);
const screen = new SpectrumScreen();
const buffers = new GameWindowBuffers();

/**
 * Start on open ground by the huts.
 *
 * World coordinates, not iso: the walls table puts hut 0 at tinypos x 106-110,
 * y 82-98, so x*8 / y*8 lands beside it. This projects to roughly iso tile
 * (96, 60), comfortably inside the 216x136 map.
 */
const START = { x: 100 * 8, y: 74 * 8, height: HERO_STANDING_HEIGHT };

/**
 * The map position that puts START near the middle of the window.
 *
 * Derived rather than hardcoded: guessing it put the hero below the visible
 * 128 rows, since only 128 of the buffer's 136 are ever blitted.
 */
const START_MAP = (() => {
  const iso = isoPlacement(START);
  return {
    x: iso.column - (WINDOW_COLS >> 1),
    y: (iso.pixelRow - (VISIBLE_PIXEL_ROWS >> 1)) >> 3,
  };
})();

const hero = createHero({ ...START }, 0, 0);
const view = new ExteriorView(START_MAP.x, START_MAP.y);
const keys = new Set<string>();
let night = false;
let torch = false;
let lastEvent = '';
let windowOffset = NO_OFFSET;
/** The room's stove or crate, if it has one. Occupies vischar slot 1. */
let movable: MovableState | null = null;

/**
 * move_map ($AAB2): scroll in response to the hero's animation.
 *
 * Not a camera that chases the hero. The animation's own header byte 3 names
 * the direction to shunt, and a 0..3 counter spreads one tile of travel across
 * the four frames of a walk cycle, filling the gaps with a sub-tile
 * game_window_offset. Centring on the hero instead makes the terrain jump a
 * whole tile while he moves two or four pixels, which is visible as jitter.
 */
function followHero(): void {
  const anim = animations[hero.animation];
  const mapDirection = anim?.header[3] ?? 0xff;
  windowOffset = view.moveMap(mapDirection, hero.reverse);
}

/** The prisoner sprite base: sprites[2] is bitmap_prisoner_facing_top_left_1. */
const PRISONER_SPRITE_BASE = 2;

/** The per-frame foreground occlusion mask, rebuilt by render_mask_buffer. */
const foreground = new Uint8Array(MASK_BUFFER_SIZE);

/**
 * Plot any sprite at a world position through the full masked path.
 *
 * Shared by the hero and by the movable items, which the game likewise treats
 * as vischars -- they occupy the second visible character slot.
 */
function plotSpriteAt(
  spriteIndex: number,
  pos: { x: number; y: number; height: number },
  flip: boolean,
): void {
  const record = spritesData.sprites[spriteIndex];
  if (!record) return;

  const iso0 = isoPlacement(pos);

  // vischar_visible (c$BAF7). width_bytes is the sprite width PLUS ONE, since
  // the plotter emits an extra byte for the sub-byte shift.
  const clip = vischarVisible(
    {
      isoXBytes: iso0.column,
      isoYPixels: iso0.pixelRow,
      widthBytesPlusOne: record.widthBytes + 1,
      height: record.height,
    },
    view.position,
  );
  if (!clip.visible) return;

  const place = windowPlacement(pos, view.position, record.widthBytes, record.height);

  // render_mask_buffer works in the units setup_vischar_plotting leaves behind:
  // state.iso_pos is vischar.iso_pos / 8, tinypos_stash is mi.pos / 8.
  const iso = iso0;
  // tinypos_stash, not toTinyPos: only x rounds. See coords.tinyposStash.
  const tiny = tinyposStash(pos, hero.room === 0);
  // Indoors the applicable masks come from the room's own mask list; outdoors
  // it is the whole exterior table.
  const records =
    hero.room === 0
      ? undefined
      : interiorMasksForRoom(
          roomsData.roomdefs[roomsData.rooms[hero.room - 1]!.roomdefIndex]!.masks,
        );
  renderMaskBuffer(
    foreground,
    {
      isoX: iso.column,
      isoY: iso.pixelRow >> 3,
      tinyX: tiny.x,
      tinyY: tiny.y,
      tinyHeight: tiny.height,
    },
    records,
  );

  plotMaskedSprite(
    { pixels: buffers.pixels, foreground },
    {
      bitmap: decodeBase64(record.bitmap),
      mask: decodeBase64(record.mask),
      widthBytes: record.widthBytes,
      height: record.height,
    },
    {
      column: place.column,
      // $DCA5: a sprite clipped at the top is drawn at buffer row 0, with the
      // skip applied to the sprite data rather than a negative row.
      row: clippedBufferRow(clip.topSkip, iso0.pixelRow, view.position.y),
      shift: place.shift,
      skipRows: clip.topSkip,
      rows: clip.clippedHeight,
      skipCols: clip.leftSkip,
      cols: clip.clippedWidth,
      // TL/TR and BR/BL are the same artwork mirrored; the frame's own flip
      // flag is the only thing distinguishing them.
      flip,
    },
  );
}

/**
 * setup_item_plotting ($DC41) and the 16px plotter.
 *
 * Items take a different path from characters: their iso_pos is stored in the
 * itemstruct in TILE rows, so placement lands on whole tiles ($DCAE multiplies
 * by 192); their definitions store a plain width rather than width-plus-one;
 * and they are never flipped, since $DC54 zeroes sprite_index outright.
 */
function plotItem(struct: ItemStruct): void {
  const def = itemDefinitions[struct.item];
  if (!def) return;

  const place = itemPlacement(struct.isoPos.x, struct.isoPos.y, view.position);

  // The same clip as characters, in the same units: iso column in bytes, iso
  // row in pixels. Items get no width-plus-one, hence widthBytes as stored.
  const clip = vischarVisible(
    {
      isoXBytes: struct.isoPos.x,
      isoYPixels: struct.isoPos.y * 8,
      widthBytesPlusOne: def.widthBytes,
      height: def.height,
    },
    view.position,
  );
  if (!clip.visible) return;

  // $DC94: the item's own mask is rendered into the buffer the same way.
  renderMaskBuffer(
    foreground,
    {
      isoX: struct.isoPos.x,
      isoY: struct.isoPos.y,
      tinyX: struct.pos.x,
      tinyY: struct.pos.y,
      tinyHeight: struct.pos.height,
    },
    hero.room === 0
      ? undefined
      : interiorMasksForRoom(
          roomsData.roomdefs[roomsData.rooms[hero.room - 1]!.roomdefIndex]!.masks,
        ),
  );

  plotMaskedSprite(
    { pixels: buffers.pixels, foreground },
    {
      bitmap: decodeBase64(def.bitmap),
      mask: decodeBase64(def.mask),
      widthBytes: def.widthBytes,
      height: def.height,
    },
    {
      column: place.column,
      row: clip.topSkip !== 0 ? 0 : place.pixelRow, // $DCA2/$DCA5
      shift: 0, // items sit on byte boundaries; there is no sub-byte roll
      skipRows: clip.topSkip,
      rows: clip.clippedHeight,
      skipCols: clip.leftSkip,
      cols: clip.clippedWidth,
      flip: false, // $DC54
    },
  );
}

/**
 * plot_sprites ($B866): everything drawable, rearmost first.
 *
 * The demo has two occupied slots -- the hero in 0, the room's movable item in
 * 1, which is where setup_movable_item puts it ($697D). Depth order between
 * them comes from get_next_drawable rather than from a fixed sequence, so the
 * hero passes behind the stove and in front of it as he walks around it.
 */
function plotVischars(): void {
  const slots: Drawable[] = [
    { kind: 'vischar', index: 0, pos: hero.pos, drawable: true },
  ];
  if (movable) {
    slots.push({ kind: 'vischar', index: 1, pos: movable.pos, drawable: true });
  }

  // Items in this room compete in the same ordering. get_next_drawable's item
  // half works on tinypos * 8 ($B1C7), so they are scaled to meet the vischars.
  const here = itemStructs().filter((s) => !s.nowhere && s.room === hero.room);
  const items: Drawable[] = here.map((s) => ({
    kind: 'item',
    index: s.index,
    pos: { x: s.pos.x * 8, y: s.pos.y * 8, height: s.pos.height * 8 },
    drawable: true,
  }));

  for (const d of drawOrder(slots, items)) {
    if (d.kind === 'item') {
      plotItem(here.find((s) => s.index === d.index)!);
      continue;
    }
    if (d.index === 0) {
      const anim = animations[hero.animation];
      const frame = anim?.frames[hero.frame];
      // TL/TR and BR/BL are the same artwork mirrored; the frame's own flip
      // flag is the only thing distinguishing them.
      if (frame) plotSpriteAt(PRISONER_SPRITE_BASE + frame.sprite, hero.pos, frame.flip);
    } else if (movable) {
      // sprite_stove or sprite_crate, from the pointer in the movable_item
      // record ($69B4 / $69BD). Movable items never flip.
      plotSpriteAt(movable.item.spriteIndex, movable.pos, false);
    }
  }
}

function render(): void {
  const itemsHeld: [number, number] = torch ? [4, 0xff] : [0xff, 0xff];
  const { attribute, wipeTiles } = chooseGameWindowAttributes(hero.room, night, itemsHeld);

  if (wipeTiles) {
    buffers.wipeTiles();
  } else if (hero.room === 0) {
    view.render(buffers);
  } else {
    fillRoom(buffers, hero.room);
  }

  buffers.expandTiles(hero.room === 0 ? exteriorTiles() : interiorTiles());

  // Order matters and matches the original: plot_sprites composites into
  // window_buf, and only then does plot_game_window blit the buffer to the
  // display. Drawing the sprite after the blit writes into a buffer nobody
  // reads again this frame.
  // The hero is drawn in rooms as well as outdoors -- only an unlit tunnel
  // suppresses everything.
  if (!wipeTiles) plotVischars();

  screen.clear(0x00, 0x00);
  plotGameWindow(screen, buffers, hero.room === 0 ? windowOffset : NO_OFFSET);
  setWindowAttributes(screen, attribute);
  presenter.present(screen);

  const tiny = toTinyPos(hero.pos);
  const dirNames = ['TL', 'TR', 'BR', 'BL'];
  const where =
    hero.room === 0
      ? `outdoors · map (${view.position.x}, ${view.position.y})`
      : `room <b>${hero.room}</b> · roomdef <span class="a">${
          roomsData.roomdefs[roomsData.rooms[hero.room - 1]!.roomdefIndex]!.addr
        }</span>`;

  statusEl.innerHTML =
    `pos <b>(${hero.pos.x}, ${hero.pos.y})</b> · tiny (${tiny.x}, ${tiny.y}) · ` +
    `facing <b>${dirNames[hero.direction & 3]}</b>${hero.direction & 4 ? ' crawling' : ''} · ` +
    `${where} · gwo (${windowOffset.low},${windowOffset.high}) · ` +
    `attr <span class="a">$${attribute.toString(16).toUpperCase().padStart(2, '0')}</span>` +
    (lastEvent ? ` · <b>${lastEvent}</b>` : '');
}

/**
 * The room state interior_bounds_check needs: which roomdef_dimensions entry
 * applies, and the roomdef's own furniture boxes.
 *
 * Omitting this indoors makes boundsCheck throw, which kills the tick and the
 * hero stops moving entirely -- silently, because the throw happens inside a
 * setInterval callback.
 */
function interiorBounds(room: number) {
  if (room === 0) return undefined;
  const def = roomsData.roomdefs[roomsData.rooms[room - 1]!.roomdefIndex]!;
  return { boundsIndex: def.dimensionsIndex, objectBounds: def.bounds };
}

/**
 * A standing position inside a room: the first spot clear of both the room
 * bounds and the furniture. Room extents differ per roomdef, so a fixed
 * position is valid in some rooms and inside a wall in others.
 */
function spawnInRoom(room: number): { x: number; y: number; height: number } {
  const def = roomsData.roomdefs[roomsData.rooms[room - 1]!.roomdefIndex]!;
  const dims = roomsData.dimensions.entries[def.dimensionsIndex]!;
  for (let y = dims.y0 + 1; y < dims.y1 - 4; y++) {
    for (let x = dims.x0 + 5; x <= dims.x1; x++) {
      const blocked = def.bounds.some(
        (b) => x >= b.x0 && x < b.x1 && y >= b.y0 && y < b.y1,
      );
      if (!blocked) return { x, y, height: HERO_STANDING_HEIGHT };
    }
  }
  return { x: dims.x0 + 5, y: dims.y0 + 1, height: HERO_STANDING_HEIGHT };
}

function tick(): void {
  const input = encodeInput(
    keys.has('ArrowUp'),
    keys.has('ArrowDown'),
    keys.has('ArrowLeft'),
    keys.has('ArrowRight'),
  );

  const outcome = step(hero, input, interiorBounds(hero.room));

  // ASSUMPTION: the original triggers this from `touch` (c$AF8F), part of the
  // collision system that lands in P4. Until then the demo uses proximity: if
  // the hero is close to the item on its movable axis, he pushes it.
  if (movable && outcome.moved) {
    const dx = Math.abs((hero.pos.x & 0xff) - movable.pos.x);
    const dy = Math.abs((hero.pos.y & 0xff) - movable.pos.y);
    if (dx <= 6 && dy <= 6) {
      pushMovable(movable, hero.direction & 0x03);
      lastEvent = `pushed the ${movable.item._label.replace('movable_item_', '')}`;
    }
  }

  // move_map runs once per logic step, after the hero has animated -- the same
  // place the original calls it from ($6939 / $9D7B).
  if (hero.room === 0 && outcome.moved) followHero();

  if (outcome.enteredRoom !== null) {
    lastEvent = outcome.enteredRoom === 0 ? 'stepped outside' : `entered room ${outcome.enteredRoom}`;
    if (outcome.enteredRoom !== 0) {
      view.position.x = INTERIOR_MAP_POSITION.x;
      view.position.y = INTERIOR_MAP_POSITION.y;
    }
    // setup_movable_items ($6939) runs on entering a room: rooms 2, 4 and 9
    // each place one, and it is reset to its starting position each time.
    const item = movableForRoom(outcome.enteredRoom);
    movable = item ? createMovable(item) : null;
  } else if (outcome.lockedDoor !== null) {
    lastEvent = 'THE DOOR IS LOCKED';
  } else if (outcome.blocked) {
    lastEvent = 'blocked';
  } else if (input !== 0) {
    lastEvent = '';
  }

  render();
}

// The original runs its logic on a fixed tick, not on wall-clock time, so the
// loop is a fixed-step interval rather than requestAnimationFrame chasing.
const TICK_MS = 1000 / 25;
setInterval(tick, TICK_MS);

window.addEventListener('keydown', (e) => {
  if (e.key.startsWith('Arrow')) {
    keys.add(e.key);
    e.preventDefault();
  }
});
window.addEventListener('keyup', (e) => keys.delete(e.key));
window.addEventListener('blur', () => keys.clear());

btnNight.addEventListener('click', () => {
  night = !night;
  btnNight.setAttribute('aria-pressed', String(night));
  render();
});
btnTorch.addEventListener('click', () => {
  torch = !torch;
  btnTorch.setAttribute('aria-pressed', String(torch));
  render();
});
btnReset.addEventListener('click', () => {
  hero.pos = { ...START };
  hero.room = 0;
  hero.direction = 0;
  view.position.x = START_MAP.x;
  view.position.y = START_MAP.y;
  // Reset the scroll phase too. move_map's shunt and the hero's tile crossings
  // both tick once every four frames; if their phase is left stale the two stop
  // cancelling and the motion turns jumpy. See OPEN_QUESTIONS.md §13.
  view.moveMapY = 0;
  view.gameWindowOffset = NO_OFFSET;
  view.refresh();
  windowOffset = NO_OFFSET;
  movable = null; // back outdoors, and no exterior position has one
  lastEvent = '';
  render();
});

// A way into rooms without hunting for a reachable door. Rooms 6, 26 and 27 are
// listed but marked, since §9 wants unused things visibly unused.
for (const entry of roomsData.rooms) {
  const option = document.createElement('option');
  option.value = String(entry.room);
  const notes: string[] = [];
  if (entry.unused) notes.push('unused');
  if (entry.aliasOf) notes.push(`= room ${entry.aliasOf}`);
  option.textContent = `Room ${entry.room}${notes.length ? ` (${notes.join(', ')})` : ''}`;
  roomSelect.append(option);
}

roomSelect.addEventListener('change', () => {
  const room = Number(roomSelect.value);
  hero.room = room;
  if (room === 0) {
    hero.pos = { ...START };
    view.position.x = START_MAP.x;
    view.position.y = START_MAP.y;
  } else {
    // Interiors do not scroll; enter_room fixes the map position ($6900).
    hero.pos = spawnInRoom(room);
    view.position.x = INTERIOR_MAP_POSITION.x;
    view.position.y = INTERIOR_MAP_POSITION.y;
  }
  view.moveMapY = 0;
  view.gameWindowOffset = NO_OFFSET;
  view.refresh();
  windowOffset = NO_OFFSET;
  // setup_movable_items ($6939): rooms 2, 4 and 9 each get one.
  const item = movableForRoom(room);
  movable = item ? createMovable(item) : null;
  lastEvent = '';
  render();
});

function fit(): void {
  presenter.resize(window.innerWidth - 48, window.innerHeight - 260);
  render();
}
window.addEventListener('resize', fit);
fit();
