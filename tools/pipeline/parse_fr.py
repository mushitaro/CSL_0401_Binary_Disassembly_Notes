"""Extract the factory Funktionsrahmen documents into a searchable index.

Each document describes one functional block of the MSS54 control software, and
the Strukturbild diagrams name the maps, curves, constants and signals that feed
each computation.  Those labels come out as ordinary text, so a page yields the
set of mnemonics the factory says belong together - which is a second, entirely
independent view of parameter relationships next to Ghidra's cross-references.

Two editions of every document are present and they are not equivalent:

German original
    Born-digital Microsoft Word 2013 PDFs.  No raster images, embedded fonts,
    no OCR involved.  **This is the authority for mnemonics.**  Note that the
    text is emitted as ``TJ`` arrays, so a naive ``Tj``-only scraper returns
    nothing at all from these files.

English translation
    The scanned page as a JPEG with a Google-Translate text layer on top
    (Producer: PDFium, watermarked "Machine Translated by Google").  Useful for
    reading prose, but it carries OCR damage such as ``ZWB______8``, so it is
    never used as a mnemonic source.

The two editions are paired by their leading section number, never by filename:
``8.1 Modulbeschreibung Zundung.pdf`` is the counterpart of ``8.1 Ignition.pdf``,
and the German side has two files both titled merely ``Modulbeschreibung.pdf``.
"""

from __future__ import annotations

import argparse
import json
import collections
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

from pdfminer.high_level import extract_text
from pdfminer.layout import LAParams

import vocabulary

REPO = Path(__file__).resolve().parents[2]
FR_ROOT = REPO / "MSS54 Funktionsrahmen"
GERMAN_DIR = FR_ROOT / "Original (German)"
ENGLISH_DIR = FR_ROOT / "Translated (English)"

# Leading "8.1", "5.04", "6" of a filename.
SECTION_RE = re.compile(r"^\s*(\d+(?:\.\d+)?)\s+(.*?)\.pdf$", re.IGNORECASE)

# Names are recognised by longest match against a vocabulary - see
# vocabulary.py for why a regex over name *shapes* cannot work on this text.
#
# The vocabulary is learned in two passes.  The XDF titles and Ghidra symbols
# alone are not enough: the factory documents name plenty of quantities that
# never became a calibration item or a Ghidra label, especially the B_* boolean
# conditions (B_LL, B_TL, B_SA) and signals that live only on a diagram wire.
#
# Pass 1 collects every token that appears at least once delimited by
# whitespace, where greedy matching is unambiguous and therefore safe.  Pass 2
# rescans with the enlarged vocabulary, which lets the same names be recovered
# from the glued runs as well.
STANDALONE_MNEMONIC_RE = re.compile(r"^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$")
STANDALONE_SIGNAL_RE = re.compile(r"^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$")

# Artefacts of the translated PDFs and of Word's own boilerplate.
LEARN_STOPWORDS = {
    "machine_translated", "module_description", "modul_beschreibung",
    "projekt_mss54", "seite_von", "page_of",
}


@dataclass
class Document:
    section: str
    title_de: str | None = None
    title_en: str | None = None
    path_de: str | None = None
    path_en: str | None = None
    pages: list[dict] = field(default_factory=list)
    mnemonics: set[str] = field(default_factory=set)
    signals: set[str] = field(default_factory=set)
    text_source: str | None = None
    note: str | None = None


def _sections(directory: Path) -> dict[str, tuple[str, Path]]:
    out: dict[str, tuple[str, Path]] = {}
    for pdf in sorted(directory.glob("*.pdf")):
        m = SECTION_RE.match(pdf.name)
        if not m:
            print(f"warning: cannot read a section number from {pdf.name}")
            continue
        out[m.group(1)] = (m.group(2).strip(), pdf)
    return out


def _pages(pdf: Path) -> list[str]:
    """Per-page text.  pdfminer handles both TJ arrays and ToUnicode maps."""
    laparams = LAParams()
    text = extract_text(str(pdf), laparams=laparams)
    return text.split("\f")


def _learn(pages: list[str]) -> tuple[set[str], set[str]]:
    """Pass 1: names that appear at least once whitespace-delimited."""
    mnemonics: set[str] = set()
    signals: set[str] = set()
    for raw in pages:
        for token in re.split(r"[^A-Za-z0-9_]+", raw):
            if len(token) < 4 or token in LEARN_STOPWORDS:
                continue
            if STANDALONE_MNEMONIC_RE.match(token):
                mnemonics.add(token)
            elif STANDALONE_SIGNAL_RE.match(token):
                signals.add(token)
    return mnemonics, signals


