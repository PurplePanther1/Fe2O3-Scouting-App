// ====== Pit Scouting Form ======
// Data stored in Firestore at teams/{teamId}/pitScouting/{docId} (moved from
// the flat top-level "pitScouting" collection as part of the data reorg —
// matchScouting is still flat and unaffected by this move).
// Document ID: `${teamId}_${eventCode}_${teamNumber}` — teamId (the SCOUTING
// team's own Firestore team ID) is included specifically so two different
// scouting teams can never collide on the same document by both happening to
// scout the same real-world target team at the same event. Now that the
// collection itself is scoped per-team by its path, this prefix is redundant
// for new docs, but kept for ID-format continuity with pre-migration data.
// Older entries (saved before this existed) used `${eventCode}_${teamNumber}`
// — those are left as-is (see findExistingPitDoc() below, which finds either
// era by querying data fields rather than guessing an ID) rather than
// migrated.
// Fields: eventCode, teamNumber, teamId, season, plus dynamic fields from
//         formConfig, scoutedBy/scoutedByName ("created by" — set exactly
//         once, at the entry's first successful commit, permanent from then
//         on), scoutedAt, lastEditedBy/lastEditedByName/lastEditedByTimestamp
//         (set only when a commit's checkpoint genuinely differs from the
//         prior one — see live-entry-sync.js's commit()), updatedAt,
//         checkpoint (snapshot of field values as of the latest commit),
//         activeEditors (live-entry-sync.js).
//
// Pit entries are always live: opening the form joins a live session via
// live-entry-sync.js — there's no separate batch-save mode the way match
// scouting has for its team-based view (pit has no equivalent "locked vs
// manual" split to preserve). The Save button is relabeled "Done" and
// commits (see commitPitScoutForm); every other way of closing the modal
// cancels — a per-field, per-user undo back to the latest checkpoint (see
// cancelPitScoutForm/live-entry-sync.js's cancelUndo()).

let currentPitTeamNumber = null;
let currentPitEventCode = null;
let pitScoutUnsubscribe = null; // Firestore snapshot listener (status/"is this team scouted" listener — see watchPitScoutStatus)
// All caches below are keyed by "eventCode_teamNumber" (data-derived), NOT
// the real Firestore document ID — this makes every reader of these caches
// (isTeamScouted, getPitScoutedEntry, isTeamBeingEditedPit, etc.)
// automatically work the same way regardless of which document-ID era an
// entry was saved under. The real ID (needed for edit/delete) is still
// available via each cached entry's own `.id` property. scoutedTeamsCache/
// pitScoutedEntriesCache only include entries that have actually been
// committed — see pitEntryIsCommitted() / watchPitScoutStatus() — while the
// activeEditing caches below are populated independently of that.
let scoutedTeamsCache = new Set(); // Set of "eventCode_teamNumber" keys with a real checkpoint (see pitEntryIsCommitted()) — this is the "scouted" checkmark signal
let pitScoutedEntriesCache = new Map(); // "eventCode_teamNumber" -> full entry data (incl. real doc id, scoutedBy), for permission checks — same committed-only population as scoutedTeamsCache
let pitActiveEditingCache = new Set(); // Set of "eventCode_teamNumber" keys with at least one fresh active editor right now — INDEPENDENT of scoutedTeamsCache (an uncommitted draft can be actively edited too), see isTeamBeingEditedPit()
let pitActiveEditingNamesCache = new Map(); // "eventCode_teamNumber" -> array of fresh editor names, for the team-list badge's text (CATEGORY 4) — see getTeamEditingNamesPit()
let pitActiveEditorsRawCache = new Map(); // "eventCode_teamNumber" -> raw activeEditors map from the last snapshot received, kept so recomputePitActiveEditingFromCache() can re-derive freshness on a timer WITHOUT waiting for a new snapshot — see that function's own comment for why a snapshot-only re-evaluation can leave the "Editing" badge stuck past its intended ~45s staleness window
let pitActiveEditingRefreshTimer = null; // setInterval handle, tied to watchPitScoutStatus()'s own listener lifecycle — see recomputePitActiveEditingFromCache()
let currentFormController = null; // returned by renderDynamicForm
let currentPitFields = null; // the field config rendered into the open form, needed by the live session's snapshot handler
let currentPitLiveSession = null; // returned by createLiveEntrySession (live-entry-sync.js)
let pitStatusWatchGeneration = 0; // guards against a slower, superseded async snapshot handler clobbering a newer one's result — see watchPitScoutStatus()

