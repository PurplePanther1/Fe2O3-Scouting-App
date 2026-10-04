// ====== Unofficial Scrimmages (phase 1) ======
// A scrimmage is a team-PRIVATE stand-in for a FIRST event: a doc at
// teams/{teamId}/scrimmages/{scrimmageId} holding its name/season/date, a
// roster map and a matchCount. Its pit/match entries live in the normal
// teams/{teamId}/pitScouting|matchScouting subcollections under the synthetic
// event code 'SCRIM-<scrimmageId>' (plus a scrimmageId field), so every
// per-event cache/key/query in the app keeps working unchanged — see
// isScrimmageCode() (first-api.js) for the guards that keep that code away from
// the FIRST worker, the global events/ collection, FTCScout and the schedule
// logic.
//
// Roster shape (teams map, keyed by team number as a string):
//   { number, name, manualName, linked, location, opr, linkedAt }
// Phase 1 only ever writes linked:false / location:'' / opr:null /
// linkedAt:null — the other fields are there for the FTCScout-linking phase.
//
// Who may do what (enforced in firestore.rules, mirrored client-side):
//   - create / rename-or-change-date / delete a scrimmage, and remove a roster
//     team: canUserManageScrimmages() (captain or canManageScrimmages)
//   - add a roster team / edit a team's name / bump matchCount: any member

let scrimmageList = [];               // [{ id, ...data }] — this team's scrimmages, live
let scrimmagesUnsubscribe = null;
let scrimmagesLoaded = false;

let currentScrimmage = null;          // live data of the OPEN scrimmage: { id, ...data }
let currentScrimmageUnsubscribe = null;
let scrimmageUiActive = false;        // banners/strips/etc. currently shown
let scrimmagePrevMatchViewMode = null;
const scrimmageIdsBeingDeleted = new Set();
let scrimmageLastCanManage = null;

let scrimmageFormEditingId = null;    // null = the form modal is creating
let scrimmageTeamModalState = null;   // { resolve, onSubmit } while the team modal is open

const SCRIMMAGE_MANUAL_TEAM_MAX = 99999;
const SCRIMMAGE_NAME_MAX = 60;
const SCRIMMAGE_BULK_BATCH_SIZE = 500;

function scrimmagesCollection(teamId) {
  return db.collection('teams').doc(teamId).collection('scrimmages');
}

function scrimmageEl(id) {
  return document.getElementById(id);
}

// ====== Live list of this team's scrimmages — started/stopped by
// watchTeamDoc() (auth.js), the single entry/exit point for every per-team
// listener, so it follows team switches, sign-out and removal for free. ======
function watchScrimmages(teamId) {
  stopWatchingScrimmages();
  if (!teamId) return;
  scrimmagesUnsubscribe = scrimmagesCollection(teamId).onSnapshot((snap) => {
    scrimmageList = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    // entrySeason() (first-api.js) resolves a scrimmage's entries through this.
    Object.keys(scrimmageSeasonById).forEach(k => delete scrimmageSeasonById[k]);
    scrimmageList.forEach(s => { if (s.season) scrimmageSeasonById[s.id] = String(s.season); });
    scrimmagesLoaded = true;
    renderScrimmageList();
  }, (err) => {
    console.warn('Scrimmages listener error:', err);
    scrimmagesLoaded = true;
    renderScrimmageList();
  });
}

function stopWatchingScrimmages() {
  if (scrimmagesUnsubscribe) {
    scrimmagesUnsubscribe();
    scrimmagesUnsubscribe = null;
  }
  scrimmageList = [];
  Object.keys(scrimmageSeasonById).forEach(k => delete scrimmageSeasonById[k]);
  scrimmagesLoaded = false;
  renderScrimmageList();
}

// ====== Sort: season descending, then date descending (undated last), then
// createdAt descending (a just-created doc whose serverTimestamp hasn't
// resolved yet counts as newest). ======
function compareScrimmages(a, b) {
  const seasonDiff = Number(b.season) - Number(a.season);
  if (seasonDiff !== 0 && !Number.isNaN(seasonDiff)) return seasonDiff;
  const dateA = a.date || '';
  const dateB = b.date || '';
  if (dateA !== dateB) return dateA < dateB ? 1 : -1;
  const createdA = a.createdAt && a.createdAt.toMillis ? a.createdAt.toMillis() : Infinity;
  const createdB = b.createdAt && b.createdAt.toMillis ? b.createdAt.toMillis() : Infinity;
  if (createdA === createdB) return 0;
  return createdB > createdA ? 1 : -1;
}

function scrimmageTeamCount(scrim) {
  return Object.keys((scrim && scrim.teams) || {}).length;
}

// ====== Scrimmages subtab ======
function renderScrimmageList() {
  const container = scrimmageEl('scrimmage-list');
  const status = scrimmageEl('scrimmages-status');
  const newBtn = scrimmageEl('btn-new-scrimmage');
  if (!container || !status) return;

  const canManage = typeof canUserManageScrimmages === 'function' && canUserManageScrimmages();
  if (newBtn) newBtn.classList.toggle('hidden', !canManage);

  container.innerHTML = '';

  if (!scrimmagesLoaded) {
    status.textContent = currentTeamData && currentTeamData.id ? 'Loading scrimmages...' : '';
    return;
  }
  if (scrimmageList.length === 0) {
    status.textContent = canManage
      ? 'No scrimmages yet — create one with + New Scrimmage.'
      : 'No scrimmages yet. A captain, or a member with scrimmage permission, can create one.';
    return;
  }
  status.textContent = `${scrimmageList.length} scrimmage(s)`;

  [...scrimmageList].sort(compareScrimmages).forEach(scrim => {
    const isOpen = !!(selectedEvent && selectedEvent.isScrimmage && selectedEvent.scrimmageId === scrim.id);

    const item = document.createElement('div');
    item.className = 'event-item scrimmage-item' + (isOpen ? ' selected' : '');
    item.dataset.scrimmageId = scrim.id;

    const textGroup = document.createElement('div');
    textGroup.className = 'scrimmage-item-text';

    const nameRow = document.createElement('div');
    nameRow.className = 'event-name';
    nameRow.appendChild(document.createTextNode(scrim.name || 'Scrimmage'));
    const badge = document.createElement('span');
    badge.className = 'scrimmage-badge';
    badge.textContent = 'UNOFFICIAL';
    nameRow.appendChild(badge);

    const metaParts = [typeof formatFtcSeasonLabel === 'function' ? formatFtcSeasonLabel(scrim.season) : String(scrim.season)];
    if (scrim.date) metaParts.push(scrim.date);
    metaParts.push(`${scrimmageTeamCount(scrim)} teams`);
    if (Number(scrim.matchCount) > 0) metaParts.push(`${scrim.matchCount} matches`);
    const meta = document.createElement('div');
    meta.className = 'event-code scrimmage-meta';
    meta.textContent = metaParts.join(' • ');

    textGroup.appendChild(nameRow);
    textGroup.appendChild(meta);

    // The WHOLE row is the click target (same as the Pinned Events and event
    // search lists): click opens it, clicking the open one again deselects it.
    // The in-flight guard mirrors selectEventLoadingCode's use there — a click
    // landing while THIS scrimmage is still opening must be ignored, not read
    // as "already selected, so toggle it off" (isOpen above is a snapshot from
    // the last render, which happens before selectScrimmage() finishes).
    //
    // ROOT CAUSE of the "clicking a scrimmage does nothing" bug: this used to
    // branch on `isOpen`, a snapshot taken when the row was RENDERED. The list
    // wasn't re-rendered when an official event was searched/selected or the
    // selection was cleared (clearSelectedEvent() only strips the .selected
    // class from the DOM), so the snapshot said "open" while nothing was — and
    // a click took the deselect branch, a silent no-op. Decide from the LIVE
    // selection at click time instead.
    item.addEventListener('click', () => {
      if (selectEventLoadingCode === (scrim.eventCode || (SCRIMMAGE_CODE_PREFIX + scrim.id))) return;
      const openNow = !!(selectedEvent && selectedEvent.isScrimmage && selectedEvent.scrimmageId === scrim.id);
      if (openNow) {
        deselectEventPreservingResults();
      } else {
        openScrimmageFromList(scrim);
      }
    });

    // Buttons are for permission holders only; members get a plain row. Each
    // stops propagation so it never also triggers the row's select/deselect.
    if (canManage) {
      const btnGroup = document.createElement('div');
      btnGroup.className = 'scrimmage-item-actions';

      const manageBtn = document.createElement('button');
      manageBtn.type = 'button';
      manageBtn.className = 'btn btn-small btn-outline btn-scrimmage-manage';
      manageBtn.textContent = 'Manage';
      manageBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openScrimmageFormModal(scrim);
      });
      btnGroup.appendChild(manageBtn);

      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'btn btn-small btn-scrimmage-delete';
      deleteBtn.style.cssText = 'background:var(--error); color:#fff; border-color:var(--error);';
      deleteBtn.textContent = 'Delete';
      deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteScrimmage(scrim);
      });
      btnGroup.appendChild(deleteBtn);

      item.appendChild(textGroup);
      item.appendChild(btnGroup);
    } else {
      item.appendChild(textGroup);
    }
    container.appendChild(item);
  });
}

