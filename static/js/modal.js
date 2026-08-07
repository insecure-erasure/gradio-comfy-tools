// ── Advanced params modal (⚙️) ────────────
// Single modal, content rendered dynamically per active tab. Values persist
// per tab for the session in window.advancedValues; the mapped keys feed the
// backend calls (lora / model / diffusion).

let currentModalTab = null;

// No override layers or per-tool base URLs: overrides (admin vs user) do not
// apply to the app (single-user), and the ComfyUI server / media base URLs
// are global settings in the 🎨 dropdown, not per tool.
const modalConfigs = {
  generate: {
    title: 'Generate Image',
    fields: [
      { label: 'Model name', type: 'text', placeholder: 'Default from model family (e.g. zImageTurbo-mxfp8.safetensors)' },
      { label: 'LoRA config (JSON)', type: 'textarea', placeholder: '[{"name":"my-lora.safetensors","strength":1.0}]' },
    ]
  },
  edit: {
    title: 'Edit Image',
    fields: [
      { label: 'LoRA config (JSON)', type: 'textarea', placeholder: '[{"name":"my-lora.safetensors","strength":1.0}]' },
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
    fields: [
      { label: 'Diffusion model (JSON)', type: 'textarea', placeholder: 'Model file(s). Object for Wan 2.1, array for Wan 2.2' },
      { label: 'LoRA config (JSON)', type: 'textarea', placeholder: '[{"name":"my-lora.safetensors","strength":1.0,"path":"high"}]' },
    ]
  }
};

function openAdvancedModal() {
  openModal(currentTab);
}

function openModal(tab) {
  currentModalTab = tab;
  const cfg = modalConfigs[tab];
  const backdrop = document.getElementById('modalBackdrop');

  document.getElementById('modalTitle').innerHTML = `⚙️ Advanced — ${cfg.title}`;

  let html = '';
  cfg.fields.forEach(f => {
    if (f.type === 'toggle') {
      html += `<div class="toggle-row"><span>${f.label}</span><div class="toggle-switch" onclick="this.classList.toggle('on')"></div></div>`;
    } else if (f.type === 'textarea') {
      html += `<div class="field"><label>${f.label}</label><textarea placeholder="${f.placeholder || ''}"></textarea></div>`;
    } else {
      html += `<div class="field"><label>${f.label}</label><input type="text" placeholder="${f.placeholder || ''}"></div>`;
    }
  });

  document.getElementById('modalBody').innerHTML = html;
  backdrop.classList.add('show');
}

function closeModal() {
  document.getElementById('modalBackdrop').classList.remove('show');
  currentModalTab = null;
}

function saveAdvanced() {
  // Collect values and store per tab (feeds the backend call)
  const fields = document.querySelectorAll('#modalBody .field input, #modalBody .field textarea');
  const toggles = document.querySelectorAll('#modalBody .toggle-switch');
  const values = {};
  fields.forEach(f => { values[f.previousElementSibling?.textContent || 'field'] = f.value; });
  toggles.forEach(t => { values[t.previousElementSibling?.textContent || 'toggle'] = t.classList.contains('on'); });
  if (!window.advancedValues) window.advancedValues = {};
  // map label -> key used by the backend call
  const cfg = modalConfigs[currentModalTab];
  const mapped = {};
  (cfg.fields || []).forEach(f => {
    const label = f.label;
    if (label === 'LoRA config (JSON)') mapped.lora = values[label] || '[]';
    if (label === 'Model name') mapped.model = values[label] || '';
    if (label === 'Diffusion model (JSON)') mapped.diffusion = values[label] || '';
  });
  window.advancedValues[currentModalTab] = mapped;
  showToast('Advanced parameters saved');
  closeModal();
}
