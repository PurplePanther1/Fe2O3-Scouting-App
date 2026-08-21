// ====== Session State Persistence ======
// Remembers the active dashboard tab and scouting subtab (global — not tied
// to any one team) plus, per team, its own last selected event and event-
// search text — all in sessionStorage, scoped to this browser tab only (not
// localStorage), so a refresh restores exactly where the user was, but
// closing the tab/browser (or opening the app fresh in a new tab) starts
// clean at the default Scouting → Team Information state with no event
// selected. Switching between teams shows each team's own event/search
// state (empty if that team has never had one set), never another team's.

const SESSION_STATE_KEY = 'fe2o3_session_state';

// ====== Snapshot current tab/subtab state plus the ACTIVE team's own
// event/search state, and persist it — read-modify-write against whatever's
// already stored so every OTHER team's perTeam entry survives untouched. ======
function saveSessionState() {
  try {
    const activeDashboardTab = document.querySelector('#dashboard-tabs .tab.active');
    const dashboardTab = activeDashboardTab ? activeDashboardTab.dataset.dtab : 'scouting';
    const scoutingSubtab = typeof lastActiveScoutingSubTab !== 'undefined' ? lastActiveScoutingSubTab : 'info';

    const existing = loadSessionState();
    const perTeam = (existing && existing.perTeam) || {};

    // No active team yet (e.g. still on the Join/Create screen) — nothing to
    // scope a per-team entry to, so just persist the global tab/subtab state.
    if (typeof currentTeamId !== 'undefined' && currentTeamId) {
      const eventToSave = (typeof selectedEvent !== 'undefined' && selectedEvent) ? selectedEvent : null;
      const searchInput = document.getElementById('input-event-search');
      perTeam[currentTeamId] = {
        selectedEvent: eventToSave,
        searchText: searchInput ? searchInput.value : '',
        matchViewMode: (typeof matchViewMode !== 'undefined') ? matchViewMode : undefined
      };
    }

    sessionStorage.setItem(SESSION_STATE_KEY, JSON.stringify({
      dashboardTab,
      scoutingSubtab,
      perTeam
    }));
  } catch (err) {
    console.warn('Failed to save session state:', err);
  }
}

// ====== Read back whatever was last saved (or null if nothing/invalid) ======
function loadSessionState() {
  try {
    const raw = sessionStorage.getItem(SESSION_STATE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    console.warn('Failed to read session state:', err);
    return null;
  }
}

// ====== Discard ALL saved state (called on sign-out) ======
// Session-restore is meant for refreshing while still logged in, not for a
// fresh login — without this, signing out and back in within the same tab
// would resurrect the previous login's tab/subtab/event(s) instead of
// landing on the Scouting → Team Information default a fresh login should
// get. Clearing the single top-level key wipes every team's perTeam entry
// too, so no separate per-team cleanup is needed here.
function clearSessionState() {
  try {
    sessionStorage.removeItem(SESSION_STATE_KEY);
  } catch (err) {
    console.warn('Failed to clear session state:', err);
  }
}

// ====== Discard just ONE team's saved event/search state (called when this
// user's membership on that team ends — selfLeaveTeam()/deleteEntireTeam(),
// delete-account.js). Without this, rejoining the same team later (same
// teamId — leaving doesn't delete/recreate the team doc) would resurrect
// whatever event/search was active before they left, instead of the fresh
// start a rejoin should be. ======
function clearTeamSessionState(teamId) {
  if (!teamId) return;
  try {
    const existing = loadSessionState();
    if (!existing || !existing.perTeam || !(teamId in existing.perTeam)) return;
    delete existing.perTeam[teamId];
    sessionStorage.setItem(SESSION_STATE_KEY, JSON.stringify(existing));
  } catch (err) {
    console.warn('Failed to clear team session state:', err);
  }
}

// ====== Apply the ACTIVE team's (currentTeamId) saved event/search state,
// or clear+blank if this team has never had one set — called on login/
// refresh (restoreOrDefaultSessionState(), below) and on every team switch
// (switchActiveTeam(), auth.js), so each team always shows its own event/
// search, never whatever a previously-active team left behind. ======
async function restorePerTeamEventState() {
  const saved = loadSessionState();
  const teamEntry = (saved && saved.perTeam && typeof currentTeamId !== 'undefined' && currentTeamId)
    ? saved.perTeam[currentTeamId]
    : null;

  const searchInput = document.getElementById('input-event-search');

  // Restore the match-based view's team-vs-match toggle BEFORE selectEvent()
  // below — selectEvent() applies matchViewMode as a side effect of loading
  // the schedule (onMatchScheduleEventSelected(), match-schedule-view.js),
  // so this has to already reflect the restored value by the time that runs
  // rather than whatever it was left at on page load.
  if (typeof matchViewMode !== 'undefined') {
    matchViewMode = (teamEntry && teamEntry.matchViewMode)
      || (typeof MATCH_VIEW_DEFAULT !== 'undefined' ? MATCH_VIEW_DEFAULT : 'team');
  }

  if (teamEntry && teamEntry.selectedEvent && typeof selectEvent === 'function') {
    // Reloads the team list for this event. selectEvent() no longer forces
    // any particular scouting subtab — whatever the caller already applied
    // (or applies after, e.g. restoreOrDefaultSessionState() below) stands.
    await selectEvent(teamEntry.selectedEvent);
    if (searchInput) searchInput.value = teamEntry.searchText || '';
  } else {
    if (typeof clearSelectedEvent === 'function') {
      clearSelectedEvent();
    }
    // A search can be submitted (and saved) without ever selecting an event
    // from its results — that case has searchText but no selectedEvent, and
    // still deserves restoring: re-run the search itself (via doSearch(),
    // which reads whatever's in the box) rather than caching the results
    // array separately, since filterEvents() against eventCache is already
    // cheap and this guarantees results can never go stale relative to it.
    if (searchInput && teamEntry && teamEntry.searchText) {
      searchInput.value = teamEntry.searchText;
      if (typeof doSearch === 'function') {
        await doSearch();
      }
    } else if (searchInput) {
      searchInput.value = '';
    }
  }
}

// ====== Apply saved dashboard tab/subtab, then the active team's saved
// event/search state — on login/refresh, or fall back to the existing
// default (Scouting → Team Information, no event) if this is a fresh
// session. ======
async function restoreOrDefaultSessionState() {
  const saved = loadSessionState();
  const dashboardTab = (saved && saved.dashboardTab) || 'scouting';
  const scoutingSubtab = (saved && saved.scoutingSubtab) || 'info';

  // Must run BEFORE activateDashboardTab()/activateScoutingSubTab() below —
  // both trigger their own saveSessionState() as a side effect, which would
  // otherwise overwrite currentTeamId's still-unrestored entry (selectedEvent
  // still null at this point, nothing has restored it yet) before this ever
  // gets to read the real saved data. Same ordering already used in
  // switchActiveTeam() for the same reason.
  await restorePerTeamEventState();

  if (typeof window.activateDashboardTab === 'function') {
    window.activateDashboardTab(dashboardTab);
  }
  if (typeof window.activateScoutingSubTab === 'function') {
    window.activateScoutingSubTab(scoutingSubtab);
  }
}
