"""Generate the asset viewer: a static page showing every decoded asset.

Run:  python -m tools.extract.viewer

This is P0's human-facing acceptance deliverable (the brief's §7): a page
presenting every decoded asset -- tiles, supertiles, sprite frames, masks and
room objects. Every item is labelled with its @label and $address so it can be
traced straight back to a line of the disassembly.

Individual tiles are shown by CSS background-position against the emitted
sheets, so the page pulls in a handful of PNGs rather than a thousand.
"""

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data"
OUT = ROOT / "tools" / "assetviewer"
SHEETS = "../../data/sheets"

CSS = """
:root {
  --bg:#12141a; --panel:#191c24; --line:#2b303c;
  --fg:#e6e8ee; --dim:#8b93a7; --accent:#7dd3fc; --warn:#fbbf24;
}
* { box-sizing:border-box }
body { margin:0; background:var(--bg); color:var(--fg);
       font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace }
header { padding:24px 28px; border-bottom:1px solid var(--line); position:sticky;
         top:0; background:var(--bg); z-index:10 }
h1 { margin:0 0 4px; font-size:18px; letter-spacing:.02em }
header p { margin:0; color:var(--dim); font-size:12px }
nav { display:flex; gap:14px; flex-wrap:wrap; margin-top:12px }
nav a { color:var(--accent); text-decoration:none; font-size:12px }
nav a:hover { text-decoration:underline }
section { padding:28px; border-bottom:1px solid var(--line) }
h2 { font-size:15px; margin:0 0 4px }
.sub { color:var(--dim); font-size:12px; margin:0 0 16px }
.grid { display:flex; flex-wrap:wrap; gap:10px }
.cell { background:var(--panel); border:1px solid var(--line); border-radius:6px;
        padding:8px; display:flex; flex-direction:column; align-items:center; gap:6px }
.cap { font-size:10px; color:var(--dim); text-align:center; line-height:1.35;
       max-width:15ch; word-break:break-all }
.cap b { color:var(--fg); font-weight:600; display:block }
.tile, .sprite, img.asset {
  image-rendering:pixelated; background:#000; display:block;
}
.tile { background-repeat:no-repeat }
.badge { display:inline-block; padding:1px 6px; border-radius:99px; font-size:10px;
         background:#3a2f14; color:var(--warn); border:1px solid #5c4a1d }
.wide { overflow-x:auto; border:1px solid var(--line); border-radius:6px; background:#000 }
"""


def _load(name: str) -> dict:
    return json.loads((DATA / f"{name}.json").read_text())


