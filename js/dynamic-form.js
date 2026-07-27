// ====== Dynamic Pit Scouting Form System ======
// Loads field configuration from teams/{teamId}/formConfig/pitScouting
// and renders the form dynamically based on that config.
// If no config exists, seeds a default one matching the original hardcoded fields.

// ====== Default field configuration (matches original hardcoded form) ======
const DEFAULT_PIT_FIELDS = [
  {
    id: 'driveType',
    label: 'Drive Type',
    type: 'dropdown',
    required: true,
    options: ['Tank (2-motor, left/right)', 'Mecanum', 'Swerve', 'X-Drive / Omni', 'H-Drive', 'Other'],
    sortOrder: 0
  },
  {
    id: 'autoCapability',
    label: 'Auto Capability',
    type: 'dropdown',
    required: false,
    options: ['None (park only)', 'Basic (1 preload + park)', 'Intermediate (scoring + park)', 'Advanced (multi-cycle auto)', 'Custom / Hybrid'],
    sortOrder: 1
  },
  {
    id: 'claimedAvgAutoScore',
    label: 'Claimed Avg Auto Score',
    type: 'number',
    required: false,
    sortOrder: 2
  },
  {
    id: 'claimedAvgTeleopScore',
    label: 'Claimed Avg Teleop Score',
    type: 'number',
    required: false,
    sortOrder: 3
  },
  {
    id: 'claimedCycleTime',
    label: 'Claimed Cycle Time (seconds)',
    type: 'number',
    required: false,
    sortOrder: 4
  },
  {
    id: 'notes',
    label: 'Notes',
    type: 'textarea',
    required: false,
    sortOrder: 5
  }
];

// ====== Default match scouting field configuration ======
const DEFAULT_MATCH_FIELDS = [
  {
    id: 'matchNumber',
    label: 'Match Number',
    type: 'number',
    required: true,
    sortOrder: 0
  },
  {
    id: 'autoScore',
    label: 'Auto Score',
    type: 'number',
    required: false,
    sortOrder: 1
  },
  {
    id: 'teleopScore',
    label: 'Teleop Score',
    type: 'number',
    required: false,
    sortOrder: 2
  },
  {
    id: 'endgameScore',
    label: 'Endgame Score',
    type: 'number',
    required: false,
    sortOrder: 3
  },
  {
    id: 'cycleTime',
    label: 'Cycle Time (seconds)',
    type: 'number',
    required: false,
    sortOrder: 4
  },
  {
    id: 'notes',
    label: 'Notes',
    type: 'textarea',
    required: false,
    sortOrder: 5
  }
];

// ====== Cached form config (per team) ======
let cachedFormConfig = null;
let formConfigTeamId = null;

// ====== Cached match form config (per team) ======
let cachedMatchFormConfig = null;
let matchFormConfigTeamId = null;

// ====== Load (or create) form config for a team ======
async function loadFormConfig(teamId) {
  // Return cached value if same team
  if (cachedFormConfig && formConfigTeamId === teamId) {
    return cachedFormConfig;
  }

  try {
    const doc = await db.collection('teams').doc(teamId)
      .collection('formConfig').doc('pitScouting').get();

    if (doc.exists) {
      const data = doc.data();
      const sorted = (data.fields || []).sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
      cachedFormConfig = sorted;
      formConfigTeamId = teamId;
      return sorted;
    }

    // No config exists — seed default and save
    const defaultConfig = DEFAULT_PIT_FIELDS.map(f => ({ ...f }));
    await db.collection('teams').doc(teamId)
      .collection('formConfig').doc('pitScouting')
      .set({ fields: defaultConfig });

    cachedFormConfig = defaultConfig;
    formConfigTeamId = teamId;
    return defaultConfig;
  } catch (err) {
    console.warn('Failed to load form config, using defaults:', err);
    // Fall back to defaults without saving
    return DEFAULT_PIT_FIELDS.map(f => ({ ...f }));
  }
}

// ====== Invalidate the config cache (call after saving edits) ======
function invalidateFormConfigCache() {
  cachedFormConfig = null;
  formConfigTeamId = null;
}

// ====== Invalidate the match form config cache ======
function invalidateMatchFormConfigCache() {
  cachedMatchFormConfig = null;
  matchFormConfigTeamId = null;
}

