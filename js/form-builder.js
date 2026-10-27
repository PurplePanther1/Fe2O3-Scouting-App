// ====== Pit & Match Scouting Form Builder (Captain only) ======
// Allows team captains to add, remove, reorder, and edit fields
// in the pit scouting or match scouting form configuration.
// Config stored in: teams/{teamId}/formConfig/{season}_pitScouting or {season}_matchScouting
// (dynamic-form.js). The builder always edits whichever season the app's
// global season selector currently shows (same convention as events/teams
// elsewhere) — there's no separate season picker inside the builder itself.

// ====== Current form type being edited ======
let currentFormBuilderType = 'pitScouting'; // 'pitScouting' or 'matchScouting'

// ====== Season the builder is currently editing — resolved once when the
// builder opens (see openFormBuilder()), from resolveFormConfigSeason()
// (dynamic-form.js), which defaults to the app's currently-selected season. ======
let currentBuilderSeason = null;

// ====== Max fields allowed in the entry preview line at once (per form type
// — pit and match each get their own budget), so the Team Detail card's
// preview can't be configured into unreadable clutter. ======
const PREVIEW_FIELD_CAP = 6;

// ====== Field type options ======
const FIELD_TYPES = [
  { value: 'dropdown', label: 'Dropdown (select one)' },
  { value: 'text', label: 'Short Text' },
  { value: 'number', label: 'Number' },
  { value: 'counter', label: 'Counter (+/-)' },
  { value: 'textarea', label: 'Long Text / Notes' },
  { value: 'buttonGroup', label: 'Button Group' }
];

// ====== Which form the builder edits ======
// 'team' (the default) edits the team's own form, teams/{teamId}/formConfig, and
// every change is saved at once. 'admin' is the same screen and the same field
// editor pointed at an unpublished DRAFT of an official form
// (official-form-admin.js): nothing is saved until the admin presses Publish,
// and no team is needed.
let builderMode = 'team';

function builderTeamId() {
  return builderMode === 'admin' ? 'admin' : currentTeamData?.id;
}

// ====== Open the form builder ======
async function openFormBuilder(type) {
  builderMode = 'team';
  currentFormBuilderType = type || 'pitScouting';
  currentBuilderSeason = resolveFormConfigSeason();

  const teamId = currentTeamData?.id;
  if (!teamId) {
    if (typeof showNoticeModal === 'function') {
      showNoticeModal({ title: 'Team Not Loaded', message: 'Team data not loaded.' });
    }
    return;
  }

  // Verify template editing permission (captain or canEditTemplates permission)
  const canEdit = typeof canUserEditTemplates === 'function' ? canUserEditTemplates() : (currentTeamRoles && currentTeamRoles[currentUser?.uid] === 'captain');
  if (!canEdit) {
    if (typeof showNoticeModal === 'function') {
      showNoticeModal({ title: 'Permission Denied', message: 'You do not have permission to edit the form configuration.' });
    }
    return;
  }

  populateBuilderSeasonSelect();
  document.getElementById('builder-modal').classList.remove('hidden');
  await applyBuilderSeasonAndType(teamId);
}

// ====== Open the same builder on an official-form draft (the Admin screen,
// official-form-admin.js). ======
async function openBuilderInAdminMode(type, season) {
  builderMode = 'admin';
  currentFormBuilderType = type || 'pitScouting';
  populateBuilderSeasonSelect();
  currentBuilderSeason = String(season || getCurrentFtcSeason());
  document.getElementById('builder-modal').classList.remove('hidden');
  await applyBuilderSeasonAndType(builderTeamId());
}

// ====== Switch builder type tab — preserves whatever season is currently
// selected (see the season <select>'s own change handler below); only the
// type changes here, unlike a fresh openFormBuilder() call which always
// resets to the app's globally-selected season. ======
function switchBuilderType(type) {
  if (type === currentFormBuilderType) return;
  currentFormBuilderType = type;
  const teamId = builderTeamId();
  if (!teamId) return;
  applyBuilderSeasonAndType(teamId);
}

// ====== Shared refresh: title, season label/select, type-tab active state,
// status message, and the field list itself — for whatever
// currentBuilderSeason/currentFormBuilderType currently are. Used by both a
// fresh open (after its own permission check/modal-show) and every
// in-builder season or type switch (which skip those, the modal's already
// open). ======
async function applyBuilderSeasonAndType(teamId) {
  const title = currentFormBuilderType === 'matchScouting' ? 'Match Scouting Form Builder' : 'Pit Scouting Form Builder';
  document.getElementById('builder-modal-title').textContent = builderMode === 'admin' ? `Admin: Official ${title}` : title;
  // Team mode shows the "Official form" bar; admin mode shows the publish panel
  // instead (and its own help text).
  const isAdmin = builderMode === 'admin';
  document.getElementById('builder-help-team').classList.toggle('hidden', isAdmin);
  document.getElementById('builder-help-admin').classList.toggle('hidden', !isAdmin);
  document.getElementById('builder-official-bar').classList.toggle('hidden', isAdmin);
  document.getElementById('builder-admin-panel').classList.toggle('hidden', !isAdmin);
  // The admin's version history belongs to one season + type: closed again on any switch / reopen.
  document.getElementById('admin-history-list').classList.add('hidden');

  const seasonSelect = document.getElementById('builder-season-select');
  if (seasonSelect) seasonSelect.value = currentBuilderSeason;

  document.querySelectorAll('.builder-type-tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.builderType === currentFormBuilderType);
  });

  // builder-modal stays open across multiple field edits (unlike pit-modal/
  // match-modal, which close on save) — its error/success messages use the
  // same auto-clearing helper sheets-export.js's export flows already do
  // (setStatusMessage/clearStatusMessage), rather than sitting there
  // indefinitely until the next edit happens to touch them.
  if (typeof clearStatusMessage === 'function') clearStatusMessage('builder');

  await renderBuilderFields(teamId);
  if (isAdmin) {
    if (typeof refreshAdminPanel === 'function') refreshAdminPanel();
  } else {
    refreshBuilderOfficialBar();
  }
}

