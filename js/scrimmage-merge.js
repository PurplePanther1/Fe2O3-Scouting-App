// ====== Moving a scrimmage team's scouting entries (phase 3) ======
// Renumbering a team that HAS data, and merging team A into team B, both come down to
// MOVING A's pit/match entries to another team number. Everything here is built on the
// two write patterns firestore.rules already allows (proved in
// scripts/smoke-tests/rules-tests/02-scrimmage-entry-move-rules.js) — NO rules change:
//   - any team member can CREATE a pit/match doc with any field values (so a copy can
//     keep the original scout's scoutedBy / lastEditedBy),
//   - a canManageScrimmages holder can DELETE a scrimmage's entries (cascade clause).
// A manager-only user can NOT update another scout's committed entry, and a batch that
// deletes and re-creates the SAME doc id is evaluated as an update and denied — so
// nothing here ever updates an existing entry in place: it writes NEW docs and deletes
// old ones.
//
// The id of a pit doc (teamId_eventCode_number) and a match doc
// (teamId_eventCode_matchNumber_number) embeds the team number, so a "move" is: create
// the doc under the new id (every field copied, teamNumber changed), later delete the
// old one. A MERGED entry (a conflict where the manager picked some of A's values)
// is a new doc too, with a fresh id, replacing B's old doc.
//
// Write order — duplicates are acceptable on a failure, LOSS never is:
//   1. re-read both teams' entries and re-check (nobody editing, entries as the user saw
//      them), then delete empty shells that sit on a target doc id
//   2. create every new doc (batches of 500)
//   3. update the roster (renumber: re-key; merge: remove A) — the caller's rosterStep
//   4. delete the old docs and A's empty shells (batches of 500)
// A failure at 1-3 changes nothing a user can see (stray copies are skipped on retry);
// a failure at 4 leaves harmless duplicates and offers "Try Again" for the leftovers.
//
// Live renumber (letting someone keep typing in an open form while its entry changes
// number) was reconsidered for phase 3 and is STILL deliberately not built: the pit doc
// id embeds the number and live-entry-sync.js is bound to that one doc, so the entry
// would have to be re-pointed under an open session, with its debounced writes in flight.
// Anyone editing either team simply blocks the move, with a message naming them.

const SCRIMMAGE_MOVE_BATCH = 500;

class ScrimmageMoveError extends Error {
  constructor(stage, reason, extra = {}) {
    super(`${stage}: ${reason}`);
    this.stage = stage;       // 'precheck' | 'create' | 'roster' | 'cleanup'
    this.reason = reason;
    Object.assign(this, extra);
  }
}

// ====== Reading ======

// Every pit/match doc of one team number in a scrimmage — a direct query, so empty
// shells (drafts a cancelled form left behind) are included, flagged `committed: false`.
// A doc already stamped with a deletionNotice is on its way out and counts as a shell.
async function readScrimmageTeamEntries(teamId, code, number) {
  const base = db.collection('teams').doc(teamId);
  const [pitSnap, matchSnap] = await Promise.all([
    base.collection('pitScouting').where('eventCode', '==', code).where('teamNumber', '==', Number(number)).get(),
    base.collection('matchScouting').where('eventCode', '==', code).where('teamNumber', '==', Number(number)).get()
  ]);
  const wrap = (kind) => (d) => {
    const data = d.data();
    return { kind, id: d.id, ref: d.ref, data, committed: isEntryCommitted(data) && !data.deletionNotice };
  };
  return {
    pit: pitSnap.docs.map(wrap('pit')),
    match: matchSnap.docs.map(wrap('match')).sort((a, b) => (Number(a.data.matchNumber) || 0) - (Number(b.data.matchNumber) || 0))
  };
}

function scrimmageEntryDocs(entries) {
  return [...entries.pit, ...entries.match];
}

// Names of everyone ELSE (not the current user's own session) with a fresh presence on
// any of these docs.
function otherFreshEditorNames(docs) {
  const me = currentUser && currentUser.uid;
  const names = [];
  docs.forEach(d => Object.entries(d.data.activeEditors || {}).forEach(([uid, e]) => {
    if (uid === me || !e || !isPresenceFresh(e.heartbeatAt)) return;
    const name = String(e.name || '').trim() || 'Someone';
    if (!names.includes(name)) names.push(name);
  }));
  return names;
}

