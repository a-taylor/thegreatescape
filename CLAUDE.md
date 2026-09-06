# Working on this project

A browser recreation of The Great Escape (1986, ZX Spectrum), derived **only** from David
Thomas's SkoolKit disassembly in `./The-Great-Escape/`. Read `PLAN.md` for the design,
`OPEN_QUESTIONS.md` for resolved ambiguities and `FIDELITY.md` for what happens at each known
bug site.

`BUILD_PROMPT.md` is the original brief and is **not published** — it is gitignored. The
`BUILD_PROMPT.md §N` citations throughout the source point into it, and are kept because they
are precise about *which* requirement a piece of code exists to satisfy.

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
  `build/TheGreatEscape.pristine.z80`, the original 48K game image. Nothing that would let
  someone reconstruct it belongs here.
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

Every time a single game byte was split across two JS objects, it broke. Four times:

- the stove's position (`MovableState` vs vischar 1) — **twice**, once when a caller re-created
  the state and once when `animate` rebound `pos`
- the hero's route (a parallel object vs vischar 0)
- the hero's `counter_and_flags` — `bounds_check` toggles `Y_DOMINANT` in it ($B1AF) and
  `character_behaviour` reads it ($C9E1); split, the wall-slide alternation never happened and
  he pressed against walls forever
- `day_or_night` ($A146) — the demo's Night button held its own `night` boolean while the
  searchlights read `schedule.night`. The button darkened the window and started nothing, so
  the entire searchlight system was unreachable from the demo. **This one was invisible for a
  different reason than the others: nothing was wrong, it just never ran.** A split field does
  not always corrupt state; sometimes it quietly disconnects a feature.

If the game has one byte, model one owner. Where the demo genuinely must keep hero state in
`HeroState` *and* vischar 0, copy explicitly and **both ways**, and say why in a comment.

### The hero is identified by his SLOT, not his character index

`$CB2D` (`route_ended`) and `$CAFC` (`target_reached`) both test `L == 2` / `L == 0` — vischar
0 — *before* looking at the character index. His vischar carries character **0**, which is also
the **commandant's** index. Going by index sends the hero down the commandant's branch.

### Verify that an edit actually landed

The solitary lock-up survived three rounds of fixes because the line that
cleared `in_solitary` was never in the file. A scripted `str.replace` whose
anchor does not match silently changes nothing, and the surrounding work --
typecheck, tests, a browser run -- all still pass, because the missing line is
one the tests do not reach.

After any scripted edit, grep for the thing you just added. Better: use the
editing tools, which fail loudly on a missed anchor.

### Two entry points to one routine mean two different behaviours

`set_hero_route` ($A33F) tests `in_solitary` and returns; **`set_hero_route_force`
($A344)** is the same routine one instruction later, without that test.
`charevnt_hero_release` jumps to `$A344` ($C859) precisely BECAUSE the hero is
in solitary at that moment — the whole point is to give him a route out.

Route the release through `$A33F` and it silently does nothing: `in_solitary`
is never cleared, `automatics` forces CPU control forever, and the hero presses
into a corner of the cell alternating direction, with no player input accepted.

The release is a CHAIN, and every link is in a different routine:

    commandant finishes route 36  ->  charevnt_hero_release ($C84C)
      ...which forces the HERO onto route 37 ($C856/$C859)
      ...and zeroes automatic_player_counter ($C853)
    hero finishes route 37        ->  charevnt_solitary_ends ($C83F)
      ...which is the ONLY thing that ever clears in_solitary

Two of those three effects are on global state rather than on the character
whose route ended, which is why they were dropped: `applyCharacterEvent` only
had the character's own route to write to.

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

This has now bitten twice, and the second one is the general shape: **`searchlight_mask_test`
($B83B) runs inside `plot_sprites` and DECREMENTS `searchlight_state`.** Ported literally, a
paused frame would count a searchlight down to nothing while the player was not even playing.

