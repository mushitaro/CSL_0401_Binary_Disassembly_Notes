"""Export functions, cross-references and symbols from the restored Ghidra project.

Run once; the viewer consumes the JSON and never needs Ghidra again.

    export GHIDRA_INSTALL_DIR=/path/to/ghidra_12.1.2_PUBLIC
    python tools/export/export_relations.py --decompile

Output (one file per program) lands in ``build/``:

    build/ghidra_master.json
    build/ghidra_slave.json

Two kinds of edge are produced, and they are kept apart on purpose:

``xref``
    A reference Ghidra's analysis actually resolved.  Trustworthy.
``scan``
    A synthesised edge: an instruction operand whose scalar value happens to
    equal a known calibration address.  Ghidra misses a lot of map accesses on
    this target because the CPU32 ``TBL`` instructions and pointer tables reach
    the data indirectly, so this fills gaps - but it is inference, and the
    viewer must present it as such.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections import defaultdict
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "tools" / "pipeline"))

DEFAULT_PROJECT_DIR = Path("/home/user/mss54-ghidra")
DEFAULT_PROJECT_NAME = "MSS54_Disassembly"

PROGRAMS = {
    "master": "0401 Master.bin",
    "slave": "0401 Slave.bin",
}

# Region classification, taken from the memory blocks karter16 defined.
#
# Note that "cal" is the *mapped* window at 0x88000-0x8FFFF, not the raw image
# at 0x8000-0xFFFF.  Every calibration symbol and practically every calibration
# reference lives in the mapped window; the raw image block carries only 18
# defined data items and 91 references in the master.
RAW_PARAM_START, RAW_PARAM_END = 0x8000, 0xFFFF     # "Parameter Space"
CODE_START, CODE_END = 0x10000, 0x7FFFF             # "Program Space"
CAL_START, CAL_END = 0x88000, 0x8FFFF               # "Mapped Parameter Space"
RAM_START = 0xFF0000                                # RAM / DPR / TPURAM / SRAM


def classify(addr: int) -> str:
    if CAL_START <= addr <= CAL_END:
        return "cal"
    if RAW_PARAM_START <= addr <= RAW_PARAM_END:
        return "rawcal"
    if CODE_START <= addr <= CODE_END:
        return "code"
    if addr >= RAM_START:
        return "ram"
    if addr < RAW_PARAM_START:
        return "boot"
    return "other"


def _comment(listing, addr, kind_name: str) -> str | None:
    """Read a comment across the Ghidra 11/12 API change.

    Ghidra 12 replaced the ``CodeUnit.PLATE_COMMENT`` int constants with a
    ``CommentType`` enum; both spellings are tried so the exporter keeps
    working on either.
    """
    try:
        from ghidra.program.model.listing import CommentType  # type: ignore

        return listing.getComment(getattr(CommentType, kind_name), addr)
    except Exception:
        pass
    try:
        from ghidra.program.model.listing import CodeUnit  # type: ignore

        return listing.getComment(getattr(CodeUnit, f"{kind_name}_COMMENT"), addr)
    except Exception:
        return None


def export_program(program, bank: str, cal_addresses: set[int], decompile: bool) -> dict:
    from ghidra.program.model.symbol import SourceType  # type: ignore
    from ghidra.util.task import ConsoleTaskMonitor  # type: ignore

    listing = program.getListing()
    fm = program.getFunctionManager()
    ref_mgr = program.getReferenceManager()
    symtab = program.getSymbolTable()
    monitor = ConsoleTaskMonitor()

    # ---------------------------------------------------------------- blocks
    blocks = [
        {
            "name": b.getName(),
            "start": int(b.getStart().getOffset()),
            "end": int(b.getEnd().getOffset()),
            "r": bool(b.isRead()),
            "w": bool(b.isWrite()),
            "x": bool(b.isExecute()),
            "init": bool(b.isInitialized()),
        }
        for b in program.getMemory().getBlocks()
    ]

    # ------------------------------------------------------------- functions
    functions = {}
    for f in fm.getFunctions(True):
        entry = int(f.getEntryPoint().getOffset())
        name = str(f.getName())
        functions[entry] = {
            "addr": entry,
            "name": name,
            "named": not name.startswith(("FUN_", "thunk_FUN_")),
            "size": int(f.getBody().getNumAddresses()),
            "thunk": bool(f.isThunk()),
        }
        plate = f.getComment()
        if plate:
            functions[entry]["plate"] = str(plate).strip()

    def owner_of(addr_obj):
        f = fm.getFunctionContaining(addr_obj)
        return int(f.getEntryPoint().getOffset()) if f is not None else None

    # ------------------------------------------------------------- symbols
    symbols = []
    for s in symtab.getAllSymbols(True):
        if s.isExternal() or s.isDynamic():
            continue
        addr = s.getAddress()
        if addr is None or not addr.isMemoryAddress():
            continue
        off = int(addr.getOffset())
        symbols.append(
            {
                "addr": off,
                "name": str(s.getName()),
                "region": classify(off),
                "type": str(s.getSymbolType()),
                "primary": bool(s.isPrimary()),
                "user": s.getSource() == SourceType.USER_DEFINED,
            }
        )

    # ----------------------------------------------------------- defined data
    data_items = []
    d = listing.getDefinedData(True)
    while d.hasNext():
        item = d.next()
        addr = int(item.getAddress().getOffset())
        dt = item.getDataType()
        data_items.append(
            {
                "addr": addr,
                "region": classify(addr),
                "type": str(dt.getName()) if dt is not None else None,
                "len": int(item.getLength()),
                "label": str(item.getLabel()) if item.getLabel() else None,
            }
        )

    # ---------------------------------------------------------------- edges
    edges: list[dict] = []
    seen: set[tuple] = set()

    def add(src: int | None, dst: int, kind: str, origin: str) -> None:
        if src is None:
            return
        key = (src, dst, kind, origin)
        if key in seen:
            return
        seen.add(key)
        edges.append({"s": src, "d": dst, "k": kind, "o": origin})

    src_iter = ref_mgr.getReferenceSourceIterator(program.getMemory(), True)
    while src_iter.hasNext():
        from_addr = src_iter.next()
        owner = owner_of(from_addr)
        if owner is None:
            continue
        for ref in ref_mgr.getReferencesFrom(from_addr):
            to = ref.getToAddress()
            if to is None or not to.isMemoryAddress():
                continue
            dst = int(to.getOffset())
            rt = ref.getReferenceType()
            if rt.isCall():
                # Point calls at the function entry, not the raw target.
                add(owner, dst, "call", "xref")
            elif rt.isWrite():
                add(owner, dst, "write", "xref")
            elif rt.isRead() or rt.isData():
                add(owner, dst, "read", "xref")
            elif rt.isJump():
                # Intra-function jumps are noise; only record jumps that leave.
                if dst in functions and dst != owner:
                    add(owner, dst, "call", "xref")

    xref_edge_count = len(edges)

    # ------------------------------------------- supplementary operand scan
    #
    # Ghidra resolves a reference only when it can prove the target.  Map reads
    # that go through a pointer table or the CPU32 TBL instructions leave no
    # reference behind, so every instruction operand is also checked against
    # the set of addresses the XDF says are calibration data.
    scan_hits = 0
    if cal_addresses:
        from ghidra.program.model.scalar import Scalar  # type: ignore

        instructions = listing.getInstructions(True)
        while instructions.hasNext():
            instr = instructions.next()
            owner = owner_of(instr.getAddress())
            if owner is None:
                continue
            for op_index in range(instr.getNumOperands()):
                for obj in instr.getOpObjects(op_index):
                    value = None
                    if isinstance(obj, Scalar):
                        value = int(obj.getUnsignedValue())
                    else:
                        try:
                            value = int(obj.getOffset())
                        except Exception:
                            continue
                    if value in cal_addresses:
                        before = len(seen)
                        add(owner, value, "read", "scan")
                        if len(seen) != before:
                            scan_hits += 1

    # ------------------------------------------------------------ decompile
    decompiled: dict[str, str] = {}
    if decompile:
        from ghidra.app.decompiler import DecompInterface  # type: ignore

        iface = DecompInterface()
        iface.openProgram(program)
        try:
            targets = [f for f in fm.getFunctions(True)
                       if not str(f.getName()).startswith("FUN_")]
            for i, f in enumerate(targets, 1):
                res = iface.decompileFunction(f, 60, monitor)
                if res is not None and res.decompileCompleted():
                    code = res.getDecompiledFunction().getC()
                    decompiled[f"{int(f.getEntryPoint().getOffset()):06x}"] = str(code)
                if i % 50 == 0:
                    print(f"      decompiled {i}/{len(targets)}", flush=True)
        finally:
            iface.dispose()

    return {
        "bank": bank,
        "program": str(program.getName()),
        "languageID": str(program.getLanguageID()),
        "imageBase": int(program.getImageBase().getOffset()),
        "createdWith": str(
            program.getOptions("Program Information").getString(
                "Created With Ghidra Version", "?"
            )
        ),
        "blocks": blocks,
        "functions": sorted(functions.values(), key=lambda x: x["addr"]),
        "symbols": symbols,
        "data": data_items,
        "edges": edges,
        "decompiled": decompiled,
        "stats": {
            "functions": len(functions),
            "namedFunctions": sum(1 for f in functions.values() if f["named"]),
            "symbols": len(symbols),
            "definedData": len(data_items),
            "xrefEdges": xref_edge_count,
            "scanEdges": scan_hits,
            "decompiled": len(decompiled),
        },
    }


def load_cal_addresses(params_path: Path) -> dict[str, set[int]]:
    """Program-space addresses of every XDF item, split by bank."""
    import parse_xdf  # noqa: PLC0415

    out: dict[str, set[int]] = {"master": set(), "slave": set()}
    if not params_path.exists():
        print(f"warning: {params_path} missing; the operand scan is disabled")
        return out
    data = json.loads(params_path.read_text())
    for p in data["params"]:
        addr = p.get("addr")
        if addr is None:
            continue
        bank = parse_xdf.bank_of(addr)
        for a in [addr] + [
            ax["addr"] for ax in (p.get("axes") or {}).values() if "addr" in ax
        ]:
            mapped = parse_xdf.program_address(a)
            out[bank].add(mapped)
            # Curve/map blocks start two bytes before their first axis.
            out[bank].add(mapped - parse_xdf.BLOCK_HEADER_BYTES)
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--project-dir", type=Path, default=DEFAULT_PROJECT_DIR)
    ap.add_argument("--project-name", default=DEFAULT_PROJECT_NAME)
    ap.add_argument("--params", type=Path, default=REPO / "build" / "params.json")
    ap.add_argument("--outdir", type=Path, default=REPO / "build")
    ap.add_argument("--decompile", action="store_true",
                    help="also emit decompiled C for human-named functions")
    args = ap.parse_args(argv)

    if not os.environ.get("GHIDRA_INSTALL_DIR"):
        return print("GHIDRA_INSTALL_DIR is not set") or 2

    cal = load_cal_addresses(args.params)
    print(f"calibration addresses: master={len(cal['master'])} slave={len(cal['slave'])}")

    import pyghidra

    pyghidra.start()
    from ghidra.base.project import GhidraProject  # type: ignore

    args.outdir.mkdir(parents=True, exist_ok=True)
    project = GhidraProject.openProject(str(args.project_dir), args.project_name, True)
    try:
        for bank, prog_name in PROGRAMS.items():
            print(f"== {prog_name}")
            program = project.openProgram("/", prog_name, False)
            try:
                result = export_program(program, bank, cal[bank], args.decompile)
            finally:
                project.close(program)

            out = args.outdir / f"ghidra_{bank}.json"
            out.write_text(json.dumps(result, ensure_ascii=False))
            for key, value in result["stats"].items():
                print(f"   {key:16s}: {value}")
            print(f"   wrote {out} ({out.stat().st_size/1e6:.1f} MB)")
    finally:
        project.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
