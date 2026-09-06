# PLAN.md — The Great Escape, browser recreation

Produced during the initial survey, before any code was written; this document plus
`OPEN_QUESTIONS.md` were presented for review before P0 began.

Every factual claim below cites a `$address`, `@label`, `file:line` or `.ref` entry, per §0.

---

## 0. What the source survey established

Read in full: `TheGreatEscape.skool` header and constants (lines 1–760), `TheGreatEscapeGame.ref`,
`TheGreatEscapeFacts.ref`, `TheGreatEscapeBugs.ref`, `TheGreatEscapeGraphics.ref`. Surveyed:
the complete label/block structure of the `.skool`, and the generated reference build under
`build/TheGreatEscape/`.

Four structural facts drive every design decision that follows.

**(1) The `.skool` is label-anchored, not block-anchored.** 1,174 `@label=` directives against
only 439 blocks — **743 labels (63%) attach mid-block**, to a continuation line rather than a
block header. Four addresses carry two labels each. A block-anchored parser would miss most of
the data tables.

**(2) Block type does not predict content type.** `b$7095` (`interior_object_defs`) holds
`DEFW`s; `w$AD29` (`searchlight_movements`) holds `DEFB`s; all five `t` blocks hold `DEFB`s, not
`DEFM`. Worse, **131 data lines live inside `c` (code) blocks**, including required extraction
targets — `vischar_initial` in `c$F163`, `character_reset_data` in `c$B79B`,
`character_to_event_handler_index_map` and `character_event_handlers` in `c$C7C6`,
`red_cross_parcel_reset_data`/`_contents_list` in `c$A228`, `searchlight_shape` in `c$AEB8`.
The converse never happens: zero code lines appear in data blocks. **So "is this line data?"
is decided by the mnemonic, never by the block letter.**

**(3) The address space is perfectly contiguous.** Across all 13,672 address lines, addresses
are strictly monotonic `$4000`→`$FFFC` with **zero holes** — every line's `addr + size` exactly
abuts the next. There is one `@org` (`$4000`, line 761), no `DEFS`, no `s` blocks. A single
forward pass reconstructs the entire 64K image, and the contiguity property is itself a strong
parser self-check.

**(4) The disassembly encodes the *original, unfixed* bytes.** See `OPEN_QUESTIONS.md` §1 —
the opposite of what the plan had assumed, and the most consequential finding of the survey.

---

## 1. Repo layout

```
.
├── PLAN.md                  # this file
├── OPEN_QUESTIONS.md        # ambiguities + assumptions, per §0
├── FIDELITY.md              # quirk-by-quirk reproduce/fix decisions, per §9
├── IDEAS.md                 # deviation ideas deferred to stage two, per §9
├── The-Great-Escape/        # the disassembly (read-only, never modified)
├── tools/extract/           # Layer 1 — Python extraction pipeline
│   ├── skoolparse.py        #   lexer/parser → address→byte image + label map
│   ├── schema.py            #   declarative table descriptors
│   ├── tables.py            #   the descriptor set (the only place table shapes live)
│   ├── graphics.py          #   tile/supertile/sprite/mask decode → PNG sheets
│   ├── rle.py               #   object + mask RLE expanders (derived from Z80)
│   ├── emit.py              #   JSON + PNG writers, deterministic ordering
│   └── __main__.py          #   CLI: build | check
├── data/                    # committed extractor output (no Python at web-build time)
│   ├── *.json
│   └── sheets/*.png
├── src/                     # Layer 2 — TypeScript engine
│   ├── spectrum/            #   display model, attributes, canvas blit, beeper
│   ├── data/                #   typed loaders + interfaces over data/*.json
│   ├── render/              #   tile plotting, supertile shunting, sprites, masks, zoombox
│   ├── game/                #   state, loop, movement, collision, doors, items, characters
│   ├── ui/                  #   menu, key redefinition, messages, morale flag, score, bell
│   └── debug/               #   overlays and harnesses
├── tests/
│   ├── golden/              #   pixel comparisons against build/TheGreatEscape/images/
│   ├── unit/                #   arithmetic primitives
│   └── determinism/         #   seeded replay → state hash
├── tools/assetviewer/       # P0 deliverable: static HTML showing every decoded asset
└── index.html, vite.config.ts, package.json
```

