// ====== FIRST FTC Events API Integration (via Cloudflare Worker) ======

// ⚠️ UPDATE THIS URL after deploying the worker:
//    wrangler deploy → it will print your worker URL
const FTC_PROXY_BASE = 'https://fe2o3-ftc-proxy.fe2o3-scouting.workers.dev';

// Currently selected event data
let selectedEvent = null;
let isSearching = false;
let debounceTimer = null;
// Separate from debounceTimer above (which only drives suggestion rendering,
// 150ms) — persists in-progress search text (session-state.js) per team even
// when the user never actually selects/clears an event, so switching teams
// and back doesn't lose an unsubmitted query. Longer delay since writing to
// sessionStorage on every keystroke would be wasteful.
let searchSaveDebounceTimer = null;

// ====== The array most recently passed to renderEventList() — null again
// whenever clearSelectedEvent() genuinely wipes #event-results (a fresh
// search, a season change, ...), so deselectEventPreservingResults() (below)
// always knows whether there's an actual list worth restoring versus
// nothing having been searched yet. ======
let lastRenderedEventResults = null;

// ====== In-memory event cache (keyed by season) ======
const eventCache = {};

// ====== Show an event-tab-level error, auto-clearing it after a few seconds
// ======
// event-error sits inline on the persistent Events area (not a modal that
// gets closed), and unlike doSearch()'s own errors — cleared by clearErrors()
// the next time the user searches — a team-load failure here was never
// cleared by anything if the user just moved on to browsing rather than
// retrying, so it could sit there indefinitely. Not using the shared
// showError() directly since that's also used for blocking form-validation
// errors elsewhere (Sign In, Create Team, ...) where persisting until the
// next attempt is correct; this is scoped to event-error alone.
let eventErrorTimer = null;
function showEventError(message) {
  showError('event-error', message);
  if (eventErrorTimer) clearTimeout(eventErrorTimer);
  eventErrorTimer = setTimeout(() => {
    const el = document.getElementById('event-error');
    if (el) el.textContent = '';
    eventErrorTimer = null;
  }, 5000);
}

// ====== The exact moment a given calendar year's FTC season kicks off: the
// 2nd Saturday of September, 12:00 EST (a fixed UTC-5 offset, as specified —
// not "Eastern time" generically, so this doesn't shift with DST). Returns a
// UTC timestamp (ms since epoch). Mirrors workers/ftc-proxy.js's
// getSeasonKickoffUTC() — duplicated rather than shared, same as every other
// piece of season logic between the worker and this file, since there's no
// build step / shared module to put it in. ======
function getSeasonKickoffUTC(year) {
  const sept1Dow = new Date(Date.UTC(year, 8, 1)).getUTCDay(); // month 8 = September
  const firstSaturday = 1 + ((6 - sept1Dow + 7) % 7);
  const secondSaturday = firstSaturday + 7;
  return Date.UTC(year, 8, secondSaturday, 17, 0, 0); // 12:00 EST = 17:00 UTC
}

// ====== Compute the current FTC season ======
// FTC seasons run September–April, named by the year they start, and don't
// actually become "current" until that year's real kickoff (2nd Saturday of
// September, 12:00 EST) — before that, the PRIOR season is still current,
// even though the calendar month is already September. Mirrors
// workers/ftc-proxy.js's getCurrentSeason().
function getCurrentFtcSeason() {
  const now = Date.now();
  const thisYear = new Date(now).getUTCFullYear();
  return now >= getSeasonKickoffUTC(thisYear) ? thisYear : thisYear - 1;
}

// ====== Format an FTC season number as its "YYYY-YYYY" label, plus the
// season's game name once known (e.g. 2025 -> "2025-2026" or, once
// seasonGameNameCache has resolved it, "2025-2026 — INTO THE DEEP presented
// by RTX"). Every place that displays a season (the season dropdown, the
// Team Detail modal's awards season filter) already goes through this one
// function, so enriching it here covers all of them. ======
function formatFtcSeasonLabel(season) {
  const s = Number(season);
  const base = `${s}-${s + 1}`;
  const gameName = seasonGameNameCache[s];
  return gameName ? `${base} — ${gameName}` : base;
}

// ====== Season game-name cache (season -> gameName string, or null once
// confirmed unavailable) — fetched lazily from FIRST's own API (via the
// worker's /season endpoint), never a maintained lookup table, since FIRST
// already serves this. ======
const seasonGameNameCache = {};

// ====== Fetch a season's game name (if not already cached) and patch every
// matching <option> already in the DOM in place once it resolves — safe to
// call repeatedly/concurrently for the same season. A no-op once cached
// (formatFtcSeasonLabel() already picks it up on the next render from
// there), so callers can call this unconditionally after building any
// season <option>. ======
async function ensureSeasonGameNameLoaded(season) {
  const s = Number(season);
  if (s in seasonGameNameCache) return seasonGameNameCache[s];

  try {
    const result = await callWorker(`/season?season=${encodeURIComponent(s)}`);
    seasonGameNameCache[s] = (result && result.gameName) || null;
  } catch (err) {
    console.warn(`Failed to load game name for season ${s}:`, err);
    seasonGameNameCache[s] = null;
  }

  if (seasonGameNameCache[s]) {
    document.querySelectorAll(`option[value="${s}"]`).forEach(opt => {
      const isCurrent = opt.textContent.includes('(current)');
      opt.textContent = formatFtcSeasonLabel(s) + (isCurrent ? ' (current)' : '');
    });
  }
  return seasonGameNameCache[s];
}

// ====== Populate season dropdown ======
function populateSeasonDropdown() {
  const select = document.getElementById('select-season');
  const current = getCurrentFtcSeason();
  const startYear = Math.max(current - 8, 2020);

  for (let y = current; y >= startYear; y--) {
    const option = document.createElement('option');
    option.value = y;
    const label = current === y ? `${formatFtcSeasonLabel(y)} (current)` : formatFtcSeasonLabel(y);
    option.textContent = label;
    if (y === current) {
      option.selected = true;
    }
    select.appendChild(option);
  }

  // Game names load lazily (one worker call per season, cached) and patch
  // each option's label in place once resolved — the dropdown is fully
  // usable immediately with year-only labels; this is a progressive
  // enhancement on top of that, not a blocking step.
  for (let y = current; y >= startYear; y--) {
    ensureSeasonGameNameLoaded(y);
  }
}

// ====== Get selected season from dropdown ======
function getSelectedSeason() {
  return document.getElementById('select-season').value;
}

// ====== Fetch helper for the worker ======
async function callWorker(endpoint) {
  const url = `${FTC_PROXY_BASE}${endpoint}`;
  const response = await fetch(url);

  if (!response.ok) {
    const body = await response.text();
    let msg = `Worker error ${response.status}`;
    try {
      const parsed = JSON.parse(body);
      if (parsed.error) msg = parsed.error;
    } catch (_) {}
    throw new Error(msg);
  }

  return await response.json();
}