// ====== Find this team's existing pit-scouting entry for (eventCode,
// teamNumber), regardless of which document-ID scheme it was saved under.
// Queries by data fields (teamId/eventCode/teamNumber — all equality
// filters, no composite index needed) rather than guessing/constructing an
// ID, so it transparently finds entries from either era and — critically —
// can never even attempt to touch a DIFFERENT team's doc that happens to
// share the old, unscoped ID format. Returns { id, ...data } or null. ======
async function findExistingPitDoc(teamId, eventCode, teamNumber) {
  const snap = await db.collection('teams').doc(teamId).collection('pitScouting')
    .where('eventCode', '==', eventCode)
    .where('teamNumber', '==', Number(teamNumber))
    .limit(1)
    .get();
  if (snap.empty) return null;
  const doc = snap.docs[0];
  return { id: doc.id, ...doc.data() };
}

// ====== Open the pit scouting form (modal) ======
async function openPitScoutForm(teamNumber, eventCode) {
  currentPitTeamNumber = teamNumber;
  currentPitEventCode = eventCode;

  // Reset modal chrome — harmless even before we know whether the modal
  // will actually be shown this call (see below).
  document.getElementById('pit-modal-title').textContent = `Pit Scout Team #${teamNumber}`;
  document.getElementById('pit-modal-error').textContent = '';
  document.getElementById('pit-modal-success').textContent = '';
  document.getElementById('pit-delete-btn').classList.add('hidden');
  const presenceBanner = document.getElementById('pit-presence-banner');
  presenceBanner.classList.add('hidden');
  presenceBanner.textContent = '';

  // The modal itself stays HIDDEN until the access check below actually
  // passes — bug fix: it used to be shown unconditionally right here, then
  // hidden again a moment later on a permission-denied result, a visible
  // flash of the modal shell right before the denial notice.

  // Clear synchronously, before any await below — otherwise whatever team
  // was rendered here last stays visible for however long the access
  // check/form-config/existing-data fetches take.
  document.getElementById('pit-dynamic-fields').innerHTML = '';
  currentFormController = null;
  // Defensive re-entrancy guard (e.g. a rapid double-open before the first
  // finished rendering) — treat abandoning whatever was open as a cancel,
  // same as clicking Cancel would: never silently keep an uncommitted
  // session's data just because a second open happened to interrupt it.
  // Capture currentPitFields BEFORE clearing it below — cancelAndLeave()
  // needs the OLD session's own field config for its checkpoint-diff
  // revert (see live-entry-sync.js's cancelUndo()), not whatever fields
  // this new open is about to load.
  if (currentPitLiveSession) {
    const staleFields = currentPitFields;
    currentPitLiveSession.cancelAndLeave(staleFields);
    currentPitLiveSession = null;
  }
  currentPitFields = null;

  // Get field configuration and render dynamic form
  const teamId = currentTeamData?.id;
  if (!teamId) {
    document.getElementById('pit-modal').classList.remove('hidden');
    document.getElementById('pit-modal-error').textContent = 'Team data not loaded. Please rejoin your team.';
    return;
  }
  if (!currentUser) {
    document.getElementById('pit-modal').classList.remove('hidden');
    document.getElementById('pit-modal-error').textContent = 'You must be signed in to scout.';
    return;
  }

  try {
    // Load existing data first so an edit resolves fields for THAT entry's
    // own season (falling back to the app's currently-selected season for a
    // brand-new entry, or a legacy entry saved before season-tagging
    // existed) — editing an old entry should show the field set that was
    // active when it was scouted, not whatever the current season's form
    // looks like now.
    const existingData = await loadExistingPitData(teamId, eventCode, teamNumber);

    const access = classifyLiveEntryAccess(existingData, canUserEditOtherEntries);
    if (access.blocked) {
      // Never shown the modal at all in this branch — the access check ran
      // to completion before any modal UI appeared, so there's nothing to
      // hide here (see the flash-fix comment above).
      if (typeof showNoticeModal === 'function') {
        showNoticeModal({ title: 'Permission Denied', message: 'You do not have permission to edit this pit scouting entry.' });
      }
      currentPitTeamNumber = null;
      currentPitEventCode = null;
      return;
    }

    // Access confirmed — safe to show the modal now.
    document.getElementById('pit-modal').classList.remove('hidden');

    const fields = await loadFormConfig(teamId, existingData?.season);
    currentPitFields = fields;
    const container = document.getElementById('pit-dynamic-fields');
    currentFormController = renderDynamicForm(container, fields, existingData);

    if (existingData) {
      document.getElementById('pit-delete-btn').classList.remove('hidden');
    }

    const teamId2 = teamId; // captured for the closures below
    const docId = existingData ? existingData.id
      : `${teamId}_${eventCode}_${teamNumber}`;
    const docRef = db.collection('teams').doc(teamId2).collection('pitScouting').doc(docId);
    const displayName = typeof getCurrentUserDisplayName === 'function' ? getCurrentUserDisplayName() : (currentUser.email || 'Unknown');

    currentPitLiveSession = createLiveEntrySession({
      docRef,
      uid: currentUser.uid,
      displayName,
      canEditFn: canUserEditOtherEntries,
      onLostEditAccess: () => {
        // CATEGORY 3: this entry just became committed (by someone else)
        // while this non-privileged session was still active in it — see
        // live-entry-sync.js's createLiveEntrySession() for the full
        // detection/cleanup this callback fires AFTER. The session is
        // already detached and cleaned up by the time this runs; this only
        // needs to close the UI and explain what happened, the same way a
        // kicked team member gets a clear notice rather than a silent or
        // confusing failure.
        closePitScoutFormUI();
        if (typeof showNoticeModal === 'function') {
          showNoticeModal({
            title: 'Entry Saved',
            message: 'This entry was just saved by another editor. Since it\'s now been scouted, only its owner, a captain, or someone with edit-others permission can continue editing it — you were disconnected. Any of your edits that had already synced remain saved; anything typed in the last moment before this may not have.'
          });
        }
      },
      onSnapshotData: (data) => {
        if (!currentFormController || !currentPitFields) return;
        applyRemoteFieldValues(currentFormController, currentPitFields, data, currentPitLiveSession);
        applyPresenceIndicators(currentFormController, currentPitFields, data?.activeEditors, currentUser.uid);
        renderPresenceBanner(document.getElementById('pit-presence-banner'), data?.activeEditors, currentUser.uid, !!data?.checkpoint);
      }
    });

    // Always join and start editing immediately — the caller already ruled
    // out the one case that shouldn't be allowed to (access.blocked, above).
    // Whether zero or several people are already active makes no difference
    // here for a still-uncommitted draft: firestore.rules' canJoinOrEditEntry()
    // permits open co-editing on a draft, and testing showed gating it behind
    // an extra "Take Over" click added friction without adding real
    // protection. Once an entry has been committed, though, that door is
    // closed (CATEGORY 3) — classifyLiveEntryAccess() above already accounts
    // for this, so reaching this line means either the entry is still a
    // draft, or this user independently qualifies to edit it.
    // No scoutedBy/scoutedByName/scoutedAt here — those are only ever set by
    // commitPitScoutForm's first successful Done now, never at doc-creation
    // time (see createLiveEntrySession's join()/commit() for why).
    await currentPitLiveSession.join({
      eventCode,
      teamNumber: Number(teamNumber),
      teamId: teamId2,
      season: existingData?.season || resolveFormConfigSeason()
    });
    wireLiveFormFields(currentFormController, fields, currentPitLiveSession);
  } catch (err) {
    console.error('Failed to render form:', err);
    document.getElementById('pit-modal').classList.remove('hidden');
    // A rare TOCTOU race: the entry became committed by someone else in the
    // brief window between the access check above and this join() write
    // actually landing (CATEGORY 3's gate is enforced server-side too, not
    // just at classifyLiveEntryAccess() time). Worth a clearer message than
    // the generic fallback below, since it's not really a load failure.
    document.getElementById('pit-modal-error').textContent = err && err.code === 'permission-denied'
      ? 'This entry was just saved by someone else and can no longer be joined. Please close and reopen it.'
      : 'Failed to load form. Please try again.';
  }
}

