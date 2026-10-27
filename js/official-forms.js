// ====== Official (app-wide) scouting forms ======
// The app admin publishes ONE official form per (season, form type) — pit and
// match are versioned separately — into the shared top-level collection
// officialForms/{season}_{pitScouting|matchScouting} (see official-form-admin.js
// for publishing). Every signed-in user can read it; only the admin can write it
// (firestore.rules).
//
// A team never has its form switched silently. Each team's config doc
// (teams/{teamId}/formConfig/{season}_{type}, dynamic-form.js) carries:
//   baseVersion     the official version it was last accepted / merged from (null = never)
//   handledVersion  the highest official version the team has dealt with: accepted,
//                   merged OR kept-as-is
//   retiredFields   definitions of fields an Accept removed (old entries can still show them)
// A form is "update available" when officialForm.version > config.handledVersion.
// That is computed here from two live listeners — the officialForms collection
// and the team's formConfig collection (auth.js) — so nothing is stored per user
// and there is no notification document and no mass write. Only a captain or a
// member with canEditTemplates ever sees it.
//
// The ONLY automatic use of an official form is a team with no config at all for
// that season + type: its first config is a COPY of the official form, stamped
// with its version (loadSeasonScopedFormConfig(), dynamic-form.js).
//
// Accept and Merge replace the form inside ONE transaction that also saves a
// snapshot of the previous form (teams/{teamId}/formSnapshots), so "Restore
// previous form" always has something to restore. They always record the version
// that was on screen when the action OPENED as handledVersion; a later publish is
// simply a bigger number than that, so its notice shows again afterwards.

// The admin account's address — also hard-coded in firestore.rules
// (isOfficialFormsAdmin()), which is what actually protects the collection; this
// only decides whether to SHOW the Admin button.
const OFFICIAL_FORMS_ADMIN_EMAIL = 'leviticus.sietman@gmail.com';

const OFFICIAL_FORM_TYPES = ['pitScouting', 'matchScouting'];

// How many "previous form" snapshots are kept per season + form type.
const FORM_SNAPSHOT_KEEP = 10;

// Verified email only: an email/password sign-up can type any address, and only
// a clicked link marks it verified (see isOfficialFormsAdmin() in the rules).
function isOfficialFormsAdmin(user = currentUser) {
  return !!user
    && user.emailVerified === true
    && typeof user.email === 'string'
    && user.email.toLowerCase() === OFFICIAL_FORMS_ADMIN_EMAIL;
}

function officialFormId(season, formType) {
  return `${season}_${formType}`;
}

function parseOfficialFormId(id) {
  const m = /^(20\d\d)_(pitScouting|matchScouting)$/.exec(id || '');
  return m ? { season: m[1], formType: m[2] } : null;
}

// "pit" / "match" — how the notice names a form.
function officialFormTypeWord(formType) {
  return formType === 'matchScouting' ? 'match' : 'pit';
}

function officialFormSeasonLabel(season) {
  return typeof formatFtcSeasonLabel === 'function' ? formatFtcSeasonLabel(season) : String(season);
}

function sortFormFields(fields) {
  return (fields || []).slice().sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
}

function formatOfficialFormDate(ts) {
  if (!ts || typeof ts.toDate !== 'function') return '';
  return typeof formatInUserTimezone === 'function' ? formatInUserTimezone(ts.toDate()) : ts.toDate().toLocaleString();
}

// ====== Reading official forms ======
// One official form (or null) — never throws: no official form, or one that
// can't be read, just means "use the default" to the caller that seeds a new
// team's config (dynamic-form.js).
async function fetchOfficialForm(season, formType) {
  try {
    const snap = await db.collection('officialForms').doc(officialFormId(season, formType)).get();
    if (!snap.exists) return null;
    const data = snap.data();
    if (!Array.isArray(data.fields) || data.fields.length === 0 || !Number.isInteger(data.version)) return null;
    return { ...data, fields: sortFormFields(data.fields) };
  } catch (err) {
    console.warn(`Could not read the official ${formType} form for season ${season}:`, err);
    return null;
  }
}

// ====== Live state ======
// officialForms: formId -> data, kept live by the officialForms listener.
// teamConfigDocs: formId -> the ACTIVE team's formConfig doc data, kept live by
// auth.js's formConfig listener (which calls officialFormsOnTeamConfigs()).
let officialForms = new Map();
let teamConfigDocs = new Map();
let officialFormsUnsubscribe = null;

// Who needs the live official forms: the admin (the admin screen) and anyone
// who would be shown the notice. A plain scout never listens — they only ever
// do the one-off read when a new config is created.
function officialFormsWatchWanted() {
  if (!currentUser) return false;
  if (isOfficialFormsAdmin()) return true;
  return typeof currentTeamData !== 'undefined' && !!currentTeamData
    && typeof canUserEditTemplates === 'function' && canUserEditTemplates();
}

