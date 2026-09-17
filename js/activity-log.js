// ====== Account Activity Log ======
// users/{uid}/activityLog/{entryId}: a flat, per-user notification log — kick
// notices, live-edit disconnects (self-written by the affected account), and
// permission-change/captaincy-transfer notices (written by the acting
// captain to the affected teammate's own log — see firestore.rules for the
// narrow captain-only cross-user create rule this requires). No backfill:
// the log starts empty at launch, nothing synthesizes history from before
// this existed. See js/members.js/auth.js/match-scout.js/pit-scout.js for
// the actual write call sites; this file owns the schema, the Account
// Activity page UI (its own standalone dashboard "page" — see
// openAccountActivity()/closeAccountActivity() in js/auth.js — with its own
// General/per-team sub-tabs rendered here), and the unread-count badge
// (refresh-on-navigation, not real-time — no onSnapshot listener here by
// design).

const ACTIVITY_LOG_TTL_DAYS = 180;

const ACTIVITY_LOG_TYPE_LABELS = {
  'kicked': 'Removed from Team',
  'live-edit-disconnected': 'Live Edit Disconnected',
  'permission-changed': 'Permissions Changed',
  'captaincy-transferred': 'Captaincy Transferred'
};

function activityLogExpireAt() {
  return firebase.firestore.Timestamp.fromMillis(Date.now() + ACTIVITY_LOG_TTL_DAYS * 24 * 60 * 60 * 1000);
}

// Self-write: the account's own client reporting something it just detected
// about itself. Fire-and-forget — a failed log write shouldn't block or
// surface an error on top of whatever real action (a kick notice, a
// disconnect) triggered it. Returns the write promise so a caller that needs
// ordering relative to a later step (see transferCaptaincy's cross-write
// below) can still await it.
async function logActivitySelf({ type, teamId, teamName, message }) {
  if (!currentUser) return;
  try {
    await db.collection('users').doc(currentUser.uid).collection('activityLog').add({
      type,
      teamId: teamId || null,
      teamName: teamName || null,
      message,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      read: false,
      expireAt: activityLogExpireAt()
    });
  } catch (err) {
    console.warn('Failed to write activity log entry:', err);
  }
}

// Captain-authored cross-write: written to the AFFECTED member's own log.
// firestore.rules checks the acting captain's role live at write time — see
// transferCaptaincy() in members.js for why call ORDER matters when the same
// action also changes the acting captain's own role.
async function logActivityForUser(targetUid, { type, teamId, teamName, message }) {
  try {
    await db.collection('users').doc(targetUid).collection('activityLog').add({
      type,
      teamId: teamId || null,
      teamName: teamName || null,
      message,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      read: false,
      expireAt: activityLogExpireAt()
    });
  } catch (err) {
    console.warn('Failed to write activity log entry for teammate:', err);
  }
}

// Query-and-batch-delete the whole subcollection — used by
// delete-account.js's account-deletion flow. Unlike private/contact (a
// single known doc), this can hold an arbitrary number of entries, so it
// loops in pages of 500 (Firestore's per-batch write cap) until nothing's
// left, rather than assuming one batch always covers it.
async function deleteActivityLogSubcollection(uid) {
  const collectionRef = db.collection('users').doc(uid).collection('activityLog');
  for (;;) {
    const snap = await collectionRef.limit(500).get();
    if (snap.empty) return;
    const batch = db.batch();
    snap.docs.forEach(doc => batch.delete(doc.ref));
    await batch.commit();
    if (snap.size < 500) return;
  }
}

// ====== Delete one team's whole Account Activity tab (every entry with that
// teamId) from the CURRENT user's own log — self-delete, so this is always
// called as (or on behalf of) the affected user, never by a captain acting
// on someone else's log (there's no cross-user delete rule for this, and
// none is needed). Called whenever this account loses membership on a team
// for any reason OTHER than deleting the whole account (voluntary leave, a
// kick, any other path that removes membership) — account deletion instead
// wipes the ENTIRE log via deleteActivityLogSubcollection() above, so
// calling this too would just be redundant reads/writes on the way out, not
// wrong, but every account-deletion call site intentionally skips it.
// Same page-of-500 loop as deleteActivityLogSubcollection() above, for the
// same reason (an arbitrary, unbounded number of entries can exist for one
// team, even if that's rare in practice). ======
async function deleteActivityLogTeamTab(uid, teamId) {
  if (!uid || !teamId) return;
  try {
    const collectionRef = db.collection('users').doc(uid).collection('activityLog').where('teamId', '==', teamId);
    for (;;) {
      const snap = await collectionRef.limit(500).get();
      if (snap.empty) return;
      const batch = db.batch();
      snap.docs.forEach(doc => batch.delete(doc.ref));
      await batch.commit();
      if (snap.size < 500) return;
    }
  } catch (err) {
    console.warn(`Failed to delete activity log tab for team ${teamId}:`, err);
  }
}