// ====== Called from refreshActiveTeamData() (auth.js) on every live team-doc
// update — a permission grant/revoke changes which controls show, both in the
// list and (when one is open) on the roster rows. ======
function onScrimmagePermissionsMaybeChanged() {
  const canManage = typeof canUserManageScrimmages === 'function' && canUserManageScrimmages();
  if (canManage === scrimmageLastCanManage) return;
  scrimmageLastCanManage = canManage;
  renderScrimmageList();
  if (currentScrimmage) renderScrimmageRoster();
}

// ====== Open from the list. Stays on the Scrimmages tab (like the Pinned
// Events tab does after a selection) — the banner on every other tab and the
// highlighted row show what's open. ======
async function openScrimmageFromList(scrim) {
  await selectEvent({
    code: scrim.eventCode || (SCRIMMAGE_CODE_PREFIX + scrim.id),
    name: scrim.name,
    isScrimmage: true,
    scrimmageId: scrim.id,
    season: scrim.season
  });
}

// ====== Select (open) a scrimmage — selectEvent()'s scrimmage branch (also
// the session-restore path). No worker, no events/ cache: the doc is read from
// Firestore and then followed live. ======
async function selectScrimmage(eventData) {
  const teamId = currentTeamData && currentTeamData.id;
  const scrimmageId = eventData.scrimmageId || scrimmageIdFromCode(eventData.code);
  if (!teamId || !scrimmageId) {
    clearSelectedEvent();
    return;
  }
  const code = SCRIMMAGE_CODE_PREFIX + scrimmageId;
  if (selectEventLoadingCode === code) return; // already opening this one — ignore the extra click
  selectEventLoadingCode = code;

  showLoading('Opening scrimmage...');
  try {
    let snap;
    try {
      snap = await scrimmagesCollection(teamId).doc(scrimmageId).get();
    } catch (err) {
      hideLoading();
      console.error('Failed to open scrimmage:', err);
      clearSelectedEvent();
      showEventError('Could not open the scrimmage. Check your connection and try again.');
      return;
    }
    hideLoading();

    if (!snap.exists) {
      // A restored selection (or a stale list row) pointing at a scrimmage
      // that's been deleted since.
      clearSelectedEvent();
      if (typeof showNoticeModal === 'function') {
        showNoticeModal({
          title: 'Scrimmage Not Found',
          message: 'That scrimmage no longer exists — it was probably deleted. Your selection has been cleared.'
        });
      }
      return;
    }

    const data = snap.data();

    // Opening a scrimmage ALWAYS clears the event search — the box AND the
    // results list, whether or not the season changes — like picking an event
    // does elsewhere. clearSelectedEvent() drops the previous selection (an
    // official event or another scrimmage) and wipes the results; the box is
    // blanked here, and saveSessionState() below persists that, so a refresh
    // doesn't bring the old search text back.
    clearSelectedEvent();
    const searchInput = scrimmageEl('input-event-search');
    if (searchInput) searchInput.value = '';
    setAppSeasonQuietly(data.season);
    scrimmageSeasonById[scrimmageId] = String(data.season);

    currentScrimmage = { id: scrimmageId, ...data };
    selectedEvent = {
      code,
      name: data.name,
      isScrimmage: true,
      scrimmageId,
      season: data.season
    };

    showScrimmageSelectedEventArea();
    applyScrimmageUi();
    attachScrimmageListener(teamId, scrimmageId);
    renderScrimmageRoster();

    if (typeof watchPitScoutStatus === 'function') watchPitScoutStatus(code);
    if (typeof watchMatchScoutStatus === 'function') watchMatchScoutStatus(code);

    if (typeof saveSessionState === 'function') saveSessionState();
    if (typeof updatePinButtonUI === 'function') updatePinButtonUI();
    renderScrimmageList();
  } finally {
    hideLoading();
    if (selectEventLoadingCode === code) selectEventLoadingCode = null;
  }
}

function showScrimmageSelectedEventArea() {
  const area = scrimmageEl('selected-event-area');
  const nameEl = scrimmageEl('selected-event-name');
  const codeEl = scrimmageEl('selected-event-code');
  if (nameEl) nameEl.textContent = selectedEvent.name;
  if (codeEl) {
    const seasonLabel = typeof formatFtcSeasonLabel === 'function' ? formatFtcSeasonLabel(selectedEvent.season) : selectedEvent.season;
    codeEl.textContent = `Unofficial scrimmage • ${seasonLabel}`;
  }
  if (area) area.classList.remove('hidden');
}

// ====== After the app's season switched underneath an open selection (a
// scrimmage re-seasoned in Manage, or a pin/scrimmage from another season),
// any search results on screen belong to the OLD season: clear them and the
// search box, exactly what the season <select>'s own change handler does. ======
function clearStaleEventSearch() {
  const searchInput = scrimmageEl('input-event-search');
  if (searchInput) searchInput.value = '';
  lastRenderedEventResults = null;
  const results = scrimmageEl('event-results');
  if (results) results.innerHTML = '';
}

