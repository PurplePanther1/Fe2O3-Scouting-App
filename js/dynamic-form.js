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
      case 'counter':
        input = renderCounter(field, savedValue);
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
          val = el.value.trim() || null;
        } else if (field.type === 'number') {
          const raw = el.value.trim();
          val = raw !== '' ? Number(raw) : null;
        } else if (field.type === 'counter') {
          val = Number(el.value);
        } else if (field.type === 'textarea') {
          val = el.value.trim() || null;
        }
        values[field.id] = val;
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

function renderCounter(field, savedValue) {
  const wrapper = document.createElement('div');
  wrapper.className = 'counter-field';
  wrapper.id = 'dyn-' + field.id;

  const min = (field.min !== undefined && field.min !== null && field.min !== '') ? Number(field.min) : 0;
  const max = (field.max !== undefined && field.max !== null && field.max !== '') ? Number(field.max) : null;
  const step = (field.step !== undefined && field.step !== null && field.step !== '') ? Number(field.step) : 1;
  const startValue = (field.defaultValue !== undefined && field.defaultValue !== null && field.defaultValue !== '') ? Number(field.defaultValue) : min;

  let current = (savedValue !== undefined && savedValue !== null && savedValue !== '') ? Number(savedValue) : startValue;

  const minusBtn = document.createElement('button');
  minusBtn.type = 'button';
  minusBtn.className = 'counter-btn counter-btn-minus';
  minusBtn.textContent = '−';
  minusBtn.setAttribute('aria-label', `Decrease ${field.label}`);

  const display = document.createElement('span');
  display.className = 'counter-display';

  const plusBtn = document.createElement('button');
  plusBtn.type = 'button';
  plusBtn.className = 'counter-btn counter-btn-plus';
  plusBtn.textContent = '+';
  plusBtn.setAttribute('aria-label', `Increase ${field.label}`);

  function render() {
    display.textContent = current;
    minusBtn.disabled = current <= min;
    plusBtn.disabled = max !== null && current >= max;
  }

  minusBtn.addEventListener('click', () => {
    if (current <= min) return;
    current = Math.max(min, current - step);
    render();
    playCounterTone('down');
  });

  plusBtn.addEventListener('click', () => {
    if (max !== null && current >= max) return;
    current = max !== null ? Math.min(max, current + step) : current + step;
    render();
    playCounterTone('up');
  });

  render();

  // Expose a `.value` property so this wrapper can be read/written by the
  // generic getValues/validate/setValues code the same way a real <input> would be.
  Object.defineProperty(wrapper, 'value', {
    get() {
      return String(current);
    },
    set(val) {
      const num = Number(val);
      current = Number.isFinite(num) ? num : min;
      render();
    }
  });

  wrapper.appendChild(minusBtn);
  wrapper.appendChild(display);
  wrapper.appendChild(plusBtn);

  return wrapper;
}

// ====== Counter tap sound (Web Audio API — no external asset needed) ======
let counterAudioCtx = null;
function playCounterTone(direction) {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    if (!counterAudioCtx) {
      counterAudioCtx = new AudioCtx();
    }
    if (counterAudioCtx.state === 'suspended') {
      counterAudioCtx.resume();
    }
    const osc = counterAudioCtx.createOscillator();
    const gain = counterAudioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = direction === 'up' ? 880 : 440;
    gain.gain.setValueAtTime(0.15, counterAudioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, counterAudioCtx.currentTime + 0.12);
    osc.connect(gain);
    gain.connect(counterAudioCtx.destination);
    osc.start();
    osc.stop(counterAudioCtx.currentTime + 0.12);
  } catch (err) {
    console.warn('Counter sound playback failed:', err);
  }
}

function renderTextarea(field, savedValue) {
  const textarea = document.createElement('textarea');
  textarea.id = 'dyn-' + field.id;
  textarea.placeholder = field.label || 'Enter notes...';
  textarea.rows = 3;
  if (savedValue) textarea.value = savedValue;
  return textarea;
}