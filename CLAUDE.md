# StrongLifts 5x5 Tracker

## 1. Project Overview

A personal workout tracker for the StrongLifts 5x5 program. Built for one
user (a non-developer) to log workouts from a phone (installed as a PWA) and
a computer browser, with data synced between both via the cloud.

The app implements:
- **Workout A**: Squat, Bench Press, Barbell Row (5x5 each)
- **Workout B**: Squat, Overhead Press (5x5), Deadlift (1x5)
- Alternating A/B sessions
- Automatic weight progression on success, deload after repeated failures
- Custom user-defined exercises alongside the built-in five
- Dashboard, Workout, Progress (charts/PRs/streaks), History, and Settings
  screens
- CSV import/export compatible with the official StrongLifts app's export
  format

## 2. Tech Stack & Architecture

- **No build step.** Plain HTML/CSS/JS. Open `index.html` or deploy the
  folder as-is.
- `index.html` - all markup/screens (toggled via `.hidden` class, see
  `showScreen()` / `goToScreen()` in app.js)
- `style.css` - all styling
- `app.js` (~2100 lines, single file) - all app logic: state, rendering,
  cloud sync, CSV import/export, charts, service worker registration
- `sw.js` - service worker (caching/offline)
- `manifest.json` - PWA manifest (installable on Android via Chrome)
- `supabase/schema.sql` - one-time SQL setup for the cloud sync table
- External CDN scripts (loaded in `index.html`, no local copies):
  - Chart.js + `chartjs-plugin-zoom` + `hammerjs` (Progress screen charts)
  - `@supabase/supabase-js@2` (cloud sync + auth)
  - Google Fonts: Cinzel (headings) and Oswald (body)

### State & persistence
- All app state lives in one in-memory JS object: `state` (see
  `defaultState()` in app.js for shape: `unit`, `setupComplete`,
  `nextWorkout`, `exercises`, `session`, `history`, `plateInventory`,
  `customExercises`, `updatedAt`).
- **IndexedDB** (`sl5x5_db` / store `state` / key `main`) is the local
  persistence layer, written via `persistToIndexedDb()`.
- Every state mutation goes through `saveState(state)`, which stamps
  `state.updatedAt = new Date().toISOString()`, writes to IndexedDB, and
  schedules a cloud push.
- Legacy `localStorage` (`sl5x5_state`) data is auto-migrated to IndexedDB on
  first load if found (see `loadState()`).

## 3. Deployment Setup

- **Hosting**: GitHub Pages, repo `CamtheChamp/stronglifts-5x5-tracker`,
  served from `master`. Push to `master` deploys.
- **Cloud sync backend**: Supabase project (URL + anon key are hardcoded as
  `SUPABASE_URL` / `SUPABASE_ANON_KEY` constants near the top of app.js - this
  is intentional, the anon key is meant to be public and access is controlled
  by Postgres row-level security, see `supabase/schema.sql`).
- **Database**: single table `user_state` (`user_id` PK -> `auth.users`,
  `state` jsonb, `updated_at` timestamptz), RLS policies restrict each user to
  their own row.
- **Auth**: Google OAuth via Supabase Auth. Supabase project's "Site URL" /
  "Redirect URLs" must include the GitHub Pages origin (and a wildcard for the
  installed Android PWA, e.g.
  `https://camthechamp.github.io/stronglifts-5x5-tracker/*`) or sign-in will
  bounce to `localhost:3000`.
- **PWA install**: Android via Chrome "Install app". `manifest.json` +
  `sw.js` + icons in `icons/` make it installable.
- **Git on this machine**: `git` is not in PATH - invoke via
  `"C:\Program Files\Git\bin\git.exe"`.

## 4. Design System ("Gladiator" Aesthetic)

Dark, stone-and-gold, Roman colosseum theme. Defined as CSS variables in
`style.css :root`:

| Variable | Value | Use |
|---|---|---|
| `--bg-black` | `#15110d` | page background |
| `--bg-stone` / `--bg-stone-light` | `#241b13` / `#2e2218` | card backgrounds |
| `--gold` / `--gold-bright` | `#c9a84c` / `#e8c873` | headings, accents, primary actions |
| `--bronze` / `--bronze-dark` | `#8a6b32` / `#5e4a23` | borders, secondary accents |
| `--crimson` / `--crimson-bright` | `#8b0000` / `#c0392b` | warnings/destructive actions |
| `--text-light` / `--text-muted` | `#ece1cb` / `#a8957a` | primary/secondary text |
| `--border-gold` | `#9c7a3a` | borders/dividers |

