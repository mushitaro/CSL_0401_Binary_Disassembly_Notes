#!/usr/bin/env python3
"""Query the joined MSS54HP 0401 parameter/logic graph.

Every fact this prints comes from app/public/data/graph.json, which the pipeline
built by joining the TunerPro XDF, the Ghidra disassembly of the 0401 binary and
the factory Funktionsrahmen. Nothing here is inferred.

Commands
--------
  params <regex> [--full]   parameters by name           (--full adds desc, cats, axes, tables)
  desc   <regex>            search English descriptions
  catof  <regex>            all parameters in categories matching regex
  cats                      list the categories
  show   <EXACT_NAME>       full dump of one parameter, or a function's recovered statements
  func   <regex>            functions by name
  code   <regex>            search recovered statements (expr / out / guards / interp)
  edges  <EXACT_NAME>       graph edges in and out of a node
  ram    <regex>            RAM / signal symbols appearing in recovered code

  consumers <EXACT_NAME>    who reads this parameter, and whether those functions
                            actually have recovered statements (the stmts=0 trap)
  enc    <EXACT_NAME> <value> [...]   can you even write that value? raw, range,
                            quantisation step, nearest representable
  dead   [regex]            scan for inert paths: enable-like constants at 0,
                            all-zero curves/maps, flat tables

Locate the graph with --graph PATH or $MSS54_GRAPH; otherwise it is found relative
to this script (repo/.claude/skills/<skill>/scripts/ -> repo/app/public/data/graph.json).
"""
import json, re, sys, os, io, math

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")


def find_graph():
    for i, a in enumerate(sys.argv):
        if a == "--graph" and i + 1 < len(sys.argv):
            return sys.argv[i + 1]
    if os.environ.get("MSS54_GRAPH"):
        return os.environ["MSS54_GRAPH"]
    here = os.path.dirname(os.path.abspath(__file__))
    for up in range(2, 7):                       # walk up to the repo root
        root = os.path.abspath(os.path.join(here, *([".."] * up)))
        cand = os.path.join(root, "app", "public", "data", "graph.json")
        if os.path.exists(cand):
            return cand
    sys.exit("graph.json not found — pass --graph PATH or set $MSS54_GRAPH")


GRAPH = find_graph()
D = json.load(open(GRAPH, encoding="utf-8"))
NODES, EDGES, CATS = D["nodes"], D["edges"], D["categories"]
PARAMS = [n for n in NODES if n.get("t") == "param"]
FUNCS = [n for n in NODES if n.get("t") == "func"]
BYID = {n["id"]: n for n in NODES}
BYNAME = {}
for n in NODES:
    BYNAME.setdefault(n["name"], []).append(n)
CATBYID = {c["id"]: c for c in CATS if isinstance(c, dict) and "id" in c}


def catname(i):
    c = CATBYID.get(i)
    return f"{c.get('en')} [{c.get('de')}]" if c else str(i)


def fileoff(addr):
    """The one address rule. Getting this wrong drops coverage from 86.5% to 0.6%."""
    return None if addr is None else 0x88000 + (addr % 0x8000)


# ---------------------------------------------------------------- scaling maths

def scale_fn(math_expr):
    """Return f(raw) -> physical for an XDF math string, or None if unparseable.

    Forms seen in this XDF: x, X, x/10, x*40, x-48, x*0.0078125, 5.12/x, 1310/x,
    x/(10*16), x*100/250, X*50/256, x/256/16.384, -x, x*(-40).
    """
    if not math_expr:
        return None
    e = str(math_expr).strip().replace("X", "x")
    if not re.fullmatch(r"[0-9x+\-*/().e ]+", e):
        return None

    def f(raw):
        try:
            return eval(e, {"__builtins__": {}}, {"x": raw})   # arithmetic only, chars filtered above
        except ZeroDivisionError:
            return float("nan")
        except Exception:
            return None
    return f


def raw_domain(bits, signed):
    bits = bits or 16
    if signed:
        return -(1 << (bits - 1)), (1 << (bits - 1)) - 1
    return 0, (1 << bits) - 1


def param_bits_signed(p):
    """Best available (bits, signed) for a constant; falls back conservatively."""
    bits = p.get("bits")
    raw = p.get("raw")
    signed = p.get("signed")
    if signed is None:
        signed = isinstance(raw, (int, float)) and raw < 0
    if bits is None:
        bits = 16 if not isinstance(raw, int) or abs(raw) > 255 else 8
    return bits, bool(signed)


# ---------------------------------------------------------------- printers

