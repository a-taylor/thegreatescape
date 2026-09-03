"""Golden-image tests: our decoded assets vs the disassembly's reference build.

Run:  python -m tools.extract.goldens

BUILD_PROMPT.md §8 calls the shipped PNGs "a genuine oracle". The survey found
that is true for some asset classes and not others, so the gate is split (see
PLAN.md §5 and OPEN_QUESTIONS.md §8):

  TIER 1 -- pixel-exact, these fail the build
      map, individual tiles, supertiles, interior objects
  TIER 2 -- exact within the reference's own bounding box
      masks: mask-*.png encodes an observed-usage bbox that can be SHORTER
      than the stored mask, so height is ours to derive, not theirs to dictate
  EXCLUDED
      room-N.png       an author's placeholder canvas, not a frame render
      <who>-<dir>*.png composited with an inaccurate shared mask; some are APNG
      map-1-1.png      debug colour tint + bright checkerboard
"""

from __future__ import annotations

from pathlib import Path
from typing import Callable

from . import pngio
from .emit import item_sheets, map_sheet, mask_sheets, object_sheets
from .schema import tile_bank
from .skoolparse import Skool, parse

ROOT = Path(__file__).resolve().parents[2]
SKOOL = ROOT / "The-Great-Escape" / "TheGreatEscape.skool"
REF = ROOT / "The-Great-Escape" / "build" / "TheGreatEscape"
SCR = REF / "images" / "scr"
UDGS = REF / "images" / "udgs"


class Results:
    def __init__(self) -> None:
        self.passed = 0
        self.failed: list[str] = []
        self.skipped = 0

    def check(self, name: str, ok: bool, detail: str = "") -> None:
        if ok:
            self.passed += 1
        else:
            self.failed.append(f"{name}: {detail}")

    def report(self, title: str) -> None:
        status = "PASS" if not self.failed else "FAIL"
        print(f"  {title:<32} {self.passed:>5} passed  "
              f"{len(self.failed):>3} failed   [{status}]")
        for f in self.failed[:8]:
            print(f"      {f}")


def _bits(path: Path, scale: int = 1) -> tuple[int, int, list[int]]:
    im = pngio.read(path)
    if scale > 1:
        im = im.downscale(scale)
    return im.width, im.height, im.to_bits()


def _diff(a: list[int], b: list[int]) -> int:
    return sum(1 for x, y in zip(a, b) if x != y)


def test_map(sk: Skool, r: Results) -> None:
    w, h, mine = map_sheet(sk)
    rw, rh, ref = _bits(SCR / "map-0-0.png")
    r.check("map dimensions", (w, h) == (rw, rh), f"{w}x{h} vs {rw}x{rh}")
    r.check("map pixels", mine == ref, f"{_diff(mine, ref)}/{len(ref)} differ")


def test_tiles(sk: Skool, r: Results) -> None:
    """Each 8x8 tile against its own reference PNG (scale 4).

    The reference splits the exterior set into four windows matching the
    plot_tile banking rule: tiles0 is mask_tiles at $8218, then the three
    exterior groups at $8590 / $8A18 / $90F8.
    """
    image = sk.image
    groups = [
        ("exterior-tiles0", sk.addr_of("mask_tiles"), 111),
        ("exterior-tiles1", 0x8590, 145),
        ("exterior-tiles2", 0x8A18, 220),
        ("exterior-tiles3", 0x90F8, 206),
        ("interior-tiles", sk.addr_of("interior_tiles"), 194),
    ]
    for prefix, base, count in groups:
        for i in range(count):
            p = UDGS / f"{prefix}-{i:03d}.png"
            if not p.exists():
                r.skipped += 1
                continue
            _, _, ref = _bits(p, scale=4)
            mine: list[int] = []
            for row in range(8):
                byte = image[base + i * 8 + row]
                mine.extend(1 if byte & (0x80 >> bit) else 0 for bit in range(8))
            r.check(f"{prefix}-{i:03d}", mine == ref, f"{_diff(mine, ref)} px differ")


