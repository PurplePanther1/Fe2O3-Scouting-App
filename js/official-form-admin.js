// ====== Admin screen: publish the official scouting forms ======
// Only the app admin (a VERIFIED leviticus.sietman@gmail.com account —
// isOfficialFormsAdmin(), official-forms.js; firestore.rules is what actually
// enforces it) sees the "Admin" button. It opens the SAME form builder the teams
// use (form-builder.js, builderMode 'admin'): pick a season and a form type, edit
// the fields in an unpublished DRAFT, see what is published now, and Publish.
// Pit and match are versioned separately; a publish bumps only that form's
// number. Nothing a team has is touched by publishing: teams are offered the new
// version and choose (official-forms.js).
//
// A draft starts from the SAVED draft (below) if there is one, else from the
// published form, else — when nothing is published for that season + type yet —
// from the built-in default (DECODE for 2025, the generic set otherwise).
//
// Drafts are AUTOSAVED to officialFormDrafts/{season}_{formType} (admin only,
// firestore.rules) about a second after any edit, so closing the screen or the
// browser does not lose them. "Discard my changes" and a successful Publish delete
// the saved draft. If it can't be saved (e.g. the rules aren't deployed yet) the
// screen says so and keeps working in memory; closing then asks first.

// formId -> {
//   fields, basisVersion (the published version the draft started from, 0 = nothing
//   published), basisFields / basisJson (the version it started from — published or
//   built-in default — to tell if the draft changed and to show what changed;
//   null when that version could not be read), fromDefault,
//   saveState ('none' | 'pending' | 'saving' | 'saved' | 'failed'), docExists (a saved
//   draft doc exists), rev (counts edits), timer (the autosave debounce), chain (the
//   promise of the last write, so writes never overlap) }
const adminDrafts = new Map();

// How many past versions the history lists.
const ADMIN_HISTORY_SHOWN = 10;

// Autosave: this long after the LAST edit.
const ADMIN_DRAFT_SAVE_DELAY_MS = 1000;

function adminFormId(season, formType) {
  return officialFormId(season, formType);
}

function adminFieldsJson(fields) {
  return JSON.stringify((fields || []).map(normalizedFieldForCompare));
}

function adminCleanFields(fields) {
  // Plain JSON (no undefined values, which Firestore rejects), sortOrder = position.
  return renumberFields(JSON.parse(JSON.stringify(fields || [])));
}

function adminDraftRef(id) {
  return db.collection('officialFormDrafts').doc(id);
}

function newAdminDraft({ fields, basisVersion, basisFields, fromDefault, saved }) {
  return {
    fields,
    basisVersion,
    basisFields,
    basisJson: basisFields ? adminFieldsJson(basisFields) : null,
    fromDefault,
    saveState: saved ? 'saved' : 'none',
    docExists: !!saved,
    rev: 0,
    timer: null,
    chain: Promise.resolve()
  };
}

// ====== Draft storage (what form-builder.js calls in admin mode) ======
function getAdminDraftFields(season, formType) {
  const draft = adminDrafts.get(adminFormId(season, formType));
  return draft ? draft.fields : null;
}

// Every edit lands here (add / edit / remove / copy / move / drag / load from history).
function setAdminDraftFields(season, formType, fields) {
  const id = adminFormId(season, formType);
  const draft = adminDrafts.get(id);
  if (!draft) return;
  draft.fields = fields;
  adminDraftEdited(id);
}

// The saved draft for a season + type, or null: none saved, or it can't be read
// (e.g. the rules aren't deployed) — then the admin simply starts from the published form.
async function readSavedAdminDraft(id) {
  try {
    const snap = await adminDraftRef(id).get();
    if (!snap.exists) return null;
    const data = snap.data();
    if (!Array.isArray(data.fields) || !Number.isInteger(data.basisVersion)) return null;
    return data;
  } catch (err) {
    console.warn('Could not read the saved admin draft:', err);
    return null;
  }
}

