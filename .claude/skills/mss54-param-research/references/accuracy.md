# Getting it right

Every example here is a real error from the lightweight-flywheel investigation
(`docs/lightweight_flywheel_tuning.md`). An adversarial verification pass found
problems in roughly a third of first-pass findings — 93 issues across 277
parameter findings, plus 103 omissions. That rate is the reason this file exists.
First-pass analysis of this material is *confidently* wrong often enough that
skipping verification is not a time saving, it is a decision to publish errors.

## Evidence grading

Put the grade on every claim, and be strict about the boundary:

| Grade | Test | What you may say |
|---|---|---|
| `code-confirmed` | the name appears in a recovered statement or guard | the formula's shape |
| `xref-only` | Ghidra proves the read; no statement recovered | **where** it matters, never **how** |
| `funktionsrahmen-only` | only the factory doc describes it | the intent; direction may be wrong |
| `inference` | name, units, table shape, neighbours | a hypothesis to test |

`q.py consumers <NAME>` computes this for you and prints a verdict.

The failure mode to guard against is grade inflation: an `xref-only` mechanism
written up in the confident voice of a `code-confirmed` one. If you catch yourself
describing what a function *does* with a constant, check that you actually read a
statement saying so.

## Trap 1 — inert paths

**The symptom:** a recommendation that is perfectly researched and completely
useless, because the parameter cannot influence anything.

**Worked example.** `K_MD_J_MOTOR` (`0x9554` / file `0x09554`, master, `Nms2`, `x/268`,
0.2687) is the ECU's only explicit engine-inertia constant. For a flywheel
question it is the obvious answer. Funktionsrahmen 1.0 p.27 gives its sole use:

```
md_max_begr = ( KL_MD_BEGR_GANG(gang) + md_ind_schlepp
              + K_MD_J_MOTOR * d_n40  [when d_n40 > 0] ) / md_eta_zw_ve
```

`KL_MD_BEGR_GANG` (`0x9526`) is flat 1000 Nm across all eight gears — far above
anything the engine produces — so `md_max_begr` never binds and the whole
expression is dead calibration. Editing `K_MD_J_MOTOR` changes nothing.

**Other live instances in this binary:** `K_AR_ENABLE` = 0 gates the fully
calibrated anti-jerk function to zero output; `KL_LFR_TZ_NEG` is 16 zeros, so the
idle governor has no fast retard authority; `KL_LLS_UB_KORR` is all zeros;
`K_DYN_CONTROL` = 0; `K_MD_RES_CONTROL` = 0.

**The check:** `q.py dead` in one pass finds ~100 of these — enable-like constants
at zero, all-zero tables, and flat tables that may be rails. Run it before forming
recommendations, not after. Then confirm the specific path with
`q.py consumers <NAME>` and `q.py show <consumer-function>`.

A flat table is not automatically dead — `KL_V_MAX_GANG` flat at 285 km/h is a
real limit that simply never varies by gear. The question to answer is whether any
real signal can cross it.

## Trap 2 — unwritable values

**The symptom:** a recommendation that cannot be flashed.

**Worked examples.**
- `K_WE_DN40_HARD` is 8-bit signed scaled `x*40`, so the most negative writable
  value is raw −128 = **−5120 rpm/s**. A first-pass recommendation of −8000 to
  −10000 rpm/s was unwritable, and the whole strategy built on it collapsed.
- `KL_LLS_UB_KORR` is read by `klu_bint` — an **unsigned** 8-bit lookup. A
  proposed negative entry could not be represented at any raw value.
- `KL_MD_NBEGR_P` is quantised `x/10`, so a target of 0.55 does not exist; the
  choices are 0.5 and 0.6.

**The check:** `q.py enc <NAME> <target>` prints the raw value, the writable
physical range, the quantisation step at that point and the nearest representable
value. Run it for every number you are about to recommend. Then quote the raw
value in the report so the user can enter it directly.

Watch reciprocal scalings (`5.12/x`, `1310/x`): larger raw means smaller physical,
and the quantisation is wildly non-uniform — near raw 1 a single count moves the
value enormously, near raw 255 barely at all. `K_LFR_TAU_IA1` sits at raw 1 and
`K_LFR_TAU_IA2_KKS` at raw 255, i.e. both at the ends of their encodable range.