function scrimmageEntryCounts(entries) {
  return {
    pit: entries.pit.filter(d => d.committed).length,
    match: entries.match.filter(d => d.committed).length
  };
}

// ====== Doc ids and copies ======

function scrimmageEntryDocId(kind, teamId, code, number, matchNumber, suffix = '') {
  return kind === 'pit'
    ? `${teamId}_${code}_${number}${suffix}`
    : `${teamId}_${code}_${matchNumber}_${number}${suffix}`;
}

function copyEntryForNumber(data, number) {
  const copy = { ...data, teamNumber: Number(number), activeEditors: {} };
  delete copy.deletionNotice;
  return copy;
}

// JSON with sorted keys and Timestamps as millis — to compare two docs' contents.
function scrimmageStable(v) {
  if (v && typeof v.toMillis === 'function') return v.toMillis();
  if (Array.isArray(v)) return v.map(scrimmageStable);
  if (v && typeof v === 'object') {
    const out = {};
    Object.keys(v).sort().forEach(k => { out[k] = scrimmageStable(v[k]); });
    return out;
  }
  return v === undefined ? null : v;
}

function scrimmageEntryContent(data, { keepNumber = false } = {}) {
  const copy = { ...data };
  delete copy.activeEditors;
  delete copy.deletionNotice;
  if (!keepNumber) delete copy.teamNumber;
  return JSON.stringify(scrimmageStable(copy));
}

// ====== The plan ======

function scrimmageSlotKey(kind, data) {
  return kind === 'pit' ? 'pit' : `match:${Number(data.matchNumber)}`;
}

// Committed entries keyed by slot ('pit' / 'match:<n>'). More than one committed doc in a
// slot (only possible after an earlier failure left duplicates) is reported in `dupes`.
function scrimmageCommittedSlots(entries) {
  const slots = new Map();
  const dupes = [];
  scrimmageEntryDocs(entries).filter(d => d.committed).forEach(d => {
    const key = scrimmageSlotKey(d.kind, d.data);
    if (slots.has(key)) dupes.push(key);
    else slots.set(key, { key, kind: d.kind, matchNumber: d.kind === 'match' ? Number(d.data.matchNumber) : null, doc: d });
  });
  return { slots, dupes };
}

function scrimmageSlotLabel(key) {
  return key === 'pit' ? 'its pit entry' : `Match ${key.split(':')[1]}`;
}

// Reads both teams fresh and sorts A's committed entries into:
//   moves        no entry in that slot on the target — copied to the target number
//   conflicts    (merge) BOTH have one: needs the Compare screen
//   alreadyThere (renumber) the target already holds an identical copy (a retry after a
//                failed earlier attempt) — only the old doc is deleted
//   blockers     empty shells sitting on a target doc id — deleted before the copies
// mode 'rename': `to` is NOT on the roster. mode 'merge': it is team B.
// Resolves { ok: true, ... } or { ok: false, reason: 'editing' | 'duplicates' | 'occupied' | 'error', ... }.
async function buildScrimmageMovePlan({ scrimmageId, from, to, mode }) {
  const teamId = currentTeamData && currentTeamData.id;
  const scrim = scrimmageDataFor(scrimmageId);
  if (!teamId || !scrim) return { ok: false, reason: 'error' };
  const code = scrim.eventCode || (SCRIMMAGE_CODE_PREFIX + scrimmageId);
  let a, b;
  try {
    [a, b] = await Promise.all([readScrimmageTeamEntries(teamId, code, from), readScrimmageTeamEntries(teamId, code, to)]);
  } catch (err) {
    console.error('Failed to read scrimmage entries for a move:', err);
    return { ok: false, reason: 'error' };
  }

  const names = otherFreshEditorNames([...scrimmageEntryDocs(a), ...scrimmageEntryDocs(b)]);
  if (names.length > 0) return { ok: false, reason: 'editing', names };

  const sa = scrimmageCommittedSlots(a);
  const sb = scrimmageCommittedSlots(b);
  if (sa.dupes.length > 0) return { ok: false, reason: 'duplicates', number: from, slot: sa.dupes[0] };
  if (sb.dupes.length > 0) return { ok: false, reason: 'duplicates', number: to, slot: sb.dupes[0] };

  const moves = [];
  const conflicts = [];
  const alreadyThere = [];
  for (const slot of sa.slots.values()) {
    const other = sb.slots.get(slot.key);
    if (!other) moves.push(slot);
    else if (mode === 'merge') conflicts.push({ key: slot.key, kind: slot.kind, matchNumber: slot.matchNumber, a: slot.doc, b: other.doc });
    else if (scrimmageEntryContent(slot.doc.data) === scrimmageEntryContent(other.doc.data)) alreadyThere.push(slot);
    else return { ok: false, reason: 'occupied', number: to, slot: slot.key };
  }

  const targetIds = new Set(moves.map(m => scrimmageEntryDocId(m.kind, teamId, code, to, m.matchNumber)));
  const blockers = scrimmageEntryDocs(b).filter(d => !d.committed && targetIds.has(d.id));

  const sideBasis = (entries) => scrimmageEntryDocs(entries).filter(d => d.committed)
    .map(d => `${d.kind}:${d.id}:${scrimmageEntryContent(d.data, { keepNumber: true })}`).sort();
  return {
    ok: true, teamId, code, a, b, moves, conflicts, alreadyThere, blockers,
    basis: JSON.stringify({ a: sideBasis(a), b: sideBasis(b) })
  };
}

