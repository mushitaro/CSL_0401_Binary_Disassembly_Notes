"""Parse the TunerPro XDF definition and decode every parameter from the binary.

Produces ``params.json``: one record per calibration item (constant, 2-D curve
or 3-D map) carrying its address, layout, scaling, categories and — where the
item has embedded data — the actual values decoded from the flash image in
engineering units.

Layout notes established by inspecting ``CSL_0401_Karter16_v3_6_publish.xdf``:

* ``<DEFAULTS lsbfirst="0">`` and the MC68336 core mean every element is
  **big-endian**.
* ``mmedtypeflags="0x01"`` marks an element **signed** (308 of 3,670).
* ``mmedelementsizebits`` is 8, 16 or (once) 32.
* ``mmedmajorstridebits`` is the bit distance between consecutive elements;
  ``0`` means "packed", which is how the z planes of every 3-D map are stored.
* 482 axes carry ``mmedmajorstridebits="-32"`` and **no** ``mmedaddress``.
  Those are enumerated label axes (the DTC tables), whose column names live in
  ``<LABEL index=".." value=".."/>`` children rather than in the flash.
* ``<CATEGORY index="0x9">`` in the header is **hex**, while
  ``<CATEGORYMEM category="10">`` is **decimal and one greater**.  Verified
  against KF_RG_M (11, 81 -> 0xA "CSL Specific", 0x50 "Restgas") and
  k_ask_flap_driver_energised_cycles_threshold (78 -> 0x4D "Ansaugklappe").
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from xdfmath import MathError, compile_equation

# The XDF's 64 KB region covers BOTH processors, split down the middle:
#
#   XDF 0x0000-0x7FFF  ->  Slave  calibration
#   XDF 0x8000-0xFFFF  ->  Master calibration
#
# Established from cfg_m.baureihe at XDF 0x8006 and cfg_s.baureihe at XDF
# 0x0006 - the same field 0x8000 apart - and then confirmed against the image:
# of the 219 slave-range x axes with four or more points, 219 decode to a
# monotonic ladder at file offset A+0x88000 and only 3 do at A or A+0x80000.
#
# In the 1 MB flash the Slave image starts at 0x80000 and its own parameter
# space sits at 0x8000 within it, i.e. file offset 0x88000 - which is exactly
# the range Ghidra's Master program labels "Mapped Parameter Space".
CAL_LIMIT = 0x10000
SLAVE_LIMIT = 0x8000
SLAVE_FILE_BASE = 0x88000

# Inside both Ghidra programs the calibration data is annotated in the
# "Mapped Parameter Space" block at 0x88000-0x8FFFF - where the MC68336 chip
# selects present it at run time - and NOT in the raw "Parameter Space" image
# at 0x8000-0xFFFF, which karter16 left unannotated.  Derived by matching XDF
# titles to Ghidra symbols: 863 master matches sit at XDF+0x80000 and 791 slave
# matches at XDF+0x88000, i.e. 0x88000 + (address mod 0x8000) in both cases.
# Using the raw XDF address instead drops reference coverage from 88.7% to 0.6%.
MAPPED_CAL_BASE = 0x88000

# A further 482 name matches land two bytes lower than that (0x7FFFE / 0x87FFE).
# Curve and map blocks begin with a two-byte header: karter16's symbol marks the
# header while the XDF's first axis starts just after it.  The same offset shows
# up in the six items whose <description> quotes an address two bytes below
# their first axis.
BLOCK_HEADER_BYTES = 2


def bank_of(address: int) -> str:
    """Which processor a raw XDF address belongs to."""
    return "slave" if address < SLAVE_LIMIT else "master"


def file_offset(address: int) -> int:
    """Byte offset of an XDF address inside ``Full ...TERRA.bin``."""
    return address + SLAVE_FILE_BASE if address < SLAVE_LIMIT else address


def program_address(address: int) -> int:
    """Address of an XDF item inside its own Ghidra program."""
    return MAPPED_CAL_BASE + (address % SLAVE_LIMIT)

# "<MNEMONIC> <HEXADDR>" is the first line of nearly every <description>.
DESC_HEAD = re.compile(r"^\s*(\S+)\s+([0-9A-Fa-f]{2,6})\s*$")


@dataclass
class Axis:
    axis_id: str
    address: int | None
    element_bits: int
    stride_bits: int
    signed: bool
    rows: int | None
    cols: int | None
    count: int | None
    units: str | None
    equation: str
    labels: list[str] = field(default_factory=list)
    link_ids: list[str] = field(default_factory=list)
    values: Any = None
    decode_error: str | None = None


@dataclass
class Item:
    unique_id: str
    kind: str  # "constant" | "curve" | "map"
    name: str
    description: str
    address: int | None
    categories: list[int]
    confidence: str
    axes: dict[str, Axis]
    units: str | None = None
    equation: str | None = None
    element_bits: int | None = None
    signed: bool = False
    value: Any = None
    raw: int | None = None
    data_address: int | None = None
    desc_address: int | None = None
    link_ids: list[str] = field(default_factory=list)
    decode_error: str | None = None
    desc_addr_mismatch: str | None = None


def _int_attr(el: ET.Element | None, name: str) -> int | None:
    if el is None:
        return None
    raw = el.get(name)
    if raw is None:
        return None
    return int(raw, 0)


def _text(el: ET.Element | None, tag: str) -> str | None:
    if el is None:
        return None
    child = el.find(tag)
    return None if child is None or child.text is None else child.text.strip()


def _math_of(el: ET.Element) -> tuple[str, list[str]]:
    math_el = el.find("MATH")
    if math_el is None:
        return "X", []
    links = [
        v.get("linkid")
        for v in math_el.iter("VAR")
        if v.get("type") == "link" and v.get("linkid")
    ]
    return math_el.get("equation") or "X", [x for x in links if x]


def _parse_axis(ax: ET.Element) -> Axis:
    ed = ax.find("EMBEDDEDDATA")
    equation, links = _math_of(ax)
    element_bits = _int_attr(ed, "mmedelementsizebits") or 16
    stride = _int_attr(ed, "mmedmajorstridebits")
    type_flags = _int_attr(ed, "mmedtypeflags") or 0
    count_text = _text(ax, "indexcount")
    return Axis(
        axis_id=ax.get("id") or "?",
        address=_int_attr(ed, "mmedaddress"),
        element_bits=element_bits,
        # stride 0 means packed; a negative stride marks a label-only axis.
        stride_bits=element_bits if not stride or stride < 0 else stride,
        signed=bool(type_flags & 0x01),
        rows=_int_attr(ed, "mmedrowcount"),
        cols=_int_attr(ed, "mmedcolcount"),
        count=int(count_text) if count_text and count_text.isdigit() else None,
        units=_text(ax, "units"),
        equation=equation,
        labels=[lb.get("value") or "" for lb in ax.findall("LABEL")],
        link_ids=links,
    )


def parse(xdf_path: Path) -> tuple[dict[int, dict], list[Item], dict]:
    root = ET.parse(xdf_path).getroot()
    header = root.find("XDFHEADER")
    if header is None:
        raise SystemExit(f"{xdf_path}: no XDFHEADER")

    categories: dict[int, dict] = {}
    for cat in header.findall("CATEGORY"):
        idx = int(cat.get("index"), 16)
        name = cat.get("name") or ""
        # Names read "German (English)"; keep both halves separately.
        m = re.match(r"^(.*?)\s*\(([^()]*)\)\s*$", name)
        categories[idx] = {
            "id": idx,
            "de": (m.group(1) if m else name).strip(),
            "en": (m.group(2) if m else name).strip(),
            "raw": name,
        }

    meta = {
        "title": _text(header, "deftitle"),
        "author": _text(header, "author"),
        "fileversion": _text(header, "fileversion"),
        "xdfformat": root.get("version"),
        "baseoffset": _int_attr(header.find("BASEOFFSET"), "offset") or 0,
    }

    items: list[Item] = []
    for el in root:
        if el.tag == "XDFHEADER":
            continue
        kind = {
            "XDFCONSTANT": "constant",
            "XDFFUNCTION": "curve",
            "XDFTABLE": "map",
        }.get(el.tag)
        if kind is None:
            continue

        name = _text(el, "title") or f"unnamed_{el.get('uniqueid')}"
        description = _text(el, "description") or ""
        # CATEGORYMEM is decimal and one greater than the hex CATEGORY index.
        cats = sorted(
            {
                int(cm.get("category")) - 1
                for cm in el.findall("CATEGORYMEM")
                if cm.get("category") is not None
            }
        )

        axes = {}
        for ax in el.findall("XDFAXIS"):
            parsed = _parse_axis(ax)
            axes[parsed.axis_id] = parsed

        item = Item(
            unique_id=el.get("uniqueid") or "",
            kind=kind,
            name=name,
            description=description,
            address=None,
            categories=cats,
            # Karter16 lowercases names he derived himself from disassembly;
            # uppercase names come from a documented source.
            confidence="documented" if name[:1].isupper() else "derived",
            axes=axes,
        )

        if kind == "constant":
            ed = el.find("EMBEDDEDDATA")
            equation, links = _math_of(el)
            type_flags = _int_attr(ed, "mmedtypeflags") or 0
            item.address = _int_attr(ed, "mmedaddress")
            item.data_address = item.address
            item.element_bits = _int_attr(ed, "mmedelementsizebits") or 16
            item.signed = bool(type_flags & 0x01)
            item.units = _text(el, "units")
            item.equation = equation
            item.link_ids = links
        else:
            # Two different addresses matter for a table/curve:
            #   - the identity address is the lowest of all its axes, which is
            #     where the block starts and what the <description> and the
            #     Ghidra symbol both refer to;
            #   - the data address is the plane holding the values (z for a
            #     map, y for a curve), which is what gets decoded.
            addrs = [a.address for a in axes.values() if a.address is not None]
            item.address = min(addrs) if addrs else None
            primary = axes.get("z") or axes.get("y")
            item.data_address = primary.address if primary else None
            item.units = primary.units if primary else None

        # Cross-check the "<NAME> <ADDR>" convention in the description.
        #
        # Which address that line quotes is not consistent across the file:
        # KF_RG_M and kl_rg_abgasdruck_ml quote their x axis, while KL_EDK_VORST
        # and KL_MD_MAX_MD_LA quote their y (data) axis.  Rather than pick one
        # convention and generate hundreds of false alarms, the stated address
        # is accepted when it matches *any* address the item owns, and flagged
        # only when it matches none - which is a real definition error.
        first_line = description.splitlines()[0] if description else ""
        m = DESC_HEAD.match(first_line)
        if m:
            try:
                stated = int(m.group(2), 16)
            except ValueError:
                stated = None
            owned = {a.address for a in axes.values() if a.address is not None}
            if item.address is not None:
                owned.add(item.address)
            if item.data_address is not None:
                owned.add(item.data_address)
            item.desc_address = stated
            if stated is not None and owned and stated not in owned:
                shown = ", ".join(f"{a:04X}" for a in sorted(owned))
                item.desc_addr_mismatch = f"desc says {stated:04X}, item owns {shown}"

        items.append(item)

    return categories, items, meta


# --------------------------------------------------------------------------- #
# decoding
# --------------------------------------------------------------------------- #


def _read_scalar(blob: bytes, offset: int, bits: int, signed: bool) -> int:
    nbytes = bits // 8
    if offset < 0 or offset + nbytes > len(blob):
        raise IndexError(f"offset 0x{offset:X}+{nbytes} outside image")
    return int.from_bytes(blob[offset : offset + nbytes], "big", signed=signed)


def _decode_series(blob: bytes, axis: Axis, count: int) -> list[int]:
    step = max(axis.stride_bits, axis.element_bits) // 8
    base = file_offset(axis.address)
    return [
        _read_scalar(blob, base + i * step, axis.element_bits, axis.signed)
        for i in range(count)
    ]


def decode(items: list[Item], blob: bytes, link_values: dict[str, float]) -> None:
    """Fill in ``values`` on every item and axis that has embedded data."""
    for item in items:
        if item.kind == "constant":
            if item.data_address is None:
                item.decode_error = "no address"
                continue
            try:
                raw = _read_scalar(
                    blob,
                    file_offset(item.data_address),
                    item.element_bits or 16,
                    item.signed,
                )
            except IndexError as exc:
                item.decode_error = str(exc)
                continue
            item.raw = raw
            try:
                item.value = _scale(item.equation or "X", raw, item.link_env(link_values))
            except MathError as exc:
                # Keep the raw integer: the scaling is undefined for this value
                # (e.g. "5.12/x" at x == 0) but the stored byte is still real.
                item.decode_error = str(exc)
            continue

        for axis in item.axes.values():
            if axis.address is None:
                # Enumerated label axis (DTC tables) - nothing to read.
                continue
            try:
                if axis.rows and axis.cols:
                    flat = _decode_series(blob, axis, axis.rows * axis.cols)
                    scaled = [
                        _scale(axis.equation, v, item.link_env(link_values)) for v in flat
                    ]
                    axis.values = [
                        scaled[r * axis.cols : (r + 1) * axis.cols] for r in range(axis.rows)
                    ]
                else:
                    n = axis.count or axis.cols or 0
                    if not n:
                        continue
                    axis.values = [
                        _scale(axis.equation, v, item.link_env(link_values))
                        for v in _decode_series(blob, axis, n)
                    ]
            except (IndexError, MathError) as exc:
                axis.decode_error = str(exc)


def _scale(equation: str, raw: int, links: dict[str, float]) -> float:
    env = {"x": float(raw), "X": float(raw)}
    env.update(links)
    value = compile_equation(equation)(env)
    # Keep the payload small and readable; the raw integer is recoverable.
    return round(value, 6)


def _item_link_env(self: Item, link_values: dict[str, float]) -> dict[str, float]:
    """Bind ``k``/``K`` for the two equations that reference another item.

    ``<VAR type="link" linkid="0x5EC3"/>`` names an XDF item by uniqueid; the
    bound name is whatever ``id`` the VAR carries, which in this file is only
    ever ``k`` or ``K``.
    """
    env: dict[str, float] = {}
    ids = list(self.link_ids)
    for axis in self.axes.values():
        ids.extend(axis.link_ids)
    for link_id in ids:
        if link_id in link_values:
            env["k"] = link_values[link_id]
            env["K"] = link_values[link_id]
    return env


Item.link_env = _item_link_env  # type: ignore[attr-defined]


def build_link_values(items: list[Item], blob: bytes) -> dict[str, float]:
    """Pre-decode plain constants so ``VAR type="link"`` equations can resolve.

    Only link-free constants are decoded here, which is enough: both linked
    equations in this XDF point at ordinary scalars (k_rf_diag_f_zaehler and
    K_RG_R).
    """
    out: dict[str, float] = {}
    for item in items:
        if item.kind != "constant" or item.data_address is None or item.link_ids:
            continue
        try:
            raw = _read_scalar(
                blob,
                file_offset(item.data_address),
                item.element_bits or 16,
                item.signed,
            )
            out[item.unique_id] = _scale(item.equation or "X", raw, {})
        except (IndexError, MathError):
            continue
    return out


# --------------------------------------------------------------------------- #


def to_json(categories, items: list[Item], meta) -> dict:
    def axis_json(a: Axis) -> dict:
        d: dict[str, Any] = {
            "id": a.axis_id,
            "bits": a.element_bits,
            "signed": a.signed,
        }
        if a.address is not None:
            d["addr"] = a.address
        if a.units:
            d["units"] = a.units
        if a.equation:
            d["math"] = a.equation
        if a.rows:
            d["rows"] = a.rows
        if a.cols:
            d["cols"] = a.cols
        if a.count:
            d["n"] = a.count
        if a.labels:
            d["labels"] = a.labels
        if a.values is not None:
            d["values"] = a.values
        if a.decode_error:
            d["error"] = a.decode_error
        return d

    out_items = []
    for it in items:
        d: dict[str, Any] = {
            "uid": it.unique_id,
            "kind": it.kind,
            "name": it.name,
            "conf": it.confidence,
            "cats": it.categories,
        }
        if it.address is not None:
            d["addr"] = it.address
            d["bank"] = bank_of(it.address)
            d["progAddr"] = program_address(it.address)
            d["fileOff"] = file_offset(it.address)
        if it.data_address is not None and it.data_address != it.address:
            d["dataAddr"] = it.data_address
        if it.raw is not None:
            d["raw"] = it.raw
        if it.desc_address is not None:
            d["descAddr"] = it.desc_address
        if it.description:
            d["desc"] = it.description
        if it.units:
            d["units"] = it.units
        if it.equation:
            d["math"] = it.equation
        if it.element_bits:
            d["bits"] = it.element_bits
        if it.signed:
            d["signed"] = True
        if it.value is not None:
            d["value"] = it.value
        if it.axes:
            d["axes"] = {k: axis_json(v) for k, v in it.axes.items()}
        if it.decode_error:
            d["error"] = it.decode_error
        if it.desc_addr_mismatch:
            d["descAddrMismatch"] = it.desc_addr_mismatch
        out_items.append(d)

    return {
        "meta": meta,
        "categories": [categories[k] for k in sorted(categories)],
        "params": out_items,
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    repo = Path(__file__).resolve().parents[2]
    ap.add_argument("--xdf", type=Path,
                    default=repo / "XDF" / "CSL_0401_Karter16_v3_6_publish.xdf")
    ap.add_argument("--bin", type=Path,
                    default=repo / "Full 211323000401PD31_TERRA.bin")
    ap.add_argument("--out", type=Path, default=repo / "build" / "params.json")
    args = ap.parse_args(argv)

    categories, items, meta = parse(args.xdf)
    blob = args.bin.read_bytes()
    meta["binSize"] = len(blob)

    link_values = build_link_values(items, blob)
    decode(items, blob, link_values)

    counts: dict[str, int] = {}
    for it in items:
        counts[it.kind] = counts.get(it.kind, 0) + 1
    errors = [it for it in items if it.decode_error]
    mismatches = [it for it in items if it.desc_addr_mismatch]
    axis_errors = sum(1 for it in items for a in it.axes.values() if a.decode_error)

    meta["counts"] = counts
    meta["categoryCount"] = len(categories)

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(to_json(categories, items, meta), ensure_ascii=False))

    banks: dict[str, int] = {}
    for it in items:
        if it.address is not None:
            banks[bank_of(it.address)] = banks.get(bank_of(it.address), 0) + 1
    meta["banks"] = banks

    print(f"categories        : {len(categories)}")
    print(f"bank split        : {banks}")
    for k in sorted(counts):
        print(f"{k:18s}: {counts[k]}")
    print(f"{'total':18s}: {len(items)}")
    print(f"decode errors     : {len(errors)} items, {axis_errors} axes")
    for it in errors[:10]:
        print(f"    {it.name}: {it.decode_error}")
    print(f"desc/addr mismatch: {len(mismatches)}")
    for it in mismatches[:10]:
        print(f"    {it.name}: {it.desc_addr_mismatch}")
    print(f"wrote {args.out} ({args.out.stat().st_size/1e6:.1f} MB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