// ====== The "Official form" bar (team mode): what the latest official form
// for this season + type is, how the team's form relates to it, and the two
// actions that are always available — view the official form (and Accept / Merge
// from there) and restore the previous form. Kept live by official-forms.js's
// listeners. ======
function builderModalIsOpen() {
  return !document.getElementById('builder-modal').classList.contains('hidden');
}

let builderOfficialBarToken = 0;
async function refreshBuilderOfficialBar() {
  if (builderMode !== 'team' || !builderModalIsOpen()) return;
  const token = ++builderOfficialBarToken;
  const formId = officialFormId(currentBuilderSeason, currentFormBuilderType);
  const official = officialForms.get(formId);
  const config = teamConfigDocs.get(formId);
  const textEl = document.getElementById('builder-official-text');
  const viewBtn = document.getElementById('btn-builder-official-view');
  const diffBtn = document.getElementById('btn-builder-official-differences');
  const sameAsOfficial = !!(official && config && sameFieldLists(config.fields, official.fields));
  let text;
  if (!official) {
    text = 'No official form has been published for this season and form type.';
  } else if (sameAsOfficial) {
    // Display only (nothing is written): the team's fields already ARE the official form.
    text = `Your form matches official version ${official.version}.`;
  } else {
    // Differs: say how, with the same comparison the admin "See what changed" uses (never "based on the latest" when it differs).
    const diff = config ? summarizeFormDifferences(config.fields, official.fields) : null;
    const withDiff = diff && diff.total > 0 ? `, with ${diff.sentence}` : '';
    if (!config || config.baseVersion == null) {
      text = `Official version ${official.version} is available. Your form is not based on an official version${withDiff}.`;
    } else if (config.baseVersion >= official.version) {
      text = `Your form is based on official version ${config.baseVersion}${withDiff}.`;
    } else {
      text = `Official version ${official.version} is available. Your form is based on version ${config.baseVersion}${withDiff}.`;
    }
  }
  if (official && config && !sameAsOfficial && (config.handledVersion || 0) >= official.version && config.baseVersion !== official.version) {
    text += ' You chose to keep your own form for this version.';
  }
  textEl.textContent = text;
  viewBtn.disabled = !official;
  // "See differences" only when there is something to see.
  if (diffBtn) diffBtn.classList.toggle('hidden', !(official && config && !sameAsOfficial));

  // Restore previous form: only offered when there is something to restore.
  const restoreBtn = document.getElementById('btn-builder-restore-previous');
  restoreBtn.classList.add('hidden');
  try {
    const snaps = await listFormSnapshots(currentTeamData.id, currentBuilderSeason, currentFormBuilderType);
    if (token === builderOfficialBarToken && builderMode === 'team') restoreBtn.classList.toggle('hidden', snaps.length === 0);
  } catch (err) {
    console.warn('Could not look for previous forms:', err);
  }
}

// After Accept / Merge / Restore replaced the team's form: re-read it into the
// open builder.
function onTeamFormReplacedForBuilder() {
  if (builderMode === 'team' && builderModalIsOpen() && currentTeamData?.id) {
    renderBuilderFields(currentTeamData.id).then(refreshBuilderOfficialBar);
  }
}

// ====== Populate the in-builder season <select> — same fixed year range
// (current season down to current-8, floor 2020) and label/game-name
// convention as the app's main #select-season (populateSeasonDropdown(),
// first-api.js), independently built rather than sharing that function's own
// loop — same convention ftcscout.js's populateAwardsSeasonSelect() already
// follows for ITS own independent season <select>. Rebuilt every open (not
// just once) so a season that only just gained game-name data, or a newly
// rolled-over current season, is always reflected. ======
function populateBuilderSeasonSelect() {
  const select = document.getElementById('builder-season-select');
  if (!select) return;
  select.innerHTML = '';

  const current = getCurrentFtcSeason();
  const startYear = Math.max(current - 8, 2020);

  for (let y = current; y >= startYear; y--) {
    const option = document.createElement('option');
    option.value = y;
    option.textContent = current === y ? `${formatFtcSeasonLabel(y)} (current)` : formatFtcSeasonLabel(y);
    select.appendChild(option);
    if (typeof ensureSeasonGameNameLoaded === 'function') ensureSeasonGameNameLoaded(y);
  }
}

// ====== Get the current season-scoped config doc ID ======
function getBuilderConfigDocId() {
  return `${currentBuilderSeason}_${currentFormBuilderType}`;
}

// ====== Get the current cached config (fields array only) ======
//
// The list is the one the builder last RENDERED (builderShown), falling back to
// the shared form-config cache. The cache can't be relied on alone: the live
// formConfig listener (auth.js) empties it on every change to the team's
// config docs — including the builder's own writes — and an edit made against
// an emptied cache would save a one-field list over the whole form.
let builderShown = null; // { key, fields }
function builderShownKey() {
  return `${builderMode}|${currentTeamData?.id}|${currentBuilderSeason}|${currentFormBuilderType}`;
}

function getBuilderCachedConfig() {
  if (builderMode === 'admin') return getAdminDraftFields(currentBuilderSeason, currentFormBuilderType);
  const teamId = currentTeamData?.id;
  if (!teamId || !currentBuilderSeason) return null;
  if (builderShown && builderShown.key === builderShownKey()) return builderShown.fields;
  const cache = currentFormBuilderType === 'matchScouting' ? matchFormConfigCache : formConfigCache;
  const cached = cache.get(`${teamId}_${currentBuilderSeason}`);
  return cached ? cached.fields : null;
}

// ====== Set the current cached config, after a builder write ======
function setBuilderCachedConfig(fields, teamId, retiredFields) {
  if (builderMode === 'admin') {
    setAdminDraftFields(currentBuilderSeason, currentFormBuilderType, fields);
    return;
  }
  builderShown = { key: builderShownKey(), fields };
  const cache = currentFormBuilderType === 'matchScouting' ? matchFormConfigCache : formConfigCache;
  // Only the fields changed: keep the entry's version bookkeeping and retired
  // fields (unless the write just changed those: retiredFields given). An entry
  // the listener already emptied stays empty — a fields-only entry would hide
  // the retired fields from the next form that reads it; the next load fetches.
  const existing = cache.get(`${teamId}_${currentBuilderSeason}`);
  if (!existing) return;
  cache.set(`${teamId}_${currentBuilderSeason}`, {
    ...existing,
    fields,
    season: currentBuilderSeason,
    ...(Array.isArray(retiredFields) ? { retiredFields } : {})
  });
}

