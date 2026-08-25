/**
 * get_next_drawable (c$B89C) and plot_sprites' ordering loop (c$B866).
 */

import { describe, expect, it } from 'vitest';

import { drawOrder, getNextDrawable, type Drawable } from '../src/render/drawlist.js';

function vischar(index: number, x: number, y: number, height = 0): Drawable {
  return { kind: 'vischar', index, pos: { x, y, height }, drawable: true };
}

/** Items arrive already scaled by 8, as $B1C7 leaves them. */
function item(index: number, x: number, y: number): Drawable {
  return { kind: 'item', index, pos: { x: x * 8, y: y * 8, height: 0 }, drawable: true };
}

const ids = (ds: Drawable[]) => ds.map((d) => `${d.kind[0]}${d.index}`);

describe('selecting the rearmost drawable', () => {
  it('finds nothing when nothing is flagged', () => {
    const vs = [vischar(0, 100, 100)];
    vs[0]!.drawable = false;
    expect(getNextDrawable(vs, []).chosen).toBeNull();
  });

  it('ignores vischars whose DRAWABLE flag is clear', () => {
    // $B8AE BIT 7,(HL) -- the flag is the first thing tested, before position.
    const near = vischar(0, 500, 500);
    near.drawable = false;
    const far = vischar(1, 100, 100);
    expect(getNextDrawable([near, far], []).chosen).toBe(far);
  });

  it('picks the one furthest along both axes', () => {
    const chosen = getNextDrawable(
      [vischar(0, 100, 100), vischar(1, 300, 300), vischar(2, 200, 200)],
      [],
    ).chosen;
    expect(chosen!.index).toBe(1);
  });

  it('records the raw position, not the compared position', () => {
    // $B8DE..$B8EC store pos itself; the +4 exists only for the comparison.
    const r = getNextDrawable([vischar(0, 120, 130, 24)], []);
    expect(r.previousX).toBe(120);
    expect(r.previousY).toBe(130);
    expect(r.previousHeight).toBe(24);
  });
});

describe('the four-unit tolerance on vischars', () => {
  it('accepts a candidate up to 4 units in front of the current best', () => {
    // $B8C5 tests (pos.x + 4) < previous_x, so pos.x == previous_x - 4 passes.
    const r = getNextDrawable([vischar(0, 200, 200), vischar(1, 196, 196)], []);
    expect(r.chosen!.index).toBe(1);
  });

  it('rejects one 5 units in front', () => {
    const r = getNextDrawable([vischar(0, 200, 200), vischar(1, 195, 200)], []);
    expect(r.chosen!.index).toBe(0);
  });

  it('lets a later slot win a tie, since equality passes', () => {
    const r = getNextDrawable([vischar(0, 200, 200), vischar(1, 200, 200)], []);
    expect(r.chosen!.index).toBe(1);
  });
});

describe('the comparison is not a total order', () => {
  it('skips a candidate that wins on one axis and loses on the other', () => {
    // Neither dominates: slot 1 is further on Y, nearer on X. The scan keeps
    // slot 0 because slot 1 fails the X test, and slot 2 -- which really is
    // rearmost -- is then measured against slot 0.
    const r = getNextDrawable(
      [vischar(0, 300, 100), vischar(1, 100, 300), vischar(2, 310, 110)],
      [],
    );
    expect(r.chosen!.index).toBe(2);
  });

  it('gives different answers for the same set in a different slot order', () => {
    // The quirk made visible: identical positions, different slots, different
    // winner. A real sort could not do this.
    const a = getNextDrawable([vischar(0, 300, 100), vischar(1, 100, 300)], []);
    const b = getNextDrawable([vischar(0, 100, 300), vischar(1, 300, 100)], []);
    expect(a.chosen!.pos).toEqual({ x: 300, y: 100, height: 0 });
    expect(b.chosen!.pos).toEqual({ x: 100, y: 300, height: 0 });
  });
});

describe('items join the same ordering', () => {
  it('lets an item beat a vischar', () => {
    // $B8FC runs the item scan against the vischars' previous_x/y.
    const r = getNextDrawable([vischar(0, 100, 100)], [item(0, 50, 50)]);
    expect(r.chosen!.kind).toBe('item');
  });

  it('compares items strictly, with no tolerance', () => {
    // $DC07 jumps on Z as well as C: equal loses, where an equal vischar wins.
    const equal = getNextDrawable([vischar(0, 400, 400)], [item(0, 50, 50)]);
    expect(equal.chosen!.kind).toBe('vischar');

    const greater = getNextDrawable([vischar(0, 400, 400)], [item(0, 51, 51)]);
    expect(greater.chosen!.kind).toBe('item');
  });

  it('requires both NEARBY flags', () => {
    // $DBF1 and $DBF5 test bits 7 and 6 separately; either clear skips it.
    const it0 = item(0, 90, 90);
    it0.drawable = false;
    expect(getNextDrawable([vischar(0, 100, 100)], [it0]).chosen!.kind).toBe('vischar');
  });

  it('does not update previous_height', () => {
    // The item half ($DC1D..$DC25) writes x and y only.
    const r = getNextDrawable([vischar(0, 100, 100, 24)], [item(0, 50, 50)]);
    expect(r.chosen!.kind).toBe('item');
    expect(r.previousHeight).toBe(24); // left from the vischar
  });
});

describe('the plot_sprites loop', () => {
  it('draws back to front', () => {
    const order = drawOrder(
      [vischar(0, 100, 100), vischar(1, 300, 300), vischar(2, 200, 200)],
      [],
    );
    // Rearmost first, so nearer sprites overlap it.
    expect(ids(order)).toEqual(['v1', 'v2', 'v0']);
  });

  it('emits everything flagged, exactly once', () => {
    const vs = [0, 1, 2, 3].map((i) => vischar(i, 100 + i * 40, 100 + i * 40));
    const order = drawOrder(vs, [1, 2].map((i) => item(i, 10 + i, 10 + i)));
    expect(order).toHaveLength(6);
    expect(new Set(ids(order)).size).toBe(6);
  });

  it('skips what is not flagged', () => {
    const vs = [vischar(0, 100, 100), vischar(1, 300, 300)];
    vs[1]!.drawable = false;
    expect(ids(drawOrder(vs, []))).toEqual(['v0']);
  });

  it('leaves the caller\'s flags alone', () => {
    const vs = [vischar(0, 100, 100), vischar(1, 300, 300)];
    drawOrder(vs, []);
    expect(vs.every((v) => v.drawable)).toBe(true);
  });

  it('terminates even when the comparison is inconsistent', () => {
    // The incomparable pair above, plus more of the same. Termination comes
    // from clearing the flag, not from the ordering being sound.
    const vs = [
      vischar(0, 300, 100),
      vischar(1, 100, 300),
      vischar(2, 300, 100),
      vischar(3, 100, 300),
    ];
    expect(drawOrder(vs, [])).toHaveLength(4);
  });

  it('returns nothing for an empty scene', () => {
    expect(drawOrder([], [])).toEqual([]);
  });
});
