/**
* P3 demo: a walkable hero drawn with the real sprite plotter.
 *
 * The hero moves through the real chain -- input -> animindices -> animation
* frames -> position -> bounds check -> door handling -- and is composited by
* plot_masked_sprite. The foreground mask is not built yet, so he draws in
* front of scenery rather than behind it; that is the rest of P3.
 */

import { exteriorTiles, interiorTiles, roomsData, spritesData, decodeBase64 } from './data/load.js';
import { toTinyPos } from './game/coords.js';
import { INTERIOR_MAP_POSITION } from './game/doors.js';
import { animations, createHero, encodeInput, step } from './game/hero.js';
import { chooseGameWindowAttributes } from './render/attributes.js';
import { ExteriorView } from './render/exterior.js';
import { centreOn, windowPlacement } from './render/place.js';
import { MASK_BUFFER_WIDTH, plotMaskedSprite } from './render/sprites.js';
import { fillRoom } from './render/scene.js';
import { GameWindowBuffers, plotGameWindow, setWindowAttributes } from './render/window.js';
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
const START = { x: 100 * 8, y: 74 * 8, height: 0 };

const hero = createHero({ ...START }, 0, 0);
const view = new ExteriorView(0, 0);
const keys = new Set<string>();
let night = false;
let torch = false;
let lastEvent = '';

/**
 * Keep the hero roughly centred by deriving the map position from his tinypos.
 *
 * ASSUMPTION: the original tracks this through hero_map_position ($81B8) and
 * the shunt_map_* routines, which move the window one tile at a time as the
 * hero crosses a threshold. Centring produces the same view for a static frame
 * but not necessarily the same scroll timing. Recorded in OPEN_QUESTIONS.md
 * rather than presented as faithful.
 */
function followHero(): void {
  const centred = centreOn(hero.pos);
  view.position.x = centred.x;
  view.position.y = centred.y;
  view.refresh();
}

/** The prisoner sprite base: sprites[2] is bitmap_prisoner_facing_top_left_1. */
const PRISONER_SPRITE_BASE = 2;

/**
 * Plot the hero through the real masked-sprite path.
 *
 * The foreground mask is all-permitting for now: render_mask_buffer is not
 * implemented yet, so the hero draws in front of scenery rather than behind it.
 * That is the remaining half of P3.
 */
const permissiveForeground = new Uint8Array(MASK_BUFFER_WIDTH * 64).fill(0xff);

function plotHeroSprite(): void {
  const anim = animations[hero.animation];
  const frame = anim?.frames[hero.frame];
  if (!frame) return;

  const record = spritesData.sprites[PRISONER_SPRITE_BASE + frame.sprite];
  if (!record) return;

  const place = windowPlacement(hero.pos, view.position, record.widthBytes, record.height);
  if (!place.visible) return;

  plotMaskedSprite(
    { pixels: buffers.pixels, foreground: permissiveForeground },
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
    },
  );
}

function render(): void {
  const itemsHeld: [number, number] = torch ? [4, 0xff] : [0xff, 0xff];
  const { attribute, wipeTiles } = chooseGameWindowAttributes(hero.room, night, itemsHeld);

  if (wipeTiles) {
    buffers.wipeTiles();
  } else if (hero.room === 0) {
    followHero();
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
  plotGameWindow(screen, buffers);
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
    `${where} · attr <span class="a">$${attribute.toString(16).toUpperCase().padStart(2, '0')}</span>` +
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
  lastEvent = '';
  render();
});

function fit(): void {
  presenter.resize(window.innerWidth - 48, window.innerHeight - 260);
  render();
}
window.addEventListener('resize', fit);
fit();
