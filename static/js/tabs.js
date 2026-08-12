// ── Tab switching ─────────────────────────
// Each tab's parameters persist (the DOM is never rebuilt); the copyable
// result URL row is cleared on switch, while the source fields and
// lastGeneratedUrl persist for chaining.

function switchTab(name) {
  // Leaving the Video tab pauses a playing video: hidden behind another tab
  // it would keep consuming resources (CPU/decoding) for nothing. No-op
  // when re-selecting Video itself (Ctrl+4 while already on Video).
  if (currentTab === 'video' && currentTab !== name) {
    pauseActiveVideo();
  }

  currentTab = name;

  // Remove the upscale-specific buttons (portrait pane btn / landscape overlay)
  const prevPaneBtn = document.getElementById('btnUpscalePane');
  if (prevPaneBtn) prevPaneBtn.remove();
  const prevOverlay = document.getElementById('btnUpscaleLandscape');
  if (prevOverlay) prevOverlay.remove();

  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  // Qualify with .tab-btn: the portrait tabs dropdown (tabs-dropdown-item)
  // sits BEFORE the inline tab buttons in the DOM, so a bare [data-tab=..]
  // selector would add .active to the HIDDEN dropdown item instead of the
  // visible tab button — leaving no accent on the selected tab in landscape.
  // The dropdown items get their highlight from updateTabsDropdown() (below),
  // which uses currentTab as the single source of truth.
  document.querySelector(`.tab-btn[data-tab="${name}"]`).classList.add('active');
  document.getElementById(`tab-${name}`).classList.add('active');

  // Update prompt bar. The .prompt-input-wrap holds one textarea per tab;
  // switchTab only toggles which field is visible (see the .active class).
  const bar = document.getElementById('bottomBar');
  const wrap = document.querySelector('.prompt-input-wrap');
  const btnCol = document.getElementById('btnCol');

  // Reset the copyable result URL row when switching tools. The source
  // image URL fields (Edit/Upscale/Video) keep their values and
  // lastGeneratedUrl persists for chaining (🔗 fills the source field).
  document.getElementById('resultUrl').textContent = '';
  document.getElementById('resultUrl').title = '';
  document.getElementById('btnCopyUrl').disabled = true;

  switch (name) {
    case 'generate':
      bar.style.display = 'flex';
      wrap.style.display = '';
      btnCol.innerHTML = '<button class="btn-refine" onclick="refinePrompt()" title="Refine prompt" aria-label="Refine prompt">🪄</button><div class="btn-wrap"><button class="btn-generate" id="btnGenerate" onclick="generateImage()" title="Generate" data-requires-prompt>✨</button><button class="btn-catcher" onclick="showToast(\'Please write a prompt first\')" title="Write a prompt first"></button></div>';
      break;
    case 'edit':
      bar.style.display = 'flex';
      wrap.style.display = '';
      // 🪄 refines the prompt; 🩹 restore is always active (no prompt);
      // 🖌️ needs a prompt (has catcher). Order left→right (landscape row)
      // / top→bottom (portrait column): 🪄 · 🩹 · 🖌️ — matching the
      // portrait prompt modal's action pills (🪄 🩹 🖌️).
      btnCol.innerHTML = '<button class="btn-refine" onclick="refinePrompt()" title="Refine prompt" aria-label="Refine prompt">🪄</button><button class="btn-generate btn-restore" id="btnRestore" onclick="generateEdit(\'restore\')" title="Restore">🩹</button><div class="btn-wrap"><button class="btn-generate" id="btnEdit" onclick="generateEdit(\'edit\')" title="Edit" data-requires-prompt>🖌️</button><button class="btn-catcher" onclick="showToast(\'Please write a prompt first\')" title="Write a prompt first"></button></div>';
      break;
    case 'upscale':
      // Upscale has no prompt. In portrait, the bottom bar (prompt + action)
      // is hidden entirely and the 🔍 button moves into the params pane,
      // which only holds the seed — a compact special layout.
      wrap.style.display = 'none';
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
      wrap.style.display = '';
      btnCol.innerHTML = '<button class="btn-refine" onclick="refinePrompt()" title="Refine prompt" aria-label="Refine prompt">🪄</button><div class="btn-wrap"><button class="btn-generate" id="btnVideo" onclick="generateVideo()" title="Video" data-requires-prompt>🎬</button><button class="btn-catcher" onclick="showToast(\'Please write a prompt first\')" title="Write a prompt first"></button></div>';
      break;
  }

  // Landscape: relocate the prompt block into this tab's params pane
  relayoutPrompt();

  // Show ONLY the active tab's textarea. Each tab owns its field and its
  // value — nothing is copied between tabs, so prompts can never mix.
  document.querySelectorAll('.prompt-input').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === name);
  });

  // Per-tab toolbar in the nav (model dropdown + ⚙️ + ↺)
  renderToolbar(name);

  // Per-tab parameter chips overlaid on the prompt field (Generate: 📏 dims
  // + 👣 steps/seed — the other tabs keep their params-pane controls for now)
  renderPromptChips();
  // The modal's action buttons (🩹 restore show/hide, per-tab ✨ glyph) must
  // follow the new tab even when the modal is already open (openPromptModal
  // early-returns in that case).
  updatePromptModalActions();

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
  // A chip popover left open on the old tab must not survive the switch.
  closeChipPopover();
  // Lazy-restore the incoming tab's last result (only if its pane is empty
  // — a live session wins over persisted state).
  restoreTabResult(name);
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
      <button class="btn-reset" onclick="resetGenerate()" title="Reset">↺</button>
      <button class="btn-reset btn-trash" onclick="trashCurrentTab()" title="Clear gallery">🗑️</button>`;
  } else if (tab === 'edit') {
    html += `<button class="btn-gear-inline" onclick="openAdvancedModal()" title="Advanced parameters">⚙️</button>
      <button class="btn-reset" onclick="resetEdit()" title="Reset">↺</button>
      <button class="btn-reset btn-trash" onclick="trashCurrentTab()" title="Clear gallery">🗑️</button>`;
  } else if (tab === 'upscale') {
    html += `<button class="btn-reset" onclick="resetUpscale()" title="Reset">↺</button>
      <button class="btn-reset btn-trash" onclick="trashCurrentTab()" title="Clear gallery">🗑️</button>`;
  } else if (tab === 'video') {
    html += `<div class="toolbar-model"><label>Model</label>
      <select id="videoModelVersion" onchange="toolbarValues.vidVersion = this.value; savePersistedState()">
        <option value="wan21" data-key="wan21">Wan 2.1</option>
        <option value="wan22" data-key="wan22">Wan 2.2</option>
      </select></div>
      <button class="btn-gear-inline" onclick="openAdvancedModal()" title="Advanced parameters">⚙️</button>
      <button class="btn-reset" onclick="resetVideo()" title="Reset">↺</button>
      <button class="btn-reset btn-trash" onclick="trashCurrentTab()" title="Clear gallery">🗑️</button>`;
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
  const input = activePromptInput();
  const wrap = document.querySelector('.prompt-input-wrap');
  const box = document.getElementById('promptModalBox');
  if (!wrap || !box) return;
  box.appendChild(wrap);
  wrap.classList.add('modal-mode');
  modal.classList.add('show');
  fitPromptModal();   // fit to the visible area BEFORE focusing (keyboard)
  updatePromptModalActions();
  // A generation running while the modal opens: the direct-generate button
  // must become the ⏹ stop button, not a disabled ✨.
  if (genLockActive) {
    const b = document.getElementById('promptGenerateBtn');
    if (b) makeStopButton(b);
  }
  input.focus();
}

function closePromptModal() {
  const modal = document.getElementById('promptModal');
  if (!modal || !modal.classList.contains('show')) return;
  const wrap = document.querySelector('.prompt-input-wrap');
  const block = document.getElementById('promptBlock');
  if (wrap && block) {
    wrap.classList.remove('modal-mode');
    block.insertBefore(wrap, block.firstChild); // back before the button column
  }
  modal.classList.remove('show');
  // Clear the visual-viewport fit (top/height) so the CSS inset:0 takes over.
  modal.style.top = '';
  modal.style.height = '';
  // The chips moved with the wrap — a popover anchored to them is stale now.
  closeChipPopover();
}

// Dismiss the portrait prompt modal when tapping OUTSIDE the prompt field:
// a click on the modal's backdrop (header, empty box space) closes it, while
// clicks on the textarea and its overlay buttons/chips (all inside
// .prompt-input-wrap) keep working. The chip popover (#chipPopover) is a
// TOP-LEVEL element (outside the wrap) but only opens from a chip inside it
// — without this exemption, tapping the popover's own controls (📐 select,
// the +/− steppers) would close the whole modal: the AR picker got dismissed
// mid-selection (value never persisted) and the steppers killed the dialog
// instantly. Portrait-only: in landscape the modal is never shown.
document.addEventListener('click', e => {
  const modal = document.getElementById('promptModal');
  if (!modal || !modal.classList.contains('show')) return;
  if (!e.target.closest('.prompt-input-wrap, #chipPopover')) closePromptModal();
});

// ── Prompt modal direct actions ────────────
// The portrait prompt modal has overlay pills in its bottom-right corner:
// 🪄 refine (existing) + ✨ direct generation (per tab). The generate button
// is the SAME class as the toolbar buttons (.btn-generate) so the generation
// lock (makeStopButton/applyGenerationLock in api.js) turns it into the ⏹
// stop button automatically.

// Direct generation from the prompt modal: validates the prompt first (the
// per-tab generators do too, but we must not close the modal when there is
// nothing to run), closes the modal, then runs the active tab's action.
function promptModalGenerate() {
  const input = activePromptInput();
  const prompt = (input && input.value || '').trim();
  const needsPrompt = currentTab === 'generate' || currentTab === 'edit' || currentTab === 'video';
  if (needsPrompt && !prompt) return showToast('Please write a prompt first');
  closePromptModal();
  switch (currentTab) {
    case 'generate': generateImage(); break;
    case 'edit': generateEdit('edit'); break;
    case 'video': generateVideo(); break;
  }
}

// 🩹 Restore from the prompt modal (Edit only): no prompt required — closes
// the modal and runs the restore directly.
function promptModalRestore() {
  closePromptModal();
  generateEdit('restore');
}

// Set the glyph/title of the modal's direct-generate button for the active
// tab, and show/hide the 🩹 restore button (Edit only — the other tabs have
// no restore). Upscale has no prompt modal — hidden defensively. Skipped
// while a button is transformed into the ⏹ stop button (makeStopButton
// stash).
function updatePromptModalActions() {
  const btn = document.getElementById('promptGenerateBtn');
  const restore = document.getElementById('promptRestoreBtn');
  if (!btn) return;
  const cfg = {
    generate: { glyph: '✨', title: 'Generate' },
    edit: { glyph: '🖌️', title: 'Edit' },
    video: { glyph: '🎬', title: 'Generate video' },
  }[currentTab];
  if (!cfg) { btn.style.display = 'none'; if (restore) restore.style.display = 'none'; return; }
  btn.style.display = '';
  if (restore) restore.style.display = currentTab === 'edit' ? '' : 'none';
  if (_genStopOrig.has(btn)) return; // already the ⏹ stop button
  btn.textContent = cfg.glyph;
  btn.title = cfg.title;
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

// ── Prompt parameter chips ─────────────────
// The per-tab parameter buttons are unified as chips OVERLAYED on the prompt
// textarea (.prompt-chips inside .prompt-input-wrap); clicking one opens a
// small popover (#chipPopover) with the actual controls. Each tab's former
// params-pane fields now live in a hidden block (#{tab}Params in the tab
// partials) and are moved into the popover body — only the ACTIVE tab's
// block is mounted. The control IDs are unchanged, so storage.js / the tool
// modules / reset work without modifications.

// Chip definitions per tab (kind -> icon + tooltip). The label ids follow
// CHIP_IDS below.
const CHIP_CONFIGS = {
  generate: [
    { kind: 'dims', icon: '📏', title: 'Image dimensions (aspect ratio, megapixels)' },
    { kind: 'stepseed', icon: '👣', title: 'Steps and seed' },
  ],
  edit: [
    { kind: 'stepseed', icon: '👣', title: 'Steps and seed' },
  ],
  video: [
    { kind: 'frames', icon: '🎞️', title: 'Frames (4n+1, 81–161)' },
    { kind: 'stepseed', icon: '👣', title: 'Steps and seed' },
  ],
  // Upscale has NO prompt textarea → no chip overlay; its seed control
  // lives directly in the params pane (reverted — see tab_upscale.html).
  upscale: [],
};

const CHIP_IDS = {
  dims: 'chipDims', frames: 'chipFrames', stepseed: 'chipStepSeed',
};
const CHIP_LABEL_IDS = {
  dims: 'chipDimsLabel', frames: 'chipFramesLabel', stepseed: 'chipStepSeedLabel',
};
const CHIP_KIND_INFO = {
  dims: { title: 'Dimensions' },
  frames: { title: 'Frames' },
  stepseed: { title: 'Steps & seed' },
};

// The params block id per tab. NB: Generate's block is GENparams (abbreviated
// from the original template) — the generic `${currentTab}Params` would look
// for a non-existent 'generateParams'. Upscale has no block (no chips).
const PARAMS_BLOCK_IDS = {
  generate: 'genParams', edit: 'editParams', video: 'videoParams',
};

// Render the chips of the active tab and mount its params block into the
// popover body. Called on every tab switch (switchTab). Blocks are NEVER
// removed from the DOM (the controls' ids must keep resolving globally for
// storage.js / the tool modules); only the active tab's block is shown.
function renderPromptChips() {
  const popBody = document.getElementById('chipPopoverBody');
  const blockId = PARAMS_BLOCK_IDS[currentTab];
  if (popBody) {
    // Hide every mounted block except the active tab's.
    popBody.querySelectorAll('[data-params-block]').forEach(b => {
      b.hidden = b.id !== blockId;
    });
    const params = document.getElementById(blockId);
    if (params && params.parentElement !== popBody) {
      params.removeAttribute('hidden'); // visibility is per-tab + per-section
      popBody.appendChild(params);
    }
  }
  // The chip container: the prompt chips for tabs with a prompt (generate /
  // edit / video); upscale has none (its seed lives in the params pane).
  const box = document.getElementById('promptChips');
  const target = box;
  if (!target) return;
  const cfg = CHIP_CONFIGS[currentTab] || [];
  if (target.dataset.rendered === currentTab && target.children.length) {
    updatePromptChips();
    return;
  }
  target.dataset.rendered = currentTab;
  target.innerHTML = cfg.map(c =>
    `<button class="prompt-chip" data-kind="${c.kind}" id="${CHIP_IDS[c.kind]}" onclick="toggleChipPopover('${c.kind}')" title="${c.title}">` +
      `<span class="chip-icon">${c.icon}</span><span class="chip-label" id="${CHIP_LABEL_IDS[c.kind]}">—</span>` +
    `</button>`
  ).join('');
  updatePromptChips();
}

// Refresh the chip labels from the active tab's controls.
function updatePromptChips() {
  // 📏 Dimensions (generate): the aspect ratio (the AR select value).
  const dimsLabel = document.getElementById('chipDimsLabel');
  if (dimsLabel) {
    const ar = document.getElementById('genAspectRatio');
    dimsLabel.textContent = (ar && ar.value) ? ar.value : '—';
  }
  // 🎞️ Frames (video)
  const framesLabel = document.getElementById('chipFramesLabel');
  if (framesLabel) {
    const f = document.getElementById('videoFrames');
    framesLabel.textContent = (f && f.value) ? f.value : '—';
  }
  // 👣 Steps & seed (generate/edit/video): "steps · 🎲" while the seed is
  // random; when it is FIXED the separator and the dice disappear (steps
  // only) — that is the visual cue.
  const ssLabel = document.getElementById('chipStepSeedLabel');
  if (ssLabel) {
    const ids = {
      generate: ['genSteps', 'genSeedRandom'],
      edit: ['editSteps', 'editSeedRandom'],
      video: ['videoSteps', 'videoSeedRandom'],
    }[currentTab];
    if (ids) {
      const steps = document.getElementById(ids[0]);
      const rnd = document.getElementById(ids[1]);
      if (steps) {
        ssLabel.textContent = (rnd && rnd.checked) ? `${steps.value} · 🎲` : `${steps.value}`;
      }
    }
  }
}

// Open the chip popover showing the matching section of the active tab's
// params block ('dims'/'frames'/'stepseed'/'seed' → #{tab}Params{Kind}),
// anchored under the clicked chip. Repositions above the chip when it would
// overflow the bottom of the viewport.
function openChipPopover(kind) {
  const pop = document.getElementById('chipPopover');
  const block = document.getElementById(PARAMS_BLOCK_IDS[currentTab]);
  if (!pop || !block) return;
  block.querySelectorAll('[data-chip-section]').forEach(s => {
    s.hidden = s.dataset.chipSection !== kind;
  });
  const info = CHIP_KIND_INFO[kind] || {};
  document.getElementById('chipPopoverTitle').textContent = info.title || kind;
  const chip = document.getElementById(CHIP_IDS[kind]);
  if (chip) {
    const r = chip.getBoundingClientRect();
    const pw = pop.offsetWidth || 280;
    const ph = pop.offsetHeight || 160;
    let left = Math.min(r.left, window.innerWidth - pw - 8);
    let top = r.bottom + 6;
    if (top + ph > window.innerHeight - 8) top = Math.max(8, r.top - ph - 6);
    pop.style.left = Math.max(8, left) + 'px';
    pop.style.top = top + 'px';
  }
  updatePromptChips();
  pop.classList.add('show');
}

// Chip click: opens the popover, or switches sections when another chip is
// clicked while the popover is open, or closes when the same chip is clicked
// again. (There is no backdrop — the chips stay clickable, see below.)
let chipPopoverKind = null;
function toggleChipPopover(kind) {
  const pop = document.getElementById('chipPopover');
  const open = pop && pop.classList.contains('show');
  if (open && chipPopoverKind === kind) {
    closeChipPopover();
    return;
  }
  chipPopoverKind = kind;
  openChipPopover(kind);
}

function closeChipPopover() {
  chipPopoverKind = null;
  const pop = document.getElementById('chipPopover');
  if (pop) pop.classList.remove('show');
}

// Close when clicking outside the popover and the chips (a click on the
// chips themselves toggles, never closes from behind).
document.addEventListener('click', e => {
  if (e.target.closest('#chipPopover, #promptChips')) return;
  closeChipPopover();
});

// Close the popover with Escape (the modal Esc handler in main.js coexists).
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeChipPopover();
});

// Radio group toggle (kept for the mockup's segmented controls)
function selectRadio(btn) {
  btn.parentElement.querySelectorAll('.radio-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
}
