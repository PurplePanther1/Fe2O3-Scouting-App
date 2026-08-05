// ====== "View Matches Scouted" Modal (Match Scouting tab) ======
// Shows ONLY the Match Scouting Entries panel for one team at the currently
// selected event — no team profile/awards/pit data, unlike the Team
// Information tab's Team Detail modal (team-info.js) which bundles all of
// those together. Reuses the exact same rendering/handler functions as that
// modal (renderMatchListForTeam, updateMatchBulkSelectUI, the bulk-select/
// search wiring — all in match-scout.js) via the 'msm-' ID prefix, rather
// than a separate implementation.

let currentMatchScoutedTeamNumber = null;
let currentMatchScoutedEventCode = null;

// ====== Open the modal for a given team ======
function openMatchScoutedModal(teamNumber, eventCode, teamObj) {
  currentMatchScoutedTeamNumber = teamNumber;
  currentMatchScoutedEventCode = eventCode;

  const modal = document.getElementById('match-scouted-modal');
  if (modal) modal.classList.remove('hidden');

  const titleEl = document.getElementById('match-scouted-modal-title');
  if (titleEl) {
    const teamName = teamObj?.name || teamObj?.nameFull || teamObj?.nameShort || teamObj?.schoolName || teamObj?.teamNameCalc || '';
    titleEl.textContent = teamName ? `Team #${teamNumber} — ${teamName} — Matches Scouted` : `Team #${teamNumber} — Matches Scouted`;
  }

  if (typeof renderMatchListForTeam === 'function') {
    renderMatchListForTeam(eventCode, teamNumber, 'msm-');
  }
}

// ====== Close the modal ======
function closeMatchScoutedModal() {
  currentMatchScoutedTeamNumber = null;
  currentMatchScoutedEventCode = null;
  const modal = document.getElementById('match-scouted-modal');
  if (modal) modal.classList.add('hidden');

  // Same reasoning as closeTeamDetailModal() (team-info.js): clear any
  // export status message immediately, so reopening this modal later (for
  // this team or another) never shows a stale message from a prior session.
  const exportErrorEl = document.getElementById('msm-export-match-error');
  if (exportErrorEl) exportErrorEl.textContent = '';
  const exportSuccessEl = document.getElementById('msm-export-match-success');
  if (exportSuccessEl) exportSuccessEl.textContent = '';
}

document.addEventListener('DOMContentLoaded', () => {
  const closeBtn = document.getElementById('btn-match-scouted-close');
  if (closeBtn) closeBtn.addEventListener('click', closeMatchScoutedModal);

  const overlay = document.getElementById('match-scouted-modal-overlay');
  if (overlay) overlay.addEventListener('click', closeMatchScoutedModal);

  const addMatchBtn = document.getElementById('msm-add-match-entry');
  if (addMatchBtn) {
    addMatchBtn.addEventListener('click', () => {
      if (currentMatchScoutedTeamNumber && currentMatchScoutedEventCode && typeof openMatchScoutForm === 'function') {
        openMatchScoutForm(currentMatchScoutedTeamNumber, currentMatchScoutedEventCode);
      }
    });
  }
});