// ====== Invalidate the current config cache ======
function invalidateBuilderConfigCache() {
  if (builderMode === 'admin') return;
  const teamId = currentTeamData?.id;
  if (currentFormBuilderType === 'matchScouting') {
    invalidateMatchFormConfigCache(teamId, currentBuilderSeason);
  } else {
    invalidateFormConfigCache(teamId, currentBuilderSeason);
  }
}

// ====== Load the current config (fields array) ======
async function loadBuilderConfig(teamId) {
  if (builderMode === 'admin') return loadAdminDraftFields(currentBuilderSeason, currentFormBuilderType);
  const defaults = currentFormBuilderType === 'matchScouting' ? getDefaultMatchFields : getDefaultPitFields;
  const cache = currentFormBuilderType === 'matchScouting' ? matchFormConfigCache : formConfigCache;
  const result = await loadSeasonScopedFormConfig(teamId, currentBuilderSeason, currentFormBuilderType, defaults, cache);
  return result.fields;
}

// ====== Save the field list. Team mode writes the team's formConfig doc —
// merged, so the version bookkeeping and retired fields next to `fields` are
// never wiped by a field edit. Admin mode keeps the change in the unpublished
// draft only (setBuilderCachedConfig() does that), so there is nothing to write. ======
//
// Retiring (team mode, opts.syncRetired): the same write also keeps
// retiredFields right, read fresh inside a transaction so an Accept/Merge made
// elsewhere meanwhile isn't overwritten from a stale cache — a field in
// opts.retire (the one just removed) is added with its full definition
// (replacing an older retired entry with that id), and any retired id that is
// on the new field list again is dropped. retiredFields is only written when
// it actually changes. Returns the retiredFields now stored, or null when this
// write did not look at them.
async function writeBuilderFields(teamId, fields, opts = {}) {
  if (builderMode === 'admin') return null;
  const ref = db.collection('teams').doc(teamId)
    .collection('formConfig').doc(getBuilderConfigDocId());
  if (!opts.syncRetired) {
    await ref.set({ fields }, { merge: true });
    return null;
  }
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const current = snap.exists && Array.isArray(snap.data().retiredFields) ? snap.data().retiredFields : [];
    const activeIds = new Set(fields.map((f) => f.id));
    const removedId = opts.retire ? opts.retire.id : null;
    const next = current.filter((r) => r && !activeIds.has(r.id) && r.id !== removedId);
    if (opts.retire && !activeIds.has(removedId)) next.push({ ...opts.retire });
    const changed = JSON.stringify(next) !== JSON.stringify(current);
    tx.set(ref, changed ? { fields, retiredFields: next } : { fields }, { merge: true });
    return next;
  });
}

// ====== Render the field list in the builder ======
// Only the LATEST render may fill the list: a slow load for an earlier season /
// form type (e.g. the first open's, still creating its config when the user has
// already switched) must not land on top of the one now selected.
let builderRenderToken = 0;

async function renderBuilderFields(teamId) {
  const list = document.getElementById('builder-field-list');
  list.innerHTML = '<p class="help-text" style="text-align:center">Loading...</p>';
  const token = ++builderRenderToken;

  try {
    const fields = await loadBuilderConfig(teamId);
    if (token !== builderRenderToken) return;
    list.innerHTML = '';
    if (builderMode !== 'admin') builderShown = { key: builderShownKey(), fields: fields || [] };

    if (!fields || fields.length === 0) {
      list.innerHTML = '<p class="help-text" style="text-align:center">No fields yet. Add one below.</p>';
      return;
    }

    fields.forEach((field, index) => {
      const item = createBuilderFieldItem(field, index);
      list.appendChild(item);
    });
  } catch (err) {
    if (token !== builderRenderToken) return;
    console.error('Failed to load config for builder:', err);
    list.innerHTML = '<p class="help-text" style="color:var(--error)">Failed to load fields.</p>';
  }
}

// ====== Create a single field editor row ======
function createBuilderFieldItem(field, index) {
  const item = document.createElement('div');
  item.className = 'builder-field-item';
  item.dataset.index = index;

  // Drag handle
  const dragHandle = document.createElement('span');
  dragHandle.className = 'builder-drag-handle';
  dragHandle.textContent = '⠿';
  dragHandle.title = 'Drag to reorder';
  dragHandle.setAttribute('aria-label', 'Drag to reorder');
  // Pointer events: one code path for mouse, touch and pen (the handle alone has
  // touch-action: none in the CSS, so the rest of the page still scrolls).
  dragHandle.addEventListener('pointerdown', (event) => startFieldDrag(event, item));

  // Move up/down buttons
  const moveGroup = document.createElement('div');
  moveGroup.className = 'builder-move-group';

  const moveUpBtn = document.createElement('button');
  moveUpBtn.className = 'btn-move btn-move-up';
  moveUpBtn.textContent = '▲';
  moveUpBtn.title = 'Move up';
  moveUpBtn.disabled = index === 0;
  moveUpBtn.addEventListener('click', () => moveField(index, -1));

  const moveDownBtn = document.createElement('button');
  moveDownBtn.className = 'btn-move btn-move-down';
  moveDownBtn.textContent = '▼';
  moveDownBtn.title = 'Move down';
  const config = getBuilderCachedConfig();
  moveDownBtn.disabled = index === (config?.length || 0) - 1;
  moveDownBtn.addEventListener('click', () => moveField(index, 1));

  moveGroup.appendChild(moveUpBtn);
  moveGroup.appendChild(moveDownBtn);

  // Field summary
  const summary = document.createElement('div');
  summary.className = 'builder-field-summary';

  const labelEl = document.createElement('span');
  labelEl.className = 'builder-field-label';
  labelEl.textContent = field.label;

  const metaEl = document.createElement('span');
  metaEl.className = 'builder-field-meta';
  const typeLabel = FIELD_TYPES.find(t => t.value === field.type)?.label || field.type;
  const inPreview = field.showInPreview !== false;
  metaEl.textContent = `${typeLabel}${field.required ? ' • Required' : ''}${inPreview ? ' • In Preview' : ''}`;

  summary.appendChild(labelEl);
  summary.appendChild(metaEl);

  // Action buttons
  const actions = document.createElement('div');
  actions.className = 'builder-field-actions';

  const editBtn = document.createElement('button');
  editBtn.className = 'btn btn-small btn-outline';
  editBtn.textContent = 'Edit';
  editBtn.addEventListener('click', () => openFieldEditor(index));

  const copyBtn = document.createElement('button');
  copyBtn.className = 'btn btn-small btn-outline builder-copy-btn';
  copyBtn.textContent = 'Copy';
  copyBtn.title = 'Add a copy of this field right below it';
  copyBtn.dataset.builderAction = 'copy';
  copyBtn.addEventListener('click', () => copyField(index));

  const removeBtn = document.createElement('button');
  removeBtn.className = 'btn btn-small btn-outline';
  removeBtn.textContent = '✕';
  removeBtn.style.cssText = 'color:var(--error); border-color:var(--error)';
  removeBtn.addEventListener('click', () => removeField(index));

  actions.appendChild(editBtn);
  actions.appendChild(copyBtn);
  actions.appendChild(removeBtn);

  item.appendChild(dragHandle);
  item.appendChild(moveGroup);
  item.appendChild(summary);
  item.appendChild(actions);

  return item;
}

