# Improvement Plan — Comfy Tools

Status: proposed backlog  
Scope: `master` after the exact-seed work (`0992901`)  
Goal: harden the deployment surface, reduce maintenance risk, and make the
frontend/backend easier to test and evolve without changing the product's
current workflows.

The items are ordered by risk. **P0** should be completed before exposing the
app beyond a fully trusted LAN. **P1** addresses maintainability and delivery
quality. **P2** is polish and documentation hygiene.

---

## P0 — Security and exposure

### P0-1. Sanitize uploads and bound resources

**Why:** `api_upload()` in `server.py` writes to
`tmp_uploads / file.filename` using the client-provided name. A filename such
as `../../x` or an absolute path can escape the temp directory; the subsequent
`unlink()` can then remove an arbitrary file. The handler also reads the whole
upload into memory without a size limit.

**Tasks**

- Reduce the filename to its basename (`Path(file.filename).name`), reject
  empty/dot names, and generate a unique stored name.
- Enforce a maximum upload size and a set of accepted image content types
  (header + magic-byte check where possible).
- Write/stream the upload without unbounded memory growth.
- Keep the `finally` cleanup, but only for files created by the app.
- Add regression tests for `../`, absolute paths, oversized files and invalid
  content types.

**Acceptance:** traversal attempts cannot create or delete files outside
`tmp_uploads`; oversized/invalid uploads return a clear 4xx response; tests
cover the cases.

### P0-2. Define and enforce the network/authentication boundary

**Why:** the app has no authentication and the README starts it on
`0.0.0.0`. Anyone who can reach it can launch jobs, change settings and point
`comfyui_base_url` at another host. If a ComfyUI API key is configured, a
changed base URL can cause that key to be sent to an attacker-controlled
server.

**Tasks**

- Document the trust model explicitly: single-user, trusted LAN, or protected
  by a reverse proxy.
- Add optional authentication (Bearer token or reverse-proxy auth) for
  `/api/*` and `/media/*`, or ship a supported reverse-proxy example.
- Protect `/api/settings`: at minimum require auth; consider separating
  read-only status from mutating settings.
- Validate configured base URLs (scheme; optional host allowlist). Do not send
  the API key to a host that was not explicitly trusted.
- Add a startup warning when binding beyond loopback without auth.

**Acceptance:** an unauthenticated client cannot mutate settings or trigger
jobs when auth is enabled; the API key is never sent to an unapproved host;
the deployment model is documented.

### P0-3. Harden `/api/check-image` against SSRF

**Why:** the endpoint performs a server-side `GET` to an arbitrary URL with
redirects enabled. On a shared network this can reach internal services or
cloud metadata endpoints.

**Tasks**

- Allow only `http`/`https`.
- Block loopback, link-local, private and metadata ranges by default, with an
  explicit opt-in allowlist if internal sources are required.
- Re-validate the destination after redirects and cap redirects.
- Keep strict timeouts and a small read limit (already partially present).
- Add tests for blocked destinations and allowed public URLs (mocked).

**Acceptance:** private/metadata destinations are rejected by default;
the allowlist path is tested and documented.

### P0-4. Handle settings and secrets safely

**Why:** settings are stored in a plain JSON file under the home directory and
include the ComfyUI API key. File permissions and write atomicity are not
managed.

**Tasks**

- Write settings atomically (temp file + rename) and set restrictive
  permissions (`0600`) where the platform supports it.
- Prefer environment variables for secrets in production and document it.
- Add a settings schema/validation layer for URLs, model ids and prompts.
- Avoid logging secret values.

**Acceptance:** only the owner can read the config file; partial writes cannot
corrupt it; secrets are absent from logs.

---

## P1 — Reliability and maintainability

### P1-1. Add a CI pipeline

**Why:** there is no automated gate today. The Python suite is fast and
valuable, but it only runs when someone remembers to run it.

**Tasks**

- Add GitHub Actions (or equivalent) running:
  - `pytest`;
  - `python -m compileall` or an import smoke test;
  - `node --check` for every `static/js/*.js`;
  - `ruff` (lint + format check);
  - optional `mypy` on `server.py`, `comfy_client.py`, `config.py`, `tools/`.
- Publish test results/coverage; make the checks required for PRs.
- Cache Python dependencies to keep the job fast.

**Acceptance:** every PR runs the checks automatically; a failing test or lint
error blocks merge.

### P1-2. Add frontend tests for pure helpers

**Why:** the frontend has no automated tests. The new `static/js/seed.js`
(BigInt parsing, per-tab maxima, stepping, random range) is a good starting
point because it is pure logic.

**Tasks**

- Add a small JS test runner (`node:test`, Vitest or Jest) with no build step
  if possible.
- Cover `seed.js` boundaries: `0`, `2^32−1`, `2^50`, `2^53`, `2^64−1`, invalid
  strings, leading zeros and stepping at min/max.
- Add tests for other pure helpers (URL/filename normalization, storage
  migration, gallery deduplication).
- Optionally add DOM-level tests for the spinner/ARIA wiring.

