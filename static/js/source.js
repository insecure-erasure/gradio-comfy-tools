// ── Source image (Edit/Upscale/Video) ──────
// Each tab has a transparent URL field over its output pane: users paste an
// external URL directly, use 🔗 to fill it with the last generation, or 📁
// to upload a file to ComfyUI (temp). The field value feeds the tool's
// `image` input (the backend auto-detects filename vs URL).

// 🔗 fills the tab's field with the last generation; persists across tabs.
function usePreviousSource(tab) {
  const input = document.getElementById(`${tab}SourceUrl`);
  if (lastGeneratedUrl) {
    input.value = lastGeneratedUrl;
    showToast('Source set to previous generation');
  } else {
    showToast('No previous generation yet — generate an image first');
  }
}

function getSourceUrl(tab) {
  const input = document.getElementById(`${tab}SourceUrl`);
  return input ? input.value.trim() : '';
}

// 📁 upload -> POST /api/upload (ComfyUI temp) -> fill the source field
function uploadForTab(tab) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.onchange = async () => {
    const file = input.files && input.files[0];
    if (!file) return;
    const fd = new FormData();
    fd.append('file', file);
    try {
      const resp = await fetch('/api/upload', { method: 'POST', body: fd });
      if (!resp.ok) throw new Error(resp.statusText);
      const j = await resp.json();
      const field = document.getElementById(`${tab}SourceUrl`);
      if (field) field.value = j.filename;
      showToast('Image uploaded — source set');
    } catch (e) {
      showToast('❌ Upload failed: ' + e.message);
    }
  };
  input.click();
}

// Base name of a source URL (filename without extension), used to build
// readable fake result names in the mockup. Kept for reference/tooling.
function baseNameFromUrl(url) {
  try {
    const u = new URL(url);
    const filename = u.searchParams.get('filename');
    if (filename) return filename.replace(/\.[a-z0-9]+$/i, '');
    const seg = u.pathname.split('/').pop();
    if (seg) return seg.replace(/\.[a-z0-9]+$/i, '');
  } catch (e) { /* not a URL */ }
  return 'source';
}
