// ====== Team Information Tab ======
// Read-only team list (search/sort shared with Match & Pit tabs) whose "View Detail"
// button opens a single consolidated popup: team profile + awards (via loadTeamDetail,
// reused as-is from ftcscout.js), pit scouting data (new, below), and match scouting
// entries (via renderMatchListForTeam, reused as-is from match-scout.js).

// ====== Delete a team's pit and/or match scouting data for one event ======
// `mode` controls which data type(s) get touched: 'pit' (Pit Scouting tab —
// pit only), 'match' (Match Scouting tab — match only), or 'combined'
// (Team Information tab — both). Scoped to `eventCode` only — a team scouted
// at other events keeps that data untouched. Reuses the existing per-entry
// delete paths (deletePitScoutEntry from pit-scout.js, bulkDeleteMatchScoutData
// from match-scout.js) so Firestore rules enforce permission per-document
// exactly as they already do for every other delete in the app; this is a UI
// convenience for issuing one or both at once, not a separate/bypassed code
// path. Neither half throws on failure — pit failure doesn't stop the match
// attempt, and bulkDeleteMatchScoutData already reports per-doc failures
// instead of throwing — so the caller gets a summary to report back to the
// user instead of an all-or-nothing exception.
async function deleteTeamScoutingData(teamId, eventCode, teamNumber, mode = 'combined') {
  const results = { pitFailed: false, matchFailed: 0, matchTotal: 0 };

  if (mode !== 'match') {
    try {
      if (typeof deletePitScoutEntry === 'function') {
        await deletePitScoutEntry(teamId, eventCode, teamNumber);
      }
    } catch (err) {
      console.error('Failed to delete pit scouting data for team:', teamNumber, err);
      results.pitFailed = true;
    }
  }

  if (mode !== 'pit') {
    const matchEntries = typeof getMatchEntriesForTeam === 'function' ? getMatchEntriesForTeam(teamNumber, eventCode) : [];
    const matchIds = matchEntries.map(e => e.id);
    results.matchTotal = matchIds.length;
    if (matchIds.length > 0 && typeof bulkDeleteMatchScoutData === 'function') {
      const matchResults = await bulkDeleteMatchScoutData(matchIds);
      results.matchFailed = matchResults.failed.length;
    }
  }

  return results;
}

