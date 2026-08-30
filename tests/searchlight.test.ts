/**
 * nighttime ($ADBD), searchlight_movement ($AD59) and searchlight_caught
 * ($AE78).
 */

import { describe, expect, it } from 'vitest';

import {
  CAUGHT_MORALE_COST,
  MASK_TEST_OFFSET,
  MASK_TEST_STRIDE,
  STATE_CAUGHT,
  STATE_SEARCHING,
  STEP_REVERSED,
  createSearchlights,
  nighttime,
  searchlightCaught,
  searchlightMaskTest,
  searchlightMovement,
} from '../src/game/searchlight.js';
import { MASK_BUFFER_SIZE } from '../src/render/sprites.js';
import { createPlayer } from '../src/game/player.js';
import {
  ATTR_BEAM,
  ATTR_NIGHT,
  CLIP_BOTTOM_ROW,
  CLIP_LEFT,
  CLIP_RIGHT,
  CLIP_RIGHT_CLIPPED,
  CLIP_TOP_ROW,
  SHAPE_BYTES_PER_ROW,
  SHAPE_ROWS,
  WINDOW_ORIGIN_COL,
  WINDOW_ORIGIN_ROW,
  lightOnScreen,
  searchlightPlot,
} from '../src/game/searchlight.js';
import { decodeBase64 } from '../src/data/load.js';
import timingJson from '../data/timing.json';

const ctx = (over: Record<string, unknown> = {}) => ({
  room: 0,
  mapPosition: { x: 200, y: 200 },
  player: createPlayer(),
  ringBell: () => {},
  ...over,
});

describe('the searchlight table', () => {
  it('has three lights, each with its own sweep', () => {
    const s = createSearchlights();
    expect(s.lights).toHaveLength(3);
    for (const l of s.lights) expect(l.path.length).toBeGreaterThan(0);
    // The paths differ -- a shared one would mean the pointers were misread.
    const shapes = s.lights.map((l) => JSON.stringify(l.path));
    expect(new Set(shapes).size).toBe(3);
  });

  it('ships mid-countdown, not searching ($81BD DEFB $04)', () => {
    // The shipped byte is $04, four frames from giving up -- NOT $FF. Starting
    // it at SEARCHING is a plausible-looking zero of exactly the kind
    // vischar_initial warns about, and it is wrong.
    expect(createSearchlights().state).toBe(4);
    expect(createSearchlights().state).not.toBe(STATE_SEARCHING);
  });
});

describe('searchlight_movement', () => {
  it('steps two units on x and one on y, by direction ($ADA2/$ADA9)', () => {
    const cases: Array<[number, number, number]> = [
      [0, -2, -1], // TOP_LEFT
      [1, +2, -1], // TOP_RIGHT
      [2, +2, +1], // BOTTOM_RIGHT
      [3, -2, +1], // BOTTOM_LEFT
    ];
    for (const [direction, dx, dy] of cases) {
      const light = {
        x: 100, y: 100, counter: 5, direction, step: 0,
        path: [{ counter: 5, direction }],
      };
      searchlightMovement(light);
      expect({ direction, x: light.x, y: light.y }).toEqual({
        direction, x: 100 + dx, y: 100 + dy,
      });
    }
  });

  it('takes the next path step when the counter runs out ($AD92)', () => {
    const light = {
      x: 100, y: 100, counter: 1, direction: 1, step: 0,
      path: [{ counter: 1, direction: 1 }, { counter: 9, direction: 3 }],
    };
    searchlightMovement(light);
    expect({ counter: light.counter, direction: light.direction, step: light.step })
      .toEqual({ counter: 9, direction: 3, step: 1 });
  });

  it('BOUNCES at the end of the path rather than looping ($AD8B)', () => {
    // Running off the end sets the reverse flag, so the light retraces its
    // sweep. Looping back to step 0 instead would make it jump across the
    // camp every time it finished.
    const light = {
      x: 100, y: 100, counter: 1, direction: 1, step: 1,
      path: [{ counter: 4, direction: 0 }, { counter: 4, direction: 1 }],
    };
    searchlightMovement(light);
    expect(light.step & STEP_REVERSED).toBe(STEP_REVERSED);
  });

  it('travels the opposite way while reversing ($ADA0 XOR $02)', () => {
    // Same stored direction, opposite motion -- that is what makes the
    // retrace a retrace rather than a second forward pass.
    const forward = {
      x: 100, y: 100, counter: 5, direction: 1, step: 0,
      path: [{ counter: 5, direction: 1 }],
    };
    const reverse = { ...forward, x: 100, y: 100, step: STEP_REVERSED | 1 };
    searchlightMovement(forward);
    searchlightMovement(reverse);
    expect(forward.y).not.toBe(reverse.y);
  });

  it('clears the reverse flag when the index reaches zero ($AD6E)', () => {
    const light = {
      x: 100, y: 100, counter: 1, direction: 1, step: STEP_REVERSED | 0,
      path: [{ counter: 7, direction: 2 }, { counter: 4, direction: 1 }],
    };
    searchlightMovement(light);
    expect(light.step & STEP_REVERSED).toBe(0);
  });
});

