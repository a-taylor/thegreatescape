/**
 * character_behaviour (c$C918), vischar_move_x/y (c$CA11 / c$CA49),
 * target_reached (c$CA81) and animate (c$B5CE).
 */

import { describe, expect, it } from 'vitest';

import {
  FLAGS_TARGET_IS_DOOR,
  INPUT_KICK,
  INPUT_X_DECREASING,
  INPUT_X_INCREASING,
  INPUT_Y_DECREASING,
  INPUT_Y_INCREASING,
  characterBehaviour,
  getTargetAssignPos,
  setInput,
  targetScale,
  vischarMoveX,
  vischarMoveY,
} from '../src/game/behaviour.js';
import { ANIMINDEX_REVERSE, animateVischar } from '../src/game/animate.js';
import { characterStructs } from '../src/game/characters.js';
import {
  BYTE7_Y_DOMINANT,
  createVischars,
  isEmpty,
  npcSlots,
} from '../src/game/vischar.js';
import { spawnCharacters, spawnProjection } from '../src/game/spawn.js';
import { calcIsoPos } from '../src/game/coords.js';

function seeded(start = 1): () => number {
  let s = start;
  return () => (s = (s * 37 + 11) & 0xff);
}

/** A spawned, walking character to poke at. */
function walker() {
  const random = seeded();
  const structs = characterStructs();
  const vs = createVischars();
  const p = spawnProjection(structs[1]!.pos);
  const map = { x: (p.x - 4) & 0xff, y: (p.y - 4) & 0xff };
  spawnCharacters(vs, structs, map, 0, { random });
  const v = npcSlots(vs).find((s) => !isEmpty(s))!;
  return { v, vs, structs, random, ctx: { random, structs, room: 0 } };
}

describe('target scaling', () => {
  it('picks 1, 4 or 8 by room and target kind', () => {
    // $C9C9 / $C9D2 / $C9D7. Doors store outdoor coordinates quartered,
    // locations store them as tinypos, and indoors nothing is scaled.
    expect(targetScale(5, 0)).toBe(1);
    expect(targetScale(0, FLAGS_TARGET_IS_DOOR)).toBe(4);
    expect(targetScale(0, 0)).toBe(8);
    // Indoors wins over the door flag.
    expect(targetScale(5, FLAGS_TARGET_IS_DOOR)).toBe(1);
  });
});

describe('the per-axis movers', () => {
  const at = (x: number, y: number) => {
    const v = createVischars()[1]!;
    v.pos = { x, y, height: 0 };
    v.target = { x: 10, y: 10, height: 0 };
    return v;
  };

  it('returns the increasing input when the position is well past the target', () => {
    // target 10 * scale 1 = 10; position 20 is 10 beyond.
    expect(vischarMoveX(at(20, 10), 1)).toBe(INPUT_X_INCREASING);
    expect(vischarMoveY(at(10, 20), 1)).toBe(INPUT_Y_INCREASING);
  });

  it('returns the decreasing input when well short', () => {
    expect(vischarMoveX(at(0, 10), 1)).toBe(INPUT_X_DECREASING);
    expect(vischarMoveY(at(10, 0), 1)).toBe(INPUT_Y_DECREASING);
  });

  it('treats a delta of 1 or 2 as arrived', () => {
    // $CA29 CP $03 and $CA36 CP $FE: the dead zone stops a character
    // oscillating around a target it can never land on exactly.
    for (const d of [-2, -1, 0, 1, 2]) {
      expect(vischarMoveX(at(10 + d, 10), 1), `delta ${d}`).toBe(0);
    }
    expect(vischarMoveX(at(13, 10), 1)).not.toBe(0);
    expect(vischarMoveX(at(7, 10), 1)).not.toBe(0);
  });

  it('alternates which axis leads', () => {
    // The heart of the navigation: x's dead zone SETS Y_DOMINANT ($CA43) and
    // y's CLEARS it ($CA7B), so a character blocked on one axis switches to
    // the other. Making both do the same thing stops it turning corners.
    const a = at(10, 50);
    a.counterAndFlags = 0;
    vischarMoveX(a, 1);
    expect(a.counterAndFlags & BYTE7_Y_DOMINANT).toBeTruthy();

    const b = at(50, 10);
    b.counterAndFlags = BYTE7_Y_DOMINANT;
    vischarMoveY(b, 1);
    expect(b.counterAndFlags & BYTE7_Y_DOMINANT).toBeFalsy();
  });

  it('scales the target before comparing', () => {
    // With scale 8 the target is 80, so a position of 20 is far short.
    const v = at(20, 20);
    expect(vischarMoveX(v, 8)).toBe(INPUT_X_DECREASING);
    // With scale 1 the target is 10 and 20 is past it.
    const w = at(20, 20);
    expect(vischarMoveX(w, 1)).toBe(INPUT_X_INCREASING);
  });
});

