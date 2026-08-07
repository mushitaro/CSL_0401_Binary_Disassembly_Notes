"""Turn decompiled C into logic blocks: an output, its formula, and its inputs.

This is the data behind the block-diagram view. For every assignment in a
decompiled function it recovers

    output  =  expression( map, curve, constant, RAM signal, called block )

which is the shape of a Funktionsrahmen Strukturbild box, except read off the
binary rather than off the factory drawing.

Two transformations make the result readable.

**Folding temporaries.** Ghidra emits

    uVar1 = kfs_wint(&KF_TZ_GRUND.sizeX,N,RF);
    TZ_GRUND = (short)uVar1;

A diagram built from those statements shows a box computing `uVar1`, which
tells a tuner nothing. Substituting the definition into its use gives
``TZ_GRUND = kfs_wint(KF_TZ_GRUND, N, RF)``. Because the decompiler reuses
`uVar1` throughout a function, the substitution has to follow reaching
definitions in program order rather than assume one definition per name.

**Keeping branch alternatives.** `tz_calc` picks its map by operating state:

    if      (LL)  table = &KF_TZ_LL;
    else if (VL)  table = &KF_TZ_VL;
    else          table = &KF_TZ_GRUND;
    TZ_GRUND = kfs_wint(&table->sizeX, N, RF);

Collapsing that to one map would be a lie, and dropping it would hide the most
useful fact in the block. A temporary with several reaching definitions renders
as ``{KF_TZ_LL | KF_TZ_VL | KF_TZ_GRUND}`` and every alternative is recorded as
an input, so the diagram shows all three feeding the interpolation.

Two MSS54 helpers carry most of the meaning and are recognised by name:
``kfs_wint`` interpolates a Kennfeld (3-D map) and ``kls_wint`` a Kennlinie
(2-D curve).
"""

from __future__ import annotations

import argparse
import collections
import json
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]

# Ghidra's generated pseudo-variables, which never correspond to a real
# quantity: unaff_* is an unaffected register, in_* an inferred input, and
# extraout_* a secondary return value.
PSEUDO_RE = re.compile(r"^(?:unaff_|in_|extraout_|__)")

# Declarations at the top of a decompiled function, e.g.
#     short sVar3;
#     KF_18x3_2byte_2byte_2byte *table;
# Reading them is how locals are identified: guessing from the name misses the
# ones the analyst renamed, and "curve" or "table" leaked into the formulas.
DECL_RE = re.compile(r"^\s*[A-Za-z_]\w*(?:\s+[A-Za-z_]\w*)*\s*\**\s*([A-Za-z_]\w*)\s*(?:\[[^\]]*\])?\s*;\s*$")

# Names that are always the decompiler's, declared or not.
GENERATED_RE = re.compile(
    r"^(?:[a-z]{1,2}Var\d+|local_[0-9a-f]+|[a-z]Stack_[0-9a-f]+|p[A-Z]?\w*Var\d+)$"
)

# Set per function from its declaration block; see `extract`.
_locals: set[str] = set()


def is_temp(name: str) -> bool:
    return bool(
        GENERATED_RE.match(name) or PSEUDO_RE.match(name) or name in _locals
    )


class _TempMatcher:
    """Keeps the `TEMP_RE.match(...)` call sites readable after the change."""

    @staticmethod
    def match(name: str):
        return is_temp(name)

    @staticmethod
    def search(text: str):
        return any(is_temp(t) for t in IDENT_RE.findall(text))


TEMP_RE = _TempMatcher

ASSIGN_RE = re.compile(r"^\s*([A-Za-z_][\w\.\[\]>-]*?)\s*=\s*(.+?);\s*$")
IDENT_RE = re.compile(r"\b[A-Za-z_][A-Za-z0-9_]*\b")

CAST_RE = re.compile(
    r"\((?:short|ushort|int|uint|char|uchar|byte|sbyte|undefined\d?|long|ulong|"
    r"float|double|bool)\s*\)\s*"
)
# Address-of only: a "&" that follows an identifier or ")" is a bitwise AND and
# must survive, or "ZUSTAND_MOTOR & VL" silently becomes "ZUSTAND_MOTOR VL".
STRUCT_ADDR_RE = re.compile(
    r"(?<![\w)\]])&\s*([A-Za-z_]\w*)\s*(?:\.\w+|->\w+)?"
)
STRUCT_CAST_RE = re.compile(r"\(\s*[A-Za-z_]\w*\s*\*\s*\)\s*")

