// ====== Match Scouting Form ======
// Data stored in Firestore collection "matchScouting"
// Document ID: `${eventCode}_${matchNumber}_${teamNumber}`
// Fields: eventCode, matchNumber, teamNumber, plus dynamic fields from formConfig
//         scoutedBy (uid), scoutedByName, scoutedAt, updatedAt
// Unlike pit scouting, each team can have multiple match entries (one per match).

let currentMatchTeamNumber = null;
let currentMatchEventCode = null;
let currentMatchDocId = null; // set when editing an existing entry
let matchScoutUnsubscribe = null; // Firestore snapshot listener
let matchEntriesCache = {}; // keyed by "eventCode_teamNumber" -> array of entries
let currentMatchFormController = null; // returned by renderDynamicForm

// Bulk-select state for the match entries list (captain / canEditOtherEntries only)
let matchBulkSelectMode = false;
let matchBulkSelectedEntryIds = new Set();

// ====== Show/hide & label the match bulk-select toolbar based on permission and selection ======
function updateMatchBulkSelectUI() {
  const toggleBtn = document.getElementById('btn-match-bulk-select-toggle');
  const deleteBtn = document.getElementById('btn-match-bulk-delete');
  if (!toggleBtn || !deleteBtn) return;

  const canBulkManage = (typeof canUserEditOtherEntries === 'function' ? canUserEditOtherEntries() : false)
    && (typeof canUserBulkDelete === 'function' ? canUserBulkDelete() : false);
  if (!canBulkManage) {
    toggleBtn.classList.add('hidden');
    deleteBtn.classList.add('hidden');
    matchBulkSelectMode = false;
    matchBulkSelectedEntryIds.clear();
    return;
  }

  toggleBtn.classList.remove('hidden');
  toggleBtn.textContent = matchBulkSelectMode ? 'Cancel Select' : 'Select';

  if (matchBulkSelectMode && matchBulkSelectedEntryIds.size > 0) {
    deleteBtn.classList.remove('hidden');
    deleteBtn.textContent = `Delete Selected (${matchBulkSelectedEntryIds.size})`;
  } else {
    deleteBtn.classList.add('hidden');
  }
}

// ====== Bulk-delete match scouting entries by doc id ======
// Each delete goes through the same db.collection('matchScouting').doc(id).delete() call
// as the single-entry path, so Firestore rules (canEditOrDeleteEntry) enforce permission
// per-document exactly as they already do — this is a UI convenience, not a bypass.
async function bulkDeleteMatchScoutData(entryIds) {
  const results = { succeeded: [], failed: [] };
  for (const entryId of entryIds) {
    try {
      await db.collection('matchScouting').doc(entryId).delete();
      results.succeeded.push(entryId);
    } catch (err) {
      console.error(`Failed to delete match scouting data for ${entryId}:`, err);
      results.failed.push(entryId);
    }
  }
  return results;
}

// ====== Open the match scouting form (modal) for a new entry ======
async function openMatchScoutForm(teamNumber, eventCode) {
  currentMatchTeamNumber = teamNumber;
  currentMatchEventCode = eventCode;
  currentMatchDocId = null;

  // Reset modal state
  document.getElementById('match-modal-title').textContent = `Match Scout Team #${teamNumber}`;
  document.getElementById('match-modal-error').textContent = '';
  document.getElementById('match-modal-success').textContent = '';
  document.getElementById('match-delete-btn').classList.add('hidden');

  // Show modal
  document.getElementById('match-modal').classList.remove('hidden');

  // Get field configuration and render dynamic form
  const teamId = currentTeamData?.id;
  if (!teamId) {
    document.getElementById('match-modal-error').textContent = 'Team data not loaded. Please rejoin your team.';
    return;
  }

  try {
    const fields = await loadMatchFormConfig(teamId);
    const container = document.getElementById('match-dynamic-fields');

    currentMatchFormController = renderDynamicForm(container, fields, null);

    // Clear success message
    document.getElementById('match-modal-success').textContent = '';
  } catch (err) {
    console.error('Failed to render match form:', err);
    document.getElementById('match-modal-error').textContent = 'Failed to load form. Please try again.';
  }
}

