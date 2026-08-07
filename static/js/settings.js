// ── 🎨 Settings dropdown (theme + ComfyUI connection) ──
// GET/POST /api/settings — the server URL and media base URL are global
// (COMFYUI_BASE_URL / COMFYUI_MEDIA_BASE_URL) and persist to disk.

let settingsOpen = false;

function toggleSettingsMenu(e) {
  e.stopPropagation();
  settingsOpen = !settingsOpen;
  const btn = document.querySelector('.tabs-title');
  const menu = document.getElementById('settingsMenu');
  btn.classList.toggle('open', settingsOpen);
  menu.classList.toggle('show', settingsOpen);
}

function hideSettingsMenu() {
  settingsOpen = false;
  document.querySelector('.tabs-title').classList.remove('open');
  document.getElementById('settingsMenu').classList.remove('show');
}

document.addEventListener('click', (e) => {
  if (settingsOpen && !e.target.closest('.tabs-params-zone')) hideSettingsMenu();
});

// ── Theme ─────────────────────────────────
// Manual toggle swapping CSS custom properties (no prefers-color-scheme).
function toggleTheme() {
  const root = document.documentElement;
  const isDark = getComputedStyle(root).getPropertyValue('--bg').trim() === '#1a1a2e';
  if (isDark) {
    root.style.setProperty('--bg', '#f0f0f5');
    root.style.setProperty('--surface', '#ffffff');
    root.style.setProperty('--surface-hover', '#f5f5fa');
    root.style.setProperty('--text', '#1a1a2e');
    root.style.setProperty('--text-secondary', '#6a6a7a');
    root.style.setProperty('--border', '#d0d0dd');
    document.querySelector('.output-pane').style.background = '#eaeaef';
  } else {
    root.style.setProperty('--bg', '#1a1a2e');
    root.style.setProperty('--surface', '#16213e');
    root.style.setProperty('--surface-hover', '#1c2a4a');
    root.style.setProperty('--text', '#eaeaea');
    root.style.setProperty('--text-secondary', '#a0a0b0');
    root.style.setProperty('--border', '#2a2a4a');
    document.querySelector('.output-pane').style.background = '#111122';
  }
}

// ── ComfyUI connection ────────────────────
function updateSettingsDisplay(s) {
  const sv = document.getElementById('serverUrlValue');
  const mv = document.getElementById('mediaBaseUrlValue');
  if (sv) sv.textContent = s.comfyui_base_url || '…';
  if (mv) mv.textContent = s.media_base_url || 'default';
}

function loadSettings() {
  fetch('/api/settings')
    .then(r => r.json())
    .then(s => {
      baseUrl = s.media_base_url || s.comfyui_base_url;
      updateSettingsDisplay(s);
    })
    .catch(() => { /* server offline — keep defaults */ });
}

function saveSettings(patch, okMsg) {
  fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
    .then(r => { if (!r.ok) return r.json().then(j => { throw new Error(j.detail || 'HTTP ' + r.status); }); return r.json(); })
    .then(s => {
      baseUrl = s.media_base_url || s.comfyui_base_url;
      updateSettingsDisplay(s);
      showToast(okMsg);
    })
    .catch(e => showToast('❌ ' + e.message));
}

function configureServerUrl() {
  const current = document.getElementById('serverUrlValue')?.textContent;
  const url = prompt('ComfyUI server URL (http://host:port):', current === '…' ? '' : current);
  if (url === null) return;
  if (!url.trim()) return showToast('Server URL must not be empty');
  saveSettings({ comfyui_base_url: url.trim() }, 'Server URL updated');
}

function configureMediaBaseUrl() {
  const current = document.getElementById('mediaBaseUrlValue')?.textContent;
  const url = prompt('Media base URL (leave empty for default = server URL):',
    current === 'default' ? '' : current);
  if (url === null) return;
  saveSettings({ comfyui_media_base_url: url.trim() }, 'Media base URL updated');
}
