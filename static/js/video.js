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
  const seed = (randomEl && randomEl.checked) ? -1 : (parseInt(seedEl?.value) || 0);
  const prompt = document.getElementById('promptInput')?.value || '';
  const negative = document.getElementById('videoNegative')?.value || '';
  // Advanced modal (⚙️): diffusion model override + LoRA config
  const adv = (window.advancedValues && window.advancedValues.video) || {};
  const loraConfig = adv.lora || '[]';
  const diffusion = adv.diffusion || '';

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

  api('/api/video', {
    image: src, model_version: mv, prompt, negative_prompt: negative,
    frames, steps, seed, lora_config: loraConfig, diffusion,
  }).then(res => {
    // Hide the mock player; show the real video
    if (mock) mock.style.display = 'none';
    showResult('videoOutputPane', res, true);
    lastGeneratedUrl = res.url;
    document.getElementById('resultUrl').textContent = res.url;
    document.getElementById('btnCopyUrl').disabled = false;
    showToast('🎬 Video ready');
  }).catch(err => {
    showToast('❌ ' + (err && err.name === 'AbortError' ? 'Timed out — try again' : (err.message || err)));
  }).finally(() => {
    if (btn) btn.disabled = false;
    pane.classList.remove('busy');
    spinner.classList.remove('show');
    setGenerating(pane, false);
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
function stepVideoFrames(d) { const input = document.getElementById('videoFrames'); input.value = snapVideoFrames(parseInt(input.value) + d); }
function onVideoFramesInput() { const input = document.getElementById('videoFrames'); input.value = snapVideoFrames(parseInt(input.value)); }
function stepVideoSteps(d) { const input = document.getElementById('videoSteps'); const val = Math.min(10, Math.max(4, parseInt(input.value) + d)); input.value = val; }
function onVideoStepsInput() {
  const input = document.getElementById('videoSteps');
  const v = parseInt(input.value);
  if (isNaN(v) || v < 4) input.value = 4;
  if (v > 10) input.value = 10;
}
function stepVideoSeed(d) { const input = document.getElementById('videoSeed'); input.value = Math.max(0, parseInt(input.value) + d); }
function onVideoSeedInput() {
  const input = document.getElementById('videoSeed');
  if (isNaN(parseInt(input.value))) input.value = 0;
  document.getElementById('videoSeedRandom').checked = false;
  input.disabled = false;
}
function onVideoSeedRandomToggle() {
  document.getElementById('videoSeed').disabled = document.getElementById('videoSeedRandom').checked;
}

// ── ↺ Reset ───────────────────────────────
function resetVideo() {
  const mv = document.getElementById('videoModelVersion');
  if (mv) mv.selectedIndex = 0; // Wan 2.1
  document.getElementById('videoFrames').value = '81';
  document.getElementById('videoSteps').value = '4';
  document.getElementById('videoSeed').value = '0';
  document.getElementById('videoSeedRandom').checked = true;
  document.getElementById('videoSeed').disabled = true;
  const neg = document.getElementById('videoNegative');
  if (neg) neg.value = '';
  clearPane('videoOutputPane');
  showToast('Video parameters reset');
}
