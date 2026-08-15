// ── Upscale tab 🔍 ────────────────────────
// POST /api/upscale -> before/after compare slider (Original | Upscaled).
// No prompt, no advanced modal — only the source image and seed.

function generateUpscale() {
  const src = getSourceUrl('upscale');
  if (!src) return showToast('No source image — paste a URL or use 🔗/📁');
  const seedEl = document.getElementById('upscaleSeed');
  const randomEl = document.getElementById('upscaleSeedRandom');
  let seed;
  if (randomEl && randomEl.checked) {
    // 🎲 enabled → generate now and show the value that will be sent
    seed = randomSeed();
    if (seedEl) seedEl.value = seed;
  } else {
    seed = parseInt(seedEl?.value) || 0;
  }

  const pane = document.getElementById('upscaleOutputPane');
  const spinner = document.getElementById('upscaleSpinner');
  const btn = document.getElementById('btnUpscale') || document.querySelector('#btnCol .btn-generate');
  if (btn) btn.disabled = true;
  pane.classList.add('busy');
  spinner.classList.add('show');
  setGenerating(pane, true);
  showToast('Upscale submitted to ComfyUI...');
  startProgressPolling();
  setGeneratingUi(true, window.matchMedia('(max-width: 1023px)').matches ? 'btnUpscalePane' : 'btnUpscaleLandscape');

  // Shared finalize (normal fetch OR focus-recovery of a lost job).
  function finalizeUpscale(res) {
    // Compare slider: original vs upscaled — this IS the result.
    const beforeEl = document.getElementById('upscaleBefore');
    const afterEl = document.getElementById('upscaleAfter');
    const cmp = document.getElementById('upscaleCompare');
    if (beforeEl && afterEl) {
      // Resolve the source through the SAME-ORIGIN proxy (/media) — the
      // pane cannot load the ComfyUI host URL directly (CORS/host
      // validation). beforeProxyUrl handles external URLs, /media/..,
      // {base}/view?.. and bare temp filenames.
      const beforeSrc = beforeProxyUrl(src);
      beforeEl.src = beforeSrc;
      afterEl.src = res.display;
      cmp.style.setProperty('--p', '50%');
      cmp.style.display = '';
      // Gallery marker: the upscaled result joins the compare gallery
      // (identity = AFTER image); no prompt caption for upscale.
      cmp.dataset.gallery = '1';
      cmp.dataset.kind = 'upscale';
      // Compare gallery: register the comparison in the session registry.
      addCompareEntry({
        src: res.display,
        before: beforeSrc,
        prompt: '',
        kind: 'upscale',
        tab: 'upscale',
      });
      // Generated history: an upscale REPLACES the source entry in the
      // lightbox gallery (keeping its generation prompt, badge = upscaled);
      // non-generated sources are appended.
      addTransformedEntry(res, '', 'upscaled', src);
    }
    // Hide any plain result image; the compare slider is the display
    pane.querySelectorAll('.result-img, .output-placeholder, .source-preview').forEach(el => el.remove());
    lastGeneratedUrl = res.url;
    stopProgressPolling(); // captures the total duration BEFORE the hint is painted
    syncResultUrl('upscale', { url: res.url });
    showToast('🔍 Upscaled');
    if (btn) btn.disabled = false;
    pane.classList.remove('busy');
    spinner.classList.remove('show');
    setGenerating(pane, false);
    setGeneratingUi(false);
  }
  registerRecoverHandler(finalizeUpscale);

  api('/api/upscale', { image: src, seed }).then(res => {
    finalizeUpscale(res);
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
function stepUpscaleSeed(d) { const input = document.getElementById('upscaleSeed'); input.value = Math.max(0, parseInt(input.value) + d); }
function onUpscaleSeedInput() {
  const input = document.getElementById('upscaleSeed');
  if (isNaN(parseInt(input.value))) input.value = 0;
  document.getElementById('upscaleSeedRandom').checked = false;
  input.disabled = false;
}
function onUpscaleSeedRandomToggle() {
  document.getElementById('upscaleSeed').disabled = document.getElementById('upscaleSeedRandom').checked;
}

// ── ↺ Reset ───────────────────────────────
function resetUpscale() {
  // Cancel a running job + stop live preview/progress polling first, so the
  // cleared pane stays clean.
  cancelIfRunning();
  document.getElementById('upscaleSeed').value = '0';
  document.getElementById('upscaleSeedRandom').checked = true;
  document.getElementById('upscaleSeed').disabled = true;
  clearPane('upscaleOutputPane');
  syncResultUrl('upscale', null); // no image shown — no URL hint
  showToast('Upscale parameters reset');
}