def pshort(p):
    a = p.get("addr")
    axes = p.get("axes") or {}
    dims = ""
    if p.get("kind") == "map":
        z = axes.get("z", {})
        dims = f" [{z.get('rows','?')}x{z.get('cols','?')}]"
    elif p.get("kind") == "curve":
        dims = f" [{(axes.get('y') or {}).get('n','?')}]"
    val = f"  = {p.get('value')} (raw {p.get('raw')})" if p.get("kind") == "constant" else ""
    fo = fileoff(a)
    return (f"{p['name']:38s} {p.get('kind',''):8s} XDF=0x{a:04X} file=0x{fo:05X} "
            f"{p.get('bank',''):6s} {str(p.get('units','')):10s} {str(p.get('math','')):16s}{dims}{val}")


def pfull(p):
    out = [pshort(p)]
    d = (p.get("desc") or {}).get("en")
    if d:
        out.append("    EN: " + " ".join(d.split())[:600])
    if p.get("cats"):
        out.append("    CATS: " + ", ".join(catname(c) for c in p["cats"]))
    for k in ("x", "y", "z"):
        ax = (p.get("axes") or {}).get(k)
        if not ax:
            continue
        head = (f"    {k}: units={ax.get('units')} math={ax.get('math')} "
                f"addr=0x{ax.get('addr', 0):04X} bits={ax.get('bits')} signed={ax.get('signed')}")
        if k == "z":
            out.append(head + f" rows={ax.get('rows')} cols={ax.get('cols')}")
            for r in (ax.get("values") or []):
                out.append("       " + " ".join(f"{v:>8}" for v in r))
        else:
            out.append(head + f" n={ax.get('n')}")
            out.append(f"       {ax.get('values')}")
    return "\n".join(out)


# ---------------------------------------------------------------- commands

def cmd_params(rx, full=False):
    r = re.compile(rx, re.I)
    hits = sorted((p for p in PARAMS if r.search(p["name"])), key=lambda p: p["name"])
    print(f"# {len(hits)} params matching /{rx}/")
    for p in hits:
        print(pfull(p) if full else pshort(p))


def cmd_desc(rx):
    r = re.compile(rx, re.I)
    hits = [p for p in PARAMS if r.search((p.get("desc") or {}).get("en") or "")]
    print(f"# {len(hits)} params whose description matches /{rx}/")
    for p in hits:
        print(pshort(p))
        print("    EN: " + " ".join(((p.get("desc") or {}).get("en") or "").split())[:400])


def cmd_func(rx):
    r = re.compile(rx, re.I)
    hits = sorted((f for f in FUNCS if r.search(f["name"])), key=lambda f: f["name"])
    print(f"# {len(hits)} functions matching /{rx}/")
    for f in hits:
        n = len(f.get("stmts") or [])
        warn = "   <-- stmts=0: xref only, mechanism NOT recovered" if n == 0 else ""
        print(f"{f['name']:46s} {f['id']:22s} bank={f.get('bank'):6s} size={f.get('size'):5} stmts={n}{warn}")


def cmd_code(rx):
    r = re.compile(rx, re.I)
    n = 0
    for f in FUNCS:
        for s in (f.get("stmts") or []):
            if r.search(json.dumps(s, ensure_ascii=False)):
                n += 1
                print(f"[{f['name']} @{f['id']}]")
                print(f"   {s.get('out')} = {s.get('expr')}")
                if s.get("guards"):
                    print(f"   guards: {s['guards']}")
                if s.get("interp"):
                    print(f"   interp: {s['interp']}")
    print(f"# {n} statements matching /{rx}/")


def cmd_show(name):
    if name not in BYNAME:
        print(f"(no node named {name})")
        return
    for n in BYNAME[name]:
        if n.get("t") == "param":
            print(pfull(n))
        else:
            st = n.get("stmts") or []
            print(f"FUNC {n['name']} {n['id']} bank={n.get('bank')} size={n.get('size')} stmts={len(st)}")
            if not st:
                print("  !! stmts=0 — Ghidra resolved the xrefs but no statement was recovered.")
                print("     Anything you say about HOW this works is inference, not code-confirmed.")
            for s in st:
                g = f"   [if {' && '.join(s['guards'])}]" if s.get("guards") else ""
                print(f"  {s.get('out')} = {s.get('expr')}{g}")
                if s.get("reads"):
                    print(f"      reads: {s['reads']}")
                if s.get("calls"):
                    print(f"      calls: {s['calls']}")
        print()