**Acceptance:** `npm test` runs locally and in CI; the seed boundaries are
covered by automated tests.

### P1-3. Split `server.py` into focused modules

**Why:** `server.py` is ~1,200 lines and mixes routing, uploads, media proxy,
settings, job tracking, WebSocket progress and recovery. It works, but changes
have a large blast radius.

**Tasks**

- Extract routers/services, for example:
  - `api/tools.py` — generate/edit/face-swap/upscale/video endpoints;
  - `api/media.py` — upload, check-image, media proxy, media-exists;
  - `api/settings.py` — settings and refiner-model endpoints;
  - `jobs.py` — job registry, WS listener, progress payload, recovery;
  - `app.py` — app wiring and static/template setup.
- Keep the existing tests as the regression contract.
- Avoid changing endpoint paths or response shapes during the split.

**Acceptance:** `server.py` becomes thin wiring; modules have clear ownership;
the full suite passes unchanged (apart from imports).

### P1-4. Fix error semantics and improve observability

**Why:** most endpoint failures become `400`, including unexpected server
errors. Several background paths swallow exceptions silently, which makes
production diagnosis difficult.

**Tasks**

- Map validation/user errors to `400` (or `422`), upstream failures to `502`,
  timeouts to `408` (already done) and unexpected exceptions to `500`.
- Avoid returning raw internal exception text to clients by default.
- Add structured logging with request/job/prompt ids.
- Replace broad `except Exception: pass` in background paths with logged,
  best-effort handling.
- Add a basic health/readiness distinction if the app is deployed behind a
  proxy.

**Acceptance:** error classes are consistent and documented; logs identify the
failing job/request; unexpected errors return `500`.

### P1-5. Remove event-loop blocking from async handlers

**Why:** `api_upload()` is `async` but calls the synchronous `ComfyClient`
inside the event loop. A slow upload can block other requests.

**Tasks**

- Run the synchronous upload through `run_in_threadpool`, or make the upload
  client truly async.
- Review other `async def` handlers for blocking I/O.
- Combine this with the upload size/streaming work from P0-1.

**Acceptance:** concurrent requests remain responsive during uploads; a load
test or focused async test demonstrates it.

### P1-6. Reduce frontend global state and file size

**Why:** the frontend is ~17k lines of classic scripts with global functions
and inline `onclick` handlers. `gallery.js`, `api.js`, `player.js` and
`modal.js` are the largest files. It is functional, but hard to test and easy
to break through load-order coupling.

**Tasks**

- Move toward ES modules or at least explicit namespaces; remove new inline
  handlers.
- Split the largest files by responsibility (gallery registry vs rendering,
  API transport vs recovery, player state vs controls).
- Introduce a small shared event/state layer for cross-tab concerns.
- Keep the no-build deployment model unless there is a strong reason to change
  it.
- Document the module boundaries and load order.

**Acceptance:** no new globals, smaller files, and the frontend tests from
P1-2 cover the extracted helpers.

### P1-7. Add workflow/ComfyUI contract checks

**Why:** node titles, model filenames, workflow defaults and node seed maxima
are hardcoded. Tests catch many changes, but live ComfyUI behaviour is only
validated manually or through the live e2e scripts.

**Tasks**

- Add fixture-based tests that assert every title/parameter used by a builder
  exists in the corresponding workflow JSON.
- Add optional smoke tests against a real ComfyUI instance (nightly/manual),
  clearly separated from the default suite.
- Document the supported ComfyUI version and the custom node packs.

**Acceptance:** changing a workflow title or removing a required node fails a
test before runtime.

---

## P2 — Quality and documentation polish

- **Pin remaining dependencies:** `jinja2` and `python-multipart` are
  unpinned; consider splitting runtime and development requirements.
- **URL-encode the media proxy:** `/media/{filename}` concatenates
  `filename`/`type` into the upstream query string; use `urlencode` like
  `api_media_exists` does.
- **Docs hygiene:** keep `docs/mockup.html` clearly historical (or remove it),
  add this plan to the README documentation list, and keep the seed/node
  tables generated from the constants where practical.
- **Accessibility pass:** review labels, focus order, keyboard navigation,
  contrast and ARIA for the newer controls (the seed spinner already has
  `role="spinbutton"` and `aria-*`).
- **Dependency/security policy:** add Dependabot or a periodic `pip`/npm
  audit, and document the update cadence.
- **Job state durability:** `/api/last-result` is in-memory; decide whether a
  restart should preserve the last result and document the answer.

---

## Suggested milestones

1. **M1 — Security baseline:** P0-1 … P0-4, with regression tests.
2. **M2 — Delivery quality:** P1-1 and P1-2 (CI + frontend tests).
3. **M3 — Backend structure:** P1-3, P1-4, P1-5.
4. **M4 — Frontend and polish:** P1-6, P1-7 and P2.

## Tracking

- Create one GitHub issue per ID (`P0-1`, `P0-2`, …).
- Use branches named `fix/p0-1-upload-sanitize`,
  `chore/p1-1-ci`, etc.
- Each PR should include the acceptance criterion it satisfies and the tests
  that prove it.
