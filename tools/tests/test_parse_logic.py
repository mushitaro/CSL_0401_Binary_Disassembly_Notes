"""Regression tests for recovering formulas from decompiled C.

`tz_calc` is the reference case: it folds temporaries, selects one of three
maps by operating state, and mixes map and curve interpolation in one
expression. Getting it right exercises everything the block diagram depends on.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "tools" / "pipeline"))

import parse_logic  # noqa: E402

TZ_CALC = """
void tz_calc(void)

{
  short sVar3;
  short sVar4;
  undefined4 uVar1;
  int iVar2;
  KF_18x3_2byte_2byte_2byte *table;

  if ((ZUSTAND_MOTOR & (Nachlauf|KI.15 aus|Start|S)) == 0) {
    if ((ZUSTAND_MOTOR & VL) == 0) {
      if ((ZUSTAND_MOTOR & LL) == 0) {
        table = (KF_18x3_2byte_2byte_2byte *)&KF_TZ_GRUND;
      }
      else {
        table = (KF_18x3_2byte_2byte_2byte *)&KF_TZ_LL;
      }
    }
    else {
      table = &KF_TZ_VL;
    }
    uVar1 = kfs_wint(&table->sizeX,N,RF);
    TZ_GRUND = (short)uVar1;
  }
  else {
    sVar3 = kls_wint(&KL_TZ_START_TMOT.sizeX,(ushort)TMOT);
    sVar4 = kls_wint(&KL_TZ_START_N.sizeX,N);
    TZ_GRUND = sVar3 + sVar4;
  }
  TZ_ETA_BASIS = TZ_TKORR + TZ_GRUND;
  sVar3 = kls_wint(&KL_TZ_MIN_TMOT.sizeX,(ushort)TMOT);
  uVar1 = kfs_wint(&KF_TZ_MIN.sizeX,N,RF);
  TZ_MIN = sVar3 + (short)uVar1;
  iVar2 = tz_sa_calc();
  TZ_SA_OFFSET = (short)iVar2;
  return;
}
"""


@pytest.fixture(scope="module")
def tz():
    statements = parse_logic.extract(TZ_CALC)
    return {s.output: s for s in statements}, statements


def test_every_assignment_is_recovered(tz):
    _by_out, statements = tz
    outputs = [s.output for s in statements]
    # TZ_GRUND is assigned on both arms of the outer branch.
    assert outputs == [
        "TZ_GRUND", "TZ_GRUND", "TZ_ETA_BASIS", "TZ_MIN", "TZ_SA_OFFSET",
    ]


def test_temporaries_are_folded_away(tz):
    """No uVar/sVar/iVar may survive into a formula the reader sees."""
    _by_out, statements = tz
    for s in statements:
        assert "Var" not in s.expression, s.expression
        assert "table" not in s.expression, s.expression


def test_branch_alternatives_are_kept(tz):
    """The map is chosen by operating state; all three must be visible."""
    _by_out, statements = tz
    first = statements[0]
    assert first.expression == "kfs_wint({KF_TZ_GRUND | KF_TZ_LL | KF_TZ_VL},N,RF)"
    assert first.interpolations[0]["shape"] == "map"
    assert first.interpolations[0]["tables"] == [
        "KF_TZ_GRUND", "KF_TZ_LL", "KF_TZ_VL",
    ]
    assert first.interpolations[0]["axes"] == ["N", "RF"]
    assert {"KF_TZ_GRUND", "KF_TZ_LL", "KF_TZ_VL", "N", "RF"} <= set(first.reads)


def test_bitwise_and_survives_cleaning(tz):
    """"ZUSTAND_MOTOR & VL" must not lose its operator to address-of stripping."""
    _by_out, statements = tz
    guards = " ".join(g for s in statements for g in s.guards)
    assert "ZUSTAND_MOTOR & (Nachlauf|KI.15 aus|Start|S)" in guards
    assert "ZUSTAND_MOTOR VL" not in guards


def test_guards_do_not_leak_past_their_branch(tz):
    """Statements after the if/else chain are unconditional."""
    by_out, _statements = tz
    assert by_out["TZ_ETA_BASIS"].guards == []
    assert by_out["TZ_MIN"].guards == []
    assert by_out["TZ_SA_OFFSET"].guards == []


def test_two_curves_in_one_expression(tz):
    _by_out, statements = tz
    start = statements[1]
    assert start.guards == ["otherwise"]
    shapes = [i["shape"] for i in start.interpolations]
    assert shapes == ["curve", "curve"]
    assert {i["tables"][0] for i in start.interpolations} == {
        "KL_TZ_START_TMOT", "KL_TZ_START_N",
    }


def test_mixed_map_and_curve(tz):
    by_out, _statements = tz
    shapes = sorted(i["shape"] for i in by_out["TZ_MIN"].interpolations)
    assert shapes == ["curve", "map"]


def test_calls_to_other_blocks_are_recorded(tz):
    by_out, _statements = tz
    assert by_out["TZ_SA_OFFSET"].calls == ["tz_sa_calc"]


# --------------------------------------------------------------------------- #


def test_locals_are_taken_from_the_declaration_block():
    """A renamed local such as `curve` must not leak into a formula."""
    code = """
void demo(void)

{
  KL_10_2byte_2byte *curve;
  ushort uVar1;

  curve = &KL_MD_BEGR_FST;
  uVar1 = klu_wint(&curve->sizeX,N);
  MD_BEGR_AUSS = uVar1;
  return;
}
"""
    statements = parse_logic.extract(code)
    assert len(statements) == 1
    assert statements[0].output == "MD_BEGR_AUSS"
    assert statements[0].expression == "klu_wint(KL_MD_BEGR_FST,N)"
    assert statements[0].interpolations[0]["shape"] == "curve"


@pytest.mark.parametrize(
    "helper,shape",
    [
        ("kfs_wint", "map"),
        ("kfu_wint", "map"),
        ("kfu_bint", "map"),
        ("kls_wint", "curve"),
        ("klu_wint", "curve"),
        ("klu_bint", "curve"),
        ("tableLookup", "table"),
        ("PT1_Filter_US", "filter"),
        ("IIR_Filter_US", "filter"),
    ],
)
def test_helper_naming_scheme(helper, shape):
    """kf/kl = Kennfeld/Kennlinie, s/u = signed/unsigned, w/b = word/byte."""
    assert parse_logic.classify_helper(helper)["shape"] == shape


def test_non_helper_calls_are_not_lookups():
    assert parse_logic.classify_helper("tz_sa_calc") is None
    assert parse_logic.classify_helper("ed_report") is None
