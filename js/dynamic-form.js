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

// ====== Default field configuration is SEASON-SCOPED, not global — a game
// changes every year, so the "no custom config yet" fallback has to change
// with it. Two tiers:
//   - GENERIC_*_FIELDS: the original game-agnostic field set (predates any
//     season-specific defaults), used for every season with no more specific
//     entry below.
//   - DECODE_*_FIELDS: the 2025 season's (2025-2026, DECODE) field set,
//     rebuilt to spec this round (an earlier round's version never actually
//     landed in production Firestore, and a still-earlier attempt this round
//     wrote it under the WRONG season key, "2026" — the 2026-2027 season is
//     a different, not-yet-named game — before being moved to "2025", the
//     season key confirmed via the app's own FTC Events API game-name lookup,
//     first-api.js's ensureSeasonGameNameLoaded()).
// SEASON_DEFAULT_PIT_FIELDS/SEASON_DEFAULT_MATCH_FIELDS map a season string
// to its field set; getDefaultPitFields()/getDefaultMatchFields() below are
// the actual lookup used everywhere (falls back to the generic set for any
// season not listed) — a team whose own formConfig doc already exists is
// untouched by any of this (loadSeasonScopedFormConfig() only ever reads a
// default for a genuinely missing doc); see
// scripts/migrate-add-decode-default-fields.js for how an EXISTING doc
// catches up with newly-added fields here instead. ======
const GENERIC_PIT_FIELDS = [
  { id: 'driveType', label: 'Drive Type', type: 'dropdown', required: true, options: ['Tank (2-motor, left/right)', 'Mecanum', 'Swerve', 'X-Drive / Omni', 'H-Drive', 'Other'], sortOrder: 0, showInPreview: true },
  { id: 'autoCapability', label: 'Auto Capability', type: 'dropdown', required: false, options: ['None (park only)', 'Basic (1 preload + park)', 'Intermediate (scoring + park)', 'Advanced (multi-cycle auto)', 'Custom / Hybrid'], sortOrder: 1, showInPreview: true },
  { id: 'claimedAvgAutoScore', label: 'Claimed Avg Auto Score', type: 'number', required: false, sortOrder: 2, showInPreview: true },
  { id: 'claimedAvgTeleopScore', label: 'Claimed Avg Teleop Score', type: 'number', required: false, sortOrder: 3, showInPreview: true },
  { id: 'claimedCycleTime', label: 'Claimed Cycle Time (seconds)', type: 'number', required: false, sortOrder: 4, showInPreview: true },
  { id: 'notes', label: 'Notes', type: 'textarea', required: false, sortOrder: 5, showInPreview: true }
];

const GENERIC_MATCH_FIELDS = [
  // Already shown in the entry list's own header ("Match #N") — defaulting
  // this to false avoids a redundant line in the preview. A team can still
  // check it on if they want it repeated there.
  { id: 'matchNumber', label: 'Match Number', type: 'number', required: true, sortOrder: 0, showInPreview: false },
  { id: 'autoScore', label: 'Auto Score', type: 'number', required: false, sortOrder: 1, showInPreview: true },
  { id: 'teleopScore', label: 'Teleop Score', type: 'number', required: false, sortOrder: 2, showInPreview: true },
  { id: 'endgameScore', label: 'Endgame Score', type: 'number', required: false, sortOrder: 3, showInPreview: true },
  { id: 'cycleTime', label: 'Cycle Time (seconds)', type: 'number', required: false, sortOrder: 4, showInPreview: true },
  { id: 'notes', label: 'Notes', type: 'textarea', required: false, sortOrder: 5, showInPreview: true }
];