// ====== Team-level Delete button — wipes this team's scouting data for the
// currently selected event in one action, scoped by `mode` to match what the
// calling tab is actually about: 'combined' (Team Information tab — both pit
// and match), 'pit' (Pit Scouting tab — pit only), or 'match' (Match
// Scouting tab — match only). Shared by all three tabs' team rows so they
// end up with identical gating/confirm/delete plumbing, just scoped
// differently. Gated by canUserEditOtherEntries() — the same single
// permission every other bulk/team-level delete surface in the app now uses
// (see auth.js) — so a plain member who can only edit their own entries
// never sees this, since deleting could touch other people's data. Returns
// null (renders nothing) when the user isn't permitted, or when this team
// has no data of the relevant type(s) at this event. Marked with the
// 'team-scout-delete-btn' class so refreshTeamRowDeleteButtons() (below) can
// find and replace an already-rendered one without a full row rebuild. ======
function createTeamScoutingDeleteButton(team, eventCode, mode = 'combined') {
  const canManage = typeof canUserEditOtherEntries === 'function' ? canUserEditOtherEntries() : false;
  if (!canManage) return null;

  const teamNumber = team.teamNumber;
  const pitEntry = mode !== 'match' && typeof getPitScoutedEntry === 'function' ? getPitScoutedEntry(teamNumber, eventCode) : null;
  const matchEntries = mode !== 'pit' && typeof getMatchEntriesForTeam === 'function' ? getMatchEntriesForTeam(teamNumber, eventCode) : [];
  const hasPit = !!pitEntry;
  const hasMatch = matchEntries.length > 0;
  if (!hasPit && !hasMatch) return null;

  const btn = document.createElement('button');
  btn.className = 'btn btn-small team-scout-delete-btn';
  btn.style.cssText = 'width:auto; padding:4px 8px; font-size:0.8rem; background:var(--error); color:#fff; border-color:var(--error);';
  btn.textContent = 'Delete';

  let title, message;
  if (mode === 'pit') {
    title = 'Delete Pit Scouting Data?';
    message = `Delete pit scouting data for Team #${teamNumber}? This cannot be undone.`;
    btn.title = "Delete this team's pit scouting data at this event";
  } else if (mode === 'match') {
    title = 'Delete Match Scouting Data?';
    message = `Delete ALL match scouting entries for Team #${teamNumber}? This will remove ${matchEntries.length} total entr${matchEntries.length === 1 ? 'y' : 'ies'}. This cannot be undone.`;
    btn.title = "Delete all of this team's match scouting entries at this event";
  } else {
    title = 'Delete All Scouting Data for This Team?';
    const parts = [];
    if (hasPit) parts.push('1 pit entry');
    if (hasMatch) parts.push(`${matchEntries.length} match entr${matchEntries.length === 1 ? 'y' : 'ies'}`);
    message = `Delete all pit and match scouting data for Team #${teamNumber} at this event? This includes ${parts.join(' and ')}. This cannot be undone.`;
    btn.title = 'Delete all pit and match scouting data for this team at this event';
  }

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (typeof showConfirmModal !== 'function') return;

    showConfirmModal({
      title,
      message,
      confirmLabel: 'Delete',
      danger: true,
      onConfirm: async () => {
        const teamId = currentTeamData?.id;
        if (!teamId) return;
        showLoading('Deleting...');
        let results = { pitFailed: false, matchFailed: 0, matchTotal: 0 };
        try {
          results = await deleteTeamScoutingData(teamId, eventCode, teamNumber, mode);
        } catch (err) {
          console.error('Failed to delete team scouting data:', err);
          results.pitFailed = true;
        } finally {
          hideLoading();
        }

        if (results.pitFailed || results.matchFailed > 0) {
          if (typeof showNoticeModal === 'function') {
            showNoticeModal({
              title: 'Delete Incomplete',
              message: `Some data for Team #${teamNumber} could not be deleted (permission denied, or a connection issue). Please try again.`
            });
          }
        }

        // Re-render every team list currently showing this event, not just
        // the one this button was clicked from, so all three tabs reflect
        // the deletion immediately.
        if (typeof currentEventTeams !== 'undefined' && currentEventTeams && currentEventTeams.length > 0) {
          if (typeof renderPitTeamList === 'function') renderPitTeamList(currentEventTeams);
          if (typeof renderMatchTeamList === 'function') renderMatchTeamList(currentEventTeams);
          if (typeof renderTeamInfoList === 'function') renderTeamInfoList(currentEventTeams);
          if (typeof applyTeamSearchFilter === 'function' && typeof currentTeamSearchQuery !== 'undefined') {
            applyTeamSearchFilter(currentTeamSearchQuery);
          }
        }
      }
    });
  });

  return btn;
}

