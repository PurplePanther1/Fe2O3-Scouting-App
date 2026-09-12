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

// ====== True when the season/type currently open has no real saved config
// yet (loadSeasonScopedFormConfig seeded either the migrated legacy config or
// the hardcoded defaults on this load) — drives the "fresh form" banner and
// its copy-from-past-season action in renderBuilderFields(). Reset on every
// open/switch, and cleared as soon as the team saves any real edit. ======
let builderConfigWasFresh = false;

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

// ====== Open the form builder ======
async function openFormBuilder(type) {
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

  // Update modal title based on type
  const title = currentFormBuilderType === 'matchScouting' ? 'Match Scouting Form Builder' : 'Pit Scouting Form Builder';
  document.getElementById('builder-modal-title').textContent = title;

  // Season subtitle — always shown (not just for a fresh form) since editing
  // is now season-scoped: whoever's editing needs to know which season's
  // form they're changing.
  const seasonLabelEl = document.getElementById('builder-season-label');
  if (seasonLabelEl) {
    seasonLabelEl.textContent = typeof formatFtcSeasonLabel === 'function'
      ? `Editing: ${formatFtcSeasonLabel(currentBuilderSeason)}`
      : `Editing season: ${currentBuilderSeason}`;
  }

  // Update tab active state
  document.querySelectorAll('.builder-type-tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.builderType === currentFormBuilderType);
  });

  document.getElementById('builder-modal').classList.remove('hidden');
  // builder-modal stays open across multiple field edits (unlike pit-modal/
  // match-modal, which close on save) — its error/success messages use the
  // same auto-clearing helper sheets-export.js's export flows already do
  // (setStatusMessage/clearStatusMessage), rather than sitting there
  // indefinitely until the next edit happens to touch them.
  if (typeof clearStatusMessage === 'function') clearStatusMessage('builder');

  await renderBuilderFields(teamId);
}

// ====== Switch builder type tab ======
function switchBuilderType(type) {
  if (type === currentFormBuilderType) return;
  openFormBuilder(type);
}

// ====== Get the current season-scoped config doc ID ======
function getBuilderConfigDocId() {
  return `${currentBuilderSeason}_${currentFormBuilderType}`;
}

// ====== Get the current cached config (fields array only) ======
function getBuilderCachedConfig() {
  const teamId = currentTeamData?.id;
  if (!teamId || !currentBuilderSeason) return null;
  const cache = currentFormBuilderType === 'matchScouting' ? matchFormConfigCache : formConfigCache;
  const cached = cache.get(`${teamId}_${currentBuilderSeason}`);
  return cached ? cached.fields : null;
}

// ====== Set the current cached config, after a builder write ======
function setBuilderCachedConfig(fields, teamId) {
  const cache = currentFormBuilderType === 'matchScouting' ? matchFormConfigCache : formConfigCache;
  cache.set(`${teamId}_${currentBuilderSeason}`, { fields, season: currentBuilderSeason, wasFresh: false });
  // A real edit just landed — this season/type is no longer "fresh" (matters
  // if the team saves an edit and then reopens the builder without a full
  // page reload in between).
  builderConfigWasFresh = false;
  renderFreshSeasonBanner();
}

// ====== Invalidate the current config cache ======
function invalidateBuilderConfigCache() {
  const teamId = currentTeamData?.id;
  if (currentFormBuilderType === 'matchScouting') {
    invalidateMatchFormConfigCache(teamId, currentBuilderSeason);
  } else {
    invalidateFormConfigCache(teamId, currentBuilderSeason);
  }
}

// ====== Load the current config (fields array; also updates
// builderConfigWasFresh as a side effect) ======
async function loadBuilderConfig(teamId) {
  const defaults = currentFormBuilderType === 'matchScouting' ? DEFAULT_MATCH_FIELDS : DEFAULT_PIT_FIELDS;
  const cache = currentFormBuilderType === 'matchScouting' ? matchFormConfigCache : formConfigCache;
  const result = await loadSeasonScopedFormConfig(teamId, currentBuilderSeason, currentFormBuilderType, defaults, cache);
  builderConfigWasFresh = result.wasFresh;
  return result.fields;
}