def tile_cells(sheet: str, count: int, per_row: int, label: str,
               scale: int = 4, size: int = 8) -> str:
    """Cells rendered from a sheet via background-position."""
    out = []
    sw = per_row * size * scale
    for i in range(count):
        x = -(i % per_row) * size * scale
        y = -(i // per_row) * size * scale
        out.append(
            f'<div class="cell"><div class="tile" style="width:{size*scale}px;'
            f'height:{size*scale}px;background-image:url({SHEETS}/{sheet}.png);'
            f'background-size:{sw}px auto;background-position:{x}px {y}px"></div>'
            f'<div class="cap"><b>{i}</b>{label}</div></div>'
        )
    return "".join(out)


def build() -> Path:
    tiles = _load("tiles")
    mp = _load("map")
    objects = _load("objects")
    masks = _load("masks")
    sprites = _load("sprites")
    rooms = _load("rooms")

    parts: list[str] = []

    # --- tiles -------------------------------------------------------------
    for key, sheet, per_row in (
        ("exterior", "tiles-exterior", 64),
        ("interior", "tiles-interior", 64),
        ("mask", "tiles-mask", 64),
        ("static", "tiles-static", 64),
    ):
        t = tiles[key]
        parts.append(
            f'<section id="tiles-{key}"><h2>{key.title()} tiles</h2>'
            f'<p class="sub">{t["count"]} x 8x8 &middot; <code>{t["_label"]}</code> '
            f'at {t["_addr"]} &middot; {t["_bytes"]} bytes</p>'
            f'<div class="grid">{tile_cells(sheet, t["count"], per_row, t["_label"], scale=3)}</div>'
            f'</section>'
        )

    # --- supertiles --------------------------------------------------------
    n_super = len(mp["superTiles"])
    unused = set(mp["unusedSuperTiles"])
    cells = []
    for i in range(n_super):
        x, y = -(i % 16) * 32 * 2, -(i // 16) * 32 * 2
        tag = ' <span class="badge">unused</span>' if i in unused else ""
        cells.append(
            f'<div class="cell"><div class="tile" style="width:64px;height:64px;'
            f'background-image:url({SHEETS}/supertiles.png);background-size:{16*32*2}px auto;'
            f'background-position:{x}px {y}px"></div>'
            f'<div class="cap"><b>${i:02X}</b>bank {mp["tileBankForSuperTile"][i]}{tag}</div></div>'
        )
    parts.append(
        f'<section id="supertiles"><h2>Super tiles</h2>'
        f'<p class="sub">{n_super} x 4x4 tiles &middot; <code>super_tiles</code> '
        f'&middot; bank chosen by <code>plot_tile</code> (c$A9AD)</p>'
        f'<div class="grid">{"".join(cells)}</div></section>'
    )

    # --- map ---------------------------------------------------------------
    parts.append(
        f'<section id="map"><h2>Exterior map</h2>'
        f'<p class="sub">{mp["width"]}x{mp["height"]} supertiles = 1728x1088 px '
        f'&middot; <code>map_tiles</code> at {mp["_addr"]} &middot; '
        f'pixel-identical to <code>map-0-0.png</code></p>'
        f'<div class="wide"><img class="asset" src="{SHEETS}/map.png" '
        f'style="width:1728px"></div></section>'
    )

    # --- interior objects --------------------------------------------------
    cells = []
    for o in objects["objects"]:
        tag = ' <span class="badge">unused</span>' if o["unused"] else ""
        cells.append(
            f'<div class="cell"><img class="asset" src="{SHEETS}/object-{o["index"]}.png" '
            f'style="width:{o["width"]*8*2}px"><div class="cap">'
            f'<b>{o["index"]}</b>{o["width"]}x{o["height"]} &middot; {o["addr"]}{tag}</div></div>'
        )
    parts.append(
        f'<section id="objects"><h2>Interior objects</h2>'
        f'<p class="sub">{len(objects["objects"])} RLE-compressed objects &middot; '
        f'expanded by <code>expand_object</code> (c$6AB5) &middot; tile 0 is transparent</p>'
        f'<div class="grid">{"".join(cells)}</div></section>'
    )

    # --- masks -------------------------------------------------------------
    unref = set(masks["unreferencedMasks"])
    cells = []
    for m in masks["masks"]:
        tag = ' <span class="badge">unreferenced</span>' if m["index"] in unref else ""
        cells.append(
            f'<div class="cell"><img class="asset" src="{SHEETS}/mask-{m["addr"][1:]}.png" '
            f'style="width:{m["width"]*8*2}px"><div class="cap">'
            f'<b>{m["index"]} ({m["kind"][:3]})</b>{m["width"]}x{m["height"]} &middot; '
            f'{m["addr"]}{tag}</div></div>'
        )
    parts.append(
        f'<section id="masks"><h2>Masks</h2>'
        f'<p class="sub">{len(masks["masks"])} masks (15 exterior + 15 interior) &middot; '
        f'heights derived exactly from sorted <code>mask_pointers</code> extents, '
        f'not inferred</p>'
        f'<div class="grid">{"".join(cells)}</div></section>'
    )

    # --- sprites -----------------------------------------------------------
    cells = []
    for n, s in enumerate(sprites["sprites"]):
        name = (s["bitmapLabels"] or ["?"])[0]
        for kind in ("bitmap", "mask"):
            f = OUT.parent.parent / "data" / "sheets" / f"sprite-{n:02d}-{kind}.png"
            if not f.exists():
                continue
            cells.append(
                f'<div class="cell"><img class="asset" src="{SHEETS}/sprite-{n:02d}-{kind}.png" '
                f'style="width:{s["widthPixels"]*2}px"><div class="cap">'
                f'<b>{n} {kind}</b>{s["widthPixels"]}x{s["height"]}<br>{name}</div></div>'
            )
    parts.append(
        f'<section id="sprites"><h2>Sprite frames</h2>'
        f'<p class="sub">{sprites["count"]} sprites &middot; <code>sprites</code> at '
        f'{sprites["_addr"]} &middot; bitmap and mask shown separately (the reference '
        f'build\'s composites use a shared "worst case" mask)</p>'
        f'<div class="grid">{"".join(cells)}</div></section>'
    )

    # --- rooms -------------------------------------------------------------
    rows = []
    for r in rooms["rooms"]:
        d = rooms["roomdefs"][r["roomdefIndex"]]
        notes = []
        if r["unused"]:
            notes.append('<span class="badge">unused</span>')
        if r["aliasOf"]:
            notes.append(f'alias of room {r["aliasOf"]}')
        rows.append(
            f'<div class="cell" style="min-width:180px;align-items:flex-start">'
            f'<div class="cap" style="max-width:none;text-align:left">'
            f'<b>Room {r["room"]}</b>{d["addr"]} &middot; '
            f'{len(d["objects"])} objs, {len(d["bounds"])} bounds, '
            f'{len(d["masks"])} masks<br>{" ".join(notes)}</div></div>'
        )
    parts.append(
        f'<section id="rooms"><h2>Rooms</h2>'
        f'<p class="sub">{len(rooms["rooms"])} rooms backed by '
        f'{len(rooms["roomdefs"])} distinct definitions &middot; '
        f'<code>rooms_and_tunnels</code> is 1-based</p>'
        f'<div class="grid">{"".join(rows)}</div></section>'
    )

    nav = "".join(
        f'<a href="#{i}">{t}</a>' for i, t in (
            ("tiles-exterior", "exterior tiles"), ("tiles-interior", "interior tiles"),
            ("tiles-mask", "mask tiles"), ("tiles-static", "static tiles"),
            ("supertiles", "supertiles"), ("map", "map"), ("objects", "objects"),
            ("masks", "masks"), ("sprites", "sprites"), ("rooms", "rooms"),
        )
    )

    html = (
        '<!doctype html><html lang="en"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1">'
        "<title>The Great Escape - asset viewer</title>"
        f"<style>{CSS}</style></head><body>"
        "<header><h1>The Great Escape &mdash; extracted assets</h1>"
        "<p>Decoded from <code>TheGreatEscape.skool</code>. Every asset is labelled "
        "with its <code>@label</code> and <code>$address</code>.</p>"
        f"<nav>{nav}</nav></header>"
        + "".join(parts)
        + "</body></html>"
    )

    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / "index.html"
    path.write_text(html, encoding="utf-8")
    return path


if __name__ == "__main__":
    p = build()
    print(f"wrote {p.relative_to(ROOT)} ({p.stat().st_size:,} bytes)")
