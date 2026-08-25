/**
 * plot_sprites (c$B866) and get_next_drawable (c$B89C): what gets drawn, and
 * in what order.
 *
 * "This plots all vischars and items in order." The order is depth order --
 * things further back are drawn first so nearer things overlap them -- and it
 * is arrived at by repeated selection rather than by sorting: each pass scans
 * for the rearmost thing still flagged for drawing, plots it, clears the flag,
 * and goes round again. Eight vischars and sixteen itemstructs compete in one
 * ordering; "this can return a vischar OR an itemstruct, but not both."
 *
 * The comparison is NOT a total order, and that is the interesting part. A
 * candidate is accepted only if it is at least as far back as the current best
 * on BOTH axes, so two things that each win on one axis are simply
 * incomparable; whichever the scan reaches first wins and the other is skipped
 * for that pass. Slot order therefore leaks into depth order. This is
 * reproduced, not corrected -- see FIDELITY.md.
 *
 * The two halves do not use the same test:
 *
 *   vischars ($B8C5, $B8D5)  accept when pos + 4 >= previous  -- a 4-unit
 *                            tolerance, so a candidate slightly in front of
 *                            the current best still wins
 *   items    ($DC07, $DC18)  accept only when pos * 8 > previous, strictly,
 *                            with no tolerance
 *
 * Items store position as bytes and are scaled by 8 to meet the vischars'
 * 16-bit scale ($B1C7).
 */

/** A vischar or itemstruct, reduced to what the ordering actually reads. */
export interface Drawable {
  readonly kind: 'vischar' | 'item';
  /** Slot index: 0..7 for vischars, 0..15 for itemstructs. */
  readonly index: number;
  /**
   * Position on the vischar scale (16-bit). Callers holding an itemstruct's
   * byte position must pass it already multiplied by 8.
   */
  readonly pos: { readonly x: number; readonly y: number; readonly height: number };
  /**
   * vischar_DRAWABLE ($8007 bit 7) for vischars; for items, both NEARBY flags
   * ($76C9 bits 7 and 6) -- the item half tests them separately but requires
   * both, so they collapse to one condition here.
   */
  drawable: boolean;
}

/** What one selection pass settled on, plus the state it settled it against. */
export interface Selection {
  readonly chosen: Drawable | null;
  readonly previousX: number;
  readonly previousY: number;
  /**
   * "Note that we maintain a previous_height but it's never usefully used."
   * ($B8A5) Tracked because the routine tracks it, and because its absence
   * from the item half is a real asymmetry: items never update it.
   */
  readonly previousHeight: number;
}

/**
 * One pass of get_next_drawable ($B89C): the rearmost thing still flagged.
 *
 * Both `SBC HL` comparisons run without an explicit `AND A` to clear carry
 * first -- $DC13 even carries a "Q. Why are we not clearing the carry flag"
 * note from the disassembler. Both turn out to be safe: every instruction that
 * could set carry on the way in leaves it clear for the values these routines
 * actually see (the vischar pointer arithmetic at $B8B4 cannot overflow, since
 * vischar bases run $8000..$80E0). So the comparisons are modelled as plain
 * arithmetic, without a borrow.
 */
export function getNextDrawable(vischars: Drawable[], items: Drawable[]): Selection {
  let previousX = 0; // $B89C
  let previousY = 0;
  let previousHeight = 0; // $B8A5
  let chosen: Drawable | null = null;

  // Vischars first, slot 0 upward ($B8AB, eight iterations at a 32-byte stride).
  for (const v of vischars) {
    if (!v.drawable) continue; // $B8AE
    if (v.pos.x + 4 < previousX) continue; // $B8C5
    if (v.pos.y + 4 < previousY) continue; // $B8D5
    chosen = v;
    // $B8DE..$B8EC: previous_* take the RAW position, without the +4.
    previousHeight = v.pos.height;
    previousY = v.pos.y;
    previousX = v.pos.x;
  }

  // Then itemstructs, continuing against the same previous_x/y ($B8FC).
  for (const item of items) {
    if (!item.drawable) continue; // $DBF1/$DBF5, both flags required
    if (item.pos.x <= previousX) continue; // $DC07/$DC09, strict
    if (item.pos.y <= previousY) continue; // $DC16/$DC18, strict
    chosen = item;
    // $DC1D..$DC25 update x and y only; previous_height is left alone.
    previousY = item.pos.y;
    previousX = item.pos.x;
  }

  return { chosen, previousX, previousY, previousHeight };
}

/**
 * plot_sprites' loop ($B866..$B89A), as a draw order.
 *
 * The real routine plots inside the loop and clears each thing's flag as it
 * goes ($B90A for a vischar, $B910 for an item). Here the same loop yields the
 * sequence instead, so the caller can plot it and the order can be tested on
 * its own. Flags are consumed on copies; the inputs are not modified.
 *
 * Anything left flagged but unreachable by the comparison would loop forever,
 * so the guard is the flag-clearing itself: every pass either picks something
 * (and clears it) or terminates.
 */
export function drawOrder(vischars: Drawable[], items: Drawable[]): Drawable[] {
  const vs = vischars.map((v) => ({ ...v }));
  const is = items.map((i) => ({ ...i }));

  const order: Drawable[] = [];
  for (;;) {
    const { chosen } = getNextDrawable(vs, is);
    if (chosen === null) return order; // $B869 / $B902: nothing remains
    chosen.drawable = false;
    order.push(chosen);
  }
}