def test_supertiles(sk: Skool, r: Results) -> None:
    image = sk.image
    st = sk.addr_of("super_tiles")
    for i in range(218):
        p = SCR / f"supertile-{i:X}-0-1.png"
        if not p.exists():
            r.skipped += 1
            continue
        _, _, ref = _bits(p, scale=2)
        mine = [0] * (32 * 32)
        base = tile_bank(i)
        for ty in range(4):
            for tx in range(4):
                tile = image[st + i * 16 + ty * 4 + tx]
                for row in range(8):
                    byte = image[base + tile * 8 + row]
                    o = (ty * 8 + row) * 32 + tx * 8
                    for bit in range(8):
                        if byte & (0x80 >> bit):
                            mine[o + bit] = 1
        r.check(f"supertile-{i:X}", mine == ref, f"{_diff(mine, ref)} px differ")


def test_objects(sk: Skool, r: Results) -> None:
    for name, (w, h, mine) in object_sheets(sk).items():
        p = SCR / f"{name}.png"
        if not p.exists():
            r.skipped += 1  # objects 21, 28, 39 are unused
            continue
        rw, rh, ref = _bits(p, scale=2)
        if (w, h) != (rw, rh):
            r.check(name, False, f"{w}x{h} vs {rw}x{rh}")
            continue
        r.check(name, mine == ref, f"{_diff(mine, ref)} px differ")


def test_masks(sk: Skool, r: Results) -> None:
    """Tier 2: compare within the reference's bounding box only.

    Our derived height is authoritative (OPEN_QUESTIONS.md §10); the reference
    can be shorter because it infers height from observed usage. $E55F is 42x26
    but renders 42x25, and unused mask 19 ($E99F) is 9x5 but renders 9x1.
    """
    for name, (w, h, mine) in mask_sheets(sk).items():
        p = SCR / f"{name}.png"
        if not p.exists():
            r.skipped += 1
            continue
        ref_im = pngio.read(p).downscale(2)
        cw, ch = min(w, ref_im.width), min(h, ref_im.height)
        ref = ref_im.crop(0, 0, cw, ch).to_bits()
        got = [mine[y * w + x] for y in range(ch) for x in range(cw)]
        r.check(
            name, got == ref,
            f"{_diff(got, ref)} px differ in {cw}x{ch} bbox "
            f"(ours {w}x{h}, ref {ref_im.width}x{ref_im.height})",
        )


def test_items(sk: Skool, r: Results) -> None:
    """item_definitions ($DD7D) bitmaps and masks, at scale 4 in images/udgs.

    This is what gates the reading that item_definitions stores a PLAIN width,
    unlike the sprites table's width-plus-one: get that wrong and every item
    renders at the wrong stride.
    """
    for name, (w, h, mine) in sorted(item_sheets(sk).items()):
        p = UDGS / f"{name}.png"
        if not p.exists():
            r.skipped += 1
            continue
        rw, rh, ref = _bits(p, scale=4)
        if (w, h) != (rw, rh):
            r.check(name, False, f"{w}x{h} vs {rw}x{rh}")
            continue
        r.check(name, mine == ref, f"{_diff(mine, ref)} px differ")