// ====== Cache freshness: re-fetch if older than 1 hour ======
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// ====== Fetch and cache all events for a season ======
async function ensureEventsLoaded(season) {
  // Already in memory and fresh
  if (eventCache[season]) return eventCache[season];

  // Try Firestore cache first
  const cacheDoc = await db.collection('eventCache').doc('season_' + season).get();
  if (cacheDoc.exists) {
    const data = cacheDoc.data();
    if (data.events && data.events.length > 0) {
      // Check freshness: if cachedAt is recent enough, use it
      const cachedAt = data.cachedAt ? data.cachedAt.toMillis() : 0;
      const age = Date.now() - cachedAt;
      if (age < CACHE_TTL_MS) {
        eventCache[season] = data.events;
        return data.events;
      }
      // Stale cache — fall through to re-fetch
      console.log(`[cache] season ${season} cache is ${Math.round(age/1000/60)}m old, re-fetching`);
    }
  }

  // Fetch from Worker
  const result = await callWorker(`/events?season=${encodeURIComponent(season)}`);
  const events = result.events || [];

  // Store in memory
  eventCache[season] = events;

  // Persist to Firestore for offline reuse
  try {
    await db.collection('eventCache').doc('season_' + season).set({
      events: events,
      cachedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
  } catch (err) {
    // Non-critical — cache will re-fetch next time
    console.warn('Failed to cache events to Firestore:', err);
  }

  return events;
}

// ====== Filter events client-side by query ======
function filterEvents(events, query) {
  if (!query || !query.trim()) return events.slice(0, 50);
  const q = query.trim().toLowerCase();
  return events.filter(evt =>
    (evt.name && evt.name.toLowerCase().includes(q)) ||
    (evt.code && evt.code.toLowerCase().includes(q))
  );
}

// ====== Get teams for a specific event via Worker ======
async function getEventTeams(eventCode, season) {
  console.time('[Timing] Worker /teams call');
  try {
    const result = await callWorker(`/teams?eventCode=${encodeURIComponent(eventCode)}&season=${encodeURIComponent(season || getSelectedSeason())}`);
    console.timeEnd('[Timing] Worker /teams call');
    return result.teams || [];
  } catch (err) {
    console.timeEnd('[Timing] Worker /teams call');
    throw err;
  }
}

// ====== Get (and cache) an event's match schedule via Worker ======
// Cached on the same events/{eventCode} doc cacheEventToFirestore() writes
// name/date/ftcTeams to, as schedule/scheduleCachedAt — a merge-write, so it
// coexists with those fields rather than clobbering them. Same 1-hour TTL
// pattern as ensureEventsLoaded()'s season cache.
//
// An empty schedule (event's match list not published yet) is cached and
// returned the same as a populated one — callers treat "no matches yet" as
// a normal state, not an error, so there's no reason to skip caching it.
//
// IMPORTANT: firestore.rules' events/{eventCode} write rule requires
// request.resource.data.name to be a string on the RESULTING document — for
// a merge-write, that's the full document after the merge applies, not just
// this write's fields. If the doc doesn't exist yet at all, a merge-write
// containing only schedule/scheduleCachedAt has no `name` in the result and
// is denied (confirmed empirically against the real rules file via the
// Firestore emulator, not just reasoned about — see scripts/ history). In
// practice this event doc should already exist by the time schedule is ever
// fetched (selectEvent() always caches name+ftcTeams first), but the guard
// below makes that a safe no-op rather than a relied-upon assumption: if the
// doc isn't there yet, this just skips the Firestore write and returns the
// in-memory result uncached, instead of attempting a write that's certain
// to be denied.
async function getEventSchedule(eventCode, season) {
  console.time('[Timing] getEventSchedule');
  try {
    const eventRef = db.collection('events').doc(eventCode);
    const doc = await eventRef.get();

    if (doc.exists) {
      const data = doc.data();
      if (data.schedule !== undefined) {
        const cachedAt = data.scheduleCachedAt ? data.scheduleCachedAt.toMillis() : 0;
        const age = Date.now() - cachedAt;
        if (age < CACHE_TTL_MS) {
          console.log(`[schedule] cache hit for ${eventCode}: ${data.schedule.length} match(es), ${Math.round(age / 1000)}s old`);
          console.timeEnd('[Timing] getEventSchedule');
          return data.schedule;
        }
        console.log(`[schedule] cache for ${eventCode} is ${Math.round(age / 1000 / 60)}m old, re-fetching`);
      }
    }

    const result = await callWorker(`/schedule?eventCode=${encodeURIComponent(eventCode)}&season=${encodeURIComponent(season || getSelectedSeason())}`);
    const schedule = result.schedule || [];
    console.log(`[schedule] fetched ${schedule.length} match(es) for ${eventCode} from worker:`, schedule);

    if (doc.exists) {
      try {
        await eventRef.set({
          schedule,
          scheduleCachedAt: firebase.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
      } catch (err) {
        console.warn('Failed to cache schedule to Firestore:', err);
      }
    } else {
      console.warn(`[schedule] events/${eventCode} doc doesn't exist yet — skipping Firestore cache write (will retry next call)`);
    }

    console.timeEnd('[Timing] getEventSchedule');
    return schedule;
  } catch (err) {
    console.timeEnd('[Timing] getEventSchedule');
    throw err;
  }
}

// ====== Cache event data to Firestore ======
async function cacheEventToFirestore(eventData, ftcTeams) {
  if (!eventData || !eventData.code) return;

  console.time('[Timing] Firestore cache write (cacheEventToFirestore)');
  try {
    const eventRef = db.collection('events').doc(eventData.code);
    await eventRef.set({
      name: eventData.name,
      date: eventData.dateStart ? new Date(eventData.dateStart) : null,
      ftcTeams: ftcTeams.map(t => ({
        teamNumber: t.teamNumber,
        name: t.name || t.nameFull || t.nameShort || t.schoolName || t.teamNameCalc || '',
        nameShort: t.nameShort || '',
        nameFull: t.nameFull || '',
        schoolName: t.schoolName || '',
        city: t.city || '',
        stateProv: t.stateProv || '',
        country: t.country || '',
        opr: typeof t.opr === 'number' ? t.opr : null
      })),
      cachedAt: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    console.timeEnd('[Timing] Firestore cache write (cacheEventToFirestore)');
    return eventRef;
  } catch (err) {
    console.timeEnd('[Timing] Firestore cache write (cacheEventToFirestore)');
    throw err;
  }
}

// ====== Load cached event from Firestore ======
async function getCachedEvent(eventCode) {
  console.time('[Timing] Firestore cache read (getCachedEvent)');
  try {
    const doc = await db.collection('events').doc(eventCode).get();
    console.timeEnd('[Timing] Firestore cache read (getCachedEvent)');
    if (doc.exists) {
      const data = doc.data();
      // Normalize ftcTeams if stored as numbers or objects
      if (data.ftcTeams) {
        data.ftcTeams = data.ftcTeams.map(t => {
          if (typeof t === 'number') return { teamNumber: t, name: '', nameShort: '', nameFull: '', schoolName: '' };
          return {
            ...t,
            name: t.name || t.nameShort || t.nameFull || t.schoolName || ''
          };
        });
      }
      return { id: doc.id, ...data };
    }
    return null;
  } catch (err) {
    console.timeEnd('[Timing] Firestore cache read (getCachedEvent)');
    throw err;
  }
}

// ====== Render event list (full results area) ======
function renderEventList(events) {
  lastRenderedEventResults = events || [];

  const container = document.getElementById('event-results');
  container.innerHTML = '';

  if (!events || events.length === 0) {
    container.innerHTML = '<p class="help-text">No events found. Try a different search term.</p>';
    return;
  }

  events.forEach(evt => {
    const item = document.createElement('div');
    item.className = 'event-item';
    if (selectedEvent && selectedEvent.code === evt.code) {
      item.classList.add('selected');
    }
    item.dataset.code = evt.code;

    const nameEl = document.createElement('div');
    nameEl.className = 'event-name';
    nameEl.textContent = evt.name;

    const codeEl = document.createElement('div');
    codeEl.className = 'event-code';
    codeEl.textContent = `${evt.code}  •  ${evt.dateStart || 'Date TBD'}`;

    item.appendChild(nameEl);
    item.appendChild(codeEl);

    // Click to select; clicking the already-selected row again deselects it
    // — same toggle pattern as the Pinned Events list (pinned-events.js).
    item.addEventListener('click', () => {
      // A click landing while THIS SAME event is still mid-selectEvent() is
      // ignored rather than fed into the toggle below — selectedEvent is set
      // synchronously well before that load actually finishes, so without
      // this guard a re-click on a slow connection reads as "already
      // selected" and incorrectly deselects it instead of doing nothing.
      if (selectEventLoadingCode === evt.code) return;
      const isSelected = selectedEvent && selectedEvent.code === evt.code;
      if (isSelected) {
        deselectEventPreservingResults();
      } else {
        selectEvent(evt);
      }
    });

    container.appendChild(item);
  });
}

// ====== Render suggestions dropdown ======
function renderSuggestions(events) {
  const dropdown = document.getElementById('search-suggestions');

  if (!events || events.length === 0) {
    dropdown.classList.add('hidden');
    return;
  }

  dropdown.innerHTML = '';
  events.forEach(evt => {
    const item = document.createElement('div');
    item.className = 'suggestion-item';
    item.dataset.code = evt.code;

    const nameEl = document.createElement('div');
    nameEl.className = 'suggestion-name';
    nameEl.textContent = evt.name;

    const codeEl = document.createElement('div');
    codeEl.className = 'suggestion-code';
    codeEl.textContent = `${evt.code}  •  ${evt.dateStart || ''}`;

    item.appendChild(nameEl);
    item.appendChild(codeEl);

    // mousedown, not click: this dropdown is rebuilt from scratch
    // (dropdown.innerHTML = '' + recreate) every time the live-typing
    // debounce fires (updateSuggestionsForCurrentQuery(), ~150ms after the
    // user's last keystroke) — including while a click is physically in
    // progress. A browser only dispatches 'click' if the same element is
    // still there for both mousedown AND mouseup; if the debounce rebuilds
    // the list in between (confirmed via Playwright: mousedown on this item,
    // then a still-pending debounce fires before mouseup), the original node
    // is gone and the click is silently dropped — nothing happens, no error.
    // mousedown fires and finishes synchronously the instant the button goes
    // down, before that later timer ever gets a chance to run, so switching
    // to it closes the race entirely. preventDefault() keeps the input from
    // losing focus first (its own blur handler would otherwise race to hide
    // this same dropdown out from under this handler).
    item.addEventListener('mousedown', (e) => {
      e.preventDefault();

      // A re-click on the same suggestion while it's already mid-selectEvent()
      // is ignored — without this, clearSelectedEvent() would tear down the
      // in-flight selection's UI/listeners while that same selectEvent() call
      // is still running in the background and will still complete and
      // repopulate things moments later, leaving a confusing half-torn-down
      // state in between. See selectEventLoadingCode's own comment above.
      if (selectEventLoadingCode === evt.code) return;

      // Set BEFORE clearSelectedEvent()/selectEvent() — both trigger
      // synchronous saveSessionState() calls (directly, and via
      // selectEvent()'s own activateScoutingSubTab() side effect), which
      // would otherwise capture the box's pre-autocomplete raw typed text
      // instead of this event's resolved name.
      document.getElementById('input-event-search').value = evt.name;
      clearSelectedEvent();
      selectEvent(evt);
      hideSuggestions();
    });

    dropdown.appendChild(item);
  });

  dropdown.classList.remove('hidden');
}

function hideSuggestions() {
  document.getElementById('search-suggestions').classList.add('hidden');
}

// ====== Clear any previously selected event's info, team list, search results, and team detail ======
function clearSelectedEvent() {
  selectedEvent = null;
  // Reset detail selection too — otherwise a team number that also exists in the
  // next event's roster would still read as "selected" and show "Close Detail"
  // even though the detail panel was just hidden below.
  currentSelectedTeamNumber = null;
  // Otherwise a stale array here would get re-rendered into the Team Information
  // tab's list the next time the user switches to it (app.js re-renders from this
  // array on every tab switch), showing the previous event's teams after clearing.
  currentEventTeams = [];
  const area = document.getElementById('selected-event-area');
  if (area) area.classList.add('hidden');
  const nameEl = document.getElementById('selected-event-name');
  if (nameEl) nameEl.textContent = '';
  const codeEl = document.getElementById('selected-event-code');
  if (codeEl) codeEl.textContent = '';
  const countEl = document.getElementById('selected-event-teams-count');
  if (countEl) countEl.textContent = '';

  const teamListMatch = document.getElementById('team-list-match');
  if (teamListMatch) teamListMatch.innerHTML = '';
  const statusMatch = document.getElementById('team-list-status-match');
  if (statusMatch) statusMatch.textContent = 'Select an event above to load teams.';

  const teamListPit = document.getElementById('team-list-pit');
  if (teamListPit) teamListPit.innerHTML = '';
  const statusPit = document.getElementById('team-list-status-pit');
  if (statusPit) statusPit.textContent = 'Select an event above to load teams.';

  const eventResults = document.getElementById('event-results');
  if (eventResults) eventResults.innerHTML = '';
  lastRenderedEventResults = null;

  const teamListInfo = document.getElementById('team-list-info');
  if (teamListInfo) teamListInfo.innerHTML = '';
  const statusInfo = document.getElementById('team-list-status-info');
  if (statusInfo) statusInfo.textContent = 'Select an event above to load teams.';

  if (typeof closeTeamDetailModal === 'function') {
    closeTeamDetailModal();
  }

  const tdError = document.getElementById('td-error');
  if (tdError) tdError.textContent = '';

  // Remove .selected class from all event items
  document.querySelectorAll('.event-item').forEach(el => el.classList.remove('selected'));
  // Stop watching pit scouting status for the previous event
  if (typeof watchPitScoutStatus === 'function') {
    watchPitScoutStatus(null);
  }
  // Stop watching match scouting status for the previous event
  if (typeof watchMatchScoutStatus === 'function') {
    watchMatchScoutStatus(null);
  }
  // Hide the Team View/Match View toggle and clear the previous event's
  // schedule/expand state
  if (typeof resetMatchScheduleView === 'function') {
    resetMatchScheduleView();
  }

  if (typeof updatePinButtonUI === 'function') {
    updatePinButtonUI();
  }
  if (typeof renderPinnedEventsList === 'function') {
    renderPinnedEventsList();
  }

  // Reset the Scouting tabs' own UI state — search filter, sort mode, and
  // any active bulk-select mode/selections — so it never silently carries
  // into whatever event/season gets selected next. This was previously only
  // reset for event/team/scouted-status DATA (above); the UI state around it
  // (search boxes, sort dropdowns, "Select" mode) was left stale, most
  // noticeably across a season switch. currentEventTeams is already []
  // by this point, so applyTeamSortMode() below only syncs the dropdowns —
  // it doesn't attempt to re-render with stale data.
  currentTeamSearchQuery = '';
  ['input-team-search-info', 'input-team-search-pit', 'input-team-search-match'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  if (typeof applyTeamSortMode === 'function') {
    applyTeamSortMode('number');
  }
  if (typeof pitBulkSelectMode !== 'undefined') {
    pitBulkSelectMode = false;
    clearBulkSelection(pitBulkSelectedDocIds, pitBulkRangeState);
  }
  if (typeof matchBulkSelectMode !== 'undefined') {
    matchBulkSelectMode = false;
    clearBulkSelection(matchBulkSelectedTeamNumbers, matchBulkRangeState);
  }
  if (typeof infoBulkSelectMode !== 'undefined') {
    infoBulkSelectMode = false;
    clearBulkSelection(infoBulkSelectedTeamNumbers, infoBulkRangeState);
  }
  if (typeof updatePitBulkSelectUI === 'function') updatePitBulkSelectUI();
  if (typeof updateMatchTeamBulkSelectUI === 'function') updateMatchTeamBulkSelectUI();
  if (typeof updateInfoBulkSelectUI === 'function') updateInfoBulkSelectUI();
  // The Team Detail modal's/Matches Scouted modal's own per-panel bulk-select
  // and search state (match-scout.js) — already closed by
  // closeTeamDetailModal() above, but reset here too so a stale selection or
  // search term isn't sitting there the next time either modal opens for a
  // different team/event. resetAllMatchEntryBulkSelectStates() is the same
  // reset those modals' own close handlers call — reused here rather than
  // duplicating the mode/selectedIds clearing inline.
  if (typeof resetAllMatchEntryBulkSelectStates === 'function') {
    resetAllMatchEntryBulkSelectStates();
  }
  if (typeof matchEntrySearchQuery !== 'undefined') {
    Object.keys(matchEntrySearchQuery).forEach(prefix => {
      matchEntrySearchQuery[prefix] = '';
    });
  }

  if (typeof saveSessionState === 'function') {
    saveSessionState();
  }
}

// ====== Deselect the current event WITHOUT losing the search results list
// ======
// clearSelectedEvent() wipes #event-results — correct for its OTHER callers
// (a fresh search, a season change, selecting a different event via the
// dropdown/Pinned Events, ...) but wrong for a plain deselect: the user just
// wants to clear the selection, not lose the results they were looking at.
// Captures the last-rendered array BEFORE clearing (clearSelectedEvent()
// resets the tracking var to null itself) and re-renders it after, unless
// nothing was ever actually searched this session. Shared by both places a
// user can deselect without picking something else: a search result row
// clicked again, and the standalone "Deselect Event" button. ======
function deselectEventPreservingResults() {
  const resultsToRestore = lastRenderedEventResults;
  if (typeof clearSelectedEvent === 'function') clearSelectedEvent();
  if (resultsToRestore !== null && typeof renderEventList === 'function') {
    renderEventList(resultsToRestore);
  }
}

// ====== Set at the very start of selectEvent() below, cleared once its full
// async chain settles (success or failure) — lets a click landing on the
// SAME event while it's still loading be recognized as "already in
// progress" rather than misread as "this event is already fully selected,
// so toggle it off/reselect it", which is all the various click handlers
// below (this file's renderEventList()/renderSuggestions(), pinned-events.js's
// renderPinnedEventsList()) otherwise have to go on — they only see
// selectedEvent, which gets set synchronously at the top of selectEvent(),
// BEFORE any of its actual async work (team/schedule fetch) has finished.
// Confirmed via repeated Playwright reproduction: two clicks on the same
// row ~150ms apart (an entirely plausible "did that register?" re-click on
// a slow connection) reliably turned the second click into an unintended
// deselect, on every entry point (search results, Pinned Events), not just
// one of them. ======
let selectEventLoadingCode = null;

// ====== Select an event ======
async function selectEvent(eventData) {
  if (selectEventLoadingCode === eventData.code) return; // already loading this same event — ignore the extra click
  selectEventLoadingCode = eventData.code;

  console.time('[Timing] selectEvent total');
  selectedEvent = eventData;

  if (typeof saveSessionState === 'function') {
    saveSessionState();
  }

  // Highlight this event in the search results list (if rendered)
  document.querySelectorAll('.event-item').forEach(el => {
    el.classList.toggle('selected', el.dataset.code === eventData.code);
  });

  // Show selected event info
  document.getElementById('selected-event-name').textContent = eventData.name;
  document.getElementById('selected-event-code').textContent = `Code: ${eventData.code}`;
  document.getElementById('selected-event-teams-count').textContent = 'Loading teams...';
  document.getElementById('selected-event-area').classList.remove('hidden');

  if (typeof updatePinButtonUI === 'function') {
    updatePinButtonUI();
  }
  if (typeof renderPinnedEventsList === 'function') {
    renderPinnedEventsList();
  }

  showLoading(`Fetching teams for ${eventData.code}...`);
  try {
    // Try cache first
    let ftcTeams = null;
    const cached = await getCachedEvent(eventData.code);
    if (cached && cached.ftcTeams && cached.ftcTeams.length > 0 && cached.ftcTeams.some(t => t.name && t.name.trim() !== '')) {
      ftcTeams = cached.ftcTeams.map(t => typeof t === 'number' ? { teamNumber: t, name: '' } : t);
    } else {
      // Fetch from Worker (which calls FIRST API server-side)
      ftcTeams = await getEventTeams(eventData.code, getSelectedSeason());
      
      // Batch fetch team details from FTCScout GraphQL API using batched aliasing for ALL teams in the event concurrently
      if (ftcTeams && ftcTeams.length > 0 && typeof fetchTeamDetailsBatch === 'function') {
        const season = getSelectedSeason();
        const batchSize = 40;
        const chunks = [];
        
        for (let i = 0; i < ftcTeams.length; i += batchSize) {
          chunks.push({
            chunkTeamNums: ftcTeams.slice(i, i + batchSize).map(t => t.teamNumber),
            chunkTeams: ftcTeams.slice(i, i + batchSize),
            index: i / batchSize
          });
        }
        
        console.log(`[FTCScout Batch] Starting concurrent batched fetch for ${ftcTeams.length} teams across ${chunks.length} chunks (batch size ${batchSize})`);
        
        await Promise.all(chunks.map(async ({ chunkTeamNums, chunkTeams, index }) => {
          const timerLabel = `[FTCScout Batch] Chunk #${index} (${chunkTeamNums.length} teams)`;
          const batchWriteTimerLabel = `[Timing] Chunk #${index} batched Firestore write`;
          console.time(timerLabel);
          try {
        const batchResults = await fetchTeamDetailsBatch(chunkTeamNums, season);
        console.timeEnd(timerLabel);
        
        console.time(batchWriteTimerLabel);
        try {
          let batch = db.batch();
          let opCount = 0;
          
          for (let t of chunkTeams) {
            const detail = batchResults[t.teamNumber];
            if (!detail || detail.isError || !detail.name || detail.name.startsWith('Team #')) {
              continue;
            }
            t.name = detail.name;
            t.nameShort = detail.name;
            t.opr = detail.quickStats?.tot?.value ?? null;

            // Normalize raw GraphQL team detail into flat structure expected by renderTeamDetail & getCachedTeamDetail
            const loc = detail.location || {};
            const normalizedDetail = {
              teamNumber: t.teamNumber,
              name: detail.name || `Team #${t.teamNumber}`,
              city: loc.city || '',
              state: loc.state || '',
              country: loc.country || '',
              rookieYear: detail.rookieYear || null,
              website: detail.website || null,
              opr: detail.quickStats?.tot?.value || null,
              auto: detail.quickStats?.auto?.value || null,
              dc: detail.quickStats?.dc?.value || null,
              eg: detail.quickStats?.eg?.value || null,
              statsCount: detail.quickStats?.count || 0,
              awards: detail.awards || []
            };
            
            const docRef = db.collection('teamDetails').doc(String(t.teamNumber));
            batch.set(docRef, {
              ...normalizedDetail,
              cachedAt: firebase.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
                opCount++;
                
                // Firestore batch limit is 500 operations. Chunk size is 40, so this is well within limits.
                if (opCount >= 450) {
                  await batch.commit();
                  batch = db.batch();
                  opCount = 0;
                }
              }
              
              if (opCount > 0) {
                await batch.commit();
              }
            } catch (fsErr) {
              console.warn('[FTCScout Batch] Batched Firestore cache write failed:', fsErr);
            }
            console.timeEnd(batchWriteTimerLabel);
          } catch (batchErr) {
            console.timeEnd(timerLabel);
            console.error(`[FTCScout Batch] Batch fetch failed for chunk #${index}:`, batchErr);
          }
        }));
      }

      // Cache result with populated names
      await cacheEventToFirestore(eventData, ftcTeams);
    }

    hideLoading();
    // FIRST's API returns an identical empty list for "this event genuinely
    // has zero teams" and "this event's roster isn't finalized/announced
    // yet" (e.g. a future event) — there's no separate signal to tell those
    // apart, so rather than risk a confident-looking "0 teams registered"
    // being wrong, always caveat a zero result instead of asserting it.
    document.getElementById('selected-event-teams-count').textContent = ftcTeams.length > 0
      ? `${ftcTeams.length} team(s) registered`
      : '0 teams registered — the roster may not be finalized yet, or this event may genuinely have none';
    renderTeamList(ftcTeams);

    // Start watching pit scouting status for this event (live snapshot listener)
    if (typeof watchPitScoutStatus === 'function') {
      watchPitScoutStatus(eventData.code);
    }

    // Start watching match scouting status for this event
    if (typeof watchMatchScoutStatus === 'function') {
      watchMatchScoutStatus(eventData.code);
    }

    // Reveal the Match Scouting tab's Team View/Match View toggle and load
    // the match-based view's schedule data (currentEventTeams above is
    // already populated by renderTeamList(), which match-schedule-view.js's
    // name lookups depend on).
    if (typeof onMatchScheduleEventSelected === 'function') {
      onMatchScheduleEventSelected(eventData.code);
    }
    console.timeEnd('[Timing] selectEvent total');
  } catch (err) {
    hideLoading();
    console.timeEnd('[Timing] selectEvent total');
    console.error('Failed to fetch teams:', err);
    document.getElementById('selected-event-teams-count').textContent = 'Failed to load teams';
    showEventError('Could not load teams. Check your connection and try again.');
  } finally {
    if (selectEventLoadingCode === eventData.code) selectEventLoadingCode = null;
  }
}

// ====== Callback for scouted state changes (set by pit-scout.js) ======
let onScoutedStateChanged = null;

// ====== Render team lists for both match and pit scouting ======
function renderTeamList(teams) {
  console.time('[Timing] renderTeamList total');
  renderMatchTeamList(teams);
  renderPitTeamList(teams);
  if (typeof renderTeamInfoList === 'function') {
    renderTeamInfoList(teams);
  }
  console.timeEnd('[Timing] renderTeamList total');
}

// Shared selected team & search query across sub-tabs
let currentSelectedTeamNumber = null;
let currentEventTeams = [];
let currentTeamSearchQuery = '';
let currentTeamSortMode = 'number'; // 'number' | 'name' | 'opr' | 'scouted' — shared across Info/Pit/Match tabs
// 1 = each mode's own natural/default order (number low-high, name A-Z, opr
// high-low, scouted-first); -1 = that flipped. Deliberately a SEPARATE
// variable from currentTeamSortMode, with its own reset boundary
// (activateDashboardTab() in members.js, only on leaving the Scouting main
// tab) — NOT reset by applyTeamSortMode() or clearSelectedEvent()'s
// season/event-switch UI reset, unlike sort mode/search/bulk-select, which
// DO reset there. See toggleTeamSortDirection() below.
let currentTeamSortDirection = 1;

// Bulk-select state for the Pit tab (captain / canEditOtherEntries only — see updatePitBulkSelectUI)
let pitBulkSelectMode = false;
let pitBulkSelectedDocIds = new Set();
// Shift-click range-select support — order/checkboxEls are rebuilt on every
// render (see renderPitTeamList()), so they always reflect the CURRENT sort
// order; rangeState.lastClickedId is tracked by id rather than list
// position, so a resort between clicks can't leave it pointing at the wrong
// row. See handleBulkRangeClick() below.
let pitBulkOrder = [];
let pitBulkCheckboxEls = new Map();
let pitBulkRangeState = { lastClickedId: null };

// ====== Show/hide & label the pit bulk-select toolbar based on permission and selection ======
function updatePitBulkSelectUI() {
  const toggleBtn = document.getElementById('btn-pit-bulk-select-toggle');
  const deleteBtn = document.getElementById('btn-pit-bulk-delete');
  if (!toggleBtn || !deleteBtn) return;

  const canBulkManage = typeof canUserEditOtherEntries === 'function' ? canUserEditOtherEntries() : false;
  if (!canBulkManage) {
    toggleBtn.classList.add('hidden');
    deleteBtn.classList.add('hidden');
    const wasActive = pitBulkSelectMode;
    pitBulkSelectMode = false;
    clearBulkSelection(pitBulkSelectedDocIds, pitBulkRangeState);
    // Hiding the toolbar above doesn't remove the per-row checkboxes already
    // sitting in the DOM from the last render while mode was still active —
    // those are only ever added/omitted at render time based on
    // pitBulkSelectMode. Force a rebuild so a live permission revocation
    // actually collapses bulk-select mode, not just its toolbar chrome.
    // Guarded on wasActive so this doesn't re-render on every unrelated
    // team-doc change (e.g. another member's display name), only the
    // true -> false transition. renderPitTeamList() calls back into this
    // function at its own end, but by then wasActive is already false, so
    // it's one extra render, not a loop.
    if (wasActive && typeof currentEventTeams !== 'undefined' && currentEventTeams && currentEventTeams.length > 0 && typeof renderPitTeamList === 'function') {
      renderPitTeamList(currentEventTeams);
    }
    return;
  }

  toggleBtn.classList.remove('hidden');
  toggleBtn.textContent = pitBulkSelectMode ? 'Cancel Select' : 'Select';

  if (pitBulkSelectMode && pitBulkSelectedDocIds.size > 0) {
    deleteBtn.classList.remove('hidden');
    deleteBtn.textContent = `Delete Selected (${pitBulkSelectedDocIds.size})`;
  } else {
    deleteBtn.classList.add('hidden');
  }
}

// Bulk-select state for the Match tab (captain / canEditOtherEntries only —
// see updateMatchTeamBulkSelectUI). Selection is by TEAM NUMBER, not doc id
// — unlike pit (one entry per team), a team can have many match entries, so
// deleting a selected team means deleting ALL of its entries at once
// (gathered via getMatchEntriesForTeam() at delete time).
let matchBulkSelectMode = false;
let matchBulkSelectedTeamNumbers = new Set();
// Shift-click range-select support — see the matching pitBulkOrder/
// pitBulkCheckboxEls/pitBulkRangeState comment above and
// handleBulkRangeClick() below.
let matchBulkOrder = [];
let matchBulkCheckboxEls = new Map();
let matchBulkRangeState = { lastClickedId: null };

// ====== Show/hide & label the match bulk-select toolbar based on permission and selection ======
function updateMatchTeamBulkSelectUI() {
  const toggleBtn = document.getElementById('btn-match-bulk-select-toggle');
  const deleteBtn = document.getElementById('btn-match-bulk-delete');
  if (!toggleBtn || !deleteBtn) return;

  const canBulkManage = typeof canUserEditOtherEntries === 'function' ? canUserEditOtherEntries() : false;
  if (!canBulkManage) {
    toggleBtn.classList.add('hidden');
    deleteBtn.classList.add('hidden');
    const wasActive = matchBulkSelectMode;
    matchBulkSelectMode = false;
    clearBulkSelection(matchBulkSelectedTeamNumbers, matchBulkRangeState);
    // Same reasoning as updatePitBulkSelectUI() — the toolbar hides
    // immediately, but the per-row checkboxes already in the DOM need a
    // rebuild to actually disappear. Guarded on wasActive so this only
    // fires on the true -> false transition, not every team-doc change.
    if (wasActive && typeof currentEventTeams !== 'undefined' && currentEventTeams && currentEventTeams.length > 0 && typeof renderMatchTeamList === 'function') {
      renderMatchTeamList(currentEventTeams);
    }
    return;
  }

  toggleBtn.classList.remove('hidden');
  toggleBtn.textContent = matchBulkSelectMode ? 'Cancel Select' : 'Select';

  if (matchBulkSelectMode && matchBulkSelectedTeamNumbers.size > 0) {
    deleteBtn.classList.remove('hidden');
    deleteBtn.textContent = `Delete Selected (${matchBulkSelectedTeamNumbers.size})`;
  } else {
    deleteBtn.classList.add('hidden');
  }
}

// ====== Shared shift-click range-select handler for bulk-select checkboxes —
// used by all three tabs with bulk-select (Team Information, Pit Scouting,
// Match Scouting). By the time a checkbox's 'click' handler runs, the browser
// has already applied the native toggle, so checkbox.checked here already IS
// the row's new state — that's the state a shift-click range copies onto
// every other row between the anchor and this one.
//
// `order` and `checkboxEls` are rebuilt from scratch on every render (by the
// caller, right before this function can be invoked again), so they always
// reflect whatever sort mode/direction is CURRENTLY active — a shift-click
// range is always computed against the list as it looks right now, never
// against whatever order was active when the anchor was first clicked.
// `rangeState.lastClickedId` (an id, not an index) is what makes that safe:
// an index would go stale the instant the list is resorted, silently
// selecting the wrong rows; an id just gets looked up fresh in the current
// `order` each time, or ignored if that row isn't rendered any more (mode
// toggled off/on, team no longer has data, etc.).
//
// applyTeamSearchFilter() hides non-matching rows with inline display:none
// rather than re-rendering, so `order`/`checkboxEls` still contain them while
// a search is active — skip hidden rows when applying a range so a shift-
// click can't silently select teams the search has hidden from view.
//
// The anchor (rangeState.lastClickedId) only moves on a plain click — never
// on a shift-click — matching standard file-manager/Gmail range-select
// behavior, where a run of consecutive shift-clicks all extend/recompute the
// range from the SAME fixed anchor rather than walking it forward each time.
// This is a deliberate choice over a "moving anchor" alternative; worth
// revisiting later if it doesn't feel right in practice. A plain click
// always becomes the new anchor regardless of whether it checked or
// unchecked its own box — there's no separate "last selected" vs. "last
// deselected" concept, just "last plain-clicked". The one exception is when
// there's no anchor at all yet (e.g. the very first click in a session
// happens to be a shift-click) — that click has to become the anchor, or
// range selection could never start.
//
// A shift-click always SELECTS the full inclusive range, regardless of the
// anchor's own current checked state or of what the native toggle just did
// to the clicked box itself — it can never deselect, even when the anchor
// (or the clicked box) happens to be unchecked going in. The clicked box's
// own native toggle is therefore overridden back to checked here when
// necessary; only a plain click ever respects/reflects the native toggle.
//
// Selections made outside the current range (by a prior click/range) are
// never touched here, so range application is always additive with respect
// to the rest of the list — only the [start, end] span this call computes
// is written.
//
// The anchor also carries a visual marker (see the .bulk-anchor-checkbox
// CSS class) so the user can always see where their next shift-click will
// range from — set at render time for the current anchor (see e.g.
// renderPitTeamList()) and moved here whenever a plain click changes it. ======
function handleBulkRangeClick(e, id, order, checkboxEls, selectedIds, rangeState, updateUIFn) {
  const checkbox = checkboxEls.get(id);
  if (!checkbox) return;

  const hasAnchor = rangeState.lastClickedId != null && rangeState.lastClickedId !== id && checkboxEls.has(rangeState.lastClickedId);
  let rangeApplied = false;

  if (e.shiftKey && hasAnchor) {
    const fromIdx = order.indexOf(rangeState.lastClickedId);
    const toIdx = order.indexOf(id);
    if (fromIdx !== -1 && toIdx !== -1) {
      rangeApplied = true;
      const start = Math.min(fromIdx, toIdx);
      const end = Math.max(fromIdx, toIdx);
      for (let i = start; i <= end; i++) {
        const itemId = order[i];
        const cb = checkboxEls.get(itemId);
        if (!cb) continue;
        const row = typeof cb.closest === 'function' ? cb.closest('.team-item') : null;
        if (row && row.style.display === 'none') continue;
        cb.checked = true;
        selectedIds.add(itemId);
      }
    }
  }

  if (!rangeApplied) {
    // Plain click (or a shift-click with no usable anchor, which can't do a
    // range) — respect whatever the native toggle already did.
    if (checkbox.checked) selectedIds.add(id); else selectedIds.delete(id);
  }

  if (!e.shiftKey || rangeState.lastClickedId == null) {
    const previousAnchorId = rangeState.lastClickedId;
    if (previousAnchorId !== id) {
      const previousAnchorCb = previousAnchorId != null ? checkboxEls.get(previousAnchorId) : null;
      if (previousAnchorCb) previousAnchorCb.classList.remove('bulk-anchor-checkbox');
      checkbox.classList.add('bulk-anchor-checkbox');
    }
    rangeState.lastClickedId = id;
  }
  updateUIFn();
}

// ====== Mark a freshly-rendered checkbox as the current shift-click anchor,
// if it is one. checkboxEls/its DOM elements are rebuilt from scratch every
// render, so any class handleBulkRangeClick() set on a PREVIOUS render's
// checkbox is gone with it — this is what re-applies the marker after a
// resort/re-render/reopen, using rangeState.lastClickedId (which, unlike the
// DOM, persists across renders). ======
function markBulkAnchorCheckbox(checkbox, id, rangeState) {
  if (id === rangeState.lastClickedId) {
    checkbox.classList.add('bulk-anchor-checkbox');
  }
}

// ====== Clear a bulk-select tab/panel's checked state AND its shift-click
// anchor together. Every EXISTING place that clears a bulk-select Set
// (Cancel Select, a live permission revocation, a tab/sub-tab switch, an
// event switch, or a bulk-delete completing) calls this instead of clearing
// the Set directly, so the anchor is never left pointing at a stale/gone box
// after any of those resets — see resolveBulkAnchor() below for the other
// half: re-anchoring to the CURRENT first item next time the list actually
// renders with select mode on. ======
function clearBulkSelection(selectedIds, rangeState) {
  selectedIds.clear();
  rangeState.lastClickedId = null;
}

// ====== Re-anchor a bulk-select list to its current first item whenever the
// existing anchor is missing or no longer in the list — called once at the
// end of each render function, after order/checkboxEls have been rebuilt for
// this render. Two cases converge here: select mode was just entered for the
// first time ever (rangeState.lastClickedId was never set), or it was reset
// by clearBulkSelection() (Cancel Select, a modal close, a tab/event switch,
// a completed bulk delete) — either way, lastClickedId is null, and this
// picks the CURRENT order's first entry as the new anchor. That's what makes
// a team that scouting has just moved to the top of a re-sorted list become
// the anchor on the next "Select", instead of wherever the old anchor used
// to sit. A still-valid anchor (present in the current order) is left
// untouched — this only kicks in when there's genuinely nothing to keep.
// A completely empty list (order.length === 0) leaves no anchor at all,
// which is fine: nothing rendered to highlight, and the first plain click
// will set one normally. ======
function resolveBulkAnchor(order, checkboxEls, rangeState) {
  if (order.length === 0) return;
  if (rangeState.lastClickedId != null && checkboxEls.has(rangeState.lastClickedId)) return;
  rangeState.lastClickedId = order[0];
  const cb = checkboxEls.get(order[0]);
  if (cb) cb.classList.add('bulk-anchor-checkbox');
}

// ====== Force-exit ALL THREE tabs' bulk-select mode (Team Info/Pit/Match) —
// called on every tab change (sub-tab switch in app.js, main dashboard tab
// switch in members.js), not just a live permission revocation. Investigated
// first: unlike the permission-revocation case (each update*BulkSelectUI()'s
// own permission-denied branch), NOTHING previously reset bulk-select mode
// on a plain tab switch — switching sub-tabs away and back left mode/
// selections/the toggle button's label exactly as they were, still fully
// active, just visually hidden while that panel wasn't showing. This is a
// genuinely new reset point, not a fix to an existing one that only missed
// syncing its button label.
//
// Guarded so it's a no-op (no render, no toolbar touch) when nothing was
// actually active — this runs on every single tab switch, so it needs to
// stay cheap in the overwhelmingly common case where bulk-select was never
// on. ======
function exitAllBulkSelectModes() {
  let anyChanged = false;

  if (typeof pitBulkSelectMode !== 'undefined' && pitBulkSelectMode) {
    pitBulkSelectMode = false;
    clearBulkSelection(pitBulkSelectedDocIds, pitBulkRangeState);
    anyChanged = true;
  }
  if (typeof matchBulkSelectMode !== 'undefined' && matchBulkSelectMode) {
    matchBulkSelectMode = false;
    clearBulkSelection(matchBulkSelectedTeamNumbers, matchBulkRangeState);
    anyChanged = true;
  }
  if (typeof infoBulkSelectMode !== 'undefined' && infoBulkSelectMode) {
    infoBulkSelectMode = false;
    clearBulkSelection(infoBulkSelectedTeamNumbers, infoBulkRangeState);
    anyChanged = true;
  }

  if (!anyChanged) return;

  // Syncs each toggle button back to "Select" / hides the delete button —
  // the state above is already false by this point, so none of these three
  // will re-enter their own permission-denied re-render branch; this just
  // handles the toolbar chrome.
  if (typeof updatePitBulkSelectUI === 'function') updatePitBulkSelectUI();
  if (typeof updateMatchTeamBulkSelectUI === 'function') updateMatchTeamBulkSelectUI();
  if (typeof updateInfoBulkSelectUI === 'function') updateInfoBulkSelectUI();

  // Drops the now-stale checkboxes from the DOM — they're only ever added/
  // omitted at render time based on the mode variables above.
  if (typeof currentEventTeams !== 'undefined' && currentEventTeams && currentEventTeams.length > 0) {
    if (typeof renderPitTeamList === 'function') renderPitTeamList(currentEventTeams);
    if (typeof renderMatchTeamList === 'function') renderMatchTeamList(currentEventTeams);
    if (typeof renderTeamInfoList === 'function') renderTeamInfoList(currentEventTeams);
    if (typeof applyTeamSearchFilter === 'function' && typeof currentTeamSearchQuery !== 'undefined') {
      applyTeamSearchFilter(currentTeamSearchQuery);
    }
  }
}

// ====== Is a team "scouted" for sort purposes, per tab scope ======
// 'pit' checks only pit data (Pit Scouting tab), 'match' checks only match
// data (Match Scouting tab's Team View), 'combined' (Team Information tab)
// checks either. Mirrors the same per-tab data-type scoping used by the
// team-level delete buttons (team-info.js's createTeamScoutingDeleteButton).
function isTeamScoutedForSort(team, eventCode, scope) {
  if (!eventCode) return false;
  const pitDone = scope !== 'match' && typeof isTeamScouted === 'function' ? isTeamScouted(team.teamNumber, eventCode) : false;
  const matchDone = scope !== 'pit' && typeof getMatchEntriesForTeam === 'function' ? getMatchEntriesForTeam(team.teamNumber, eventCode).length > 0 : false;
  return pitDone || matchDone;
}

// ====== Sort a team list per the shared sort mode (number is the default,
// matching prior behavior). `scope` ('pit' | 'match' | 'combined') only
// matters for the 'scouted' mode, since scouted-status means something
// different per tab — see isTeamScoutedForSort(). ======
function sortTeams(teams, scope = 'combined') {
  const sorted = [...teams];
  // Applied to the WHOLE comparator result (primary key and its tiebreaker
  // together), so a flip is a true mirror of the natural order rather than
  // just reversing the primary key — see currentTeamSortDirection above.
  const dir = typeof currentTeamSortDirection !== 'undefined' ? currentTeamSortDirection : 1;
  if (currentTeamSortMode === 'name') {
    sorted.sort((a, b) => {
      const nameA = a.name || a.nameFull || a.nameShort || a.schoolName || a.teamNameCalc || '';
      const nameB = b.name || b.nameFull || b.nameShort || b.schoolName || b.teamNameCalc || '';
      return dir * (nameA.localeCompare(nameB) || (a.teamNumber || 0) - (b.teamNumber || 0));
    });
  } else if (currentTeamSortMode === 'opr') {
    sorted.sort((a, b) => {
      const oprA = typeof a.opr === 'number' ? a.opr : -Infinity;
      const oprB = typeof b.opr === 'number' ? b.opr : -Infinity;
      return dir * ((oprB - oprA) || (a.teamNumber || 0) - (b.teamNumber || 0));
    });
  } else if (currentTeamSortMode === 'scouted') {
    const eventCode = selectedEvent?.code;
    sorted.sort((a, b) => {
      const scoutedA = isTeamScoutedForSort(a, eventCode, scope) ? 1 : 0;
      const scoutedB = isTeamScoutedForSort(b, eventCode, scope) ? 1 : 0;
      return dir * ((scoutedB - scoutedA) || (a.teamNumber || 0) - (b.teamNumber || 0));
    });
  } else {
    sorted.sort((a, b) => dir * ((a.teamNumber || 0) - (b.teamNumber || 0)));
  }
  return sorted;
}

// ====== Sync both sort selects & re-render both team lists when sort mode changes ======
function applyTeamSortMode(mode) {
  currentTeamSortMode = mode || 'number';

  const matchSelect = document.getElementById('select-team-sort-match');
  const pitSelect = document.getElementById('select-team-sort-pit');
  const infoSelect = document.getElementById('select-team-sort-info');
  if (matchSelect && matchSelect.value !== currentTeamSortMode) matchSelect.value = currentTeamSortMode;
  if (pitSelect && pitSelect.value !== currentTeamSortMode) pitSelect.value = currentTeamSortMode;
  if (infoSelect && infoSelect.value !== currentTeamSortMode) infoSelect.value = currentTeamSortMode;

  if (currentEventTeams && currentEventTeams.length > 0) {
    renderMatchTeamList(currentEventTeams);
    renderPitTeamList(currentEventTeams);
    if (typeof renderTeamInfoList === 'function') {
      renderTeamInfoList(currentEventTeams);
    }
    applyTeamSearchFilter(currentTeamSearchQuery);
  }
}

// ====== Sync all three sort-direction buttons' icon/title to the current
// currentTeamSortDirection — called after every toggle, reset, or restore so
// they never show a stale arrow relative to the actual applied order. ======
function updateSortDirectionButtons() {
  const flipped = currentTeamSortDirection === -1;
  ['info', 'pit', 'match'].forEach(scope => {
    const btn = document.getElementById(`btn-team-sort-direction-${scope}`);
    if (!btn) return;
    btn.textContent = flipped ? '↓' : '↑';
    btn.title = flipped ? 'Sort direction reversed — click to restore default' : 'Default sort direction — click to reverse';
    btn.classList.toggle('sort-direction-flipped', flipped);
  });
}

// ====== Flip currentTeamSortDirection and re-render — shared by all three
// tabs' direction buttons (Team Info/Pit/Match Team View only; NOT Match
// View's search bar, which is a search, not a sort). Persists across a sort
// MODE switch and a Scouting sub-tab switch for free, since it's a separate
// variable from currentTeamSortMode that neither applyTeamSortMode() nor
// activateSubTab() (app.js) ever touches. Explicitly saves session state
// here (unlike mode/search/bulk-select changes, which only get saved as a
// side effect of a later tab switch) since toggling direction alone,
// without switching anything else, still needs to survive a refresh. ======
function toggleTeamSortDirection() {
  currentTeamSortDirection = currentTeamSortDirection === 1 ? -1 : 1;
  updateSortDirectionButtons();
  if (currentEventTeams && currentEventTeams.length > 0) {
    renderMatchTeamList(currentEventTeams);
    renderPitTeamList(currentEventTeams);
    if (typeof renderTeamInfoList === 'function') {
      renderTeamInfoList(currentEventTeams);
    }
    applyTeamSearchFilter(currentTeamSearchQuery);
  }
  if (typeof saveSessionState === 'function') {
    saveSessionState();
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const matchSortSelect = document.getElementById('select-team-sort-match');
  if (matchSortSelect) {
    matchSortSelect.addEventListener('change', (e) => applyTeamSortMode(e.target.value));
  }
  const pitSortSelect = document.getElementById('select-team-sort-pit');
  if (pitSortSelect) {
    pitSortSelect.addEventListener('change', (e) => applyTeamSortMode(e.target.value));
  }
  const infoSortSelect = document.getElementById('select-team-sort-info');
  if (infoSortSelect) {
    infoSortSelect.addEventListener('change', (e) => applyTeamSortMode(e.target.value));
  }

  ['info', 'pit', 'match'].forEach(scope => {
    const btn = document.getElementById(`btn-team-sort-direction-${scope}`);
    if (btn) btn.addEventListener('click', () => toggleTeamSortDirection());
  });
  updateSortDirectionButtons();

  // Pit bulk-select toggle
  const pitBulkToggleBtn = document.getElementById('btn-pit-bulk-select-toggle');
  if (pitBulkToggleBtn) {
    pitBulkToggleBtn.addEventListener('click', () => {
      pitBulkSelectMode = !pitBulkSelectMode;
      clearBulkSelection(pitBulkSelectedDocIds, pitBulkRangeState);
      if (currentEventTeams && currentEventTeams.length > 0) {
        renderPitTeamList(currentEventTeams);
        applyTeamSearchFilter(currentTeamSearchQuery);
      } else {
        updatePitBulkSelectUI();
      }
    });
  }

  // Pit bulk delete
  const pitBulkDeleteBtn = document.getElementById('btn-pit-bulk-delete');
  if (pitBulkDeleteBtn) {
    pitBulkDeleteBtn.addEventListener('click', () => {
      const docIds = [...pitBulkSelectedDocIds];
      if (docIds.length === 0 || typeof showConfirmModal !== 'function') return;

      showConfirmModal({
        title: 'Delete Pit Scouting Data?',
        message: `Delete pit scouting data for ${docIds.length} team(s)? This cannot be undone.`,
        confirmLabel: 'Delete',
        danger: true,
        onConfirm: async () => {
          showLoading('Deleting selected entries...');
          let results = { succeeded: [], failed: [] };
          try {
            if (typeof bulkDeletePitScoutData === 'function') {
              results = await bulkDeletePitScoutData(docIds);
            }
          } finally {
            hideLoading();
          }

          const statusEl = document.getElementById('pit-bulk-delete-status');
          if (statusEl) {
            if (results.failed.length > 0) {
              console.error('Bulk pit delete: failed doc IDs:', results.failed);
              statusEl.textContent = `Deleted ${results.succeeded.length} of ${docIds.length} entries — ${results.failed.length} failed`;
              statusEl.className = 'error-message';
            } else {
              statusEl.textContent = `Deleted ${results.succeeded.length} entr${results.succeeded.length === 1 ? 'y' : 'ies'}.`;
              statusEl.className = 'success-message';
            }
            setTimeout(() => { statusEl.textContent = ''; statusEl.className = ''; }, 5000);
          }

          pitBulkSelectMode = false;
          clearBulkSelection(pitBulkSelectedDocIds, pitBulkRangeState);
          if (currentEventTeams && currentEventTeams.length > 0) {
            renderPitTeamList(currentEventTeams);
            applyTeamSearchFilter(currentTeamSearchQuery);
          }
        }
      });
    });
  }

  // Match bulk-select toggle
  const matchBulkToggleBtn = document.getElementById('btn-match-bulk-select-toggle');
  if (matchBulkToggleBtn) {
    matchBulkToggleBtn.addEventListener('click', () => {
      matchBulkSelectMode = !matchBulkSelectMode;
      clearBulkSelection(matchBulkSelectedTeamNumbers, matchBulkRangeState);
      if (currentEventTeams && currentEventTeams.length > 0) {
        renderMatchTeamList(currentEventTeams);
        applyTeamSearchFilter(currentTeamSearchQuery);
      } else {
        updateMatchTeamBulkSelectUI();
      }
    });
  }

  // Match bulk delete — deletes ALL match entries for every selected team
  // (not one doc per team, since match has many entries per team).
  const matchBulkDeleteBtn = document.getElementById('btn-match-bulk-delete');
  if (matchBulkDeleteBtn) {
    matchBulkDeleteBtn.addEventListener('click', () => {
      const teamNumbers = [...matchBulkSelectedTeamNumbers];
      if (teamNumbers.length === 0) return;

      const eventCode = selectedEvent?.code;
      const allEntryIds = (eventCode && typeof getMatchEntriesForTeam === 'function')
        ? teamNumbers.flatMap(tn => getMatchEntriesForTeam(tn, eventCode).map(e => e.id))
        : [];
      if (allEntryIds.length === 0 || typeof showConfirmModal !== 'function') return;

      showConfirmModal({
        title: 'Delete Match Scouting Data?',
        message: `Delete ALL match scouting entries for ${teamNumbers.length} team(s)? This will remove ${allEntryIds.length} total entr${allEntryIds.length === 1 ? 'y' : 'ies'}. This cannot be undone.`,
        confirmLabel: 'Delete',
        danger: true,
        onConfirm: async () => {
          showLoading('Deleting selected entries...');
          let results = { succeeded: [], failed: [] };
          try {
            if (typeof bulkDeleteMatchScoutData === 'function') {
              results = await bulkDeleteMatchScoutData(allEntryIds);
            }
          } finally {
            hideLoading();
          }

          const statusEl = document.getElementById('match-bulk-delete-status');
          if (statusEl) {
            if (results.failed.length > 0) {
              console.error('Bulk match delete: failed doc IDs:', results.failed);
              statusEl.textContent = `Deleted ${results.succeeded.length} of ${allEntryIds.length} entries — ${results.failed.length} failed`;
              statusEl.className = 'error-message';
            } else {
              statusEl.textContent = `Deleted ${results.succeeded.length} entr${results.succeeded.length === 1 ? 'y' : 'ies'}.`;
              statusEl.className = 'success-message';
            }
            setTimeout(() => { statusEl.textContent = ''; statusEl.className = ''; }, 5000);
          }

          matchBulkSelectMode = false;
          clearBulkSelection(matchBulkSelectedTeamNumbers, matchBulkRangeState);
          if (currentEventTeams && currentEventTeams.length > 0) {
            renderMatchTeamList(currentEventTeams);
            applyTeamSearchFilter(currentTeamSearchQuery);
          }
          if (typeof refreshMatchTeamListCounts === 'function') {
            refreshMatchTeamListCounts();
          }
        }
      });
    });
  }
});

// ====== In-list team filtering & sync (Match & Pit) ======
function applyTeamSearchFilter(query) {
  currentTeamSearchQuery = query || '';
  const q = currentTeamSearchQuery.trim().toLowerCase();

  // Update all input values if they differ
  const matchInput = document.getElementById('input-team-search-match');
  const pitInput = document.getElementById('input-team-search-pit');
  const infoInput = document.getElementById('input-team-search-info');
  if (matchInput && matchInput.value !== currentTeamSearchQuery) {
    matchInput.value = currentTeamSearchQuery;
  }
  if (pitInput && pitInput.value !== currentTeamSearchQuery) {
    pitInput.value = currentTeamSearchQuery;
  }
  if (infoInput && infoInput.value !== currentTeamSearchQuery) {
    infoInput.value = currentTeamSearchQuery;
  }

  // Filter match team items
  const matchContainer = document.getElementById('team-list-match');
  if (matchContainer) {
    matchContainer.querySelectorAll('.team-item').forEach(item => {
      const text = item.textContent.toLowerCase();
      item.style.display = (!q || text.includes(q)) ? '' : 'none';
    });
  }

  // Filter pit team items
  const pitContainer = document.getElementById('team-list-pit');
  if (pitContainer) {
    pitContainer.querySelectorAll('.team-item').forEach(item => {
      const text = item.textContent.toLowerCase();
      item.style.display = (!q || text.includes(q)) ? '' : 'none';
    });
  }

  // Filter info team items
  const infoContainer = document.getElementById('team-list-info');
  if (infoContainer) {
    infoContainer.querySelectorAll('.team-item').forEach(item => {
      const text = item.textContent.toLowerCase();
      item.style.display = (!q || text.includes(q)) ? '' : 'none';
    });
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const matchSearchInput = document.getElementById('input-team-search-match');
  if (matchSearchInput) {
    matchSearchInput.addEventListener('input', (e) => {
      applyTeamSearchFilter(e.target.value);
    });
  }

  const pitSearchInput = document.getElementById('input-team-search-pit');
  if (pitSearchInput) {
    pitSearchInput.addEventListener('input', (e) => {
      applyTeamSearchFilter(e.target.value);
    });
  }

  const infoSearchInput = document.getElementById('input-team-search-info');
  if (infoSearchInput) {
    infoSearchInput.addEventListener('input', (e) => {
      applyTeamSearchFilter(e.target.value);
    });
  }

  // Also hook into scouting subtab buttons to re-apply filter on tab switch without resetting
  const subtabButtons = document.querySelectorAll('#scouting-subtabs .tab');
  subtabButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      // Small timeout to let DOM active class update first
      setTimeout(() => {
        applyTeamSearchFilter(currentTeamSearchQuery);
      }, 10);
    });
  });
});

function renderMatchTeamList(teams) {
  console.time('[Timing] renderMatchTeamList');
  const container = document.getElementById('team-list-match');
  const status = document.getElementById('team-list-status-match');
  if (!container || !status) {
    console.timeEnd('[Timing] renderMatchTeamList');
    return;
  }
  container.innerHTML = '';

  if (!teams || teams.length === 0) {
    status.textContent = 'No teams found for this event.';
    console.timeEnd('[Timing] renderMatchTeamList');
    return;
  }

  currentEventTeams = teams;
  status.textContent = `${teams.length} team(s)`;
  const sorted = sortTeams(teams, 'match');

  // Rebuilt every render so shift-click range-select always reflects the
  // CURRENT sort order/direction — see handleBulkRangeClick().
  matchBulkOrder = [];
  matchBulkCheckboxEls = new Map();

  sorted.forEach(team => {
    const item = document.createElement('div');
    item.className = 'team-item';
    item.dataset.teamNumber = team.teamNumber;

    const leftGroup = document.createElement('div');
    leftGroup.style.cssText = 'display:flex; align-items:center; gap:8px; flex:1; min-width:0;';

    const numSpan = document.createElement('span');
    numSpan.className = 'team-number';
    numSpan.textContent = `#${team.teamNumber}`;

    const nameSpan = document.createElement('span');
    nameSpan.className = 'team-name';
    nameSpan.textContent = team.name || team.nameFull || team.nameShort || team.schoolName || team.teamNameCalc || '';

    const oprSpan = document.createElement('span');
    oprSpan.className = 'team-opr-inline';
    oprSpan.textContent = typeof team.opr === 'number' ? `OPR: ${team.opr.toFixed(1)}` : 'OPR: --';

    leftGroup.appendChild(numSpan);
    leftGroup.appendChild(nameSpan);
    leftGroup.appendChild(oprSpan);

    const btnGroup = document.createElement('div');
    btnGroup.className = 'team-item-actions';
    btnGroup.style.cssText = 'display:flex; align-items:center; gap:6px; flex-shrink:0; flex-wrap:wrap; justify-content:flex-end;';

    // Team-level Delete — appended FIRST so it renders on the left side of
    // the button group, before the other buttons (see
    // refreshTeamRowDeleteButtons() in team-info.js, which relies on this
    // same "insert as first child" placement for its own incremental
    // add/remove). 'match' scope: this tab only ever deletes this team's
    // match entries, never its pit data.
    const teamDeleteBtnMatch = typeof createTeamScoutingDeleteButton === 'function'
      ? createTeamScoutingDeleteButton(team, selectedEvent?.code || '', 'match')
      : null;
    if (teamDeleteBtnMatch) btnGroup.appendChild(teamDeleteBtnMatch);

    // Match scout quick button (+ Match Scout)
    const scoutBtn = document.createElement('button');
    scoutBtn.className = 'btn btn-small btn-primary';
    scoutBtn.style.cssText = 'width: auto; padding: 4px 10px; font-size: 0.8rem;';
    scoutBtn.textContent = '+ Match Scout';
    scoutBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (selectedEvent?.code && typeof openMatchScoutForm === 'function') {
        openMatchScoutForm(team.teamNumber, selectedEvent.code);
      }
    });

    btnGroup.appendChild(scoutBtn);

    // Match entry count badge — hidden (via .hidden) when 0, filled in by
    // refreshMatchTeamListCounts() below (initial render) and on every live
    // update thereafter. Separate element rather than folded into the
    // button's own text so the count reads as its own distinct signal.
    const matchCountBadge = document.createElement('span');
    matchCountBadge.className = 'match-count-badge hidden';
    matchCountBadge.textContent = '0';
    btnGroup.appendChild(matchCountBadge);

    // View Matches Scouted button — opens a popup showing just this team's
    // logged match entries (match-scouted-modal.js), reusing the same panel
    // as the Team Information tab's Team Detail popup.
    const viewScoutedBtn = document.createElement('button');
    // btn-view-matches-scouted is a style-neutral hook (no CSS rule targets it) —
    // it just gives refreshMatchTeamListCounts() a stable selector to find this
    // exact button, same reasoning as pit's btn-pit-quick-scout hook.
    viewScoutedBtn.className = 'btn btn-small btn-outline btn-view-matches-scouted';
    viewScoutedBtn.style.cssText = 'width: auto; padding: 4px 8px; font-size: 0.8rem;';
    viewScoutedBtn.textContent = 'View Matches Scouted';
    viewScoutedBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (selectedEvent?.code && typeof openMatchScoutedModal === 'function') {
        openMatchScoutedModal(team.teamNumber, selectedEvent.code, team);
      }
    });

    btnGroup.appendChild(viewScoutedBtn);

    // Bulk-select checkbox — only in select mode, and only for teams that
    // have at least one match entry (nothing to delete otherwise). Keyed by
    // team number, not doc id — see matchBulkSelectedTeamNumbers comment.
    const teamHasMatchEntries = (selectedEvent?.code && typeof getMatchEntriesForTeam === 'function')
      ? getMatchEntriesForTeam(team.teamNumber, selectedEvent.code).length > 0
      : false;
    if (matchBulkSelectMode && teamHasMatchEntries) {
      const teamKey = String(team.teamNumber);
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.style.cssText = 'width:18px; height:18px; flex-shrink:0; cursor:pointer;';
      checkbox.checked = matchBulkSelectedTeamNumbers.has(teamKey);
      matchBulkOrder.push(teamKey);
      matchBulkCheckboxEls.set(teamKey, checkbox);
      markBulkAnchorCheckbox(checkbox, teamKey, matchBulkRangeState);
      // 'click' (not 'change') so shiftKey is available — see handleBulkRangeClick().
      checkbox.addEventListener('click', (e) => {
        e.stopPropagation();
        handleBulkRangeClick(e, teamKey, matchBulkOrder, matchBulkCheckboxEls, matchBulkSelectedTeamNumbers, matchBulkRangeState, updateMatchTeamBulkSelectUI);
      });
      leftGroup.insertBefore(checkbox, leftGroup.firstChild);
    }

    item.appendChild(leftGroup);
    item.appendChild(btnGroup);
    container.appendChild(item);
  });

  if (typeof refreshMatchTeamListCounts === 'function') {
    refreshMatchTeamListCounts();
  }
  resolveBulkAnchor(matchBulkOrder, matchBulkCheckboxEls, matchBulkRangeState);
  updateMatchTeamBulkSelectUI();
  console.timeEnd('[Timing] renderMatchTeamList');
}

// ====== Show/update/remove the "Scouted by / Last edited by" line on a pit
// team-list row — called on initial render and again (via
// refreshTeamListScoutedState) right after a save/delete, so it reflects the
// new state immediately rather than waiting for the next full re-render. ======
function updatePitTeamRowMetaLine(item, teamNumber, eventCode) {
  let metaLine = item.querySelector('.pit-row-meta');
  const isScouted = typeof isTeamScouted === 'function' ? isTeamScouted(teamNumber, eventCode) : false;
  const entry = (isScouted && typeof getPitScoutedEntry === 'function') ? getPitScoutedEntry(teamNumber, eventCode) : null;

  if (!entry) {
    if (metaLine) metaLine.remove();
    return;
  }

  if (!metaLine) {
    metaLine = document.createElement('div');
    metaLine.className = 'pit-row-meta';
    metaLine.style.cssText = 'font-size:0.75rem; color:var(--text-muted);';
    item.appendChild(metaLine);
  }

  const scoutedBy = entry.scoutedByName || entry.scoutedByEmail || 'Unknown';
  const lastEditedBy = entry.lastEditedByName || entry.lastEditedByEmail || 'N/A';
  metaLine.textContent = `Scouted by: ${scoutedBy} | Last edited by: ${lastEditedBy}`;
}

function renderPitTeamList(teams) {
  console.time('[Timing] renderPitTeamList');
  const container = document.getElementById('team-list-pit');
  const status = document.getElementById('team-list-status-pit');
  if (!container || !status) {
    console.timeEnd('[Timing] renderPitTeamList');
    return;
  }
  container.innerHTML = '';

  if (!teams || teams.length === 0) {
    status.textContent = 'No teams found for this event.';
    console.timeEnd('[Timing] renderPitTeamList');
    return;
  }

  status.textContent = `${teams.length} team(s)`;
  const sorted = sortTeams(teams, 'pit');

  // Rebuilt every render so shift-click range-select always reflects the
  // CURRENT sort order/direction — see handleBulkRangeClick().
  pitBulkOrder = [];
  pitBulkCheckboxEls = new Map();

  sorted.forEach(team => {
    const item = document.createElement('div');
    item.className = 'team-item team-item-pit';
    item.dataset.teamNumber = team.teamNumber;
    // Overrides the shared .team-item row layout so a second, full-width line
    // (Scouted by / Last edited by) can stack below the number/name/buttons
    // row for teams that have been pit scouted.
    item.style.cssText = 'display:flex; flex-direction:column; align-items:stretch; gap:4px;';

    const topRow = document.createElement('div');
    topRow.style.cssText = 'display:flex; align-items:center; justify-content:space-between; gap:8px;';

    const leftGroup = document.createElement('div');
    leftGroup.style.cssText = 'display:flex; align-items:center; gap:8px; flex:1; min-width:0;';

    const numSpan = document.createElement('span');
    numSpan.className = 'team-number';
    numSpan.textContent = `#${team.teamNumber}`;

    const nameSpan = document.createElement('span');
    nameSpan.className = 'team-name';
    nameSpan.textContent = team.name || team.nameFull || team.nameShort || team.schoolName || team.teamNameCalc || '';

    const oprSpan = document.createElement('span');
    oprSpan.className = 'team-opr-inline';
    oprSpan.textContent = typeof team.opr === 'number' ? `OPR: ${team.opr.toFixed(1)}` : 'OPR: --';

    leftGroup.appendChild(numSpan);
    leftGroup.appendChild(nameSpan);
    leftGroup.appendChild(oprSpan);

    const btnGroup = document.createElement('div');
    btnGroup.className = 'team-item-actions';
    btnGroup.style.cssText = 'display:flex; align-items:center; gap:6px; flex-shrink:0; flex-wrap:wrap; justify-content:flex-end;';

    // Team-level Delete — appended FIRST so it renders on the left side of
    // the button group, before the other buttons (see
    // refreshTeamRowDeleteButtons() in team-info.js). 'pit' scope: this tab
    // only ever deletes this team's pit entry, never its match data.
    const teamDeleteBtnPit = typeof createTeamScoutingDeleteButton === 'function'
      ? createTeamScoutingDeleteButton(team, selectedEvent?.code || '', 'pit')
      : null;
    if (teamDeleteBtnPit) btnGroup.appendChild(teamDeleteBtnPit);

    const scoutBtn = document.createElement('button');
    // btn-pit-quick-scout is a style-neutral hook (no CSS rule targets it) — it just
    // gives refreshTeamListScoutedState() a stable selector to find this exact button,
    // since its actual style classes never change and can't be used to identify it.
    scoutBtn.className = 'btn btn-small btn-primary btn-pit-quick-scout';
    scoutBtn.style.cssText = 'width: auto; padding: 4px 10px; font-size: 0.8rem; display: inline-flex; align-items: center; gap: 4px;';

    const isScouted = typeof isTeamScouted === 'function' ? isTeamScouted(team.teamNumber, selectedEvent?.code) : false;
    if (isScouted) {
      scoutBtn.style.background = 'var(--success)';
      const checkSpan = document.createElement('span');
      checkSpan.textContent = '✓';
      const textSpan = document.createElement('span');
      textSpan.textContent = 'Edit Pit Scout';
      scoutBtn.appendChild(checkSpan);
      scoutBtn.appendChild(textSpan);
    } else {
      scoutBtn.textContent = '+ Pit Scout';
    }

    scoutBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (selectedEvent?.code && typeof openPitScoutForm === 'function') {
        openPitScoutForm(team.teamNumber, selectedEvent.code);
      }
    });

    // Bulk-select checkbox — only in select mode, and only for teams that have
    // been pit scouted (nothing to delete otherwise). Toggle visibility is already
    // permission-gated (see updatePitBulkSelectUI), so anyone who can see the mode
    // at all is allowed to bulk-delete any scouted entry.
    // Use the cached entry's real doc id rather than reconstructing one —
    // pitScoutedEntriesCache is keyed by data (eventCode_teamNumber) but
    // each entry's own .id is whatever Firestore actually assigned it,
    // which may be an old- or new-format ID (see pit-scout.js).
    const pitEntryForBulkSelect = (isScouted && selectedEvent?.code && typeof getPitScoutedEntry === 'function')
      ? getPitScoutedEntry(team.teamNumber, selectedEvent.code)
      : null;
    if (pitBulkSelectMode && pitEntryForBulkSelect?.id) {
      const docId = pitEntryForBulkSelect.id;
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.style.cssText = 'width:18px; height:18px; flex-shrink:0; cursor:pointer;';
      checkbox.checked = pitBulkSelectedDocIds.has(docId);
      pitBulkOrder.push(docId);
      pitBulkCheckboxEls.set(docId, checkbox);
      markBulkAnchorCheckbox(checkbox, docId, pitBulkRangeState);
      // 'click' (not 'change') so shiftKey is available — see handleBulkRangeClick().
      checkbox.addEventListener('click', (e) => {
        e.stopPropagation();
        handleBulkRangeClick(e, docId, pitBulkOrder, pitBulkCheckboxEls, pitBulkSelectedDocIds, pitBulkRangeState, updatePitBulkSelectUI);
      });
      leftGroup.insertBefore(checkbox, leftGroup.firstChild);
    }

    btnGroup.appendChild(scoutBtn);

    // Export this team's single pit entry — no "view" modal (unlike Match
    // Scouting's "View Matches Scouted"), since pit scouting is one entry per
    // team, not a list; the existing scoutBtn above already shows/edits it.
    // Opens the shared export-choice modal directly via
    // openTeamPitExportChoice() (sheets-export.js), reusing the same
    // single-team pit-only gather/export functions "Export All Pit Data"
    // uses — always shown (not conditional on scouted status), consistent
    // with how export buttons elsewhere just report "nothing found" rather
    // than disappearing.
    const exportBtn = document.createElement('button');
    exportBtn.className = 'btn btn-small btn-outline';
    exportBtn.style.cssText = 'width: auto; padding: 4px 8px; font-size: 0.8rem;';
    exportBtn.textContent = '📤';
    exportBtn.title = 'Export Pit Data';
    exportBtn.setAttribute('aria-label', 'Export Pit Data');
    exportBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (selectedEvent?.code && currentTeamData?.id && typeof openTeamPitExportChoice === 'function') {
        openTeamPitExportChoice(team.teamNumber, selectedEvent.code, currentTeamData.id, 'event-export-pit');
      }
    });

    btnGroup.appendChild(exportBtn);

    topRow.appendChild(leftGroup);
    topRow.appendChild(btnGroup);
    item.appendChild(topRow);

    updatePitTeamRowMetaLine(item, team.teamNumber, selectedEvent?.code);

    container.appendChild(item);
  });

  if (typeof refreshTeamListScoutedState === 'function') {
    refreshTeamListScoutedState();
  }
  resolveBulkAnchor(pitBulkOrder, pitBulkCheckboxEls, pitBulkRangeState);
  updatePitBulkSelectUI();
  console.timeEnd('[Timing] renderPitTeamList');
}