function adminDefaultFields(season, formType) {
  return adminCleanFields(formType === 'matchScouting' ? getDefaultMatchFields(season) : getDefaultPitFields(season));
}

// The fields a draft that started from `basisVersion` started from: the built-in
// default (0), the published form (still that version), or that version's history copy.
async function adminBasisFields(season, formType, basisVersion, published) {
  if (basisVersion === 0) return { basisFields: adminDefaultFields(season, formType), fromDefault: true };
  if (published && published.version === basisVersion) {
    return { basisFields: adminCleanFields(sortFormFields(published.fields)), fromDefault: false };
  }
  try {
    const snap = await db.collection('officialForms').doc(adminFormId(season, formType)).collection('versions').doc(String(basisVersion)).get();
    if (snap.exists && Array.isArray(snap.data().fields)) {
      return { basisFields: adminCleanFields(sortFormFields(snap.data().fields)), fromDefault: false };
    }
  } catch (err) {
    console.warn('Could not read the version this draft started from:', err);
  }
  return { basisFields: null, fromDefault: false };
}

async function loadAdminDraftFields(season, formType) {
  const id = adminFormId(season, formType);
  let draft = adminDrafts.get(id);
  if (!draft) {
    const published = officialForms.get(id) || await fetchOfficialForm(season, formType);
    const saved = await readSavedAdminDraft(id);
    let built;
    if (saved) {
      const basis = await adminBasisFields(season, formType, saved.basisVersion, published);
      built = newAdminDraft({ fields: adminCleanFields(sortFormFields(saved.fields)), basisVersion: saved.basisVersion, ...basis, saved: true });
    } else if (published) {
      const fields = adminCleanFields(sortFormFields(published.fields));
      built = newAdminDraft({ fields, basisVersion: published.version, basisFields: fields, fromDefault: false });
    } else {
      const fields = adminDefaultFields(season, formType);
      built = newAdminDraft({ fields, basisVersion: 0, basisFields: fields, fromDefault: true });
    }
    // A quick switch away and back can finish two loads: keep the first (it may already be edited).
    draft = adminDrafts.get(id) || built;
    adminDrafts.set(id, draft);
  }
  return draft.fields;
}

function adminDraftIsDirty(draft) {
  // A draft whose starting version couldn't be read can't be shown equal to it.
  return !!draft && (draft.basisJson == null || adminFieldsJson(draft.fields) !== draft.basisJson);
}

function adminAnyDraftDirty() {
  return Array.from(adminDrafts.values()).some(adminDraftIsDirty);
}

// ====== Autosave ======
// An edit marks the draft 'pending' and (re)starts the debounce; the write itself is
// serialized per draft (draft.chain). A clean draft (the admin undid every change)
// deletes its saved doc instead of saving a copy of the published form.
function adminDraftEdited(id) {
  const draft = adminDrafts.get(id);
  if (!draft) return;
  draft.rev = (draft.rev || 0) + 1;
  draft.saveState = 'pending';
  clearTimeout(draft.timer);
  draft.timer = setTimeout(() => { adminFlushDraft(id); }, ADMIN_DRAFT_SAVE_DELAY_MS);
  refreshAdminPanel();
}

// Writes a pending draft now. `retry` also re-tries one whose last save failed.
function adminFlushDraft(id, retry = false) {
  const draft = adminDrafts.get(id);
  if (!draft) return Promise.resolve();
  clearTimeout(draft.timer);
  draft.timer = null;
  if (retry && draft.saveState === 'failed') draft.saveState = 'pending';
  if (draft.saveState !== 'pending') return draft.chain || Promise.resolve();
  draft.chain = (draft.chain || Promise.resolve()).then(() => adminWriteDraft(draft, id));
  return draft.chain;
}