Toolchain is exactly `vite` + `vitest` + `typescript` (strict), per §2. No engine, no physics
library, no ECS.

---

## 2. Extractor strategy (Layer 1)

### 2.1 Parsing

Rule from §3: **parse, never transcribe.** No game data byte may be typed by hand into Python
or TypeScript. The parser is therefore the foundation of the whole project, and it is designed
around findings (1)–(3) above.

**Pass A — lex.** Exactly five line shapes occur, and nothing else:

| Shape | Discriminator | Count |
|---|---|---|
| Directive | `^@` at column 0 | 1,310 |
| Block/instruction/data line | `^[bcgtuw* ]\$[0-9A-F]{4} ` | 13,672 |
| Block or mid-block comment | `^;` at column 0 | 5,541 |
| Comment continuation | `^\s+;` with no `$XXXX` | 1,011 |
| Blank | `^$` | 443 |

Note that address lines and comment continuations *both* begin with a space — they are
disambiguated on `\$[0-9A-F]{4}` at offset 1, never on indentation, which ranges from 5 to ~88
spaces.

Column-0 character semantics: `b c g t u w` open a block (`s` never occurs); `*` marks a
continuation line that is a branch target; a space is an ordinary continuation. There is always
exactly one space between the address field and the mnemonic — verified zero exceptions.

**Pass B — build the image.** For every line whose mnemonic is `DEFB` or `DEFW` (the only two
that occur), split operands and write bytes into a `bytearray(65536)`. Operand tokens are split
on `,` first, then classified: `$XX`/`$XXXX` → hex; `"c"` → glyph byte. That last case matters
— five lines carry quoted operands (`"$"` at `$F2BB`/`$F2C3`/`$F2CC`/`$F2D2`, `"!"` at `$F2AD`)
and a naive `\$([0-9A-F]+)` scan would silently corrupt them. Operand counts per line range
from 1 to 54 with no per-block consistency, so rows are accumulated by address, never assumed
to be fixed-width.

Assert contiguity as we go (finding 3). Any gap or overlap is a parser bug and fails the build.

**Pass C — resolve labels.** `@label=` binds to the next non-directive line; directives stack
(e.g. `@label=` + `@keep` + address line at `$783A`). Build `label → address` (1,174 entries,
all names unique) and `address → [labels]` (a *list*, because four addresses carry two labels:
`tiles`/`mask_tiles` → `$8218`, `sprites`/`sprite_stove` → `$CE22`, `masks`/`exterior_mask_0` →
`$E55F`, `static_graphic_defs`/`statics_flagpole` → `$F076`).

Other directives are handled thus: `@keep`, `@nowarn`, `@assemble` — ignored (assembler hints).
`@isub=` — ignored; all six occurrences are cosmetic label substitutions for self-modifying-code
addresses (`$6A3C`, `$6AC6`, `$6B03`, `$6B2C`, `$7AF0`, `$7B9D`) that describe identical bytes.
`@bfix`/`@rfix`/`@ofix` — see `OPEN_QUESTIONS.md` §1; they carry no substitutions.

**Pass D — cross-assert against the snapshot.** Load
`The-Great-Escape/build/TheGreatEscape.pristine.z80` and assert the reconstructed image matches
byte-for-byte over `$4000..$FFFF`. §3's parse-only rule is honoured — every byte still comes
out of the `.skool` — and this turns a stylistic constraint into a free correctness gate that
catches any lexer bug on the first run.

### 2.2 Slicing

