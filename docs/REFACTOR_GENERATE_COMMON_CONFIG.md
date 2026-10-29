# Refactor: Generate common config + injection helpers

Branch: `refactor/generate-common-config`
Base: `b448507`
Status: **complete**

Goal: one source of truth for the Generate family configuration and shared
injection helpers, without changing workflow JSONs, sampling behaviour or the
public API.

## Phase 0 — Baseline snapshot

- [x] Build a deterministic matrix of 14 workflows (standard: zimage/krea2/
      flux2; variability: zimage/krea2/flux2; defaults, explicit params,
      model override + LoRA).
- [x] Save them to `/tmp/generate_refactor_baseline/` with a `manifest.json`
      (sha256 + meta).
- [x] Re-run the matrix after each phase and diff against the baseline.

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

- [x] `docs/BACKEND.md`: family config single source + §3 injection helpers.
- [x] `docs/PLAN.md`: update `MODEL_CONFIGS` reference.
- [x] `tools/generate.py` docstring/comments.
- [x] `docs/FRONTEND.md` only if Phase 4 is done.
- [x] Run pytest (docs-only change, no behaviour change expected).

Result: 180 tests pass (docs-only change).

## Phase 4 (optional) — Frontend defaults

- [x] Decide whether to include the light `FAMILY_DEFAULTS` JS unification.
- [x] If included: `state.js`, `tabs.js`, `generate.js`; remove duplicated
      `data-steps`/`data-vae`.
- [x] `node --check` + e2e smoke if available.
- [x] Update `docs/FRONTEND.md`.

Result: `FAMILY_DEFAULTS` is the single frontend source for labels/steps/vae
and derives `VARIABILITY_FAMILIES`/`VARIABILITY_STEPS`. `tabs.js` builds the
options from it; `generate.js` reads steps/vae from it. The full Puppeteer e2e
could not run here (puppeteer/chrome not installed), so validation was Python
tests + `node --check` + a Node `vm` smoke test of the derived values and
toolbar options.

## Test log

| Phase | Command | Result |
|---|---|---|
| 0 | `PYTHONPATH=/work venv/bin/python /tmp/generate_refactor_baseline.py` | 14 workflows written |
| 1 | `venv/bin/python -m pytest -q` | 180 passed |
| 1 | `diff -r /tmp/generate_refactor_baseline /tmp/generate_refactor_phase1` | no differences |
| 2 | `venv/bin/python -m pytest -q` | 180 passed |
| 2 | `diff -r /tmp/generate_refactor_baseline /tmp/generate_refactor_phase2` | no differences |
| 3 | `venv/bin/python -m pytest -q` | 180 passed |
| 4 | `venv/bin/python -m pytest -q` | 180 passed |
| 4 | `node --check state.js tabs.js generate.js modal.js` | OK |
| 4 | Node `vm` smoke (defaults/options/steps) | OK |

## Notes / decisions

- Keep the three workflow JSON files separate.
- Preserve public symbols (`MODEL_CONFIGS`, `VARIABILITY_CONFIGS`, etc.) as
  derived views so existing imports/tests keep working.
- Any existing test that needs an assertion change is a signal that behaviour
  changed; the refactor should be behaviour-preserving.

## Commits

| Phase | Commit |
|---|---|
| 1 | `4db032b` refactor(generate): centralize family config in FAMILY_CONFIGS |
| 2 | `b23a4ae` refactor(generate): share common workflow injection helpers |
| 3 | `1ca4e62` docs(generate): describe FAMILY_CONFIGS and shared injection helpers |
| 4 | (frontend FAMILY_DEFAULTS; see branch history) |