// ====== Merging two entries' values ======

function scrimmageValueIsBlank(v) {
  return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
}

function scrimmageValuesSame(a, b) {
  if (scrimmageValueIsBlank(a) && scrimmageValueIsBlank(b)) return true;
  if (scrimmageValueIsBlank(a) || scrimmageValueIsBlank(b)) return false;
  return valuesEqual(a, b);
}

// Doc keys that are never form fields (identity, attribution, live-session bookkeeping).
function scrimmageNonFieldKeys() {
  return new Set([...RESERVED_DOC_KEYS, 'checkpoint', 'activeEditors', 'deletionNotice']);
}

// The fields the Compare screen walks for one conflict: the season's form config (the
// same read-only loader the exports use) plus any "deleted field" either entry still
// carries. matchNumber is the slot itself, never a choice.
function scrimmageCompareFields(config, aData, bData) {
  const skip = scrimmageNonFieldKeys();
  const known = new Set((config || []).map(f => f.id));
  const fields = (config || [])
    .filter(f => !skip.has(f.id))
    .map(f => ({ id: f.id, label: f.label || f.id, deleted: false }));
  const extra = new Set();
  [aData, bData].forEach(data => Object.keys(data || {}).forEach(k => {
    if (!known.has(k) && !skip.has(k)) extra.add(k);
  }));
  Array.from(extra).sort().forEach(k => fields.push({ id: k, label: `${k} (deleted field)`, deleted: true }));
  return fields;
}

async function loadScrimmageCompareConfig(teamId, season) {
  const [pit, match] = await Promise.all([
    loadFormConfigReadOnly(teamId, season, 'pitScouting', getDefaultPitFields),
    loadFormConfigReadOnly(teamId, season, 'matchScouting', getDefaultMatchFields)
  ]);
  return { pit, match };
}

// B's doc with the chosen values written into BOTH the live fields and the checkpoint,
// lastEdited* set to the manager. `changed` is false when every choice leaves B's values
// as they are — then B's doc is left completely alone and only A's is deleted (the app's
// own rule: lastEditedBy moves only when the checkpoint genuinely differs).
function buildMergedEntryData({ aData, bData, fields, choices, uid, displayName }) {
  const data = { ...bData };
  const checkpoint = { ...(bData.checkpoint || {}) };
  let changed = false;
  fields.forEach(f => {
    const av = aData[f.id];
    const bv = bData[f.id];
    if (!(f.id in checkpoint)) checkpoint[f.id] = bv === undefined ? null : bv;
    if ((choices || {})[f.id] === 'a' && !scrimmageValuesSame(av, bv)) {
      changed = true;
      if (av === undefined || av === null) { delete data[f.id]; checkpoint[f.id] = null; }
      else { data[f.id] = av; checkpoint[f.id] = av; }
    }
  });
  if (!changed) return { changed: false, data: bData };
  data.checkpoint = checkpoint;
  data.lastEditedBy = uid;
  data.lastEditedByName = displayName;
  data.lastEditedByTimestamp = Date.now();
  data.updatedAt = firebase.firestore.FieldValue.serverTimestamp();
  data.activeEditors = {};
  delete data.deletionNotice;
  return { changed: true, data };
}

