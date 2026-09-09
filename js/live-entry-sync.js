// ====== Shared live-collaboration engine for pit/match scouting entries ======
// Used by pit-scout.js (always) and match-scout.js (only for entries opened
// from the match-based/schedule view — the team-based view keeps its own
// batch-save model, see match-scout.js for why).
//
// Presence lives as a MAP FIELD on the entry document itself
// (activeEditors: { [uid]: { name, heartbeatAt, focusedField } }), not a
// separate subcollection. That's required, not a style choice: Firestore
// security rules can get()/exists() a specific document path but cannot
// query or enumerate a collection, so "is anyone else currently present"
// can only be enforced server-side if it's a field on the very document
// being written. It also means every join/leave is just an ordinary
// read-modify-write on one document, which Firestore already serializes —
// no separate coordination needed to avoid a join/leave race.
//
// heartbeatAt staleness (LIVE_PRESENCE_STALE_MS) is a CLIENT-SIDE display
// filter only, not a server-enforced TTL — a crashed tab's entry lingers in
// the map until someone's next write opportunistically prunes it. That's an
// accepted, deliberately benign failure mode: an unpruned stale entry only
// keeps the document in the MORE permissive "someone's already in here, any
// team member may join" state — it can never lock anyone out, only stay
// collaborative longer than strictly necessary.

const LIVE_PRESENCE_HEARTBEAT_MS = 15000;
const LIVE_PRESENCE_STALE_MS = 45000;
const LIVE_FIELD_DEBOUNCE_MS = 600;

// ====== Is this activeEditors[uid] entry still "live" for display purposes?
// (Not a security check — see file header.) ======
function isPresenceFresh(heartbeatAt) {
  if (!heartbeatAt) return false;
  const ms = typeof heartbeatAt.toMillis === 'function' ? heartbeatAt.toMillis()
    : (heartbeatAt instanceof Date ? heartbeatAt.getTime() : null);
  if (ms == null) return false;
  return (Date.now() - ms) < LIVE_PRESENCE_STALE_MS;
}

// ====== Decide what opening an entry should do, given its current data (or
// null for a brand-new entry) and a canEditFn (pass canUserEditOtherEntries,
// auth.js) that mirrors firestore.rules' canEditOrDeleteEntry client-side.
// - blocked: zero active editors, and this user isn't the owner/captain/
//   canEditOtherEntries — nothing to view-and-wait-for either, so refuse.
// - startInEditMode: zero active editors and this user qualifies — the
//   classic uncontended case, join and start editing immediately.
// - otherwise (hasActiveEditors true): open read-only with a "Take Over"
//   option, REGARDLESS of whether this user would also qualify to edit
//   outright — someone already being in there is exactly the "coordinate
//   first" signal this feature exists to surface, even for the owner. ======
function classifyLiveEntryAccess(existingData, canEditFn) {
  const activeEditors = (existingData && existingData.activeEditors) || {};
  const hasActiveEditors = Object.keys(activeEditors).length > 0;
  const qualifies = !existingData || canEditFn(existingData);
  return {
    hasActiveEditors,
    qualifies,
    blocked: !hasActiveEditors && !qualifies,
    startInEditMode: !hasActiveEditors && qualifies
  };
}