function syncOfficialFormsWatch() {
  if (officialFormsWatchWanted()) startWatchingOfficialForms();
  else stopWatchingOfficialForms();
}

function startWatchingOfficialForms() {
  if (officialFormsUnsubscribe || !currentUser) return;
  officialFormsUnsubscribe = db.collection('officialForms').onSnapshot((snap) => {
    const next = new Map();
    snap.forEach((doc) => { next.set(doc.id, doc.data()); });
    officialForms = next;
    onOfficialFormsChanged();
  }, (err) => {
    // e.g. the rules for this collection aren't deployed yet — there is simply
    // nothing official to show.
    console.warn('officialForms listener error:', err);
    officialForms = new Map();
    onOfficialFormsChanged();
  });
}

function stopWatchingOfficialForms() {
  if (officialFormsUnsubscribe) {
    officialFormsUnsubscribe();
    officialFormsUnsubscribe = null;
  }
  if (officialForms.size > 0) {
    officialForms = new Map();
    onOfficialFormsChanged();
  }
}

// Called from auth.js's formConfig listener (and with null when the team changes
// or the user signs out).
function officialFormsOnTeamConfigs(snap) {
  const next = new Map();
  if (snap) snap.forEach((doc) => { next.set(doc.id, doc.data()); });
  teamConfigDocs = next;
  syncOfficialFormsWatch();
  renderOfficialFormsNotices();
  if (typeof refreshBuilderOfficialBar === 'function') refreshBuilderOfficialBar();
}

// Called from auth.js's refreshActiveTeamData(): the team doc changed, so
// permissions (who may see the notice) may have too.
function onOfficialFormsTeamChanged() {
  syncOfficialFormsWatch();
  renderOfficialFormsNotices();
}

function onOfficialFormsChanged() {
  renderOfficialFormsNotices();
  if (typeof refreshBuilderOfficialBar === 'function') refreshBuilderOfficialBar();
  if (typeof onOfficialFormsChangedForAdmin === 'function') onOfficialFormsChangedForAdmin();
  if (typeof onOfficialFormsChangedForMerge === 'function') onOfficialFormsChangedForMerge();
}

// ====== What is pending ======
// [{ formId, season, formType, version, official, config }] for the ACTIVE
// team: an official form exists, the team has a config for it, and the official
// version is newer than the highest one the team has handled. Newest season
// first, pit before match. A team with NO config for it is not listed (it gets
// a stamped copy when its config is first created). A team whose form already
// EQUALS the official one (same ids, same order, same definitions) has nothing
// to decide, so it is not listed either. That is a display rule only: nothing
// is written (handledVersion / baseVersion stay as they are), and retired
// fields don't matter.
function getPendingOfficialUpdates() {
  const out = [];
  officialForms.forEach((official, formId) => {
    const parsed = parseOfficialFormId(formId);
    const config = teamConfigDocs.get(formId);
    if (!parsed || !config || !Number.isInteger(official.version)) return;
    if (sameFieldLists(config.fields, official.fields)) return;
    if (official.version > (config.handledVersion || 0)) {
      out.push({ formId, season: parsed.season, formType: parsed.formType, version: official.version, official, config });
    }
  });
  out.sort((a, b) => Number(b.season) - Number(a.season) || OFFICIAL_FORM_TYPES.indexOf(a.formType) - OFFICIAL_FORM_TYPES.indexOf(b.formType));
  return out;
}

function officialFormsNoticeVisible() {
  return typeof currentTeamData !== 'undefined' && !!currentTeamData
    && typeof canUserEditTemplates === 'function' && canUserEditTemplates();
}

// ====== The notice (My Team banner + My Account card) ======
const OFFICIAL_NOTICE_CONTAINERS = ['official-forms-notice-myteam', 'official-forms-notice-account'];

// The My Team banner only shows the updates for the season selected in the app
// (the same value the form builder and the forms use, resolveFormConfigSeason());
// one line under it points to My Account when other seasons have updates too.
// The My Account card and the count badge always show ALL of them.
// Re-rendered whenever the selected season changes (see onAppSeasonChangedForOfficialForms).
function renderOfficialFormsNotices() {
  const pending = officialFormsNoticeVisible() ? getPendingOfficialUpdates() : [];
  const selectedSeason = String(typeof resolveFormConfigSeason === 'function' ? resolveFormConfigSeason() : '');
  const forSelectedSeason = pending.filter((item) => item.season === selectedSeason);
  const otherSeasons = new Set(pending.filter((item) => item.season !== selectedSeason).map((item) => item.season));
  OFFICIAL_NOTICE_CONTAINERS.forEach((id) => {
    const container = document.getElementById(id);
    if (!container) return;
    const shown = id === 'official-forms-notice-myteam' ? forSelectedSeason : pending;
    container.textContent = '';
    container.classList.toggle('hidden', shown.length === 0);
    shown.forEach((item) => container.appendChild(buildOfficialNoticeItem(item)));
  });
  const otherLine = document.getElementById('official-forms-other-seasons');
  if (otherLine) {
    otherLine.classList.toggle('hidden', otherSeasons.size === 0);
    otherLine.textContent = otherSeasons.size === 0 ? ''
      : `${otherSeasons.size === 1 ? 'Another season also has' : `${otherSeasons.size} other seasons also have`} a new official form. See My Account.`;
  }
  // The My Account card also stays up while a result line is showing (the
  // notice itself is gone once its action finished).
  const card = document.getElementById('official-forms-account-card');
  const resultShowing = ['error', 'success'].some((kind) => {
    const el = document.getElementById(`official-forms-account-${kind}`);
    return !!(el && el.textContent);
  });
  if (card) card.classList.toggle('hidden', pending.length === 0 && !(resultShowing && officialFormsNoticeVisible()));
  const badge = document.getElementById('official-forms-nav-badge-header');
  if (badge) {
    badge.textContent = String(pending.length);
    badge.classList.toggle('hidden', pending.length === 0);
  }
}