// ====== Derive a Field ID candidate from a Field Label — camelCase: split
// into words on any run of non-alphanumerics, lowercase the first word,
// capitalize the rest, join with no separator (e.g. "Auto Points" ->
// "autoPoints"), then strip any leading non-letters so the result always
// starts with a letter (matching the Field ID validation rule in
// saveFieldEdit() below). ======
function slugifyFieldLabel(label) {
  const words = (label || '').trim().split(/[^a-zA-Z0-9]+/).filter(Boolean);
  if (words.length === 0) return '';

  const camel = words
    .map((word, i) => {
      const lower = word.toLowerCase();
      return i === 0 ? lower : lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join('');

  return camel.replace(/^[^a-zA-Z]+/, '');
}

// ====== Open field editor sub-modal to edit an existing field or add a new one ======
let editingFieldIndex = -1;
// Only a brand-new field's ID auto-follows the label as the user types it
// (see the bld-field-label input listener below) — an existing field's ID is
// already meaningful (changing it loses the connection to its saved data,
// per the warning text next to it) and is always freely editable, no
// auto-follow involved. For a new field, the ID input starts locked
// (readOnly) and auto-following; checking bld-field-id-manual (see its
// change listener below) is what unlocks it for manual editing and stops
// the follow — unchecking re-locks it and snaps back to whatever
// auto-generation currently produces, confirming first if that would
// discard a manually-typed value.
let fieldIdAutoFollow = false;

function openFieldEditor(index) {
  editingFieldIndex = index;

  const teamId = builderTeamId();
  if (!teamId) return;

  // Populate the editor form
  const fields = getBuilderCachedConfig() || [];
  const field = index >= 0 && index < fields.length ? fields[index] : null;

  document.getElementById('field-editor-title').textContent = field ? 'Edit Field' : 'Add Field';
  const isNewField = !field;
  fieldIdAutoFollow = isNewField;

  const idInput = document.getElementById('bld-field-id');
  const manualRow = document.getElementById('bld-field-id-manual-row');
  const manualCheckbox = document.getElementById('bld-field-id-manual');
  if (isNewField) {
    // Locked + auto-following by default — the checkbox (wired up in the
    // DOMContentLoaded handler below) is what unlocks it.
    if (manualRow) manualRow.classList.remove('hidden');
    if (manualCheckbox) manualCheckbox.checked = false;
    idInput.readOnly = true;
  } else {
    // Editing an existing field: auto-generation was never a thing here —
    // the ID is already meaningful and always freely editable, same as
    // before this feature existed.
    if (manualRow) manualRow.classList.add('hidden');
    idInput.readOnly = false;
  }

  document.getElementById('bld-field-label').value = field?.label || '';
  idInput.value = field?.id || '';
  document.getElementById('bld-field-type').value = field?.type || 'text';
  document.getElementById('bld-field-required').checked = field?.required || false;
  // Missing showInPreview (pre-existing fields saved before this setting
  // existed, and brand-new fields alike) defaults to checked/shown.
  document.getElementById('bld-field-show-in-preview').checked = field?.showInPreview !== false;
  document.getElementById('bld-field-options').value = field?.options ? field.options.join('\n') : '';
  const multiCheckbox = document.getElementById('bld-field-multi');
  if (multiCheckbox) multiCheckbox.checked = field?.multi || false;
  document.getElementById('bld-field-id-warning').textContent = '';
  const modalErrorEl = document.getElementById('field-editor-error');
  if (modalErrorEl) modalErrorEl.textContent = '';

  document.getElementById('bld-field-min').value = field?.min ?? 0;
  document.getElementById('bld-field-max').value = field?.max ?? '';
  document.getElementById('bld-field-step').value = field?.step ?? 1;
  // Assumed value: an older field that only has defaultValue shows it here (the stored form is not rewritten until saved).
  document.getElementById('bld-field-assumed').value = field && field.type === 'counter' ? counterAssumedValue(field) : 0;

  // Show/hide options/counter config based on type
  toggleOptionsField();

  document.getElementById('field-editor-modal').classList.remove('hidden');
}

function closeFieldEditor() {
  document.getElementById('field-editor-modal').classList.add('hidden');
  editingFieldIndex = -1;
}

function toggleOptionsField() {
  const type = document.getElementById('bld-field-type').value;
  const optionsGroup = document.getElementById('bld-field-options-group');
  const counterGroup = document.getElementById('bld-field-counter-group');
  const multiGroup = document.getElementById('bld-field-multi-group');
  // Dropdown and Button Group share the same newline-delimited options list.
  optionsGroup.style.display = (type === 'dropdown' || type === 'buttonGroup') ? 'block' : 'none';
  counterGroup.style.display = type === 'counter' ? 'block' : 'none';
  if (multiGroup) multiGroup.style.display = type === 'buttonGroup' ? 'block' : 'none';
}

// ====== Counter settings worth a second look before saving (counter type only) ======
// Both are allowed (the counter still works), they just usually mean a slip:
//  - minimum = maximum: the counter can only ever be that one number.
//  - an Assumed value that was set (not the default 0) and is MORE than one step outside minimum-maximum
//    (assumed < min - step, or assumed > max + step): it is treated as the nearest limit when + / - is pressed.
//    An Assumed value left at 0 (or never set) never warns by itself, and one exactly one step below the
//    minimum / above the maximum is the normal way to make the first + give the minimum / maximum.
// Returns the sentences to confirm, [] in the normal case.
const COUNTER_SAME_MIN_MAX_WARNING = 'Minimum and maximum are the same, so this counter can only ever be that one number. A dropdown or button group is usually better.';
const COUNTER_ASSUMED_OUTSIDE_WARNING = 'The assumed value is outside the minimum-maximum range, so it will be treated as the nearest limit.';
function counterSaveWarnings(minRaw, maxRaw, assumedRaw, stepRaw) {
  const min = minRaw !== '' ? Number(minRaw) : 0;
  const max = maxRaw !== '' ? Number(maxRaw) : null;
  const assumed = assumedRaw !== '' ? Number(assumedRaw) : 0;
  const step = stepRaw !== undefined && stepRaw !== '' && Number(stepRaw) > 0 ? Number(stepRaw) : 1;
  const warnings = [];
  if (max !== null && min === max) warnings.push(COUNTER_SAME_MIN_MAX_WARNING);
  if (assumed !== 0 && (assumed < min - step || (max !== null && assumed > max + step))) warnings.push(COUNTER_ASSUMED_OUTSIDE_WARNING);
  return warnings;
}

// ====== Save the field being edited ======
// (opts.skipCounterWarning: set when the person has just answered "Save anyway" to the counter confirm below;
// a click handler passes an Event here, which has no such property.)
async function saveFieldEdit(opts) {
  // Validation/failure messages use the field-editor sub-modal's OWN error
  // element, not the parent Form Builder screen's — that modal stays open
  // (or, on a save failure, is still open) through every case below, and the
  // parent's builder-error sits behind it, invisible to whoever's looking at
  // this topmost modal. builder-success is still correct for the one case
  // that actually uses it (below): by then closeFieldEditor() has already
  // run, so the parent screen is what's showing again.
  const modalErrorEl = document.getElementById('field-editor-error');
  if (modalErrorEl) modalErrorEl.textContent = '';
  if (typeof clearStatusMessage === 'function') clearStatusMessage('builder');

  const label = document.getElementById('bld-field-label').value.trim();
  const fieldId = document.getElementById('bld-field-id').value.trim();
  const type = document.getElementById('bld-field-type').value;
  const required = document.getElementById('bld-field-required').checked;
  const showInPreview = document.getElementById('bld-field-show-in-preview').checked;
  const optionsRaw = document.getElementById('bld-field-options').value;
  const multi = document.getElementById('bld-field-multi')?.checked || false;
  const minRaw = document.getElementById('bld-field-min').value.trim();
  const maxRaw = document.getElementById('bld-field-max').value.trim();
  const stepRaw = document.getElementById('bld-field-step').value.trim();
  const assumedRaw = document.getElementById('bld-field-assumed').value.trim();

  if (!label) {
    if (modalErrorEl) modalErrorEl.textContent = 'Field label is required.';
    return;
  }
  if (!fieldId) {
    if (modalErrorEl) modalErrorEl.textContent = 'Field ID (database key) is required.';
    return;
  }
  // Validate field ID format: lowercase, no spaces, alphanumeric + underscore
  if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(fieldId)) {
    if (modalErrorEl) modalErrorEl.textContent = 'Field ID must start with a letter and contain only letters, numbers, and underscores.';
    return;
  }
  if ((type === 'dropdown' || type === 'buttonGroup') && !optionsRaw.trim()) {
    if (modalErrorEl) modalErrorEl.textContent = 'Options are required. Enter one per line.';
    return;
  }
  if (type === 'counter' && maxRaw !== '' && minRaw !== '' && Number(maxRaw) < Number(minRaw)) {
    if (modalErrorEl) modalErrorEl.textContent = 'Counter maximum can\'t be lower than the minimum.';
    return;
  }
  if (showInPreview) {
    // Count every OTHER field currently marked for preview — excludes the
    // field being edited (if any), since its own new value is what we're
    // about to set, not what's already saved.
    const existingFields = getBuilderCachedConfig() || [];
    const otherPreviewCount = existingFields.reduce((count, f, i) => {
      if (i === editingFieldIndex) return count;
      return count + (f.showInPreview !== false ? 1 : 0);
    }, 0);
    if (otherPreviewCount >= PREVIEW_FIELD_CAP) {
      if (modalErrorEl) modalErrorEl.textContent = `Up to ${PREVIEW_FIELD_CAP} fields can be shown in the preview at once. Uncheck another field first.`;
      return;
    }
  }

  // Counter warnings: one confirm (the two messages combined when both apply). "Go back" just closes it — the
  // editor stays open with everything as typed; "Save anyway" runs this save again without asking.
  if (type === 'counter' && !(opts && opts.skipCounterWarning)) {
    const warnings = counterSaveWarnings(minRaw, maxRaw, assumedRaw, stepRaw);
    if (warnings.length > 0 && typeof showConfirmModal === 'function') {
      showConfirmModal({
        title: 'Check this counter',
        message: `${warnings.join(' ')} Save anyway?`,
        confirmLabel: 'Save anyway',
        cancelLabel: 'Go back',
        onConfirm: () => saveFieldEdit({ skipCounterWarning: true })
      });
      return;
    }
  }

  const options = (type === 'dropdown' || type === 'buttonGroup')
    ? optionsRaw.split('\n').map(s => s.trim()).filter(Boolean)
    : [];

  const teamId = builderTeamId();
  if (!teamId) return;

  showLoading('Saving field...');
  try {
    // Get current fields (or empty array if none)
    const fields = getBuilderCachedConfig() ? [...getBuilderCachedConfig()] : [];

    const fieldData = { id: fieldId, label, type, required, sortOrder: 0, showInPreview };

    if (type === 'dropdown' || type === 'buttonGroup') {
      fieldData.options = options;
    }

    if (type === 'buttonGroup') {
      fieldData.multi = multi;
    }

    if (type === 'counter') {
      fieldData.min = minRaw !== '' ? Number(minRaw) : 0;
      if (maxRaw !== '') fieldData.max = Number(maxRaw);
      fieldData.step = stepRaw !== '' ? Number(stepRaw) : 1;
      // The assumed value replaces the old starting value (defaultValue is never written again); 0 is the default, so it is left out.
      if (assumedRaw !== '' && Number(assumedRaw) !== 0) fieldData.assumedValue = Number(assumedRaw);
    }

    if (editingFieldIndex >= 0 && editingFieldIndex < fields.length) {
      // Update existing field — preserve sortOrder
      fieldData.sortOrder = fields[editingFieldIndex].sortOrder;
      fields[editingFieldIndex] = fieldData;
    } else {
      // New field — add at end
      fieldData.sortOrder = fields.length;
      fields.push(fieldData);
    }

    // Recalculate sortOrders
    fields.forEach((f, i) => { f.sortOrder = i; });

    // Save to Firestore (team mode) / keep in the draft (admin mode)
    // (a field added back under a retired id leaves retiredFields)
    const retiredNow = await writeBuilderFields(teamId, fields, { syncRetired: true });

    hideLoading();

    // Update the cached copy and re-render builder
    setBuilderCachedConfig(fields, teamId, retiredNow);

    closeFieldEditor();
    await renderBuilderFields(teamId);
    if (builderMode === 'admin' && typeof refreshAdminPanel === 'function') refreshAdminPanel();
    if (typeof setStatusMessage === 'function') setStatusMessage('builder', 'success', builderMode === 'admin' ? 'Field updated in the draft (not published yet).' : 'Field saved!');
  } catch (err) {
    hideLoading();
    console.error('Failed to save field:', err);
    if (modalErrorEl) modalErrorEl.textContent = 'Failed to save. Please check your connection.';
  }
}

// ====== Remove a field ======
function removeField(index) {
  const teamId = builderTeamId();
  if (!teamId) return;

  const fields = getBuilderCachedConfig() || [];
  const field = fields[index];
  if (!field || typeof showConfirmModal !== 'function') return;

  showConfirmModal({
    title: 'Remove Field?',
    message: builderMode === 'admin'
      ? `Remove field "${field.label}" from this draft? It only leaves the official form once you publish.`
      : `Remove field "${field.label}"? Scouted entries keep their data. Old entries that have a value in this field will still show it, marked as a deleted field. New entries won't show it.`,
    confirmLabel: 'Remove',
    danger: true,
    onConfirm: async () => {
      showLoading('Removing field...');
      try {
        const updated = fields.filter((_, i) => i !== index);
        // Recalculate sortOrders
        updated.forEach((f, i) => { f.sortOrder = i; });

        // Same write retires it, exactly like an Accept does (admin mode: draft only)
        const retiredNow = await writeBuilderFields(teamId, updated, { syncRetired: true, retire: { ...field } });

        hideLoading();

        setBuilderCachedConfig(updated, teamId, retiredNow);

        await renderBuilderFields(teamId);
        if (builderMode === 'admin' && typeof refreshAdminPanel === 'function') refreshAdminPanel();
        if (typeof setStatusMessage === 'function') setStatusMessage('builder', 'success', builderMode === 'admin' ? 'Field removed from the draft (not published yet).' : 'Field removed. Old data is preserved.');
      } catch (err) {
        hideLoading();
        console.error('Failed to remove field:', err);
        if (typeof setStatusMessage === 'function') setStatusMessage('builder', 'error', 'Failed to remove field.');
      }
    }
  });
}

// ====== Copy a field ======
// A copy of the row appears directly below it: label "<label> (copy)", a field ID
// nothing else uses (not an active one, and not a retired one either: re-using a
// retired ID would make the old entries' deleted-field values show up in the copy),
// everything else the same. When the preview already holds PREVIEW_FIELD_CAP fields
// the copy is added with "Show in preview" off. Saved through the same write as
// adding a field, so in team mode the version fields are kept and retiredFields
// stays in step (writeBuilderFields); in admin mode it only changes the draft.
function uniqueCopyFieldId(baseId, takenIds) {
  const root = `${baseId}Copy`;
  if (!takenIds.has(root)) return root;
  for (let n = 2; ; n++) {
    if (!takenIds.has(`${root}${n}`)) return `${root}${n}`;
  }
}

function builderRetiredFieldIds() {
  if (builderMode === 'admin') return [];
  const config = teamConfigDocs.get(getBuilderConfigDocId());
  return (config && Array.isArray(config.retiredFields) ? config.retiredFields : []).map((r) => r && r.id).filter(Boolean);
}

async function copyField(index) {
  const teamId = builderTeamId();
  if (!teamId) return;

  const fields = getBuilderCachedConfig() ? [...getBuilderCachedConfig()] : [];
  const original = fields[index];
  if (!original) return;

  const taken = new Set([...fields.map((f) => f.id), ...builderRetiredFieldIds()]);
  const copy = JSON.parse(JSON.stringify(original));
  copy.id = uniqueCopyFieldId(original.id, taken);
  copy.label = `${original.label} (copy)`;
  const inPreview = fields.filter((f) => f.showInPreview !== false).length;
  if (copy.showInPreview !== false && inPreview >= PREVIEW_FIELD_CAP) copy.showInPreview = false;
  fields.splice(index + 1, 0, copy);
  fields.forEach((f, i) => { f.sortOrder = i; });

  showLoading('Copying field...');
  try {
    const retiredNow = await writeBuilderFields(teamId, fields, { syncRetired: true });
    hideLoading();
    setBuilderCachedConfig(fields, teamId, retiredNow);
    await renderBuilderFields(teamId);
    if (builderMode === 'admin' && typeof refreshAdminPanel === 'function') refreshAdminPanel();
    if (typeof setStatusMessage === 'function') setStatusMessage('builder', 'success', builderMode === 'admin' ? 'Field copied in the draft (not published yet).' : 'Field copied!');
  } catch (err) {
    hideLoading();
    console.error('Failed to copy field:', err);
    if (typeof setStatusMessage === 'function') setStatusMessage('builder', 'error', 'Failed to copy field.');
  }
}

// ====== Move a field up/down (reorder) ======
async function moveField(fromIndex, direction) {
  const fields = getBuilderCachedConfig() ? [...getBuilderCachedConfig()] : [];
  const toIndex = fromIndex + direction;
  if (toIndex < 0 || toIndex >= fields.length) return;

  // Swap
  [fields[fromIndex], fields[toIndex]] = [fields[toIndex], fields[fromIndex]];
  await saveFieldOrder(fields);
}

// The one way a new order is saved — the ▲ ▼ buttons and the drag handle both end here.
async function saveFieldOrder(fields) {
  const teamId = builderTeamId();
  if (!teamId) return;

  fields.forEach((f, i) => { f.sortOrder = i; });

  showLoading('Reordering...');
  try {
    await writeBuilderFields(teamId, fields);

    hideLoading();
    setBuilderCachedConfig(fields, teamId);

    await renderBuilderFields(teamId);
    if (builderMode === 'admin' && typeof refreshAdminPanel === 'function') refreshAdminPanel();
  } catch (err) {
    hideLoading();
    console.error('Failed to reorder:', err);
  }
}

// ====== Drag a field to reorder it ======
// Press the six-dot handle on the left of a row, drag, release: the row moves to where
// the blue drop line is and the new order is saved by saveFieldOrder(), exactly like
// the ▲ ▼ buttons. Pointer events, so one code path covers mouse, touch and pen; only
// the handle has touch-action: none, the rest of the page keeps scrolling. Escape or a
// cancelled pointer drops nothing. The list is only re-rendered after the drop.
let builderDrag = null; // { pointerId, item, fromIndex, targetIndex, list, indicator, scroller, lastY, scrollTimer }

function startFieldDrag(event, item) {
  if (builderDrag) return;
  if (event.pointerType === 'mouse' && event.button !== 0) return;
  const list = document.getElementById('builder-field-list');
  const fromIndex = Array.from(list.querySelectorAll('.builder-field-item')).indexOf(item);
  if (fromIndex < 0) return;
  event.preventDefault();

  const indicator = document.createElement('div');
  indicator.className = 'builder-drop-indicator';
  list.appendChild(indicator);
  builderDrag = {
    pointerId: event.pointerId, item, fromIndex, targetIndex: fromIndex, list, indicator,
    scroller: nearestScrollableAncestor(list), lastY: event.clientY, scrollTimer: null
  };
  item.classList.add('builder-field-item--dragging');
  document.body.classList.add('builder-dragging');
  try { event.target.setPointerCapture(event.pointerId); } catch (_) { /* a synthetic pointer can't be captured; the document listeners below still get the moves */ }
  document.addEventListener('pointermove', onFieldDragMove);
  document.addEventListener('pointerup', onFieldDragEnd);
  document.addEventListener('pointercancel', onFieldDragCancel);
  document.addEventListener('keydown', onFieldDragKey);
  builderDrag.scrollTimer = setInterval(autoScrollFieldDrag, 30);
  updateFieldDrag(event.clientY);
}

function nearestScrollableAncestor(el) {
  for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
    const overflowY = getComputedStyle(node).overflowY;
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) return node;
  }
  return document.scrollingElement || document.documentElement;
}

