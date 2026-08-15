// ── Generation timing (elapsed + duration) ──
// Two pieces of timing shown in the result row:
//
//   • ELAPSED (live): while a generation runs, the #resultTime span shows
//     the elapsed time with 1-second precision, updated by a 250ms
//     interval (so the displayed second flips at most ~0.25s late, never
//     early). The node progress lives in the sibling #resultUrl span.
//   • DURATION (persistent): once the result lands, #resultTime keeps the
//     total generation time with 1-decimal precision (e.g. "⏱ 12.4s"). It
//     survives tab switches, gallery navigation and page reloads (the
//     duration rides along with the result in the galleries / persisted
//     state). The result URL is shown next to it in the row (#resultUrl,
//     click it to copy — copyResultHint).
//
// The clock is driven by performance.now() (monotonic — unaffected by
// wall-clock jumps / DST); the stored duration is the wall-clock delta at
// the end of the request.

let _startedAt = null;   // performance.now() of the job start
let _elapsedTimer = null; // interval that repaints the elapsed time
let _elapsedEl = null;    // the #resultTime element while the clock runs

// Number formatting: 1-decimal seconds, rounded (12.35 → '12.4s').
function fmtDuration(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  return (Math.round(sec * 10) / 10).toFixed(1) + 's';
}

// Start the elapsed clock on a row element (the #resultTime span).
// Replaces any running clock.
function startElapsedClock(el) {
  stopElapsedClock();
  if (!el) return;
  _startedAt = performance.now();
  _elapsedEl = el;
  const paint = () => {
    if (!_elapsedEl || !_startedAt) return;
    _elapsedEl.textContent = '⏱ ' + Math.floor((performance.now() - _startedAt) / 1000) + 's';
  };
  paint();
  _elapsedTimer = setInterval(paint, 250);
}

// Stop the clock and return the elapsed wall-clock seconds with 1-decimal
// precision (0 when no clock was running).
function stopElapsedClock() {
  let secs = 0;
  if (_startedAt !== null) {
    secs = (performance.now() - _startedAt) / 1000;
    _startedAt = null;
  }
  if (_elapsedTimer) { clearInterval(_elapsedTimer); _elapsedTimer = null; }
  _elapsedEl = null;
  return secs;
}
