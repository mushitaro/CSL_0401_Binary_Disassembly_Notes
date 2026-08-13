"""Safe evaluator for TunerPro XDF ``<MATH equation="...">`` expressions.

The XDF uses 204 distinct equations, all of the shape ``x/10``, ``x-48``,
``x*100/32768``, ``5.12/x``, ``x/(10*64)`` and so on.  A couple of them pull in
a second variable through ``<VAR type="link" linkid="0x..."/>``, which refers to
another XDF item by its ``uniqueid``.

``eval`` is deliberately not used: equations come from a third-party definition
file, so the expression is parsed with :mod:`ast` and walked with an explicit
node allowlist instead.
"""

from __future__ import annotations

import ast
import math
import operator
from typing import Mapping

_BIN_OPS = {
    ast.Add: operator.add,
    ast.Sub: operator.sub,
    ast.Mult: operator.mul,
    ast.Div: operator.truediv,
    ast.Pow: operator.pow,
    ast.Mod: operator.mod,
}

_UNARY_OPS = {
    ast.UAdd: operator.pos,
    ast.USub: operator.neg,
}

# Functions seen in automotive definition files.  Kept small on purpose.
_FUNCS = {
    "abs": abs,
    "min": min,
    "max": max,
    "sqrt": math.sqrt,
    "round": round,
}


class MathError(ValueError):
    """Raised when an equation cannot be parsed or evaluated safely."""


def _walk(node: ast.AST, env: Mapping[str, float]) -> float:
    if isinstance(node, ast.Expression):
        return _walk(node.body, env)

    if isinstance(node, ast.Constant):
        if isinstance(node.value, bool) or not isinstance(node.value, (int, float)):
            raise MathError(f"non-numeric constant {node.value!r}")
        return float(node.value)

    if isinstance(node, ast.Name):
        # XDF is inconsistent about case: both `x` and `X` appear, as do `k`/`K`.
        for key in (node.id, node.id.lower(), node.id.upper()):
            if key in env:
                return float(env[key])
        raise MathError(f"unbound variable {node.id!r}")

    if isinstance(node, ast.BinOp):
        op = _BIN_OPS.get(type(node.op))
        if op is None:
            raise MathError(f"operator {type(node.op).__name__} not allowed")
        return op(_walk(node.left, env), _walk(node.right, env))

    if isinstance(node, ast.UnaryOp):
        op = _UNARY_OPS.get(type(node.op))
        if op is None:
            raise MathError(f"unary {type(node.op).__name__} not allowed")
        return op(_walk(node.operand, env))

    if isinstance(node, ast.Call):
        if not isinstance(node.func, ast.Name) or node.func.id.lower() not in _FUNCS:
            raise MathError("only abs/min/max/sqrt/round may be called")
        if node.keywords:
            raise MathError("keyword arguments not allowed")
        return float(_FUNCS[node.func.id.lower()](*(_walk(a, env) for a in node.args)))

    raise MathError(f"syntax node {type(node).__name__} not allowed")


def compile_equation(equation: str):
    """Parse ``equation`` once and return ``f(env) -> float``.

    Raises :class:`MathError` if the expression uses anything outside the
    allowlist, so a malformed definition fails loudly at build time rather than
    silently producing wrong numbers in the viewer.
    """
    text = (equation or "").strip()
    if not text:
        raise MathError("empty equation")
    # TunerPro spells exponentiation "^" (the XDF has four "x/2^14" scalings).
    # Python parses "^" as bitwise xor, which also binds *looser* than "/" -
    # "x/2^14" would become "(x/2)**14".  Rewriting to "**" restores both the
    # meaning and TunerPro's precedence, giving x/16384 as intended.
    source = text.replace("^", "**")
    try:
        tree = ast.parse(source, mode="eval")
    except SyntaxError as exc:  # pragma: no cover - defensive
        raise MathError(f"cannot parse {text!r}: {exc}") from exc

    def evaluate(env: Mapping[str, float]) -> float:
        try:
            return _walk(tree, env)
        except (ZeroDivisionError, OverflowError, ValueError) as exc:
            # e.g. "5.12/x" evaluated at a raw cell value of 0.  The cell is
            # genuinely undefined rather than mis-parsed, so surface it as a
            # per-cell error instead of aborting the whole build.
            if isinstance(exc, MathError):
                raise
            raise MathError(f"{text!r}: {exc}") from exc

    return evaluate


def apply(equation: str, raw: float, links: Mapping[str, float] | None = None) -> float:
    """Convenience wrapper: evaluate ``equation`` for a single raw value."""
    env = {"x": raw, "X": raw}
    if links:
        env.update(links)
    return compile_equation(equation)(env)
