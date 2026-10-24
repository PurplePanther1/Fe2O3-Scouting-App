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
// A team starts UNLINKED (linked:false / location:'' / opr:null / linkedAt:null,
// name == manualName == whatever was typed). Linking it to its FTCScout profile
// (js/ftc-team-lookup.js) sets name = the official name, linked:true, location,
// opr, linkedAt and LEAVES manualName alone — that is what remembers what a
// scout typed, so the bulk link can warn before overwriting it. There is no
// unlink. FTCScout data is never shown for an unlinked team (its number is just
// what was typed; #99999 is a real FTCScout team).
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
  updateScrimmageBulkLinkButton();
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

const SCRIMMAGE_OFFICIAL_NAME_MAX = 120;

// The roster fields linking sets, from a normalized FTCScout team
// (normalizeFtcTeam() / an openFtcTeamLookup 'linked' result). manualName is
// deliberately NOT here.
function ftcLinkFields(ftc) {
  return {
    name: String(ftc.name || '').trim().slice(0, SCRIMMAGE_OFFICIAL_NAME_MAX),
    linked: true,
    location: ftc.location || '',
    opr: typeof ftc.opr === 'number' ? ftc.opr : null,
    linkedAt: firebase.firestore.FieldValue.serverTimestamp()
  };
}

// Unlinked by default; with `ftc` the entry is created already LINKED: name is the
// official name (replacing anything typed), manualName keeps what was typed.
function buildRosterEntry(number, name, ftc) {
  const typed = String(name || '').trim().slice(0, SCRIMMAGE_NAME_MAX);
  const entry = {
    number,
    name: typed,
    manualName: typed,
    linked: false,
    location: '',
    opr: null,
    linkedAt: null
  };
  return ftc ? { ...entry, ...ftcLinkFields(ftc) } : entry;
}