// Where the dragged row would land: the number of OTHER rows above the pointer.
function updateFieldDrag(clientY) {
  const drag = builderDrag;
  if (!drag) return;
  drag.lastY = clientY;
  const rows = Array.from(drag.list.querySelectorAll('.builder-field-item')).filter((row) => row !== drag.item);
  let index = rows.length;
  for (let i = 0; i < rows.length; i++) {
    const box = rows[i].getBoundingClientRect();
    if (clientY < box.top + box.height / 2) { index = i; break; }
  }
  drag.targetIndex = index;
  const listTop = drag.list.getBoundingClientRect().top;
  let lineY;
  if (index < rows.length) lineY = rows[index].getBoundingClientRect().top - 3;
  else if (rows.length > 0) lineY = rows[rows.length - 1].getBoundingClientRect().bottom + 3;
  else lineY = drag.item.getBoundingClientRect().top;
  drag.indicator.style.top = `${lineY - listTop - 1}px`;
  drag.indicator.dataset.index = String(index);
}

function onFieldDragMove(event) {
  if (!builderDrag || event.pointerId !== builderDrag.pointerId) return;
  updateFieldDrag(event.clientY);
}

// Near the top / bottom edge of the scrolling area the area scrolls, so a field can be
// dragged past what is on screen.
function autoScrollFieldDrag() {
  const drag = builderDrag;
  if (!drag) return;
  const isPage = drag.scroller === document.scrollingElement || drag.scroller === document.documentElement;
  const top = isPage ? 0 : drag.scroller.getBoundingClientRect().top;
  const bottom = isPage ? window.innerHeight : drag.scroller.getBoundingClientRect().bottom;
  const edge = 48;
  let delta = 0;
  if (drag.lastY < top + edge) delta = -Math.ceil(14 * Math.min(1, (top + edge - drag.lastY) / edge));
  else if (drag.lastY > bottom - edge) delta = Math.ceil(14 * Math.min(1, (drag.lastY - (bottom - edge)) / edge));
  if (delta === 0) return;
  const before = drag.scroller.scrollTop;
  drag.scroller.scrollTop += delta;
  if (drag.scroller.scrollTop !== before) updateFieldDrag(drag.lastY);
}

