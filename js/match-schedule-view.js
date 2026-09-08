// ====== Match Scouting Tab: Match-Based View ======
// Adds a second way to browse the Match Scouting tab, alongside the existing
// team-based list (js/first-api.js's renderMatchTeamList()/#team-list-match),
// which this file never touches. A toggle switches between them; this file
// owns only the new match-based side: fetching the event's schedule
// (getEventSchedule(), first-api.js), rendering one row per match with all 4
// teams color-coded by alliance, and — per-team — a scouted-status indicator
// and a direct click straight to the match scouting form.
//
// Team slots are clickable directly from the collapsed row (wishlist item
// 29) — there used to be an expand-first step here, but expanding never
// showed anything the collapsed row didn't already show (same team number/
// name/scouted-status), so it was removed rather than kept as a redundant
// second way to reach the same click target.
//
// Each alliance's score (wishlist item 31) is populated separately by
// match-scores.js, auto-loaded as soon as an event is selected (cached
// per-event for the session, and in Firestore, so this doesn't mean a live
// FTCScout hit on every switch) — this file just renders the score element
// and asks match-scores.js (if loaded) what to put in it, the same "call the
// optional global if it's defined" pattern already used below for
// scouted-status.

// ====== Fallback view for a team that's never set one — change this one
// constant to flip the default. Persisted per-team via session-state.js
// (perTeam[teamId].matchViewMode, restored in restorePerTeamEventState())
// same as selectedEvent/searchText, so a refresh or team switch shows
// whichever view this team was last left on rather than always resetting. ======
const MATCH_VIEW_DEFAULT = 'team'; // 'team' | 'match'

let matchViewMode = MATCH_VIEW_DEFAULT;

// Schedule data for the currently selected event
let currentEventSchedule = [];

// Same "live substring filter over rendered text" approach as
// applyTeamSearchFilter() (first-api.js) for the Team View lists — kept as
// its own query/function rather than reusing that one, since this filters
// match ROWS (by team number/name OR match number/description), not team
// items, and there's no second/third input to keep in sync with here.
let currentMatchScheduleSearchQuery = '';

// Which part of each row the query above is matched against — 'both' (the
// row's full rendered text, the original combined behavior), 'match' (just
// the match's own label, so e.g. "1" can't accidentally match team #1111
// embedded in the same row), or 'team' (just the teams block: numbers +
// names). Not reset on event change (unlike the query text) — it's a
// standing preference for how to search, not per-event state.
let currentMatchScheduleSearchMode = 'both';

// ====== Show/hide the team-view vs match-view containers and sync the
// toggle buttons' active state to matchViewMode. Safe to call any time —
// e.g. after the toggle bar itself is shown, or after a toggle click. ======
function applyMatchViewMode() {
  const teamView = document.getElementById('match-team-view');
  const scheduleView = document.getElementById('match-schedule-view');
  if (!teamView || !scheduleView) return;

  teamView.classList.toggle('hidden', matchViewMode !== 'team');
  scheduleView.classList.toggle('hidden', matchViewMode !== 'match');

  document.querySelectorAll('.match-view-toggle-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === matchViewMode);
  });
}

// ====== Reveal the toggle bar once an event is selected, and apply
// whatever view mode is currently active. ======
function showMatchViewToggle() {
  const bar = document.getElementById('match-view-toggle-bar');
  if (bar) bar.classList.remove('hidden');
  applyMatchViewMode();
}

function hideMatchViewToggle() {
  const bar = document.getElementById('match-view-toggle-bar');
  if (bar) bar.classList.add('hidden');
}

// ====== Called from selectEvent() (first-api.js) once teams are loaded —
// reveals the toggle and fetches/renders the schedule, regardless of which
// view is currently active (same eager-load-both-views convention the
// team-based pit/match lists already follow). ======
function onMatchScheduleEventSelected(eventCode) {
  showMatchViewToggle();
  loadMatchScheduleView(eventCode);
  // Auto-loads scores for this event (session/Firestore cache first, live
  // FTCScout fetch only if neither has it) — no manual "Refresh Scores"
  // click required for the first load, wishlist item 31 follow-up.
  if (typeof onMatchScoresEventSelected === 'function') {
    onMatchScoresEventSelected(eventCode);
  }
}

