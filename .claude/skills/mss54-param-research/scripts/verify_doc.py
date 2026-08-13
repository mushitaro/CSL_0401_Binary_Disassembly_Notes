#!/usr/bin/env python3
"""Check every parameter row in a research document against the real XDF data.

Run this before handing any document to the user. Prose can be argued about;
an address cannot. A single wrong address makes a reader edit the wrong byte,
and it destroys trust in every other row on the page.

Recognised row shape (the column order the skill's report template uses):

  | NAME | kind | 0xXDF | 0xFILE | bank | current | units | ... |

For each row it checks:
  1. NAME exists as a parameter in graph.json
  2. the XDF address matches that parameter's real address
  3. the file offset follows the rule for that row's bank:
       master  file = addr             (master XDF addresses are 0x8000-0xFFFF)
       slave   file = 0x88000 + addr   (slave  XDF addresses are 0x0000-0x7FFF)
  4. the bank matches
  5. the kind (constant/curve/map) matches
  6. for constants, the stated current value matches (when a number is parseable)

Usage:
  python verify_doc.py DOC.md [DOC2.md ...] [--graph PATH]

Exits non-zero if anything failed, so it can gate a commit.
"""
import json, re, sys, os, io

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")


def find_graph():
    for i, a in enumerate(sys.argv):
        if a == "--graph" and i + 1 < len(sys.argv):
            return sys.argv[i + 1]
    if os.environ.get("MSS54_GRAPH"):
        return os.environ["MSS54_GRAPH"]
    here = os.path.dirname(os.path.abspath(__file__))
    for up in range(2, 7):
        root = os.path.abspath(os.path.join(here, *([".."] * up)))
        cand = os.path.join(root, "app", "public", "data", "graph.json")
        if os.path.exists(cand):
            return cand
    sys.exit("graph.json not found — pass --graph PATH or set $MSS54_GRAPH")


D = json.load(open(find_graph(), encoding="utf-8"))
PARAMS = {}
for n in D["nodes"]:
    if n.get("t") == "param":
        PARAMS.setdefault(n["name"], []).append(n)

ROW = re.compile(
    # XDF titles are not identifiers: several carry a parenthetical or an index,
    # e.g. "kf_rf_soll (CSL Alpha-N)" and "K_LL_TI_FAC[1of8]". Match the whole
    # cell and strip it, rather than silently skipping those rows.
    r"^\|\s*`?([A-Za-z_][A-Za-z0-9_]*(?:\s*\([^)|]*\)|\[[^\]|]*\])?)`?\s*\|"   # 1 name
    r"\s*([^|]*?)\s*\|"                                           # 2 kind
    r"\s*`?0x([0-9A-Fa-f]{2,5})`?\s*\|"                          # 3 XDF addr
    r"\s*`?0x([0-9A-Fa-f]{4,6})`?\s*\|"                          # 4 file offset
    r"\s*([A-Za-z]*)\s*\|"                                        # 5 bank
    r"\s*([^|]*?)\s*\|"                                           # 6 current value
)
KINDS = {"constant", "curve", "map"}
NUM = re.compile(r"-?\d+(?:\.\d+)?")


def file_offset(addr, bank):
    """Where an XDF address really sits in the 1 MB image. Bank decides.

    The two CPUs share one 32 KB XDF window but not one place in the flash:

        master   file = addr             (master XDF addresses are 0x8000-0xFFFF)
        slave    file = 0x88000 + addr   (slave  XDF addresses are 0x0000-0x7FFF)

    Do not confuse this with `0x88000 + (addr mod 0x8000)`. That is the run-time
    "Mapped Parameter Space" window Ghidra annotates for *both* banks: right for
    matching Ghidra symbols, wrong for reading bytes out of the file. Applied to a
    master parameter it lands 0x80000 too high, on unrelated slave data.

    Measured against `Full 211323000401PD31_TERRA.bin`: all 922 master constants
    read back correctly at `addr` (only 28 also happen to match the mapped-window
    form), and all 859 slave constants at `0x88000 + addr` (only 21 also match at
    `addr`). `tools/pipeline/parse_xdf.py:file_offset` uses the same rule.
    """
    b = (bank or "").lower()
    if b not in ("master", "slave"):
        b = "slave" if addr < 0x8000 else "master"     # the two ranges never overlap
    return 0x88000 + addr if b == "slave" else addr


def check(path):
    bad, seen = [], 0
    for ln, line in enumerate(open(path, encoding="utf-8"), 1):
        m = ROW.match(line.strip())
        if not m:
            continue
        name, kind, xa, fo, bank, cur = m.groups()
        kind = kind.strip().lower()
        if kind not in KINDS:
            continue                                  # header row or a different table
        seen += 1
        xa_i, fo_i = int(xa, 16), int(fo, 16)
        nodes = PARAMS.get(name)
        if not nodes:
            bad.append((ln, name, "name does not exist in the XDF data"))
            continue
        node = min(nodes, key=lambda n: abs((n.get("addr") if n.get("addr") is not None else -1) - xa_i))
        # Grade the offset against the bank the data says, not the bank the row
        # claims — a wrong bank column would otherwise excuse a wrong offset.
        eff_bank = node.get("bank") or bank
        want = file_offset(xa_i, eff_bank)
        rule = "0x88000 + addr" if want != xa_i else "addr"
        if node.get("addr") != xa_i:
            bad.append((ln, name, f"XDF 0x{xa_i:04X} but the real address is 0x{node.get('addr'):04X}"))
        if fo_i != want:
            bad.append((ln, name, f"file 0x{fo_i:05X} but {eff_bank or 'this'} {rule} = 0x{want:05X}"))
        if bank and node.get("bank") and bank.lower() != node["bank"].lower():
            bad.append((ln, name, f"bank '{bank}' but the parameter is '{node['bank']}'"))
        if node.get("kind") and kind != node["kind"]:
            bad.append((ln, name, f"kind '{kind}' but the parameter is a '{node['kind']}'"))
        if node.get("kind") == "constant" and node.get("value") is not None:
            # Documents legitimately use a Unicode minus and round for display,
            # so normalise the sign characters and allow 0.5% before complaining.
            text = cur.replace(",", "")
            for ch in "−–—－":
                text = text.replace(ch, "-")
            nums = NUM.findall(text)
            real = float(node["value"])
            tol = max(1e-6, abs(real) * 5e-3)
            if nums and not any(abs(float(v) - real) <= tol for v in nums[:3]):
                bad.append((ln, name, f"current value {nums[:3]} does not include the real {real}"))
    return seen, bad


total_seen = total_bad = 0
for path in sys.argv[1:]:
    if path.startswith("--") or path == os.environ.get("MSS54_GRAPH"):
        continue
    if not os.path.exists(path):
        print(f"!! missing file: {path}")
        total_bad += 1
        continue
    seen, bad = check(path)
    total_seen += seen
    total_bad += len(bad)
    print(f"\n=== {path} — {seen} parameter rows, {len(bad)} problems ===")
    for ln, name, why in bad:
        print(f"  line {ln:5d}  {name:34s} {why}")

print(f"\nTOTAL: {total_seen} rows checked, {total_bad} problems")
if total_seen == 0:
    print("NOTE: no rows matched the expected column order — check the table format "
          "against the template in the skill's report section.")
sys.exit(1 if total_bad else 0)
