"""Run-length decoders for interior objects and masks.

The game uses TWO different RLE schemes. Both are derived here from the Z80
routines rather than from any existing decoder: every behaviour here is
traceable to a specific address, which is the project's first rule.
"""

from __future__ import annotations

ESCAPE = 0xFF  # interiorobjecttile_ESCAPE


def expand_object(data: bytes, offset: int = 0) -> tuple[int, int, list[int]]:
    """Expand an interior object. Derived from `expand_object` (c$6AB5).

    The routine's own header table ($6A36ff) specifies the format:

        <w> <h>                    width, height in tiles
        <t>                        literal: emit a single tile t
        <$FF> <$FF>                escape: emit a single tile $FF
        <$FF> <c=128..254> <t>     repetition: emit t, (c AND 127) times
        <$FF> <c=64..79> <t>       ascending range: emit t, t+1, t+2, ...
        <$FF> <other>              not used

    Two details come only from the code, not the header:

      * Termination is by OUTPUT COUNT, not by input exhaustion. The row
        counter C is decremented at end-of-row and the routine returns when it
        hits zero ($6AF1/$6B11/$6B3A), so exactly w*h tiles are emitted and a
        run may straddle a row boundary.

      * The ascending range emits `c AND 15` tiles, i.e. t .. t+(count-1) --
        NOT count+1 as the header's prose implies. The loop at $6B25 is a
        do-while over the counter ($6B3C DEC A / JR NZ), writing once per
        iteration. Verified against the 51 reference object renders.

    Tile 0 means "emit nothing" -- the write is skipped but the output pointer
    still advances ($6ADE AND A / JR Z). That is the transparency mechanism
    that lets objects overlay a room outline. We emit the 0 and let the
    compositor treat it as transparent.

    Returns (width, height, tiles) with len(tiles) == width * height.
    """
    i = offset
    width = data[i]
    height = data[i + 1]
    i += 2

    want = width * height
    out: list[int] = []

    while len(out) < want:
        b = data[i]
        if b != ESCAPE:
            out.append(b)  # literal
            i += 1
            continue

        i += 1  # step over the escape
        c = data[i]

        if c == ESCAPE:  # $FF $FF -> emit a literal $FF
            out.append(ESCAPE)
            i += 1
            continue

        # $6AD4 masks to the top nibble before testing.
        kind = c & 0xF0
        if kind >= 0x80:  # repetition
            count = c & 0x7F  # $6AF5 AND $7F
            i += 1
            value = data[i]
            i += 1
            out.extend([value] * count)
        elif kind == 0x40:  # ascending range
            count = c & 0x0F  # $6B1F AND $0F
            i += 1
            value = data[i]
            i += 1
            out.extend((value + n) & 0xFF for n in range(count))
        else:
            raise ValueError(
                f"unused object encoding $FF ${c:02X} at offset {i}"
            )

    if len(out) != want:
        # A run straddling the final row can overshoot; the game stops mid-run
        # because its terminator is the row counter.
        out = out[:want]

    return width, height, out


def expand_mask(data: bytes, start: int, end: int) -> tuple[int, int, list[int]]:
    """Expand a mask. Derived from the decoder inside `render_mask_buffer`
    ($BA3E onward).

    Format is NOT the same as objects:

        <w>                        width in tiles -- and that is the ONLY header
        <b> where b & $80 == 0     literal: a tile index
        <b> where b & $80 != 0     repeat: count = b AND $7F, next byte is the
                                   value ($BA4D-$BA5A, $BA74-$BA79)

    Height is not stored anywhere. It is nonetheless exactly recoverable, so no
    inference is needed (OPEN_QUESTIONS.md §10): a mask's data runs to the next
    higher pointer in a SORTED copy of mask_pointers ($EBC5) -- they are not
    stored in ascending order -- with the highest running to $EA7C, where the
    mask data region ends. Then height = expanded / width, which divides
    exactly for all 30 masks.

    `start` and `end` are absolute addresses into the image; `data` is the full
    64K image.
    """
    width = data[start]
    out: list[int] = []
    i = start + 1

    while i < end:
        b = data[i]
        i += 1
        if b & 0x80:  # MASK_RUN_FLAG
            count = b & 0x7F
            value = data[i]
            i += 1
            out.extend([value] * count)
        else:
            out.append(b)

    if width == 0 or len(out) % width:
        raise ValueError(
            f"mask at ${start:04X}: {len(out)} bytes is not a multiple of "
            f"width {width}"
        )

    return width, len(out) // width, out


def mask_extents(pointers: list[int], region_end: int) -> dict[int, tuple[int, int]]:
    """Map each mask pointer to its (start, end) extent.

    mask_pointers ($EBC5) is NOT sorted -- entries 13, 14, 15 and 17 are out of
    sequence, which is also why Masks.html lists them out of order. So the end
    of each mask is the next higher address among ALL pointers, not the next
    entry in the table.
    """
    bounds = sorted(set(pointers))
    nxt = {p: (bounds[n + 1] if n + 1 < len(bounds) else region_end)
           for n, p in enumerate(bounds)}
    return {p: (p, nxt[p]) for p in set(pointers)}