// ====== Create a live session bound to one entry document. Attaches the
// doc listener immediately (so even a read-only viewer sees live field
// updates and presence) but does NOT join as an active editor until join()
// is called — viewing is free/anonymous, joining is an explicit step.
// onSnapshotData(data|null) is called on every snapshot (data is null if the
// doc doesn't exist yet, e.g. a brand-new entry nobody has typed into). ======
function createLiveEntrySession({ docRef, uid, displayName, onSnapshotData }) {
  let detached = false;
  let joined = false;
  let heartbeatTimer = null;
  let lastKnownData = null;
  const debounceTimers = {};
  const pendingValues = {};

  const unsubscribe = docRef.onSnapshot((snap) => {
    lastKnownData = snap.exists ? snap.data() : null;
    if (!detached) onSnapshotData(lastKnownData);
  }, (err) => console.warn('Live entry sync listener error:', err));

  function startHeartbeat() {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
      docRef.update({
        [`activeEditors.${uid}.heartbeatAt`]: firebase.firestore.FieldValue.serverTimestamp()
      }).catch((err) => console.warn('Presence heartbeat failed:', err));
    }, LIVE_PRESENCE_HEARTBEAT_MS);
  }
  function stopHeartbeat() {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  }

  // ====== Join as an active editor. Creates the doc (seeded with
  // baseFieldsIfNew) if this is the first editor ever; otherwise just adds
  // this uid to the existing activeEditors map. Always a transaction — its
  // validity (and, for leave() below, ownership transfer) depends on the
  // rest of the map, which a plain read-then-write could race on. ======
  async function join(baseFieldsIfNew) {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(docRef);
      const data = snap.exists ? snap.data() : null;
      const editors = { ...((data && data.activeEditors) || {}) };
      editors[uid] = {
        name: displayName,
        heartbeatAt: firebase.firestore.FieldValue.serverTimestamp(),
        focusedField: null
      };
      if (!snap.exists) {
        tx.set(docRef, { ...baseFieldsIfNew, activeEditors: editors });
      } else {
        tx.update(docRef, { activeEditors: editors });
      }
    });
    joined = true;
    startHeartbeat();
  }

  // ====== Leave. If this removal empties the map, this uid becomes the new
  // owner (scoutedBy/scoutedByName) — "whoever is last to close out owns
  // it" — which is why this, too, has to be a transaction: the decision of
  // whether the map ends up empty depends on everyone else's current state,
  // not just this uid's own. Best-effort: if it fails (e.g. offline), the
  // presence entry just lingers until it goes stale — see file header. ======
  async function leave() {
    if (!joined) return;
    joined = false;
    stopHeartbeat();
    try {
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(docRef);
        if (!snap.exists) return;
        const data = snap.data();
        const editors = { ...(data.activeEditors || {}) };
        delete editors[uid];
        const update = { activeEditors: editors };
        if (Object.keys(editors).length === 0) {
          update.scoutedBy = uid;
          update.scoutedByName = displayName;
        }
        tx.update(docRef, update);
      });
    } catch (err) {
      console.warn('Leaving live entry session failed (presence will self-clear once stale):', err);
    }
  }

  // ====== Write one field's value now. lastEditedBy* is only stamped when
  // the value actually differs from what this session last saw — opening an
  // entry and leaving untouched fields alone shouldn't reassign "last
  // edited by" to whoever merely has the form open. ======
  function writeField(fieldId, value) {
    if (!joined) return;
    const previous = (lastKnownData && lastKnownData[fieldId] != null) ? lastKnownData[fieldId] : null;
    const normalizedNew = (value === '' || value == null) ? null : value;
    const changed = normalizedNew !== previous;
    const payload = { [fieldId]: value, updatedAt: firebase.firestore.FieldValue.serverTimestamp() };
    if (changed) {
      payload.lastEditedBy = uid;
      payload.lastEditedByName = displayName;
      payload.lastEditedByTimestamp = Date.now();
    }
    // Update our own view of the doc optimistically so rapid repeated edits
    // to the same field are each compared against the latest local value,
    // not a snapshot that hasn't round-tripped yet.
    lastKnownData = { ...(lastKnownData || {}), [fieldId]: value };
    docRef.set(payload, { merge: true }).catch((err) => console.warn('Field write failed:', err));
  }

  // ====== Debounced version of writeField, for text/number/textarea fields
  // firing on every keystroke. Dropdown-style discrete selections should call
  // writeField directly instead (see wireLiveFormFields). ======
  function scheduleWrite(fieldId, value) {
    if (!joined) return;
    pendingValues[fieldId] = value;
    if (debounceTimers[fieldId]) clearTimeout(debounceTimers[fieldId]);
    debounceTimers[fieldId] = setTimeout(() => flushField(fieldId), LIVE_FIELD_DEBOUNCE_MS);
  }
  function flushField(fieldId) {
    if (debounceTimers[fieldId]) { clearTimeout(debounceTimers[fieldId]); delete debounceTimers[fieldId]; }
    if (fieldId in pendingValues) {
      const v = pendingValues[fieldId];
      delete pendingValues[fieldId];
      writeField(fieldId, v);
    }
  }
  function flushAll() {
    Object.keys(debounceTimers).forEach(flushField);
  }

  // ====== Field-level presence: which field (if any) this uid currently has
  // focus in, shown to everyone else as a lightweight indicator rather than
  // any kind of write lock — see applyPresenceIndicators() below. ======
  function setFocusedField(fieldId) {
    if (!joined) return;
    docRef.update({ [`activeEditors.${uid}.focusedField`]: fieldId || null })
      .catch((err) => console.warn('Focus presence update failed:', err));
  }

  async function detach() {
    if (detached) return;
    detached = true;
    unsubscribe();
    Object.keys(debounceTimers).forEach((fieldId) => clearTimeout(debounceTimers[fieldId]));
    await leave();
  }

  return { join, leave, writeField, scheduleWrite, flushAll, setFocusedField, detach, isJoined: () => joined };
}

