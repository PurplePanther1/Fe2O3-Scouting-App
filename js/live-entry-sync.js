// ====== Shared live-collaboration engine for pit/match scouting entries ======
// Used by pit-scout.js (always) and match-scout.js (only for entries opened
// from the match-based/schedule view — the team-based view keeps its own
// batch-save model, see match-scout.js for why).
//
// Presence lives as a MAP FIELD on the entry document itself
// (activeEditors: { [uid]: { name, heartbeatAt, focusedField } }), not a
// separate subcollection. That's required, not a style choice:
// Firestore security rules can get()/exists() a specific document path but
// cannot query or enumerate a collection, so "is anyone else currently
// present" is only enforceable server-side if it's a field on the very
// document being written. It also means every join/leave/commit/cancel is
// just an ordinary read-modify-write transaction on one document, which
// Firestore already serializes — no separate coordination needed to avoid a
// race between two people acting at once.
//
// heartbeatAt staleness (LIVE_PRESENCE_STALE_MS) is a CLIENT-SIDE display
// filter only, not a server-enforced TTL — a crashed tab's entry lingers in
// the map until someone's next write opportunistically prunes it. That's an
// accepted, deliberately benign failure mode: an unpruned stale entry only
// keeps the document in the MORE permissive "someone's already in here, any
// team member may join" state — it can never lock anyone out, only stay
// collaborative longer than strictly necessary.
//
// OWNERSHIP/CHECKPOINT MODEL (redesigned from an earlier "last to leave"
// model, which is gone entirely):
//  - scoutedBy/scoutedByName ("created by") is set exactly once, at the
//    entry's FIRST successful commit, and never changes again for the life
//    of the document — see commit() below and firestore.rules'
//    isValidScoutedByWrite().
//  - checkpoint is a snapshot of every configured field's value as of the
//    most recent commit, stored separately from the live field values
//    (which keep updating on every keystroke via writeField/scheduleWrite,
//    independent of checkpoints). Every commit overwrites checkpoint with
//    the current live values.
//  - lastEditedBy/lastEditedByName/lastEditedByTimestamp update on a commit
//    ONLY if that commit's checkpoint differs from the immediately prior
//    one, field-by-field. The very first commit never sets it (no prior
//    checkpoint exists to differ from) — it stays unset until some later,
//    genuinely different commit happens.
//  - Cancel is LAST-EDITOR-TRIGGERED, not per-user (redesigned again from an
//    earlier per-user/per-field "touchedFields" undo, which is gone
//    entirely — see cancelUndo() below for why it turned out to be
//    unnecessary): if OTHER active editors remain after this uid leaves,
//    nothing is reverted at all — this uid's own edits (and everyone
//    else's) stay exactly as they are, live on the document, for whoever
//    commits next (or cancels next) to inherit. Only when this uid is the
//    LAST active editor does cancelling revert anything, and when it does,
//    it reverts EVERY configured field that differs from the latest
//    checkpoint (not just fields this uid personally touched) — because at
//    that point there's nobody left to hand the document's uncommitted,
//    abandoned state off to. With no checkpoint at all (never committed),
//    every field reverts to empty, same net effect as today.

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

// ====== Names of every currently-fresh (non-stale) active editor, of ANY
// uid including the viewer's own. Unlike applyPresenceIndicators()/
// renderPresenceBanner() below (which are always scoped to "everyone but
// the person with THIS form open"), there's no current viewer to exclude
// here — used by the team list's independent "someone is editing this right
// now" marker (pit-scout.js/match-scout.js's watch*ScoutStatus), which
// reports on ANY editor with it open, and (CATEGORY 4) shows who by name,
// not just that someone is. Order is whatever Object.values() gives — not
// sorted, not meaningful beyond "who's currently in there." ======
function freshActiveEditorNames(activeEditors) {
  return Object.values(activeEditors || {})
    .filter((info) => info && isPresenceFresh(info.heartbeatAt))
    .map((info) => info.name || 'Someone');
}

// ====== Does this entry currently have at least one fresh active editor at
// all? Thin wrapper over freshActiveEditorNames() for call sites that only
// need the boolean, not the names. ======
function hasFreshActiveEditors(activeEditors) {
  return freshActiveEditorNames(activeEditors).length > 0;
}

