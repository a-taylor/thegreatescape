"""Domain extractors: address image -> structured game data.

Each function owns one group from BUILD_PROMPT.md §3 and cites the labels and
addresses it reads. Counts are derived from label extents wherever possible and
asserted, so a wrong assumption fails loudly instead of silently truncating.
"""

from __future__ import annotations

from typing import Any

from .rle import expand_mask, expand_object, mask_extents
from .schema import (
    b64,
    decode_glyphs,
    fixed_records,
    pointer_table,
    provenance,
    resolve_pointers,
    tile_bank,
    word_at,
    words,
)
from .skoolparse import Skool

# Documented in the .skool constants block (lines 180-233, 283-337) and
# TheGreatEscapeFacts.ref. Emitted as data so that §9's "leave unused things
# unused" is testable rather than incidental.
UNUSED_ROOMS = [6, 26, 27]
UNUSED_OBJECTS = [21, 28, 39]
UNUSED_SUPERTILES = [0x4F, 0x9A]

MAP_W, MAP_H = 54, 34
N_SUPERTILES = 218
N_EXTERIOR_TILES = 571
N_INTERIOR_TILES = 194
N_ROOMS = 52
N_OBJECTS = 54
N_MASKS = 30
N_ITEMS = 16
# $6A83: "Constant final byte is always 32" -- the pos.height that
# interior_mask_data_source omits and setup_room supplies.
INTERIOR_MASK_HEIGHT = 32
N_CHARACTERS = 26


def _count(sk: Skool, label: str, stride: int, whole_block: bool = False) -> int:
    lo, hi = sk.extent_of_block(label) if whole_block else sk.extent_of(label)
    span = hi - lo
    if span % stride:
        raise ValueError(f"{label}: {span} bytes is not a multiple of {stride}")
    return span // stride


def extract_map(sk: Skool) -> dict[str, Any]:
    """Exterior map: 54x34 supertile indices, 218 supertiles of 4x4 tile refs."""
    img = sk.image
    m = sk.addr_of("map_tiles")
    s = sk.addr_of("super_tiles")

    assert _count(sk, "map_tiles", 1) == MAP_W * MAP_H
    assert _count(sk, "super_tiles", 16) == N_SUPERTILES

    return {
        **provenance(sk, "map_tiles"),
        "width": MAP_W,
        "height": MAP_H,
        "supertileIndices": list(img[m:m + MAP_W * MAP_H]),
        "superTiles": [
            list(img[s + i * 16:s + i * 16 + 16]) for i in range(N_SUPERTILES)
        ],
        "unusedSuperTiles": UNUSED_SUPERTILES,
        # Resolved here so the engine never chases addresses. Derived from
        # plot_tile (c$A9AD) -- see schema.tile_bank.
        "tileBankForSuperTile": [
            (tile_bank(i) - 0x8590) // 8 for i in range(N_SUPERTILES)
        ],
    }


def extract_tiles(sk: Skool) -> dict[str, Any]:
    """The four 8x8 tile sets, as raw bitmap bytes."""
    img = sk.image

    def sheet(label: str, count: int | None = None) -> dict[str, Any]:
        lo, hi = sk.extent_of(label)
        n = (hi - lo) // 8 if count is None else count
        return {
            **provenance(sk, label),
            "count": n,
            "bytesPerTile": 8,
            "data": b64(img[lo:lo + n * 8]),
        }

    exterior = sheet("exterior_tiles", N_EXTERIOR_TILES)
    interior = sheet("interior_tiles", N_INTERIOR_TILES)

    # tiles/mask_tiles share $8218 -- one of the four duplicate-label addresses.
    mask_lo = sk.addr_of("mask_tiles")
    mask_hi = sk.addr_of("exterior_tiles")

    return {
        "exterior": exterior,
        "interior": interior,
        "mask": {
            **provenance(sk, "mask_tiles"),
            "count": (mask_hi - mask_lo) // 8,
            "bytesPerTile": 8,
            "data": b64(img[mask_lo:mask_hi]),
        },
        "static": sheet("static_tiles"),
    }