// ====== Live roster/metadata for the open scrimmage. ======
function attachScrimmageListener(teamId, scrimmageId) {
  if (currentScrimmageUnsubscribe) currentScrimmageUnsubscribe();
  currentScrimmageUnsubscribe = scrimmagesCollection(teamId).doc(scrimmageId).onSnapshot({ includeMetadataChanges: true }, (snap) => {
    if (!currentScrimmage || currentScrimmage.id !== scrimmageId) return;
    if (!snap.exists) {
      // A cache-only "doesn't exist" isn't proof of deletion — wait for the
      // server (same reasoning as live-entry-sync.js's serverConfirmed).
      if (snap.metadata.fromCache) return;
      handleOpenScrimmageDeleted(scrimmageId);
      return;
    }
    const data = snap.data();
    const renamed = selectedEvent && selectedEvent.name !== data.name;
    const seasonChanged = selectedEvent && String(selectedEvent.season) !== String(data.season);
    currentScrimmage = { id: scrimmageId, ...data };
    scrimmageSeasonById[scrimmageId] = String(data.season);
    if (renamed || seasonChanged) {
      selectedEvent.name = data.name;
      selectedEvent.season = data.season;
      if (seasonChanged) {
        // Everything season-scoped follows the open scrimmage: the app's season
        // dropdown (quietly — its change handler would deselect the scrimmage),
        // and the event search, whose results belong to the OLD season.
        if (setAppSeasonQuietly(data.season)) clearStaleEventSearch();
      }
      showScrimmageSelectedEventArea();
      applyScrimmageUi();
      if (typeof saveSessionState === 'function') saveSessionState();
    }
    renderScrimmageRoster();
    renderScrimmageList();
  }, (err) => {
    console.warn('Open scrimmage listener error:', err);
  });
}

// ====== The open scrimmage was deleted. The deleter's own client already
// knows (and reports its own result); everyone else gets one clear notice —
// modeled on handleRemovedFromTeam()/onEntryDeleted. Any open pit/match form
// is force-closed first (its entry is being or has been deleted). ======
function handleOpenScrimmageDeleted(scrimmageId) {
  const name = (currentScrimmage && currentScrimmage.name) || 'The scrimmage';
  const deletedHere = scrimmageIdsBeingDeleted.has(scrimmageId);

  if (typeof forceClosePitLiveSessionForTeam === 'function') forceClosePitLiveSessionForTeam();
  if (typeof forceCloseMatchLiveSessionForTeam === 'function') forceCloseMatchLiveSessionForTeam();
  closeScrimmageTeamModal(null);
  clearSelectedEvent();

  if (!deletedHere && typeof showNoticeModal === 'function') {
    showNoticeModal({
      title: 'Scrimmage Deleted',
      message: `"${name}" was deleted by a teammate, so it has been closed.`
    });
  }
}

// ====== Called by clearSelectedEvent()/selectEvent() (first-api.js): stop
// following the open scrimmage and put back every control it hid. ======
function detachScrimmageSelection() {
  if (currentScrimmageUnsubscribe) {
    currentScrimmageUnsubscribe();
    currentScrimmageUnsubscribe = null;
  }
  currentScrimmage = null;
  if (!scrimmageUiActive) return;
  scrimmageUiActive = false;

  document.querySelectorAll('[data-scrimmage-banner]').forEach(el => el.classList.add('hidden'));
  document.querySelectorAll('[data-scrimmage-only]').forEach(el => el.classList.add('hidden'));

  if (scrimmagePrevMatchViewMode !== null && typeof matchViewMode !== 'undefined') {
    matchViewMode = scrimmagePrevMatchViewMode;
    scrimmagePrevMatchViewMode = null;
    if (typeof applyMatchViewMode === 'function') applyMatchViewMode();
  }
  renderScrimmageList();
}

// ====== Banners on Info/Pit/Match/Compare, the roster controls, and Team View
// forced on (no schedule, so no Match View/Refresh Scores). ======
function applyScrimmageUi() {
  const text = `SCRIMMAGE: ${selectedEvent.name} — Unofficial, not FIRST data`;
  document.querySelectorAll('[data-scrimmage-banner]').forEach(el => {
    const textEl = el.querySelector('.scrimmage-banner-text');
    if (textEl) textEl.textContent = text;
    el.classList.remove('hidden');
  });
  document.querySelectorAll('[data-scrimmage-only]').forEach(el => el.classList.remove('hidden'));

  if (!scrimmageUiActive && typeof matchViewMode !== 'undefined') {
    scrimmagePrevMatchViewMode = matchViewMode;
  }
  if (typeof matchViewMode !== 'undefined') {
    matchViewMode = 'team';
    if (typeof applyMatchViewMode === 'function') applyMatchViewMode();
  }
  if (typeof hideMatchViewToggle === 'function') hideMatchViewToggle();
  scrimmageUiActive = true;
}

// ====== Roster -> the team-object shape every team list already renders. ======
function scrimmageRosterToTeams(scrim) {
  return Object.entries((scrim && scrim.teams) || {}).map(([key, t]) => {
    const number = Number(t && t.number != null ? t.number : key);
    const name = (t && t.name) || '';
    return {
      teamNumber: number,
      name,
      nameShort: name,
      opr: t && typeof t.opr === 'number' ? t.opr : null,
      isScrimmageTeam: true,
      linked: !!(t && t.linked === true),
      manualName: (t && t.manualName) || '',
      location: (t && t.location) || ''
    };
  }).filter(t => Number.isFinite(t.teamNumber)).sort((a, b) => a.teamNumber - b.teamNumber);
}

function renderScrimmageRoster() {
  if (!currentScrimmage) return;
  const teams = scrimmageRosterToTeams(currentScrimmage);
  // The list renderers return early on an empty roster without touching
  // currentEventTeams, so set it here first or a stale roster would linger.
  currentEventTeams = teams;
  const countEl = scrimmageEl('selected-event-teams-count');
  if (countEl) countEl.textContent = `${teams.length} team(s) on roster`;
  renderTeamList(teams);
  if (typeof applyTeamSearchFilter === 'function') applyTeamSearchFilter(currentTeamSearchQuery);
}

// The scrimmage doc data for ANY of this team's scrimmages — the open one's
// live copy, else its row in the live list (the Manage modal adds teams to a
// scrimmage that isn't open).
function scrimmageDataFor(scrimmageId) {
  if (currentScrimmage && currentScrimmage.id === scrimmageId) return currentScrimmage;
  return scrimmageList.find(s => s.id === scrimmageId) || null;
}

function getScrimmageRosterTeam(number, scrimmageId = currentScrimmage && currentScrimmage.id) {
  const scrim = scrimmageId ? scrimmageDataFor(scrimmageId) : null;
  if (!scrim || !scrim.teams) return null;
  return scrim.teams[String(number)] || null;
}

// ====== Team-number validation: a positive integer up to 99999. ======
function parseScrimmageTeamNumber(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return (n >= 1 && n <= SCRIMMAGE_MANUAL_TEAM_MAX) ? n : null;
}

function scrimmageRosterFieldPath(number, field) {
  return field
    ? new firebase.firestore.FieldPath('teams', String(number), field)
    : new firebase.firestore.FieldPath('teams', String(number));
}

function buildRosterEntry(number, name) {
  const cleanName = String(name || '').trim().slice(0, SCRIMMAGE_NAME_MAX);
  return {
    number,
    name: cleanName,
    manualName: cleanName,
    linked: false,
    location: '',
    opr: null,
    linkedAt: null
  };
}

