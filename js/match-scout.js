// ====== Match Scouting Form ======
// Data stored in Firestore at teams/{teamId}/matchScouting/{docId} (moved
// from the flat top-level "matchScouting" collection as part of the data
// reorg — same move pit scouting already went through, see pit-scout.js).
// Document ID: `${teamId}_${eventCode}_${matchNumber}_${teamNumber}` — teamId
// (the SCOUTING team's own Firestore team ID) is included so two different
// scouting teams can never collide, even though match numbers are canonical/
// shared across a real event (two different teams both scouting the same
// target team in the same real match is a plausible collision, not just an
// artifact of reused test data — same reasoning as pit-scout.js, see there
// for the fuller writeup). Now that the collection itself is scoped per-team
// by its path, this prefix is redundant for new docs, but kept for ID-format
// continuity with pre-migration data. Older entries (saved before this
// existed) used `${eventCode}_${matchNumber}_${teamNumber}` — left as-is
// (see findExistingMatchDoc() below) rather than migrated.
// Fields: eventCode, matchNumber, teamNumber, teamId, season, plus dynamic
//         fields from formConfig, scoutedBy/scoutedByName ("created by" —
//         set exactly once, at the entry's first successful commit,
//         permanent from then on), scoutedAt, lastEditedBy/lastEditedByName/
//         lastEditedByTimestamp (set only when a commit's checkpoint
//         genuinely differs from the prior one), updatedAt, and (live
//         entries only) checkpoint and activeEditors — see
//         live-entry-sync.js's commit()/cancelUndo() for the full model.
// Unlike pit scouting, each team can have multiple match entries (one per match).
//
// Two distinct modes, depending on entry point — unlike pit scouting, which
// is always live:
//  - LIVE (the match-based/schedule view, match-schedule-view.js ->
//    openMatchScoutFormFromSchedule): matchNumber is already known from
//    which row was clicked, so there's no "which slot" ambiguity. Uses
//    live-entry-sync.js exactly like pit-scout.js — field writes go live as
//    typed, presence/ownership apply, Save becomes "Done".
//  - BATCH (the team-based view's manual "+Match Scout"/"Edit" buttons):
//    matchNumber is typed/edited by hand, so the duplicate-slot problem is
//    real (this is what commit b77fcb9 was about) and there's no natural
//    moment to "join" a live session before a number is even chosen. Keeps
//    today's single-write-on-Save model entirely; the only change is
//    checking for a colliding matchNumber as soon as one is entered (blur),
//    rather than only at Save — see checkMatchNumberCollision().
// Which mode applies is determined by the SAME lockedMatchNumber/
// lockMatchNumber parameter that already distinguished "came from the
// schedule" from "came from the team view" before any of this — no new flag
// needed.

let currentMatchTeamNumber = null;
let currentMatchEventCode = null;
let currentMatchDocId = null; // set when editing an existing entry
// Set only when the form was opened from the match-based view
// (match-schedule-view.js), where matchNumber/teamNumber/eventCode are
// already known from which match row + team slot was clicked. When
// non-null, the matchNumber field is excluded from the rendered dynamic
// form (same as teamNumber/eventCode, which are never dynamic-form fields
// at all — title + module state only), saveMatchScoutForm() uses this value
// instead of reading one out of the form, and — per the header comment —
// this is also exactly what selects LIVE mode.
let currentLockedMatchNumber = null;
let matchScoutUnsubscribe = null; // Firestore snapshot listener (status/"how many matches logged" listener — see watchMatchScoutStatus)
let matchEntriesCache = {}; // keyed by "eventCode_teamNumber" -> array of entries (each entry's own .id is the real doc id, format-agnostic). Only entries that count per matchEntryIsCommitted() are included — see watchMatchScoutStatus().
let matchActiveEditingCache = new Set(); // Set of "eventCode_teamNumber" keys with at least one fresh active editor right now, on ANY of that team's match entries — INDEPENDENT of matchEntriesCache, see isTeamBeingEditedMatch()
let matchActiveEditingNamesCache = new Map(); // "eventCode_teamNumber" -> array of fresh editor names across all of that team's match entries, for the team-list badge's text (CATEGORY 4) — see getTeamEditingNamesMatch()
let matchActiveEditorsRawCache = new Map(); // "eventCode_teamNumber" -> array of raw activeEditors maps (one per that team's match entries) from the last snapshot, kept so recomputeMatchActiveEditingFromCache() can re-derive freshness on a timer WITHOUT waiting for a new snapshot — see that function's own comment
let matchActiveEditingRefreshTimer = null; // setInterval handle, tied to watchMatchScoutStatus()'s own listener lifecycle — see recomputeMatchActiveEditingFromCache()
let currentMatchFormController = null; // returned by renderDynamicForm
let currentMatchFormMode = null; // 'live' or 'batch' — set by whichever open function ran, read by the Save/Done button handler
let currentMatchFields = null; // the field config rendered into the open form, needed by the live session's snapshot handler (live mode only)
let currentMatchLiveSession = null; // returned by createLiveEntrySession (live-entry-sync.js), live mode only
let matchStatusWatchGeneration = 0; // guards against a slower, superseded async snapshot handler clobbering a newer one's result — see watchMatchScoutStatus()

// ====== Find this team's existing match-scouting entry for (eventCode,
// matchNumber, teamNumber), regardless of which document-ID scheme it was
// saved under — same reasoning/pattern as pit-scout.js's findExistingPitDoc().
// Queries by data fields rather than guessing an ID. Returns { id, ...data }
// or null. ======
async function findExistingMatchDoc(teamId, eventCode, matchNumber, teamNumber) {
  const snap = await db.collection('teams').doc(teamId).collection('matchScouting')
    .where('eventCode', '==', eventCode)
    .where('matchNumber', '==', Number(matchNumber))
    .where('teamNumber', '==', Number(teamNumber))
    .limit(1)
    .get();
  if (snap.empty) return null;
  const doc = snap.docs[0];
  return { id: doc.id, ...doc.data() };
}

// ====== Does (eventCode, matchNumber, teamNumber) already belong to some
// OTHER entry than the one currently open (excludeDocId)? Used by batch
// mode's matchNumber blur check (as soon as a number is entered, for the
// earliest possible warning) and by performMatchScoutSave's save-time
// re-check (kept as a defensive backstop — see saveMatchScoutForm, b77fcb9)
// so both call sites agree on exactly what counts as a collision. ======
async function checkMatchNumberCollision(teamId, eventCode, matchNumber, teamNumber, excludeDocId) {
  const existing = await findExistingMatchDoc(teamId, eventCode, matchNumber, teamNumber);
  if (existing && existing.id !== excludeDocId) return existing;
  return null;
}

// Bulk-select state for the match entries list (captain / canEditOtherEntries
// only) — keyed by ID prefix ('td-' for the Team Information tab's Team
// Detail modal, 'msm-' for the "View Matches Scouted" modal) so the two
// modals never share select-mode or selections, even if both happen to be
// showing different teams' entries at once.
// order/checkboxEls/rangeState (shift-click range-select support, shared
// with the three main tabs — see handleBulkRangeClick() in first-api.js) are
// namespaced by prefix here too, so the Team Detail modal and Matches
// Scouted modal each get their own independent anchor/order, exactly like
// their mode/selectedIds already are.
const matchBulkState = {
  'td-': { mode: false, selectedIds: new Set(), order: [], checkboxEls: new Map(), rangeState: { lastClickedId: null } },
  'msm-': { mode: false, selectedIds: new Set(), order: [], checkboxEls: new Map(), rangeState: { lastClickedId: null } }
};

// ====== Reset one match-entry-list bulk-select context (the Team Detail
// modal's 'td-', or the Matches Scouted modal's 'msm-') back to its default:
// mode off, nothing selected, shift-click anchor cleared, toolbar synced back
// to "Select" with the delete button hidden. Mirrors exactly what
// exitAllBulkSelectModes() (first-api.js) does for the three main tabs' own
// bulk-select — shared here (by both modals' close handlers, and by
// clearSelectedEvent()'s event-switch reset) rather than duplicated at each
// call site. ======
function resetMatchBulkSelectState(prefix) {
  const state = matchBulkState[prefix];
  if (!state) return;
  state.mode = false;
  if (typeof clearBulkSelection === 'function') {
    clearBulkSelection(state.selectedIds, state.rangeState);
  } else {
    state.selectedIds.clear();
    state.rangeState.lastClickedId = null;
  }
  state.order = [];
  state.checkboxEls = new Map();
  if (typeof updateMatchBulkSelectUI === 'function') updateMatchBulkSelectUI(prefix);
}

function resetAllMatchEntryBulkSelectStates() {
  Object.keys(matchBulkState).forEach(resetMatchBulkSelectState);
}

