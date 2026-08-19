// ====== Pit & Match Scouting Form Builder (Captain only) ======
// Allows team captains to add, remove, reorder, and edit fields
// in the pit scouting or match scouting form configuration.
// Config stored in: teams/{teamId}/formConfig/pitScouting or matchScouting

// ====== Current form type being edited ======
let currentFormBuilderType = 'pitScouting'; // 'pitScouting' or 'matchScouting'

// ====== Field type options ======
const FIELD_TYPES = [
  { value: 'dropdown', label: 'Dropdown (select one)' },
  { value: 'text', label: 'Short Text' },
  { value: 'number', label: 'Number' },
  { value: 'counter', label: 'Counter (+/-)' },
  { value: 'textarea', label: 'Long Text / Notes' }
];

// ====== Open the form builder ======
async function openFormBuilder(type) {
  currentFormBuilderType = type || 'pitScouting';

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

  // Update tab active state
  document.querySelectorAll('.builder-type-tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.builderType === currentFormBuilderType);
  });

  document.getElementById('builder-modal').classList.remove('hidden');
  document.getElementById('builder-error').textContent = '';
  document.getElementById('builder-success').textContent = '';

  await renderBuilderFields(teamId);
}

// ====== Switch builder type tab ======
function switchBuilderType(type) {
  if (type === currentFormBuilderType) return;
  openFormBuilder(type);
}

// ====== Get the current config doc name ======
function getBuilderConfigDoc() {
  return currentFormBuilderType === 'matchScouting' ? 'matchScouting' : 'pitScouting';
}

// ====== Get the current cached config ======
function getBuilderCachedConfig() {
  return currentFormBuilderType === 'matchScouting' ? cachedMatchFormConfig : cachedFormConfig;
}

// ====== Get the current config team ID ======
function getBuilderConfigTeamId() {
  return currentFormBuilderType === 'matchScouting' ? matchFormConfigTeamId : formConfigTeamId;
}

// ====== Set the current cached config ======
function setBuilderCachedConfig(fields, teamId) {
  if (currentFormBuilderType === 'matchScouting') {
    cachedMatchFormConfig = fields;
    matchFormConfigTeamId = teamId;
  } else {
    cachedFormConfig = fields;
    formConfigTeamId = teamId;
  }
}

// ====== Invalidate the current config cache ======
function invalidateBuilderConfigCache() {
  if (currentFormBuilderType === 'matchScouting') {
    invalidateMatchFormConfigCache();
  } else {
    invalidateFormConfigCache();
  }
}

