/**
 * Hero movement: input -> animation -> position.
 *
 * Nothing about how far a step moves is written into this file. The chain is
 * entirely data-driven, exactly as the game's is:
 *
 *   (direction, input) -> animindices ($CDAA) -> animation index + reverse flag
 *                      -> animations ($CDF2)  -> frames of signed dx/dy/dh
 *
 * So the walk speed, the four-frame cycle and the crawl behaviour all come out
 * of the extracted tables rather than out of constants chosen here.
 */

import animationsJson from '../../data/animations.json';
import charactersJson from '../../data/characters.json';

import {
  boundsCheck,
  toggleYDominant,
  type InteriorBoundsState,
} from './bounds.js';
import { DIRECTION_MASK, DIRECTION_CRAWL, type Pos } from './coords.js';
import { tryDoor } from './doors.js';
import { decodeBase64 } from '../data/load.js';

export interface AnimFrame {
  readonly dx: number;
  readonly dy: number;
  readonly dh: number;
  readonly sprite: number;
  readonly flip: boolean;
}

export interface Animation {
  readonly index: number;
  readonly addr: string;
  readonly labels: readonly string[];
  readonly header: readonly number[];
  readonly frames: readonly AnimFrame[];
}

interface AnimIndexCell {
  readonly animation: number;
  readonly reverse: boolean;
}

const data = animationsJson as unknown as {
  count: number;
  animations: Animation[];
  animIndices: { table: AnimIndexCell[][] };
};

export const animations: readonly Animation[] = data.animations;

/**
 * The hero's standing height, read from vischar_initial ($F1C9) rather than
 * hardcoded.
 *
 * This matters more than it looks: iso_pos.y is $800 - x - y - HEIGHT, so the
 * height directly sets how high up the screen the sprite is drawn. Leaving it
 * at zero draws the character 24 pixels -- three tiles -- too low, which reads
 * as him walking through scenery he should be behind and failing to reach
 * walls he is in fact touching.
 */
export const HERO_STANDING_HEIGHT = (() => {
  const initial = decodeBase64(
    (charactersJson as unknown as { vischarInitial: { data: string } }).vischarInitial.data,
  );
  const MI_POS_HEIGHT = 0x0f + 4; // mi at $0F, then x and y words
  return (initial[MI_POS_HEIGHT] ?? 24) | ((initial[MI_POS_HEIGHT + 1] ?? 0) << 8);
})();

/**
 * Height while crawling, set by action_wiresnips (the header's note on $8013:
 * "set to 24 in process_player_input ... set to 12 in action_wiresnips").
 */
export const HERO_CRAWLING_HEIGHT = 12;
export const animIndices: readonly (readonly AnimIndexCell[])[] = data.animIndices.table;

/**
 * Input encoding, from the constants block.
 *
 * Not a bitmask: it is a 3x3 grid flattened as horizontal*3 + vertical, with
 * up=1, down=2, left=3, right=6. FIRE adds 9 on top.
 */
export const INPUT_NONE = 0;
export const INPUT_UP = 1;
export const INPUT_DOWN = 2;
export const INPUT_LEFT = 3;
export const INPUT_RIGHT = 6;
export const INPUT_FIRE = 9;
/** input_KICK, bit 7: set by transition to restart movement after a door. */
export const INPUT_KICK = 0x80;

/** Build an input byte from the pressed directions. */
export function encodeInput(
  up: boolean,
  down: boolean,
  left: boolean,
  right: boolean,
  fire = false,
): number {
  const vertical = up ? 1 : down ? 2 : 0;
  const horizontal = left ? 1 : right ? 2 : 0;
  return horizontal * 3 + vertical + (fire ? INPUT_FIRE : 0);
}

/** animindices lookup: row is the full direction field (incl. crawl), column the input. */
export function lookupAnimation(direction: number, input: number): AnimIndexCell {
  const row = animIndices[direction & 0x07];
  if (!row) throw new Error(`no animindices row for direction ${direction}`);
  const cell = row[input % 9];
  if (!cell) throw new Error(`no animindices entry for input ${input}`);
  return cell;
}