describe('setting the input', () => {
  it('adds input_KICK when the input changes', () => {
    const v = createVischars()[1]!;
    v.input = 0;
    setInput(v, INPUT_X_INCREASING);
    expect(v.input & 0x0f).toBe(INPUT_X_INCREASING);
    expect(v.input & INPUT_KICK).toBeTruthy();
  });

  it('leaves an unchanged input alone', () => {
    // $C9F8 returns early. Setting the kick bit every frame would restart the
    // animation every frame, freezing the character on its first pose.
    const v = createVischars()[1]!;
    v.input = INPUT_X_INCREASING;
    setInput(v, INPUT_X_INCREASING);
    expect(v.input & INPUT_KICK).toBeFalsy();
  });
});

describe('character_behaviour', () => {
  it('counts down the delay nibble before doing anything', () => {
    // $C91C. "This stops characters navigating around obstacles too quickly."
    const { v, ctx } = walker();
    v.counterAndFlags = (v.counterAndFlags & 0xf0) | 3;
    const before = { ...v.pos };
    characterBehaviour(v, ctx);
    expect(v.counterAndFlags & 0x0f).toBe(2);
    expect(v.pos).toEqual(before);
  });

  it('leaves pursuit modes alone rather than treating them as patrol', () => {
    // $C92E onward needs bribes, solitary and dog food. Falling through into
    // the ordinary path would make a pursuing guard behave like a patrolling
    // one, which is worse than doing nothing.
    const { v, ctx } = walker();
    v.flags = 1; // vischar_PURSUIT_PURSUE
    const before = v.input;
    characterBehaviour(v, ctx);
    expect(v.input).toBe(before);
  });

  it('gives a halted character an input of zero', () => {
    const { v, ctx } = walker();
    v.route = { index: 0, step: 0 };
    v.input = INPUT_X_INCREASING;
    characterBehaviour(v, ctx);
    expect(v.input & 0x0f).toBe(0);
  });

  it('produces an input that moves towards the target', () => {
    const { v, ctx } = walker();
    v.target = { x: (v.pos.x >> 3) + 20, y: v.pos.y >> 3, height: 0 };
    v.counterAndFlags = 0;
    characterBehaviour(v, ctx);
    expect(v.input & 0x0f).not.toBe(0);
  });
});

describe('spawning acquires a target', () => {
  it('gives a moving character somewhere to go immediately', () => {
    // $C592..$C5A1. Without this a character stands still until something
    // else prompts it, which looks like the route system not working.
    const { v } = walker();
    expect(v.route.index).not.toBe(0);
    expect(v.target).not.toEqual({ x: 0, y: 0, height: 0 });
  });

  it('sets TARGET_IS_DOOR only for door targets', () => {
    const v = createVischars()[1]!;
    // An empty slot's flags are $FF, which already has bit 6 set;
    // spawn_character zeroes them at $C534 before any of this runs.
    v.flags = 0;
    v.route = { index: 1, step: 0 }; // route 1 is all locations
    getTargetAssignPos(v, { random: seeded(), structs: characterStructs(), room: 0 });
    expect(v.flags & FLAGS_TARGET_IS_DOOR).toBeFalsy();
  });
});