def cmd_edges(name):
    ids = {n["id"] for n in BYNAME.get(name, [])}
    if not ids:
        print("no such node")
        return
    print("--- OUT ---")
    for e in EDGES:
        if e["s"] in ids:
            print(f"  -{e.get('k')}({e.get('o')})-> {BYID.get(e['d'], {}).get('name', e['d'])}")
    print("--- IN ---")
    for e in EDGES:
        if e["d"] in ids:
            print(f"  {BYID.get(e['s'], {}).get('name', e['s'])} -{e.get('k')}({e.get('o')})->")


def cmd_cats():
    for c in CATS:
        print(c.get("id"), "|", c.get("de"), "|", c.get("en"))


def cmd_catof(rx):
    r = re.compile(rx, re.I)
    idx = {c["id"] for c in CATS if r.search(json.dumps(c, ensure_ascii=False))}
    print("# categories:", [(i, catname(i)) for i in sorted(idx)])
    for p in sorted(PARAMS, key=lambda p: p["name"]):
        if set(p.get("cats") or []) & idx:
            print(pshort(p))


def cmd_ram(rx):
    r = re.compile(rx, re.I)
    seen = {}
    for f in FUNCS:
        for s in (f.get("stmts") or []):
            for sym in [s.get("out")] + list(s.get("reads") or []):
                if sym and r.search(sym):
                    seen.setdefault(sym, set()).add(f["name"])
    for k in sorted(seen):
        print(f"{k:34s}  in {len(seen[k])} fn: {sorted(seen[k])[:8]}")


def cmd_consumers(name):
    """Who reads this, and is the mechanism actually recovered?

    A parameter can be read by a function whose statements were never recovered
    (stmts=0). The xref proves WHERE it matters; it proves nothing about HOW.
    """
    ids = {n["id"] for n in BYNAME.get(name, [])}
    if not ids:
        print("no such node")
        return
    readers, docs = [], []
    for e in EDGES:
        if e["d"] in ids or e["s"] in ids:
            other = BYID.get(e["s"] if e["d"] in ids else e["d"], {})
            if other.get("t") == "func":
                readers.append((other, e.get("k"), e.get("o")))
            elif e.get("o") == "fr":
                docs.append(other.get("name") or other.get("id"))
    print(f"# consumers of {name}")
    named = False
    for f, k, o in readers:
        st = len(f.get("stmts") or [])
        appears = any(name in json.dumps(s, ensure_ascii=False) for s in (f.get("stmts") or []))
        if appears:
            grade, named = "code-confirmed  (name appears in a recovered statement)", True
        elif st == 0:
            grade = "xref-only       (function has NO recovered statements)"
        else:
            grade = "xref-only       (function recovered, but this name is in none of its statements)"
        print(f"  {f['name']:44s} {k}/{o}  stmts={st:3d}  -> {grade}")
    if docs:
        print(f"  Funktionsrahmen: {sorted(set(docs))}")
    print()
    print("VERDICT:", "code-confirmed available" if named else
          "NO recovered statement contains this name -> at best xref-only / funktionsrahmen-only")


def cmd_enc(name, targets):
    """Can the value you want actually be written? Check before recommending it.

    Three separate real errors came from skipping this: a byte whose most negative
    writable value was already past the request, an unsigned lookup asked to hold a
    negative, and a 0.1-quantised table asked for 0.55.
    """
    nodes = [n for n in BYNAME.get(name, []) if n.get("t") == "param"]
    if not nodes:
        print("no such parameter")
        return
    p = nodes[0]
    print(pshort(p))
    if p.get("kind") == "constant":
        m, bits, signed = p.get("math"), *param_bits_signed(p)
        axes_list = [("value", m, bits, signed)]
    else:
        axes_list = []
        for k in ("y", "z", "x"):
            ax = (p.get("axes") or {}).get(k)
            if ax:
                axes_list.append((k, ax.get("math"), ax.get("bits"), ax.get("signed")))
    for label, m, bits, signed in axes_list:
        f = scale_fn(m)
        print(f"\n  [{label}] math={m} bits={bits} signed={signed}")
        if not f:
            print("    cannot parse this scaling — invert it by hand")
            continue
        lo, hi = raw_domain(bits, signed)
        if hi - lo > 200000:
            print("    domain too large to enumerate — invert this scaling by hand")
            continue
        # Sweep the whole domain rather than just the endpoints: reciprocal
        # scalings like 5.12/x are non-monotonic at raw 0 (division by zero) and
        # their endpoints say nothing useful about the reachable range.
        table = []
        for raw in range(lo, hi + 1):
            v = f(raw)
            if v is None or (isinstance(v, float) and math.isnan(v)):
                continue
            table.append((raw, v))
        if not table:
            print("    no raw value produces a usable result — check the scaling")
            continue
        vals = [v for _, v in table]
        print(f"    writable physical range: {min(vals):g} .. {max(vals):g}   "
              f"(raw {lo} .. {hi}, {len(table)} usable)")
        for t in targets:
            best, bestv = None, None
            for raw, v in table:
                if best is None or abs(v - t) < abs(bestv - t):
                    best, bestv = raw, v
            if best is None:
                print(f"    {t:>12g} -> could not search this domain")
                continue
            nb = f(best + 1) if best + 1 <= hi else None
            step = abs(nb - bestv) if isinstance(nb, (int, float)) else float("nan")
            exact = abs(bestv - t) < 1e-9
            flag = "exact" if exact else f"NOT representable — nearest is {bestv:g}"
            print(f"    {t:>12g} -> raw {best}  = {bestv:g}  [{flag}]   quantisation here ~{step:g}")