// ====== Show/hide & label the match bulk-select toolbar based on permission and selection ======
function updateMatchBulkSelectUI(prefix = 'td-') {
  const state = matchBulkState[prefix];
  const toggleBtn = document.getElementById(`${prefix}match-bulk-select-toggle`);
  const deleteBtn = document.getElementById(`${prefix}match-bulk-delete`);
  if (!toggleBtn || !deleteBtn || !state) return;

  const canBulkManage = typeof canUserEditOtherEntries === 'function' ? canUserEditOtherEntries() : false;
  if (!canBulkManage) {
    toggleBtn.classList.add('hidden');
    deleteBtn.classList.add('hidden');
    state.mode = false;
    state.selectedIds.clear();
    return;
  }

  toggleBtn.classList.remove('hidden');
  toggleBtn.textContent = state.mode ? 'Cancel Select' : 'Select';

  if (state.mode && state.selectedIds.size > 0) {
    deleteBtn.classList.remove('hidden');
    deleteBtn.textContent = `Delete Selected (${state.selectedIds.size})`;
  } else {
    deleteBtn.classList.add('hidden');
  }
}

// ====== Bulk-delete match scouting entries by doc id ======
// Each delete goes through the same teams/{teamId}/matchScouting doc(id).delete() call
// as the single-entry path, so Firestore rules (canEditOrDeleteEntry) enforce permission
// per-document exactly as they already do — this is a UI convenience, not a bypass. Reads
// teamId from currentTeamData (like pit-scout.js's bulkDeletePitScoutData) since callers
// only ever operate on the current team's own bulk-selected entries.
async function bulkDeleteMatchScoutData(entryIds) {
  const results = { succeeded: [], failed: [] };
  const teamId = currentTeamData?.id;
  if (!teamId) {
    return { succeeded: [], failed: [...entryIds] };
  }
  const deleterName = typeof getCurrentUserDisplayName === 'function' ? getCurrentUserDisplayName() : (currentUser?.email || 'Unknown');
  for (const entryId of entryIds) {
    try {
      const docRef = db.collection('teams').doc(teamId).collection('matchScouting').doc(entryId);
      await deleteEntryWithNotice(docRef, deleterName, currentUser?.uid);
      results.succeeded.push(entryId);
    } catch (err) {
      console.error(`Failed to delete match scouting data for ${entryId}:`, err);
      results.failed.push(entryId);
    }
  }
  return results;
}

// ====== Shared live-mode wiring for the match-based (schedule) view — see
// the file header for why only this entry point gets live-entry-sync.js.
// Creates the live session, attaches its snapshot handler to the already-
// rendered form, and joins immediately — every caller of this function has
// already ruled out the one case that isn't allowed to (blocked, decided by
// classifyLiveEntryAccess() before openMatchScoutForm/openMatchScoutEdit was
// even called), so there's no more read-only/"Take Over" middle state. ======
async function attachMatchLiveSession(docId, fields, baseFieldsIfNew) {
  currentMatchFormMode = 'live';
  currentMatchFields = fields;
  document.getElementById('btn-match-save').textContent = 'Done';
  const presenceBanner = document.getElementById('match-presence-banner');
  presenceBanner.classList.add('hidden');
  presenceBanner.textContent = '';

  const teamId = currentTeamData?.id;
  const docRef = db.collection('teams').doc(teamId).collection('matchScouting').doc(docId);
  const displayName = typeof getCurrentUserDisplayName === 'function' ? getCurrentUserDisplayName() : (currentUser.email || 'Unknown');

  currentMatchLiveSession = createLiveEntrySession({
    docRef,
    uid: currentUser.uid,
    displayName,
    canEditFn: canUserEditOtherEntries,
    onLostEditAccess: () => {
      // CATEGORY 3: mirrors pit-scout.js's own copy of this callback — see
      // live-entry-sync.js's createLiveEntrySession() for the full
      // detection/cleanup this fires after (already detached/cleaned up by
      // the time this runs).
      closeMatchScoutFormUI();
      if (typeof showNoticeModal === 'function') {
        showNoticeModal({
          title: 'Entry Saved',
          message: 'This entry was just saved by another editor. Since it\'s now been scouted, only its owner, a captain, or someone with edit-others permission can continue editing it — you were disconnected. Any of your edits that had already synced remain saved; anything typed in the last moment before this may not have.'
        });
      }
      if (typeof logActivitySelf === 'function') {
        const liveTeamName = (currentTeamData && currentTeamData.name) || 'this team';
        logActivitySelf({
          type: 'live-edit-disconnected',
          teamId,
          teamName: liveTeamName,
          message: `You were disconnected from a match scouting entry in "${liveTeamName}" — it was saved by another editor while you were still working on it.`
        });
      }
    },
    onEntryDeleted: (deletedByName) => {
      // Mirrors pit-scout.js's own copy of this callback — the entry this
      // session had open was deleted (see deleteEntryWithNotice(),
      // live-entry-sync.js) by someone else while it was still active here.
      closeMatchScoutFormUI();
      if (typeof showNoticeModal === 'function') {
        showNoticeModal({
          title: 'Entry Deleted',
          message: `This entry was deleted by ${deletedByName || 'another editor'} while you had it open. Your changes were not saved.`
        });
      }
      if (typeof logActivitySelf === 'function') {
        const liveTeamName = (currentTeamData && currentTeamData.name) || 'this team';
        logActivitySelf({
          type: 'live-edit-disconnected',
          teamId,
          teamName: liveTeamName,
          message: `You were disconnected from a match scouting entry in "${liveTeamName}" — it was deleted by ${deletedByName || 'another editor'} while you were still working on it.`
        });
      }
    },
    onSnapshotData: (data) => {
      if (!currentMatchFormController || !currentMatchFields) return;
      applyRemoteFieldValues(currentMatchFormController, currentMatchFields, data, currentMatchLiveSession);
      applyPresenceIndicators(currentMatchFormController, currentMatchFields, data?.activeEditors, currentUser.uid);
      renderPresenceBanner(document.getElementById('match-presence-banner'), data?.activeEditors, currentUser.uid, !!data?.checkpoint);
    }
  });

  // baseFieldsIfNew must NOT include scoutedBy/scoutedByName/scoutedAt —
  // those are only ever set by commitMatchScoutForm's first successful Done
  // now, never at doc-creation time (see the two callers below).
  await currentMatchLiveSession.join(baseFieldsIfNew);
  wireLiveFormFields(currentMatchFormController, fields, currentMatchLiveSession);
}

// ====== Watch the matchNumber field (batch mode only — see file header) for
// a collision with some other already-existing entry, as soon as a valid
// number is entered, rather than waiting for Save. excludeDocId is the entry
// currently being edited (null for a brand-new entry), so editing a slot
// back onto its own existing number is never flagged as a collision with
// itself. Per decision: don't auto-open/redirect into the colliding entry,
// just block with a message pointing at it. ======
function wireMatchNumberCollisionCheck(formController, teamId, eventCode, teamNumber, excludeDocId) {
  const el = formController.getField('matchNumber');
  if (!el) return;
  const errorEl = document.getElementById('match-modal-error');
  const checkNow = async () => {
    const matchNumber = formController.getValues().matchNumber;
    if (!matchNumber) return;
    const collision = await checkMatchNumberCollision(teamId, eventCode, matchNumber, teamNumber, excludeDocId);
    if (collision) {
      errorEl.textContent = `Match ${matchNumber} for this team already exists — go edit that entry from the team's match list instead, or change the match number.`;
    } else if (errorEl.textContent.startsWith('Match ') && errorEl.textContent.includes('already exists')) {
      errorEl.textContent = '';
    }
  };
  el.addEventListener('blur', checkNow);
  el.addEventListener('change', checkNow);
}

