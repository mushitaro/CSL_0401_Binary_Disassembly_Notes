"""Regression tests for the Funktionsrahmen extraction.

The expectations were read off the "8.1 Zündung" structure diagrams by hand
before the parser existed.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "tools" / "pipeline"))

FR_JSON = REPO / "build" / "funktionsrahmen.json"

pytestmark = pytest.mark.skipif(
    not FR_JSON.exists(), reason="run tools/pipeline/parse_fr.py first"
)


@pytest.fixture(scope="module")
def fr():
    data = json.loads(FR_JSON.read_text())
    return data, {d["section"]: d for d in data["documents"]}


def test_all_39_documents_are_paired_german_and_english(fr):
    data, by_section = fr
    assert data["stats"]["documents"] == 39
    assert data["stats"]["germanOnly"] == []
    assert data["stats"]["englishOnly"] == []
    for doc in data["documents"]:
        assert doc["pathDe"], f"{doc['section']} has no German original"
        assert doc["pathEn"], f"{doc['section']} has no English translation"
        # Mnemonics must never be taken from the machine-translated edition.
        assert doc["textSource"] == "de"


def test_sections_pair_by_number_not_by_title(fr):
    """Titles differ wildly and two German files share one title."""
    _data, by_section = fr
    assert by_section["8.1"]["titleDe"] == "Modulbeschreibung Zundung"
    assert by_section["8.1"]["titleEn"] == "Ignition"
    assert by_section["3.02"]["titleDe"] == "Modulbeschreibung"
    assert by_section["7.05"]["titleDe"] == "Modulbeschreibung"
    assert by_section["3.02"]["titleEn"] == "EDK"
    assert by_section["7.05"]["titleEn"] == "Overrun Cutoff:Restart"


def test_ignition_document_yields_its_structure_diagram_names(fr):
    """Every name hand-read off the 8.1 diagrams must survive extraction."""
    _data, by_section = fr
    doc = by_section["8.1"]
    expected = {
        "KF_TZ_GRUND", "KF_TZ_LL", "KF_TZ_VL", "KF_TZ_MIN", "KF_TZ_SZ",
        "KL_TZ_START_N", "KL_TZ_START_TMOT", "KL_TZ_LL", "KL_TZ_PHASE",
        "B_EVT", "B_LL", "B_TL", "B_VL", "B_ZWB1", "B_ZWB2", "B_ZWB3",
        "K_TZ_MAX", "K_TZ_MCS", "K_ZWD", "MD_TZ",
    }
    assert expected <= set(doc["mnemonics"])
    assert len(doc["mnemonics"]) >= 50


def test_basic_ignition_page_reproduces_one_functional_block(fr):
    """Page 6 is the basic-ignition-angle block; it must come out intact."""
    _data, by_section = fr
    page6 = next(p for p in by_section["8.1"]["pages"] if p["page"] == 6)
    assert set(page6["mnemonics"]) == {
        "B_EVT", "B_LL", "B_TL", "B_VL",
        "KF_TZ_GRUND", "KF_TZ_LL", "KF_TZ_VL",
        "KL_TZ_START_N", "KL_TZ_START_TMOT",
    }
    assert "tz_grund" in page6["signals"]
    assert "tz_bas" in page6["signals"]


def test_temperature_correction_page_follows_the_basic_block(fr):
    _data, by_section = fr
    page7 = next(p for p in by_section["8.1"]["pages"] if p["page"] == 7)
    assert {"KL_TZ_TKORR_LL", "KL_TZ_TKORR_TL"} <= set(page7["mnemonics"])
    assert "tz_tkorr" in page7["signals"]


def test_two_pass_learning_beats_the_data_vocabulary_alone(fr):
    """B_* conditions exist only in the documents, never in the XDF or Ghidra."""
    data, by_section = fr
    assert data["stats"]["learnedMnemonics"] > 300
    assert data["stats"]["learnedSignals"] > 300
    # A concrete example of something only the documents know about.
    assert "B_ZWB1" in by_section["8.1"]["mnemonics"]


def test_corpus_scale(fr):
    data, _by_section = fr
    assert data["stats"]["totalPages"] == 448
    assert data["stats"]["uniqueMnemonics"] > 1000
    assert data["stats"]["uniqueSignals"] > 700
