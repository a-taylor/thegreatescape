/**
 * The item action handlers -- what "use" does for each of the sixteen items.
 *
 * Dispatched through item_actions_jump_table ($7B16). Five items have a bare
 * RET for a handler and so do nothing at all; the rest are here.
 *
 * Several of these handlers only SET state. action_bribe marks a character as
 * pursuing, action_wiresnips puts the hero into a cutting-wire mode, and
 * action_uniform swaps his sprite set -- the code that acts on those lives in
 * hostiles_pursue, the movement system and the line-of-sight checks, which are
 * P6. That split is in the original too: the handlers are small because they
 * hand off to the main loop, not because anything is missing here.
 */

import {
  DOOR_INDEX_MASK,
  DOOR_LOCKED,
  DOOR_NONE,
  LOCKED_DOOR_COUNT,
  doorInRange,
  halfDoor,
  interiorDoorInRange,
  resolveDoor,
} from './doors.js';
import geographyJson from '../../data/geography.json';
import itemsJson from '../../data/items.json';
import {
  ITEMSTRUCT_STRIDE,
  ITEM_NONE,
  OFF_ITEM,
  OFF_ROOM,
  type ItemState,
} from './inventory.js';
import { increaseMoraleBy10ScoreBy50, type PlayerState } from './player.js';
import type { Pos } from './math.js';
import type { Vischar } from './vischar.js';

interface Wall {
  readonly minx: number;
  readonly maxx: number;
  readonly miny: number;
  readonly maxy: number;
  readonly minh: number;
  readonly maxh: number;
}

const geography = geographyJson as unknown as {
  walls: { stride: number; entries: Wall[] };
  lockedDoors: { values: number[] };
};
const itemsData = itemsJson as unknown as {
  redCrossParcelContents: { values: number[] };
};

/** item_RED_CROSS_PARCEL ($B38F LD A,$0C). */
export const ITEM_RED_CROSS_PARCEL = 0x0c;
/** itemstruct_ROOM_NONE ($B387 LD A,$3F). */
export const ROOM_NONE = 0x3f;
/** room_50_BLOCKED_TUNNEL ($B3F9 CP $32). */
export const ROOM_BLOCKED_TUNNEL = 50;
/** The first character index that is NOT a fellow prisoner ($B3B2 CP $14). */
export const CHARACTER_PRISONER_1 = 0x14;
/** vischar_PURSUIT_PURSUE ($B3C1 LD (HL),$01). */
export const PURSUIT_PURSUE = 0x01;
/** itemstruct_ITEM_FLAG_POISONED ($B3D4 SET 5). */
export const ITEM_FLAG_POISONED = 0x20;
/** vischar_FLAGS_PICKING_LOCK / _CUTTING_WIRE ($B4A7 / $B47B). */
export const FLAGS_PICKING_LOCK = 0x01;
export const FLAGS_CUTTING_WIRE = 0x02;
/** input_KICK ($B476 LD (HL),$80). */
export const INPUT_KICK = 0x80;

/** Message indices, from the `LD B,n` at each queue_message call site. */
export const MESSAGE_IT_IS_OPEN = 0x06; // $B4CB
export const MESSAGE_INCORRECT_KEY = 0x07; // $B4C2
export const MESSAGE_PICKING_THE_LOCK = 0x0a; // $B4A9
export const MESSAGE_CUTTING_THE_WIRE = 0x0b; // $B490
export const MESSAGE_YOU_OPEN_THE_BOX = 0x0c; // $B3A0

/**
 * Everything the handlers need to touch.
 *
 * Passed in rather than imported so `actions.ts` owns no state of its own --
 * the item bytes, the player and the vischars each keep their single owner.
 */
export interface ActionContext {
  items: ItemState;
  player: PlayerState;
  /** The global current room index ($68A0). */
  room: number;
  /** The hero's vischar (slot 0). */
  hero: Vischar;
  /** hero_map_position ($81B8), iso scale. */
  mapPosition: { x: number; y: number };
  /** saved_pos ($81A4), filled by use_item before dispatch. */
  savedPos: Pos;
  vischars: Vischar[];
  /** interior_doors ($81D6), $FF-terminated. */
  interiorDoors: readonly number[];
  /** A mutable copy of locked_doors ($F05D); action_key clears bit 7 here. */
  lockedDoors: Uint8Array;
  /** red_cross_parcel_current_contents ($A263). */
  redCrossParcelContents: number;
  /** player_locked_out_until ($A145). */
  playerLockedOutUntil: number;
  /** bribed_character ($AF8E). */
  bribedCharacter: number;
  /** ptr_to_door_being_lockpicked ($A143), as a locked_doors index. */
  doorBeingLockpicked: number;