// ====== Open the match scouting form (modal) for a new entry ======
// lockedMatchNumber/teamName are only passed by openMatchScoutFormFromSchedule()
// (the match-based/LIVE view's entry point, below) — every other existing
// caller passes just (teamNumber, eventCode), which behaves exactly as
// before (BATCH mode, team-based view).
async function openMatchScoutForm(teamNumber, eventCode, lockedMatchNumber = null, teamName = null) {
  currentMatchTeamNumber = teamNumber;
  currentMatchEventCode = eventCode;
  currentMatchDocId = null;
  currentLockedMatchNumber = lockedMatchNumber;
  currentMatchFormMode = lockedMatchNumber != null ? 'live' : 'batch';
  // Defensive re-entrancy guard (e.g. a rapid double-open before the first
  // finished rendering) — treat abandoning whatever was open as a cancel,
  // same as clicking Cancel would: never silently keep an uncommitted
  // session's data just because a second open happened to interrupt it.
  // Capture currentMatchFields BEFORE clearing it below — cancelAndLeave()
  // needs the OLD session's own field config for its checkpoint-diff
  // revert (see live-entry-sync.js's cancelUndo()), not whatever fields
  // this new open is about to load.
  if (currentMatchLiveSession) {
    const staleFields = currentMatchFields;
    currentMatchLiveSession.cancelAndLeave(staleFields);
    currentMatchLiveSession = null;
  }
  currentMatchFields = null;

  // Reset modal state
  document.getElementById('match-modal-title').textContent = lockedMatchNumber != null
    ? `Match #${lockedMatchNumber} — Team #${teamNumber}${teamName ? ` (${teamName})` : ''}`
    : `Match Scout Team #${teamNumber}`;
  document.getElementById('match-modal-error').textContent = '';
  document.getElementById('match-modal-success').textContent = '';
  document.getElementById('match-delete-btn').classList.add('hidden');
  document.getElementById('btn-match-save').textContent = lockedMatchNumber != null ? 'Done' : 'Save Match Data';
  const presenceBanner = document.getElementById('match-presence-banner');
  presenceBanner.classList.add('hidden');
  presenceBanner.textContent = '';

  // Show modal
  document.getElementById('match-modal').classList.remove('hidden');

  // Clear synchronously, before any await below — otherwise whatever entry
  // was rendered here last stays visible (wrong team/match data, or a stale
  // "existing data loaded" state) for however long the form-config fetch
  // takes, instead of never appearing at all.
  document.getElementById('match-dynamic-fields').innerHTML = '';
  currentMatchFormController = null;

  // Get field configuration and render dynamic form
  const teamId = currentTeamData?.id;
  if (!teamId) {
    document.getElementById('match-modal-error').textContent = 'Team data not loaded. Please rejoin your team.';
    return;
  }

  try {
    const fields = await loadMatchFormConfig(teamId);
    const container = document.getElementById('match-dynamic-fields');
    // Locked entries already have their match number fixed by which row was
    // clicked — exclude it from the rendered form the same way
    // teamNumber/eventCode are never rendered as form fields at all, shown
    // only in the title above.
    const renderedFields = lockedMatchNumber != null ? fields.filter(f => f.id !== 'matchNumber') : fields;

    currentMatchFormController = renderDynamicForm(container, renderedFields, null);

    // Clear success message
    document.getElementById('match-modal-success').textContent = '';

    if (lockedMatchNumber != null) {
      // LIVE mode. Reached only from openMatchScoutFormFromSchedule's
      // "not found" branch, which already confirmed nothing exists for this
      // slot — so this is always a brand-new entry, and (per
      // classifyLiveEntryAccess) always allowed to join immediately.
      const docId = `${teamId}_${eventCode}_${lockedMatchNumber}_${teamNumber}`;
      await attachMatchLiveSession(docId, fields, {
        eventCode,
        teamNumber: Number(teamNumber),
        matchNumber: Number(lockedMatchNumber),
        teamId,
        season: resolveFormConfigSeason()
      });
    } else {
      // BATCH mode — today's model, plus the early duplicate-number check.
      wireMatchNumberCollisionCheck(currentMatchFormController, teamId, eventCode, teamNumber, null);
    }
  } catch (err) {
    console.error('Failed to render match form:', err);
    // Rare TOCTOU race: the entry became committed by someone else in the
    // brief window between the access check (openMatchScoutFormFromSchedule)
    // and this join() write actually landing — CATEGORY 3's gate is
    // enforced server-side too, not just client-side at access-check time.
    document.getElementById('match-modal-error').textContent = err && err.code === 'permission-denied'
      ? 'This entry was just saved by someone else and can no longer be joined. Please close and reopen it.'
      : 'Failed to load form. Please try again.';
  }
}

// ====== Open match form to edit an existing entry ======
// lockMatchNumber/teamName are only passed by openMatchScoutFormFromSchedule()
// (below) — every other existing caller
// (the team-based view's Edit button) passes just (docId, existingData),
// which behaves exactly as before (BATCH mode). The locked value is always
// derived from existingData.matchNumber itself, not a separately-passed
// number, so it can never disagree with the entry being edited.
async function openMatchScoutEdit(docId, existingData, lockMatchNumber = false, teamName = null) {
  // Extract team number and event code from existing data
  currentMatchTeamNumber = existingData.teamNumber;
  currentMatchEventCode = existingData.eventCode;
  currentMatchDocId = docId;
  currentLockedMatchNumber = lockMatchNumber ? existingData.matchNumber : null;
  currentMatchFormMode = lockMatchNumber ? 'live' : 'batch';
  // Defensive re-entrancy guard — see openMatchScoutForm's own copy of this
  // comment for why cancelAndLeave() rather than a bare detach(), and for
  // why currentMatchFields must be captured before it's cleared below.
  if (currentMatchLiveSession) {
    const staleFields = currentMatchFields;
    currentMatchLiveSession.cancelAndLeave(staleFields);
    currentMatchLiveSession = null;
  }
  currentMatchFields = null;

  document.getElementById('match-modal-title').textContent = lockMatchNumber && teamName
    ? `Edit Match #${existingData.matchNumber || '?'} — Team #${currentMatchTeamNumber} (${teamName})`
    : `Edit Match #${existingData.matchNumber || '?'} — Team #${currentMatchTeamNumber}`;
  document.getElementById('match-modal-error').textContent = '';
  document.getElementById('match-modal-success').textContent = '';
  document.getElementById('match-delete-btn').classList.remove('hidden');
  document.getElementById('btn-match-save').textContent = lockMatchNumber ? 'Done' : 'Save Match Data';
  const presenceBanner = document.getElementById('match-presence-banner');
  presenceBanner.classList.add('hidden');
  presenceBanner.textContent = '';

  document.getElementById('match-modal').classList.remove('hidden');

  // Clear synchronously, before any await below — otherwise whatever entry
  // was rendered here last (a different match/team) stays visible for
  // however long the form-config fetch takes, instead of never appearing.
  document.getElementById('match-dynamic-fields').innerHTML = '';
  currentMatchFormController = null;

  const teamId = currentTeamData?.id;
  if (!teamId) return;

  try {
    // Resolve fields for THIS entry's own season (falling back to the app's
    // currently-selected season for a legacy entry saved before
    // season-tagging existed) — editing an old entry should show the field
    // set that was active when it was scouted, not today's form.
    const fields = await loadMatchFormConfig(teamId, existingData?.season);
    const container = document.getElementById('match-dynamic-fields');
    const renderedFields = lockMatchNumber ? fields.filter(f => f.id !== 'matchNumber') : fields;

    currentMatchFormController = renderDynamicForm(container, renderedFields, existingData);

    document.getElementById('match-modal-success').textContent = lockMatchNumber ? '' : 'Editing existing match entry.';

    if (lockMatchNumber) {
      // LIVE mode. openMatchScoutFormFromSchedule already ruled out the
      // blocked case before calling this, so join immediately.
      await attachMatchLiveSession(docId, fields, {
        eventCode: existingData.eventCode,
        teamNumber: Number(existingData.teamNumber),
        matchNumber: Number(existingData.matchNumber),
        teamId,
        season: existingData.season || resolveFormConfigSeason()
      });
    } else {
      // BATCH mode — today's model, plus the early duplicate-number check
      // (excluding this entry's own current slot).
      wireMatchNumberCollisionCheck(currentMatchFormController, teamId, existingData.eventCode, existingData.teamNumber, docId);
    }
  } catch (err) {
    console.error('Failed to render match form for edit:', err);
    // See openMatchScoutForm's own copy of this comment — same rare TOCTOU
    // race, same nicer message for it.
    document.getElementById('match-modal-error').textContent = err && err.code === 'permission-denied'
      ? 'This entry was just saved by someone else and can no longer be joined. Please close and reopen it.'
      : 'Failed to load form. Please try again.';
  }
}

// ====== Open the match scouting form from the match-based view
// (match-schedule-view.js's expanded panel) — matchNumber, teamNumber, and
// eventCode are all already known from which match row + team slot was
// clicked, so all three end up locked (title-only, not user-editable) in
// whichever of the two functions above ends up handling it, and this is
// always LIVE mode (see file header). Access decision (mirrors
// pit-scout.js's openPitScoutForm — see classifyLiveEntryAccess() in
// live-entry-sync.js for the reasoning): zero active editors and not
// qualified (owner/captain/canEditOtherEntries, or nothing exists yet) ->
// blocked, Permission Denied. Otherwise -> open and join immediately,
// whether the entry was empty or already had other active editors. ======
async function openMatchScoutFormFromSchedule(matchNumber, teamNumber, eventCode, teamName) {
  const teamId = currentTeamData?.id;
  if (!teamId || !currentUser) return;

  const existing = await findExistingMatchDoc(teamId, eventCode, matchNumber, teamNumber);
  const access = classifyLiveEntryAccess(existing, canUserEditOtherEntries);

  if (access.blocked) {
    if (typeof showNoticeModal === 'function') {
      showNoticeModal({ title: 'Permission Denied', message: 'You do not have permission to edit this match scouting entry.' });
    }
    return;
  }

  if (existing) {
    await openMatchScoutEdit(existing.id, existing, true, teamName);
  } else {
    await openMatchScoutForm(teamNumber, eventCode, matchNumber, teamName);
  }
}