function endFieldDrag() {
  const drag = builderDrag;
  if (!drag) return null;
  builderDrag = null;
  clearInterval(drag.scrollTimer);
  document.removeEventListener('pointermove', onFieldDragMove);
  document.removeEventListener('pointerup', onFieldDragEnd);
  document.removeEventListener('pointercancel', onFieldDragCancel);
  document.removeEventListener('keydown', onFieldDragKey);
  document.body.classList.remove('builder-dragging');
  drag.item.classList.remove('builder-field-item--dragging');
  drag.indicator.remove();
  return drag;
}

function onFieldDragEnd(event) {
  if (!builderDrag || event.pointerId !== builderDrag.pointerId) return;
  updateFieldDrag(event.clientY);
  const drag = endFieldDrag();
  if (!drag || !drag.item.isConnected || drag.targetIndex === drag.fromIndex) return;
  const fields = getBuilderCachedConfig() ? [...getBuilderCachedConfig()] : [];
  if (drag.fromIndex >= fields.length) return;
  const [moved] = fields.splice(drag.fromIndex, 1);
  fields.splice(drag.targetIndex, 0, moved);
  saveFieldOrder(fields);
}

function onFieldDragCancel(event) {
  if (!builderDrag || event.pointerId !== builderDrag.pointerId) return;
  endFieldDrag();
}