# The MSS54 lookup helpers follow a strict naming scheme:
#   kf = Kennfeld (3-D map)      kl = Kennlinie (2-D curve)
#   s  = signed data             u  = unsigned data
#   w  = word (16 bit)           b  = byte (8 bit)
# The unsigned variants dominate - klu_wint alone is called 90 times against
# kls_wint's 28 - so all eight are matched by pattern rather than listed.
LOOKUP_RE = re.compile(r"^(kf|kl)([su])_([wb])int$")
TABLE_LOOKUP = {"tableLookup"}
# First-order lag filters read as their own block in the factory diagrams.
FILTER_RE = re.compile(r"^(PT1|IIR)_Filter_(\w+)$")


def classify_helper(name: str) -> dict | None:
    m = LOOKUP_RE.match(name)
    if m:
        return {
            "shape": "map" if m.group(1) == "kf" else "curve",
            "signed": m.group(2) == "s",
            "width": 16 if m.group(3) == "w" else 8,
        }
    if name in TABLE_LOOKUP:
        return {"shape": "table", "signed": False, "width": 0}
    m = FILTER_RE.match(name)
    if m:
        return {"shape": "filter", "kind": m.group(1), "signed": False, "width": 0}
    return None

C_KEYWORDS = {
    "if", "else", "return", "while", "for", "do", "switch", "case", "break",
    "continue", "goto", "sizeof", "void", "short", "int", "long", "char",
    "unsigned", "signed", "float", "double", "static", "const", "struct",
    "true", "false", "NULL", "bool", "byte", "uint", "ushort", "uchar",
    "undefined", "undefined1", "undefined2", "undefined4", "undefined8",
}

MAX_FOLD_DEPTH = 6
MAX_ALTERNATIVES = 4


# --------------------------------------------------------------------------- #
# a small structured parse of the decompiled body
# --------------------------------------------------------------------------- #


@dataclass
class Stmt:
    text: str


@dataclass
class Branch:
    """An if / else-if / else chain: a list of (condition, body)."""
    arms: list[tuple[str, list]] = field(default_factory=list)