// ====== Executing ======

async function commitSetsInBatches(writes) {
  for (let i = 0; i < writes.length; i += SCRIMMAGE_MOVE_BATCH) {
    const batch = db.batch();
    writes.slice(i, i + SCRIMMAGE_MOVE_BATCH).forEach(w => batch.set(w.ref, w.data));
    await batch.commit();
  }
}

// opts: { scrimmageId, from, to, mode, basis?, choices?, config?, rosterStep }
//   basis       the plan's basis string the user decided on; the entries must still match it
//   choices     { <slotKey>: { <fieldId>: 'a' | 'b' } } (merge conflicts; default = B)
//   config      loadScrimmageCompareConfig() result (needed when there are conflicts)
//   rosterStep  async () => void — the roster write (step 3); its failure is stage 'roster'
// Resolves { moved: { pit, match }, merged, leftovers: [DocumentReference] } or throws a
// ScrimmageMoveError (stage + reason). A 'cleanup' error means everything but the final
// delete worked — it carries the refs still to delete.
async function executeScrimmageMove(opts) {
  const { scrimmageId, from, to, mode, basis, choices = {}, config = null, rosterStep } = opts;
  const plan = await buildScrimmageMovePlan({ scrimmageId, from, to, mode });
  if (!plan.ok) throw new ScrimmageMoveError('precheck', plan.reason, plan);
  if (basis && plan.basis !== basis) throw new ScrimmageMoveError('precheck', 'changed');

  const { teamId, code } = plan;
  const base = db.collection('teams').doc(teamId);
  const collectionOf = (kind) => base.collection(kind === 'pit' ? 'pitScouting' : 'matchScouting');
  const uid = currentUser.uid;
  const displayName = typeof getCurrentUserDisplayName === 'function' ? getCurrentUserDisplayName() : (currentUser.email || 'Unknown');

  const writes = plan.moves.map(m => ({
    ref: collectionOf(m.kind).doc(scrimmageEntryDocId(m.kind, teamId, code, to, m.matchNumber)),
    data: copyEntryForNumber(m.doc.data, to)
  }));
  const replacedRefs = [];
  let mergedCount = 0;
  const stamp = Date.now().toString(36);
  plan.conflicts.forEach(c => {
    const fields = scrimmageCompareFields(config && config[c.kind], c.a.data, c.b.data);
    const merged = buildMergedEntryData({ aData: c.a.data, bData: c.b.data, fields, choices: choices[c.key], uid, displayName });
    mergedCount += 1;
    if (!merged.changed) return;
    writes.push({ ref: collectionOf(c.kind).doc(scrimmageEntryDocId(c.kind, teamId, code, to, c.matchNumber, `_m${stamp}`)), data: merged.data });
    replacedRefs.push(c.b.ref);
  });

  // 1 (cont.): empty shells on a target id are deleted first — copying another scout's
  // entry ONTO an existing shell would be an update the scoutedBy rule refuses.
  // 2: create the new docs.
  try {
    await deleteDocRefsInBatches(plan.blockers.map(d => d.ref));
    await commitSetsInBatches(writes);
  } catch (err) {
    console.error('Scrimmage move: could not create the new entries:', err);
    throw new ScrimmageMoveError('create', 'write', { cause: err });
  }

  // 3: the roster.
  try {
    await rosterStep();
  } catch (err) {
    console.error('Scrimmage move: roster update failed:', err);
    // The originals are untouched, so take the copies back out (best effort) — otherwise
    // they would sit at the target number and show up on whatever team gets that number.
    // If this fails too they are harmless duplicates a retry recognises.
    await deleteRefsReportingLeftovers(writes.map(w => w.ref));
    throw new ScrimmageMoveError('roster', 'write', { cause: err });
  }

  // 4: delete the old docs (all of A's, committed or empty) and the B docs replaced by merges.
  const oldRefs = [...scrimmageEntryDocs(plan.a).map(d => d.ref), ...replacedRefs];
  const leftovers = await deleteRefsReportingLeftovers(oldRefs);
  return {
    moved: { pit: plan.moves.filter(m => m.kind === 'pit').length, match: plan.moves.filter(m => m.kind === 'match').length },
    merged: mergedCount,
    leftovers
  };
}

