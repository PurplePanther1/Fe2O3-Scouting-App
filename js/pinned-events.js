// ====== Pinned Events ======
// pinnedEvents lives on the team doc as an array of {code, name, season} —
// shared team-wide, but only the captain or a member with the canPinEvents
// permission may write it (enforced both client-side here and in
// firestore.rules, where the pinnedEvents write is allowed for the captain OR
// anyone with permissions[uid].canPinEvents == true).
//
// `season` is recorded when an event is pinned. FIRST reuses an event code from
// year to year, so (code, season) — not code alone — identifies a pin, and
// selecting a pin from another season has to switch the app to THAT season
// first: selectEvent() reads getSelectedSeason() for the roster fetch, the
// Firestore event cache and the schedule, and asking FIRST for a code under the
// wrong season fails ("Could not load teams. Check your connection and try
// again."), which was the original cross-season bug.
//
// LEGACY pins (pinned before `season` existed) have no season. Their season is
// looked up lazily from the global events/{code} cache doc (which records the
// season it was cached for) and remembered in memory only; if that can't be
// determined the pin is shown under EVERY season with a "season unknown" tag and
// selecting it uses the season the Pinned tab is currently showing — i.e. the
// old behavior, never worse than before. Nothing is rewritten on the team doc.

// The Pinned tab's own season filter. It starts at, FOLLOWS, and resets to the
// app's CURRENTLY SELECTED season (getSelectedSeason(), the main season
// dropdown):
//   - it defaults to the app's selected season;
//   - whenever the app's season changes while the tab exists — the user picks a
//     season, a session restore/team switch sets one, or selecting a pin from
//     another season switches it (setAppSeasonQuietly(), first-api.js) — the
//     dropdown shows the new app season (syncPinnedSeasonToApp());
//   - while the user stays on the tab, picking another season here only
//     FILTERS the list; it never changes the app's season;
//   - it goes back to the app's selected season (as it is at that moment)
//     whenever the tab is left (resetPinnedSeasonFilter(), app.js/members.js).
// (An earlier version defaulted to the real current FTC season instead; that was
// a miscommunication and is gone — getCurrentFtcSeason() is not used here.)
let pinnedFilterSeason = null;
// The app season the filter last matched; a change in the app's season (see
// syncPinnedSeasonToApp()) makes the filter follow it.
let pinnedLastAppSeason = null;

// legacy pin code -> season string (resolved), null (couldn't resolve);
// undefined = not looked up yet.
const legacyPinSeasonCache = {};
const legacyPinLookupsStarted = new Set();

function appSelectedSeasonString() {
  return String(getSelectedSeason());
}

// The season a pin belongs to, or null when unknown (a legacy pin that
// couldn't be resolved, or hasn't been looked up yet).
function pinSeason(pin) {
  if (pin && pin.season) return String(pin.season);
  const cached = pin ? legacyPinSeasonCache[pin.code] : undefined;
  return cached ? String(cached) : null;
}

// Does this pin stand for (eventCode, season)? An unknown-season legacy pin
// matches by code alone — the pre-season behavior.
function pinMatches(pin, eventCode, season) {
  if (!pin || pin.code !== eventCode) return false;
  const s = pinSeason(pin);
  return s === null || s === String(season);
}

// ====== Is this event currently pinned by the team? `season` defaults to the
// app's selected season (what the header Pin button is about). ======
function isEventPinned(eventCode, season = (typeof getSelectedSeason === 'function' ? getSelectedSeason() : undefined)) {
  if (!eventCode || !currentTeamData?.pinnedEvents) return false;
  return currentTeamData.pinnedEvents.some(p => pinMatches(p, eventCode, season));
}