// ====== Incrementally add/remove/update just the team-level Delete button on
// each already-rendered team row, across all three team lists (Team
// Information, Pit Scouting, Match Scouting), without rebuilding the rest of
// the row — same "patch just what changed" approach refreshTeamListScoutedState()
// (pit-scout.js) and updatePitBulkSelectUI()/updateMatchTeamBulkSelectUI()
// (first-api.js) already use for other live-synced state.
//
// Root cause this fixes: the very first render of these lists (from
// selectEvent() in first-api.js) always runs before the live Firestore
// listeners that populate the pit/match scouted-status caches even attach,
// so createTeamScoutingDeleteButton() always saw empty caches and rendered
// nothing on first paint. And once those listeners' snapshots DID arrive,
// their change callbacks (onScoutedStateChanged / onMatchScoutedStateChanged)
// only ever did narrow incremental patches that never touched this button —
// so it stayed permanently absent until something else happened to trigger a
// FULL re-render of these lists (e.g. this button's own delete handler
// above, or the bulk-delete flows), which is why buttons appeared to "start
// working" only after a delete was used once, with no connection to the
// delete action itself. The same gap made permission changes (grant/revoke
// of canEditOtherEntries) invisible until a full re-render happened to occur
// for an unrelated reason, instead of updating live like every other
// permission-gated control in the app (see auth.js's refreshActiveTeamData()).
//
// Call sites: pit-scout.js's onScoutedStateChanged, match-scout.js's
// onMatchScoutedStateChanged, and auth.js's refreshActiveTeamData() (team-doc
// live listener — covers permission grant/revoke). Always removes and
// recreates rather than leaving an existing button in place, so a stale
// closure over old pit/match counts never survives a data change. ======
function refreshTeamRowDeleteButtons() {
  const eventCode = typeof selectedEvent !== 'undefined' ? selectedEvent?.code : null;
  if (!eventCode || typeof currentEventTeams === 'undefined' || !currentEventTeams || currentEventTeams.length === 0) return;

  const teamsByNumber = new Map(currentEventTeams.map(t => [String(t.teamNumber), t]));

  const panels = [
    { selector: '#team-list-info .team-item', mode: 'combined' },
    { selector: '#team-list-pit .team-item', mode: 'pit' },
    { selector: '#team-list-match .team-item', mode: 'match' }
  ];

  panels.forEach(({ selector, mode }) => {
    document.querySelectorAll(selector).forEach(item => {
      const teamNumber = item.dataset.teamNumber;
      const existingBtn = item.querySelector('.team-scout-delete-btn');
      if (existingBtn) existingBtn.remove();

      const team = teamNumber ? teamsByNumber.get(String(teamNumber)) : null;
      if (!team) return;

      const newBtn = createTeamScoutingDeleteButton(team, eventCode, mode);
      if (!newBtn) return;

      const btnGroup = item.querySelector('.team-item-actions');
      if (btnGroup) btnGroup.insertBefore(newBtn, btnGroup.firstChild);
    });
  });
}

// ====== Bulk-select state for the Team Information tab — mirrors the Match
// tab's pattern (first-api.js's matchBulkSelectMode/matchBulkSelectedTeamNumbers):
// selection is by TEAM NUMBER, not a single doc id, since "this team's
// combined data" isn't one document. Delete performs the same 'combined'
// (pit + match) delete as the single-row Delete button above, per team. ======
let infoBulkSelectMode = false;
let infoBulkSelectedTeamNumbers = new Set();
// Shift-click range-select support — see the matching pitBulkOrder/
// pitBulkCheckboxEls/pitBulkRangeState comment (first-api.js) and
// handleBulkRangeClick() (also first-api.js, loaded before this file).
let infoBulkOrder = [];
let infoBulkCheckboxEls = new Map();
let infoBulkRangeState = { lastClickedId: null };