// ====== Did the form's field values actually differ from what's already
// saved? Used to decide whether a Save on an existing entry should touch
// lastEditedBy/lastEditedByName/lastEditedByTimestamp at all — clicking Save
// without changing anything shouldn't reassign "last edited by" to whoever
// just reopened and resaved the entry unchanged. BATCH mode only — live
// mode's per-field writes do this same comparison inline in
// createLiveEntrySession (live-entry-sync.js). ======
function matchFormValuesChanged(fieldValues, existingData) {
  if (!existingData) return true;
  return Object.keys(fieldValues).some(key => (fieldValues[key] ?? null) !== (existingData[key] ?? null));
}

// ====== Does this match number NOT appear in the team's actual schedule for
// this event? Used to warn (not block) before saving a match entry — e.g. a
// typo'd match number. Reuses getEventSchedule() (first-api.js), the same
// schedule lookup the match-based view (match-schedule-view.js) already
// fetches through, rather than a second lookup here.
//
// Returns false (treat as "no mismatch", i.e. skip the warning) whenever
// schedule data isn't available at all — an API failure, or an event with no
// published schedule yet — since there's nothing to validate against, not
// evidence of a mismatch. ======
async function isMatchNumberMismatched(eventCode, teamNumber, matchNumber) {
  let schedule;
  try {
    schedule = await getEventSchedule(eventCode);
  } catch (err) {
    console.warn('Could not load schedule to validate match number, skipping check:', err);
    return false;
  }
  if (!schedule || schedule.length === 0) return false;

  const match = schedule.find(m => Number(m.matchNumber) === Number(matchNumber));
  if (!match) return true;
  return !(match.teams || []).some(t => Number(t.teamNumber) === Number(teamNumber));
}

// ====== Save match scouting form (BATCH mode only — see file header; the
// Save/Done button's click handler, wired in DOMContentLoaded below,
// branches to this only when currentMatchFormMode is 'batch'. This guard is
// just defensive backup against that branch ever getting out of sync. ======
async function saveMatchScoutForm() {
  if (currentMatchFormMode === 'live') return;
  const errorEl = document.getElementById('match-modal-error');
  const successEl = document.getElementById('match-modal-success');
  if (errorEl) errorEl.textContent = '';
  if (successEl) successEl.textContent = '';

  if (!currentMatchFormController) {
    errorEl.textContent = 'Form not initialized. Please reopen the form.';
    return;
  }

  // Validate required fields
  const validationError = currentMatchFormController.validate();
  if (validationError) {
    errorEl.textContent = validationError;
    return;
  }

  if (!currentUser) {
    errorEl.textContent = 'You must be signed in to scout.';
    return;
  }

  if (!currentMatchTeamNumber || !currentMatchEventCode) {
    errorEl.textContent = 'Missing team or event data. Please try again.';
    return;
  }

    const fieldValues = currentMatchFormController.getValues();
    // Locked entries (opened from the match-based view) never render a
    // matchNumber field at all — same as teamNumber/eventCode, which have
    // never been form fields — so the fixed value set when the form was
    // opened is used instead of reading one out of the (excluded) field.
    const matchNumber = currentLockedMatchNumber != null ? currentLockedMatchNumber : fieldValues.matchNumber;

    if (!matchNumber) {
      errorEl.textContent = 'Match Number is required.';
      return;
    }

    const teamId = currentTeamData?.id;
    if (!teamId) {
      errorEl.textContent = 'Team data not loaded. Please rejoin your team.';
      return;
    }

    // Warn (don't block) if this match number doesn't show up in the team's
    // actual schedule for this event — a likely typo, but not necessarily
    // wrong (e.g. a replay/reschedule not yet reflected in the published
    // schedule), so this is a confirm, not a hard stop. Confirming or
    // canceling both leave the form's entered values exactly as-is (same
    // "don't discard the user's input" pattern as the duplicate-match-number
    // block above) — canceling just returns to the form with nothing saved.
    showLoading('Checking match schedule...');
    const mismatched = await isMatchNumberMismatched(currentMatchEventCode, currentMatchTeamNumber, matchNumber);
    hideLoading();
    if (mismatched) {
      showConfirmModal({
        title: 'Match Number Not Scheduled',
        message: `Team #${currentMatchTeamNumber} isn't scheduled for Match ${matchNumber} at this event — save anyway?`,
        confirmLabel: 'Save Anyway',
        onConfirm: () => performMatchScoutSave(fieldValues, matchNumber, teamId)
      });
      return;
    }

    await performMatchScoutSave(fieldValues, matchNumber, teamId);
}

// ====== Actually write the match scouting entry — factored out of
// saveMatchScoutForm() so the schedule-mismatch confirm above can call this
// directly as its onConfirm, without duplicating the write logic. ======
async function performMatchScoutSave(fieldValues, matchNumber, teamId) {
    const errorEl = document.getElementById('match-modal-error');
    const successEl = document.getElementById('match-modal-success');
    const userDisplayName = typeof getCurrentUserDisplayName === 'function' ? getCurrentUserDisplayName() : (currentUser.email || 'Unknown');

    showLoading('Saving match scouting data...');
    try {
      // If editing a known entry, read it directly by its real id first —
      // needed for scoutedBy/scoutedAt continuity even if the match number
      // below is being changed (i.e. "moving" this entry to a new slot).
      let existingData = null;
      if (currentMatchDocId) {
        const knownDoc = await db.collection('teams').doc(teamId).collection('matchScouting').doc(currentMatchDocId).get();
        if (knownDoc.exists) existingData = knownDoc.data();
      }

      // Resolve the write target: the entry being edited, if the match
      // number hasn't changed; otherwise whatever (if anything) already
      // occupies the target match number's slot — regardless of which
      // document-ID era it was saved under (see findExistingMatchDoc()) —
      // or a fresh, collision-safe ID for a genuinely new entry/slot.
      let docId;
      if (currentMatchDocId && Number(existingData?.matchNumber) === Number(matchNumber)) {
        docId = currentMatchDocId;
      } else {
        const targetSlot = await findExistingMatchDoc(teamId, currentMatchEventCode, matchNumber, currentMatchTeamNumber);
        if (targetSlot) {
          // The target match-number slot is already occupied. That's fine
          // only if it's the SAME entry already open in this form (editing
          // in place, or "moving" it back onto its own slot) — anything
          // else is a duplicate: either a brand-new entry (currentMatchDocId
          // is null) colliding with one that already exists, or an existing
          // entry being MOVED (match number changed) onto a slot some OTHER
          // entry already occupies, which would otherwise silently merge
          // this save into that unrelated entry. Block and leave the form
          // (and whatever the user already typed) exactly as-is so they can
          // just change the match number and retry.
          if (targetSlot.id !== currentMatchDocId) {
            hideLoading();
            errorEl.textContent = `Match ${matchNumber} for this team already exists — edit that entry instead, or change the match number.`;
            return;
          }
          docId = targetSlot.id;
          existingData = targetSlot;
        } else {
          docId = `${teamId}_${currentMatchEventCode}_${matchNumber}_${currentMatchTeamNumber}`;
          if (!currentMatchDocId) existingData = null;
        }
      }

      const isExisting = !!existingData;
      const scoutedByUid = isExisting ? (existingData.scoutedBy || currentUser.uid) : currentUser.uid;

      const payload = {
        eventCode: currentMatchEventCode,
        teamNumber: Number(currentMatchTeamNumber),
        teamId: teamId || null,
        matchNumber: Number(matchNumber),
        // Tags which FTC season this entry belongs to, so form-config lookups
        // (dynamic-form.js) and exports (sheets-export.js) resolve the field
        // set that was actually active when it was scouted, not whatever the
        // current season's form looks like now. Immutable once set on an
        // existing entry (like scoutedAt below); a legacy entry saved before
        // this field existed picks one up here on its next save.
        season: (isExisting && existingData.season) ? existingData.season : resolveFormConfigSeason(),
        ...fieldValues,
        scoutedBy: scoutedByUid,
        // Raw email is never stored on entries — attribution is uid + display name only.
        scoutedByEmail: firebase.firestore.FieldValue.delete(),
        // Refresh the label whenever the original scouter is the one saving (self-heals stale/pre-feature names);
        // otherwise leave the original scouter's name alone when someone else edits their entry.
        scoutedByName: (!isExisting || scoutedByUid === currentUser.uid) ? userDisplayName : (existingData.scoutedByName || existingData.scoutedByEmail || 'Unknown'),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      };

      if (!isExisting) {
        payload.scoutedAt = firebase.firestore.FieldValue.serverTimestamp();
      } else {
        payload.scoutedAt = existingData.scoutedAt || firebase.firestore.FieldValue.serverTimestamp();
        // Moving an entry to a different match-number slot (docId changed) is
        // always a real edit even if every other field is untouched — only
        // resaving the SAME slot needs the field-by-field comparison to tell
        // whether anything actually changed.
        const sameSlot = currentMatchDocId === docId;
        if (!sameSlot || matchFormValuesChanged(fieldValues, existingData)) {
          payload.lastEditedBy = currentUser.uid;
          payload.lastEditedByEmail = firebase.firestore.FieldValue.delete();
          payload.lastEditedByName = userDisplayName;
          payload.lastEditedByTimestamp = Date.now();
        }
        if (currentMatchDocId && currentMatchDocId !== docId) {
          const oldDocRef = db.collection('teams').doc(teamId).collection('matchScouting').doc(currentMatchDocId);
          await deleteEntryWithNotice(oldDocRef, userDisplayName, currentUser.uid);
        }
      }

    await db.collection('teams').doc(teamId).collection('matchScouting').doc(docId).set(payload, { merge: true });

    hideLoading();
    if (successEl) successEl.textContent = 'Match scouting data saved!';
    if (errorEl) errorEl.textContent = '';

    // Update cache and re-render match list immediately
    if (typeof refreshMatchEntriesCache === 'function') {
      refreshMatchEntriesCache();
    }
    refreshOpenMatchListPanels();

    setTimeout(() => {
      closeMatchScoutForm();
    }, 800);
  } catch (err) {
    hideLoading();
    console.error('Failed to save match scouting data:', err);
    if (successEl) successEl.textContent = '';
    if (errorEl) {
      if (err.code === 'permission-denied') {
        errorEl.textContent = 'Permission denied: You do not have permission to edit or save this entry.';
      } else {
        errorEl.textContent = 'Failed to save. Please check your connection and try again.';
      }
    }
  }
}