const DECODE_PIT_FIELDS = [
  { id: 'drivetrainType', label: 'Drivetrain type', type: 'dropdown', required: false, options: ['Mecanum', 'Tank', 'Other'], sortOrder: 0, showInPreview: true },
  { id: 'chassisSize', label: 'Chassis size', type: 'dropdown', required: false, options: ['Small', 'Big'], sortOrder: 1, showInPreview: false },
  { id: 'weightClass', label: 'Weight class', type: 'dropdown', required: false, options: ['Light', 'Medium', 'Heavy'], sortOrder: 2, showInPreview: true },
  { id: 'parkMethod', label: 'Park Method', type: 'buttonGroup', required: false, multi: false, options: ['Drive-In', 'Lift', 'Tilter', 'Other'], sortOrder: 3, showInPreview: true },
  { id: 'transferType', label: 'Transfer type', type: 'buttonGroup', required: false, multi: false, options: ['Single-Stage/Constant', 'Sorter/Indexer'], sortOrder: 4, showInPreview: false },
  { id: 'shootingRange', label: 'Shooting range', type: 'buttonGroup', required: false, multi: false, options: ['Far', 'Medium', 'Near', 'Anywhere'], sortOrder: 5, showInPreview: true },
  { id: 'artifactLoading', label: 'Artifact loading', type: 'dropdown', required: false, options: ['Human-Player Loaded', 'Self-Intake'], sortOrder: 6, showInPreview: false },
  { id: 'humanPlayerInterop', label: 'Human player interop', type: 'dropdown', required: false, options: ['Needs Own HP', 'Can Use Ours'], sortOrder: 7, showInPreview: false },
  { id: 'claimedArtifactsScoredAuto', label: 'Claimed artifacts scored (auto)', type: 'number', required: false, sortOrder: 8, showInPreview: true },
  { id: 'claimedArtifactsScoredTeleop', label: 'Claimed artifacts scored (teleop)', type: 'number', required: false, sortOrder: 9, showInPreview: true },
  { id: 'leavesLaunchLine', label: 'Leaves launch line?', type: 'dropdown', required: false, options: ['Yes', 'No'], sortOrder: 10, showInPreview: false },
  { id: 'claimedAvgSoloMatchScore', label: 'Claimed avg solo match score', type: 'number', required: false, sortOrder: 11, showInPreview: false },
  { id: 'claimedCycleTimeSec', label: 'Claimed cycle time (sec)', type: 'number', required: false, sortOrder: 12, showInPreview: false },
  { id: 'notes', label: 'Notes', type: 'textarea', required: false, sortOrder: 13, showInPreview: true }
];

const DECODE_MATCH_FIELDS = [
  // Structural, not part of the season's real field spec — kept ahead of it
  // (explicit decision) because match-scout.js's BATCH mode (Team-based
  // Match View: still live from search results/Team Detail's Scout
  // button/Matches Scouted's re-scout) renders this as a real form field and
  // needs it to exist in the config at all. LIVE/schedule mode already
  // filters id==='matchNumber' out of its rendered fields regardless of
  // config (openMatchScoutFormFromSchedule's lockedMatchNumber path), so it
  // never shows there either way. Already shown in the entry list's own
  // header ("Match #N") — defaulting showInPreview to false avoids a
  // redundant line in the preview.
  { id: 'matchNumber', label: 'Match Number', type: 'number', required: true, sortOrder: 0, showInPreview: false },
  { id: 'artifactsScoredAuto', label: 'Artifacts scored (auto)', type: 'counter', required: false, min: 0, step: 1, sortOrder: 1, showInPreview: true },
  { id: 'leavesLaunchLine', label: 'Leaves launch line?', type: 'dropdown', required: false, options: ['Yes', 'No'], sortOrder: 2, showInPreview: true },
  { id: 'artifactsScoredTeleop', label: 'Artifacts scored (teleop)', type: 'counter', required: false, min: 0, step: 1, sortOrder: 3, showInPreview: true },
  // stopwatch: true — dynamic-form.js's wrapNumberWithStopwatch() adds a
  // Start/Stop/Reset control alongside the plain number input, filling it
  // with the elapsed seconds (1 decimal) on Stop.
  { id: 'cycleTimeSec', label: 'Cycle time (sec)', type: 'number', required: false, stopwatch: true, sortOrder: 4, showInPreview: true },
  { id: 'rankingPointsEarned', label: 'Ranking points earned', type: 'buttonGroup', required: false, multi: true, options: ['2 Win RPs', 'Movement RP', 'Goal RP', 'Pattern RP'], sortOrder: 5, showInPreview: true },
  { id: 'notes', label: 'Notes', type: 'textarea', required: false, sortOrder: 6, showInPreview: true }
];

const SEASON_DEFAULT_PIT_FIELDS = { '2025': DECODE_PIT_FIELDS };
const SEASON_DEFAULT_MATCH_FIELDS = { '2025': DECODE_MATCH_FIELDS };

function getDefaultPitFields(season) {
  return SEASON_DEFAULT_PIT_FIELDS[String(season)] || GENERIC_PIT_FIELDS;
}