// ====== Has this pit entry ever actually been committed (Done clicked at
// least once), as opposed to an empty/in-progress shell created the instant
// someone opened the form (live entries are created on open, not on an
// explicit save — see createLiveEntrySession in live-entry-sync.js)? Thin
// wrapper over live-entry-sync.js's shared isEntryCommitted() — see that
// function's own comment for why checkpoint alone isn't enough (a LEGACY
// entry scouted before the checkpoint field existed has scoutedBy but no
// checkpoint, and must still count as committed here, not as a draft). See
// watchPitScoutStatus(). ======
function pitEntryIsCommitted(entry) {
  return isEntryCommitted(entry);
}

// ====== Load existing pit scouting data ======
async function loadExistingPitData(teamId, eventCode, teamNumber) {
  try {
    return await findExistingPitDoc(teamId, eventCode, teamNumber);
  } catch (err) {
    console.warn('Could not load existing pit data:', err);
  }
  return null;
}

// ====== "Done" — commits the entry (see live-entry-sync.js's commit() for
// the full checkpoint/scoutedBy/lastEditedBy logic). Required fields
// (dynamic-form.js's own validate(), same rule the old batch-save path
// used) must be filled in before a commit is allowed, so an incomplete
// entry can't be silently walked away from as if it were finished.
// flushAll() is AWAITED here (not fire-and-forget) specifically so
// commitAndLeave()'s checkpoint read is guaranteed to see whatever was just
// typed, not a stale pre-flush value. ======
async function commitPitScoutForm() {
  const errorEl = document.getElementById('pit-modal-error');
  if (currentFormController) {
    const validationError = currentFormController.validate();
    if (validationError) {
      errorEl.textContent = validationError;
      return;
    }
  }
  errorEl.textContent = '';
  if (currentPitLiveSession) {
    await currentPitLiveSession.flushAll();
    await currentPitLiveSession.commitAndLeave(currentPitFields);
  }
  closePitScoutFormUI();
}

