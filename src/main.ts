/**
 * P1 demo: draw the game window with the real display model.
 *
 * Deliberately not a game loop -- P1 is static rendering. This exists to make
 * the pipeline visible end to end: tile buffer -> pixel buffer -> 128-row blit
 * -> attributes -> ImageData -> integer-scaled canvas.
 */

import { mapData, exteriorTiles, interiorTiles, roomsData } from './data/load.js';
import { chooseGameWindowAttributes } from './render/attributes.js';
import { fillExterior, fillRoom } from './render/scene.js';
import {
  BUFFER_ROWS,
  GameWindowBuffers,
  WINDOW_COLS,
  plotGameWindow,
  setWindowAttributes,
} from './render/window.js';
import { CanvasPresenter } from './spectrum/canvas.js';
import { SpectrumScreen } from './spectrum/display.js';

const canvas = document.querySelector<HTMLCanvasElement>('#screen')!;
const statusEl = document.querySelector<HTMLParagraphElement>('#status')!;
const roomSelect = document.querySelector<HTMLSelectElement>('#room')!;
const btnExterior = document.querySelector<HTMLButtonElement>('#mode-exterior')!;
const btnInterior = document.querySelector<HTMLButtonElement>('#mode-interior')!;
const btnNight = document.querySelector<HTMLButtonElement>('#night')!;
const btnTorch = document.querySelector<HTMLButtonElement>('#torch')!;

const presenter = new CanvasPresenter(canvas);
const screen = new SpectrumScreen();
const buffers = new GameWindowBuffers();

/** Tile columns/rows of exterior map beyond which the window would run off. */
const MAX_MAP_X = mapData.width * 4 - WINDOW_COLS;
const MAX_MAP_Y = mapData.height * 4 - BUFFER_ROWS;

const state = {
  mode: 'exterior' as 'exterior' | 'interior',
  mapX: 0,
  mapY: 40, // the upper map is blank; start where the camp is
  room: 1,
  night: false,
  torch: false,
};

// Rooms 6, 26 and 27 are unused indices; they are listed but marked, because
// §9 requires unused things to stay visibly unused rather than be filtered out.
for (const entry of roomsData.rooms) {
  const option = document.createElement('option');
  option.value = String(entry.room);
  const notes: string[] = [];
  if (entry.unused) notes.push('unused');
  if (entry.aliasOf) notes.push(`= room ${entry.aliasOf}`);
  option.textContent = `Room ${entry.room}${notes.length ? ` (${notes.join(', ')})` : ''}`;
  roomSelect.append(option);
}
roomSelect.value = String(state.room);

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function render(): void {
  const room = state.mode === 'exterior' ? 0 : state.room;
  const itemsHeld: [number, number] = state.torch ? [4, 0xff] : [0xff, 0xff];
  const { attribute, wipeTiles } = chooseGameWindowAttributes(room, state.night, itemsHeld);

  if (wipeTiles) {
    // An unlit tunnel draws nothing at all ($AB96 calls wipe_visible_tiles).
    buffers.wipeTiles();
  } else if (state.mode === 'exterior') {
    fillExterior(buffers, state.mapX, state.mapY);
  } else {
    fillRoom(buffers, state.room);
  }

  buffers.expandTiles(state.mode === 'exterior' ? exteriorTiles() : interiorTiles());

  screen.clear(0x00, 0x00);
  plotGameWindow(screen, buffers);
  setWindowAttributes(screen, attribute);
  presenter.present(screen);

  const where =
    state.mode === 'exterior'
      ? `map tile <b>(${state.mapX}, ${state.mapY})</b> · supertile (${Math.floor(state.mapX / 4)}, ${Math.floor(state.mapY / 4)})`
      : `room <b>${state.room}</b> · roomdef <span class="a">${roomsData.roomdefs[roomsData.rooms[state.room - 1]!.roomdefIndex]!.addr}</span>`;

  const attrName =
    attribute === 0x07
      ? 'white over black'
      : attribute === 0x41
        ? 'bright blue over black'
        : attribute === 0x05
          ? 'cyan over black'
          : 'red over black';

  statusEl.innerHTML =
    `${where} · attribute <span class="a">$${attribute.toString(16).toUpperCase().padStart(2, '0')}</span> ` +
    `(${attrName})${wipeTiles ? ' · <b>unlit tunnel: tiles wiped</b>' : ''}`;
}

function setMode(mode: 'exterior' | 'interior'): void {
  state.mode = mode;
  btnExterior.setAttribute('aria-pressed', String(mode === 'exterior'));
  btnInterior.setAttribute('aria-pressed', String(mode === 'interior'));
  roomSelect.disabled = mode === 'exterior';
  render();
}

btnExterior.addEventListener('click', () => setMode('exterior'));
btnInterior.addEventListener('click', () => setMode('interior'));

roomSelect.addEventListener('change', () => {
  state.room = Number(roomSelect.value);
  setMode('interior');
});

btnNight.addEventListener('click', () => {
  state.night = !state.night;
  btnNight.setAttribute('aria-pressed', String(state.night));
  render();
});

btnTorch.addEventListener('click', () => {
  state.torch = !state.torch;
  btnTorch.setAttribute('aria-pressed', String(state.torch));
  render();
});

window.addEventListener('keydown', (e) => {
  const step = e.shiftKey ? 4 : 1;
  let handled = true;

  switch (e.key) {
    case 'ArrowLeft':
      state.mapX = clamp(state.mapX - step, 0, MAX_MAP_X);
      break;
    case 'ArrowRight':
      state.mapX = clamp(state.mapX + step, 0, MAX_MAP_X);
      break;
    case 'ArrowUp':
      state.mapY = clamp(state.mapY - step, 0, MAX_MAP_Y);
      break;
    case 'ArrowDown':
      state.mapY = clamp(state.mapY + step, 0, MAX_MAP_Y);
      break;
    case '[':
      state.room = clamp(state.room - 1, 1, roomsData.rooms.length);
      roomSelect.value = String(state.room);
      setMode('interior');
      return;
    case ']':
      state.room = clamp(state.room + 1, 1, roomsData.rooms.length);
      roomSelect.value = String(state.room);
      setMode('interior');
      return;
    default:
      handled = false;
  }

  if (handled) {
    e.preventDefault();
    if (state.mode !== 'exterior') setMode('exterior');
    else render();
  }
});

function fit(): void {
  presenter.resize(window.innerWidth - 48, window.innerHeight - 260);
  render();
}

window.addEventListener('resize', fit);
setMode('exterior');
fit();