// ====== Wire a rendered dynamic form's fields to a live session: typed
// fields (text/number/textarea/counter) debounce, dropdown selections write
// immediately (a discrete choice, not a keystroke stream). Also wires
// focus/blur so other viewers see the field-level presence indicator. ======
function wireLiveFormFields(formController, fields, session) {
  fields.forEach((field) => {
    const el = formController.getField(field.id);
    if (!el) return;
    const immediate = field.type === 'dropdown';
    const eventName = immediate ? 'change' : 'input';
    el.addEventListener(eventName, () => {
      const values = formController.getValues();
      if (immediate) session.writeField(field.id, values[field.id]);
      else session.scheduleWrite(field.id, values[field.id]);
    });
    el.addEventListener('focus', () => session.setFocusedField(field.id));
    el.addEventListener('blur', () => session.setFocusedField(null));
  });
}

// ====== Apply remote field values to the form. Deliberately unconditional
// (no "is this field focused" guard) — last-write-wins on the value itself
// is the accepted model here; the field-level presence indicator (not a
// value lock) is what's meant to prevent collisions in practice, the same
// way a spreadsheet shows a colored cell-selection rather than merging
// keystrokes. Skips a field whose displayed value already matches, so a
// heartbeat-only snapshot (no real field change) never touches the DOM. ======
function applyRemoteFieldValues(formController, fields, data) {
  if (!data) return;
  fields.forEach((field) => {
    const el = formController.getField(field.id);
    if (!el) return;
    const incoming = data[field.id];
    const incomingStr = (incoming === null || incoming === undefined) ? '' : String(incoming);
    if (String(el.value) !== incomingStr) {
      formController.setValues({ [field.id]: incoming });
    }
  });
}

// ====== Toggle the per-field "someone else is here" indicator based on the
// current activeEditors map. Shows at most one name per field (the most
// recently relevant editor found); stale entries (see isPresenceFresh) and
// the current user's own entry are never shown. ======
function applyPresenceIndicators(formController, fields, activeEditors, selfUid) {
  const focusedBy = {};
  Object.entries(activeEditors || {}).forEach(([otherUid, info]) => {
    if (otherUid === selfUid || !info) return;
    if (!isPresenceFresh(info.heartbeatAt)) return;
    if (info.focusedField) focusedBy[info.focusedField] = info.name || 'Someone';
  });
  fields.forEach((field) => {
    if (typeof formController.setFieldPresenceIndicator === 'function') {
      formController.setFieldPresenceIndicator(field.id, focusedBy[field.id] || null);
    }
  });
}

// ====== Render the "who else is in here" banner. bannerEl is hidden
// (classList 'hidden') and cleared when nobody else is actively present. ======
function renderPresenceBanner(bannerEl, activeEditors, selfUid) {
  if (!bannerEl) return;
  const others = Object.entries(activeEditors || {})
    .filter(([otherUid, info]) => otherUid !== selfUid && info && isPresenceFresh(info.heartbeatAt))
    .map(([, info]) => info.name || 'Someone');

  if (others.length === 0) {
    bannerEl.classList.add('hidden');
    bannerEl.textContent = '';
    return;
  }
  bannerEl.classList.remove('hidden');
  bannerEl.textContent = others.length === 1
    ? `${others[0]} is also in this entry right now.`
    : `${others.join(', ')} are also in this entry right now.`;
}