// ====== Called from clearSelectedEvent() (first-api.js) — hides the toggle
// and clears out any schedule/score state from the previous event. ======
function resetMatchScheduleView() {
  hideMatchViewToggle();
  currentEventSchedule = [];

  const status = document.getElementById('match-schedule-status');
  const list = document.getElementById('match-schedule-list');
  if (status) status.textContent = '';
  if (list) list.innerHTML = '';

  // A new event means a fresh schedule — same "start clean" reasoning as
  // clearSelectedEvent()'s other per-event state, so a search typed for the
  // last event doesn't silently carry into a different one's match list.
  currentMatchScheduleSearchQuery = '';
  const searchInput = document.getElementById('input-match-schedule-search');
  if (searchInput) searchInput.value = '';

  // A new event also means whatever scores were fetched for the last one
  // (match-scores.js) no longer apply — reset that state too, same "call the
  // optional global if it's defined" pattern used throughout this file.
  if (typeof resetMatchScores === 'function') resetMatchScores();
}

// ====== Fetch this event's schedule and render it ======
async function loadMatchScheduleView(eventCode) {
  currentEventSchedule = [];

  const status = document.getElementById('match-schedule-status');
  const list = document.getElementById('match-schedule-list');
  if (!status || !list) return;

  list.innerHTML = '';
  status.textContent = 'Loading match schedule...';

  try {
    const schedule = await getEventSchedule(eventCode);
    currentEventSchedule = schedule;
    renderMatchScheduleList(schedule);
  } catch (err) {
    console.error('Failed to load match schedule:', err);
    status.textContent = 'Could not load the match schedule. Check your connection and try again.';
  }
}

// ====== Render the match list, or the "not available yet" empty state —
// an empty schedule means the event hasn't published its matches yet, which
// is a normal state here, not an error. ======
function renderMatchScheduleList(schedule) {
  const status = document.getElementById('match-schedule-status');
  const list = document.getElementById('match-schedule-list');
  if (!status || !list) return;

  list.innerHTML = '';

  if (!schedule || schedule.length === 0) {
    status.textContent = 'Match schedule not available yet for this event.';
    return;
  }

  status.textContent = `${schedule.length} match(es) — click a team below to scout`;

  const sorted = [...schedule].sort((a, b) => (a.matchNumber || 0) - (b.matchNumber || 0));
  sorted.forEach(match => {
    list.appendChild(buildMatchScheduleRow(match));
  });

  // Re-apply whatever search was already typed — this render just rebuilt
  // every row from scratch (e.g. a fresh event load), which would otherwise
  // silently drop the filter until the next keystroke.
  applyMatchScheduleSearchFilter(currentMatchScheduleSearchQuery);
}

// ====== Filter match rows by team number/name OR match number/description —
// same broad "does the rendered text contain this" substring match
// applyTeamSearchFilter() (first-api.js) already uses for team lists, rather
// than parsing the query into separate team-vs-match-number cases: a row's
// text already includes every team's number+name and the match's own
// label, so one substring check against it naturally satisfies both search
// modes at once. ======
function applyMatchScheduleSearchFilter(query) {
  currentMatchScheduleSearchQuery = query || '';
  const q = currentMatchScheduleSearchQuery.trim().toLowerCase();

  const searchInput = document.getElementById('input-match-schedule-search');
  if (searchInput && searchInput.value !== currentMatchScheduleSearchQuery) {
    searchInput.value = currentMatchScheduleSearchQuery;
  }

  const list = document.getElementById('match-schedule-list');
  if (!list) return;

  list.querySelectorAll('.match-schedule-row').forEach(row => {
    const matches = !q || getMatchScheduleRowSearchText(row).toLowerCase().includes(q);
    row.style.display = matches ? '' : 'none';
  });
}