async function adminWriteDraft(draft, id) {
  if (draft.discarded) return;
  const rev = draft.rev;
  draft.saveState = 'saving';
  refreshAdminPanel();
  let result = 'saved';
  try {
    if (adminDraftIsDirty(draft)) {
      await adminDraftRef(id).set({
        fields: adminCleanFields(draft.fields),
        basisVersion: draft.basisVersion,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        updatedBy: currentUser.uid
      });
      draft.docExists = true;
    } else if (draft.docExists) {
      await adminDraftRef(id).delete();
      draft.docExists = false;
    }
  } catch (err) {
    console.warn('Could not save the admin draft:', err);
    result = 'failed';
  }
  // A newer edit has its own save coming: leave its 'pending' alone.
  if (draft.rev === rev) draft.saveState = result;
  else if (draft.saveState === 'saving') draft.saveState = 'pending';
  refreshAdminPanel();
}

// Dirty and not safely stored: closing would lose it.
function adminHasUnsavedDraft() {
  return Array.from(adminDrafts.values()).some((draft) => adminDraftIsDirty(draft) && draft.saveState !== 'saved');
}

// The "Draft saved" / "Saving..." / "Not saved" line in the admin panel.
function adminSaveStateText(draft) {
  if (!draft || !adminDraftIsDirty(draft)) return '';
  if (draft.saveState === 'pending' || draft.saveState === 'saving') return 'Saving...';
  if (draft.saveState === 'saved') return 'Draft saved';
  if (draft.saveState === 'failed') return 'Not saved: changes are only kept while this screen is open';
  return '';
}

// ====== Opening / closing ======
function openAdminScreen() {
  if (!isOfficialFormsAdmin()) return;
  adminDrafts.forEach((draft) => clearTimeout(draft.timer));
  adminDrafts.clear();
  syncOfficialFormsWatch();
  openBuilderInAdminMode('pitScouting', getCurrentFtcSeason());
}

// closeFormBuilder() asks this first in admin mode. Returns true when it has
// taken over: pending edits are saved first, and only a draft that could NOT be
// saved puts up a "discard?" confirm (the screen then stays open).
let adminClosing = false;
function adminBuilderCloseNeedsConfirm() {
  if (!adminHasUnsavedDraft()) {
    adminDrafts.forEach((draft) => clearTimeout(draft.timer));
    adminDrafts.clear();
    return false;
  }
  if (!adminClosing) adminSaveThenClose();
  return true;
}

async function adminSaveThenClose() {
  adminClosing = true;
  try {
    await Promise.all(Array.from(adminDrafts.keys()).map((id) => adminFlushDraft(id, true)));
  } finally {
    adminClosing = false;
  }
  if (!adminHasUnsavedDraft()) {
    adminDrafts.clear();
    closeFormBuilder();
    return;
  }
  showConfirmModal({
    title: 'Discard unpublished changes?',
    message: 'Your changes could not be saved, so they are only kept while this screen is open. Closing the Admin screen throws them away.',
    confirmLabel: 'Discard',
    danger: true,
    onConfirm: () => {
      adminDrafts.forEach((draft) => clearTimeout(draft.timer));
      adminDrafts.clear();
      closeFormBuilder();
    }
  });
}

function updateAdminButtons() {
  const show = isOfficialFormsAdmin();
  ['btn-open-admin-from-team', 'btn-open-admin-from-dashboard', 'btn-open-admin-from-account', 'btn-open-admin-from-activity'].forEach((id) => {
    const btn = document.getElementById(id);
    if (btn) btn.classList.toggle('hidden', !show);
  });
}

// ====== The panel above the field list ======
function adminPanelVisible() {
  return builderMode === 'admin' && builderModalIsOpen();
}

