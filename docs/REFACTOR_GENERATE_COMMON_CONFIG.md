# Refactor: Generate common config + injection helpers

Branch: `refactor/generate-common-config`
Base: `b448507`
Status: **in progress**

Goal: one source of truth for the Generate family configuration and shared
injection helpers, without changing workflow JSONs, sampling behaviour or the
public API.

## Phase 0 — Baseline snapshot

- [x] Build a deterministic matrix of 14 workflows (standard: zimage/krea2/
      flux2; variability: zimage/krea2/flux2; defaults, explicit params,
      model override + LoRA).
- [x] Save them to `/tmp/generate_refactor_baseline/` with a `manifest.json`
      (sha256 + meta).
- [ ] Re-run the matrix after each phase and diff against the baseline.

Baseline commit: `b448507`.

## Phase 1 — `FAMILY_CONFIGS` single source

- [x] Add `FAMILY_CONFIGS` (common + `standard` + `variability` per family).
- [x] Derive `MODEL_CONFIGS`, `VARIABILITY_CONFIGS` and
      `VARIABILITY_WORKFLOW_FILES` with the same shapes/keys as today.
- [x] Keep `FAMILY_OPTIONS`, `VARIABILITY_FAMILIES`, `VARIABILITY_FAMILY`
      behaviour unchanged.
- [x] Add `test_family_configs_single_source`.
- [x] Run pytest + baseline diff.

Result: 180 tests pass; `/tmp/generate_refactor_phase1` diff vs baseline is
empty.

## Phase 2 — Common injection helpers

- [x] `_inject_model_stack`
- [x] `_inject_resolution` (preserve the standard-only `aspect_ratio` write)
- [x] `_inject_prompt` (`Prompt.value` vs `Prompt here.text`)
- [x] `_inject_variability_conditioning`
- [x] `_inject_loras`
- [x] Reuse helpers in `build_workflow`, `build_variability_workflow` and
      `_build_flux2_variability_workflow`.
- [x] Run pytest + baseline diff.

Result: 180 tests pass; `/tmp/generate_refactor_phase2` diff vs baseline is
empty.

## Phase 3 — Documentation

- [ ] `docs/BACKEND.md`: family config single source + §3 injection helpers.
- [ ] `docs/PLAN.md`: update `MODEL_CONFIGS` reference.
- [ ] `tools/generate.py` docstring/comments.
- [ ] `docs/FRONTEND.md` only if Phase 4 is done.
- [ ] Run pytest (docs-only change, no behaviour change expected).

## Phase 4 (optional) — Frontend defaults

- [ ] Decide whether to include the light `FAMILY_DEFAULTS` JS unification.
- [ ] If included: `state.js`, `tabs.js`, `generate.js`; remove duplicated
      `data-steps`/`data-vae`.
- [ ] `node --check` + e2e smoke if available.
- [ ] Update `docs/FRONTEND.md`.

## Test log

| Phase | Command | Result |
|---|---|---|
| 0 | `PYTHONPATH=/work venv/bin/python /tmp/generate_refactor_baseline.py` | 14 workflows written |
| 1 | `venv/bin/python -m pytest -q` | 180 passed |
| 1 | `diff -r /tmp/generate_refactor_baseline /tmp/generate_refactor_phase1` | no differences |
| 2 | `venv/bin/python -m pytest -q` | 180 passed |
| 2 | `diff -r /tmp/generate_refactor_baseline /tmp/generate_refactor_phase2` | no differences |
| 3 | pending | — |
| 4 | pending | — |

## Notes / decisions

- Keep the three workflow JSON files separate.
- Preserve public symbols (`MODEL_CONFIGS`, `VARIABILITY_CONFIGS`, etc.) as
  derived views so existing imports/tests keep working.
- Any existing test that needs an assertion change is a signal that behaviour
  changed; the refactor should be behaviour-preserving.