The fix is a pattern worth reusing whenever a draw-time routine mutates: **the render
snapshots, the tick consumes.** `render()` copies the hero's mask buffer into `heroForeground`
and sets `heroPlotted` — both pure writes, safe to repeat any number of times — and `tick()`
runs the actual test once, after `render()` returns. Ordering is preserved (the test still sees
the buffer built for this frame's hero) without the mutation being tied to how often the
renderer happens to run.

Before porting anything called from `plot_sprites` or `render_mask_buffer`, ask what it writes.
If the answer is anything at all, it does not belong in `render()`.

### The wire cut writes to the VISCHAR, and the hero is a different object

The sixth costume of "one game field, two objects", and the worst one, because it made the
game **uncompletable** rather than merely wrong.

`snips_tail` ($B474/$B47F) and `cutting_wire` ($9ED5/$9EDB) between them write four things: the
hero's `direction`, his `pos.height` (12 to crawl through, back to 24 after), and his `input` —
four scripted values from `cutting_wire_new_inputs` ($9EE0) fed over the last three turns of a
cut, whose entire job is to **walk him through the gap he has just made**. Every one of those
writes goes to vischar 0, which in the original is exactly where those bytes live: `animate`
reads `vischar.input` and moves him.

This port keeps the hero's position in its own `HeroState` and rebuilds vischar 0 from it every
frame. So all four writes were overwritten before anything read them. He snipped the wire, stood
exactly where he was, and stayed in the camp — and since the fence is the only way out, no game
could ever be finished.

The fix is a both-ways copy, and it has to be **scoped to the cut**: at every other moment the
vischar's height and direction are written FROM the hero, so copying them back unconditionally
drags his height to a stale value and pins him where he stands. `src/main.ts` and
`tests/harness/loop.ts` both carry it, keyed on `FLAGS_CUTTING_WIRE` being set at either end of
the tick.

**Nothing in 774 other tests noticed**, because no test had ever driven a cut to completion
inside the real loop. `tests/walkthrough.test.ts` does, and both of its wire-cut assertions were
shown to fail on the old behaviour.

### The camp is sealed: you cannot walk off the map

Measured, not assumed. Breadth-first search over `outdoorBoundsCheck` — the game's own wall test
— reaches **34,532 outdoor squares** from the hut door, and not one satisfies `in_permitted_area`'s
escape test at $9F31. So "run off-screen and you've escaped" is the last step of a route that has
already got the hero out: through the cut wire, through the tunnel, or out of the main gate on
forged papers in a stolen uniform (`action_papers` $EFCB, whose `outside_main_gate` destination
$EFF9 is far past the line). The test that pins this is worth more than an escape assertion,
because it is the fact that makes those routes necessary.

### A pathfinding grid must be the hero's FINEST step, not his usual one

Wall 12 is a **two-unit sliver** at x=562. A four-unit search grid steps clean over it and reports
a clear straight corridor east of hut 2 — which the hero then walks into and stops dead against,
looking exactly like a navigator bug. The animation frames carry deltas of two as well as four, so
two is the finest step he takes, and only a grid at his finest step cannot invent a gap.
`tests/harness/path.ts` uses two, and says why.

### A pile of dropped items hands you the lowest index

Already noted above that `find_nearby_item` ($7C91) returns the first item **by index**, not the
nearest. The consequence only bites when something drops items repeatedly in one place:
`action_red_cross_parcel` ($B387) drops the contents at the hero's feet, which is the square the
NEXT parcel lands on, so tomorrow's parcel (index 12) under yesterday's wiresnips (index 0) hands
you the wiresnips. And `drop` ($7B8B) always drops slot **zero** and shifts slot 1 down — the held
pair is a queue, not two slots to choose between, so "keep this, discard that" is not a thing the
player can express in one command.

### An asset with a reference render and no golden test is a bug waiting

`static_tiles` ($7F00) is the ONE tile set in the game whose stride is not eight. It is nine:
eight pixel rows and a trailing attribute byte that `plot_static_tiles` writes to the cell
($F219 multiplies the index by nine, $F23E reads the ninth). The block comment says so outright
— *"9 bytes each: 8x8 bitmap + 1 byte attribute. 75 tiles."*

It was extracted at stride eight for four phases. That put 84 tiles where there are 75, read
every tile after the first from the wrong offset, and dropped three bytes. Nothing noticed,
because nothing draws a static tile until P7 — and, more to the point, because
`images/udgs/static-tiles.png` was sitting in the reference build the whole time and
`goldens.py` never looked at it. **The oracle existed and was not wired in.** If the reference
build ships a render of something, compare against it; the cost is twenty lines and it is the
difference between finding this in P0 and finding it in P7.

### A table's extent is decided by its readers, not by its label

Two cases in one phase, and both would have silently truncated:

- **`static_tiles` runs PAST its own block.** `statics_medals_row1` indexes tile $4E = 78, and
  75 tiles end at $81A3. Tiles 75–78 lie in the RAM variable block that follows — over
  `saved_pos`, `bitmap_pointer`, `iso_pos`, `hero_map_position`, `map_position` — and they are
  not noise: each is a structured 8×8 bitmap with a sensible attribute. The medals are drawn
  once by `main` before any of those variables is live and never redrawn, so artwork and
  variables share the bytes quite happily. The count therefore comes from the highest index the
  18 definitions actually reference.
- **`define_key_prompts` runs one byte past its label.** $F2E1 is the "." that finishes "FIRE."
  and is *also* labelled `byte_F2E1`, because `choose_keys` takes its address before walking
  `keyboard_port_hi_bytes` at $F2E2 — the disassembly says "nothing uses this byte for storage".
  Slice on the label and the last prompt decodes as "FIRE" with a truncated glyph.

`extent_of_block` covers the first shape. The second needs an explicit end label. Either way:
when a slice looks one record short, ask what READS it before assuming the count is right.

### Do not tidy 8-bit arithmetic into 16-bit

`set_menu_item_attributes` ($F408) advances by `LD A,L / ADD A,$40 / LD L,A` and fills by
`INC L` — L alone, never carrying into H. That looks like something to clean up, and it is
load-bearing: `main` passes index $44 where the disassembly says "it ought to be zero", and 68
rows of $40 is 4352, which is **0 mod 256**, so L comes back where it started and item 0 is
highlighted exactly as intended. Carry the addition properly and the boot highlight lands at
$6A0D, outside the attribute file. **The bug is harmless BECAUSE the arithmetic is 8-bit.**

### A plausible misreading of a counter is worse than an obvious one

`frequency_for_semitone` ($F52C) loads the table word into B (low) and C (high), increments
both, and increments C again if B wrapped. B is what `DJNZ` counts down and C is only touched
when B reaches zero, so the iterations before a speaker toggle are `B + 256 * (C - 1)`.

`C * 256 + B` reads perfectly naturally, is out by 256, and produces frequencies that are
neither musical nor obviously wrong — the kind of mistake that survives a listen. The test that
pins it asserts that adjacent semitones differ by 2^(1/12), which nothing but the right formula
satisfies. **When a value has a structure the data must have — a scale, a ratio, a monotonic
ramp — assert the structure, not a sample.**

### Driving the UI in a browser finds what no unit test can

Two P7 faults, both invisible to 847 passing tests:

- the harness's `P` and `.` shortcuts swallowed those keys before `choose_keys` saw them, so
  binding P produced **one silently missing key definition** and nothing else. Front-end input
  now runs before any debug key, and the debug keys only exist under `?debug=1`.
- the menu ignored a quick tap. `menu_keyscan` polls the hardware and `menu_screen` polls it
  thousands of times a second; this demo polls on a 25 Hz tick, where a tap lands between two
  polls and vanishes. Latching the keydown until the next poll restores the original's
  behaviour rather than changing it.

Neither is a rule misread. Both are what happens when a routine that assumes it is polling
faster than a human can move is put on a frame clock, and only a hand on a keyboard shows it.

### Item state has one owner, and it is not `itemStructs()`

`itemStructs()` in `src/game/items.ts` decodes the **shipped** table. `createItemState()` in
`src/game/inventory.ts` is the mutable owner, and `readItemStruct` / `allItemStructs` are views
onto it. Calling `itemStructs()` during play rebuilds the world from the original bytes and
resurrects anything the hero picked up — the same hazard as the stove, in its fourth costume.
`src/main.ts` called it once per frame until P5.

### `searchlight_state` is a COUNTER, not a tri-state

`$81BD` is documented in the disassembly's own table as:

    255     searching
    31      caught the hero
    0..30   tracking the hero

Modelling only the two named values made the searchlight a one-way trap: once a light had the
hero the only way out was to go indoors ($ADCC). The missing half is `searchlight_mask_test`
($B83B), called from `plot_sprites` ($B87B) whenever the state is not SEARCHING. For the HERO
only (`$B83E AND A` — the slot test again) it samples eight rows of the mask buffer from
`mask_buffer + $31`, "approximately the middle of the character", four bytes apart:

- any non-zero byte → `still_in_searchlight` ($B860) resets the state to 31
- all zero → the hero has broken line of sight, so the state is **decremented** ($B854)
- when it wraps 0 → 255 the light gives up and the window attributes are restored ($B859)

Escaping takes 32 consecutive frames out of sight and the counter resets the moment he is seen
again. That is the whole tension of the mechanic.

**The polarity is the trap, and the routine's own header comment points the wrong way.** It
says the test checks "if the hero is hiding behind the scenery", which reads as though a
non-zero mask byte — scenery present — should mean hidden. It is the opposite. The mask buffer
is a PERMISSION mask: `render_mask_buffer` fills it with `$FF` and ANDs scenery in, so 1 means
"the sprite may draw here" and 0 means "occluded". Non-zero therefore means **exposed**. Settle
this kind of question against `src/render/maskbuffer.ts`'s fill-and-AND, not against prose.

Two things that were wrong alongside it:

- the shipped initial value is `$04` (mid-countdown), not `$FF`. It now comes out of the
  extractor as `timing.searchlightState.initial` rather than being typed.
- the demo's Night button held its own `night` boolean while the searchlights read
  `schedule.night`, so toggling it darkened the window and started nothing. `day_or_night`
  ($A146) is one byte; `schedule` owns it. The same hazard as the stove, in its fifth costume.

Reachability was measured, not assumed: sweeping 16,384 outdoor positions through the real
`renderMaskBuffer`, 192 give all eight sampled bytes zero and 246 give a partial mask. The
hiding places exist, so the countdown is reachable in play — which per the note below is a
separate question from whether the routine is correct.

**Dawn does not reset the state, and that is correct — do not "fix" it.**
`event_another_day_dawns` ($A1D3) does exactly four things: queues the message, docks 25
morale, clears `day_or_night` ($A1DD), and repaints the window attributes ($A1E1/$A1E4). It
never touches `$81BD`. So a hero caught at 3am is still `CAUGHT` at noon, frozen, because
`nighttime` stops being called at all. It becomes visible again at the next nightfall, where
the counter resumes wherever it stopped. Watching a state freeze across dawn in the demo looks
exactly like a missed reset; it is the shipped behaviour, and it is the same reason `$81BD`
ships as `$04` rather than `$FF`.

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

**How to instrument the running demo.** Unit tests cannot answer "does this ever happen in the
real map", which is the question that P5's items and P6's searchlight escape both turned on.
The setup that works:

```sh
npx vite --port 5199        # serves at http://localhost:5199/thegreatescape/
```

Two techniques, both from the browser console:

- **A temporary probe.** Add `(window as unknown as Record<string, unknown>).__probe = {...}`
  at the end of `tick()`, exposing the live objects. Now the console can read state the demo
  never prints, and *write* it — parking the hero at a chosen position, forcing
  `schedule.night`, setting `searchlights.state` — to reach a situation that would take
  thousands of frames to hit by playing. Copy `main.ts` aside first, delete the probe after,
  and `diff` against the copy to prove it is gone. It must never reach a commit.
- **Import the real modules and sweep.** `await import('/thegreatescape/src/render/maskbuffer.ts')`
  gives the actual code, against the actual `data/`. Note the **base path**: `/src/...` 404s,
  because `vite.config.ts` sets `base = '/thegreatescape/'` for Pages.

That second one is how the searchlight escape was shown to be reachable: 16,384 outdoor
positions pushed through `renderMaskBuffer` with the real `isoPlacement`/`tinyposStash`, of
which 192 fully occlude the sampled rows. **Build the subject with the same functions
`plotSpriteAt` uses.** A hand-rolled iso projection reported zero occluded positions out of
4,096 — a confident, wrong answer that looked exactly like "the feature is unreachable".

**The tick now lives in `tests/harness/loop.ts`, and both scenarios drive it.** `runIdle` in
`tests/demoloop.test.ts` and `playThrough` in `tests/walkthrough.test.ts` are instrumentation
only. The harness is four files:

| file | what it is |
|---|---|
| `harness/loop.ts` | one iteration of `main_loop` ($9D7B) in `src/main.ts`'s order, plus the state it needs |
| `harness/navigate.ts` | a pair of hands: walk toward a target, press the five keys |
| `harness/path.ts` | route-finding over `outdoorBoundsCheck`, the game's OWN wall test |
| `harness/hash.ts` | the §8 state hash, for the determinism replay |

Only `loop.ts` may know a rule. The other three are scaffolding, and if a fact about how the game
behaves ends up in them it is in the wrong file. `path.ts` borrows the game's obstacle test rather
than modelling the map a second time, for the same reason the searchlight sweep had to be built
with the real `isoPlacement`: a hand-rolled second model gives a confident wrong answer that looks
exactly like a working one.

**`tests/demoloop.test.ts` is the integration net, and it must MIRROR `src/main.ts`'s tick.**
It runs thousands of frames of the whole main loop in order. When the two drifted apart -- the
test's loop had no `heroSits`, no automatic door path and no `doorHandling` flag -- the hero
took a different route through breakfast, the simulation diverged from the demo, and the test
happily passed on behaviour the demo never exhibited. If you add a step to the demo's tick, add
it here in the same place. Every "fit" bug — the teleport, the double step, the gate, the mess hall — was
invisible to per-routine tests and obvious there. Extend it when adding systems.

**As of the mirror repair after P6 part 2, `runWorkingTimers`, `nighttime` and
`searchlightMaskTest` are wired into `runIdle`'s tick, in the same order `src/main.ts` calls
them.** The searchlight one was the interesting case, because it is the only step that reads a
*rendering* product (the mask buffer) back into game state, and the demoloop test does not run
the pixel renderer at all. It gets its mask buffer by calling `renderMaskBuffer` directly for the
hero — the same clip test the test already ran for the `offWindow` assertion tells it whether the
hero would have been plotted, which is all `plot_sprites` needs to decide whether to sample the
buffer at all.

`runWorkingTimers` is a true no-op in this scenario — the idle hero never fires an item action, so
`vischar.flags` never carries `PICKING_LOCK`/`CUTTING_WIRE` — but it is called anyway, for order
fidelity, with its own `createJeopardy()`/`createLockedDoors()` state.

**Reachability was checked, not assumed** (`tests/demoloop.test.ts`'s `'actually reaches night'`
test): the run length had to go from 6000 to 10000 ticks, past `DAY_LENGTH_TICKS` (8960), or
`nighttime` would silently never run — the exact shape of P5's item-logic bug. Even at 10000
ticks the mask test itself (`maskTestRuns`) never fires: the day schedule has the hero in bed
before night falls, so he is never outdoors and exposed to a light in this idle scenario. That is
not a bug — the escape mechanic is for a player caught outdoors after curfew, which idle autopilot
never attempts — and `searchlightMaskTest`'s own polarity, countdown and reset logic already have
direct coverage in `tests/searchlight.test.ts`. What the demoloop integration adds is proof that
wiring the three calls into the real tick, against the real day schedule, doesn't crash, doesn't
put `searchlight_state` outside its documented 0..255 range, and doesn't disturb the existing
route/room/message assertions across a full day-night cycle.

**The two systems that note used to list as missing are now in.** `inPermittedArea`,
`followSuspiciousCharacter` and `collision` run in the mirror in `src/main.ts`'s positions,
against real `permitted` / `pursuitState` / `solitaryState`, with the arrest wired to the same
`solitary` chain `arrestHero` drives. `processPlayerInputFire` runs too, against the real
`itemActions(actionContext())` rather than a stub — a stub would have made the twelve
`action_*` handlers look covered while covering nothing.

Three things that came out of doing it, each worth keeping:

- **The pursuit chain is reachable and busy.** 941 slot-frames of an ordinary idle day carry a
  pursuit mode, so the guards react to each other while the hero does nothing. Measured, not
  assumed.
- **The valuable assertions were the zeroes.** An idle hero walking the day's routes must never
  raise the red flag, never be arrested, never take a bribe and never trip `escaped`. Each is a
  net nothing else in the suite casts.
- **Fire is never pressed, and the test says so out loud.** `expect(run.itemCommands).toBe(0)`
  records that the item path is present for ORDER only. Covering the handlers needs a
  scripted-input run — which is what the walkthrough harness is for.

Also fixed while doing it: the mirror ran `dispatchTimedEvent` **before** `waveMoraleFlag`,
which is neither `$9DC2`/`$9DC5`'s order nor `src/main.ts`'s, and its `checkMorale` was missing
the `automatic.counter = 0` callback ($9DE1) that main.ts passes.

**Still open, and bigger: `src/main.ts`'s own tick is not in `$9D7B`'s order.** The loop runs
`check_morale` FIRST ($9D7B), `in_permitted_area` at $9D87 — before `move_a_character`,
`follow_suspicious_character`, purge/spawn and `animate` — and `mark_nearby_items` at $9D99,
between `spawn_characters` and `animate`. `src/main.ts` has all three near the END of its tick.
`in_permitted_area` is the one that can actually differ: it can put the hero back on his route,
and in the original every NPC behaviour that frame sees the result. The mirror deliberately
matches `src/main.ts` rather than `$9D7B`, because the mirror's job is to mirror. Reordering the
real tick is its own session, and needs measuring before and after — not a drive-by fix.

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