function buildOfficialNoticeItem(item) {
  const root = document.createElement('div');
  root.className = 'official-notice-item';
  root.dataset.formId = item.formId;
  root.dataset.formType = item.formType;

  const title = document.createElement('p');
  title.className = 'official-notice-title';
  title.textContent = `The ${officialFormTypeWord(item.formType)} scouting form has a new official version`;
  root.appendChild(title);

  const detail = document.createElement('p');
  detail.className = 'help-text official-notice-detail';
  const based = item.config.baseVersion == null ? 'Your form is not based on an official version' : `Your form is based on official version ${item.config.baseVersion}`;
  detail.textContent = `${officialFormSeasonLabel(item.season)} · official version ${item.version}. ${based}.`;
  root.appendChild(detail);

  const actions = document.createElement('div');
  actions.className = 'official-notice-actions';
  [
    ['accept', 'Accept new form', 'btn btn-small btn-primary', () => acceptOfficialForm(item.season, item.formType)],
    ['merge', 'Merge', 'btn btn-small btn-outline', () => openOfficialFormMerge(item.season, item.formType)],
    ['keep', 'Keep my form', 'btn btn-small btn-outline', () => keepMyForm(item.season, item.formType)],
    ['view', 'View official form', 'btn btn-small btn-outline', () => openOfficialFormViewer(item.season, item.formType)]
  ].forEach(([key, label, cls, handler]) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = cls;
    btn.dataset.officialAction = key;
    btn.textContent = label;
    btn.addEventListener('click', handler);
    actions.appendChild(btn);
  });
  root.appendChild(actions);
  return root;
}

// Success / error line shown next to the notice (both places; auto-clears).
function setOfficialFormsStatus(kind, message) {
  ['official-forms-myteam', 'official-forms-account'].forEach((prefix) => {
    if (typeof setStatusMessage === 'function') setStatusMessage(prefix, kind, message);
  });
  // The account card's visibility follows its result line (see
  // renderOfficialFormsNotices()): re-evaluate now and when the line clears.
  renderOfficialFormsNotices();
  setTimeout(renderOfficialFormsNotices, 5200);
}

// ====== Comparing forms ======
// Field-level helpers shared by Accept, Merge and the viewer.
function normalizedFieldForCompare(field) {
  const out = {};
  const source = { ...(field || {}) };
  // A counter's old "starting value" (defaultValue) is read as its assumed value, so a field with
  // defaultValue X and one with assumedValue X are the same field (assumedValue wins when both exist).
  if ('defaultValue' in source) {
    const blank = source.assumedValue === undefined || source.assumedValue === null || source.assumedValue === '';
    if (blank) source.assumedValue = source.defaultValue;
    delete source.defaultValue;
  }
  Object.keys(source).forEach((key) => {
    if (key === 'sortOrder') return;
    const value = source[key];
    if (value === undefined || value === null || value === '') return;
    // Assumed value 0 is the default (an absent key means 0).
    if (key === 'assumedValue' && Number(value) === 0) return;
    // Absent means the default, so a default value and an absent key are the same field.
    if (key === 'showInPreview' && value !== false) return;
    if ((key === 'required' || key === 'multi' || key === 'stopwatch') && value === false) return;
    out[key] = value;
  });
  return out;
}

function sameFieldDefinition(a, b) {
  return JSON.stringify(sortedKeysCopy(normalizedFieldForCompare(a))) === JSON.stringify(sortedKeysCopy(normalizedFieldForCompare(b)));
}

// Same ids in the same order with the same definitions (sortOrder values
// themselves don't matter, only the order they give).
function sameFieldLists(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  const sa = sortFormFields(a);
  const sb = sortFormFields(b);
  return sa.every((field, i) => !!field && !!sb[i] && field.id === sb[i].id && sameFieldDefinition(field, sb[i]));
}