// ====== Cancel — the X, the Cancel button, the inline Cancel button, and
// clicking the overlay all call this exact same function with no
// differences between them (bug fix — they used to diverge). Last-editor-
// triggered revert (see live-entry-sync.js's cancelUndo()): if other active
// editors remain, nothing reverts at all — this session's edits (and
// everyone else's) stay live, untouched, for whoever commits or cancels
// next; only if this is the LAST active editor does everything that differs
// from the latest checkpoint revert together. Any pending debounced write is
// discarded, not flushed — see cancelAndLeave()'s own comment for why
// flushing first would be wrong here. currentPitFields is passed through
// since a last-editor revert needs the field CONFIG list to know what to
// compare against the checkpoint, same as commitPitScoutForm needs it. ======
async function cancelPitScoutForm() {
  if (currentPitLiveSession) {
    await currentPitLiveSession.cancelAndLeave(currentPitFields);
  }
  closePitScoutFormUI();
}

// ====== Core delete logic: resolve the real doc, delete it, and clean up
// caches/UI — shared by the edit form's own Delete button (below, which
// reads its state from whatever form is currently open) and the Team Detail
// popup's standalone Delete button (team-info.js), which already has the
// team/event/team-number on hand and doesn't need the form open at all. ======
async function deletePitScoutEntry(teamId, eventCode, teamNumber) {
  // Resolve the real doc id (regardless of which ID era it was saved
  // under) rather than guessing — same reasoning as findExistingPitDoc()'s own doc comment.
  const existing = await findExistingPitDoc(teamId, eventCode, teamNumber);
  if (existing) {
    await db.collection('teams').doc(teamId).collection('pitScouting').doc(existing.id).delete();
  }
  const cacheKey = `${eventCode}_${teamNumber}`;
  scoutedTeamsCache.delete(cacheKey);
  pitScoutedEntriesCache.delete(cacheKey);
  refreshTeamListScoutedState();
}

