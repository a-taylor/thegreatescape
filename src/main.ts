/**
 * P4 demo: the camp, populated and on a schedule.
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
 * The day runs on the game's own clock: one step every 64 ticks, wrapping at
 * 140, so 8,960 frames make a day. Each timed event reassigns routes to the
 * ten characters in prisoners_and_guards, walking them to roll call, the mess
 * halls, the exercise yard and back to bed.
 *
 * The speed multiplier and the jump-to-event control are debug scaffolding --
 * the game has neither. Speed runs the logic tick several times per interval
 * rather than changing anything inside it, and the jump winds the clock to the
 * value just BEFORE the event wanted, because dispatch matches on equality and
 * would otherwise step straight over it.
 *
 * Stop steering for 31 ticks and automatics takes over: the hero is driven by
 * character_behaviour from whatever route the schedule last gave him, through
 * the same step() the keyboard uses.
 *
 * Still stubbed, and marked ASSUMPTION where it is: the push trigger, which
 * really lives in `touch`'s collision handling.
 */

import { exteriorTiles, interiorTiles, roomsData, spritesData, decodeBase64 } from './data/load.js';
import { heroMapPosition, tinyposStash, toTinyPos } from './game/coords.js';
import { HOME_ROOM, createPermitted, inPermittedArea } from './game/permitted.js';
import {
  MSG_PRESS_ANY_KEY,
  computeEscapeOutcome,
  drawEscapeString,
  type EscapeOutcome,
} from './ui/ending.js';
import { followSuspiciousCharacter } from './game/pursuit.js';
import {
  BLOCKED_TUNNEL_BOUND,
  INTERIOR_OBJECT_COLLAPSED_TUNNEL,
  ROOM_SOLITARY,
  acceptBribe,
  collision,
  resetMapAndCharacters,
  solitary,
  solitaryPos,
} from './game/jeopardy.js';
import { isItemDiscoverable, itemDiscovered } from './game/discovery.js';
import { FLAGS_PICKING_LOCK, runWorkingTimers } from './game/timers.js';
import {
  STATE_CAUGHT,
  STATE_SEARCHING,
  createSearchlights,
  lightOnScreen,
  nighttime,
  searchlightMaskTest,
  searchlightPlot,
} from './game/searchlight.js';
import timingJson from '../data/timing.json';
import { HERO_RELEASE_ROUTE } from './game/events.js';
import { calcIsoPos } from './game/coords.js';
import { INTERIOR_MAP_POSITION } from './game/doors.js';
import { itemDefinitions, type ItemStruct } from './game/items.js';
import {
  ITEM_NONE,
  allItemStructs,
  createItemState,
  dropItemTail,
  markNearbyItems,
  readItemStruct,
  processPlayerInputFire,
} from './game/inventory.js';
import {
  type ActionContext,
  createJeopardy,
  createLockedDoors,
  itemActions,
} from './game/actions.js';
import { interiorDoorsForRoom } from './game/doors.js';
import { MORALE_MAX, checkMorale, createPlayer, scoreValue } from './game/player.js';
import {
  INTERIOR_OBJECT_OCCUPIED_BED,
  bedObjects,
  blockedTunnelBoundary,
  blockedTunnelObject,
  clearAllBenches,
  clearTunnelBlockage,
  createParcels,
  createRoomPokes,
  heroBedObject,
  isTunnelBlockageCleared,
  pokeBound,
  pokeObject,
} from './game/parcels.js';
import {
  createMessages,
  messageDisplay,
  messageOnScreen,
  messages as messageTable,
  queueMessage,
} from './ui/messages.js';
import { plotScore, setMoraleFlagScreenAttributes, waveMoraleFlag } from './ui/panel.js';
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
import {
  createAutomaticState,
  heroIsAutomatic,
  noteInput,
} from './game/events.js';
import {
  CLOCK_WRAP,
  TICKS_PER_CLOCK,
  createSchedule,
  describeEvent,
  dispatchTimedEvent,
  heroGetsUp,
  heroStandsFromBreakfast,
  setHeroRoute,
  setHeroRouteForce,
  heroSits,
  heroSleeps,
  timedEvents,
} from './game/schedule.js';
import { animateVischar, currentFrame } from './game/animate.js';
import {
  HERO_STANDING_HEIGHT,
  animations,
  createHero,
  INPUT_FIRE,
  encodeInput,
  step,
} from './game/hero.js';
import {
  installMovable,
  movableForRoom,
  movableItemFor,
  pushMovable,
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
const speedSelect = document.querySelector<HTMLSelectElement>('#speed')!;
const eventSelect = document.querySelector<HTMLSelectElement>('#event')!;
const clockEl = document.querySelector<HTMLSpanElement>('#clock')!;
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
// There is no `night` local: day_or_night ($A146) is ONE byte and its owner is
// `schedule`. A second copy here meant the Night button darkened the window
// while the searchlights, which read schedule.night, carried on sleeping.
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

/**
 * escaped ($A51C): set the instant the hero walks off the map edge.
 *
 * The original never returns to the main loop from here -- it waits for a
 * keypress and then jumps straight to reset_game or solitary. `tick()`
 * mirrors that by returning immediately once this is set, so nothing else in
 * the frame runs until `resolveEnding` clears it.
 */
let ending: EscapeOutcome | null = null;

/**
 * Indirection so `tick()`'s early-return guard doesn't narrow `ending` to
 * `null` for the rest of the function -- TypeScript cannot see that
 * `inPermittedArea`'s `onEscaped` callback, several statements later,
 * reassigns it.
 */
function hasEnding(): boolean {
  return ending !== null;
}

/** escaped_press_any_key ($A56E)/keyscan_all ($A58C): resolve the ending screen. */
function resolveEnding(): void {
  if (!ending) return;
  const outcome = ending;
  ending = null;
  if (outcome.resetsGame) resetGame(); // $A581/$A586
  else arrestHero(); // $A589 JP $CB98
  render();
}

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
 * The day schedule, and the frame counter that drives its clock.
 *
 * $9DC5 dispatches a timed event once every 64 iterations of the main loop, so
 * the counter here is the low six bits of the game counter rather than a
 * separate timer.
 */
const schedule = createSchedule();

/**
 * automatics ($C8FE): the game drives the hero when the player does not.
 *
 * Any input postpones it for 31 turns ($9E34); idling counts that down, and at
 * zero character_behaviour takes the wheel using whatever route the day
 * schedule last gave him. So leaving the keyboard alone during roll call walks
 * him to roll call.
 */
const automatic = createAutomaticState();

/**
 * P5 state, each with exactly one owner.
 *
 * `itemState` is the authoritative item_structs array; the shipped table in
 * `items.json` is only its seed. `player` holds morale and score, `messages`
 * the queue and the line being typed, `parcels` the current parcel contents,
 * and `roomPokes` the roomdef bytes the game overwrites (the beds, and the
 * tunnel blockage the shovel clears).
 */
const itemState = createItemState();
const player = createPlayer();
const messages = createMessages();
const parcels = createParcels();
const roomPokes = createRoomPokes();
const queueGameMessage = (index: number, c = 0) => queueMessage(messages, index, c);

/**
 * The panel's own display file.
 *
 * See render() -- the game keeps the panel in screen memory permanently, and
 * this demo rebuilds the screen each frame, so the two are reconciled by
 * letting the panel accumulate here and copying it in.
 */
const panelScreen = new SpectrumScreen();

/**
 * The demo's "fire" key.
 *
 * Debug scaffolding: the real game has no fixed key here at all -- choose_keys
 * ($F2A7) lets the player define all five, which is P7. Space is chosen so
 * that fire + an arrow is reachable one-handed.
 */
const FIRE_KEY = ' ';

/** saved_pos ($81A4), which use_item fills before dispatching ($7B0A). */
const savedPos = { x: 0, y: 0, height: 0 };

/**
 * The jeopardy bytes ($A145, $AF8E, $A143), with ONE owner.
 *
 * The action handlers write them and P6 reads them back a frame later, so
 * they cannot live on a context object rebuilt per call.
 */
const jeopardy = createJeopardy();

/** item_structs[item_FOOD] ($76F9), as the dog-food pursuit reads it. */
const ITEM_FOOD_INDEX = 7;
function foodItemState() {
  const s = readItemStruct(itemState, ITEM_FOOD_INDEX);
  return { nearby: s.nearby, x: s.pos.x, y: s.pos.y };
}

/** locked_doors ($F05D), mutable: action_key clears bit 7 in it. */
const lockedDoors = createLockedDoors();

/** The hero's sprite set, which IS the uniform ($B3E1 / $7B96). */
let heroSprite: 'prisoner' | 'guard' = 'prisoner';

/**
 * The context the action handlers need, rebuilt per command.
 *
 * Cheap, and it keeps the handlers reading live values rather than a snapshot
 * taken when the demo started.
 */
function actionContext(): ActionContext {
  return {
    items: itemState,
    player,
    room: hero.room,
    hero: heroSlot,
    // $81B8, the HERO's tinypos -- not map_position ($81BB), the view scroll.
    mapPosition: heroMapPosition(hero.pos, hero.room === 0),
    savedPos,
    vischars,
    interiorDoors: hero.room === 0 ? [] : interiorDoorsForRoom(hero.room),
    lockedDoors,
    redCrossParcelContents: parcels.contents,
    jeopardy,
    queueMessage: queueGameMessage,
    dropItemTail: (item) => dropItemTail(itemState, item, hero.room, hero.pos),
    setHeroSprite: (sprite) => { heroSprite = sprite; },
    heroSpriteIsGuard: () => heroSprite === 'guard',
    refreshRoom: () => { render(); },
    clearTunnelBlockage: () => clearTunnelBlockage(roomPokes),
    isTunnelBlockageCleared: () => isTunnelBlockageCleared(roomPokes),
    // P6 owns both of these; the handlers only need to be able to call them.
    solitary: () => { lastEvent = 'solitary (P6)'; },
    transitionOutsideMainGate: () => { lastEvent = 'out of the gate (P6)'; },
  };
}

/** attribute_WHITE_OVER_BLACK, what the screen clear leaves ($F266 LD (HL),$07). */
const PANEL_ATTRIBUTE = 0x07;

/**
 * in_permitted_area's state ($A138 red_flag, plus the flag's own colour).
 *
 * The colour is not decoration: red_flag is what P6's guards read to decide
 * whether to chase the hero. It is kept here rather than derived from the
 * screen because the original reads the attribute back out of the display file
 * ($9FFA) and this demo repaints attributes every frame.
 */
const permitted = createPermitted();

/**
 * follow_suspicious_character's own state: the poisoned-food countdown
 * ($C891) and whether the bell is ringing perpetually ($A130 == 0).
 */
const pursuitState = { foodDiscoveredCounter: 0, bellRingingPerpetually: false };

/** in_solitary ($A13A) and the global current door ($68A1). */
const solitaryState = { inSolitary: false, currentDoor: -1 };

/** searchlight_shape ($AF3E), 16 rows of 2 bytes. */
const searchlightShape = decodeBase64(
  (timingJson as unknown as { searchlightShape: { data: string } }).searchlightShape.data,
);

/** The three searchlights and searchlight_state ($81BD). */
const searchlights = createSearchlights();
/** Which lights nighttime wants drawn this frame, for the debug readout. */
let litBySearchlight: ReturnType<typeof nighttime> = [];

/** solitary ($CB98): everything the arrest writes, in one place. */
/**
 * charevnt_hero_release's effects on the HERO ($C852 / $C859).
 *
 * Forced, not the ordinary set_hero_route: he is in solitary at this moment,
 * and $A33F would refuse. Without this he never gets route 37, so
 * charevnt_solitary_ends never fires and in_solitary is never cleared.
 */
function releaseHero(): void {
  automatic.counter = 0; // $C853 -- $A139, the byte heroIsAutomatic reads
  setHeroRouteForce(
    { structs, vischars, random: () => prng.next(), room: hero.room, hero: heroSlot, heroPos: hero.pos },
    HERO_RELEASE_ROUTE.index,
    HERO_RELEASE_ROUTE.step,
  );
  lastEvent = 'the commandant lets him out';
}

/** $B7B9, $B7D4, $B7DD: the part of reset_map_and_characters shared by every caller. */
function restoreRoomObjects(): void {
  for (const bed of bedObjects) {
    pokeObject(roomPokes, bed, INTERIOR_OBJECT_OCCUPIED_BED); // $B7D4
  }
  pokeObject(roomPokes, heroBedObject, INTERIOR_OBJECT_OCCUPIED_BED);
  clearAllBenches(roomPokes); // $B7DD
  pokeObject(roomPokes, blockedTunnelObject, INTERIOR_OBJECT_COLLAPSED_TUNNEL); // $B7B9
  pokeBound(roomPokes, blockedTunnelBoundary, BLOCKED_TUNNEL_BOUND); // $B7BE
}

function arrestHero(): void {
  solitary(solitaryState, {
    hero: heroSlot,
    items: itemState,
    player,
    vischars,
    structs,
    queueMessage: queueGameMessage,
    discoverItem: (item) => {
      if (item !== 0xff) itemDiscovered(itemState, player, item, queueGameMessage);
    },
    silenceBell: () => { pursuitState.bellRingingPerpetually = false; },
    // $CBF3 -> reset_map_and_characters ($B79B), which is far more than
    // resetting the cast -- see resetMapAndCharacters.
    resetCast: () => {
      resetMapAndCharacters({
        vischars,
        structs,
        hero: heroSlot,
        schedule,
        lockedDoors,
        resetVisible: (v) => resetVisibleCharacter(v, structs),
        restoreRoomObjects,
      });
    },
    forceAutomatic: () => { automatic.counter = 0; }, // $CC16
    transitionToSolitary: () => {
      // $CC2E transitions to solitary_pos. The demo's view follows the room.
      hero.room = ROOM_SOLITARY;
      hero.pos = {
        x: solitaryPos[0]!,
        y: solitaryPos[1]!,
        height: solitaryPos[2]!,
      };
      setViewForRoom(ROOM_SOLITARY, hero.pos);
    },
  });
  lastEvent = 'ARRESTED -- solitary';
}

/**
 * reset_game ($B75A): the routine that also boots the game from the menu
 * ($F163) and restarts it after morale runs out ($9DE5).
 *
 * The sixteen item_discovered calls and the message-queue reset at the top
 * ($B75D/$B765) have no OBSERVABLE effect of their own here: every message
 * they queue is discarded three lines later when the queue pointer is reset
 * again, and every morale point they cost is overwritten by the unconditional
 * $70 two lines after that. What survives is item_discovered's other job --
 * putting each item back at its default location -- so this recreates item
 * state from scratch rather than replaying calls whose visible effects never
 * reach the screen.
 */
function resetGame(): void {
  const freshItems = createItemState();
  itemState.structs.set(freshItems.structs);
  itemState.held[0] = freshItems.held[0]!;
  itemState.held[1] = freshItems.held[1]!;

  const freshMessages = createMessages();
  messages.queue.set(freshMessages.queue);
  messages.pointer = freshMessages.pointer;
  messages.delay = freshMessages.delay;
  messages.displayIndex = freshMessages.displayIndex;
  messages.messageIndex = freshMessages.messageIndex;
  messages.charIndex = freshMessages.charIndex;

  // $B76B: everyone back at spawn, clock to 7, night off, hero flags clear,
  // doors re-locked, beds/benches/tunnel restored.
  resetMapAndCharacters({
    vischars,
    structs,
    hero: heroSlot,
    schedule,
    lockedDoors,
    resetVisible: (v) => resetVisibleCharacter(v, structs),
    restoreRoomObjects,
  });

  // $B772..$B77B: score, hero_in_breakfast, red_flag, automatic_player_counter,
  // in_solitary and morale_exhausted are one contiguous ten-byte region in the
  // original; here they are five separate owners, all zeroed together.
  player.score.fill(0);
  schedule.heroInBreakfast = false;
  permitted.redFlag = false;
  automatic.counter = 0;
  solitaryState.inSolitary = false;
  player.moraleExhausted = false;
  player.morale = MORALE_MAX; // $B77B

  heroSprite = 'prisoner'; // $B789
  hero.room = HOME_ROOM; // $B78F
  heroSlot.room = HOME_ROOM;
  heroSleeps(schedule, heroSlot, hero.pos, roomPokes); // $B794
  setViewForRoom(HOME_ROOM, hero.pos); // $B797 enter_room

  lastEvent = '';
}

/** hero_map_position ($81B8), maintained by in_permitted_area. */
const heroMapPos = { x: 0, y: 0, height: 0 };

/**
 * The hero's own vischar, slot 0.
 *
 * It holds his route, target and flags -- the fields character_behaviour needs
 * and the day schedule writes. His POSITION stays in `hero`, because step()
 * rebinds it and a shared reference would break the way the stove's did.
 */
const heroSlot = vischars[0]!;
heroSlot.character = 0;
heroSlot.flags = 0;
let frameCounter = 0;
/**
 * Debug only: how many logic ticks to run per interval, as a multiplier of
 * TICK_MS. Not in the game -- see TICK_MS for why 1x is a guess rather than
 * a citation, which is what the fractional options below are compensating
 * for.
 */
let speed = 1;
/** Carries a fractional tick across intervals when speed < 1. */
let speedAccumulator = 0;

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
  // indoors); only rooms 2, 4 and 9 have one. The movable IS vischar 1 ($697D
  // writes to $8020) -- there is no parallel object, so nothing can drift.
  const item = movableForRoom(room);
  if (item) installMovable(vischars[1]!, item, room);
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
 * The hero's own copy of that mask, for searchlight_mask_test.
 *
 * In the original the test runs INSIDE plot_sprites, between render_mask_buffer
 * and the sprite plotter ($B873..$B87B). Here it cannot: the test DECREMENTS
 * searchlight_state, and this demo re-renders on pause, resize and every
 * toggle, so running it during the draw would count a paused frame down to
 * nothing. Instead the draw snapshots the buffer -- a pure copy, safe to repeat
 * -- and the tick consumes it exactly once, after render().
 */
const heroForeground = new Uint8Array(MASK_BUFFER_SIZE);
/** Whether the hero survived vischar_visible this frame, i.e. was drawn. */
let heroPlotted = false;

/**
 * Plot any sprite at a world position through the full masked path.
 *
 * Shared by the hero and by the movable items, which the game likewise treats
 * as vischars -- they occupy the second visible character slot.
 *
 * @returns true if the sprite was actually plotted, i.e. it survived
 *   vischar_visible. The searchlight mask test needs to know, because
 *   plot_sprites only reaches $B87B for a vischar it is drawing.
 */
function plotSpriteAt(
  spriteIndex: number,
  pos: { x: number; y: number; height: number },
  flip: boolean,
): boolean {
  const record = spritesData.sprites[spriteIndex];
  if (!record) return false;

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
  if (!clip.visible) return false;

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
  return true;
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
  // Read through the single owner, never itemStructs(): that decodes the
  // SHIPPED table, so calling it per frame would resurrect anything the hero
  // had picked up. CLAUDE.md's "one game field, two objects" hazard.
  const here = allItemStructs(itemState).filter((s) => !s.nowhere && s.room === hero.room);
  const items: Drawable[] = here.map((s) => ({
    kind: 'item',
    index: s.index,
    pos: { x: s.pos.x * 8, y: s.pos.y * 8, height: s.pos.height * 8 },
    drawable: true,
  }));

  // Cleared before the scan, not after: if the hero is off-window this frame
  // plot_sprites never reaches him, and a stale true would let the searchlight
  // test run on last frame's mask.
  heroPlotted = false;

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
      heroPlotted = frame
        ? plotSpriteAt(PRISONER_SPRITE_BASE + frame.sprite, hero.pos, frame.flip)
        : false;
      // $B873: the buffer render_mask_buffer just filled is the hero's. Keep
      // it for the searchlight test the tick runs after this render.
      if (heroPlotted) heroForeground.set(foreground);
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

/** The two held-item slots, for the debug line. Item names are not in the data. */
function heldLabel(): string {
  const names = [...itemState.held].map((i) => (i === ITEM_NONE ? '—' : `#${i}`));
  return names.join(' ');
}

function render(): void {
  const itemsHeld: [number, number] = torch ? [4, 0xff] : [0xff, 0xff];
  const { attribute, wipeTiles } = chooseGameWindowAttributes(hero.room, schedule.night, itemsHeld);

  if (wipeTiles) {
    buffers.wipeTiles();
  } else if (hero.room === 0) {
    view.render(buffers);
  } else {
    // The poke overlay carries the runtime roomdef writes -- occupied beds,
    // seated prisoners, the cleared tunnel blockage. Without it they are
    // recorded and never drawn.
    fillRoom(buffers, hero.room, roomPokes);
  }

  buffers.expandTiles(hero.room === 0 ? exteriorTiles() : interiorTiles());

  // Order matters and matches the original: plot_sprites composites into
  // window_buf, and only then does plot_game_window blit the buffer to the
  // display. Drawing the sprite after the blit writes into a buffer nobody
  // reads again this frame.
  // The hero is drawn in rooms as well as outdoors -- only an unlit tunnel
  // suppresses everything.
  if (!wipeTiles) plotVischars();

  // The panel is PERSISTENT screen memory in the original: the score, the
  // morale flag and the message line are poked into the display file and stay
  // there until something overwrites them. This demo clears and rebuilds the
  // whole screen every frame, so the panel accumulates on its own display and
  // is copied in first; the game window is then blitted over the middle of it.
  // Same pixels on screen, different bookkeeping -- see CLAUDE.md on the
  // renderer running more than once per frame.
  // $F266: the game's own screen clear sets every attribute to $07, white
  // over black, and only then paints the flag green and the game window its
  // chosen colour. Clearing to zero instead leaves black ink on black paper,
  // which draws the score and the message line perfectly and invisibly.
  screen.clear(0x00, PANEL_ATTRIBUTE);
  screen.display.set(panelScreen.display);
  plotGameWindow(screen, buffers, hero.room === 0 ? windowOffset : NO_OFFSET);
  setWindowAttributes(screen, attribute);

  // $AE69: the searchlights paint OVER the window attributes, so they go on
  // after set_game_window_attributes rather than before it.
  for (const light of litBySearchlight) {
    // Searchlight positions are in MAP space; convert to screen attribute
    // cells and drop the ones off-window ($AE22..$AE53).
    const at = lightOnScreen(light, view.position);
    if (!at) continue;
    searchlightPlot(at, searchlightShape, at.clipLeft, (col, row, attr) => {
      screen.setAttribute(col, row, attr);
    });
  }

  // plot_score and the flag attributes are re-run every frame rather than
  // being part of the persistent panel: the score digits change in place and
  // the attributes are cleared by screen.clear.
  plotScore(screen, player);
  setMoraleFlagScreenAttributes(screen, permitted.flagAttribute);
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
  // P6 debug scaffolding: the pursuit mode each slot is in, which is the
  // thing to watch when the camp is meant to be reacting.
  const modeName = (f: number) =>
    f === 1 ? '!' : f === 2 ? '?' : f === 3 ? 'f' : f === 4 ? 'b' : '';
  const roster = occupied.length
    ? occupied
        .map(
          (v) =>
            `${v.slot}:${characterClass(v.character)[0]}${v.character}` +
            modeName(v.flags),
        )
        .join(' ')
    : '—';

  const next = timedEvents
    .filter((e) => e.clock > schedule.clock)
    .sort((a, b) => a.clock - b.clock)[0] ?? timedEvents[0]!;
  clockEl.textContent =
    `clock ${schedule.clock}/${CLOCK_WRAP} · ` +
    `${schedule.night ? 'night' : 'day'} · ` +
    // describeEvent, not the raw label: four of the fifteen timed_events
    // labels name the opposite of what the handler does. $A202 is called
    // event_breakfast_time and is end_of_breakfast.
    `next: ${describeEvent(next)} at ${next.clock}`;

  statusEl.innerHTML =
    `pos <b>(${hero.pos.x}, ${hero.pos.y})</b> · tiny (${tiny.x}, ${tiny.y}) · ` +
    `facing <b>${dirNames[hero.direction & 3]}</b>${hero.direction & 4 ? ' crawling' : ''} · ` +
    `${where} · gwo (${windowOffset.low},${windowOffset.high}) · ` +
    `attr <span class="a">$${attribute.toString(16).toUpperCase().padStart(2, '0')}</span><br>` +
    `vischars <b>${occupied.length}/7</b> <span class="a">${roster}</span> · ` +
    // P5: morale, the flag's lagging copy, the score, and what is on the
    // message line. Debug scaffolding -- the game shows all four graphically.
    `morale <b>${player.morale}</b>/${MORALE_MAX} (flag ${player.displayedMorale}) · ` +
    `<b>${permitted.redFlag ? 'RED' : 'green'}</b> flag · ` +
    // Who is driving the hero. $A139 counts down while idle and the CPU takes
    // over at zero; solitary and the red flag override it. Shown because a
    // hero the player cannot steer is otherwise indistinguishable from a hero
    // who is stuck.
    `<b>${heroIsAutomatic(automatic) ? 'CPU' : 'player'}</b>` +
    `(${automatic.counter}${solitaryState.inSolitary ? ',solitary' : ''}` +
    `${pursuitState.bellRingingPerpetually ? ',BELL' : ''}) · ` +
    // The searchlights: how many are sweeping, and whether one has him.
    // The counter is the interesting number: 255 sweeping, 31 on him, and
    // 30..0 counting down the frames he has stayed out of sight.
    (schedule.night
      ? `<b>${
          searchlights.state === STATE_SEARCHING
            ? 'lights'
            : searchlights.state === STATE_CAUGHT
              ? 'CAUGHT'
              : `hiding ${searchlights.state}`
        }</b>(${litBySearchlight.length}) · `
      : '') +
    `score <b>${String(scoreValue(player)).padStart(5, '0')}</b> · ` +
    `held ${heldLabel()}` +
    (messageOnScreen(messages) ? ` · msg "<b>${messageTable[messages.messageIndex]!.text}</b>"` : '') +
    (schedule.heroInBed ? ' · <b>IN BED</b> (press an arrow)' : '') +
    (schedule.heroInBreakfast ? ' · <b>AT BREAKFAST</b>' : '') +
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
  if (hasEnding()) return; // frozen on the escape screen; see resolveEnding.

  let input = encodeInput(
    keys.has('ArrowUp'),
    keys.has('ArrowDown'),
    keys.has('ArrowLeft'),
    keys.has('ArrowRight'),
    keys.has(FIRE_KEY),
  );

  const random = () => prng.next();

  // $9DB4..$9DB8: the searchlights only run at night. Once one has him it
  // stops sweeping and tracks him until he gets indoors, which is the only
  // thing that shakes it off.
  litBySearchlight =
    schedule.night
      ? nighttime(searchlights, {
          room: hero.room,
          mapPosition: view.position,
          player,
          ringBell: () => { pursuitState.bellRingingPerpetually = true; }, // $AEB0
        })
      : [];

  // $9E07..$9E0D: process_player_input returns IMMEDIATELY when in_solitary
  // or morale_exhausted is set -- the original loads both bytes at once
  // ($A13A/$A13B are adjacent) and bails on either. That inhibits the WHOLE
  // input path: no movement, no getting out of bed, no item commands. Without
  // it the player steers himself out of the solitary cell and the release
  // chain never completes.
  const inputInhibited = solitaryState.inSolitary || player.moraleExhausted;
  if (inputInhibited) input = 0;

  // $9E0E..$9E1F: if the hero is picking a lock or cutting wire, that branch
  // takes the WHOLE frame instead of the ordinary input path -- which is what
  // "locks out player controls" means. It also feeds him inputs of its own
  // over the last three turns of a cut, to walk him through the gap.
  const working = runWorkingTimers(
    {
      gameCounter: player.gameCounter,
      lockedOutUntil: jeopardy.playerLockedOutUntil,
      hero: heroSlot,
      lockedDoors,
      doorBeingLockpicked: jeopardy.doorBeingLockpicked,
      queueMessage: queueGameMessage,
    },
    (turns) => { automatic.counter = turns; }, // $9E18
  );
  if (working) {
    input = 0;
    lastEvent = heroSlot.flags & FLAGS_PICKING_LOCK ? 'picking the lock' : 'cutting the wire';
  }

  // $9E86: `CP $09 / JR C` -- anything below 9 has no fire and takes the
  // ordinary movement path. With fire, the item commands run and the input
  // then becomes input_KICK ($9E8D), which carries no direction, so the hero
  // does NOT also walk. Passing the raw value on would move him, because
  // lookupAnimation takes `input % 9` and fire+up would read as plain up.
  const command = processPlayerInputFire(itemState, input, {
    player,
    room: hero.room,
    mapPosition: heroMapPosition(hero.pos, hero.room === 0),
    heroPos: hero.pos,
    savedPos,
    actions: itemActions(actionContext()),
    // $7B96: dropping the uniform puts the prisoner sprite back.
    onUniformRemoved: () => { heroSprite = 'prisoner'; },
  });
  if (command) {
    lastEvent =
      command.item < 0
        ? `${command.command}: nothing`
        : `${command.command}: item ${command.item}`;
  }
  // input_KICK ($9E8D): a sprite refresh with no direction bits.
  const moveInput = input >= INPUT_FIRE ? 0 : input;

  // $9E37..$9E5C: the first keypress gets the hero out of bed, or up off the
  // breakfast bench, rather than being treated as movement. Both branches poke
  // the furniture back to its empty graphic ($9E78 / $9E55) -- skip that and
  // he walks away leaving a seated copy of himself behind.
  if (input !== 0 && schedule.heroInBed) {
    heroGetsUp(schedule, heroSlot, hero.pos, roomPokes);
    hero.room = 2;
    lastEvent = 'got out of bed';
  } else if (input !== 0 && schedule.heroInBreakfast) {
    heroStandsFromBreakfast(schedule, heroSlot, hero.pos, roomPokes);
    lastEvent = 'stood up from breakfast';
  }

  // $9E22..$9E35: input resets the automatic counter, idleness counts it down.
  noteInput(automatic, input);

  // $C910: when the counter reaches zero character_behaviour supplies the
  // input instead of the keyboard. It SUPPLIES one -- it does not make a
  // second move. Stepping twice in a frame doubles the hero's speed while
  // move_map still scrolls once, so he walks straight out of the window and
  // the scroll phase desynchronises, which is the whole class of bug P3 spent
  // its time on.
  let effectiveInput = moveInput;
  /** Set when target_reached took the automatic hero through a door. */
  let autoEnteredRoom: number | null = null;
  if (heroIsAutomatic(automatic)) {
    // character_behaviour reads mi.pos and room, and writes input, target and
    // flags. A one-way copy in is safe; a shared reference would not be, since
    // step() rebinds hero.pos.
    heroSlot.pos = { ...hero.pos };
    heroSlot.room = hero.room;
    // counter_and_flags has to travel BOTH ways. It is one byte in the game --
    // vischar 0's -- written by bounds_check when a move is refused ($B1AF)
    // and read by character_behaviour to decide which axis to try first
    // ($C9E1). Split across two objects, the Y_DOMINANT alternation never
    // reaches the behaviour code: the hero picks one direction, walks into a
    // wall and presses against it forever instead of sliding along it.
    heroSlot.counterAndFlags = hero.counterAndFlags;
    const behaviour = characterBehaviour(heroSlot, {
      random,
      structs,
      room: hero.room,
      pokes: roomPokes,
    });
    hero.counterAndFlags = heroSlot.counterAndFlags;
    effectiveInput = heroSlot.input & 0x0f;

    // $C83F charevnt_solitary_ends: the ONLY thing that ever clears
    // in_solitary ($A13A). Without it the hero is released from the cell,
    // wanders off on the WANDER route the event gave him, and stays there --
    // the day schedule cannot reroute him ($A343) and the player cannot steer
    // him ($9E0A), so he circles the courtyard forever.
    if (behaviour.event === 'solitaryEnds') {
      solitaryState.inSolitary = false;
      lastEvent = 'released from solitary';
    }

    // hero_sits / hero_sleeps ($A47F / $A489) halt the route and zero the
    // position so he is inside the bench or bed. The caller owns his position,
    // so this half happens here.
    if (behaviour.event === 'heroSits') {
      heroSits(schedule, heroSlot, hero.pos, roomPokes);
      lastEvent = 'sat down to breakfast';
    } else if (behaviour.event === 'heroSleeps') {
      heroSleeps(schedule, heroSlot, hero.pos, roomPokes);
      lastEvent = 'went to bed';
    }

    // target_reached may have walked him through a door ($CAF8 -> transition).
    // That is the AUTOMATIC door path; the player's goes through door_handling
    // inside step(), and $AFA3 makes the two mutually exclusive. Copy the
    // result back, or it is discarded on the next frame's copy in and he
    // stands at the doorway forever.
    //
    // Keyed on the transition having HAPPENED, not on the room having changed.
    // The exercise-yard gates (door pairs 0 and 1) have both halves outdoors:
    // passing through moves the hero from one side of the fence to the other
    // with the room index unchanged. Comparing rooms throws that away, and
    // since the fence blocks the direct path he then presses against it until
    // the next timed event -- with no way round, because his target is aligned
    // on x and the Y_DOMINANT alternation has nothing to alternate to.
    if (behaviour.enterRoom !== null) {
      autoEnteredRoom = behaviour.enterRoom;
      hero.room = heroSlot.room;
      hero.pos = { ...heroSlot.pos };
    }
  }

  const outcome = step(hero, effectiveInput, interiorBounds(hero.room), {
    doorHandling: !heroIsAutomatic(automatic),
  });

  // main_loop order: move_a_character ($9D8D), then purge ($9D93), then spawn
  // ($9D96). Purging before spawning matters -- the other way round would let
  // a character spawn and be purged in one frame.
  // $9D8D: one off-screen character walks its route.
  moveIndex = nextCharacterIndex(moveIndex);
  const mover = structs[moveIndex];
  if (mover) moveCharacter(mover, { random, pokes: roomPokes, onHeroRelease: releaseHero });

  // $9D90: follow_suspicious_character loops the seven NPC slots and runs
  // character_behaviour on each, which synthesises an input.
  for (const v of npcSlots(vischars)) {
    if (isEmpty(v)) continue;
    characterBehaviour(v, {
      random,
      structs,
      room: hero.room,
      pokes: roomPokes,
      onHeroRelease: releaseHero,
      // The pursuit modes steer by these rather than by a route.
      heroMapPosition: heroMapPos,
      automaticPlayerCounter: automatic.counter,
      foodItem: foodItemState(),
      bribedCharacter: jeopardy.bribedCharacter,
      vischars,
    });
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
  const stove = vischars[1]!;
  const stoveItem = movableItemFor(stove.character);
  if (stoveItem && outcome.moved) {
    const dx = Math.abs((hero.pos.x & 0xff) - stove.pos.x);
    const dy = Math.abs((hero.pos.y & 0xff) - stove.pos.y);
    if (dx <= 6 && dy <= 6) {
      pushMovable(stove, hero.direction & 0x03);
      lastEvent = `pushed the ${stoveItem._label.replace('movable_item_', '')}`;
    }
  }

  // move_map runs once per logic step, after the hero has animated -- the same
  // place the original calls it from ($6939 / $9D7B).
  if (hero.room === 0 && outcome.moved) followHero();

  const enteredRoom = outcome.enteredRoom ?? autoEnteredRoom;
  if (enteredRoom !== null) {
    lastEvent = enteredRoom === 0 ? 'stepped outside' : `entered room ${enteredRoom}`;
    // enter_room ($68F4) fixes the map position for interiors;
    // reset_outdoor_position ($B2FC) recentres it on the hero outdoors. Leave
    // the interior position in place on the way out and the exterior renderer
    // reads supertiles from (116, 234), far off a 216x136 map -- the window
    // fills with whatever that resolves to and never recovers.
    // setViewForRoom also runs setup_movable_items for the new room.
    setViewForRoom(enteredRoom, hero.pos);
  } else if (outcome.lockedDoor !== null) {
    lastEvent = 'THE DOOR IS LOCKED';
  } else if (outcome.blocked) {
    lastEvent = 'blocked';
  } else if (moveInput !== 0) {
    // moveInput, not input: a fire command carries no movement ($9E8D turns it
    // into input_KICK), so there is no "moved and nothing happened" to report
    // and clearing here would wipe the command's own message.
    lastEvent = '';
  }

  // $9F21: in_permitted_area, which maintains hero_map_position, decides the
  // morale flag's colour and can put the hero back on his route. Runs before
  // the panel because wave_morale_flag draws the flag it just recoloured.
  heroSlot.pos = { ...hero.pos };
  // The escape check reads vischar.iso_pos ($8018/$801A), which is
  // calc_vischar_iso_pos_from_state -- not the item projection.
  heroSlot.isoPos = calcIsoPos(hero.pos);
  inPermittedArea(permitted, {
    room: hero.room,
    clock: schedule.clock,
    inSolitary: solitaryState.inSolitary, // $A13A
    hero: heroSlot,
    mapPosition: heroMapPos,
    setHeroRoute: (index, step) => {
      setHeroRoute(
        {
          structs,
          vischars,
          random,
          room: hero.room,
          hero: heroSlot,
          heroPos: hero.pos,
          // $A343: set_hero_route does nothing in solitary. Omit this and the
          // day schedule walks him straight back out of the cell.
          inSolitary: solitaryState.inSolitary,
        },
        index,
        step,
      );
    },
    onEscaped: () => {
      ending = computeEscapeOutcome(itemState.held); // $A51C escaped
      lastEvent = ending.won ? 'ESCAPED' : 'RECAPTURED';
    },
    silenceBell: () => { /* the bell arrives with P7's audio */ },
  });

  if (ending) {
    // $A51F..$A571: print every line, then wait for a key. The original does
    // this over a freshly zoomboxed scene ($A50B screen_reset); this demo
    // renders the current one instead of reproducing that transition.
    render();
    for (const line of ending.lines) drawEscapeString(screen, line);
    drawEscapeString(screen, MSG_PRESS_ANY_KEY);
    // render() already presented this frame; the text drawn since needs its
    // own present, or it never reaches the canvas.
    presenter.present(screen);
    return;
  }

  // $A138 is ONE game byte. in_permitted_area writes it and automatics reads
  // it; copied across explicitly here rather than left as two fields that
  // drift, per CLAUDE.md's "one game field, one owner".
  automatic.redFlag = permitted.redFlag;
  // $A13A likewise: solitary writes it, automatics and set_hero_route read it.
  automatic.inSolitary = solitaryState.inSolitary;

  // $9D90: follow_suspicious_character. Sets the pursuit flags that
  // character_behaviour then acts on, so it runs BEFORE the NPC behaviour
  // pass below.
  const followed = followSuspiciousCharacter(
    vischars,
    {
      room: hero.room,
      redFlag: permitted.redFlag,
      automaticPlayerCounter: automatic.counter,
      heroMapPosition: heroMapPos,
      heroInUniform: heroSprite === 'guard',
      items: itemState,
    },
    pursuitState,
    {
      checkItemDiscoverable: () => {
        const found = isItemDiscoverable(itemState, hero.room);
        if (found >= 0) itemDiscovered(itemState, player, found, queueGameMessage);
      },
      foodExpired: () => {
        itemDiscovered(itemState, player, ITEM_FOOD_INDEX, queueGameMessage);
      },
    },
  );
  if (followed.ringBell) pursuitState.bellRingingPerpetually = true;

  // $AFC0: collision, for each moving NPC against the hero. A PURSUING
  // character that reaches him is the arrest ($B06E); the one who took the
  // bribe becomes a decoy instead ($B063).
  if (!solitaryState.inSolitary) {
    for (const v of npcSlots(vischars)) {
      if (isEmpty(v)) continue;
      const outcome = collision(v, { ...v.pos }, vischars, jeopardy.bribedCharacter);
      if (outcome.kind === 'arrest') {
        arrestHero();
        break;
      }
      if (outcome.kind === 'bribe') {
        acceptBribe(v, vischars, itemState, player, queueGameMessage);
        jeopardy.bribedCharacter = 0xff;
        lastEvent = 'took the bribe';
        break;
      }
    }
  }

  // $DB9E: recompute which items are near enough to draw and to pick up. Runs
  // every iteration in the main loop, and reads map_position ($81BB) -- the
  // view scroll -- unlike the pick-up range check, which reads the hero's own
  // position.
  markNearbyItems(itemState, view.position, hero.room);

  // $9D7B's own order: wave_morale_flag first -- it is what advances the game
  // counter, so it has to run every tick even when nothing is moving -- then
  // message_display, then check_morale.
  //
  // These write straight into the display file rather than into the window
  // buffer, and render() clears the screen before blitting, so they are
  // redrawn from render() as well. Only the STATE advances here.
  waveMoraleFlag(panelScreen, player);
  messageDisplay(messages, panelScreen);
  checkMorale(player, queueGameMessage, () => { automatic.counter = 0; }); // $9DE1

  // $9DC5..$9DCA: dispatch a timed event once every 64 iterations. The counter
  // is the game counter's low six bits, not a timer of its own.
  frameCounter = (frameCounter + 1) & 0xff;
  if ((frameCounter & (TICKS_PER_CLOCK - 1)) === 0) {
    const fired = dispatchTimedEvent(schedule, {
      structs,
      vischars,
      random,
      room: hero.room,
      hero: heroSlot,
      heroPos: hero.pos,
      inSolitary: solitaryState.inSolitary, // $A343
      player,
      items: itemState,
      parcels,
      roomPokes,
      queueMessage: queueGameMessage,
    });
    if (fired) {
      lastEvent = fired.note ? `${fired.event} (${fired.note})` : fired.event;
    }
    syncNightButton();
  }

  render();

  // $B876..$B87B: plot_sprites tests the mask buffer for each vischar it draws
  // while a light has the hero, and searchlight_mask_test itself ignores every
  // slot but his. Eight fully-zero rows mean scenery covers him and the
  // counter drops; anything non-zero means he is still exposed and it snaps
  // back to CAUGHT. Run here rather than inside render() so a paused or
  // resized frame cannot count it down -- see heroForeground.
  if (schedule.night && heroPlotted && searchlights.state !== STATE_SEARCHING) {
    if (searchlightMaskTest(searchlights, heroForeground)) {
      // $B859: the light gave up. The window attributes it had overwritten are
      // recomputed, which here means simply drawing the next frame without the
      // beam -- chooseGameWindowAttributes already runs every render.
      lastEvent = 'lost the searchlight';
    }
  }
}

/**
 * The original has no fixed tick rate at all: main_loop ($9D7B) disables
 * interrupts at boot and just free-runs, paced only by how long each
 * iteration takes to execute -- unthrottled outdoors, and ($9DBB-$9DBF)
 * deliberately slowed indoors by a ~4095-iteration busy-wait ($A095) because
 * indoor scenes are cheap enough to render that the loop would otherwise be
 * "unplayable" fast, in the disassembly's own words. Getting the real speed
 * right needs Z80 T-state accounting for the render path, which is not
 * extracted data; 25 ticks/sec is a placeholder, not a citation, hence the
 * speed control going below 1x rather than only above it.
 */
const TICK_MS = 1000 / 25;
setInterval(() => {
  // Debug scaffolding: the game has no speed control, so this fires the
  // logic tick more or less often than the interval rather than changing
  // anything inside it. speedAccumulator carries a fractional tick across
  // intervals so speed < 1 skips ticks instead of running a partial one.
  speedAccumulator += speed;
  while (speedAccumulator >= 1) {
    tick();
    speedAccumulator -= 1;
  }
}, TICK_MS);

window.addEventListener('keydown', (e) => {
  // keyscan_all ($A58C): the escape screen reads the whole keyboard, not just
  // the game's own move/fire keys. Simplified to "any keydown resolves it" --
  // the original's separate wait for the key to be RELEASED exists so a key
  // already held at the moment of escape cannot dismiss the screen before the
  // player has read it, which cannot happen here since tick() is frozen the
  // instant `ending` is set.
  if (hasEnding()) {
    resolveEnding();
    e.preventDefault();
    return;
  }
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
  if (e.key.startsWith('Arrow') || e.key === FIRE_KEY) {
    keys.add(e.key);
    // Space scrolls the page otherwise, which moves the canvas out from under
    // whatever the player is looking at.
    e.preventDefault();
  }
});
window.addEventListener('keyup', (e) => keys.delete(e.key));
window.addEventListener('blur', () => keys.clear());

/** The button reflects day_or_night; it never holds it. */
function syncNightButton(): void {
  btnNight.setAttribute('aria-pressed', String(schedule.night));
}

btnNight.addEventListener('click', () => {
  // Debug scaffolding: event_night_time ($A1C3) and event_dawn ($A1DD) are the
  // only things that write day_or_night in the game. This forces it so the
  // searchlights can be driven without winding the clock to 100.
  schedule.night = !schedule.night;
  syncNightButton();
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

speedSelect.addEventListener('change', () => {
  speed = Number(speedSelect.value) || 1;
});

// Populate the jump list from the table itself, so it cannot drift from it.
for (const e of timedEvents) {
  const option = document.createElement('option');
  option.value = String(e.clock);
  const name = (e.labels[0] ?? e.handler).replace(/^event_/, '').replace(/_/g, ' ');
  option.textContent = `${String(e.clock).padStart(3)} · ${name}`;
  eventSelect.append(option);
}

eventSelect.addEventListener('change', () => {
  const target = Number(eventSelect.value);
  if (eventSelect.value === '') return;
  // dispatch_timed_event matches on EQUALITY ($A1B0), so an event is missed
  // entirely if its clock value is stepped over. Wind the clock round to the
  // value just BEFORE the one wanted and let the next dispatch fire it, rather
  // than assigning the clock and hoping.
  const before = (target - 1 + CLOCK_WRAP) % CLOCK_WRAP;
  while (schedule.clock !== before) {
    // The same context the real dispatch uses, so winding the clock leaves the
    // beds, the parcel and morale in the state the elapsed day would have. The
    // intervening messages all get queued and then play out in order, which is
    // what the game would do too -- queue_message simply drops any that do not
    // fit ($7D1B).
    dispatchTimedEvent(schedule, {
      structs,
      vischars,
      random: () => prng.next(),
      room: hero.room,
      hero: heroSlot,
      heroPos: hero.pos,
      inSolitary: solitaryState.inSolitary, // $A343
      player,
      items: itemState,
      parcels,
      roomPokes,
      queueMessage: queueGameMessage,
    });
  }
  syncNightButton();
  frameCounter = 0;
  lastEvent = `clock wound to ${before}`;
  eventSelect.value = '';
  render();
});
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
 * Start where the game starts: room 2, hut 2 left ($B78F), asleep.
 *
 * hero_sleeps ($A489) zeroes his position and halts his route, so he is inside
 * the bed graphic and not drawn -- an apparently empty hut is the correct
 * opening. Any arrow key gets him up ($9E5C), and event_wake_up does it on the
 * clock at 8.
 *
 * Starting him standing instead, as this demo used to, leaves the hero
 * somewhere the day schedule does not expect: route 42's target is the hut
 * door, whose stored position is an INDOOR one, and reading it with the
 * outdoor scale sends him into a fence.
 *
 * reset_game ($B75A) is this demo's boot routine too, as it is the original's
 * ($F163 calls it from the menu) -- every piece of state it touches is
 * already at that value from the `create*()` calls above, so this is
 * idempotent, and it is one fewer place for the boot state to drift from what
 * a mid-game reset produces.
 */
resetGame();

function fit(): void {
  presenter.resize(window.innerWidth - 48, window.innerHeight - 260);
  render();
}
window.addEventListener('resize', fit);
fit();