  queueMessage(index: number, c?: number): void;
  /** drop_item_tail ($7BB5). */
  dropItemTail(item: number): void;
  /** The prisoner sprite set ($CE2E) / the guard set ($CEA6). */
  setHeroSprite(sprite: 'prisoner' | 'guard'): void;
  heroSpriteIsGuard(): boolean;
  /** Re-render after the room changes under the hero. */
  refreshRoom(): void;
  /** roomdef_50 pokes: the blockage boundary and its graphic ($7077/$708C). */
  clearTunnelBlockage(): void;
  isTunnelBlockageCleared(): boolean;
  /** solitary ($CB98). */
  solitary(): void;
  /** transition ($68A2) to the outside-the-gate location. */
  transitionOutsideMainGate(): void;
}

/**
 * action_red_cross_parcel ($B387).
 *
 * Five steps, and the second is the one that is easy to drop: the parcel's own
 * itemstruct room is set to ROOM_NONE FIRST ($B389), before the parcel leaves
 * the inventory, so the parcel object itself never reappears in the world.
 * What gets dropped is its CONTENTS, through drop_item_tail.
 */
export function actionRedCrossParcel(ctx: ActionContext): void {
  const o = ITEM_RED_CROSS_PARCEL * ITEMSTRUCT_STRIDE;
  ctx.items.structs[o + OFF_ROOM] = ROOM_NONE; // $B389

  // $B38F: one of the two held slots must be the parcel, since we got here
  // from a "use". The search does not verify it -- if neither matched it would
  // clear the second slot regardless -- so the fallback is slot 1, as coded.
  const slot = ctx.items.held[0] === ITEM_RED_CROSS_PARCEL ? 0 : 1;
  ctx.items.held[slot] = ITEM_NONE; // $B395

  ctx.dropItemTail(ctx.redCrossParcelContents); // $B39D
  ctx.queueMessage(MESSAGE_YOU_OPEN_THE_BOX); // $B3A0
  increaseMoraleBy10ScoreBy50(ctx.player); // $B3A5
}

/**
 * action_bribe ($B3A8).
 *
 * Scans vischars 1..7 for the first FRIENDLY character -- index >= 20 -- and
 * sets it pursuing. Guards (12..15) are skipped by the `CP $14 / JR NC` test,
 * so a bribe only ever lands on a fellow prisoner.
 *
 * Note the scan starts at the SECOND vischar ($B3A8 points at $8020) and runs
 * seven times, so the hero can never bribe himself.
 */
export function actionBribe(ctx: ActionContext): void {
  for (let slot = 1; slot < 8; slot++) {
    const v = ctx.vischars[slot];
    if (!v) continue;
    if (v.character === 0xff) continue; // $B3AE character_NONE
    if (v.character < CHARACTER_PRISONER_1) continue; // $B3B4 JR NC to found
    ctx.bribedCharacter = v.character; // $B3BD
    v.flags = PURSUIT_PURSUE; // $B3C1
    return;
  }
}

/**
 * action_poison ($B3C4).
 *
 * Requires food in hand, and is idempotent: the POISONED bit is checked before
 * it is set ($B3D1), so poisoning twice awards points only once.
 *
 * It also rewrites item_attributes[item_FOOD] to bright purple on black
 * ($B3D8), which is a write into what is otherwise read-only data -- the
 * poisoned food is visibly a different colour.
 */
export function actionPoison(ctx: ActionContext, itemAttributes: Uint8Array): void {
  const ITEM_FOOD = 7; // $B3C7 LD A,$07
  if (ctx.items.held[0] !== ITEM_FOOD && ctx.items.held[1] !== ITEM_FOOD) return; // $B3CD

  const o = ITEM_FOOD * ITEMSTRUCT_STRIDE;
  if ((ctx.items.structs[o + OFF_ITEM]! & ITEM_FLAG_POISONED) !== 0) return; // $B3D3
  ctx.items.structs[o + OFF_ITEM] = ctx.items.structs[o + OFF_ITEM]! | ITEM_FLAG_POISONED;

  itemAttributes[ITEM_FOOD] = 0x43; // $B3D6, bright purple on black
  increaseMoraleBy10ScoreBy50(ctx.player); // $B3DE
}

/**
 * action_uniform ($B3E1).
 *
 * The disguise IS the sprite set -- there is no separate "wearing uniform"
 * flag anywhere, which is why dropping the uniform ($7B96) and being sent to
 * solitary both work by writing mi.sprite back.
 *
 * Refused in the tunnels: room 29 or above ($B3ED CP $1D).
 */
