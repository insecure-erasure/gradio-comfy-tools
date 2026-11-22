// ── Thumbnail grid geometry (pure) ────────────────────────────────────────
// The fullscreen gallery's counter button opens a contact sheet that fills the
// visible area. The number of cells is CAPPED so the sheet never becomes a wall
// of thumbnails (gallery.js renders only a window around the current entry):
//
//   limits = 3×4 portrait · 4×5 landscape · 5×6 wide landscape
//   colsCap = min(limits.maxCols, floor((W + g) / (MIN + g)))
//   shown = min(n, colsCap · limits.maxRows)
//   cols = clamp(round(sqrt(shown · W / H)), 1, colsCap)
//   rows = ceil(shown / cols)  (widened if it would exceed maxRows)
//   cell = clamp(min((W − (cols−1)·g)/cols, (H − (rows−1)·g)/rows), MIN, MAX)
//
// If even MIN does not fit vertically, the grid scrolls (never below MIN).
// The width clamp is what keeps a PHONE PORTRAIT layout inside the viewport.
//
// Loaded before gallery.js (templates/index.html); unit-tested in
// tests/js/gallery_grid_test.js.

const GALLERY_GRID_MIN = 64;    // px — also a comfortable touch target
const GALLERY_GRID_MAX = 200;   // px — cap when there are few entries
const GALLERY_GRID_GAP = 10;    // px between cells
const GALLERY_GRID_MAX_COLS = 8;

// Maximum cells the sheet may show at once. The grid never renders the whole
// gallery: it shows a window of at most maxCols × maxRows entries around the
// current selection. Portrait phones get 3×4, landscape 4×5, and a wide
// landscape screen (where a 5×6 cell still keeps ≥96 px) gets 5×6.
const GALLERY_GRID_LIMITS_PORTRAIT = { maxCols: 3, maxRows: 4 };
const GALLERY_GRID_LIMITS_LANDSCAPE = { maxCols: 4, maxRows: 5 };
const GALLERY_GRID_LIMITS_WIDE = { maxCols: 5, maxRows: 6 };
const GALLERY_GRID_WIDE_MIN_CELL = 96;

function galleryGridLimits(width, height) {
  const W = Math.max(0, Number(width) || 0);
  const H = Math.max(0, Number(height) || 0);
  if (!W || !H || H >= W) return GALLERY_GRID_LIMITS_PORTRAIT;
  const g = GALLERY_GRID_GAP;
  const wideCell = Math.min(
    (W - (GALLERY_GRID_LIMITS_WIDE.maxCols - 1) * g) / GALLERY_GRID_LIMITS_WIDE.maxCols,
    (H - (GALLERY_GRID_LIMITS_WIDE.maxRows - 1) * g) / GALLERY_GRID_LIMITS_WIDE.maxRows
  );
  return wideCell >= GALLERY_GRID_WIDE_MIN_CELL
    ? GALLERY_GRID_LIMITS_WIDE
    : GALLERY_GRID_LIMITS_LANDSCAPE;
}

function galleryGridMetrics(n, width, height, limits) {
  const W = Math.max(0, Number(width) || 0);
  const H = Math.max(0, Number(height) || 0);
  const count = Math.max(0, Math.floor(Number(n) || 0));
  const g = GALLERY_GRID_GAP;
  if (!count || !W || !H) {
    return { cols: 1, rows: 1, cell: GALLERY_GRID_MIN, gap: g, scroll: false, shown: 0 };
  }
  const maxColsLimit = Math.max(
    1,
    Math.min(GALLERY_GRID_MAX_COLS, Math.floor(Number(limits && limits.maxCols) || GALLERY_GRID_MAX_COLS))
  );
  const maxRowsLimit = limits && Number(limits.maxRows) > 0
    ? Math.max(1, Math.floor(Number(limits.maxRows)))
    : Infinity;
  const maxColsByWidth = Math.max(1, Math.floor((W + g) / (GALLERY_GRID_MIN + g)));
  const colsCap = Math.min(maxColsLimit, maxColsByWidth);
  const maxCells = Number.isFinite(maxRowsLimit) ? colsCap * maxRowsLimit : Infinity;
  const shown = Math.min(count, maxCells);

  let cols = Math.round(Math.sqrt(shown * (W / H)));
  cols = Math.max(1, Math.min(colsCap, cols));
  let rows = Math.ceil(shown / cols);
  if (Number.isFinite(maxRowsLimit) && rows > maxRowsLimit) {
    // Fit the capped window in maxRows by widening the grid (never past the
    // width limit, which is what keeps phone portrait inside the viewport).
    cols = Math.min(colsCap, Math.ceil(shown / maxRowsLimit));
    rows = Math.ceil(shown / cols);
  }

  let cell = Math.min(
    (W - (cols - 1) * g) / cols,
    (H - (rows - 1) * g) / rows
  );
  let scroll = false;
  if (cell < GALLERY_GRID_MIN) { cell = GALLERY_GRID_MIN; scroll = true; }
  if (cell > GALLERY_GRID_MAX) cell = GALLERY_GRID_MAX;
  return {
    cols,
    rows,
    cell: Math.floor(cell),
    gap: g,
    scroll,
    shown,
  };
}
