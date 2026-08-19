// ====== Team Information Tab ======
// Read-only team list (search/sort shared with Match & Pit tabs) whose "View Detail"
// button opens a single consolidated popup: team profile + awards (via loadTeamDetail,
// reused as-is from ftcscout.js), pit scouting data (new, below), and match scouting
// entries (via renderMatchListForTeam, reused as-is from match-scout.js).

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
    btnGroup.style.cssText = 'display:flex; align-items:center; gap:6px; flex-shrink:0;';

    const viewDetailBtn = document.createElement('button');
    viewDetailBtn.className = 'btn btn-small btn-secondary';
    viewDetailBtn.style.cssText = 'width: auto; padding: 4px 8px; font-size: 0.8rem;';
    viewDetailBtn.textContent = 'View Detail';
    viewDetailBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openTeamDetailModal(team.teamNumber, selectedEvent?.code || '', team);
    });

    btnGroup.appendChild(viewDetailBtn);

    item.appendChild(leftGroup);
    item.appendChild(btnGroup);
    container.appendChild(item);
  });
}

// ====== Open the Team Detail modal for a given team ======
function openTeamDetailModal(teamNumber, eventCode, teamObj) {
  currentSelectedTeamNumber = teamNumber;

  const modal = document.getElementById('team-detail-modal');
  if (modal) modal.classList.remove('hidden');

  const titleEl = document.getElementById('team-detail-modal-title');
  if (titleEl) {
    const teamName = teamObj?.name || teamObj?.nameFull || teamObj?.nameShort || teamObj?.schoolName || teamObj?.teamNameCalc || '';
    titleEl.textContent = teamName ? `Team #${teamNumber} — ${teamName}` : `Team #${teamNumber}`;
  }

  if (typeof loadTeamDetail === 'function') {
    loadTeamDetail(teamNumber, eventCode);
  }
  if (typeof renderPitDataForTeam === 'function') {
    renderPitDataForTeam(teamNumber, eventCode);
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

  fields.forEach(field => {
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