// ====== Show/hide/populate the "fresh form" banner and its
// copy-fields-from-a-past-season action (wishlist item 26). Only offers
// seasons that actually have a saved config for the SAME form type — copying
// pit fields into a match form (or vice versa) isn't offered. A no-op if the
// banner markup isn't in the DOM (older cached page, etc.). ======
async function renderFreshSeasonBanner() {
  const banner = document.getElementById('builder-fresh-season-banner');
  if (!banner) return;

  if (!builderConfigWasFresh) {
    banner.classList.add('hidden');
    return;
  }

  const teamId = currentTeamData?.id;
  const textEl = document.getElementById('builder-fresh-season-text');
  const select = document.getElementById('builder-copy-season-select');
  const copyBtn = document.getElementById('btn-builder-copy-season');
  if (!teamId || !textEl || !select || !copyBtn) return;

  // Snapshot which season/type this render is for — captured before the
  // await below so a season/type switch (or the modal closing) mid-lookup
  // can be detected and the now-stale result discarded instead of painting
  // the wrong season's banner.
  const renderedSeason = currentBuilderSeason;
  const renderedType = currentFormBuilderType;
  const seasonLabel = typeof formatFtcSeasonLabel === 'function' ? formatFtcSeasonLabel(renderedSeason) : renderedSeason;

  let pastSeasons = [];
  try {
    pastSeasons = await listOtherSeasonsWithFormConfig(teamId, renderedType, renderedSeason);
  } catch (err) {
    console.warn('Failed to list past seasons with a saved form config:', err);
  }

  if (!builderConfigWasFresh || currentBuilderSeason !== renderedSeason || currentFormBuilderType !== renderedType) return;

  banner.classList.remove('hidden');
  textEl.textContent = `This is a fresh ${seasonLabel} form.`;

  if (pastSeasons.length === 0) {
    select.innerHTML = '';
    select.classList.add('hidden');
    copyBtn.classList.add('hidden');
    return;
  }

  select.classList.remove('hidden');
  copyBtn.classList.remove('hidden');
  select.innerHTML = '';
  pastSeasons.forEach(season => {
    const option = document.createElement('option');
    option.value = season;
    option.textContent = typeof formatFtcSeasonLabel === 'function' ? formatFtcSeasonLabel(season) : season;
    select.appendChild(option);
  });
}

// ====== Copy another season's saved fields in as this season's starting
// config (wishlist item 26) — a deliberate one-time seed the team can then
// keep editing normally; it does not link the two seasons' configs together
// afterward. Only enabled while the current season/type is genuinely fresh
// (see renderFreshSeasonBanner()), so this only ever overwrites a
// hardcoded-defaults doc, never a team's real configured fields. ======
async function copyFormConfigFromSeason(fromSeason) {
  const teamId = currentTeamData?.id;
  if (!teamId || !fromSeason) return;

  const seasonLabel = typeof formatFtcSeasonLabel === 'function' ? formatFtcSeasonLabel(fromSeason) : fromSeason;
  const targetLabel = typeof formatFtcSeasonLabel === 'function' ? formatFtcSeasonLabel(currentBuilderSeason) : currentBuilderSeason;

  if (typeof showConfirmModal !== 'function') return;
  showConfirmModal({
    title: 'Copy Form Fields?',
    message: `Copy ${seasonLabel}'s fields into ${targetLabel}? This replaces the current (default) fields for this season with a copy of ${seasonLabel}'s — you can still edit them afterward.`,
    confirmLabel: 'Copy Fields',
    onConfirm: async () => {
      showLoading('Copying fields...');
      try {
        const sourceDoc = await db.collection('teams').doc(teamId)
          .collection('formConfig').doc(`${fromSeason}_${currentFormBuilderType}`).get();
        const copiedFields = sourceDoc.exists ? (sourceDoc.data().fields || []) : [];

        await db.collection('teams').doc(teamId)
          .collection('formConfig').doc(getBuilderConfigDocId())
          .set({ fields: copiedFields });

        hideLoading();
        invalidateBuilderConfigCache();
        setBuilderCachedConfig(copiedFields, teamId);

        await renderBuilderFields(teamId);
        if (typeof setStatusMessage === 'function') setStatusMessage('builder', 'success', `Copied fields from ${seasonLabel}.`);
      } catch (err) {
        hideLoading();
        console.error('Failed to copy form config from another season:', err);
        if (typeof setStatusMessage === 'function') setStatusMessage('builder', 'error', 'Failed to copy fields.');
      }
    }
  });
}