export function actionUniform(ctx: ActionContext): void {
  if (ctx.heroSpriteIsGuard()) return; // $B3E9, already wearing it
  if (ctx.room >= 29) return; // $B3EF, room_29_SECOND_TUNNEL_START or above
  ctx.setHeroSprite('guard'); // $B3F0
  increaseMoraleBy10ScoreBy50(ctx.player); // $B3F3
}

/**
 * action_shovel ($B3F6): clear the blockage in room 50.
 *
 * Two pokes into the room definition, and both are needed. Setting the
 * boundary's x0 to 255 ($B404) invalidates it by making interior_bounds_check's
 * "x < bounds->x0" test always fail -- the wall stops existing rather than
 * being moved. Zeroing the object ($B408) removes the rubble graphic. Do only
 * the second and the hero still walks into an invisible wall.
 *
 * The disassembly notes the hero "doesn't need to be adjacent to the blockage
 * for this to work, only in the same room".
 */
export function actionShovel(ctx: ActionContext): void {
  if (ctx.room !== ROOM_BLOCKED_TUNNEL) return; // $B3FB
  if (ctx.isTunnelBlockageCleared()) return; // $B401
  ctx.clearTunnelBlockage(); // $B402..$B408
  ctx.refreshRoom(); // $B40B..$B411
  increaseMoraleBy10ScoreBy50(ctx.player); // $B414
}

/** walls ($B53E): 24 entries of {minx, maxx, miny, maxy, minheight, maxheight}. */
export const WALL_STRIDE = geography.walls.stride;
export const walls: readonly Wall[] = geography.walls.entries;
/**
 * The vertically-oriented fences start at entry 12.
 *
 * Derived from the pointer the routine starts with: $B589 is walls + 75, and
 * 75 = 12 * 6 + 3 -- entry 12, offset 3, which is maxy. The disassembly says
 * exactly that at $B417.
 */
export const FIRST_VERTICAL_FENCE = 12;
/** The horizontally-oriented fences start at entry 16 ($B59E = walls + 96). */
export const FIRST_HORIZONTAL_FENCE = 16;

/**
 * action_wiresnips ($B417): find a fence the hero is up against, and cut it.
 *
 * Checks the four vertical fences then the three horizontal ones, and the two
 * loops are NOT symmetric -- read the one on the actual path. The vertical
 * test is `y < maxy && y >= miny` then `x == maxx || x - 1 == maxx`; the
 * horizontal test is `x >= minx && x < maxx` then `y == miny || y - 1 == miny`.
 *
 * The horizontal case compares BOTH sides against miny -- the disassembly's
 * comment at $B453 says "maxy" but the instruction reads the same byte as the
 * line above. It makes no difference either way: in the shipped walls array
 * every vertical fence has minx == maxx and every horizontal one has
 * miny == maxy, so the two readings agree everywhere. Coded as the instruction
 * reads, with the data property asserted in the tests.
 *
 * @returns the crawl direction chosen, or -1 if no fence is adjacent.
 */
export function actionWiresnips(ctx: ActionContext): number {
  const { x, y } = ctx.mapPosition;

  for (let i = 0; i < 4; i++) {
    const w = walls[FIRST_VERTICAL_FENCE + i]!;
    if (y >= w.maxy) continue; // $B422
    if (y < w.miny) continue; // $B426
    if (x === w.maxx) return snipsTail(ctx, 4); // $B42C, TOP_LEFT + CRAWL
    if (((x - 1) & 0xff) === w.maxx) return snipsTail(ctx, 6); // $B430, BOTTOM_RIGHT + CRAWL
  }

  for (let i = 0; i < 3; i++) {
    const w = walls[FIRST_HORIZONTAL_FENCE + i]!;
    if (x < w.minx) continue; // $B446
    if (x >= w.maxx) continue; // $B44A
    if (y === w.miny) return snipsTail(ctx, 5); // $B450, TOP_RIGHT + CRAWL
    if (((y - 1) & 0xff) === w.miny) return snipsTail(ctx, 7); // $B454, BOTTOM_LEFT + CRAWL
  }
  return -1;
}

/**
 * snips_tail ($B470): put the hero into the wire-cutting animation.
 *
 * Six writes. The sprite reset to the prisoner set ($B482) matters even when
 * he is not in uniform -- cutting the wire in a guard's uniform drops the
 * disguise, which is not obvious from the handler's name.
 */
