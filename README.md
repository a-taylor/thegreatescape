# The Great Escape — browser reimplementation

A from-scratch browser recreation of **The Great Escape** (Ocean Software / Denton Designs,
1986) for the ZX Spectrum, derived entirely from David Thomas's SkoolKit disassembly.

This is a **non-commercial fan reimplementation**. It is not an emulator: there is no Z80 CPU
here, and the original tape image is not distributed with it.

---

## Attribution

| | |
|---|---|
| **The Great Escape** | © 1986 Ocean Software Ltd. / Denton Designs. Designed by John Heap and Denton Designs. |
| **The disassembly** | © 2012–2024 [David Thomas](https://github.com/dpt/The-Great-Escape) — `dave@davespace.co.uk` |
| **This reimplementation** | Depends on that disassembly entirely; without it this project could not exist. |

**The graphics data in `data/` is extracted from the original game and is derived from the
copyrighted work.** It is included so the web build has no Python dependency at runtime, per
the project brief. It is not original to this repository.

The original `.z80` / `.tap` image is **not** shipped here, and `The-Great-Escape/` is
deliberately excluded from version control (see `.gitignore`).

---

## Getting the source material

The disassembly is a separate repository and is not vendored. Clone it into place:

```sh
git clone https://github.com/dpt/The-Great-Escape.git
```

The extractor reads two things from it:

- `The-Great-Escape/TheGreatEscape.skool` — the disassembly itself
- `The-Great-Escape/build/TheGreatEscape.pristine.z80` — used only to *verify* the parse

The `.skool` and the reference build are produced by that project's own `make`; see its README.

---

## Setup

```sh
npm install                      # Vite + Vitest + TypeScript, nothing else
python3 -m venv .venv            # SkoolKit, for the extractor only
.venv/bin/pip install skoolkit
```

## Running

```sh
npm run dev            # dev server
npm run build          # typecheck + static build into dist/
npm test               # engine tests
```

## The extraction pipeline

Game data is **parsed, never transcribed**. No byte of game data is typed by hand into either
Python or TypeScript; it all comes out of the `.skool` by parsing `DEFB`/`DEFW` anchored on
`@label`, and `src/` is checked by a test that fails on any literal data table.

```sh
npm run extract           # .skool -> data/*.json + data/sheets/*.png
npm run extract:check     # assert a fresh extraction matches committed data/ exactly
npm run extract:goldens   # pixel-compare decoded assets against the reference build
npm run assetviewer       # build tools/assetviewer/index.html
```

The extractor cross-checks every parsed byte against the pristine snapshot, so a parser bug
fails immediately rather than producing plausible-looking wrong data.

---

## Verification

The disassembly ships decoded PNGs of its own graphics, which serve as an oracle — but not
uniformly, so the gate is split by asset class (see `OPEN_QUESTIONS.md` §8).

| | |
|---|---|
| Exterior map vs `map-0-0.png` | 1,880,064 pixels, 0 differ |
| 876 individual 8×8 tiles | exact |
| 218 supertiles | exact |
| 51 interior objects (RLE) | exact |
| 30 masks | exact within the reference's bounding box |

`room-N.png` is deliberately **excluded** as a frame oracle: it is a placeholder canvas the
disassembly's author drew on a hardcoded 24×16 grid, ignoring room dimensions, attributes and
masks. Matching it pixel-for-pixel would calibrate the renderer to an approximation rather
than to the game.

---

## Documents

- **`PLAN.md`** — repo layout, extractor strategy, data schema, display-model design, phasing
- **`OPEN_QUESTIONS.md`** — every ambiguity found in the source, with the address read and the
  assumption taken. Notably §1: the disassembly encodes the *original, unfixed* bytes, so the
  documented bug fixes are deliberate deviations rather than something inherited.
- **`BUILD_PROMPT.md`** — the original brief

---

## Status

- **P0 — extraction** ✅ pipeline, `data/`, PNG sheets, asset viewer, golden tests
- **P1 — static rendering** ✅ Spectrum display model, tile plotting, game window, room and
  map rendering, window attribute selection
- **P2 — hero movement** ✅ arithmetic primitives, the three coordinate systems, map window
  and `shunt_map_*`, bounds checking, doors and transitions, input and animation
- **P3 — sprites and masking** ✅ masked sprite compositor, the foreground occlusion mask,
  the `vischar_visible` clip cases, item plotting, the pushable stove and crate, and
  `get_next_drawable` depth ordering. Interior door handling too, which the phase needed
  to be walkable.
  `restore_tiles` is deliberately not implemented: it re-plots tiles under each vischar
  before sprites are redrawn, but this renderer rebuilds the whole window buffer every
  frame, so its output is identical.

See `PLAN.md` §6 for the phase breakdown, `FIDELITY.md` for what happens at each bug site,
and `OPEN_QUESTIONS.md` for ambiguities and their resolutions.