function sortedKeysCopy(obj) {
  const out = {};
  Object.keys(obj).sort().forEach((key) => { out[key] = obj[key]; });
  return out;
}

const FIELD_PROPERTY_LABELS = {
  label: 'Label', type: 'Type', required: 'Required', options: 'Options', showInPreview: 'Show in preview',
  multi: 'Multiple selections', min: 'Counter settings', max: 'Counter settings', step: 'Counter settings',
  defaultValue: 'Counter settings', assumedValue: 'Counter settings', stopwatch: 'Stopwatch'
};

// Human names of the properties that differ between two definitions of one field.
function describeFieldDifferences(a, b) {
  const na = normalizedFieldForCompare(a);
  const nb = normalizedFieldForCompare(b);
  const names = new Set();
  new Set([...Object.keys(na), ...Object.keys(nb)]).forEach((key) => {
    if (key === 'id') return;
    if (JSON.stringify(na[key]) !== JSON.stringify(nb[key])) names.add(FIELD_PROPERTY_LABELS[key] || key);
  });
  return Array.from(names);
}

const FIELD_TYPE_LABELS = {
  dropdown: 'Dropdown', text: 'Short text', number: 'Number', counter: 'Counter', textarea: 'Long text', buttonGroup: 'Button group'
};

// One readable line for a field definition ("Dropdown · Required · Options: A, B").
function describeFieldDefinition(field) {
  const parts = [FIELD_TYPE_LABELS[field.type] || field.type || 'Field'];
  if (field.required) parts.push('Required');
  if (field.type === 'buttonGroup' && field.multi) parts.push('Multiple selections');
  if (Array.isArray(field.options) && field.options.length > 0) parts.push(`Options: ${field.options.join(', ')}`);
  if (field.type === 'counter') {
    const assumed = counterAssumedValue(field);
    parts.push(`Range ${field.min ?? 0}${field.max != null ? `-${field.max}` : '+'}, step ${field.step ?? 1}${assumed !== 0 ? `, assumed ${assumed}` : ''}`);
  }
  if (field.stopwatch) parts.push('Stopwatch');
  parts.push(field.showInPreview === false ? 'Not in preview' : 'In preview');
  return parts.join(' · ');
}

// Retiring: an Accept removes fields; their definitions go to retiredFields so
// old entries can still show them. A retired id that is on the new form again
// is dropped from the list; a re-retired id takes the newer definition.
function computeRetiredFields(previousFields, previousRetired, newFields) {
  const newIds = new Set(newFields.map((f) => f.id));
  const removed = previousFields.filter((f) => !newIds.has(f.id)).map((f) => ({ ...f }));
  const removedIds = new Set(removed.map((f) => f.id));
  const kept = (previousRetired || []).filter((f) => f && !newIds.has(f.id) && !removedIds.has(f.id));
  return [...kept, ...removed];
}

function renumberFields(fields) {
  return fields.map((field, index) => ({ ...field, sortOrder: index }));
}

// ====== Merge calculation (by field id) ======
// Fields only on the official form are ADDED (placed after the field that
// precedes them on the official form, else first); fields only on the team's
// form are KEPT; fields on both that differ become a per-field choice
// (choices[id] = 'mine' | 'official', default 'mine'); equal fields are
// untouched. Nothing is ever removed. Added fields that would push the preview
// past the cap are added with "Show in preview" off (the team's own fields are
// never touched).
function classifyMerge(teamFields, officialFields) {
  const teamById = new Map(teamFields.map((f) => [f.id, f]));
  const officialById = new Map(officialFields.map((f) => [f.id, f]));
  return {
    added: officialFields.filter((f) => !teamById.has(f.id)),
    kept: teamFields.filter((f) => !officialById.has(f.id)),
    different: teamFields.filter((f) => officialById.has(f.id) && !sameFieldDefinition(f, officialById.get(f.id)))
      .map((f) => ({ id: f.id, mine: f, official: officialById.get(f.id), differences: describeFieldDifferences(f, officialById.get(f.id)) })),
    same: teamFields.filter((f) => officialById.has(f.id) && sameFieldDefinition(f, officialById.get(f.id)))
  };
}

function computeMergedFields(teamFields, officialFields, choices) {
  const plan = classifyMerge(teamFields, officialFields);
  const officialById = new Map(officialFields.map((f) => [f.id, f]));
  const merged = teamFields.map((f) => ((choices || {})[f.id] === 'official' && officialById.has(f.id) ? { ...officialById.get(f.id) } : { ...f }));

  const addedIds = new Set(plan.added.map((f) => f.id));
  let previewCount = merged.filter((f) => f.showInPreview !== false).length;
  officialFields.forEach((officialField, index) => {
    if (!addedIds.has(officialField.id)) return;
    const added = { ...officialField };
    let anchor = -1;
    for (let i = index - 1; i >= 0 && anchor < 0; i--) {
      anchor = merged.findIndex((f) => f.id === officialFields[i].id);
    }
    merged.splice(anchor + 1, 0, added);
  });
  // Cap the preview: only ever by switching OFF fields this merge added.
  const cap = typeof PREVIEW_FIELD_CAP === 'number' ? PREVIEW_FIELD_CAP : 6;
  previewCount = merged.filter((f) => f.showInPreview !== false).length;
  for (let i = merged.length - 1; i >= 0 && previewCount > cap; i--) {
    if (addedIds.has(merged[i].id) && merged[i].showInPreview !== false) {
      merged[i] = { ...merged[i], showInPreview: false };
      previewCount -= 1;
    }
  }
  return renumberFields(merged);
}

