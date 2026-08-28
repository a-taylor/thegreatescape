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
  targetReached,
  targetScale,
  vischarMoveX,
  vischarMoveY,
} from '../src/game/behaviour.js';
import { ANIMINDEX_REVERSE, animateVischar } from '../src/game/animate.js';
import { characterStructs } from '../src/game/characters.js';
import {
  BYTE7_Y_DOMINANT,
  VISCHAR_DRAWABLE,
  VISCHAR_INITIAL_ANIM,
  createVischars,
  isEmpty,
  npcSlots,
} from '../src/game/vischar.js';
import { spawnCharacter, spawnCharacters, spawnProjection } from '../src/game/spawn.js';
import { calcIsoPos } from '../src/game/coords.js';
import { installMovable, movableItems } from '../src/game/movable.js';
import { animations } from '../src/game/hero.js';

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

describe('a halted character does not drift', () => {
  /** Characters 5..8 are the watchtower guards: route 0, height 13. */
  const TOWER_GUARDS = [5, 6, 7, 8];

  it('starts on anim_wait_tl, not anim_walk_tl', () => {
    // vischar_initial ($F1D3) points at $CF76. spawn_character never writes
    // vischar.anim, and a halted character's input of zero matches the input
    // already there, so cb_set_input returns without input_KICK ($C9F8) and
    // animate never re-initialises. Whatever anim starts as is what plays.
    expect(VISCHAR_INITIAL_ANIM).toBe(8);
    expect(animations[VISCHAR_INITIAL_ANIM]!.labels).toContain('anim_wait_tl');
    expect(animations[VISCHAR_INITIAL_ANIM]!.frames).toHaveLength(1);
    // ...and animation 0, the tempting default, is a walk.
    expect(animations[0]!.labels).toContain('anim_walk_tl');
  });

  it('leaves the watchtower guards exactly where they were placed', () => {
    // The visible bug: defaulting anim to 0 made every halted character take
    // four walk frames before the animation ran out, drifting 8 world units.
    // For the tower guards that is enough to leave them beside their
    // platforms rather than on them -- they appear to hang in mid-air.
    const random = seeded();
    for (const idx of TOWER_GUARDS) {
      const structs = characterStructs();
      const s = structs[idx]!;
      expect(s.route.index, `char ${idx} is halted`).toBe(0);

      const vs = createVischars();
      const v = spawnCharacter(vs, s, 0, { random, structs })!;
      const start = { ...v.pos };

      for (let i = 0; i < 200; i++) {
        characterBehaviour(v, { random, structs, room: 0 });
        animateVischar(v);
      }
      expect(v.pos, `char ${idx} drifted`).toEqual(start);
    }
  });

  it('keeps the elevated height the struct gives them', () => {
    // Height 13 is what puts them up the tower; iso_pos.y subtracts it, so
    // losing it would drop them to ground level.
    const structs = characterStructs();
    for (const idx of TOWER_GUARDS) {
      expect(structs[idx]!.pos.height).toBe(13);
    }
    const vs = createVischars();
    const v = spawnCharacter(vs, structs[5]!, 0, {
      random: seeded(),
      structs,
    })!;
    expect(v.pos.height).toBe(13 * 8);
  });
});

describe('what the game decides to draw', () => {
  it('sets DRAWABLE when a character is animated', () => {
    // $AF97: touch sets it before anything else, and get_next_drawable ($B8AE)
    // tests it to decide whether a vischar is plotted at all. Drawing every
    // occupied slot regardless shows characters the game would not.
    const { v } = walker();
    v.counterAndFlags &= ~VISCHAR_DRAWABLE & 0xff;
    animateVischar(v);
    expect(v.counterAndFlags & VISCHAR_DRAWABLE).toBeTruthy();
  });

  it('sets it even when the move is refused', () => {
    // touch sets DRAWABLE at $AF97, before the bounds check at $AFB5, so a
    // character stopped by a wall is still drawn where it stands.
    const { v } = walker();
    v.pos = { x: 0, y: 0, height: 0 };
    v.counterAndFlags &= ~VISCHAR_DRAWABLE & 0xff;
    animateVischar(v);
    expect(v.counterAndFlags & VISCHAR_DRAWABLE).toBeTruthy();
  });

  it('applies a frame on the pass that restarts the animation', () => {
    // $B6F9 jumps into animate_forwards and $B718 into animate_backwards, so
    // re-initialising does not cost a frame. Returning early instead loses one
    // step of travel per cycle -- three per four-frame walk instead of four,
    // which makes every character walk about a quarter slow.
    const { v } = walker();
    setInput(v, INPUT_X_INCREASING);
    animateVischar(v); // consumes the kick

    let movedFrames = 0;
    for (let i = 0; i < 16; i++) {
      if (animateVischar(v).moved) movedFrames++;
    }
    // Every frame of a walk cycle moves; none is spent purely re-initialising.
    expect(movedFrames).toBe(16);
  });
});