// ====== Has this entry ever actually been committed (Done clicked at least
// once)? checkpoint is the primary signal — only commit() ever writes it
// (see below). scoutedBy is a FALLBACK for entries scouted before the
// checkpoint field existed at all: the old (pre-redesign) model wrote
// scoutedBy at first save with no checkpoint concept, so those are real,
// already-saved entries that must be treated as committed here too, not as
// an open draft (CATEGORY 1 — discovered when legacy entries were showing
// as unscouted, and non-privileged users got a confusing Permission Denied
// opening one, since the entry secretly already had an owner despite
// looking like a never-touched draft to the rest of the UI). Shared by
// pit-scout.js's pitEntryIsCommitted()/match-scout.js's
// matchEntryIsCommitted(), classifyLiveEntryAccess() below, and
// cancelUndo()'s own defensive check (a legacy entry with no checkpoint
// must never have its fields nulled out by a last-editor cancel — there's
// no snapshot to revert to, so cancelUndo() skips reverting it entirely
// rather than destroying real historical data). ======
function isEntryCommitted(data) {
  return !!(data && (data.checkpoint || data.scoutedBy));
}

// ====== Decide whether opening an entry is allowed at all, given its
// current data (or null for a brand-new entry) and a canEditFn (pass
// canUserEditOtherEntries, auth.js) that mirrors firestore.rules'
// canEditOrDeleteEntry client-side. Mirrors firestore.rules'
// canJoinOrEditEntry() exactly — see that function's own comment for the
// CATEGORY 3 reasoning:
// - A never-committed draft (isEntryCommitted false): open co-editing
//   applies — blocked only if there are zero active editors AND this user
//   doesn't independently qualify.
// - An already-committed entry (isEntryCommitted true — checkpoint, or the
//   legacy scoutedBy-only fallback, see isEntryCommitted()): active editors
//   no longer matter at all. Blocked unless this user independently
//   qualifies (owner/captain/canEditOtherEntries), regardless of who else
//   is currently in there. ======
function classifyLiveEntryAccess(existingData, canEditFn) {
  const activeEditors = (existingData && existingData.activeEditors) || {};
  const hasActiveEditors = Object.keys(activeEditors).length > 0;
  const qualifies = !existingData || canEditFn(existingData);
  const committed = isEntryCommitted(existingData);
  const blocked = committed ? !qualifies : (!hasActiveEditors && !qualifies);
  return { blocked };
}