Each label's extent runs to the **next label or block end**, whichever comes first. Tables are
then described declaratively in `tables.py`, so the shape of the data lives in exactly one
place and is reviewable against the disassembly. Four descriptor kinds cover everything:

| Kind | Use | Example |
|---|---|---|
| `FixedStride(n, fields)` | array of fixed records | `sprites` `$CE22`, 6 bytes: `width_bytes+1, height, data_ptr, mask_ptr` |
| `VarRecord(reader)` | self-describing records | `roomdef_*` (below) |
| `PointerTable(n, target, base)` | pointer arrays, aliasing preserved | `rooms_and_tunnels` `$6BAD`, `interior_object_defs` `$7095` |
| `RawSlice(lo, hi)` | address ranges with no label | the PRNG bytes `$9000..$90FF` |

`roomdef_*` is the archetypal `VarRecord`, verified against `roomdef_1_hut1_right` (`b$6C15`):

```
byte      dimensions_index      → index into roomdef_dimensions ($6B85, 10 × 4 bytes)
byte      n_bounds ; n × 4      → bounds_t {x0, x1, y0, y1}
byte      n_masks  ; n × 1      → mask indices
byte      n_objects; n × 3      → {interior_object, x, y}
```

Two indexing traps, both handled by resolving through pointer tables rather than by label name:

- `rooms_and_tunnels` (`w$6BAD`) is **52 entries and 1-based** — "the first entry is room 1, not
  room 0" — with heavy aliasing: only 33 distinct `roomdef_*` blocks back 52 rooms (rooms 33,
  37–39, 41–43, 45–49, 51–52 reuse earlier definitions). The JSON preserves aliasing explicitly
  (`{"room": 41, "roomdef": "roomdef_30", "aliased": true}`) so the engine and the fidelity
  tests can both see it.
- `roomdef_*` and `interior_object_tile_refs_*` labels appear in **memory order, not index
  order** (`roomdef_16_corridor` precedes `roomdef_7_corridor`; `..._refs_20` precedes
  `..._refs_2`). Never sort or index by label suffix.

### 2.3 Extraction targets

The §3 list, corrected per `OPEN_QUESTIONS.md`. Grouped as the brief groups them.

- **Map/tiles** — `map_tiles` `$BCEE` (54×34 supertile indices), `super_tiles` `$5B00`
  (218 × 16 = 4×4 tile refs), `exterior_tiles` `$8590` (571 × 8), `interior_tiles` `$9768`
  (194 × 8), `tiles`/`mask_tiles` `$8218`, `static_tiles` `$7F00` (75),
  `static_graphic_defs`/`statics_flagpole` `$F076` + the 18 `statics_*`.
- **Rooms** — 53 `roomdef_*`, `roomdef_dimensions` `$6B85`, `rooms_and_tunnels` `$6BAD`,
  `interior_object_defs` `$7095` (54 × 2 pointers), 51 `interior_object_tile_refs_*`,
  `beds` `w$6B79`, `walls` `$B53E`.
- **Doors & geography** — `doors` `$78D6` with `doors_home_to_outside` `$7906`,
  `doors_home_to_inside` `$7962`, `doors_home_to_tunnel` `$7A3E`; `locked_doors` `$F05D`,
  `solitary_pos` `$7AC6`, `locations` `w$783A`.
- **Characters** — `character_structs` `$7612`, 4 × `character_meta_data_*` from `$CD9A`,
  `character_reset_data` `$B819`, `character_to_event_handler_index_map` `$C7F9`,
  `character_event_handlers` `$C829`, `vischar_initial` `$F1C9`, `prisoners_and_guards` `$A27F`.