function getDefaultMatchFields(season) {
  return SEASON_DEFAULT_MATCH_FIELDS[String(season)] || GENERIC_MATCH_FIELDS;
}

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
// Returns { fields, season }.
async function loadSeasonScopedFormConfig(teamId, season, configType, defaultsFn, cache) {
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
      const result = { fields: sorted, season: resolvedSeason };
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
        const result = { fields: legacyFields, season: resolvedSeason };
        cache.set(cacheKey, result);
        return result;
      }
    }

    // No season-scoped doc, no legacy doc to inherit — fresh default config.
    // Seasons have entirely different game elements, so there's no copy-from-
    // another-season option here — this is always just the plain generic
    // (or, for the one season keyed in SEASON_DEFAULT_*_FIELDS, DECODE)
    // default, straight from getDefaultPitFields()/getDefaultMatchFields().
    const defaultConfig = defaultsFn(resolvedSeason).map(f => ({ ...f }));
    await configRef.set({ fields: defaultConfig });
    const result = { fields: defaultConfig, season: resolvedSeason };
    cache.set(cacheKey, result);
    return result;
  } catch (err) {
    console.warn(`Failed to load ${configType} form config for season ${resolvedSeason}, using defaults:`, err);
    // Fall back to defaults without saving
    return { fields: defaultsFn(resolvedSeason).map(f => ({ ...f })), season: resolvedSeason };
  }
}

// ====== Load (or create/migrate) pit scouting form config for a team +
// season. season defaults to the app's currently-selected season. ======
async function loadFormConfig(teamId, season) {
  const { fields } = await loadSeasonScopedFormConfig(teamId, season, 'pitScouting', getDefaultPitFields, formConfigCache);
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
  const { fields } = await loadSeasonScopedFormConfig(teamId, season, 'matchScouting', getDefaultMatchFields, matchFormConfigCache);
  return fields;
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
      case 'buttonGroup':
        input = renderButtonGroup(field, savedValue);
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
        } else if (field.type === 'buttonGroup') {
          // A plain string (single-select, same shape as dropdown) or an
          // array (multi-select) — see renderButtonGroup()'s value getter.
          val = el.value;
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
        // Multi-select button-group value is an array, not a string — .trim()
        // would throw. "Required" means at least one option chosen.
        if (field.type === 'buttonGroup' && field.multi) {
          if (!Array.isArray(el.value) || el.value.length === 0) {
            return `"${field.label}" is required.`;
          }
          continue;
        }
        const val = String(el.value ?? '').trim();
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
    }
  };
}

// ====== Format a stored field value for read-only display — array-safe for
// multi-select button-group values (joined with " + "; an empty array reads
// as "—", same as any other empty value), scalar otherwise. Shared by
// team-info.js's/match-scout.js's preview-line rendering and
// pit-vs-match.js's comparison/print views, so every place a field value is
// shown as plain text agrees on the same rules. ======
function formatFieldValueForDisplay(val) {
  if (Array.isArray(val)) {
    return val.length > 0 ? val.join(' + ') : '—';
  }
  return (val === null || val === undefined || val === '') ? '—' : String(val);
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
  // A cycle-time-style field shows a browser-native autocomplete dropdown of
  // previously typed values (no name attribute is set on these dynamic
  // inputs, so Chrome falls back to keying its form-value history off id,
  // which is stable/reused across every render of this field) — every match
  // has a genuinely different value here, so that history is pure noise.
  // Other number fields don't show it, so scope the fix to just
  // stopwatch-driven fields rather than disabling autocomplete on every
  // dynamic number field. (Previously scoped to the literal id "cycleTime"
  // — generalized to field.stopwatch since that's the actual reason, not
  // that specific id, and the DECODE rebuild's cycle-time field uses a
  // different id.)
  if (field.stopwatch) input.autocomplete = 'off';
  if (!field.stopwatch) return input;
  return wrapNumberWithStopwatch(field, input);
}