def test_font(sk: Skool, r: Results) -> None:
    """bitmap_font ($A69E) against images/font/font.png, at scale 2.

    The reference renders 35 of the 37 glyphs -- the alphanumerics only, with
    space and full stop left off the end -- so the comparison is bounded by the
    reference's width rather than by the table's extent. Everything it does
    render is exact, including the absent letter "O": glyph 24 is "P", and
    "R0LL CALL" is the game's own spelling.
    """
    font = sk.slice("bitmap_font")
    rw, rh, ref = _bits(REF / "images" / "font" / "font.png", scale=2)
    r.check("font height", rh == 8, f"{rh} rows")
    n = rw // 8
    r.check("font glyph count", n <= len(font) // 8, f"{n} rendered vs {len(font) // 8} in table")
    mine = [(font[g * 8 + row] >> (7 - col)) & 1
            for row in range(8) for g in range(n) for col in range(8)]
    r.check("font pixels", mine == ref, f"{_diff(mine, ref)}/{len(ref)} differ")


def test_panel(sk: Skool, r: Results) -> None:
    """The morale flag bitmaps against images/udgs/flag-*.png, at scale 4.

    Tier 2: the reference renders 24 rows where wave_morale_flag plots 25
    ($A06B LD BC,$0319), because its UDGARRAY is three 8-pixel rows tall. The
    25th row has no oracle, so the comparison is bounded by the reference and
    the extra row is left unchecked rather than quietly dropped.
    """
    for label, name in (("bitmap_flag_up", "flag-up"), ("bitmap_flag_down", "flag-down")):
        addr = sk.addr_of(label)
        rw, rh, ref = _bits(UDGS / f"{name}.png", scale=4)
        if rw != 24:
            r.check(name, False, f"reference is {rw}px wide, expected 24")
            continue
        data = sk.image[addr:addr + 3 * rh]
        mine = [(data[row * 3 + (col >> 3)] >> (7 - (col & 7))) & 1
                for row in range(rh) for col in range(rw)]
        r.check(name, mine == ref, f"{_diff(mine, ref)}/{len(ref)} differ")


def test_static_tiles(sk: Skool, r: Results) -> None:
    """static_tiles ($7F00) against images/udgs/static-tiles.png.

    The oracle that was missing, and the reason a real bug lived here: static
    tiles are NINE bytes each -- eight pixel rows and a trailing attribute byte
    that plot_static_tiles writes to the cell ($F219 multiplies the index by
    nine, $F23E reads the ninth byte). They were extracted at stride eight like
    every other tile set, which put 84 tiles where there are 75 and slid every
    one after the first out of alignment. Nothing noticed because nothing drew
    them until P7.

    The reference lays the tiles out in a strip, so its width gives the count
    and the comparison is bounded by it rather than by the table's extent.
    """
    lo, hi = sk.extent_of("static_tiles")
    stride = 9
    in_table = (hi - lo) // stride
    r.check("static_tiles divides by 9", (hi - lo) % stride == 0,
            f"{hi - lo} bytes")

    path = UDGS / "static-tiles.png"
    if not path.exists():
        r.skipped += 1
        return
    rw, rh, ref = _bits(path, scale=1)
    r.check("static tile height", rh == 8, f"{rh} rows")
    n = rw // 8
    r.check("static tile count", n <= in_table,
            f"{n} rendered vs {in_table} in table")
    mine = [(sk.image[lo + g * stride + row] >> (7 - col)) & 1
            for row in range(8) for g in range(n) for col in range(8)]
    r.check("static tile pixels", mine == ref,
            f"{_diff(mine, ref)}/{len(ref)} differ")


TIERS: list[tuple[str, str, Callable[[Skool, Results], None]]] = [
    ("TIER 1  (pixel-exact; these gate the build)", "exterior map", test_map),
    ("TIER 1  (pixel-exact; these gate the build)", "individual 8x8 tiles", test_tiles),
    ("TIER 1  (pixel-exact; these gate the build)", "supertiles", test_supertiles),
    ("TIER 1  (pixel-exact; these gate the build)", "interior objects (RLE)", test_objects),
    ("TIER 1  (pixel-exact; these gate the build)", "item sprites", test_items),
    ("TIER 1  (pixel-exact; these gate the build)", "bitmap font", test_font),
    ("TIER 1  (pixel-exact; these gate the build)", "static tiles", test_static_tiles),
    ("TIER 2  (exact within reference bbox)", "masks", test_masks),
    ("TIER 2  (exact within reference bbox)", "morale flag", test_panel),
]


def main() -> int:
    print(f"Golden-image tests vs {REF.relative_to(ROOT)}\n")
    sk = parse(SKOOL)

    failed_total = skipped_total = 0
    current_tier = None
    for tier, title, fn in TIERS:
        if tier != current_tier:
            print(tier)
            current_tier = tier
        r = Results()
        fn(sk, r)
        r.report(title)
        failed_total += len(r.failed)
        skipped_total += r.skipped

    print(f"\nskipped {skipped_total} (unused assets with no reference render)")
    if failed_total:
        print(f"FAILED: {failed_total} golden comparison(s)")
        return 1
    print("ALL GOLDEN COMPARISONS PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
