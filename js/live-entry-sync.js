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
// canJoinOrEditEntry() exactly:
// - A never-committed draft (isEntryCommitted false): always joinable by
//   any team member, regardless of whether anyone else is currently active
//   in it — there's no real data to protect yet.
// - An already-committed entry (isEntryCommitted true — checkpoint, or the
//   legacy scoutedBy-only fallback, see isEntryCommitted()): blocked unless
//   this user independently qualifies (owner/captain/canEditOtherEntries).
//
// Bug fix: this used to also require at least one active editor already
// present before a non-privileged user could join an uncommitted draft
// (`!hasActiveEditors && !qualifies` below). That meant the SOLE editor of a
// brand-new draft leaving via Cancel — which must remove them from
// activeEditors as part of leaving, see leaveActiveEditors()/cancelUndo()
// below — closed the door behind them: the doc now existed (so the next open
// no longer got the `!existingData` free pass) but had zero active editors,
// so a non-privileged team member could never reopen it again even though
// nothing had ever been committed. Reported as a "Permission Denied" modal
// on a team whose scouted-checkmark was never showing. See firestore.rules'
// canJoinOrEditEntry() for the server-side half of this same fix. ======
function classifyLiveEntryAccess(existingData, canEditFn) {
  const qualifies = !existingData || canEditFn(existingData);
  const committed = isEntryCommitted(existingData);
  const blocked = committed && !qualifies;
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
// could never land now anyway), detach, and call onLostEditAccess()
// IMMEDIATELY so the caller can show a clear notice, close its modal, and —
// critically — optimistically clear this uid's OWN entry out of its local
// "who's editing" cache right away (see pit-scout.js's
// closePitScoutFormUI()/match-scout.js's closeMatchScoutFormUI(), both
// already called from onLostEditAccess/onEntryDeleted) — mirroring how a
// kicked team member is already handled elsewhere (handleRemovedFromTeam(),
// auth.js), rather than a confusing raw permission-denied error the next
// time they happen to type.
//
// removeSelfFromActiveEditors() (below) is fired here too, but
// deliberately NOT awaited before the callback runs — it used to be, on the
// theory that a team list watching this same entry (pit-scout.js's
// watchPitScoutStatus/match-scout.js's watchMatchScoutStatus) only updates
// its "Editing" badge once ITS OWN independent onSnapshot subscription
// receives a snapshot reflecting the removal, so the write had to land
// before the callback closed the modal. That reasoning no longer holds now
// that the callback's own closePitScoutFormUI()/closeMatchScoutFormUI()
// patches the SAME local cache that badge reads from, synchronously, the
// instant the callback runs — the real snapshot still arrives shortly after
// and reconciles either way, exactly like every other exit path's
// optimistic clear. Awaiting first was actively harmful here specifically:
// this branch only ever fires because canEditFn just turned false, which
// means the very write being awaited (a self-leave) is itself at risk of
// being denied for the same reason (e.g. a captain both revoking edit
// access AND removing the uid from the team in quick succession) — blocking
// the user's own UI on a write that may never succeed is exactly the
// "lingers before clearing" bug this was reported as. handlingLostAccess
// still guards against a second snapshot arriving before detach() has
// actually unsubscribed the listener, from re-entering this branch or
// falling through to onSnapshotData() on a session that's already
// mid-teardown. ======
// ====== Delete an entry doc, first writing a deletionNotice marker so a
// still-joined live session on this same doc (see createLiveEntrySession's
// onSnapshot handler below) can detect the deletion and show who did it,
// rather than the doc simply vanishing out from under an active editor.
// Firestore delivers a document's own committed versions to an active
// listener in order, so a joined session almost always observes this update
// (data.deletionNotice set) before the follow-up delete's !exists snapshot —
// but if it doesn't (e.g. a reconnect that jumps straight to the final
// state), the onSnapshot handler's own !data fallback still disconnects that
// session cleanly, just without a name. Best-effort: if the marker write
// fails for any reason (already deleted, offline, ...), proceed straight to
// the real delete anyway — it's an enhancement for whoever's currently
// joined, never a precondition for deleting.
//
// deleterUid (bug fix): recorded alongside deletedByName so a session that's
// STILL joined on the very entry it just deleted itself — e.g. the in-form
// Delete button, or Team Detail's standalone delete button firing while that
// same entry happens to be open live elsewhere under the same account — can
// tell "I did this" apart from a genuine other-editor deletion. Every call
// site already has the deleting uid on hand (currentUser.uid), so this is
// always populated for any delete going through this app's own UI. ======
async function deleteEntryWithNotice(docRef, deleterName, deleterUid) {
  try {
    await docRef.update({
      deletionNotice: {
        deletedByName: deleterName || 'another editor',
        deletedByUid: deleterUid || null,
        deletedAt: firebase.firestore.FieldValue.serverTimestamp()
      }
    });
  } catch (err) {
    console.warn('Writing deletion notice failed (proceeding to delete anyway):', err);
  }
  await docRef.delete();
}

// ====== Array-safe value equality. A button-group multi-select field's
// value is an array, and a plain !== always treats two different array
// instances as unequal even when their contents are identical (e.g. the same
// stored array read back out of two separate Firestore snapshots) — so
// commit()'s "did anything actually change since the last checkpoint" check
// and cancelUndo()'s "does this field differ from its checkpoint" check both
// need this instead of a raw !==, or they'd treat every array-valued field as
// having "changed" on every single commit/cancel, even when nothing did
// (confirmed bug: this round's audit of every checkpoint-diffing site for
// array safety, prompted by match scouting's new multi-select
// rankingPointsEarned field). ======
function valuesEqual(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) {
    const arrA = Array.isArray(a) ? a : (a == null ? [] : [a]);
    const arrB = Array.isArray(b) ? b : (b == null ? [] : [b]);
    if (arrA.length !== arrB.length) return false;
    return arrA.every((v, i) => v === arrB[i]);
  }
  return a === b;
}