// ====== Core delete logic: delete a single match entry by its known doc id,
// then refresh whichever list panels/counts are currently visible — shared by
// the edit form's own Delete button (below, which reads its state from
// whatever form is currently open) and each entry row's standalone Delete
// button in renderMatchListForTeam(), which already has the doc id on hand
// and doesn't need the form open at all. Mirrors pit-scout.js's
// deletePitScoutEntry(). ======
async function deleteMatchScoutEntry(teamId, docId) {
  const docRef = db.collection('teams').doc(teamId).collection('matchScouting').doc(docId);
  const deleterName = typeof getCurrentUserDisplayName === 'function' ? getCurrentUserDisplayName() : (currentUser?.email || 'Unknown');
  await deleteEntryWithNotice(docRef, deleterName, currentUser?.uid);
  refreshOpenMatchListPanels();
  if (typeof refreshMatchTeamListCounts === 'function') refreshMatchTeamListCounts();
}

// ====== Delete match scouting data ======
async function deleteMatchScoutData() {
  const errorEl = document.getElementById('match-modal-error');
  const successEl = document.getElementById('match-modal-success');
  errorEl.textContent = '';
  successEl.textContent = '';

  if (!currentMatchDocId || typeof showConfirmModal !== 'function') return;

  const teamId = currentTeamData?.id;
  if (!teamId) {
    errorEl.textContent = 'Team data not loaded. Please rejoin your team.';
    return;
  }

  showConfirmModal({
    title: 'Delete Match Scouting Data?',
    message: `Delete this match scouting entry for Team #${currentMatchTeamNumber}? This cannot be undone.`,
    confirmLabel: 'Delete',
    danger: true,
    onConfirm: async () => {
      showLoading('Deleting...');
      try {
        await deleteMatchScoutEntry(teamId, currentMatchDocId);
        hideLoading();
        successEl.textContent = 'Entry deleted.';
        setTimeout(() => {
          closeMatchScoutForm();
        }, 800);
      } catch (err) {
        hideLoading();
        console.error('Failed to delete match scouting data:', err);
        if (err.code === 'permission-denied') {
          errorEl.textContent = 'Permission denied: You do not have permission to edit or save this entry.';
        } else {
          errorEl.textContent = 'Failed to delete. Please check your connection and try again.';
        }
      }
    }
  });
}

// ====== Close the match scouting form's UI/module state — LIVE mode only
// (batch mode's own close path is just closeMatchScoutForm() below, since it
// never needs a commit/cancel decision). No session decision here — that's
// commitMatchScoutForm's/cancelMatchScoutForm's job; this only ever runs
// AFTER a session has already been resolved one way or another. ======
function closeMatchScoutFormUI() {
  document.getElementById('match-modal').classList.add('hidden');

  // Bug fix (low priority, cheap): optimistically clear this uid's own
  // presence from the local "who's editing" cache right away, rather than
  // waiting for leaveActiveEditors()'s write to round-trip back through this
  // same client's OWN team-list listener before the "Editing: You" tag
  // clears. matchActiveEditorsRawCache holds one raw activeEditors map PER
  // match entry for this team (not doc-id-tagged — see
  // watchMatchScoutStatus()), so this patches every entry in the array
  // rather than one specific doc; harmless, since this uid can only actually
  // be present in whichever one it just left. A real snapshot still arrives
  // shortly after and reconciles this with the server's actual state either way.
  if (currentMatchEventCode && currentMatchTeamNumber && currentUser) {
    const key = `${currentMatchEventCode}_${currentMatchTeamNumber}`;
    const rawList = matchActiveEditorsRawCache.get(key);
    if (rawList && rawList.length > 0) {
      const patchedList = rawList.map((activeEditors) => {
        if (!activeEditors || !(currentUser.uid in activeEditors)) return activeEditors;
        const patched = { ...activeEditors };
        delete patched[currentUser.uid];
        return patched;
      });
      matchActiveEditorsRawCache.set(key, patchedList);
      recomputeMatchActiveEditingFromCache();
    }
  }

  currentMatchTeamNumber = null;
  currentMatchEventCode = null;
  currentMatchDocId = null;
  currentLockedMatchNumber = null;
  currentMatchFormController = null;
  currentMatchFields = null;
  currentMatchFormMode = null;
  currentMatchLiveSession = null;
}

// ====== "Done" — LIVE mode's Save/Done button handler (batch mode uses
// saveMatchScoutForm instead — see the DOMContentLoaded wiring below).
// Mirrors pit-scout.js's commitPitScoutForm(): validates required fields
// (blocking, same dynamic-form.js rule the batch path already used) before
// committing — see live-entry-sync.js's commit() for the full checkpoint/
// scoutedBy/lastEditedBy logic. flushAll() is AWAITED (not fire-and-forget)
// so commitAndLeave()'s checkpoint read is guaranteed to see whatever was
// just typed. ======
async function commitMatchScoutForm() {
  const errorEl = document.getElementById('match-modal-error');
  if (currentMatchFormController) {
    const validationError = currentMatchFormController.validate();
    if (validationError) {
      errorEl.textContent = validationError;
      return;
    }
  }
  errorEl.textContent = '';
  if (currentMatchLiveSession) {
    // Bug fix: mirrors pit-scout.js's commitPitScoutForm() — commitAndLeave()
    // can throw (permission-denied if this uid lost edit access mid-session),
    // and this had no try/catch at all before, so a failed commit silently
    // did nothing rather than showing an error.
    try {
      await currentMatchLiveSession.flushAll();
      await currentMatchLiveSession.commitAndLeave(currentMatchFields);
    } catch (err) {
      console.error('Failed to save match scouting entry:', err);
      errorEl.textContent = err && err.code === 'permission-denied'
        ? 'Permission denied: you no longer have permission to save this entry (you may have been removed from the team, or your permissions changed). Please refresh and try again.'
        : 'Failed to save. Please check your connection and try again.';
      return;
    }
  }
  closeMatchScoutFormUI();
}