// ====== Timezone ======
// Per-user preference (users/{uid}.timezone), defaulted at first login from
// the browser (see detectBrowserTimezone(), auth.js) and editable from the
// Account tab. Applied here (activity log timestamps) and in
// sheets-export.js's two timestamp-formatting call sites — deliberately NOT
// applied to the live match-scores clock elsewhere in the app.
function getUserTimezone() {
  return (typeof currentUserProfile !== 'undefined' && currentUserProfile && currentUserProfile.timezone)
    || (typeof detectBrowserTimezone === 'function' ? detectBrowserTimezone() : 'UTC');
}

function formatInUserTimezone(date) {
  try {
    return date.toLocaleString('en-US', { timeZone: getUserTimezone() });
  } catch (err) {
    return date.toLocaleString();
  }
}

// Cached across calls in the same session — the supported-timezone list is
// static and Intl.supportedValuesOf() (where available) is not free to
// recompute on every dropdown open.
let cachedTimezoneList = null;
function listAvailableTimezones() {
  if (cachedTimezoneList) return cachedTimezoneList;
  try {
    if (typeof Intl.supportedValuesOf === 'function') {
      cachedTimezoneList = Intl.supportedValuesOf('timeZone');
      return cachedTimezoneList;
    }
  } catch (err) {
    // fall through to the fixed fallback list below
  }
  // Fallback for browsers without Intl.supportedValuesOf (older Safari) —
  // covers US timezones (the primary FTC audience) plus UTC.
  cachedTimezoneList = [
    'America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix',
    'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu', 'UTC'
  ];
  return cachedTimezoneList;
}

function populateTimezoneSelect(selectId, currentValue) {
  const select = document.getElementById(selectId);
  if (!select) return;
  const zones = listAvailableTimezones();
  const zonesWithCurrent = (currentValue && !zones.includes(currentValue)) ? [currentValue, ...zones] : zones;
  select.innerHTML = zonesWithCurrent.map(z => `<option value="${z}">${z.replace(/_/g, ' ')}</option>`).join('');
  select.value = currentValue || getUserTimezone();
}

// ====== Account Activity tab UI ======
// Tabs are a client-side filter over ONE flat query (users/{uid}/activityLog
// isn't split per-team in Firestore — every entry, regardless of team, lives
// in the same subcollection), not a separate collection per team. The tab
// list itself is the union of myTeams (teams currently belonged to) and any
// teamId actually present in the fetched entries — a kicked-from-team entry
// must stay reachable even after the team itself is gone from myTeams.
let activityLogEntries = [];
let activityLogActiveTab = 'general';
let activityLogSearchQuery = '';
let activityLogTypeFilter = '';
let activityLogUnreadCounts = { total: 0, byTeam: {}, general: 0 };

// ====== Active tab / type-filter persistence rules ======
// Two genuinely different cases, per live-testing feedback:
//  - Normal in-app navigation INTO this page (the "Account Activity" button,
//    auth.js's openAccountActivity()) or signing out: reset to General/All
//    Types. See resetActivityLogViewState().
//  - A page REFRESH while already viewing this page: keep whatever tab/
//    filter was active. See applyActivityLogViewState(), called from
//    restoreOrDefaultSessionState() (session-state.js) with whatever was
//    last saved to sessionStorage (saveSessionState() there reads
//    activityLogActiveTab/activityLogTypeFilter live, and the tab-click/
//    filter-change listeners below explicitly re-save on every change so
//    sessionStorage never lags behind what's on screen).
function resetActivityLogViewState() {
  activityLogActiveTab = 'general';
  activityLogTypeFilter = '';
  const typeFilterSelect = document.getElementById('select-account-activity-type-filter');
  if (typeFilterSelect) typeFilterSelect.value = '';
}
window.resetActivityLogViewState = resetActivityLogViewState;

function applyActivityLogViewState(activeTab, typeFilter) {
  activityLogActiveTab = activeTab || 'general';
  activityLogTypeFilter = typeFilter || '';
  const typeFilterSelect = document.getElementById('select-account-activity-type-filter');
  if (typeFilterSelect) typeFilterSelect.value = activityLogTypeFilter;
}
window.applyActivityLogViewState = applyActivityLogViewState;