// ====== Optional stopwatch helper for a `number` field (field.stopwatch:
// true in its config) — Start/Stop/Reset alongside the plain number input,
// filling it with the elapsed seconds (1 decimal place) on Stop rather than
// requiring the seconds to be counted by hand and typed in. The field is
// still just a number underneath — the stopwatch only ever writes into
// `input`, never replaces the underlying value contract, and the number can
// still be typed/edited directly regardless of whether the stopwatch was
// used at all. Returns a wrapper div exposing a `.value` proxy onto the real
// input, same pattern as renderCounter()/renderButtonGroup()'s wrappers, so
// every generic caller (getValues/validate/setValues, live-entry-sync's
// wireLiveFormFields/applyRemoteFieldValues) keeps working without knowing
// this field is anything other than a plain input. ======
function wrapNumberWithStopwatch(field, input) {
  const wrapper = document.createElement('div');
  wrapper.className = 'number-stopwatch-field';

  const controls = document.createElement('div');
  controls.className = 'stopwatch-controls';

  const timeDisplay = document.createElement('span');
  timeDisplay.className = 'stopwatch-time';
  timeDisplay.textContent = '0.0s';

  const startBtn = document.createElement('button');
  startBtn.type = 'button';
  startBtn.className = 'btn btn-small btn-outline stopwatch-btn';
  startBtn.textContent = 'Start';

  const stopBtn = document.createElement('button');
  stopBtn.type = 'button';
  stopBtn.className = 'btn btn-small btn-outline stopwatch-btn';
  stopBtn.textContent = 'Stop';
  stopBtn.disabled = true;

  const resetBtn = document.createElement('button');
  resetBtn.type = 'button';
  resetBtn.className = 'btn btn-small btn-outline stopwatch-btn';
  resetBtn.textContent = 'Reset';

  let startedAt = null;
  let rafId = null;

  function tick() {
    if (startedAt == null) return;
    timeDisplay.textContent = ((Date.now() - startedAt) / 1000).toFixed(1) + 's';
    rafId = requestAnimationFrame(tick);
  }

  function stopTicking() {
    if (rafId != null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  }

  startBtn.addEventListener('click', () => {
    if (startedAt != null) return;
    startedAt = Date.now();
    startBtn.disabled = true;
    stopBtn.disabled = false;
    tick();
  });

  stopBtn.addEventListener('click', () => {
    if (startedAt == null) return;
    const elapsedSec = Math.round(((Date.now() - startedAt) / 1000) * 10) / 10;
    startedAt = null;
    stopTicking();
    startBtn.disabled = false;
    stopBtn.disabled = true;
    timeDisplay.textContent = elapsedSec.toFixed(1) + 's';
    input.value = elapsedSec;
    // Setting .value via JS doesn't fire a native input/change event —
    // dispatch one (bubbling, so the wrapper's own listener — set up
    // generically by wireLiveFormFields, live-entry-sync.js — catches it
    // the same way it catches a real keystroke) so the stopwatch-filled
    // value actually gets saved/synced, not just displayed.
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });

  resetBtn.addEventListener('click', () => {
    startedAt = null;
    stopTicking();
    startBtn.disabled = false;
    stopBtn.disabled = true;
    timeDisplay.textContent = '0.0s';
  });

  controls.appendChild(startBtn);
  controls.appendChild(stopBtn);
  controls.appendChild(resetBtn);
  controls.appendChild(timeDisplay);

  wrapper.appendChild(input);
  wrapper.appendChild(controls);

  Object.defineProperty(wrapper, 'value', {
    get() { return input.value; },
    set(val) { input.value = (val != null) ? val : ''; }
  });

  return wrapper;
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
  // Direct editing (see beginEdit() below): the displayed number is also a
  // click/tap target and keyboard-focusable, not just a label between the
  // +/- buttons.
  display.tabIndex = 0;
  display.setAttribute('role', 'button');
  display.title = 'Click to type a value directly';

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

  // ====== Direct editing — click/tap the displayed number (or Enter/Space
  // while it has keyboard focus) to type a value straight in, instead of
  // only ever stepping one tap at a time. Swaps the span for a real
  // <input type="number"> for the duration of the edit; the span stays what
  // the rest of the form (getValues/validate/setValues, via wrapper.value
  // below) actually reads — an in-progress edit's typed-but-uncommitted
  // value is never that source of truth, same as any other field never
  // reporting a value until it's actually settled. ======
  let editInput = null;
  // Bug fix (found via testing, not just review): removing the focused
  // editInput — cancel()'s job on Escape — itself fires a native 'blur' on
  // it, which the commit() listener below is ALSO subscribed to. Without
  // this guard, pressing Escape ran cancel() then immediately ran commit()
  // too (via that blur), silently re-committing whatever had been typed —
  // exactly the "Escape does nothing" bug this direct-editing feature must
  // not have. cancel() sets this right before removing the input so
  // commit() can tell "this blur is cancel() tearing down" apart from "the
  // user actually clicked/tabbed away" and skip re-running itself.
  let suppressBlurCommit = false;
  function beginEdit() {
    if (editInput) return; // already editing
    editInput = document.createElement('input');
    editInput.type = 'number';
    editInput.className = 'counter-edit-input';
    editInput.value = String(current);
    editInput.min = String(min);
    if (max !== null) editInput.max = String(max);
    editInput.step = String(step);

    const commit = () => {
      if (!editInput) return;
      if (suppressBlurCommit) {
        suppressBlurCommit = false;
        return;
      }
      const raw = editInput.value.trim();
      let num = raw === '' ? current : Number(raw);
      if (!Number.isFinite(num)) num = current;
      num = Math.max(min, num);
      if (max !== null) num = Math.min(max, num);
      const changed = num !== current;
      current = num;
      editInput.remove();
      editInput = null;
      display.classList.remove('hidden');
      render();
      if (changed) notifyChanged();
    };
    const cancel = () => {
      if (!editInput) return;
      suppressBlurCommit = true;
      editInput.remove();
      editInput = null;
      display.classList.remove('hidden');
    };

    editInput.addEventListener('blur', commit);
    editInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        editInput.blur(); // triggers commit via the blur listener above
      } else if (e.key === 'Escape') {
        e.preventDefault();
        cancel();
      }
    });

    display.classList.add('hidden');
    display.insertAdjacentElement('afterend', editInput);
    editInput.focus();
    editInput.select();
  }

  display.addEventListener('click', beginEdit);
  display.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      beginEdit();
    }
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

