"""Primitives for slicing the address image into structured tables.

Kept deliberately small. The variety of shapes in this game (variable-length
roomdefs, fixed-stride sprite records, glyph-encoded text, raw address slices)
does not reward a heavy descriptor framework, so this module provides just the
few operations that actually repeat, and the domain extractors in tables.py
compose them.

Every extracted table carries provenance -- its @label and $address -- so any
value in the running game can be traced back to a line of the disassembly, per
BUILD_PROMPT.md §0.
"""

from __future__ import annotations

import base64
from typing import Any, Callable, Iterator

from .skoolparse import Skool


def provenance(sk: Skool, label: str) -> dict[str, Any]:
    lo, hi = sk.extent_of(label)
    return {"_label": label, "_addr": f"${lo:04X}", "_bytes": hi - lo}


def word_at(image: bytes, addr: int) -> int:
    """Little-endian 16-bit read."""
    return image[addr] | (image[addr + 1] << 8)


def words(image: bytes, addr: int, count: int) -> list[int]:
    return [word_at(image, addr + i * 2) for i in range(count)]


def fixed_records(
    image: bytes, addr: int, count: int, stride: int
) -> Iterator[tuple[int, bytes]]:
    """Yield (address, bytes) for `count` records of `stride` bytes."""
    for i in range(count):
        a = addr + i * stride
        yield a, bytes(image[a:a + stride])


def pointer_table(
    image: bytes, addr: int, count: int
) -> list[int]:
    """Read `count` little-endian pointers."""
    return words(image, addr, count)


def resolve_pointers(pointers: list[int]) -> tuple[list[int], list[int]]:
    """Turn a pointer list into (unique targets in first-use order, index per entry).

    This is how address chasing is kept out of src/: the engine sees indices,
    never addresses. Aliasing is preserved -- rooms_and_tunnels ($6BAD) has 52
    entries backed by only 33 distinct roomdefs, and which rooms share a
    definition is itself meaningful.
    """
    order: list[int] = []
    seen: dict[int, int] = {}
    indices: list[int] = []
    for p in pointers:
        if p not in seen:
            seen[p] = len(order)
            order.append(p)
        indices.append(seen[p])
    return order, indices


def b64(data: bytes) -> str:
    """Bitmaps and tile data emit as base64, not JSON number arrays.

    A 571-tile exterior set is 4,568 bytes; as a JSON array of decimals that is
    roughly three times larger and no more readable.
    """
    return base64.b64encode(bytes(data)).decode("ascii")


def tile_bank(supertile: int) -> int:
    """Exterior tile base address for a supertile index.

    Transcribed from `plot_tile` (c$A9AD):

        $A9B0 LD BC,$8590   ; exterior_tiles[0]
        $A9B3 CP $2D        ; if supertile <  45  -> $8590
        $A9B7 LD BC,$8A18   ; exterior_tiles[145]
        $A9BA CP $8B        ; if supertile < 139  -> $8A18
        $A9BE CP $CC        ; if supertile >= 204 -> $8A18
        $A9C2 LD BC,$90F8   ; exterior_tiles[365] otherwise

    Note 365, not the 366 stated in TheGreatEscapeGraphics.ref line 205:
    $90F8 - $8590 = 2920, and 2920 / 8 = 365. Verified by rendering the whole
    54x34 map and diffing against map-0-0.png -- 1,880,064 pixels, 0 differ.
    """
    if supertile < 0x2D:
        return 0x8590
    if supertile < 0x8B:
        return 0x8A18
    if supertile >= 0xCC:
        return 0x8A18
    return 0x90F8


# The game's glyph set, from _decode_string semantics: digits, then A-Z with
# the letter "O" SKIPPED -- digit zero doubles for it.
GLYPHS = "0123456789" + "ABCDEFGHIJKLMN" + "PQRSTUVWXYZ" + " ."


def decode_glyphs(data: bytes) -> str:
    return "".join(GLYPHS[b] if b < len(GLYPHS) else f"\\x{b:02X}" for b in data)
