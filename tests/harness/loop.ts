/**
 * The demo's tick, extracted so more than one scenario can drive it.
 *
 * `tests/demoloop.test.ts` used to hold its own copy of `src/main.ts`'s tick,
 * and CLAUDE.md records what that cost: when the two drifted, the simulation
 * diverged from the demo and the test passed on behaviour the demo never
 * exhibited. Adding a SECOND copy for the walkthrough would have made that
 * failure mode twice as likely, so the loop lives here and both scenarios call
 * it.
 *
 * It still mirrors `src/main.ts` rather than being shared with it -- the demo's
 * tick is entangled with rendering, the DOM and the debug status line, and
 * untangling that is its own job. The rule is unchanged: **if you add a step to
 * the demo's tick, add it here, in the same place.**
 *
 * What is deliberately absent is the pixel renderer. Only two things in the
 * tick read a rendering product -- the clip test and the mask buffer
 * searchlight_mask_test samples -- and both are computed here directly from
 * `renderMaskBuffer` and `vischarVisible`, which is what `plot_sprites` needs
 * to decide whether to sample at all.
 *
 * Every address cited below is the same one cited at the matching line of
 * `src/main.ts`.
 */

import { characterStructs, type CharacterStruct } from '../../src/game/characters.js';
import {
  VISCHAR_DRAWABLE,
  createVischars,
  isEmpty,
  npcSlots,
  type Vischar,
} from '../../src/game/vischar.js';
import {
  purgeInvisibleCharacters,
  resetVisibleCharacter,
  spawnCharacters,
} from '../../src/game/spawn.js';
import { characterBehaviour } from '../../src/game/behaviour.js';
import { animateVischar } from '../../src/game/animate.js';
import { moveCharacter, nextCharacterIndex } from '../../src/game/move.js';
import {
  TICKS_PER_CLOCK,
  createSchedule,
  dispatchTimedEvent,
  heroGetsUp,
  heroSits,
  heroSleeps,
  heroStandsFromBreakfast,
  setHeroRoute,
  setHeroRouteForce,
} from '../../src/game/schedule.js';
import { Prng } from '../../src/game/prng.js';
import {
  HERO_RELEASE_ROUTE,
  createAutomaticState,
  heroIsAutomatic,
  noteInput,
} from '../../src/game/events.js';
import {
  HERO_STANDING_HEIGHT,
  INPUT_FIRE,
  animations,
  createHero,
  step,
} from '../../src/game/hero.js';
import { ExteriorView } from '../../src/render/exterior.js';
import { isoPlacement, resetOutdoorPosition } from '../../src/render/place.js';
import { vischarVisible } from '../../src/render/clip.js';
import { roomsData } from '../../src/data/load.js';
import {
  type ActionContext,
  createJeopardy,
  createLockedDoors,
  itemActions,
} from '../../src/game/actions.js';
import { FLAGS_PICKING_LOCK, runWorkingTimers } from '../../src/game/timers.js';
import {
  STATE_SEARCHING,
  createSearchlights,
  nighttime,
  searchlightMaskTest,
} from '../../src/game/searchlight.js';
import { renderMaskBuffer, interiorMasksForRoom } from '../../src/render/maskbuffer.js';
import { calcIsoPos, heroMapPosition, tinyposStash } from '../../src/game/coords.js';
import { MASK_BUFFER_SIZE } from '../../src/render/sprites.js';
import { advanceZoombox, createZoombox } from '../../src/render/zoombox.js';
import { createPermitted, inPermittedArea } from '../../src/game/permitted.js';
import { followSuspiciousCharacter } from '../../src/game/pursuit.js';
import {
  BLOCKED_TUNNEL_BOUND,
  INTERIOR_OBJECT_COLLAPSED_TUNNEL,
  ROOM_SOLITARY,
  acceptBribe,
  collision,
  resetMapAndCharacters,
  solitary,
  solitaryPos,
} from '../../src/game/jeopardy.js';
import { ITEM_FOOD, isItemDiscoverable, itemDiscovered } from '../../src/game/discovery.js';
import {
  createItemState,
  dropItemTail,
  markNearbyItems,
  processPlayerInputFire,
} from '../../src/game/inventory.js';
import { INTERIOR_MAP_POSITION, interiorDoorsForRoom } from '../../src/game/doors.js';
import { checkMorale, createPlayer } from '../../src/game/player.js';
import {
  createMessages,
  messageDisplay,
  queueMessage as queueMessageState,
} from '../../src/ui/messages.js';
import { waveMoraleFlag } from '../../src/ui/panel.js';
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
} from '../../src/game/parcels.js';
import { SpectrumScreen } from '../../src/spectrum/display.js';

