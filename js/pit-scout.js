// ====== Pit Scouting Form ======
// Data stored in Firestore collection "pitScouting"
// Document ID: `${eventCode}_${teamNumber}`
// Fields: eventCode, teamNumber, plus dynamic fields from formConfig
//         scoutedBy (uid), scoutedByName, scoutedAt, updatedAt

let currentPitTeamNumber = null;
let currentPitEventCode = null;
let pitScoutUnsubscribe = null; // Firestore snapshot listener
let scoutedTeamsCache = new Set(); // Set of "eventCode_teamNumber" keys
let pitScoutedEntriesCache = new Map(); // docId -> full entry data (incl. scoutedBy), for permission checks
let currentFormController = null; // returned by renderDynamicForm

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
    const existingData = await loadExistingPitData(eventCode, teamNumber);
    
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
async function loadExistingPitData(eventCode, teamNumber) {
  const docId = `${eventCode}_${teamNumber}`;
  try {
    const doc = await db.collection('pitScouting').doc(docId).get();
    if (doc.exists) {
      return doc.data();
    }
  } catch (err) {
    console.warn('Could not load existing pit data:', err);
    // TEMPORARY DIAGNOSTIC — remove after tracking down the nonexistent-doc read issue
    console.log('[DIAG pit-scout] loadExistingPitData FAILED for docId:', docId);
    console.log('[DIAG pit-scout] full error object:', err);
    console.log('[DIAG pit-scout] err.code:', err.code);
    console.log('[DIAG pit-scout] err.message:', err.message);
    console.log('[DIAG pit-scout] err.details:', err.details);
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

  const docId = `${currentPitEventCode}_${currentPitTeamNumber}`;

  showLoading('Saving pit scouting data...');
  try {
    const fieldValues = currentFormController.getValues();
    const teamId = currentTeamData?.id;
    const userDisplayName = typeof getCurrentUserDisplayName === 'function' ? getCurrentUserDisplayName() : (currentUser.email || 'Unknown');

    // Check if this is a new document or update
    const existingDoc = await db.collection('pitScouting').doc(docId).get();
    const isExisting = existingDoc.exists;
    const existingData = isExisting ? existingDoc.data() : null;

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

    await db.collection('pitScouting').doc(docId).set(payload, { merge: true });

    hideLoading();
    successEl.textContent = 'Pit scouting data saved!';
    
    // Update the cache so the team list reflects it immediately
    scoutedTeamsCache.add(docId);
    
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

// ====== Delete pit scouting data ======
async function deletePitScoutData() {
  const errorEl = document.getElementById('pit-modal-error');
  const successEl = document.getElementById('pit-modal-success');
  errorEl.textContent = '';
  successEl.textContent = '';

  if (!currentPitTeamNumber || !currentPitEventCode) return;

  const docId = `${currentPitEventCode}_${currentPitTeamNumber}`;

  if (!confirm(`Delete pit scouting data for Team #${currentPitTeamNumber}?`)) return;

  showLoading('Deleting...');
  try {
    await db.collection('pitScouting').doc(docId).delete();
    hideLoading();
    scoutedTeamsCache.delete(docId);
    refreshTeamListScoutedState();
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

// ====== Bulk-delete pit scouting entries by docId ======
// Each delete goes through the same db.collection('pitScouting').doc(id).delete() call
// as the single-entry path above, so Firestore rules (canEditOrDeleteEntry) enforce
// permission per-document exactly as they already do — this is a UI convenience for
// issuing several deletes at once, not a separate/bypassed code path.
async function bulkDeletePitScoutData(docIds) {
  const results = { succeeded: [], failed: [] };
  for (const docId of docIds) {
    try {
      await db.collection('pitScouting').doc(docId).delete();
      scoutedTeamsCache.delete(docId);
      pitScoutedEntriesCache.delete(docId);
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

  if (!eventCode) {
    // No event selected — clear and notify
    if (typeof onScoutedStateChanged === 'function') {
      onScoutedStateChanged();
    }
    return;
  }

  // Listen for our own team's pit scouting docs at this event code (explicitly scoped
  // to our team — other teams' entries for the same real-world event are a separate,
  // rules-enforced dataset now, this filter is just the matching client-side intent)
  pitScoutUnsubscribe = db.collection('pitScouting')
    .where('eventCode', '==', eventCode)
    .where('teamId', '==', currentTeamData?.id || null)
    .onSnapshot((snapshot) => {
      scoutedTeamsCache.clear();
      pitScoutedEntriesCache.clear();
      snapshot.forEach((doc) => {
        scoutedTeamsCache.add(doc.id);
        pitScoutedEntriesCache.set(doc.id, { id: doc.id, ...doc.data() });
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