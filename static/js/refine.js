// ── Prompt refiner (🪄) ────────────────────
// Streams the refined prompt from the backend (GET /api/refine-prompt →
// text/event-stream, consumed with the browser's NATIVE EventSource) into
// the prompt textarea, so the user sees the refinement evolve live. While
// refining:
//   - the 🪄 button turns into a ⏹ stop button (click = cancel),
//   - the generation buttons are disabled with the click-catcher overlay
//     (see setRefining below).
// The refiner URL + system prompt are configured in the ☰ menu.
//
// Why EventSource and not fetch+ReadableStream: EventSource is the browser's
// own SSE transport and is delivered progressively by design; fetch streams
// can be buffered by some engines/proxies, which made the refinement appear
// to complete all at once. EventSource only does GET, so the prompt travels
// URL-encoded in the query string, and backend failures arrive as SSE
// {"error": ...} events (EventSource cannot read the HTTP status of a failed
// response — the GET endpoint emits errors with status 200 for this reason).
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
  const input = activePromptInput();
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
  const input = activePromptInput();
  const prompt = input ? input.value.trim() : '';
  if (!prompt) return showToast('Please write a prompt first');
  if (_refineController) return; // already refining

  _refineController = new AbortController();
  setRefining(true);
  setRefineButtons(true);
  showToast('🪄 Refining prompt…');
  // Clear any previous stats in the progress area.
  const resultUrlEl = document.getElementById('resultUrl');
  if (resultUrlEl) resultUrlEl.textContent = '';

  // Keep the original prompt so cancel restores it (the textarea is filled
  // progressively with the streamed deltas).
  const original = prompt;

  // Native EventSource stream: each `data: {"delta": "..."}` appends to the
  // textarea (live evolution); `data: {"done": true}` ends it; `data:
  // {"meta": {...}}` carries the final timings (tokens, tok/s); `data:
  // {"error": "..."}` is a backend failure.
  const es = new EventSource('/api/refine-prompt?prompt=' + encodeURIComponent(prompt));

  const startTime = performance.now();
  let refined = '';
  let chars = 0;
  let finalMeta = null;
  let settled = false; // done/error/abort seen — stop accepting events

  const finish = () => { try { es.close(); } catch (e) {} };

  const ctl = {};
  // Cancel (⏹): close the stream and restore the original prompt. Resolves
  // the flow promise so the UI always settles, even mid-stream.
  const onAbort = () => {
    if (settled) return;
    settled = true;
    finish();
    ctl.resolve({ aborted: true });
  };
  _refineController.signal.addEventListener('abort', onAbort);

  try {
    const outcome = await new Promise((resolve, reject) => {
      ctl.resolve = resolve;
      ctl.reject = reject;
      es.onmessage = ev => {
        if (settled) return;
        let payload;
        try { payload = JSON.parse(ev.data); } catch (e) { return; }
        if (typeof payload.delta === 'string') {
          refined += payload.delta;
          chars += payload.delta.length;
          if (input) input.value = refined;
          // Live tok/s estimate (chars/4 ≈ tokens) in the progress area.
          if (resultUrlEl) {
            const secs = (performance.now() - startTime) / 1000;
            const estTok = chars / 5.5;  // ≈5.5 chars/token (tuned estimate)
            resultUrlEl.textContent = '🪄 ' + (secs > 0 ? (estTok / secs).toFixed(1) : '0') + ' tok/s';
          }
        } else if (payload.meta) {
          finalMeta = payload.meta; // final timings: predicted_n + predicted_per_second
        } else if (payload.done) {
          settled = true;
          finish();
          resolve({ ok: true });
        } else if (payload.error) {
          settled = true;
          finish();
          reject(new Error(payload.error));
        }
      };
      es.onerror = () => {
        // EventSource auto-reconnects; we don't want that (a reconnect would
        // restart the refinement from scratch). Close and fail unless the
        // flow already settled.
        finish();
        if (!settled) {
          settled = true;
          reject(new Error('Streaming connection lost'));
        }
      };
    });

    if (outcome && outcome.aborted) {
      // Cancelled: restore the original prompt (the streamed text is partial).
      if (input) input.value = original;
      if (promptsByTab && currentTab && currentTab !== 'upscale') {
        promptsByTab[currentTab] = original;
      }
      if (resultUrlEl) resultUrlEl.textContent = '';
      updateActionButtons();
      return;
    }

    refined = refined.trim();
    if (!refined) throw new Error('Refiner returned an empty prompt');

    // Final stats in the progress area: real tokens + average tok/s.
    if (resultUrlEl && finalMeta) {
      const toks = finalMeta.predicted_n;
      const tps = finalMeta.predicted_per_second;
      resultUrlEl.textContent = '✨ ' + toks + ' tokens · ' + (tps ? tps.toFixed(1) : '?') + ' tok/s avg';
    }

    // Keep the per-tab prompt store + localStorage in sync (promptsByTab).
    if (promptsByTab && currentTab && currentTab !== 'upscale') {
      promptsByTab[currentTab] = refined;
    }
    savePersistedState();
    updateActionButtons();
    showToast('✨ Prompt refined');
  } catch (e) {
    // The abort path resolves with {aborted:true} above; errors here are
    // real failures (mid-stream SSE {"error": ...}, connection loss). If
    // the user cancelled anyway, restore the original prompt.
    if (_refineController.signal.aborted) {
      if (input) input.value = original;
      if (promptsByTab && currentTab && currentTab !== 'upscale') {
        promptsByTab[currentTab] = original;
      }
      const r = document.getElementById('resultUrl');
      if (r) r.textContent = '';
      updateActionButtons();
    } else {
      showToast('❌ ' + (e && e.message ? e.message : 'Could not refine prompt'));
    }
  } finally {
    _refineController.signal.removeEventListener('abort', onAbort);
    _refineController = null;
    setRefining(false);
    setRefineButtons(false);
  }
}
