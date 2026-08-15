// ── Edit tab 🖍️ ───────────────────────────
// POST /api/edit (mode: edit | restore) -> before/after compare slider.

function generateEdit(forceMode) {
  const src = getSourceUrl('edit');
  if (!src) return showToast('No source image — paste a URL or use 🔗/📁');
  const mode = forceMode || 'edit';
  const steps = parseInt(document.getElementById('editSteps')?.value) || 6;
  const seedEl = document.getElementById('editSeed');
  const randomEl = document.getElementById('editSeedRandom');
  let seed;
  if (randomEl && randomEl.checked) {
    // 🎲 enabled → generate now and show the value that will be sent
    seed = randomSeed();
    if (seedEl) seedEl.value = seed;
  } else {
    seed = parseInt(seedEl?.value) || 0;
  }
  const prompt = activePromptInput()?.value || '';
  // Advanced modal (⚙️): LoRA config
  const adv = (window.advancedValues && window.advancedValues.edit) || {};
  const loraConfig = adv.lora || '[]';

  const pane = document.getElementById('editOutputPane');
  const spinner = document.getElementById('editSpinner');
  const btn = document.getElementById('btnEdit') || document.querySelector('#btnCol .btn-generate');
  if (btn) btn.disabled = true;
  pane.classList.add('busy');
  spinner.classList.add('show');
  setGenerating(pane, true);
  showToast('Edit submitted to ComfyUI...');
  startProgressPolling();
  setGeneratingUi(true, mode === 'restore' ? 'btnRestore' : 'btnEdit');

  // Shared finalize (normal fetch OR focus-recovery of a lost job).
  function finalizeEdit(res) {
    // Compare slider: source (before) vs edited (after) — this IS the result.
    const beforeEl = document.getElementById('editBefore');
    const afterEl = document.getElementById('editAfter');
    const cmp = document.getElementById('editCompare');
    if (beforeEl && afterEl) {
      // The AFTER label follows the mode (Edit / Restore) — not hardcoded.
      const afterLabel = document.getElementById('editCompareAfterLabel');
      if (afterLabel) afterLabel.textContent = mode === 'restore' ? 'Restored' : 'Edited';
      // Resolve the source through the SAME-ORIGIN proxy (/media) — the
      // pane cannot load the ComfyUI host URL directly (CORS/host
      // validation). beforeProxyUrl handles external URLs, /media/..,
      // {base}/view?.. and bare temp filenames.
      const beforeSrc = beforeProxyUrl(src);
      beforeEl.src = beforeSrc;
      afterEl.src = res.display;
      cmp.style.setProperty('--p', '50%');
      cmp.style.display = '';
      // Gallery marker: the edited/restored result joins the compare
      // gallery (identity = AFTER image); kind is the actual mode.
      cmp.dataset.gallery = '1';
      cmp.dataset.kind = mode; // 'edit' | 'restore'
      cmp.dataset.prompt = prompt;
      // Compare gallery: register the comparison in the session registry.
      addCompareEntry({
        src: res.display,
        before: beforeSrc,
        prompt,
        kind: mode, // 'edit' | 'restore'
        tab: 'edit',
      });
      // Generated history: an edit/restore APPENDS a new entry — the
      // original generation stays in the gallery (the edited image is a new
      // image). The edit/restore text is the bottom caption; if the source
      // was a gallery image, its prompt becomes the badge hover hint.
      appendTransformedEntry(res, prompt, mode === 'restore' ? 'restored' : 'edited', src);
    }
    // Hide any plain result image; the compare slider is the display
    pane.querySelectorAll('.result-img, .output-placeholder, .source-preview').forEach(el => el.remove());
    lastGeneratedUrl = res.url;
    stopProgressPolling(); // captures the total duration BEFORE the hint is painted
    syncResultUrl('edit', { url: res.url });
    showToast('✨ Edited');
    if (btn) btn.disabled = false;
    pane.classList.remove('busy');
    spinner.classList.remove('show');
    setGenerating(pane, false);
    setGeneratingUi(false);
  }
  registerRecoverHandler(finalizeEdit);

  api('/api/edit', {
    image: src, mode, prompt, steps, seed, lora_config: loraConfig,
  }).then(res => {
    finalizeEdit(res);
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
      setGenerating(pane, false);
      setGeneratingUi(false);
    }
  });
}

// ── Steppers + seed ───────────────────────
function stepEditSteps(d) { const input = document.getElementById('editSteps'); input.value = Math.min(15, Math.max(1, parseInt(input.value) + d)); updatePromptChips(); }
function onEditStepsInput() {
  const input = document.getElementById('editSteps');
  const v = parseInt(input.value);
  if (isNaN(v) || v < 1) input.value = 1;
  if (v > 15) input.value = 15;
  updatePromptChips();
}
function stepEditSeed(d) { const input = document.getElementById('editSeed'); input.value = Math.max(0, parseInt(input.value) + d); updatePromptChips(); }
function onEditSeedInput() {
  const input = document.getElementById('editSeed');
  if (isNaN(parseInt(input.value))) input.value = 0;
  document.getElementById('editSeedRandom').checked = false;
  input.disabled = false;
  updatePromptChips();
}
function onEditSeedRandomToggle() {
  document.getElementById('editSeed').disabled = document.getElementById('editSeedRandom').checked;
  updatePromptChips();
}

// ── ↺ Reset ───────────────────────────────
function resetEdit() {
  // Cancel a running job + stop live preview/progress polling first, so the
  // cleared pane stays clean (nothing reappears over the placeholder).
  cancelIfRunning();
  document.getElementById('editSteps').value = '6';
  document.getElementById('editSeed').value = '0';
  document.getElementById('editSeedRandom').checked = true;
  document.getElementById('editSeed').disabled = true;
  clearPane('editOutputPane');
  syncResultUrl('edit', null); // no image shown — no URL hint
  updatePromptChips();
  showToast('Edit parameters reset');
}