def _read_roomdef(img: bytes, addr: int) -> dict[str, Any]:
    """Parse one self-describing roomdef record.

    Layout verified at roomdef_1_hut1_right (b$6C15):
        byte  dimensions index
        byte  n_bounds ; n x 4 bytes {x0, x1, y0, y1}
        byte  n_masks  ; n x 1 byte
        byte  n_objects; n x 3 bytes {object, x, y}
    """
    i = addr
    dimensions = img[i]; i += 1

    n = img[i]; i += 1
    bounds = []
    for _ in range(n):
        bounds.append({"x0": img[i], "x1": img[i + 1], "y0": img[i + 2], "y1": img[i + 3]})
        i += 4

    n = img[i]; i += 1
    masks = list(img[i:i + n]); i += n

    n = img[i]; i += 1
    objects = []
    for _ in range(n):
        objects.append({"object": img[i], "x": img[i + 1], "y": img[i + 2]})
        i += 3

    return {
        "addr": f"${addr:04X}",
        "dimensionsIndex": dimensions,
        "bounds": bounds,
        "masks": masks,
        "objects": objects,
        "bytes": i - addr,
    }


def extract_rooms(sk: Skool) -> dict[str, Any]:
    """Room definitions, the 1-based pointer table, and the dimensions table."""
    img = sk.image

    dims_addr = sk.addr_of("roomdef_dimensions")
    n_dims = _count(sk, "roomdef_dimensions", 4)
    dimensions = [
        {"x1": img[a], "x0": img[a + 1], "y1": img[a + 2], "y0": img[a + 3]}
        for a, _ in fixed_records(img, dims_addr, n_dims, 4)
    ]

    # rooms_and_tunnels is 52 entries and 1-BASED: "the first entry is room 1,
    # not room 0". Aliasing is heavy -- 33 distinct roomdefs back 52 rooms.
    rt = sk.addr_of("rooms_and_tunnels")
    assert _count(sk, "rooms_and_tunnels", 2) == N_ROOMS
    pointers = pointer_table(img, rt, N_ROOMS)
    targets, indices = resolve_pointers(pointers)

    roomdefs = [_read_roomdef(img, a) for a in targets]
    for d, a in zip(roomdefs, targets):
        d["labels"] = sk.addr_to_labels.get(a, [])

    rooms = []
    for n, (ptr, idx) in enumerate(zip(pointers, indices), start=1):
        first = pointers.index(ptr) + 1
        rooms.append({
            "room": n,
            "roomdefIndex": idx,
            "unused": n in UNUSED_ROOMS,
            "aliasOf": None if first == n else first,
        })

    return {
        **provenance(sk, "rooms_and_tunnels"),
        "note": "rooms_and_tunnels is 1-based; entry 0 is room 1",
        "dimensions": {**provenance(sk, "roomdef_dimensions"), "entries": dimensions},
        "roomdefs": roomdefs,
        "rooms": rooms,
        "unusedRooms": UNUSED_ROOMS,
    }


def extract_objects(sk: Skool) -> dict[str, Any]:
    """The 54 RLE-compressed interior objects, expanded."""
    img = sk.image
    base = sk.addr_of("interior_object_defs")
    pointers = pointer_table(img, base, N_OBJECTS)

    objects = []
    for n, ptr in enumerate(pointers):
        w, h, tiles = expand_object(img, ptr)
        objects.append({
            "index": n,
            "addr": f"${ptr:04X}",
            "width": w,
            "height": h,
            "tiles": tiles,
            "unused": n in UNUSED_OBJECTS,
        })

    return {
        **provenance(sk, "interior_object_defs"),
        "objects": objects,
        "unusedObjects": UNUSED_OBJECTS,
        "note": "tile 0 is transparent: the write is skipped but the cursor advances ($6ADE)",
    }