// ====== Create a live session bound to one entry document. Attaches the
// doc listener immediately; join() is called by the caller right after
// construction for every non-blocked open (see classifyLiveEntryAccess) —
// there's no passive/view-only mode, opening an entry always means joining
// it. onSnapshotData(data|null) is called on every snapshot (data is null if
// the doc doesn't exist yet, e.g. between construction and the first join()
// write completing).
//
// canEditFn (pass canUserEditOtherEntries, auth.js — same function
// classifyLiveEntryAccess used at open time) and onLostEditAccess are both
// optional, but needed together for CATEGORY 3's mid-session handling: a
// non-privileged co-editor who joined a still-uncommitted draft can find
// the entry committed by someone ELSE while they're still actively in it —
// closing the "someone's already active" door behind them (see
// firestore.rules' canJoinOrEditEntry()). Every further write this session
// would attempt (heartbeat, field writes, its own eventual leave) would now
// be denied. Reads stay open regardless (the read rule only requires team
// membership) — so rather than waiting for a write to silently fail, the
// snapshot handler itself watches for this exact transition (joined, entry
// just became committed, canEditFn now says no) and forces a clean
// disconnect: stop heartbeating, discard any unsent debounced edits (they
// could never land now anyway), AWAIT removing just this uid from
// activeEditors (see removeSelfFromActiveEditors() — permitted even now via
// firestore.rules' isValidSelfLeaveOnly() carve-out), then detach and call
// onLostEditAccess() so the caller can show a clear notice and close its
// modal — mirroring how a kicked team member is already handled elsewhere
// (handleRemovedFromTeam(), auth.js), rather than a confusing raw
// permission-denied error the next time they happen to type.
//
// The AWAIT matters for more than this session's own bookkeeping: a team
// list watching this same entry (pit-scout.js's watchPitScoutStatus/
// match-scout.js's watchMatchScoutStatus) has its own, completely
// independent onSnapshot subscription, and only updates its "Editing"
// badge once IT receives a snapshot reflecting the removal. commit()/
// cancelUndo() already fully await their own self-leave write before their
// callers close the modal (commitAndLeave/cancelAndLeave), so by the time
// those exit paths' UI visibly changes, the write has already landed and
// any other listener can already see it. This path used to fire
// onLostEditAccess() immediately, with the self-leave write still only
// just-sent — confirmed via the emulator (a ~280ms gap between the notify
// callback firing and a second, independent listener on the same doc
// observing the removal) to be a genuine bug, not network latency alone:
// every OTHER exit path closes that same gap by waiting, this one didn't.
// handlingLostAccess guards against a second snapshot arriving mid-await
// (joined is already false by then, but the listener is still attached
// until detach() runs) from re-entering this branch or falling through to
// onSnapshotData() on a session that's already mid-teardown. ======
function createLiveEntrySession({ docRef, uid, displayName, onSnapshotData, canEditFn, onLostEditAccess }) {
  let detached = false;
  let joined = false;
  let handlingLostAccess = false;
  let heartbeatTimer = null;
  const debounceTimers = {};
  const pendingValues = {};

  async function removeSelfFromActiveEditors() {
    try {
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(docRef);
        if (!snap.exists) return;
        const data = snap.data();
        if (!data.activeEditors || !(uid in data.activeEditors)) return;
        const editors = { ...data.activeEditors };
        delete editors[uid];
        tx.update(docRef, { activeEditors: editors });
      });
    } catch (err) {
      console.warn('Removing self from activeEditors failed (presence will self-clear once stale):', err);
    }
  }

  const unsubscribe = docRef.onSnapshot(async (snap) => {
    if (detached || handlingLostAccess) return;
    const data = snap.exists ? snap.data() : null;

    if (joined && data && typeof canEditFn === 'function'
      && isEntryCommitted(data) && !canEditFn(data)) {
      handlingLostAccess = true;
      joined = false;
      stopHeartbeat();
      discardPendingWrites();
      await removeSelfFromActiveEditors();
      detach();
      if (typeof onLostEditAccess === 'function') onLostEditAccess();
      return;
    }

    onSnapshotData(data);
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
  // baseFieldsIfNew — identity/metadata fields ONLY; callers must NOT
  // include scoutedBy/scoutedByName/scoutedAt here anymore, since those are
  // now set exclusively by commit() on the entry's first Done, never at
  // doc-creation time) if this is the first editor ever; otherwise just adds
  // this uid to the existing activeEditors map. Always a transaction — its
  // validity depends on the rest of the map, which a plain read-then-write
  // could race on. ======
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

  // ====== Remove this uid from activeEditors. No ownership decision here at
  // all anymore — scoutedBy/lastEditedBy are entirely commit()'s
  // responsibility now, independent of who leaves or when. Delegates to
  // removeSelfFromActiveEditors() (defined above, shared with the forced-
  // disconnect path) — best-effort: if it fails (e.g. offline), the
  // presence entry just lingers until it goes stale — see file header. ======
  async function leaveActiveEditors() {
    if (!joined) return;
    joined = false;
    stopHeartbeat();
    await removeSelfFromActiveEditors();
  }

  // ====== Commit (Done). `fields` is the field CONFIG list for this entry's
  // form — needed to know exactly which keys make up the checkpoint (can't
  // just snapshot the whole doc, which also has activeEditors/scoutedBy/etc).
  // Reads the doc's CURRENT server-side values within this same transaction
  // (not from any locally-cached copy) so the checkpoint can never reflect a
  // debounced write that hasn't landed yet — callers must still await
  // flushAll() before calling this, but this is defense in depth against
  // that ordering ever slipping.
  //  - First-ever commit (scoutedBy not yet set): sets scoutedBy/
  //    scoutedByName/scoutedAt to this uid. Does NOT touch lastEditedBy —
  //    there's no prior checkpoint to have differed from.
  //  - Every later commit: compares the new checkpoint to the prior one
  //    field-by-field. Only if something actually differs does lastEditedBy
  //    become this uid; if nothing differs, lastEditedBy is left completely
  //    untouched (not reset, not reassigned to the committer).
  //  - Never touches activeEditors — that's leaveActiveEditors()'s job
  //    (always called right after, via commitAndLeave). There's no
  //    per-editor undo state left to reset here now that cancelUndo() is
  //    last-editor-triggered rather than per-user (see file header). ======
  async function commit(fields) {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(docRef);
      const data = snap.exists ? snap.data() : {};
      const priorCheckpoint = data.checkpoint || null;
      const newCheckpoint = {};
      fields.forEach((f) => { newCheckpoint[f.id] = (data[f.id] != null) ? data[f.id] : null; });

      const update = { checkpoint: newCheckpoint };

      if (data.scoutedBy == null) {
        update.scoutedBy = uid;
        update.scoutedByName = displayName;
        update.scoutedAt = data.scoutedAt || firebase.firestore.FieldValue.serverTimestamp();
      } else if (priorCheckpoint) {
        const changed = fields.some((f) => (newCheckpoint[f.id] ?? null) !== (priorCheckpoint[f.id] ?? null));
        if (changed) {
          update.lastEditedBy = uid;
          update.lastEditedByName = displayName;
          update.lastEditedByTimestamp = Date.now();
        }
      }

      tx.set(docRef, update, { merge: true });
    });
  }

  // ====== Cancel (X / overlay / Cancel — all identical, see
  // pit-scout.js/match-scout.js's single shared handler for each).
  // LAST-EDITOR-TRIGGERED, not per-user (redesigned from an earlier
  // per-user/per-field "touchedFields" undo — see file header for why):
  //  - If OTHER active editors remain (checked fresh, within this same
  //    transaction, against the server's current activeEditors — not a
  //    client-remembered list) once this uid is removed: nothing is
  //    reverted. This uid's own edits — and everyone else's — stay exactly
  //    as they are, live on the document, for whoever commits or cancels
  //    next to inherit. There's no more "this uid's own fields" concept to
  //    revert; every field write is already just ordinary shared document
  //    state, same as it is for every OTHER active editor's edits.
  //  - If this uid IS the last active editor, cancelling reverts EVERY
  //    configured field (fields param — the field CONFIG list, same as
  //    commit() needs) that currently differs from the latest checkpoint
  //    back to that checkpoint's value. This is deliberately entry-wide, not
  //    scoped to this uid: it's what correctly cleans up an earlier editor's
  //    own cancel-while-others-remained (the bullet above), which leaves
  //    edits live and unclaimed rather than reverting them immediately —
  //    when the very last person walks away without a Done, ALL of that
  //    abandoned, never-committed work reverts together, not just this
  //    uid's share of it. If no checkpoint exists at all (nobody has ever
  //    committed this entry), every field reverts to null — the doc just
  //    sits as an empty shell exactly like any other never-scouted entry
  //    (see pitEntryIsCommitted()/matchEntryIsCommitted() in
  //    pit-scout.js/match-scout.js) — no special cleanup needed.
  //  - CATEGORY 1 exception: a LEGACY entry (scoutedBy set, but no
  //    checkpoint — see isEntryCommitted()'s own comment) is committed,
  //    real, already-saved data, NOT an abandoned draft — but there's no
  //    checkpoint snapshot to revert to. Reverting every field to null here
  //    would silently DESTROY that real data. Since there's no safe diff to
  //    compute, this case skips the revert entirely and leaves every field
  //    exactly as it is — same as the "other active editors remain" branch
  //    above, just for a different reason. (Recommend backfilling a real
  //    checkpoint onto these entries so this branch stops being hit for
  //    them — investigated but not done automatically, see CATEGORY 1 in
  //    the round's report.) ======
  async function cancelUndo(fields) {
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

        const isLegacyCommittedNoCheckpoint = !data.checkpoint && !!data.scoutedBy;
        if (Object.keys(editors).length === 0 && !isLegacyCommittedNoCheckpoint) {
          const checkpoint = data.checkpoint || null; // null here means genuinely never-committed -- revert to empty
          (fields || []).forEach((f) => {
            const checkpointVal = (checkpoint && Object.prototype.hasOwnProperty.call(checkpoint, f.id))
              ? checkpoint[f.id] : null;
            const liveVal = (data[f.id] !== undefined) ? data[f.id] : null;
            if ((liveVal ?? null) !== (checkpointVal ?? null)) {
              update[f.id] = checkpointVal;
            }
          });
        }
        // else: either other active editors remain, or this IS the last
        // editor but it's a legacy committed entry with no checkpoint to
        // revert to (isLegacyCommittedNoCheckpoint) — see the CATEGORY 1
        // doc comment above. Leave every field exactly as it is; only
        // activeEditors changes.

        tx.update(docRef, update);
      });
    } catch (err) {
      console.warn('Cancelling live entry session failed (presence will self-clear once stale):', err);
    }
  }

  // ====== Discard any pending debounced writes WITHOUT sending them — used
  // before cancelUndo(), so a write still sitting in a debounce timer can
  // never land after the revert and silently resurrect the very edit being
  // cancelled. ======
  function discardPendingWrites() {
    Object.keys(debounceTimers).forEach((fieldId) => { clearTimeout(debounceTimers[fieldId]); delete debounceTimers[fieldId]; });
    Object.keys(pendingValues).forEach((fieldId) => delete pendingValues[fieldId]);
  }

  // ====== The two real exit paths — every caller should use one of these
  // rather than calling join/commit/cancelUndo/leaveActiveEditors/detach
  // individually. ======
  async function commitAndLeave(fields) {
    await commit(fields);
    await leaveActiveEditors();
    detach();
  }
  async function cancelAndLeave(fields) {
    discardPendingWrites();
    await cancelUndo(fields);
    detach();
  }

  // ====== Write one field's value now. No attribution here anymore —
  // lastEditedBy is entirely commit()'s responsibility (see the checkpoint
  // comparison above), not stamped on every keystroke the way it used to
  // be. No per-uid "touched" tracking either anymore — cancelUndo() no
  // longer needs it (see file header for the redesign). Returns the write's
  // promise so callers that need the write to have actually landed
  // (flushAll, for commitAndLeave's sake) can await it. Uses .update()
  // rather than .set(payload, {merge:true}) — the doc's existence is
  // guaranteed here (writeField() only ever runs while joined is true,
  // which only becomes true after join()'s own transaction, which always
  // creates the doc if missing, resolves), and .update() is what a prior
  // round's real bug (found via emulator reproduction) turned out to need
  // for a computed dotted-path key elsewhere in this file — kept here too
  // for consistency even though this particular payload no longer has one. ======
  function writeField(fieldId, value) {
    if (!joined) return Promise.resolve();
    const payload = {
      [fieldId]: value,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    };
    return docRef.update(payload).catch((err) => console.warn('Field write failed:', err));
  }

  // ====== Debounced version of writeField, for text/number/textarea/counter
  // fields firing on every keystroke. Dropdown-style discrete selections
  // should call writeField directly instead (see wireLiveFormFields). ======
  function scheduleWrite(fieldId, value) {
    if (!joined) return;
    pendingValues[fieldId] = value;
    if (debounceTimers[fieldId]) clearTimeout(debounceTimers[fieldId]);
    debounceTimers[fieldId] = setTimeout(() => { flushField(fieldId); }, LIVE_FIELD_DEBOUNCE_MS);
  }
  function flushField(fieldId) {
    if (debounceTimers[fieldId]) { clearTimeout(debounceTimers[fieldId]); delete debounceTimers[fieldId]; }
    if (fieldId in pendingValues) {
      const v = pendingValues[fieldId];
      delete pendingValues[fieldId];
      return writeField(fieldId, v);
    }
    return Promise.resolve();
  }
  // Resolves once every currently-pending debounced write has actually
  // landed. Callers that need the server caught up before proceeding
  // (commitAndLeave, so the checkpoint it reads reflects what was just
  // typed rather than a stale pre-flush value) must AWAIT this — it used to
  // be fire-and-forget, which was a real race: the old commit path could run
  // before a just-flushed write had actually reached the server.
  async function flushAll() {
    const fieldIds = Object.keys(debounceTimers);
    await Promise.all(fieldIds.map((fieldId) => flushField(fieldId)));
  }

  // ====== Field-level presence: which field (if any) this uid currently has
  // focus in, shown to everyone else as a lightweight indicator rather than
  // any kind of write lock — see applyPresenceIndicators() below. ======
  function setFocusedField(fieldId) {
    if (!joined) return;
    docRef.update({ [`activeEditors.${uid}.focusedField`]: fieldId || null })
      .catch((err) => console.warn('Focus presence update failed:', err));
  }

  // ====== Does fieldId currently have an unflushed local write sitting in
  // its debounce timer? Used by applyRemoteFieldValues() to skip applying an
  // incoming remote snapshot to a field the user just typed into but hasn't
  // blurred/settled long enough to flush yet — without this, a remote
  // snapshot arriving in that window (e.g. from another editor's heartbeat)
  // would visibly flash the field back to its pre-edit value until the
  // debounced write catches up and self-corrects. ======
  function hasPendingWrite(fieldId) {
    return fieldId in pendingValues;
  }

  // Unsubscribe/stop-heartbeat/clear-any-remaining-timers only — does NOT
  // touch activeEditors, scoutedBy, or anything else on its own; that's
  // always commitAndLeave's/cancelAndLeave's job. Always go through one of
  // those two composites rather than calling detach() directly while still
  // joined.
  function detach() {
    if (detached) return;
    detached = true;
    unsubscribe();
    Object.keys(debounceTimers).forEach((fieldId) => clearTimeout(debounceTimers[fieldId]));
  }

  return {
    join, writeField, scheduleWrite, flushAll, setFocusedField, hasPendingWrite,
    commitAndLeave, cancelAndLeave, detach,
    isJoined: () => joined
  };
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

