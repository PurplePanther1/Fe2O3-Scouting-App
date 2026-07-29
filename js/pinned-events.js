// ====== Pinned Events ======
// pinnedEvents lives on the team doc as an array of {code, name} — shared team-wide,
// but only the captain may write it (enforced both client-side here and in
// firestore.rules, where pinnedEvents is added to the same captain-only field list
// as roles/permissions/name/joinCode).

// ====== Is this event currently pinned by the team? ======
function isEventPinned(eventCode) {
  if (!eventCode || !currentTeamData?.pinnedEvents) return false;
  return currentTeamData.pinnedEvents.some(e => e.code === eventCode);
}

// ====== Show/hide & label the Pin button based on captain status and current event ======
function updatePinButtonUI() {
  const btn = document.getElementById('btn-pin-event');
  if (!btn) return;

  const isCaptain = typeof getCurrentUserRole === 'function' && getCurrentUserRole() === 'captain';
  if (!isCaptain || !selectedEvent?.code) {
    btn.classList.add('hidden');
    return;
  }

  btn.classList.remove('hidden');
  btn.textContent = isEventPinned(selectedEvent.code) ? '📌 Unpin This Event' : '📌 Pin This Event';
}

// ====== Toggle pin state for the currently selected event (captain only) ======
async function togglePinEvent() {
  if (!selectedEvent?.code || !currentTeamData?.id) return;

  const teamRef = db.collection('teams').doc(currentTeamData.id);
  const pinned = isEventPinned(selectedEvent.code);

  try {
    if (pinned) {
      const existing = currentTeamData.pinnedEvents.find(e => e.code === selectedEvent.code);
      await teamRef.update({
        pinnedEvents: firebase.firestore.FieldValue.arrayRemove(existing)
      });
      currentTeamData.pinnedEvents = currentTeamData.pinnedEvents.filter(e => e.code !== selectedEvent.code);
    } else {
      const entry = { code: selectedEvent.code, name: selectedEvent.name || selectedEvent.code };
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

  pinned.forEach(evt => {
    const item = document.createElement('div');
    item.className = 'event-item';
    if (selectedEvent && selectedEvent.code === evt.code) {
      item.classList.add('selected');
    }

    const nameEl = document.createElement('div');
    nameEl.className = 'event-name';
    nameEl.textContent = evt.name || evt.code;

    const codeEl = document.createElement('div');
    codeEl.className = 'event-code';
    codeEl.textContent = evt.code;

    item.appendChild(nameEl);
    item.appendChild(codeEl);

    // Loads the event exactly the way selecting it from search results does.
    item.addEventListener('click', () => {
      if (typeof selectEvent === 'function') {
        selectEvent({ code: evt.code, name: evt.name || evt.code });
      }
    });

    container.appendChild(item);
  });
}

document.addEventListener('DOMContentLoaded', () => {
  const pinBtn = document.getElementById('btn-pin-event');
  if (pinBtn) {
    pinBtn.addEventListener('click', togglePinEvent);
  }
});
