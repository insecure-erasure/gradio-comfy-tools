// ── Tab switching ─────────────────────────
// Each tab's parameters persist (the DOM is never rebuilt); the copyable
// result URL row is cleared on switch, while the source fields and
// lastGeneratedUrl persist for chaining.

function switchTab(name) {
  // Save the prompt of the tab we're leaving into the per-tab store BEFORE
  // the shared textarea's value changes (the #promptInput element is a
  // single instance relocated between tabs). Upscale has no prompt — its
  // value is never stored so it cannot clobber another tab's text.
  const input0 = document.getElementById('promptInput');
  if (currentTab && currentTab !== 'upscale' && input0) {
    promptsByTab[currentTab] = input0.value;
  }
  currentTab = name;

  // Remove the upscale-specific buttons (portrait pane btn / landscape overlay)
  const prevPaneBtn = document.getElementById('btnUpscalePane');
  if (prevPaneBtn) prevPaneBtn.remove();
  const prevOverlay = document.getElementById('btnUpscaleLandscape');
  if (prevOverlay) prevOverlay.remove();

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
      input.closest('.prompt-input-wrap').style.display = '';
      input.placeholder = 'Describe the image you want to generate in detail...';
      btnCol.innerHTML = '<button class="btn-refine" onclick="refinePrompt()" title="Refine prompt" aria-label="Refine prompt">🪄</button><div class="btn-wrap"><button class="btn-generate" id="btnGenerate" onclick="generateImage()" title="Generate" data-requires-prompt>✨</button><button class="btn-catcher" onclick="showToast(\'Please write a prompt first\')" title="Write a prompt first"></button></div>';
      break;
    case 'edit':
      bar.style.display = 'flex';
      input.style.display = 'block';
      input.closest('.prompt-input-wrap').style.display = '';
      input.placeholder = 'Describe the edit you want to apply (e.g., "change the background to a beach at sunset")...';
      // 🖌️ needs a prompt (has catcher); 🩹 restore does not (always active);
      // 🪄 refines the prompt (to the LEFT of the edit button in landscape).
      btnCol.innerHTML = '<button class="btn-refine" onclick="refinePrompt()" title="Refine prompt" aria-label="Refine prompt">🪄</button><div class="btn-wrap"><button class="btn-generate" id="btnEdit" onclick="generateEdit(\'edit\')" title="Edit" data-requires-prompt>🖌️</button><button class="btn-catcher" onclick="showToast(\'Please write a prompt first\')" title="Write a prompt first"></button></div><button class="btn-generate btn-restore" id="btnRestore" onclick="generateEdit(\'restore\')" title="Restore">🩹</button>';
      break;
    case 'upscale':
      // Upscale has no prompt. In portrait, the bottom bar (prompt + action)
      // is hidden entirely and the 🔍 button moves into the params pane,
      // which only holds the seed — a compact special layout.
      input.closest('.prompt-input-wrap').style.display = 'none';
      if (window.matchMedia('(max-width: 1023px)').matches) {
        bar.style.display = 'none';
        btnCol.innerHTML = '';
        const pane = document.querySelector('#tab-upscale .params-pane');
        let btn = document.getElementById('btnUpscalePane');
        if (!btn) {
          btn = document.createElement('button');
          btn.id = 'btnUpscalePane';
          btn.className = 'btn-generate btn-upscale-pane';
          btn.textContent = '🔍';
          btn.title = 'Upscale';
          btn.onclick = generateUpscale;
          pane.appendChild(btn);
        }
      } else {
        bar.style.display = 'flex';
        btnCol.innerHTML = '<button class="btn-generate" id="btnUpscale" onclick="generateUpscale()" title="Upscale">🔍</button>';
      }
      break;
    case 'video':
      bar.style.display = 'flex';
      input.style.display = 'block';
      input.closest('.prompt-input-wrap').style.display = '';
      input.placeholder = 'Describe the motion and action (e.g., "a cat walking slowly through a field of flowers, gentle breeze")...';
      btnCol.innerHTML = '<button class="btn-refine" onclick="refinePrompt()" title="Refine prompt" aria-label="Refine prompt">🪄</button><div class="btn-wrap"><button class="btn-generate" id="btnVideo" onclick="generateVideo()" title="Video" data-requires-prompt>🎬</button><button class="btn-catcher" onclick="showToast(\'Please write a prompt first\')" title="Write a prompt first"></button></div>';
      break;
  }

  // Landscape: relocate the prompt block into this tab's params pane
  relayoutPrompt();

  // Restore this tab's own prompt (independent per tool — the textarea is
  // shared, so its value must be loaded from the per-tab store).
  const input1 = document.getElementById('promptInput');
  if (input1 && name !== 'upscale') {
    input1.value = promptsByTab[name] || '';
  }

  // Per-tab toolbar in the nav (model dropdown + ⚙️ + ↺)
  renderToolbar(name);

  // Enable/disable the action button(s) based on the prompt state
  updateActionButtons();
  // A generation running while switching tabs keeps the lock: switchTab
  // rebuilt #btnCol with fresh (enabled) buttons, so re-assert it.
  if (genLockActive) applyGenerationLock();

  // Portrait: sync the tabs dropdown trigger (icon) with the new tab
  updateTabsDropdown();
  // Keyboard tab switches (Ctrl+1..4) go through switchTab too — close the
  // dropdown so it never stays open over the new tab.
  closeTabsDropdown();
}

