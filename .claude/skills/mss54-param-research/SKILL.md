---
name: mss54-param-research
description: >-
  Investigate MSS54 / MSS54HP DME calibration parameters for the BMW E46 M3 CSL
  '0401' binary — which parameter controls a behaviour, what a change would do,
  which addresses to edit, and what to datalog to prove it. Use this whenever the
  user asks about DME/ECU tuning, a calibration parameter, a map or curve
  (KF_/KL_/K_ names), an XDF address, engine behaviour they want to change (idle,
  overrun, tip-in, misfire, rev limiter, VANOS, lambda, throttle), the effect of a
  hardware change on the tune (flywheel, clutch, cams, airbox, exhaust, injectors),
  or what to log over DS2 — even if they never say "parameter" or name a file.
  Also use it for any question of the form "why does the car do X" about this
  engine, and before editing or citing docs/ research notes in this repository.
---

# MSS54HP '0401' calibration parameter research

## What you are working with

Three sources are already joined in this repository, so the answer to almost any
parameter question is a query away rather than a research project:

| Source | What it gives |
|---|---|
| `XDF/CSL_0401_Karter16_v3_6_publish.xdf` | 2,529 parameters: names, addresses, scaling, axes |
| `app/public/data/graph.json` | the join — XDF + Ghidra decompilation + Funktionsrahmen, 8,289 nodes / 27,620 edges, 534 blocks with recovered formulas |
| `MSS54 Funktionsrahmen/Original (German)/` | 39 factory function specs. The German original is authoritative; the English is machine-translated |

`docs/PARAMETER_TREE.md` documents how the join was built and its measured
coverage (86.5% of parameters have a code reference; 23.1% appear in the factory
docs). Read `references/sources.md` for provenance details and the pitfalls of
each source.

## The address rule

Everything depends on this one conversion, so get it right before anything else:

```
file offset = 0x88000 + (XDF address mod 0x8000)
```

The XDF is a 32 KB window shared by two CPUs: **slave `0x0000–0x7FFF`, master
`0x8000–0xFFFF`**. A slave parameter and a master parameter therefore land on the
same file offset — `KF_AR_MD` (slave `0x112A`) and `KF_MD_MIN_BRENN` (master
`0x912A`) both sit at `0x8912A`. That is expected, not a bug, but it means the
bank must always travel with the address. Quote both forms in every answer.

## Tools

`scripts/q.py` queries the graph. Run it with `python3`; it finds `graph.json`
relative to the repository, or takes `--graph PATH`.

```bash
python3 .claude/skills/mss54-param-research/scripts/q.py <command> <args>
```

| Command | Use it to |
|---|---|
| `catof <regex>` | **start here** — sweep a whole functional area by category, rather than guessing names |
| `params <regex> [--full]` | look up parameters; `--full` decodes every axis and table cell |
| `dead [regex]` | **run this early** — find calibration that cannot do anything (see traps) |
| `consumers <NAME>` | who reads it, and whether the mechanism is actually recovered — this sets the evidence grade |
| `enc <NAME> <value>...` | can that value even be written? raw, range, quantisation, nearest representable |
| `show <NAME>` | full dump of a parameter, or a function's recovered statements |
| `code <regex>` | search recovered statements for a signal, helper or constant |
| `func <regex>` | find functions; flags `stmts=0` |
| `desc` / `edges` / `ram` / `cats` | descriptions, graph edges, RAM symbols, category list |

`scripts/verify_doc.py DOC.md` re-checks every parameter row in a finished
document against the real data. Run it before showing the user anything.

## How to run an investigation

Scale this to the question. A single "what does `K_X` do?" needs steps 3–5 only.
A full behavioural question ("make the car smoother after a flywheel change")
needs all of it.

**1. State the physics first, when hardware changed.** If the question involves a
mechanical change, work out which control loops it disturbs and why *before*
touching the parameter list. Otherwise you produce a list of plausible-looking
parameters with no argument connecting them to the symptom. Quantify it: a lighter
flywheel raises every speed gradient as `dω/dt = M_net / J`, so the loop gain
rises while every lag (task period, filter time constants, transport delay) stays
put — gain up, phase margin down. That sentence is what makes the parameter list
mean something.

**2. Survey by category, not by guessing names.** `q.py cats` lists 71 functional
categories (Leerlaufregelung, Antiruckelfunktion, Aussetzerkennung, SA_WE,
Momentenmanager …). `q.py catof <regex>` then gives you every parameter in that
area. Guessing prefixes misses things; the categories are the factory's own
partition of the ECU.

**3. Check whether the path is alive — before forming any recommendation.**
Run `q.py dead`. This repository's calibration contains ~100 inert items, and
advising a change to one of them is worthless advice that reads as authoritative.
See the traps section below.

**4. Recover the mechanism.** `q.py show <function>` prints the decompiled
statements with their guards. `q.py code <regex>` finds where a signal is written
or read. Give the actual formula in the answer — `SA_N40 = SA_N40_HYST_GANG +
K_SA_N40_HYS + SA_N40_WIEDEREINSETZEN` tells a tuner far more than a description
does. Where the binary and the Funktionsrahmen disagree, the binary wins.

**5. Grade every claim.** Run `q.py consumers <NAME>`. Use four grades, and put
the grade in the output:

