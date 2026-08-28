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

### The hero has his own copy of almost everything

Sitting and sleeping are implemented TWICE, and finding one does not mean you
have found the other:

| | characters | hero |
|---|---|---|
| sit | `character_sits` ($A420) | `hero_sits` ($A47F) |
| sleep | `character_sleeps` ($A444) | `hero_sleeps` ($A489) |
| common tail | `character_sit_sleep_common` ($A462) | `hero_sit_sleep_common` ($A491) |

They poke different objects with **different values**: the six prisoners get
`PRISONER_SAT_MID_TABLE` ($05) on benches A–F, the hero gets
`PRISONER_SAT_DOWN_END_TABLE` ($13) on bench_G, because he sits at the end of
the table. `end_of_breakfast` ($A31A) is the only place that treats all seven
as one list.

Getting up has two copies as well — `process_player_input` ($9E43 for the
bench, $9E5C for the bed) — and both poke the furniture back to its empty
graphic. Miss those and he walks away leaving a seated copy of himself behind.

### A write is not done until something reads it

The seated-prisoner bug had two halves, and each was invisible on its own:

- `character_sits` / `character_sleeps` existed as functions and **nothing
  called them**. `routeEnded` applied only the route HALT and left a comment
  saying the caller would do the rest. No caller did.
- Once they were called, the pokes were recorded in `RoomPokeState` and
  **`fillRoom` never read it**, so the bench graphic never changed.

Symptom of either: prisoners stand next to the furniture instead of sitting in
it. When adding a runtime write to what is otherwise constant data, check both
ends — the producer AND the consumer — and test the consumer separately.
`fillRoom` takes the overlay as an argument precisely so a test can prove it is
read.

Related: a poked value of **0 is meaningful** (the transparent tile, how
`action_shovel` removes the blockage at $B408), so the override test must be
`?? ` and not `||`.

### Three separate routines each own part of "the route ended"

The mess hall jam came back because handling a finished route is split across
three places, and each one had been left out independently:

- **`transition` ($68D4)** ends `AND A / JP Z`: the hero takes the hero path,
  and **everyone else exits via `reset_visible_character` ($C5D3)**, which hands
  the slot back — writing the new room, position and advanced route into the
  character struct and emptying the vischar. That is how an NPC survives a
  doorway. Without it the vischar keeps a target that is the door it just used,
  in the coordinate space of the room it just left.
- **`spawn_character` ($C5A4)** tests `get_target` for `ROUTE_ENDS`, calls
  `route_ended`, and **jumps back to try again** ($C5B4). Discard that result
  and a character spawns standing on its own terminator.
- **`character_sit_sleep_common` ($A463)** sets the route index to HALT before
  anything else. A seated prisoner with a live route walks off the end of it.

The symptom of any of the three is the same: characters converge on one square
and stay there until the next timed event. `tests/demoloop.test.ts` now asserts
the invariant directly — **a route step must never exceed its own route's
length** — which is worth more than any of the individual fixes, because routes
are packed and an overrun reads plausible-looking data instead of failing.

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

### Item state has one owner, and it is not `itemStructs()`

`itemStructs()` in `src/game/items.ts` decodes the **shipped** table. `createItemState()` in
`src/game/inventory.ts` is the mutable owner, and `readItemStruct` / `allItemStructs` are views
onto it. Calling `itemStructs()` during play rebuilds the world from the original bytes and
resurrects anything the hero picked up — the same hazard as the stove, in its fourth costume.
`src/main.ts` called it once per frame until P5.

### A routine can be implemented, tested, and still unreachable

P5's item logic passed every unit test while being impossible to trigger in the demo, for two
separate reasons at once:

- **no input was bound to it.** `process_player_input_fire` ($7AC9) is the only caller of pick
  up / drop / use, and nothing called it. The acceptance bar in `BUILD_PROMPT.md` §7 is "can be
  picked up, dropped and used", which is about the whole path, not the routine.
- **`mark_nearby_items` ($DB9E) did not exist.** No shipped itemstruct has NEARBY_7 set; the
  main loop sets it every frame. Without it `find_nearby_item` returns nothing forever, and so
  does the exterior half of `is_item_discoverable`.

When a phase's acceptance criterion is a verb the player performs, drive it in the browser
before calling the phase done. Both of these were invisible to 611 passing tests.

### Three things that look like the hero's position and are not

`hero_map_position` ($81B8) is the hero's own tinypos; `map_position` ($81BB), two bytes later,
is the view's scroll. `find_nearby_item`, `action_wiresnips` and `action_papers` read the first;
`mark_nearby_items` reads the second. And a third scaling exists: `stash_pos` ($E42D) rounds x
but truncates y and height, while `in_permitted_area` ($9F2E) uses `pos_to_tinypos`, which
rounds all three. Use `heroMapPosition` for the hero and `view.position` for the camera.

### The panel is persistent screen memory; the window buffer is not

The score, morale flag and message line are poked straight into the display file and stay there
until something overwrites them. The game window is rebuilt and re-blitted every frame from a
24×17 buffer. The demo clears the whole screen each frame, so the panel accumulates on its own
`SpectrumScreen` and is copied in before the window blit — otherwise a message that types one
character per tick loses every character but the last.

Also: `screen.clear(0x00, 0x00)` gives black ink on black paper, and the panel then draws
perfectly and invisibly. The game's own clear writes `$07` to every attribute ($F266).

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
Three more pairs that look interchangeable and are not:

- `calc_exterior_item_iso_pos` ($7BD0) works entirely in 8 bits and wraps;
  `calc_interior_item_iso_pos` ($7BF2) goes wide and divides by 8 with rounding. The
  disassembly says so at $7BF2. Neither is `calc_vischar_iso_pos_from_state`.
- `get_nearest_door` uses `door_in_range` ($B252, which multiplies the stored position by four)
  outdoors and the unscaled test at $B528 indoors, in the same routine.
- `find_nearby_item` ($7C91) tests **NEARBY_7 only**; the draw-order scan ($DBF1/$DBF5) requires
  both nearby bits.

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

**`tests/demoloop.test.ts` is the integration net, and it must MIRROR `src/main.ts`'s tick.**
It runs thousands of frames of the whole main loop in order. When the two drifted apart -- the
test's loop had no `heroSits`, no automatic door path and no `doorHandling` flag -- the hero
took a different route through breakfast, the simulation diverged from the demo, and the test
happily passed on behaviour the demo never exhibited. If you add a step to the demo's tick, add
it here in the same place. Every "fit" bug — the teleport, the double step, the gate, the mess hall — was
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