// ====== Render the field list in the builder ======
async function renderBuilderFields(teamId) {
  const list = document.getElementById('builder-field-list');
  list.innerHTML = '<p class="help-text" style="text-align:center">Loading...</p>';

  try {
    const fields = await loadBuilderConfig(teamId);
    renderFreshSeasonBanner();
    list.innerHTML = '';

    if (!fields || fields.length === 0) {
      list.innerHTML = '<p class="help-text" style="text-align:center">No fields yet. Add one below.</p>';
      return;
    }

    fields.forEach((field, index) => {
      const item = createBuilderFieldItem(field, index);
      list.appendChild(item);
    });
  } catch (err) {
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

  const removeBtn = document.createElement('button');
  removeBtn.className = 'btn btn-small btn-outline';
  removeBtn.textContent = '✕';
  removeBtn.style.cssText = 'color:var(--error); border-color:var(--error); margin-left:6px';
  removeBtn.addEventListener('click', () => removeField(index));

  actions.appendChild(editBtn);
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

  const teamId = currentTeamData?.id;
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
  document.getElementById('bld-field-default').value = field?.defaultValue ?? '';

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

// ====== Save the field being edited ======
async function saveFieldEdit() {
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
  const defaultRaw = document.getElementById('bld-field-default').value.trim();

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
  if (type === 'counter' && maxRaw !== '' && minRaw !== '' && Number(maxRaw) <= Number(minRaw)) {
    if (modalErrorEl) modalErrorEl.textContent = 'Counter maximum must be greater than the minimum.';
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

  const options = (type === 'dropdown' || type === 'buttonGroup')
    ? optionsRaw.split('\n').map(s => s.trim()).filter(Boolean)
    : [];

  const teamId = currentTeamData?.id;
  if (!teamId) return;

  const configDoc = getBuilderConfigDocId();

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
      if (defaultRaw !== '') fieldData.defaultValue = Number(defaultRaw);
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

    // Save to Firestore
    await db.collection('teams').doc(teamId)
      .collection('formConfig').doc(configDoc)
      .set({ fields });

    hideLoading();

    // Invalidate cache and re-render builder
    invalidateBuilderConfigCache();
    setBuilderCachedConfig(fields, teamId);

    closeFieldEditor();
    await renderBuilderFields(teamId);
    if (typeof setStatusMessage === 'function') setStatusMessage('builder', 'success', 'Field saved!');
  } catch (err) {
    hideLoading();
    console.error('Failed to save field:', err);
    if (modalErrorEl) modalErrorEl.textContent = 'Failed to save. Please check your connection.';
  }
}

// ====== Remove a field ======
function removeField(index) {
  const teamId = currentTeamData?.id;
  if (!teamId) return;

  const fields = getBuilderCachedConfig() || [];
  const field = fields[index];
  if (!field || typeof showConfirmModal !== 'function') return;

  showConfirmModal({
    title: 'Remove Field?',
    message: `Remove field "${field.label}"? Existing scouting data for this field will be preserved in the database but will no longer display in the form.`,
    confirmLabel: 'Remove',
    danger: true,
    onConfirm: async () => {
      const configDoc = getBuilderConfigDocId();

      showLoading('Removing field...');
      try {
        const updated = fields.filter((_, i) => i !== index);
        // Recalculate sortOrders
        updated.forEach((f, i) => { f.sortOrder = i; });

        await db.collection('teams').doc(teamId)
          .collection('formConfig').doc(configDoc)
          .set({ fields: updated });

        hideLoading();

        invalidateBuilderConfigCache();
        setBuilderCachedConfig(updated, teamId);

        await renderBuilderFields(teamId);
        if (typeof setStatusMessage === 'function') setStatusMessage('builder', 'success', 'Field removed. Old data is preserved.');
      } catch (err) {
        hideLoading();
        console.error('Failed to remove field:', err);
        if (typeof setStatusMessage === 'function') setStatusMessage('builder', 'error', 'Failed to remove field.');
      }
    }
  });
}

// ====== Move a field up/down (reorder) ======
async function moveField(fromIndex, direction) {
  const teamId = currentTeamData?.id;
  if (!teamId) return;

  const fields = getBuilderCachedConfig() ? [...getBuilderCachedConfig()] : [];
  const toIndex = fromIndex + direction;
  if (toIndex < 0 || toIndex >= fields.length) return;

  // Swap
  [fields[fromIndex], fields[toIndex]] = [fields[toIndex], fields[fromIndex]];
  fields.forEach((f, i) => { f.sortOrder = i; });

  const configDoc = getBuilderConfigDocId();

  showLoading('Reordering...');
  try {
    await db.collection('teams').doc(teamId)
      .collection('formConfig').doc(configDoc)
      .set({ fields });

    hideLoading();
    invalidateBuilderConfigCache();
    setBuilderCachedConfig(fields, teamId);

    await renderBuilderFields(teamId);
  } catch (err) {
    hideLoading();
    console.error('Failed to reorder:', err);
  }
}

// ====== Close the form builder ======
function closeFormBuilder() {
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

  // Builder buttons
  document.getElementById('btn-builder-close').addEventListener('click', closeFormBuilder);
  document.getElementById('btn-builder-add-field').addEventListener('click', () => openFieldEditor(-1));

  // Copy-fields-from-a-past-season action (wishlist item 26) — only ever
  // visible/enabled while the fresh-season banner is shown.
  const copySeasonBtn = document.getElementById('btn-builder-copy-season');
  if (copySeasonBtn) {
    copySeasonBtn.addEventListener('click', () => {
      const select = document.getElementById('builder-copy-season-select');
      if (select && select.value) copyFormConfigFromSeason(select.value);
    });
  }

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