// ====== PHASE 3 REPLACES THE BODY OF THIS FUNCTION with the name/number
// conflict flow. Everything that adds a team to a scrimmage — the Info tab's
// Add Team to Roster, the Pit/Match "Add & scout a team" buttons, and the
// Manage modal's Add Team — goes through here and nowhere else.
//
// Phase 1: if `number` is already on the roster, use the existing team as-is
// (no conflict detection); otherwise add it (blank/optional name) in a
// transaction so two scouts adding at once can't clobber each other. Defaults
// to the OPEN scrimmage, but takes an id because the Manage modal adds teams
// to a scrimmage that isn't open. Resolves to { team, created } — or throws
// (the caller shows the message). ======
async function resolveTeamForScouting(number, name, scrimmageId = currentScrimmage && currentScrimmage.id) {
  const teamId = currentTeamData && currentTeamData.id;
  const n = parseScrimmageTeamNumber(number);
  if (!scrimmageId || !teamId || n === null) throw new Error('Invalid team or no scrimmage selected.');

  const ref = scrimmagesCollection(teamId).doc(scrimmageId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new Error('This scrimmage no longer exists.');
    const existing = (snap.data().teams || {})[String(n)];
    if (existing) return { team: existing, created: false };
    const entry = buildRosterEntry(n, name);
    tx.update(ref, scrimmageRosterFieldPath(n), entry);
    return { team: entry, created: true };
  });
}

// ====== The add-team prompt, shared by every entry point. `mode`:
//   'scout'  — "Add & Scout a Team" (Pit/Match tabs): the caller opens a
//              scouting form afterward.
//   'roster' — "Add Team to Roster" (Info tab, Manage modal): just adds.
// The add happens INSIDE the modal's submit (so a failure keeps it open), and
// the returned promise resolves only once the modal has fully CLOSED — which
// is what lets a caller open a pit/match form afterward with nothing stacked
// behind it (the pit form's join() writes a draft doc the instant it opens, so
// it must never open for a team that isn't on the roster yet). A number that is
// already on the roster skips the add and resolves with the existing team.
// Resolves to { team, created } or null if cancelled. ======
async function addTeamFlow({ scrimmageId = currentScrimmage && currentScrimmage.id, mode = 'roster' } = {}) {
  const scout = mode === 'scout';
  return openScrimmageTeamModal({
    title: scout ? 'Add & Scout a Team' : 'Add Team to Roster',
    submitLabel: scout ? 'Add & Scout' : 'Add Team',
    initialNumber: '',
    numberLocked: false,
    initialName: '',
    onSubmit: async ({ number, name }) => {
      try {
        return { value: await resolveTeamForScouting(number, name, scrimmageId) };
      } catch (err) {
        console.error('Failed to add scrimmage team:', err);
        return { error: err && err.code === 'permission-denied' ? 'You do not have permission to add teams.' : 'Could not add the team. Check your connection and try again.' };
      }
    }
  });
}

// ====== Pit / Match tabs: "+ Add & scout a team". Finish the whole add flow
// FIRST (modal fully closed), THEN open the form — see addTeamFlow(). ======
async function addAndScoutTeam(kind) {
  if (!currentScrimmage || !selectedEvent) return;
  const code = selectedEvent.code;

  let result;
  try {
    result = await addTeamFlow({ mode: 'scout' });
  } catch (err) {
    console.error('Add & scout failed:', err);
    if (typeof showNoticeModal === 'function') showNoticeModal({ title: 'Could Not Add Team', message: 'Something went wrong adding the team. Please try again.' });
    return;
  }
  if (!result) return; // cancelled — nothing to open

  const n = result.team.number;
  if (kind === 'pit' && typeof openPitScoutForm === 'function') {
    openPitScoutForm(n, code);
  } else if (kind === 'match' && typeof openMatchScoutForm === 'function') {
    openMatchScoutForm(n, code);
  }
}

// ====== Info tab: [+ Add Team to Roster] ======
async function handleAddTeamButton() {
  if (!currentScrimmage) return;
  let result;
  try {
    result = await addTeamFlow({ mode: 'roster' });
  } catch (err) {
    setStatusMessage('scrimmage-roster', 'error', 'Could not add the team.');
    return;
  }
  if (!result) return;
  const n = result.team.number;
  setStatusMessage('scrimmage-roster', 'success', result.created
    ? `Added Team #${n} to the roster.`
    : `Team #${n} is already on this scrimmage's roster.`);
}

// ====== Name-only edit of a roster team (any member). The name lives ONLY in
// the roster — pit/match entries store teamNumber alone and look the name up
// from the roster when rendered/exported — so there is no per-entry header to
// rewrite, and every viewer sees the new name as soon as the roster snapshot
// lands. A transaction so an edit can't resurrect a team someone just removed. ======
async function editScrimmageTeamName(team) {
  const teamId = currentTeamData && currentTeamData.id;
  if (!currentScrimmage || !teamId) return;
  const scrimmageId = currentScrimmage.id;
  await openScrimmageTeamModal({
    title: `Edit Team #${team.teamNumber}`,
    submitLabel: 'Save',
    initialNumber: String(team.teamNumber),
    numberLocked: true,
    initialName: team.name || '',
    onSubmit: async ({ number, name }) => {
      try {
        const ref = scrimmagesCollection(teamId).doc(scrimmageId);
        const cleanName = name.slice(0, SCRIMMAGE_NAME_MAX);
        await db.runTransaction(async (tx) => {
          const snap = await tx.get(ref);
          if (!snap.exists) throw new Error('This scrimmage no longer exists.');
          if (!(snap.data().teams || {})[String(number)]) throw new Error('That team is no longer on the roster.');
          tx.update(ref,
            scrimmageRosterFieldPath(number, 'name'), cleanName,
            scrimmageRosterFieldPath(number, 'manualName'), cleanName);
        });
        return { value: true };
      } catch (err) {
        console.error('Failed to edit scrimmage team name:', err);
        return { error: err && err.code === 'permission-denied' ? 'You do not have permission to edit this team.' : (err && err.message) || 'Could not save. Try again.' };
      }
    }
  });
}