// ====== Delete pit scouting data ======
async function deletePitScoutData() {
  const errorEl = document.getElementById('pit-modal-error');
  const successEl = document.getElementById('pit-modal-success');
  errorEl.textContent = '';
  successEl.textContent = '';

  if (!currentPitTeamNumber || !currentPitEventCode) return;

  const teamId = currentTeamData?.id;
  if (!teamId) {
    errorEl.textContent = 'Team data not loaded. Please rejoin your team.';
    return;
  }

  if (typeof showConfirmModal !== 'function') return;
  showConfirmModal({
    title: 'Delete Pit Scouting Data?',
    message: `Delete pit scouting data for Team #${currentPitTeamNumber}? This cannot be undone.`,
    confirmLabel: 'Delete',
    danger: true,
    onConfirm: async () => {
      showLoading('Deleting...');
      try {
        await deletePitScoutEntry(teamId, currentPitEventCode, currentPitTeamNumber);
        hideLoading();
        successEl.textContent = 'Data deleted.';
        setTimeout(() => {
          closePitScoutForm();
        }, 800);
      } catch (err) {
        hideLoading();
        console.error('Failed to delete pit scouting data:', err);
        if (err.code === 'permission-denied') {
          errorEl.textContent = 'Permission denied: You do not have permission to edit or save this entry.';
        } else {
          errorEl.textContent = 'Failed to delete. Please check your connection and try again.';
        }
      }
    }
  });
}

// ====== Bulk-delete pit scouting entries by real doc id ======
// Each delete goes through the same teams/{teamId}/pitScouting doc(id).delete() call
// as the single-entry path above, so Firestore rules (canEditOrDeleteEntry) enforce
// permission per-document exactly as they already do — this is a UI convenience for
// issuing several deletes at once, not a separate/bypassed code path. Reads teamId
// from currentTeamData (like save/delete above) since callers only ever operate on
// the current team's own bulk-selected entries.
async function bulkDeletePitScoutData(docIds) {
  const results = { succeeded: [], failed: [] };
  const teamId = currentTeamData?.id;
  if (!teamId) {
    return { succeeded: [], failed: [...docIds] };
  }
  for (const docId of docIds) {
    try {
      await db.collection('teams').doc(teamId).collection('pitScouting').doc(docId).delete();
      // pitScoutedEntriesCache is keyed by data (eventCode_teamNumber), not
      // the real doc id we have here — find which cache key holds this doc
      // to clean it up optimistically (the live listener will also catch up
      // shortly regardless, this just avoids the visible delay).
      for (const [key, entry] of pitScoutedEntriesCache.entries()) {
        if (entry.id === docId) {
          scoutedTeamsCache.delete(key);
          pitScoutedEntriesCache.delete(key);
          break;
        }
      }
      results.succeeded.push(docId);
    } catch (err) {
      console.error(`Failed to delete pit scouting data for ${docId}:`, err);
      results.failed.push(docId);
    }
  }
  refreshTeamListScoutedState();
  return results;
}