describe('searchlight_caught', () => {
  const light = (x: number, y: number) => ({
    x, y, counter: 5, direction: 0, step: 0, path: [{ counter: 5, direction: 0 }],
  });

  it('catches him when the beam overlaps the window ($AE7C)', () => {
    const s = createSearchlights();
    s.state = STATE_SEARCHING; // the branch this routine is called from ($AE19)
    const player = createPlayer();
    let rang = 0;
    // map_position (200,200): x needs sx+5 < 212 and sx+10 >= 210.
    const caught = searchlightCaught(s, light(200, 200), { x: 200, y: 200 }, player, () => rang++);
    expect(caught).toBe(true);
    expect(s.state).toBe(STATE_CAUGHT);
    expect(s.caught).toEqual({ x: 200, y: 200 });
    expect(rang).toBe(1);
    expect(player.morale).toBe(112 - CAUGHT_MORALE_COST);
  });

  it('misses when the beam is elsewhere', () => {
    const s = createSearchlights();
    // searchlight_caught is only reached from the SEARCHING branch ($AE19),
    // so that is the state to test it in -- not whatever ships at $81BD.
    s.state = STATE_SEARCHING;
    expect(searchlightCaught(s, light(20, 20), { x: 200, y: 200 }, createPlayer(), () => {}))
      .toBe(false);
    expect(s.state).toBe(STATE_SEARCHING);
  });

  it('does not charge morale twice for the same capture ($AE9D)', () => {
    const s = createSearchlights();
    const player = createPlayer();
    searchlightCaught(s, light(200, 200), { x: 200, y: 200 }, player, () => {});
    const after = player.morale;
    searchlightCaught(s, light(200, 200), { x: 200, y: 200 }, player, () => {});
    expect(player.morale).toBe(after);
  });
});

describe('nighttime', () => {
  it('sweeps all three lights while searching ($AE0D)', () => {
    const s = createSearchlights();
    s.state = STATE_SEARCHING; // $81BD ships at $04; this is the sweeping branch
    const before = s.lights.map((l) => ({ x: l.x, y: l.y }));
    const drawn = nighttime(s, ctx({ mapPosition: { x: 20, y: 20 } }));
    expect(drawn).toHaveLength(3);
    // All three actually moved.
    for (let i = 0; i < 3; i++) {
      expect({ i, moved: s.lights[i]!.x !== before[i]!.x || s.lights[i]!.y !== before[i]!.y })
        .toEqual({ i, moved: true });
    }
  });

  it('loses him the moment he gets indoors ($ADCC)', () => {
    // The ONLY thing that shakes off a searchlight.
    const s = createSearchlights();
    s.state = STATE_CAUGHT;
    const drawn = nighttime(s, ctx({ room: 5 }));
    expect(s.state).toBe(STATE_SEARCHING);
    expect(drawn).toEqual([]);
  });

  it('tracks him with ONE light once caught, and stops sweeping ($ADD2)', () => {
    const s = createSearchlights();
    s.state = STATE_CAUGHT;
    s.caught = { x: 100, y: 100 };
    const frozen = s.lights.map((l) => ({ x: l.x, y: l.y }));

    const drawn = nighttime(s, ctx({ mapPosition: { x: 140, y: 140 } }));

    expect(drawn).toHaveLength(1);
    // It closes on him...
    expect(s.caught.x).toBeGreaterThan(100);
    expect(s.caught.y).toBeGreaterThan(100);
    // ...and the other two are not being simulated at all.
    for (let i = 0; i < 3; i++) {
      expect({ i, x: s.lights[i]!.x, y: s.lights[i]!.y }).toEqual({ i, ...frozen[i]! });
    }
  });
});

