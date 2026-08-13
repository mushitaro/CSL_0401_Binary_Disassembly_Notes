"""Join the XDF, the Ghidra export and the Funktionsrahmen into one graph.

Output: ``app/public/data/graph.json`` plus a coverage report.

Node kinds
    ``param``   a calibration item from the XDF (constant, curve or map)
    ``func``    a function from the Ghidra project
    ``ram``     a named RAM/register location from the Ghidra symbol table
    ``signal``  a wire name read off a Funktionsrahmen diagram
    ``frpage``  one page of a Funktionsrahmen document
    ``unknown`` a name the factory documents use that nothing else defines

Edge origins - the distinction the viewer must never blur
    ``xref``  Ghidra resolved this reference from the binary.  Measured.
    ``scan``  an instruction operand equals a known calibration address.
              Inferred, and wrong sometimes.
    ``fr``    the two nodes appear on the same Funktionsrahmen page.

An ``fr`` edge means "the factory documents these together", **not** "A feeds
B".  Direction is visible in the Strukturbild arrows, but the arrows are vector
graphics; only the text labels are extracted here, so claiming a direction
would be inventing it.  Upstream/downstream in the viewer therefore comes from
Ghidra's read/write classification alone.
"""

from __future__ import annotations

import argparse
import collections
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).resolve().parent))

import parse_xdf  # noqa: E402
import vocabulary  # noqa: E402

# A page naming more than this many things is an index or a summary table, not
# a functional block; its co-occurrence edges would be noise.
DENSE_PAGE_LIMIT = 25

RAM_REGIONS = {"ram"}


def load(build_dir: Path) -> dict:
    def read(name: str):
        path = build_dir / name
        if not path.exists():
            raise SystemExit(f"missing {path}; run the earlier pipeline stages first")
        return json.loads(path.read_text())

    out = {
        "params": read("params.json"),
        "master": read("ghidra_master.json"),
        "slave": read("ghidra_slave.json"),
        "fr": read("funktionsrahmen.json"),
    }
    logic_path = build_dir / "logic.json"
    out["logic"] = json.loads(logic_path.read_text()) if logic_path.exists() else {"blocks": {}}
    return out


def load_i18n(i18n_dir: Path) -> dict[str, dict[str, str]]:
    out: dict[str, dict[str, str]] = {}
    for name in ("categories", "frdocs", "params", "glossary"):
        path = i18n_dir / f"ja.{name}.json"
        out[name] = json.loads(path.read_text()) if path.exists() else {}
    return out


# The PDFs are not copied into the built site (they are 47 MB); the viewer
# links back to them in the repository instead, which also works from a local
# `npm run dev` and from GitHub Pages alike.
DEFAULT_DOC_BASE = (
    "https://github.com/mushitaro/CSL_0401_Binary_Disassembly_Notes/blob/master"
)


def write_decompiled(data: dict, out_dir: Path) -> int:
    """One file per decompiled function, fetched on demand by the viewer.

    Keeping the C out of graph.json matters: the two Ghidra exports carry
    644 functions' worth of it, which would roughly double the payload every
    visitor downloads just to see the parameter list.
    """
    written = 0
    for bank in ("master", "slave"):
        bank_dir = out_dir / bank
        bank_dir.mkdir(parents=True, exist_ok=True)
        for addr, code in (data[bank].get("decompiled") or {}).items():
            (bank_dir / f"{addr}.txt").write_text(code)
            written += 1
    return written


