// ====== Dynamic Pit Scouting Form System ======
// Loads field configuration from teams/{teamId}/formConfig/{season}_pitScouting
// and renders the form dynamically based on that config. Config is scoped per
// FTC season (see getSelectedSeason()/getCurrentFtcSeason(), first-api.js) so
// editing one season's form never changes how another season's already-
// collected data displays or exports.
// If no config exists for a season, seeds a default one matching the original
// hardcoded fields — EXCEPT the current season the very first time it's ever
// loaded post-migration, which instead inherits the old pre-season-scoping
// shared doc (formConfig/pitScouting or matchScouting, no season prefix) if
// one exists, so existing teams' already-configured forms aren't silently
// reset. See loadSeasonScopedFormConfig() below.

// ====== Default field configuration (matches original hardcoded form) ======
const DEFAULT_PIT_FIELDS = [
  {
    id: 'driveType',
    label: 'Drive Type',
    type: 'dropdown',
    required: true,
    options: ['Tank (2-motor, left/right)', 'Mecanum', 'Swerve', 'X-Drive / Omni', 'H-Drive', 'Other'],
    sortOrder: 0,
    showInPreview: true
  },
  {
    id: 'autoCapability',
    label: 'Auto Capability',
    type: 'dropdown',
    required: false,
    options: ['None (park only)', 'Basic (1 preload + park)', 'Intermediate (scoring + park)', 'Advanced (multi-cycle auto)', 'Custom / Hybrid'],
    sortOrder: 1,
    showInPreview: true
  },
  {
    id: 'claimedAvgAutoScore',
    label: 'Claimed Avg Auto Score',
    type: 'number',
    required: false,
    sortOrder: 2,
    showInPreview: true
  },
  {
    id: 'claimedAvgTeleopScore',
    label: 'Claimed Avg Teleop Score',
    type: 'number',
    required: false,
    sortOrder: 3,
    showInPreview: true
  },
  {
    id: 'claimedCycleTime',
    label: 'Claimed Cycle Time (seconds)',
    type: 'number',
    required: false,
    sortOrder: 4,
    showInPreview: true
  },
  {
    id: 'notes',
    label: 'Notes',
    type: 'textarea',
    required: false,
    sortOrder: 5,
    showInPreview: true
  }
];

// ====== Default match scouting field configuration ======
const DEFAULT_MATCH_FIELDS = [
  {
    id: 'matchNumber',
    label: 'Match Number',
    type: 'number',
    required: true,
    sortOrder: 0,
    // Already shown in the entry list's own header ("Match #N") — defaulting
    // this to false avoids a redundant line in the preview. A team can still
    // check it on if they want it repeated there.
    showInPreview: false
  },
  {
    id: 'autoScore',
    label: 'Auto Score',
    type: 'number',
    required: false,
    sortOrder: 1,
    showInPreview: true
  },
  {
    id: 'teleopScore',
    label: 'Teleop Score',
    type: 'number',
    required: false,
    sortOrder: 2,
    showInPreview: true
  },
  {
    id: 'endgameScore',
    label: 'Endgame Score',
    type: 'number',
    required: false,
    sortOrder: 3,
    showInPreview: true
  },
  {
    id: 'cycleTime',
    label: 'Cycle Time (seconds)',
    type: 'number',
    required: false,
    sortOrder: 4,
    showInPreview: true
  },
  {
    id: 'notes',
    label: 'Notes',
    type: 'textarea',
    required: false,
    sortOrder: 5,
    showInPreview: true
  }
];

// ====== Resolve the FTC season a form config lookup/save should target when
// no explicit season is given — always "whatever the app's season selector
// currently shows" (getSelectedSeason(), first-api.js), the same signal
// every other event-scoped lookup in this app already keys off of. Falls
// back to getCurrentFtcSeason() if the selector isn't in the DOM yet (e.g.
// called before first-api.js's DOMContentLoaded populates it). Always
// returned as a string, matching the season dropdown's own value type and
// the {season}_pitScouting doc-ID convention. ======
function resolveFormConfigSeason(season) {
  if (season !== undefined && season !== null && season !== '') return String(season);
  if (typeof getSelectedSeason === 'function') {
    const fromSelector = getSelectedSeason();
    if (fromSelector) return String(fromSelector);
  }
  return String(getCurrentFtcSeason());
}

// ====== Cached form config, keyed by "teamId_season" ======
const formConfigCache = new Map();

// ====== Cached match form config, keyed by "teamId_season" ======
const matchFormConfigCache = new Map();

