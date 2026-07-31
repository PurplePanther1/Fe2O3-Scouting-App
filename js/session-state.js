// ====== Session State Persistence ======
// Remembers the active dashboard tab, scouting subtab, and selected event in
// sessionStorage — scoped to this browser tab only (not localStorage), so a
// refresh restores exactly where the user was, but closing the tab/browser
// (or opening the app fresh in a new tab) starts clean at the default
// Scouting → Team Information state with no event selected.

const SESSION_STATE_KEY = 'fe2o3_session_state';

// ====== Snapshot current tab/subtab/event state and persist it ======
function saveSessionState() {
  try {
    const activeDashboardTab = document.querySelector('#dashboard-tabs .tab.active');
    const dashboardTab = activeDashboardTab ? activeDashboardTab.dataset.dtab : 'scouting';
    const scoutingSubtab = typeof lastActiveScoutingSubTab !== 'undefined' ? lastActiveScoutingSubTab : 'info';
    const eventToSave = (typeof selectedEvent !== 'undefined' && selectedEvent) ? selectedEvent : null;

    sessionStorage.setItem(SESSION_STATE_KEY, JSON.stringify({
      dashboardTab,
      scoutingSubtab,
      selectedEvent: eventToSave
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

// ====== Discard saved state (called on sign-out) ======
// Session-restore is meant for refreshing while still logged in, not for a
// fresh login — without this, signing out and back in within the same tab
// would resurrect the previous login's tab/subtab/event instead of landing
// on the Scouting → Team Information default a fresh login should get.
function clearSessionState() {
  try {
    sessionStorage.removeItem(SESSION_STATE_KEY);
  } catch (err) {
    console.warn('Failed to clear session state:', err);
  }
}

// ====== Apply saved state on login/refresh, or fall back to the existing
// default (Scouting → Team Information, no event) if this is a fresh session ======
async function restoreOrDefaultSessionState() {
  const saved = loadSessionState();
  const dashboardTab = (saved && saved.dashboardTab) || 'scouting';
  const scoutingSubtab = (saved && saved.scoutingSubtab) || 'info';

  if (typeof window.activateDashboardTab === 'function') {
    window.activateDashboardTab(dashboardTab);
  }
  if (typeof window.activateScoutingSubTab === 'function') {
    window.activateScoutingSubTab(scoutingSubtab);
  }

  if (saved && saved.selectedEvent && typeof selectEvent === 'function') {
    // Reloads the team list for this event. selectEvent() always forces the
    // scouting subtab to 'info' as a side effect, so re-apply the saved subtab
    // afterward to correct that.
    await selectEvent(saved.selectedEvent);
    if (typeof window.activateScoutingSubTab === 'function') {
      window.activateScoutingSubTab(scoutingSubtab);
    }
  }
}
