#!/usr/bin/env bash
#
# Regenerate app/public/data from the sources in this repository.
#
#   ./tools/setup_ghidra.sh                 # once: Ghidra + CPU32
#   export GHIDRA_INSTALL_DIR=/path/to/ghidra_12.1.2_PUBLIC
#   ./tools/run_pipeline.sh
#
# Stages 1, 3 and 4 need no Ghidra; only stage 2 does.
set -euo pipefail
cd "$(dirname "$0")/.."

PY=${PY:-.venv/bin/python}
[[ -x "$PY" ]] || { echo "create a venv first: python3 -m venv .venv && .venv/bin/pip install -r tools/requirements.txt" >&2; exit 1; }

echo "== 1/4  XDF -> build/params.json"
PYTHONPATH=tools/pipeline "$PY" tools/pipeline/parse_xdf.py

if [[ -n "${GHIDRA_INSTALL_DIR:-}" ]]; then
  echo "== 2/4  Ghidra -> build/ghidra_{master,slave}.json"
  [[ -d /home/user/mss54-ghidra ]] || "$PY" tools/export/restore_gar.py
  "$PY" tools/export/export_relations.py --decompile
else
  echo "== 2/4  skipped (GHIDRA_INSTALL_DIR unset); reusing any existing export"
fi

echo "== 3/4  Funktionsrahmen -> build/funktionsrahmen.json"
PYTHONPATH=tools/pipeline "$PY" tools/pipeline/parse_fr.py

echo "== 4/4  join -> app/public/data/graph.json"
"$PY" tools/pipeline/build_graph.py

echo
echo "done.  cd app && npm ci && npm run dev"