// ====== Shared season-scoped load/seed/migrate logic for both pit and match
// form config. configType is 'pitScouting' or 'matchScouting'. The doc ID for
// season S is "{S}_{configType}" (e.g. "2025_pitScouting") — a plain doc-ID
// change within the existing formConfig collection, not a new subcollection
// level, so no firestore.rules changes are needed (the existing
// match /formConfig/{configDoc} rule already applies to any doc ID in that
// collection).
//
// Migration: existing teams have ONE pre-season-scoping shared doc at the
// OLD un-prefixed ID (formConfig/pitScouting or formConfig/matchScouting).
// The first time the CURRENT season's config is loaded and no
// {currentSeason}_{configType} doc exists yet, that legacy doc's fields (if
// any) are copied in as the current season's starting config — so existing
// teams' already-configured forms keep working immediately after this ships.
// Any OTHER season (past or, once seasons roll over, future) with no config
// doc yet just seeds DEFAULT_*_FIELDS fresh and never touches the legacy
// doc — a new season always starts from a clean form, per design. The legacy
// doc itself is left in place afterward (unused, harmless) rather than
// deleted. ======
// Returns { fields, season, wasFresh }. wasFresh is true only when NO
// season-scoped doc existed yet and the hardcoded defaults had to be seeded
// (i.e. there was nothing — not even a legacy config — to inherit) — used by
// form-builder.js to show its "fresh form" banner and copy-from-past-season
// action. Inheriting the legacy config counts as already-configured, not
// fresh, since the team has real content either way. ======
async function loadSeasonScopedFormConfig(teamId, season, configType, defaults, cache) {
  const resolvedSeason = resolveFormConfigSeason(season);
  const cacheKey = `${teamId}_${resolvedSeason}`;
  if (cache.has(cacheKey)) {
    return cache.get(cacheKey);
  }

  const docId = `${resolvedSeason}_${configType}`;
  const configRef = db.collection('teams').doc(teamId).collection('formConfig').doc(docId);

  try {
    const doc = await configRef.get();

    if (doc.exists) {
      const data = doc.data();
      const sorted = (data.fields || []).sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
      const result = { fields: sorted, season: resolvedSeason, wasFresh: false };
      cache.set(cacheKey, result);
      return result;
    }

    // No season-scoped doc yet. Only the CURRENT season inherits the old
    // shared (un-prefixed) config, and only on its own first load ever.
    if (resolvedSeason === String(getCurrentFtcSeason())) {
      const legacyDoc = await db.collection('teams').doc(teamId)
        .collection('formConfig').doc(configType).get();
      if (legacyDoc.exists) {
        const legacyFields = (legacyDoc.data().fields || []).sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
        await configRef.set({ fields: legacyFields });
        const result = { fields: legacyFields, season: resolvedSeason, wasFresh: false };
        cache.set(cacheKey, result);
        return result;
      }
    }

    // No season-scoped doc, no legacy doc to inherit — fresh default config.
    const defaultConfig = defaults.map(f => ({ ...f }));
    await configRef.set({ fields: defaultConfig });
    const result = { fields: defaultConfig, season: resolvedSeason, wasFresh: true };
    cache.set(cacheKey, result);
    return result;
  } catch (err) {
    console.warn(`Failed to load ${configType} form config for season ${resolvedSeason}, using defaults:`, err);
    // Fall back to defaults without saving
    return { fields: defaults.map(f => ({ ...f })), season: resolvedSeason, wasFresh: true };
  }
}

// ====== Load (or create/migrate) pit scouting form config for a team +
// season. season defaults to the app's currently-selected season. ======
async function loadFormConfig(teamId, season) {
  const { fields } = await loadSeasonScopedFormConfig(teamId, season, 'pitScouting', DEFAULT_PIT_FIELDS, formConfigCache);
  return fields;
}

// ====== Invalidate the pit form config cache — call after saving edits.
// With no args, clears every cached team/season; pass teamId (and optionally
// season) to invalidate more narrowly. ======
function invalidateFormConfigCache(teamId, season) {
  if (teamId === undefined) { formConfigCache.clear(); return; }
  if (season === undefined) {
    Array.from(formConfigCache.keys())
      .filter(key => key.startsWith(`${teamId}_`))
      .forEach(key => formConfigCache.delete(key));
    return;
  }
  formConfigCache.delete(`${teamId}_${resolveFormConfigSeason(season)}`);
}

// ====== Invalidate the match form config cache — same shape as
// invalidateFormConfigCache() above, for matchFormConfigCache. ======
function invalidateMatchFormConfigCache(teamId, season) {
  if (teamId === undefined) { matchFormConfigCache.clear(); return; }
  if (season === undefined) {
    Array.from(matchFormConfigCache.keys())
      .filter(key => key.startsWith(`${teamId}_`))
      .forEach(key => matchFormConfigCache.delete(key));
    return;
  }
  matchFormConfigCache.delete(`${teamId}_${resolveFormConfigSeason(season)}`);
}

// ====== Load (or create/migrate) match scouting form config for a team +
// season. season defaults to the app's currently-selected season. ======
async function loadMatchFormConfig(teamId, season) {
  const { fields } = await loadSeasonScopedFormConfig(teamId, season, 'matchScouting', DEFAULT_MATCH_FIELDS, matchFormConfigCache);
  return fields;
}

