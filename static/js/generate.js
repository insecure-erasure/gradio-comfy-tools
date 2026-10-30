// ── Generate tab 🖼️ ────────────────────────
// POST /api/generate -> show result image + set result URL (chaining).

function generateImage() {
  const familyEl = document.getElementById('genModelFamily');
  const family = (familyEl && familyEl.options[familyEl.selectedIndex]?.getAttribute('data-key')) || 'zimage';
  const ar = document.getElementById('genAspectRatio')?.value || '2:3';
  const mp = document.getElementById('genMegapixel')?.value || 1;
  const steps = document.getElementById('genSteps')?.value || 9;
  const seedEl = document.getElementById('genSeed');
  const randomEl = document.getElementById('genSeedRandom');
  let seed;
  if (randomEl && randomEl.checked) {
    // 🎲 enabled → generate now and show the value that will be sent
    seed = randomSeed();
    if (seedEl) seedEl.value = seed;
  } else {
    seed = parseInt(seedEl?.value) || 0;
  }
  const prompt = activePromptInput()?.value || '';
  // Advanced modal (⚙️): LoRA config + optional model override
  const adv = (window.advancedValues && window.advancedValues.generate) || {};
  const loraConfig = adv.lora || '[]';
  const model = adv.model || '';
  // "Increase randomness" only applies to the families whose two-stage
  // workflow is supported (Z-Image Turbo and Krea 2).
  const variability = !!adv.variability && VARIABILITY_FAMILIES.includes(family);
  const initialConditioning = variability ? (adv.initial_conditioning || '') : '';

  if (!prompt.trim()) return showToast('Please write a prompt first');

  const btn = document.getElementById('btnGenerate') || document.querySelector('#btnCol .btn-generate');
  const pane = document.getElementById('genOutputPane');
  const spinner = document.getElementById('genSpinner');
  if (btn) btn.disabled = true;
  pane.classList.add('busy');
  spinner.classList.add('show');
  showToast('Workflow submitted to ComfyUI...');
  startProgressPolling();
  setGeneratingUi(true, 'btnGenerate');

  // Shared finalize (normal fetch OR focus-recovery of a lost job).
  function finalizeGenerate(res) {
    showResult('genOutputPane', res, false);
    // Generated history: the result joins the lightbox gallery with its
    // generation prompt; session-scoped, survives the pane.
    addGeneratedEntry(res, prompt);
    lastGeneratedUrl = res.url;
    stopProgressPolling(); // captures the total duration BEFORE the hint is painted
    syncResultUrl('generate', { url: res.url });
    showToast('✨ Generated');
    if (btn) btn.disabled = false;
    pane.classList.remove('busy');
    spinner.classList.remove('show');
    setGeneratingUi(false);
  }
  registerRecoverHandler(finalizeGenerate);

  api('/api/generate', {
    family, prompt, aspect_ratio: ar, megapixel: parseFloat(mp),
    steps: parseInt(steps), seed, lora_config: loraConfig, model, variability,
    initial_conditioning: initialConditioning,
  }).then(res => {
    finalizeGenerate(res);
  }).catch(err => {
    const isAbort = err && err.name === 'AbortError';
    if (!userCancelled && err && err.isHttp && err.status === 408) {
      // The backend's own wait timed out (a long job) — ComfyUI may
      // still be running and the WS listener records the result on
      // completion; enter recovery like a lost fetch.
      recoverPending = true;
      return;
    }
    if (!userCancelled && err && err.isHttp) {
      // The backend answered with a REAL failure (e.g. ComfyUI OOM /
      // validation error / unreachable) — the job is dead, nothing
      // will finish: terminal. .finally releases the UI.
      syncResultUrl('w+', null);
      showToast('❌ ' + (err.message || 'Generation failed'));
      return;
    }
    if (isAbort && !userCancelled) {
      recoverPending = true; // job still running — resolve on completion
      return;
    }
    if (!userCancelled) {
      // Transport error — the backend still polls ComfyUI and records the
      // result on completion; enter recovery (see video.js catch).
      recoverPending = true;
      showToast('⚠️ Connection lost — waiting for the result…');
      return;
    }
    syncResultUrl('w+', null);
    showToast('❌ ' + (isAbort ? (userCancelled ? 'Cancelled' : 'Timed out — try again') : (err.message || err)));
  }).finally(() => {
    userCancelled = false;
    if (!recoverPending) {
      stopProgressPolling();
      if (btn) btn.disabled = false;
      pane.classList.remove('busy');
      spinner.classList.remove('show');
      setGeneratingUi(false);
    }
  });
}

// ── Steppers ──────────────────────────────
function stepMp(delta) {
  const input = document.getElementById('genMegapixel');
  const val = parseFloat(input.value) + delta;
  const clamped = Math.round(Math.min(2, Math.max(0.1, val)) * 10) / 10;
  input.value = clamped;
  onModelFamilyChange();
  updatePromptChips();
}
function stepSteps(delta) {
  const input = document.getElementById('genSteps');
  const val = parseInt(input.value) + delta;
  const clamped = Math.min(MAX_GEN_STEPS, Math.max(MIN_GEN_STEPS, val));
  input.value = clamped;
  updatePromptChips();
}
function onStepsInput() {
  const input = document.getElementById('genSteps');
  const v = parseInt(input.value);
  if (isNaN(v) || v < MIN_GEN_STEPS) input.value = MIN_GEN_STEPS;
  if (v > MAX_GEN_STEPS) input.value = MAX_GEN_STEPS;
  updatePromptChips();
}