// ====== Show/hide & label the Pin button based on captain status and current event ======
function updatePinButtonUI() {
  const btn = document.getElementById('btn-pin-event');
  if (!btn) return;

  const canPin = typeof canUserPinEvents === 'function' && canUserPinEvents();
  // Scrimmages are never pinned — they have their own list (Scrimmages subtab).
  if (!canPin || !selectedEvent?.code || selectedEvent.isScrimmage) {
    btn.classList.add('hidden');
    return;
  }

  btn.classList.remove('hidden');
  btn.textContent = isEventPinned(selectedEvent.code) ? '📌 Unpin This Event' : '📌 Pin This Event';
}

// ====== Toggle pin state for an event in a season (captain or canPinEvents).
// Pinning records the season. Unpinning removes ONE stored object: the exact
// pin passed as eventEntry.pin (a row's own Unpin button — two stored pins can
// stand for the same (code, season), e.g. a legacy pin and a recorded one, and
// the one clicked must be the one removed), else whichever stored pin matches
// (the header Pin button). ======
async function togglePinForEvent(eventEntry) {
  if (!eventEntry?.code || !currentTeamData?.id) return;
  if (eventEntry.isScrimmage || isScrimmageCode(eventEntry.code)) return; // scrimmages can't be pinned

  const season = String(eventEntry.season || pinSeason(eventEntry) || getSelectedSeason());
  const teamRef = db.collection('teams').doc(currentTeamData.id);
  const existing = eventEntry.pin || (currentTeamData.pinnedEvents || []).find(p => pinMatches(p, eventEntry.code, season));

  try {
    if (existing) {
      await teamRef.update({
        pinnedEvents: firebase.firestore.FieldValue.arrayRemove(existing)
      });
    } else {
      const entry = { code: eventEntry.code, name: eventEntry.name || eventEntry.code, season };
      await teamRef.update({
        pinnedEvents: firebase.firestore.FieldValue.arrayUnion(entry)
      });
    }
    // No local state mutation or re-render here — the live team doc listener
    // (watchTeamDoc in auth.js) picks up this write, refreshes currentTeamData with
    // the authoritative array, and re-renders (updatePinButtonUI/renderPinnedEventsList)
    // for us. Doing it here too raced that listener and duplicated the visual row.
  } catch (err) {
    console.error('Failed to toggle pinned event:', err);
    if (typeof showNoticeModal === 'function') {
      showNoticeModal({
        title: 'Update Failed',
        message: 'Failed to update pinned events. Check your connection and permissions.'
      });
    }
  }
}

// ====== Toggle pin state for the currently selected event (the header button) ======
async function togglePinEvent() {
  if (!selectedEvent?.code) return;
  await togglePinForEvent({ ...selectedEvent, season: getSelectedSeason() });
}

// ====== Legacy pins: look up the season of any pin that doesn't record one.
// One events/{code} read per distinct code, once per page load; re-renders when
// they land. ======
async function resolveLegacyPinSeasons(pins) {
  const codes = Array.from(new Set(
    (pins || []).filter(p => !p.season && !legacyPinLookupsStarted.has(p.code)).map(p => p.code)
  ));
  if (codes.length === 0) return;
  codes.forEach(code => legacyPinLookupsStarted.add(code));

  await Promise.all(codes.map(async (code) => {
    try {
      const doc = await db.collection('events').doc(code).get();
      const season = doc.exists ? doc.data().season : null;
      legacyPinSeasonCache[code] = season ? String(season) : null;
    } catch (err) {
      console.warn(`Could not determine the season of legacy pin ${code}:`, err);
      legacyPinSeasonCache[code] = null;
    }
  }));
  renderPinnedEventsList();
}

// ====== The Pinned tab's season <select> ======
function ensurePinnedSeasonSelect() {
  const select = document.getElementById('select-pinned-season');
  if (!select) return null;
  if (pinnedFilterSeason === null) {
    pinnedFilterSeason = appSelectedSeasonString();
    pinnedLastAppSeason = pinnedFilterSeason;
  }
  if (select.options.length === 0) {
    populateSeasonSelectOptions(select, pinnedFilterSeason);
  } else if (select.value !== pinnedFilterSeason) {
    select.value = pinnedFilterSeason;
  }
  return select;
}

