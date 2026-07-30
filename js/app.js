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
let lastActiveScoutingSubTab = 'info'; // Remembers 'info', 'match', 'pit', or 'pinned'

document.addEventListener('DOMContentLoaded', () => {
  const subtabs = {
    info: {
      tab: document.querySelector('[data-subtab="info"]'),
      view: document.getElementById('subtab-info')
    },
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

    if (subtab === 'info') {
      console.log('Switched to Team Information View');
      if (typeof renderTeamInfoList === 'function' && typeof currentEventTeams !== 'undefined' && currentEventTeams.length > 0) {
        renderTeamInfoList(currentEventTeams);
      }
    } else if (subtab === 'pit') {
      console.log('Switched to Pit Scouting View');
    } else if (subtab === 'match') {
      console.log('Switched to Match Scouting View');
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

  // Exposed so selecting an event (from search or the Pinned Events list) can
  // jump the user to a scouting subtab, same as clicking a subtab button directly.
  window.activateScoutingSubTab = activateSubTab;

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