/** The room state interior_bounds_check needs, per room. */
export function interiorBounds(room: number) {
  if (room === 0) return undefined;
  const def = roomsData.roomdefs[roomsData.rooms[room - 1]!.roomdefIndex]!;
  return { boundsIndex: def.dimensionsIndex, objectBounds: def.bounds };
}

/** reset_game ($B75A) leaves him asleep in hut 2 ($B794). */
export const START_POS = { x: 100 * 8, y: 74 * 8, height: HERO_STANDING_HEIGHT };
export const START_ROOM = 2;

/**
 * Everything the tick reads or writes, with one owner per game field.
 *
 * The fields are public because the scenarios instrument them; the tick is the
 * only thing that should WRITE them.
 */
export interface GameState {
  readonly prng: Prng;
  readonly random: () => number;
  readonly structs: CharacterStruct[];
  readonly vischars: Vischar[];
  readonly heroSlot: Vischar;
  hero: ReturnType<typeof createHero>;
  readonly view: ExteriorView;
  readonly automatic: ReturnType<typeof createAutomaticState>;
  readonly player: ReturnType<typeof createPlayer>;
  readonly items: ReturnType<typeof createItemState>;
  readonly parcels: ReturnType<typeof createParcels>;
  readonly pokes: ReturnType<typeof createRoomPokes>;
  readonly messages: ReturnType<typeof createMessages>;
  readonly jeopardy: ReturnType<typeof createJeopardy>;
  readonly lockedDoors: ReturnType<typeof createLockedDoors>;
  readonly searchlights: ReturnType<typeof createSearchlights>;
  readonly schedule: ReturnType<typeof createSchedule>;
  readonly screen: SpectrumScreen;
  readonly permitted: ReturnType<typeof createPermitted>;
  /** $C891 food_discovered_counter and $A130's "ringing perpetually" state. */
  readonly pursuit: { foodDiscoveredCounter: number; bellRingingPerpetually: boolean };
  /** $A13A in_solitary, plus the door it came in by. */
  readonly solitaryState: { inSolitary: boolean; currentDoor: number };
  /** saved_pos ($7B0A), which the action_* handlers read back. */
  readonly savedPos: { x: number; y: number; height: number };
  /** Boxed so a callback write is visible to TypeScript's narrowing. */
  readonly heroSprite: { current: 'prisoner' | 'guard' };
  /** hero_map_position ($81B8) -- NOT map_position ($81BB), the view scroll. */
  readonly heroMapPos: { x: number; y: number; height: number };
  readonly foreground: Uint8Array;
  readonly heroForeground: Uint8Array;
  /** Which character move_a_character advances next ($C6A0). */
  moveIndex: number;
  /** The low byte of game_counter that gates dispatch_timed_event. */
  frame: number;
  /** Ticks run so far, for diagnostics. */
  ticks: number;
}

/** What one tick did, for a scenario to instrument. */
export interface TickResult {
  /** The input that actually reached step(), after inhibition and autopilot. */
  effectiveInput: number;
  moved: boolean;
  enteredRoom: number | null;
  /** Steps the reveal ran; the loop is frozen for all of them. */
  zoomboxSteps: number;
  command: ReturnType<typeof processPlayerInputFire>;
  /** True while a lockpick or wire cut owns the whole frame ($9E0E). */
  working: boolean;
  arrested: boolean;
  bribed: boolean;
  escaped: boolean;
  gateTransition: boolean;
  redFlag: boolean;
  /** Occupied NPC slots carrying a pursuit mode this tick. */
  pursuingSlots: number;
  /** Whether the hero would have been plotted -- the clip test plot_sprites runs. */
  visible: boolean;
  maskTested: boolean;
  searchlightEscaped: boolean;
  eventFired: boolean;
  /** messages.displayIndex before message_display ran, for the typing tests. */
  messageIndexBefore: number;
}

