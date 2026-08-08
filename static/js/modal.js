// ── Advanced params modal (⚙️) ────────────
// Single modal, content rendered dynamically per active tab. Values persist
// per tab for the session in window.advancedValues; the mapped keys feed the
// backend calls (lora / model / diffusion).
//
// The Video tab renders differently depending on the Wan version:
//   wan21: one diffusion model dropdown + one LoRA editor
//   wan22: two diffusion dropdowns (HIGH / LOW) + two LoRA editors (HIGH/LOW)

let currentModalTab = null;

// No override layers or per-tool base URLs: overrides (admin vs user) do not
// apply to the app (single-user), and the ComfyUI server / media base URLs
// are global settings in the 🎨 dropdown, not per tool.
const modalConfigs = {
  generate: {
    title: 'Generate Image',
    fields: [
      { label: 'Model name', type: 'select', placeholder: 'Default from model family (e.g. zImageTurbo-mxfp8.safetensors)' },
      { label: 'LoRA config', type: 'lora', path: 'main' },
    ]
  },
  edit: {
    title: 'Edit Image',
    fields: [
      { label: 'LoRA config', type: 'lora', path: 'main' },
    ]
  },
  upscale: {
    title: 'Upscale',
    // No advanced fields: resolution/blend/color stay as workflow defaults
    // and the media base URL is a global setting.
    fields: [],
  },
  video: {
    title: 'Generate Video',
    // Rendered dynamically per Wan version (see videoFields()).
    fields: [],
  }
};

// Fields for the Video tab, based on the currently selected Wan version.
// The negative prompt goes at the bottom of the modal (after the LoRAs).
function videoFields() {
  const wan22 = toolbarValues.vidVersion === 'wan22';
  const fields = [];
  if (wan22) {
    fields.push({ label: 'Diffusion model HIGH', type: 'select', path: 'high' });
    fields.push({ label: 'Diffusion model LOW', type: 'select', path: 'low' });
    fields.push({ label: 'LoRA config HIGH', type: 'lora', path: 'high' });
    fields.push({ label: 'LoRA config LOW', type: 'lora', path: 'low' });
    fields.push({ label: 'Negative prompt', type: 'textarea' });
  } else {
    fields.push({ label: 'Diffusion model', type: 'select', path: 'main' });
    fields.push({ label: 'LoRA config', type: 'lora', path: 'main' });
    fields.push({ label: 'Negative prompt', type: 'textarea' });
  }
  return fields;
}

function openAdvancedModal() {
  openModal(currentTab);
}

