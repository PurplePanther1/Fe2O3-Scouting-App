# Smoke tests

Small, permanent Playwright suite covering the app's core flows. Run it on
demand — no CI. **Run it after every deploy** (standing convention).

## Run the full suite

```
cd scripts/smoke-tests
npm install        # first time only (Playwright 1.63.0; Chromium is already installed)
npm test           # = node run-all.js
```

Exit code is `0` if everything passed, `1` otherwise. A full run takes ~2 minutes.
Failure screenshots land in `artifacts/` (gitignored).

Useful flags: `node run-all.js --only pit` (filename filter, applies to rules tests
too) and `--headed` (watch the browser).

## What it covers

| File | Flow |
| --- | --- |
| `01-login.js` | Sign up, email verification, display-name gate, sign out, wrong password rejected, sign in |
| `02-team.js` | Create a team; a second user joins with the join code; both on the roster |
| `03-pit-scout.js` | Create a pit entry; survives a full reload; reopens with saved values |
| `04-match-scout.js` | Create a match entry via Team View; shows in View Matches Scouted |
| `05-pit-vs-match.js` | Pit vs Match comparison modal shows pit data + match stats; entry viewer opens |
| `06-scrimmage.js` | Scrimmages end to end: create, whole-row open/deselect (buttons don't trigger the row), text-only banner/hidden controls, Add Team to Roster, "+ Add & scout a team" (new + existing team, modal reset, no orphan drafts), reload restore, unlinked Team Details (no FTCScout), member view, Manage's Add Team + Delete, SEASON CHANGE (danger confirm with totals/per-team lines, Cancel/X/click-out change nothing, Export First on a scrimmage that is not open, confirm deletes entries + zeroes matchCount + keeps the roster, a teammate with an entry open is disconnected, no-prompt cases), removing a team WITH entries, export isolation, delete cascade |
| `07-scrimmage-layout.js` | Subtab bar, rows, banner, add buttons + help lines, Add Team / Manage modals, the season-change confirm and the Pinned tab from 320px to 1280px (re-measure the `@media` breakpoint in `css/style.css` if a subtab is added) |
| `08-scrimmage-permission.js` | Grant/revoke `canManageScrimmages` shows/hides Manage, Delete and + New live; Manage works for a granted member |
| `09-scrimmage-restore.js` | Refresh restores an open scrimmage; a since-deleted one is cleared with a notice |
| `10-scrimmage-team-delete.js` | `deleteEntireTeam()` clears scrimmages and their entries |
| `11-pinned-events.js` | Pins record their season; the Pinned dropdown defaults to, FOLLOWS and resets to the app's selected season (picking a season there only filters); whole-row toggle; cross-season select switches the app's season and the dropdown shows it (and reproduces the original error); legacy pins |
| `12-transient-inputs.js` | Tagged status lines clear when their view is left (and not when re-clicking it); search/filter/sort/season are NOT cleared |
| `13-search-vs-scrimmage.js` | Regression for the stale-row-click bug: search / select an official event / click a scrimmage in any order, repeatedly, from the Scrimmages tab — search box, results, banner and hidden controls asserted after every step; the cleared search survives a refresh |

### Rules tests (`rules-tests/`)

Run first, against the real `firestore.rules` on the same emulator (no browser):
`01-scrimmage-rules.js` covers the scrimmage permission gate, roster
add/edit/no-remove, increase-only `matchCount`, immutable season/eventCode,
the entry cascade-delete clause, and that entries without a `scrimmageId` are
unaffected. Add new `rules-tests/NN-name.js` files exporting
`{ name, async run(ctx) }` (`ctx.rulesEnv` is a rules-unit-testing
environment; use unique IDs rather than clearing Firestore).

## How it works (and what it does NOT touch)

- Starts a static server for the working tree plus the **Firebase Auth +
  Firestore emulators**, loading the real `firestore.rules`. Needs the global
  `firebase` CLI and Java (both already installed).
- The page's `js/firebase-config.js` is swapped in flight to point at a
  throwaway `demo-` project on the emulators, so a run **can never read or
  write production Firebase**. App source is never modified.
- The FTC proxy worker and FTCScout GraphQL are mocked with fixtures (event
  `SMOKE1`, teams 101/202/303). Google sign-in, the feedback worker and other
  external calls are blocked. Firebase SDK / xlsx / JSZip CDN files are cached
  in `.cdn-cache/` after the first run.
- Each test creates its own users/teams, so tests are independent.

Because it runs the **working tree** against emulators, it validates the code
that was just deployed but not the hosts themselves — that's what the next
check is for.

## Post-deploy: do the live hosts serve these files?

```
node run-all.js --deployed https://staging.fe2o3scouting.pages.dev https://scouting-app-9b4c4.web.app
```

Fetches every JS file, `css/style.css`, `scouting/index.html` and
`scouting/sw.js` from each URL with cache-busting + no-cache headers and
compares them byte-for-byte with the working tree. Pass the Cloudflare
staging/production URL(s) and the Firebase Hosting URL you just deployed to.
`--deployed` can be combined with the emulator tests (the usual post-deploy
command) or used alone with `--only none` to skip them.

## Adding a test

Drop a new `NN-name.js` in `tests/` exporting `{ name, async run(ctx) }`.
`ctx.newPage()` gives a fresh browser context, `ctx.makeUser()` a verified
emulator account; `lib/app.js` has the UI helpers (sign in, create/join team,
select the fixture event, pit/match scout a team). Any uncaught page error
during a test fails it.