def extract_masks(sk: Skool) -> dict[str, Any]:
    """The 30 masks plus the two mask_t usage tables.

    Heights are derived exactly, not inferred -- see OPEN_QUESTIONS.md §10.
    """
    img = sk.image
    mp = sk.addr_of("mask_pointers")
    region_end = sk.addr_of("interior_mask_data_source")
    pointers = pointer_table(img, mp, N_MASKS)
    extents = mask_extents(pointers, region_end)

    masks = []
    for n, p in enumerate(pointers):
        lo, hi = extents[p]
        w, h, tiles = expand_mask(img, lo, hi)
        masks.append({
            "index": n,
            "addr": f"${p:04X}",
            "kind": "exterior" if n < 15 else "interior",
            "width": w,
            "height": h,
            "tiles": tiles,
        })

    def mask_records(label: str, stride: int) -> list[dict[str, Any]]:
        """{index, bounds x0/x1/y0/y1, pos x/y/height} -- eight bytes.

        interior_mask_data_source is stored SEVEN bytes wide: "an array of 47
        mask structs with the constant final height byte omitted" ($EA7C).
        setup_room copies the seven and appends $20 itself ($6A83), so the
        height is restored here -- without it every interior mask has height 0
        and render_mask_buffer's "is the character in front of it?" test
        ($B979) rejects the lot, leaving nothing to occlude anyone indoors.
        """
        addr = sk.addr_of(label)
        out = []
        for a, rec in fixed_records(img, addr, _count(sk, label, stride), stride):
            pos = list(rec[5:])
            if stride == 7:
                pos.append(INTERIOR_MASK_HEIGHT)
            out.append({
                "addr": f"${a:04X}",
                "index": rec[0],
                "bounds": {"x0": rec[1], "x1": rec[2], "y0": rec[3], "y1": rec[4]},
                "pos": pos,
            })
        return out

    referenced = {r["index"] for r in mask_records("exterior_mask_data", 8)}
    referenced |= {r["index"] for r in mask_records("interior_mask_data_source", 7)}

    return {
        **provenance(sk, "mask_pointers"),
        "masks": masks,
        "exteriorMaskData": mask_records("exterior_mask_data", 8),
        "interiorMaskDataSource": mask_records("interior_mask_data_source", 7),
        # Flagged explicitly: mask 19 is referenced by nothing, which is why the
        # reference build renders it at a fallback height of 1.
        "unreferencedMasks": sorted(set(range(N_MASKS)) - referenced),
    }


def extract_sprites(sk: Skool) -> dict[str, Any]:
    """The sprites table: 6-byte records {width_bytes+1, height, data, mask}."""
    img = sk.image
    addr = sk.addr_of("sprites")
    # The sprites array runs to the start of the animation data.
    end = sk.addr_of("anim_crawlwait_tl")
    count = (end - addr) // 6

    sprites = []
    for a, rec in fixed_records(img, addr, count, 6):
        data_ptr = rec[2] | (rec[3] << 8)
        mask_ptr = rec[4] | (rec[5] << 8)
        width_bytes = rec[0] - 1
        height = rec[1]
        size = width_bytes * height
        sprites.append({
            "addr": f"${a:04X}",
            # Stored value is width in BYTES PLUS ONE (ctl line 10874).
            "widthBytes": width_bytes,
            "widthPixels": width_bytes * 8,
            "height": height,
            "bitmapAddr": f"${data_ptr:04X}",
            "maskAddr": f"${mask_ptr:04X}",
            "bitmapLabels": sk.addr_to_labels.get(data_ptr, []),
            "maskLabels": sk.addr_to_labels.get(mask_ptr, []),
            # The bytes themselves, read at the size the table declares. Nine
            # records declare more rows than fit before the next sprite's data:
            # bitmap_dog_facing_bottom_right_3 ($CE9A) claims 15 rows where 13
            # fit, and the eight prisoner walk frames ($CE2E..$CE58) each
            # overrun by one row. This deliberately reads what the table says,
            # inheriting the glitch rather than silently clamping. See
            # FIDELITY.md.
            "bitmap": b64(img[data_ptr:data_ptr + size]),
            "mask": b64(img[mask_ptr:mask_ptr + size]),
        })

    return {
        **provenance(sk, "sprites"),
        "count": count,
        "sprites": sprites,
        "knownGlitches": [
            "All prisoner sprites are specified one row too tall "
            "(TheGreatEscapeGraphics.ref:21). Not visibly wrong.",
            "Dog frame 3 ($CEA0) has height 15 but only 13 rows of data, so two "
            "rows are lifted from the next frame -- the documented stray pixels.",
            "Front-facing guard bitmap pointers ($CEBE) are offset back by two "
            "bytes, drawing them one row too low.",
        ],
    }


