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

**Applied.** `BED_COUNT` is 6, with `BED_COUNT_AS_CODED = 7` kept alongside it
(`src/game/parcels.ts`) on the same pattern as `EXTERIOR_MASK_COUNT`. `emptyAllBeds` writes the
six prisoner beds plus the hero's ($A2CF, a separate poke into roomdef 2), and a test asserts
exactly seven objects change — not eight.

---

## The complete fix ledger

The header names three bfixes and five rfixes. Since the `.skool` contains none of them as
directives (see above), each is a decision made here. All eight, with their disposition:

| Site | Described fix | Disposition |
|---|---|---|
| `$B935` | `exterior_mask_data` iteration count 59 → 58 | **Applied.** Out-of-bounds read; §9 excludes it. Both constants kept in source. |
| `$A2C6` | `beds` iteration count 7 → 6 | **Applied.** ROM write, named in §9. Both constants kept in source. |
| `$7CAF` | needless `RET Z` → `RET` | **No effect.** The condition is always met; a plain return is equivalent. |
| `$B916` | missing `RET` at the end of `render_mask_buffer` | **No effect**, and the disassembly says so: without it "the routine will harmlessly fall through into `multiply`", which computes a value nobody reads and returns. Returning normally is equivalent. |
| `$6B19` | redundant self-modifying code | **No effect.** Structural; nothing observable depends on it. |
| `$7AFB` | redundant jump | **No effect.** |
| `$A0B8` | redundant jump | **No effect.** |
| `$CCED` | `is_item_discoverable` off-by-one | **Not applied — reproduced.** See below. The read stays inside `item_structs`, so §9's exclusions do not reach it. |

So of the eight, **two are applied** (`$B935`, `$A2C6` — both excluded by §9), five are
genuinely inert, and one (`$CCED`) is deliberately reproduced because it is a visible quirk
rather than an out-of-bounds read. The ledger is now closed: nothing is outstanding.

---

### Sound: the platform, not the reading

Three deviations, all forced by the browser rather than by anything in the disassembly. The
arithmetic behind the sound is faithful — see `OPEN_QUESTIONS.md` §17 for the T-state
assumptions and the counter formula that `tests/beeper.test.ts` pins against a chromatic scale.

- **Nothing sounds before the first key or click.** Browsers refuse to start an `AudioContext`
  without a user gesture. `menu_screen` starts its music the instant the menu appears; here
  `Beeper.resume()` is hung off the first `keydown` or `pointerdown` and the intention is
  remembered until then.
- **The tune is rendered once and looped.** `menu_screen` re-derives every note from the tables
  on every pass round its infinite loop ($F529 `JP $F4B7`). Fifty-four seconds of samples is
  cheaper to hold than to recompute, there is no way to hear the difference, and the render
  costs 14 ms.
- **The three `ring_bell` calls run together.** The main loop spaces them across the frame
  ($9D9C, $9DA8, $9DB1), between `animate`, `move_map` and `plot_sprites`. Nothing in between
  reads `$A130` or the ringer's graphic, so the only difference is where in the frame the
  clatter falls — and the frame is not a unit of time the player can hear.

What is NOT a deviation is the two-channel behaviour, which is easy to get wrong by reaching for
an oscillator. The channels do not mix: each writes its own value to the speaker with its own
`OUT` ($F50C and $F51D), so the cone follows whichever toggled last. That interference is the
sound of a Spectrum playing two notes at once, and it only comes out right by simulating the
one-bit port, which is what `renderTune` does.

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

### `$CCEB` — `is_item_discoverable` loses its place

`DEC HL` steps the pointer back from an itemstruct's room byte to its item byte and is never
undone. When the item turns out to be the green key or food, the `ADD HL,DE` at `$CCE7`
therefore advances from the wrong byte, and every later iteration of the scan is one byte
early: it tests bit 7 of an ITEM byte — `ITEM_FLAG_HELD`, not `NEARBY_7` — and reads its
"item index" out of the *previous* struct's `iso_pos.y`. The disassembly guesses the
consequence and stops there: "I think it'll screw up when multiple items are in range."

**Reproduced** (`src/game/discovery.ts`). The header lists this as a *potential* bug fix, and
§9's exclusions do not apply: the pointer drifts back one byte per skip while advancing seven,
so across sixteen iterations it stays inside the 112 bytes of `item_structs` and can never read
out of bounds. A test asserts the shifted read directly — a held item nowhere near the hero
reporting a nonsense index — and a second test drives the maximum possible drift to show the
scan stays in the array.

Two smaller misreadings in the same pair of routines are reproduced for the same reason, both
flagged by the disassembly:

- **`$CD17`** compares `default_item_locations[item].room_and_flags` whole against a room index
  that was masked with `$3F` two instructions earlier. Only one default location has flag bits
  set — the wiresnips, at `$FF` — so the effect is confined to that one item, which reads as
  "moved" wherever it is. The DOS version fixes this; this one does not.
- **`$CD44` / `$CD4F`** in `item_discovered` add the *unmasked* index back into two address
  calculations after masking it to `$0F`. Every caller passes an index below 16, where the two
  agree, so the divergence is unreachable in play — but it is coded as written rather than
  normalised.

### The character set has no letter "O"

All five text blocks use `DEFB` in the game's own glyph codes, in a charset where digit zero
doubles as the letter O. Reproduced as-is; no substitution at extract time.

### `$B803` — a reset character is briefly the wrong height

`reset_map_and_characters` ($B79B) puts the ten off-screen guards and prisoners back at their
`character_reset_data` spawn points after an arrest or a full reset, and sets their height to
18 (`LD (HL),$12`). Every other spawn path uses 24, and the disassembly flags the mismatch
directly: "This is reset to 18 here but the initial value is 24." A character reset this way is
therefore six units shorter than one freshly spawned, until the next animation frame corrects
it.

**Reproduced** (`src/game/characters.ts`'s `CHARACTER_RESET_HEIGHT`, used by
`resetMapAndCharacters` in `src/game/jeopardy.ts`). Six units for a handful of frames on an
already-brief transition is not worth diverging from the disassembly's own literal value over.

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