// ====== Load (or create) match scouting form config for a team ======
async function loadMatchFormConfig(teamId) {
  // Return cached value if same team
  if (cachedMatchFormConfig && matchFormConfigTeamId === teamId) {
    return cachedMatchFormConfig;
  }

  try {
    const doc = await db.collection('teams').doc(teamId)
      .collection('formConfig').doc('matchScouting').get();

    if (doc.exists) {
      const data = doc.data();
      const sorted = (data.fields || []).sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
      cachedMatchFormConfig = sorted;
      matchFormConfigTeamId = teamId;
      return sorted;
    }

    // No config exists — seed default and save
    const defaultConfig = DEFAULT_MATCH_FIELDS.map(f => ({ ...f }));
    await db.collection('teams').doc(teamId)
      .collection('formConfig').doc('matchScouting')
      .set({ fields: defaultConfig });

    cachedMatchFormConfig = defaultConfig;
    matchFormConfigTeamId = teamId;
    return defaultConfig;
  } catch (err) {
    console.warn('Failed to load match form config, using defaults:', err);
    // Fall back to defaults without saving
    return DEFAULT_MATCH_FIELDS.map(f => ({ ...f }));
  }
}

// ====== Render a dynamic form into a container element ======
// Returns an object with methods to get/set values
function renderDynamicForm(container, fields, existingData) {
  container.innerHTML = '';

  const fieldElements = {}; // id -> DOM element (input, select, textarea)
  const labelElements = {}; // id -> label DOM element

  fields.forEach(field => {
    const fieldDiv = document.createElement('div');
    fieldDiv.className = 'pit-field';
    fieldDiv.dataset.fieldId = field.id;

    // Label
    const label = document.createElement('label');
    label.setAttribute('for', 'dyn-' + field.id);
    label.textContent = field.label + (field.required ? ' *' : '');
    labelElements[field.id] = label;

    const savedValue = existingData ? existingData[field.id] : undefined;

    let input;
    switch (field.type) {
      case 'dropdown':
        input = renderDropdown(field, savedValue);
        break;
      case 'number':
        input = renderNumber(field, savedValue);
        break;
      case 'textarea':
        input = renderTextarea(field, savedValue);
        break;
      case 'text':
      default:
        input = renderText(field, savedValue);
        break;
    }

    fieldElements[field.id] = input;
    fieldDiv.appendChild(label);
    fieldDiv.appendChild(input);
    container.appendChild(fieldDiv);
  });

  return {
    // Get all field values as a plain object
    getValues() {
      const values = {};
      fields.forEach(field => {
        const el = fieldElements[field.id];
        if (!el) return;
        let val;
        if (field.type === 'dropdown' || field.type === 'text') {
          val = el.value.trim();
        } else if (field.type === 'number') {
          val = el.value.trim();
          val = val !== '' ? Number(val) : null;
        } else if (field.type === 'textarea') {
          val = el.value.trim();
        }
        values[field.id] = val || null;
      });
      return values;
    },
    // Validate required fields. Returns null if valid, or error string.
    validate() {
      for (const field of fields) {
        if (!field.required) continue;
        const el = fieldElements[field.id];
        if (!el) continue;
        const val = el.value.trim();
        if (!val) {
          return `"${field.label}" is required.`;
        }
      }
      return null;
    },
    // Set values from an object (for loading existing data)
    setValues(data) {
      if (!data) return;
      fields.forEach(field => {
        const el = fieldElements[field.id];
        if (!el) return;
        const val = data[field.id];
        if (val != null) {
          el.value = val;
        }
      });
    },
    // Get a specific field element
    getField(id) {
      return fieldElements[id] || null;
    }
  };
}

// ====== Render helpers ======
function renderDropdown(field, savedValue) {
  const select = document.createElement('select');
  select.id = 'dyn-' + field.id;
  if (field.required) select.required = true;

  // Build options list
  let options = [...(field.options || [])];

  // If there's a saved value not in the options, inject it so it displays
  if (savedValue && !options.includes(savedValue)) {
    options.push(savedValue);
  }

  // Blank option
  const blankOpt = document.createElement('option');
  blankOpt.value = '';
  blankOpt.textContent = '— Select —';
  if (!savedValue) blankOpt.selected = true;
  select.appendChild(blankOpt);

  options.forEach(opt => {
    const option = document.createElement('option');
    option.value = opt;
    option.textContent = opt;
    if (savedValue === opt) option.selected = true;
    select.appendChild(option);
  });

  return select;
}

function renderNumber(field, savedValue) {
  const input = document.createElement('input');
  input.type = 'number';
  input.id = 'dyn-' + field.id;
  input.placeholder = field.label;
  input.min = '0';
  if (field.required) input.required = true;
  if (savedValue != null) input.value = savedValue;
  return input;
}

function renderText(field, savedValue) {
  const input = document.createElement('input');
  input.type = 'text';
  input.id = 'dyn-' + field.id;
  input.placeholder = field.label;
  if (field.required) input.required = true;
  if (savedValue) input.value = savedValue;
  return input;
}

function renderTextarea(field, savedValue) {
  const textarea = document.createElement('textarea');
  textarea.id = 'dyn-' + field.id;
  textarea.placeholder = field.label || 'Enter notes...';
  textarea.rows = 3;
  if (savedValue) textarea.value = savedValue;
  return textarea;
}