// ====== List every OTHER season that has a real saved config for the given
// type ("pitScouting"/"matchScouting"), newest first — used by the form
// builder's "copy fields from a past season" action (wishlist item 26).
// Reads the whole (small — a couple docs per season) formConfig collection
// and picks out doc IDs of the form "{season}_{configType}", since Firestore
// can't query by ID suffix. excludeSeason is normally whichever season the
// builder currently has open, so it can't "copy" a season onto itself. ======
async function listOtherSeasonsWithFormConfig(teamId, configType, excludeSeason) {
  const snap = await db.collection('teams').doc(teamId).collection('formConfig').get();
  const suffix = `_${configType}`;
  const seasons = [];
  snap.forEach(doc => {
    if (!doc.id.endsWith(suffix)) return;
    const season = doc.id.slice(0, -suffix.length);
    if (!/^\d+$/.test(season)) return; // skip the un-prefixed legacy doc
    if (season === String(excludeSeason)) return;
    seasons.push(season);
  });
  return seasons.sort((a, b) => Number(b) - Number(a));
}

// ====== Render a dynamic form into a container element ======
// Returns an object with methods to get/set values
function renderDynamicForm(container, fields, existingData) {
  container.innerHTML = '';

  const fieldElements = {}; // id -> DOM element (input, select, textarea)
  const labelElements = {}; // id -> label DOM element
  const fieldDivs = {}; // id -> wrapping div, used by setFieldPresenceIndicator()

  fields.forEach(field => {
    const fieldDiv = document.createElement('div');
    fieldDiv.className = 'pit-field';
    fieldDiv.dataset.fieldId = field.id;
    fieldDivs[field.id] = fieldDiv;

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
    // Set values from an object (for loading existing data). A key whose
    // value is null/undefined clears that field back to blank — matters for
    // live remote updates (dynamic-form.js itself is only ever called with a
    // full snapshot, where this was previously harmless either way).
    setValues(data) {
      if (!data) return;
      fields.forEach(field => {
        const el = fieldElements[field.id];
        if (!el) return;
        if (!(field.id in data)) return;
        const val = data[field.id];
        el.value = (val != null) ? val : '';
      });
    },
    // Get a specific field element
    getField(id) {
      return fieldElements[id] || null;
    },
    // Show/hide a lightweight "someone else is focused here" indicator on one
    // field. Pass a display name to show it, or null/undefined to clear it.
    // Used by live-entry-sync.js's applyPresenceIndicators() — not a lock,
    // purely visual (see that file for why).
    setFieldPresenceIndicator(id, name) {
      const fieldDiv = fieldDivs[id];
      if (!fieldDiv) return;
      let tag = fieldDiv.querySelector('.field-presence-tag');
      if (!name) {
        fieldDiv.classList.remove('field-presence-active');
        if (tag) tag.remove();
        return;
      }
      fieldDiv.classList.add('field-presence-active');
      if (!tag) {
        tag = document.createElement('span');
        tag.className = 'field-presence-tag';
        fieldDiv.appendChild(tag);
      }
      tag.textContent = name;
    },
    // Disable/enable every rendered field — used for the read-only "someone
    // else is already editing this" view, before a "Take Over" click (if any)
    // switches the form into edit mode.
    setReadOnly(readOnly) {
      fields.forEach(field => {
        const el = fieldElements[field.id];
        if (!el) return;
        if (field.type === 'counter') {
          el.querySelectorAll('button').forEach(btn => { btn.disabled = readOnly; });
        } else {
          el.disabled = readOnly;
        }
      });
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
  // The match form's Cycle Time field shows a browser-native autocomplete
  // dropdown of previously typed values (no name attribute is set on these
  // dynamic inputs, so Chrome falls back to keying its form-value history off
  // id, which is stable/reused across every render of this field) — other
  // fields don't show it, so scope the fix to just this one rather than
  // disabling autocomplete on every dynamic number field.
  if (field.id === 'cycleTime') input.autocomplete = 'off';
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

  // Dispatches a synthetic 'input' on the wrapper itself after each tap, so
  // wireLiveFormFields() (live-entry-sync.js) can wire a counter field the
  // same generic way as any real <input> — it only listens for event names,
  // not a specific element type. (No synthetic focus/blur here: there's no
  // natural "focused" moment for a +/- button tap, so counter fields don't
  // get the live field-level presence indicator — a known, accepted gap.)
  function notifyChanged() {
    wrapper.dispatchEvent(new Event('input', { bubbles: false }));
  }

  minusBtn.addEventListener('click', () => {
    if (current <= min) return;
    current = Math.max(min, current - step);
    render();
    playCounterTone('down');
    notifyChanged();
  });

  plusBtn.addEventListener('click', () => {
    if (max !== null && current >= max) return;
    current = max !== null ? Math.min(max, current + step) : current + step;
    render();
    playCounterTone('up');
    notifyChanged();
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