// ====== Text to match the query against for one row, scoped by
// currentMatchScheduleSearchMode. 'match' reads only the row's own label
// (.match-number — the match description, or "Match N" fallback, which
// always embeds the real match number) so a query like "1" can't
// accidentally hit team #1111 the way a full-row substring match would;
// 'team' reads only the teams block (numbers + names); 'both' is the row's
// full rendered text, same as the original combined-only behavior. ======
function getMatchScheduleRowSearchText(row) {
  if (currentMatchScheduleSearchMode === 'match') {
    const numberEl = row.querySelector('.match-number');
    return numberEl ? numberEl.textContent : '';
  }
  if (currentMatchScheduleSearchMode === 'team') {
    const teamsEl = row.querySelector('.match-schedule-teams');
    return teamsEl ? teamsEl.textContent : '';
  }
  return row.textContent;
}

// ====== Split a schedule match's teams into red/blue alliances, each
// ordered by station number (1 before 2). Station strings from the FIRST API
// look like "Red1"/"Blue2"; matched case-insensitively and by prefix rather
// than an exact set, so this doesn't break if the API's casing varies. ======
function getAllianceTeams(match) {
  const teams = match.teams || [];
  const stationOrder = (station) => {
    const s = String(station || '').toLowerCase();
    if (s.endsWith('1')) return 1;
    if (s.endsWith('2')) return 2;
    return 99;
  };
  const isRed = (t) => String(t.station || '').toLowerCase().startsWith('red');
  const isBlue = (t) => String(t.station || '').toLowerCase().startsWith('blue');

  return {
    red: teams.filter(isRed).sort((a, b) => stationOrder(a.station) - stationOrder(b.station)),
    blue: teams.filter(isBlue).sort((a, b) => stationOrder(a.station) - stationOrder(b.station))
  };
}

// ====== Look up a team's display name from the already-cached event roster
// (currentEventTeams, first-api.js) — the same source renderMatchTeamList()
// uses, so a name shown here always matches what the team-based view (and
// exports) would show for the same team, with no separate name storage. ======
function getScheduleTeamName(teamNumber) {
  const team = (typeof currentEventTeams !== 'undefined' ? currentEventTeams : [])
    .find(t => Number(t.teamNumber) === Number(teamNumber));
  if (!team) return '';
  return team.name || team.nameFull || team.nameShort || team.schoolName || team.teamNameCalc || '';
}

// ====== Build one collapsed match row: header (match label) plus all 4
// teams as two-line (number/name) slots, color-coded by alliance, each
// directly clickable to scout. Each alliance block also carries its OWN
// score header (wishlist item 31) — the red alliance's score sits on the red
// side, the blue alliance's on the blue side, rather than one shared badge —
// see buildAllianceBlock() below. ======
function buildMatchScheduleRow(match) {
  const { red, blue } = getAllianceTeams(match);

  const row = document.createElement('div');
  row.className = 'match-schedule-row';
  row.dataset.matchNumber = match.matchNumber;

  const header = document.createElement('div');
  header.className = 'match-schedule-row-header';

  const numberSpan = document.createElement('span');
  numberSpan.className = 'match-number';
  numberSpan.textContent = match.description || `Match ${match.matchNumber}`;

  header.appendChild(numberSpan);

  const teamsRow = document.createElement('div');
  teamsRow.className = 'match-schedule-teams';
  teamsRow.appendChild(buildAllianceBlock('red', red, match.matchNumber));
  teamsRow.appendChild(buildAllianceBlock('blue', blue, match.matchNumber));

  row.appendChild(header);
  row.appendChild(teamsRow);

  return row;
}

// ====== One alliance's half of a match row: its own score header (wishlist
// item 31 — big, on THIS alliance's own side, clickable to open the
// breakdown modal) stacked above its team slots. ======
function buildAllianceBlock(color, teams, matchNumber) {
  const block = document.createElement('div');
  block.className = `alliance-block alliance-${color}`;

  const scoreEl = document.createElement('div');
  scoreEl.className = `alliance-score alliance-score-${color}`;
  scoreEl.dataset.matchNumber = matchNumber;
  scoreEl.dataset.alliance = color;
  scoreEl.addEventListener('click', () => {
    if (typeof openMatchScoreBreakdownModal === 'function') {
      openMatchScoreBreakdownModal(matchNumber);
    }
  });
  block.appendChild(scoreEl);
  applyAllianceScore(scoreEl, matchNumber, color);

  const slotsWrap = document.createElement('div');
  slotsWrap.className = 'alliance-team-slots';
  teams.forEach(t => slotsWrap.appendChild(buildMatchTeamSlot(t.teamNumber, matchNumber)));
  block.appendChild(slotsWrap);

  return block;
}

