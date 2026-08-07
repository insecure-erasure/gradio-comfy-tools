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

  api('/api/upscale', { image: src, seed }).then(res => {
    // Compare slider: original vs upscaled — this IS the result.
    const beforeEl = document.getElementById('upscaleBefore');
    const afterEl = document.getElementById('upscaleAfter');
    const cmp = document.getElementById('upscaleCompare');
    if (beforeEl && afterEl) {
      // Resolve the source through the media proxy (temp filename or external URL)
      const srcIsUrl = /^https?:\/\//i.test(src);
      beforeEl.src = srcIsUrl ? src : '/media/' + encodeURIComponent(src.split('/').pop()) + '?type=temp';
      afterEl.src = res.display;
      cmp.style.setProperty('--p', '50%');
      cmp.style.display = '';
    }
    // Hide any plain result image; the compare slider is the display
    pane.querySelectorAll('.result-img, .output-placeholder, .source-preview').forEach(el => el.remove());
    lastGeneratedUrl = res.url;
    document.getElementById('resultUrl').textContent = res.url;
    document.getElementById('btnCopyUrl').disabled = false;
    showToast('🔍 Upscaled');
  }).catch(err => {
    document.getElementById('resultUrl').textContent = '';
    showToast('❌ ' + (err && err.name === 'AbortError' ? 'Timed out — try again' : (err.message || err)));
  }).finally(() => {
    stopProgressPolling();
    if (btn) btn.disabled = false;
    pane.classList.remove('busy');
    spinner.classList.remove('show');
    setGenerating(pane, false);
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
  document.getElementById('upscaleSeed').value = '0';
  document.getElementById('upscaleSeedRandom').checked = true;
  document.getElementById('upscaleSeed').disabled = true;
  clearPane('upscaleOutputPane');
  showToast('Upscale parameters reset');
}