// Deletes in batches; returns the refs NOT deleted (the failed batch onward).
async function deleteRefsReportingLeftovers(refs) {
  for (let i = 0; i < refs.length; i += SCRIMMAGE_MOVE_BATCH) {
    try {
      const batch = db.batch();
      refs.slice(i, i + SCRIMMAGE_MOVE_BATCH).forEach(r => batch.delete(r));
      await batch.commit();
    } catch (err) {
      console.error('Scrimmage move: could not delete old entries:', err);
      return refs.slice(i);
    }
  }
  return [];
}

// After a move whose final delete failed: the move itself is done and complete, only old
// copies remain — offer to remove them (and again on another failure).
function offerMoveCleanupRetry(refs, label) {
  if (!refs || refs.length === 0) return;
  showConfirmModal({
    title: 'Some Old Entries Remain',
    message: `${label} is done and every entry is safe at its new number, but ${refs.length} old ${refs.length === 1 ? 'entry' : 'entries'} could not be removed (connection or permission). Remove them now?`,
    confirmLabel: 'Try Again',
    onConfirm: async () => {
      showLoading('Removing old entries...');
      let left;
      try { left = await deleteRefsReportingLeftovers(refs); } finally { hideLoading(); }
      if (left.length > 0) offerMoveCleanupRetry(left, label);
    }
  });
}

// ====== Messages ======

function scrimmageMoveCountsText(pit, match) {
  const parts = [];
  if (match > 0) parts.push(`${match} match ${match === 1 ? 'entry' : 'entries'}`);
  if (pit > 0) parts.push(`${pit} pit ${pit === 1 ? 'entry' : 'entries'}`);
  return parts.join(' and ');
}

function scrimmageMoveProblemMessage(problem, { merge = false } = {}) {
  const reason = problem.reason;
  if (reason === 'editing') return scrimmageEditingMessage(problem.names || [], { merge });
  if (reason === 'changed') return 'The scouting entries for these teams changed while you were deciding. Nothing was changed. Close this and try again.';
  if (reason === 'duplicates') return `Team #${problem.number} has more than one entry for ${scrimmageSlotLabel(problem.slot)}, so it can't be moved safely. Delete the extra entry first.`;
  if (reason === 'occupied') return `Team #${problem.number} already has scouting entries from an earlier attempt that don't match this team's. Remove them first, or choose another number.`;
  return "Couldn't check the scouting entries. Nothing was changed. Check your connection and try again.";
}

// ScrimmageMoveError (or anything else) -> the line shown to the user.
function scrimmageMoveErrorMessage(err, { merge = false } = {}) {
  if (err instanceof ScrimmageMoveError) {
    if (err.stage === 'precheck') return scrimmageMoveProblemMessage({ ...err, reason: err.reason }, { merge });
    if (err.stage === 'create') return 'Could not copy the scouting entries. Nothing was changed. Check your connection and try again.';
    if (err.stage === 'roster') {
      const cause = err.cause || {};
      if (cause.code === 'permission-denied') return 'You do not have permission to change the roster.';
      // Our own readable errors (a teammate just added that number, the team was removed...).
      if (cause.message && !cause.code) return cause.message;
      return 'The roster could not be updated, so nothing was changed. Check your connection and try again.';
    }
  }
  return (err && err.message) || 'Could not save. Try again.';
}

