"""CLI: python -m tools.extract [build|check|verify]

  build   parse the .skool, emit data/*.json and data/sheets/*.png
  check   re-run into a temp dir and diff against the committed data/
          (BUILD_PROMPT.md §3's no-diff CI gate; exits non-zero on any diff)
  verify  parse and cross-assert against the pristine snapshot only
"""

from __future__ import annotations

import argparse
import filecmp
import sys
import tempfile
from pathlib import Path

from .emit import write_json, write_sheets
from .skoolparse import parse, verify_against_snapshot
from .tables import EXTRACTORS

ROOT = Path(__file__).resolve().parents[2]
SKOOL = ROOT / "The-Great-Escape" / "TheGreatEscape.skool"
SNAPSHOT = ROOT / "The-Great-Escape" / "build" / "TheGreatEscape.pristine.z80"
DATA = ROOT / "data"


def build(outdir: Path, sheets: bool = True) -> None:
    sk = parse(SKOOL)
    n = verify_against_snapshot(sk, SNAPSHOT)
    print(f"parsed {len(sk.label_to_addr)} labels, {len(sk.blocks)} blocks; "
          f"{n} bytes cross-checked against the pristine snapshot")

    for name, fn in EXTRACTORS.items():
        write_json(outdir / f"{name}.json", fn(sk))
    print(f"wrote {len(EXTRACTORS)} json files to {outdir}")

    if sheets:
        written = write_sheets(sk, outdir / "sheets")
        print(f"wrote {len(written)} png sheets to {outdir / 'sheets'}")


def check() -> int:
    if not DATA.exists():
        print(f"no committed data at {DATA}; run `build` first", file=sys.stderr)
        return 1
    with tempfile.TemporaryDirectory() as tmp:
        tmpdir = Path(tmp)
        build(tmpdir)
        diffs = _diff_tree(DATA, tmpdir)
    if diffs:
        print(f"\nEXTRACTION IS NOT REPRODUCIBLE -- {len(diffs)} file(s) differ:",
              file=sys.stderr)
        for d in sorted(diffs)[:20]:
            print(f"  {d}", file=sys.stderr)
        return 1
    print("\ncheck: committed data/ matches a fresh extraction exactly")
    return 0


def _diff_tree(a: Path, b: Path) -> list[str]:
    diffs: list[str] = []
    names = {p.relative_to(a) for p in a.rglob("*") if p.is_file()}
    names |= {p.relative_to(b) for p in b.rglob("*") if p.is_file()}
    for rel in names:
        pa, pb = a / rel, b / rel
        if not pa.exists():
            diffs.append(f"only in fresh extraction: {rel}")
        elif not pb.exists():
            diffs.append(f"only in committed data:  {rel}")
        elif not filecmp.cmp(pa, pb, shallow=False):
            diffs.append(f"differs: {rel}")
    return diffs


def main() -> int:
    ap = argparse.ArgumentParser(prog="tools.extract")
    ap.add_argument("command", choices=["build", "check", "verify"],
                    nargs="?", default="build")
    ap.add_argument("--out", type=Path, default=DATA)
    ap.add_argument("--no-sheets", action="store_true")
    args = ap.parse_args()

    if args.command == "verify":
        sk = parse(SKOOL)
        n = verify_against_snapshot(sk, SNAPSHOT)
        print(f"OK: {n} bytes match the pristine snapshot")
        return 0
    if args.command == "check":
        return check()
    build(args.out, sheets=not args.no_sheets)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