// ====== Apply remote field values to the form. Last-write-wins on the
// value itself is the accepted model here (no per-field lock); the
// field-level presence indicator, not a value lock, is what's meant to
// prevent collisions in practice, the same way a spreadsheet shows a
// colored cell-selection rather than merging keystrokes. Two things are
// skipped, both intentionally:
//  - a field with an unflushed local write pending (session.hasPendingWrite)
//    — applying a stale remote value here would visibly flash the field
//    back to its pre-edit value until the local debounced write catches up
//    and self-corrects a moment later (bug fix — see hasPendingWrite above).
//  - a field whose displayed value already matches the incoming one, so a
//    heartbeat-only snapshot (no real field change) never touches the DOM. ======
function applyRemoteFieldValues(formController, fields, data, session) {
  if (!data) return;
  fields.forEach((field) => {
    if (session && session.hasPendingWrite(field.id)) return;
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
// (classList 'hidden') and cleared when there's nothing to say — nobody
// else is actively present AND the entry already has a checkpoint (a real,
// committed entry, not a draft). hasCheckpoint (pass !!data?.checkpoint from
// the caller's snapshot data) adds a draft notice, shown alongside a
// presence line if there is one, or alone if there isn't — so a second
// person joining a not-yet-committed entry immediately understands it's
// still a draft, not an already-real entry someone's merely editing, and a
// SOLO opener of a brand-new entry gets the same information rather than
// just an empty banner. ======
function renderPresenceBanner(bannerEl, activeEditors, selfUid, hasCheckpoint) {
  if (!bannerEl) return;
  const others = Object.entries(activeEditors || {})
    .filter(([otherUid, info]) => otherUid !== selfUid && info && isPresenceFresh(info.heartbeatAt))
    .map(([, info]) => info.name || 'Someone');

  let text = '';
  if (others.length === 1) {
    text = `${others[0]} is also in this entry right now.`;
  } else if (others.length > 1) {
    text = `${others.join(', ')} are also in this entry right now.`;
  }
  if (!hasCheckpoint) {
    text = text ? `${text} Nobody has saved this entry yet.` : 'Nobody has saved this entry yet.';
  }

  if (!text) {
    bannerEl.classList.add('hidden');
    bannerEl.textContent = '';
    return;
  }
  bannerEl.classList.remove('hidden');
  bannerEl.textContent = text;
}