// ====== Merge: the whole flow, started from the Edit modal's Save ======
// Resolves { status: 'merged', leftovers } | { status: 'cancelled' } | { error }.
// `fromName` is team A's name as typed in the Edit modal (used only if B has no name).
async function mergeScrimmageTeams({ scrimmageId, from, to, fromName }) {
  const teamId = currentTeamData && currentTeamData.id;
  const scrim = scrimmageDataFor(scrimmageId);
  if (!teamId || !scrim) return { error: 'This scrimmage is not available.' };
  if (!(typeof canUserManageScrimmages === 'function' && canUserManageScrimmages())) return { error: scrimmageRenumberHint({ reason: 'permission' }) };

  showLoading('Checking scouting entries...');
  let plan, config = null;
  try {
    plan = await buildScrimmageMovePlan({ scrimmageId, from, to, mode: 'merge' });
    if (plan.ok && plan.conflicts.length > 0) config = await loadScrimmageCompareConfig(teamId, scrim.season);
  } finally {
    hideLoading();
  }
  if (!plan.ok) return { error: scrimmageMoveProblemMessage(plan, { merge: true }) };
  if (!getScrimmageRosterTeam(to, scrimmageId)) return { error: `Team #${to} is no longer on the roster.` };

  const typedName = String(fromName || '').trim().slice(0, SCRIMMAGE_NAME_MAX);
  const rosterStep = () => mergeRosterTransaction(teamId, scrimmageId, from, to, typedName);
  let leftovers = [];
  const run = async (choices) => {
    try {
      const res = await executeScrimmageMove({ scrimmageId, from, to, mode: 'merge', basis: plan.basis, choices, config, rosterStep });
      leftovers = res.leftovers;
      return { ok: true };
    } catch (err) {
      return { error: scrimmageMoveErrorMessage(err, { merge: true }) };
    }
  };

  // No overlap: a plain confirm that says exactly what moves.
  if (plan.conflicts.length === 0) {
    const counts = scrimmageMoveCountsText(plan.moves.filter(m => m.kind === 'pit').length, plan.moves.filter(m => m.kind === 'match').length);
    const total = plan.moves.length;
    const message = total === 0
      ? `Team #${from} has no scouting entries to move. #${from} is removed from the roster.`
      : `${counts} from #${from} ${total === 1 ? 'moves' : 'move'} to #${to}. #${from} is removed from the roster.`;
    const confirmed = await new Promise((resolve) => {
      showConfirmModal({
        title: `Merge #${from} into #${to}?`,
        message,
        confirmLabel: 'Merge',
        onConfirm: () => resolve(true),
        onCancel: () => resolve(false)
      });
    });
    if (!confirmed) return { status: 'cancelled' };
    showLoading('Merging teams...');
    let out;
    try { out = await run({}); } finally { hideLoading(); }
    if (out.error) return { error: out.error };
    return { status: 'merged', leftovers };
  }

  // Overlap: the Compare screen; nothing is written until its final Merge button.
  const outcome = await openScrimmageMergeCompare({ plan, from, to, config, season: scrim.season, onMerge: run });
  if (outcome !== 'merged') return { status: 'cancelled' };
  return { status: 'merged', leftovers };
}

async function mergeRosterTransaction(teamId, scrimmageId, from, to, typedName) {
  const ref = scrimmagesCollection(teamId).doc(scrimmageId);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new Error('This scrimmage no longer exists.');
    const roster = snap.data().teams || {};
    if (!roster[String(from)] || !roster[String(to)]) throw new Error('One of the teams is no longer on the roster.');
    // B's roster entry survives untouched (link, name, OPR) — except a blank name,
    // which takes A's.
    const updates = [scrimmageRosterFieldPath(from), firebase.firestore.FieldValue.delete()];
    if (!String(roster[String(to)].name || '').trim() && typedName) {
      updates.push(scrimmageRosterFieldPath(to, 'name'), typedName, scrimmageRosterFieldPath(to, 'manualName'), typedName);
    }
    tx.update(ref, ...updates);
  });
}

// ====== The Compare screen (#scrimmage-merge-modal) ======
// STAGED: nothing is written until the final "Merge into #B" button; Cancel / X /
// click-out ask "Discard changes?" first and, if confirmed, throw everything away and
// leave the Edit modal exactly as it was.
let mergeCompareState = null; // { plan, from, to, choices, onMerge, resolve, busy }

function mergeCompareEl(id) {
  return document.getElementById(id);
}

function mergeCompareText(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  el.textContent = text;
  return el;
}