function onFieldDragKey(event) {
  if (event.key === 'Escape') endFieldDrag();
}

// ====== Close the form builder ======
function closeFormBuilder() {
  // The admin draft isn't saved anywhere: ask before throwing unpublished edits away.
  if (builderMode === 'admin' && typeof adminBuilderCloseNeedsConfirm === 'function' && adminBuilderCloseNeedsConfirm()) return;
  document.getElementById('builder-modal').classList.add('hidden');
  if (typeof clearStatusMessage === 'function') clearStatusMessage('builder');
}

// ====== Wire up event handlers ======
document.addEventListener('DOMContentLoaded', () => {
  // Open form builder from My Team tab — single entry point, defaults to the
  // Pit Scouting tab; the Match Scouting tab is one click away inside the
  // modal's own builder-type-tab switcher.
  document.getElementById('btn-open-form-builder').addEventListener('click', () => openFormBuilder('pitScouting'));

  // Builder type tabs
  document.querySelectorAll('.builder-type-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      switchBuilderType(tab.dataset.builderType);
    });
  });

  // In-builder season switcher — lets a captain build/maintain a past
  // season's form, or hop between seasons, without leaving the builder to
  // change the app's main season selector first. Preserves the current
  // builder-type tab (pit/match), only the season changes.
  const seasonSelect = document.getElementById('builder-season-select');
  if (seasonSelect) {
    seasonSelect.addEventListener('change', (e) => {
      currentBuilderSeason = e.target.value;
      const teamId = builderTeamId();
      if (!teamId) return;
      applyBuilderSeasonAndType(teamId);
    });
  }

  // "Official form" bar (team mode, see refreshBuilderOfficialBar()).
  document.getElementById('btn-builder-official-view').addEventListener('click', () => openOfficialFormViewer(currentBuilderSeason, currentFormBuilderType));
  document.getElementById('btn-builder-restore-previous').addEventListener('click', () => restorePreviousForm(currentBuilderSeason, currentFormBuilderType));

  // Builder buttons
  document.getElementById('btn-builder-close').addEventListener('click', closeFormBuilder);
  document.getElementById('btn-builder-add-field').addEventListener('click', () => openFieldEditor(-1));

  // Field editor buttons
  document.getElementById('btn-bld-save').addEventListener('click', saveFieldEdit);
  document.getElementById('btn-bld-cancel').addEventListener('click', closeFieldEditor);
  document.getElementById('btn-bld-cancel-inline').addEventListener('click', closeFieldEditor);

  // Toggle options on type change
  document.getElementById('bld-field-type').addEventListener('change', toggleOptionsField);

  // Auto-generate the Field ID from the Field Label as the user types it
  // (new fields only — see fieldIdAutoFollow's comment above), shown live in
  // the (locked, read-only) ID field.
  document.getElementById('bld-field-label').addEventListener('input', (e) => {
    if (!fieldIdAutoFollow) return;
    document.getElementById('bld-field-id').value = slugifyFieldLabel(e.target.value);
  });

  // "Edit ID manually" checkbox — gates manual editing of a NEW field's ID.
  document.getElementById('bld-field-id-manual').addEventListener('change', (e) => {
    const idInput = document.getElementById('bld-field-id');
    const checkbox = e.target;

    if (checkbox.checked) {
      // Unlock for manual editing; stop auto-following the label.
      fieldIdAutoFollow = false;
      idInput.readOnly = false;
      idInput.focus();
      return;
    }

    // Re-locking snaps the ID back to whatever auto-generation currently
    // produces from the label. If that differs from what's there now (a
    // manually-typed value), confirm first since unchecking would silently
    // discard it — revert the checkbox back to checked until/unless
    // confirmed, since showConfirmModal() has no cancel callback to undo it.
    const autoGenerated = slugifyFieldLabel(document.getElementById('bld-field-label').value);
    const currentId = idInput.value.trim();

    const applyAutoFollow = () => {
      fieldIdAutoFollow = true;
      idInput.value = autoGenerated;
      idInput.readOnly = true;
    };

    if (currentId === autoGenerated) {
      applyAutoFollow();
      return;
    }

    checkbox.checked = true;
    if (typeof showConfirmModal === 'function') {
      showConfirmModal({
        title: 'Discard Manual Field ID?',
        message: `Switching back to auto-generated will discard "${currentId}" and use "${autoGenerated}" instead (from the current label). Continue?`,
        confirmLabel: 'Use Auto-Generated ID',
        danger: true,
        onConfirm: () => {
          checkbox.checked = false;
          applyAutoFollow();
        }
      });
    }
  });

  // Close builder on overlay click
  document.getElementById('builder-modal-overlay').addEventListener('click', closeFormBuilder);
  document.getElementById('field-editor-overlay').addEventListener('click', closeFieldEditor);
});