// ====== Cancel — LIVE mode only (batch mode's Cancel/X/overlay all go
// straight to closeMatchScoutForm() below instead — see the DOMContentLoaded
// wiring). Mirrors pit-scout.js's cancelPitScoutForm(): last-editor-
// triggered revert (live-entry-sync.js's cancelUndo()) — if other active
// editors remain, nothing reverts at all; only if this is the LAST active
// editor does everything differing from the latest checkpoint revert
// together. The X, the Cancel button, the inline Cancel button, and the
// overlay all call this exact same function (bug fix — they used to
// diverge). currentMatchFields is passed through since a last-editor
// revert needs the field CONFIG list, same as commitMatchScoutForm. ======
async function cancelMatchScoutForm() {
  if (currentMatchLiveSession) {
    await currentMatchLiveSession.cancelAndLeave(currentMatchFields);
  }
  closeMatchScoutFormUI();
}

// ====== Close the match scouting form after some OTHER action already
// resolved the entry's fate directly (Delete — see deleteMatchScoutData
// above), OR as batch mode's own plain Cancel/X/overlay handler (batch mode
// never has a live session, so the cancelAndLeave() below is always a no-op
// for it — this is exactly today's "just close" behavior for that mode). ======
async function closeMatchScoutForm() {
  if (currentMatchLiveSession) {
    await currentMatchLiveSession.cancelAndLeave(currentMatchFields);
  }
  closeMatchScoutFormUI();
}

// ====== Has this match entry ever actually been committed (Done clicked at
// least once), as opposed to an empty/in-progress shell created the instant
// someone opened a LIVE entry's form (see attachMatchLiveSession — live
// entries are created on open, not on an explicit save)? BATCH-mode entries
// never have this problem — they're only ever created by an explicit Save,
// which already requires matchNumber (see saveMatchScoutForm's validation)
// — so existence is still a meaningful signal for them, same as before this
// feature. The presence of the activeEditors field is what's checked to
// tell which kind of entry this is: only entries that have ever gone
// through createLiveEntrySession ever get that field at all. For a live
// entry, delegates to live-entry-sync.js's shared isEntryCommitted() — see
// that function's own comment for why checkpoint alone isn't enough (a
// LEGACY entry scouted before the checkpoint field existed has scoutedBy
// but no checkpoint, and must still count as committed, not as a draft). ======
function matchEntryIsCommitted(entry) {
  if (entry.activeEditors === undefined) return true; // batch-mode entry — existence already meant something
  return isEntryCommitted(entry);
}

// ====== Re-derive matchActiveEditingCache/matchActiveEditingNamesCache from
// the last-received raw activeEditors data (matchActiveEditorsRawCache),
// WITHOUT requiring a new Firestore snapshot. Mirrors pit-scout.js's
// recomputePitActiveEditingFromCache() — see that function's own comment
// for the CATEGORY 2 staleness-window reasoning this exists for. A team can
// have several match entries at once, so each key maps to an ARRAY of raw
// activeEditors maps (one per entry); names are deduped across all of them
// in case the same uid somehow has two of that team's match entries open
// at once. ======
function recomputeMatchActiveEditingFromCache() {
  const newActiveEditing = new Set();
  const newNames = new Map();
  matchActiveEditorsRawCache.forEach((activeEditorsList, key) => {
    const namesSet = new Set();
    activeEditorsList.forEach((activeEditors) => {
      freshActiveEditorNames(activeEditors).forEach((name) => namesSet.add(name));
    });
    if (namesSet.size > 0) {
      newActiveEditing.add(key);
      newNames.set(key, Array.from(namesSet));
    }
  });
  matchActiveEditingCache = newActiveEditing;
  matchActiveEditingNamesCache = newNames;
  if (typeof onMatchScoutedStateChanged === 'function') {
    onMatchScoutedStateChanged();
  }
}

// ====== Watch match scouting status for a given event ======
// Sets up a Firestore onSnapshot listener that updates matchEntriesCache/
// matchActiveEditingCache and calls the callback whenever data changes.
// These are two INDEPENDENT signals — see matchEntryIsCommitted() and
// isTeamBeingEditedMatch() — a live entry with no checkpoint yet can still
// have an active editor, and a committed entry can simultaneously have
// someone reopened into it.
function watchMatchScoutStatus(eventCode) {
  // Unsubscribe previous listener (and stop its periodic freshness-recheck
  // timer — see recomputeMatchActiveEditingFromCache()'s own comment).
  if (matchScoutUnsubscribe) {
    matchScoutUnsubscribe();
    matchScoutUnsubscribe = null;
  }
  if (matchActiveEditingRefreshTimer) {
    clearInterval(matchActiveEditingRefreshTimer);
    matchActiveEditingRefreshTimer = null;
  }

  matchEntriesCache = {};
  matchActiveEditingCache = new Set();
  matchActiveEditingNamesCache = new Map();
  matchActiveEditorsRawCache = new Map();

  const teamId = currentTeamData?.id;
  if (!eventCode || !teamId) {
    // No event selected, or team data not loaded yet — notify
    if (typeof onMatchScoutedStateChanged === 'function') {
      onMatchScoutedStateChanged();
    }
    return;
  }

  // Listen for our own team's match scouting docs at this event code —
  // scoped by the teams/{teamId}/matchScouting subcollection path itself
  // now, not a teamId where() clause.
  matchScoutUnsubscribe = db.collection('teams').doc(teamId).collection('matchScouting')
    .where('eventCode', '==', eventCode)
    .onSnapshot((snapshot) => {
      // Fires far more often now — every live per-field write and every
      // ~15s presence heartbeat from every active editor at this event, not
      // just an explicit save. The checks below are now synchronous
      // (checkpoint-presence and activeEditors-presence need no field-config
      // lookup, unlike the old per-field content check this replaced), but
      // the generation guard is kept anyway as cheap defense against two
      // snapshot callbacks ever somehow interleaving.
      const myGeneration = ++matchStatusWatchGeneration;

      const docsData = [];
      snapshot.forEach((doc) => docsData.push({ id: doc.id, ...doc.data() }));

      const newCache = {};
      const newRawEditors = new Map();
      for (const data of docsData) {
        const key = `${data.eventCode}_${data.teamNumber}`;
        if (matchEntryIsCommitted(data)) {
          if (!newCache[key]) newCache[key] = [];
          newCache[key].push(data);
        }
        if (!newRawEditors.has(key)) newRawEditors.set(key, []);
        newRawEditors.get(key).push(data.activeEditors);
      }

      if (myGeneration !== matchStatusWatchGeneration) return; // superseded by a newer snapshot
      matchEntriesCache = newCache;
      matchActiveEditorsRawCache = newRawEditors;
      recomputeMatchActiveEditingFromCache(); // also notifies via onMatchScoutedStateChanged()
    }, (err) => {
      console.warn('Match scouting listener error:', err);
    });

  matchActiveEditingRefreshTimer = setInterval(recomputeMatchActiveEditingFromCache, LIVE_PRESENCE_HEARTBEAT_MS);
}

// ====== Get match entries for a specific team ======
function getMatchEntriesForTeam(teamNumber, eventCode) {
  const key = `${eventCode}_${teamNumber}`;
  return matchEntriesCache[key] || [];
}

// ====== Is someone actively editing one of this team's match entries right
// now, independent of whether any of them has been committed yet? Mirrors
// pit-scout.js's isTeamBeingEditedPit() — see matchActiveEditingCache's own
// comment. ======
function isTeamBeingEditedMatch(teamNumber, eventCode) {
  const key = `${eventCode}_${teamNumber}`;
  return matchActiveEditingCache.has(key);
}

// ====== Names of everyone currently, freshly, editing any of this team's
// match entries (CATEGORY 4) — empty array if nobody is. Used by the
// team-list "Editing" badge to show who, not just that someone is. ======
function getTeamEditingNamesMatch(teamNumber, eventCode) {
  const key = `${eventCode}_${teamNumber}`;
  return matchActiveEditingNamesCache.get(key) || [];
}

// ====== Refresh match count on existing team list items ======
// Mirrors refreshTeamListScoutedState() (pit-scout.js) — an incremental DOM
// patch over the already-rendered #team-list-match rows on save/delete/live
// update, no full re-render. Unlike pit's binary scouted/unscouted, a team
// can have any number of match entries, so this shows a count badge rather
// than toggling a checkmark/row tint.
function refreshMatchTeamListCounts() {
  const eventCode = selectedEvent?.code;
  if (!eventCode) return;

  document.querySelectorAll('#team-list-match .team-item').forEach(item => {
    const teamNum = item.dataset.teamNumber;
    if (!teamNum) return;
    const count = getMatchEntriesForTeam(teamNum, eventCode).length;

    const badge = item.querySelector('.match-count-badge');
    if (badge) {
      badge.textContent = String(count);
      badge.classList.toggle('hidden', count === 0);
    }

    // Independent "someone is editing this right now" marker — see
    // isTeamBeingEditedMatch()'s own comment for why this is deliberately
    // not folded into the count badge above. Shows WHO (CATEGORY 4), via
    // the shared updateLiveEditingBadge() helper (first-api.js).
    const editingBadge = item.querySelector('.live-editing-badge');
    if (editingBadge && typeof updateLiveEditingBadge === 'function') {
      updateLiveEditingBadge(editingBadge, getTeamEditingNamesMatch(teamNum, eventCode));
    }
  });
}

