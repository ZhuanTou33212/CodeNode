# Scripts directory

[English](README.md) · [简体中文](README.zh-CN.md)

Scripts are grouped by execution purpose; moving a file between groups changes neither npm commands, assertions nor test groups. A file's directory does not mean it runs automatically — the effective test set is defined by `run-all-tests.cjs`.

| Location | Purpose | Entry point |
| --- | --- | --- |
| The 6 `.cjs` files in the root | Dev startup, build, icons, release signing, launcher and test scheduling | `npm run dev`, `npm run build`, `npm run dist:win`, `npm run verify` |
| `core/` | Feature regressions, permission boundaries, storage and runtime gates with no UI | `npm test`; specialised tests are in `package.json` |
| `ui/` | Electron/browser UI tests, screenshots and theme checks | `npm run test:display`; unregistered cases run through `run-electron.cjs` or their own instructions |
| `packaged/` | Startup, tool and UI acceptance against the real `app.asar` | Set `CODENODE_PACKAGED_ASAR`, then run through `run-electron.cjs` |
| `eval/` | Datasets, evaluations, ablation experiments and an optional local model service | `npm run test:eval`, `npm run rag:acceptance`; other scripts document their own arguments |
| `tools/` | Event replay, image and visual inspection tools | See each script's usage notes |
| `lib/` | Shared model stubs, source readers and check helpers for scripts | Imported by tests and evaluation scripts |
| `fixtures/` | Test inputs, frozen datasets and lock files | Read by scripts; they are not cache and must not be deleted |

## Common verification

```powershell
npm run test:list                 # current core / display sets and counts
npm run verify                    # build + CJS static checks + core regression
npm run test:display               # needs Electron or a browser
node scripts/run-all-tests.cjs --only test:session,test:undo
node scripts/run-electron.cjs scripts/ui/theme-parity-ui-test.cjs
$env:CODENODE_PACKAGED_ASAR = 'E:\CodeNode\release\win-unpacked\resources\app.asar'
node scripts/run-electron.cjs scripts/packaged/packaged-startup-check.cjs
```

`eval/` contains offline evaluations and real-model experiments. Moving a script between directories does not change its credential, send-confirmation or frozen-baseline requirements; pick a mode according to the script's own notes.

Frozen archives keep the directory structure and hashes they had when they were frozen. Verify the original material with `node baselines/rag-regression-v3/verify.cjs`; the archive's `--check-host-evaluator` checks the host scripts of that time, and the migrated script paths and hashes have changed since. Re-evaluating with the current `eval/` must write a new report — never overwrite an older result or claim byte-identical equivalence with the frozen evaluator.

## Maintenance rules

- Put new tests in the matching group, shared helper code in `lib/` and input data in `fixtures/`.
- Register an npm command, and decide from its execution requirements whether it joins the core/display sets in `run-all-tests.cjs`. Keep existing manual probes and specialised acceptance scripts even when they are not in the default set.
- When moving files, update module imports, `__dirname` paths, npm commands, CI / CODEOWNERS and the doc examples in the same change; verify that the test set did not change.
- Write generated reports to `out/` or the established report directory. Keep reports already referenced by documentation, baselines or review material; before deleting temporary files, check the real references and whether something is still running.