function refreshAdminPanel() {
  if (!adminPanelVisible()) return;
  const id = adminFormId(currentBuilderSeason, currentFormBuilderType);
  const draft = adminDrafts.get(id);
  const published = officialForms.get(id);
  const word = officialFormTypeWord(currentFormBuilderType);

  const statusEl = document.getElementById('admin-status');
  if (published) {
    const when = formatOfficialFormDate(published.publishedAt);
    statusEl.textContent = `Published now: version ${published.version}${when ? `, ${when}` : ''}.`;
  } else {
    statusEl.textContent = `No ${word} form is published for ${officialFormSeasonLabel(currentBuilderSeason)} yet.`;
  }

  const stateEl = document.getElementById('admin-draft-state');
  const saveEl = document.getElementById('admin-save-state');
  const changesBtn = document.getElementById('btn-admin-changes');
  if (!draft) {
    // The draft for this season + type is still loading.
    stateEl.textContent = 'Loading...';
    document.getElementById('btn-admin-publish').disabled = true;
    saveEl.textContent = '';
    saveEl.classList.add('hidden');
    changesBtn.classList.add('hidden');
    return;
  }
  const dirty = adminDraftIsDirty(draft);
  const publishedMoved = !!draft && (published ? published.version : 0) !== draft.basisVersion;
  if (publishedMoved) stateEl.textContent = `Version ${published ? published.version : 0} was published since you started this draft (another tab?). Discard your changes to start again from it.`;
  else if (dirty) stateEl.textContent = 'You have unpublished changes.';
  else if (draft && draft.fromDefault) stateEl.textContent = 'Starting from the built-in default form. It is not published yet.';
  else stateEl.textContent = 'No changes since the published version.';
  stateEl.classList.toggle('official-admin-warning', dirty || publishedMoved);

  const nextVersion = (published ? published.version : 0) + 1;
  const publishBtn = document.getElementById('btn-admin-publish');
  publishBtn.textContent = `Publish version ${nextVersion}`;
  publishBtn.disabled = !draft || publishedMoved;
  document.getElementById('btn-admin-reset').classList.toggle('hidden', !(dirty || publishedMoved));
  // "See what changed" needs something to show (a draft that differs) and the version it started from.
  changesBtn.classList.toggle('hidden', !(dirty && draft.basisFields));
  const saveText = adminSaveStateText(draft);
  saveEl.textContent = saveText;
  saveEl.classList.toggle('hidden', !saveText);
  saveEl.dataset.state = draft.saveState || 'none';
  saveEl.classList.toggle('official-admin-warning', draft.saveState === 'failed');
}

function onOfficialFormsChangedForAdmin() {
  refreshAdminPanel();
  if (adminPanelVisible() && !document.getElementById('admin-history-list').classList.contains('hidden')) {
    renderAdminHistory();
  }
}

// Throw the draft away (including its saved copy) and start again from the
// published form (or default). Nothing is deleted unless a saved draft exists, so
// this also works when drafts can't be saved at all.
async function adminResetDraft() {
  const id = adminFormId(currentBuilderSeason, currentFormBuilderType);
  const draft = adminDrafts.get(id);
  if (draft) {
    clearTimeout(draft.timer);
    draft.timer = null;
    draft.discarded = true; // a save still queued behind the one running must not write
    try { await draft.chain; } catch (_) { /* adminWriteDraft never rejects */ }
    if (draft.docExists) {
      try {
        await adminDraftRef(id).delete();
        draft.docExists = false;
      } catch (err) {
        console.warn('Could not delete the saved admin draft:', err);
        draft.discarded = false;
        setStatusMessage('builder', 'error', 'Could not discard the saved draft. Your changes are still there. Check your connection and try again.');
        adminDraftEdited(id);
        return;
      }
    }
  }
  adminDrafts.delete(id);
  await applyBuilderSeasonAndType(builderTeamId());
}