// ====== Open match form to edit an existing entry ======
async function openMatchScoutEdit(docId, existingData) {
  // Extract team number and event code from existing data
  currentMatchTeamNumber = existingData.teamNumber;
  currentMatchEventCode = existingData.eventCode;
  currentMatchDocId = docId;

  document.getElementById('match-modal-title').textContent = `Edit Match #${existingData.matchNumber || '?'} — Team #${currentMatchTeamNumber}`;
  document.getElementById('match-modal-error').textContent = '';
  document.getElementById('match-modal-success').textContent = '';
  document.getElementById('match-delete-btn').classList.remove('hidden');

  document.getElementById('match-modal').classList.remove('hidden');

  const teamId = currentTeamData?.id;
  if (!teamId) return;

  try {
    const fields = await loadMatchFormConfig(teamId);
    const container = document.getElementById('match-dynamic-fields');

    currentMatchFormController = renderDynamicForm(container, fields, existingData);

    document.getElementById('match-modal-success').textContent = 'Editing existing match entry.';
  } catch (err) {
    console.error('Failed to render match form for edit:', err);
    document.getElementById('match-modal-error').textContent = 'Failed to load form. Please try again.';
  }
}

// ====== Save match scouting form ======
async function saveMatchScoutForm() {
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
    const matchNumber = fieldValues.matchNumber;

    if (!matchNumber) {
      errorEl.textContent = 'Match Number is required.';
      return;
    }

    const docId = `${currentMatchEventCode}_${matchNumber}_${currentMatchTeamNumber}`;
    const teamId = currentTeamData?.id;
    const userDisplayName = typeof getCurrentUserDisplayName === 'function' ? getCurrentUserDisplayName() : (currentUser.email || 'Unknown');

    showLoading('Saving match scouting data...');
    try {
      // Check if doc exists (either currentMatchDocId or docId)
      let targetDocId = currentMatchDocId || docId;
      let existingDoc;
      try {
        existingDoc = await db.collection('matchScouting').doc(targetDocId).get();
      } catch (existenceCheckErr) {
        // TEMPORARY DIAGNOSTIC — remove after tracking down the nonexistent-doc read issue
        console.log('[DIAG match-scout] existence-check .get() FAILED for targetDocId:', targetDocId);
        console.log('[DIAG match-scout] full error object:', existenceCheckErr);
        console.log('[DIAG match-scout] err.code:', existenceCheckErr.code);
        console.log('[DIAG match-scout] err.message:', existenceCheckErr.message);
        console.log('[DIAG match-scout] err.details:', existenceCheckErr.details);
        throw existenceCheckErr;
      }
      const isExisting = existingDoc.exists;
      const existingData = isExisting ? existingDoc.data() : null;

      const scoutedByUid = isExisting ? (existingData.scoutedBy || currentUser.uid) : currentUser.uid;

      const payload = {
        eventCode: currentMatchEventCode,
        teamNumber: Number(currentMatchTeamNumber),
        teamId: teamId || null,
        matchNumber: Number(matchNumber),
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
        if (currentMatchDocId && currentMatchDocId !== docId) {
          await db.collection('matchScouting').doc(currentMatchDocId).delete();
        }
      }

    await db.collection('matchScouting').doc(docId).set(payload, { merge: true });

    hideLoading();
    if (successEl) successEl.textContent = 'Match scouting data saved!';
    if (errorEl) errorEl.textContent = '';

    // Update cache and re-render match list immediately
    if (typeof refreshMatchEntriesCache === 'function') {
      refreshMatchEntriesCache();
    }
    if (typeof renderMatchListForTeam === 'function') {
      renderMatchListForTeam(currentMatchEventCode, currentMatchTeamNumber);
    }

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

// ====== Delete match scouting data ======
async function deleteMatchScoutData() {
  const errorEl = document.getElementById('match-modal-error');
  const successEl = document.getElementById('match-modal-success');
  errorEl.textContent = '';
  successEl.textContent = '';

  if (!currentMatchDocId) return;

  if (!confirm(`Delete this match scouting entry?`)) return;

  showLoading('Deleting...');
  try {
    await db.collection('matchScouting').doc(currentMatchDocId).delete();
    hideLoading();
    refreshMatchEntriesCache();
    renderMatchListForTeam(currentMatchEventCode, currentMatchTeamNumber);
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

// ====== Close the match scouting form ======
function closeMatchScoutForm() {
  document.getElementById('match-modal').classList.add('hidden');
  currentMatchTeamNumber = null;
  currentMatchEventCode = null;
  currentMatchDocId = null;
  currentMatchFormController = null;
}

// ====== Watch match scouting status for a given event ======
// Sets up a Firestore onSnapshot listener that updates matchEntriesCache
// and calls the callback whenever data changes.
function watchMatchScoutStatus(eventCode) {
  // Unsubscribe previous listener
  if (matchScoutUnsubscribe) {
    matchScoutUnsubscribe();
    matchScoutUnsubscribe = null;
  }

  matchEntriesCache = {};

  if (!eventCode) {
    // No event selected — notify
    if (typeof onMatchScoutedStateChanged === 'function') {
      onMatchScoutedStateChanged();
    }
    return;
  }

  // Listen for our own team's match scouting docs at this event code
  matchScoutUnsubscribe = db.collection('matchScouting')
    .where('eventCode', '==', eventCode)
    .where('teamId', '==', currentTeamData?.id || null)
    .onSnapshot((snapshot) => {
      matchEntriesCache = {};
      snapshot.forEach((doc) => {
        const data = doc.data();
        const key = `${data.eventCode}_${data.teamNumber}`;
        if (!matchEntriesCache[key]) {
          matchEntriesCache[key] = [];
        }
        matchEntriesCache[key].push({ id: doc.id, ...data });
      });

      // Notify any listeners
      if (typeof onMatchScoutedStateChanged === 'function') {
        onMatchScoutedStateChanged();
      }
    }, (err) => {
      console.warn('Match scouting listener error:', err);
    });
}

// ====== Get match entries for a specific team ======
function getMatchEntriesForTeam(teamNumber, eventCode) {
  const key = `${eventCode}_${teamNumber}`;
  return matchEntriesCache[key] || [];
}

// ====== Refresh match entries cache callback ======
function refreshMatchEntriesCache() {
  // The snapshot listener handles this automatically;
  // this is a no-op placeholder for manual refresh triggers.
}

// ====== Render the match list for a team in the detail view ======
// Search query for filtering the currently-displayed team's match entries by match number
let currentMatchEntrySearchQuery = '';

function renderMatchListForTeam(eventCode, teamNumber) {
  const container = document.getElementById('td-match-entries');
  const countEl = document.getElementById('td-match-count');
  if (!container) return;

  const entries = getMatchEntriesForTeam(teamNumber, eventCode);

  // Sort by match number ascending (lowest at top)
  entries.sort((a, b) => (a.matchNumber || 0) - (b.matchNumber || 0));

  const query = currentMatchEntrySearchQuery.trim();
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
    updateMatchBulkSelectUI();
    return;
  }

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
    if (matchBulkSelectMode) {
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.style.cssText = 'width:18px; height:18px; flex-shrink:0; cursor:pointer;';
      checkbox.checked = matchBulkSelectedEntryIds.has(entry.id);
      checkbox.addEventListener('change', (e) => {
        e.stopPropagation();
        if (checkbox.checked) {
          matchBulkSelectedEntryIds.add(entry.id);
        } else {
          matchBulkSelectedEntryIds.delete(entry.id);
        }
        updateMatchBulkSelectUI();
      });
      numAndCheckbox.appendChild(checkbox);
    }

    const matchNumSpan = document.createElement('span');
    matchNumSpan.style.cssText = 'font-weight:600; font-size:1.05rem; color:var(--text-main);';
    matchNumSpan.textContent = `Match #${entry.matchNumber}`;
    numAndCheckbox.appendChild(matchNumSpan);

    header.appendChild(numAndCheckbox);

    if (typeof canUserEditOtherEntries === 'function' ? canUserEditOtherEntries(entry) : (entry.scoutedBy === currentUser?.uid)) {
      const editBtn = document.createElement('button');
      editBtn.className = 'btn btn-small btn-outline';
      editBtn.textContent = 'Edit';
      editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openMatchScoutEdit(entry.id, entry);
      });
      header.appendChild(editBtn);
    }
    item.appendChild(header);

    // Metadata line
    const meta = document.createElement('div');
    meta.style.cssText = 'font-size:0.8rem; color:var(--text-muted); margin-bottom:8px;';
    const scoutedBy = entry.scoutedByName || entry.scoutedByEmail || 'Unknown';
    const lastEditedBy = entry.lastEditedByName || entry.lastEditedByEmail || 'N/A';
    meta.textContent = `Scouted by: ${scoutedBy} | Last edited by: ${lastEditedBy}`;
    item.appendChild(meta);

    // Metrics summary line
    const metrics = document.createElement('div');
    metrics.style.cssText = 'font-size:0.9rem; font-weight:500; margin-bottom:8px; padding:6px 10px; background: rgba(255, 255, 255, 0.08); color: var(--text-main, #ffffff); border-radius:6px;';
    const autoScore = entry.autoScore ?? entry.auto ?? 0;
    const teleopScore = entry.teleopScore ?? entry.teleop ?? 0;
    const endgameScore = entry.endgameScore ?? entry.endgame ?? 0;
    const cycleTime = entry.cycleTime ?? entry.cycle ?? 0;
    metrics.textContent = `Auto: ${autoScore} | Teleop: ${teleopScore} | Endgame: ${endgameScore} | Cycle: ${cycleTime}s`;
    item.appendChild(metrics);

    // Notes section (if present)
    if (entry.notes) {
      const notesEl = document.createElement('div');
      notesEl.style.cssText = 'font-size:0.85rem; color:var(--text-main); margin-top:8px; padding-top:8px; border-top:1px dashed var(--border);';
      notesEl.textContent = `Notes: ${entry.notes}`;
      item.appendChild(notesEl);
    }

    container.appendChild(item);
  });

  updateMatchBulkSelectUI();
}

