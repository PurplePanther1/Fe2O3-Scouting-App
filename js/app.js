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
let lastActiveScoutingSubTab = 'match'; // Remembers 'match', 'pit', or 'pinned'

document.addEventListener('DOMContentLoaded', () => {
  const subtabs = {
    match: {
      tab: document.querySelector('[data-subtab="match"]'),
      view: document.getElementById('subtab-match')
    },
    pit: {
      tab: document.querySelector('[data-subtab="pit"]'),
      view: document.getElementById('subtab-pit')
    },
    pinned: {
      tab: document.querySelector('[data-subtab="pinned"]'),
      view: document.getElementById('subtab-pinned')
    }
  };

  const activateSubTab = (subtab) => {
    if (!subtabs[subtab]) return;
    lastActiveScoutingSubTab = subtab;

    Object.entries(subtabs).forEach(([name, { tab, view }]) => {
      const isActive = name === subtab;
      if (tab) tab.classList.toggle('active', isActive);
      if (view) {
        view.classList.toggle('hidden', !isActive);
        view.classList.toggle('active', isActive);
      }
    });

    if (subtab === 'pit') {
      console.log('Switched to Pit Scouting View');
      // If a team is currently selected, auto-load its pit detail
      if (typeof currentSelectedTeamNumber !== 'undefined' && currentSelectedTeamNumber && typeof selectedEvent !== 'undefined' && selectedEvent?.code) {
        const foundTeam = (typeof currentEventTeams !== 'undefined' ? currentEventTeams : []).find(t => t.teamNumber === currentSelectedTeamNumber);
        if (typeof wireTeamPitDetailClick === 'function') {
          wireTeamPitDetailClick(currentSelectedTeamNumber, selectedEvent.code, foundTeam || { teamNumber: currentSelectedTeamNumber });
        }
      }
    } else if (subtab === 'match') {
      console.log('Switched to Match Scouting View');
      // If a team is currently selected, auto-load its match detail
      if (typeof currentSelectedTeamNumber !== 'undefined' && currentSelectedTeamNumber && typeof selectedEvent !== 'undefined' && selectedEvent?.code) {
        if (typeof loadTeamDetail === 'function') {
          loadTeamDetail(currentSelectedTeamNumber, selectedEvent.code);
        }
      }
    } else if (subtab === 'pinned') {
      console.log('Switched to Pinned Events View');
      if (typeof renderPinnedEventsList === 'function') {
        renderPinnedEventsList();
      }
    }
  };

  Object.entries(subtabs).forEach(([name, { tab }]) => {
    if (tab) {
      tab.addEventListener('click', (e) => {
        e.preventDefault();
        activateSubTab(name);
      });
    }
  });

  // Ensure top-level Scouting tab stays highlighted when switching sub-tabs, and restore last-active subtab when navigating back to Scouting
  const scoutingTopTab = document.querySelector('[data-dtab="scouting"]');
  if (scoutingTopTab) {
    scoutingTopTab.addEventListener('click', () => {
      setTimeout(() => {
        activateSubTab(lastActiveScoutingSubTab);
      }, 10);
    });

    const ensureTopTabActive = () => {
      if (!scoutingTopTab.classList.contains('active')) {
        scoutingTopTab.classList.add('active');
      }
    };
    Object.values(subtabs).forEach(({ tab }) => {
      if (tab) tab.addEventListener('click', ensureTopTabActive);
    });
  }
});