// ====== Remove a roster team — permission holders only. Mirrors the normal-
// event team Delete (createTeamScoutingDeleteButton()/deleteTeamScoutingData(),
// team-info.js): a danger confirm that lists exactly what will be permanently
// deleted, then the existing per-entry delete helpers (deletePitScoutEntry,
// bulkDeleteMatchScoutData — both go through deleteEntryWithNotice(), so a
// teammate with that entry open gets the usual "deleted by X" disconnect and
// the scouted-state caches update the same way).
//
// The entry check is a direct query (not the live caches, which skip
// uncommitted drafts) so a draft is listed and deleted too. Entries go FIRST
// and the roster team LAST: if anything fails part-way the team is still on the
// roster and Remove can simply be run again. ======
async function removeScrimmageTeam(team) {
  const teamId = currentTeamData && currentTeamData.id;
  if (!currentScrimmage || !teamId || !selectedEvent) return;
  const code = selectedEvent.code;
  const scrimmageId = currentScrimmage.id;
  const n = team.teamNumber;
  const label = `Team #${n}${team.name ? ` (${team.name})` : ''}`;

  showLoading('Checking for scouting entries...');
  let pitDocs, matchDocs;
  try {
    const base = db.collection('teams').doc(teamId);
    const [pitSnap, matchSnap] = await Promise.all([
      base.collection('pitScouting').where('eventCode', '==', code).where('teamNumber', '==', n).get(),
      base.collection('matchScouting').where('eventCode', '==', code).where('teamNumber', '==', n).get()
    ]);
    pitDocs = pitSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    matchDocs = matchSnap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (Number(a.matchNumber) || 0) - (Number(b.matchNumber) || 0));
  } catch (err) {
    hideLoading();
    console.error('Failed to check entries before removing team:', err);
    if (typeof showNoticeModal === 'function') showNoticeModal({ title: 'Could Not Remove Team', message: 'Could not check for scouting entries. Check your connection and try again.' });
    return;
  }
  hideLoading();

  const removeRosterTeam = async () => {
    await scrimmagesCollection(teamId).doc(scrimmageId).update(scrimmageRosterFieldPath(n), firebase.firestore.FieldValue.delete());
  };

  // No entries: the plain confirm, as before.
  if (pitDocs.length === 0 && matchDocs.length === 0) {
    showConfirmModal({
      title: 'Remove Team',
      message: `Remove ${label} from this scrimmage's roster?`,
      confirmLabel: 'Remove',
      danger: true,
      onConfirm: async () => {
        try {
          await removeRosterTeam();
        } catch (err) {
          console.error('Failed to remove scrimmage team:', err);
          showNoticeModal({ title: 'Could Not Remove Team', message: 'Failed to remove the team. Check your connection and permissions.' });
        }
      }
    });
    return;
  }

  // With entries: list exactly what goes.
  const parts = [];
  if (pitDocs.length > 0) parts.push(`${pitDocs.length} pit entry`);
  if (matchDocs.length > 0) {
    const numbers = matchDocs.map(d => (d.matchNumber != null ? `Match ${d.matchNumber}` : 'a match draft'));
    parts.push(`${matchDocs.length} match entr${matchDocs.length === 1 ? 'y' : 'ies'} (${numbers.join(', ')})`);
  }
  showConfirmModal({
    title: 'Remove Team and Delete Its Entries?',
    message: `Remove ${label} from this scrimmage? This permanently deletes ${parts.join(' and ')}, then removes the team from the roster. This cannot be undone.`,
    confirmLabel: 'Delete & Remove',
    danger: true,
    onConfirm: async () => {
      showLoading('Deleting entries...');
      let failed = false;
      try {
        if (pitDocs.length > 0 && typeof deletePitScoutEntry === 'function') {
          try {
            await deletePitScoutEntry(teamId, code, n);
          } catch (err) {
            console.error('Failed to delete pit entry while removing team:', n, err);
            failed = true;
          }
        }
        if (matchDocs.length > 0 && typeof bulkDeleteMatchScoutData === 'function') {
          const results = await bulkDeleteMatchScoutData(matchDocs.map(d => d.id));
          if (results.failed.length > 0) failed = true;
        }
        if (!failed) await removeRosterTeam();
      } catch (err) {
        console.error('Failed to remove scrimmage team:', err);
        failed = true;
      } finally {
        hideLoading();
      }
      if (failed) {
        showNoticeModal({
          title: 'Remove Incomplete',
          message: `${label} could not be fully removed (permission denied, or a connection issue). Nothing else is lost — the team is still on the roster, so you can run Remove again.`
        });
      }
    }
  });
}

// ====== Called by renderTeamInfoList() (team-info.js) for each roster row of
// an open scrimmage: [Edit] for every member, [Remove] for permission holders. ======
function appendScrimmageTeamRowActions(btnGroup, team) {
  if (!selectedEvent || !selectedEvent.isScrimmage) return;

  const editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.className = 'btn btn-small btn-outline btn-scrimmage-team-edit';
  editBtn.style.cssText = 'width:auto; padding:4px 8px; font-size:0.8rem;';
  editBtn.textContent = 'Edit';
  editBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    editScrimmageTeamName(team);
  });
  btnGroup.appendChild(editBtn);

  if (typeof canUserManageScrimmages === 'function' && canUserManageScrimmages()) {
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'btn btn-small btn-outline btn-scrimmage-team-remove';
    removeBtn.style.cssText = 'width:auto; padding:4px 8px; font-size:0.8rem;';
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      removeScrimmageTeam(team);
    });
    btnGroup.appendChild(removeBtn);
  }
}

// ====== matchCount: the highest match number scouted in this scrimmage (a
// scrimmage has no schedule to count from). Called after a match entry saves
// (match-scout.js). A transaction that only ever raises it, matching the
// increase-only rule in firestore.rules, so two scouts saving at once can't
// lower it. ======
async function bumpScrimmageMatchCount(eventCode, matchNumber) {
  const teamId = currentTeamData && currentTeamData.id;
  const scrimmageId = scrimmageIdFromCode(eventCode);
  const n = Number(matchNumber);
  if (!teamId || !scrimmageId || !Number.isInteger(n) || n < 1 || n > 9999) return;
  try {
    const ref = scrimmagesCollection(teamId).doc(scrimmageId);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return;
      if (n > (Number(snap.data().matchCount) || 0)) tx.update(ref, { matchCount: n });
    });
  } catch (err) {
    console.warn('Failed to update scrimmage matchCount:', err);
  }
}

// ====== { teamNumber: name } for exports (sheets-export.js's
// getEventTeamNameMap) — the roster instead of the global events/ cache. ======
async function getScrimmageTeamNameMap(scrimmageId) {
  const map = {};
  let teams = null;
  if (currentScrimmage && currentScrimmage.id === scrimmageId) {
    teams = currentScrimmage.teams;
  } else {
    const teamId = currentTeamData && currentTeamData.id;
    if (!teamId) return map;
    const snap = await scrimmagesCollection(teamId).doc(scrimmageId).get();
    teams = snap.exists ? (snap.data().teams || {}) : {};
  }
  Object.entries(teams || {}).forEach(([key, t]) => {
    const number = Number(t && t.number != null ? t.number : key);
    if (Number.isFinite(number)) map[number] = (t && t.name) || '';
  });
  return map;
}

// ====== Create / Manage modal ======
// One modal, two modes. Creating: name, season, optional date. Managing (permission
// holders only, opened from a row's [Manage]): the same three fields — all
// editable, season included — plus "+ Add Team" (adds to THAT scrimmage by id,
// open or not) and a Delete button at the bottom. Every field and status line is
// reset on every open AND every close, so nothing from one scrimmage can show
// up in another.
function resetScrimmageFormModalFields() {
  const nameInput = scrimmageEl('input-scrimmage-name');
  const dateInput = scrimmageEl('input-scrimmage-date');
  if (nameInput) nameInput.value = '';
  if (dateInput) dateInput.value = '';
  const err = scrimmageEl('scrimmage-form-error');
  if (err) err.textContent = '';
  clearStatusMessage('scrimmage-manage-team');
  const saveBtn = scrimmageEl('btn-scrimmage-form-save');
  if (saveBtn) saveBtn.disabled = false;
}

function openScrimmageFormModal(scrim) {
  scrimmageFormEditingId = scrim ? scrim.id : null;
  const modal = scrimmageEl('scrimmage-form-modal');
  const title = scrimmageEl('scrimmage-form-title');
  const nameInput = scrimmageEl('input-scrimmage-name');
  const seasonSelect = scrimmageEl('select-scrimmage-season');
  const dateInput = scrimmageEl('input-scrimmage-date');
  if (!modal) return;

  resetScrimmageFormModalFields();
  if (title) title.textContent = scrim ? 'Manage Scrimmage' : 'New Scrimmage';

  // The app's own season options and labels (first-api.js) — defaults to the
  // current FTC season for a new scrimmage, the scrimmage's own season when managing.
  populateSeasonSelectOptions(seasonSelect, scrim ? scrim.season : getCurrentFtcSeason());

  if (nameInput) nameInput.value = scrim ? (scrim.name || '') : '';
  if (dateInput) dateInput.value = scrim && scrim.date ? scrim.date : '';

  scrimmageEl('scrimmage-manage-extras').classList.toggle('hidden', !scrim);
  scrimmageEl('scrimmage-season-help').classList.toggle('hidden', !scrim);
  const saveBtn = scrimmageEl('btn-scrimmage-form-save');
  if (saveBtn) saveBtn.textContent = scrim ? 'Save' : 'Create';

  modal.classList.remove('hidden');
  if (nameInput) nameInput.focus();
}