// ====== Back to the app's selected season (as it is NOW) — called whenever the
// Pinned tab is left (any Scouting subtab switch, or leaving the Scouting
// dashboard tab). ======
function resetPinnedSeasonFilter() {
  pinnedFilterSeason = appSelectedSeasonString();
  pinnedLastAppSeason = pinnedFilterSeason;
  const select = document.getElementById('select-pinned-season');
  if (select && select.options.length > 0) select.value = pinnedFilterSeason;
  renderPinnedEventsList();
}

// ====== Make the filter follow the app's season. Called wherever the app's
// season dropdown gets set or changes (setAppSeasonQuietly(), the season
// <select>'s own change handler, session restore, entering a team); a no-op
// unless the app's season really changed since the filter last matched it, so
// a season the user picked on this tab stays put until the app season moves. ======
function syncPinnedSeasonToApp() {
  const app = appSelectedSeasonString();
  if (pinnedLastAppSeason !== null && app === pinnedLastAppSeason) return;
  pinnedFilterSeason = app;
  pinnedLastAppSeason = app;
  renderPinnedEventsList();
}

// ====== Select a pin. If it belongs to a different season than the app is
// showing, switch the app's season to the pin's FIRST (shared helper — same one
// scrimmages use — which sets the dropdown without firing its change handler
// and starts loading that season's event cache), then select. ======
function selectPinnedEvent(pin) {
  // An unknown-season legacy pin uses the season the Pinned tab is showing.
  const season = pinSeason(pin) || pinnedFilterSeason || appSelectedSeasonString();
  setAppSeasonQuietly(season);

  // Clear whatever was selected (and, via it, any search results — which now
  // belong to the wrong season anyway), then fill the search bar with this
  // event's name and route through the same steps selecting from the search
  // dropdown uses (first-api.js renderSuggestions' click handler) — needed so
  // the choice persists across a refresh: session-state.js saves whatever's in
  // the search box alongside selectedEvent and restores it verbatim.
  if (typeof clearSelectedEvent === 'function') clearSelectedEvent();
  const searchInput = document.getElementById('input-event-search');
  if (searchInput) searchInput.value = pin.name || pin.code;
  if (typeof selectEvent === 'function') selectEvent({ code: pin.code, name: pin.name || pin.code, season });
  if (typeof hideSuggestions === 'function') hideSuggestions();
  if (typeof saveSessionState === 'function') saveSessionState();
}