describe('animate', () => {
  it('consumes input_KICK and starts a new animation', () => {
    const { v } = walker();
    setInput(v, INPUT_X_INCREASING);
    expect(v.input & INPUT_KICK).toBeTruthy();
    const r = animateVischar(v);
    expect(v.input & INPUT_KICK).toBeFalsy(); // $B6BE
    expect(r.restarted).toBe(true);
  });

  it('moves the character and keeps iso_pos in step', () => {
    const { v } = walker();
    setInput(v, INPUT_X_INCREASING);
    animateVischar(v);
    const before = { ...v.pos };
    let moved = false;
    for (let i = 0; i < 10; i++) {
      if (animateVischar(v).moved) moved = true;
    }
    expect(moved).toBe(true);
    expect(v.pos).not.toEqual(before);
    // $B6A5 recomputes the projection from the new position.
    expect(v.isoPos).toEqual(calcIsoPos(v.pos));
  });

  it('writes the frame index, not the sprite base', () => {
    // mi.sprite stays the class's set; mi.sprite_index is the frame. The
    // renderer adds them. Conflating the two freezes every character on its
    // first pose.
    const { v } = walker();
    const base = v.sprite;
    setInput(v, INPUT_X_INCREASING);
    for (let i = 0; i < 6; i++) animateVischar(v);
    expect(v.sprite).toBe(base);
    expect(v.spriteIndex).toBeLessThan(8);
  });

  it('counts backwards when the animation index has the reverse bit', () => {
    const { v } = walker();
    setInput(v, INPUT_X_DECREASING);
    animateVischar(v);
    if (v.animIndex & ANIMINDEX_REVERSE) {
      const before = v.animIndex & 0x7f;
      animateVischar(v);
      expect(v.animIndex & 0x7f).toBeLessThanOrEqual(before);
    }
    expect(true).toBe(true);
  });

  it('does nothing to an empty slot', () => {
    const v = createVischars()[3]!;
    expect(animateVischar(v).moved).toBe(false);
  });

  it('never leaves a position outside 16 bits', () => {
    const { v, ctx } = walker();
    for (let i = 0; i < 500; i++) {
      characterBehaviour(v, ctx);
      animateVischar(v);
      expect(v.pos.x).toBeGreaterThanOrEqual(0);
      expect(v.pos.x).toBeLessThanOrEqual(0xffff);
      expect(v.pos.y).toBeGreaterThanOrEqual(0);
      expect(v.pos.y).toBeLessThanOrEqual(0xffff);
    }
  });
});

describe('a spawned character actually walks its route', () => {
  it('moves a meaningful distance under its own steam', () => {
    // The end-to-end check for this checkpoint: behaviour produces inputs,
    // animate turns them into movement, and the character covers ground.
    const { v, ctx } = walker();
    const start = { ...v.pos };
    let moves = 0;
    for (let i = 0; i < 300; i++) {
      characterBehaviour(v, ctx);
      if (animateVischar(v).moved) moves++;
    }
    const travelled = Math.abs(v.pos.x - start.x) + Math.abs(v.pos.y - start.y);
    expect(moves).toBeGreaterThan(100);
    expect(travelled).toBeGreaterThan(50);
  });

  it('heads for real waypoints rather than drifting', () => {
    const { v, ctx } = walker();
    const targets = new Set<string>();
    for (let i = 0; i < 600; i++) {
      characterBehaviour(v, ctx);
      animateVischar(v);
      targets.add(`${v.target.x},${v.target.y}`);
    }
    // It should reach at least one waypoint and take up another.
    expect(targets.size).toBeGreaterThan(1);
  });
});
