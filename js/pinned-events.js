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
      currentTeamData.pinnedEvents = currentTeamData.pinnedEvents.filter(e => e.code !== eventEntry.code);
    } else {
      const entry = { code: eventEntry.code, name: eventEntry.name || eventEntry.code };
      await teamRef.update({
        pinnedEvents: firebase.firestore.FieldValue.arrayUnion(entry)
      });
      currentTeamData.pinnedEvents = [...(currentTeamData.pinnedEvents || []), entry];
    }
    updatePinButtonUI();
    renderPinnedEventsList();
  } catch (err) {
    console.error('Failed to toggle pinned event:', err);
    alert('Failed to update pinned events. Check your connection and permissions.');
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
    item.style.cursor = 'default'; // row itself is no longer clickable — use the Select button
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

    const btnGroup = document.createElement('div');
    btnGroup.style.display = 'flex';
    btnGroup.style.gap = '6px';
    btnGroup.style.flexShrink = '0';

    const selectBtn = document.createElement('button');
    selectBtn.className = `btn btn-small ${isSelected ? 'btn-primary' : 'btn-outline'}`;
    selectBtn.textContent = isSelected ? 'Deselect' : 'Select';
    selectBtn.addEventListener('click', () => {
      if (isSelected) {
        // Reuse the same "clear selected event" logic used elsewhere in the app.
        if (typeof clearSelectedEvent === 'function') {
          clearSelectedEvent();
        }
      } else if (typeof selectEvent === 'function') {
        // Selecting from this tab leaves behind a stale search query/result set
        // from the event-search box, since that flow was never involved — clear it.
        const searchInput = document.getElementById('input-event-search');
        if (searchInput) searchInput.value = '';
        if (typeof hideSuggestions === 'function') hideSuggestions();
        const eventResults = document.getElementById('event-results');
        if (eventResults) eventResults.innerHTML = '';

        // Loads the event exactly the way selecting it from search results does.
        selectEvent({ code: evt.code, name: evt.name || evt.code });
      }
    });
    btnGroup.appendChild(selectBtn);

    if (canPin) {
      const unpinBtn = document.createElement('button');
      unpinBtn.className = 'btn btn-outline btn-small';
      unpinBtn.textContent = isEventPinned(evt.code) ? '📌 Unpin' : '📌 Pin';
      unpinBtn.addEventListener('click', () => {
        togglePinForEvent(evt);
      });
      btnGroup.appendChild(unpinBtn);
    }

    item.appendChild(btnGroup);
    container.appendChild(item);
  });
}

document.addEventListener('DOMContentLoaded', () => {
  const pinBtn = document.getElementById('btn-pin-event');
  if (pinBtn) {
    pinBtn.addEventListener('click', togglePinEvent);
  }
});