// ====== Show/hide & label the Team Information bulk-select toolbar based on
// permission and selection — same shape as updatePitBulkSelectUI() and
// updateMatchTeamBulkSelectUI() (first-api.js). ======
function updateInfoBulkSelectUI() {
  const toggleBtn = document.getElementById('btn-info-bulk-select-toggle');
  const deleteBtn = document.getElementById('btn-info-bulk-delete');
  if (!toggleBtn || !deleteBtn) return;

  const canBulkManage = typeof canUserEditOtherEntries === 'function' ? canUserEditOtherEntries() : false;
  if (!canBulkManage) {
    toggleBtn.classList.add('hidden');
    deleteBtn.classList.add('hidden');
    const wasActive = infoBulkSelectMode;
    infoBulkSelectMode = false;
    clearBulkSelection(infoBulkSelectedTeamNumbers, infoBulkRangeState);
    // Same reasoning as updatePitBulkSelectUI()/updateMatchTeamBulkSelectUI()
    // (first-api.js) — the toolbar hides immediately, but the per-row
    // checkboxes already in the DOM need a rebuild to actually disappear.
    // Guarded on wasActive so this only fires on the true -> false
    // transition, not every team-doc change.
    if (wasActive && typeof currentEventTeams !== 'undefined' && currentEventTeams && currentEventTeams.length > 0 && typeof renderTeamInfoList === 'function') {
      renderTeamInfoList(currentEventTeams);
    }
    return;
  }

  toggleBtn.classList.remove('hidden');
  toggleBtn.textContent = infoBulkSelectMode ? 'Cancel Select' : 'Select';

  if (infoBulkSelectMode && infoBulkSelectedTeamNumbers.size > 0) {
    deleteBtn.classList.remove('hidden');
    deleteBtn.textContent = `Delete Selected (${infoBulkSelectedTeamNumbers.size})`;
  } else {
    deleteBtn.classList.add('hidden');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const toggleBtn = document.getElementById('btn-info-bulk-select-toggle');
  if (toggleBtn) {
    toggleBtn.addEventListener('click', () => {
      infoBulkSelectMode = !infoBulkSelectMode;
      clearBulkSelection(infoBulkSelectedTeamNumbers, infoBulkRangeState);
      if (typeof currentEventTeams !== 'undefined' && currentEventTeams && currentEventTeams.length > 0) {
        renderTeamInfoList(currentEventTeams);
        if (typeof applyTeamSearchFilter === 'function' && typeof currentTeamSearchQuery !== 'undefined') {
          applyTeamSearchFilter(currentTeamSearchQuery);
        }
      } else {
        updateInfoBulkSelectUI();
      }
    });
  }

  // Bulk delete — performs the same 'combined' (pit + match) delete as the
  // single-row Delete button, once per selected team.
  const deleteBtn = document.getElementById('btn-info-bulk-delete');
  if (deleteBtn) {
    deleteBtn.addEventListener('click', () => {
      const teamNumbers = [...infoBulkSelectedTeamNumbers];
      if (teamNumbers.length === 0 || typeof showConfirmModal !== 'function') return;

      showConfirmModal({
        title: 'Delete All Scouting Data for These Teams?',
        message: `Delete all pit and match scouting data for ${teamNumbers.length} team(s) at this event? This cannot be undone.`,
        confirmLabel: 'Delete',
        danger: true,
        onConfirm: async () => {
          const teamId = currentTeamData?.id;
          const eventCode = selectedEvent?.code;
          if (!teamId || !eventCode) return;

          showLoading('Deleting selected teams...');
          let anyFailed = false;
          try {
            for (const teamNumber of teamNumbers) {
              const results = await deleteTeamScoutingData(teamId, eventCode, teamNumber, 'combined');
              if (results.pitFailed || results.matchFailed > 0) anyFailed = true;
            }
          } catch (err) {
            console.error('Failed to bulk-delete team scouting data:', err);
            anyFailed = true;
          } finally {
            hideLoading();
          }

          const statusEl = document.getElementById('info-bulk-delete-status');
          if (statusEl) {
            statusEl.textContent = anyFailed
              ? `Some data could not be deleted for one or more teams — check permissions and try again.`
              : `Deleted data for ${teamNumbers.length} team(s).`;
            statusEl.className = anyFailed ? 'error-message' : 'success-message';
            setTimeout(() => { statusEl.textContent = ''; statusEl.className = ''; }, 5000);
          }

          infoBulkSelectMode = false;
          clearBulkSelection(infoBulkSelectedTeamNumbers, infoBulkRangeState);
          if (typeof currentEventTeams !== 'undefined' && currentEventTeams && currentEventTeams.length > 0) {
            if (typeof renderTeamInfoList === 'function') renderTeamInfoList(currentEventTeams);
            if (typeof renderPitTeamList === 'function') renderPitTeamList(currentEventTeams);
            if (typeof renderMatchTeamList === 'function') renderMatchTeamList(currentEventTeams);
            if (typeof applyTeamSearchFilter === 'function' && typeof currentTeamSearchQuery !== 'undefined') {
              applyTeamSearchFilter(currentTeamSearchQuery);
            }
          }
        }
      });
    });
  }
});