function snipsTail(ctx: ActionContext, direction: number): number {
  ctx.hero.direction = direction; // $B474
  ctx.hero.input = INPUT_KICK; // $B476
  ctx.hero.flags = FLAGS_CUTTING_WIRE; // $B47B
  ctx.hero.pos.height = 12; // $B47F
  ctx.setHeroSprite('prisoner'); // $B485
  ctx.playerLockedOutUntil = (ctx.player.gameCounter + 0x60) & 0xff; // $B48B
  ctx.queueMessage(MESSAGE_CUTTING_THE_WIRE); // $B490
  return direction;
}

/**
 * get_nearest_door ($B4D0): the locked door the hero is standing at.
 *
 * Outdoors it checks locked doors 0..4, testing BOTH halves of each door pair
 * ($B4EC advances four bytes to the second half). Indoors it starts at locked
 * door 2 and runs EIGHT times ($B500) over a nine-entry table -- one past the
 * end, which the disassembly marks "Bug: ought to be 7 iterations".
 *
 * That overrun is reproduced. Unlike the $B935 mask overrun it does not read
 * unrelated memory: locked_doors is followed inside its own block by two bytes
 * the disassembly labels "unused", both zero, so the extra iteration searches
 * the room's doors for index 0 -- an exercise-yard gate, which is an outdoor
 * pair and never appears in interior_doors. It finds nothing and returns. See
 * FIDELITY.md.
 *
 * @returns an index into locked_doors, or -1.
 */
export function getNearestDoor(ctx: ActionContext): number {
  if (ctx.room === 0) {
    // $B4D9: locked doors 0..4, both halves of each pair. The test here is
    // door_in_range ($B252), which SCALES the stored position by four --
    // outdoor door positions are quartered. The indoor branch below uses a
    // different test on unscaled coordinates; they are not interchangeable.
    for (let i = 0; i < 5; i++) {
      const index = ctx.lockedDoors[i]! & DOOR_INDEX_MASK;
      for (const half of [index * 2, index * 2 + 1]) { // $B4E5 / $B4EC
        if (doorInRange(ctx.savedPos, halfDoor(half))) return i;
      }
    }
    return -1;
  }

  for (let n = 0; n < 8; n++) { // $B500 LD B,$08 -- the reproduced overrun
    const i = 2 + n; // $B4FD starts at the third entry
    if (i >= ctx.lockedDoors.length) break;
    const index = ctx.lockedDoors[i]! & DOOR_INDEX_MASK;

    for (const interior of ctx.interiorDoors) {
      if (interior === DOOR_NONE) break; // $B50C
      if ((interior & DOOR_INDEX_MASK) !== index) continue; // $B511
      // $B51C re-reads the interior entry WITH its reverse flag, so get_door
      // picks the correct half; $B528 is interior_door_in_range.
      if (interiorDoorInRange(ctx.savedPos, halfDoor(resolveDoor(interior)))) return i;
      break;
    }
  }
  return -1;
}

/**
 * action_lockpick ($B495).
 *
 * Locks the player out for 255 game-counter ticks ($B49F ADD A,$FF) -- which
 * is 255 and not 256, so it is one tick short of a full wrap of the byte.
 */
export function actionLockpick(ctx: ActionContext): void {
  const door = getNearestDoor(ctx);
  if (door < 0) return; // $B498
  ctx.doorBeingLockpicked = door; // $B499
  ctx.playerLockedOutUntil = (ctx.player.gameCounter + 0xff) & 0xff; // $B49F
  ctx.hero.flags = FLAGS_PICKING_LOCK; // $B4A7
  ctx.queueMessage(MESSAGE_PICKING_THE_LOCK); // $B4A9
}

/** action_red_key ($B4AE): room_22_REDKEY. */
export const KEY_ROOM_RED = 22;
/** action_yellow_key ($B4B2): room_13_CORRIDOR. */
export const KEY_ROOM_YELLOW = 13;
/** action_green_key ($B4B6): room_14_TORCH. */
export const KEY_ROOM_GREEN = 14;

/**
 * action_key ($B4B8): the common tail of the three key handlers.
 *
 * The comparison at $B4C1 tests the nearest door's INDEX against the room
 * number the key belongs to. Those are different kinds of number, and the game
 * conflates them deliberately -- door index 22 is the room 22 door. Reproduced
 * as coded rather than "corrected" to a room lookup.
 *
 * The message is set to INCORRECT_KEY before the test ($B4C2, "irrespectively")
 * and overwritten only on success, so the failure path needs no branch.
 */