def _harvest(
    pages: list[str],
    mnemonic_scanner: re.Pattern,
    signal_scanner: re.Pattern,
) -> tuple[list[dict], set[str], set[str]]:
    page_records: list[dict] = []
    all_mnemonics: set[str] = set()
    all_signals: set[str] = set()

    for index, raw in enumerate(pages, start=1):
        text = raw.strip()
        if not text:
            continue
        mnemonics = sorted(set(mnemonic_scanner.findall(text)))
        signals = sorted(set(signal_scanner.findall(text)))
        all_mnemonics.update(mnemonics)
        all_signals.update(signals)
        page_records.append(
            {
                "page": index,
                "chars": len(text),
                "mnemonics": mnemonics,
                "signals": signals,
                # Enough prose for the viewer to show context, not the whole page.
                "excerpt": " ".join(text.split())[:600],
            }
        )
    return page_records, all_mnemonics, all_signals


def build() -> tuple[list[Document], dict]:
    german = _sections(GERMAN_DIR)
    english = _sections(ENGLISH_DIR)

    vocab = vocabulary.build()
    base_mnemonics = set(vocab["mnemonics"])
    base_signals = set(vocab["signals"])
    print(
        f"vocabulary from XDF + Ghidra: {len(base_mnemonics)} mnemonics, "
        f"{len(base_signals)} signals"
    )

    sections = sorted(
        set(german) | set(english), key=lambda s: [int(x) for x in s.split(".")]
    )

    # ------------------------------------------------------------- pass 1
    page_cache: dict[str, list[str]] = {}
    learned_mnemonics: set[str] = set()
    learned_signals: set[str] = set()
    for section in sections:
        source = (
            GERMAN_DIR / Path(german[section][1]).name
            if section in german
            else ENGLISH_DIR / Path(english[section][1]).name
        )
        pages = _pages(source)
        page_cache[section] = pages
        m, s_ = _learn(pages)
        learned_mnemonics |= m
        learned_signals |= s_

    new_mnemonics = learned_mnemonics - base_mnemonics
    new_signals = learned_signals - base_signals
    new_mnemonics, glued_mnemonics = vocabulary.drop_concatenations(
        new_mnemonics, base_mnemonics
    )
    new_signals, glued_signals = vocabulary.drop_concatenations(
        new_signals, base_signals
    )
    learned_mnemonics = base_mnemonics | new_mnemonics
    learned_signals = base_signals | new_signals
    print(
        f"learned from the documents: +{len(new_mnemonics)} mnemonics, "
        f"+{len(new_signals)} signals "
        f"(discarded {len(glued_mnemonics)} + {len(glued_signals)} glued runs)"
    )

    mnemonic_scanner = vocabulary.compile_scanner(base_mnemonics | learned_mnemonics)
    signal_scanner = vocabulary.compile_scanner(base_signals | learned_signals)

    # ------------------------------------------------------------- pass 2
    docs: list[Document] = []
    for section in sections:
        doc = Document(section=section)
        if section in german:
            doc.title_de, path = german[section]
            doc.path_de = str(path.relative_to(REPO))
        if section in english:
            doc.title_en, path = english[section]
            doc.path_en = str(path.relative_to(REPO))

        # Mnemonics come from the German original wherever it exists.
        doc.text_source = "de" if doc.path_de else "en"
        if doc.text_source == "en":
            doc.note = "no German original; mnemonics taken from the OCR'd translation"

        pages, mnemonics, signals = _harvest(
            page_cache[section], mnemonic_scanner, signal_scanner
        )
        doc.pages = pages
        doc.mnemonics = mnemonics
        doc.signals = signals
        docs.append(doc)
        print(
            f"  {section:6s} {(doc.title_de or doc.title_en or '')[:44]:46s} "
            f"pages={len(pages):3d} mnemonics={len(mnemonics):4d} signals={len(signals):4d}"
        )

    stats = {
        "vocabFromDataMnemonics": len(base_mnemonics),
        "vocabFromDataSignals": len(base_signals),
        "learnedMnemonics": len(new_mnemonics),
        "learnedSignals": len(new_signals),
        "discardedGluedRuns": len(glued_mnemonics) + len(glued_signals),
        "documents": len(docs),
        "germanOnly": sorted(set(german) - set(english)),
        "englishOnly": sorted(set(english) - set(german)),
        "totalPages": sum(len(d.pages) for d in docs),
        "uniqueMnemonics": len({m for d in docs for m in d.mnemonics}),
        "uniqueSignals": len({s for d in docs for s in d.signals}),
    }
    return docs, stats


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", type=Path, default=REPO / "build" / "funktionsrahmen.json")
    args = ap.parse_args(argv)

    docs, stats = build()

    payload = {
        "stats": stats,
        "documents": [
            {
                "section": d.section,
                "titleDe": d.title_de,
                "titleEn": d.title_en,
                "pathDe": d.path_de,
                "pathEn": d.path_en,
                "textSource": d.text_source,
                "note": d.note,
                "mnemonics": sorted(d.mnemonics),
                "signals": sorted(d.signals),
                "pages": d.pages,
            }
            for d in docs
        ],
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(payload, ensure_ascii=False))

    print()
    for key, value in stats.items():
        print(f"{key:16s}: {value}")
    print(f"wrote {args.out} ({args.out.stat().st_size/1e6:.1f} MB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