function closeScrimmageFormModal() {
  const modal = scrimmageEl('scrimmage-form-modal');
  if (modal) modal.classList.add('hidden');
  scrimmageFormEditingId = null;
  resetScrimmageFormModalFields();
}

async function saveScrimmageForm() {
  const teamId = currentTeamData && currentTeamData.id;
  const errEl = scrimmageEl('scrimmage-form-error');
  const saveBtn = scrimmageEl('btn-scrimmage-form-save');
  const name = (scrimmageEl('input-scrimmage-name').value || '').trim();
  const season = scrimmageEl('select-scrimmage-season').value;
  const date = (scrimmageEl('input-scrimmage-date').value || '').trim();

  if (!teamId) return;
  if (!name) { errEl.textContent = 'Please enter a name.'; return; }
  if (name.length > SCRIMMAGE_NAME_MAX) { errEl.textContent = `Name must be ${SCRIMMAGE_NAME_MAX} characters or fewer.`; return; }
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) { errEl.textContent = 'Date must look like YYYY-MM-DD.'; return; }
  if (!/^20\d{2}$/.test(String(season))) { errEl.textContent = 'Pick a season.'; return; }
  errEl.textContent = '';
  saveBtn.disabled = true;

  try {
    if (scrimmageFormEditingId) {
      const scrim = scrimmageDataFor(scrimmageFormEditingId);
      const seasonChanged = !!scrim && String(scrim.season) !== String(season);

      // Name/date-only edits (and an unchanged season) never prompt.
      if (seasonChanged) {
        // A season change swaps the form fields, so this scrimmage's entries
        // can't be kept. A DIRECT query (not the live caches, which skip
        // uncommitted drafts) says whether there is anything to lose.
        let entries;
        try {
          entries = await queryScrimmageEntries(teamId, scrim.eventCode);
        } catch (err) {
          console.error('Failed to check scrimmage entries before a season change:', err);
          errEl.textContent = "Couldn't check this scrimmage's entries. Check your connection and try again.";
          saveBtn.disabled = false;
          return;
        }
        if (entries.pit.length + entries.match.length > 0) {
          // Danger confirm. Nothing is written until the user confirms; Cancel,
          // the X and a click on the overlay all leave the Manage modal exactly
          // as it is.
          saveBtn.disabled = false;
          promptSeasonChange({ scrim, fields: { name, date, season }, entries });
          return;
        }
      }
      // No entries to lose: save straight away. A season change with no entries
      // also zeroes a stale matchCount (there are no matches to count).
      await writeScrimmageEdit(scrimmageFormEditingId, { name, date, season },
        { resetMatchCount: seasonChanged && Number(scrim.matchCount) > 0 });
    } else {
      const ref = scrimmagesCollection(teamId).doc();
      const data = {
        name,
        season: String(season),
        eventCode: SCRIMMAGE_CODE_PREFIX + ref.id,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        teams: {},
        matchCount: 0
      };
      if (date) data.date = date;
      await ref.set(data);
    }
    closeScrimmageFormModal();
  } catch (err) {
    console.error('Failed to save scrimmage:', err);
    saveBtn.disabled = false;
    errEl.textContent = err && err.code === 'permission-denied'
      ? 'You do not have permission to do that.'
      : 'Failed to save. Check your connection and try again.';
  }
}

// The one write behind Manage's Save: name/season/date (+ matchCount reset).
// Clearing the date deletes the field. An unchanged season isn't part of the
// write's diff at all.
async function writeScrimmageEdit(scrimmageId, { name, date, season }, { resetMatchCount = false } = {}) {
  const teamId = currentTeamData && currentTeamData.id;
  const update = {
    name,
    season: String(season),
    date: date || firebase.firestore.FieldValue.delete()
  };
  if (resetMatchCount) update.matchCount = 0;
  await scrimmagesCollection(teamId).doc(scrimmageId).update(update);
}

// ====== Changing a scrimmage's season: the confirm, "Export First", and the
// delete-then-write ======

// Every pit/match entry of a scrimmage — a direct query, so uncommitted drafts
// count too. Resolves to { pit: [QueryDocumentSnapshot], match: [...] }.
async function queryScrimmageEntries(teamId, eventCode) {
  const base = db.collection('teams').doc(teamId);
  const [pitSnap, matchSnap] = await Promise.all([
    base.collection('pitScouting').where('eventCode', '==', eventCode).get(),
    base.collection('matchScouting').where('eventCode', '==', eventCode).get()
  ]);
  return { pit: pitSnap.docs, match: matchSnap.docs };
}

// [{ teamNumber, pit, match }] sorted by team number — who has data.
function summarizeEntriesByTeam(entries) {
  const byTeam = new Map();
  const bump = (doc, key) => {
    const n = Number(doc.data().teamNumber);
    if (!byTeam.has(n)) byTeam.set(n, { teamNumber: n, pit: 0, match: 0 });
    byTeam.get(n)[key] += 1;
  };
  entries.pit.forEach(d => bump(d, 'pit'));
  entries.match.forEach(d => bump(d, 'match'));
  return Array.from(byTeam.values()).sort((a, b) => a.teamNumber - b.teamNumber);
}

// Kept short on purpose: what happens, the totals, up to 5 per-team lines, and
// that the roster survives.
function buildSeasonChangeMessage(newSeason, entries, note) {
  const summary = summarizeEntriesByTeam(entries);
  const seasonLabel = formatFtcSeasonLabel(newSeason);
  const lines = [];
  if (note) lines.push(note, '');
  lines.push(`Changing the season to ${seasonLabel} deletes all scouting entries in this scrimmage, because the form fields change. ${summary.length} team${summary.length === 1 ? ' has' : 's have'} data: ${entries.pit.length} pit and ${entries.match.length} match entries.`);
  summary.slice(0, 5).forEach(t => lines.push(`#${t.teamNumber} — ${t.pit} pit, ${t.match} match`));
  if (summary.length > 5) lines.push(`and ${summary.length - 5} more team${summary.length - 5 === 1 ? '' : 's'}`);
  lines.push("The teams stay on the roster. This can't be undone.");
  return lines.join('\n');
}

// Three actions: [Delete & Change Season] (danger), [Export First], [Cancel].
// Built on showConfirmModal's optional secondary action (members.js), so it
// layers at z-index 1002 above the Manage modal. Cancel / X / overlay do
// nothing — nothing has been written yet.
function promptSeasonChange({ scrim, fields, entries, note }) {
  showConfirmModal({
    title: 'Change Season and Delete Entries?',
    message: buildSeasonChangeMessage(fields.season, entries, note),
    multiline: true,
    confirmLabel: 'Delete & Change Season',
    danger: true,
    secondaryLabel: 'Export First',
    onSecondary: () => exportScrimmageThenReconfirm({ scrim, fields, entries }),
    onConfirm: () => performSeasonChange({ scrim, fields })
  });
}