// ====== Button Group: a row of small toggle buttons over field.options.
// field.multi false (default) -> radio-like, exactly one active at a time,
// value is a single string (or null if nothing's been chosen yet) — same
// shape as a dropdown's value. field.multi true -> independent toggles, any
// number active at once, value is always an array (never null, [] when
// nothing's chosen). savedValue may arrive as either shape regardless of the
// field's current `multi` setting (a team could flip that setting after data
// already exists), so it's normalized defensively rather than assumed. ======
function renderButtonGroup(field, savedValue) {
  const wrapper = document.createElement('div');
  wrapper.className = 'button-group-field';
  wrapper.id = 'dyn-' + field.id;

  const options = field.options || [];
  const isMulti = !!field.multi;
  const buttons = new Map(); // option -> button element

  let active = new Set();
  if (Array.isArray(savedValue)) {
    savedValue.forEach((v) => active.add(v));
  } else if (savedValue != null && savedValue !== '') {
    active.add(savedValue);
  }

  function syncButtonStates() {
    options.forEach((opt) => {
      const btn = buttons.get(opt);
      if (!btn) return;
      const isActive = active.has(opt);
      btn.classList.toggle('active', isActive);
      btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    });
  }

  // Dispatched on every click so wireLiveFormFields() (live-entry-sync.js)
  // can wire this the same generic way as a dropdown — a discrete choice,
  // not a keystroke stream, so 'change' (not 'input') matches how it treats
  // dropdown fields.
  function notifyChanged() {
    wrapper.dispatchEvent(new Event('change', { bubbles: false }));
  }

  options.forEach((opt) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'button-group-option';
    btn.textContent = opt;
    btn.addEventListener('click', () => {
      if (isMulti) {
        if (active.has(opt)) active.delete(opt);
        else active.add(opt);
      } else if (active.has(opt)) {
        // Bug fix (decision reversed from an earlier round): single-select
        // used to be strictly radio-like — clicking the already-active
        // option did nothing, with no way to get back to "nothing selected"
        // short of deleting/retyping the entry. Every OTHER single-select
        // field type (a dropdown always has its blank "— Select —" option)
        // already supports clearing back to unset; this brings Button Group
        // in line with that instead of being the one exception.
        active = new Set();
      } else {
        active = new Set([opt]);
      }
      syncButtonStates();
      notifyChanged();
    });
    buttons.set(opt, btn);
    wrapper.appendChild(btn);
  });

  syncButtonStates();

  // Same pattern as renderCounter()'s wrapper — exposes `.value` so the
  // generic getValues/validate/setValues code above can read/write this
  // like any other field element without knowing it's not a real input.
  Object.defineProperty(wrapper, 'value', {
    get() {
      if (isMulti) return Array.from(active);
      const first = active.values().next();
      return first.done ? null : first.value;
    },
    set(val) {
      active = new Set();
      if (Array.isArray(val)) {
        val.forEach((v) => active.add(v));
      } else if (val != null && val !== '') {
        active.add(val);
      }
      syncButtonStates();
    }
  });

  return wrapper;
}