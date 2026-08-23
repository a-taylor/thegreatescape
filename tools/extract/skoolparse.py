"""Parser for TheGreatEscape.skool (SkoolKit disassembly format).

Reconstructs the 64K address space from DEFB/DEFW directives and builds a
label map, per BUILD_PROMPT.md §3: "Every byte comes out of the .skool file by
parsing DEFB/DEFW/DEFM directives anchored on @label."

Design notes, all verified against the actual file (see PLAN.md §0):

  * The file is LABEL-anchored, not block-anchored. There are 1,174 @label
    directives against only 439 blocks -- 743 labels (63%) attach mid-block.

  * Block type does not predict content type. b$7095 holds DEFWs, w$AD29 holds
    DEFBs, and 131 data lines live inside `c` (code) blocks. So "is this data?"
    is decided by the MNEMONIC, never by the block letter.

  * The address space is perfectly contiguous: strictly monotonic $4000->$FFFC
    with zero holes. We assert this, and it doubles as a parser self-check.

  * There is no DEFM, no DEFS and no `s` block anywhere in the file. All five
    `t` (text) blocks use DEFB with the game's own glyph codes.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

# The five line shapes. Address lines and comment continuations BOTH start with
# a space, so they are disambiguated on the $XXXX at offset 1 -- never on
# indentation, which ranges from 5 to ~88 columns.
# A directive may carry a trailing comment. Exactly one line does
# (`@nowarn               ;` at line 15117), but the grammar allows it.
DIRECTIVE = re.compile(
    r"^@(?P<name>[a-z][a-z0-9_+-]*)"
    r"(?:(?P<sep>[=+])(?P<value>.*?))?"
    r"(?:\s+;.*)?$"
)
ADDR_LINE = re.compile(
    r"^(?P<ctl>[bcgtuw* ])\$(?P<addr>[0-9A-F]{4}) (?P<mnem>\S+)(?: +(?P<rest>.*))?$"
)

BLOCK_TYPES = set("bcgtuw")  # `s` never occurs in this file
DATA_MNEMONICS = {"DEFB": 1, "DEFW": 2}

ORG = 0x4000
TOP = 0x10000


class SkoolParseError(Exception):
    pass


@dataclass
class Block:
    """One SkoolKit block: a run of lines opened by a type letter in column 0."""

    ctl: str
    start: int
    end: int = 0  # exclusive; filled in once the next block is seen
    title: str = ""


@dataclass
class Skool:
    """Parsed disassembly: a flat address image plus label and block maps."""

    image: bytearray
    written: bytearray  # 1 byte per address, 1 if a DEFB/DEFW wrote here
    label_to_addr: dict[str, int] = field(default_factory=dict)
    # A LIST per address: four addresses carry two labels each
    # (tiles/mask_tiles $8218, sprites/sprite_stove $CE22,
    #  masks/exterior_mask_0 $E55F, static_graphic_defs/statics_flagpole $F076).
    addr_to_labels: dict[int, list[str]] = field(default_factory=dict)
    blocks: list[Block] = field(default_factory=list)

    def addr_of(self, label: str) -> int:
        try:
            return self.label_to_addr[label]
        except KeyError:
            raise SkoolParseError(f"no such label: {label!r}") from None

    def block_containing(self, addr: int) -> Block:
        for b in self.blocks:
            if b.start <= addr < b.end:
                return b
        raise SkoolParseError(f"address ${addr:04X} is in no block")

    def _index(self) -> tuple[list[int], list[int]]:
        """Sorted label addresses and block starts, computed once and cached."""
        if not hasattr(self, "_sorted_labels"):
            self._sorted_labels = sorted(self.addr_to_labels)
            self._sorted_blocks = sorted(b.start for b in self.blocks)
        return self._sorted_labels, self._sorted_blocks

    def extent_of(self, label: str) -> tuple[int, int]:
        """Address range owned by `label`: from it to the next label or block end.

        This is the core slicing primitive. Because 63% of labels are mid-block,
        a label's extent is bounded by the next LABEL, not by the next block.
        """
        import bisect

        start = self.addr_of(label)
        labels, _ = self._index()
        end = self.block_containing(start).end
        i = bisect.bisect_right(labels, start)
        if i < len(labels) and labels[i] < end:
            end = labels[i]
        return start, end

    def slice(self, label: str) -> bytes:
        lo, hi = self.extent_of(label)
        return bytes(self.image[lo:hi])

    def extent_of_block(self, label: str) -> tuple[int, int]:
        """Address range from `label` to the end of its BLOCK, ignoring any
        labels in between.

        Needed where a label names a whole array whose *elements* or *sections*
        are themselves labelled -- extent_of() would stop at the first one and
        silently truncate. Four cases in this file:

            item_structs      truncated by item_structs_food       (an element)
            item_attributes   truncated by item_attributes_food    (an element)
            doors             truncated by doors_home_to_outside   (a section)
            routes            truncated by route_7795              (an element)

        This is deliberately NOT automatic: distinguishing "sub-label inside my
        array" from "next table starts here" is a judgement about meaning, not
        something the syntax reveals. music_channel0_data and
        searchlight_movements look similar but really are bounded by the next
        label, so they use extent_of().
        """
        start = self.addr_of(label)
        return start, self.block_containing(start).end

    def slice_block(self, label: str) -> bytes:
        lo, hi = self.extent_of_block(label)
        return bytes(self.image[lo:hi])

    def raw(self, lo: int, hi: int) -> bytes:
        """Bytes by explicit address range, for data that has no label of its own.

        Needed for the PRNG source at $9000..$90FF, which is not a table at all
        -- it lies inside exterior_tiles and is read as entropy by random_nibble
        ($CB85). See OPEN_QUESTIONS.md §7.
        """
        return bytes(self.image[lo:hi])


def _parse_operands(text: str, width: int) -> list[int]:
    """Split a DEFB/DEFW operand list into byte values.

    Operands never contain spaces, so the field ends at the first whitespace.
    Tokens are `$XX`/`$XXXX` hex, or a quoted character.

    The quoted form matters: five lines carry `"$"` or `"!"` operands (the key
    definition strings at $F2AD..$F2D2). A naive \\$([0-9A-F]+) scan would
    silently corrupt them -- `"$"` means byte 0x24, not a malformed hex literal.
    """
    out: list[int] = []
    for tok in text.split(","):
        tok = tok.strip()
        if not tok:
            raise SkoolParseError(f"empty operand in {text!r}")
        if tok.startswith('"') and tok.endswith('"') and len(tok) == 3:
            value = ord(tok[1])
        elif tok.startswith("$"):
            value = int(tok[1:], 16)
        else:
            raise SkoolParseError(f"unrecognised operand {tok!r} in {text!r}")
        if width == 1:
            if not 0 <= value <= 0xFF:
                raise SkoolParseError(f"byte out of range: {tok!r}")
            out.append(value)
        else:  # DEFW, little-endian
            if not 0 <= value <= 0xFFFF:
                raise SkoolParseError(f"word out of range: {tok!r}")
            out.append(value & 0xFF)
            out.append((value >> 8) & 0xFF)
    return out


def parse(path: Path) -> Skool:
    image = bytearray(TOP)
    written = bytearray(TOP)
    sk = Skool(image=image, written=written)

    pending_labels: list[str] = []
    expected: int | None = None  # next address, for the contiguity assertion
    current: Block | None = None
    last_comment = ""

    with path.open(encoding="utf-8") as fh:
        for lineno, line in enumerate(fh, 1):
            line = line.rstrip("\n")

            if not line:
                continue

            if line.startswith("@"):
                m = DIRECTIVE.match(line)
                if not m:
                    raise SkoolParseError(f"{path}:{lineno}: bad directive {line!r}")
                if m["name"] == "label" and m["sep"] == "=":
                    pending_labels.append(m["value"])
                # Everything else is ignored on purpose:
                #   @keep/@nowarn/@assemble  - assembler hints
                #   @isub                    - all 6 uses are cosmetic label
                #                              substitutions for self-modifying
                #                              code; identical bytes
                #   @bfix/@rfix/@ofix        - +begin/+end prose brackets only;
                #                              they carry NO substitutions.
                #                              See OPEN_QUESTIONS.md §1.
                continue

            if line.startswith(";"):
                last_comment = line[1:].strip()
                continue

            m = ADDR_LINE.match(line)
            if not m:
                # A comment continuation: leading whitespace then ';', with no
                # $XXXX. 1,011 of these exist. Anything else is a parse failure.
                if re.match(r"^\s+;", line):
                    continue
                raise SkoolParseError(f"{path}:{lineno}: unrecognised line {line!r}")

            ctl, addr = m["ctl"], int(m["addr"], 16)

            if ctl in BLOCK_TYPES:
                if current is not None:
                    current.end = addr
                current = Block(ctl=ctl, start=addr, title=last_comment)
                sk.blocks.append(current)
            elif current is None:
                raise SkoolParseError(f"{path}:{lineno}: line before any block")

            for label in pending_labels:
                if label in sk.label_to_addr:
                    raise SkoolParseError(f"{path}:{lineno}: duplicate label {label!r}")
                sk.label_to_addr[label] = addr
                sk.addr_to_labels.setdefault(addr, []).append(label)
            pending_labels.clear()

            if expected is not None and addr != expected:
                raise SkoolParseError(
                    f"{path}:{lineno}: address discontinuity -- expected "
                    f"${expected:04X}, got ${addr:04X}"
                )

            mnem = m["mnem"]
            width = DATA_MNEMONICS.get(mnem)
            if width is None:
                # An instruction. We do not decode Z80 here; we only need its
                # length to keep the contiguity check honest, and we cannot know
                # that without a disassembler. So we stop tracking until the
                # next data line -- see _verify_against_snapshot for the real
                # correctness gate.
                expected = None
                last_comment = ""
                continue

            rest = m["rest"] or ""
            operand_text = rest.split(None, 1)[0] if rest else ""
            if not operand_text:
                raise SkoolParseError(f"{path}:{lineno}: {mnem} with no operands")

            values = _parse_operands(operand_text, width)
            for i, value in enumerate(values):
                image[addr + i] = value
                written[addr + i] = 1
            expected = addr + len(values)
            last_comment = ""

    if current is not None:
        current.end = TOP

    if pending_labels:
        raise SkoolParseError(f"{path}: trailing labels {pending_labels}")

    return sk


def verify_against_snapshot(sk: Skool, snapshot_path: Path) -> int:
    """Assert every byte we parsed matches the pristine tape snapshot.

    BUILD_PROMPT.md §3 requires bytes to come from the .skool, and they do --
    this is purely a correctness gate on the parser. It catches a missed
    continuation line or a misread operand immediately, which nothing else
    would. Returns the number of bytes checked.

    Note the .skool is itself generated from this snapshot
    (`sna2skool.py --ctl TheGreatEscape.ctl <pristine.z80>`, Makefile:53), so
    the two agree by construction and any mismatch is our bug.
    """
    from skoolkit.snapshot import Snapshot

    snap = Snapshot.get(str(snapshot_path))
    ram = list(snap.ram(-1))  # $4000..$FFFF
    checked = 0
    for addr in range(ORG, TOP):
        if not sk.written[addr]:
            continue
        want = ram[addr - ORG]
        got = sk.image[addr]
        if got != want:
            raise SkoolParseError(
                f"snapshot mismatch at ${addr:04X}: parsed ${got:02X}, "
                f"snapshot ${want:02X}"
            )
        checked += 1
    return checked
