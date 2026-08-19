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
// Fields: eventCode, teamNumber, teamId, plus dynamic fields from formConfig,
//         scoutedBy (uid), scoutedByName, scoutedAt, updatedAt

let currentPitTeamNumber = null;
let currentPitEventCode = null;
let pitScoutUnsubscribe = null; // Firestore snapshot listener
// Both caches below are keyed by "eventCode_teamNumber" (data-derived), NOT
// the real Firestore document ID — this makes every reader of these caches
// (isTeamScouted, getPitScoutedEntry, etc.) automatically work the same way
// regardless of which document-ID era an entry was saved under. The real ID
// (needed for edit/delete) is still available via each cached entry's own
// `.id` property.
let scoutedTeamsCache = new Set(); // Set of "eventCode_teamNumber" keys
let pitScoutedEntriesCache = new Map(); // "eventCode_teamNumber" -> full entry data (incl. real doc id, scoutedBy), for permission checks
let currentFormController = null; // returned by renderDynamicForm

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

  // Show modal
  document.getElementById('pit-modal').classList.remove('hidden');

  // Clear synchronously, before any await below — otherwise whatever team
  // was rendered here last stays visible for however long the form-config/
  // existing-data fetches take, instead of never appearing at all.
  document.getElementById('pit-dynamic-fields').innerHTML = '';
  currentFormController = null;

  // Get field configuration and render dynamic form
  const teamId = currentTeamData?.id;
  if (!teamId) {
    document.getElementById('pit-modal-error').textContent = 'Team data not loaded. Please rejoin your team.';
    return;
  }

  try {
    const fields = await loadFormConfig(teamId);
    const container = document.getElementById('pit-dynamic-fields');

    // Load existing data for this team
    const existingData = await loadExistingPitData(teamId, eventCode, teamNumber);
    
    currentFormController = renderDynamicForm(container, fields, existingData);

    if (existingData) {
      document.getElementById('pit-modal-success').textContent = 'Existing scouting data loaded.';
      document.getElementById('pit-delete-btn').classList.remove('hidden');
    }
  } catch (err) {
    console.error('Failed to render form:', err);
    document.getElementById('pit-modal-error').textContent = 'Failed to load form. Please try again.';
  }
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

// ====== Save pit scouting form ======
async function savePitScoutForm() {
  const errorEl = document.getElementById('pit-modal-error');
  const successEl = document.getElementById('pit-modal-success');
  errorEl.textContent = '';
  successEl.textContent = '';

  if (!currentFormController) {
    errorEl.textContent = 'Form not initialized. Please reopen the form.';
    return;
  }

  // Validate required fields
  const validationError = currentFormController.validate();
  if (validationError) {
    errorEl.textContent = validationError;
    return;
  }

  if (!currentUser) {
    errorEl.textContent = 'You must be signed in to scout.';
    return;
  }

  if (!currentPitTeamNumber || !currentPitEventCode) {
    errorEl.textContent = 'Missing team or event data. Please try again.';
    return;
  }

  const teamId = currentTeamData?.id;
  if (!teamId) {
    errorEl.textContent = 'Team data not loaded. Please rejoin your team.';
    return;
  }

  showLoading('Saving pit scouting data...');
  try {
    const fieldValues = currentFormController.getValues();
    const userDisplayName = typeof getCurrentUserDisplayName === 'function' ? getCurrentUserDisplayName() : (currentUser.email || 'Unknown');

    // Check if this is a new document or update — finds an existing entry
    // regardless of which document-ID era it was saved under (see
    // findExistingPitDoc()); a genuinely new entry gets the current,
    // collision-safe ID format.
    const existing = await findExistingPitDoc(teamId, currentPitEventCode, currentPitTeamNumber);
    const isExisting = !!existing;
    const existingData = existing;
    const docId = existing ? existing.id : `${teamId}_${currentPitEventCode}_${currentPitTeamNumber}`;

    const scoutedByUid = isExisting ? (existingData.scoutedBy || currentUser.uid) : currentUser.uid;

    const payload = {
      eventCode: currentPitEventCode,
      teamNumber: Number(currentPitTeamNumber),
      teamId: teamId || null,
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
      payload.lastEditedBy = currentUser.uid;
      payload.lastEditedByEmail = firebase.firestore.FieldValue.delete();
      payload.lastEditedByName = userDisplayName;
      payload.lastEditedByTimestamp = Date.now();
    }

    await db.collection('teams').doc(teamId).collection('pitScouting').doc(docId).set(payload, { merge: true });

    hideLoading();
    successEl.textContent = 'Pit scouting data saved!';
    
    // Update the cache so the team list reflects it immediately — keyed by
    // data (eventCode_teamNumber), not the real doc id (see cache comments above).
    scoutedTeamsCache.add(`${currentPitEventCode}_${currentPitTeamNumber}`);
    
    // Re-render team list to reflect scouted state
    refreshTeamListScoutedState();

    // Close modal after a short delay
    setTimeout(() => {
      closePitScoutForm();
    }, 1200);
  } catch (err) {
    hideLoading();
    console.error('Failed to save pit scouting data:', err);
    if (err.code === 'permission-denied') {
      errorEl.textContent = 'Permission denied: You do not have permission to edit or save this entry.';
    } else {
      errorEl.textContent = 'Failed to save. Please check your connection and try again.';
    }
  }
}

// ====== Core delete logic: resolve the real doc, delete it, and clean up
// caches/UI — shared by the edit form's own Delete button (below, which
// reads its state from whatever form is currently open) and the Team Detail
// popup's standalone Delete button (team-info.js), which already has the
// team/event/team-number on hand and doesn't need the form open at all. ======
async function deletePitScoutEntry(teamId, eventCode, teamNumber) {
  // Resolve the real doc id (regardless of which ID era it was saved
  // under) rather than guessing — same reasoning as savePitScoutForm().
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
// and calls the callback whenever data changes.
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
    .onSnapshot((snapshot) => {
      scoutedTeamsCache.clear();
      pitScoutedEntriesCache.clear();
      snapshot.forEach((doc) => {
        const data = doc.data();
        // Keyed by data (eventCode_teamNumber), not doc.id — see cache
        // comments at the top of this file for why.
        const key = `${data.eventCode}_${data.teamNumber}`;
        scoutedTeamsCache.add(key);
        pitScoutedEntriesCache.set(key, { id: doc.id, ...data });
      });

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
  // Save button
  document.getElementById('btn-pit-save').addEventListener('click', savePitScoutForm);

  // Cancel / close buttons
  document.getElementById('btn-pit-cancel').addEventListener('click', closePitScoutForm);
  document.getElementById('pit-modal-overlay').addEventListener('click', closePitScoutForm);

  // Inline cancel button
  document.getElementById('btn-pit-cancel-inline').addEventListener('click', closePitScoutForm);

  // Delete button
  document.getElementById('pit-delete-btn').addEventListener('click', deletePitScoutData);

  // Set the scouted state change callback so first-api.js can notify us
  // This must be set after first-api.js has loaded (which it has, since pit-scout.js loads after it)
  if (typeof onScoutedStateChanged !== 'undefined') {
    onScoutedStateChanged = refreshTeamListScoutedState;
  }
});