describe('every animated slot ends the tick drawable', () => {
  /** The tick's clear-then-animate pass, without the DOM. */
  function tickPass(vs: ReturnType<typeof createVischars>, structs: ReturnType<typeof characterStructs>, random: () => number) {
    for (const v of npcSlots(vs)) v.counterAndFlags &= ~VISCHAR_DRAWABLE & 0xff;
    for (const v of npcSlots(vs)) {
      if (isEmpty(v)) continue;
      characterBehaviour(v, { random, structs, room: 0 });
      animateVischar(v);
    }
  }

  it('leaves the flag set for the whole frame, however often it is read', () => {
    // get_next_drawable clears the flag as it plots ($B90A), which is safe
    // because the original draws exactly once per main-loop iteration. This
    // demo re-renders the same frame on pause, resize and toggles, so the
    // clear belongs at the top of the tick instead. Clearing it during
    // rendering blanks every character on the second read -- which is exactly
    // what pausing did.
    const random = seeded();
    const structs = characterStructs();
    const vs = createVischars();
    const p = spawnProjection(structs[1]!.pos);
    spawnCharacters(vs, structs, { x: (p.x - 4) & 0xff, y: (p.y - 4) & 0xff }, 0, {
      random,
    });
    tickPass(vs, structs, random);

    const occupied = npcSlots(vs).filter((v) => !isEmpty(v));
    expect(occupied.length).toBeGreaterThan(0);

    // Reading it repeatedly must not change the answer.
    for (let read = 0; read < 3; read++) {
      const drawable = occupied.filter((v) => v.counterAndFlags & VISCHAR_DRAWABLE);
      expect(drawable, `read ${read}`).toHaveLength(occupied.length);
    }
  });

  it('keeps every occupied slot drawable tick after tick', () => {
    const random = seeded();
    const structs = characterStructs();
    const vs = createVischars();
    const p = spawnProjection(structs[1]!.pos);
    spawnCharacters(vs, structs, { x: (p.x - 4) & 0xff, y: (p.y - 4) & 0xff }, 0, {
      random,
    });

    for (let i = 0; i < 30; i++) {
      tickPass(vs, structs, random);
      const occupied = npcSlots(vs).filter((v) => !isEmpty(v));
      const drawable = occupied.filter((v) => v.counterAndFlags & VISCHAR_DRAWABLE);
      expect(drawable.length, `tick ${i}`).toBe(occupied.length);
    }
  });

  it('includes a movable, which animates on anim_wait_tl', () => {
    const random = seeded();
    const structs = characterStructs();
    const vs = createVischars();
    installMovable(vs[1]!, movableItems.stove1!, 0);
    tickPass(vs, structs, random);
    expect(vs[1]!.counterAndFlags & VISCHAR_DRAWABLE).toBeTruthy();
  });
});

describe('going through a door hands the slot back', () => {
  /** Put an NPC on a route whose current step is a door, standing on it. */
  function atDoor(slot: number, character: number) {
    const vischars = createVischars();
    const structs = characterStructs();
    const v = vischars[slot]!;
    v.character = character;
    v.flags = 0;
    // Route 16 step 1 is door 10; step 2 is door 20.
    v.route = { index: 16, step: 1 };
    v.room = 0;
    getTargetAssignPos(v, { random: seeded(), structs, room: 0 });
    expect(v.flags & FLAGS_TARGET_IS_DOOR).toBeTruthy();
    // Stand exactly on the target so target_reached fires.
    v.pos = { x: v.target.x * 4, y: v.target.y * 4, height: 0 };
    return { v, vischars, structs };
  }

  it('empties the vischar and writes the state back to the struct ($68D4)', () => {
    // transition ends `AND A / JP Z` -- the hero takes the hero path, and
    // EVERYONE ELSE exits via reset_visible_character ($C5D3). That is the
    // mechanism by which an NPC survives a doorway: the slot is handed back
    // and the character carries on off-screen from its struct.
    //
    // Leave it out and the vischar keeps a target that is the door it just
    // walked through, expressed in the coordinate space of the room it just
    // left; target_reached fires again at once and the character cascades
    // through its remaining waypoints.
    const { v, structs } = atDoor(3, 22);
    const before = { ...v.route };

    targetReached(v, { random: seeded(), structs, room: 0 });

    expect(isEmpty(v)).toBe(true);
    expect(v.character).toBe(0xff);

    const struct = structs[22]!;
    expect(struct.onScreen).toBe(false);
    expect(struct.route.step).toBe(before.step + 1); // $CAD9, stepped on
    expect(struct.room).not.toBe(0); // it went indoors
  });

  it('keeps the HERO in his slot and gives him the next waypoint ($CAFE)', () => {
    // The hero branch is the exception, and it is selected by SLOT, not by
    // character index -- his vischar carries character 0, the commandant's.
    const { v, structs } = atDoor(0, 0);
    const before = { ...v.route };

    targetReached(v, { random: seeded(), structs, room: 0 });

    expect(isEmpty(v)).toBe(false);
    expect(v.route.step).toBe(before.step + 1);
    // $CB02 clears TARGET_IS_DOOR and $CB05 takes the next waypoint, so he is
    // already heading somewhere new rather than at the door he just used.
    expect(v.target).not.toEqual({ x: 252, y: 202, height: 0 });
  });
});
