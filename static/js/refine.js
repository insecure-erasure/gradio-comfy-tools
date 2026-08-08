// ── Prompt refiner (🪄) ────────────────────
// Streams the refined prompt from the backend (POST /api/refine-prompt with
// stream:true → SSE of content deltas) into the prompt textarea, so the
// user sees the refinement evolve live. While refining:
//   - the 🪄 button turns into a ⏹ stop button (click = cancel),
//   - the generation buttons are disabled with the click-catcher overlay
//     (see setRefining below).
// The refiner URL + system prompt are configured in the ☰ menu.
//
// The button lives in the button column (landscape, left of the generate
// button) and as an overlay on the textarea (portrait).

let _refiningCatchers = [];
let _refineController = null;   // AbortController for the in-flight request

// Switch the 🪄 button(s) to ⏹ (or back). There are two buttons: the
// landscape one in #btnCol and the portrait overlay on the textarea.
function setRefineButtons(refining) {
  const glyph = refining ? '⏹' : '🪄';
  const title = refining ? 'Stop refining' : 'Refine prompt';
  const fn = refining ? 'stopRefining()' : 'refinePrompt()';
  document.querySelectorAll('.btn-refine, .prompt-refine-btn').forEach(b => {
    b.textContent = glyph;
    b.title = title;
    b.setAttribute('onclick', fn);
  });
}

// Disable the generation buttons while refining and swap the click-catcher
// to a "Refining prompt…" toast (the same overlay trick as empty prompts).
// The prompt textarea is also disabled + dimmed so the streamed text cannot
// be edited mid-refinement.
function setRefining(on) {
  const btnCol = document.getElementById('btnCol');
  const input = document.getElementById('promptInput');
  if (btnCol) {
    if (on) {
      btnCol.classList.add('refining');
      _refiningCatchers = [];
      btnCol.querySelectorAll('.btn-catcher').forEach(c => {
        _refiningCatchers.push({ el: c, orig: c.onclick });
        c.onclick = () => showToast('Refining prompt…');
      });
      btnCol.querySelectorAll('.btn-generate').forEach(b => { b.disabled = true; });
    } else {
      btnCol.classList.remove('refining');
      _refiningCatchers.forEach(({ el, orig }) => { el.onclick = orig; });
      _refiningCatchers = [];
      btnCol.querySelectorAll('.btn-generate').forEach(b => {
        if (!b.dataset.requiresPrompt) b.disabled = false;
      });
      updateActionButtons();
    }
  }
  if (input) {
    input.disabled = !!on;
    input.classList.toggle('refining', !!on);
  }
}

function stopRefining() {
  if (_refineController) {
    _refineController.abort();
    showToast('Refinement cancelled');
  }
}

async function refinePrompt() {
  const input = document.getElementById('promptInput');
  const prompt = input ? input.value.trim() : '';
  if (!prompt) return showToast('Please write a prompt first');
  if (_refineController) return; // already refining

  _refineController = new AbortController();
  setRefining(true);
  setRefineButtons(true);
  showToast('🪄 Refining prompt…');

  // Keep the original prompt so cancel restores it (the textarea is filled
  // progressively with the streamed deltas).
  const original = prompt;

  try {
    const resp = await fetch('/api/refine-prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, stream: true }),
      signal: _refineController.signal,
    });
    if (!resp.ok) {
      const j = await resp.json().catch(() => ({}));
      throw new Error(j.detail || ('HTTP ' + resp.status));
    }
    if (!resp.body) throw new Error('Streaming not supported');

    // Read the SSE stream: each `data: {"delta": "..."}` appends to the
    // textarea (live evolution); `data: {"done": true}` ends it.
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let refined = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split('\n\n');
      buf = parts.pop();
      for (const part of parts) {
        const line = part.trim();
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        let ev;
        try { ev = JSON.parse(payload); } catch (e) { continue; }
        if (ev.delta) {
          refined += ev.delta;
          if (input) input.value = refined;
        } else if (ev.done) {
          buf = '';
        } else if (ev.error) {
          throw new Error(ev.error);
        }
      }
    }

    refined = refined.trim();
    if (!refined) throw new Error('Refiner returned an empty prompt');

    // If the user cancelled mid-stream, the loop above may have exited
    // normally (reader done) without throwing AbortError — restore the
    // original prompt in that case too.
    if (_refineController.signal.aborted) {
      if (input) input.value = original;
      if (promptsByTab && currentTab && currentTab !== 'upscale') {
        promptsByTab[currentTab] = original;
      }
      updateActionButtons();
      return;
    }

    // Keep the per-tab prompt store + localStorage in sync (promptsByTab).
    if (promptsByTab && currentTab && currentTab !== 'upscale') {
      promptsByTab[currentTab] = refined;
    }
    savePersistedState();
    updateActionButtons();
    showToast('✨ Prompt refined');
  } catch (e) {
    if (e && e.name === 'AbortError') {
      // Cancelled: restore the original prompt (the streamed text is partial).
      if (input) input.value = original;
      if (promptsByTab && currentTab && currentTab !== 'upscale') {
        promptsByTab[currentTab] = original;
      }
      updateActionButtons();
    } else {
      showToast('❌ ' + (e && e.message ? e.message : 'Could not refine prompt'));
    }
  } finally {
    _refineController = null;
    setRefining(false);
    setRefineButtons(false);
  }
}
