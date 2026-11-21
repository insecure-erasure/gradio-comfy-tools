// ── Thumbnail grid geometry (pure) ────────────────────────────────────────
// The fullscreen gallery's counter button opens a contact sheet that fills the
// visible area. Cell size adapts to the number of entries and the available
// box, with hard bounds so thumbs never become unusable:
//
//   cols = clamp(round(sqrt(n · W / H)), 1, MAX_COLS)
//   cols = min(cols, floor((W + g) / (MIN + g)))   // never overflow sideways
//   rows = ceil(n / cols)
//   cell = clamp(min((W − (cols−1)·g)/cols, (H − (rows−1)·g)/rows), MIN, MAX)
//
// If even MIN does not fit vertically, the grid scrolls (never below MIN).
// The width clamp is what keeps a PHONE PORTRAIT layout inside the viewport:
// the aspect formula alone would pick more columns than fit at MIN px.
//
// Loaded before gallery.js (templates/index.html); unit-tested in
// tests/js/gallery_grid_test.js.

const GALLERY_GRID_MIN = 64;    // px — also a comfortable touch target
const GALLERY_GRID_MAX = 200;   // px — cap when there are few entries
const GALLERY_GRID_GAP = 10;    // px between cells
const GALLERY_GRID_MAX_COLS = 8;

function galleryGridMetrics(n, width, height) {
  const W = Math.max(0, Number(width) || 0);
  const H = Math.max(0, Number(height) || 0);
  const count = Math.max(0, Math.floor(Number(n) || 0));
  const g = GALLERY_GRID_GAP;
  if (!count || !W || !H) {
    return { cols: 1, rows: 1, cell: GALLERY_GRID_MIN, gap: g, scroll: false };
  }
  let cols = Math.round(Math.sqrt(count * (W / H)));
  cols = Math.max(1, Math.min(GALLERY_GRID_MAX_COLS, cols));
  const maxColsByWidth = Math.max(1, Math.floor((W + g) / (GALLERY_GRID_MIN + g)));
  cols = Math.min(cols, maxColsByWidth);
  const rows = Math.ceil(count / cols);
  let cell = Math.min(
    (W - (cols - 1) * g) / cols,
    (H - (rows - 1) * g) / rows
  );
  let scroll = false;
  if (cell < GALLERY_GRID_MIN) { cell = GALLERY_GRID_MIN; scroll = true; }
  if (cell > GALLERY_GRID_MAX) cell = GALLERY_GRID_MAX;
  return { cols, rows, cell: Math.floor(cell), gap: g, scroll };
}
