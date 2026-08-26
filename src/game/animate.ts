/**
 * animate (c$B5CE): advance every visible character by one animation frame.
 *
 * This is the hero's movement path applied to all eight slots. The hero reaches
 * it with an input from the keyboard; NPCs reach it with an input synthesised
 * by character_behaviour. From here on the two are indistinguishable -- same
 * animindices lookup, same frame deltas, same collision test.
 *
 * The animation state is encoded differently from the way it reads:
 * `animindex` is a frame counter whose BIT 7 means "playing backwards"
 * ($B5F1), and when set the low bits count DOWN from nframes rather than up
 * from zero. So a reversed animation walks its frames in reverse and applies
 * each delta by SUBTRACTING it ($B615 SBC) instead of adding ($B66A ADD).
 * That is how one table of animations serves eight directions of travel.
 */

import { boundsCheck, toggleYDominant, type InteriorBoundsState } from './bounds.js';
import { calcIsoPos, DIRECTION_MASK, DIRECTION_CRAWL, type Pos } from './coords.js';
import { animations, lookupAnimation } from './hero.js';
import { INPUT_KICK } from './behaviour.js';
import { CHARACTER_NONE, VISCHAR_DRAWABLE, type Vischar } from './vischar.js';

/** vischar_ANIMINDEX_REVERSE ($B5F1 / $B6FE). */
export const ANIMINDEX_REVERSE = 0x80;

export interface AnimateResult {
  readonly moved: boolean;
  /** Set when the frame was refused by the collision test. */
  readonly blocked: boolean;
  /** Set when the animation restarted from a new input. */
  readonly restarted: boolean;
}

const STILL: AnimateResult = { moved: false, blocked: false, restarted: false };

/**
 * animate_init ($B6C2): pick an animation for (direction, input).
 *
 * `direction * 9 + input` indexes animindices -- nine inputs per direction, the
 * 3x3 grid flattened. The result's bit 7 is a reverse flag, and the animation's
 * own header supplies the direction the character ends up facing: byte 2 ('to')
 * going forwards, byte 1 ('from') going backwards.
 */
function initAnimation(v: Vischar): void {
  const cell = lookupAnimation(v.direction, v.input & 0x0f);
  const anim = animations[cell.animation];
  if (!anim) return;

  v.anim = cell.animation;

  if (!cell.reverse) {
    v.animIndex = 0; // $B6EC
    const to = anim.header[2];
    if (to !== undefined && to !== 0xff) {
      v.direction = (v.direction & DIRECTION_CRAWL) | (to & DIRECTION_MASK);
    }
    return;
  }

  // $B6FE: the index becomes nframes with the reverse bit set, so the first
  // step decrements to the last real frame.
  v.animIndex = (anim.frames.length | ANIMINDEX_REVERSE) & 0xff;
  const from = anim.header[1];
  if (from !== undefined && from !== 0xff) {
    v.direction = (v.direction & DIRECTION_CRAWL) | (from & DIRECTION_MASK);
  }
}

export interface AnimateContext {
  /** Interior bounds for the room, when indoors. */
  readonly interior?: InteriorBoundsState | undefined;
}

/**
 * One vischar, one frame.
 *
 * Returns without touching the position when the collision test refuses the
 * new one ($B647 / $B69C jump straight to animate_pop_next), which is what
 * makes a character stop dead at a wall rather than sliding through it. The
 * animation index is NOT advanced in that case either, so the character stays
 * on the same frame until something changes.
 */
export function animateVischar(v: Vischar, ctx: AnimateContext = {}): AnimateResult {
  if (v.character === CHARACTER_NONE) return STILL; // $B5D7

  // $B5E1: input_KICK means "start a new animation", and is consumed here.
  let restarted = false;
  if (v.input & INPUT_KICK) {
    v.input &= ~INPUT_KICK & 0xff; // $B6BE
    initAnimation(v);
    restarted = true;
  }

  let anim = animations[v.anim];
  if (!anim || anim.frames.length === 0) return { ...STILL, restarted };

  let reverse = (v.animIndex & ANIMINDEX_REVERSE) !== 0;
  let counter = v.animIndex & 0x7f;

  // The end-of-animation tests differ by direction, and the disassembly flags
  // the reverse one as a bug: "$B5F7 -- this ought to check for $7F, not
  // zero." Reproduced as written; the effect is that a reversed animation
  // restarts one frame early.
  //
  // Re-initialising does NOT end the frame. $B6F9 jumps into animate_forwards
  // and $B718 into animate_backwards, so a frame is applied on the same pass.
  // Returning here instead costs one movement frame per animation cycle --
  // three steps of travel per four-frame walk rather than four, which reads as
  // a slight stutter and makes every character walk about a quarter slow.
  if (reverse ? counter === 0 : counter === anim.frames.length) {
    initAnimation(v);
    restarted = true;
    anim = animations[v.anim];
    if (!anim || anim.frames.length === 0) return { ...STILL, restarted };
    reverse = (v.animIndex & ANIMINDEX_REVERSE) !== 0;
    counter = v.animIndex & 0x7f;
  }

  const frameIndex = reverse ? counter - 1 : counter;
  const frame = anim.frames[frameIndex];
  if (!frame) return { ...STILL, restarted };

  // $B615 subtracts going backwards, $B66A adds going forwards.
  const sign = reverse ? -1 : 1;
  const candidate: Pos = {
    x: (v.pos.x + frame.dx * sign) & 0xffff,
    y: (v.pos.y + frame.dy * sign) & 0xffff,
    height: (v.pos.height + frame.dh * sign) & 0xffff,
  };

  // $B644 / $B699 call `touch`, which also handles doors and character-to-
  // character collision. Only the bounds half exists so far; the door half is
  // reached through target_reached for NPCs, and the collision half is P5.
  // $AF93/$AF97: touch sets DONT_MOVE_MAP and DRAWABLE before it does anything
  // else, so a vischar that reaches this point is drawn this frame whether or
  // not the move is then refused.
  v.counterAndFlags |= VISCHAR_DRAWABLE;

  const { blocked } = boundsCheck(candidate, v.room, ctx.interior);
  if (blocked) {
    // $B1AF: a refused move flips Y_DOMINANT, which is what makes a blocked
    // character try the other axis and slide along the wall.
    v.counterAndFlags = toggleYDominant(v.counterAndFlags);
    return { moved: false, blocked: true, restarted };
  }

  v.pos = candidate;
  v.spriteIndex = frame.sprite;
  v.animIndex = reverse
    ? (v.animIndex - 1) & 0xff // $B64A
    : (v.animIndex + 1) & 0xff; // $B69F

  // $B6A5: recompute the projected position from the new one.
  const iso = calcIsoPos(v.pos);
  v.isoPos = { x: iso.x, y: iso.y };

  return { moved: true, blocked: false, restarted };
}

/** The frame's flip flag, for the renderer. */
export function currentFrame(v: Vischar) {
  const anim = animations[v.anim];
  if (!anim) return undefined;
  const reverse = (v.animIndex & ANIMINDEX_REVERSE) !== 0;
  const counter = v.animIndex & 0x7f;
  const index = reverse ? Math.max(0, counter - 1) : Math.min(counter, anim.frames.length - 1);
  return anim.frames[index];
}
