// ====== Match Scouting Tab: Match-Based View (Phase 2 — list/expand shell) ======
// Adds a second way to browse the Match Scouting tab, alongside the existing
// team-based list (js/first-api.js's renderMatchTeamList()/#team-list-match),
// which this file never touches. A toggle switches between them; this file
// owns only the new match-based side: fetching the event's schedule
// (getEventSchedule(), first-api.js), rendering one row per match with all 4
// teams color-coded by alliance, and a single-open-at-a-time inline expand
// panel per row.
//
// Phase 2 scope only: no scouted-status indicators yet (phase 3), and
// clicking a team in the expanded panel does nothing yet (phase 4 wires it
// to the match scouting form).

// ====== Fallback view for a team that's never set one — change this one
// constant to flip the default. Persisted per-team via session-state.js
// (perTeam[teamId].matchViewMode, restored in restorePerTeamEventState())
// same as selectedEvent/searchText, so a refresh or team switch shows
// whichever view this team was last left on rather than always resetting. ======
const MATCH_VIEW_DEFAULT = 'team'; // 'team' | 'match'

let matchViewMode = MATCH_VIEW_DEFAULT;

// Schedule data + expand state for the currently selected event
let currentEventSchedule = [];
let expandedScheduleMatchNumber = null;
let expandedSchedulePanelEl = null;

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
}

// ====== Called from clearSelectedEvent() (first-api.js) — hides the toggle
// and clears out any schedule state/expanded panel from the previous event. ======
function resetMatchScheduleView() {
  hideMatchViewToggle();
  currentEventSchedule = [];
  expandedScheduleMatchNumber = null;
  expandedSchedulePanelEl = null;

  const status = document.getElementById('match-schedule-status');
  const list = document.getElementById('match-schedule-list');
  if (status) status.textContent = '';
  if (list) list.innerHTML = '';
}

// ====== Fetch this event's schedule and render it ======
async function loadMatchScheduleView(eventCode) {
  currentEventSchedule = [];
  expandedScheduleMatchNumber = null;
  expandedSchedulePanelEl = null;

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

  status.textContent = `${schedule.length} match(es)`;

  const sorted = [...schedule].sort((a, b) => (a.matchNumber || 0) - (b.matchNumber || 0));
  sorted.forEach(match => {
    list.appendChild(buildMatchScheduleRow(match));
  });
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

// ====== Build one collapsed match row: header (match label + expand icon)
// plus all 4 teams as two-line (number/name) slots, color-coded by alliance. ======
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

  const icon = document.createElement('span');
  icon.className = 'match-expand-icon';
  icon.textContent = '▾'; // ▾ — rotates to point up when expanded (CSS)

  header.appendChild(numberSpan);
  header.appendChild(icon);

  const teamsRow = document.createElement('div');
  teamsRow.className = 'match-schedule-teams';
  teamsRow.appendChild(buildAllianceBlock('red', red, match.matchNumber));
  teamsRow.appendChild(buildAllianceBlock('blue', blue, match.matchNumber));

  row.appendChild(header);
  row.appendChild(teamsRow);

  row.addEventListener('click', () => toggleScheduleMatchExpand(match, row));

  return row;
}

function buildAllianceBlock(color, teams, matchNumber) {
  const block = document.createElement('div');
  block.className = `alliance-block alliance-${color}`;
  teams.forEach(t => block.appendChild(buildMatchTeamSlot(t.teamNumber, matchNumber)));
  return block;
}

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
  return slot;
}

// ====== Scouted-status indicator (phase 3) ======
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
// (collapsed rows and, if one is open, the expanded panel) in place, without
// rebuilding any DOM — called whenever matchEntriesCache changes (live
// snapshot updates), so an expanded panel or scroll position never gets
// disrupted by someone else's scouting update landing mid-browse. ======
function refreshMatchScheduleScoutedIndicators() {
  document.querySelectorAll('#match-schedule-list [data-team-number]').forEach(el => {
    applyScoutedIndicator(el, el.dataset.teamNumber, el.dataset.matchNumber);
  });
}

// ====== Expand/collapse a match row into its persistent inline panel.
// Only one match is ever expanded at a time — expanding a new one always
// collapses (removes) whichever panel was previously open first. The panel
// is inserted as a real DOM sibling right after the row (not
// position:absolute), so it pushes every row below it down the page. ======
function toggleScheduleMatchExpand(match, rowEl) {
  const matchNumber = match.matchNumber;
  const wasThisOneExpanded = expandedScheduleMatchNumber === matchNumber;

  if (expandedSchedulePanelEl) {
    expandedSchedulePanelEl.remove();
    expandedSchedulePanelEl = null;
  }
  document.querySelectorAll('.match-schedule-row.expanded').forEach(el => el.classList.remove('expanded'));
  expandedScheduleMatchNumber = null;

  if (wasThisOneExpanded) {
    // Clicking the already-expanded row again just closes it.
    return;
  }

  expandedScheduleMatchNumber = matchNumber;
  rowEl.classList.add('expanded');

  const panel = buildMatchSchedulePanel(match);
  rowEl.insertAdjacentElement('afterend', panel);
  expandedSchedulePanelEl = panel;
}

// ====== Build the expanded panel's 4 team rows. Purely display-only in this
// phase — phase 4 adds the click handler that opens the match scouting form
// with this match/team pre-filled and locked. ======
function buildMatchSchedulePanel(match) {
  const { red, blue } = getAllianceTeams(match);
  const panel = document.createElement('div');
  panel.className = 'match-schedule-panel';
  panel.dataset.matchNumber = match.matchNumber;

  [...red, ...blue].forEach(t => panel.appendChild(buildMatchSchedulePanelTeam(t, match.matchNumber)));

  return panel;
}

function buildMatchSchedulePanelTeam(teamEntry, matchNumber) {
  const color = String(teamEntry.station || '').toLowerCase().startsWith('red') ? 'red' : 'blue';

  const row = document.createElement('div');
  row.className = `match-schedule-panel-team alliance-${color}`;
  row.dataset.teamNumber = teamEntry.teamNumber;
  row.dataset.matchNumber = matchNumber;

  const numSpan = document.createElement('span');
  numSpan.className = 'match-team-number';
  numSpan.textContent = `#${teamEntry.teamNumber}`;

  const nameSpan = document.createElement('span');
  nameSpan.className = 'match-team-name';
  nameSpan.textContent = getScheduleTeamName(teamEntry.teamNumber);

  row.appendChild(numSpan);
  row.appendChild(nameSpan);
  applyScoutedIndicator(row, teamEntry.teamNumber, matchNumber);

  // Opens the match scouting form with match number + team pre-filled and
  // locked (match-scout.js's openMatchScoutFormFromSchedule() resolves
  // new-vs-edit and permission the same way the team-based view does — if
  // an entry already exists and the current user can't edit it, it tells
  // them so via showNoticeModal() rather than silently doing nothing).
  row.addEventListener('click', () => {
    if (typeof openMatchScoutFormFromSchedule === 'function' && selectedEvent?.code) {
      openMatchScoutFormFromSchedule(matchNumber, teamEntry.teamNumber, selectedEvent.code, nameSpan.textContent);
    }
  });

  return row;
}

// ====== Wire up the Team View / Match View toggle buttons ======
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.match-view-toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      matchViewMode = btn.dataset.view === 'match' ? 'match' : 'team';
      applyMatchViewMode();
      if (typeof saveSessionState === 'function') saveSessionState();
    });
  });

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