export function createGameState(): GameState {
  const prng = new Prng();
  const structs = characterStructs();
  const vischars = createVischars();
  const heroSlot = vischars[0]!;
  heroSlot.character = 0;
  heroSlot.flags = 0;

  const hero = createHero({ ...START_POS }, START_ROOM, 0);
  const start = resetOutdoorPosition(START_POS);
  const view = new ExteriorView(start.x, start.y);
  view.position.x = INTERIOR_MAP_POSITION.x;
  view.position.y = INTERIOR_MAP_POSITION.y;

  const pokes = createRoomPokes();
  const schedule = createSchedule();
  // reset_game leaves him asleep, which pokes his bed to OCCUPIED -- so the
  // poke state has to exist first.
  heroSleeps(schedule, heroSlot, hero.pos, pokes);

  return {
    prng,
    random: () => prng.next(),
    structs,
    vischars,
    heroSlot,
    hero,
    view,
    automatic: createAutomaticState(),
    player: createPlayer(),
    items: createItemState(),
    parcels: createParcels(),
    pokes,
    messages: createMessages(),
    jeopardy: createJeopardy(),
    lockedDoors: createLockedDoors(),
    searchlights: createSearchlights(),
    schedule,
    screen: new SpectrumScreen(),
    permitted: createPermitted(),
    pursuit: { foodDiscoveredCounter: 0, bellRingingPerpetually: false },
    solitaryState: { inSolitary: false, currentDoor: -1 },
    savedPos: { x: 0, y: 0, height: 0 },
    heroSprite: { current: 'prisoner' },
    heroMapPos: { x: 0, y: 0, height: 0 },
    foreground: new Uint8Array(MASK_BUFFER_SIZE),
    heroForeground: new Uint8Array(MASK_BUFFER_SIZE),
    moveIndex: 0,
    frame: 0,
    ticks: 0,
  };
}

