# Working on this project

A browser recreation of The Great Escape (1986, ZX Spectrum), derived **only** from David
Thomas's SkoolKit disassembly in `./The-Great-Escape/`. Read `BUILD_PROMPT.md` for the brief,
`PLAN.md` for the design, `OPEN_QUESTIONS.md` for resolved ambiguities and `FIDELITY.md` for
what happens at each known bug site.

This file is the part that is not in those: **how to work on it without repeating mistakes
that have already cost a dozen rounds of bug reports.** Everything below was learned the
expensive way.

---

## The rules that are not negotiable

- **The disassembly is the sole source of truth.** Never consult other reimplementations or
  ports. Every behaviour cites an address or `@label`.
- **Never invent.** If it cannot be determined from the disassembly, record it in
  `OPEN_QUESTIONS.md` with the address read and the assumption taken, and mark the code
  `// ASSUMPTION:`.
- **Parse, never transcribe.** No byte of game data is typed by hand. `src/` contains zero
  literal game data and a test enforces it.
- **Do not ship the tape image.** `The-Great-Escape/` is gitignored because it contains
  `build/TheGreatEscape.pristine.z80`. The repo is private; making it public would publish
  extracted copyrighted data.
- **Commit and push only when asked.**

---

## Coordinate scales — read this before touching any position

Four scales are in play and mixing them has caused more bugs here than everything else
combined. Guards on hut roofs, a teleporting hero, a hero walking into a fence and the mess
hall jam were all one confusion in different clothes.

| Space | Range | Where |
|---|---|---|
| **world** (`pos_t`) | 16-bit, ~0..2000 | `vischar.mi.pos` **outdoors** |
| **tinypos** | byte, world/8 | character structs, item structs, locations, `vischar.mi.pos` **indoors** |
| **iso** | `iso_pos.x` in bytes, `iso_pos.y` in pixel rows | projection; `map_position` lives here |
| **quartered** | byte, world/4 | door positions, but **only the outdoor half** |

Consequences that keep biting:

- **Indoors, `mi.pos` is tinypos-scale, not world.** The stove's record is `DEFW $003E,$0023,$0010`
  — plain 62, 35, 16. A room is ~40 units across.
- **A door's two halves are at different scales.** The outdoor half is quartered; the indoor
  half is room-local. `targetScale` ($C9C3) picks ×1 indoors, ×4 for a door outdoors, ×8 for a
  location outdoors. Read the wrong half with the wrong scale and the target lands in a fence.
- **`transition` multiplies by 4 for a vischar ($68B6); `move_a_character` halves for a
  character struct ($C763).** Both are right — a vischar holds world, a struct holds tinypos.
- **Item `iso_pos` is stored in TILE rows; vischar `iso_pos.y` is in PIXEL rows.**
  `setup_item_plotting` multiplies by 192, `setup_vischar_plotting` by 24. Applying the item
  rule to a character quantises him to 8-pixel steps — invisible outdoors, obvious bouncing
  indoors.

---

## Hazards that have each caused a real bug

### One game field, two objects

Every time a single game byte was split across two JS objects, it broke. Three times:

- the stove's position (`MovableState` vs vischar 1) — **twice**, once when a caller re-created
  the state and once when `animate` rebound `pos`
- the hero's route (a parallel object vs vischar 0)
- the hero's `counter_and_flags` — `bounds_check` toggles `Y_DOMINANT` in it ($B1AF) and
  `character_behaviour` reads it ($C9E1); split, the wall-slide alternation never happened and
  he pressed against walls forever

If the game has one byte, model one owner. Where the demo genuinely must keep hero state in
`HeroState` *and* vischar 0, copy explicitly and **both ways**, and say why in a comment.

### The hero is identified by his SLOT, not his character index

`$CB2D` (`route_ended`) and `$CAFC` (`target_reached`) both test `L == 2` / `L == 0` — vischar
0 — *before* looking at the character index. His vischar carries character **0**, which is also
the **commandant's** index. Going by index sends the hero down the commandant's branch.

### Routes are packed