// ====== Render the Team Information tab's team list ======
function renderTeamInfoList(teams) {
  const container = document.getElementById('team-list-info');
  const status = document.getElementById('team-list-status-info');
  if (!container || !status) return;

  container.innerHTML = '';

  if (!teams || teams.length === 0) {
    status.textContent = 'No teams found for this event.';
    return;
  }

  status.textContent = `${teams.length} team(s)`;
  const sorted = typeof sortTeams === 'function' ? sortTeams(teams) : teams;

  // Rebuilt every render so shift-click range-select always reflects the
  // CURRENT sort order/direction — see handleBulkRangeClick() (first-api.js).
  infoBulkOrder = [];
  infoBulkCheckboxEls = new Map();

  sorted.forEach(team => {
    const item = document.createElement('div');
    item.className = 'team-item';
    item.dataset.teamNumber = team.teamNumber;

    const leftGroup = document.createElement('div');
    leftGroup.style.cssText = 'display:flex; align-items:center; gap:8px; flex:1; min-width:0;';

    const numSpan = document.createElement('span');
    numSpan.className = 'team-number';
    numSpan.textContent = `#${team.teamNumber}`;

    const nameSpan = document.createElement('span');
    nameSpan.className = 'team-name';
    nameSpan.textContent = team.name || team.nameFull || team.nameShort || team.schoolName || team.teamNameCalc || '';

    const oprSpan = document.createElement('span');
    oprSpan.className = 'team-opr-inline';
    oprSpan.textContent = typeof team.opr === 'number' ? `OPR: ${team.opr.toFixed(1)}` : 'OPR: --';

    leftGroup.appendChild(numSpan);
    leftGroup.appendChild(nameSpan);
    leftGroup.appendChild(oprSpan);

    const btnGroup = document.createElement('div');
    btnGroup.className = 'team-item-actions';
    btnGroup.style.cssText = 'display:flex; align-items:center; gap:6px; flex-shrink:0; flex-wrap:wrap; justify-content:flex-end;';

    // Team-level Delete — appended FIRST so it renders on the left side of
    // the button group, before View Detail (see refreshTeamRowDeleteButtons()
    // above, which relies on this same "insert as first child" placement for
    // its own incremental add/remove).
    const deleteBtn = typeof createTeamScoutingDeleteButton === 'function'
      ? createTeamScoutingDeleteButton(team, selectedEvent?.code || '', 'combined')
      : null;
    if (deleteBtn) btnGroup.appendChild(deleteBtn);

    const viewDetailBtn = document.createElement('button');
    viewDetailBtn.className = 'btn btn-small btn-secondary';
    viewDetailBtn.style.cssText = 'width: auto; padding: 4px 8px; font-size: 0.8rem;';
    viewDetailBtn.textContent = 'View Detail';
    viewDetailBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openTeamDetailModal(team.teamNumber, selectedEvent?.code || '', team);
    });

    btnGroup.appendChild(viewDetailBtn);

    // Bulk-select checkbox — only in select mode, and only for teams that
    // have at least some scouting data (nothing to delete otherwise). Keyed
    // by team number, matching the Match tab's pattern (there's no single
    // doc id representing "this team's combined data").
    const teamHasAnyData = (selectedEvent?.code)
      ? ((typeof getPitScoutedEntry === 'function' && !!getPitScoutedEntry(team.teamNumber, selectedEvent.code))
        || (typeof getMatchEntriesForTeam === 'function' && getMatchEntriesForTeam(team.teamNumber, selectedEvent.code).length > 0))
      : false;
    if (infoBulkSelectMode && teamHasAnyData) {
      const teamKey = String(team.teamNumber);
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.style.cssText = 'width:18px; height:18px; flex-shrink:0; cursor:pointer;';
      checkbox.checked = infoBulkSelectedTeamNumbers.has(teamKey);
      infoBulkOrder.push(teamKey);
      infoBulkCheckboxEls.set(teamKey, checkbox);
      markBulkAnchorCheckbox(checkbox, teamKey, infoBulkRangeState);
      // 'click' (not 'change') so shiftKey is available — see handleBulkRangeClick() (first-api.js).
      checkbox.addEventListener('click', (e) => {
        e.stopPropagation();
        handleBulkRangeClick(e, teamKey, infoBulkOrder, infoBulkCheckboxEls, infoBulkSelectedTeamNumbers, infoBulkRangeState, updateInfoBulkSelectUI);
      });
      leftGroup.insertBefore(checkbox, leftGroup.firstChild);
    }

    item.appendChild(leftGroup);
    item.appendChild(btnGroup);
    container.appendChild(item);
  });

  resolveBulkAnchor(infoBulkOrder, infoBulkCheckboxEls, infoBulkRangeState);
  updateInfoBulkSelectUI();
}