function createLiveEntrySession({ docRef, uid, displayName, onSnapshotData, canEditFn, onLostEditAccess, onEntryDeleted }) {
  let detached = false;
  let joined = false;
  let handlingLostAccess = false;
  let heartbeatTimer = null;
  const debounceTimers = {};
  const pendingValues = {};
  // Bug fix, round 2: a prior fix here (sawDocExist, now folded into
  // attachListener()'s own comment below) patched the SYMPTOM by gating the
  // `!data` fallback on having observed the doc exist first. That still
  // wasn't reliable, because the underlying ordering problem was untouched:
  // the listener was attached at construction time, BEFORE join() had ever
  // run, so it could receive a "doesn't exist yet" snapshot, and THAT
  // snapshot's delivery relative to join()'s transaction resolving was never
  // actually guaranteed — a transaction is a full server round-trip outside
  // the SDK's normal optimistic-local-write pipeline, so there's no
  // ordering guarantee between "the transaction resolved" and "this
  // separate onSnapshot listener has delivered its corresponding snapshot."
  // Sometimes the stale snapshot lost the race and arrived after `joined`
  // was already true, which looked identical to a real deletion.
  //
  // The actual fix: attachListener() (below) is now called from join()
  // itself, AFTER its transaction has already resolved — never at
  // construction time. By the time this listener exists at all, the doc is
  // already guaranteed to exist on the server, so its very first snapshot
  // can never be a false "doesn't exist" for a brand-new entry — there's no
  // race left to lose. sawDocExist is set unconditionally the moment join()
  // resolves (not just from an observed snapshot) as an extra guarantee,
  // and kept as the `!data` fallback's gate purely as defense in depth for
  // the same reason a NASA launch still carries a manual abort switch nobody
  // expects to need.
  let sawDocExist = false;
  let unsubscribe = null;

  // Bug fix (real root cause of the kicked-from-team disconnect never
  // clearing, confirmed against the actual firestore.rules via the Firestore
  // emulator — not just by re-reading the rule): this used to be a
  // db.runTransaction() that read the doc first (tx.get()), computed the map
  // minus this uid, then wrote it back. That read is subject to the READ
  // rule, which requires isTeamMember(teamId) with NO self-leave carve-out —
  // isValidSelfLeaveOnly() only ever applies to the WRITE rule. So once this
  // uid is no longer a team member (kicked), the transaction's own tx.get()
  // was denied and the whole transaction threw before the write was ever
  // even evaluated — completely independent of whether the write itself
  // would have been permitted. A plain targeted update on the specific
  // "activeEditors.{uid}" field path, using FieldValue.delete(), needs no
  // read at all: the client never has to know the map's current contents,
  // Firestore applies the delete server-side, and the WRITE rule (which
  // isValidSelfLeaveOnly() DOES cover regardless of team membership) is the
  // only thing evaluated. Confirmed via the emulator: this succeeds and
  // correctly preserves every OTHER uid's own activeEditors entry, both
  // while still a team member and after being kicked. ======
  async function removeSelfFromActiveEditors() {
    console.log(`[live-entry-sync] removeSelfFromActiveEditors: attempting for uid=${uid} on ${docRef.path}`);
    try {
      await docRef.update({ [`activeEditors.${uid}`]: firebase.firestore.FieldValue.delete() });
      console.log(`[live-entry-sync] removeSelfFromActiveEditors: SUCCEEDED for uid=${uid} on ${docRef.path}`);
    } catch (err) {
      console.warn(`[live-entry-sync] removeSelfFromActiveEditors: FAILED for uid=${uid} on ${docRef.path} - code=${err.code}`, err);
    }
  }

  // ====== Attach the snapshot listener — called only from join(), after its
  // transaction has already confirmed the doc exists (see the file's own
  // comment above for why this ordering is what actually closes the race).
  // No-ops if already attached, or if this session was torn down (detach()
  // already called) before join() got this far — e.g. the "defensive
  // re-entrancy guard" in openPitScoutForm/openMatchScoutForm firing a
  // fire-and-forget cancelAndLeave() on a session whose own join() hadn't
  // resolved yet. ======
  function attachListener() {
    if (unsubscribe || detached) return;
    unsubscribe = docRef.onSnapshot(async (snap) => {
      if (detached || handlingLostAccess) return;
      const data = snap.exists ? snap.data() : null;
      if (snap.exists) sawDocExist = true;
      console.log(`[live-entry-sync] attachListener: snapshot for uid=${uid} on ${docRef.path} - exists=${snap.exists} fromCache=${snap.metadata.fromCache} activeEditors=${data ? JSON.stringify(Object.keys(data.activeEditors || {})) : 'n/a'}`);

      // Bug fix (serious regression — delete-then-immediately-recreate at the
      // same deterministic doc ID showed a false "Entry Deleted"): join()'s
      // transaction is a direct server round-trip and never touches the
      // SDK's local cache — but THIS listener, attached right after that
      // transaction resolves, can still have its very first snapshot served
      // straight from the local cache, which is a separate store that
      // catches up to the transaction's result asynchronously. Deleting an
      // entry and immediately re-scouting the same team/match reuses the
      // exact same doc ID — for a brief window, the cache can still say
      // "doesn't exist" (the just-prior delete) even though a brand-new
      // transaction has already confirmed, directly against the server, that
      // the doc exists again. Both deletion signals below used to trust that
      // stale cached read exactly as much as a real server-confirmed one, so
      // it was indistinguishable from a genuine deletion. Gating both on
      // snap.metadata.fromCache === false closes this: a cache-only "gone"
      // reading is simply ignored, and the very next (server-confirmed)
      // snapshot corrects it — for an ALREADY-active listener that isn't a
      // meaningful delay, since fromCache is really only ever true for a
      // listener's first delivery or while genuinely offline. Deliberately
      // NOT applied to onSnapshotData() below — that path needs the instant,
      // optimistic cache echo for a responsive typing/presence experience;
      // only "is this doc actually deleted" needs to wait for the server's
      // word rather than the cache's guess.
      const serverConfirmed = !snap.metadata.fromCache;

      if (joined && data && typeof canEditFn === 'function'
        && isEntryCommitted(data) && !canEditFn(data)) {
        console.log(`[live-entry-sync] attachListener: LOST EDIT ACCESS branch fired for uid=${uid} on ${docRef.path} (entry committed by someone else)`);
        handlingLostAccess = true;
        joined = false;
        stopHeartbeat();
        discardPendingWrites();
        detach();
        if (typeof onLostEditAccess === 'function') onLostEditAccess();
        // Fire-and-forget: see the comment above this function's signature
        // for why this is no longer awaited before the callback runs.
        removeSelfFromActiveEditors();
        return;
      }

      // Deleted while joined — see deleteEntryWithNotice() above (the write
      // side of this). join()'s transaction always creates the doc if
      // missing, so `joined` can only be true once it genuinely exists;
      // either signal below, once server-confirmed (see serverConfirmed
      // above), is therefore unambiguous evidence of a real deletion.
      //
      // Bug fix: deleting your OWN currently-open entry (the in-form Delete
      // button, or a standalone delete button elsewhere acting on the same
      // doc under the same account) used to hit this exact branch too —
      // `joined` is still true at that instant, since this session's own
      // listener observes its own write just like anyone else's. That showed
      // a confusing "deleted by another editor" notice for a delete the user
      // themselves just performed, stepping on the delete flow's own
      // "Data deleted." success message. deletedByUid (see
      // deleteEntryWithNotice() above) lets this session recognize itself and
      // just tear down quietly instead — the delete's own caller already owns
      // showing the outcome and closing the modal.
      if (joined && data && data.deletionNotice && serverConfirmed) {
        handlingLostAccess = true;
        joined = false;
        stopHeartbeat();
        discardPendingWrites();
        detach();
        const selfDeleted = !!data.deletionNotice.deletedByUid && data.deletionNotice.deletedByUid === uid;
        if (!selfDeleted && typeof onEntryDeleted === 'function') onEntryDeleted(data.deletionNotice.deletedByName || null);
        // Defense in depth, fire-and-forget (see this function's own comment
        // above for why this is no longer awaited before the callback runs)
        // — attempted even though "the doc's gone, there's nothing left to
        // remove it from" is usually true; harmless no-op when it is.
        removeSelfFromActiveEditors();
        return;
      }
      if (joined && !data && sawDocExist && serverConfirmed) {
        // Fallback: the deletionNotice update above was somehow never
        // observed before the doc's removal itself landed. No name
        // available, but still a clear disconnect beats every subsequent
        // write silently failing.
        //
        // Bug fix (defense in depth): removeSelfFromActiveEditors() is now
        // attempted here too, even though "the doc doesn't exist, there's
        // nothing to remove it from" was true whenever this branch's
        // detection was actually correct. It's a safe no-op against a
        // genuinely deleted doc (its own transaction just returns early on
        // !snap.exists) — but if this detection is EVER wrong again in some
        // future edge case neither of us has found yet, this is what stops
        // this uid's activeEditors entry from being permanently orphaned on
        // a document that, it turns out, is still very much alive — exactly
        // what left the "Editing: [name]" tag stuck after the false-positive
        // this round surfaced.
        handlingLostAccess = true;
        joined = false;
        stopHeartbeat();
        discardPendingWrites();
        detach();
        if (typeof onEntryDeleted === 'function') onEntryDeleted(null);
        // Fire-and-forget — see this function's own comment above for why
        // this is no longer awaited before the callback runs.
        removeSelfFromActiveEditors();
        return;
      }

      onSnapshotData(data);
    }, (err) => {
      // This is the signal for a KICKED-mid-session disconnect (see
      // forceClosePitLiveSessionForTeam()/forceCloseMatchLiveSessionForTeam(),
      // pit-scout.js/match-scout.js) — once this uid is off the team, the
      // READ rule (isTeamMember) stops passing, so instead of one more data
      // snapshot, this listener just errors out with permission-denied. Logged
      // here for visibility, but deliberately NOT handled here: this callback
      // has no reliable way to tell "kicked" apart from a transient network
      // blip, and handleRemovedFromTeam() (members.js) already reacts to the
      // real signal (its own watchMyTeams() listener on the TEAM doc, not
      // this one) faster and more reliably than trying to disambiguate here.
      console.warn(`[live-entry-sync] attachListener: listener ERROR for uid=${uid} on ${docRef.path} - code=${err.code}`, err);
    });
  }

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
    // This session may have been torn down (detach() already called, e.g.
    // by another open() interrupting this one before this transaction even
    // landed) while the above was in flight — don't resurrect a session
    // nothing is holding a reference to anymore: no heartbeat left running
    // forever, no listener attached.
    if (detached) return;
    // The transaction above just confirmed this doc exists on the server —
    // set unconditionally here (not only from an observed snapshot), since
    // attachListener() runs next and its very first snapshot should already
    // reflect that. See this file's own comment above attachListener() for
    // why this ordering (join always fully resolves before the listener
    // ever attaches) is what actually closes the false-deletion race.
    sawDocExist = true;
    joined = true;
    startHeartbeat();
    attachListener();
  }

  // ====== Remove this uid from activeEditors. No ownership decision here at
  // all anymore — scoutedBy/lastEditedBy are entirely commit()'s
  // responsibility now, independent of who leaves or when. Delegates to
  // removeSelfFromActiveEditors() (defined above, shared with the forced-
  // disconnect path) — best-effort: if it fails (e.g. offline), the
  // presence entry just lingers until it goes stale — see file header. ======
  async function leaveActiveEditors() {
    if (!joined) {
      console.log(`[live-entry-sync] leaveActiveEditors: no-op for uid=${uid} on ${docRef.path} (already not joined)`);
      return;
    }
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
        const changed = fields.some((f) => !valuesEqual(newCheckpoint[f.id] ?? null, priorCheckpoint[f.id] ?? null));
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
            // Bug fix (confirmed via two real corrupted docs found live,
            // right before kickoff — both matchNumber: null, no season, empty
            // activeEditors): matchNumber is the one config-list field that's
            // LOCKED/structural for a live match entry, not abandonable draft
            // data like every other field here — see match-scout.js's file
            // header, it's fixed by whichever schedule row was clicked and is
            // never even rendered into the live form, so there's no
            // "abandoned edit" to revert. Before this fix, cancelling out of
            // (or the re-entrancy guard silently abandoning) a brand-new,
            // never-committed live match entry reverted it to null just like
            // every other field, since a never-committed entry has no
            // checkpoint at all — permanently orphaning the document, since
            // findExistingMatchDoc()'s query can never match a null
            // matchNumber again. Pit entries have no field with this id, so
            // this exclusion is a no-op there.
            if (f.id === 'matchNumber') return;
            const checkpointVal = (checkpoint && Object.prototype.hasOwnProperty.call(checkpoint, f.id))
              ? checkpoint[f.id] : null;
            const liveVal = (data[f.id] !== undefined) ? data[f.id] : null;
            if (!valuesEqual(liveVal ?? null, checkpointVal ?? null)) {
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
  // ====== Bug fix: commit() failing (e.g. permission-denied because this
  // uid was removed from the team, or any other write rejection) used to
  // throw straight out of commitAndLeave() before leaveActiveEditors()/
  // detach() ever ran — leaving this uid's activeEditors entry stuck in the
  // doc forever (nothing else ever prunes another uid's stale entry — see
  // the file header), on top of the caller (commitPitScoutForm/
  // commitMatchScoutForm) having no try/catch of its own, so the failure was
  // completely silent to the user too. The try/finally below guarantees
  // self-removal is still attempted (isValidSelfLeaveOnly, firestore.rules,
  // permits a self-leave regardless of team membership, so this still
  // succeeds even for a just-kicked uid) and the session still detaches,
  // while the original error still propagates so the caller can show it. ======
  async function commitAndLeave(fields) {
    try {
      await commit(fields);
    } finally {
      await leaveActiveEditors();
      detach();
    }
  }
  // ====== Bug fix: detach() now runs BEFORE cancelUndo()'s revert
  // transaction, not after. This is the only exit path ever invoked
  // fire-and-forget rather than awaited — the re-entrancy guard in
  // openPitScoutForm/openMatchScoutForm/openMatchScoutEdit abandons a still-
  // open session exactly like this while immediately loading a brand-new
  // entry into the very same shared module-level form state. With detach()
  // last, this session's OWN listener stayed attached throughout its own
  // teardown transaction — so that transaction's write could echo straight
  // back into THIS callback, which reads whatever entry the caller has since
  // moved on to render (currentFormController/currentFields already
  // repointed at the newly-opened entry) and misapply the OLD entry's data
  // onto it — e.g. rendering "Nobody has saved this entry yet." onto a
  // genuinely-saved, unrelated batch-mode entry. Detaching first means this
  // session can never observe the echo of its own teardown write at all,
  // closing that window by construction rather than by timing luck.
  // cancelUndo()'s own correctness is unaffected — it reads fresh
  // server-side data in its own transaction, never anything from this
  // session's listener. ======
  async function cancelAndLeave(fields) {
    discardPendingWrites();
    detach();
    await cancelUndo(fields);
  }

  // ====== Forced disconnect with NO revert attempt at all — for when this
  // uid's own team membership may already be gone (kicked mid-session; see
  // pit-scout.js's/match-scout.js's forceClose*LiveSessionForTeam(), called
  // from handleRemovedFromTeam() in members.js).
  //
  // Bug fix history (two real, stacked bugs here, confirmed against the
  // actual firestore.rules via the Firestore emulator, not just by re-reading
  // the rule):
  //  1. This originally called cancelAndLeave() (above). cancelUndo() can
  //     revert EVERY configured field back to its checkpoint when this uid
  //     turns out to be the last active editor of an uncommitted draft — a
  //     write touching more than just activeEditors, which no longer
  //     qualifies under isValidSelfLeaveOnly(), and every OTHER branch of
  //     that OR-gated rule requires team membership. Confirmed denied for a
  //     kicked uid. Switched to this function (which only ever removes this
  //     uid from activeEditors, nothing else) to fix that.
  //  2. That alone STILL didn't fix it: leaveActiveEditors() ->
  //     removeSelfFromActiveEditors() (below) used to be a transaction that
  //     read the doc first — and that read is denied by the READ rule
  //     (isTeamMember, no self-leave carve-out) for a kicked uid, so the
  //     transaction failed before the write was ever evaluated, regardless
  //     of what write it would have attempted. removeSelfFromActiveEditors()
  //     itself is now a read-free targeted field delete — see its own
  //     comment for the fix and how it was verified. ======
  async function disconnectAndLeave() {
    console.log(`[live-entry-sync] disconnectAndLeave: called for uid=${uid} on ${docRef.path}`);
    discardPendingWrites();
    detach();
    await leaveActiveEditors();
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
    // unsubscribe can still be null here — detach() can now run before
    // join() ever resolves (the re-entrancy-guard scenario in
    // attachListener()'s own comment), in which case there's no listener to
    // tear down yet; join() checks `detached` itself before attaching one.
    if (unsubscribe) unsubscribe();
    Object.keys(debounceTimers).forEach((fieldId) => clearTimeout(debounceTimers[fieldId]));
  }

  return {
    join, writeField, scheduleWrite, flushAll, setFocusedField, hasPendingWrite,
    commitAndLeave, cancelAndLeave, disconnectAndLeave, detach,
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
    // Button Group is a discrete click too (renderButtonGroup dispatches
    // 'change', dynamic-form.js), same reasoning as dropdown.
    const immediate = field.type === 'dropdown' || field.type === 'buttonGroup';
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