// ====== Close the pit scouting form's UI/module state — no session
// decision here (that's commitPitScoutForm's/cancelPitScoutForm's job);
// this only ever runs AFTER a session has already been resolved one way or
// another (or never existed). ======
function closePitScoutFormUI() {
  document.getElementById('pit-modal').classList.add('hidden');
  currentPitTeamNumber = null;
  currentPitEventCode = null;
  currentFormController = null;
  currentPitFields = null;
  currentPitLiveSession = null;

  // If the Team Detail modal (Team Information tab) is open behind this form,
  // refresh its pit data section — covers the save/delete case (already refreshed
  // via refreshTeamListScoutedState, but harmless to repeat) as well as a plain
  // cancel/close, so the section never shows anything stale after this closes.
  if (currentSelectedTeamNumber && typeof renderPitDataForTeam === 'function' && selectedEvent?.code) {
    renderPitDataForTeam(currentSelectedTeamNumber, selectedEvent.code);
  }
}

// ====== Close the pit scouting form after some OTHER action already
// resolved the entry's fate directly (currently: Delete — deletePitScoutData
// below deletes the doc itself, outside the commit/cancel flow). Calls
// cancelAndLeave() as a safe generic default — against an already-deleted
// doc that's just a no-op (cancelUndo()'s transaction sees the doc doesn't
// exist and returns without touching anything). ======
async function closePitScoutForm() {
  if (currentPitLiveSession) {
    await currentPitLiveSession.cancelAndLeave(currentPitFields);
  }
  closePitScoutFormUI();
}

// ====== Re-derive pitActiveEditingCache/pitActiveEditingNamesCache from the
// last-received raw activeEditors data (pitActiveEditorsRawCache), WITHOUT
// requiring a new Firestore snapshot. Called both right after a fresh
// snapshot arrives (watchPitScoutStatus below) AND on a periodic timer
// (CATEGORY 2 fix): isPresenceFresh()'s ~45s staleness window is otherwise
// only ever re-evaluated when a new snapshot pushes in, but if whoever had
// an entry open just closes their tab/refreshes (no beforeunload hook calls
// cancelAndLeave — see live-entry-sync.js), their stale activeEditors entry
// just sits in the document, and if nobody else happens to write to that
// SPECIFIC doc again, no new snapshot ever arrives to re-run the freshness
// check — the "Editing" badge would then stay stuck showing them as active
// indefinitely, well past the intended 45s window, instead of
// self-correcting. Re-running this on a timer, independent of whether new
// data has arrived, closes that gap. ======
function recomputePitActiveEditingFromCache() {
  const newActiveEditing = new Set();
  const newNames = new Map();
  pitActiveEditorsRawCache.forEach((activeEditors, key) => {
    const names = freshActiveEditorNames(activeEditors);
    if (names.length > 0) {
      newActiveEditing.add(key);
      newNames.set(key, names);
    }
  });
  pitActiveEditingCache = newActiveEditing;
  pitActiveEditingNamesCache = newNames;
  if (typeof onScoutedStateChanged === 'function') {
    onScoutedStateChanged();
  }
}

