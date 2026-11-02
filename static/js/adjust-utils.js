// ── Adjust panel helpers (pure) ────────────────────────────────────────────
// The UI works in percent (0–200, 100 = neutral); ComfyUI's LayerColor node
// takes factors (0–3, 1 = neutral). Keeping the conversion here makes the
// slider → payload → CSS preview mapping consistent and unit-testable.

const ADJUST_MIN_PERCENT = 0;
const ADJUST_MAX_PERCENT = 200;
const ADJUST_NEUTRAL_PERCENT = 100;

function adjustClampPercent(value) {
  const n = typeof value === 'number' ? value : parseFloat(value);
  if (!Number.isFinite(n)) return ADJUST_NEUTRAL_PERCENT;
  return Math.min(ADJUST_MAX_PERCENT, Math.max(ADJUST_MIN_PERCENT, Math.round(n)));
}

function adjustFactor(percent) {
  return adjustClampPercent(percent) / 100;
}

function adjustFilter(brightness, contrast, saturation) {
  return 'brightness(' + adjustFactor(brightness) + ') ' +
    'contrast(' + adjustFactor(contrast) + ') ' +
    'saturate(' + adjustFactor(saturation) + ')';
}

function adjustPayload(brightness, contrast, saturation) {
  return {
    brightness: adjustFactor(brightness),
    contrast: adjustFactor(contrast),
    saturation: adjustFactor(saturation),
  };
}

function adjustIsNeutral(brightness, contrast, saturation) {
  return [brightness, contrast, saturation].every(
    value => adjustClampPercent(value) === ADJUST_NEUTRAL_PERCENT
  );
}
