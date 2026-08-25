# Fidelity

What this reimplementation does with the original's bugs, quirks and dead code.

§9 of the brief draws the line: **reproduce visible quirks; do not reproduce crashes, hangs or
writes to ROM.** Where the two conflict the crash loses, and the divergence is recorded here
with the address, so the choice is auditable rather than silent.

Anything reproduced faithfully is also *tested* faithfully — a test that asserts the sensible
behaviour instead of the actual one is worse than no test, because it reads as confirmation.
Two of the entries below were found precisely because a test asserted what I expected.

---

## The disassembly is the unfixed image

Worth restating, because it inverts what `BUILD_PROMPT.md` §1 says. The `.skool` contains **no**
`@bfix`/`@rfix`/`@ofix` substitutions — none exist in the file. Every bug site encodes the
**original buggy bytes**, and the header's fix list is prose. So each fix is a deliberate
decision made here, not something inherited from the disassembly. See `OPEN_QUESTIONS.md` §1.

---

## Diverged from the original

### `$B935` — `exterior_mask_data` iteration count

`LD B,$3B` sets 59 iterations over a table holding 58 entries. The 59th reads past the end of
the table, and what it finds is whatever follows in the address space — not scenery data.

**Reproduced as 58.** `EXTERIOR_MASK_COUNT` is 58, with the coded value kept alongside as
`EXTERIOR_MASK_COUNT_AS_CODED = 59` (`src/render/maskbuffer.ts`) so the discrepancy stays
visible in the source rather than being quietly normalised. This is an out-of-bounds read, and
its visible effect depends on adjacent memory contents; §9 puts it on the "do not reproduce"
side.

### `$A2C6` — the `beds` overrun

`LD B,$07` iterates seven times over a six-entry array, and the seventh iteration writes to
`$1A42`, which is **ROM**. Named explicitly in §9 as not to be reproduced.

**Not yet reached** — the beds arrive with the day schedule in P4/P5. Recorded now so it is not
implemented from the raw byte count by accident.

---

## The complete fix ledger

The header names three bfixes and five rfixes. Since the `.skool` contains none of them as
directives (see above), each is a decision made here. All eight, with their disposition:

| Site | Described fix | Disposition |
|---|---|---|
| `$B935` | `exterior_mask_data` iteration count 59 → 58 | **Applied.** Out-of-bounds read; §9 excludes it. Both constants kept in source. |
| `$A2C6` | `beds` iteration count 7 → 6 | **To apply** when the beds land. ROM write, named in §9. |
| `$7CAF` | needless `RET Z` → `RET` | **No effect.** The condition is always met; a plain return is equivalent. |
| `$B916` | missing `RET` at the end of `render_mask_buffer` | **No effect**, and the disassembly says so: without it "the routine will harmlessly fall through into `multiply`", which computes a value nobody reads and returns. Returning normally is equivalent. |
| `$6B19` | redundant self-modifying code | **No effect.** Structural; nothing observable depends on it. |
| `$7AFB` | redundant jump | **No effect.** |
| `$A0B8` | redundant jump | **No effect.** |
| `$CCED` | `is_item_discoverable` off-by-one | **Open.** P5. The header calls it a "potential bug fix" and `TheGreatEscapeBugs.ref` describes an off-by-one at `$CCCD` where `HL` is decremented but not restored. The corrected form must be derived from the code, not the prose — see `OPEN_QUESTIONS.md` §1. |

So of the eight, one is applied, one is pending with a clear rule from §9, five are genuinely
inert, and one needs work when P5 reaches it. None of them block P4.

---

## Reproduced faithfully

### `get_next_drawable` ($B89C) is not a total order

The draw-order scan accepts a candidate only when it is at least as far back as the current
best on **both** axes. Two things that each win on one axis are incomparable, so whichever the
scan reaches first wins and the other is skipped for that pass. Slot order leaks into depth
order, and the same set of positions in different slots gives a different answer.

Reproduced (`src/render/drawlist.ts`), with a test that asserts the asymmetry directly rather
than asserting that the rearmost thing wins.

Two smaller oddities in the same routine, both kept:

- The vischar half compares with a **+4 tolerance** on each axis, so something up to 4 units in
  front of the current best still wins; the item half ($DC07) compares **strictly**, and equal
  loses. The two halves of one ordering disagree about ties.
- `previous_height` is maintained throughout and never usefully read — "*note that we maintain
  a previous_height but it's never usefully used*" ($B8A5). Items don't update it at all, so
  after an item is chosen it holds a stale value from the last vischar. Tracked, because
  dropping it would hide the asymmetry.

### `$B0A9` — pushing a movable item "backwards"

Direction 2 does not step the stove or crate; it **snaps it straight to the minimum** in one
go. The disassembly notes this "never seems to happen in practice in the game". It is what the
code does, so it is what `pushMovable` does (`src/game/movable.ts`).

### Declared sprite heights that overrun their data

Nine of the 38 `sprites` records declare more rows than fit before the next sprite's data
begins:

- `bitmap_dog_facing_bottom_right_3` ($CE9A) declares 3×15 = 45 bytes with 39 available — 15
  rows claimed where 13 fit.
- The eight prisoner walk frames ($CE2E..$CE58) each overrun by exactly one row: the records
  declare 27–29 rows, but consecutive bitmaps are stored at a stride two bytes shorter than
  the declared size.

The extractor reads **what the table declares**, inheriting the glitch, rather than clamping to
the gap (`tools/extract/tables.py`, `extract_sprites`). The last row of each affected sprite is
therefore whatever bytes follow — which for the prisoner is the previous frame's first row,
since those bitmaps descend through memory.

### The alternating blit paths

`plot_game_window` takes an aligned block-copy path or an unaligned nibble-roll path depending
on `game_window_offset`, and the two differ in both speed and byte count (`Fact:alternatingSpeed`).
Both are implemented separately (`src/render/window.ts`); collapsing them to one path is what
made the view swing 8 pixels sideways on alternate frames during P3.

### Unused content is present and labelled

Rooms 6, 26 and 27 are unreachable in the finished game. They are extracted, listed in the
demo's room selector, and marked `unused` — §9 wants unused things visibly unused rather than
dropped.

### The character set has no letter "O"

All five text blocks use `DEFB` in the game's own glyph codes, in a charset where digit zero
doubles as the letter O. Reproduced as-is; no substitution at extract time.

---

## Harmless-looking things that are genuinely harmless

Recorded so they are not "fixed" later by someone reading the same code and assuming a bug.

- **`$B88A CALL Z`** — "*it's odd to test for Z here since it's always set*". The conditional
  call is unconditional in practice. Modelled as a plain call.
- **`$DC13 SBC HL,DE` without a preceding `AND A`** — the disassembly asks "*Q. Why are we not
  clearing the carry flag like at #R$DC03?*". For the values these routines actually see the
  carry is already clear on entry, so the missing clear changes nothing. The comparisons are
  modelled as plain arithmetic, and `src/render/drawlist.ts` says why.
- **The `@isub` directives** — all six are cosmetic label substitutions for self-modifying
  code. The bytes are identical either way, so parsing ignores them.