// ====== Load the current config ======
async function loadBuilderConfig(teamId) {
  if (currentFormBuilderType === 'matchScouting') {
    return await loadMatchFormConfig(teamId);
  }
  return await loadFormConfig(teamId);
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
  metaEl.textContent = `${typeLabel}${field.required ? ' • Required' : ''}`;

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

// ====== Open field editor sub-modal to edit an existing field or add a new one ======
let editingFieldIndex = -1;

function openFieldEditor(index) {
  editingFieldIndex = index;

  const teamId = currentTeamData?.id;
  if (!teamId) return;

  // Populate the editor form
  const fields = getBuilderCachedConfig() || [];
  const field = index >= 0 && index < fields.length ? fields[index] : null;

  document.getElementById('bld-field-label').value = field?.label || '';
  document.getElementById('bld-field-id').value = field?.id || '';
  document.getElementById('bld-field-type').value = field?.type || 'text';
  document.getElementById('bld-field-required').checked = field?.required || false;
  document.getElementById('bld-field-options').value = field?.options ? field.options.join('\n') : '';
  document.getElementById('bld-field-id-warning').textContent = '';

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
  optionsGroup.style.display = type === 'dropdown' ? 'block' : 'none';
  counterGroup.style.display = type === 'counter' ? 'block' : 'none';
}

// ====== Save the field being edited ======
async function saveFieldEdit() {
  const errorEl = document.getElementById('builder-error');
  const successEl = document.getElementById('builder-success');
  errorEl.textContent = '';
  successEl.textContent = '';

  const label = document.getElementById('bld-field-label').value.trim();
  const fieldId = document.getElementById('bld-field-id').value.trim();
  const type = document.getElementById('bld-field-type').value;
  const required = document.getElementById('bld-field-required').checked;
  const optionsRaw = document.getElementById('bld-field-options').value;
  const minRaw = document.getElementById('bld-field-min').value.trim();
  const maxRaw = document.getElementById('bld-field-max').value.trim();
  const stepRaw = document.getElementById('bld-field-step').value.trim();
  const defaultRaw = document.getElementById('bld-field-default').value.trim();

  if (!label) {
    errorEl.textContent = 'Field label is required.';
    return;
  }
  if (!fieldId) {
    errorEl.textContent = 'Field ID (database key) is required.';
    return;
  }
  // Validate field ID format: lowercase, no spaces, alphanumeric + underscore
  if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(fieldId)) {
    errorEl.textContent = 'Field ID must start with a letter and contain only letters, numbers, and underscores.';
    return;
  }
  if (type === 'dropdown' && !optionsRaw.trim()) {
    errorEl.textContent = 'Dropdown options are required. Enter one per line.';
    return;
  }
  if (type === 'counter' && maxRaw !== '' && minRaw !== '' && Number(maxRaw) <= Number(minRaw)) {
    errorEl.textContent = 'Counter maximum must be greater than the minimum.';
    return;
  }

  const options = type === 'dropdown'
    ? optionsRaw.split('\n').map(s => s.trim()).filter(Boolean)
    : [];

  const teamId = currentTeamData?.id;
  if (!teamId) return;

  const configDoc = getBuilderConfigDoc();

  showLoading('Saving field...');
  try {
    // Get current fields (or empty array if none)
    const fields = getBuilderCachedConfig() ? [...getBuilderCachedConfig()] : [];

    const fieldData = { id: fieldId, label, type, required, sortOrder: 0 };

    if (type === 'dropdown') {
      fieldData.options = options;
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
    successEl.textContent = 'Field saved!';
  } catch (err) {
    hideLoading();
    console.error('Failed to save field:', err);
    errorEl.textContent = 'Failed to save. Please check your connection.';
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
      const configDoc = getBuilderConfigDoc();

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
        document.getElementById('builder-success').textContent = 'Field removed. Old data is preserved.';
      } catch (err) {
        hideLoading();
        console.error('Failed to remove field:', err);
        document.getElementById('builder-error').textContent = 'Failed to remove field.';
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

  const configDoc = getBuilderConfigDoc();

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
  document.getElementById('builder-error').textContent = '';
  document.getElementById('builder-success').textContent = '';
}

// ====== Wire up event handlers ======
document.addEventListener('DOMContentLoaded', () => {
  // Open form builder from My Team tab
  document.getElementById('btn-open-form-builder').addEventListener('click', () => openFormBuilder('pitScouting'));
  document.getElementById('btn-open-match-form-builder').addEventListener('click', () => openFormBuilder('matchScouting'));

  // Builder type tabs
  document.querySelectorAll('.builder-type-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      switchBuilderType(tab.dataset.builderType);
    });
  });

  // Builder buttons
  document.getElementById('btn-builder-close').addEventListener('click', closeFormBuilder);
  document.getElementById('btn-builder-add-field').addEventListener('click', () => openFieldEditor(-1));

  // Field editor buttons
  document.getElementById('btn-bld-save').addEventListener('click', saveFieldEdit);
  document.getElementById('btn-bld-cancel').addEventListener('click', closeFieldEditor);
  document.getElementById('btn-bld-cancel-inline').addEventListener('click', closeFieldEditor);

  // Toggle options on type change
  document.getElementById('bld-field-type').addEventListener('change', toggleOptionsField);

  // Close builder on overlay click
  document.getElementById('builder-modal-overlay').addEventListener('click', closeFormBuilder);
  document.getElementById('field-editor-overlay').addEventListener('click', closeFieldEditor);
});