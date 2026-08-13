# Datalogging over DS2 — what can actually be measured

The measurement side is fixed by the ECU, not by the tool: DS2 exposes eight
live-value blocks and nothing else. Any log plan that assumes a channel outside
these blocks is fiction.

The authority is the user's own tool source:

```
C:\Users\kazuh\MSS54-DS2-Tool-Public-1.2.1\decompiled-source\
  Core/Mss54Ds2Tool.Core/DmeLiveValueCatalog.cs      <- the 8 blocks, 213 field definitions
  Core/Mss54Ds2Tool.Core/DmeLiveValueDecoder.cs      <- how a frame becomes values
  Core/Mss54Ds2Tool.Core/DmeLiveValueFieldFormat.cs  <- UInt8 / UInt10 / UInt16 / Int7 / Int15
  App/Mss54Ds2Tool.App/LiveValuesService.cs          <- polling loop, block selection, failure handling
  App/Mss54Ds2Tool.App/LiveValuesCsvLogger.cs        <- CSV output
```

Re-read `DmeLiveValueCatalog.cs` when writing a log plan rather than trusting the
summary below — it is the ground truth and it is only ~290 lines.

## The eight blocks

| Sel | Name | Payload | Fields | Why you would select it |
|---|---|---|---|---|
| 2 (0x02) | A/D Converters | 64 B | 32 | raw sensor volts — sensor faults, not control behaviour |
| 3 (0x03) | Standard Measurements | 35 B | 24 | `n`, `llr_n_soll`, `ml`, `tl`, `rf`, temperatures, `pwg1/2`, `wdk1/2`, `edk_soll` |
| 4 (0x04) | Switch / Status Bits | 43 B | 43 | `zustand_motor`, `lfr_zustand`, `sa_we_st`, `ba_st`, `kr_st`, `ews_status` … |
| 19 (0x13) | Operating Measurements | 90 B | 48 | `ti1..ti6`, `tz1..tz6`, `md_llri`, `lls_tv`, `edk_aus`, `fr_regler`, `la_f_regler1/2`, `v` |
| 21 (0x15) | Rough Running System Check | 42 B | 6 | `ll_abw1..6` per-cylinder roughness |
| 35 (0x23) | VANOS/CSL | 39 B | 20 | `evan/avan` target vs actual, `gks`, `psau_local`, `rf_psau`, `rf_drrel` |
| 83 (0x53) | EGAS | 52 B | 34 | **the drivability block** — see below |
| 179 (0xB3) | Rough Running | 16 B | 6 | `lu[0..5]` segment-time deviation |

Block 3 is the tool's default selection.

## Block 83 (0x53) — the one that matters for drivability

| Symbol | Off | Format | Scale | Meaning |
|---|---|---|---|---|
| `n40` | 18 | UInt8 | ×40 | engine speed, coarse |
| `d_n40` | 19 | Int7 | ×40 | **speed gradient, rpm/s** |
| `d_pwg` | 20 | Int15 | ×0.1 | pedal gradient, %/20ms |
| `d_wdk` | 22 | Int15 | ×5.0 | throttle gradient, %/s |
| `md_ind_wunsch` | 34 | UInt16 | ×0.1 | driver torque request, Nm |
| `md_ind_ne` | 38 | UInt16 | ×0.1 | torque after intervention, Nm |
| `md_ind_opt_korr` | 40 | UInt16 | ×0.1 | actual torque, Nm |
| `md_dyn_st` | 48 | UInt8 | — | dynamic filter state |
| `sa_we_st` | 51 | UInt8 | — | overrun cut / re-instatement state |
| `gang` | 49 | UInt8 | — | calculated gear |
| `s_krafts` | 50 | UInt8 | — | powertrain engaged |
| `wdk1/2`, `egas_soll`, `edk_aus`, `rf`, `ml`, `pwg_soll`, `asc_st`, `edksi_zustand` | — | — | — | the rest of the throttle/torque chain |

Having gradient, request, delivery, state machine and gear in **one block** is why
most drivability logging should start here: everything is time-aligned within a
single frame, with no cross-block skew.

## Be honest about resolution

This is the part that makes a log plan useful rather than decorative.

**Cross-block skew.** DS2 is request/response: each selected block is a separate
round trip, so signals in different blocks are not sampled at the same instant.
Selecting more blocks divides the rate and widens the skew. Prefer a plan that
answers one question from one block over a plan that logs everything badly.

**`d_n40` quantisation.** 1 LSB = 40 rpm/s, signed, and it saturates around
±5080 rpm/s. Deceleration rates are therefore reported in 40 rpm/s steps — fine
for comparing before/after, too coarse for fine threshold work.

**What cannot be seen at all.** A 4–10 Hz driveline torsional oscillation needs
>20 Hz sampling to characterise; the DS2 link is nowhere near that, so the
oscillation is aliased, not measured. An external accelerometer or a driveshaft
speed sensor is the only honest instrument for torsional work. Similarly there is
no live channel for `LU_SCHWELLE`, `SWE_STATUS`, `LU_ADAP[]`, `AUSS_SUM_*` or
`D_N_GEFILTERT` — several important internals are simply not observable, and a
plan that pretends otherwise will not produce the evidence it promises.

**Measure the actual rate before promising one.** Nobody has established the
achievable Hz for this tool and link. Log a fixed block set for 60 s, then take
the median delta between CSV timestamps. Do that once and record it, rather than
computing a theoretical figure from baud rate.

**Failure behaviour** (from `LiveValuesService.cs` / `Ds2OperationFailureHandling`):
a bad checksum raises `Ds2ProtocolException`, which is caught — polling continues.
A timeout is a *communication* failure, which escapes the loop and **ends the
logging run**. So an unanswered block does not merely slow the sweep; it kills the
log. Verify every block in the set responds before starting a real session.

**Live values and commanded tests are mutually exclusive.** Live-value polling and
commands such as the idle-raise test both take `ShellSessionService.CommandGate`,
so you cannot log while commanding a setpoint step. Step-response tests must be
driven by the driver's inputs, not by the tool.

## Building a log set

Pick the minimum block set that answers one question, and state the expected
manoeuvre and a pass/fail criterion in real units. A useful set specifies:

1. which blocks (and therefore the expected rate),
2. the exact manoeuvre to drive,
3. which signals to plot against each other,
4. the numeric criterion that decides pass or fail,
5. which channels are *blanked* during that manoeuvre and therefore prove nothing.

Point 5 is easy to forget and it invalidates otherwise good plans. For example
`K_LU_KUPPL_DELAY` and `K_LU_AUSKUPPL_DELAY` are 2.0 s each, so `lu[]` and
`ll_abw[]` are not evaluated for two seconds around any clutch action — exactly
the window a clutch-engagement test wants to examine. Likewise `KL_LU_RF_MIN`
gates roughness measurement by load, so quiet `lu[]` during overrun means "not
evaluated", not "no misfire".

## Derived quantities worth computing off-line

The tool does not provide these, but they come straight out of the CSV:

- `dN/dt` from successive `n` — higher resolution than `d_n40`, though noisier
- idle speed error `n − llr_n_soll`
- torque tracking error `md_ind_wunsch − md_ind_ne`
- oscillation frequency: FFT of `n` during a tip-in (subject to the Nyquist caveat)
- damping ratio from the decay of successive peaks of the same trace
- the inertia ratio `J_new/J_old = gradient_old / gradient_new` from a no-load
  free deceleration between two fixed speeds — the cheapest way to turn "the
  flywheel is lighter" into a number that the rest of an analysis can use