def _item_definitions(sk: Skool) -> list[dict[str, Any]]:
    """item_definitions ($DD7D): a 6-byte spritedef per item.

    {byte width, byte height, word bitmap, word mask}. The width is stored
    plainly here, unlike the `sprites` table which stores width-plus-one --
    verified below by checking width*height against the gap to the next
    bitmap, which matches exactly for every item.
    """
    img = sk.image
    base = sk.addr_of("item_definitions")

    records = []
    for i, (a, rec) in enumerate(fixed_records(img, base, N_ITEMS, 6)):
        width = rec[0]
        height = rec[1]
        bitmap = rec[2] | (rec[3] << 8)
        mask = rec[4] | (rec[5] << 8)
        size = width * height
        records.append({
            "index": i,
            "addr": f"${a:04X}",
            "widthBytes": width,
            "widthPixels": width * 8,
            "height": height,
            "bitmapAddr": f"${bitmap:04X}",
            "maskAddr": f"${mask:04X}",
            "bitmapLabels": sk.addr_to_labels.get(bitmap, []),
            "maskLabels": sk.addr_to_labels.get(mask, []),
            "bitmap": b64(img[bitmap:bitmap + size]),
            "mask": b64(img[mask:mask + size]),
        })

    # The width-not-width-plus-one reading, asserted rather than assumed: every
    # item's declared size must land exactly on the next block's start.
    starts = sorted({r["bitmapAddr"] for r in records} | {r["maskAddr"] for r in records})
    starts = [int(s[1:], 16) for s in starts]
    for r in records:
        for kind in ("bitmap", "mask"):
            p = int(r[f"{kind}Addr"][1:], 16)
            nxt = next((s for s in starts if s > p), None)
            if nxt is not None:
                need = r["widthBytes"] * r["height"]
                assert need <= nxt - p, (
                    f"item {r['index']} {kind} declares {need} bytes but only "
                    f"{nxt - p} are available -- width is not a plain byte count"
                )
    return records


def extract_items(sk: Skool) -> dict[str, Any]:
    # item_structs and item_attributes each own their whole block; their extents
    # are truncated by element labels (item_structs_food, item_attributes_food).
    img = sk.image
    structs = sk.addr_of("item_structs")
    stride = _count(sk, "item_structs", 1, whole_block=True) // N_ITEMS
    assert stride == 7, f"expected 7-byte itemstructs, got {stride}"

    return {
        **provenance(sk, "item_structs"),
        "count": N_ITEMS,
        "structStride": stride,
        "structs": [list(r) for _, r in fixed_records(img, structs, N_ITEMS, stride)],
        # item_definitions ($DD7D): one 6-byte spritedef per item, indexed by
        # item number ($DC55..$DC5D multiplies the index by 6). Note the width
        # here is a PLAIN byte count, not the sprites table's width-plus-one --
        # setup_item_plotting never adds the extra byte because item plotting
        # "only ever uses the 16 pixel plotter".
        "definitions": {
            **provenance(sk, "item_definitions"),
            "stride": 6,
            "records": _item_definitions(sk),
        },
        "attributes": {
            **provenance(sk, "item_attributes"),
            "values": list(sk.slice_block("item_attributes")),
        },
        "defaultLocations": {
            **provenance(sk, "default_item_locations"),
            "values": list(sk.slice("default_item_locations")),
        },
        "redCrossParcelContents": {
            **provenance(sk, "red_cross_parcel_contents_list"),
            "values": list(sk.slice("red_cross_parcel_contents_list")),
        },
    }


def extract_characters(sk: Skool) -> dict[str, Any]:
    img = sk.image
    structs = sk.addr_of("character_structs")
    stride = _count(sk, "character_structs", 1) // N_CHARACTERS

    return {
        **provenance(sk, "character_structs"),
        "count": N_CHARACTERS,
        "structStride": stride,
        "structs": [
            list(r) for _, r in fixed_records(img, structs, N_CHARACTERS, stride)
        ],
        "vischarInitial": {
            **provenance(sk, "vischar_initial"),
            "data": b64(sk.slice("vischar_initial")),
        },
        "resetData": {
            **provenance(sk, "character_reset_data"),
            "data": b64(sk.slice("character_reset_data")),
        },
        "eventHandlerIndexMap": {
            **provenance(sk, "character_to_event_handler_index_map"),
            "values": list(sk.slice("character_to_event_handler_index_map")),
        },
    }