// ====== History ======
async function renderAdminHistory() {
  const listEl = document.getElementById('admin-history-list');
  const id = adminFormId(currentBuilderSeason, currentFormBuilderType);
  listEl.classList.remove('hidden');
  listEl.textContent = 'Loading...';
  let versions;
  try {
    const snap = await db.collection('officialForms').doc(id).collection('versions').get();
    versions = snap.docs.map((d) => d.data()).sort((a, b) => b.version - a.version).slice(0, ADMIN_HISTORY_SHOWN);
  } catch (err) {
    console.warn('Could not read the version history:', err);
    listEl.textContent = 'Could not load the history. Check your connection and try again.';
    return;
  }
  // The admin may have switched season/type while this was loading.
  if (id !== adminFormId(currentBuilderSeason, currentFormBuilderType)) return;
  listEl.textContent = '';
  if (versions.length === 0) {
    listEl.textContent = 'Nothing has been published for this season and form type yet.';
    return;
  }
  versions.forEach((version) => {
    const row = document.createElement('div');
    row.className = 'official-admin-history-row';
    row.dataset.version = String(version.version);
    const label = document.createElement('span');
    label.className = 'official-admin-history-label';
    const when = formatOfficialFormDate(version.publishedAt);
    label.textContent = `Version ${version.version}${when ? ` · ${when}` : ''} · ${version.fields.length} fields`;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-small btn-outline';
    btn.textContent = 'Load as draft';
    btn.addEventListener('click', async () => {
      const draft = adminDrafts.get(id);
      if (!draft) return;
      draft.fields = adminCleanFields(sortFormFields(version.fields));
      adminDraftEdited(id);
      await renderBuilderFields(builderTeamId());
      refreshAdminPanel();
    });
    row.appendChild(label);
    row.appendChild(btn);
    listEl.appendChild(row);
  });
}

function toggleAdminHistory() {
  const listEl = document.getElementById('admin-history-list');
  if (!listEl.classList.contains('hidden')) {
    listEl.classList.add('hidden');
    return;
  }
  renderAdminHistory();
}

// ====== Publish ======
function adminValidateDraft(fields) {
  if (!fields || fields.length === 0) return 'Add at least one field before publishing.';
  const seen = new Set();
  for (const field of fields) {
    if (seen.has(field.id)) return `Two fields share the ID "${field.id}". Field IDs must be unique.`;
    seen.add(field.id);
  }
  if (fields.length > 100) return 'An official form can have at most 100 fields.';
  return null;
}

function adminPublish() {
  if (!isOfficialFormsAdmin()) return;
  const season = String(currentBuilderSeason);
  const formType = currentFormBuilderType;
  const id = adminFormId(season, formType);
  const draft = adminDrafts.get(id);
  if (!draft) return;
  const problem = adminValidateDraft(draft.fields);
  if (problem) {
    setStatusMessage('builder', 'error', problem);
    return;
  }
  const published = officialForms.get(id);
  const version = (published ? published.version : 0) + 1;
  const word = officialFormTypeWord(formType);
  const isCurrentSeason = season === String(getCurrentFtcSeason());
  showConfirmModal({
    title: `Publish version ${version}?`,
    message: `Publish version ${version} of the ${officialFormSeasonLabel(season)} ${word} scouting form (${draft.fields.length} fields)? `
      + `Every team that has a ${word} form for this season is offered it: a captain or forms editor chooses Accept, Merge or Keep. Nothing on any team changes by itself.`
      + (isCurrentSeason ? ' This is the CURRENT season, so real teams will see it.' : '')
      + ' A published version cannot be taken back; publish again to replace it.',
    confirmLabel: `Publish version ${version}`,
    danger: isCurrentSeason,
    onConfirm: () => adminDoPublish(season, formType, draft)
  });
}