## Trap 3 — `stmts=0`

Only 644 of 1,705 functions were decompiled. A cross-reference proves that a
function reads a constant; it says nothing about what the function does with it.

Functions central to drivability that have **zero** recovered statements:
`FUN_00017052` (Lastschlag / dashpot torque-gradient filter), `FUN_00023a3a`
(EDK position PID), `FUN_00017400` (`KF_MD_WE`, the SA torque filter constants),
`FUN_000143c6` (misfire threshold formation), `FUN_000265ea` (idle speed
filtering).

Anything you write about those mechanisms is `funktionsrahmen-only` or
`inference`, and the report must say so. This is not pedantry: it tells the reader
which recommendations need bench confirmation before being trusted.

Also watch for **unresolved disjunctions** in recovered code. The decompiler emits
`{A | B}` when it could not determine which branch supplies a value — e.g.
`TZ_SA_DELTA = {kls_wint(KL_TZ_ZWB_WE_SOFT,N) | kls_wint(KL_TZ_ZWB_SA,N)} + …`.
Assigning one is inference, however plausible.

## Trap 4 — value provenance

Values come from `Full 211323000401PD31_TERRA.bin`; the XDF text references
`211325000401PD11`; the user's car is a Community Patch derivative with the EGT
table zeroed. Addresses and logic transfer between these; numbers do not. See
`sources.md`. Every document that quotes current values must say so.

## Sign and direction errors

These were the single most common class the verifier caught, and they are the
most dangerous because the parameter and address are right — only the direction is
wrong, so the advice survives review and fails in the car.

Check explicitly:
- Which way does the scaling run? (reciprocals invert everything)
- Is a "minimum" a floor on the value or a threshold the value must exceed?
- Does raising a limit make the system more or less permissive? Worked example:
  the first pass said leaving `K_MD_J_MOTOR` high risked gearbox overload; in fact
  the term is *added* to the allowed torque during positive rpm gradient, so a
  smaller J makes the limiter bind **earlier** — more protective, not less.
- For gradient thresholds, does a lighter flywheel push the signal toward the
  threshold or away from it? Do the arithmetic rather than reasoning verbally.

## The adversarial verification pass

For anything beyond a single-parameter lookup, run a second pass whose explicit
job is to **refute** the first. Default it to "the analyst got this wrong".

Checklist:

1. Does every claimed name exist verbatim in the XDF data?
2. Is every XDF address correct for that name?
3. Is every file offset right **for that bank** — master `addr`, slave
   `0x88000 + addr`? (`0x88000 + (addr mod 0x8000)` is the Ghidra mapped window,
   not the file offset; it puts master rows 0x80000 too high.)
4. Are the current value, scaling, bank and kind right?
5. Are `code-confirmed` claims actually backed by a recovered statement? Downgrade
   anything that is really `xref-only`.
6. **What was missed?** Sweep the domain's categories with `q.py catof` and diff
   against what was reported. In the flywheel work this produced 103 additions.
7. Is any claim physically wrong — units, signs, direction, order of magnitude?
8. Is every recommended value writable (`q.py enc`)?
9. Is any recommendation pointing at an inert path (`q.py dead`)?

Then apply the corrections with the verification as authoritative. Where a
verified correction reverses a headline conclusion, say so plainly in the report
rather than quietly softening the original claim.

## Mechanical verification

`scripts/verify_doc.py DOC.md` checks every parameter row against the data:
name exists, XDF address matches, file offset follows the rule, bank matches, kind
matches, and for constants the stated current value matches within 0.5%.

It exits non-zero on failure, so it can gate a commit. It only recognises the
column order in the SKILL.md report template — if it reports "0 rows matched", the
table shape has drifted.

## A process note

When reducing many findings into one document, do not truncate the input. In the
first synthesis attempt the analyses were concatenated and clipped at 400,000
characters, which silently dropped two whole domains; the resulting document was
missing entire sections and said so itself. Reduce per-domain first (apply the
verification to each domain separately, producing a finished section), then
assemble the sections. Each stage then fits comfortably and nothing is lost.
