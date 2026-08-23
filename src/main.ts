/**
 * P2 demo: a walkable hero.
 *
 * The hero moves through the real chain -- input -> animindices -> animation
 * frames -> position -> bounds check -> door handling -- and the map window
 * follows. Sprite plotting with masks is P3, so the hero is drawn here as a
 * marker at his projected isometric position.
 */

import { exteriorTiles, interiorTiles, roomsData } from './data/load.js';
import { calcIsoPos, toTinyPos } from './game/coords.js';
import { INTERIOR_MAP_POSITION } from './game/doors.js';
import { createHero, encodeInput, step } from './game/hero.js';
import { chooseGameWindowAttributes } from './render/attributes.js';
import { ExteriorView, MAP_ROW_BIAS } from './render/exterior.js';
import { fillRoom } from './render/scene.js';
import {
  BUFFER_ROWS,
  GameWindowBuffers,
  WINDOW_COLS,
  WINDOW_ORIGIN_COL,
  WINDOW_ORIGIN_PIXEL_ROW,
  plotGameWindow,
  setWindowAttributes,
} from './render/window.js';
import { CanvasPresenter } from './spectrum/canvas.js';
import { SCREEN_COLS, SpectrumScreen, screenAddress } from './spectrum/display.js';

const canvas = document.querySelector<HTMLCanvasElement>('#screen')!;
const statusEl = document.querySelector<HTMLParagraphElement>('#status')!;
const btnNight = document.querySelector<HTMLButtonElement>('#night')!;
const btnTorch = document.querySelector<HTMLButtonElement>('#torch')!;
const btnReset = document.querySelector<HTMLButtonElement>('#reset')!;

const presenter = new CanvasPresenter(canvas);
const screen = new SpectrumScreen();
const buffers = new GameWindowBuffers();

/** Start on open ground inside the camp. */
const START = { x: 0x2a * 8, y: 0x3e * 8, height: 0 };

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
  // Integer arithmetic only: BUILD_PROMPT §5 forbids floats in game state, and
  // map_position is a pair of bytes in the original. `>> 1` rather than `/ 2`.
  const tiny = toTinyPos(hero.pos);
  const x = tiny.x - (WINDOW_COLS >> 1);
  const y = tiny.y - (BUFFER_ROWS >> 1) + MAP_ROW_BIAS;
  view.position.x = Math.max(0, Math.min(54 * 4 - WINDOW_COLS, x));
  view.position.y = Math.max(
    MAP_ROW_BIAS,
    Math.min(34 * 4 - BUFFER_ROWS + MAP_ROW_BIAS, y),
  );
  view.refresh();
}

/** Draw the hero as a marker until sprite plotting arrives in P3. */
function plotHeroMarker(): void {
  const iso = calcIsoPos(hero.pos);
  // iso_pos is in half-pixels on x; the window shows a moving portion of it.
  const tiny = toTinyPos(hero.pos);
  const col = tiny.x - view.position.x;
  const row = tiny.y - (view.position.y - MAP_ROW_BIAS);
  if (col < 0 || col >= WINDOW_COLS || row < 0 || row >= BUFFER_ROWS) return;

  const screenCol = WINDOW_ORIGIN_COL + col;
  const baseRow = WINDOW_ORIGIN_PIXEL_ROW + row * 8;
  for (let r = 0; r < 8; r++) {
    const addr = screenAddress(screenCol, baseRow + r);
    screen.writeByte(addr, screen.readByte(addr) ^ 0xff);
  }
  // Mark the cell so it stands out against the terrain.
  const charRow = (baseRow >> 3) & 0x1f;
  if (screenCol < SCREEN_COLS && charRow < 24) {
    screen.setAttribute(screenCol, charRow, 0x46); // bright yellow over black
  }
  void iso;
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

  screen.clear(0x00, 0x00);
  plotGameWindow(screen, buffers);
  setWindowAttributes(screen, attribute);
  if (!wipeTiles) plotHeroMarker();
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
