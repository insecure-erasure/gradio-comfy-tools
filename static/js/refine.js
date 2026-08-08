// ── Prompt refiner (🪄) ────────────────────
// Calls POST /api/refine-prompt (backend → llama-server, OpenAI-compatible
// API) with the ACTIVE tab's prompt and replaces the textarea with the
// refined text. The refiner URL + system prompt are configured in the ☰
// menu; if the service is not configured the button toasts an explanation.
//
// The button is available in Generate, Edit and Video (all prompt-driven
// tools). It sits to the LEFT of the generate button in landscape; in
// portrait it is hidden (`.btn-refine { display: none }` until <1024px is
// handled — see CSS).

async function refinePrompt() {
  const input = document.getElementById('promptInput');
  const prompt = input ? input.value.trim() : '';
  if (!prompt) return showToast('Please write a prompt first');

  const btn = document.querySelector('.btn-refine');
  if (btn) { btn.disabled = true; btn.style.opacity = '.5'; }
  showToast('🪄 Refining prompt…');
  try {
    const resp = await fetch('/api/refine-prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
    });
    const j = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(j.detail || ('HTTP ' + resp.status));
    const refined = (j.refined || '').trim();
    if (!refined) throw new Error('Refiner returned an empty prompt');
    if (input) input.value = refined;
    // Keep the per-tab prompt store + localStorage in sync (promptsByTab).
    if (promptsByTab && currentTab && currentTab !== 'upscale') {
      promptsByTab[currentTab] = refined;
    }
    savePersistedState();
    updateActionButtons();
    showToast('✨ Prompt refined');
  } catch (e) {
    showToast('❌ ' + (e && e.message ? e.message : 'Could not refine prompt'));
  } finally {
    if (btn) { btn.disabled = false; btn.style.opacity = ''; }
  }
}