function openModal(tab) {
  currentModalTab = tab;
  let cfg = modalConfigs[tab];
  if (tab === 'video') {
    cfg = { ...cfg, fields: videoFields() };
  }
  const backdrop = document.getElementById('modalBackdrop');
  const modalBox = document.getElementById('modalBox');
  // Wan 2.2 (dual path) modal is wider; other tabs keep the default width
  modalBox.classList.toggle('modal-wide', tab === 'video' && toolbarValues.vidVersion === 'wan22');

  document.getElementById('modalTitle').innerHTML = `⚙️ Advanced — ${cfg.title}`;

  let html = '';
  cfg.fields.forEach(f => {
    if (f.type === 'toggle') {
      html += `<div class="toggle-row"><span>${f.label}</span><div class="toggle-switch" onclick="this.classList.toggle('on')"></div></div>`;
    } else if (f.type === 'select') {
      // Model/diffusion dropdown, populated from ComfyUI /models/diffusion_models
      const opts = diffusionModels.map(m =>
        `<option value="${esc(m)}">${esc(m)}</option>`
      ).join('');
      html += `<div class="field"><label>${f.label}</label>`
        + `<select class="modal-model-select" data-label="${f.label}" data-path="${f.path || 'main'}">`
        + `<option value="">— default —</option>${opts}</select>`
        + `</div>`;
    } else if (f.type === 'lora') {
      const path = f.path || 'main';
      html += `<div class="field"><label>${f.label}</label>`
        + `<div id="loraRows-${path}" class="lora-editor"></div>`
        + `<button class="btn btn-secondary btn-add-lora" id="btnAddLora-${path}" onclick="addModalLoraRow('${path}')">＋ Add LoRA</button>`
        + `</div>`;
    } else if (f.type === 'textarea') {
      html += `<div class="field"><label>${f.label}</label><textarea placeholder="${f.placeholder || ''}"></textarea></div>`;
    } else {
      html += `<div class="field"><label>${f.label}</label><input type="text" placeholder="${f.placeholder || ''}"></div>`;
    }
  });

  document.getElementById('modalBody').innerHTML = html;

  // Saved state: for video, use the per-version store (wan21/wan22); for
  // other tabs, the tab's own object.
  const saved = (window.advancedValues && window.advancedValues[tab]) || {};
  const cfg2 = saved;
  const store = (tab === 'video')
    ? (saved[toolbarValues.vidVersion] || {})
    : saved;

  // Pre-fill plain text/textarea values
  document.querySelectorAll('#modalBody .field input, #modalBody .field textarea').forEach(f => {
    const label = f.previousElementSibling?.textContent;
    const key = label === 'Model name' ? 'model'
      : label === 'Diffusion model' ? 'diffusion'
      : label === 'Diffusion model HIGH' ? 'diffusionHigh'
      : label === 'Diffusion model LOW' ? 'diffusionLow'
      : label === 'Negative prompt' ? 'negative'
      : null;
    if (key && store[key] !== undefined) f.value = store[key];
  });

  // Pre-select model dropdowns from saved values
  document.querySelectorAll('#modalBody .modal-model-select').forEach(sel => {
    const path = sel.getAttribute('data-path');
    const label = sel.getAttribute('data-label');
    // key in the store: model / diffusion / diffusionHigh / diffusionLow
    let key = 'diffusion';
    if (label === 'Model name') key = 'model';
    else if (label === 'Diffusion model HIGH') key = 'diffusionHigh';
    else if (label === 'Diffusion model LOW') key = 'diffusionLow';
    let v = store[key];
    // diffusion JSON for wan21 may be {model: ...}; pick the filename
    let filename = '';
    if (key === 'diffusion' && v) {
      try { filename = JSON.parse(v).model || ''; } catch (e) { filename = v; }
    } else {
      filename = v || '';
    }
    if (filename && [...sel.options].some(o => o.value === filename)) sel.value = filename;
  });

  // Populate each embedded LoRA editor from saved JSON
  cfg.fields.filter(f => f.type === 'lora').forEach(f => {
    const path = f.path || 'main';
    loraSets[path] = parseLoraJson(store.loraSets ? store.loraSets[path] : store.lora);
    renderModalLoraRows(path);
  });
  if (loraNames.length === 0) fetchLoras().then(() => {
    cfg.fields.filter(f => f.type === 'lora').forEach(f => renderModalLoraRows(f.path || 'main'));
  });
  // Load diffusion models for the dropdowns (cached)
  if (diffusionModels.length === 0) fetchDiffusionModels();

  backdrop.classList.add('show');
}

function closeModal() {
  document.getElementById('modalBackdrop').classList.remove('show');
  currentModalTab = null;
}

