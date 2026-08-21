#!/usr/bin/env python3
"""Decode every XDF parameter out of two calibration images and report what differs.

Why this exists
---------------
``q.py`` answers "what is this parameter, and who reads it" against ONE image —
the 0401 CSL reference the graph was built from. The moment a second calibration
turns up (a standard M3 read off a car, a tuned file, a Community Patch
derivative) the interesting question changes shape: not "what is K_SMG_I_HA" but
"where do these two calibrations disagree, and does the disagreement matter".

That question is only answerable parameter-by-parameter. A byte diff of two
64 KB images returns a few thousand offsets and no meaning: it cannot tell a
16-bit torque limit from one byte of an axis it shares a word with, and it says
nothing at all about the ~40% of the address space that no XDF parameter covers.
This walks the 2,529 XDF definitions instead, decodes each one from both images
with its own layout and scaling, and reports differences in engineering units.

Image formats, and the offset rule
----------------------------------
Two shapes are accepted and auto-detected by size:

* **64 KB partial** — what the DS2 tool reads off a car, and what the web tuner
  stores in a session. This IS the XDF's own address space: offset = address,
  slave below 0x8000, master at or above it.
* **1 MB full** — a complete flash image. Here the bank must travel with the
  address: master at ``addr``, slave at ``0x88000 + addr``. See
  ``tools/pipeline/parse_xdf.py`` for how that was established.

A 1 MB image is folded into the 64 KB view on load, so both sides of a
comparison are always the same shape and one decoder serves both.

Usage
-----
    xdf_diff.py A.bin B.bin [--cat REGEX] [--name REGEX] [--full] [--json OUT]
    xdf_diff.py A.bin B.bin --summary          # differing count per category
    xdf_diff.py --dump A.bin --name REGEX      # decode one image, no comparison
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "pipeline"))
from xdfmath import compile_equation, MathError          # noqa: E402

CAL_LIMIT = 0x10000
SLAVE_LIMIT = 0x8000
SLAVE_FILE_BASE = 0x88000
FULL_IMAGE = 0x100000


def find_graph() -> str:
    for i, a in enumerate(sys.argv):
        if a == "--graph" and i + 1 < len(sys.argv):
            return sys.argv[i + 1]
    if os.environ.get("MSS54_GRAPH"):
        return os.environ["MSS54_GRAPH"]
    here = os.path.dirname(os.path.abspath(__file__))
    for up in range(1, 6):
        root = os.path.abspath(os.path.join(here, *([".."] * up)))
        cand = os.path.join(root, "app", "public", "data", "graph.json")
        if os.path.exists(cand):
            return cand
    sys.exit("graph.json not found — pass --graph PATH or set $MSS54_GRAPH")


def bank_of(p: dict) -> str:
    """The XDF's two ranges never overlap, so the address decides. Some nodes carry
    `bank` and some do not; deriving it keeps one rule instead of two."""
    return p.get("bank") or ("slave" if (p.get("addr") or 0) < SLAVE_LIMIT else "master")


def load_image(path: str) -> bytes:
    """Any accepted image, as a 64 KB XDF-space view.

    A full 1 MB flash is folded here rather than at every read site, because the
    bank rule is the single thing in this file most likely to be got wrong twice.
    """
    raw = open(path, "rb").read()
    if len(raw) == CAL_LIMIT:
        return raw
    if len(raw) == FULL_IMAGE:
        return raw[SLAVE_FILE_BASE:SLAVE_FILE_BASE + SLAVE_LIMIT] + raw[SLAVE_LIMIT:CAL_LIMIT]
    sys.exit(f"{path}: {len(raw)} bytes — expected a 64 KB partial or a 1 MB full image")


def read_int(img: bytes, addr: int, bits: int, signed: bool):
    """One big-endian element. `None` when it would run off the end of the image."""
    n = bits // 8
    if addr is None or addr < 0 or addr + n > CAL_LIMIT:
        return None
    return int.from_bytes(img[addr:addr + n], "big", signed=signed)


_EQ_CACHE: dict[str, object] = {}


def phys(math: str | None, raw):
    """Raw -> engineering units, with the XDF's own equation.

    The equation takes an environment, not a number: `x` and `X` are both bound
    because the file spells it either way. Two XDF equations also reference a
    second item through `<VAR type="link">` and bind it as `k`; those cannot be
    resolved from an address alone, so they fall back to the raw integer — which
    still compares correctly between two images, which is all this tool needs.
    """
    if raw is None:
        return None
    if not math:
        return float(raw)
    if math not in _EQ_CACHE:
        try:
            _EQ_CACHE[math] = compile_equation(math)
        except MathError:
            _EQ_CACHE[math] = None
    fn = _EQ_CACHE[math]
    if fn is None:
        return float(raw)
    try:
        return round(float(fn({"x": float(raw), "X": float(raw)})), 6)
    except (MathError, ZeroDivisionError, ValueError, TypeError, KeyError):
        return float(raw)


def _elems(img, spec, count):
    """`count` consecutive elements described by an axis/table spec."""
    bits, signed, math = spec.get("bits", 8), bool(spec.get("signed")), spec.get("math")
    addr, step = spec.get("addr"), spec.get("bits", 8) // 8
    if addr is None:
        return None
    out = []
    for i in range(count):
        out.append(phys(math, read_int(img, addr + i * step, bits, signed)))
    return out


def decode(img: bytes, p: dict):
    """One parameter's value(s) out of one image.

    Returns a plain Python value for a constant and a nested list for a curve or
    map — the shape a caller can compare with `==` without knowing the kind.
    """
    kind = p.get("kind")
    if kind == "constant":
        return phys(p.get("math"), read_int(img, p.get("addr"), p.get("bits", 8), bool(p.get("signed"))))

    axes = p.get("axes") or {}
    if kind == "curve":
        x, y = axes.get("x") or {}, axes.get("y") or {}
        n = y.get("n") or y.get("cols") or x.get("n") or x.get("cols") or 0
        return {"x": _elems(img, x, x.get("n") or x.get("cols") or n), "y": _elems(img, y, n)}

    if kind == "map":
        x, y, z = axes.get("x") or {}, axes.get("y") or {}, axes.get("z") or {}
        cols = z.get("cols") or x.get("n") or 0
        rows = z.get("rows") or y.get("n") or 0
        flat = _elems(img, z, rows * cols) or []
        grid = [flat[r * cols:(r + 1) * cols] for r in range(rows)]
        return {"x": _elems(img, x, x.get("n") or cols),
                "y": _elems(img, y, y.get("n") or rows),
                "z": grid}
    return None


def fmt(v, limit=14):
    """Compact enough to scan a few hundred rows without wrapping."""
    if v is None:
        return "-"
    if isinstance(v, float):
        return f"{v:g}"
    if isinstance(v, dict):
        parts = []
        for k in ("x", "y", "z"):
            if k in v and v[k] is not None:
                parts.append(f"{k}=" + fmt(v[k], limit))
        return " ".join(parts)
    if isinstance(v, list):
        if v and isinstance(v[0], list):
            return "[" + "; ".join(fmt(r, limit) for r in v[:4]) + ("; …]" if len(v) > 4 else "]")
        shown = ", ".join(fmt(e) for e in v[:limit])
        return "[" + shown + (", …]" if len(v) > limit else "]")
    return str(v)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("images", nargs="+", help="A.bin B.bin — or one image with --dump")
    ap.add_argument("--dump", action="store_true", help="decode one image instead of comparing two")
    ap.add_argument("--cat", help="only categories whose English or German name matches this regex")
    ap.add_argument("--name", help="only parameters whose name matches this regex")
    ap.add_argument("--summary", action="store_true", help="differing-parameter count per category")
    ap.add_argument("--full", action="store_true", help="print whole tables, not a first slice")
    ap.add_argument("--json", help="write the differences as JSON")
    ap.add_argument("--graph", help="path to graph.json")
    args = ap.parse_args()

    D = json.load(open(find_graph(), encoding="utf-8"))
    cats = {c["id"]: c for c in D["categories"] if isinstance(c, dict) and "id" in c}
    params = [n for n in D["nodes"] if n.get("t") == "param"]

    if args.cat:
        rx = re.compile(args.cat, re.I)
        keep = {i for i, c in cats.items() if rx.search(c.get("en") or "") or rx.search(c.get("de") or "")}
        params = [p for p in params if keep & set(p.get("cats") or [])]
    if args.name:
        rx = re.compile(args.name, re.I)
        params = [p for p in params if rx.search(p["name"])]
    params.sort(key=lambda p: (p.get("addr") if p.get("addr") is not None else 0))

    if args.dump:
        img = load_image(args.images[0])
        for p in params:
            v = decode(img, p)
            print(f"{p['name']:<44} {bank_of(p):<6} 0x{p['addr']:04X}  {fmt(v, 999 if args.full else 14)}")
        print(f"\n{len(params)} parameter(s)")
        return

    if len(args.images) < 2:
        sys.exit("two images are needed to compare — or pass --dump for one")
    a, b = load_image(args.images[0]), load_image(args.images[1])
    na, nb = (os.path.basename(x) for x in args.images[:2])

    diffs, same, per_cat = [], 0, {}
    for p in params:
        va, vb = decode(a, p), decode(b, p)
        if va == vb:
            same += 1
            continue
        diffs.append({"name": p["name"], "kind": p["kind"], "addr": p["addr"], "bank": bank_of(p),
                      "units": p.get("units"), "math": p.get("math"),
                      "cats": [cats.get(c, {}).get("en", str(c)) for c in (p.get("cats") or [])],
                      "a": va, "b": vb})
        for c in (p.get("cats") or []):
            per_cat[c] = per_cat.get(c, 0) + 1

    if args.summary:
        print(f"{na}  vs  {nb}\n{len(diffs)} differing / {len(diffs) + same} compared\n")
        print(f"{'category':<42} {'differ':>6} {'total':>6}")
        totals = {}
        for p in params:
            for c in (p.get("cats") or []):
                totals[c] = totals.get(c, 0) + 1
        for c, n in sorted(per_cat.items(), key=lambda kv: -kv[1]):
            info = cats.get(c, {})
            print(f"{(info.get('en') or str(c))[:42]:<42} {n:>6} {totals.get(c, 0):>6}")
    else:
        print(f"{na}  vs  {nb}\n{len(diffs)} differing / {len(diffs) + same} compared\n")
        width = 999 if args.full else 14
        for d in diffs:
            print(f"{d['name']}  [{d['kind']}] {d['bank']} 0x{d['addr']:04X}"
                  f"{'  ' + d['units'] if d['units'] else ''}  {'/'.join(d['cats'])}")
            print(f"    A {fmt(d['a'], width)}")
            print(f"    B {fmt(d['b'], width)}")

    if args.json:
        json.dump({"a": na, "b": nb, "diffs": diffs}, open(args.json, "w", encoding="utf-8"),
                  ensure_ascii=False, indent=1)
        print(f"\n-> {args.json}", file=sys.stderr)


if __name__ == "__main__":
    main()
