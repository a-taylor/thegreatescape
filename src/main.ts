/**
 * P4 demo: the camp populated -- the hero plus spawned characters.
 *
 * The hero moves through the real path -- input -> animindices -> animation
 * frames -> position -> bounds check -> door handling -- and reaches the screen
 * through render_mask_buffer and plot_masked_sprite, so scenery occludes him
 * rather than the other way round. The map scrolls through move_map rather than
 * by chasing him. Rooms 2, 4 and 9 carry a pushable stove or crate; ten rooms
 * hold an item lying on the floor. Depth order between all of them comes from
 * get_next_drawable, which sorts characters and items into one sequence.
 *
 * The view is positioned the way the game positions it: enter_room ($6900)
 * pins interiors at a constant, reset_outdoor_position ($B2FC) recentres the
 * exterior on the hero.
 *
 * The camp is populated and moving. Characters are spawned and purged around
 * the window; off-screen they walk their routes through move_a_character, one
 * per tick, and on-screen through character_behaviour and animate. Those two
 * are worth knowing about together: character_behaviour compares a vischar with
 * its target and produces an INPUT, and animate feeds that through the same
 * animindices/animation machinery the hero uses. A guard walking to a waypoint
 * and the player walking there run the identical code.
 *
 * Still stubbed, and marked ASSUMPTION where it is: the push trigger, which
 * really lives in `touch`'s collision handling.
 */

