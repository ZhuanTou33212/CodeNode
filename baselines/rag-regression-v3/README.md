# CodeNode RAG regression v3

## Frozen result

This is the exposed 100-case regression baseline, not unseen acceptance or human gold.

- Overall: 63/100; strict reference-anchor score: 61/100.
- Positive: 50/70; single-file: 34/40; cross-file: 16/30.
- Negative safe-response pass: 13/30. All 17 failed negatives were blocked; this is not an observed unsafe-release count.
- Final malformed/truncated judge JSON: 0. Execution and grading errors: 0.
- Core verification: 136/136. Portable delivery is `E:/CodeNode/release/win-unpacked`.

## Verify and replay

Run from `E:/CodeNode`:

```powershell
node baselines/rag-regression-v3/verify.cjs --check-host-evaluator
node scripts/rag-agent-task-eval.cjs --runtime-root=baselines/rag-regression-v3/runtime --limit=100 --runtime-profile=production --system-prompt=native-read-only --token-budget=8000000 --confirm-send --out=out/rag-regression-v3-replay-NEW.json
```

Use a fresh output name. Replay makes paid calls through configured host credentials; no credentials are frozen here. The original measured reports must never be replaced by a new replay score. The service model alias is stochastic and cannot be frozen like local code. Dependency lock and Node environment are recorded; the active dependency installation must match for a faithful replay.

The copied evaluator files are an audit reference. Run the host evaluator only after `--check-host-evaluator` succeeds: its helper/fixture imports and host configuration remain in the original workspace. Do not run the audit copy as if it were a standalone application.

## Policy

- Stop optimizing prompts, thresholds, or routing against these exposed 100 cases.
- Continue using the frozen cases for regression verification of independently motivated changes.
- Do not use expected-negative labels or case IDs to alter production behavior.
- Keep human review exports outside this frozen directory. Corrected labels require a new dataset version with reviewer and adjudication provenance.
- New language or real multi-file call-chain acceptance cases must be independently authored, reviewed, and held out before model tuning.

`manifest.json` binds frozen runtime, original data/judges, evaluator, reports, dependency lock and delivery proof by SHA256. The Git HEAD is context only: the measured working-tree version is identified by these hashes. Executables and old release backups are not stored here.