def _clean(expression: str) -> str:
    text = STRUCT_CAST_RE.sub("", expression)
    text = CAST_RE.sub("", text)
    text = STRUCT_ADDR_RE.sub(r"\1", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def parse_body(lines: list[str], start: int = 0, stop_at_brace: bool = False):
    """Parse a brace-delimited region into Stmt / Branch nodes."""
    out: list = []
    i = start
    while i < len(lines):
        line = lines[i].strip()
        i += 1
        if not line or line.startswith("/*") or line.startswith("//"):
            continue
        if line == "}" or line.startswith("}") and line.strip() == "}":
            if stop_at_brace:
                return out, i
            continue

        cond = re.match(r"^(?:\}\s*)?if\s*\((.*)\)\s*\{?\s*$", line)
        if cond:
            branch = Branch()
            condition = _clean(cond.group(1))
            body, i = _read_block(lines, i)
            branch.arms.append((condition, body))
            # else / else if chain
            while i < len(lines):
                nxt = lines[i].strip()
                m_elif = re.match(r"^\}?\s*else\s+if\s*\((.*)\)\s*\{?\s*$", nxt)
                m_else = re.match(r"^\}?\s*else\s*\{?\s*$", nxt)
                if m_elif:
                    i += 1
                    body, i = _read_block(lines, i)
                    branch.arms.append((_clean(m_elif.group(1)), body))
                elif m_else:
                    i += 1
                    body, i = _read_block(lines, i)
                    branch.arms.append(("otherwise", body))
                else:
                    break
            out.append(branch)
            continue

        if re.match(r"^(?:do|while|for|switch)\b", line):
            # Loop and switch bodies are read as plain sequences: the exact
            # control flow does not change which quantities feed which output.
            body, i = _read_block(lines, i)
            out.extend(body)
            continue

        out.append(Stmt(line))
    return out, i


def _read_block(lines: list[str], i: int):
    """Read either a braced block or a single unbraced statement."""
    # A brace may sit on the condition line (already consumed) or on its own.
    while i < len(lines) and not lines[i].strip():
        i += 1
    if i < len(lines) and lines[i].strip() == "{":
        i += 1
        return parse_body(lines, i, stop_at_brace=True)
    if i - 1 >= 0 and lines[i - 1].rstrip().endswith("{"):
        return parse_body(lines, i, stop_at_brace=True)
    if i < len(lines):
        return [Stmt(lines[i].strip())], i + 1
    return [], i


# --------------------------------------------------------------------------- #
# evaluation: reaching definitions with branch merging
# --------------------------------------------------------------------------- #


@dataclass
class Statement:
    output: str
    expression: str
    guards: list[str]
    reads: list[str]
    calls: list[str]
    interpolations: list[dict]


Env = dict  # temp name -> list of candidate expressions


def _merge(base: Env, branches: list[Env]) -> Env:
    merged: Env = dict(base)
    names = {n for b in branches for n in b}
    for name in names:
        options: list[str] = []
        for b in branches:
            for value in b.get(name, base.get(name, [])):
                if value not in options:
                    options.append(value)
        # A name untouched by some arm keeps its incoming value as an option.
        if any(name not in b for b in branches):
            for value in base.get(name, []):
                if value not in options:
                    options.append(value)
        merged[name] = options[:MAX_ALTERNATIVES]
    return merged


ATOMIC_RE = re.compile(r"^[A-Za-z_]\w*$|^-?(?:0x[0-9a-fA-F]+|\d+)$|^\{[^{}]*\}$")


def _is_atomic(text: str) -> bool:
    """A bare name, number or alternative set needs no protecting parentheses."""
    if ATOMIC_RE.match(text):
        return True
    # A complete call such as klu_wint(a,b) is also atomic for this purpose.
    m = re.match(r"^[A-Za-z_]\w*\(", text)
    return bool(m and text.endswith(")") and _outer_call_balanced(text, m.end() - 1))


def _outer_call_balanced(text: str, open_index: int) -> bool:
    depth = 0
    for i in range(open_index, len(text)):
        if text[i] == "(":
            depth += 1
        elif text[i] == ")":
            depth -= 1
            if depth == 0:
                return i == len(text) - 1
    return False


def _fold(expression: str, env: Env, depth: int = 0) -> str:
    if depth >= MAX_FOLD_DEPTH:
        return expression

    def repl(m: re.Match) -> str:
        ident = m.group(0)
        if not TEMP_RE.match(ident):
            return ident
        options = env.get(ident)
        if not options:
            return ident
        folded = [_fold(o, env, depth + 1) for o in options]
        folded = list(dict.fromkeys(folded))
        if len(folded) == 1:
            # Parenthesise only what needs it.  A substituted name is atomic,
            # and wrapping it turned kfs_wint(KF_TZ_VL,...) into
            # kfs_wint((KF_TZ_VL),...) for no reason.
            return folded[0] if _is_atomic(folded[0]) else f"({folded[0]})"
        return "{" + " | ".join(folded) + "}"

    return IDENT_RE.sub(repl, expression)


def _strip_redundant_parens(text: str) -> str:
    while (
        text.startswith("(")
        and text.endswith(")")
        and _outer_pair_wraps_all(text)
    ):
        text = text[1:-1].strip()
    return text


def _outer_pair_wraps_all(text: str) -> bool:
    depth = 0
    for i, ch in enumerate(text):
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
            if depth == 0:
                return i == len(text) - 1
    return False


def _analyse(expression: str) -> tuple[list[str], list[str], list[dict]]:
    calls = sorted(set(re.findall(r"\b([A-Za-z_]\w*)\s*\(", expression)))
    reads: list[str] = []
    for name in IDENT_RE.findall(expression):
        if name in C_KEYWORDS or TEMP_RE.match(name) or name in calls:
            continue
        if name not in reads:
            reads.append(name)

    interpolations = []
    for name in calls:
        kind = classify_helper(name)
        if kind is None:
            continue
        # Arguments may themselves contain a {a | b} alternative set.
        for m in re.finditer(rf"\b{re.escape(name)}\s*\(", expression):
            args = _balanced_args(expression, m.end() - 1)
            if not args:
                continue
            tables = [
                t
                for t in re.findall(r"[A-Za-z_]\w*", args[0])
                if not TEMP_RE.match(t) and t not in C_KEYWORDS
            ]
            interpolations.append(
                {
                    "helper": name,
                    **kind,
                    "tables": tables,
                    "axes": [a.strip() for a in args[1:]],
                }
            )
    return reads, calls, interpolations


def _balanced_args(text: str, open_index: int) -> list[str] | None:
    depth = 0
    start = open_index + 1
    args: list[str] = []
    for i in range(open_index, len(text)):
        ch = text[i]
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
            if depth == 0:
                args.append(text[start:i].strip())
                return [a for a in args if a]
        elif ch == "," and depth == 1:
            args.append(text[start:i].strip())
            start = i + 1
    return None


def _walk(nodes: list, env: Env, guards: list[str], out: list[Statement]) -> Env:
    for node in nodes:
        if isinstance(node, Branch):
            # Each arm is evaluated against a copy, then the arms are merged so
            # a temporary written differently per branch keeps every value it
            # can hold.  _walk returns the environment because merging produces
            # a new mapping: rebinding a local would drop the alternatives.
            branch_envs = [
                _walk(body, dict(env), guards + [condition], out)
                for condition, body in node.arms
            ]
            env = _merge(env, branch_envs)
            continue

        m = ASSIGN_RE.match(node.text)
        if not m:
            continue
        lhs, rhs = m.group(1), m.group(2)
        folded = _strip_redundant_parens(_clean(_fold(_clean(rhs), env)))

        if TEMP_RE.match(lhs):
            env[lhs] = [folded]
            continue

        reads, calls, interpolations = _analyse(folded)
        out.append(
            Statement(
                output=lhs,
                expression=folded,
                guards=list(guards),
                reads=reads,
                calls=calls,
                interpolations=interpolations,
            )
        )
    return env


def _declared_locals(body: str) -> set[str]:
    """Names declared in the block before the first real statement."""
    names: set[str] = set()
    for line in body.splitlines():
        text = line.strip()
        if not text:
            continue
        if text.startswith(("if", "return", "}", "/*", "//")):
            break
        m = DECL_RE.match(text)
        if m:
            names.add(m.group(1))
        elif "=" in text:
            break
    return names


def extract(code: str) -> list[Statement]:
    global _locals
    body = code.split("{", 1)[1] if "{" in code else code
    _locals = _declared_locals(body)
    try:
        nodes, _ = parse_body(body.splitlines())
        out: list[Statement] = []
        _walk(nodes, {}, [], out)
        return out
    finally:
        _locals = set()


# --------------------------------------------------------------------------- #


def build(build_dir: Path) -> dict:
    blocks: dict[str, dict] = {}
    stats: collections.Counter = collections.Counter()

    for bank in ("master", "slave"):
        path = build_dir / f"ghidra_{bank}.json"
        if not path.exists():
            continue
        data = json.loads(path.read_text())
        by_addr = {f"{f['addr']:06x}": f for f in data["functions"]}
        for addr, code in (data.get("decompiled") or {}).items():
            fn = by_addr.get(addr)
            if fn is None:
                continue
            statements = extract(code)
            stats["functions"] += 1
            stats["statements"] += len(statements)
            if statements:
                stats["functionsWithStatements"] += 1
            stats["interpolations"] += sum(len(s.interpolations) for s in statements)
            stats["unfoldedTemporaries"] += sum(
                1 for s in statements if TEMP_RE.search(s.expression) or
                re.search(r"\b[a-z]{1,2}Var\d+\b", s.expression)
            )
            blocks[f"f:{bank}:{addr}"] = {
                "name": fn["name"],
                "bank": bank,
                "addr": fn["addr"],
                "statements": [
                    {
                        "out": s.output,
                        "expr": s.expression,
                        "guards": s.guards,
                        "reads": s.reads,
                        "calls": s.calls,
                        "interp": s.interpolations,
                    }
                    for s in statements
                ],
            }
    return {"blocks": blocks, "stats": dict(stats)}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--build", type=Path, default=REPO / "build")
    ap.add_argument("--out", type=Path, default=REPO / "build" / "logic.json")
    ap.add_argument("--show", help="print the statements of one function and exit")
    args = ap.parse_args(argv)

    result = build(args.build)

    if args.show:
        for block in result["blocks"].values():
            if block["name"] == args.show:
                print(f"=== {block['name']}  ({block['bank']} {block['addr']:#x})")
                for s in block["statements"]:
                    if s["guards"]:
                        print("  when " + " AND ".join(s["guards"]))
                    print(f"    {s['out']} = {s['expr']}")
                    if s["interp"]:
                        for i in s["interp"]:
                            print(f"      {i['shape']}: {i['tables']} over {i['axes']}")
                    print(f"      reads={s['reads']}")
                return 0
        print(f"{args.show} not found")
        return 1

    args.out.write_text(json.dumps(result, ensure_ascii=False))
    for key, value in result["stats"].items():
        print(f"{key:24s}: {value}")
    print(f"wrote {args.out} ({args.out.stat().st_size/1e6:.1f} MB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
