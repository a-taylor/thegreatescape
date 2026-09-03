"""Writers: structured data -> data/*.json and data/sheets/*.png.

Determinism is a requirement, not a nicety: BUILD_PROMPT.md §3 asks for a
CI-able check that re-running the extractor produces no diff. So JSON is
written with sorted keys and a fixed separator, and PNGs use a fixed filter
type and zlib level (see pngio.write_indexed).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from . import pngio
from .rle import expand_mask, expand_object, mask_extents
from .schema import fixed_records, tile_bank
from .skoolparse import Skool

# Spectrum white ink on black paper -- the same pairing SkoolKit uses for
# attribute 7, so our sheets are directly comparable with the reference build.
PALETTE = [(0, 0, 0), (205, 198, 205)]


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(data, indent=2, sort_keys=True, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )


def _blit_tile(px: list[int], sheet_w: int, x: int, y: int,
               image: bytes, addr: int) -> None:
    """Draw one 8x8 tile from 8 bitmap bytes."""
    for row in range(8):
        byte = image[addr + row]
        base = (y + row) * sheet_w + x
        for bit in range(8):
            if byte & (0x80 >> bit):
                px[base + bit] = 1


def tile_sheet(image: bytes, addr: int, count: int, per_row: int = 64,
               stride: int = 8) -> tuple[int, int, list[int]]:
    """`stride` is the bytes PER RECORD, which is not always the 8 rows drawn:
    static_tiles carries a ninth attribute byte after each tile."""
    rows = (count + per_row - 1) // per_row
    w, h = per_row * 8, rows * 8
    px = [0] * (w * h)
    for i in range(count):
        _blit_tile(px, w, (i % per_row) * 8, (i // per_row) * 8, image, addr + i * stride)
    return w, h, px


def supertile_sheet(sk: Skool, per_row: int = 16) -> tuple[int, int, list[int]]:
    """218 supertiles, each 4x4 tiles, using the plot_tile banking rule."""
    image = sk.image
    st = sk.addr_of("super_tiles")
    n = 218
    rows = (n + per_row - 1) // per_row
    w, h = per_row * 32, rows * 32
    px = [0] * (w * h)
    for i in range(n):
        ox, oy = (i % per_row) * 32, (i // per_row) * 32
        base = tile_bank(i)
        for ty in range(4):
            for tx in range(4):
                tile = image[st + i * 16 + ty * 4 + tx]
                _blit_tile(px, w, ox + tx * 8, oy + ty * 8, image, base + tile * 8)
    return w, h, px


def map_sheet(sk: Skool) -> tuple[int, int, list[int]]:
    """The whole 54x34 exterior map at 1:1 -- 1728x1088.

    This is the project's strongest oracle: it diffs byte-for-byte against
    build/TheGreatEscape/images/scr/map-0-0.png.
    """
    image = sk.image
    m, st = sk.addr_of("map_tiles"), sk.addr_of("super_tiles")
    MW, MH = 54, 34
    w, h = MW * 4 * 8, MH * 4 * 8
    px = [0] * (w * h)
    for ty in range(MH * 4):
        for tx in range(MW * 4):
            s = image[m + (ty // 4) * MW + (tx // 4)]
            tile = image[st + s * 16 + (ty & 3) * 4 + (tx & 3)]
            _blit_tile(px, w, tx * 8, ty * 8, image, tile_bank(s) + tile * 8)
    return w, h, px


def object_sheets(sk: Skool) -> dict[str, tuple[int, int, list[int]]]:
    image = sk.image
    base = sk.addr_of("interior_object_defs")
    tiles_addr = sk.addr_of("interior_tiles")
    out = {}
    for n in range(54):
        ptr = image[base + n * 2] | (image[base + n * 2 + 1] << 8)
        ow, oh, tiles = expand_object(image, ptr)
        w, h = ow * 8, oh * 8
        px = [0] * (w * h)
        for ty in range(oh):
            for tx in range(ow):
                t = tiles[ty * ow + tx]
                if t:  # tile 0 is transparent
                    _blit_tile(px, w, tx * 8, ty * 8, image, tiles_addr + t * 8)
        out[f"object-{n}"] = (w, h, px)
    return out


def mask_sheets(sk: Skool) -> dict[str, tuple[int, int, list[int]]]:
    image = sk.image
    mp = sk.addr_of("mask_pointers")
    mt = sk.addr_of("mask_tiles")
    region_end = sk.addr_of("interior_mask_data_source")
    ptrs = [image[mp + i * 2] | (image[mp + i * 2 + 1] << 8) for i in range(30)]
    extents = mask_extents(ptrs, region_end)

    out = {}
    for n, p in enumerate(ptrs):
        lo, hi = extents[p]
        mw, mh, tiles = expand_mask(image, lo, hi)
        w, h = mw * 8, mh * 8
        px = [0] * (w * h)
        for ty in range(mh):
            for tx in range(mw):
                _blit_tile(px, w, tx * 8, ty * 8, image,
                           mt + tiles[ty * mw + tx] * 8)
        out[f"mask-{p:04X}"] = (w, h, px)
    return out


def sprite_sheets(sk: Skool) -> dict[str, tuple[int, int, list[int]]]:
    """One PNG per sprite frame, bitmap and mask separately.

    Deliberately NOT composited. The reference build's merged <who>-<dir>-<n>
    frames use a shared "worst case" mask that TheGreatEscapeGraphics.ref:38
    calls "inaccurate and misshapen", so compositing here would bake in a
    known-wrong overlay. Keeping them apart also lets the mask be checked
    independently.

    Note the stored width is "width in bytes PLUS ONE" (ctl line 10874), and
    some heights are wrong in the data itself -- the dog's frame 3 claims 15
    rows but only 13 exist, which is the documented stray-pixel glitch. We
    render what the table says, so the glitch is visible rather than hidden.
    """
    image = sk.image
    addr = sk.addr_of("sprites")
    end = sk.addr_of("anim_crawlwait_tl")
    out: dict[str, tuple[int, int, list[int]]] = {}

    for n, (a, rec) in enumerate(fixed_records(image, addr, (end - addr) // 6, 6)):
        width_bytes = rec[0] - 1
        height = rec[1]
        if width_bytes <= 0 or height <= 0:
            continue
        for kind, ptr in (("bitmap", rec[2] | (rec[3] << 8)),
                          ("mask", rec[4] | (rec[5] << 8))):
            w, h = width_bytes * 8, height
            px = [0] * (w * h)
            for row in range(height):
                for col in range(width_bytes):
                    byte = image[ptr + row * width_bytes + col]
                    o = row * w + col * 8
                    for bit in range(8):
                        if byte & (0x80 >> bit):
                            px[o + bit] = 1
            out[f"sprite-{n:02d}-{kind}"] = (w, h, px)
    return out


def write_sheets(sk: Skool, outdir: Path) -> list[str]:
    outdir.mkdir(parents=True, exist_ok=True)
    written: list[str] = []

    def put(name: str, wht: tuple[int, int, list[int]]) -> None:
        w, h, px = wht
        pngio.write_indexed(outdir / f"{name}.png", w, h, px, PALETTE)
        written.append(name)

    # Tile sheets take a `tiles-` prefix so they cannot collide with the
    # per-mask sheets below, which are named mask-<addr>.
    image = sk.image
    put("tiles-exterior", tile_sheet(image, sk.addr_of("exterior_tiles"), 571))
    put("tiles-interior", tile_sheet(image, sk.addr_of("interior_tiles"), 194))

    mask_lo, mask_hi = sk.addr_of("mask_tiles"), sk.addr_of("exterior_tiles")
    put("tiles-mask", tile_sheet(image, mask_lo, (mask_hi - mask_lo) // 8))

    # Nine bytes per static tile, not eight: the ninth is the attribute byte
    # plot_static_tiles writes ($F219 / $F23E). At stride 8 the sheet showed 84
    # tiles sliding progressively out of alignment.
    lo, hi = sk.extent_of("static_tiles")
    put("tiles-static", tile_sheet(image, lo, (hi - lo) // 9, stride=9))

    put("supertiles", supertile_sheet(sk))
    put("map", map_sheet(sk))

    for name, wht in object_sheets(sk).items():
        put(name, wht)
    for name, wht in mask_sheets(sk).items():
        put(name, wht)
    for name, wht in sprite_sheets(sk).items():
        put(name, wht)

    return written


def item_sheets(sk: Skool) -> dict[str, tuple[int, int, list[int]]]:
    """The 16 item_definitions ($DD7D) as bitmaps and masks, one sheet each.

    Keyed by the reference build's own filenames, which drop the underscores
    from the label: mask_shovel_key -> item-mask-shovelkey. Several items share
    artwork (the three keys are one bitmap), so the 16 definitions yield fewer
    than 32 distinct sheets and the dict collapses the duplicates.
    """
    image = sk.image
    base = sk.addr_of("item_definitions")

    out: dict[str, tuple[int, int, list[int]]] = {}
    for i in range(16):
        a = base + i * 6
        width, height = image[a], image[a + 1]
        for kind, ptr in (
            ("bitmap", image[a + 2] | (image[a + 3] << 8)),
            ("mask", image[a + 4] | (image[a + 5] << 8)),
        ):
            labels = sk.addr_to_labels.get(ptr, [])
            if not labels:
                continue
            stem = labels[0].replace("_", "").removeprefix("bitmap").removeprefix("mask")
            name = f"item-{stem}" if kind == "bitmap" else f"item-mask-{stem}"

            px = [0] * (width * 8 * height)
            for y in range(height):
                for bx in range(width):
                    byte = image[ptr + y * width + bx]
                    for bit in range(8):
                        px[y * width * 8 + bx * 8 + bit] = (byte >> (7 - bit)) & 1
            out[name] = (width * 8, height, px)
    return out
