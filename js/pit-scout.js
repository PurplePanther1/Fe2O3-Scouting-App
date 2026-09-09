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
//         formConfig, scoutedBy/scoutedByName (CURRENT OWNER — mutable, see
//         live-entry-sync.js), scoutedAt, lastEditedBy/lastEditedByName/
//         lastEditedByTimestamp (last actual field change), updatedAt,
//         activeEditors (live-entry-sync.js).
//
// Pit entries are always live: opening the form joins (or views) a live
// session via live-entry-sync.js — there's no separate batch-save mode the
// way match scouting has for its team-based view (pit has no equivalent
// "locked vs manual" split to preserve). The Save button is relabeled
// "Done" and just flushes pending field writes and closes.

let currentPitTeamNumber = null;
let currentPitEventCode = null;
let pitScoutUnsubscribe = null; // Firestore snapshot listener (status/"is this team scouted" listener — see watchPitScoutStatus)
// Both caches below are keyed by "eventCode_teamNumber" (data-derived), NOT
// the real Firestore document ID — this makes every reader of these caches
// (isTeamScouted, getPitScoutedEntry, etc.) automatically work the same way
// regardless of which document-ID era an entry was saved under. The real ID
// (needed for edit/delete) is still available via each cached entry's own
// `.id` property. Only entries with real field content are added here — see
// pitEntryHasRealContent() / watchPitScoutStatus().
let scoutedTeamsCache = new Set(); // Set of "eventCode_teamNumber" keys
let pitScoutedEntriesCache = new Map(); // "eventCode_teamNumber" -> full entry data (incl. real doc id, scoutedBy), for permission checks
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

  // Reset modal state
  document.getElementById('pit-modal-title').textContent = `Pit Scout Team #${teamNumber}`;
  document.getElementById('pit-modal-error').textContent = '';
  document.getElementById('pit-modal-success').textContent = '';
  document.getElementById('pit-delete-btn').classList.add('hidden');
  document.getElementById('btn-pit-take-over').classList.add('hidden');
  const presenceBanner = document.getElementById('pit-presence-banner');
  presenceBanner.classList.add('hidden');
  presenceBanner.textContent = '';

  // Show modal
  document.getElementById('pit-modal').classList.remove('hidden');

  // Clear synchronously, before any await below — otherwise whatever team
  // was rendered here last stays visible for however long the form-config/
  // existing-data fetches take, instead of never appearing at all.
  document.getElementById('pit-dynamic-fields').innerHTML = '';
  currentFormController = null;
  currentPitFields = null;
  if (currentPitLiveSession) { currentPitLiveSession.detach(); currentPitLiveSession = null; }

  // Get field configuration and render dynamic form
  const teamId = currentTeamData?.id;
  if (!teamId) {
    document.getElementById('pit-modal-error').textContent = 'Team data not loaded. Please rejoin your team.';
    return;
  }
  if (!currentUser) {
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
      document.getElementById('pit-modal').classList.add('hidden');
      if (typeof showNoticeModal === 'function') {
        showNoticeModal({ title: 'Permission Denied', message: 'You do not have permission to edit this pit scouting entry.' });
      }
      currentPitTeamNumber = null;
      currentPitEventCode = null;
      return;
    }

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
      onSnapshotData: (data) => {
        if (!currentFormController || !currentPitFields) return;
        applyRemoteFieldValues(currentFormController, currentPitFields, data);
        applyPresenceIndicators(currentFormController, currentPitFields, data?.activeEditors, currentUser.uid);
        renderPresenceBanner(document.getElementById('pit-presence-banner'), data?.activeEditors, currentUser.uid);
      }
    });

    if (access.startInEditMode) {
      await currentPitLiveSession.join({
        eventCode,
        teamNumber: Number(teamNumber),
        teamId: teamId2,
        season: existingData?.season || resolveFormConfigSeason(),
        scoutedBy: existingData?.scoutedBy || currentUser.uid,
        scoutedByName: existingData?.scoutedByName || displayName,
        scoutedAt: existingData?.scoutedAt || firebase.firestore.FieldValue.serverTimestamp()
      });
      currentFormController.setReadOnly(false);
      wireLiveFormFields(currentFormController, fields, currentPitLiveSession);
      document.getElementById('btn-pit-take-over').classList.add('hidden');
    } else {
      // Someone else is already in here — open read-only with a Take Over option.
      currentFormController.setReadOnly(true);
      document.getElementById('btn-pit-take-over').classList.remove('hidden');
    }
  } catch (err) {
    console.error('Failed to render form:', err);
    document.getElementById('pit-modal-error').textContent = 'Failed to load form. Please try again.';
  }
}