async function fetchActivityLogEntries() {
  if (!currentUser) return [];
  try {
    const snap = await db.collection('users').doc(currentUser.uid).collection('activityLog')
      .orderBy('createdAt', 'desc')
      .limit(300)
      .get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (err) {
    console.warn('Failed to fetch activity log entries:', err);
    return [];
  }
}

function computeUnreadCounts(entries) {
  const byTeam = {};
  let general = 0;
  entries.forEach(e => {
    if (e.read) return;
    if (e.teamId) byTeam[e.teamId] = (byTeam[e.teamId] || 0) + 1;
    else general++;
  });
  const total = Object.values(byTeam).reduce((a, b) => a + b, 0) + general;
  return { total, byTeam, general };
}

// Three separate badge elements now show the same unread total: one on the
// dashboard header's "My Account" button (visible from the Scouting/My Team
// tabs), one on the Join/Create Team screen's own "My Account" button
// (visible to a signed-in user with zero teams), and one on the Account
// page's "Account Activity" button (visible once standalone-mode is open —
// see css's #screen-main.standalone-mode rule). Centralized here so every
// call site that changes read state (mark-one, mark-tab, mark-all, the
// initial fetch) updates all three the same way instead of re-deriving this
// hidden/text logic itself.
function updateActivityBadgeDom() {
  const total = activityLogUnreadCounts.total;
  ['account-activity-nav-badge-header', 'account-activity-nav-badge-team', 'account-activity-nav-badge'].forEach(id => {
    const badge = document.getElementById(id);
    if (!badge) return;
    if (total > 0) {
      badge.textContent = String(total);
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  });
}

// Called from activateDashboardTab() (members.js) on every dashboard tab
// switch, and once after login — kept alongside the live listener below
// (watchActivityLog()) rather than replaced by it, same "a little redundancy
// here is harmless and simpler than coordinating the two" reasoning
// watchMyTeams()/watchTeamDoc() already use for the team doc itself: this
// one-time fetch guarantees a correct snapshot the instant a view opens,
// without waiting on the listener's first callback.
async function refreshActivityBadge() {
  if (!currentUser) return;
  const entries = await fetchActivityLogEntries();
  activityLogEntries = entries;
  activityLogUnreadCounts = computeUnreadCounts(entries);
  updateActivityBadgeDom();
}
window.refreshActivityBadge = refreshActivityBadge;

// ====== Live activity-log listener ======
// users/{uid}/activityLog is per-user, so this is a single listener on the
// current user's own subcollection — no team-scoped fan-out needed, unlike
// watchTeamMemberProfiles() (auth.js). Started once at login (see
// handleAuthenticatedUser(), auth.js) and stopped on sign-out, independent of
// which dashboard tab happens to be active — the unread badge is visible
// from Scouting/My Team too, not just the Account Activity page itself, so
// this can't be scoped to only run while that page is open.
let activityLogUnsubscribe = null;

function watchActivityLog(uid) {
  if (activityLogUnsubscribe) {
    activityLogUnsubscribe();
    activityLogUnsubscribe = null;
  }
  if (!uid) return;

  activityLogUnsubscribe = db.collection('users').doc(uid).collection('activityLog')
    .orderBy('createdAt', 'desc')
    .limit(300)
    .onSnapshot((snap) => {
      activityLogEntries = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      activityLogUnreadCounts = computeUnreadCounts(activityLogEntries);
      updateActivityBadgeDom();
      // Harmless (and cheap, given how infrequent entries are) to refresh
      // these unconditionally rather than gating on whether the Account
      // Activity page happens to be the currently active view — same "just
      // re-render" approach the team-doc-derived listeners already take.
      // Neither call touches activityLogSearchQuery/activityLogTypeFilter,
      // so an in-progress search/filter survives a live update untouched.
      if (typeof renderAccountActivityTabs === 'function') renderAccountActivityTabs();
      if (typeof renderAccountActivityList === 'function') renderAccountActivityList();
    }, (err) => {
      console.warn('Activity log listener error:', err);
    });
}
window.watchActivityLog = watchActivityLog;

function activityLogTabList() {
  const tabs = [];
  const seen = new Set();
  if (typeof myTeams !== 'undefined' && Array.isArray(myTeams)) {
    myTeams.forEach(t => {
      if (seen.has(t.id)) return;
      seen.add(t.id);
      tabs.push({ id: t.id, name: t.name || 'Team' });
    });
  }
  activityLogEntries.forEach(e => {
    if (!e.teamId || seen.has(e.teamId)) return;
    seen.add(e.teamId);
    tabs.push({ id: e.teamId, name: e.teamName || 'Former Team' });
  });
  return tabs;
}

function renderAccountActivityTabs() {
  const container = document.getElementById('account-activity-tabs');
  if (!container) return;
  const teamTabs = activityLogTabList();
  const validIds = ['general', ...teamTabs.map(t => t.id)];
  if (!validIds.includes(activityLogActiveTab)) {
    activityLogActiveTab = 'general';
  }
  const generalUnread = activityLogUnreadCounts.general || 0;
  const tabHtml = [
    `<button class="tab activity-subtab${activityLogActiveTab === 'general' ? ' active' : ''}" data-activity-tab="general">General${generalUnread > 0 ? ` (${generalUnread})` : ''}</button>`
  ].concat(teamTabs.map(t => {
    const unread = activityLogUnreadCounts.byTeam[t.id] || 0;
    return `<button class="tab activity-subtab${activityLogActiveTab === t.id ? ' active' : ''}" data-activity-tab="${t.id}">${escapeHtmlForActivity(t.name)}${unread > 0 ? ` (${unread})` : ''}</button>`;
  }));
  container.innerHTML = tabHtml.join('');
  container.querySelectorAll('[data-activity-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
      activityLogActiveTab = btn.dataset.activityTab;
      renderAccountActivityTabs();
      renderAccountActivityList();
      // Persists the now-active tab into sessionStorage (saveSessionState()
      // reads activityLogActiveTab live — see session-state.js) so a page
      // REFRESH while on this page keeps showing it. Deliberately separate
      // from resetActivityLogViewState() below, which only fires on normal
      // in-app navigation INTO this page (and sign-out) — a refresh is meant
      // to preserve this, not reset it.
      if (typeof saveSessionState === 'function') saveSessionState();
    });
  });
}

