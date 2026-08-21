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

// ====== Modals always reopen scrolled to top ======
// Every modal's scrollable region(s) — the outer .modal-card itself
// (max-height:90vh; overflow-y:auto — the only scroll region for most
// modals) plus any inline overflow-y:auto region nested inside it (e.g. Team
// Detail's own scrollable body) — keep whatever scroll position they were
// left at between opens, since the elements just stay in the DOM. Rather
// than resetting scrollTop at every one of the many open-call sites spread
// across the codebase, a single observer watches every modal's `hidden`
// class and resets scroll the moment it's removed, regardless of which
// call site did it.
//
// Also watches the SUBTREE, not just each modal's own class attribute: Team
// Detail (team-info.js) hides its scrollable body behind a loading state and
// reveals it only after data finishes loading — resetting scrollTop while an
// element is display:none is silently ignored by the browser, so doing it
// only when the outer modal opens left the pre-close scroll position to
// resurface the instant the body itself became visible again. Watching every
// descendant's class changes catches that reveal too, not just the modal's.
document.addEventListener('DOMContentLoaded', () => {
  const resetModalScroll = (modal) => {
    const card = modal.querySelector('.modal-card');
    if (card) card.scrollTop = 0;
    modal.querySelectorAll('[style*="overflow-y"]').forEach(el => { el.scrollTop = 0; });
  };

  const modalScrollObserver = new MutationObserver(mutations => {
    mutations.forEach(mutation => {
      const el = mutation.target;
      if (el.classList.contains('hidden')) return; // just hidden (or already hidden) — nothing to reset

      if (el.classList.contains('modal-overlay')) {
        resetModalScroll(el);
      } else if (el.style && el.style.overflowY) {
        // A scrollable region nested inside an already-open modal just
        // became visible (e.g. Team Detail's td-modal-body, revealed after
        // its loading state) — reset it now that display:none can no longer
        // swallow the write.
        el.scrollTop = 0;
      }
    });
  });

  document.querySelectorAll('.modal-overlay').forEach(modal => {
    modalScrollObserver.observe(modal, { attributes: true, attributeFilter: ['class'], subtree: true });
  });
});

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

    if (typeof saveSessionState === 'function') {
      saveSessionState();
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
