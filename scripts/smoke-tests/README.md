# Smoke tests

Small, permanent Playwright suite covering the app's core flows. Run it on
demand — no CI. **Run it after every deploy** (standing convention).

## Run the full suite

```
cd scripts/smoke-tests
npm install        # first time only (Playwright 1.63.0; Chromium is already installed)
npm test           # = node run-all.js
```

Exit code is `0` if everything passed, `1` otherwise. A full run takes ~3 minutes.
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
| `06-scrimmage.js` | Scrimmages end to end: create, whole-row open/deselect (buttons don't trigger the row), text-only banner/hidden controls, Add Team to Roster, "+ Add & scout a team" (new team; an existing number is an INLINE ERROR with the modal kept open and no form; modal reset, no orphan drafts), reload restore, unlinked Team Details (no FTCScout), member view, Manage's Add Team + Delete, SEASON CHANGE (danger confirm with totals/per-team lines, Cancel/X/click-out change nothing, Export First on a scrimmage that is not open, confirm deletes entries + zeroes matchCount + keeps the roster, a teammate with an entry open is disconnected, no-prompt cases), removing a team WITH entries, export isolation, delete cascade |
| `07-scrimmage-layout.js` | Subtab bar, rows, banner, add buttons + help lines, Add Team / Manage modals, the season-change confirm and the Pinned tab from 320px to 1280px (re-measure the `@media` breakpoint in `css/style.css` if a subtab is added); phase 2 adds long-named roster rows + link badges in all four lists, the bulk-link button/result, the FTCScout lookup modal (idle + found; the Look up button sits UNDER the number box, full width), the Edit modal in all four states A/B/C/D (buttons, hints, the lock note in B and C and hidden in D), the 'OPR: unlinked' text, the bulk-link REVIEW popup with 52 rows at 320-1280px and on a 320x480 screen (only the list scrolls, buttons stay), the whole-team export choice with 'Include scrimmages', the My Team 'N not included' line; phase 3 adds the Edit modal's merge choice and the merge COMPARE screen (3 conflicts with long values, an unbroken token and a long deleted-field key: card on screen, Cancel/Merge reachable at the top and after scrolling, A/B stacked on a narrow screen and side by side on a wide one, the Discard confirm above it), the lookup popup's RESULTS list (5 rows: a very long name, a greyed roster team, a picked row; the popup is a flex column so only its middle scrolls and Cancel / Use This Team stay on a 320x480 screen) and the My Account DATA card's refresh button in its idle / refreshing / cooldown states, all at 320-1280px and on a 320x480 screen |
| `08-scrimmage-permission.js` | Grant/revoke `canManageScrimmages` shows/hides Manage, Delete and + New live; Manage works for a granted member |
| `09-scrimmage-restore.js` | Refresh restores an open scrimmage; a since-deleted one is cleared with a notice |
| `10-scrimmage-team-delete.js` | `deleteEntireTeam()` clears scrimmages and their entries |
| `11-pinned-events.js` | Pins record their season; the Pinned dropdown defaults to, FOLLOWS and resets to the app's selected season (picking a season there only filters); whole-row toggle; cross-season select switches the app's season and the dropdown shows it (and reproduces the original error); legacy pins |
| `12-transient-inputs.js` | Tagged status lines clear when their view is left (and not when re-clicking it); search/filter/sort/season are NOT cleared |
| `13-search-vs-scrimmage.js` | Regression for the stale-row-click bug: search / select an official event / click a scrimmage in any order, repeatedly, from the Scrimmages tab — search box, results, banner and hidden controls asserted after every step; the cleared search survives a refresh |
| `14-scrimmage-ftc-link.js` | FTCScout lookup + link: the popup searches a typed number BY ITSELF when it opens (one match = one card, auto-selected); found / not found ('No FTCScout team matches N.') / network-or-API error on the details (just an error — the popup has NO manual button, the plain Add is the manual route); the popup's number is EDITABLE from the Add modal and mirrored into it (kept when the popup is cancelled); a team already on the roster is GREYED in the popup ('already on this scrimmage', nothing looked up) and an existing number is an inline error in the Add modal; a linked add REPLACES the typed name (manualName keeps it); scout mode (modals fully closed before the pit form; cancel leaves no team/draft); the **#99999 trap** (an unlinked team never queries or shows FTCScout; only an explicit lookup does, and cancelling it changes nothing); popup reset on every open/close; stale responses dropped; z-order under the confirm modal; roster Edit -> Link: the OFFICIAL name drops into the read-only name box before Save, no preview line anywhere, Cancel reverts, manualName keeps what was typed; Team Details unlinked (no request, Link button) vs linked (real data for the scrimmage's season, also an old-season scrimmage) |
| `15-scrimmage-bulk-link.js` | "Bulk link teams (N)" REVIEW popup: ONE batched lookup for the unlinked teams only that writes NOTHING; found teams as checkboxes (all checked; `typed -> official` only when the name changes), not-found teams listed without checkboxes; confirm label follows the count ("Link 3 teams"/"Link 1 team", disabled at 0); only the checked teams are linked; Cancel/X/click-out change nothing and the next open starts fresh; no second confirm and no result line that stays (auto-clearing message); network failure changes nothing; none-found -> a notice; a plain member can; "unlinked" badges on Info/Pit/Match/Compare, "linked" on Info only, none on an official event |
| `16-whole-team-export-scrimmages.js` | Whole-team export: "Include scrimmages" (default OFF on every open), `gatherFullTeamExportData({ includeScrimmages })`, entries labelled by scrimmage NAME (unique for equal names), team names from the scrimmage roster, season via `entrySeason()`; the "N scrimmage entries not included" line on My Team / Leave Team / Delete Account; the precheck uses the filtered result (scrimmage-only team still gets the modal, empty team gets "nothing to export"); real Excel zip contents with the box off and on |
| `17-scrimmage-unlink-renumber.js` | A LINKED team's Edit: read-only name and number; staged Unlink (nothing written until Save, Cancel reverts) unlocks the name and — for a manager — the number; Save writes linked false / location '' / opr null / linkedAt null / name = manualName = the box; renumber = roster re-key; a number already on the roster offers the MERGE choice to a manager (no inline error; Save is off while it shows; 'Change the number' backs out and refocuses the box); a team WITH a committed entry is renumberable and says its entry travels; an empty draft is swept; a plain member can unlink but never renumber; a draft with a live editor blocks ('Someone is editing...'); Manage's '+ Add Team' refuses a duplicate inline |
| `18-scrimmage-empty-draft.js` | REPRODUCES the phantom entry: Add & scout -> Cancel leaves an EMPTY SHELL doc (no checkpoint/scoutedBy). It is not an entry in any user-facing count (season-change confirm, Remove Team, Delete Scrimmage, "N scrimmage entries not included", included exports) but every delete still sweeps it; a shell-only season change needs no prompt |
| `19-scrimmage-season-opr.js` | After a season change, linked teams' OPR/location are refreshed for the NEW season with ONE batched request (lists + Team Details agree); a team with no stats there shows "OPR: --" (never the old number) while an UNLINKED team shows "OPR: unlinked" in the Info/Pit/Match lists and the Team Details badge; the "No OPR For This Season Yet" notice names only the linked teams that got "--" and mentions "unlinked" only when the scrimmage has unlinked teams; FTCScout unreachable clears the OPRs and says so; the change-with-entries path refreshes too; a name-only edit / no linked teams / unlinked teams send no request |
| `20-scrimmage-edit-states.js` | The Edit modal as a state machine: A unlinked (number editable from the moment it opens for a manager, 'Checking...' while the check runs), B pending link (official name read-only, number locked, button 'Unlink' discards the staged link and restores the name, number keeps what was typed, the lock note shows with 'Press Unlink'), C linked (both boxes read-only + the lock note word for word, 'Unlink from FTCScout'), D pending unlink (name/number unlock, the lock note is hidden, button 'Link to FTCScout' again, link the NEW number without closing); **focus**: no read-only or disabled box is the active element or wears the focus highlight in A/B/C/D and the Add modal (a linked team opens with nothing focused, Unlink hands focus to the now-editable name, even a CLICKED read-only box doesn't look focused); the number hint sits DIRECTLY under the number box; the lookup popup's number is editable in Edit when renumbering is allowed and mirrored back (the team's OWN number is not greyed as a duplicate; another roster team's row is greyed); link + renumber is ONE transaction (no intermediate snapshot) that also sweeps the old number's empty shell; Cancel reverts all; a roster number at Save shows the merge choice; hints for member / 'This team's N scouting entries move with it' / 'Jordan is editing' / 'Jordan and Sam are editing' (own session and stale presence don't count; an editor appearing between open and Save is caught at Save) |
| `21-scrimmage-renumber-merge.js` | Phase 3 (`js/scrimmage-merge.js`), through the real UI on the real rules: renumbering a team WITH data (pit + match entries get new doc ids, every field and the ORIGINAL scout/last editor kept, old docs and the old number's empty shells gone, an empty shell already on the new pit doc id is cleared; lists, scouted checkmarks, match counts and Team Details right at the new number without a refresh); FAILURES never lose data (copy fails -> nothing changed; roster step fails -> copies rolled back, originals intact, retry works; final delete fails -> 'Some Old Entries Remain' + Try Again); a MANAGER-ONLY user (canManageScrimmages, no captain / edit-others) can move and merge another scout's entries, a plain member cannot (permission hint); a live editor blocks with a NAMED message; the Add flow still just errors on a duplicate; merge with NO overlap = a plain confirm that says exactly what moves (Cancel changes nothing; B's blank name takes A's); merge with OVERLAP = the Compare screen (both-pit + same-match conflicts + a non-conflicting entry that just moves, who/when per side, only differing fields get radios — default B, equal fields collapse, '(deleted field)' values, 'Use all of #A/#B', Cancel/X/click-out -> 'Discard changes?' -> nothing written); chosen values land in the live fields AND the checkpoint, B's scoutedBy/scoutedAt kept, lastEditedBy = the manager, all-B choices leave B's doc untouched; an editor who appears, or an entry that changes, while the Compare screen is open blocks the final write |
| `22-ftc-lookup-popup-typing.js` | The lookup popup's typing behaviour: a number already in the box is searched by itself on open (Add, Edit, Team Details; a roster team shows greyed, nothing looked up; a blank box does nothing — and does not even load the team list); 500 ms debounce measured from the LAST keystroke (nothing searched for the partial numbers typed on the way, exactly one search afterwards, typing again restarts the wait); the Look up button searches immediately and cancels the pending wait; a late answer for an older query is ignored; closing cancels a pending wait and the next open is clean |
| `23-ftc-team-search.js` | Partial team search on the LOCAL cached FTCScout team list: nothing fetches the list until a search needs it ('Loading team list...' meanwhile, the typed number is searched as soon as it is ready), ONE request, stored in IndexedDB (number, name, location, fetched-at) and NOT refetched after a reload; ranking — exact first, then numbers that start with the digits, then numbers that merely contain them, lower first, at most 5 (36 -> 36, 365, 3650, 36012, 36533 and not 36999/1365/7360; 365 -> 365, 3650, 36533, 1365; 865 -> 865, 8651, 21865); the results list (#number, name, location, OPR from ONE batched request for the shown teams, the scrimmage's season); roster teams greyed + unselectable, one match = one auto-selected card, several = nothing auto-selected; picking a row puts ITS number in the popup box and mirrors it into the Add/Edit modal (kept on cancel), Add links the PICKED team with its official data, Edit's Save renumbers + links; a failed OPR request leaves OPR blank and picking still works (the link fetches the details itself, and fails cleanly while offline); a LOCKED number (Team Details) shows exactly that team, no list; 24 h staleness with a FAKED clock (23 h = no request, 25 h = refreshed, a stale copy still used when the refresh fails, no retry hammering); with no list at all the popup falls back to the exact-number lookup with a note |
| `24-refresh-cached-data.js` | My Account > DATA 'Refresh cached data': replaces the stored team list; writes/deletes NOT ONE shared Firestore doc (events, event lists, team stats byte-identical) — instead this device treats every cached copy as expired (roster, team stats incl. the open scrimmage's linked teams) and the event reloads FRESH from the worker on its next open and is re-cached; in-memory copies cleared; scouting entries, form configs, the scrimmage and the session untouched; the open scrimmage keeps working; 'Refreshing...' then 'Refreshed. Event data will reload when you next open it.'; a double start sends ONE request; the cooldown (one named constant, 15 min) starts only after a success, survives a reload, shows 'Available again in N min' (12 min after 3 min), ends by itself, and is enforced even if the function is called directly; a part-way failure says so, keeps the old stored list and starts NO cooldown |

### Rules tests (`rules-tests/`)

Run first, against the real `firestore.rules` on the same emulator (no browser):
`01-scrimmage-rules.js` covers the scrimmage permission gate, roster
add/edit/no-remove (including the FTCScout **link** writes — linked add, per-field link, several teams in one write, by a plain member and by a permission holder — which needed no rules change), increase-only `matchCount`, immutable season/eventCode,
the entry cascade-delete clause, and that entries without a `scrimmageId` are
unaffected. Add new `rules-tests/NN-name.js` files exporting
`{ name, async run(ctx) }` (`ctx.rulesEnv` is a rules-unit-testing
environment; use unique IDs rather than clearing Firestore).

`02-scrimmage-entry-move-rules.js` (21 checks) pins the write patterns phase 3 relies on to
move a team's entries (renumber / merge) with NO rules change: any member can CREATE a copy of
another scout's committed entry (original scoutedBy/lastEditedBy kept), a canManageScrimmages-only
user can cascade-DELETE the old docs, but cannot update another scout's committed entry, a
batch that deletes and re-creates the SAME doc id is denied (the rules see an update), and a
copy cannot land on an existing empty shell (so shells are deleted first).

`03-shared-cache-rules.js` (10 checks) pins what the 'Refresh cached data' design rests on: events/, eventCache/ and teamDetails/ docs can NEVER be deleted by a client (so the app never relies on deleting a shared cache — and the old swallowed delete in `getCachedTeamDetail()` has always been a silent no-op), any signed-in user can ALREADY overwrite them or reset their `cachedAt` (existing behavior; the button deliberately writes none of it), and signed-out users can do nothing.

## How it works (and what it does NOT touch)

- Starts a static server for the working tree plus the **Firebase Auth +
  Firestore emulators**, loading the real `firestore.rules`. Needs the global
  `firebase` CLI and Java (both already installed).
- The page's `js/firebase-config.js` is swapped in flight to point at a
  throwaway `demo-` project on the emulators, so a run **can never read or
  write production Firebase**. App source is never modified.
- The FTC proxy worker and FTCScout GraphQL are mocked with fixtures (event
  `SMOKE1`, teams 101/202/303). The FTCScout mock also knows a few extra teams
  (1234, 2468, 3579, 5555; **#3579 has NO stats from the current season on**, like most teams right after a new season starts) and **#99999 ("Off-Season Demo Team", a real FTCScout
  team — the unlinked-scrimmage-team trap)**; any other number, e.g.
  `FTCSCOUT_UNKNOWN_NUMBER` (88888), answers `null` = not found. Its OPR depends on
  the season in the query, so a test can tell which season was asked for. Tests can
  force failures through the shared `ctx.state`: `ftcScoutMode = 'abort'` (network
  failure) or `'error'` (HTTP 500), and `ftcScoutDelays = { 5555: 1500 }` to hold a
  team's response (stale-response tests) — always restore them in a `finally`. Google sign-in, the feedback worker and other FTCScout's full team list (`teamsSearch(searchText: "")`) is mocked too: every known team, ascending, plus the search teams 36/365/3650/36012 (a very long name + location)/36533/36999/1365/7360/865/8651/21865 and #4040 (the roster-duplicate case); `ctx.state.ftcScoutListMode = 'error' | 'abort'` forces a list-fetch failure, `ftcScoutListDelay` holds the response, `ftcScoutListRequests` counts them (shared across tests: compare against a baseline). Each test gets a fresh browser context, so each starts with an empty IndexedDB.
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