- **Routes** — `routes` `$7738` and 40 `route_*`.
- **Sprites & animation** — `sprites` `$CE22`, 6 × `sprite_*`, 56 `bitmap_*`, 35 `mask_*`,
  `animations` `w$CDF2`, `animindices` `$CDAA`, 24 `anim_*`, `masks`/`exterior_mask_0` `$E55F`,
  `exterior_mask_0..14`, `interior_mask_15..29`, `interior_mask_data_source` `$EA7C`,
  `exterior_mask_data` `$EC01`, `mask_pointers` `w$EBC5` (30 = 15 exterior + 15 interior).
- **Items** — `item_structs` `$76C8`, `item_definitions` `$DD7D`, `item_attributes` `$DD69`,
  `default_item_locations` `$CD6A`, `red_cross_parcel_contents_list` `$A25F`,
  `red_cross_parcel_reset_data` `$A259`.
- **Text & UI** — `messages_table` `w$7DCD` + 17 `messages_*`, `escape_strings` `t$A5CE`,
  `bitmap_font` `$A69E`, `keycode_to_glyph` `$F303`, `special_key_names` `t$F2EB`,
  `define_key_prompts` `t$F2AD`, `keydefs` `g$F06B`, `key_choice_screenlocstrings` `t$F446`.
- **Timing & events** — `timed_events` `$A173`, `searchlight_movements` `w$AD29`,
  `searchlight_path_0/1/2`, `searchlight_shape` `$AF3E`, `zoombox_tiles` `$AF5E`,
  `game_window_start_addresses` `w$EDD3` (128 entries).
- **Audio** — `music_channel0_data` `$F546`, `music_channel1_data` `$F7C7`,
  `semitone_to_frequency` `$FA48`.
- **Randomness** — `RawSlice($9000, $90FF)`.

Text tables decode through the game's own glyph set — note that the charset **skips the letter
"O"**, digit zero doubling for it. Screen-located strings carry `{screen_addr LE16, len, bytes}`.

### 2.4 Graphics decoding

Two **different** run-length schemes exist; both must be derived from the Z80 routines (§0
traceability), with `TheGreatEscape.py` used only as a differential check:

- **Interior objects** — `expand_object`, `c$6AB5`. Header `width, height`; then literals, with
  `$FF` introducing an escape: repeat-run, and an unusual **ascending run** (emit `d, d+1,
  d+2 …`) that is easy to miss.
- **Masks** — header is `width` **only**; height is not stored. It is nonetheless *exactly
  derivable*, so no inference is needed (`OPEN_QUESTIONS.md` §10): sort the 30 `mask_pointers`
  (`w$EBC5` — they are **not** stored in ascending order), take each mask's extent to the next
  higher pointer (highest → `$EA7C`), expand, and `height = expanded / width`. Verified: all 30
  divide exactly. `mask_t` records are `{index, bounds_t, tinypos_t}` — 8 bytes in
  `exterior_mask_data` (`$EC01`, 58 entries), 7 in `interior_mask_data_source` (`$EA7C`, the
  constant trailing byte omitted).

The exterior tileset uses a **three-group sliding window** selected by supertile index, derived
from `plot_tile` (`c$A9AD`) rather than inherited from `TheGreatEscape.py`:

| Supertile index | Base | Tile | Instruction |
|---|---|---|---|
| 0–44 | `$8590` | 0 | `CP $2D` / `JR C` |
| 45–138, 204–217 | `$8A18` | 145 | `CP $8B` / `JR C`, `CP $CC` / `JR NC` |
| 139–203 | `$90F8` | **365** | fallthrough |

Note 365, not the 366 stated in `TheGreatEscapeGraphics.ref` line 205 — `$90F8 − $8590 = 2920`,
`2920 / 8 = 365`, and the routine's own comment agrees. `map-0-0.png` validates the result.

### 2.5 Determinism and the CI gate

Output ordering is fixed (sorted keys, stable float-free encoding, PNG written with fixed
filters). `python -m tools.extract check` re-runs extraction into a temp dir and diffs against
committed `data/`; non-empty diff exits non-zero. This satisfies §3's "re-running it produces
no diff" requirement and is the first CI job.

---