// ====== The transaction behind Accept / Merge / Restore ======
class OfficialFormError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function formConfigRefFor(teamId, season, formType) {
  return db.collection('teams').doc(teamId).collection('formConfig').doc(officialFormId(season, formType));
}

function formCachesInvalidate(teamId, season) {
  if (typeof invalidateFormConfigCache === 'function') invalidateFormConfigCache(teamId, season);
  if (typeof invalidateMatchFormConfigCache === 'function') invalidateMatchFormConfigCache(teamId, season);
}

// Replaces the active team's form and saves the old one, atomically.
//   computeNext(current) -> { fields, retiredFields, baseVersion, handledVersion }
//   basisJson   (merge) the team's fields as they were when the screen opened;
//               if they differ now, nothing is written ('changed').
// Resolves true when something was written (and a snapshot saved).
async function replaceTeamForm({ teamId, season, formType, action, appliedVersion, computeNext, basisJson }) {
  const configRef = formConfigRefFor(teamId, season, formType);
  const snapshotRef = db.collection('teams').doc(teamId).collection('formSnapshots').doc();
  const uid = currentUser.uid;
  const displayName = typeof getCurrentUserDisplayName === 'function' ? getCurrentUserDisplayName() : (currentUser.email || 'Unknown');

  const wrote = await db.runTransaction(async (tx) => {
    const snap = await tx.get(configRef);
    if (!snap.exists) throw new OfficialFormError('missing', 'This form no longer has a saved configuration.');
    const current = formConfigFromDocData(snap.data(), String(season));
    if (basisJson != null && JSON.stringify(current.fields.map(normalizedFieldForCompare)) !== basisJson) {
      throw new OfficialFormError('changed', 'Your form changed while this was open.');
    }
    const next = computeNext(current);
    const unchanged = JSON.stringify(current.fields.map(normalizedFieldForCompare)) === JSON.stringify(next.fields.map(normalizedFieldForCompare))
      && JSON.stringify(current.retiredFields) === JSON.stringify(next.retiredFields);
    if (!unchanged) {
      tx.set(snapshotRef, {
        season: String(season),
        formType,
        formKey: officialFormId(season, formType),
        fields: current.fields,
        retiredFields: current.retiredFields,
        baseVersion: current.baseVersion,
        handledVersion: current.handledVersion,
        appliedVersion: appliedVersion == null ? null : appliedVersion,
        action,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        createdBy: uid,
        createdByName: displayName
      });
    }
    tx.set(configRef, {
      fields: next.fields,
      retiredFields: next.retiredFields,
      baseVersion: next.baseVersion,
      handledVersion: next.handledVersion
    });
    return !unchanged;
  });

  formCachesInvalidate(teamId, String(season));
  if (wrote) pruneFormSnapshots(teamId, season, formType);
  if (typeof onTeamFormReplacedForBuilder === 'function') onTeamFormReplacedForBuilder();
  return wrote;
}

async function pruneFormSnapshots(teamId, season, formType) {
  try {
    const snaps = await listFormSnapshots(teamId, season, formType);
    for (const old of snaps.slice(FORM_SNAPSHOT_KEEP)) await old.ref.delete();
  } catch (err) {
    console.warn('Could not prune old form snapshots:', err);
  }
}

// Newest first. Single-field query (no composite index), sorted here.
async function listFormSnapshots(teamId, season, formType) {
  const snap = await db.collection('teams').doc(teamId).collection('formSnapshots')
    .where('formKey', '==', officialFormId(season, formType)).get();
  const millis = (doc) => { const t = doc.data().createdAt; return t && typeof t.toMillis === 'function' ? t.toMillis() : 0; };
  return snap.docs.sort((a, b) => millis(b) - millis(a));
}

function describeOfficialFormErrorForUser(err) {
  if (err instanceof OfficialFormError) {
    if (err.code === 'changed') return 'Your form changed while this was open, so nothing was saved. Open Merge again to see the current form.';
    return `${err.message} Nothing was saved.`;
  }
  if (err && err.code === 'permission-denied') return 'You do not have permission to change this form. Nothing was saved.';
  return 'Could not save. Nothing was changed. Check your connection and try again.';
}