def extract_geography(sk: Skool) -> dict[str, Any]:
    """Doors, locations, walls, beds and the solitary position."""
    img = sk.image

    def raw(label: str) -> dict[str, Any]:
        return {**provenance(sk, label), "values": list(sk.slice(label))}

    # `doors` owns its whole block; extent_of() would stop at the section label
    # doors_home_to_outside, which names a region *within* the array.
    doors_lo, doors_hi = sk.extent_of_block("doors")

    # 62 PAIRS of 4-byte half-doors (124 entries). Each half gives the TARGET
    # room, the direction the door faces, and its position; the pair's other
    # half is where you arrive. Outdoor coordinates are stored divided by four.
    half_doors = []
    for a, rec in fixed_records(img, doors_lo, (doors_hi - doors_lo) // 4, 4):
        half_doors.append({
            "addr": f"${a:04X}",
            "targetRoom": (rec[0] >> 2) & 0x3F,
            "direction": rec[0] & 0x03,
            "pos": {"x": rec[1], "y": rec[2], "height": rec[3]},
        })

    return {
        "doors": {
            "_label": "doors",
            "_addr": f"${doors_lo:04X}",
            "_bytes": doors_hi - doors_lo,
            "pairCount": len(half_doors) // 2,
            "halfDoors": half_doors,
            "note": (
                "Each door is a PAIR of half-doors; entry 2n and 2n+1. "
                "Outdoor positions are divided by four (transition c$68A2 "
                "multiplies them back by 4)."
            ),
        },
        "doorSections": {
            "homeToOutside": f"${sk.addr_of('doors_home_to_outside'):04X}",
            "homeToInside": f"${sk.addr_of('doors_home_to_inside'):04X}",
            "homeToTunnel": f"${sk.addr_of('doors_home_to_tunnel'):04X}",
        },
        "lockedDoors": raw("locked_doors"),
        "solitaryPos": raw("solitary_pos"),
        "locations": {
            **provenance(sk, "locations"),
            "values": words(img, sk.addr_of("locations"),
                            _count(sk, "locations", 2)),
        },
        "beds": {
            **provenance(sk, "beds"),
            "values": words(img, sk.addr_of("beds"), _count(sk, "beds", 2)),
        },
        # 24 wall/boundary volumes in map space, stride 6:
        # {minx, maxx, miny, maxy, minh, maxh}. bounds_check (c$B14C) tests the
        # hero against every one of them.
        "walls": {
            **provenance(sk, "walls"),
            "stride": 6,
            "fields": ["minx", "maxx", "miny", "maxy", "minh", "maxh"],
            "entries": [
                dict(zip(("minx", "maxx", "miny", "maxy", "minh", "maxh"), rec))
                for _, rec in fixed_records(
                    img, sk.addr_of("walls"), _count(sk, "walls", 6), 6
                )
            ],
        },
        # Three permitted areas, stride 4: {x0, x1, y0, y1} in tinypos space.
        # within_camp_bounds (c$A01A) indexes this with 0..2.
        "permittedBounds": {
            **provenance(sk, "permitted_bounds"),
            "entries": [
                dict(zip(("x0", "x1", "y0", "y1"), rec))
                for _, rec in fixed_records(
                    img,
                    sk.addr_of("permitted_bounds"),
                    _count(sk, "permitted_bounds", 4),
                    4,
                )
            ],
        },
        "routeToPermitted": {
            **provenance(sk, "route_to_permitted"),
            "values": list(sk.slice("route_to_permitted")),
        },
    }


def extract_animations(sk: Skool) -> dict[str, Any]:
    """The animation table, the (direction, input) lookup, and the frame data.

    Movement is entirely data-driven: animindices ($CDAA) maps a character's
    direction and input to an animation index plus a reverse flag, animations
    ($CDF2) resolves that to a pointer, and each frame carries signed dx/dy/dh
    deltas. Nothing about how far a step moves is hardcoded in the engine.

    An animation is a 4-byte header {nframes, ...} followed by nframes frames of
    {dx, dy, dh, spriteindex}, the last with a flip flag in its top bit.
    """
    img = sk.image
    anims_addr = sk.addr_of("animations")
    n_anims = _count(sk, "animations", 2)
    pointers = pointer_table(img, anims_addr, n_anims)

    def signed(b: int) -> int:
        return b - 256 if b >= 128 else b

    animations = []
    for i, ptr in enumerate(pointers):
        nframes = img[ptr]
        frames = []
        for f in range(nframes):
            o = ptr + 4 + f * 4
            frames.append({
                "dx": signed(img[o]),
                "dy": signed(img[o + 1]),
                "dh": signed(img[o + 2]),
                "sprite": img[o + 3] & 0x7F,
                "flip": bool(img[o + 3] & 0x80),
            })
        animations.append({
            "index": i,
            "addr": f"${ptr:04X}",
            "labels": sk.addr_to_labels.get(ptr, []),
            "header": list(img[ptr:ptr + 4]),
            "frames": frames,
        })

    # animindices is 8 rows (direction 0..7) x 9 columns (the 3x3 input grid).
    ai = sk.addr_of("animindices")
    rows = []
    for d in range(8):
        row = []
        for inp in range(9):
            v = img[ai + d * 9 + inp]
            row.append({"animation": v & 0x7F, "reverse": bool(v & 0x80)})
        rows.append(row)

    return {
        **provenance(sk, "animations"),
        "count": n_anims,
        "animations": animations,
        "animIndices": {
            **provenance(sk, "animindices"),
            "rows": 8,
            "columns": 9,
            "note": (
                "row = direction (TL/TR/BR/BL, then the same four crawling); "
                "column = input, encoded as horizontal*3 + vertical where "
                "up=1 down=2 left=3 right=6"
            ),
            "table": rows,
        },
    }


def extract_movables(sk: Skool) -> dict[str, Any]:
    """The stove and crate: items the hero can push along a single axis.

    "Unlike ordinary items such as keys and the radio the movable items can be
    pushed around (on one axis) by the hero character walking into them.
    Internally they use the second visible character slot." (setup_movable_items,
    c$6939)

    The push limits are not in a table -- they are immediates in the collision
    code ($B07F for the stove, $B08B for the crate) -- so they are recorded here
    with the addresses they came from rather than silently inlined in the engine.
    """
    img = sk.image

    # "struct movable_item { word x_coord, y_coord, height; const sprite *;
    # byte index; }" ($69AE) -- nine bytes, matching the LD BC,$0009 at $6980.
    sprites_addr = sk.addr_of("sprites")

    def movable(label: str, character: int, axis: str, centre: int) -> dict[str, Any]:
        a = sk.addr_of(label)
        sprite_ptr = word_at(img, a + 6)
        return {
            **provenance(sk, label),
            "character": character,
            "pos": {
                "x": word_at(img, a),
                "y": word_at(img, a + 2),
                "height": word_at(img, a + 4),
            },
            "spriteAddr": f"${sprite_ptr:04X}",
            # Index into the sprites array, so the engine never chases a Z80
            # address. The records are 6 bytes; see extract_sprites.
            "spriteIndex": (sprite_ptr - sprites_addr) // 6,
            # The struct's ninth byte. NOT a table index -- it is the vischar's
            # animation index field, and all three movables store 0.
            "animIndex": img[a + 8],
            "axis": axis,
            "centre": centre,
            # $B07F LD BC,$0723 -- B is the range either side of the centre.
            "range": 7,
        }

    return {
        "note": (
            "Movable items occupy vischar slot 1 ($8020). setup_movable_items "
            "($693C..$6958) picks one by room: 2 -> stove1, 4 -> stove2, "
            "9 -> crate."
        ),
        "byRoom": {"2": "stove1", "4": "stove2", "9": "crate"},
        # Stoves move on Y about 35 ($B07F); the crate moves on X about 54 ($B08B).
        "items": {
            "stove1": movable("movable_item_stove1", 26, "y", 35),
            "stove2": movable("movable_item_stove2", 27, "y", 35),
            "crate": movable("movable_item_crate", 28, "x", 54),
        },
    }


def extract_routes(sk: Skool) -> dict[str, Any]:
    """The route table and the individual routes within it.

    A vischar's route is (index, step): the index selects a route from the
    table at $7738, the step indexes into it, and bit 7 of the index means
    "follow in reverse" (route_REVERSED, .skool line 510).

    `routes` owns its whole block -- the route_* labels name entries inside it.
    """
    lo, hi = sk.extent_of_block("routes")
    entries = []
    for addr in sorted(a for a in sk.addr_to_labels if lo <= a < hi):
        end = min(
            (a for a in sk.addr_to_labels if addr < a < hi), default=hi
        )
        entries.append({
            "addr": f"${addr:04X}",
            "labels": sk.addr_to_labels[addr],
            "offset": addr - lo,
            "values": list(sk.image[addr:end]),
        })

    return {
        "_label": "routes",
        "_addr": f"${lo:04X}",
        "_bytes": hi - lo,
        "data": b64(sk.slice_block("routes")),
        "entries": entries,
        "note": "route index bit 7 (route_REVERSED) means follow in reverse order",
    }


def extract_text(sk: Skool) -> dict[str, Any]:
    img = sk.image
    mt = sk.addr_of("messages_table")
    n = _count(sk, "messages_table", 2)

    return {
        "messagesTable": {
            **provenance(sk, "messages_table"),
            "pointers": [f"${p:04X}" for p in words(img, mt, n)],
        },
        "escapeStrings": {
            **provenance(sk, "escape_strings"),
            "data": b64(sk.slice("escape_strings")),
        },
        "bitmapFont": {
            **provenance(sk, "bitmap_font"),
            "data": b64(sk.slice("bitmap_font")),
        },
        "keycodeToGlyph": {
            **provenance(sk, "keycode_to_glyph"),
            "values": list(sk.slice("keycode_to_glyph")),
        },
        "glyphSet": {
            "note": 'the letter "O" is absent; digit zero doubles for it',
            "chars": list(decode_glyphs(bytes(range(48)))),
        },
    }


def extract_timing(sk: Skool) -> dict[str, Any]:
    img = sk.image
    gw = sk.addr_of("game_window_start_addresses")
    n = _count(sk, "game_window_start_addresses", 2)
    assert n == 128, f"expected 128 window row pointers, got {n}"

    return {
        "timedEvents": {
            **provenance(sk, "timed_events"),
            "values": list(sk.slice("timed_events")),
        },
        "searchlightMovements": {
            **provenance(sk, "searchlight_movements"),
            "values": list(sk.slice("searchlight_movements")),
        },
        "searchlightShape": {
            **provenance(sk, "searchlight_shape"),
            "data": b64(sk.slice("searchlight_shape")),
        },
        "zoomboxTiles": {
            **provenance(sk, "zoombox_tiles"),
            "data": b64(sk.slice("zoombox_tiles")),
        },
        "gameWindow": {
            **provenance(sk, "game_window_start_addresses"),
            "rows": n,
            "rowAddresses": [f"${p:04X}" for p in words(img, gw, n)],
            # First pointer $4047 decodes to char column 7, pixel row 16.
            "originColumn": 7,
            "originPixelRow": 16,
            "widthPixels": 192,
            "heightPixels": 128,
            "note": (
                "The visible window is 192x128 (24x16 chars). The 24x17 figure "
                "in BUILD_PROMPT §4 is the BUFFER (tile_buf 408B at $F0F8, "
                "window_buf 3264B at $F290); the extra row is scroll slack and "
                "is never blitted."
            ),
        },
    }


def extract_audio(sk: Skool) -> dict[str, Any]:
    return {
        "channel0": {
            **provenance(sk, "music_channel0_data"),
            "data": b64(sk.slice("music_channel0_data")),
        },
        "channel1": {
            **provenance(sk, "music_channel1_data"),
            "data": b64(sk.slice("music_channel1_data")),
        },
        "semitoneToFrequency": {
            **provenance(sk, "semitone_to_frequency"),
            "data": b64(sk.slice("semitone_to_frequency")),
        },
    }


def extract_prng(sk: Skool) -> dict[str, Any]:
    """The PRNG source bytes.

    Not a table: $9000..$90FF lies inside exterior_tiles, so random_nibble
    ($CB85) is reading exterior tile BITMAP data as entropy. Extracted as a raw
    address slice -- see OPEN_QUESTIONS.md §7.
    """
    lo, hi = 0x9000, 0x9100
    ext_lo, ext_hi = sk.extent_of("exterior_tiles")
    assert ext_lo <= lo < ext_hi, "PRNG range should sit inside exterior_tiles"

    return {
        "_addr": "$9000",
        "_bytes": hi - lo,
        "containedIn": "exterior_tiles",
        "data": b64(sk.raw(lo, hi)),
        "pointerInit": "$9000",
        "note": (
            "random_nibble ($CB85) does INC L BEFORE the read, so the first "
            "value comes from $9001; H is never touched, so it wraps in-page."
        ),
    }


EXTRACTORS = {
    "map": extract_map,
    "tiles": extract_tiles,
    "rooms": extract_rooms,
    "objects": extract_objects,
    "masks": extract_masks,
    "sprites": extract_sprites,
    "items": extract_items,
    "characters": extract_characters,
    "geography": extract_geography,
    "animations": extract_animations,
    "movables": extract_movables,
    "routes": extract_routes,
    "text": extract_text,
    "timing": extract_timing,
    "audio": extract_audio,
    "prng": extract_prng,
}
