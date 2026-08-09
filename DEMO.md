# DEMO.md — reproduce every claim in this repo

Everything below runs **offline**: no network, no API key, no account. All fixture data is
**SYNTHETIC** (fictitious persons, payers, member IDs, determinations).

Verified on 2026-08-09 · Node ≥ 18.17 · macOS (darwin 25.5.0).

## 0. Setup

```bash
npm install          # no postinstall, no network calls at runtime
```

## 1. The one command that proves the whole thing

```bash
npm run ci           # typecheck → 121 tests → seed → seed:check → self-test → verify:ledger
```

Expected, in order:

| Step | Expected output |
|---|---|
| `tsc --noEmit` | silent (zero errors) |
| `vitest run` | **Test Files 8 passed (8) · Tests 121 passed (121)** |
| `self_test` | `SELF-TEST: PASS` |
| `verify_ledger` | `RESULT: OK — chain + signatures + merkle roots all recompute` |

## 2. The devastating query — a case the agent *refuses*

The autonomy proof is not that the agent drafts an appeal. It is that it **declines and refunds**
cases it judges unwinnable, and writes that decision to a ledger it cannot later edit.

```bash
npm run bench                       # 15 fixture cases through the full pipeline
```

Outcomes across the fixture set: `{"DOCKETED": 11, "REFUNDED": 3, "VERIFY_FAILED": 1}` — three
declines and one fail-closed catch, all on the record.

Walk one case end to end:

```bash
npx tsx src/cli.ts decode maria_asthma
npx tsx src/cli.ts docket --state TX --denial-date 2026-06-26 --stated-deadline 2026-08-25
```

`decode` scrubs 6 PHI span types **before persistence** (`detectPhi → null`), triages at
`p_win 0.74`, and extracts denial code `CO-50` with both deadlines. `docket` then reconciles the
letter-stated deadline against the TX rulepack window and binds to the **earlier** of the two —
the failure mode that actually loses appeals.

## 3. Tamper-evidence — the claim judges should try to break

```bash
npm run verify:ledger              # RESULT: OK
```

Ledger state: **15 entries · 1 case chain · 1 merkle day**, root
`a66463cb3f4b6150136b47e17c7e1da7df6c1fde9b602d3323e4c60ccb54479b` (key mode `FIXTURE_DEV_KEYS`).

Now edit any byte of an exported ledger row and re-run: verification fails and localizes the
mutated sequence number. The tampered-state screenshot is
[`docs/evidence/11-terminal-verify-ledger-tamper.png`](docs/evidence/11-terminal-verify-ledger-tamper.png).

## 4. Benchmarks

```bash
npm run bench                      # 15 fixture cases, DeterministicMockAdapter
```

| Stage | n | p50 (ms) | p95 (ms) | max (ms) |
|---|---|---|---|---|
| redact | 15 | 0.09 | 0.83 | 0.83 |
| triage | 15 | 0.00 | 0.05 | 0.05 |
| evidence | 12 | 0.00 | 0.11 | 0.11 |
| strategy | 12 | 0.09 | 0.30 | 0.30 |
| draft | 12 | 0.01 | 0.05 | 0.05 |
| verify | 12 | 0.02 | 0.10 | 0.10 |
| case_ops | 11 | 0.69 | 1.39 | 1.39 |
| **end-to-end** | **15** | **1.86** | **6.19** | **6.19** |

**These are mock-adapter timings — pipeline mechanics only, not model latency.** Production adds
Gemini inference plus Lob/Stripe I/O. Numbers vary by machine; the shape does not.

## 5. Judge-visible dashboard (no server)

```bash
npm run verify:dashboard           # prints a file:// URL
```

Opens a self-contained offline viewer over the real exported pipeline data: case header,
counters, ledger replay, merkle verification, citation pass, fail-closed catch, redaction.
Static captures of all of it are in [`docs/evidence/`](docs/evidence/) (16 PNGs).

## What is NOT proven here

Stated plainly, because the rubric asks: this repo is the **offline core**. It does not yet
demonstrate live production operation — no deployed service, no live Gemini key, no Lob certified
mail, no Stripe charges, no real customers. Those are business milestones, not code claims, and
this file will not pretend otherwise.