def cmd_dead(rx=None):
    """Find calibration that cannot do anything: switched off, zeroed, or flat.

    This is the highest-yield accuracy check in the whole toolkit. A parameter can
    be perfectly named, perfectly scaled and completely inert because its enable
    byte is 0, its table is all zeros, or its consumer compares against a rail no
    signal ever reaches. Recommending a change to inert calibration is worthless
    advice that looks authoritative.
    """
    r = re.compile(rx, re.I) if rx else None
    zero_enable, zero_tab, flat_tab = [], [], []
    for p in PARAMS:
        if r and not r.search(p["name"]):
            continue
        k = p.get("kind")
        if k == "constant":
            # Naming is not consistent across modules: CONTROL, CTRL, CFG,
            # ENABLE, AKTIV, STEUER and MODE all appear as the same idea.
            if re.search(r"_(ENABLE|EN|CFG|CONFIG|CONTROL|CTRL|STEUER|AKTIV|ACTIVE|MODE|ON)$",
                         p["name"], re.I) and p.get("value") == 0:
                zero_enable.append(p)
        else:
            ax = (p.get("axes") or {}).get("z") or (p.get("axes") or {}).get("y")
            if not ax:
                continue
            vals = ax.get("values") or []
            flat = [v for row in vals for v in (row if isinstance(row, list) else [row])]
            if not flat:
                continue
            if all(v == 0 for v in flat):
                zero_tab.append((p, len(flat)))
            elif len(set(flat)) == 1:
                flat_tab.append((p, flat[0], len(flat)))
    print(f"### enable-like constants sitting at 0 ({len(zero_enable)})")
    print("### the function is present and calibrated; a single byte switches it off")
    for p in zero_enable:
        print("  " + pshort(p))
    print(f"\n### all-zero curves/maps ({len(zero_tab)})")
    print("### zero authority. 'tune this' is meaningless until something is written here")
    for p, n in zero_tab:
        print(f"  {pshort(p)}   ({n} points, all 0)")
    print(f"\n### flat curves/maps ({len(flat_tab)})")
    print("### a single repeated value often means 'disabled by railing it out of reach'")
    print("### — check whether any real signal can ever cross it before trusting it as a limit")
    for p, v, n in flat_tab:
        print(f"  {pshort(p)}   ({n} points, all = {v})")


CMDS = {
    "params": lambda a: cmd_params(a[1], "--full" in a),
    "desc": lambda a: cmd_desc(a[1]),
    "func": lambda a: cmd_func(a[1]),
    "code": lambda a: cmd_code(a[1]),
    "show": lambda a: cmd_show(a[1]),
    "edges": lambda a: cmd_edges(a[1]),
    "cats": lambda a: cmd_cats(),
    "catof": lambda a: cmd_catof(a[1]),
    "ram": lambda a: cmd_ram(a[1]),
    "consumers": lambda a: cmd_consumers(a[1]),
    "enc": lambda a: cmd_enc(a[1], [float(x) for x in a[2:] if not x.startswith("--")]),
    "dead": lambda a: cmd_dead(a[1] if len(a) > 1 and not a[1].startswith("--") else None),
}

if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if a != "--graph"]
    if args and args[0] == GRAPH:
        args = args[1:]
    args = [a for a in args if a != GRAPH]
    if not args or args[0] not in CMDS:
        print(__doc__)
        print(f"\n(graph: {GRAPH})")
        sys.exit(0)
    CMDS[args[0]](args)