| Grade | Means |
|---|---|
| `code-confirmed` | the name appears in a recovered statement or guard |
| `xref-only` | Ghidra proves the function reads it, but no statement was recovered — you know **where** it matters, not **how** |
| `funktionsrahmen-only` | only the factory doc describes it; the direction could be wrong |
| `inference` | deduced from name, units, table shape or neighbouring addresses |

The `xref-only` grade is the one that keeps you honest. A function can have
`stmts=0` and still be the right function; `q.py consumers` and `q.py show` both
flag it. Never let an `xref-only` mechanism be presented as established.

**6. Check the number is writable.** Before recommending "change A to B", run
`q.py enc <NAME> <B>`. It reports the raw value, the writable range, the
quantisation step and the nearest representable value.

**7. Verify adversarially.** On any substantial investigation, have the findings
re-checked against the data by a fresh pass whose job is to refute them — the
default assumption being that something is wrong. In the investigation this skill
came from, that pass found errors in roughly a third of first-pass findings,
including several sign inversions and two headline conclusions that were exactly
backwards. Verification is not optional polish; it is where the accuracy comes
from. `references/accuracy.md` has the checklist.

**8. Verify mechanically.** Run `scripts/verify_doc.py` on the finished document.
Prose can be argued about; an address cannot.

## The four traps

These caused every serious error in the investigation this skill is distilled
from. `references/accuracy.md` has worked examples of each.

**Inert paths.** A parameter can be perfectly named, perfectly scaled and
completely unable to affect anything, because an enable byte is `0`, its table is
all zeros, or its consumer compares against a rail no signal reaches. The clearest
case: `K_MD_J_MOTOR` (`0x9554`) is the ECU's only engine-inertia constant and
looks like *the* flywheel parameter — but its only consumer is `md_max_begr`,
whose other term `KL_MD_BEGR_GANG` is flat 1000 Nm, far above anything the engine
makes. The path is dead. `q.py dead` finds these in one command.

**Unwritable values.** `K_WE_DN40_HARD` is an 8-bit signed byte scaled `x*40`, so
its most negative writable value is `-5120 rpm/s`; a recommendation of `-8000`
cannot be flashed. Unsigned lookups (`klu_bint`) cannot hold negatives at all, and
a table quantised `x/10` cannot express `0.55`. Always run `q.py enc`.

**`stmts=0`.** An xref proves a function reads a constant. It does not tell you
what the function does with it. Several functions central to drivability
(`FUN_00017052`, the Lastschlag/dashpot filter; `FUN_00023a3a`, the EDK position
loop) have zero recovered statements, so everything said about their mechanism is
`funktionsrahmen-only` or `inference`.

**Value provenance.** Values in `graph.json` are decoded from
`Full 211323000401PD31_TERRA.bin` (see `tools/pipeline/parse_xdf.py`), while the
XDF's own text references `211325000401PD11`, and the user's car is a Community
Patch derivative. Addresses, scaling and logic are common to program 0401 and
transfer; **numbers do not**. Say which image the values came from and tell the
user to read their own BIN before editing.

## Datalogging

The car is measured over DS2, and what is loggable is fixed: eight live-value
blocks defined in `DmeLiveValueCatalog.cs` in the user's MSS54 DS2 tool. Block 83
(EGAS) carries most of what drivability work needs — `d_n40`, `md_dyn_st`,
`sa_we_st`, `d_pwg`, `d_wdk`, `md_ind_wunsch`, `md_ind_ne`, `gang`, `s_krafts`.

Be straight about resolution. DS2 is request/response over a slow serial link, so
polling more blocks divides the rate; `d_n40` quantises at 40 rpm/s per bit; and a
4–10 Hz driveline torsional oscillation is at or past the Nyquist limit — it
cannot be measured this way, and saying so is more useful than a plan that
silently aliases. Read `references/datalog.md` before writing a log strategy.

## Reporting

Lead with the answer, then the evidence. For a parameter table use exactly these
columns — `verify_doc.py` checks this order, and a consistent shape lets the user
compare documents across investigations:

```
| パラメータ定義名 | 種別 | XDFアドレス | ファイルオフセット | bank | 現在値 | 単位 | 役割 | 変更方向・量 | リスク | 根拠 |
```

(`種別` = constant/curve/map; `根拠` = the evidence grade from step 5.)

Include the parameters that must **not** be changed, with the reason — safety
concept, emissions monitor, engine protection, or an adjacent address that is easy
to hit by mistake. Readers reach for those first, so naming them is part of the
job, not a disclaimer.

Give directions with magnitudes and raw values (`0.4 → 0.6 (raw 6); 0.55 は 0.1
刻みで表現不能`), and state the failure mode if the change goes too far. End with
what you could **not** establish. That section is load-bearing: it is how the
reader knows where the analysis stops and their own judgement starts.

Write in the user's language (Japanese in this repository), keeping all parameter
names, signal symbols, function names and addresses in ASCII.

## Reference files

- `references/sources.md` — the three sources, their coverage and quirks, how to read the Funktionsrahmen PDFs, how to regenerate the graph
- `references/accuracy.md` — evidence grading, the four traps with worked examples, the adversarial verification checklist
- `references/datalog.md` — the eight DS2 blocks, the channels that matter, sample-rate reality, named log sets

## Worked example

`docs/lightweight_flywheel_tuning.md` is a full investigation produced with this
method: a hardware change traced through seven control domains, 331 verified
parameter rows, evidence grades throughout, and an explicit list of what could not
be established. Use it as the shape to aim for — including its habit of naming the
things that are *not* the answer, which is usually the most valuable part for a
reader who has already formed a theory.
