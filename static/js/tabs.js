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
      btnCol.innerHTML = '<button class="btn-generate" id="btnGenerate" onclick="generateImage()" title="Generate">✨</button>';
      break;
    case 'edit':
      bar.style.display = 'flex';
      input.style.display = 'block';
      input.placeholder = 'Describe the edit you want to apply (e.g., "change the background to a beach at sunset")...';
      btnCol.innerHTML = '<button class="btn-generate" id="btnEdit" onclick="generateEdit(\'edit\')" title="Edit">🖌️</button><button class="btn-generate btn-restore" id="btnRestore" onclick="generateEdit(\'restore\')" title="Restore (same as edit but with restoration prompt)">🩹</button>';
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
      btnCol.innerHTML = '<button class="btn-generate" id="btnVideo" onclick="generateVideo()" title="Video">🎬</button>';
      break;
  }

  // Landscape: relocate the prompt block into this tab's params pane
  relayoutPrompt();
}

// In landscape (≥1024px) the prompt block (textarea + action buttons) lives
// inside the active tab's params pane, pinned to its bottom; the result URL
// row stays in the bottom bar, full-width. Portrait: everything stays in the
// bottom bar as before. The block is a single shared element (same textarea,
// same value) — only its parent changes.
function relayoutPrompt() {
  const block = document.getElementById('promptBlock');
  const bar = document.getElementById('bottomBar');
  if (!block || !bar) return;
  const landscape = window.matchMedia('(min-width: 1024px)').matches;
  if (landscape) {
    const pane = document.querySelector(`#tab-${currentTab} .params-pane`);
    if (pane && block.parentElement !== pane) pane.appendChild(block);
  } else {
    if (block.parentElement !== bar) bar.insertBefore(block, bar.firstChild);
  }
}

// Radio group toggle (kept for the mockup's segmented controls)
function selectRadio(btn) {
  btn.parentElement.querySelectorAll('.radio-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
}
