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
  if (settingsOpen && !e.target.closest('#tabNav')) hideSettingsMenu();
});

// ── Theme ─────────────────────────────────
// Manual toggle swapping CSS custom properties (no prefers-color-scheme).
function toggleTheme() {
  currentTheme = currentTheme === 'dark' ? 'light' : 'dark';
  applyTheme();
  savePersistedState();
}

// Apply the current theme (dark default) to the CSS variables.
function applyTheme() {
  const root = document.documentElement;
  const light = currentTheme === 'light';
  root.style.setProperty('--bg', light ? '#f0f0f5' : '#1a1a2e');
  root.style.setProperty('--surface', light ? '#ffffff' : '#16213e');
  root.style.setProperty('--surface-hover', light ? '#f5f5fa' : '#1c2a4a');
  root.style.setProperty('--text', light ? '#1a1a2e' : '#eaeaea');
  root.style.setProperty('--text-secondary', light ? '#6a6a7a' : '#a0a0b0');
  root.style.setProperty('--border', light ? '#d0d0dd' : '#2a2a4a');
  const panes = document.querySelectorAll('.output-pane');
  panes.forEach(p => { p.style.background = light ? '#eaeaef' : '#111122'; });
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