// ====== One team's clickable slot within a collapsed match row (wishlist
// item 29 — clicking it goes straight to the match scouting form, no expand
// step first). Resolves new-vs-edit and permission the same way the
// team-based view does — openMatchScoutFormFromSchedule() (match-scout.js)
// tells the user via showNoticeModal() if an entry already exists and they
// can't edit it, rather than silently doing nothing. ======
function buildMatchTeamSlot(teamNumber, matchNumber) {
  const slot = document.createElement('div');
  slot.className = 'match-team-slot';
  slot.dataset.teamNumber = teamNumber;
  slot.dataset.matchNumber = matchNumber;

  const numSpan = document.createElement('span');
  numSpan.className = 'match-team-number';
  numSpan.textContent = `#${teamNumber}`;

  const nameSpan = document.createElement('span');
  nameSpan.className = 'match-team-name';
  nameSpan.textContent = getScheduleTeamName(teamNumber);
  nameSpan.title = nameSpan.textContent; // full name on hover once CSS ellipsis shortens it

  slot.appendChild(numSpan);
  slot.appendChild(nameSpan);
  applyScoutedIndicator(slot, teamNumber, matchNumber);

  slot.addEventListener('click', () => {
    if (typeof openMatchScoutFormFromSchedule === 'function' && selectedEvent?.code) {
      openMatchScoutFormFromSchedule(matchNumber, teamNumber, selectedEvent.code, nameSpan.textContent);
    }
  });

  return slot;
}

// ====== Scouted-status indicator ======
// Reads the LIVE cache watchMatchScoutStatus() (match-scout.js) already
// maintains for the currently selected event — no separate Firestore
// listener of our own. That cache is keyed by "eventCode_teamNumber" and
// holds every match entry for that team at this event, not just one match,
// so "scouted for THIS match" means filtering it down to matchNumber.
//
// watchMatchScoutStatus(eventCode) is called from selectEvent() (first-api.js)
// BEFORE onMatchScheduleEventSelected() (this file's hook) — so the listener
// is always already attached by the time this runs. But attachment isn't the
// same as data having arrived: the snapshot resolves asynchronously and can
// genuinely still be empty at the moment a row first renders, racing against
// this file's own schedule fetch. getMatchEntriesForTeam() already returns
// [] gracefully for a cache miss, so an early call here just shows "not
// scouted yet" rather than erroring or showing something wrong — and
// whichever finishes first (schedule render or the snapshot), the other's
// completion re-applies indicators correctly (row-build time here, and the
// chained onMatchScoutedStateChanged callback below for live updates).
function isTeamScoutedForMatch(teamNumber, matchNumber) {
  if (!selectedEvent?.code || typeof getMatchEntriesForTeam !== 'function') return false;
  const entries = getMatchEntriesForTeam(teamNumber, selectedEvent.code);
  return entries.some(e => Number(e.matchNumber) === Number(matchNumber));
}

function applyScoutedIndicator(el, teamNumber, matchNumber) {
  el.classList.toggle('scouted', isTeamScoutedForMatch(teamNumber, matchNumber));
}

// ====== Re-apply scouted indicators to every currently-rendered team slot
// in place, without rebuilding any DOM — called whenever matchEntriesCache
// changes (live snapshot updates), so scroll position never gets disrupted
// by someone else's scouting update landing mid-browse. ======
function refreshMatchScheduleScoutedIndicators() {
  document.querySelectorAll('#match-schedule-list [data-team-number]').forEach(el => {
    applyScoutedIndicator(el, el.dataset.teamNumber, el.dataset.matchNumber);
  });
}