// "Export First": the normal Excel/Sheets choice, for THIS scrimmage (open or
// not — the per-event gather takes an event code + team id, and the name map
// comes from getScrimmageTeamNameMap()), exported under its CURRENT (old)
// season since nothing has changed yet. Then back to the confirm — after an
// export finishes (with its result as a note) or if the choice is dismissed.
function exportScrimmageThenReconfirm({ scrim, fields, entries }) {
  const back = (note) => promptSeasonChange({ scrim, fields, entries, note });
  openExportChoiceModal({
    title: 'Export Scrimmage Data',
    statusPrefix: 'scrimmage-export',
    excelHandler: async () => back((await exportScrimmageData(scrim, 'excel')).message),
    sheetsHandler: async () => back((await exportScrimmageData(scrim, 'sheets')).message),
    onDismiss: () => back()
  });
}

// Mirrors handleExportEventExcelClick()/handleExportEventClick() (sheets-export.js),
// which read the SELECTED event; this takes the scrimmage explicitly.
async function exportScrimmageData(scrim, kind) {
  const teamId = currentTeamData && currentTeamData.id;
  const code = scrim.eventCode || (SCRIMMAGE_CODE_PREFIX + scrim.id);
  try {
    if (kind === 'sheets') {
      showLoading('Waiting for Google authorization...');
      await getGoogleAccessToken();
    }
    showLoading('Gathering scouting data...');
    const { pitFields, matchFields, pitDocs, matchDocs } = await gatherEventExportData(code, teamId);
    if (kind === 'sheets') {
      showLoading('Creating Google Sheet...');
      const { spreadsheetUrl } = await withStep('Creating/writing Google Sheet', () =>
        exportToNewSpreadsheet(`${scrim.name} — All Teams Scouting Export`, pitFields, pitDocs, matchFields, matchDocs));
      hideLoading();
      window.open(spreadsheetUrl, '_blank');
      return { ok: true, message: 'Export complete — the sheet opened in a new tab.' };
    }
    await downloadScoutingWorkbook(sanitizeFilename(`${scrim.name} - All Teams Scouting.xlsx`), pitFields, pitDocs, matchFields, matchDocs);
    hideLoading();
    return { ok: true, message: 'Excel file downloaded.' };
  } catch (err) {
    hideLoading();
    console.error('Scrimmage export failed:', err);
    return { ok: false, message: `Export failed: ${err.message || 'please try again'}.` };
  }
}

// The confirmed change. Order matters, so a partial failure is just retried:
//   1. re-query the entries NOW (someone may have added one since the confirm)
//   2. close MY pit/match form if it is open on this scrimmage
//   3. delete every entry, in batches of 500 — FIRST
//   4. write name/date/season + matchCount: 0 in ONE update — LAST
// If step 4 fails after step 3, the scrimmage is still on its old season but has
// no entries, so Save in Manage simply goes through (no entries -> no prompt).
// A teammate with one of those entries open: the entry vanishes under their live
// session, whose built-in fallback (live-entry-sync.js — a batch delete can't
// stamp a "deleted by" notice) closes their form and shows "Entry Deleted: This
// entry was deleted by another editor while you had it open. Your changes were
// not saved."
async function performSeasonChange({ scrim, fields }) {
  const teamId = currentTeamData && currentTeamData.id;
  if (!teamId) return;
  const code = scrim.eventCode || (SCRIMMAGE_CODE_PREFIX + scrim.id);

  showLoading('Deleting entries...');
  let entriesDeleted = false;
  try {
    const entries = await queryScrimmageEntries(teamId, code);

    if (typeof currentPitEventCode !== 'undefined' && currentPitEventCode === code && typeof forceClosePitLiveSessionForTeam === 'function') {
      forceClosePitLiveSessionForTeam();
    }
    if (typeof currentMatchEventCode !== 'undefined' && currentMatchEventCode === code && typeof forceCloseMatchLiveSessionForTeam === 'function') {
      forceCloseMatchLiveSessionForTeam();
    }

    await deleteDocRefsInBatches([...entries.pit.map(d => d.ref), ...entries.match.map(d => d.ref)]);
    entriesDeleted = true;

    await writeScrimmageEdit(scrim.id, fields, { resetMatchCount: true });
    hideLoading();
    closeScrimmageFormModal();
  } catch (err) {
    hideLoading();
    console.error('Season change failed:', err);
    if (entriesDeleted) {
      showNoticeModal({
        title: 'Season Not Changed',
        message: "This scrimmage's entries were deleted, but saving the new season failed (check your connection and permissions). It is still on its old season, with no entries — open Manage and Save again to finish."
      });
    } else {
      showNoticeModal({
        title: 'Season Change Incomplete',
        message: err && err.code === 'permission-denied'
          ? 'You do not have permission to do that.'
          : 'Not every entry could be deleted, so the season was NOT changed. Some entries may already be gone — open Manage and Save again to retry.'
      });
    }
  }
}

// ====== Manage modal: "+ Add Team" — to THIS scrimmage, whether or not it is
// the open one. ======
async function handleManageAddTeam() {
  const scrimmageId = scrimmageFormEditingId;
  if (!scrimmageId) return;
  let result;
  try {
    result = await addTeamFlow({ scrimmageId, mode: 'roster' });
  } catch (err) {
    setStatusMessage('scrimmage-manage-team', 'error', 'Could not add the team.');
    return;
  }
  if (!result) return;
  const n = result.team.number;
  setStatusMessage('scrimmage-manage-team', 'success', result.created
    ? `Added Team #${n} to the roster.`
    : `Team #${n} is already on this scrimmage's roster.`);
}

// ====== Add Team / Edit Team modal (promise-based) ======
// Resolves once the modal has CLOSED, with whatever onSubmit returned as
// { value } — or null if cancelled. onSubmit returns { value } to close or
// { error } to stay open and show it. Number, name, error and button state are
// reset on every open AND every close, so nothing typed for one team ever
// reappears for the next.
function resetScrimmageTeamModalFields() {
  const numberInput = scrimmageEl('input-scrimmage-team-number');
  const nameInput = scrimmageEl('input-scrimmage-team-name');
  const saveBtn = scrimmageEl('btn-scrimmage-team-save');
  if (numberInput) { numberInput.value = ''; numberInput.disabled = false; }
  if (nameInput) nameInput.value = '';
  const err = scrimmageEl('scrimmage-team-error');
  if (err) err.textContent = '';
  if (saveBtn) saveBtn.disabled = false;
}

function openScrimmageTeamModal({ title, submitLabel, initialNumber, numberLocked, initialName, onSubmit }) {
  return new Promise((resolve) => {
    if (scrimmageTeamModalState) closeScrimmageTeamModal(null);
    scrimmageTeamModalState = { resolve, onSubmit };

    resetScrimmageTeamModalFields();
    scrimmageEl('scrimmage-team-title').textContent = title;
    const numberInput = scrimmageEl('input-scrimmage-team-number');
    const nameInput = scrimmageEl('input-scrimmage-team-name');
    numberInput.value = initialNumber || '';
    numberInput.disabled = !!numberLocked;
    nameInput.value = initialName || '';
    scrimmageEl('btn-scrimmage-team-save').textContent = submitLabel;

    scrimmageEl('scrimmage-team-modal').classList.remove('hidden');
    // An empty number box is always focused first; when the number is fixed
    // (editing a name) the name box is.
    (numberLocked ? nameInput : numberInput).focus();
  });
}

