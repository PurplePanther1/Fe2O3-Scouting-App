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

  populateBuilderSeasonSelect();
  document.getElementById('builder-modal').classList.remove('hidden');
  await applyBuilderSeasonAndType(teamId);
}

// ====== Switch builder type tab — preserves whatever season is currently
// selected (see the season <select>'s own change handler below); only the
// type changes here, unlike a fresh openFormBuilder() call which always
// resets to the app's globally-selected season. ======
function switchBuilderType(type) {
  if (type === currentFormBuilderType) return;
  currentFormBuilderType = type;
  const teamId = currentTeamData?.id;
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
  document.getElementById('builder-modal-title').textContent = title;

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
  cache.set(`${teamId}_${currentBuilderSeason}`, { fields, season: currentBuilderSeason });
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

// ====== Load the current config (fields array) ======
async function loadBuilderConfig(teamId) {
  const defaults = currentFormBuilderType === 'matchScouting' ? getDefaultMatchFields : getDefaultPitFields;
  const cache = currentFormBuilderType === 'matchScouting' ? matchFormConfigCache : formConfigCache;
  const result = await loadSeasonScopedFormConfig(teamId, currentBuilderSeason, currentFormBuilderType, defaults, cache);
  return result.fields;
}

// ====== Render the field list in the builder ======
async function renderBuilderFields(teamId) {
  const list = document.getElementById('builder-field-list');
  list.innerHTML = '<p class="help-text" style="text-align:center">Loading...</p>';

  try {
    const fields = await loadBuilderConfig(teamId);
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

  // In-builder season switcher — lets a captain build/maintain a past
  // season's form, or hop between seasons, without leaving the builder to
  // change the app's main season selector first. Preserves the current
  // builder-type tab (pit/match), only the season changes.
  const seasonSelect = document.getElementById('builder-season-select');
  if (seasonSelect) {
    seasonSelect.addEventListener('change', (e) => {
      currentBuilderSeason = e.target.value;
      const teamId = currentTeamData?.id;
      if (!teamId) return;
      applyBuilderSeasonAndType(teamId);
    });
  }

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