def build(data: dict, ja: dict, doc_base: str = DEFAULT_DOC_BASE) -> tuple[dict, dict]:
    nodes: dict[str, dict] = {}
    edges: list[dict] = []
    edge_seen: set[tuple] = set()
    name_index: dict[str, str] = {}

    def add_edge(src: str, dst: str, kind: str, origin: str, **extra) -> None:
        if src == dst or src not in nodes or dst not in nodes:
            return
        key = (src, dst, kind, origin)
        if key in edge_seen:
            return
        edge_seen.add(key)
        edges.append({"s": src, "d": dst, "k": kind, "o": origin, **extra})

    # ------------------------------------------------------------ categories
    categories = []
    for cat in data["params"]["categories"]:
        cid = cat["id"]
        categories.append(
            {
                "id": cid,
                "de": cat["de"],
                "en": cat["en"],
                "ja": ja["categories"].get(str(cid)) or ja["categories"].get(cat["en"]),
            }
        )

    # ---------------------------------------------------------------- params
    # program address (per bank) -> node id, used to resolve Ghidra edges.
    addr_index: dict[tuple[str, int], str] = {}

    for p in data["params"]["params"]:
        addr = p.get("addr")
        node_id = f"p:{addr:05x}" if addr is not None else f"p:{p['uid']}"
        bank = p.get("bank")
        node = {
            "id": node_id,
            "t": "param",
            "name": p["name"],
            "kind": p["kind"],
            "conf": p["conf"],
            "cats": p["cats"],
        }
        for key in ("addr", "bank", "units", "math", "bits", "signed", "value", "raw"):
            if p.get(key) is not None:
                node[key] = p[key]
        desc = p.get("desc")
        if desc:
            # Strip the "<NAME> <ADDR>" header line; it is already structured data.
            body = desc.split("\n", 1)
            prose = body[1].strip() if len(body) > 1 else ""
            if prose:
                node["desc"] = {"en": prose}
                ja_text = ja["params"].get(p["name"])
                if ja_text:
                    node["desc"]["ja"] = ja_text
        if p.get("axes"):
            node["axes"] = p["axes"]
        if p.get("error"):
            node["error"] = p["error"]
        nodes[node_id] = node
        name_index.setdefault(p["name"], node_id)
        # "KF_TZ_GRUND (Map_Ignition_Ground)" must also answer to KF_TZ_GRUND,
        # which is how the Funktionsrahmen refers to it.
        name_index.setdefault(vocabulary.base_name(p["name"]), node_id)

        if addr is not None and bank:
            mapped = parse_xdf.program_address(addr)
            for candidate in (mapped, mapped - parse_xdf.BLOCK_HEADER_BYTES):
                addr_index.setdefault((bank, candidate), node_id)
            for axis in (p.get("axes") or {}).values():
                if "addr" in axis:
                    m = parse_xdf.program_address(axis["addr"])
                    for candidate in (m, m - parse_xdf.BLOCK_HEADER_BYTES):
                        addr_index.setdefault((bank, candidate), node_id)

    # The formulas recovered from the decompiler, keyed by the same node id.
    logic_blocks = data.get("logic", {}).get("blocks", {})

    # ----------------------------------------------------- functions and RAM
    for bank in ("master", "slave"):
        g = data[bank]
        for f in g["functions"]:
            node_id = f"f:{bank}:{f['addr']:06x}"
            node = {
                "id": node_id,
                "t": "func",
                "name": f["name"],
                "bank": bank,
                "addr": f["addr"],
                "named": f["named"],
                "size": f["size"],
            }
            if f.get("plate"):
                node["plate"] = f["plate"]
            if f"{f['addr']:06x}" in (g.get("decompiled") or {}):
                node["hasCode"] = True
            block = logic_blocks.get(node_id)
            if block and block["statements"]:
                # What the block computes, which is what the diagram draws
                # inside the box rather than merely around it.
                node["stmts"] = block["statements"]
            nodes[node_id] = node
            addr_index.setdefault((bank, f["addr"]), node_id)
            if f["named"]:
                name_index.setdefault(f["name"], node_id)

        for s in g["symbols"]:
            if s["region"] not in RAM_REGIONS or not s["primary"]:
                continue
            node_id = f"r:{bank}:{s['addr']:06x}"
            if node_id in nodes:
                continue
            nodes[node_id] = {
                "id": node_id,
                "t": "ram",
                "name": s["name"],
                "bank": bank,
                "addr": s["addr"],
            }
            addr_index.setdefault((bank, s["addr"]), node_id)
            name_index.setdefault(s["name"], node_id)

    # ------------------------------------------------------- Ghidra edges
    unresolved_targets: collections.Counter = collections.Counter()
    for bank in ("master", "slave"):
        for e in data[bank]["edges"]:
            src = addr_index.get((bank, e["s"]))
            dst = addr_index.get((bank, e["d"]))
            if src is None:
                continue
            if dst is None:
                unresolved_targets[e["d"]] += 1
                continue
            add_edge(src, dst, e["k"], e["o"])

    # The documents write wire names in lower case (tz_grund, aq_rel) while the
    # Ghidra symbol table uses upper case (AQ_REL).  343 of the 841 diagram
    # signals only join up once case is ignored, and that join is what connects
    # a factory block to measured code behaviour, so it is done deliberately
    # rather than left on the floor.
    lower_index = {}
    for name, node_id in name_index.items():
        lower_index.setdefault(name.lower(), node_id)

    def resolve(name: str) -> str | None:
        return name_index.get(name) or lower_index.get(name.lower())

    # ------------------------------------------ Funktionsrahmen pages/edges
    fr_docs = []
    for doc in data["fr"]["documents"]:
        section = doc["section"]
        fr_docs.append(
            {
                "section": section,
                "de": doc["titleDe"],
                "en": doc["titleEn"],
                "ja": ja["frdocs"].get(section),
                "pathDe": doc["pathDe"],
                "pathEn": doc["pathEn"],
                "pages": len(doc["pages"]),
            }
        )

        for page in doc["pages"]:
            names = page["mnemonics"] + page["signals"]
            if not names:
                continue
            page_id = f"d:{section}:{page['page']}"
            dense = len(names) > DENSE_PAGE_LIMIT
            nodes[page_id] = {
                "id": page_id,
                "t": "frpage",
                "name": f"{section} p.{page['page']}",
                "section": section,
                "page": page["page"],
                "dense": dense,
                "excerpt": page["excerpt"],
                "count": len(names),
            }

            for name in names:
                target = resolve(name)
                if target is None:
                    target = f"u:{name}"
                    if target not in nodes:
                        nodes[target] = {
                            "id": target,
                            "t": "unknown",
                            "name": name,
                            "note": "named by the factory documents only",
                        }
                        name_index.setdefault(name, target)
                add_edge(target, page_id, "documented", "fr")
                add_edge(page_id, target, "documents", "fr")

    # ------------------------------------------------------------- signals
    # A signal name that matches a Ghidra RAM symbol is the same quantity; the
    # link is what lets a factory block reach measured code behaviour.
    signal_links = 0
    for doc in data["fr"]["documents"]:
        for signal in doc["signals"]:
            node_id = resolve(signal)
            if node_id and nodes[node_id]["t"] == "ram":
                signal_links += 1

    # ------------------------------------------------------------ coverage
    params_total = sum(1 for n in nodes.values() if n["t"] == "param")
    referenced = collections.Counter()
    fr_linked = set()
    for e in edges:
        if e["o"] in ("xref", "scan") and nodes[e["d"]]["t"] == "param":
            referenced[e["d"]] += 1
        if e["o"] == "fr" and nodes[e["s"]]["t"] == "param":
            fr_linked.add(e["s"])

    by_bank_total = collections.Counter(
        n.get("bank") for n in nodes.values() if n["t"] == "param"
    )
    by_bank_ref = collections.Counter(
        nodes[pid].get("bank") for pid in referenced
    )

    blocks_with_logic = sum(1 for n in nodes.values() if n.get("stmts"))
    lookups = sum(
        len(st.get("interp") or [])
        for n in nodes.values()
        for st in (n.get("stmts") or [])
    )

    coverage = {
        "blocksWithFormulas": blocks_with_logic,
        "tableLookupsFound": lookups,
        "params": params_total,
        "paramsWithCodeReference": len(referenced),
        "paramsWithCodeReferencePct": round(100 * len(referenced) / params_total, 1),
        "paramsPerBank": dict(by_bank_total),
        "paramsWithCodeReferencePerBank": dict(by_bank_ref),
        "paramsInFunktionsrahmen": len(fr_linked),
        "paramsInFunktionsrahmenPct": round(100 * len(fr_linked) / params_total, 1),
        "functions": sum(1 for n in nodes.values() if n["t"] == "func"),
        "namedFunctions": sum(
            1 for n in nodes.values() if n["t"] == "func" and n.get("named")
        ),
        "ramSymbols": sum(1 for n in nodes.values() if n["t"] == "ram"),
        "frPages": sum(1 for n in nodes.values() if n["t"] == "frpage"),
        "densePagesExcludedFromBlocks": sum(
            1 for n in nodes.values() if n["t"] == "frpage" and n.get("dense")
        ),
        "namesOnlyInDocuments": sum(1 for n in nodes.values() if n["t"] == "unknown"),
        "signalsMatchingRamSymbols": signal_links,
        "edgesByOrigin": dict(collections.Counter(e["o"] for e in edges)),
        "edgesByKind": dict(collections.Counter(e["k"] for e in edges)),
        "ghidraTargetsWithNoNode": len(unresolved_targets),
    }

    graph = {
        "meta": {
            "docBase": doc_base.rstrip("/"),
            "xdf": data["params"]["meta"].get("title"),
            "xdfVersion": data["params"]["meta"].get("fileversion"),
            "ghidra": {
                bank: {
                    "languageID": data[bank]["languageID"],
                    "createdWith": data[bank]["createdWith"],
                    "program": data[bank]["program"],
                }
                for bank in ("master", "slave")
            },
            "coverage": coverage,
        },
        "categories": categories,
        "frDocs": fr_docs,
        "nodes": list(nodes.values()),
        "edges": edges,
        "nameIndex": name_index,
        "glossary": ja["glossary"],
    }
    return graph, coverage


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--build", type=Path, default=REPO / "build")
    ap.add_argument("--i18n", type=Path, default=REPO / "tools" / "i18n")
    ap.add_argument("--out", type=Path,
                    default=REPO / "app" / "public" / "data" / "graph.json")
    ap.add_argument("--doc-base", default=DEFAULT_DOC_BASE,
                    help="URL prefix the viewer uses to link the PDF documents")
    args = ap.parse_args(argv)

    data = load(args.build)
    graph, coverage = build(data, load_i18n(args.i18n), args.doc_base)

    args.out.parent.mkdir(parents=True, exist_ok=True)
    written = write_decompiled(data, args.out.parent / "decomp")
    coverage["decompiledFunctionFiles"] = written
    graph["meta"]["coverage"] = coverage
    args.out.write_text(json.dumps(graph, ensure_ascii=False, separators=(",", ":")))

    print("coverage")
    for key, value in coverage.items():
        print(f"   {key:34s}: {value}")
    print(f"nodes {len(graph['nodes'])}  edges {len(graph['edges'])}")
    print(f"wrote {args.out} ({args.out.stat().st_size/1e6:.1f} MB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
