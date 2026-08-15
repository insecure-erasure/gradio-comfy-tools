// ── Generate tab 🖼️ ────────────────────────
// POST /api/generate -> show result image + set result URL (chaining).

function generateImage() {
  const familyEl = document.getElementById('genModelFamily');
  const family = (familyEl && familyEl.options[familyEl.selectedIndex]?.getAttribute('data-key')) || 'zimage';
  const ar = document.getElementById('genAspectRatio')?.value || '2:3';
  const mp = document.getElementById('genMegapixel')?.value || 1;
  const steps = document.getElementById('genSteps')?.value || 10;
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
    steps: parseInt(steps), seed, lora_config: loraConfig, model,
  }).then(res => {
    finalizeGenerate(res);
  }).catch(err => {
    const isAbort = err && err.name === 'AbortError';
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
  const clamped = Math.min(15, Math.max(1, val));
  input.value = clamped;
  updatePromptChips();
}
function onStepsInput() {
  const input = document.getElementById('genSteps');
  const v = parseInt(input.value);
  if (isNaN(v) || v < 1) input.value = 1;
  if (v > 15) input.value = 15;
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
  const opt = sel.options[sel.selectedIndex];
  toolbarValues.genFamily = sel.value;  // persist across tab switches

  // Update steps input
  const steps = parseInt(opt.getAttribute('data-steps')) || 8;
  document.getElementById('genSteps').value = steps;
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

function recalcResolution() {
  const sel = document.getElementById('genModelFamily');
  const opt = sel.options[sel.selectedIndex];
  const vaeScale = parseInt(opt.getAttribute('data-vae')) || 16;

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
  document.getElementById('genSteps').value = '10';
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