// ====== Callback for match scouted state changes (set by first-api.js) ======
let onMatchScoutedStateChanged = null;

// ====== Wire up event handlers ======
document.addEventListener('DOMContentLoaded', () => {
  // Save button
  document.getElementById('btn-match-save').addEventListener('click', saveMatchScoutForm);

  // Cancel / close buttons
  document.getElementById('btn-match-cancel').addEventListener('click', closeMatchScoutForm);
  document.getElementById('match-modal-overlay').addEventListener('click', closeMatchScoutForm);

  // Inline cancel button
  document.getElementById('btn-match-cancel-inline').addEventListener('click', closeMatchScoutForm);

  // Delete button
  document.getElementById('match-delete-btn').addEventListener('click', deleteMatchScoutData);

  // Set the scouted state change callback
  if (typeof onMatchScoutedStateChanged !== 'undefined') {
    onMatchScoutedStateChanged = () => {
      // When match cache changes, re-render for currently selected team
      const teamNum = document.getElementById('td-team-number').textContent.replace('#', '');
      const eventCode = selectedEvent?.code;
      if (teamNum && eventCode) {
        renderMatchListForTeam(eventCode, teamNum);
      }
    };
  }

  // Search/filter match entries by match number
  const matchEntrySearchInput = document.getElementById('input-match-entry-search');
  if (matchEntrySearchInput) {
    matchEntrySearchInput.addEventListener('input', (e) => {
      currentMatchEntrySearchQuery = e.target.value;
      const teamNum = document.getElementById('td-team-number').textContent.replace('#', '');
      const eventCode = selectedEvent?.code;
      if (teamNum && eventCode) {
        renderMatchListForTeam(eventCode, teamNum);
      }
    });
  }

  // Match bulk-select toggle
  const matchBulkToggleBtn = document.getElementById('btn-match-bulk-select-toggle');
  if (matchBulkToggleBtn) {
    matchBulkToggleBtn.addEventListener('click', () => {
      matchBulkSelectMode = !matchBulkSelectMode;
      matchBulkSelectedEntryIds.clear();
      const teamNum = document.getElementById('td-team-number').textContent.replace('#', '');
      const eventCode = selectedEvent?.code;
      if (teamNum && eventCode) {
        renderMatchListForTeam(eventCode, teamNum);
      } else {
        updateMatchBulkSelectUI();
      }
    });
  }

  // Match bulk delete
  const matchBulkDeleteBtn = document.getElementById('btn-match-bulk-delete');
  if (matchBulkDeleteBtn) {
    matchBulkDeleteBtn.addEventListener('click', async () => {
      const entryIds = [...matchBulkSelectedEntryIds];
      if (entryIds.length === 0) return;
      if (!confirm(`Delete ${entryIds.length} match scouting entr${entryIds.length === 1 ? 'y' : 'ies'}? This cannot be undone.`)) return;

      showLoading('Deleting selected entries...');
      let results = { succeeded: [], failed: [] };
      try {
        results = await bulkDeleteMatchScoutData(entryIds);
      } finally {
        hideLoading();
      }

      const statusEl = document.getElementById('match-bulk-delete-status');
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

      matchBulkSelectMode = false;
      matchBulkSelectedEntryIds.clear();
      const teamNum = document.getElementById('td-team-number').textContent.replace('#', '');
      const eventCode = selectedEvent?.code;
      if (teamNum && eventCode) {
        renderMatchListForTeam(eventCode, teamNum);
      }
    });
  }
});