function saveAdvanced() {
  // Collect values and store per tab (feeds the backend call)
  const fields = document.querySelectorAll('#modalBody .field input, #modalBody .field textarea, #modalBody .modal-model-select');
  const toggles = document.querySelectorAll('#modalBody .toggle-switch');
  const values = {};
  fields.forEach(f => { values[f.previousElementSibling?.textContent || 'field'] = f.value; });
  toggles.forEach(t => { values[t.previousElementSibling?.textContent || 'toggle'] = t.classList.contains('on'); });
  if (!window.advancedValues) window.advancedValues = {};

  let cfg = modalConfigs[currentModalTab];
  if (currentModalTab === 'video') cfg = { ...cfg, fields: videoFields() };

  // Start from the previously saved state so switching wan21 <-> wan22 keeps
  // the other version's configuration.
  const prev = window.advancedValues[currentModalTab] || {};
  const mapped = Object.assign({}, prev);

  // For video, save into the per-version store (wan21/wan22) so switching
  // versions restores each one's own config (LoRAs are not cross-compatible).
  if (currentModalTab === 'video') {
    const version = toolbarValues.vidVersion; // 'wan21' | 'wan22'
    const store = Object.assign({}, prev[version] || {});
    (cfg.fields || []).forEach(f => {
      const label = f.label;
      if (f.type === 'lora') {
        const path = f.path || 'main';
        if (!store.loraSets) store.loraSets = {};
        store.loraSets[path] = loraSetsToJson(path);
      } else if (f.type === 'select') {
        if (label === 'Diffusion model') store.diffusion = diffusionSelectToJson(values[label], 'main');
        else if (label === 'Diffusion model HIGH') store.diffusionHigh = values[label] || '';
        else if (label === 'Diffusion model LOW') store.diffusionLow = values[label] || '';
      } else if (f.type === 'textarea') {
        if (label === 'Negative prompt') store.negative = values[label] || '';
      }
    });
    // assemble final diffusion per version
    if (version === 'wan22') {
      store.diffusion = JSON.stringify({
        high: store.diffusionHigh || '',
        low: store.diffusionLow || '',
      });
      delete store.diffusionHigh;
      delete store.diffusionLow;
    }
    mapped[version] = store;
  } else {
    (cfg.fields || []).forEach(f => {
      const label = f.label;
      if (f.type === 'lora') {
        const path = f.path || 'main';
        if (!mapped.loraSets) mapped.loraSets = {};
        mapped.loraSets[path] = loraSetsToJson(path);
        mapped.lora = mapped.loraSets[path];
      } else if (f.type === 'select') {
        if (label === 'Model name') mapped.model = values[label] || '';
      } else if (f.type === 'textarea') {
        if (label === 'Negative prompt') mapped.negative = values[label] || '';
      }
    });
  }

  window.advancedValues[currentModalTab] = mapped;
  savePersistedState();
  showToast('Advanced parameters saved');
  closeModal();
}

// Convert a selected diffusion model filename into the JSON shape the backend
// expects: wan21 -> {"model": "..."}; wan22 high/low are stored separately and
// assembled on save.
function diffusionSelectToJson(filename, path) {
  if (!filename) return '';
  if (currentModalTab === 'video' && toolbarValues.vidVersion === 'wan22') {
    return filename; // assembled later into {high, low}
  }
  return JSON.stringify({ model: filename });
}

// ── Embedded LoRA config editor (🧩) ───────
// Lives directly inside the ⚙️ advanced modal: one editor per "path"
// (main for image tools / wan21, high+low for wan22). Each editor has rows of
// (LoRA dropdown + strength stepper ±0.05, up to 4 rows). The JSON is derived
// on save and stored in advancedValues.loraSets[path] (plus .lora for the
// single-set image tools, which the backend reads).

let loraNames = [];           // fetched from {COMFYUI_BASE_URL}/models/loras
let loraSets = {};            // { main: [...], high: [...], low: [...] } rows
let loraNamesLoaded = false;  // true once the fetch resolved (for tests/UX)
let diffusionModels = [];     // fetched from {COMFYUI_BASE_URL}/models/diffusion_models
let diffusionLoaded = false;  // true once the fetch resolved

function fetchDiffusionModels() {
  return fetch('/api/diffusion-models')
    .then(r => {
      if (!r.ok) return r.json().then(j => { throw new Error(j.detail || 'HTTP ' + r.status); });
      return r.json();
    })
    .then(j => {
      diffusionModels = j.models || [];
      diffusionLoaded = true;
      window.diffusionLoaded = true;
      // Repopulate the open modal's model selects (keep the current value)
      document.querySelectorAll('#modalBody .modal-model-select').forEach(sel => {
        const prev = sel.value;
        const opts = diffusionModels.map(m =>
          `<option value="${esc(m)}">${esc(m)}</option>`
        ).join('');
        sel.innerHTML = `<option value="">— default —</option>${opts}`;
        if (prev && [...sel.options].some(o => o.value === prev)) sel.value = prev;
      });
    })
    .catch(e => { diffusionModels = []; diffusionLoaded = true; window.diffusionLoaded = true; showToast('❌ Could not load diffusion models: ' + e.message); });
}