async function adminDoPublish(season, formType, draft) {
  const id = adminFormId(season, formType);
  const ref = db.collection('officialForms').doc(id);
  const fields = adminCleanFields(draft.fields);
  showLoading('Publishing...');
  let version;
  try {
    version = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const current = snap.exists ? snap.data().version : 0;
      if (current !== draft.basisVersion) throw new OfficialFormError('stale', `Version ${current} was published since you started this draft.`);
      const next = current + 1;
      const data = {
        season, formType, version: next, fields,
        publishedAt: firebase.firestore.FieldValue.serverTimestamp(),
        publishedBy: currentUser.uid
      };
      tx.set(ref, data);
      tx.set(ref.collection('versions').doc(String(next)), data);
      return next;
    });
  } catch (err) {
    hideLoading();
    console.error('Publish failed:', err);
    setStatusMessage('builder', 'error', err instanceof OfficialFormError
      ? `${err.message} Nothing was published.`
      : (err && err.code === 'permission-denied'
        ? 'Permission denied: only the admin account can publish. Nothing was published.'
        : 'Could not publish. Nothing was published. Check your connection and try again.'));
    return;
  }
  hideLoading();
  // The draft is now exactly the published version.
  draft.fields = fields;
  draft.basisVersion = version;
  draft.basisFields = fields;
  draft.basisJson = adminFieldsJson(fields);
  draft.fromDefault = false;
  // The saved draft has done its job: drop it (best effort; if that fails the draft is
  // now clean, so the next autosave pass deletes it).
  await adminDropSavedDraftAfterPublish(id, draft);
  setStatusMessage('builder', 'success', `Published version ${version}.`);
  if (adminPanelVisible()) await renderBuilderFields(builderTeamId());
  refreshAdminPanel();
  // An open history list gets the new version.
  if (adminPanelVisible() && !document.getElementById('admin-history-list').classList.contains('hidden')) renderAdminHistory();
}

async function adminDropSavedDraftAfterPublish(id, draft) {
  clearTimeout(draft.timer);
  draft.timer = null;
  draft.rev = (draft.rev || 0) + 1;
  try { await draft.chain; } catch (_) { /* adminWriteDraft never rejects */ }
  draft.saveState = 'none';
  if (!draft.docExists) return;
  try {
    await adminDraftRef(id).delete();
    draft.docExists = false;
  } catch (err) {
    console.warn('Could not delete the saved admin draft after publishing:', err);
    adminDraftEdited(id);
  }
}

// ====== "See what changed" ======
// A read-only popup of the version the draft STARTED from (the published version, or
// the built-in default), each field in its original order with its status against the
// draft, then the fields the draft added. Nothing here touches the draft.
//
// Fields on the longest in-order run common to both lists stay "unchanged" in position;
// the others that exist on both sides are "moved", so moving one field is one "moved",
// not a "moved" for everything it jumped over.
function adminLongestOrderedRun(sequence) {
  // Indexes into `sequence` of one longest strictly increasing subsequence.
  const best = sequence.map(() => 1);
  const prev = sequence.map(() => -1);
  let end = -1;
  sequence.forEach((value, i) => {
    for (let j = 0; j < i; j++) {
      if (sequence[j] < value && best[j] + 1 > best[i]) { best[i] = best[j] + 1; prev[i] = j; }
    }
    if (end < 0 || best[i] > best[end]) end = i;
  });
  const keep = new Set();
  for (let i = end; i >= 0; i = prev[i]) keep.add(i);
  return keep;
}

function describeDraftChanges(baseFields, draftFields) {
  const plan = classifyMerge(baseFields, draftFields); // "team" = where it started, "official" = the draft
  const draftIndex = new Map(draftFields.map((f, i) => [f.id, i]));
  const differencesById = new Map(plan.different.map((d) => [d.id, d.differences]));
  const removedIds = new Set(plan.kept.map((f) => f.id));
  const common = baseFields.filter((f) => draftIndex.has(f.id));
  const keep = adminLongestOrderedRun(common.map((f) => draftIndex.get(f.id)));
  const movedIds = new Set(common.filter((f, i) => !keep.has(i)).map((f) => f.id));
  return {
    rows: baseFields.map((field) => ({
      field,
      removed: removedIds.has(field.id),
      differences: differencesById.get(field.id) || [],
      moved: movedIds.has(field.id),
      position: draftIndex.has(field.id) ? draftIndex.get(field.id) + 1 : null
    })),
    added: plan.added.map((field) => ({ field, position: draftIndex.get(field.id) + 1 }))
  };
}