// ====== "Take Over" — join the live session as an active editor after
// opening read-only because someone else was already in here. ======
async function takeOverPitScoutEntry() {
  if (!currentPitLiveSession || !currentFormController || !currentPitFields || !currentUser) return;
  const teamId = currentTeamData?.id;
  if (!teamId) return;
  try {
    const displayName = typeof getCurrentUserDisplayName === 'function' ? getCurrentUserDisplayName() : (currentUser.email || 'Unknown');
    await currentPitLiveSession.join({
      eventCode: currentPitEventCode,
      teamNumber: Number(currentPitTeamNumber),
      teamId,
      season: resolveFormConfigSeason(),
      scoutedBy: currentUser.uid,
      scoutedByName: displayName,
      scoutedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    currentFormController.setReadOnly(false);
    wireLiveFormFields(currentFormController, currentPitFields, currentPitLiveSession);
    document.getElementById('btn-pit-take-over').classList.add('hidden');
  } catch (err) {
    console.error('Failed to take over pit scouting entry:', err);
    if (typeof showNoticeModal === 'function') {
      showNoticeModal({ title: 'Take Over Failed', message: 'Could not take over this entry. Please check your connection and try again.' });
    }
  }
}

// ====== Does this pit entry have any real scouted content, as opposed to
// an empty shell created the instant someone opened the form (live entries
// are created on open, not on an explicit save — see createLiveEntrySession
// in live-entry-sync.js)? Checked against the team's configured field list
// for THIS entry's own season, same as the form itself renders. A doc with
// none of its configured fields populated should not count as "scouted" —
// see watchPitScoutStatus(). ======
function pitEntryHasRealContent(entry, fields) {
  return fields.some((field) => {
    const v = entry[field.id];
    return v !== null && v !== undefined && v !== '';
  });
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

// ====== "Done" — there's no discrete save anymore (every field write
// already landed live as it was typed); this just flushes any
// still-debounced field writes and closes. ======
function finishPitScoutForm() {
  if (currentPitLiveSession) currentPitLiveSession.flushAll();
  closePitScoutForm();
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

// ====== Close the pit scouting form ======
function closePitScoutForm() {
  document.getElementById('pit-modal').classList.add('hidden');
  currentPitTeamNumber = null;
  currentPitEventCode = null;
  currentFormController = null;
  currentPitFields = null;
  // Best-effort, not awaited — this leaves the session (dropping us from
  // activeEditors, transferring ownership if we're the last one out) without
  // blocking the modal close on that round-trip. A failure just means our
  // presence entry lingers until it goes stale — see live-entry-sync.js.
  if (currentPitLiveSession) {
    currentPitLiveSession.detach();
    currentPitLiveSession = null;
  }

  // If the Team Detail modal (Team Information tab) is open behind this form,
  // refresh its pit data section — covers the save/delete case (already refreshed
  // via refreshTeamListScoutedState, but harmless to repeat) as well as a plain
  // cancel/close, so the section never shows anything stale after this closes.
  if (currentSelectedTeamNumber && typeof renderPitDataForTeam === 'function' && selectedEvent?.code) {
    renderPitDataForTeam(currentSelectedTeamNumber, selectedEvent.code);
  }
}

// ====== Watch pit scouting status for a given event ======
// Sets up a Firestore onSnapshot listener that updates scoutedTeamsCache
// and calls the callback whenever data changes. Only entries with real
// field content count as "scouted" — a live entry's doc exists from the
// moment its form is opened (see openPitScoutForm), not from an explicit
// save, so mere existence is no longer a meaningful signal (see
// pitEntryHasRealContent()).
function watchPitScoutStatus(eventCode) {
  // Unsubscribe previous listener
  if (pitScoutUnsubscribe) {
    pitScoutUnsubscribe();
    pitScoutUnsubscribe = null;
  }

  scoutedTeamsCache.clear();
  pitScoutedEntriesCache.clear();

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
    .onSnapshot(async (snapshot) => {
      // This listener now fires far more often than before — every live
      // per-field write and every ~15s presence heartbeat from every active
      // editor at this event, not just an explicit save. The content-check
      // below is async (loadFormConfig), so a slower call can finish after a
      // newer one already did; this generation guard drops the stale result
      // instead of letting it clobber the caches with outdated data (same
      // pattern as match-scout.js's matchListRenderGeneration).
      const myGeneration = ++pitStatusWatchGeneration;

      const docsData = [];
      snapshot.forEach((doc) => docsData.push({ id: doc.id, ...doc.data() }));

      const newScoutedTeams = new Set();
      const newEntries = new Map();
      for (const data of docsData) {
        const fields = await loadFormConfig(teamId, data.season);
        if (!pitEntryHasRealContent(data, fields)) continue; // empty shell — not scouted
        const key = `${data.eventCode}_${data.teamNumber}`;
        newScoutedTeams.add(key);
        newEntries.set(key, data);
      }

      if (myGeneration !== pitStatusWatchGeneration) return; // superseded by a newer snapshot
      scoutedTeamsCache = newScoutedTeams;
      pitScoutedEntriesCache = newEntries;

      // Notify any listeners (e.g., team list renderer)
      if (typeof onScoutedStateChanged === 'function') {
        onScoutedStateChanged();
      }
    }, (err) => {
      console.warn('Pit scouting listener error:', err);
    });
}

// ====== Check if a specific team has been scouted ======
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
  });

  // If the Team Detail modal is currently open for a team, refresh its pit
  // scouting data section too, in case this save/delete affected that team.
  if (currentSelectedTeamNumber && typeof renderPitDataForTeam === 'function') {
    renderPitDataForTeam(currentSelectedTeamNumber, eventCode);
  }
}

// ====== Wire up event handlers ======
document.addEventListener('DOMContentLoaded', () => {
  // "Done" — there's no separate save/cancel distinction left (every field
  // write already landed live), so every way of leaving this modal just
  // flushes any still-debounced write and closes.
  document.getElementById('btn-pit-save').addEventListener('click', finishPitScoutForm);
  document.getElementById('btn-pit-cancel').addEventListener('click', finishPitScoutForm);
  document.getElementById('pit-modal-overlay').addEventListener('click', finishPitScoutForm);
  document.getElementById('btn-pit-cancel-inline').addEventListener('click', finishPitScoutForm);

  // Take Over — join as an active editor after opening read-only because
  // someone else was already in this entry.
  document.getElementById('btn-pit-take-over').addEventListener('click', takeOverPitScoutEntry);

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