// ====== Keep my form ======
// Marks the official version handled with NO change to the form. The official
// form stays viewable / mergeable / acceptable from the form builder.
async function keepMyForm(season, formType, versionOverride) {
  const teamId = currentTeamData && currentTeamData.id;
  const official = officialForms.get(officialFormId(season, formType));
  const version = versionOverride != null ? versionOverride : (official && official.version);
  if (!teamId || !Number.isInteger(version)) return false;
  const ref = formConfigRefFor(teamId, season, formType);
  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new OfficialFormError('missing', 'This form no longer has a saved configuration.');
      // Never lowers the number (another editor may have handled a newer one).
      tx.update(ref, { handledVersion: Math.max(version, snap.data().handledVersion || 0) });
    });
    formCachesInvalidate(teamId, String(season));
    setOfficialFormsStatus('success', `Keeping your ${officialFormTypeWord(formType)} scouting form. The official form stays under Edit Scouting Forms.`);
    return true;
  } catch (err) {
    console.error('Keep my form failed:', err);
    setOfficialFormsStatus('error', describeOfficialFormErrorForUser(err));
    return false;
  }
}

// ====== Accept ======
// The version captured here — when the confirm OPENS — is what gets recorded,
// whatever is published while the confirm is up. officialFormActionBusy is true
// only while a write (or the load before one) is actually running, so a double
// click can't start two; it is never held across a confirm the user can walk away from.
let officialFormActionBusy = false;

async function acceptOfficialForm(season, formType, captured) {
  const teamId = currentTeamData && currentTeamData.id;
  const official = captured || officialForms.get(officialFormId(season, formType));
  if (!teamId || !official || officialFormActionBusy) return;

  let current;
  officialFormActionBusy = true;
  try {
    current = await loadTeamFormConfigFresh(teamId, season, formType);
  } catch (err) {
    setOfficialFormsStatus('error', describeOfficialFormErrorForUser(err));
    return;
  } finally {
    officialFormActionBusy = false;
  }
  const officialFields = renumberFields(sortFormFields(official.fields));
  const plan = classifyMerge(current.fields, officialFields);
  const removed = plan.kept.length;
  const word = officialFormTypeWord(formType);
  const message = `Your ${officialFormSeasonLabel(season)} ${word} scouting form will be replaced by official version ${official.version}`
    + ` (${plan.added.length} field${plan.added.length === 1 ? '' : 's'} added, ${removed} removed, ${plan.different.length} changed).`
    + ' Your current form is saved first: Edit Scouting Forms > Restore previous form puts it back.'
    + ' Entries already scouted keep all their data'
    + (removed > 0 ? '; a removed field stays visible on the old entries that have a value in it, marked as a deleted field.' : '.');
  showConfirmModal({
    title: `Accept the new ${word} scouting form?`,
    message,
    confirmLabel: 'Accept new form',
    onConfirm: async () => {
      if (officialFormActionBusy) return;
      officialFormActionBusy = true;
      showLoading('Replacing your form...');
      try {
        await replaceTeamForm({
          teamId, season, formType, action: 'accept', appliedVersion: official.version,
          computeNext: (cur) => ({
            fields: officialFields,
            retiredFields: computeRetiredFields(cur.fields, cur.retiredFields, officialFields),
            baseVersion: official.version,
            handledVersion: official.version
          })
        });
        hideLoading();
        setOfficialFormsStatus('success', `Your ${word} scouting form is now official version ${official.version}. The previous form was saved (Restore previous form).`);
      } catch (err) {
        hideLoading();
        console.error('Accept official form failed:', err);
        setOfficialFormsStatus('error', describeOfficialFormErrorForUser(err));
      } finally {
        officialFormActionBusy = false;
      }
    }
  });
}

// The team's current config read straight from Firestore (not the cache): what
// Accept / Merge decide on must be what is really saved.
async function loadTeamFormConfigFresh(teamId, season, formType) {
  const snap = await formConfigRefFor(teamId, season, formType).get();
  if (!snap.exists) throw new OfficialFormError('missing', 'This form no longer has a saved configuration.');
  return formConfigFromDocData(snap.data(), String(season));
}