function closeScrimmageTeamModal(value) {
  const state = scrimmageTeamModalState;
  scrimmageTeamModalState = null;
  const modal = scrimmageEl('scrimmage-team-modal');
  if (modal) modal.classList.add('hidden');
  resetScrimmageTeamModalFields();
  if (state) state.resolve(value === undefined ? null : value);
}

async function submitScrimmageTeamModal() {
  const state = scrimmageTeamModalState;
  if (!state) return;
  const errEl = scrimmageEl('scrimmage-team-error');
  const saveBtn = scrimmageEl('btn-scrimmage-team-save');

  const number = parseScrimmageTeamNumber(scrimmageEl('input-scrimmage-team-number').value);
  if (number === null) {
    errEl.textContent = `Enter a team number from 1 to ${SCRIMMAGE_MANUAL_TEAM_MAX}.`;
    return;
  }
  const name = (scrimmageEl('input-scrimmage-team-name').value || '').trim();
  errEl.textContent = '';
  saveBtn.disabled = true;
  try {
    const result = await state.onSubmit({ number, name });
    if (result && result.error) {
      errEl.textContent = result.error;
      return;
    }
    closeScrimmageTeamModal(result ? result.value : null);
  } finally {
    saveBtn.disabled = false;
  }
}

// ====== Delete (cascade) — from a list row's [Delete] or the Manage modal's
// Delete button (same confirm, same cascade). `onDeleted` runs once the
// scrimmage is actually gone (the Manage modal closes itself with it; a
// cancelled confirm leaves the Manage modal open). ======
async function deleteScrimmage(scrim, { onDeleted } = {}) {
  const teamId = currentTeamData && currentTeamData.id;
  if (!teamId) return;
  const code = scrim.eventCode || (SCRIMMAGE_CODE_PREFIX + scrim.id);
  const base = db.collection('teams').doc(teamId);

  showLoading('Counting entries...');
  let pitCount, matchCount;
  try {
    const [pitSnap, matchSnap] = await Promise.all([
      base.collection('pitScouting').where('eventCode', '==', code).get(),
      base.collection('matchScouting').where('eventCode', '==', code).get()
    ]);
    pitCount = pitSnap.size;
    matchCount = matchSnap.size;
  } catch (err) {
    hideLoading();
    console.error('Failed to count scrimmage entries:', err);
    showNoticeModal({ title: 'Could Not Delete Scrimmage', message: 'Could not read the scrimmage\'s entries. Check your connection and try again.' });
    return;
  }
  hideLoading();

  showConfirmModal({
    title: 'Delete Scrimmage',
    message: `Delete "${scrim.name}"? This permanently deletes ${scrimmageTeamCount(scrimmageDataFor(scrim.id) || scrim)} teams / ${pitCount} pit / ${matchCount} match entries and can't be undone.`,
    confirmLabel: 'Delete',
    danger: true,
    onConfirm: () => performDeleteScrimmage(scrim, { onDeleted })
  });
}

// Every entry first (batches of up to 500), the scrimmage doc LAST: the rules'
// cascade-delete clause (canDeleteScrimmageEntry) needs the scrimmage doc to
// still exist, and a partial failure leaves the scrimmage in place so running
// the delete again just picks up where it stopped.
async function performDeleteScrimmage(scrim, { onDeleted } = {}) {
  const teamId = currentTeamData && currentTeamData.id;
  if (!teamId) return;
  const code = scrim.eventCode || (SCRIMMAGE_CODE_PREFIX + scrim.id);
  const base = db.collection('teams').doc(teamId);

  scrimmageIdsBeingDeleted.add(scrim.id);
  showLoading('Deleting scrimmage...');
  try {
    const [pitSnap, matchSnap] = await Promise.all([
      base.collection('pitScouting').where('eventCode', '==', code).get(),
      base.collection('matchScouting').where('eventCode', '==', code).get()
    ]);
    const refs = [...pitSnap.docs.map(d => d.ref), ...matchSnap.docs.map(d => d.ref)];
    await deleteDocRefsInBatches(refs);
    await scrimmagesCollection(teamId).doc(scrim.id).delete();

    hideLoading();
    if (selectedEvent && selectedEvent.scrimmageId === scrim.id) clearSelectedEvent();
    if (typeof onDeleted === 'function') onDeleted();
  } catch (err) {
    hideLoading();
    console.error('Failed to delete scrimmage:', err);
    showNoticeModal({
      title: 'Delete Incomplete',
      message: err && err.code === 'permission-denied'
        ? 'You do not have permission to delete this scrimmage.'
        : 'The scrimmage could not be fully deleted. Nothing is lost — it is still there, and running Delete again will finish the job.'
    });
  } finally {
    scrimmageIdsBeingDeleted.delete(scrim.id);
  }
}

// Shared by the scrimmage delete (and written so a later re-key, which also
// deletes entries by reference, can reuse it).
async function deleteDocRefsInBatches(refs) {
  for (let i = 0; i < refs.length; i += SCRIMMAGE_BULK_BATCH_SIZE) {
    const batch = db.batch();
    refs.slice(i, i + SCRIMMAGE_BULK_BATCH_SIZE).forEach(r => batch.delete(r));
    await batch.commit();
  }
}

// ====== Wiring ======
document.addEventListener('DOMContentLoaded', () => {
  const on = (id, evt, fn) => { const el = scrimmageEl(id); if (el) el.addEventListener(evt, fn); };

  on('btn-new-scrimmage', 'click', () => openScrimmageFormModal(null));
  on('btn-scrimmage-form-cancel', 'click', closeScrimmageFormModal);
  on('btn-scrimmage-form-close', 'click', closeScrimmageFormModal);
  on('scrimmage-form-modal-overlay', 'click', closeScrimmageFormModal);
  on('btn-scrimmage-form-save', 'click', saveScrimmageForm);
  on('input-scrimmage-name', 'keydown', (e) => { if (e.key === 'Enter') saveScrimmageForm(); });
  on('btn-scrimmage-manage-add-team', 'click', handleManageAddTeam);
  on('btn-scrimmage-manage-delete', 'click', () => {
    const scrim = scrimmageFormEditingId ? scrimmageDataFor(scrimmageFormEditingId) : null;
    if (scrim) deleteScrimmage(scrim, { onDeleted: closeScrimmageFormModal });
  });

  on('btn-scrimmage-add-team', 'click', handleAddTeamButton);
  on('btn-scrimmage-team-cancel', 'click', () => closeScrimmageTeamModal(null));
  on('btn-scrimmage-team-close', 'click', () => closeScrimmageTeamModal(null));
  on('scrimmage-team-modal-overlay', 'click', () => closeScrimmageTeamModal(null));
  on('btn-scrimmage-team-save', 'click', submitScrimmageTeamModal);
  ['input-scrimmage-team-number', 'input-scrimmage-team-name'].forEach(id => {
    on(id, 'keydown', (e) => { if (e.key === 'Enter') submitScrimmageTeamModal(); });
  });

  // Pit / Match tabs: "+ Add & scout a team".
  ['pit', 'match'].forEach(kind => {
    on(`btn-scrimmage-add-scout-${kind}`, 'click', () => addAndScoutTeam(kind));
  });
});
