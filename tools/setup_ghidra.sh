#!/usr/bin/env bash
#
# Prepare a Ghidra install that can open MSS54_Disassembly_2025_09_16.gar.
#
# The archive stores languageID "68000:BE:32:CPU32" at language version 1.1,
# written by Ghidra 11.2.1.  CPU32 support was merged upstream in June 2026
# (milestone 12.1.3) but is NOT in any public release yet - 12.1.2 is the
# newest - so a released Ghidra has to be topped up with the four 68000
# language files from upstream master, which declare the very same
# id/version pair.  Only SLEIGH sources change, so `support/sleigh` recompiles
# them in seconds; a Gradle build of Ghidra is not needed.
#
#   ./tools/setup_ghidra.sh [--ghidra DIR]
#
set -euo pipefail

GHIDRA_DIR="${GHIDRA_DIR:-/home/user/ghidra-dist/ghidra_12.1.2_PUBLIC}"
UPSTREAM_RAW="https://raw.githubusercontent.com/NationalSecurityAgency/ghidra/master"
LANG_REL="Ghidra/Processors/68000/data/languages"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ghidra) GHIDRA_DIR="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

LANG_DIR="$GHIDRA_DIR/$LANG_REL"
MODULE_DIR="$GHIDRA_DIR/Ghidra/Processors/68000"

[[ -d "$LANG_DIR" ]] || { echo "no 68000 language dir at $LANG_DIR" >&2; exit 1; }

echo "== Ghidra: $GHIDRA_DIR"
grep -m1 '^application.version' "$GHIDRA_DIR/Ghidra/application.properties" || true

# ---------------------------------------------------------------- fetch ----
if grep -q '68000:BE:32:CPU32' "$LANG_DIR/68000.ldefs" 2>/dev/null; then
  echo "== CPU32 already declared; skipping download"
else
  echo "== fetching CPU32 language files from upstream master"
  for f in CPU32.slaspec 68000.sinc 68000.ldefs; do
    [[ -f "$LANG_DIR/$f.orig" ]] || \
      { [[ -f "$LANG_DIR/$f" ]] && cp "$LANG_DIR/$f" "$LANG_DIR/$f.orig"; }
    curl -sSfL --retry 4 --retry-delay 2 -o "$LANG_DIR/$f" "$UPSTREAM_RAW/$LANG_REL/$f"
    echo "   $f  ($(wc -c <"$LANG_DIR/$f") bytes)"
  done

  # The build enforces that every data file is listed in certification.manifest.
  MANIFEST="$MODULE_DIR/certification.manifest"
  if [[ -f "$MANIFEST" ]] && ! grep -q 'CPU32.slaspec' "$MANIFEST"; then
    echo "data/languages/CPU32.slaspec||GHIDRA||||END|" >> "$MANIFEST"
    echo "   certification.manifest += CPU32.slaspec"
  fi
fi

# -------------------------------------------------------------- verify ----
echo "== verifying the language declaration"
python3 - "$LANG_DIR/68000.ldefs" <<'PY'
import re, sys, xml.etree.ElementTree as ET
root = ET.parse(sys.argv[1]).getroot()
langs = {l.get("id"): l.get("version") for l in root.iter("language")}
for lid, ver in sorted(langs.items()):
    print(f"   {lid}  version={ver}")
want = "68000:BE:32:CPU32"
if want not in langs:
    sys.exit(f"FAIL: {want} missing from 68000.ldefs")
if langs[want] != "1.1":
    sys.exit(f"FAIL: {want} is version {langs[want]}, the .gar needs 1.1")
print(f"   OK: {want} at version {langs[want]} matches the archive")
PY

# ------------------------------------------------------------- compile ----
echo "== compiling SLEIGH for the 68000 module"
"$GHIDRA_DIR/support/sleigh" -a "$LANG_DIR" 2>&1 | tail -20

for sla in CPU32 68020 68030 68040 coldfire; do
  if [[ -f "$LANG_DIR/$sla.sla" ]]; then
    printf '   %-10s %s bytes\n' "$sla.sla" "$(wc -c <"$LANG_DIR/$sla.sla")"
  else
    echo "   MISSING $sla.sla" >&2
  fi
done

[[ -f "$LANG_DIR/CPU32.sla" ]] || { echo "FAIL: CPU32.sla was not produced" >&2; exit 1; }

# ------------------------------------------------------------- pyghidra ----
WHEEL=$(ls "$GHIDRA_DIR"/Ghidra/Features/PyGhidra/pypkg/dist/pyghidra-*.whl 2>/dev/null | head -1 || true)
if [[ -n "$WHEEL" ]]; then
  echo "== PyGhidra wheel: $WHEEL"
else
  echo "== WARNING: no PyGhidra wheel found under $GHIDRA_DIR" >&2
fi

echo "== done.  export GHIDRA_INSTALL_DIR=$GHIDRA_DIR"