## 3. Data schema

`data/` is the hard boundary. `src/` contains **zero literal game data**; a Vitest rule fails
the build if a numeric array literal longer than a small threshold appears under `src/`.

Principles:

- **Addresses do not cross the boundary.** All pointer tables are resolved to indices at
  extract time. `sprites[].data_ptr` becomes `bitmapIndex`; `rooms_and_tunnels` becomes
  `roomdefIndex`. The engine never chases a `$` address.
- **Provenance is retained.** Every emitted table carries `{"_label": "...", "_addr":
  "$6C15", "_bytes": 48}` so any value in the running game can be traced back to a line of the
  disassembly, and so the asset viewer can show it.
- **Bytes stay bytes.** Bitmaps, masks and tile data emit as base64 `Uint8Array` payloads plus
  a PNG sheet for human inspection — never as JSON number arrays, which would triple the size.
- **Quirks are data, not code.** The unused sets (`rooms 6, 26, 27`; `interior objects 21, 28,
  39`; `supertiles $4F, $9A`) are emitted as explicit lists so §9's "leave unused things
  unused" is testable rather than incidental.

---

## 4. Display model (Layer 2)

Per §4, reproduce the Spectrum display rather than approximating it: a 256×192 1-bit pixel
bitmap plus a 32×24 attribute grid (ink, paper, bright, flash). Colour comes only from
attributes.

**Geometry, verified rather than assumed** (§4 explicitly asks for this):

| Buffer | Address | Size | Note |
|---|---|---|---|
| `tile_buf` | `$F0F8` | 24×17 = 408 B | tile refs; `wipe_visible_tiles` `$6A27` clears exactly this |
| `window_buf` | `$F290` | 24×17×8 = 3,264 B | 192×136 px |
| visible window | — | 192×**128** px | `game_window_start_addresses` `w$EDD3` holds exactly **128** pointers |

First window pointer is `$4047` → character column 7, pixel row 16. So the buffer is 17 rows
but only 16 are ever blitted; the extra row is sub-tile scroll slack. The 24×17 figure quoted
elsewhere describes the buffer, not the window — both are real, and conflating them is the
subject of `OPEN_QUESTIONS.md` §2.

**Pipeline**, following the original exactly, over real `Uint8Array`s:

1. Visible tiles array — `wipe_visible_tiles` `$6A27`, `plot_interior_tiles`, `setup_room`
   `$6A35`.
2. Expand to screen buffer — `$6B42` (interiors); `plot_all_tiles` /
   `plot_horizontal_tiles_common` / `plot_vertical_tiles_common` and the `shunt_map_*` family
   (scrolling exterior).
3. Composite sprites — `plot_sprites` → `plot_vischar` / `plot_item`, via
   `plot_masked_sprite_16px` / `_24px` against the mask buffer at `$8100` (`$A0` bytes) built by
   `render_mask_buffer` `$B916`, clipped by `vischar_visible` / `item_visible`, restored by
   `restore_tiles`.
4. Blit — `plot_game_window` (`$E0DC` area), aligned fast path vs. nibble-rolling slow path.
   That asymmetry *is* `Fact:alternatingSpeed` and must be modelled, not smoothed away.

Only step 4's output converts to `ImageData`. No per-pixel canvas drawing anywhere in 1–3 —
the masking, clipping and sub-character scroll only come out right at byte level.

Also required and scheduled: `zoombox` `$ABA0`, searchlight (`searchlight_movement`,
`searchlight_mask_test`), `wave_morale_flag`, bell ringer, score digits, and
`choose_game_window_attributes` including the tunnel case.

**Integer discipline** (§5): all game state in `Uint8Array`/`Int8Array`/`Uint16Array` with
explicit `& 0xFF` / `& 0xFFFF`. No floats in game state. Carry/borrow behaviour is reproduced
where the original depends on it — the `A += delta; JR NC; H++` pointer-advance pattern,
`divide_by_8_with_rounding`, `multiply`, `pos_to_tinypos`. Fixed-step logic tick decoupled from
`requestAnimationFrame`, driven by the original's own timing sources (`game_counter` `$A12F`,
`interior_delay_loop` `$A095`) rather than wall-clock.

