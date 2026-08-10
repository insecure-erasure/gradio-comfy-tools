// ── Video tab 🎬 ──────────────────────────
// POST /api/video -> real <video> player from /media proxy.

function generateVideo() {
  const src = getSourceUrl('video');
  if (!src) return showToast('No source image — paste a URL or use 🔗/📁');
  const mv = document.getElementById('videoModelVersion')?.value || 'wan21';
  const frames = parseInt(document.getElementById('videoFrames')?.value) || 81;
  const steps = parseInt(document.getElementById('videoSteps')?.value) || 4;
  const seedEl = document.getElementById('videoSeed');
  const randomEl = document.getElementById('videoSeedRandom');
  let seed;
  if (randomEl && randomEl.checked) {
    // 🎲 enabled → generate now and show the value that will be sent
    seed = randomSeed();
    if (seedEl) seedEl.value = seed;
  } else {
    seed = parseInt(seedEl?.value) || 0;
  }
  const prompt = document.getElementById('promptInput')?.value || '';
  // Advanced modal (⚙️): negative prompt, diffusion model override + LoRA config.
  // Video stores per-version config (wan21/wan22) — read the active one.
  const adv = (window.advancedValues && window.advancedValues.video) || {};
  const vstore = adv[mv] || adv; // per-version store, fallback to flat
  const negative = vstore.negative || '';
  const diffusion = vstore.diffusion || '';
  // LoRAs: wan21 -> loraSets.main (no path); wan22 -> loraSets.high/low (with
  // path, the backend filters them per path). Fall back to adv.lora for older
  // sessions.
  const loraSets = vstore.loraSets || {};
  let loraConfig = adv.lora || '[]';
  if (loraSets.main) loraConfig = loraSets.main;
  else if (loraSets.high || loraSets.low) {
    loraConfig = JSON.stringify([
      ...(JSON.parse(loraSets.high || '[]')).map(r => ({ ...r, path: 'high' })),
      ...(JSON.parse(loraSets.low || '[]')).map(r => ({ ...r, path: 'low' })),
    ]);
  }

  if (!prompt.trim()) return showToast('Please write a prompt first');

  const pane = document.getElementById('videoOutputPane');
  const spinner = document.getElementById('videoSpinner');
  const mock = pane.querySelector('.video-mock');
  const btn = document.getElementById('btnVideo') || document.querySelector('#btnCol .btn-generate');
  if (btn) btn.disabled = true;
  pane.classList.add('busy');
  spinner.classList.add('show');
  setGenerating(pane, true);
  showToast('Video submitted to ComfyUI...');
  startProgressPolling();
  setGeneratingUi(true, 'btnVideo');

  api('/api/video', {
    image: src, model_version: mv, prompt, negative_prompt: negative,
    frames, steps, seed, lora_config: loraConfig, diffusion,
  }).then(res => {
    // Remove the mock player from the DOM (not just hide it): it is a
    // flex block with width:100%, so leaving it (even display:none inline)
    // gets restored by stopProgressPolling and pushes the real <video> to
    // the side. showResult then fills the pane.
    if (mock) mock.remove();
    showResult('videoOutputPane', res, true);
    // If the user switched away while the video was generating, don't let
    // the autoplaying result keep consuming resources hidden behind another
    // tab — pause it (the ▶ button shows ▶; a click resumes). No-op if the
    // user is (back) on the Video tab.
    if (typeof currentTab !== 'undefined' && currentTab !== 'video') {
      pauseActiveVideo();
    }
    // Video gallery (B5, deferred): mark the element + collect the URL for
    // a future video gallery (native controls don't mix with navigation).
    const vid = document.getElementById('videoOutputPane').querySelector('.result-video');
    if (vid) vid.dataset.videoGallery = '1';
    collectVideoUrl(res, prompt);
    lastGeneratedUrl = res.url;
    document.getElementById('resultUrl').textContent = res.url;
    document.getElementById('btnCopyUrl').disabled = false;
    showToast('🎬 Video ready');
  }).catch(err => {
    document.getElementById('resultUrl').textContent = '';
    showToast('❌ ' + (err && err.name === 'AbortError' ? (userCancelled ? 'Cancelled' : 'Timed out — try again') : (err.message || err)));
  }).finally(() => {
    userCancelled = false;
    stopProgressPolling();
    if (btn) btn.disabled = false;
    pane.classList.remove('busy');
    spinner.classList.remove('show');
    setGenerating(pane, false);
    setGeneratingUi(false);
  });
}

// ── Steppers + frames snap + seed ─────────
// Snap to the nearest 4n+1 (WAN temporal VAE stride), clamped to [81,161] —
// same logic as _snap_to_valid_frames in tools/video.py.
function snapVideoFrames(v) {
  v = Math.min(161, Math.max(81, v));
  let snapped = Math.floor((v - 1) / 4) * 4 + 1;
  if (v - snapped > 2) snapped += 4;
  return Math.min(snapped, 161);
}
function stepVideoFrames(d) { const input = document.getElementById('videoFrames'); input.value = snapVideoFrames(parseInt(input.value) + d); updatePromptChips(); }
function onVideoFramesInput() { const input = document.getElementById('videoFrames'); input.value = snapVideoFrames(parseInt(input.value)); updatePromptChips(); }
function stepVideoSteps(d) { const input = document.getElementById('videoSteps'); const val = Math.min(10, Math.max(4, parseInt(input.value) + d)); input.value = val; updatePromptChips(); }
function onVideoStepsInput() {
  const input = document.getElementById('videoSteps');
  const v = parseInt(input.value);
  if (isNaN(v) || v < 4) input.value = 4;
  if (v > 10) input.value = 10;
  updatePromptChips();
}
function stepVideoSeed(d) { const input = document.getElementById('videoSeed'); input.value = Math.max(0, parseInt(input.value) + d); updatePromptChips(); }
function onVideoSeedInput() {
  const input = document.getElementById('videoSeed');
  if (isNaN(parseInt(input.value))) input.value = 0;
  document.getElementById('videoSeedRandom').checked = false;
  input.disabled = false;
  updatePromptChips();
}
function onVideoSeedRandomToggle() {
  document.getElementById('videoSeed').disabled = document.getElementById('videoSeedRandom').checked;
  updatePromptChips();
}

// ── ↺ Reset ───────────────────────────────
function resetVideo() {
  // Cancel a running job + stop live preview/progress polling first, so the
  // cleared pane stays clean.
  cancelIfRunning();
  const mv = document.getElementById('videoModelVersion');
  if (mv) mv.selectedIndex = 0; // Wan 2.1
  document.getElementById('videoFrames').value = '81';
  document.getElementById('videoSteps').value = '4';
  document.getElementById('videoSeed').value = '0';
  document.getElementById('videoSeedRandom').checked = true;
  document.getElementById('videoSeed').disabled = true;
  // Clear the active version's advanced-modal config (negative, loras, model)
  if (window.advancedValues && window.advancedValues.video) {
    const version = mv ? mv.value : 'wan21';
    if (window.advancedValues.video[version]) {
      delete window.advancedValues.video[version];
    } else {
      window.advancedValues.video.negative = '';
    }
  }
  clearPane('videoOutputPane');
  updatePromptChips();
  showToast('Video parameters reset');
}