Overrunning a terminator yields the *next route's* data rather than failing. Route 16 step 5
reads route 17's first waypoint quite happily. Any code that advances a step must handle the
end, not rely on the read failing.

### `get_target_assign_pos` falls through into `route_ended` ($CB29)

If you call it and discard the result, a route whose last waypoint IS a door never has its end
handled.

### Defaults come from `vischar_initial` ($F1C9), not from zero

`anim` defaults to 8 (`anim_wait_tl`), not 0 (`anim_walk_tl`). Zero made every halted character
drift 8 world units before the animation corrected itself — enough to walk the watchtower
guards off their platforms. Read the initial state; don't pick a plausible-looking zero.

### The renderer may run more than once per frame

`get_next_drawable` clears `DRAWABLE` as it plots ($B90A), which is safe because the game draws
exactly once per main-loop iteration. This demo re-renders on pause, resize and toggles.
Anything consumed during rendering must be idempotent; clear per-tick instead.

### Some doors do not change room

The exercise-yard gates (door pairs 0 and 1) have **both halves outdoors** — they are gaps in a
fence. Keying a transition on "did the room change" discards them.

---

## Before implementing a routine

**Enumerate everything it writes, then implement all of it.** The single most repeated mistake
here has been implementing a routine's obvious effect and dropping a step that did not look
related:

- `set_hero_route` ($A344) does three things; I did two, and the missing target sent the hero
  to (0,0)
- `setup_movable_item` ($697D) sets the room ($6996); omitting it made purge evict the stove
- `setup_vischar_plotting` adds `(iso_pos.y & 7) * 4` to the mask pointer ($E515); omitting it
  put a black bar across every character
- `event_wake_up` writes the **low byte** of `mi.pos` ($A293 `LD (HL),$2E` is one byte);
  assigning the word teleported an outdoor hero to the corner of the map

Also: **read the routine on the actual path**, not a neighbour that looks similar.
`setup_item_plotting` and `setup_vischar_plotting` differ in exactly the way that matters.

---

## Verification

Run before every commit:

```sh
npx tsc --noEmit && npx vitest run
.venv/bin/python -m tools.extract check      # committed data/ reproduces exactly
.venv/bin/python -m tools.extract.goldens    # pixel-compare against the reference build
npx vite build
```

**A new test must be shown to fail on the old behaviour.** Revert the fix, confirm it fails,
restore. This has repeatedly caught tests of mine that asserted nothing — `interiorMaskData.length > 0`
stayed true the entire time interior masking was completely broken.

**Measure before theorising.** Every bug in this project was found by instrumenting and
printing, not by reading harder. Sweeping positions, dumping route transitions, counting
blocked frames. When a symptom seems to point somewhere, check that place *is* the cause before
fixing it — one report about masking turned out to be a door-index error, and the mask code I
had verified at length was fine.

**`tests/demoloop.test.ts` is the integration net.** It runs 6,000 frames of the whole main
loop in order. Every "fit" bug — the teleport, the double step, the gate, the mess hall — was
invisible to per-routine tests and obvious there. Extend it when adding systems.

---

## Reproducing quirks

§9 of the brief: reproduce visible quirks, do **not** reproduce crashes, hangs or ROM writes.
When the disassembly flags a bug, decide deliberately and record it in `FIDELITY.md` with the
address. Examples already handled: the mask iteration count ($B935, diverged), the sixth
prisoner who never sits for breakfast ($C7D4, reproduced), the null-route ROM read at $0001
(reproduced with the known value).

Where a quirk is reproduced, **test it as the quirk** — a test asserting the sensible behaviour
instead of the actual one is worse than no test.

---

## Demo conventions

`src/main.ts` is a demo harness, not the game. Debug scaffolding is fine there and must be
labelled as such: the pause button, the speed multiplier, the jump-to-event control. None of it
belongs in `src/game/` or `src/render/`.

The demo starts where `reset_game` leaves the hero — room 2, asleep. An apparently empty hut is
the correct opening; the status line says `IN BED`.

A throw inside `setInterval` kills the loop silently. `bounds_check` throws when asked for an
interior room without its state — derive bounds per slot, never from a neighbouring value.