**Randomness** (§6): `random_nibble` `$CB85` reads the extracted `$9000..$90FF` slice via
`prng_pointer` `$C41A`. Two details from the code that a paraphrase would lose — `INC L`
precedes the read, so the first value comes from `$9001`; and `H` is never touched, so it wraps
within the page. `game_counter` is deliberately **not** reset on new game
(`Fact:randomness`): seed it from time-on-menu, and expose `?seed=` for deterministic runs.

---

## 5. Verification design

Built in P0/P1, not bolted on (§8). The critical result of the survey is that the shipped PNGs
are **not uniformly trustworthy** — see `OPEN_QUESTIONS.md` §8. The gate is therefore split by
asset class.

### Tier 1 — pixel-exact oracles (these gate the build)

| Target | Oracle | Count |
|---|---|---|
| Exterior tile plane | `images/scr/map-0-0.png` (1728×1088, scale 1, mono) | 1 — strongest |
| Individual 8×8 tiles | `images/udgs/{exterior-tiles0..3,interior-tiles}-NNN.png` (scale 4) | 876 |
| Supertiles | `images/scr/supertile-<hex>-0-1.png` (64×64, scale 2) | 218 |
| Interior objects (RLE) | `images/scr/object-N.png` (scale 2) | 51 |

Scenery masks are **not** in Tier 1. `mask-XXXX.png` encodes the Python's observed-usage
bounding box, not the stored mask dimensions — `$E55F` is 42×26 but renders 42×25, and unused
mask 19 (`$E99F`) is 9×5 but renders 9×1 (`OPEN_QUESTIONS.md` §10). They are compared pixel-wise
*within the PNG's own bounding box* only, and never gate dimensions.

`map-0-0.png` is the anchor: it is the entire 54×34 grid expanded to a 216×136-tile plane at
1:1, uncropped and unattributed, so a correct tile/supertile/banking implementation reproduces
any sub-rectangle of it byte-for-byte.

### Tier 2 — structural, not pixel

Rooms. `room-N.png` is **not** a frame oracle — `_render_room`
(`The-Great-Escape/TheGreatEscape.py:627`) hardcodes a 24×16 canvas with the author's own
comment *"room_dims is not comprehendible to me right now"*, ignores each room's dimensions and
boundaries, forces attribute 7, and draws no masks, sprites or items. It is tested as: correct
object set at correct `(x, y)` from the roomdef, and — optionally, downscaled 2× with masks off
and rows 0–15 only — as a check on the tile-plane composition step alone. Full-frame room
fidelity is gated in P2 against the real display model instead.

### Excluded

Composited `<who>-<dir>-<n>.png` character frames (bitmap+mask merged with green transparency,
documented as *"inaccurate and misshapen"*) — use the separate `bitmap-*.png` / `mask-*.png`.
The unindexed `<who>-<dir>.png` files are **animated PNGs** (`acTL` chunks) and must never be
fed to a single-frame comparator. `map-1-1.png` carries debug tinting and a bright checkerboard.

### Also required

- **Unit tests on the arithmetic primitives** — `pos_to_tinypos`, `divide_by_8_with_rounding`,
  `multiply`, `multiply_by_4`/`_8`, `random_nibble`, route stepping, `bounds_check`. Small,
  exactly specified, and everything downstream depends on them.
- **Debug overlay** (toggleable) — room, hero pos/tinypos/isopos, full vischar table, per-
  character route and target, morale, flags, game counter, current timed event.
- **Determinism harness** — fixed seed + scripted input → state hash at frame *N*; replays the
  P6 walkthrough in CI.