// ====== Refresh match entries cache callback ======
function refreshMatchEntriesCache() {
  // The snapshot listener handles this automatically;
  // this is a no-op placeholder for manual refresh triggers.
}

// ====== Render the match list for a team in the detail view ======
// Search query for filtering the currently-displayed team's match entries by
// match number — keyed by ID prefix, same reasoning as matchBulkState above.
const matchEntrySearchQuery = { 'td-': '', 'msm-': '' };

// ====== Per-panel render-generation counter — renderMatchListForTeam() is
// async (it awaits the match form config to know which fields belong in the
// preview), and can be re-invoked for the same panel (prefix) again before an
// earlier call's await resolves (rapid snapshot updates, a search keystroke,
// ...). Each call captures the counter's value at its start, bumps it first,
// and checks after the await that no newer call has since started — if one
// has, this stale call bails without touching the DOM instead of a slower
// call clobbering a newer one's already-rendered result. ======
const matchListRenderGeneration = { 'td-': 0, 'msm-': 0 };

async function renderMatchListForTeam(eventCode, teamNumber, prefix = 'td-') {
  const container = document.getElementById(`${prefix}match-entries`);
  const countEl = document.getElementById(`${prefix}match-count`);
  const bulkState = matchBulkState[prefix];
  if (!container || !bulkState) return;

  const myGeneration = ++matchListRenderGeneration[prefix];

  const entries = getMatchEntriesForTeam(teamNumber, eventCode);

  // Sort by match number ascending (lowest at top)
  entries.sort((a, b) => (a.matchNumber || 0) - (b.matchNumber || 0));

  const query = (matchEntrySearchQuery[prefix] || '').trim();
  const filtered = query ? entries.filter(entry => String(entry.matchNumber).includes(query)) : entries;

  if (countEl) {
    countEl.textContent = query
      ? `${filtered.length} of ${entries.length} match(es) shown`
      : `${entries.length} match(es) logged`;
  }

  container.innerHTML = '';

  if (filtered.length === 0) {
    container.innerHTML = query
      ? '<p class="help-text" style="font-size:0.8rem; margin-bottom:0">No matches found for that search.</p>'
      : '<p class="help-text" style="font-size:0.8rem; margin-bottom:0">No matches logged yet.</p>';
    updateMatchBulkSelectUI(prefix);
    return;
  }

  // Which fields belong in each entry's preview (and in what order) is
  // team-configured — see form-builder.js's "Show in preview" checkbox on
  // the match form's fields. Textarea-type fields (e.g. Notes) render as
  // their own block below the line rather than jammed into it, same as the
  // old hardcoded Notes section did.
  let previewFields = [];
  const teamId = currentTeamData?.id;
  if (teamId && typeof loadMatchFormConfig === 'function') {
    try {
      // All these entries share one eventCode, so (once tagged) they share
      // one real season too — pulled from whichever entry has it tagged,
      // falling back to the app's currently-selected season if every entry
      // here predates season-tagging. Resolving once for the whole list
      // (rather than per-entry) keeps this consistent with the fact that an
      // event can never actually span two seasons.
      const listSeason = entries.find(e => e.season)?.season;
      const matchFields = await loadMatchFormConfig(teamId, listSeason);
      if (matchListRenderGeneration[prefix] !== myGeneration) return; // superseded by a newer call
      previewFields = matchFields.filter(f => f.showInPreview !== false);
    } catch (err) {
      console.warn('Failed to load match form config for preview:', err);
    }
  }
  const lineFields = previewFields.filter(f => f.type !== 'textarea');
  const blockFields = previewFields.filter(f => f.type === 'textarea');

  // Rebuilt every render so shift-click range-select always reflects the
  // CURRENT filtered/sorted order — see handleBulkRangeClick() (first-api.js).
  bulkState.order = [];
  bulkState.checkboxEls = new Map();

  filtered.forEach((entry, index) => {
    const item = document.createElement('div');
    item.className = 'match-entry-item';
    item.style.cssText = 'background:var(--card-bg, #fff); border:1px solid var(--border); border-radius:8px; padding:14px; margin-bottom:12px;';

    // Header row with match number & edit button
    const header = document.createElement('div');
    header.style.cssText = 'display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;';

    const numAndCheckbox = document.createElement('div');
    numAndCheckbox.style.cssText = 'display:flex; align-items:center; gap:8px;';

    // Bulk-select checkbox — only in select mode. Toggle visibility is already
    // permission-gated (see updateMatchBulkSelectUI), so anyone who can see the
    // mode at all is allowed to bulk-delete any entry, same as canEditOrDeleteEntry().
    if (bulkState.mode) {
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.style.cssText = 'width:18px; height:18px; flex-shrink:0; cursor:pointer;';
      checkbox.checked = bulkState.selectedIds.has(entry.id);
      bulkState.order.push(entry.id);
      bulkState.checkboxEls.set(entry.id, checkbox);
      markBulkAnchorCheckbox(checkbox, entry.id, bulkState.rangeState);
      // 'click' (not 'change') so shiftKey is available — see handleBulkRangeClick() (first-api.js).
      checkbox.addEventListener('click', (e) => {
        e.stopPropagation();
        handleBulkRangeClick(e, entry.id, bulkState.order, bulkState.checkboxEls, bulkState.selectedIds, bulkState.rangeState, () => updateMatchBulkSelectUI(prefix));
      });
      numAndCheckbox.appendChild(checkbox);
    }

    const matchNumSpan = document.createElement('span');
    matchNumSpan.style.cssText = 'font-weight:600; font-size:1.05rem; color:var(--text-main);';
    matchNumSpan.textContent = `Match #${entry.matchNumber}`;
    numAndCheckbox.appendChild(matchNumSpan);

    header.appendChild(numAndCheckbox);

    // Always rendered now, regardless of permission — an unauthorized user
    // clicking it finds out why via showNoticeModal(), rather than the
    // control simply being absent with no way to discover the reason.
    const editBtn = document.createElement('button');
    editBtn.className = 'btn btn-small btn-outline';
    editBtn.textContent = 'Edit';
    const canEditThisEntry = typeof canUserEditOtherEntries === 'function'
      ? canUserEditOtherEntries(entry)
      : (entry.scoutedBy === currentUser?.uid);
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!canEditThisEntry) {
        if (typeof showNoticeModal === 'function') {
          showNoticeModal({ title: 'Permission Denied', message: 'You do not have permission to edit this match scouting entry.' });
        }
        return;
      }
      openMatchScoutEdit(entry.id, entry);
    });
    header.appendChild(editBtn);

    // Standalone one-click Delete — same permission rule as Edit (own entry
    // always allowed, otherwise needs canEditOtherEntries) and, like Edit,
    // always rendered with a Permission Denied notice on click rather than
    // hidden, so an unauthorized user can still discover why. Mirrors the
    // Team Detail popup's pit-entry Delete button (team-info.js), just
    // per-row instead of a single section-level button since a team can have
    // many match entries.
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'btn btn-small';
    deleteBtn.style.cssText = 'background:var(--error); color:#fff; border-color:var(--error);';
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!canEditThisEntry) {
        if (typeof showNoticeModal === 'function') {
          showNoticeModal({ title: 'Permission Denied', message: 'You do not have permission to delete this match scouting entry.' });
        }
        return;
      }
      if (typeof showConfirmModal !== 'function') return;
      showConfirmModal({
        title: 'Delete Match Scouting Entry?',
        message: `Delete Match #${entry.matchNumber} for Team #${teamNumber}? This cannot be undone.`,
        confirmLabel: 'Delete',
        danger: true,
        onConfirm: async () => {
          const teamId = currentTeamData?.id;
          if (!teamId) return;
          showLoading('Deleting...');
          try {
            await deleteMatchScoutEntry(teamId, entry.id);
          } catch (err) {
            console.error('Failed to delete match scouting entry:', err);
            if (typeof showNoticeModal === 'function') {
              showNoticeModal({
                title: 'Delete Failed',
                message: err.code === 'permission-denied'
                  ? 'Permission denied: you do not have permission to delete this entry.'
                  : 'Failed to delete. Please check your connection and try again.'
              });
            }
          } finally {
            hideLoading();
          }
        }
      });
    });
    header.appendChild(deleteBtn);
    item.appendChild(header);

    // Metadata line
    const meta = document.createElement('div');
    meta.style.cssText = 'font-size:0.8rem; color:var(--text-muted); margin-bottom:8px;';
    const scoutedBy = entry.scoutedByName || entry.scoutedByEmail || 'Unknown';
    const lastEditedBy = entry.lastEditedByName || entry.lastEditedByEmail || 'N/A';
    meta.textContent = `Scouted by: ${scoutedBy} | Last edited by: ${lastEditedBy}`;
    item.appendChild(meta);

    // Preview line — one "Label: value" pair per configured non-textarea
    // preview field, pipe-delimited. Missing/empty values show as '—'.
    if (lineFields.length > 0) {
      const metrics = document.createElement('div');
      metrics.style.cssText = 'font-size:0.9rem; font-weight:500; margin-bottom:8px; padding:6px 10px; background: rgba(255, 255, 255, 0.08); color: var(--text-main, #ffffff); border-radius:6px;';
      metrics.textContent = lineFields.map(f => {
        const val = entry[f.id];
        const display = typeof formatFieldValueForDisplay === 'function'
          ? formatFieldValueForDisplay(val)
          : ((val === null || val === undefined || val === '') ? '—' : val);
        return `${f.label}: ${display}`;
      }).join(' | ');
      item.appendChild(metrics);
    }

    // Preview blocks — configured textarea-type fields (e.g. Notes), each
    // its own block below the line. Skipped entirely when empty, same as the
    // old hardcoded Notes section did.
    blockFields.forEach(f => {
      const val = entry[f.id];
      if (val === null || val === undefined || val === '') return;
      const blockEl = document.createElement('div');
      blockEl.style.cssText = 'font-size:0.85rem; color:var(--text-main); margin-top:8px; padding-top:8px; border-top:1px dashed var(--border);';
      blockEl.textContent = `${f.label}: ${val}`;
      item.appendChild(blockEl);
    });

    container.appendChild(item);
  });

  resolveBulkAnchor(bulkState.order, bulkState.checkboxEls, bulkState.rangeState);
  updateMatchBulkSelectUI(prefix);
}