function describeMergeValue(v) {
  if (scrimmageValueIsBlank(v)) return '(blank)';
  if (Array.isArray(v)) return v.join(' + ');
  if (v && typeof v.toDate === 'function') return formatTimestamp(v);
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function describeMergeScout(doc) {
  const d = doc.data;
  const parts = [`Scouted by ${d.scoutedByName || 'unknown'}`];
  const at = formatTimestamp(d.scoutedAt);
  if (at) parts.push(`on ${at}`);
  if (d.lastEditedByName) parts.push(`· last edited by ${d.lastEditedByName}`);
  return parts.join(' ');
}

function openScrimmageMergeCompare({ plan, from, to, config, season, onMerge }) {
  return new Promise((resolve) => {
    if (mergeCompareState) closeMergeCompare(null);
    const choices = {};
    const state = { plan, from, to, choices, onMerge, resolve, busy: false };
    mergeCompareState = state;

    const rosterA = getScrimmageRosterTeam(from);
    const rosterB = getScrimmageRosterTeam(to);
    const label = (n, t) => `#${n}${t && t.name ? ` (${t.name})` : ''}`;
    mergeCompareEl('merge-compare-title').textContent = `Merge #${from} into #${to}`;
    mergeCompareEl('merge-compare-intro').textContent =
      `Both teams have an entry for the same thing. For each field that differs, choose whose value to keep (${label(to, rosterB)}'s is selected). Nothing changes until you press Merge into #${to}.`;
    const movePit = plan.moves.filter(m => m.kind === 'pit').length;
    const moveMatch = plan.moves.filter(m => m.kind === 'match').length;
    const summary = mergeCompareEl('merge-compare-summary');
    summary.textContent = plan.moves.length > 0
      ? `${moveMatch} more match ${moveMatch === 1 ? 'entry' : 'entries'} and ${movePit} pit ${movePit === 1 ? 'entry' : 'entries'} from #${from} will move to #${to}.`
      : '';
    summary.classList.toggle('hidden', plan.moves.length === 0);
    mergeCompareEl('merge-compare-error').textContent = '';
    mergeCompareEl('btn-merge-compare-confirm').textContent = `Merge into #${to}`;
    mergeCompareEl('btn-merge-compare-confirm').disabled = false;
    mergeCompareEl('btn-merge-compare-cancel').disabled = false;

    const list = mergeCompareEl('merge-compare-list');
    list.textContent = '';
    plan.conflicts.forEach(c => list.appendChild(renderMergeConflict(state, c, config && config[c.kind], rosterA, rosterB)));

    mergeCompareEl('scrimmage-merge-modal').classList.remove('hidden');
    list.scrollTop = 0;
    mergeCompareEl('btn-merge-compare-confirm').focus();
  });
}

function renderMergeConflict(state, c, config, rosterA, rosterB) {
  const { from, to } = state;
  const fields = scrimmageCompareFields(config, c.a.data, c.b.data);
  const choice = {};
  state.choices[c.key] = choice;

  const section = document.createElement('section');
  section.className = 'merge-conflict';
  section.dataset.conflict = c.key;
  section.appendChild(mergeCompareText('h4', 'merge-conflict-title', c.kind === 'pit' ? 'Pit scouting' : `Match ${c.matchNumber}`));

  const sides = document.createElement('div');
  sides.className = 'merge-sides';
  [[from, c.a], [to, c.b]].forEach(([n, doc]) => {
    const side = document.createElement('div');
    side.className = 'merge-side';
    side.appendChild(mergeCompareText('strong', null, `#${n}`));
    side.appendChild(mergeCompareText('span', 'merge-side-who', describeMergeScout(doc)));
    sides.appendChild(side);
  });
  section.appendChild(sides);

  const different = fields.filter(f => !scrimmageValuesSame(c.a.data[f.id], c.b.data[f.id]));
  // Equal values collapse into one line; a field blank on BOTH sides has nothing to show.
  const same = fields.filter(f => scrimmageValuesSame(c.a.data[f.id], c.b.data[f.id]) && !scrimmageValueIsBlank(c.a.data[f.id]));
  different.forEach(f => { choice[f.id] = 'b'; });

  const setAll = (who) => {
    different.forEach(f => { choice[f.id] = who; });
    section.querySelectorAll('input[type="radio"]').forEach(r => { r.checked = r.value === who; });
  };
  const shortcuts = document.createElement('div');
  shortcuts.className = 'merge-shortcuts';
  [['a', from], ['b', to]].forEach(([who, n]) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-small btn-outline';
    btn.dataset.useAll = who;
    btn.textContent = `Use all of #${n}`;
    btn.addEventListener('click', () => setAll(who));
    shortcuts.appendChild(btn);
  });
  section.appendChild(shortcuts);

  if (different.length === 0) {
    section.appendChild(mergeCompareText('p', 'help-text', 'Every field is the same on both entries.'));
  }
  different.forEach(f => {
    const row = document.createElement('div');
    row.className = 'merge-field';
    row.dataset.field = f.id;
    row.appendChild(mergeCompareText('div', 'merge-field-label', f.label));
    const opts = document.createElement('div');
    opts.className = 'merge-field-opts';
    [['a', from, c.a], ['b', to, c.b]].forEach(([who, n, doc]) => {
      const opt = document.createElement('label');
      opt.className = 'merge-opt';
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = `merge_${c.key}_${f.id}`;
      radio.value = who;
      radio.checked = who === 'b';
      radio.addEventListener('change', () => { if (radio.checked) choice[f.id] = who; });
      opt.appendChild(radio);
      const text = document.createElement('span');
      text.className = 'merge-opt-text';
      text.appendChild(mergeCompareText('span', 'merge-opt-who', `#${n}`));
      text.appendChild(mergeCompareText('span', 'merge-opt-value', describeMergeValue(doc.data[f.id])));
      opt.appendChild(text);
      opts.appendChild(opt);
    });
    row.appendChild(opts);
    section.appendChild(row);
  });

  if (same.length > 0) {
    const sameBox = document.createElement('div');
    sameBox.className = 'merge-same';
    sameBox.appendChild(mergeCompareText('div', 'merge-same-title', 'Same on both'));
    same.forEach(f => {
      const line = document.createElement('div');
      line.className = 'merge-same-line';
      line.dataset.field = f.id;
      line.appendChild(mergeCompareText('span', 'merge-same-label', `${f.label}: `));
      line.appendChild(mergeCompareText('span', null, describeMergeValue(c.a.data[f.id])));
      sameBox.appendChild(line);
    });
    section.appendChild(sameBox);
  }
  return section;
}