// ====== Watch pit scouting status for a given event ======
// Sets up a Firestore onSnapshot listener that updates scoutedTeamsCache/
// pitActiveEditingCache and calls the callback whenever data changes. These
// are two INDEPENDENT signals, not one — see pitEntryIsCommitted() and
// isTeamBeingEditedPit() — since a live entry's doc exists from the moment
// its form is opened (see openPitScoutForm), not from an explicit save, a
// draft can be actively being edited with no checkpoint yet, and a
// committed entry can simultaneously have someone reopened into it.
function watchPitScoutStatus(eventCode) {
  // Unsubscribe previous listener (and stop its periodic freshness-recheck
  // timer — see recomputePitActiveEditingFromCache()'s own comment).
  if (pitScoutUnsubscribe) {
    pitScoutUnsubscribe();
    pitScoutUnsubscribe = null;
  }
  if (pitActiveEditingRefreshTimer) {
    clearInterval(pitActiveEditingRefreshTimer);
    pitActiveEditingRefreshTimer = null;
  }

  scoutedTeamsCache.clear();
  pitScoutedEntriesCache.clear();
  pitActiveEditingCache.clear();
  pitActiveEditingNamesCache.clear();
  pitActiveEditorsRawCache.clear();

  const teamId = currentTeamData?.id;
  if (!eventCode || !teamId) {
    // No event selected, or team data not loaded yet — clear and notify
    if (typeof onScoutedStateChanged === 'function') {
      onScoutedStateChanged();
    }
    return;
  }

  // Listen for our own team's pit scouting docs at this event code — scoped
  // by the teams/{teamId}/pitScouting subcollection path itself now, not a
  // teamId where() clause.
  pitScoutUnsubscribe = db.collection('teams').doc(teamId).collection('pitScouting')
    .where('eventCode', '==', eventCode)
    .onSnapshot((snapshot) => {
      // This listener fires far more often than a plain save would — every
      // live per-field write and every ~15s presence heartbeat from every
      // active editor at this event. The checks below are now synchronous
      // (checkpoint-presence and activeEditors-presence need no field-config
      // lookup, unlike the old per-field content check this replaced), but
      // the generation guard is kept anyway as cheap defense against two
      // snapshot callbacks ever somehow interleaving.
      const myGeneration = ++pitStatusWatchGeneration;

      const docsData = [];
      snapshot.forEach((doc) => docsData.push({ id: doc.id, ...doc.data() }));

      const newScoutedTeams = new Set();
      const newEntries = new Map();
      const newRawEditors = new Map();
      for (const data of docsData) {
        const key = `${data.eventCode}_${data.teamNumber}`;
        if (pitEntryIsCommitted(data)) {
          newScoutedTeams.add(key);
          newEntries.set(key, data);
        }
        newRawEditors.set(key, data.activeEditors);
      }

      if (myGeneration !== pitStatusWatchGeneration) return; // superseded by a newer snapshot
      scoutedTeamsCache = newScoutedTeams;
      pitScoutedEntriesCache = newEntries;
      pitActiveEditorsRawCache = newRawEditors;
      recomputePitActiveEditingFromCache(); // also notifies via onScoutedStateChanged()
    }, (err) => {
      console.warn('Pit scouting listener error:', err);
    });

  pitActiveEditingRefreshTimer = setInterval(recomputePitActiveEditingFromCache, LIVE_PRESENCE_HEARTBEAT_MS);
}

// ====== Check if a specific team has been scouted (committed at least
// once — see pitEntryIsCommitted()). ======
function isTeamScouted(teamNumber, eventCode) {
  const docId = `${eventCode}_${teamNumber}`;
  return scoutedTeamsCache.has(docId);
}

// ====== Get the full cached pit scouting entry for a team (or null) ======
// Used for permission checks (e.g. bulk delete) that need entry.scoutedBy.
function getPitScoutedEntry(teamNumber, eventCode) {
  const docId = `${eventCode}_${teamNumber}`;
  return pitScoutedEntriesCache.get(docId) || null;
}

// ====== Is someone actively editing this team's pit entry right now,
// independent of whether it's been committed yet? Both a not-yet-committed
// draft with an active editor and an already-scouted entry someone's
// reopened count — see pitActiveEditingCache's own comment. ======
function isTeamBeingEditedPit(teamNumber, eventCode) {
  const docId = `${eventCode}_${teamNumber}`;
  return pitActiveEditingCache.has(docId);
}

// ====== Names of everyone currently, freshly, editing this team's pit
// entry (CATEGORY 4) — empty array if nobody is. Used by the team-list
// "Editing" badge to show who, not just that someone is. ======
function getTeamEditingNamesPit(teamNumber, eventCode) {
  const docId = `${eventCode}_${teamNumber}`;
  return pitActiveEditingNamesCache.get(docId) || [];
}