/** One iteration of main_loop ($9D7B), in src/main.ts's order. */
export function tickGame(g: GameState, playerInput = 0): TickResult {
  const queueMessage = (index: number, c = 0) => queueMessageState(g.messages, index, c);
  const r: TickResult = {
    effectiveInput: 0,
    moved: false,
    enteredRoom: null,
    zoomboxSteps: 0,
    command: null,
    working: false,
    arrested: false,
    bribed: false,
    escaped: false,
    gateTransition: false,
    redFlag: false,
    pursuingSlots: 0,
    visible: false,
    maskTested: false,
    searchlightEscaped: false,
    eventFired: false,
    messageIndexBefore: g.messages.displayIndex,
  };

  /** $C853 charevnt_hero_release: force him onto route 37 out of the cell. */
  const releaseHero = () => {
    g.automatic.counter = 0;
    setHeroRouteForce(
      {
        structs: g.structs,
        vischars: g.vischars,
        random: g.random,
        room: g.hero.room,
        hero: g.heroSlot,
        heroPos: g.hero.pos,
      },
      HERO_RELEASE_ROUTE.index,
      HERO_RELEASE_ROUTE.step,
    );
  };

  /** $B7B9/$B7D4/$B7DD, shared by every reset_map_and_characters caller. */
  const restoreRoomObjects = () => {
    for (const bed of bedObjects) pokeObject(g.pokes, bed, INTERIOR_OBJECT_OCCUPIED_BED);
    pokeObject(g.pokes, heroBedObject, INTERIOR_OBJECT_OCCUPIED_BED);
    clearAllBenches(g.pokes);
    pokeObject(g.pokes, blockedTunnelObject, INTERIOR_OBJECT_COLLAPSED_TUNNEL);
    pokeBound(g.pokes, blockedTunnelBoundary, BLOCKED_TUNNEL_BOUND);
  };

  /** $CB98 solitary, as main.ts's arrestHero drives it. */
  const arrestHero = () => {
    r.arrested = true;
    solitary(g.solitaryState, {
      hero: g.heroSlot,
      items: g.items,
      player: g.player,
      vischars: g.vischars,
      structs: g.structs,
      queueMessage,
      discoverItem: (item) => {
        if (item !== 0xff) itemDiscovered(g.items, g.player, item, queueMessage);
      },
      silenceBell: () => { g.pursuit.bellRingingPerpetually = false; },
      resetCast: () => {
        resetMapAndCharacters({
          vischars: g.vischars,
          structs: g.structs,
          hero: g.heroSlot,
          schedule: g.schedule,
          lockedDoors: g.lockedDoors,
          resetVisible: (v) => resetVisibleCharacter(v, g.structs),
          restoreRoomObjects,
        });
      },
      forceAutomatic: () => { g.automatic.counter = 0; }, // $CC16
      transitionToSolitary: () => {
        g.hero.room = ROOM_SOLITARY;
        g.hero.pos = { x: solitaryPos[0]!, y: solitaryPos[1]!, height: solitaryPos[2]! };
        setView(ROOM_SOLITARY);
      },
    });
  };

  /** The same context main.ts hands the action_* handlers. */
  const actionContext = (): ActionContext => ({
    items: g.items,
    player: g.player,
    room: g.hero.room,
    hero: g.heroSlot,
    mapPosition: heroMapPosition(g.hero.pos, g.hero.room === 0),
    savedPos: g.savedPos,
    vischars: g.vischars,
    interiorDoors: g.hero.room === 0 ? [] : interiorDoorsForRoom(g.hero.room),
    lockedDoors: g.lockedDoors,
    redCrossParcelContents: g.parcels.contents,
    jeopardy: g.jeopardy,
    queueMessage,
    dropItemTail: (item) => dropItemTail(g.items, item, g.hero.room, g.hero.pos),
    setHeroSprite: (sprite) => { g.heroSprite.current = sprite; },
    heroSpriteIsGuard: () => g.heroSprite.current === 'guard',
    refreshRoom: () => {}, // no pixel renderer in this loop
    clearTunnelBlockage: () => clearTunnelBlockage(g.pokes),
    isTunnelBlockageCleared: () => isTunnelBlockageCleared(g.pokes),
    solitary: arrestHero,
    transitionOutsideMainGate: () => { r.gateTransition = true; },
  });

  /** enter_room ($68F4) / reset_outdoors ($B2FC), minus the reveal. */
  function setView(room: number): void {
    if (room === 0) {
      const m = resetOutdoorPosition(g.hero.pos);
      g.view.position.x = m.x;
      g.view.position.y = m.y;
    } else {
      g.view.position.x = INTERIOR_MAP_POSITION.x;
      g.view.position.y = INTERIOR_MAP_POSITION.y;
    }
    g.view.moveMapY = 0;
    g.view.refresh();
  }

  // -- $9DB4..$9DB8: the searchlights only run at night. ---------------------
  if (g.schedule.night) {
    nighttime(g.searchlights, {
      room: g.hero.room,
      mapPosition: g.view.position,
      player: g.player,
      ringBell: () => { g.pursuit.bellRingingPerpetually = true; }, // $AEB0
    });
  }

  let input = playerInput;

  // -- $9E07..$9E0D: solitary or exhausted morale inhibits the WHOLE input
  // path -- no movement, no getting out of bed, no item commands.
  if (g.solitaryState.inSolitary || g.player.moraleExhausted) input = 0;

  // -- $9E0E..$9E1F: a lockpick or wire cut takes the whole frame. ----------
  r.working = runWorkingTimers(
    {
      gameCounter: g.player.gameCounter,
      lockedOutUntil: g.jeopardy.playerLockedOutUntil,
      hero: g.heroSlot,
      lockedDoors: g.lockedDoors,
      doorBeingLockpicked: g.jeopardy.doorBeingLockpicked,
      queueMessage,
    },
    (turns) => { g.automatic.counter = turns; }, // $9E18
  );
  if (r.working) input = 0;

  // -- $9E86 process_player_input_fire ($7AC9). ----------------------------
  r.command = processPlayerInputFire(g.items, input, {
    player: g.player,
    room: g.hero.room,
    mapPosition: heroMapPosition(g.hero.pos, g.hero.room === 0),
    heroPos: g.hero.pos,
    savedPos: g.savedPos,
    actions: itemActions(actionContext()),
    onUniformRemoved: () => { g.heroSprite.current = 'prisoner'; }, // $7B96
  });

  // input_KICK ($9E8D): a sprite refresh with no direction bits.
  const moveInput = input >= INPUT_FIRE ? 0 : input;

  // -- $9E37..$9E5C: the first keypress gets him out of bed or off the bench.
  if (input !== 0 && g.schedule.heroInBed) {
    heroGetsUp(g.schedule, g.heroSlot, g.hero.pos, g.pokes);
    g.hero.room = 2;
  } else if (input !== 0 && g.schedule.heroInBreakfast) {
    heroStandsFromBreakfast(g.schedule, g.heroSlot, g.hero.pos, g.pokes);
  }

  // -- $9E22..$9E35: input resets the automatic counter. --------------------
  noteInput(g.automatic, input);

  // -- $C910: at zero, character_behaviour supplies the input instead. -----
  let effectiveInput = moveInput;
  let autoEnteredRoom: number | null = null;
  if (heroIsAutomatic(g.automatic)) {
    g.heroSlot.pos = { ...g.hero.pos };
    g.heroSlot.room = g.hero.room;
    // counter_and_flags is one game byte and has to travel BOTH ways ($B1AF
    // writes it, $C9E1 reads it).
    g.heroSlot.counterAndFlags = g.hero.counterAndFlags;
    const behaviour = characterBehaviour(g.heroSlot, {
      random: g.random,
      structs: g.structs,
      room: g.hero.room,
      pokes: g.pokes,
    });
    g.hero.counterAndFlags = g.heroSlot.counterAndFlags;
    effectiveInput = g.heroSlot.input & 0x0f;

    // $C83F charevnt_solitary_ends: the ONLY thing that clears in_solitary.
    if (behaviour.event === 'solitaryEnds') g.solitaryState.inSolitary = false;

    if (behaviour.event === 'heroSits') {
      heroSits(g.schedule, g.heroSlot, g.hero.pos, g.pokes);
    } else if (behaviour.event === 'heroSleeps') {
      heroSleeps(g.schedule, g.heroSlot, g.hero.pos, g.pokes);
    }

    // $CAF8 -> transition: the AUTOMATIC door path. Keyed on the transition
    // having happened, not on the room having changed -- the yard gates have
    // both halves outdoors.
    if (behaviour.enterRoom !== null) {
      autoEnteredRoom = behaviour.enterRoom;
      g.hero.room = g.heroSlot.room;
      g.hero.pos = { ...g.heroSlot.pos };
    }
  }
  r.effectiveInput = effectiveInput;

  const outcome = step(g.hero, effectiveInput, interiorBounds(g.hero.room), {
    doorHandling: !heroIsAutomatic(g.automatic),
  });
  r.moved = outcome.moved;

  // -- main_loop order: move_a_character ($9D8D), purge ($9D93), spawn ($9D96).
  g.moveIndex = nextCharacterIndex(g.moveIndex);
  const mover = g.structs[g.moveIndex];
  if (mover) moveCharacter(mover, { random: g.random, pokes: g.pokes, onHeroRelease: releaseHero });

  for (const v of npcSlots(g.vischars)) {
    if (!isEmpty(v)) {
      characterBehaviour(v, {
        random: g.random,
        structs: g.structs,
        room: g.hero.room,
        pokes: g.pokes,
      });
    }
  }
  purgeInvisibleCharacters(g.vischars, g.structs, g.view.position, g.hero.room);
  spawnCharacters(g.vischars, g.structs, g.view.position, g.hero.room, { random: g.random });
  for (const v of npcSlots(g.vischars)) v.counterAndFlags &= ~VISCHAR_DRAWABLE & 0xff;
  for (const v of npcSlots(g.vischars)) {
    if (!isEmpty(v)) animateVischar(v, { interior: interiorBounds(v.room) });
  }

  const enteredRoom = outcome.enteredRoom ?? autoEnteredRoom;
  r.enteredRoom = enteredRoom;
  if (enteredRoom !== null) {
    setView(enteredRoom);
    // zoombox ($ABA0) at $6912 / $B329. Run out inline because the original's
    // CALL BLOCKS: no main-loop iteration happens until the box is complete,
    // so the reveal costs wall-clock time and not one game tick. src/main.ts
    // spreads the same eleven steps over eleven intervals -- a browser cannot
    // block -- but returns early from tick() for every one of them.
    const box = createZoombox();
    while (advanceZoombox(box)) r.zoomboxSteps++;
  } else if (g.hero.room === 0 && outcome.moved) {
    g.view.moveMap(animations[g.hero.animation]?.header[3] ?? 0xff, g.hero.reverse);
  }

  // -- $9F21 in_permitted_area. --------------------------------------------
  g.heroSlot.pos = { ...g.hero.pos };
  g.heroSlot.isoPos = calcIsoPos(g.hero.pos);
  inPermittedArea(g.permitted, {
    room: g.hero.room,
    clock: g.schedule.clock,
    inSolitary: g.solitaryState.inSolitary,
    hero: g.heroSlot,
    mapPosition: g.heroMapPos,
    setHeroRoute: (index, routeStep) => {
      setHeroRoute(
        {
          structs: g.structs,
          vischars: g.vischars,
          random: g.random,
          room: g.hero.room,
          hero: g.heroSlot,
          heroPos: g.hero.pos,
          inSolitary: g.solitaryState.inSolitary, // $A343
        },
        index,
        routeStep,
      );
    },
    onEscaped: () => { r.escaped = true; },
    silenceBell: () => { g.pursuit.bellRingingPerpetually = false; }, // $9FF1
  });
  r.redFlag = g.permitted.redFlag;

  // $A138 and $A13A each have two readers; copied rather than left to drift.
  g.automatic.redFlag = g.permitted.redFlag;
  g.automatic.inSolitary = g.solitaryState.inSolitary;

  // -- $9D90 follow_suspicious_character ($C892). --------------------------
  const followed = followSuspiciousCharacter(
    g.vischars,
    {
      room: g.hero.room,
      redFlag: g.permitted.redFlag,
      automaticPlayerCounter: g.automatic.counter,
      heroMapPosition: g.heroMapPos,
      heroInUniform: g.heroSprite.current === 'guard',
      items: g.items,
    },
    g.pursuit,
    {
      checkItemDiscoverable: () => {
        const found = isItemDiscoverable(g.items, g.hero.room);
        if (found >= 0) itemDiscovered(g.items, g.player, found, queueMessage);
      },
      foodExpired: () => {
        itemDiscovered(g.items, g.player, ITEM_FOOD, queueMessage);
      },
    },
  );
  if (followed.ringBell) g.pursuit.bellRingingPerpetually = true;
  for (const v of npcSlots(g.vischars)) if (!isEmpty(v) && v.flags !== 0) r.pursuingSlots++;

  // -- $AFC0 collision, per moving NPC against the hero. -------------------
  if (!g.solitaryState.inSolitary) {
    for (const v of npcSlots(g.vischars)) {
      if (isEmpty(v)) continue;
      const hit = collision(v, { ...v.pos }, g.vischars, g.jeopardy.bribedCharacter);
      if (hit.kind === 'arrest') {
        arrestHero();
        break;
      }
      if (hit.kind === 'bribe') {
        r.bribed = true;
        acceptBribe(v, g.vischars, g.items, g.player, queueMessage);
        g.jeopardy.bribedCharacter = 0xff;
        break;
      }
    }
  }

  // -- $DB9E mark_nearby_items, against map_position ($81BB). --------------
  markNearbyItems(g.items, g.view.position, g.hero.room);

  // -- $9DC2 wave_morale_flag, then message_display, then check_morale. ----
  waveMoraleFlag(g.screen, g.player);
  messageDisplay(g.messages, g.screen);
  checkMorale(g.player, queueMessage, () => { g.automatic.counter = 0; }); // $9DE1

  // -- $9DC5..$9DCA: a timed event once every 64 ticks of the game counter.
  g.frame = (g.frame + 1) & 0xff;
  if ((g.frame & (TICKS_PER_CLOCK - 1)) === 0) {
    r.eventFired = true;
    dispatchTimedEvent(g.schedule, {
      structs: g.structs,
      vischars: g.vischars,
      random: g.random,
      room: g.hero.room,
      hero: g.heroSlot,
      heroPos: g.hero.pos,
      inSolitary: g.solitaryState.inSolitary, // $A343
      player: g.player,
      items: g.items,
      parcels: g.parcels,
      roomPokes: g.pokes,
      queueMessage,
    });
  }

  // -- The two rendering products the tick reads back. ---------------------
  // plot_sprites' clip test decides whether the hero is plotted at all, and
  // searchlight_mask_test ($B83B) samples the mask buffer built for him.
  const iso = isoPlacement(g.hero.pos);
  r.visible = vischarVisible(
    { isoXBytes: iso.column, isoYPixels: iso.pixelRow, widthBytesPlusOne: 3, height: 27 },
    g.view.position,
  ).visible;

  if (r.visible) {
    const tiny = tinyposStash(g.hero.pos, g.hero.room === 0);
    renderMaskBuffer(
      g.foreground,
      {
        isoX: iso.column,
        isoY: iso.pixelRow >> 3,
        tinyX: tiny.x,
        tinyY: tiny.y,
        tinyHeight: tiny.height,
      },
      g.hero.room === 0
        ? undefined
        : interiorMasksForRoom(
            roomsData.roomdefs[roomsData.rooms[g.hero.room - 1]!.roomdefIndex]!.masks,
          ),
    );
    g.heroForeground.set(g.foreground);
  }
  if (g.schedule.night && r.visible && g.searchlights.state !== STATE_SEARCHING) {
    r.maskTested = true;
    if (searchlightMaskTest(g.searchlights, g.heroForeground)) r.searchlightEscaped = true;
  }

  g.ticks++;
  return r;
}

/** Whether a lockpick or wire cut currently owns the frame, for diagnostics. */
export function heroIsWorking(g: GameState): boolean {
  return (g.heroSlot.flags & FLAGS_PICKING_LOCK) !== 0;
}
