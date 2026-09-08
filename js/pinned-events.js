// ====== Pinned Events ======
// pinnedEvents lives on the team doc as an array of {code, name} — shared team-wide,
// but only the captain or a member with the canPinEvents permission may write it
// (enforced both client-side here and in firestore.rules, where the pinnedEvents
// write is allowed for the captain OR anyone with permissions[uid].canPinEvents == true).

// ====== Is this event currently pinned by the team? ======
function isEventPinned(eventCode) {
  if (!eventCode || !currentTeamData?.pinnedEvents) return false;
  return currentTeamData.pinnedEvents.some(e => e.code === eventCode);
}

// ====== Show/hide & label the Pin button based on captain status and current event ======
function updatePinButtonUI() {
  const btn = document.getElementById('btn-pin-event');
  if (!btn) return;

  const canPin = typeof canUserPinEvents === 'function' && canUserPinEvents();
  if (!canPin || !selectedEvent?.code) {
    btn.classList.add('hidden');
    return;
  }

  btn.classList.remove('hidden');
  btn.textContent = isEventPinned(selectedEvent.code) ? '📌 Unpin This Event' : '📌 Pin This Event';
}

// ====== Toggle pin state for an arbitrary event (captain or canPinEvents) ======
async function togglePinForEvent(eventEntry) {
  if (!eventEntry?.code || !currentTeamData?.id) return;

  const teamRef = db.collection('teams').doc(currentTeamData.id);
  const pinned = isEventPinned(eventEntry.code);

  try {
    if (pinned) {
      const existing = currentTeamData.pinnedEvents.find(e => e.code === eventEntry.code);
      await teamRef.update({
        pinnedEvents: firebase.firestore.FieldValue.arrayRemove(existing)
      });
    } else {
      const entry = { code: eventEntry.code, name: eventEntry.name || eventEntry.code };
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
  await togglePinForEvent(selectedEvent);
}

// ====== Render the Pinned tab's event list ======
function renderPinnedEventsList() {
  const container = document.getElementById('pinned-events-list');
  const status = document.getElementById('pinned-events-status');
  if (!container || !status) return;

  const pinned = currentTeamData?.pinnedEvents || [];
  container.innerHTML = '';

  if (pinned.length === 0) {
    status.textContent = 'No events pinned yet.';
    return;
  }

  status.textContent = `${pinned.length} pinned event(s)`;

  const canPin = typeof canUserPinEvents === 'function' && canUserPinEvents();

  pinned.forEach(evt => {
    const isSelected = !!(selectedEvent && selectedEvent.code === evt.code);

    const item = document.createElement('div');
    item.className = 'event-item';
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
    codeEl.textContent = evt.code;

    textGroup.appendChild(nameEl);
    textGroup.appendChild(codeEl);
    item.appendChild(textGroup);

    // Row itself is the click target now — matches the event-search results
    // list's pattern (click to select, no separate button). Clicking an
    // already-selected row deselects it.
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

      if (isSelected) {
        // Reuse the same "clear selected event" logic used elsewhere in the app.
        if (typeof clearSelectedEvent === 'function') {
          clearSelectedEvent();
        }
      } else if (typeof selectEvent === 'function') {
        // Fill the search bar with this event's name and route through the exact
        // same steps selecting from the search dropdown uses (first-api.js
        // renderSuggestions' click handler) — needed so the choice persists
        // across a refresh the same way: session-state.js saves whatever's in
        // the search box alongside selectedEvent, and restorePerTeamEventState()
        // just restores that saved text verbatim rather than re-deriving it.
        const searchInput = document.getElementById('input-event-search');
        if (searchInput) searchInput.value = evt.name || evt.code;
        if (typeof clearSelectedEvent === 'function') clearSelectedEvent();
        selectEvent({ code: evt.code, name: evt.name || evt.code });
        if (typeof hideSuggestions === 'function') hideSuggestions();
      }
    });

    if (canPin) {
      const btnGroup = document.createElement('div');
      btnGroup.style.display = 'flex';
      btnGroup.style.gap = '6px';
      btnGroup.style.flexShrink = '0';

      const unpinBtn = document.createElement('button');
      unpinBtn.className = 'btn btn-outline btn-small';
      unpinBtn.textContent = isEventPinned(evt.code) ? '📌 Unpin' : '📌 Pin';
      unpinBtn.addEventListener('click', (e) => {
        e.stopPropagation(); // don't also trigger the row's select/deselect click
        togglePinForEvent(evt);
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
});