// ====== Everything that adds a team to a scrimmage — the Info tab's Add Team to
// Roster, the Pit/Match "Add & scout a team" buttons, and the Manage modal's Add
// Team — goes through here and nowhere else.
//
// Phase 3 decision: the ADD flows keep the inline "already on the roster" error (a
// brand-new team has nothing to merge, and the lookup popup never merges either).
// Merging two teams is started ONLY from the Edit modal's Save (scrimmage-merge.js).
//
// An existing number is never re-added or re-linked here (created:false); otherwise
// the team is added (blank/optional name) in a transaction so two scouts adding at
// once can't clobber each other. `ftc` (optional, a 'linked' lookup result) adds it
// already linked to its FTCScout profile. Defaults
// to the OPEN scrimmage, but takes an id because the Manage modal adds teams
// to a scrimmage that isn't open. Resolves to { team, created } — or throws
// (the caller shows the message). ======
async function resolveTeamForScouting(number, name, scrimmageId = currentScrimmage && currentScrimmage.id, ftc = null) {
  const teamId = currentTeamData && currentTeamData.id;
  const n = parseScrimmageTeamNumber(number);
  if (!scrimmageId || !teamId || n === null) throw new Error('Invalid team or no scrimmage selected.');

  const ref = scrimmagesCollection(teamId).doc(scrimmageId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new Error('This scrimmage no longer exists.');
    const existing = (snap.data().teams || {})[String(n)];
    if (existing) return { team: existing, created: false };
    const entry = buildRosterEntry(n, name, ftc);
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
// it must never open for a team that isn't on the roster yet).
//
// A number that is ALREADY on the roster is an error shown inline in the modal
// (and in the FTCScout lookup popup): the modal stays open so the number can be
// changed, or the whole thing cancelled. (This used to quietly reuse the
// existing team and close — including for Add & scout. It no longer does.)
// Resolves to { team, created } or null if cancelled. ======
function scrimmageDuplicateNumberMessage(n) {
  return `Team #${n} is already on this scrimmage's roster. Change the number or cancel.`;
}

async function addTeamFlow({ scrimmageId = currentScrimmage && currentScrimmage.id, mode = 'roster' } = {}) {
  const scout = mode === 'scout';
  const scrim = scrimmageDataFor(scrimmageId);
  return openScrimmageTeamModal({
    title: scout ? 'Add & Scout a Team' : 'Add Team to Roster',
    submitLabel: scout ? 'Add & Scout' : 'Add Team',
    initialNumber: '',
    numberLocked: false,
    initialName: '',
    validateNumber: (n) => (getScrimmageRosterTeam(n, scrimmageId) ? scrimmageDuplicateNumberMessage(n) : ''),
    // The FTCScout lookup step: "Look up on FTCScout" in the modal opens the
    // shared lookup (js/ftc-team-lookup.js) for the scrimmage's own season, with
    // its own editable number box kept in sync with this modal's.
    lookup: {
      mode: 'add',
      season: scrim ? scrim.season : getSelectedSeason(),
      confirmLabel: scout ? 'Add & Scout (Linked)' : 'Add Linked Team'
    },
    onSubmit: async ({ number, name, ftc }) => {
      try {
        const res = await resolveTeamForScouting(number, name, scrimmageId, ftc || null);
        // Not created = a teammate added this number a moment ago (the check
        // above only knows the roster as of the last snapshot).
        if (!res.created) return { error: scrimmageDuplicateNumberMessage(number) };
        return { value: res };
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
  setStatusMessage('scrimmage-roster', 'success', `Added Team #${result.team.number} to the roster.`);
}

// ====== Can this team's NUMBER be changed (roster Edit)? Only a MANAGER can: renumbering
// re-keys the roster (remove the old key, add the new one), which firestore.rules only
// lets canManageScrimmages / the captain do, and moving the team's scouting entries
// (see scrimmage-merge.js) relies on the same permission to delete the old docs.
// A team WITH scouting data is fine since phase 3 — its entries travel with it; the
// result carries their counts so the Edit modal can say so. Empty never-committed drafts
// (the shells a cancelled pit/match form leaves behind) are not data; the move sweeps
// them. What blocks is a draft/entry someone ELSE has open right now (fresh presence, see
// isPresenceFresh()): the result NAMES them.
//
// Live renumber — letting that person keep saving under the new number — was
// RECONSIDERED for phase 3 and is still deliberately NOT built: the pit doc id embeds the
// number and live-entry-sync is bound to that one doc, so the entry would have to be
// re-pointed under an open session (with debounced field writes in flight and a
// presence heartbeat running). The cost of blocking is a short wait; the cost of getting
// that wrong is a lost or split entry. Revisit only with a real need.
//
// Resolves { ok: true, counts: { pit, match } } (committed entries) or
//   { ok: false, reason: 'permission' | 'editing' | 'error', names? }. ======
async function checkScrimmageRenumber(scrimmageId, number) {
  if (!(typeof canUserManageScrimmages === 'function' && canUserManageScrimmages())) return { ok: false, reason: 'permission' };
  const teamId = currentTeamData && currentTeamData.id;
  const scrim = scrimmageDataFor(scrimmageId);
  if (!teamId || !scrim) return { ok: false, reason: 'error' };
  const code = scrim.eventCode || (SCRIMMAGE_CODE_PREFIX + scrimmageId);
  try {
    const entries = await readScrimmageTeamEntries(teamId, code, number);
    const names = otherFreshEditorNames(scrimmageEntryDocs(entries));
    if (names.length > 0) return { ok: false, reason: 'editing', names };
    return { ok: true, counts: scrimmageEntryCounts(entries) };
  } catch (err) {
    console.error('Failed to check scrimmage team entries before a renumber:', err);
    return { ok: false, reason: 'error' };
  }
}

// "Jordan is editing..." / "Jordan and Sam are editing..." / "A, B and C are editing..."
// `merge`: the wording for merging two teams instead of changing one number.
function scrimmageEditingMessage(names, { merge = false } = {}) {
  const list = names.length <= 1 ? (names[0] || 'Someone')
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  const verb = names.length <= 1 ? 'is' : 'are';
  return merge
    ? `${list} ${verb} editing a scouting entry for one of these teams. Wait until they are finished before merging them.`
    : `${list} ${verb} editing a scouting entry for this team. Wait until they are finished before changing its number.`;
}

// The line under a locked number box, from a checkScrimmageRenumber() result.
function scrimmageRenumberHint(check) {
  const reason = check && check.reason;
  if (reason === 'permission') return "Changing a team's number needs a captain or scrimmage permission.";
  if (reason === 'editing') return scrimmageEditingMessage(check.names || []);
  return "Couldn't check this team's scouting data, so its number can't change right now.";
}

// The note under an UNLOCKED number box when the team has scouting data that will travel.
function scrimmageRenumberTravelHint(check) {
  const c = check && check.counts;
  const total = c ? c.pit + c.match : 0;
  if (total === 0) return '';
  return `This team's ${total} scouting ${total === 1 ? 'entry moves' : 'entries move'} with it if you change the number.`;
}

// ====== Edit a roster team (any member). A small state machine, all STAGED — nothing
// is written until Save, and Cancel / X / click-out discards every staged change
// (reopening always starts from the saved state):
//   A  UNLINKED   name editable; number editable when renumbering is allowed (see
//                 checkScrimmageRenumber()); button "Link to FTCScout"
//   B  PENDING LINK  a team was picked in the lookup popup: its OFFICIAL name sits in
//                 the read-only name box, the number is locked to the picked team's;
//                 button "Unlink" discards the staged link (name back to what it was)
//   C  LINKED     name AND number read-only; button "Unlink from FTCScout"
//   D  PENDING UNLINK  name unlocks (text kept), number unlocks when allowed; button
//                 "Link to FTCScout" again — so "unlink, change the number, link the NEW
//                 number" works without closing the modal
// Save writes whatever is staged in ONE transaction: a name edit, a link, an unlink, a
// renumber (roster re-key), or a link at a changed number (re-key + link fields). The
// name lives ONLY in the roster — pit/match entries store teamNumber alone and look
// the name up from the roster when rendered/exported. Transactions, so an edit can't
// resurrect a team someone just removed. ======
async function editScrimmageTeamName(team) {
  const teamId = currentTeamData && currentTeamData.id;
  if (!currentScrimmage || !teamId) return;
  const scrimmageId = currentScrimmage.id;
  await openScrimmageTeamModal({
    title: `Edit Team #${team.teamNumber}`,
    submitLabel: 'Save',
    initialNumber: String(team.teamNumber),
    numberLocked: true,           // locked until the renumber check says otherwise
    initialName: team.name || '',
    lookup: {
      mode: 'edit',
      scrimmageId,
      number: team.teamNumber,
      season: currentScrimmage.season,
      linked: team.linked === true
    },
    onSubmit: async ({ number, name, link, unlink, nameBeforeLink, merge }) => {
      try {
        const ref = scrimmagesCollection(teamId).doc(scrimmageId);
        const cleanName = name.slice(0, SCRIMMAGE_NAME_MAX);
        const oldNumber = team.teamNumber;
        const changed = number !== oldNumber;
        const fieldsAt = (n, pairs) => Object.entries(pairs).flatMap(([k, v]) => [scrimmageRosterFieldPath(n, k), v]);

        // A linked team with nothing staged has nothing to save (and writing the
        // read-only name back would clobber manualName).
        if (team.linked === true && !unlink && !link) return { value: true };
        if (link && link.number !== number) return { error: 'The picked FTCScout team no longer matches the number. Pick the team again.' };

        // What the roster entry becomes. A link: the official name replaces the roster
        // name and what was in the box before linking is kept as manualName. Anything
        // else leaves the team unlinked with the name from the box.
        const fields = link
          ? { ...ftcLinkFields(link), manualName: String(nameBeforeLink || '').slice(0, SCRIMMAGE_NAME_MAX) }
          : (team.linked === true
            ? { name: cleanName, manualName: cleanName, linked: false, location: '', opr: null, linkedAt: null }
            : { name: cleanName, manualName: cleanName });

        // Same number: a plain in-place roster edit.
        if (!changed) {
          await db.runTransaction(async (tx) => {
            const snap = await tx.get(ref);
            if (!snap.exists) throw new Error('This scrimmage no longer exists.');
            if (!(snap.data().teams || {})[String(oldNumber)]) throw new Error('That team is no longer on the roster.');
            tx.update(ref, ...fieldsAt(number, fields));
          });
          return { value: true };
        }

        // The number is another roster team's: a MANAGER may merge (staged choice in the
        // modal, then the confirm / Compare screen — scrimmage-merge.js). Nothing is
        // written until that flow's own final confirm. (Only managers ever get a
        // changeable number box, so this is never reached by anyone else.)
        if (getScrimmageRosterTeam(number, scrimmageId)) {
          if (link) return { error: scrimmageDuplicateNumberMessage(number) };
          if (!merge) return { mergeChoice: { number, name: getScrimmageRosterTeam(number, scrimmageId).name || '' } };
          const res = await mergeScrimmageTeams({ scrimmageId, from: oldNumber, to: number, fromName: cleanName });
          if (res.error) return { error: res.error };
          if (res.status === 'cancelled') return { stay: true };
          setStatusMessage('scrimmage-roster', 'success', `Merged Team #${oldNumber} into Team #${number}.`);
          offerMoveCleanupRetry(res.leftovers, `Merging #${oldNumber} into #${number}`);
          return { value: true };
        }

        // A free number: renumber — the team's scouting entries (if any) travel with it.
        // Re-check NOW (an entry or an editor may have appeared since the box unlocked).
        const check = await checkScrimmageRenumber(scrimmageId, oldNumber);
        if (!check.ok) return { error: scrimmageRenumberHint(check) };
        const rosterStep = () => db.runTransaction(async (tx) => {
          const snap = await tx.get(ref);
          if (!snap.exists) throw new Error('This scrimmage no longer exists.');
          const roster = snap.data().teams || {};
          if (!roster[String(oldNumber)]) throw new Error('That team is no longer on the roster.');
          if (roster[String(number)]) throw new Error(scrimmageDuplicateNumberMessage(number));
          const entry = { ...roster[String(oldNumber)], number, ...fields };
          tx.update(ref, scrimmageRosterFieldPath(oldNumber), firebase.firestore.FieldValue.delete(), scrimmageRosterFieldPath(number), entry);
        });
        const travelling = check.counts.pit + check.counts.match;
        if (travelling > 0) showLoading('Moving scouting entries...');
        let res;
        try {
          res = await executeScrimmageMove({ scrimmageId, from: oldNumber, to: number, mode: 'rename', rosterStep });
        } finally {
          if (travelling > 0) hideLoading();
        }
        if (travelling > 0) setStatusMessage('scrimmage-roster', 'success', `Team #${oldNumber} is now #${number}. ${scrimmageMoveCountsText(check.counts.pit, check.counts.match)} moved with it.`);
        offerMoveCleanupRetry(res.leftovers, `Renumbering #${oldNumber} to #${number}`);
        return { value: true };
      } catch (err) {
        console.error('Failed to edit scrimmage team:', err);
        if (err instanceof ScrimmageMoveError) return { error: scrimmageMoveErrorMessage(err) };
        return { error: err && err.code === 'permission-denied' ? 'You do not have permission to edit this team.' : (err && err.message) || 'Could not save. Try again.' };
      }
    }
  });
}

// ====== Linking to FTCScout (any member — it is a roster edit) ======

// Writes the link fields for ONE team (name = official, linked, location, opr,
// linkedAt; manualName untouched) and patches the local copy of the roster so
// the UI doesn't wait for the snapshot listener. Throws on failure.
async function linkScrimmageTeamInRoster(scrimmageId, number, ftc) {
  const teamId = currentTeamData && currentTeamData.id;
  if (!teamId) throw new Error('No team loaded.');
  const ref = scrimmagesCollection(teamId).doc(scrimmageId);
  const fields = ftcLinkFields(ftc);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new Error('This scrimmage no longer exists.');
    if (!(snap.data().teams || {})[String(number)]) throw new Error('That team is no longer on the roster.');
    tx.update(ref, ...Object.entries(fields).flatMap(([k, v]) => [scrimmageRosterFieldPath(number, k), v]));
  });
  if (currentScrimmage && currentScrimmage.id === scrimmageId && currentScrimmage.teams && currentScrimmage.teams[String(number)]) {
    Object.assign(currentScrimmage.teams[String(number)], fields, { linkedAt: new Date() });
    renderScrimmageRoster();
  }
}

// Team Details -> "Link to FTCScout" on an unlinked team (ftcscout.js). Linking
// just overwrites the roster name with the official one (what was typed is kept
// as manualName) — no preview. Afterwards the open Team Details modal reloads,
// now with the real FTCScout data.
async function linkScrimmageTeamFromDetail(team, teamNumber) {
  if (!currentScrimmage || !selectedEvent) return;
  const scrimmageId = currentScrimmage.id;
  const code = selectedEvent.code;
  const result = await openFtcTeamLookup({
    title: `Link Team #${teamNumber} to FTCScout`,
    season: currentScrimmage.season,
    initialNumber: teamNumber,
    numberLocked: true,
    confirmLabel: 'Link Team',
    onConfirm: async (r) => {
      try {
        await linkScrimmageTeamInRoster(scrimmageId, teamNumber, r);
      } catch (err) {
        console.error('Failed to link scrimmage team:', err);
        return { error: err && err.code === 'permission-denied' ? 'You do not have permission to edit this team.' : (err && err.message) || 'Could not save. Try again.' };
      }
    }
  });
  if (!result || currentSelectedTeamNumber !== teamNumber || !currentScrimmage || currentScrimmage.id !== scrimmageId) return;
  const updated = scrimmageRosterToTeams(currentScrimmage).find(t => t.teamNumber === Number(teamNumber));
  if (updated) openTeamDetailModal(teamNumber, code, updated);
}

const SCRIMMAGE_BULK_LINK_CHUNK = 25;

// Unlinked teams on the open roster.
function unlinkedScrimmageTeams() {
  return currentScrimmage ? scrimmageRosterToTeams(currentScrimmage).filter(t => t.linked !== true) : [];
}

// Info tab: "Bulk link teams (N)" — shown while N > 0.
function updateScrimmageBulkLinkButton() {
  const btn = scrimmageEl('btn-scrimmage-bulk-link');
  const help = scrimmageEl('scrimmage-bulk-link-help');
  if (!btn) return;
  const n = unlinkedScrimmageTeams().length;
  btn.textContent = `Bulk link teams (${n})`;
  btn.classList.toggle('hidden', n === 0);
  if (help) help.classList.toggle('hidden', n === 0);
}

// One batched lookup (fetchTeamDetailsBatch, chunked) of `numbers` for `season`.
// Resolves { number: normalized FTCScout team } for the ones FTCScout knows;
// throws if FTCScout can't be reached.
async function lookupFtcTeamsBatch(numbers, season) {
  const found = {};
  for (let i = 0; i < numbers.length; i += SCRIMMAGE_BULK_LINK_CHUNK) {
    const batch = await fetchTeamDetailsBatch(numbers.slice(i, i + SCRIMMAGE_BULK_LINK_CHUNK), season);
    Object.entries(batch).forEach(([n, detail]) => {
      found[n] = normalizeFtcTeam(buildTeamDetailObject(Number(n), detail, season));
    });
  }
  return found;
}

// ====== Bulk link: look up first, ask second, write last.
// "Bulk link teams (N)" does the ONE batched FTCScout lookup for the unlinked
// teams (the scrimmage's season) and writes NOTHING. If FTCScout knows none of
// them, a notice says so. Otherwise the review popup lists the found teams as
// checkboxes (all checked; "typed -> official" when the name would change) and
// the not-found ones without checkboxes; only the checked teams are linked, in
// one transaction, and only when the confirm button is pressed. Cancel / X /
// click-out discard everything. The review IS the confirmation — no second
// confirm. A failed lookup changes nothing and shows a short auto-clearing error. ======
let bulkLinkState = null; // { scrimmageId, matches: [{ number, ftc }], checked: Set<number> }

async function linkUnlinkedScrimmageTeams() {
  const scrim = currentScrimmage;
  const teamId = currentTeamData && currentTeamData.id;
  const btn = scrimmageEl('btn-scrimmage-bulk-link');
  if (!scrim || !teamId) return;
  clearStatusMessage('scrimmage-roster');
  const unlinked = unlinkedScrimmageTeams();
  if (unlinked.length === 0) return;
  const season = String(scrim.season);

  btn.disabled = true;
  showLoading('Looking up teams on FTCScout...');
  let found;
  try {
    found = await lookupFtcTeamsBatch(unlinked.map(t => t.teamNumber), season);
  } catch (err) {
    hideLoading();
    btn.disabled = false;
    console.error('Bulk FTCScout link lookup failed:', err);
    setStatusMessage('scrimmage-roster', 'error', "Couldn't reach FTCScout. Check your connection and try again — nothing was changed.");
    return;
  }
  hideLoading();
  btn.disabled = false;

  const matches = [];
  const notFound = [];
  unlinked.forEach(t => {
    const ftc = found[t.teamNumber];
    if (ftc) matches.push({ number: t.teamNumber, typed: (t.name || '').trim(), ftc });
    else notFound.push({ number: t.teamNumber, typed: (t.name || '').trim() });
  });

  if (matches.length === 0) {
    showNoticeModal({
      title: 'No Teams Found',
      message: `FTCScout doesn't have ${unlinked.length === 1 ? 'this team' : 'any of these teams'}: ${notFound.map(t => `#${t.number}`).join(', ')}. ${unlinked.length === 1 ? 'It stays' : 'They stay'} unlinked.`
    });
    return;
  }
  openBulkLinkReview({ scrimmageId: scrim.id, season, matches, notFound });
}

function resetBulkLinkModal() {
  ['bulk-link-found', 'bulk-link-notfound'].forEach((id) => {
    const el = scrimmageEl(id);
    if (el) el.replaceChildren();
  });
  const intro = scrimmageEl('bulk-link-intro');
  if (intro) intro.textContent = '';
  const group = scrimmageEl('bulk-link-notfound-group');
  if (group) group.classList.add('hidden');
  const confirm = scrimmageEl('btn-bulk-link-confirm');
  if (confirm) { confirm.disabled = false; confirm.textContent = 'Link teams'; }
}

function bulkLinkRowText(m) {
  // "Alpha -> Alpha Bots" only when the name would actually change (a typed name
  // that is blank or the same, ignoring case, just shows the official one).
  return m.typed && m.typed.toLowerCase() !== m.ftc.name.toLowerCase() ? `${m.typed} -> ${m.ftc.name}` : m.ftc.name;
}

function updateBulkLinkConfirm() {
  const state = bulkLinkState;
  const confirm = scrimmageEl('btn-bulk-link-confirm');
  if (!state || !confirm) return;
  const n = state.checked.size;
  confirm.textContent = n === 0 ? 'Link teams' : `Link ${n} team${n === 1 ? '' : 's'}`;
  confirm.disabled = n === 0;
}

function openBulkLinkReview({ scrimmageId, season, matches, notFound }) {
  resetBulkLinkModal();
  bulkLinkState = { scrimmageId, matches, checked: new Set(matches.map(m => m.number)) };

  const seasonLabel = `${season}-${Number(season) + 1}`;
  scrimmageEl('bulk-link-intro').textContent = `Checked against FTCScout for the ${seasonLabel} season. Uncheck any team you don't want linked — linking replaces its name with the official one.`;

  const list = scrimmageEl('bulk-link-found');
  matches.forEach(m => {
    const row = document.createElement('label');
    row.className = 'bulk-link-row';
    row.dataset.teamNumber = m.number;
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = true;
    box.addEventListener('change', () => {
      if (box.checked) bulkLinkState.checked.add(m.number); else bulkLinkState.checked.delete(m.number);
      updateBulkLinkConfirm();
    });
    const num = document.createElement('span');
    num.className = 'bulk-link-number';
    num.textContent = `#${m.number}`;
    const text = document.createElement('span');
    text.className = 'bulk-link-text';
    text.textContent = bulkLinkRowText(m);
    row.append(box, num, text);
    list.appendChild(row);
  });

  if (notFound.length > 0) {
    scrimmageEl('bulk-link-notfound-group').classList.remove('hidden');
    const nfList = scrimmageEl('bulk-link-notfound');
    notFound.forEach(t => {
      const row = document.createElement('div');
      row.className = 'bulk-link-row is-plain';
      row.dataset.teamNumber = t.number;
      const num = document.createElement('span');
      num.className = 'bulk-link-number';
      num.textContent = `#${t.number}`;
      const text = document.createElement('span');
      text.textContent = t.typed;
      row.append(num, text);
      nfList.appendChild(row);
    });
  }

  updateBulkLinkConfirm();
  scrimmageEl('bulk-link-modal').classList.remove('hidden');
}

// Cancel / X / click-out / after a confirm: hide and forget everything.
function closeBulkLinkReview() {
  bulkLinkState = null;
  const modal = scrimmageEl('bulk-link-modal');
  if (modal) modal.classList.add('hidden');
  resetBulkLinkModal();
}

function setBulkLinkChecked(all) {
  const state = bulkLinkState;
  if (!state) return;
  state.checked = new Set(all ? state.matches.map(m => m.number) : []);
  document.querySelectorAll('#bulk-link-found .bulk-link-row input').forEach(box => { box.checked = all; });
  updateBulkLinkConfirm();
}

// Writes ONLY the checked teams (still on the roster and still unlinked), in one
// transaction. Same link write as every other path: name = official, manualName
// untouched, linked / location / opr / linkedAt.
async function confirmBulkLinkReview() {
  const state = bulkLinkState;
  const teamId = currentTeamData && currentTeamData.id;
  if (!state || !teamId || state.checked.size === 0) return;
  const chosen = state.matches.filter(m => state.checked.has(m.number));
  const scrimmageId = state.scrimmageId;
  closeBulkLinkReview();

  showLoading('Linking teams...');
  try {
    const ref = scrimmagesCollection(teamId).doc(scrimmageId);
    let linkedCount = 0;
    await db.runTransaction(async (tx) => {
      linkedCount = 0;
      const snap = await tx.get(ref);
      if (!snap.exists) throw new Error('This scrimmage no longer exists.');
      const roster = snap.data().teams || {};
      const args = [];
      chosen.forEach(({ number, ftc }) => {
        const existing = roster[String(number)];
        if (!existing || existing.linked === true) return; // removed or linked by a teammate meanwhile
        Object.entries(ftcLinkFields(ftc)).forEach(([k, v]) => args.push(scrimmageRosterFieldPath(number, k), v));
        linkedCount += 1;
      });
      if (args.length > 0) tx.update(ref, ...args);
    });
    hideLoading();
    setStatusMessage('scrimmage-roster', 'success', linkedCount > 0
      ? `Linked ${linkedCount} team${linkedCount === 1 ? '' : 's'} to FTCScout.`
      : 'Nothing to link — those teams changed while you were reviewing.');
  } catch (err) {
    hideLoading();
    console.error('Bulk FTCScout link failed:', err);
    setStatusMessage('scrimmage-roster', 'error', err && err.code === 'permission-denied'
      ? 'You do not have permission to edit this roster.'
      : 'Could not save the links. Check your connection and try again — nothing was changed.');
  }
}

// ====== OPR/location after a SEASON CHANGE. A linked team's OPR (and location)
// are copied onto the roster when it is linked, and they are that SEASON's
// numbers — the Info/Pit/Match/Compare lists show the roster copy, while Team
// Details loads FTCScout live for the scrimmage's season. Moving a scrimmage to
// another season therefore left the lists showing the OLD season's OPR. So once
// the season change has succeeded, the linked teams are refreshed with ONE
// batched FTCScout request for the NEW season and written back to the roster.
// A team FTCScout has no stats for in that season gets opr: null ("--"), never
// the old number; if FTCScout can't be reached, every linked team's opr is cleared
// (again: never a wrong number) and the user is told. Team Details is always live.
// Needs no rules change: it is an ordinary roster edit, and the person changing
// the season is a manager (who may also edit the roster). Resolves a summary. ======
async function refreshLinkedTeamsForSeason(scrimmageId, season) {
  const teamId = currentTeamData && currentTeamData.id;
  const scrim = scrimmageDataFor(scrimmageId);
  if (!teamId || !scrim) return { linked: 0, noStats: [], failed: false };
  const linkedNumbers = Object.values(scrim.teams || {}).filter(t => t && t.linked === true).map(t => Number(t.number));
  if (linkedNumbers.length === 0) return { linked: 0, noStats: [], failed: false };

  showLoading('Refreshing OPR from FTCScout...');
  let found = null;
  try {
    found = await lookupFtcTeamsBatch(linkedNumbers, String(season));
  } catch (err) {
    console.error('Could not refresh linked teams for the new season:', err);
  }
  try {
    const ref = scrimmagesCollection(teamId).doc(scrimmageId);
    const noStats = [];
    await db.runTransaction(async (tx) => {
      noStats.length = 0;
      const snap = await tx.get(ref);
      if (!snap.exists) return;
      const roster = snap.data().teams || {};
      const args = [];
      linkedNumbers.forEach((n) => {
        const existing = roster[String(n)];
        if (!existing || existing.linked !== true) return;
        const ftc = found ? found[n] : null;
        const opr = ftc && typeof ftc.opr === 'number' ? ftc.opr : null;
        if (found && opr === null) noStats.push(n);
        args.push(scrimmageRosterFieldPath(n, 'opr'), opr);
        if (ftc && ftc.location) args.push(scrimmageRosterFieldPath(n, 'location'), ftc.location);
      });
      if (args.length > 0) tx.update(ref, ...args);
    });
    hideLoading();
    return { linked: linkedNumbers.length, noStats, failed: !found };
  } catch (err) {
    hideLoading();
    console.error('Could not write refreshed OPR to the roster:', err);
    return { linked: linkedNumbers.length, noStats: [], failed: true };
  }
}

// Runs after the Manage modal has closed on a successful season change; only
// speaks up when the user needs to know something.
async function refreshLinkedTeamsAfterSeasonChange(scrimmageId, season) {
  const res = await refreshLinkedTeamsForSeason(scrimmageId, season);
  const label = `${season}-${Number(season) + 1}`;
  const list = (nums) => nums.map(n => `#${n}`).join(', ');
  const scrim = scrimmageDataFor(scrimmageId);
  const hasUnlinked = !!scrim && Object.values(scrim.teams || {}).some(t => t && t.linked !== true);
  if (res.failed) {
    showNoticeModal({
      title: 'OPR Not Refreshed',
      message: `The season was changed to ${label}, but FTCScout couldn't be reached to refresh OPR for the ${res.linked} linked team${res.linked === 1 ? '' : 's'}, so their OPR shows -- for now (Team Details still loads live data).`
    });
  } else if (res.noStats.length > 0) {
    showNoticeModal({
      title: 'No OPR For This Season Yet',
      message: `FTCScout has no stats for the ${label} season yet for ${list(res.noStats)}, so ${res.noStats.length === 1 ? 'its' : 'their'} OPR shows --.`
        + (hasUnlinked ? ' Teams that aren\'t linked to FTCScout show "unlinked" instead.' : '')
    });
  }
}

// ====== One small shared badge for roster rows — Info, Pit, Match and Compare
// lists all call it. "unlinked" on any scrimmage roster team that isn't linked;
// "linked" only where asked (the Info tab). No-op for official-event teams. ======
function appendScrimmageLinkBadge(parent, team, { showLinked = false } = {}) {
  if (!team || !team.isScrimmageTeam) return;
  const linked = team.linked === true;
  if (linked && !showLinked) return;
  const badge = document.createElement('span');
  badge.className = 'team-link-badge' + (linked ? ' is-linked' : '');
  badge.textContent = linked ? 'linked' : 'unlinked';
  badge.title = linked ? 'Linked to this team on FTCScout' : "Not linked to FTCScout — its name is whatever was typed";
  parent.appendChild(badge);
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
    pitDocs = pitSnap.docs.map(d => ({ id: d.id, ref: d.ref, committed: isEntryCommitted(d.data()), ...d.data() }));
    matchDocs = matchSnap.docs.map(d => ({ id: d.id, ref: d.ref, committed: isEntryCommitted(d.data()), ...d.data() }))
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

  // Only COMMITTED entries are "entries" to the user; empty shells left by a
  // cancelled form are swept silently (see committedEntries()).
  const realPit = pitDocs.filter(d => d.committed);
  const realMatch = matchDocs.filter(d => d.committed);

  // No entries: the plain confirm, as before.
  if (realPit.length === 0 && realMatch.length === 0) {
    showConfirmModal({
      title: 'Remove Team',
      message: `Remove ${label} from this scrimmage's roster?`,
      confirmLabel: 'Remove',
      danger: true,
      onConfirm: async () => {
        try {
          await deleteDocRefsInBatches([...pitDocs, ...matchDocs].map(d => d.ref));
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
  if (realPit.length > 0) parts.push(`${realPit.length} pit entry`);
  if (realMatch.length > 0) {
    const numbers = realMatch.map(d => (d.matchNumber != null ? `Match ${d.matchNumber}` : 'a match draft'));
    parts.push(`${realMatch.length} match entr${realMatch.length === 1 ? 'y' : 'ies'} (${numbers.join(', ')})`);
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

  let refreshSeasonAfterClose = null;
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
        const real = committedEntries(entries);
        if (real.pit.length + real.match.length > 0) {
          // Danger confirm (counts committed entries only). Nothing is written
          // until the user confirms; Cancel, the X and a click on the overlay all
          // leave the Manage modal exactly as it is.
          saveBtn.disabled = false;
          promptSeasonChange({ scrim, fields: { name, date, season }, entries: real });
          return;
        }
        if (entries.pit.length + entries.match.length > 0) {
          // Only empty drafts: nothing to lose, so no prompt — but sweep them so
          // the new season starts with no entries at all (same as a confirmed change).
          saveBtn.disabled = false;
          await performSeasonChange({ scrim, fields: { name, date, season } });
          return;
        }
      }
      // No entries to lose: save straight away. A season change with no entries
      // also zeroes a stale matchCount (there are no matches to count).
      await writeScrimmageEdit(scrimmageFormEditingId, { name, date, season },
        { resetMatchCount: seasonChanged && Number(scrim.matchCount) > 0 });
      refreshSeasonAfterClose = seasonChanged ? { id: scrimmageFormEditingId, season } : null;
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
    if (refreshSeasonAfterClose) await refreshLinkedTeamsAfterSeasonChange(refreshSeasonAfterClose.id, refreshSeasonAfterClose.season);
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

// Every pit/match doc of a scrimmage — a direct query, so uncommitted drafts are
// included (they must still be DELETED with the rest). Resolves to
// { pit: [QueryDocumentSnapshot], match: [...] }. Anything shown to the user as
// "entries" goes through committedEntries() instead — see there.
async function queryScrimmageEntries(teamId, eventCode) {
  const base = db.collection('teams').doc(teamId);
  const [pitSnap, matchSnap] = await Promise.all([
    base.collection('pitScouting').where('eventCode', '==', eventCode).get(),
    base.collection('matchScouting').where('eventCode', '==', eventCode).get()
  ]);
  return { pit: pitSnap.docs, match: matchSnap.docs };
}

// The pit/match form creates its doc the moment it opens (join()), and a Cancel
// leaves that doc behind as an EMPTY SHELL (identity fields + empty activeEditors,
// no checkpoint/scoutedBy — live-entry-sync.js: "no special cleanup needed").
// Those shells aren't scouting entries — Team Details and the scouted checkmarks
// already ignore them (isEntryCommitted()) — so every count shown to the user
// (season-change and delete confirms, "N scrimmage entries not included") counts
// committed entries only, while the deletes still sweep the shells away.
function committedEntries(entries) {
  return {
    pit: entries.pit.filter(d => isEntryCommitted(d.data())),
    match: entries.match.filter(d => isEntryCommitted(d.data()))
  };
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
// layers at z-index 1003 above the Manage modal. Cancel / X / overlay do
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
    // Linked teams still carry the OLD season's OPR: refresh them for the new one.
    await refreshLinkedTeamsAfterSeasonChange(scrim.id, fields.season);
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
  setStatusMessage('scrimmage-manage-team', 'success', `Added Team #${result.team.number} to the roster.`);
}

// ====== Add Team / Edit Team modal (promise-based) ======
// Resolves once the modal has CLOSED, with whatever onSubmit returned as
// { value } — or null if cancelled. onSubmit returns { value } to close or
// { error } to stay open and show it. Number, name, error, button state and every
// staged FTCScout change are reset on every open AND every close, so nothing typed
// or staged for one team ever reappears for the next.
function resetScrimmageTeamModalFields() {
  const numberInput = scrimmageEl('input-scrimmage-team-number');
  const nameInput = scrimmageEl('input-scrimmage-team-name');
  const saveBtn = scrimmageEl('btn-scrimmage-team-save');
  if (numberInput) { numberInput.value = ''; numberInput.disabled = false; }
  if (nameInput) { nameInput.value = ''; nameInput.readOnly = false; }
  const err = scrimmageEl('scrimmage-team-error');
  if (err) err.textContent = '';
  if (saveBtn) saveBtn.disabled = false;
  const ftcBlock = scrimmageEl('scrimmage-team-ftc-block');
  if (ftcBlock) ftcBlock.classList.add('hidden');
  const lookupBtn = scrimmageEl('btn-scrimmage-team-lookup');
  if (lookupBtn) { lookupBtn.classList.remove('hidden'); lookupBtn.disabled = false; lookupBtn.textContent = 'Look up on FTCScout'; }
  const unlinkBtn = scrimmageEl('btn-scrimmage-team-unlink');
  if (unlinkBtn) { unlinkBtn.classList.add('hidden'); unlinkBtn.disabled = false; unlinkBtn.textContent = 'Unlink from FTCScout'; }
  const ftcHelp = scrimmageEl('scrimmage-team-ftc-help');
  if (ftcHelp) ftcHelp.textContent = '';
  const hint = scrimmageEl('scrimmage-team-number-hint');
  if (hint) { hint.textContent = ''; hint.classList.add('hidden'); }
  const lockNote = scrimmageEl('scrimmage-team-lock-note');
  if (lockNote) { lockNote.textContent = ''; lockNote.classList.add('hidden'); }
  const mergeBox = scrimmageEl('scrimmage-team-merge-choice');
  if (mergeBox) mergeBox.classList.add('hidden');
  const mergeBtn = scrimmageEl('btn-scrimmage-team-merge');
  if (mergeBtn) mergeBtn.disabled = false;
}

// `lookup` (optional) adds the FTCScout step:
//   { mode: 'add', season, confirmLabel }   — "Look up on FTCScout": opens the
//        shared lookup (its own EDITABLE number box, kept in sync with this
//        modal's); confirming a found team adds it linked.
//   { mode: 'edit', scrimmageId, number, season, linked } — the A/B/C/D state machine
//        described at editScrimmageTeamName(). Staged state lives here:
//          pendingLink     the lookup result picked for this team (state B)
//          pendingUnlink   Unlink pressed on a linked team (state D)
//          nameBeforeLink  the name box's text when the link was staged — restored if
//                          the staged link is discarded, saved as manualName otherwise
//          renumber        checkScrimmageRenumber() result; null while it runs
//          mergeChoice     { number, name } while Save is showing "Team #B is already on
//                          this scrimmage. [Merge] [Change the number]" (managers only)
// `validateNumber(n)` (add) returns a message to refuse a number inline.
function openScrimmageTeamModal({ title, submitLabel, initialNumber, numberLocked, initialName, lookup = null, validateNumber = null, onSubmit }) {
  return new Promise((resolve) => {
    if (scrimmageTeamModalState) closeScrimmageTeamModal(null);
    const state = { resolve, onSubmit, lookup, validateNumber, pendingLink: null, pendingUnlink: false, nameBeforeLink: '', renumber: null, mergeChoice: null };
    scrimmageTeamModalState = state;

    resetScrimmageTeamModalFields();
    scrimmageEl('scrimmage-team-title').textContent = title;
    const numberInput = scrimmageEl('input-scrimmage-team-number');
    const nameInput = scrimmageEl('input-scrimmage-team-name');
    numberInput.value = initialNumber || '';
    numberInput.disabled = !!numberLocked;
    nameInput.value = initialName || '';
    scrimmageEl('btn-scrimmage-team-save').textContent = submitLabel;

    if (lookup) scrimmageEl('scrimmage-team-ftc-block').classList.remove('hidden');
    renderScrimmageTeamFtcUi();

    scrimmageEl('scrimmage-team-modal').classList.remove('hidden');
    focusScrimmageTeamModalField();

    // Edit: find out NOW whether the number may change (shows "Checking..." meanwhile).
    if (lookup && lookup.mode === 'edit') {
      checkScrimmageRenumber(lookup.scrimmageId, lookup.number).then((check) => {
        if (scrimmageTeamModalState !== state) return;
        state.renumber = check;
        renderScrimmageTeamFtcUi();
      });
    }
  });
}

// ====== Focus rule for the Add/Edit modal: NEVER a read-only or disabled box (a linked
// team's name and number are both read-only — focusing one painted the red focus outline on a
// box you can't type in). The first EDITABLE box gets focus (Add: the number; Edit: the name,
// else the number); if there is none, nothing in the modal is focused. A box that already has
// focus keeps it while it stays editable (so the renumber check finishing and unlocking the
// number never steals focus from the name box).
// `fixupOnly`: only repair a focus that went stale (the focused box just became read-only) —
// used by every re-render; the full pick happens when the modal opens. ======
function scrimmageTeamFieldEditable(el) {
  return !!el && !el.disabled && !el.readOnly;
}

function focusScrimmageTeamModalField({ fixupOnly = false } = {}) {
  const state = scrimmageTeamModalState;
  const modal = scrimmageEl('scrimmage-team-modal');
  if (!state || !modal) return;
  const active = document.activeElement;
  const insideModal = !!active && modal.contains(active);
  if (insideModal && active.matches('input') && scrimmageTeamFieldEditable(active)) return;   // keep it
  const number = scrimmageEl('input-scrimmage-team-number');
  const name = scrimmageEl('input-scrimmage-team-name');
  const editFirst = !!(state.lookup && state.lookup.mode === 'edit');
  const target = (editFirst ? [name, number] : [number, name]).find(scrimmageTeamFieldEditable);
  const staleInput = insideModal && active.matches('input');   // focused, but no longer editable
  if (fixupOnly && !staleInput) return;
  if (target) { target.focus(); return; }
  if (insideModal && typeof active.blur === 'function') active.blur();
}

function closeScrimmageTeamModal(value) {
  const state = scrimmageTeamModalState;
  scrimmageTeamModalState = null;
  const modal = scrimmageEl('scrimmage-team-modal');
  if (modal) modal.classList.add('hidden');
  resetScrimmageTeamModalFields();
  if (state) state.resolve(value === undefined ? null : value);
}

// Everything the FTCScout block, the name box and the number box show follows the
// modal's staged state, so this one function keeps them consistent.
function renderScrimmageTeamFtcUi() {
  const state = scrimmageTeamModalState;
  if (!state || !state.lookup) return;
  const lk = state.lookup;
  const lookupBtn = scrimmageEl('btn-scrimmage-team-lookup');
  const unlinkBtn = scrimmageEl('btn-scrimmage-team-unlink');
  const help = scrimmageEl('scrimmage-team-ftc-help');
  const lockNote = scrimmageEl('scrimmage-team-lock-note');
  const nameInput = scrimmageEl('input-scrimmage-team-name');
  const numberInput = scrimmageEl('input-scrimmage-team-number');
  const hint = scrimmageEl('scrimmage-team-number-hint');

  if (lk.mode === 'add') {
    lookupBtn.textContent = 'Look up on FTCScout';
    help.textContent = 'Optional: find the official name, location and OPR and add the team linked to FTCScout.';
    return;
  }

  const savedLinked = lk.linked && !state.pendingUnlink;   // C
  const pending = !!state.pendingLink;                      // B
  const lockedByLink = savedLinked || pending;              // C or B: name AND number come from FTCScout

  nameInput.readOnly = lockedByLink;
  lookupBtn.textContent = 'Link to FTCScout';
  lookupBtn.classList.toggle('hidden', lockedByLink);       // A, D
  unlinkBtn.classList.toggle('hidden', !lockedByLink);      // B, C
  unlinkBtn.textContent = pending ? 'Unlink' : 'Unlink from FTCScout';

  // The "why is this locked" note: its own always-visible line whenever the name and
  // number are read-only (B and C), hidden when they are editable (A and D).
  let lockText = '';
  if (pending) lockText = "The name and number come from FTCScout and can't be edited while linked. Press Unlink to change them.";
  else if (savedLinked) lockText = "Linked to FTCScout. The name and number come from FTCScout and can't be edited while linked. Unlink to change them.";
  lockNote.textContent = lockText;
  lockNote.classList.toggle('hidden', !lockText);

  let helpText;
  if (pending) {
    const p = state.pendingLink;
    helpText = `Will link to FTCScout: ${p.name}${p.location ? ` (${p.location})` : ''}. Save to apply.`;
  } else if (savedLinked) {
    helpText = '';
  } else if (state.pendingUnlink) {
    helpText = 'Will unlink from FTCScout when you Save.';
  } else {
    helpText = 'Find this team on FTCScout. Nothing changes until you Save.';
  }
  help.textContent = helpText;
  help.classList.toggle('hidden', !helpText);

  // The number is editable only in A / D, and only when renumbering is allowed. Every
  // number hint sits directly under the number box.
  const canRenumber = !lockedByLink && !!(state.renumber && state.renumber.ok);
  numberInput.disabled = !canRenumber;
  let hintText = '';
  if (!lockedByLink) {
    if (!state.renumber) hintText = 'Checking whether the number can change...';
    else if (!state.renumber.ok) hintText = scrimmageRenumberHint(state.renumber);
    else hintText = scrimmageRenumberTravelHint(state.renumber);
  }
  hint.textContent = hintText;
  hint.classList.toggle('hidden', !hintText);
  focusScrimmageTeamModalField({ fixupOnly: true });
}

// "Team #B (<name>) is already on this scrimmage. [Merge #A into #B] [Change the number]" —
// shown (managers only) when Save finds the typed number on the roster. While it shows,
// Save is off; editing the number, or "Change the number", dismisses it.
function renderScrimmageTeamMergeChoice() {
  const state = scrimmageTeamModalState;
  const box = scrimmageEl('scrimmage-team-merge-choice');
  const saveBtn = scrimmageEl('btn-scrimmage-team-save');
  if (!box) return;
  const choice = state && state.mergeChoice;
  box.classList.toggle('hidden', !choice);
  if (saveBtn) saveBtn.disabled = !!choice;
  if (!choice) return;
  const from = state.lookup.number;
  scrimmageEl('scrimmage-team-merge-text').textContent =
    `Team #${choice.number}${choice.name ? ` (${choice.name})` : ''} is already on this scrimmage.`;
  scrimmageEl('btn-scrimmage-team-merge').textContent = `Merge #${from} into #${choice.number}`;
}

function dismissScrimmageTeamMergeChoice({ focus = false } = {}) {
  const state = scrimmageTeamModalState;
  if (!state || !state.mergeChoice) return;
  state.mergeChoice = null;
  scrimmageEl('scrimmage-team-error').textContent = '';
  renderScrimmageTeamMergeChoice();
  if (focus) scrimmageEl('input-scrimmage-team-number').focus();
}

// "Look up on FTCScout" (add) / "Link to FTCScout" (edit, states A and D).
// The popup has its OWN number box when the number is changeable (the Add flow, and
// Edit when renumbering is allowed): every edit of it is copied into this modal's
// box (so cancelling the popup keeps the number), and the already-on-the-roster rule
// applies there too (inline error, nothing is looked up) — in Edit the team's OWN
// current number is not a duplicate. Otherwise (Edit, renumbering not allowed) it is
// fixed to the team's number.
// Add: confirming a found team adds it linked straight away (the submit runs inside
// the popup's onConfirm, so a failure stays visible there); this modal only closes
// once the popup is fully gone. Edit: confirming only STAGES the link (state B) and
// drops the official name into the (now read-only) name box.
async function handleScrimmageTeamLookupClick() {
  const state = scrimmageTeamModalState;
  if (!state || !state.lookup) return;
  const lk = state.lookup;
  const errEl = scrimmageEl('scrimmage-team-error');
  const nameInput = scrimmageEl('input-scrimmage-team-name');
  const numberInput = scrimmageEl('input-scrimmage-team-number');
  errEl.textContent = '';

  if (lk.mode === 'edit') {
    const canRenumber = !!(state.renumber && state.renumber.ok);
    await openFtcTeamLookup({
      title: canRenumber ? 'Link a Team to FTCScout' : `Link Team #${lk.number} to FTCScout`,
      season: lk.season,
      initialNumber: canRenumber ? numberInput.value : lk.number,
      numberLocked: !canRenumber,
      confirmLabel: 'Use This Team',
      validateNumber: canRenumber
        ? (n) => (n !== lk.number && getScrimmageRosterTeam(n, lk.scrimmageId) ? scrimmageDuplicateNumberMessage(n) : '')
        : null,
      onNumberInput: canRenumber ? (v) => { if (scrimmageTeamModalState === state) numberInput.value = v; } : null,
      onConfirm: (r) => {
        if (scrimmageTeamModalState !== state) return;
        if (!state.pendingLink) state.nameBeforeLink = (nameInput.value || '').trim();
        state.pendingLink = r;
        nameInput.value = r.name;
        numberInput.value = String(r.number);
      }
    });
    if (scrimmageTeamModalState === state) renderScrimmageTeamFtcUi();
    return;
  }

  const typedName = (nameInput.value || '').trim();
  let submitted = null;
  const res = await openFtcTeamLookup({
    title: 'Look Up a Team',
    season: lk.season,
    initialNumber: numberInput.value,
    numberLocked: false,
    confirmLabel: lk.confirmLabel,
    validateNumber: state.validateNumber || null,
    onNumberInput: (v) => { if (scrimmageTeamModalState === state) numberInput.value = v; },
    onConfirm: async (r) => {
      const out = await state.onSubmit({ number: r.number, name: typedName, ftc: r });
      if (out && out.error) return { error: out.error };
      submitted = out;
    }
  });
  if (res && submitted && scrimmageTeamModalState === state) closeScrimmageTeamModal(submitted.value);
}

// The second button of the FTCScout block (states B and C):
//   B  "Unlink"  — discard the STAGED link: the name box goes back to the text it had
//                  before linking (and unlocks); the number box keeps what is in it.
//                  Back to A, or to D if the team was linked when the modal opened.
//   C  "Unlink from FTCScout" — stage the unlink (D). Nothing is written until Save.
function handleScrimmageTeamUnlinkClick() {
  const state = scrimmageTeamModalState;
  if (!state || !state.lookup || state.lookup.mode !== 'edit') return;
  scrimmageEl('scrimmage-team-error').textContent = '';
  if (state.pendingLink) {
    state.pendingLink = null;
    scrimmageEl('input-scrimmage-team-name').value = state.nameBeforeLink;
    state.nameBeforeLink = '';
  } else {
    state.pendingUnlink = true;
  }
  renderScrimmageTeamFtcUi();
  // Unlinking (C -> D, B -> A/D) hands focus to the first editable box; nothing if there is none.
  focusScrimmageTeamModalField();
}

// `opts.merge` (true only from the merge-choice button) tells the Edit flow's onSubmit the
// manager chose "Merge #A into #B". onSubmit may also return { mergeChoice } (show that
// choice, write nothing) or { stay: true } (a cancelled merge: keep the modal exactly as it
// was).
async function submitScrimmageTeamModal(opts) {
  const merge = !!(opts && opts.merge === true);
  const state = scrimmageTeamModalState;
  if (!state) return;
  if (state.mergeChoice && !merge) return;   // the choice is showing — Save is off
  const errEl = scrimmageEl('scrimmage-team-error');
  const saveBtn = scrimmageEl('btn-scrimmage-team-save');
  const mergeBtn = scrimmageEl('btn-scrimmage-team-merge');

  const number = parseScrimmageTeamNumber(scrimmageEl('input-scrimmage-team-number').value);
  if (number === null) {
    errEl.textContent = `Enter a team number from 1 to ${SCRIMMAGE_MANUAL_TEAM_MAX}.`;
    return;
  }
  const problem = state.validateNumber ? state.validateNumber(number) : '';
  if (problem) {
    errEl.textContent = problem;
    return;
  }
  const name = (scrimmageEl('input-scrimmage-team-name').value || '').trim();
  errEl.textContent = '';
  saveBtn.disabled = true;
  if (mergeBtn) mergeBtn.disabled = true;
  try {
    const result = await state.onSubmit({
      number,
      name,
      link: state.pendingLink || null,
      unlink: state.pendingUnlink,
      nameBeforeLink: state.nameBeforeLink,
      merge
    });
    if (scrimmageTeamModalState !== state) return;
    if (result && result.mergeChoice) {
      state.mergeChoice = result.mergeChoice;
      renderScrimmageTeamMergeChoice();
      return;
    }
    if (result && result.stay) return;
    if (result && result.error) {
      errEl.textContent = result.error;
      return;
    }
    closeScrimmageTeamModal(result ? result.value : null);
  } finally {
    if (mergeBtn) mergeBtn.disabled = false;
    saveBtn.disabled = !!(scrimmageTeamModalState && scrimmageTeamModalState.mergeChoice);
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
    pitCount = pitSnap.docs.filter(d => isEntryCommitted(d.data())).length;
    matchCount = matchSnap.docs.filter(d => isEntryCommitted(d.data())).length;
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
  on('btn-scrimmage-bulk-link', 'click', linkUnlinkedScrimmageTeams);
  on('btn-scrimmage-team-cancel', 'click', () => closeScrimmageTeamModal(null));
  on('btn-scrimmage-team-close', 'click', () => closeScrimmageTeamModal(null));
  on('scrimmage-team-modal-overlay', 'click', () => closeScrimmageTeamModal(null));
  on('btn-scrimmage-team-save', 'click', () => submitScrimmageTeamModal());
  on('btn-scrimmage-team-merge', 'click', () => submitScrimmageTeamModal({ merge: true }));
  on('btn-scrimmage-team-merge-change', 'click', () => dismissScrimmageTeamMergeChoice({ focus: true }));
  on('input-scrimmage-team-number', 'input', () => dismissScrimmageTeamMergeChoice());
  on('btn-scrimmage-team-lookup', 'click', handleScrimmageTeamLookupClick);
  on('btn-scrimmage-team-unlink', 'click', handleScrimmageTeamUnlinkClick);

  on('btn-bulk-link-cancel', 'click', closeBulkLinkReview);
  on('btn-bulk-link-close', 'click', closeBulkLinkReview);
  on('bulk-link-modal-overlay', 'click', closeBulkLinkReview);
  on('btn-bulk-link-confirm', 'click', confirmBulkLinkReview);
  on('btn-bulk-link-all', 'click', () => setBulkLinkChecked(true));
  on('btn-bulk-link-none', 'click', () => setBulkLinkChecked(false));
  ['input-scrimmage-team-number', 'input-scrimmage-team-name'].forEach(id => {
    on(id, 'keydown', (e) => { if (e.key === 'Enter') submitScrimmageTeamModal(); });
  });

  // Pit / Match tabs: "+ Add & scout a team".
  ['pit', 'match'].forEach(kind => {
    on(`btn-scrimmage-add-scout-${kind}`, 'click', () => addAndScoutTeam(kind));
  });
});
