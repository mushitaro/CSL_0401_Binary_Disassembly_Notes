# The three sources, and what each one can and cannot tell you

## 1. The XDF — `XDF/CSL_0401_Karter16_v3_6_publish.xdf`

2,529 parameters with names, addresses, scaling maths, axis definitions and
categories. This is the naming authority: if a name is not here, it is not an
editable calibration parameter (it may still be a RAM signal or a function).

What it cannot tell you: how parameters relate to each other, or whether a
parameter does anything.

**Scaling expressions** are small arithmetic strings evaluated on the raw value:
`x`, `x/10`, `x*40`, `x-48`, `x*0.0078125`, `5.12/x`, `1310/x`, `x/(10*16)`,
`x*100/250`, `x/256/16.384`, `x*(-40)`. Note the reciprocal forms — for
`5.12/x`, a *larger* raw means a *shorter* time, which inverts the direction of
every recommendation. `q.py enc` handles the inversion for you.

**Temperature** is almost always `x-48` in °C. **N40**-style rpm fields are
`x*40` (40 rpm per count), and their gradient siblings are `x*40` rpm/s.

**Descriptions** are mostly boilerplate from the XDF's discovery tooling
(`HW:211 Version:… Created by find routine …`). Real prose descriptions exist for
only a minority. Do not mistake the boilerplate for documentation.

## 2. `app/public/data/graph.json` — the join

Built by `tools/pipeline/` from the XDF, a Ghidra export of the 0401 binary and
the Funktionsrahmen PDFs. Structure:

- `nodes` — 8,289. `t: "param"` (2,529) or `t: "func"` (1,705).
  - params carry `name, kind (constant|curve|map), addr, bank, units, math,
    bits, value, raw, cats, desc.en, axes.{x,y,z}` with **decoded** axis values
    and table cells.
  - funcs carry `name, id, bank, size, stmts[]` where each statement has
    `out, expr, guards[], reads[], calls[], interp[]`.
- `edges` — 27,620, each tagged with an origin: `xref` (measured from the binary),
  `scan` (an operand value matched a known calibration address — inferred, contains
  errors) and `fr` (co-occurrence on a Funktionsrahmen page — **undirected**,
  because the arrows in the factory diagrams are vector graphics and were not
  extracted).
- `categories` — 71, keyed by `id`. Note `cats` on a param holds category **ids**,
  not list indices.

**Measured coverage** (from the app's About panel, not rounded up): 2,188 of 2,529
parameters have a code reference (86.5%); 583 appear in the Funktionsrahmen
(23.1%); 644 functions are human-named and decompiled; 534 blocks have recovered
formulas.

**The `stmts=0` population matters.** 1,705 functions exist but only 644 were
decompiled, so a function can be a confirmed reader of a constant while having no
recovered statements at all. `q.py func` and `q.py show` both flag this.

**Interpolation helpers** follow a naming convention that tells you the table
shape and type: `kf` = Kennfeld (3D map), `kl` = Kennlinie (2D curve); `s`/`u` =
signed/unsigned; `w`/`b` = 16/8-bit. So `klu_bint` is an unsigned 8-bit curve
lookup — which is why it cannot return a negative value, a fact that killed one
recommendation in the flywheel investigation.

## 3. The Funktionsrahmen — `MSS54 Funktionsrahmen/Original (German)/`

39 factory module specifications. **Use the German original**; the English
directory is Google machine translation with a watermark and is unreliable for
anything load-bearing.

The PDFs have no extractable page images in this environment (`pdftoppm` is
absent), but the text extracts cleanly:

```python
import fitz                      # PyMuPDF is installed
d = fitz.open("MSS54 Funktionsrahmen/Original (German)/1.0 Momentenmanagement.pdf")
print(d[26].get_text())          # 0-based index; PDF page 27
```

`pypdf` and `pdfminer.six` are also available. The block diagrams are vector
graphics, so structure must be read from the prose, not the figures.

Each module ends with a table of applicable calibration data
("APPLIZIERBARE DATEN") giving the German meaning of each constant — often the
only place a parameter's purpose is written down. `1.0 Momentenmanagement.pdf`
p.46–47 is the torque manager's full list.

Where the factory doc and the binary disagree, **the binary wins**: the documents
cover MSS54 generally and several sections describe a different software version
(the Vmax passage on p.28 and the PD-map sections of 7.2 do not match 0401).

Graph edges of origin `fr` point at document pages, so `q.py edges <NAME>` and
`q.py consumers <NAME>` will tell you which page to open.

## Value provenance — say this in every document

`tools/pipeline/parse_xdf.py` decodes values from
`Full 211323000401PD31_TERRA.bin` by default. The XDF's own embedded text
references `211325000401PD11`. The user's own car runs a Community Patch v1
derivative with the EGT correction table zeroed.

These are three different images. Addresses, scaling, axis structure and control
logic are common to program 0401 and transfer between them. **Current values do
not.** Any document that quotes current values must say which image they came from
and tell the reader to read their own BIN before editing. Where a value looks
surprising (an all-zero curve, a flat rail), consider that it may be third-party
modification rather than a BMW decision, and say so rather than asserting intent.

## Regenerating the graph

Only needed if the binary or XDF changes:

```bash
python3 -m venv .venv && .venv/bin/pip install -r tools/requirements.txt
./tools/setup_ghidra.sh
export GHIDRA_INSTALL_DIR=/path/to/ghidra_12.1.2_PUBLIC
./tools/run_pipeline.sh
.venv/bin/python -m pytest tools/tests -q
```

Ghidra needs the CPU32 language files (`68000:BE:32:CPU32` v1.1), which are merged
upstream but not in a release; `setup_ghidra.sh` patches a public 12.1.2 build.

## Windows note

The shell here is Git Bash on Windows with a cp932 default encoding, so printing
Japanese or `°`/`±` from Python fails unless you force UTF-8:

```python
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
```

Both bundled scripts already do this.