// ====== Restore previous form ======
async function restorePreviousForm(season, formType) {
  const teamId = currentTeamData && currentTeamData.id;
  if (!teamId || officialFormActionBusy) return;
  let snaps;
  try {
    snaps = await listFormSnapshots(teamId, season, formType);
  } catch (err) {
    setBuilderOfficialStatus('error', 'Could not look for a previous form. Check your connection and try again.');
    return;
  }
  if (snaps.length === 0) {
    setBuilderOfficialStatus('error', 'There is no previous form to restore for this season yet.');
    return;
  }
  const snapDoc = snaps[0];
  const data = snapDoc.data();
  const when = formatOfficialFormDate(data.createdAt);
  const actionWord = { accept: 'accepting the official form', merge: 'merging the official form', restore: 'a restore' }[data.action] || 'a change';
  showConfirmModal({
    title: 'Restore previous form?',
    message: `Your ${officialFormSeasonLabel(season)} ${officialFormTypeWord(formType)} scouting form goes back to the one saved${when ? ` on ${when}` : ''} before ${actionWord}`
      + `${data.createdByName ? ` by ${data.createdByName}` : ''}. The form you have now is saved first. Scouted entries are not changed.`,
    confirmLabel: 'Restore',
    onConfirm: async () => {
      if (officialFormActionBusy) return;
      officialFormActionBusy = true;
      showLoading('Restoring...');
      try {
        await replaceTeamForm({
          teamId, season, formType, action: 'restore', appliedVersion: null,
          computeNext: (cur) => ({
            fields: renumberFields(sortFormFields(data.fields)),
            retiredFields: Array.isArray(data.retiredFields) ? data.retiredFields : [],
            baseVersion: data.baseVersion == null ? null : data.baseVersion,
            // Restoring a form is not a new decision about the official version.
            handledVersion: cur.handledVersion
          })
        });
        hideLoading();
        setBuilderOfficialStatus('success', 'Previous form restored.');
      } catch (err) {
        hideLoading();
        console.error('Restore previous form failed:', err);
        setBuilderOfficialStatus('error', describeOfficialFormErrorForUser(err));
      } finally {
        officialFormActionBusy = false;
      }
    }
  });
}

function setBuilderOfficialStatus(kind, message) {
  if (typeof setStatusMessage === 'function') setStatusMessage('builder', kind, message);
}

// ====== The official form viewer (read-only) ======
// Shows the LATEST official version for a season + form type with Accept /
// Merge. Used by the notice's "View official form" and by the form builder's
// "Official form" button, so a team that kept its own form can always come back.
let officialViewerState = null; // { season, formType, official }

function openOfficialFormViewer(season, formType) {
  const official = officialForms.get(officialFormId(season, formType));
  if (!official) {
    setBuilderOfficialStatus('error', 'There is no official form for this season yet.');
    return;
  }
  officialViewerState = { season: String(season), formType, official: { ...official, fields: sortFormFields(official.fields) } };
  renderOfficialFormViewer();
  document.getElementById('official-form-view-modal').classList.remove('hidden');
}

function closeOfficialFormViewer() {
  officialViewerState = null;
  const modal = document.getElementById('official-form-view-modal');
  if (modal) modal.classList.add('hidden');
}

function renderOfficialFormViewer() {
  const state = officialViewerState;
  if (!state) return;
  const { season, formType, official } = state;
  const config = teamConfigDocs.get(officialFormId(season, formType));
  const word = officialFormTypeWord(formType);
  document.getElementById('official-view-title').textContent = `Official ${word} scouting form`;
  const published = formatOfficialFormDate(official.publishedAt);
  document.getElementById('official-view-info').textContent =
    `${officialFormSeasonLabel(season)} · official version ${official.version}${published ? ` · published ${published}` : ''}`;
  let status = '';
  if (!config) status = 'Your team has no saved form for this season yet.';
  else if (config.baseVersion == null) status = `Your form is not based on an official version${(config.handledVersion || 0) >= official.version ? ' (you chose to keep it)' : ''}.`;
  else status = `Your form is based on official version ${config.baseVersion}${(config.handledVersion || 0) >= official.version && config.baseVersion < official.version ? ' (you chose to keep it)' : ''}.`;
  document.getElementById('official-view-status').textContent = status;
  const list = document.getElementById('official-view-fields');
  list.textContent = '';
  official.fields.forEach((field) => list.appendChild(buildReadOnlyFieldRow(field)));
  const canAct = !!config && officialFormsNoticeVisible();
  document.getElementById('btn-official-view-accept').classList.toggle('hidden', !canAct);
  document.getElementById('btn-official-view-merge').classList.toggle('hidden', !canAct);
}

// ====== How the team's form differs from the official one (display only) ======
// Same logic as the admin "See what changed" (describeDraftChanges(), official-form-admin.js, which uses
// classifyMerge()): the OFFICIAL form is the starting point and the team's form plays "the draft", so
//   changed  = on both, different definition (what differs is named)
//   moved    = on both, same definition, out of place (the longest in-order run stays "unmoved")
//   removed  = on the official form, NOT on the team's form
//   added    = on the team's form only
// A field that is both changed and moved counts once, as changed.
function summarizeFormDifferences(teamFields, officialFields) {
  const { rows, added } = describeDraftChanges(sortFormFields(officialFields), sortFormFields(teamFields));
  const statuses = rows.map((row) => {
    if (row.removed) return 'removed';
    if (row.differences.length > 0) return 'changed';
    return row.moved ? 'moved' : 'unchanged';
  });
  const count = (status) => statuses.filter((s) => s === status).length;
  const counts = { changed: count('changed'), added: added.length, removed: count('removed'), moved: count('moved'), unchanged: count('unchanged') };
  const total = counts.changed + counts.added + counts.removed + counts.moved;
  const list = ['changed', 'added', 'removed', 'moved'].filter((k) => counts[k] > 0).map((k) => `${counts[k]} ${k}`).join(', ');
  return { rows, added, statuses, counts, total, sentence: total > 0 ? `${total} difference${total === 1 ? '' : 's'}: ${list}` : '' };
}

