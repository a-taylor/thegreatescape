/**
 * P3 demo: a walkable hero drawn with the real sprite plotter.
 *
 * The hero moves through the real chain -- input -> animindices -> animation
 * frames -> position -> bounds check -> door handling -- and is composited by
 * plot_masked_sprite. The map scrolls through move_map rather than by chasing
 * him. The foreground mask is not built yet, so he draws in front of scenery
 * rather than behind it; that is the rest of P3.
 */

import { exteriorTiles, interiorTiles, roomsData, spritesData, decodeBase64 } from './data/load.js';
import { tinyposStash, toTinyPos } from './game/coords.js';
import { INTERIOR_MAP_POSITION } from './game/doors.js';
import {
  HERO_STANDING_HEIGHT,
  animations,
  createHero,
  encodeInput,
  step,
} from './game/hero.js';
import { chooseGameWindowAttributes } from './render/attributes.js';
import { ExteriorView } from './render/exterior.js';
import { isoPlacement, windowPlacement } from './render/place.js';
import { MASK_BUFFER_SIZE, plotMaskedSprite } from './render/sprites.js';
import { renderMaskBuffer } from './render/maskbuffer.js';
import { fillRoom } from './render/scene.js';
import {
  GameWindowBuffers,
  NO_OFFSET,
  VISIBLE_PIXEL_ROWS,
  WINDOW_COLS,
  WINDOW_STRIDE,
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

function plotHeroSprite(): void {
  const anim = animations[hero.animation];
  const frame = anim?.frames[hero.frame];
  if (!frame) return;

  const record = spritesData.sprites[PRISONER_SPRITE_BASE + frame.sprite];
  if (!record) return;

  const place = windowPlacement(
    hero.pos,
    view.position,
    record.widthBytes,
    record.height,
    windowOffset.low / WINDOW_STRIDE,
  );
  if (!place.visible) return;

  // render_mask_buffer works in the units setup_vischar_plotting leaves behind:
  // state.iso_pos is vischar.iso_pos / 8, tinypos_stash is mi.pos / 8.
  const iso = isoPlacement(hero.pos);
  // tinypos_stash, not toTinyPos: only x rounds. See coords.tinyposStash.
  const tiny = tinyposStash(hero.pos, hero.room === 0);
  renderMaskBuffer(foreground, {
    isoX: iso.column,
    isoY: iso.pixelRow >> 3,
    tinyX: tiny.x,
    tinyY: tiny.y,
    tinyHeight: tiny.height,
  });

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
      row: place.pixelRow,
      shift: place.shift,
      skipRows: Math.max(0, -place.pixelRow),
      rows: record.height,
      // TL/TR and BR/BL are the same artwork mirrored; the frame's own flip
      // flag is the only thing distinguishing them.
      flip: frame.flip,
    },
  );
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
  if (!wipeTiles && hero.room === 0) plotHeroSprite();

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

function tick(): void {
  const input = encodeInput(
    keys.has('ArrowUp'),
    keys.has('ArrowDown'),
    keys.has('ArrowLeft'),
    keys.has('ArrowRight'),
  );

  const outcome = step(hero, input);

  // move_map runs once per logic step, after the hero has animated -- the same
  // place the original calls it from ($6939 / $9D7B).
  if (hero.room === 0 && outcome.moved) followHero();

  if (outcome.enteredRoom !== null) {
    lastEvent = outcome.enteredRoom === 0 ? 'stepped outside' : `entered room ${outcome.enteredRoom}`;
    if (outcome.enteredRoom !== 0) {
      view.position.x = INTERIOR_MAP_POSITION.x;
      view.position.y = INTERIOR_MAP_POSITION.y;
    }
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
  view.refresh();
  windowOffset = NO_OFFSET;
  lastEvent = '';
  render();
});

function fit(): void {
  presenter.resize(window.innerWidth - 48, window.innerHeight - 260);
  render();
}
window.addEventListener('resize', fit);
fit();