export function actionKey(ctx: ActionContext, keyRoom: number): void {
  const door = getNearestDoor(ctx);
  if (door < 0) return; // $B4BD

  let message = MESSAGE_INCORRECT_KEY; // $B4C2
  if ((ctx.lockedDoors[door]! & DOOR_INDEX_MASK) === keyRoom) { // $B4C1
    ctx.lockedDoors[door] = ctx.lockedDoors[door]! & ~DOOR_LOCKED; // $B4C6
    increaseMoraleBy10ScoreBy50(ctx.player); // $B4C8
    message = MESSAGE_IT_IS_OPEN; // $B4CB
  }
  ctx.queueMessage(message); // $B4CD
}

/** The main gate's bounds: x in $69..$6D, y in $49..$4B ($EFCB / $EFD9). */
export const MAIN_GATE_X = { min: 0x69, max: 0x6d } as const;
export const MAIN_GATE_Y = { min: 0x49, max: 0x4b } as const;

/**
 * action_papers ($EFCB).
 *
 * Only works at the main gate, and only in uniform: showing papers out of
 * uniform sends the hero to solitary rather than doing nothing ($EFE5).
 *
 * The bounds test is exclusive at the top on both axes -- `CP D / RET C` then
 * `CP E / RET NC` means `x >= $69 && x < $6D`.
 */
export function actionPapers(ctx: ActionContext): void {
  const { x, y } = ctx.mapPosition;
  if (x < MAIN_GATE_X.min || x >= MAIN_GATE_X.max) return; // $EFD5/$EFD7
  if (y < MAIN_GATE_Y.min || y >= MAIN_GATE_Y.max) return;

  if (!ctx.heroSpriteIsGuard()) { // $EFE5
    ctx.solitary();
    return;
  }
  increaseMoraleBy10ScoreBy50(ctx.player); // $EFE8
  ctx.hero.room = 0; // $EFEC
  ctx.transitionOutsideMainGate(); // $EFF6
}

/** The initial contents of locked_doors ($F05D), as mutable state. */
export function createLockedDoors(): Uint8Array {
  return Uint8Array.from(geography.lockedDoors.values);
}

/** red_cross_parcel_contents_list ($A25F). */
export const redCrossParcelContentsList: readonly number[] =
  itemsData.redCrossParcelContents.values;

export { LOCKED_DOOR_COUNT };

/**
 * The four inputs that do something, from process_player_input_fire ($7AC9).
 *
 * `encodeInput` already produces these values: horizontal * 3 + vertical, plus
 * 9 for fire. So fire+up is 10, fire+down 11, fire+left 12, fire+right 15 --
 * exactly the four the routine tests for.
 *
 * The DIAGONALS are not tested. Fire with left+up (13), left+down (14),
 * right+up (16), right+down (17) and fire alone (9) all fall through to the
 * return at $7AEF and do nothing. That is worth knowing while playing: holding
 * two directions when you press fire silently does nothing at all.
 */
export const INPUT_FIRE_UP = 0x0a; // $7AC9 -> pick_up_item
export const INPUT_FIRE_DOWN = 0x0b; // $7AD3 -> drop_item
export const INPUT_FIRE_LEFT = 0x0c; // $7ADD -> use_item_A
export const INPUT_FIRE_RIGHT = 0x0f; // $7AE7 -> use_item_B

/**
 * item_actions_jump_table ($7B16), as callable handlers.
 *
 * The five entries that point at a bare RET are simply absent, which `useItem`
 * treats as "do nothing" -- the same outcome as the original's RET.
 *
 * The three key handlers differ only in the room number they carry ($B4AE,
 * $B4B2, $B4B6), all falling into action_key.
 */
export function itemActions(
  ctx: ActionContext,
): Readonly<Record<number, ItemActionHandler>> {
  return {
    0: () => actionWiresnips(ctx), // $B417
    1: () => actionShovel(ctx), // $B3F6
    2: () => actionLockpick(ctx), // $B495
    3: () => actionPapers(ctx), // $EFCB
    // 4 torch -- $7AEF RET
    5: () => actionBribe(ctx), // $B3A8
    6: () => actionUniform(ctx), // $B3E1
    // 7 food -- $7AEF RET
    8: () => actionPoison(ctx, ctx.items.attributes), // $B3C4
    9: () => actionKey(ctx, KEY_ROOM_RED), // $B4AE
    10: () => actionKey(ctx, KEY_ROOM_YELLOW), // $B4B2
    11: () => actionKey(ctx, KEY_ROOM_GREEN), // $B4B6
    12: () => actionRedCrossParcel(ctx), // $B387
    // 13 radio, 14 purse, 15 compass -- $7AEF RET
  };
}

export type ItemActionHandler = (item: number) => void;