function buildFormDifferenceRow(field, status, text) {
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

// Read-only popup: the official form's fields with their status on the team's form, then the fields the team
// added. Nothing is written and nothing here can change the form.
function openFormDifferences() {
  const formId = officialFormId(currentBuilderSeason, currentFormBuilderType);
  const official = officialForms.get(formId);
  const config = teamConfigDocs.get(formId);
  if (!official || !config) return;
  const diff = summarizeFormDifferences(config.fields, official.fields);
  const word = officialFormTypeWord(currentFormBuilderType);
  document.getElementById('form-diff-title').textContent = `How your ${word} form differs`;
  document.getElementById('form-diff-info').textContent =
    `${officialFormSeasonLabel(currentBuilderSeason)} · your form compared with official version ${official.version}. Nothing here changes your form.`;
  const summary = [['changed', 'changed'], ['moved', 'moved'], ['removed', 'removed'], ['added', 'added'], ['unchanged', 'unchanged']]
    .filter(([key]) => diff.counts[key] > 0).map(([key, label]) => `${diff.counts[key]} ${label}`).join(', ');
  document.getElementById('form-diff-summary').textContent = summary || 'No differences.';
  const teamIndex = new Map(sortFormFields(config.fields).map((f, i) => [f.id, i + 1]));
  const list = document.getElementById('form-diff-list');
  list.textContent = '';
  diff.rows.forEach((row, i) => {
    const status = diff.statuses[i];
    let text = 'Same on your form';
    if (status === 'removed') text = 'Removed on your form (not on your form)';
    else if (status === 'changed') text = `Changed on your form: ${row.differences.join(', ')}${row.moved ? ` · Moved (position ${row.position} on your form)` : ''}`;
    else if (status === 'moved') text = `Moved on your form (position ${row.position})`;
    list.appendChild(buildFormDifferenceRow(row.field, status, text));
  });
  if (diff.added.length > 0) {
    const head = document.createElement('h4');
    head.className = 'admin-change-heading';
    head.textContent = 'Fields you added';
    list.appendChild(head);
    diff.added.forEach((item) => list.appendChild(buildFormDifferenceRow(item.field, 'added', `Added by you (position ${teamIndex.get(item.field.id) || item.position})`)));
  }
  document.getElementById('form-differences-modal').classList.remove('hidden');
}

function closeFormDifferences() {
  const modal = document.getElementById('form-differences-modal');
  if (modal) modal.classList.add('hidden');
}

function buildReadOnlyFieldRow(field) {
  const item = document.createElement('div');
  item.className = 'builder-field-item builder-field-item--readonly';
  const summary = document.createElement('div');
  summary.className = 'builder-field-summary';
  const label = document.createElement('span');
  label.className = 'builder-field-label';
  label.textContent = field.label;
  const meta = document.createElement('span');
  meta.className = 'builder-field-meta';
  meta.textContent = describeFieldDefinition(field);
  summary.appendChild(label);
  summary.appendChild(meta);
  item.appendChild(summary);
  return item;
}

// ====== Wiring ======
// The app's season selector changed (a user pick, or a restore that sets it without
// an event: first-api.js, session-state.js, team.js call this).
function onAppSeasonChangedForOfficialForms() {
  renderOfficialFormsNotices();
}

document.addEventListener('DOMContentLoaded', () => {
  const on = (id, evt, fn) => { const el = document.getElementById(id); if (el) el.addEventListener(evt, fn); };
  on('select-season', 'change', onAppSeasonChangedForOfficialForms);
  on('btn-builder-official-differences', 'click', openFormDifferences);
  on('btn-form-diff-close', 'click', closeFormDifferences);
  on('btn-form-diff-close-inline', 'click', closeFormDifferences);
  on('form-differences-modal-overlay', 'click', closeFormDifferences);
  on('btn-official-view-close', 'click', closeOfficialFormViewer);
  on('btn-official-view-close-inline', 'click', closeOfficialFormViewer);
  on('official-form-view-modal-overlay', 'click', closeOfficialFormViewer);
  on('btn-official-view-accept', 'click', () => {
    const state = officialViewerState;
    if (!state) return;
    closeOfficialFormViewer();
    acceptOfficialForm(state.season, state.formType, state.official);
  });
  on('btn-official-view-merge', 'click', () => {
    const state = officialViewerState;
    if (!state) return;
    closeOfficialFormViewer();
    openOfficialFormMerge(state.season, state.formType, state.official);
  });
});