Typography:
- **Headings (`h1`-`h4`)**: `'Cinzel', serif` - uppercase, wide letter-spacing,
  bold/black weight. `h1` and section headers use a gold gradient
  text-fill. `h2` has decorative gradient line flourishes before/after.
- **Body/UI text**: `'Oswald', sans-serif`.
- Background has a subtle radial gold glow + diagonal texture overlays for a
  weathered-stone feel.

When adding new UI, match this: dark stone cards, gold/bronze borders and
headings in Cinzel uppercase, body text in Oswald, crimson reserved for
destructive/alert actions (e.g. delete buttons, errors).

## 5. Key Decisions (and Why)

- **Service worker: network-first for everything** (`sw.js`, rewritten from
  scratch). Every GET request tries the network first and falls back to cache
  only on failure; the cache is just an offline fallback, not a perf layer.
  This was a deliberate simplification after the previous cache-first +
  manual-update-banner approach caused persistent stale-version bugs.
  - `VERSION` constant in `sw.js` must be bumped on every deploy - it both
    busts the SW's cache name and must match the `?v=` query string appended
    to `style.css`, `app.js`, and `manifest.json` in `index.html`.
  - On a new SW taking control (`controllerchange`), the page reloads itself
    exactly once (guarded by a flag) - no user-facing "update available"
    banner. Keep it this way: simple/automatic over clever/interactive.

- **Supabase is the source of truth; IndexedDB is an offline cache only.**
  - On load, if signed in and online, the app calls `syncStateWithCloud()`
    *before* the first render (see `init()`). If the cloud row's
    `updated_at` is >= local `state.updatedAt`, the cloud state replaces
    local state entirely (whole-blob, last-write-wins - no field-level
    merge). Otherwise local is pushed up.
  - Every `saveState()` call schedules a debounced (500ms) push
    (`scheduleCloudSync` -> `pushStateToCloud`). The debounce is short and
    is **flushed immediately** (`flushCloudSync`) on `visibilitychange`
    (going hidden) and `pagehide`, so backgrounding/closing the app doesn't
    silently drop a pending push.
  - `window.addEventListener('online', ...)` re-runs `syncStateWithCloud()`
    so offline edits sync up automatically on reconnect.
  - This is a **whole-state-blob, last-write-wins** model, not a merge/CRDT.
    If both devices make independent edits while the other is offline, one
    set of edits will be silently discarded by design. This is an accepted
    tradeoff for a single-user app, not a bug to "fix" with a bigger
    rewrite unless asked.
  - Cloud sync is fully optional/no-op if `sb` is null (Supabase JS failed to
    load) or the user isn't signed in - the app must keep working purely on
    IndexedDB in that case.

