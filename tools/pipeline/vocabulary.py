"""Build the mnemonic vocabulary used to read names out of the PDF text.

Labels inside the Funktionsrahmen structure diagrams are absolutely positioned,
so every extractor - pdfminer included - hands back long runs with no
separators at all:

    KL_TZ_START_TMOTKF_TZ_LLKF_TZ_GRUNDKL_TZ_START_Nnrftm

A greedy ``[A-Z0-9_]+`` pattern swallows that whole run as one token, and
splitting on known prefixes is worse than useless because the prefixes recur
inside names: ``K_MD_TZ_CONTROL`` would break at ``TZ_`` and yield ``K_MD_``.

The reliable way to cut the run is to already know the names.  The XDF supplies
2,529 calibration titles and the Ghidra symbol tables several thousand more, so
tokenising is a longest-match scan against that vocabulary.  Anything the
vocabulary does not contain is reported separately rather than guessed at.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]

# A mnemonic must look like one before it is allowed into the vocabulary; this
# keeps Ghidra's FUN_/DAT_/LAB_ auto-names and single letters out.
MNEMONIC_SHAPE = re.compile(r"^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$")

# Seventeen XDF titles carry a human-readable alias in brackets, e.g.
# "KF_TZ_GRUND (Map_Ignition_Ground)".  The factory documents use the bare
# mnemonic, and five of the seventeen are ignition maps the Funktionsrahmen
# names directly, so both spellings have to be indexed.  No two titles share a
# base name, so stripping is unambiguous.
PARENTHETICAL = re.compile(r"\s*\([^()]*\)\s*$")


def base_name(name: str) -> str:
    return PARENTHETICAL.sub("", name).strip()
SIGNAL_SHAPE = re.compile(r"^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$")
AUTO_PREFIXES = ("FUN_", "DAT_", "LAB_", "SUB_", "UNK_", "SWITCH_", "caseD_")


def _add(target: set[str], name: str, shape: re.Pattern) -> None:
    for candidate in {name.strip(), base_name(name)}:
        if len(candidate) < 4 or candidate.startswith(AUTO_PREFIXES):
            continue
        if shape.match(candidate):
            target.add(candidate)


def build(build_dir: Path | None = None) -> dict[str, set[str]]:
    build_dir = build_dir or REPO / "build"
    mnemonics: set[str] = set()
    signals: set[str] = set()
    from_xdf: set[str] = set()

    params_path = build_dir / "params.json"
    if params_path.exists():
        for p in json.loads(params_path.read_text())["params"]:
            name = p["name"]
            from_xdf.add(name)
            _add(mnemonics, name, MNEMONIC_SHAPE)
            _add(signals, name, SIGNAL_SHAPE)

    for bank in ("master", "slave"):
        path = build_dir / f"ghidra_{bank}.json"
        if not path.exists():
            continue
        data = json.loads(path.read_text())
        for s in data["symbols"]:
            _add(mnemonics, s["name"], MNEMONIC_SHAPE)
            _add(signals, s["name"], SIGNAL_SHAPE)
        for f in data["functions"]:
            _add(mnemonics, f["name"], MNEMONIC_SHAPE)
            _add(signals, f["name"], SIGNAL_SHAPE)

    return {"mnemonics": mnemonics, "signals": signals, "xdf": from_xdf}


def compile_scanner(names: set[str]) -> re.Pattern:
    """Longest-match alternation over ``names``.

    Python's ``re`` alternation is first-match-wins, so ordering by descending
    length makes the scan prefer ``KL_TZ_START_TMOT`` over ``KL_TZ_START``.
    """
    ordered = sorted(names, key=len, reverse=True)
    return re.compile("|".join(re.escape(n) for n in ordered))


def drop_concatenations(learned: set[str], known: set[str]) -> tuple[set[str], set[str]]:
    """Remove learned tokens that are just two or more other names run together.

    Pass 1 treats any whitespace-delimited token as a name, but the diagrams
    sometimes place a whole row of labels with no gap at all, producing tokens
    like ``B_AFRB_LLR_HALTB_IA1B_IA2K_LLR_TAU_IA1KL_LLR_DQP_POS``.  A token that
    can be segmented end to end into two or more *other* vocabulary entries is
    such an artefact, not a name.
    """
    vocab = known | learned
    kept: set[str] = set()
    dropped: set[str] = set()

    for token in learned:
        pieces = vocab - {token}
        # Reachable[i] is True when token[:i] is a concatenation of pieces.
        reachable = [False] * (len(token) + 1)
        reachable[0] = True
        parts = [0] * (len(token) + 1)
        for i in range(len(token)):
            if not reachable[i]:
                continue
            for j in range(i + 2, len(token) + 1):
                if token[i:j] in pieces and (not reachable[j] or parts[j] > parts[i] + 1):
                    reachable[j] = True
                    parts[j] = parts[i] + 1
        if reachable[len(token)] and parts[len(token)] >= 2:
            dropped.add(token)
        else:
            kept.add(token)
    return kept, dropped
