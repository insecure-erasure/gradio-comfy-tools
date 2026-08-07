// ── Tab switching ─────────────────────────
// Each tab's parameters persist (the DOM is never rebuilt); the copyable
// result URL row is cleared on switch, while the source fields and
// lastGeneratedUrl persist for chaining.

function switchTab(name) {
  currentTab = name;
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.querySelector(`[data-tab="${name}"]`).classList.add('active');
  document.getElementById(`tab-${name}`).classList.add('active');

  // Update prompt bar
  const bar = document.getElementById('bottomBar');
  const input = document.getElementById('promptInput');
  const btnCol = document.getElementById('btnCol');

  // Reset the copyable result URL row when switching tools. The source
  // image URL fields (Edit/Upscale/Video) keep their values and
  // lastGeneratedUrl persists for chaining (🔗 fills the source field).
  document.getElementById('resultUrl').textContent = '';
  document.getElementById('btnCopyUrl').disabled = true;

  switch (name) {
    case 'generate':
      bar.style.display = 'flex';
      input.style.display = 'block';
      input.placeholder = 'Describe the image you want to generate in detail...';
      btnCol.innerHTML = '<div class="btn-wrap"><button class="btn-generate" id="btnGenerate" onclick="generateImage()" title="Generate" data-requires-prompt>✨</button><button class="btn-catcher" onclick="showToast(\'Please write a prompt first\')" title="Write a prompt first"></button></div>';
      break;
    case 'edit':
      bar.style.display = 'flex';
      input.style.display = 'block';
      input.placeholder = 'Describe the edit you want to apply (e.g., "change the background to a beach at sunset")...';
      // 🖌️ needs a prompt (has catcher); 🩹 restore does not (always active)
      btnCol.innerHTML = '<div class="btn-wrap"><button class="btn-generate" id="btnEdit" onclick="generateEdit(\'edit\')" title="Edit" data-requires-prompt>🖌️</button><button class="btn-catcher" onclick="showToast(\'Please write a prompt first\')" title="Write a prompt first"></button></div><button class="btn-generate btn-restore" id="btnRestore" onclick="generateEdit(\'restore\')" title="Restore">🩹</button>';
      break;
    case 'upscale':
      bar.style.display = 'flex';
      input.style.display = 'none';
      btnCol.innerHTML = '<button class="btn-generate" id="btnUpscale" onclick="generateUpscale()" title="Upscale">🔍</button>';
      break;
    case 'video':
      bar.style.display = 'flex';
      input.style.display = 'block';
      input.placeholder = 'Describe the motion and action (e.g., "a cat walking slowly through a field of flowers, gentle breeze")...';
      btnCol.innerHTML = '<div class="btn-wrap"><button class="btn-generate" id="btnVideo" onclick="generateVideo()" title="Video" data-requires-prompt>🎬</button><button class="btn-catcher" onclick="showToast(\'Please write a prompt first\')" title="Write a prompt first"></button></div>';
      break;
  }

  // Landscape: relocate the prompt block into this tab's params pane
  relayoutPrompt();

  // Per-tab toolbar in the nav (model dropdown + ⚙️ + ↺)
  renderToolbar(name);

  // Enable/disable the action button(s) based on the prompt state
  updateActionButtons();
}

// Builds the per-tab toolbar (model dropdown + ⚙️ advanced + ↺ reset) in the
// nav bar, right-aligned. Upscale has no model dropdown (SeedVR2 is fixed).
function renderToolbar(tab) {
  const tb = document.getElementById('tabsToolbar');
  if (!tb) return;
  let html = '';
  if (tab === 'generate') {
    html += `<div class="toolbar-model"><label>Model</label>
      <select id="genModelFamily" onchange="onModelFamilyChange()">
        <option value="krea2" data-key="krea2" data-steps="8" data-vae="8">Krea 2</option>
        <option value="flux2" data-key="flux2" data-steps="8" data-vae="64">FLUX.2 Klein</option>
        <option value="zimage" data-key="zimage" data-steps="10" data-vae="16">Z-Image Turbo</option>
      </select></div>
      <button class="btn-gear-inline" onclick="openAdvancedModal()" title="Advanced parameters">⚙️</button>
      <button class="btn-reset" onclick="resetGenerate()" title="Reset">↺</button>`;
  } else if (tab === 'edit') {
    html += `<button class="btn-gear-inline" onclick="openAdvancedModal()" title="Advanced parameters">⚙️</button>
      <button class="btn-reset" onclick="resetEdit()" title="Reset">↺</button>`;
  } else if (tab === 'upscale') {
    html += `<button class="btn-reset" onclick="resetUpscale()" title="Reset">↺</button>`;
  } else if (tab === 'video') {
    html += `<div class="toolbar-model"><label>Model</label>
      <select id="videoModelVersion" onchange="toolbarValues.vidVersion = this.value">
        <option value="wan21" data-key="wan21">Wan 2.1</option>
        <option value="wan22" data-key="wan22">Wan 2.2</option>
      </select></div>
      <button class="btn-gear-inline" onclick="openAdvancedModal()" title="Advanced parameters">⚙️</button>
      <button class="btn-reset" onclick="resetVideo()" title="Reset">↺</button>`;
  }
  tb.innerHTML = html;
  // restore persisted selections
  if (tab === 'generate' && document.getElementById('genModelFamily')) {
    document.getElementById('genModelFamily').value = toolbarValues.genFamily;
  }
  if (tab === 'video' && document.getElementById('videoModelVersion')) {
    document.getElementById('videoModelVersion').value = toolbarValues.vidVersion;
  }
}

// In landscape (≥1024px) the prompt block (textarea + action buttons) AND the
// result URL row live inside the active tab's params pane — the URL hint sits
// below the textarea — and the bottom bar is hidden entirely, gaining vertical
// space. Portrait: everything stays in the bottom bar as before. The block and
// URL row are single shared elements (same textarea, same value) — only their
// parent changes.
function relayoutPrompt() {
  const block = document.getElementById('promptBlock');
  const urlRow = document.getElementById('resultUrlRow');
  const bar = document.getElementById('bottomBar');
  if (!block || !bar) return;
  const landscape = window.matchMedia('(min-width: 1024px)').matches;
  if (landscape) {
    const pane = document.querySelector(`#tab-${currentTab} .params-pane`);
    if (pane) {
      if (block.parentElement !== pane) pane.appendChild(block);
      if (urlRow && urlRow.parentElement !== pane) pane.appendChild(urlRow);
    }
    bar.style.display = 'none';
  } else {
    if (block.parentElement !== bar) bar.insertBefore(block, bar.firstChild);
    if (urlRow && urlRow.parentElement !== bar) bar.appendChild(urlRow);
    bar.style.display = 'flex';
  }
}

// Radio group toggle (kept for the mockup's segmented controls)
function selectRadio(btn) {
  btn.parentElement.querySelectorAll('.radio-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
}