// ── Seed + random toggle ──────────────────
function stepGenSeed(d) { const input = document.getElementById('genSeed'); input.value = Math.max(0, parseInt(input.value) + d); updatePromptChips(); }
function onGenSeedInput() {
  const input = document.getElementById('genSeed');
  if (isNaN(parseInt(input.value))) input.value = 0;
  document.getElementById('genSeedRandom').checked = false;
  input.disabled = false;
  updatePromptChips();
}
function onSeedRandomToggle() {
  document.getElementById('genSeed').disabled = document.getElementById('genSeedRandom').checked;
  updatePromptChips();
}

// ── Model family -> auto steps + W/H calc ──
function onModelFamilyChange() {
  const sel = document.getElementById('genModelFamily');
  toolbarValues.genFamily = sel.value;  // persist across tab switches

  // "Increase randomness" is not available for every family: drop it when
  // the family changes away so a stale true can never reach the backend.
  if (!VARIABILITY_FAMILIES.includes(sel.value) && window.advancedValues?.generate) {
    window.advancedValues.generate.variability = false;
  }

  // Update steps input (variability mode has its own per-family default)
  syncVariabilitySteps();
  updatePromptChips();

  // Show/hide custom ratio fields (dead code in the mockup — kept for parity)
  const arSel = document.getElementById('genAspectRatio');
  const arOpt = arSel.options[arSel.selectedIndex];
  const customRow = document.getElementById('genCustomRatio');
  if (arOpt.getAttribute('data-w') === '0') {
    customRow.style.display = 'flex';
  } else {
    customRow.style.display = 'none';
  }

  // Update megapixel input
  const mpInput = document.getElementById('genMegapixel');
  const mp = parseFloat(mpInput.value);
  if (isNaN(mp) || mp < 0.1) mpInput.value = 0.1;
  if (mp > 2) mpInput.value = 2;

  recalcResolution();
}

// Steps default for the active family, taking the variability workflow's own
// budget into account (Z-Image 10 in variability mode, Krea 2 9). Called on
// family changes and when the advanced modal flips the checkbox.
function syncVariabilitySteps() {
  const sel = document.getElementById('genModelFamily');
  if (!sel) return;
  const defaults = FAMILY_DEFAULTS[sel.value] || {};
  const adv = (window.advancedValues && window.advancedValues.generate) || {};
  const on = !!adv.variability && VARIABILITY_FAMILIES.includes(sel.value);
  const fallback = parseInt(defaults.steps) || 8;
  const steps = on ? (parseInt(defaults.varSteps) || fallback) : fallback;
  const input = document.getElementById('genSteps');
  if (input) input.value = steps;
}

function recalcResolution() {
  const sel = document.getElementById('genModelFamily');
  const defaults = FAMILY_DEFAULTS[sel.value] || {};
  const vaeScale = parseInt(defaults.vae) || 16;

  const arSel = document.getElementById('genAspectRatio');
  const arOpt = arSel.options[arSel.selectedIndex];

  let wRatio, hRatio;
  if (arOpt.getAttribute('data-w') === '0') {
    // Custom ratio — read from the custom inputs
    const customInputs = document.querySelectorAll('#genCustomRatio input');
    wRatio = parseInt(customInputs[0]?.value) || 16;
    hRatio = parseInt(customInputs[1]?.value) || 9;
  } else {
    wRatio = parseInt(arOpt.getAttribute('data-w'));
    hRatio = parseInt(arOpt.getAttribute('data-h'));
  }

  const mp = parseFloat(document.getElementById('genMegapixel').value);
  const totalPixels = mp * 1_000_000;

  // w = sqrt(totalPixels * wRatio / hRatio)
  const rawW = Math.sqrt(totalPixels * wRatio / hRatio);
  const rawH = rawW * hRatio / wRatio;

  // Round to nearest multiple of vae_scale_factor
  const w = Math.max(vaeScale, Math.round(rawW / vaeScale) * vaeScale);
  const h = Math.max(vaeScale, Math.round(rawH / vaeScale) * vaeScale);

  document.getElementById('genWidth').textContent = w;
  document.getElementById('genHeight').textContent = h;
  updatePromptChips();
}

// ── ↺ Reset ───────────────────────────────
function resetGenerate() {
  // If a generation is running, cancel the backend job and stop the live
  // preview/progress polling so the reset leaves a clean pane: the
  // placeholder is recreated below and nothing (preview or result)
  // reappears over it.
  cancelIfRunning();

  const family = document.getElementById('genModelFamily');
  if (family) family.selectedIndex = 0;
  const ar = document.getElementById('genAspectRatio');
  if (ar) ar.selectedIndex = 0;
  document.getElementById('genMegapixel').value = '1';
  document.getElementById('genSteps').value = '9';
  document.getElementById('genSeed').value = '0';
  document.getElementById('genSeedRandom').checked = true;
  document.getElementById('genSeed').disabled = true;
  onModelFamilyChange(); // auto-steps + recalc W/H

  // Clear output and restore the placeholder
  const pane = document.getElementById('genOutputPane');
  clearPane('genOutputPane');
  syncResultUrl('generate', null); // no image shown — no URL hint
  const ph = document.createElement('div');
  ph.className = 'output-placeholder';
  ph.innerHTML = '<div class="icon">🖼️</div><p>Your generated image<br>will appear here</p>' +
                 '<p style="font-size:.75rem;margin-top:6px;">Click to open lightbox</p>';
  pane.insertBefore(ph, pane.firstChild);
  showToast('Generate parameters reset');
}