- **Trace mode** — log routine entry by disassembly address, so behaviour can be diffed against
  a reading of the `.skool`.

---

## 6. P0 and P1 task breakdown

### P0 — Extraction

1. `skoolparse.py`: lexer for the five line shapes; `DEFB`/`DEFW` operand tokeniser handling
   quoted glyphs; directive handling.
2. Address-image builder with contiguity assertion; snapshot cross-assert against
   `build/TheGreatEscape.pristine.z80`.
3. Label resolution incl. the four duplicate-label addresses.
4. `schema.py` + `tables.py`: the four descriptor kinds and the full target list from §2.3.
5. `rle.py`: object and mask expanders derived from `expand_object` `c$6AB5` and the mask
   routine; mask height inference from the `$EC01` / `$EA7C` usage tables.
6. `graphics.py` + `emit.py`: JSON, PNG sheets for tiles/supertiles/sprites/masks/objects.
7. `tools/assetviewer/`: static HTML showing every tile, supertile, sprite frame, mask and room
   object, each labelled with its `@label` and `$address`.
8. Golden tests — Tier 1 above wired into Vitest.
9. `check` mode + CI job.

**Accept:** every table in §2.3 extracted; snapshot cross-assert passes; asset viewer matches
`build/TheGreatEscape/images/`; Tier 1 golden tests green; `check` produces no diff.

### P1 — Static rendering

1. `src/spectrum/`: 256×192 1-bit buffer + 32×24 attributes; Spectrum screen address
   arithmetic; `ImageData` conversion; integer-scaled nearest-neighbour canvas with letterbox.
2. `src/data/`: typed loaders over `data/*.json`, plus the no-literal-data lint/test.
3. `src/render/`: tile plotting; supertile expansion with the three-group banking derived from
   `plot_tile`; `tile_buf` (`$F0F8`, 24×17) and `window_buf` (`$F290`, 24×17×8) at real sizes;
   `plot_game_window` with its 128 row pointers from `game_window_start_addresses`.
4. Interior room rendering via the roomdef object list; exterior map rendering at a fixed
   position.
5. Golden tests extended: exterior window sub-rectangles vs. `map-0-0.png`; rooms per Tier 2.

**Accept:** any exterior window position is byte-identical to the corresponding sub-rectangle of
`map-0-0.png`; every room's tile plane matches its roomdef structurally (and, downscaled with
masks off, matches `room-N.png`); the display model round-trips a known attribute pattern.

Later phases follow §7 unchanged. Deviation ideas go to `IDEAS.md`, not into P1–P6 (§9).

---

## 7. Fidelity policy

`FIDELITY.md` records every decision. Reproduce everything in `TheGreatEscapeFacts.ref`: unused
rooms/objects/supertiles left unused, the never-waking sleepers in Hut 1 (`Fact:deadGuys` — there
are no references to those bed objects in the `$6B79` array, so they can never spawn), the
game-counter seeding, the interior delay loop, the fast/slow blit asymmetry.

For each entry in `TheGreatEscapeBugs.ref` and `TheGreatEscapeGraphics.ref`: default is to
reproduce *visible* quirks (guard sprites drawn one row too low from the off-by-two pointers at
`$CEBE`; the dog's two stray pixels from the height-15-should-be-13 error at `$CEA0`) behind a
`?faithful=0` flag. Do not reproduce crashes, hangs, or the ROM write.

The three bfixes and five rfixes are implemented deliberately and each gets a `FIDELITY.md`
entry — see `OPEN_QUESTIONS.md` §1 for why this is a decision rather than a transcription.

---

## 8. Legal

The game is © 1986 Ocean Software / Denton Designs. The disassembly is © David Thomas
(<https://github.com/dpt/The-Great-Escape>) and this project depends on it entirely. The README
will attribute both prominently, state that this is a non-commercial fan reimplementation, note
that extracted graphics data is derived from the original work, and will not ship the original
tape image.