function parseLoraJson(json) {
  let parsed = [];
  try { parsed = JSON.parse(json || '[]'); } catch (e) { parsed = []; }
  return (Array.isArray(parsed) ? parsed : [])
    .map(r => ({
      name: typeof r === 'string' ? r : (r.name || ''),
      strength: (typeof r === 'object' && r !== null) ? (parseFloat(r.strength) || 1.0) : 1.0,
    }))
    // Empty/whitespace names mean "no LoRA loaded" — by default there is
    // never a LoRA unless the user saved one (bogus empty rows, e.g. from
    // the Windows-path bug, are dropped instead of showing as loaded).
    .filter(r => String(r.name).trim() !== '');
}

function loraSetsToJson(path) {
  const rows = loraSets[path] || [];
  // video high/low sets carry their path; main set has no path
  const withPath = currentModalTab === 'video' && (path === 'high' || path === 'low');
  // Drop empty-name rows so a default/blank LoRA is never persisted.
  const valid = rows.filter(r => String(r.name).trim() !== '');
  return JSON.stringify(valid.map(r => ({
    name: r.name,
    strength: r.strength,
    ...(withPath ? { path } : {}),
  })), null, 2);
}

function fetchLoras() {
  return fetch('/api/loras')
    .then(r => {
      if (!r.ok) return r.json().then(j => { throw new Error(j.detail || 'HTTP ' + r.status); });
      return r.json();
    })
    .then(j => { loraNames = j.loras || []; loraNamesLoaded = true; window.loraNamesLoaded = true; })
    .catch(e => { loraNames = []; loraNamesLoaded = true; window.loraNamesLoaded = true; showToast('❌ Could not load LoRAs: ' + e.message); });
}