// ====== Open the Team Detail modal for a given team ======
// Keeps the real content hidden behind a loading state until every piece
// (profile/awards/OPR via loadTeamDetail, pit data via renderPitDataForTeam —
// match entries render synchronously off the local cache inside
// loadTeamDetail) has finished loading, so the popup appears already fully
// populated instead of visibly resizing as each piece fills in.
async function openTeamDetailModal(teamNumber, eventCode, teamObj) {
  currentSelectedTeamNumber = teamNumber;

  const modal = document.getElementById('team-detail-modal');
  const body = document.getElementById('td-modal-body');
  const loadingEl = document.getElementById('td-modal-loading');
  if (modal) modal.classList.remove('hidden');
  if (body) body.classList.add('hidden');
  if (loadingEl) loadingEl.classList.remove('hidden');

  const titleEl = document.getElementById('team-detail-modal-title');
  if (titleEl) {
    const teamName = teamObj?.name || teamObj?.nameFull || teamObj?.nameShort || teamObj?.schoolName || teamObj?.teamNameCalc || '';
    titleEl.textContent = teamName ? `Team #${teamNumber} — ${teamName}` : `Team #${teamNumber}`;
  }

  const loadPromises = [];
  if (typeof loadTeamDetail === 'function') {
    loadPromises.push(loadTeamDetail(teamNumber, eventCode));
  }
  if (typeof renderPitDataForTeam === 'function') {
    loadPromises.push(renderPitDataForTeam(teamNumber, eventCode));
  }

  try {
    await Promise.all(loadPromises);
  } finally {
    // The team may have changed (or the modal closed) while data was loading
    // — don't reveal stale content for a team the user has since navigated
    // away from. Same guard renderPitDataForTeam already uses internally.
    if (currentSelectedTeamNumber === teamNumber) {
      if (loadingEl) loadingEl.classList.add('hidden');
      if (body) body.classList.remove('hidden');
    }
  }
}

// ====== Close the Team Detail modal ======
function closeTeamDetailModal() {
  currentSelectedTeamNumber = null;
  const modal = document.getElementById('team-detail-modal');
  if (modal) modal.classList.add('hidden');

  // Clear any export status message immediately, so reopening this modal later
  // (for this team or another) never shows a stale message from a prior session.
  const exportErrorEl = document.getElementById('td-export-match-error');
  if (exportErrorEl) exportErrorEl.textContent = '';
  const exportSuccessEl = document.getElementById('td-export-match-success');
  if (exportSuccessEl) exportSuccessEl.textContent = '';

  // This modal's own match-entry bulk-select toolbar (match-scout.js) isn't
  // covered by exitAllBulkSelectModes() (that's only the three main tabs) —
  // reset it here too, so reopening later (for this team or another) never
  // shows a stale selection or a "Cancel Select" toggle left on.
  if (typeof resetMatchBulkSelectState === 'function') resetMatchBulkSelectState('td-');
}

