/**
 * Hero movement: the (direction, input) -> animation -> delta chain.
 */

import { describe, expect, it } from 'vitest';

import {
  INPUT_DOWN,
  INPUT_FIRE,
  INPUT_LEFT,
  INPUT_NONE,
  INPUT_RIGHT,
  INPUT_UP,
  animIndices,
  animations,
  createHero,
  encodeInput,
  lookupAnimation,
  step,
} from '../src/game/hero.js';

function byLabel(label: string) {
  const a = animations.find((x) => x.labels.includes(label));
  if (!a) throw new Error(`no animation labelled ${label}`);
  return a;
}

describe('animation tables', () => {
  it('has the 24 animations the pointer table declares', () => {
    // "This is an array, 24 long, of pointers to animation data."
    expect(animations.length).toBe(24);
  });

  it('is an 8 x 9 direction/input grid', () => {
    // 8 directions (four, then the same four crawling) x the 3x3 input grid.
    expect(animIndices.length).toBe(8);
    for (const row of animIndices) expect(row.length).toBe(9);
  });

  it('never indexes past the end of the animation table', () => {
    // "the highest index in the table is 23 which is the max index".
    for (const row of animIndices) {
      for (const cell of row) {
        expect(cell.animation).toBeLessThan(animations.length);
      }
    }
  });

  it('matches the worked example in the disassembly', () => {
    // "if (direction,input) is (TL, None) then index is 8 which is anim_wait_tl"
    const cell = lookupAnimation(0, INPUT_NONE);
    expect(cell.animation).toBe(8);
    expect(animations[8]!.labels).toContain('anim_wait_tl');
  });

  it('matches the second worked example', () => {
    // "if (direction,input) is (TR + Crawl, D+L) then index is 21 which is
    //  anim_crawlwait_tr"
    const direction = 1 | 0x04; // TR + crawl
    const cell = lookupAnimation(direction, INPUT_DOWN + INPUT_LEFT);
    expect(cell.animation).toBe(21);
    expect(animations[21]!.labels).toContain('anim_crawlwait_tr');
  });
});

describe('walk animations carry the movement', () => {
  it('each walk cycle is four frames of two units on one axis', () => {
    expect(byLabel('anim_walk_tl').frames.map((f) => [f.dx, f.dy])).toEqual([
      [2, 0],
      [2, 0],
      [2, 0],
      [2, 0],
    ]);
    expect(byLabel('anim_walk_tr').frames.map((f) => [f.dx, f.dy])).toEqual([
      [0, 2],
      [0, 2],
      [0, 2],
      [0, 2],
    ]);
    expect(byLabel('anim_walk_br').frames.map((f) => [f.dx, f.dy])).toEqual([
      [-2, 0],
      [-2, 0],
      [-2, 0],
      [-2, 0],
    ]);
    expect(byLabel('anim_walk_bl').frames.map((f) => [f.dx, f.dy])).toEqual([
      [0, -2],
      [0, -2],
      [0, -2],
      [0, -2],
    ]);
  });

  it('the four walk directions cover both axes in both senses', () => {
    const deltas = ['tl', 'tr', 'br', 'bl'].map((d) => {
      const f = byLabel(`anim_walk_${d}`).frames[0]!;
      return `${f.dx},${f.dy}`;
    });
    expect(new Set(deltas).size).toBe(4);
  });
});

describe('input encoding', () => {
  it('is a flattened 3x3 grid, not a bitmask', () => {
    // up=1 down=2 left=3 right=6, so a diagonal is their sum.
    expect(encodeInput(true, false, false, false)).toBe(INPUT_UP);
    expect(encodeInput(false, true, false, false)).toBe(INPUT_DOWN);
    expect(encodeInput(false, false, true, false)).toBe(INPUT_LEFT);
    expect(encodeInput(false, false, false, true)).toBe(INPUT_RIGHT);
    expect(encodeInput(true, false, true, false)).toBe(INPUT_LEFT + INPUT_UP);
    expect(encodeInput(false, false, false, false)).toBe(INPUT_NONE);
  });

  it('adds 9 for fire', () => {
    expect(encodeInput(true, false, false, false, true)).toBe(INPUT_UP + INPUT_FIRE);
  });

  it('never produces a value outside the 3x3 grid without fire', () => {
    for (const up of [false, true]) {
      for (const down of [false, true]) {
        for (const left of [false, true]) {
          for (const right of [false, true]) {
            const v = encodeInput(up, down, left, right);
            expect(v).toBeGreaterThanOrEqual(0);
            expect(v).toBeLessThan(9);
          }
        }
      }
    }
  });
});