function escapeHtmlForActivity(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

function renderAccountActivityList() {
  const listEl = document.getElementById('account-activity-list');
  if (!listEl) return;

  let filtered = activityLogEntries.filter(e => {
    return activityLogActiveTab === 'general' ? !e.teamId : e.teamId === activityLogActiveTab;
  });
  if (activityLogTypeFilter) {
    filtered = filtered.filter(e => e.type === activityLogTypeFilter);
  }
  if (activityLogSearchQuery.trim()) {
    const q = activityLogSearchQuery.trim().toLowerCase();
    filtered = filtered.filter(e => (e.message || '').toLowerCase().includes(q));
  }

  if (filtered.length === 0) {
    listEl.innerHTML = '<p class="help-text" style="padding:12px 0">No activity here yet.</p>';
    return;
  }

  listEl.innerHTML = filtered.map(e => {
    const when = e.createdAt && typeof e.createdAt.toDate === 'function'
      ? formatInUserTimezone(e.createdAt.toDate())
      : '';
    const typeLabel = ACTIVITY_LOG_TYPE_LABELS[e.type] || e.type;
    // Every entry gets a persistent toggle button — "Mark as read" while
    // unread, "Mark as unread" once read — rather than the row itself being
    // clickable (removed per live-testing feedback: an accidental click
    // anywhere on the row used to silently mark it read).
    return `
      <div class="activity-log-entry${e.read ? '' : ' unread'}" data-entry-id="${e.id}">
        <div class="activity-log-entry-main">
          <p class="activity-log-entry-message">${escapeHtmlForActivity(e.message)}</p>
          <p class="help-text activity-log-entry-meta">${escapeHtmlForActivity(typeLabel)} &middot; ${escapeHtmlForActivity(when)}</p>
        </div>
        <div class="activity-log-entry-side">
          <span class="activity-log-unread-dot${e.read ? ' activity-log-unread-dot-hidden' : ''}"${e.read ? '' : ' title="Unread"'}></span>
          <button type="button" class="btn btn-small btn-outline activity-log-entry-toggle-read-btn" data-toggle-read-id="${e.id}">${e.read ? 'Mark as unread' : 'Mark as read'}</button>
        </div>
      </div>`;
  }).join('');

  listEl.querySelectorAll('[data-toggle-read-id]').forEach(btn => {
    btn.addEventListener('click', () => toggleActivityEntryRead(btn.dataset.toggleReadId));
  });
}

// Two-way toggle (not a one-time "mark read") — flips whatever the entry's
// CURRENT read state is, so the same button also un-reads a read entry.
async function toggleActivityEntryRead(entryId) {
  const entry = activityLogEntries.find(e => e.id === entryId);
  if (!entry || !currentUser) return;
  const newReadState = !entry.read;
  entry.read = newReadState; // optimistic
  // Recompute + redraw the tab bar's per-tab unread counts (e.g. "Fe2O3 (1)")
  // immediately, BEFORE the Firestore write resolves — previously this only
  // happened after the write succeeded and something else (a tab switch)
  // triggered a re-render, so the just-toggled entry's tab kept showing its
  // old count until then.
  activityLogUnreadCounts = computeUnreadCounts(activityLogEntries);
  renderAccountActivityTabs();
  renderAccountActivityList();
  updateActivityBadgeDom();
  try {
    await db.collection('users').doc(currentUser.uid).collection('activityLog').doc(entryId).update({ read: newReadState });
  } catch (err) {
    console.warn('Failed to toggle activity log entry read state:', err);
    entry.read = !newReadState;
    activityLogUnreadCounts = computeUnreadCounts(activityLogEntries);
    renderAccountActivityTabs();
    renderAccountActivityList();
    updateActivityBadgeDom();
  }
}

// Scoped to just the currently active sub-tab (General or one team) —
// distinct from markAllActivityReadGlobal() below, which spans every tab.
async function markAllActivityReadInActiveTab() {
  if (!currentUser) return;
  const unreadInTab = activityLogEntries.filter(e => {
    const inTab = activityLogActiveTab === 'general' ? !e.teamId : e.teamId === activityLogActiveTab;
    return inTab && !e.read;
  });
  if (unreadInTab.length === 0) return;
  await markActivityEntriesReadBatch(unreadInTab);
}

// Every unread entry across every tab (General + every team), not just the
// active one — distinct from markAllActivityReadInActiveTab() above.
async function markAllActivityReadGlobal() {
  if (!currentUser) return;
  const unread = activityLogEntries.filter(e => !e.read);
  if (unread.length === 0) return;
  await markActivityEntriesReadBatch(unread);
}

// Shared optimistic-batch-write path for both bulk actions above — same
// "Firestore batches cap at 500 writes; 300 is our own fetch limit, so a
// single batch always covers it" reasoning applies regardless of scope.
async function markActivityEntriesReadBatch(entries) {
  entries.forEach(e => { e.read = true; });
  activityLogUnreadCounts = computeUnreadCounts(activityLogEntries);
  renderAccountActivityTabs();
  renderAccountActivityList();
  updateActivityBadgeDom();

  try {
    const batch = db.batch();
    entries.forEach(e => {
      batch.update(db.collection('users').doc(currentUser.uid).collection('activityLog').doc(e.id), { read: true });
    });
    await batch.commit();
  } catch (err) {
    console.warn('Failed to mark activity log entries read:', err);
    entries.forEach(e => { e.read = false; });
    activityLogUnreadCounts = computeUnreadCounts(activityLogEntries);
    renderAccountActivityTabs();
    renderAccountActivityList();
    updateActivityBadgeDom();
  }
}

async function renderAccountActivity() {
  if (!currentUser) return;
  const listEl = document.getElementById('account-activity-list');
  if (listEl) listEl.innerHTML = '<p class="help-text" style="padding:12px 0">Loading…</p>';

  activityLogEntries = await fetchActivityLogEntries();
  activityLogUnreadCounts = computeUnreadCounts(activityLogEntries);
  renderAccountActivityTabs();
  renderAccountActivityList();
  updateActivityBadgeDom();
}
window.renderAccountActivity = renderAccountActivity;

document.addEventListener('DOMContentLoaded', () => {
  const searchInput = document.getElementById('input-account-activity-search');
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      activityLogSearchQuery = searchInput.value;
      renderAccountActivityList();
    });
  }
  const typeFilter = document.getElementById('select-account-activity-type-filter');
  if (typeFilter) {
    typeFilter.addEventListener('change', () => {
      activityLogTypeFilter = typeFilter.value;
      renderAccountActivityList();
      // Same reasoning as the tab-click listener above — persists the filter
      // for a page refresh, without affecting the separate reset-on-navigate
      // behavior (resetActivityLogViewState()).
      if (typeof saveSessionState === 'function') saveSessionState();
    });
  }
  const markAllBtn = document.getElementById('btn-account-activity-mark-all-read');
  if (markAllBtn) {
    markAllBtn.addEventListener('click', markAllActivityReadGlobal);
  }
  const markTabBtn = document.getElementById('btn-account-activity-mark-tab-read');
  if (markTabBtn) {
    markTabBtn.addEventListener('click', markAllActivityReadInActiveTab);
  }
});