describe('searchlight_plot', () => {
  const shape = () => decodeBase64(
    (timingJson as unknown as { searchlightShape: { data: string } }).searchlightShape.data,
  );

  it('is a 16x16 ATTRIBUTE block, not pixels', () => {
    expect(shape()).toHaveLength(SHAPE_ROWS * SHAPE_BYTES_PER_ROW);
    // y = 2 so all sixteen rows fall inside the window; at y = 4 the bottom
    // two are clipped, which is the behaviour the crop test covers.
    const cells: Array<[number, number, number]> = [];
    searchlightPlot({ x: 10, y: CLIP_TOP_ROW }, shape(), false, (c, r, a) => cells.push([c, r, a]));
    const cols = new Set(cells.map(([c]) => c));
    const rows = new Set(cells.map(([, r]) => r));
    expect(cols.size).toBe(16);
    expect(rows.size).toBe(16);
  });

  it('paints yellow where the shape is set and BLUE where it is not ($AF24/$AF28)', () => {
    // The clear bits matter: the beam repaints the night around itself, which
    // is why the camp is blue after dark. Plotting only the set bits would
    // leave the beam with no surround.
    const attrs = new Set<number>();
    searchlightPlot({ x: 10, y: 4 }, shape(), false, (_c, _r, a) => attrs.add(a));
    expect(attrs).toEqual(new Set([ATTR_BEAM, ATTR_NIGHT]));
  });

  it('crops rows outside the window rather than shifting them ($AED2)', () => {
    // A row above the window is skipped and the shape pointer still advances,
    // so the beam is cut off at the edge instead of sliding down it.
    const rows: number[] = [];
    searchlightPlot({ x: 10, y: -6 }, shape(), false, (_c, r) => rows.push(r));
    expect(Math.min(...rows)).toBe(CLIP_TOP_ROW);
    expect(rows.every((r) => r >= CLIP_TOP_ROW && r < CLIP_BOTTOM_ROW)).toBe(true);
  });

  it('clips columns to the window, and tighter when clip_left is set ($AF06)', () => {
    const wide: number[] = [];
    searchlightPlot({ x: 20, y: 4 }, shape(), false, (c) => wide.push(c));
    expect(Math.max(...wide)).toBeLessThan(CLIP_RIGHT);

    const narrow: number[] = [];
    searchlightPlot({ x: 20, y: 4 }, shape(), true, (c) => narrow.push(c));
    expect(Math.max(...narrow)).toBeLessThan(CLIP_RIGHT_CLIPPED);
    expect(narrow.length).toBeLessThan(wide.length);
  });

  it('never plots left of column 7 ($AF18)', () => {
    const cols: number[] = [];
    searchlightPlot({ x: 0, y: 4 }, shape(), false, (c) => cols.push(c));
    expect(Math.min(...cols)).toBeGreaterThanOrEqual(CLIP_LEFT);
  });
});

describe('lightOnScreen', () => {
  it('converts map coordinates to the window\'s attribute cells ($AE45)', () => {
    // The lights live in MAP space; the window shows map columns
    // [map_x, map_x+23) at screen columns [7, 30). Plotting the raw map
    // coordinate puts the beam off-window, where the row clip eats it and
    // nothing is drawn at all.
    const at = lightOnScreen({ x: 70, y: 60 }, { x: 65, y: 58 });
    expect(at).toEqual({ x: WINDOW_ORIGIN_COL + 5, y: WINDOW_ORIGIN_ROW + 2, clipLeft: false });
  });

  it('drops lights outside the window on all four sides ($AE22)', () => {
    const map = { x: 100, y: 100 };
    expect(lightOnScreen({ x: 124, y: 100 }, map)).toBeNull(); // right
    expect(lightOnScreen({ x: 83, y: 100 }, map)).toBeNull(); // left
    expect(lightOnScreen({ x: 100, y: 117 }, map)).toBeNull(); // top
    expect(lightOnScreen({ x: 100, y: 83 }, map)).toBeNull(); // bottom
    expect(lightOnScreen({ x: 100, y: 100 }, map)).not.toBeNull();
  });

  it('flags a light straddling the left edge rather than dropping it ($AE4B)', () => {
    const at = lightOnScreen({ x: 98, y: 100 }, { x: 100, y: 100 });
    expect(at?.clipLeft).toBe(true);
  });
});