describe('stepping', () => {
  // A clear patch of the exterior map, away from every wall volume.
  const clear = { x: 8, y: 8, height: 0 };

  it('walks when the input matches the way the hero faces', () => {
    // (TL, UP) selects anim_walk_tl, which moves +2 on x.
    const hero = createHero(clear, 0, 0);
    const before = { ...hero.pos };
    const r = step(hero, INPUT_UP);
    expect(r.blocked).toBe(false);
    expect(hero.pos.x - before.x).toBe(2);
    expect(hero.pos.y).toBe(before.y);
  });

  it('turns instead of moving when the input is off-axis', () => {
    // (TL, LEFT) selects anim_turn_bl REVERSED. Turn animations have zero
    // deltas, so the hero pivots on the spot -- and ends up facing BL, because
    // reversing an animation ends it at its "from" direction.
    const hero = createHero(clear, 0, 0);
    const before = { ...hero.pos };
    const r = step(hero, INPUT_LEFT);
    expect(r.moved).toBe(true);
    expect(hero.pos).toEqual(before);
    expect(hero.direction & 0x03).toBe(3); // BL
  });

  it('turning then walking moves along the new axis', () => {
    const hero = createHero(clear, 0, 0);
    step(hero, INPUT_LEFT); // now facing BL
    const afterTurn = { ...hero.pos };
    // Facing BL, the walk input is LEFT -- anim_walk_bl moves -2 on y.
    step(hero, INPUT_LEFT);
    expect(hero.pos.y - afterTurn.y).toBe(-2);
  });

  it('maps the four screen directions onto the four world diagonals', () => {
    // The walk input for each facing is the SCREEN direction that facing points
    // in, not a fixed axis:
    //     TL <- up      TR <- right      BR <- down      BL <- left
    // which is exactly what an isometric view requires. Reading animindices as
    // if input mapped straight to a world axis gets this wrong.
    const walks: Array<[number, number, string]> = [
      [0, INPUT_UP, 'anim_walk_tl'],
      [1, INPUT_RIGHT, 'anim_walk_tr'],
      [2, INPUT_DOWN, 'anim_walk_br'],
      [3, INPUT_LEFT, 'anim_walk_bl'],
    ];
    for (const [direction, input, label] of walks) {
      const cell = lookupAnimation(direction, input);
      expect(animations[cell.animation]!.labels, `${label} for direction ${direction}`)
        .toContain(label);
      expect(cell.reverse).toBe(false);
    }
  });

  it('does not move when the input maps to a wait animation', () => {
    const hero = createHero(clear, 0, 0);
    const before = { ...hero.pos };
    step(hero, INPUT_NONE);
    expect(hero.pos).toEqual(before);
  });

  it('cycles through the animation frames', () => {
    const hero = createHero(clear, 0, 0);
    step(hero, INPUT_LEFT);
    const anim = animations[hero.animation]!;
    for (let i = 0; i < anim.frames.length * 2; i++) step(hero, INPUT_LEFT);
    expect(hero.frame).toBeLessThan(anim.frames.length);
  });

  it('blocks against a wall and toggles Y_DOMINANT', () => {
    // Start inside wall 0's volume so every step is refused.
    const hero = createHero({ x: 106 * 8 + 8, y: 82 * 8 + 8, height: 0 }, 0, 0);
    const before = { ...hero.pos };
    const flagsBefore = hero.counterAndFlags;

    const r = step(hero, INPUT_LEFT);
    expect(r.blocked).toBe(true);
    expect(r.moved).toBe(false);
    expect(hero.pos).toEqual(before);
    expect(hero.counterAndFlags).not.toBe(flagsBefore);

    // Toggling twice returns to the original value.
    step(hero, INPUT_LEFT);
    expect(hero.counterAndFlags).toBe(flagsBefore);
  });

  it('walks a long distance across open ground without getting stuck', () => {
    const hero = createHero({ x: 16, y: 16, height: 0 }, 0, 0);
    const start = { ...hero.pos };
    let moved = 0;
    for (let i = 0; i < 40; i++) if (step(hero, INPUT_UP).moved) moved++;
    expect(moved).toBe(40);
    expect(hero.pos).not.toEqual(start);
  });
});
