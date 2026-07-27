// ====== App Entry Point ======
// This file initializes any app-wide state and logging.

console.log('Fe2O3 Scouting App v1.0.0');
console.log('Firebase SDK loaded:', typeof firebase !== 'undefined');
console.log('Auth:', typeof auth !== 'undefined');
console.log('Firestore:', typeof db !== 'undefined');

// Service Worker registration (for PWA — will be implemented in a later step)
if ('serviceWorker' in navigator) {
  // Registration will be added when we build the PWA step
  // navigator.serviceWorker.register('/sw.js');
  console.log('ServiceWorker not yet registered — PWA step coming later.');
}

// ====== Global Tab Navigation Handler ======
let lastActiveScoutingSubTab = 'match'; // Remembers 'match' or 'pit'

document.addEventListener('DOMContentLoaded', () => {
  const matchTab = document.getElementById('tab-match-scouting') || document.querySelector('[data-subtab="match"]') || document.querySelectorAll('.tab-btn')[0];
  const pitTab = document.getElementById('tab-pit-scouting') || document.querySelector('[data-subtab="pit"]') || document.querySelectorAll('.tab-btn')[1];

  const matchView = document.getElementById('subtab-match') || document.getElementById('match-scouting-view') || document.getElementById('view-match') || document.getElementById('match-view');
  const pitView = document.getElementById('subtab-pit') || document.getElementById('pit-scouting-view') || document.getElementById('view-pit') || document.getElementById('pit-view');

  const activateSubTab = (subtab) => {
    lastActiveScoutingSubTab = subtab;
    if (subtab === 'pit') {
      if (pitTab) pitTab.classList.add('active');
      if (matchTab) matchTab.classList.remove('active');
      if (matchView) { matchView.classList.add('hidden'); matchView.classList.remove('active'); }
      if (pitView) { pitView.classList.remove('hidden'); pitView.classList.add('active'); }
      console.log('Switched to Pit Scouting View');

      // If a team is currently selected, auto-load its pit detail
      if (typeof currentSelectedTeamNumber !== 'undefined' && currentSelectedTeamNumber && typeof selectedEvent !== 'undefined' && selectedEvent?.code) {
        const foundTeam = (typeof currentEventTeams !== 'undefined' ? currentEventTeams : []).find(t => t.teamNumber === currentSelectedTeamNumber);
        wireTeamPitDetailClick(currentSelectedTeamNumber, selectedEvent.code, foundTeam || { teamNumber: currentSelectedTeamNumber });
      }
    } else {
      if (matchTab) matchTab.classList.add('active');
      if (pitTab) pitTab.classList.remove('active');
      if (matchView) { matchView.classList.remove('hidden'); matchView.classList.add('active'); }
      if (pitView) { pitView.classList.add('hidden'); pitView.classList.remove('active'); }
      console.log('Switched to Match Scouting View');

      // If a team is currently selected, auto-load its match detail
      if (typeof currentSelectedTeamNumber !== 'undefined' && currentSelectedTeamNumber && typeof selectedEvent !== 'undefined' && selectedEvent?.code) {
        if (typeof loadTeamDetail === 'function') {
          loadTeamDetail(currentSelectedTeamNumber, selectedEvent.code);
        }
      }
    }
  };

  if (matchTab && pitTab) {
    matchTab.addEventListener('click', (e) => {
      e.preventDefault();
      activateSubTab('match');
    });

    pitTab.addEventListener('click', (e) => {
      e.preventDefault();
      activateSubTab('pit');
    });
  }

  // Ensure top-level Scouting tab stays highlighted when switching sub-tabs, and restore last-active subtab when navigating back to Scouting
  const scoutingTopTab = document.querySelector('[data-dtab="scouting"]');
  if (scoutingTopTab) {
    scoutingTopTab.addEventListener('click', () => {
      setTimeout(() => {
        activateSubTab(lastActiveScoutingSubTab);
      }, 10);
    });
  }

  if (scoutingTopTab && matchTab && pitTab) {
    const ensureTopTabActive = () => {
      if (!scoutingTopTab.classList.contains('active')) {
        scoutingTopTab.classList.add('active');
      }
    };
    matchTab.addEventListener('click', ensureTopTabActive);
    pitTab.addEventListener('click', ensureTopTabActive);
  }
});