function closeMergeCompare(value) {
  const state = mergeCompareState;
  mergeCompareState = null;
  const modal = mergeCompareEl('scrimmage-merge-modal');
  if (modal) modal.classList.add('hidden');
  const list = mergeCompareEl('merge-compare-list');
  if (list) list.textContent = '';
  if (state) state.resolve(value === undefined ? null : value);
}

// Cancel / X / click-out.
function requestCloseMergeCompare() {
  const state = mergeCompareState;
  if (!state || state.busy) return;
  showConfirmModal({
    title: 'Discard changes?',
    message: 'The merge will not happen and your choices on this screen will be discarded.',
    confirmLabel: 'Discard',
    danger: true,
    onConfirm: () => { if (mergeCompareState === state && !state.busy) closeMergeCompare(null); }
  });
}

async function confirmMergeCompare() {
  const state = mergeCompareState;
  if (!state || state.busy) return;
  const errEl = mergeCompareEl('merge-compare-error');
  const confirmBtn = mergeCompareEl('btn-merge-compare-confirm');
  const cancelBtn = mergeCompareEl('btn-merge-compare-cancel');
  errEl.textContent = '';
  state.busy = true;
  confirmBtn.disabled = true;
  cancelBtn.disabled = true;
  confirmBtn.textContent = 'Merging...';
  let out;
  try {
    out = await state.onMerge(state.choices);
  } catch (err) {
    console.error('Merge failed:', err);
    out = { error: 'Something went wrong. Nothing was lost. Try again.' };
  }
  if (mergeCompareState !== state) return;
  state.busy = false;
  confirmBtn.disabled = false;
  cancelBtn.disabled = false;
  confirmBtn.textContent = `Merge into #${state.to}`;
  if (out && out.error) { errEl.textContent = out.error; return; }
  closeMergeCompare('merged');
}

document.addEventListener('DOMContentLoaded', () => {
  const on = (id, evt, fn) => { const el = mergeCompareEl(id); if (el) el.addEventListener(evt, fn); };
  on('btn-merge-compare-cancel', 'click', requestCloseMergeCompare);
  on('btn-merge-compare-close', 'click', requestCloseMergeCompare);
  on('scrimmage-merge-modal-overlay', 'click', requestCloseMergeCompare);
  on('btn-merge-compare-confirm', 'click', confirmMergeCompare);
});