describe('searchlight_mask_test ($B83B)', () => {
  // The buffer is four bytes wide; the test samples one byte per pixel row
  // from $31, eight rows apart by four ($B841/$B84B).
  const clear = () => new Uint8Array(MASK_BUFFER_SIZE);
  const exposed = () => {
    const b = clear();
    // Any ONE of the eight sampled bytes non-zero is enough.
    b[MASK_TEST_OFFSET + 3 * MASK_TEST_STRIDE] = 0x01;
    return b;
  };

  it('counts down one frame at a time while he is fully hidden ($B854)', () => {
    const s = createSearchlights();
    s.state = STATE_CAUGHT;
    searchlightMaskTest(s, clear());
    expect(s.state).toBe(STATE_CAUGHT - 1);
    searchlightMaskTest(s, clear());
    expect(s.state).toBe(STATE_CAUGHT - 2);
  });

  it('snaps back to CAUGHT the moment any part of him is exposed ($B860)', () => {
    // This is the whole tension: 31 frames of hiding are undone by one frame
    // in the open. Without it the counter would drift down regardless and the
    // hero would escape a light that plainly still has him.
    const s = createSearchlights();
    s.state = STATE_CAUGHT;
    for (let i = 0; i < 10; i++) searchlightMaskTest(s, clear());
    expect(s.state).toBe(STATE_CAUGHT - 10);
    searchlightMaskTest(s, exposed());
    expect(s.state).toBe(STATE_CAUGHT);
  });

  it('reads the mask as a PERMISSION mask, not an occlusion one', () => {
    // render_mask_buffer fills $FF and ANDs scenery in, so 1 = "the sprite may
    // draw here". A buffer of $FF therefore means NOTHING covers him -- fully
    // exposed -- which reads backwards from the routine's own header comment
    // about "hiding behind the scenery". Measured against the real buffer
    // semantics in src/render/maskbuffer.ts, not inferred from the comment.
    const s = createSearchlights();
    s.state = STATE_CAUGHT - 5;
    const wideOpen = new Uint8Array(MASK_BUFFER_SIZE).fill(0xff);
    searchlightMaskTest(s, wideOpen);
    expect(s.state).toBe(STATE_CAUGHT);
  });

  it('gives up when the counter wraps $00 -> $FF ($B855)', () => {
    const s = createSearchlights();
    s.state = STATE_CAUGHT;
    // 31 decrements reach 0; the 32nd wraps to SEARCHING.
    let gaveUp = false;
    for (let i = 0; i < STATE_CAUGHT; i++) {
      expect(searchlightMaskTest(s, clear())).toBe(false);
    }
    expect(s.state).toBe(0);
    gaveUp = searchlightMaskTest(s, clear());
    expect(gaveUp).toBe(true);
    expect(s.state).toBe(STATE_SEARCHING);
  });

  it('takes 32 consecutive hidden frames to escape', () => {
    // The acceptance number: a light that has him is not a one-way trap.
    const s = createSearchlights();
    s.state = STATE_CAUGHT;
    let frames = 0;
    while (s.state !== STATE_SEARCHING) {
      searchlightMaskTest(s, clear());
      frames++;
      expect(frames).toBeLessThan(100); // never loop forever
    }
    expect(frames).toBe(32);
  });

  it('does nothing once the light is already searching ($B87B)', () => {
    // plot_sprites only calls it when the state is not SEARCHING; guarding
    // inside as well keeps a stray call from wrapping $FF round to $FE.
    const s = createSearchlights();
    s.state = STATE_SEARCHING;
    expect(searchlightMaskTest(s, clear())).toBe(false);
    expect(s.state).toBe(STATE_SEARCHING);
  });

  it('escapes only on CONSECUTIVE hidden frames', () => {
    const s = createSearchlights();
    s.state = STATE_CAUGHT;
    // Hide for 20, get seen once, hide for 20 more: still not out, because
    // the sighting reset the counter to 31 and 20 < 32.
    for (let i = 0; i < 20; i++) searchlightMaskTest(s, clear());
    searchlightMaskTest(s, exposed());
    for (let i = 0; i < 20; i++) searchlightMaskTest(s, clear());
    expect(s.state).not.toBe(STATE_SEARCHING);
    expect(s.state).toBe(STATE_CAUGHT - 20);
  });
});
