/**
 * The visible character array ($8000).
 *
 * Eight slots of 32 bytes. Slot 0 is always the hero; slots 1..7 hold whichever
 * non-player characters are currently near enough to draw, and are recycled as
 * the hero moves around -- spawn_characters fills them, purge_invisible_characters
 * empties them again. Slot 1 doubles as the room's movable item when there is
 * one, which is why the stove and crate are "characters" 26..28.
 *
 * The layout is taken from vischar_initial ($F1C9) for the first 22 bytes and
 * from the offsets the code actually indexes for the rest:
 *
 *   $00 character          $0D input
 *   $01 flags              $0E direction
 *   $02 route (2)          $0F mi.pos (3 words)
 *   $04 target (3)         $15 mi.sprite
 *   $07 counter_and_flags  $17 mi.sprite_index
 *   $08 animbase           $18 iso_pos.x
 *   $0A anim               $1A iso_pos.y
 *   $0C animindex          $1C room
 *                          $1E width_bytes   $1F height
 *
 * Represented here as objects rather than a byte array. The byte offsets still
 * matter -- several routines reach a field by adding a constant to the low byte
 * of a pointer, and a few of those wrap deliberately -- so the offsets are
 * recorded as constants where behaviour depends on them.
 */

import animationsJson from '../../data/animations.json';
import charactersJson from '../../data/characters.json';

import { decodeBase64 } from '../data/load.js';
import type { Pos } from './coords.js';

/** vischars_LENGTH: eight slots ($B8A8 sets B for 8 iterations). */
export const VISCHAR_COUNT = 8;

/** The stride between slots, and the value the loops add to advance ($C4D9). */
export const VISCHAR_STRIDE = 0x20;

/** character_NONE / vischar_CHARACTER_EMPTY_SLOT ($C4EA). */
export const CHARACTER_NONE = 0xff;

/** vischar_FLAGS_EMPTY_SLOT ($C5DF). */
export const FLAGS_EMPTY_SLOT = 0xff;

/** vischar_CHARACTER_MASK -- "not consistently applied", per the header. */
export const VISCHAR_CHARACTER_MASK = 0x1f;

/** vischar_DRAWABLE, counter_and_flags bit 7 ($B8AE). */
export const VISCHAR_DRAWABLE = 0x80;

/** counter_and_flags bit 5 ($B1AF), which makes characters slide along walls. */
export const BYTE7_Y_DOMINANT = 0x20;

/**
 * The animation a fresh vischar starts on, read from vischar_initial ($F1D3).
 *
 * This matters more than a default usually would. spawn_character never writes
 * vischar.anim -- it copies animbase and the sprite ($C553, $C55B) but not the
 * animation itself -- and for a HALTED character character_behaviour then sets
 * an input of zero, which equals the existing input, so cb_set_input returns
 * without setting input_KICK ($C9F8) and animate never re-initialises. The
 * starting animation is therefore the one the character actually plays.
 *
 * vischar_initial points at $CF76, which is anim_wait_tl: one frame, no
 * deltas. Default it to animation 0 instead -- anim_walk_tl -- and every
 * halted character takes four walk frames before the animation runs out and
 * corrects itself, drifting 8 world units. The watchtower guards, who are
 * halted at height 13, end up beside their platforms instead of on them.
 */
export const VISCHAR_INITIAL_ANIM = (() => {
  const initial = decodeBase64(
    (charactersJson as unknown as { vischarInitial: { data: string } }).vischarInitial.data,
  );
  // Offsets 10..11: the anim pointer, little-endian.
  const addr = (initial[10] ?? 0) | ((initial[11] ?? 0) << 8);
  const animations = (animationsJson as unknown as {
    animations: { addr: string }[];
  }).animations;
  const index = animations.findIndex(
    (a) => parseInt(a.addr.slice(1), 16) === addr,
  );
  return index < 0 ? 0 : index;
})();

export interface Vischar {
  /** Slot index 0..7. Not a stored field; the code derives it from the pointer. */
  readonly slot: number;

  /** $00. character_NONE when the slot is free. */
  character: number;
  /** $01. vischar_FLAGS_EMPTY_SLOT when free; otherwise mode/pursuit bits. */
  flags: number;
  /** $02: {index, step}. Bit 7 of index is route_REVERSED. */
  route: { index: number; step: number };
  /** $04: where this character is heading, in tinypos. */
  target: { x: number; y: number; height: number };
  /** $07. Bit 7 is DRAWABLE, bit 5 is Y_DOMINANT. */
  counterAndFlags: number;
  /** $08/$0A/$0C: the animation state. */
  animbase: number;
  anim: number;
  animIndex: number;
  /** $0D/$0E. */
  input: number;
  direction: number;
  /** $0F: the 16-bit position. Outdoors this is tinypos * 8; indoors it is
   *  tinypos widened, which is why spawn_character branches on the room. */
  pos: Pos;
  /**
   * $15: mi.sprite -- the BASE of this character's sprite set, from
   * character_meta_data. In the original this is a pointer to a spritedef
   * array; here it is the index of that array's first entry.
   */
  sprite: number;
  /**
   * $17: mi.sprite_index -- the frame WITHIN that set, written by animate from
   * the animation frame. The renderer draws sprite + spriteIndex; conflating
   * the two makes every character show its first frame forever.
   */
  spriteIndex: number;
  /** $18/$1A: the projected position, filled by calc_vischar_iso_pos. */
  isoPos: { x: number; y: number };
  /** $1C. */
  room: number;
  /** $1E/$1F: a copy of the sprite's dimensions, width being width PLUS ONE. */
  widthBytes: number;
  height: number;
}

/** A slot in its empty state, as reset_visible_character leaves it ($C632). */
export function emptyVischar(slot: number): Vischar {
  return {
    slot,
    character: CHARACTER_NONE,
    flags: FLAGS_EMPTY_SLOT,
    route: { index: 0, step: 0 },
    target: { x: 0, y: 0, height: 0 },
    counterAndFlags: 0,
    animbase: 0,
    anim: VISCHAR_INITIAL_ANIM,
    animIndex: 0,
    input: 0,
    direction: 0,
    pos: { x: 0, y: 0, height: 0 },
    sprite: 0,
    spriteIndex: 0,
    isoPos: { x: 0, y: 0 },
    room: 0,
    widthBytes: 0,
    height: 0,
  };
}

export function isEmpty(v: Vischar): boolean {
  return v.character === CHARACTER_NONE;
}

/** The eight slots, hero first. */
export function createVischars(): Vischar[] {
  return Array.from({ length: VISCHAR_COUNT }, (_, i) => emptyVischar(i));
}

/**
 * The non-player slots, 1..7.
 *
 * Every routine that walks NPCs starts at $8020 with a count of seven
 * ($C48F, $C4E4, $C6A0), never at $8000 -- the hero is handled by the player
 * input path instead and must not be spawned, purged or steered.
 */
export function npcSlots(vischars: Vischar[]): Vischar[] {
  return vischars.slice(1);
}