// ====== Handle search button click ======
async function doSearch() {
  if (isSearching) return;
  clearErrors();
  hideSuggestions();
  const query = document.getElementById('input-event-search').value.trim();

  // Empty search: clear everything and return
  if (!query) {
    clearSelectedEvent();
    return;
  }

  // Clear any previously selected event before showing new results
  clearSelectedEvent();
  const season = getSelectedSeason();

  isSearching = true;
  showLoading('Searching events...');
  try {
    // This loads the full list if not already cached, then filters
    const allEvents = await ensureEventsLoaded(season);
    const filtered = filterEvents(allEvents, query);
    hideLoading();
    renderEventList(filtered);
  } catch (err) {
    hideLoading();
    console.error('Event search error:', err);
    showEventError('Failed to search events. Check your connection and try again.');
  } finally {
    isSearching = false;
  }
}

// ====== Event Search Button ======
document.getElementById('btn-search-events').addEventListener('click', doSearch);

// ====== Deselect Event Button (normal-search flow's counterpart to the Pinned Events tab's Deselect button) ======
const btnDeselectEvent = document.getElementById('btn-deselect-event');
if (btnDeselectEvent) {
  btnDeselectEvent.addEventListener('click', () => {
    deselectEventPreservingResults();
  });
}

// ====== Compute and render suggestions for whatever's currently in the
// search box (client-side, no API calls) — shared by the debounced `input`
// listener below and the immediate `focus` listener, so both stay in sync
// rather than duplicating the same filter/cache-check/render logic. ======
function updateSuggestionsForCurrentQuery() {
  const query = document.getElementById('input-event-search').value.trim();
  if (!query) {
    hideSuggestions();
    return;
  }

  const season = getSelectedSeason();
  const allEvents = eventCache[season];
  if (!allEvents) {
    // Cache not loaded yet — don't show suggestions, just wait for search
    hideSuggestions();
    return;
  }

  const matches = filterEvents(allEvents, query).slice(0, 8);
  renderSuggestions(matches);
}