// ====== Render a team's submitted pit scouting data (read-only) into the modal ======
async function renderPitDataForTeam(teamNumber, eventCode) {
  const container = document.getElementById('td-pit-data-list');
  const status = document.getElementById('td-pit-data-status');
  const scoutBtn = document.getElementById('btn-team-info-pit-scout');
  const deleteBtn = document.getElementById('btn-team-info-pit-delete');
  if (!container || !status) return;

  container.innerHTML = '';
  status.textContent = 'Loading...';

  const entry = typeof getPitScoutedEntry === 'function' ? getPitScoutedEntry(teamNumber, eventCode) : null;

  if (scoutBtn) scoutBtn.textContent = entry ? '✓ Edit Pit Scout' : '+ Add Pit Scout';

  // Only shown when there's something to delete AND this user is actually
  // permitted to (own entry, captain, or canEditOtherEntries) — same rule
  // firestore.rules enforces, checked here up front so the button never
  // appears only to fail.
  const canDelete = !!entry && (typeof canUserEditOtherEntries === 'function' ? canUserEditOtherEntries(entry) : false);
  if (deleteBtn) deleteBtn.classList.toggle('hidden', !canDelete);

  if (!entry) {
    status.textContent = 'This team has not been pit scouted yet.';
    return;
  }

  const teamId = currentTeamData?.id;
  let fields = [];
  try {
    fields = teamId && typeof loadFormConfig === 'function' ? await loadFormConfig(teamId) : [];
  } catch (err) {
    console.warn('Failed to load pit form config for team detail:', err);
    fields = [];
  }

  // The team may have switched (or the modal closed) while the config was loading
  if (currentSelectedTeamNumber !== teamNumber) return;

  const scoutedBy = entry.scoutedByName || entry.scoutedByEmail || 'Unknown';
  const lastEditedBy = entry.lastEditedByName || entry.lastEditedByEmail || 'N/A';
  status.textContent = `Scouted by: ${scoutedBy} | Last edited by: ${lastEditedBy}`;

  if (fields.length === 0) {
    container.innerHTML = '<p class="help-text" style="font-size:0.8rem; margin-bottom:0">No pit scouting fields configured.</p>';
    return;
  }

  // This read-only view is the entry's "preview" — only fields the team has
  // configured to show there (see form-builder.js's "Show in preview"
  // checkbox) appear here, in the field order the team set. The full field
  // set is still always shown in the actual edit form (openPitScoutForm),
  // regardless of this setting.
  const previewFields = fields.filter(field => field.showInPreview !== false);
  if (previewFields.length === 0) {
    container.innerHTML = '<p class="help-text" style="font-size:0.8rem; margin-bottom:0">No fields are configured to show in the preview.</p>';
    return;
  }

  previewFields.forEach(field => {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex; justify-content:space-between; gap:8px; padding:4px 0; font-size:0.85rem; border-bottom:1px solid var(--border);';

    const labelSpan = document.createElement('span');
    labelSpan.style.color = 'var(--text-muted)';
    labelSpan.textContent = field.label;

    const valueSpan = document.createElement('span');
    const val = entry[field.id];
    valueSpan.textContent = (val === null || val === undefined || val === '') ? '—' : String(val);

    row.appendChild(labelSpan);
    row.appendChild(valueSpan);
    container.appendChild(row);
  });
}

// ====== Wire up modal close controls ======
document.addEventListener('DOMContentLoaded', () => {
  const closeBtn = document.getElementById('btn-team-detail-close');
  if (closeBtn) closeBtn.addEventListener('click', closeTeamDetailModal);

  const overlay = document.getElementById('team-detail-modal-overlay');
  if (overlay) overlay.addEventListener('click', closeTeamDetailModal);

  // Add/Edit Pit Scout — opens the existing pit-scout form on top of this modal
  // for whichever team is currently shown.
  const pitScoutBtn = document.getElementById('btn-team-info-pit-scout');
  if (pitScoutBtn) {
    pitScoutBtn.addEventListener('click', () => {
      if (currentSelectedTeamNumber && selectedEvent?.code && typeof openPitScoutForm === 'function') {
        openPitScoutForm(currentSelectedTeamNumber, selectedEvent.code);
      }
    });
  }

  // Delete Pit Scout — one-click delete without opening the edit form first.
  // Only ever visible (see renderPitDataForTeam()) when this user is
  // actually permitted to delete this specific entry.
  const pitDeleteBtn = document.getElementById('btn-team-info-pit-delete');
  if (pitDeleteBtn) {
    pitDeleteBtn.addEventListener('click', () => {
      const teamNumber = currentSelectedTeamNumber;
      const eventCode = selectedEvent?.code;
      const teamId = currentTeamData?.id;
      if (!teamNumber || !eventCode || !teamId || typeof showConfirmModal !== 'function') return;

      showConfirmModal({
        title: 'Delete Pit Scouting Data?',
        message: `Delete pit scouting data for Team #${teamNumber}? This cannot be undone.`,
        confirmLabel: 'Delete',
        danger: true,
        onConfirm: async () => {
          showLoading('Deleting...');
          try {
            if (typeof deletePitScoutEntry === 'function') {
              await deletePitScoutEntry(teamId, eventCode, teamNumber);
            }
          } catch (err) {
            console.error('Failed to delete pit scouting data:', err);
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

          if (currentSelectedTeamNumber === teamNumber) {
            renderPitDataForTeam(teamNumber, eventCode);
          }
        }
      });
    });
  }
});