- **Settings -> Data -> Cloud Sync section** includes a diagnostics panel
  (account email + user id, "this device's data last changed", "cloud data
  last changed") plus manual Force Pull / Force Push buttons. Keep these -
  they're the primary tool for resolving sync drift by hand.

- **Last screen persistence**: the currently-active tab/screen is saved to
  `localStorage` (`sl5x5_last_screen`) via `goToScreen()` and restored on
  load (`init()`), so a refresh doesn't bounce the user back to the
  Dashboard.

- **App version display**: `APP_VERSION` constant in app.js is shown on the
  Dashboard (`#app-version`). Bump it alongside `sw.js`'s `VERSION` on every
  deploy so the user can confirm an update landed.

## 6. Known Issues / In Progress

- The whole-blob LWW sync (see above) means two **simultaneous** offline
  edits on different devices can still result in one device's changes being
  overwritten when both come back online around the same time. No
  field-level merge exists. If this becomes a real problem, it would need a
  larger design discussion before implementing - don't silently bolt on a
  merge strategy.
- No automated tests exist. Verification is manual: open in browser /
  installed PWA on both a computer and an Android phone, check the dashboard
  version number matches the latest deploy, and confirm the Cloud Sync
  diagnostics panel shows matching/updated timestamps after an edit.
- Sync requires the user to be signed in with Google on **both** devices.
  Getting silently signed out on one device (session expiry, browser data
  clearing, etc.) looks exactly like a sync bug - check the "Signed in as"
  line in Settings -> Data first when debugging sync reports.

## 7. Rules for Future Sessions

- **No build tooling.** Don't introduce bundlers, package.json, npm
  dependencies, frameworks, or a build step. Keep it plain HTML/CSS/JS
  served directly.
- **Every deploy that changes `style.css`, `app.js`, `manifest.json`, or
  `sw.js`'s cached asset list must**:
  1. Bump `VERSION` in `sw.js`.
  2. Bump `APP_VERSION` in `app.js` to match.
  3. Update the `?v=...` query strings in `index.html` for `style.css`,
     `app.js`, and `manifest.json` to match.
  - Forgetting this means devices may keep serving stale cached assets.
- **Don't reintroduce an "update available" banner / manual update
  flow.** The user explicitly asked for automatic skipWaiting + single
  reload instead. Don't add prompts, confirms, or banners for SW updates.
- **Don't use `alert()`/`confirm()`/`prompt()` for cloud sync status.**
  These get silently suppressed by some browsers after repeated use. Use
  the `#sync-status` text element (`setSyncStatus()`) instead. (CSV
  import/export and the history-delete confirmation still use
  `confirm()`/`alert()` - that's existing/accepted behavior, just don't add
  *new* dialogs for sync.)
- **Keep the gladiator dark/gold/stone aesthetic** (section 4) for any new
  UI - reuse the existing CSS variables, don't introduce new color
  palettes or fonts.
- **Don't touch `SUPABASE_URL` / `SUPABASE_ANON_KEY`** unless the user
  explicitly provides new ones - these are tied to their Supabase project.
- **IndexedDB (`sl5x5_db`) schema** (`DB_NAME`/`DB_VERSION`/`STORE_NAME`/
  `STATE_KEY` constants) - if you ever need to change the stored shape of
  `state`, do it via additive fields with defaults in `loadState()` (see how
  `plateInventory`/`customExercises` were added), not a breaking schema
  change, since there's no migration framework.
- Git: use `"C:\Program Files\Git\bin\git.exe"` (not on PATH on this
  machine). Push to `origin/master` deploys to GitHub Pages - confirm with
  the user before pushing if a change is large/risky, but routine
  fix-and-deploy iterations have been the established workflow.

## 8. Current Feature List (do not remove without discussion)

**Setup / Settings (tabs: Weights, Plates, Exercises, Data)**
- Unit toggle (lb/kg) with per-unit default starting weights/increments
- Per-exercise starting weight configuration
- Plate inventory configuration (used to compute plate breakdown per lift)
- Custom exercise creation (name, workout assignment, sets/reps, starting
  weight, increment, deload %)
- CSV export of full history
- CSV import from official StrongLifts app export (replaces history + resets
  working weights to most recent session)
- Cloud Sync section: Google sign-in/out, sync diagnostics (account, local
  vs. cloud `updated_at`), Force Pull, Force Push

**Dashboard**
- Last workout summary card
- Weekly frequency chart
- Weight trends (last 4 weeks) per exercise
- Deload suggestion card (with adjustable deload % preview) when triggered
- "Start Workout" button
- App version display

**Workout (Home) screen**
- Workout A / B selector with "Recommended" badge for the next workout
- Per-exercise set/rep grid with plate-breakdown display
- Body weight entry (optional)
- Rest timer (auto-starts after a set, shown as a bottom bar with skip)
- "Finish Workout" -> applies progression/deload rules, records history,
  flips next workout A/B, shows a congrats modal with summary

**Progress screen**
- Range filters: Last Month / Last Year / Lifetime
- Stats grid (PRs, streaks, total volume, workout count)
- Interactive chart (Chart.js + zoom/pan plugin) with optional trend lines,
  reset-zoom control
- Per-exercise pills to filter the chart
- Tap a data point for a detail modal; per-exercise detail modal with its own
  chart and PR timeline

**History screen**
- List of all logged workouts (most recent first)
- Delete button per entry (with confirmation)

**Cross-cutting**
- Bottom navigation (Dashboard / Workout / Progress / History / Settings)
- Last-viewed screen persists across reloads
- PWA installable (manifest + service worker), offline-capable
- Cloud sync across devices via Supabase (see section 5)