function adminChangeStatusParts(row) {
  if (row.removed) return { status: 'removed', text: 'Removed in the draft' };
  const parts = [];
  if (row.differences.length > 0) parts.push(`Changed: ${row.differences.join(', ')}`);
  if (row.moved) parts.push(`Moved (now position ${row.position})`);
  if (parts.length === 0) return { status: 'unchanged', text: 'Unchanged' };
  return { status: row.differences.length > 0 ? 'changed' : 'moved', text: parts.join(' · ') };
}

function buildAdminChangeRow(field, status, text) {
  const item = buildReadOnlyFieldRow(field);
  item.classList.add('admin-change-row');
  item.dataset.status = status;
  item.dataset.fieldId = field.id;
  const note = document.createElement('span');
  note.className = 'admin-change-status';
  note.textContent = text;
  item.querySelector('.builder-field-summary').appendChild(note);
  return item;
}

function openAdminChanges() {
  const id = adminFormId(currentBuilderSeason, currentFormBuilderType);
  const draft = adminDrafts.get(id);
  if (!draft || !draft.basisFields) return;
  const { rows, added } = describeDraftChanges(draft.basisFields, draft.fields);
  const word = officialFormTypeWord(currentFormBuilderType);
  document.getElementById('admin-changes-title').textContent = `What changed in the ${word} draft`;
  const startedFrom = draft.fromDefault ? 'the built-in default form (nothing is published yet)' : `published version ${draft.basisVersion}`;
  document.getElementById('admin-changes-info').textContent =
    `${officialFormSeasonLabel(currentBuilderSeason)} · compared with ${startedFrom}, which is where this draft started.`;

  const parts = rows.map(adminChangeStatusParts);
  const count = (status) => parts.filter((p) => p.status === status).length;
  const summary = [
    [count('changed'), 'changed'], [count('moved'), 'moved'], [count('removed'), 'removed'], [added.length, 'added'], [count('unchanged'), 'unchanged']
  ].filter(([n]) => n > 0).map(([n, label]) => `${n} ${label}`).join(', ');
  document.getElementById('admin-changes-summary').textContent = summary || 'No differences.';

  const list = document.getElementById('admin-changes-list');
  list.textContent = '';
  rows.forEach((row, i) => list.appendChild(buildAdminChangeRow(row.field, parts[i].status, parts[i].text)));
  if (added.length > 0) {
    const head = document.createElement('h4');
    head.className = 'admin-change-heading';
    head.textContent = 'Added in the draft';
    list.appendChild(head);
    added.forEach((item) => list.appendChild(buildAdminChangeRow(item.field, 'added', `Added (position ${item.position})`)));
  }
  document.getElementById('admin-changes-modal').classList.remove('hidden');
}

function closeAdminChanges() {
  const modal = document.getElementById('admin-changes-modal');
  if (modal) modal.classList.add('hidden');
}

document.addEventListener('DOMContentLoaded', () => {
  const on = (id, evt, fn) => { const el = document.getElementById(id); if (el) el.addEventListener(evt, fn); };
  on('btn-admin-changes', 'click', openAdminChanges);
  on('btn-admin-changes-close', 'click', closeAdminChanges);
  on('btn-admin-changes-close-inline', 'click', closeAdminChanges);
  on('admin-changes-modal-overlay', 'click', closeAdminChanges);
  on('btn-open-admin-from-team', 'click', openAdminScreen);
  on('btn-open-admin-from-dashboard', 'click', openAdminScreen);
  on('btn-open-admin-from-account', 'click', openAdminScreen);
  on('btn-open-admin-from-activity', 'click', openAdminScreen);
  on('btn-admin-publish', 'click', adminPublish);
  on('btn-admin-reset', 'click', adminResetDraft);
  on('btn-admin-history', 'click', toggleAdminHistory);
});