function renderModalLoraRows(path) {
  const container = document.getElementById(`loraRows-${path}`);
  if (!container) return;
  const rows = loraSets[path] || [];
  // LoRA options filtered by the current model context, prefix stripped
  const opts = loraOptionsForContext();
  // Separator-agnostic matching (dual-boot: a saved name may use / while
  // the server returns \, or vice versa).
  const norm = s => String(s).replace(/[\\/]+/g, '/');
  let html = '';
  if (rows.length === 0) {
    html = '<p class="lora-empty">No LoRAs configured. Click “＋ Add LoRA”.</p>';
  }
  rows.forEach((row, i) => {
    // Pick the option value to preselect: exact match wins, otherwise the
    // separator-normalized match (so a saved Linux-style name restores on
    // Windows and vice versa).
    let sel = '';
    if (opts.some(o => o.value === row.name)) {
      sel = row.name;
    } else {
      const n = norm(row.name);
      const m = opts.find(o => norm(o.value) === n);
      sel = m ? m.value : '';
    }
    let options;
    if (!sel) {
      // Saved LoRA is no longer in the list (file removed / renamed): show
      // a clearly non-matching placeholder so it never silently becomes a
      // different LoRA; if the user saves as-is the empty name is dropped.
      options = `<option value="">— not available —</option>`
        + opts.map(o => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('');
    } else {
      options = opts.map(o =>
        `<option value="${esc(o.value)}"${o.value === sel ? ' selected' : ''}>${esc(o.label)}</option>`
      ).join('');
    }
    html += `<div class="lora-row" data-i="${i}">
      <select class="lora-select" onchange="updateLoraRow('${path}', ${i}, 'name', this.value)">
        ${options}
      </select>
      <div class="stepper lora-strength">
        <button class="stepper-btn" onclick="stepLoraStrength('${path}', ${i}, -0.05)" title="Decrease">−</button>
        <input type="text" inputmode="decimal" value="${row.strength.toFixed(2)}" class="lora-strength-input" oninput="sanitizeLoraStrength('${path}', ${i}, this.value)">
        <button class="stepper-btn" onclick="stepLoraStrength('${path}', ${i}, 0.05)" title="Increase">+</button>
      </div>
      <button class="btn-remove-lora" onclick="removeLoraRow('${path}', ${i})" title="Remove">✕</button>
    </div>`;
  });
  container.innerHTML = html;
  const addBtn = document.getElementById(`btnAddLora-${path}`);
  if (addBtn) addBtn.disabled = rows.length >= 4;
}

// Directory prefix that groups LoRAs per model family/version on the server
// (zit/, flux2/, krea2/, wan21/, wan22/). Returns the dir for the current
// tab + active model, or null when no filtering applies.
function loraDirForContext() {
  switch (currentModalTab) {
    case 'generate':
      return toolbarValues.genFamily === 'zimage' ? 'zit'
        : toolbarValues.genFamily === 'krea2' ? 'krea2'
        : 'flux2'; // flux2 default
    case 'edit':
      return 'flux2'; // Edit uses the flux-2-klein model
    case 'video':
      return toolbarValues.vidVersion; // wan21 | wan22
    default:
      return null;
  }
}

// LoRA names available for the current context. ComfyUI returns subfolder
// paths with the OS separator (/ on Linux/macOS, \ on Windows — the user
// runs dual-boot), so all matching is separator-agnostic. A LoRA whose
// directory matches the current model context is listed first (label
// without the dir); every other LoRA is still listed after it (label
// without any dir) — ComfyUI can resolve a unique name even without its
// directory. The FULL name as returned by ComfyUI is kept as the value so
// the backend passes it through unchanged.
function loraOptionsForContext() {
  const dir = loraDirForContext();
  const parse = n => {
    const parts = String(n).split(/[\\/]/);
    return { value: n, label: parts.pop(), dir: parts.join('/').toLowerCase() };
  };
  const items = loraNames.map(parse);
  if (!dir) return items.map(({ value, label }) => ({ value, label }));
  const target = dir.toLowerCase();
  const inDir = items.filter(i => i.dir === target);
  const rest = items.filter(i => i.dir !== target);
  return [...inDir, ...rest].map(({ value, label }) => ({ value, label }));
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function addModalLoraRow(path) {
  const rows = loraSets[path] || [];
  if (rows.length >= 4) return;
  const first = loraOptionsForContext()[0]?.value || '';
  // Never add a row with an empty name ("a LoRA loaded" that is none) —
  // only when the server actually has LoRAs to pick from.
  if (!first) return showToast('No LoRAs available on the server');
  rows.push({ name: first, strength: 1.0 });
  loraSets[path] = rows;
  renderModalLoraRows(path);
}

function removeLoraRow(path, i) {
  const rows = loraSets[path] || [];
  rows.splice(i, 1);
  loraSets[path] = rows;
  renderModalLoraRows(path);
}

function updateLoraRow(path, i, key, val) {
  const rows = loraSets[path] || [];
  if (key === 'strength') rows[i].strength = Math.max(0, parseFloat(val) || 1.0);
  else rows[i].name = val;
  loraSets[path] = rows;
}

// Keep the strength text field numeric-only and in sync with the model.
function sanitizeLoraStrength(path, i, raw) {
  const rows = loraSets[path] || [];
  const clean = raw.replace(/[^0-9.]/g, '');
  rows[i].strength = Math.max(0, parseFloat(clean) || 0);
  loraSets[path] = rows;
  if (clean !== raw) renderModalLoraRows(path);
}

function stepLoraStrength(path, i, delta) {
  const rows = loraSets[path] || [];
  rows[i].strength = Math.max(0, Math.round((rows[i].strength + delta) * 100) / 100);
  loraSets[path] = rows;
  renderModalLoraRows(path);
}