import { exteriorTiles, interiorTiles, roomsData, spritesData, decodeBase64 } from './data/load.js';
import { tinyposStash, toTinyPos } from './game/coords.js';
import { INTERIOR_MAP_POSITION } from './game/doors.js';
import { itemDefinitions, itemStructs, type ItemStruct } from './game/items.js';
import {
  characterClass,
  characterStructs,
  type CharacterStruct,
} from './game/characters.js';
import {
  purgeInvisibleCharacters,
  resetVisibleCharacter,
  spawnCharacters,
} from './game/spawn.js';
import {
  VISCHAR_DRAWABLE,
  createVischars,
  isEmpty,
  npcSlots,
} from './game/vischar.js';
import { moveCharacter, nextCharacterIndex } from './game/move.js';
import { prng } from './game/prng.js';
import { characterBehaviour } from './game/behaviour.js';
import { animateVischar, currentFrame } from './game/animate.js';
import {
  HERO_STANDING_HEIGHT,
  animations,
  createHero,
  encodeInput,
  step,
} from './game/hero.js';
import {
  createMovable,
  installMovable,
  movableForRoom,
  pushMovable,
  refreshMovableIso,
  type MovableState,
} from './game/movable.js';
import { chooseGameWindowAttributes } from './render/attributes.js';
import { drawOrder, type Drawable } from './render/drawlist.js';
import { ExteriorView } from './render/exterior.js';
import {
  isoPlacement,
  itemPlacement,
  resetOutdoorPosition,
  windowPlacement,
} from './render/place.js';
import { clippedBufferRow, vischarVisible } from './render/clip.js';
import { MASK_BUFFER_SIZE, plotMaskedSprite } from './render/sprites.js';
import { interiorMasksForRoom, renderMaskBuffer } from './render/maskbuffer.js';
import { fillRoom } from './render/scene.js';
import {
  GameWindowBuffers,
  NO_OFFSET,
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
const btnPause = document.querySelector<HTMLButtonElement>('#pause')!;
const btnStep = document.querySelector<HTMLButtonElement>('#stepframe')!;
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
 * The map position for START, from the game's own rule.
 *
 * reset_outdoor_position ($B2FC) is what the game calls whenever the hero ends
 * up outdoors, so the demo uses it for the initial view too rather than
 * centring by hand.
 */
const START_MAP = resetOutdoorPosition(START);

const hero = createHero({ ...START }, 0, 0);
const view = new ExteriorView(START_MAP.x, START_MAP.y);
const keys = new Set<string>();
let night = false;
let torch = false;
let lastEvent = '';
let windowOffset = NO_OFFSET;

/**
 * Freeze the game loop.
 *
 * Debug scaffolding, not part of the game: the original has no pause. It stops
 * the tick rather than the renderer, so the frame stays exactly as it was --
 * useful for catching a rendering fault mid-motion. `stepOnce` lets a single
 * tick through so a fault can be walked up to one frame at a time.
 */
let paused = false;
let stepOnce = false;
/** The room's stove or crate, if it has one. Occupies vischar slot 1. */
let movable: MovableState | null = null;

/**
 * The eight visible-character slots and the 26 character structs behind them.
 *
 * The structs are live state, not a constant table: spawn_character copies a
 * character out of one into a slot and flags it on-screen, and
 * reset_visible_character copies it back. So they are rebuilt on reset rather
 * than shared.
 */
const vischars = createVischars();
let structs: CharacterStruct[] = characterStructs();

/**
 * The rotating index move_a_character works through ($8217).
 *
 * One character per tick, wrapping at 26 -- so the whole cast advances once
 * every 26 frames. That is why the camp is never quite where you left it.
 */
let moveIndex = 0;

/**
 * Put the view where the game puts it for a given room.
 *
 * Two different rules, and using the wrong one is what corrupted the exterior
 * after stepping outside: enter_room ($6900) pins interiors at a constant
 * (116, 234) and they never scroll, while reset_outdoor_position ($B2FC)
 * recentres the exterior on the hero. Leave the interior value in place
 * outdoors and the renderer walks supertiles from a position far outside the
 * 216x136 map.
 */
function setViewForRoom(room: number, pos: { x: number; y: number; height: number }): void {
  if (room === 0) {
    const m = resetOutdoorPosition(pos);
    view.position.x = m.x;
    view.position.y = m.y;
  } else {
    view.position.x = INTERIOR_MAP_POSITION.x;
    view.position.y = INTERIOR_MAP_POSITION.y;
  }
  // The scroll phase is per-view state; carrying it across a transition makes
  // move_map's shunt and the hero's tile crossings fall out of step.
  view.moveMapY = 0;
  view.gameWindowOffset = NO_OFFSET;
  view.refresh();
  windowOffset = NO_OFFSET;
  // Changing room hands every slot back: reset_visible_character is called for
  // all of them by reset_nonplayer_visible_characters ($69C9).
  for (const v of npcSlots(vischars)) resetVisibleCharacter(v, structs);

  // setup_movable_items runs on both paths ($B326 outdoors, from enter_room
  // indoors); only rooms 2, 4 and 9 have one.
  const item = movableForRoom(room);
  movable = item ? createMovable(item) : null;
  // The movable IS vischar 1 ($697D writes to $8020) -- a complete slot, room
  // and projected position included, not just an occupancy marker.
  if (movable) installMovable(vischars[1]!, movable, room);
  roomSelect.value = String(room);
}

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
      // $E515: the mask buffer is tile-aligned, the sprite is not. Without the
      // sub-tile remainder the occlusion band sits up to 7 pixels off.
      maskRow: clip.topSkip + (iso0.pixelRow & 7),
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
      // $DCD7 adds top_skip alone -- no sub-tile term, because an itemstruct's
      // iso_pos is stored in tile rows and the remainder is always zero.
      maskRow: clip.topSkip,
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
  // Every occupied slot competes in the same depth ordering as the hero --
  // including slot 1 when it holds the room's stove or crate.
  //
  // A slot is only drawn when its DRAWABLE flag is set. touch sets it ($AF97)
  // as part of animating the character, so the flag means "this vischar was
  // animated this tick". Drawing every occupied slot regardless would show
  // characters the game does not.
  //
  // get_next_drawable clears the flag as it plots ($B90A), which works because
  // the original draws exactly once per main-loop iteration. This demo can
  // render the same frame several times -- on pause, on resize, on a toggle --
  // so clearing here would blank every character on the second pass. The flags
  // are cleared at the top of the tick instead, which gives the same result
  // once per frame and leaves render idempotent.
  for (const v of npcSlots(vischars)) {
    if (isEmpty(v)) continue;
    if ((v.counterAndFlags & VISCHAR_DRAWABLE) === 0) continue;
    slots.push({ kind: 'vischar', index: v.slot, pos: v.pos, drawable: true });
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
      continue;
    }
    const v = vischars[d.index];
    if (v && !isEmpty(v)) {
      // mi.sprite is the character class's set; mi.sprite_index is the frame
      // animate left there. A movable's animation is a single zero-delta frame
      // with sprite 0 and no flip, so this works for it unchanged.
      const frame = currentFrame(v);
      plotSpriteAt(v.sprite + v.spriteIndex, v.pos, frame?.flip ?? false);
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

  // Which slots are occupied, and by whom -- the whole point of this
  // checkpoint is watching these fill and empty as the hero moves.
  const occupied = npcSlots(vischars).filter((v) => !isEmpty(v));
  const roster = occupied.length
    ? occupied
        .map((v) => `${v.slot}:${characterClass(v.character)[0]}${v.character}`)
        .join(' ')
    : '—';

  statusEl.innerHTML =
    `pos <b>(${hero.pos.x}, ${hero.pos.y})</b> · tiny (${tiny.x}, ${tiny.y}) · ` +
    `facing <b>${dirNames[hero.direction & 3]}</b>${hero.direction & 4 ? ' crawling' : ''} · ` +
    `${where} · gwo (${windowOffset.low},${windowOffset.high}) · ` +
    `attr <span class="a">$${attribute.toString(16).toUpperCase().padStart(2, '0')}</span><br>` +
    `vischars <b>${occupied.length}/7</b> <span class="a">${roster}</span>` +
    (paused ? ' · <b>PAUSED</b>' : '') +
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
  if (paused && !stepOnce) return;
  stepOnce = false;

  const input = encodeInput(
    keys.has('ArrowUp'),
    keys.has('ArrowDown'),
    keys.has('ArrowLeft'),
    keys.has('ArrowRight'),
  );

  const outcome = step(hero, input, interiorBounds(hero.room));

  // main_loop order: move_a_character ($9D8D), then purge ($9D93), then spawn
  // ($9D96). Purging before spawning matters -- the other way round would let
  // a character spawn and be purged in one frame.
  const random = () => prng.next();

  // $9D8D: one off-screen character walks its route.
  moveIndex = nextCharacterIndex(moveIndex);
  const mover = structs[moveIndex];
  if (mover) moveCharacter(mover, { random });

  // $9D90: follow_suspicious_character loops the seven NPC slots and runs
  // character_behaviour on each, which synthesises an input.
  for (const v of npcSlots(vischars)) {
    if (isEmpty(v)) continue;
    characterBehaviour(v, { random, structs, room: hero.room });
  }

  purgeInvisibleCharacters(vischars, structs, view.position, hero.room);
  spawnCharacters(vischars, structs, view.position, hero.room, { random });

  // $9D9F: animate turns those inputs into movement, through the same
  // animation machinery the hero uses. Slot 0 is skipped -- the demo drives
  // the hero through step() from real keyboard input instead.
  // Clear DRAWABLE before animating, standing in for get_next_drawable's
  // clear-as-it-plots ($B90A). See plotVischars for why it does not happen
  // during rendering.
  for (const v of npcSlots(vischars)) {
    v.counterAndFlags &= ~VISCHAR_DRAWABLE & 0xff;
  }

  // The stove and crate go through this too: movable_item_reset_data gives
  // them anim_wait_tl, a single zero-delta frame, which is how touch comes to
  // set their DRAWABLE flag.
  //
  // The bounds are the SLOT's room, not the hero's. Purge should already have
  // emptied any slot whose room differs, so the two agree in practice -- but
  // bounds_check throws when asked for an interior room without its state, and
  // a throw inside setInterval kills the loop silently. Deriving it per slot
  // removes the dependency on that ordering.
  for (const v of npcSlots(vischars)) {
    if (isEmpty(v)) continue;
    animateVischar(v, { interior: interiorBounds(v.room) });
  }

  // ASSUMPTION: the original triggers this from `touch` (c$AF8F), part of the
  // collision system that lands in P4. Until then the demo uses proximity: if
  // the hero is close to the item on its movable axis, he pushes it.
  if (movable && outcome.moved) {
    const dx = Math.abs((hero.pos.x & 0xff) - movable.pos.x);
    const dy = Math.abs((hero.pos.y & 0xff) - movable.pos.y);
    if (dx <= 6 && dy <= 6) {
      pushMovable(movable, hero.direction & 0x03);
      // purge reads iso_pos, so it has to follow the push ($B71B).
      refreshMovableIso(vischars[1]!);
      lastEvent = `pushed the ${movable.item._label.replace('movable_item_', '')}`;
    }
  }

  // move_map runs once per logic step, after the hero has animated -- the same
  // place the original calls it from ($6939 / $9D7B).
  if (hero.room === 0 && outcome.moved) followHero();

  if (outcome.enteredRoom !== null) {
    lastEvent = outcome.enteredRoom === 0 ? 'stepped outside' : `entered room ${outcome.enteredRoom}`;
    // enter_room ($68F4) fixes the map position for interiors;
    // reset_outdoor_position ($B2FC) recentres it on the hero outdoors. Leave
    // the interior position in place on the way out and the exterior renderer
    // reads supertiles from (116, 234), far off a 216x136 map -- the window
    // fills with whatever that resolves to and never recovers.
    // setViewForRoom also runs setup_movable_items for the new room. It must
    // not be repeated here: a second createMovable would leave `movable` and
    // vischar 1 holding different position objects, so pushes would mutate one
    // while the renderer drew the other, and the stove would look immovable.
    setViewForRoom(outcome.enteredRoom, hero.pos);
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
  // Debug keys. Deliberately not arrow keys or anything the game reads, so
  // they cannot be confused with player input.
  if (e.key === 'p' || e.key === 'P') {
    setPaused(!paused);
    e.preventDefault();
    return;
  }
  if (e.key === '.') {
    if (paused) {
      stepOnce = true;
      tick();
    }
    e.preventDefault();
    return;
  }
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
function setPaused(next: boolean): void {
  paused = next;
  btnPause.setAttribute('aria-pressed', String(paused));
  btnPause.textContent = paused ? 'Resume' : 'Pause';
  btnStep.disabled = !paused;
  render();
}

btnPause.addEventListener('click', () => setPaused(!paused));
btnStep.addEventListener('click', () => {
  if (!paused) return;
  stepOnce = true;
  tick();
});

btnReset.addEventListener('click', () => {
  hero.pos = { ...START };
  hero.room = 0;
  hero.direction = 0;
  setViewForRoom(0, hero.pos);
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
  hero.pos = room === 0 ? { ...START } : spawnInRoom(room);
  setViewForRoom(room, hero.pos);
  lastEvent = '';
  render();
});

/**
 * Start where the game starts: room 2, hut 2 left ($B78F).
 *
 * reset_game also puts the hero to bed -- hero_sleeps ($A489) zeroes his
 * position, sets hero_in_bed and swaps roomdef 2's bed for
 * interiorobject_OCCUPIED_BED, so he is inside the furniture and not drawn.
 * That is deliberately NOT reproduced yet: getting him out again is
 * event_wake_up, which arrives with the day schedule. He stands instead.
 */
const START_ROOM = 2;
hero.room = START_ROOM;
hero.pos = spawnInRoom(START_ROOM);
setViewForRoom(START_ROOM, hero.pos);

function fit(): void {
  presenter.resize(window.innerWidth - 48, window.innerHeight - 260);
  render();
}
window.addEventListener('resize', fit);
fit();