// ====== Refresh whichever match-list panel(s) are actually open (Team Detail
// modal's 'td-' panel, "View Matches Scouted" modal's 'msm-' panel, or both)
// after data changes — a save, a delete, a bulk delete, or a live snapshot
// update from anyone on the team. Each panel's own team/event state is only
// ever non-null while that modal is open (see closeTeamDetailModal() /
// closeMatchScoutedModal()), so this is safe to call unconditionally. ======
function refreshOpenMatchListPanels() {
  if (typeof renderMatchListForTeam !== 'function') return;

  if (typeof currentSelectedTeamNumber !== 'undefined' && currentSelectedTeamNumber && selectedEvent?.code) {
    renderMatchListForTeam(selectedEvent.code, currentSelectedTeamNumber, 'td-');
  }
  if (typeof currentMatchScoutedTeamNumber !== 'undefined' && currentMatchScoutedTeamNumber && currentMatchScoutedEventCode) {
    renderMatchListForTeam(currentMatchScoutedEventCode, currentMatchScoutedTeamNumber, 'msm-');
  }
}

// ====== Callback for match scouted state changes (set by first-api.js) ======
let onMatchScoutedStateChanged = null;

// ====== Wire up event handlers ======
document.addEventListener('DOMContentLoaded', () => {
  // Save/Done button — branches by mode: batch mode still does a real,
  // validating write (saveMatchScoutForm, unchanged); live mode commits
  // (also validates — see commitMatchScoutForm) and leaves.
  document.getElementById('btn-match-save').addEventListener('click', () => {
    if (currentMatchFormMode === 'live') commitMatchScoutForm();
    else saveMatchScoutForm();
  });

  // Cancel / close buttons — branch by mode too: batch mode is a plain
  // discard-and-close exactly as before (it never has a live session to
  // begin with); live mode cancels (discards the whole entry if nobody's
  // committed it yet and this is the last active editor — see
  // cancelMatchScoutForm/live-entry-sync.js).
  const handleMatchCancelClick = () => {
    if (currentMatchFormMode === 'live') cancelMatchScoutForm();
    else closeMatchScoutForm();
  };
  document.getElementById('btn-match-cancel').addEventListener('click', handleMatchCancelClick);
  document.getElementById('match-modal-overlay').addEventListener('click', handleMatchCancelClick);
  document.getElementById('btn-match-cancel-inline').addEventListener('click', handleMatchCancelClick);

  // Delete button
  document.getElementById('match-delete-btn').addEventListener('click', deleteMatchScoutData);

  // Set the scouted state change callback — refreshes whichever match-list
  // panel(s) are actually open (not just the Team Detail modal's), plus the
  // Match Scouting tab's own team-list counts.
  if (typeof onMatchScoutedStateChanged !== 'undefined') {
    onMatchScoutedStateChanged = () => {
      refreshOpenMatchListPanels();
      if (typeof refreshMatchTeamListCounts === 'function') refreshMatchTeamListCounts();
      // Neither of the above ever touches the team-level Delete button — it
      // used to stay permanently absent until some unrelated full re-render
      // happened to fire first. Patch it here too so it appears as soon as
      // this event's first match-scouting snapshot actually arrives.
      if (typeof refreshTeamRowDeleteButtons === 'function') refreshTeamRowDeleteButtons();
    };
  }

  // Wires the search box, bulk-select toggle, and bulk delete for ONE
  // match-list panel (identified by its ID prefix) to its own context
  // resolver — so the Team Detail modal's 'td-' panel and the "View Matches
  // Scouted" modal's 'msm-' panel each act on their own team/event and their
  // own matchBulkState/matchEntrySearchQuery entry, independently.
  function wireMatchListPanelControls(prefix, getContext) {
    const searchInput = document.getElementById(`${prefix}match-entry-search`);
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        matchEntrySearchQuery[prefix] = e.target.value;
        const { teamNumber, eventCode } = getContext();
        if (teamNumber && eventCode) {
          renderMatchListForTeam(eventCode, teamNumber, prefix);
        }
      });
    }

    const toggleBtn = document.getElementById(`${prefix}match-bulk-select-toggle`);
    if (toggleBtn) {
      toggleBtn.addEventListener('click', () => {
        const state = matchBulkState[prefix];
        state.mode = !state.mode;
        state.selectedIds.clear();
        const { teamNumber, eventCode } = getContext();
        if (teamNumber && eventCode) {
          renderMatchListForTeam(eventCode, teamNumber, prefix);
        } else {
          updateMatchBulkSelectUI(prefix);
        }
      });
    }

    const deleteBtn = document.getElementById(`${prefix}match-bulk-delete`);
    if (deleteBtn) {
      deleteBtn.addEventListener('click', () => {
        const state = matchBulkState[prefix];
        const entryIds = [...state.selectedIds];
        if (entryIds.length === 0 || typeof showConfirmModal !== 'function') return;

        showConfirmModal({
          title: 'Delete Match Scouting Data?',
          message: `Delete ${entryIds.length} match scouting entr${entryIds.length === 1 ? 'y' : 'ies'}? This cannot be undone.`,
          confirmLabel: 'Delete',
          danger: true,
          onConfirm: async () => {
            showLoading('Deleting selected entries...');
            let results = { succeeded: [], failed: [] };
            try {
              results = await bulkDeleteMatchScoutData(entryIds);
            } finally {
              hideLoading();
            }

            const statusEl = document.getElementById(`${prefix}match-bulk-delete-status`);
            if (statusEl) {
              if (results.failed.length > 0) {
                console.error('Bulk match delete: failed entry IDs:', results.failed);
                statusEl.textContent = `Deleted ${results.succeeded.length} of ${entryIds.length} entries — ${results.failed.length} failed`;
                statusEl.className = 'error-message';
              } else {
                statusEl.textContent = `Deleted ${results.succeeded.length} entr${results.succeeded.length === 1 ? 'y' : 'ies'}.`;
                statusEl.className = 'success-message';
              }
              setTimeout(() => { statusEl.textContent = ''; statusEl.className = ''; }, 5000);
            }

            state.mode = false;
            state.selectedIds.clear();
            refreshOpenMatchListPanels();
          }
        });
      });
    }
  }

  wireMatchListPanelControls('td-', () => ({
    teamNumber: currentSelectedTeamNumber,
    eventCode: selectedEvent?.code
  }));
  wireMatchListPanelControls('msm-', () => ({
    teamNumber: typeof currentMatchScoutedTeamNumber !== 'undefined' ? currentMatchScoutedTeamNumber : null,
    eventCode: typeof currentMatchScoutedEventCode !== 'undefined' ? currentMatchScoutedEventCode : null
  }));
});