// ====== Render the Pinned tab's event list (filtered to the tab's season) ======
function renderPinnedEventsList() {
  const container = document.getElementById('pinned-events-list');
  const status = document.getElementById('pinned-events-status');
  if (!container || !status) return;

  ensurePinnedSeasonSelect();
  // Follow the app's season if it moved (belt and braces: the explicit
  // syncPinnedSeasonToApp() calls cover the places the season is set).
  const appNow = appSelectedSeasonString();
  if (pinnedLastAppSeason !== null && appNow !== pinnedLastAppSeason) {
    pinnedFilterSeason = appNow;
    pinnedLastAppSeason = appNow;
    const sel = document.getElementById('select-pinned-season');
    if (sel) sel.value = appNow;
  }
  const allPins = currentTeamData?.pinnedEvents || [];
  resolveLegacyPinSeasons(allPins);

  container.innerHTML = '';

  const filter = pinnedFilterSeason;
  const seasonLabel = formatFtcSeasonLabel(filter);
  const visible = allPins.filter(p => {
    const s = pinSeason(p);
    return s === null || s === filter; // unknown-season legacy pins show under every season
  });

  if (allPins.length === 0) {
    status.textContent = 'No events pinned yet.';
    return;
  }
  if (visible.length === 0) {
    status.textContent = `No events pinned for ${seasonLabel}. (${allPins.length} pinned in other seasons.)`;
    return;
  }
  status.textContent = `${visible.length} pinned event(s) for ${seasonLabel}`;

  const canPin = typeof canUserPinEvents === 'function' && canUserPinEvents();

  visible.forEach(evt => {
    const evtSeason = pinSeason(evt);
    const isSelected = !!(selectedEvent && !selectedEvent.isScrimmage && selectedEvent.code === evt.code
      && (evtSeason === null || evtSeason === String(getSelectedSeason())));

    const item = document.createElement('div');
    item.className = 'event-item';
    item.dataset.code = evt.code;
    item.style.display = 'flex';
    item.style.justifyContent = 'space-between';
    item.style.alignItems = 'center';
    item.style.gap = '10px';
    if (isSelected) {
      item.classList.add('selected');
    }

    const textGroup = document.createElement('div');

    const nameEl = document.createElement('div');
    nameEl.className = 'event-name';
    nameEl.textContent = evt.name || evt.code;

    const codeEl = document.createElement('div');
    codeEl.className = 'event-code';
    codeEl.textContent = evtSeason === null ? `${evt.code} • season unknown` : evt.code;

    textGroup.appendChild(nameEl);
    textGroup.appendChild(codeEl);
    item.appendChild(textGroup);

    // The whole row is the click target (no separate select/deselect button) —
    // matches the event-search results list: click to select, click the
    // selected one again to deselect.
    item.addEventListener('click', () => {
      // A click landing while THIS SAME event is still mid-selectEvent() is
      // ignored — isSelected above is a snapshot from when this row was last
      // (re-)rendered, which happens synchronously inside selectEvent() itself
      // before its actual team/schedule fetch has finished, so a re-click on
      // a slow connection would otherwise read as "already selected" and
      // incorrectly deselect an event that's still loading. Confirmed via
      // repeated Playwright reproduction — see selectEventLoadingCode's own
      // comment in first-api.js.
      if (typeof selectEventLoadingCode !== 'undefined' && selectEventLoadingCode === evt.code) return;

      // Decided from the LIVE selection at click time, not the `isSelected`
      // snapshot taken at render (the same stale-snapshot trap the scrimmage
      // rows had — see their click handler in scrimmages.js).
      const selectedNow = !!(selectedEvent && !selectedEvent.isScrimmage && selectedEvent.code === evt.code
        && (evtSeason === null || evtSeason === String(getSelectedSeason())));
      if (selectedNow) {
        // Reuse the same "clear selected event" logic used elsewhere in the app.
        if (typeof clearSelectedEvent === 'function') {
          clearSelectedEvent();
        }
      } else {
        selectPinnedEvent(evt);
      }
    });

    if (canPin) {
      const btnGroup = document.createElement('div');
      btnGroup.style.display = 'flex';
      btnGroup.style.gap = '6px';
      btnGroup.style.flexShrink = '0';

      const unpinBtn = document.createElement('button');
      unpinBtn.className = 'btn btn-outline btn-small btn-unpin';
      unpinBtn.textContent = '📌 Unpin';
      unpinBtn.addEventListener('click', (e) => {
        e.stopPropagation(); // don't also trigger the row's select/deselect click
        togglePinForEvent({ code: evt.code, name: evt.name, season: evtSeason || filter, pin: evt });
      });
      btnGroup.appendChild(unpinBtn);
      item.appendChild(btnGroup);
    }

    container.appendChild(item);
  });
}

document.addEventListener('DOMContentLoaded', () => {
  const pinBtn = document.getElementById('btn-pin-event');
  if (pinBtn) {
    pinBtn.addEventListener('click', togglePinEvent);
  }

  const seasonSelect = document.getElementById('select-pinned-season');
  if (seasonSelect) {
    ensurePinnedSeasonSelect();
    seasonSelect.addEventListener('change', () => {
      pinnedFilterSeason = seasonSelect.value;
      renderPinnedEventsList();
    });
  }
});