// ====== One alliance's score header (wishlist item 31) — reads whatever
// match-scores.js has cached for this match (nothing until it's auto-loaded
// or explicitly refreshed; match-scores.js is optional-global-called exactly
// like match-scout.js's scouted-status cache above). Shows just THIS
// alliance's total, big and on its own side of the row; hidden entirely if
// no score is available yet (not yet fetched, or this match hasn't been
// played). The caret is a pure affordance — the whole element is clickable,
// same as the CSS hover highlight applies to the whole element too. ======
function applyAllianceScore(scoreEl, matchNumber, color) {
  const summary = typeof getMatchScoreSummary === 'function' ? getMatchScoreSummary(matchNumber) : null;
  const value = summary ? summary[color]?.totalPoints : null;

  if (value == null) {
    scoreEl.classList.remove('visible');
    scoreEl.innerHTML = '';
    return;
  }

  scoreEl.innerHTML = '';
  const numSpan = document.createElement('span');
  numSpan.className = 'alliance-score-value';
  numSpan.textContent = value;
  const caret = document.createElement('span');
  caret.className = 'alliance-score-caret';
  caret.textContent = '▸';

  scoreEl.appendChild(numSpan);
  scoreEl.appendChild(caret);
  scoreEl.classList.add('visible');
}

// ====== Re-apply score headers to every currently-rendered row — called by
// match-scores.js once scores load/refresh, same "refresh in place" pattern
// as refreshMatchScheduleScoutedIndicators() above. ======
function refreshMatchScheduleScoreBadges() {
  document.querySelectorAll('#match-schedule-list .alliance-score').forEach(scoreEl => {
    applyAllianceScore(scoreEl, scoreEl.dataset.matchNumber, scoreEl.dataset.alliance);
  });
}

// ====== Wire up the Team View / Match View toggle buttons ======
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.match-view-toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      matchViewMode = btn.dataset.view === 'match' ? 'match' : 'team';
      // Team View <-> Match View is a third distinct switch point, inside
      // the Match Scouting sub-tab, that the sub-tab-switch and main-tab-
      // switch reset points (app.js's activateSubTab(), members.js's
      // activateDashboardTab()) never cover — an in-progress bulk-select on
      // Team View shouldn't survive flipping to Match View and back any more
      // than it survives leaving the sub-tab entirely.
      if (typeof exitAllBulkSelectModes === 'function') exitAllBulkSelectModes();
      applyMatchViewMode();
      if (typeof saveSessionState === 'function') saveSessionState();
    });
  });

  const scheduleSearchInput = document.getElementById('input-match-schedule-search');
  if (scheduleSearchInput) {
    scheduleSearchInput.addEventListener('input', (e) => {
      applyMatchScheduleSearchFilter(e.target.value);
    });
  }

  const scheduleSearchModeSelect = document.getElementById('select-match-schedule-search-mode');
  if (scheduleSearchModeSelect) {
    scheduleSearchModeSelect.addEventListener('change', (e) => {
      currentMatchScheduleSearchMode = (e.target.value === 'match' || e.target.value === 'team') ? e.target.value : 'both';
      applyMatchScheduleSearchFilter(currentMatchScheduleSearchQuery);
    });
  }

  // Chain onto onMatchScoutedStateChanged (match-scout.js) rather than
  // reassign it outright — match-scout.js's own DOMContentLoaded handler
  // already assigns it (to refresh the team-based view's match list/counts),
  // and script tag order guarantees that handler registers, and therefore
  // fires, before this one. Overwriting it here instead of wrapping it would
  // silently break the team-based view's live refresh — this preserves
  // whatever's already there and adds our own refresh alongside it.
  if (typeof onMatchScoutedStateChanged !== 'undefined') {
    const previousMatchScoutedCallback = onMatchScoutedStateChanged;
    onMatchScoutedStateChanged = () => {
      if (typeof previousMatchScoutedCallback === 'function') {
        previousMatchScoutedCallback();
      }
      refreshMatchScheduleScoutedIndicators();
    };
  }
});
