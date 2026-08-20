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
// Fields: eventCode, matchNumber, teamNumber, teamId, plus dynamic fields
//         from formConfig, scoutedBy (uid), scoutedByName, scoutedAt, updatedAt
// Unlike pit scouting, each team can have multiple match entries (one per match).

let currentMatchTeamNumber = null;
let currentMatchEventCode = null;
let currentMatchDocId = null; // set when editing an existing entry
// Set only when the form was opened from the match-based view
// (match-schedule-view.js), where matchNumber/teamNumber/eventCode are
// already known from which match row + team slot was clicked. When
// non-null, the matchNumber field is excluded from the rendered dynamic
// form (same as teamNumber/eventCode, which are never dynamic-form fields
// at all — title + module state only) and saveMatchScoutForm() uses this
// value instead of reading one out of the form.
let currentLockedMatchNumber = null;
let matchScoutUnsubscribe = null; // Firestore snapshot listener
let matchEntriesCache = {}; // keyed by "eventCode_teamNumber" -> array of entries (each entry's own .id is the real doc id, format-agnostic)
let currentMatchFormController = null; // returned by renderDynamicForm

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

// Bulk-select state for the match entries list (captain / canEditOtherEntries
// only) — keyed by ID prefix ('td-' for the Team Information tab's Team
// Detail modal, 'msm-' for the "View Matches Scouted" modal) so the two
// modals never share select-mode or selections, even if both happen to be
// showing different teams' entries at once.
const matchBulkState = {
  'td-': { mode: false, selectedIds: new Set() },
  'msm-': { mode: false, selectedIds: new Set() }
};

// ====== Show/hide & label the match bulk-select toolbar based on permission and selection ======
function updateMatchBulkSelectUI(prefix = 'td-') {
  const state = matchBulkState[prefix];
  const toggleBtn = document.getElementById(`${prefix}match-bulk-select-toggle`);
  const deleteBtn = document.getElementById(`${prefix}match-bulk-delete`);
  if (!toggleBtn || !deleteBtn || !state) return;

  const canBulkManage = (typeof canUserEditOtherEntries === 'function' ? canUserEditOtherEntries() : false)
    && (typeof canUserBulkDelete === 'function' ? canUserBulkDelete() : false);
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
  for (const entryId of entryIds) {
    try {
      await db.collection('teams').doc(teamId).collection('matchScouting').doc(entryId).delete();
      results.succeeded.push(entryId);
    } catch (err) {
      console.error(`Failed to delete match scouting data for ${entryId}:`, err);
      results.failed.push(entryId);
    }
  }
  return results;
}

// ====== Open the match scouting form (modal) for a new entry ======
// lockedMatchNumber/teamName are only passed by openMatchScoutFormFromSchedule()
// (the match-based view's entry point, below) — every other existing caller
// passes just (teamNumber, eventCode), which behaves exactly as before.
async function openMatchScoutForm(teamNumber, eventCode, lockedMatchNumber = null, teamName = null) {
  currentMatchTeamNumber = teamNumber;
  currentMatchEventCode = eventCode;
  currentMatchDocId = null;
  currentLockedMatchNumber = lockedMatchNumber;

  // Reset modal state
  document.getElementById('match-modal-title').textContent = lockedMatchNumber != null
    ? `Match #${lockedMatchNumber} — Team #${teamNumber}${teamName ? ` (${teamName})` : ''}`
    : `Match Scout Team #${teamNumber}`;
  document.getElementById('match-modal-error').textContent = '';
  document.getElementById('match-modal-success').textContent = '';
  document.getElementById('match-delete-btn').classList.add('hidden');

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
  } catch (err) {
    console.error('Failed to render match form:', err);
    document.getElementById('match-modal-error').textContent = 'Failed to load form. Please try again.';
  }
}