// ====== Refresh scouted state on existing team list items ======
// This is called after a save/delete to update the UI without a full re-render
function refreshTeamListScoutedState() {
  const eventCode = selectedEvent?.code;
  if (!eventCode) return;

  // Update each team-item's visual state based on current scoutedTeamsCache.
  // Scoped to the Pit tab's list only — pit-scouted status has no bearing on
  // match scouting, which has its own (or no) completion state.
  document.querySelectorAll('#team-list-pit .team-item').forEach(item => {
    const teamNum = item.dataset.teamNumber;
    if (!teamNum) return;
    const isScouted = isTeamScouted(teamNum, eventCode);
    item.classList.toggle('scouted', isScouted);
    
    // Update the quick-scout button's label/highlight to match renderPitTeamList()'s
    // markup exactly, in both directions (scouted <-> unscouted) — this is the button
    // in the team list row, not the detail-view button handled below.
    const scoutBtn = item.querySelector('.btn-pit-quick-scout');
    if (scoutBtn) {
      if (isScouted) {
        scoutBtn.style.background = 'var(--success)';
        scoutBtn.innerHTML = '';
        const checkSpan = document.createElement('span');
        checkSpan.textContent = '✓';
        const textSpan = document.createElement('span');
        textSpan.textContent = 'Edit Pit Scout';
        scoutBtn.appendChild(checkSpan);
        scoutBtn.appendChild(textSpan);
      } else {
        scoutBtn.style.background = '';
        scoutBtn.innerHTML = '';
        scoutBtn.textContent = '+ Pit Scout';
      }
    }

    if (typeof updatePitTeamRowMetaLine === 'function') {
      updatePitTeamRowMetaLine(item, teamNum, eventCode);
    }

    // Independent "someone is editing this right now" marker — see
    // isTeamBeingEditedPit()'s own comment for why this is deliberately not
    // folded into the scouted checkmark above. Shows WHO (CATEGORY 4), via
    // the shared updateLiveEditingBadge() helper (first-api.js).
    const editingBadge = item.querySelector('.live-editing-badge');
    if (editingBadge && typeof updateLiveEditingBadge === 'function') {
      updateLiveEditingBadge(editingBadge, getTeamEditingNamesPit(teamNum, eventCode));
    }
  });

  // If the Team Detail modal is currently open for a team, refresh its pit
  // scouting data section too, in case this save/delete affected that team.
  if (currentSelectedTeamNumber && typeof renderPitDataForTeam === 'function') {
    renderPitDataForTeam(currentSelectedTeamNumber, eventCode);
  }
}

// ====== Wire up event handlers ======
document.addEventListener('DOMContentLoaded', () => {
  // "Done" commits (validates required fields, marks the entry committed,
  // keeps everything). Every other way of leaving — the X, the Cancel
  // button, the inline Cancel button, clicking the overlay — cancels
  // (discards the whole entry if nobody has committed it yet and this is
  // the last active editor; see cancelPitScoutForm/live-entry-sync.js).
  document.getElementById('btn-pit-save').addEventListener('click', commitPitScoutForm);
  document.getElementById('btn-pit-cancel').addEventListener('click', cancelPitScoutForm);
  document.getElementById('pit-modal-overlay').addEventListener('click', cancelPitScoutForm);
  document.getElementById('btn-pit-cancel-inline').addEventListener('click', cancelPitScoutForm);

  // Delete button
  document.getElementById('pit-delete-btn').addEventListener('click', deletePitScoutData);

  // Set the scouted state change callback so first-api.js can notify us
  // This must be set after first-api.js has loaded (which it has, since pit-scout.js loads after it)
  if (typeof onScoutedStateChanged !== 'undefined') {
    onScoutedStateChanged = () => {
      refreshTeamListScoutedState();
      // refreshTeamListScoutedState() only patches scouted-state UI it already
      // knows about (checkmarks, meta lines) — it never touches the
      // team-level Delete button, which is why that button used to stay
      // permanently absent until some unrelated full re-render happened to
      // fire first. Patch it here too so it appears as soon as this event's
      // first pit-scouting snapshot actually arrives, not only after that.
      if (typeof refreshTeamRowDeleteButtons === 'function') refreshTeamRowDeleteButtons();
    };
  }
});