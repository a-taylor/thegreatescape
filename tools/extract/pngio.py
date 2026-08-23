"""Minimal PNG read/write, stdlib only.

The project's toolchain is meant to be just Vite + Vitest + TypeScript on the
web side, and SkoolKit is the only Python dependency. Rather than pull in
Pillow or numpy purely to compare golden images, this module does the small
amount of PNG work needed: read the reference renders under
build/TheGreatEscape/images/, and write our own asset sheets.

Only the subset PNG actually needs here is supported -- no interlacing, no
16-bit channels.
"""

from __future__ import annotations

import struct
import zlib
from dataclasses import dataclass
from pathlib import Path

SIGNATURE = b"\x89PNG\r\n\x1a\n"

# Bytes per pixel by colour type, used to pick the filter stride.
_CHANNELS = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}


@dataclass
class Image:
    """An indexed or greyscale image as one integer sample per pixel."""

    width: int
    height: int
    pixels: list[int]          # row-major, len == width * height
    palette: list[tuple[int, int, int]] | None = None

    def at(self, x: int, y: int) -> int:
        return self.pixels[y * self.width + x]

    def crop(self, x0: int, y0: int, w: int, h: int) -> "Image":
        px = [self.at(x0 + x, y0 + y) for y in range(h) for x in range(w)]
        return Image(w, h, px, self.palette)

    def downscale(self, factor: int) -> "Image":
        """Take every Nth pixel. The reference renders are nearest-neighbour
        upscales, so this inverts them exactly."""
        w, h = self.width // factor, self.height // factor
        px = [self.at(x * factor, y * factor) for y in range(h) for x in range(w)]
        return Image(w, h, px, self.palette)

    def to_bits(self) -> list[int]:
        """Collapse to 1 bit per pixel, where 1 means ink (a set bit in the
        original Spectrum bitmap).

        Palette index order is NOT a reliable proxy for ink/paper. SkoolKit
        writes attribute-7 graphics with index 0 = white ink (205,198,205) and
        index 1 = black paper, i.e. the opposite of the obvious reading. So ink
        is identified by colour: any palette entry that is not pure black.
        """
        if self.palette:
            ink = {i for i, c in enumerate(self.palette) if c != (0, 0, 0)}
            return [1 if p in ink else 0 for p in self.pixels]
        return [1 if p else 0 for p in self.pixels]


def _unfilter(raw: bytes, width: int, height: int, bpp_bits: int, stride_bpp: int) -> bytes:
    """Reverse the per-scanline PNG filters."""
    row_bytes = (width * bpp_bits + 7) // 8
    out = bytearray()
    prev = bytearray(row_bytes)
    pos = 0
    for _ in range(height):
        ftype = raw[pos]
        pos += 1
        line = bytearray(raw[pos:pos + row_bytes])
        pos += row_bytes
        if ftype == 0:
            pass
        elif ftype == 1:  # Sub
            for i in range(stride_bpp, row_bytes):
                line[i] = (line[i] + line[i - stride_bpp]) & 0xFF
        elif ftype == 2:  # Up
            for i in range(row_bytes):
                line[i] = (line[i] + prev[i]) & 0xFF
        elif ftype == 3:  # Average
            for i in range(row_bytes):
                a = line[i - stride_bpp] if i >= stride_bpp else 0
                line[i] = (line[i] + ((a + prev[i]) >> 1)) & 0xFF
        elif ftype == 4:  # Paeth
            for i in range(row_bytes):
                a = line[i - stride_bpp] if i >= stride_bpp else 0
                b = prev[i]
                c = prev[i - stride_bpp] if i >= stride_bpp else 0
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 0xFF
        else:
            raise ValueError(f"unknown PNG filter type {ftype}")
        out += line
        prev = line
    return bytes(out)


def read(path: Path) -> Image:
    data = path.read_bytes()
    if data[:8] != SIGNATURE:
        raise ValueError(f"{path}: not a PNG")

    pos = 8
    width = height = depth = colour = 0
    palette: list[tuple[int, int, int]] | None = None
    idat = bytearray()

    while pos < len(data):
        length, ctype = struct.unpack(">I4s", data[pos:pos + 8])
        body = data[pos + 8:pos + 8 + length]
        pos += 12 + length  # 8 header + body + 4 CRC

        if ctype == b"IHDR":
            width, height, depth, colour, _, _, interlace = struct.unpack(
                ">IIBBBBB", body
            )
            if interlace:
                raise ValueError(f"{path}: interlaced PNG not supported")
        elif ctype == b"PLTE":
            palette = [tuple(body[i:i + 3]) for i in range(0, len(body), 3)]
        elif ctype == b"IDAT":
            idat += body
        elif ctype == b"IEND":
            break

    channels = _CHANNELS[colour]
    bpp_bits = depth * channels
    stride_bpp = max(1, bpp_bits // 8)
    raw = _unfilter(zlib.decompress(bytes(idat)), width, height, bpp_bits, stride_bpp)

    # Expand packed sub-byte samples to one integer per pixel.
    pixels: list[int] = []
    row_bytes = (width * bpp_bits + 7) // 8
    mask = (1 << depth) - 1
    for y in range(height):
        row = raw[y * row_bytes:(y + 1) * row_bytes]
        if depth == 8:
            pixels.extend(row[x * channels] for x in range(width))
        elif depth in (1, 2, 4):
            per_byte = 8 // depth
            for x in range(width):
                byte = row[x // per_byte]
                shift = 8 - depth * (x % per_byte + 1)
                pixels.append((byte >> shift) & mask)
        else:
            raise ValueError(f"{path}: unsupported bit depth {depth}")

    return Image(width, height, pixels, palette)


def write_indexed(
    path: Path,
    width: int,
    height: int,
    pixels: list[int],
    palette: list[tuple[int, int, int]],
) -> None:
    """Write an 8-bit palette PNG. Deterministic: fixed filter, fixed zlib level."""
    raw = bytearray()
    for y in range(height):
        raw.append(0)  # filter type None, so output is byte-identical run to run
        raw += bytes(pixels[y * width:(y + 1) * width])

    plte = bytearray()
    for r, g, b in palette:
        plte += bytes((r, g, b))

    def chunk(tag: bytes, body: bytes) -> bytes:
        return (
            struct.pack(">I", len(body))
            + tag
            + body
            + struct.pack(">I", zlib.crc32(tag + body) & 0xFFFFFFFF)
        )

    path.write_bytes(
        SIGNATURE
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 3, 0, 0, 0))
        + chunk(b"PLTE", bytes(plte))
        + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        + chunk(b"IEND", b"")
    )