// ====== Live Autocomplete (client-side, no API calls) ======
document.getElementById('input-event-search').addEventListener('input', () => {
  // Persists whatever's typed (session-state.js, per active team) once typing
  // settles — independent of the suggestion-rendering debounce below, and
  // scheduled before the empty-query early return so clearing the box back
  // to empty gets saved too, not just non-empty queries.
  if (searchSaveDebounceTimer) clearTimeout(searchSaveDebounceTimer);
  searchSaveDebounceTimer = setTimeout(() => {
    if (typeof saveSessionState === 'function') saveSessionState();
  }, 400);

  if (debounceTimer) clearTimeout(debounceTimer);

  const query = document.getElementById('input-event-search').value.trim();
  if (!query) {
    hideSuggestions();
    return;
  }

  debounceTimer = setTimeout(updateSuggestionsForCurrentQuery, 150); // 150ms debounce — fast since it's local
});

// ====== Show suggestions immediately on focus if the box already has text
// (e.g. just restored on refresh/team-switch) — without this, suggestions
// only ever appeared once the user typed something, even though the box
// could already be non-empty the moment they click/tab into it. No debounce
// needed here — a focus is a single discrete action, not per-keystroke. ======
document.getElementById('input-event-search').addEventListener('focus', () => {
  updateSuggestionsForCurrentQuery();
});

// ====== Hide suggestions on blur / Escape ======
document.getElementById('input-event-search').addEventListener('blur', () => {
  setTimeout(hideSuggestions, 200);
});

document.getElementById('input-event-search').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    hideSuggestions();
  } else if (e.key === 'Enter') {
    hideSuggestions();
    doSearch();
  }
});

// ====== When season changes, clear everything and re-fetch ======
document.getElementById('select-season').addEventListener('change', async () => {
  const season = getSelectedSeason();

  // Clear all previous state immediately
  clearSelectedEvent();
  document.getElementById('input-event-search').value = '';

  // If we don't have this season cached yet, pre-load it in the background
  if (!eventCache[season]) {
    try {
      await ensureEventsLoaded(season);
    } catch (err) {
      // Silently fail — the search button will handle errors
    }
  }
});

// ====== Pre-load current season on page load ======
populateSeasonDropdown();

// Kick off background load of the current season's events
const initialSeason = getSelectedSeason();
ensureEventsLoaded(initialSeason).catch(() => {});