// ====== Open match form to edit an existing entry ======
// lockMatchNumber/teamName are only passed by openMatchScoutFormFromSchedule()
// (below) — every other existing caller (the team-based view's Edit button)
// passes just (docId, existingData), which behaves exactly as before. The
// locked value is always derived from existingData.matchNumber itself, not
// a separately-passed number, so it can never disagree with the entry being
// edited.
async function openMatchScoutEdit(docId, existingData, lockMatchNumber = false, teamName = null) {
  // Extract team number and event code from existing data
  currentMatchTeamNumber = existingData.teamNumber;
  currentMatchEventCode = existingData.eventCode;
  currentMatchDocId = docId;
  currentLockedMatchNumber = lockMatchNumber ? existingData.matchNumber : null;

  document.getElementById('match-modal-title').textContent = lockMatchNumber && teamName
    ? `Edit Match #${existingData.matchNumber || '?'} — Team #${currentMatchTeamNumber} (${teamName})`
    : `Edit Match #${existingData.matchNumber || '?'} — Team #${currentMatchTeamNumber}`;
  document.getElementById('match-modal-error').textContent = '';
  document.getElementById('match-modal-success').textContent = '';
  document.getElementById('match-delete-btn').classList.remove('hidden');

  document.getElementById('match-modal').classList.remove('hidden');

  // Clear synchronously, before any await below — otherwise whatever entry
  // was rendered here last (a different match/team) stays visible for
  // however long the form-config fetch takes, instead of never appearing.
  document.getElementById('match-dynamic-fields').innerHTML = '';
  currentMatchFormController = null;

  const teamId = currentTeamData?.id;
  if (!teamId) return;

  try {
    const fields = await loadMatchFormConfig(teamId);
    const container = document.getElementById('match-dynamic-fields');
    const renderedFields = lockMatchNumber ? fields.filter(f => f.id !== 'matchNumber') : fields;

    currentMatchFormController = renderDynamicForm(container, renderedFields, existingData);

    document.getElementById('match-modal-success').textContent = 'Editing existing match entry.';
  } catch (err) {
    console.error('Failed to render match form for edit:', err);
    document.getElementById('match-modal-error').textContent = 'Failed to load form. Please try again.';
  }
}

// ====== Open the match scouting form from the match-based view
// (match-schedule-view.js's expanded panel) — matchNumber, teamNumber, and
// eventCode are all already known from which match row + team slot was
// clicked, so all three end up locked (title-only, not user-editable) in
// whichever of the two functions above ends up handling it. Resolves
// new-vs-edit and permission exactly like the team-based view already does:
// looks up any existing entry via findExistingMatchDoc() (the same helper
// the manual flow already uses to avoid guessing doc IDs), and if one
// exists but the current user isn't its original scouter and lacks
// canEditOtherEntries, tells them so via showNoticeModal() — same
// Permission Denied message renderMatchListForTeam()'s Edit button now
// shows in that case, below. ======
async function openMatchScoutFormFromSchedule(matchNumber, teamNumber, eventCode, teamName) {
  const teamId = currentTeamData?.id;
  if (!teamId || !currentUser) return;

  const existing = await findExistingMatchDoc(teamId, eventCode, matchNumber, teamNumber);

  if (existing) {
    const canEdit = typeof canUserEditOtherEntries === 'function'
      ? canUserEditOtherEntries(existing)
      : (existing.scoutedBy === currentUser?.uid);
    if (!canEdit) {
      if (typeof showNoticeModal === 'function') {
        showNoticeModal({ title: 'Permission Denied', message: 'You do not have permission to edit this match scouting entry.' });
      }
      return;
    }
    await openMatchScoutEdit(existing.id, existing, true, teamName);
  } else {
    await openMatchScoutForm(teamNumber, eventCode, matchNumber, teamName);
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
          await db.collection('teams').doc(teamId).collection('matchScouting').doc(currentMatchDocId).delete();
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
        await db.collection('teams').doc(teamId).collection('matchScouting').doc(currentMatchDocId).delete();
        hideLoading();
        refreshMatchEntriesCache();
        refreshOpenMatchListPanels();
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

// ====== Close the match scouting form ======
function closeMatchScoutForm() {
  document.getElementById('match-modal').classList.add('hidden');
  currentMatchTeamNumber = null;
  currentMatchEventCode = null;
  currentMatchDocId = null;
  currentLockedMatchNumber = null;
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

function renderMatchListForTeam(eventCode, teamNumber, prefix = 'td-') {
  const container = document.getElementById(`${prefix}match-entries`);
  const countEl = document.getElementById(`${prefix}match-count`);
  const bulkState = matchBulkState[prefix];
  if (!container || !bulkState) return;

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
      checkbox.addEventListener('change', (e) => {
        e.stopPropagation();
        if (checkbox.checked) {
          bulkState.selectedIds.add(entry.id);
        } else {
          bulkState.selectedIds.delete(entry.id);
        }
        updateMatchBulkSelectUI(prefix);
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
  // Save button
  document.getElementById('btn-match-save').addEventListener('click', saveMatchScoutForm);

  // Cancel / close buttons
  document.getElementById('btn-match-cancel').addEventListener('click', closeMatchScoutForm);
  document.getElementById('match-modal-overlay').addEventListener('click', closeMatchScoutForm);

  // Inline cancel button
  document.getElementById('btn-match-cancel-inline').addEventListener('click', closeMatchScoutForm);

  // Delete button
  document.getElementById('match-delete-btn').addEventListener('click', deleteMatchScoutData);

  // Set the scouted state change callback — refreshes whichever match-list
  // panel(s) are actually open (not just the Team Detail modal's), plus the
  // Match Scouting tab's own team-list counts.
  if (typeof onMatchScoutedStateChanged !== 'undefined') {
    onMatchScoutedStateChanged = () => {
      refreshOpenMatchListPanels();
      if (typeof refreshMatchTeamListCounts === 'function') refreshMatchTeamListCounts();
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