export interface HeroState {
  pos: Pos;
  /** Full direction field: bits 0..1 direction, bit 2 crawl. */
  direction: number;
  room: number;
  /** Current animation index and the frame within it. */
  animation: number;
  frame: number;
  reverse: boolean;
  /** counter_and_flags ($8007); bit 5 is Y_DOMINANT. */
  counterAndFlags: number;
}

export function createHero(pos: Pos, room = 0, direction = 0): HeroState {
  return {
    // Default to the standing height unless the caller states one, so a
    // position literal without a height cannot silently sink the sprite.
    pos: { ...pos, height: pos.height || HERO_STANDING_HEIGHT },
    direction,
    room,
    animation: 8, // anim_wait_tl -- (TL, no input) per the animindices example
    frame: 0,
    reverse: false,
    counterAndFlags: 0,
  };
}

export interface StepOutcome {
  readonly moved: boolean;
  readonly blocked: boolean;
  /** Set when the step took the hero through a door. */
  readonly enteredRoom: number | null;
  /** Set when a door was in range but locked. */
  readonly lockedDoor: number | null;
}

/**
 * Advance the hero by one animation frame.
 *
 * The order matters and follows the original: pick the animation from
 * (direction, input), apply the frame's deltas to a candidate position, test it
 * against the boundaries, and only commit if clear. A blocked step toggles
 * Y_DOMINANT, which is what makes characters slide along walls rather than
 * stick to them.
 */
export function step(
  hero: HeroState,
  input: number,
  interior?: InteriorBoundsState,
): StepOutcome {
  const cell = lookupAnimation(hero.direction, input & 0x0f);

  // Changing animation restarts the frame counter.
  if (cell.animation !== hero.animation || cell.reverse !== hero.reverse) {
    hero.animation = cell.animation;
    hero.reverse = cell.reverse;
    hero.frame = 0;
  }

  const anim = animations[hero.animation];
  if (!anim || anim.frames.length === 0) {
    return { moved: false, blocked: false, enteredRoom: null, lockedDoor: null };
  }

  const frameIndex = hero.reverse ? anim.frames.length - 1 - hero.frame : hero.frame;
  const frame = anim.frames[frameIndex]!;
  const sign = hero.reverse ? -1 : 1;

  const candidate: Pos = {
    x: (hero.pos.x + frame.dx * sign) & 0xffff,
    y: (hero.pos.y + frame.dy * sign) & 0xffff,
    height: (hero.pos.height + frame.dh * sign) & 0xffff,
  };

  const { blocked } = boundsCheck(candidate, hero.room, interior);
  if (blocked) {
    hero.counterAndFlags = toggleYDominant(hero.counterAndFlags);
    return { moved: false, blocked: true, enteredRoom: null, lockedDoor: null };
  }

  hero.pos = candidate;
  hero.frame = (hero.frame + 1) % anim.frames.length;

  // Header bytes 1 and 2 are the directions the animation runs FROM and TO:
  //   anim_turn_tl  [2, 0, 1, 255]  two frames, TL -> TR
  //   anim_walk_tl  [4, 0, 0, 2]    four frames, TL -> TL (walking never turns)
  // Played in reverse the animation ends where it started, so the resulting
  // direction is the "from" byte instead. This is what makes pressing left
  // while facing TL turn the hero to BL: (TL, LEFT) selects anim_turn_bl
  // reversed, which runs BL -> TL forwards and therefore TL -> BL backwards.
  const facing = hero.reverse ? anim.header[1] : anim.header[2];
  if (facing !== undefined && facing !== 0xff) {
    hero.direction = (hero.direction & DIRECTION_CRAWL) | (facing & DIRECTION_MASK);
  }

  // Doors are only checked outdoors here; interiors use door_handling_interior.
  if (hero.room === 0) {
    const door = tryDoor(hero.pos, hero.direction & DIRECTION_MASK);
    if (door && door.locked) {
      return { moved: true, blocked: false, enteredRoom: null, lockedDoor: door.pair };
    }
    if (door && !door.locked) {
      hero.room = door.result.room;
      hero.pos = { ...door.result.pos };
      if (door.result.clearCrawl) hero.direction &= DIRECTION_MASK;
      return {
        moved: true,
        blocked: false,
        enteredRoom: hero.room,
        lockedDoor: null,
      };
    }
  }

  return { moved: true, blocked: false, enteredRoom: null, lockedDoor: null };
}