// Builds the per-tab toolbar (model dropdown + ⚙️ advanced + ↺ reset) in the
// nav bar, right-aligned. Upscale has no model dropdown (SeedVR2 is fixed).
function renderToolbar(tab) {
  const tb = document.getElementById('tabsToolbar');
  if (!tb) return;
  let html = '';
  if (tab === 'generate') {
    html += `<div class="toolbar-model"><label>Model</label>
      <select id="genModelFamily" onchange="onModelFamilyChange(); savePersistedState()">
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
      <select id="videoModelVersion" onchange="toolbarValues.vidVersion = this.value; savePersistedState()">
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
      if (currentTab === 'upscale') {
        // Upscale (landscape): no prompt bar and no prompt — the 🔍 button
        // sits at the bottom-right of the params pane, just above the result
        // URL row. The prompt block stays out (no textarea).
        ensureUpscaleButton();
        if (block && block.parentElement !== bar) bar.appendChild(block);
      } else {
        // Order matters: the prompt block first, the URL hint row below it.
        if (block && block.parentElement !== pane) pane.appendChild(block);
      }
      if (urlRow && urlRow.parentElement !== pane) pane.appendChild(urlRow);
    }
    bar.style.display = 'none';
  } else {
    if (currentTab === 'upscale') {
      // Upscale (portrait): no prompt bar — the 🔍 lives in the params pane
      // with the seed; the result URL row goes there too (below them).
      const pane = document.querySelector('#tab-upscale .params-pane');
      if (pane && urlRow && urlRow.parentElement !== pane) pane.appendChild(urlRow);
      bar.style.display = 'none';
      return;
    }
    if (block.parentElement !== bar) bar.insertBefore(block, bar.firstChild);
    if (urlRow && urlRow.parentElement !== bar) bar.appendChild(urlRow);
    bar.style.display = 'flex';
  }
}

// Creates/keeps the 🔍 button at the bottom-right of the upscale params pane
// (landscape layout), just above the result URL row. Removes the portrait
// params-pane button first.
function ensureUpscaleButton() {
  const paneBtn = document.getElementById('btnUpscalePane');
  if (paneBtn) paneBtn.remove();
  const pane = document.querySelector('#tab-upscale .params-pane');
  if (!pane) return;
  let btn = document.getElementById('btnUpscaleLandscape');
  if (!btn) {
    btn = document.createElement('button');
    btn.id = 'btnUpscaleLandscape';
    btn.className = 'btn-generate btn-upscale-landscape';
    btn.textContent = '🔍';
    btn.title = 'Upscale';
    btn.onclick = generateUpscale;
    // Insert just above the result URL row (which relayoutPrompt places in
    // the params pane), so the button sits at the pane's bottom-right.
    const urlRow = document.getElementById('resultUrlRow');
    if (urlRow && urlRow.parentElement === pane) {
      pane.insertBefore(btn, urlRow);
    } else {
      pane.appendChild(btn);
    }
  }
}

// ── Tabs dropdown (portrait only) ──────────
// On vertical displays the nav bar is too small for the four tab buttons,
// so they condense into this dropdown: the trigger shows the ACTIVE tab
// (icon + label) and the menu lists all four. Landscape keeps the inline
// tab buttons (the dropdown is display:none there — responsive.css).
let tabsDropdownOpen = false;

function toggleTabsDropdown(e) {
  e.stopPropagation();
  tabsDropdownOpen = !tabsDropdownOpen;
  const menu = document.getElementById('tabsDropdownMenu');
  const btn = document.getElementById('tabsDropdownBtn');
  if (tabsDropdownOpen) {
    // Anchor the fixed menu under the trigger: the nav bar (.tabs) clips
    // absolutely-positioned descendants via its overflow-x:auto, so the
    // menu is fixed and positioned from the trigger's viewport rect.
    const r = btn.getBoundingClientRect();
    menu.style.left = r.left + 'px';
    menu.style.top = (r.bottom + 4) + 'px';
  }
  menu.classList.toggle('show', tabsDropdownOpen);
  btn.classList.toggle('open', tabsDropdownOpen);
}

function closeTabsDropdown() {
  tabsDropdownOpen = false;
  const menu = document.getElementById('tabsDropdownMenu');
  const btn = document.getElementById('tabsDropdownBtn');
  if (menu) menu.classList.remove('show');
  if (btn) btn.classList.remove('open');
}

// Sync the dropdown trigger (icon + label) and the active item highlight
// with the currently active tab. Uses currentTab (set by switchTab) and
// reads the matching inline .tab-btn — NOT document.querySelector('.tab-btn.active'),
// which can hit a stale/inline first match: in portrait the inline .tab-btn
// are display:none and switchTab's document.querySelector('[data-tab=..]')
// may resolve to the dropdown ITEM (it comes first in the DOM), leaving
// .tab-btn.active stale. currentTab is the single source of truth.
function updateTabsDropdown() {
  const icon = document.getElementById('tabsDropdownIcon');
  const label = document.getElementById('tabsDropdownLabel');
  const btn = document.querySelector(`.tab-btn[data-tab="${currentTab}"]`);
  if (btn) {
    const aIcon = btn.querySelector('.tab-icon');
    const aLabel = btn.querySelector('.tab-label');
    if (aIcon) icon.textContent = aIcon.textContent;
    if (aLabel && label) label.textContent = aLabel.textContent;
  }
  document.querySelectorAll('.tabs-dropdown-item').forEach(item => {
    item.classList.toggle('active', item.dataset.tab === currentTab);
  });
}

// Close the tabs dropdown when clicking anywhere outside it (the trigger
// button stops propagation, so its own toggle is unaffected).
document.addEventListener('click', (e) => {
  if (tabsDropdownOpen && !e.target.closest('#tabsDropdown')) closeTabsDropdown();
});

// ── Prompt modal (portrait only) ───────────
// The compact single-line prompt in the bottom bar opens a fullscreen field
// when tapped (openPromptModal — wired to the textarea's onclick). The
// .prompt-input-wrap (textarea + ✕ clear + 🪄 refine) is RELOCATED into the
// modal — the same elements, so the value and every handler keep working —
// and moved back to #promptBlock on close. While open, the wrap gets
// .modal-mode: the overlay buttons return to their original layout (✕
// top-right, 🪄 bottom-right over the large textarea). The action buttons
// (.btn-col) never leave the bar.
function openPromptModal() {
  if (window.matchMedia('(min-width: 1024px)').matches) return; // portrait only
  const modal = document.getElementById('promptModal');
  if (!modal || modal.classList.contains('show')) return;
  const input = document.getElementById('promptInput');
  const wrap = input && input.closest('.prompt-input-wrap');
  const box = document.getElementById('promptModalBox');
  if (!wrap || !box) return;
  box.appendChild(wrap);
  wrap.classList.add('modal-mode');
  modal.classList.add('show');
  fitPromptModal();   // fit to the visible area BEFORE focusing (keyboard)
  input.focus();
}

function closePromptModal() {
  const modal = document.getElementById('promptModal');
  if (!modal || !modal.classList.contains('show')) return;
  const input = document.getElementById('promptInput');
  const wrap = input && input.closest('.prompt-input-wrap');
  const block = document.getElementById('promptBlock');
  if (wrap && block) {
    wrap.classList.remove('modal-mode');
    block.insertBefore(wrap, block.firstChild); // back before the button column
  }
  modal.classList.remove('show');
  // Clear the visual-viewport fit (top/height) so the CSS inset:0 takes over.
  modal.style.top = '';
  modal.style.height = '';
}

// Fit the fullscreen prompt modal to the ACTUAL visible area. The mobile
// keyboard does NOT resize position:fixed elements — the layout viewport
// stays the same and the keyboard just overlays it, so the textarea would
// end up hidden behind the keyboard. window.visualViewport tracks the real
// visible area (its height shrinks / offsetTop changes when the keyboard
// opens, closes or the page zooms); on every such event we set the modal's
// top + height to match it. With both top and height inline, the CSS
// bottom:0 (from inset:0) is ignored per the abs/fixed box rules.
function fitPromptModal() {
  const vv = window.visualViewport;
  if (!vv) return;
  const modal = document.getElementById('promptModal');
  if (!modal || !modal.classList.contains('show')) return;
  modal.style.top = (vv.offsetTop || 0) + 'px';
  modal.style.height = vv.height + 'px';
}

if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', fitPromptModal);
  window.visualViewport.addEventListener('scroll', fitPromptModal);
}

// Radio group toggle (kept for the mockup's segmented controls)
function selectRadio(btn) {
  btn.parentElement.querySelectorAll('.radio-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
}
