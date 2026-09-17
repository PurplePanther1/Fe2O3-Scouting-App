// ====== Pit vs Match Comparison (roadmap step 6) ======
// Lays a team's pit-scouted claims side by side with what was actually
// observed across its match entries at one event — "did what they told us
// in the pit match what we saw them do on the field".
//
// Deliberately NO automatic field pairing: pit and match forms are two
// entirely independent, freeform, season-scoped field lists (dynamic-form.js)
// with no shared concept linking a pit field to a match field. Rather than
// guess a correspondence, this shows the pit entry's fields and an
// auto-generated match-stats summary (average/min/max for number/counter
// fields, a frequency breakdown for dropdowns, raw notes for text/textarea)
// next to each other, and leaves the actual "does this match up" judgment to
// whoever's reading it.
//
// Match-entry inclusion (which entries feed the stats column) is SESSION-ONLY
// state — matchInclusionState below — not written back to Firestore. A
// mismatched-match-number entry (reusing sheets-export.js's
// splitMismatchedMatchEntries(), the same schedule-based check used for
// save-time warnings and export) defaults to excluded; every other entry
// defaults to included.

let currentComparisonTeamNumber = null;
let currentComparisonEventCode = null;

// "eventCode_teamNumber" -> Map(entryId -> boolean). Only ever grown, never
// reset for a key already seen this session, so a toggle a user makes
// survives closing/reopening the comparison or the matches-used modal.
const matchInclusionState = new Map();

// ====== Get (lazily creating) this team+event's inclusion map, seeding any
// not-yet-seen entry with its default: mismatched -> excluded, everything
// else -> included. Never overwrites an entry already present, so a manual
// toggle from an earlier render of this same team+event is preserved. ======
function getInclusionMap(eventCode, teamNumber, normalEntries, mismatchedEntries) {
  const key = `${eventCode}_${teamNumber}`;
  let map = matchInclusionState.get(key);
  if (!map) {
    map = new Map();
    matchInclusionState.set(key, map);
  }
  (normalEntries || []).forEach((e) => { if (!map.has(e.id)) map.set(e.id, true); });
  (mismatchedEntries || []).forEach((e) => { if (!map.has(e.id)) map.set(e.id, false); });
  return map;
}

// ====== Compute per-field match stats across INCLUDED entries only.
// number/counter -> average/min/max/count; dropdown -> a frequency
// breakdown; text/textarea are intentionally excluded here (nothing numeric
// to summarize) — see collectMatchTextNotes() below for those instead.
// Returns [] for an empty entries array — callers still get a stat object
// per field with count:0, never NaN/undefined, so rendering never needs a
// special empty-input case beyond checking `entries.length === 0` up front. ======
function computeMatchFieldStats(entries, matchFields) {
  const list = entries || [];
  return (matchFields || [])
    .filter((f) => f.type !== 'text' && f.type !== 'textarea')
    .map((field) => {
      if (field.type === 'number' || field.type === 'counter') {
        const vals = list
          .map((e) => e[field.id])
          .filter((v) => typeof v === 'number' && Number.isFinite(v));
        if (vals.length === 0) return { field, type: field.type, count: 0 };
        const sum = vals.reduce((a, b) => a + b, 0);
        return {
          field,
          type: field.type,
          count: vals.length,
          avg: sum / vals.length,
          min: Math.min(...vals),
          max: Math.max(...vals)
        };
      }
      // dropdown and button-group (single or multi). Single-select values
      // are a scalar (identical shape to dropdown); multi-select button-group
      // values are an array — each selected option counts toward its OWN
      // frequency (an entry that picked 2 options contributes 1 to each of
      // those 2 options' counts, not 1 to some combined "2 options" bucket).
      // `counted` (the denominator shown in the UI) is how many entries had
      // ANY selection at all, not a sum of per-option counts.
      const counts = new Map();
      let counted = 0;
      list.forEach((e) => {
        const v = e[field.id];
        if (Array.isArray(v)) {
          if (v.length === 0) return;
          counted++;
          v.forEach((opt) => {
            if (opt === null || opt === undefined || opt === '') return;
            counts.set(opt, (counts.get(opt) || 0) + 1);
          });
          return;
        }
        if (v === null || v === undefined || v === '') return;
        counted++;
        counts.set(v, (counts.get(v) || 0) + 1);
      });
      const breakdown = Array.from(counts.entries()).map(([value, count]) => ({ value, count }));
      return { field, type: field.type, count: counted, breakdown };
    });
}

// ====== Raw text/textarea values across included entries, grouped by field
// — shown as a separate "Notes across matches" list rather than folded into
// the stats table, since free text has nothing to average. ======
function collectMatchTextNotes(entries, matchFields) {
  const list = entries || [];
  const textFields = (matchFields || []).filter((f) => f.type === 'text' || f.type === 'textarea');
  return textFields
    .map((field) => ({
      field,
      notes: list
        .filter((e) => e[field.id] !== null && e[field.id] !== undefined && e[field.id] !== '')
        .map((e) => ({ matchNumber: e.matchNumber, value: e[field.id] }))
    }))
    .filter((f) => f.notes.length > 0);
}

// ====== Render helpers ======
function renderComparisonPitColumn(container, entry, fields) {
  container.innerHTML = '';

  if (!entry) {
    container.innerHTML = '<p class="help-text">This team has not been pit scouted yet.</p>';
    return;
  }

  const meta = document.createElement('p');
  meta.className = 'help-text';
  meta.style.cssText = 'font-size:0.8rem; margin-bottom:8px;';
  meta.textContent = `Scouted by: ${entry.scoutedByName || entry.scoutedByEmail || 'Unknown'}`;
  container.appendChild(meta);

  if (!fields || fields.length === 0) {
    const p = document.createElement('p');
    p.className = 'help-text';
    p.textContent = 'No pit scouting fields configured.';
    container.appendChild(p);
    return;
  }

  // Every configured field is shown here, not just the "show in preview"
  // subset Team Detail uses — this IS the dedicated detail view, so nothing
  // is hidden by default.
  fields.forEach((field) => {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex; justify-content:space-between; gap:8px; padding:4px 0; font-size:0.85rem; border-bottom:1px solid var(--border);';

    const labelSpan = document.createElement('span');
    labelSpan.style.color = 'var(--text-muted)';
    labelSpan.textContent = field.label;

    const valueSpan = document.createElement('span');
    const val = entry[field.id];
    valueSpan.textContent = typeof formatFieldValueForDisplay === 'function'
      ? formatFieldValueForDisplay(val)
      : ((val === null || val === undefined || val === '') ? '—' : String(val));

    row.appendChild(labelSpan);
    row.appendChild(valueSpan);
    container.appendChild(row);
  });
}

function renderComparisonMatchColumn(container, includedEntries, matchFields, totalEntryCount) {
  container.innerHTML = '';

  const summary = document.createElement('p');
  summary.className = 'help-text';
  summary.style.cssText = 'font-size:0.8rem; margin-bottom:8px;';
  summary.textContent = totalEntryCount === 0
    ? 'This team has no match scouting entries yet.'
    : `${includedEntries.length} of ${totalEntryCount} match(es) included.`;
  container.appendChild(summary);

  if (totalEntryCount === 0) return;

  if (includedEntries.length === 0) {
    const p = document.createElement('p');
    p.style.cssText = 'font-weight:600; font-size:0.85rem;';
    p.textContent = 'No match data included.';
    container.appendChild(p);
    return;
  }

  const stats = computeMatchFieldStats(includedEntries, matchFields);
  stats.forEach((stat) => {
    const row = document.createElement('div');
    row.style.cssText = 'padding:4px 0; font-size:0.85rem; border-bottom:1px solid var(--border);';

    const labelDiv = document.createElement('div');
    labelDiv.style.cssText = 'color:var(--text-muted); margin-bottom:2px;';
    labelDiv.textContent = stat.field.label;
    row.appendChild(labelDiv);

    const valueDiv = document.createElement('div');
    if (stat.count === 0) {
      valueDiv.textContent = 'No data';
    } else if (stat.type === 'number' || stat.type === 'counter') {
      valueDiv.textContent = `Avg ${stat.avg.toFixed(1)} (min ${stat.min}, max ${stat.max}) — n=${stat.count}`;
    } else {
      valueDiv.textContent = [...stat.breakdown]
        .sort((a, b) => b.count - a.count)
        .map((b) => `${b.value}: ${b.count}/${stat.count}`)
        .join(', ');
    }
    row.appendChild(valueDiv);
    container.appendChild(row);
  });

  const notes = collectMatchTextNotes(includedEntries, matchFields);
  if (notes.length > 0) {
    const notesHeader = document.createElement('p');
    notesHeader.style.cssText = 'font-size:0.8rem; font-weight:600; color:var(--text-muted); margin-top:12px; margin-bottom:4px;';
    notesHeader.textContent = 'Notes across matches';
    container.appendChild(notesHeader);

    notes.forEach(({ field, notes: fieldNotes }) => {
      fieldNotes.forEach((n) => {
        const block = document.createElement('div');
        block.style.cssText = 'font-size:0.85rem; margin-top:6px; padding-top:6px; border-top:1px dashed var(--border);';
        block.textContent = `Match #${n.matchNumber} — ${field.label}: ${n.value}`;
        container.appendChild(block);
      });
    });
  }
}

// ====== Team list (Pit vs Match subtab) ======
function renderComparisonTeamList(teams) {
  const container = document.getElementById('team-list-compare');
  const status = document.getElementById('team-list-status-compare');
  if (!container || !status) return;

  container.innerHTML = '';

  if (!teams || teams.length === 0) {
    status.textContent = 'No teams found for this event.';
    return;
  }

  status.textContent = `${teams.length} team(s)`;
  const sorted = typeof sortTeams === 'function' ? sortTeams(teams) : teams;

  sorted.forEach((team) => {
    const item = document.createElement('div');
    item.className = 'team-item';
    item.dataset.teamNumber = team.teamNumber;

    const leftGroup = document.createElement('div');
    leftGroup.style.cssText = 'display:flex; align-items:center; gap:8px; flex:1; min-width:0;';

    const numSpan = document.createElement('span');
    numSpan.className = 'team-number';
    numSpan.textContent = `#${team.teamNumber}`;

    const nameSpan = document.createElement('span');
    nameSpan.className = 'team-name';
    nameSpan.textContent = team.name || team.nameFull || team.nameShort || team.schoolName || team.teamNameCalc || '';

    leftGroup.appendChild(numSpan);
    leftGroup.appendChild(nameSpan);

    const btnGroup = document.createElement('div');
    btnGroup.className = 'team-item-actions';
    btnGroup.style.cssText = 'display:flex; align-items:center; gap:6px; flex-shrink:0;';

    const compareBtn = document.createElement('button');
    compareBtn.className = 'btn btn-small btn-secondary';
    compareBtn.style.cssText = 'width:auto; padding:4px 8px; font-size:0.8rem;';
    compareBtn.textContent = 'Compare';
    compareBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openComparisonModal(team.teamNumber, selectedEvent?.code || '', team);
    });
    btnGroup.appendChild(compareBtn);

    item.appendChild(leftGroup);
    item.appendChild(btnGroup);
    container.appendChild(item);
  });
}

// ====== Comparison modal ======
async function openComparisonModal(teamNumber, eventCode, teamObj) {
  currentComparisonTeamNumber = teamNumber;
  currentComparisonEventCode = eventCode;

  const modal = document.getElementById('comparison-modal');
  const titleEl = document.getElementById('comparison-modal-title');
  if (!modal) return;

  if (titleEl) {
    const teamName = teamObj?.name || teamObj?.nameFull || teamObj?.nameShort || teamObj?.schoolName || teamObj?.teamNameCalc || '';
    titleEl.textContent = teamName ? `Compare — Team #${teamNumber} (${teamName})` : `Compare — Team #${teamNumber}`;
  }
  if (typeof clearStatusMessage === 'function') clearStatusMessage('cmp-export');

  modal.classList.remove('hidden');
  await renderComparisonBody(teamNumber, eventCode);
}

function closeComparisonModal() {
  currentComparisonTeamNumber = null;
  currentComparisonEventCode = null;
  const modal = document.getElementById('comparison-modal');
  if (modal) modal.classList.add('hidden');
  if (typeof clearStatusMessage === 'function') clearStatusMessage('cmp-export');
}

async function renderComparisonPitSide(teamNumber, eventCode) {
  const pitContainer = document.getElementById('cmp-pit-data');
  if (!pitContainer) return;
  pitContainer.innerHTML = '<p class="help-text">Loading...</p>';

  const teamId = currentTeamData?.id;
  const pitEntry = typeof getPitScoutedEntry === 'function' ? getPitScoutedEntry(teamNumber, eventCode) : null;
  let pitFields = [];
  if (teamId && typeof loadFormConfig === 'function') {
    try {
      pitFields = await loadFormConfig(teamId, pitEntry?.season);
    } catch (err) {
      console.warn('Failed to load pit form config for comparison:', err);
    }
  }
  // The comparison modal may have closed (or moved to a different team)
  // while this awaited — don't paint stale data over whatever's shown now.
  if (currentComparisonTeamNumber !== teamNumber || currentComparisonEventCode !== eventCode) return;
  renderComparisonPitColumn(pitContainer, pitEntry, pitFields);
}

async function renderComparisonMatchSide(teamNumber, eventCode) {
  const matchContainer = document.getElementById('cmp-match-stats');
  if (!matchContainer) return;
  matchContainer.innerHTML = '<p class="help-text">Loading...</p>';

  const allMatchEntries = typeof getMatchEntriesForTeam === 'function' ? getMatchEntriesForTeam(teamNumber, eventCode) : [];
  let normal = allMatchEntries;
  let mismatched = [];
  if (allMatchEntries.length > 0 && typeof splitMismatchedMatchEntries === 'function') {
    try {
      const split = await splitMismatchedMatchEntries(allMatchEntries);
      normal = split.normal;
      mismatched = split.mismatched;
    } catch (err) {
      console.warn('Failed to check for mismatched match numbers:', err);
    }
  }
  if (currentComparisonTeamNumber !== teamNumber || currentComparisonEventCode !== eventCode) return;

  const inclusionMap = getInclusionMap(eventCode, teamNumber, normal, mismatched);
  const includedEntries = allMatchEntries.filter((e) => inclusionMap.get(e.id) !== false);

  const teamId = currentTeamData?.id;
  let matchFields = [];
  if (teamId && typeof loadMatchFormConfig === 'function') {
    const listSeason = allMatchEntries.find((e) => e.season)?.season;
    try {
      matchFields = await loadMatchFormConfig(teamId, listSeason);
    } catch (err) {
      console.warn('Failed to load match form config for comparison:', err);
    }
  }
  if (currentComparisonTeamNumber !== teamNumber || currentComparisonEventCode !== eventCode) return;

  renderComparisonMatchColumn(matchContainer, includedEntries, matchFields, allMatchEntries.length);
}

async function renderComparisonBody(teamNumber, eventCode) {
  await Promise.all([
    renderComparisonPitSide(teamNumber, eventCode),
    renderComparisonMatchSide(teamNumber, eventCode)
  ]);
}

// Re-render just the match-observed stats column — called after an
// include/exclude checkbox changes in the Matches Used modal, so a toggle
// there is reflected immediately without touching the pit column at all.
function refreshComparisonMatchColumnIfOpen(teamNumber, eventCode) {
  if (currentComparisonTeamNumber === teamNumber && currentComparisonEventCode === eventCode) {
    renderComparisonMatchSide(teamNumber, eventCode);
  }
}

// ====== View Entry modal (read-only) — shared by both "See ... Used"
// buttons. Reuses renderDynamicForm() (dynamic-form.js) exactly as the real
// edit forms do, then disables every rendered control — a read-only view
// with no separate renderer to maintain. ======
function disableRenderedFormFields(container) {
  container.querySelectorAll('input, select, textarea').forEach((el) => { el.disabled = true; });
  // Counter fields (dynamic-form.js's renderCounter) and Button Group fields
  // (renderButtonGroup) are both plain <div> wrappers with <button> children,
  // not native form controls — disable those buttons directly since the
  // querySelectorAll above doesn't reach them.
  container.querySelectorAll('.counter-field button, .button-group-field button, .stopwatch-controls button').forEach((btn) => { btn.disabled = true; });
  // Counter fields' displayed number is ALSO a click/tap-to-type-directly
  // target (renderCounter's beginEdit()), not just the +/- buttons above —
  // a plain <span>, so .disabled has no effect on it. Strip its
  // interactivity directly: pointer-events:none blocks the click, tabIndex
  // -1 removes it from tab order (the same two properties a real disabled
  // control loses), so a read-only view can't open an edit input at all.
  container.querySelectorAll('.counter-display').forEach((el) => {
    el.style.pointerEvents = 'none';
    el.tabIndex = -1;
  });
}

function openViewEntryModal(title, fields, data) {
  const modal = document.getElementById('view-entry-modal');
  const titleEl = document.getElementById('view-entry-modal-title');
  const container = document.getElementById('view-entry-fields');
  if (!modal || !container) return;

  if (titleEl) titleEl.textContent = title;
  renderDynamicForm(container, fields || [], data || {});
  disableRenderedFormFields(container);
  modal.classList.remove('hidden');
}

function closeViewEntryModal() {
  const modal = document.getElementById('view-entry-modal');
  if (modal) modal.classList.add('hidden');
}

// ====== Matches Used modal — lists this team's match entries for the event
// with include/exclude checkboxes, plus a "Mismatched Matches" tab that only
// appears when at least one entry's match number doesn't correspond to a
// match the team actually played (per splitMismatchedMatchEntries(),
// sheets-export.js — the same schedule-based check used for save-time
// warnings and every other export in the app). ======
let matchesUsedActiveTab = 'normal';

async function openMatchesUsedModal(teamNumber, eventCode) {
  const modal = document.getElementById('matches-used-modal');
  const titleEl = document.getElementById('matches-used-modal-title');
  const body = document.getElementById('matches-used-body');
  if (!modal || !body) return;

  if (titleEl) titleEl.textContent = `Matches Used — Team #${teamNumber}`;
  matchesUsedActiveTab = 'normal';
  body.innerHTML = '<p class="help-text">Loading...</p>';
  modal.classList.remove('hidden');

  const allEntries = typeof getMatchEntriesForTeam === 'function' ? getMatchEntriesForTeam(teamNumber, eventCode) : [];
  let normal = allEntries;
  let mismatched = [];
  if (allEntries.length > 0 && typeof splitMismatchedMatchEntries === 'function') {
    try {
      const split = await splitMismatchedMatchEntries(allEntries);
      normal = split.normal;
      mismatched = split.mismatched;
    } catch (err) {
      console.warn('Failed to check for mismatched match numbers:', err);
    }
  }
  // The modal may have been closed again while this awaited.
  if (modal.classList.contains('hidden')) return;

  const inclusionMap = getInclusionMap(eventCode, teamNumber, normal, mismatched);
  renderMatchesUsedBody(body, teamNumber, eventCode, normal, mismatched, inclusionMap);
}

function closeMatchesUsedModal() {
  const modal = document.getElementById('matches-used-modal');
  if (modal) modal.classList.add('hidden');
}

function renderMatchesUsedBody(body, teamNumber, eventCode, normal, mismatched, inclusionMap) {
  body.innerHTML = '';

  if (mismatched.length > 0) {
    const tabs = document.createElement('div');
    tabs.className = 'tabs';
    tabs.style.marginBottom = '12px';

    const normalTab = document.createElement('button');
    normalTab.className = `tab${matchesUsedActiveTab === 'normal' ? ' active' : ''}`;
    normalTab.textContent = `Matches (${normal.length})`;
    normalTab.addEventListener('click', () => {
      matchesUsedActiveTab = 'normal';
      renderMatchesUsedBody(body, teamNumber, eventCode, normal, mismatched, inclusionMap);
    });

    const mismatchedTab = document.createElement('button');
    mismatchedTab.className = `tab${matchesUsedActiveTab === 'mismatched' ? ' active' : ''}`;
    mismatchedTab.textContent = `Mismatched Matches (${mismatched.length})`;
    mismatchedTab.addEventListener('click', () => {
      matchesUsedActiveTab = 'mismatched';
      renderMatchesUsedBody(body, teamNumber, eventCode, normal, mismatched, inclusionMap);
    });

    tabs.appendChild(normalTab);
    tabs.appendChild(mismatchedTab);
    body.appendChild(tabs);
  } else {
    matchesUsedActiveTab = 'normal';
  }

  const activeList = matchesUsedActiveTab === 'mismatched' ? mismatched : normal;

  if (matchesUsedActiveTab === 'mismatched') {
    const helpP = document.createElement('p');
    helpP.className = 'help-text';
    helpP.style.marginBottom = '8px';
    helpP.textContent = "These match numbers don't correspond to a match this team actually played at this event, per the published schedule. Excluded from the comparison by default.";
    body.appendChild(helpP);

    const includeAllBtn = document.createElement('button');
    includeAllBtn.className = 'btn btn-small btn-outline';
    includeAllBtn.style.marginBottom = '10px';
    includeAllBtn.textContent = 'Include All';
    includeAllBtn.addEventListener('click', () => {
      mismatched.forEach((e) => inclusionMap.set(e.id, true));
      renderMatchesUsedBody(body, teamNumber, eventCode, normal, mismatched, inclusionMap);
      refreshComparisonMatchColumnIfOpen(teamNumber, eventCode);
    });
    body.appendChild(includeAllBtn);
  }

  if (activeList.length === 0) {
    const p = document.createElement('p');
    p.className = 'help-text';
    p.textContent = 'No matches here.';
    body.appendChild(p);
    return;
  }

  const sorted = [...activeList].sort((a, b) => (a.matchNumber || 0) - (b.matchNumber || 0));
  sorted.forEach((entry) => {
    const item = document.createElement('div');
    item.style.cssText = 'display:flex; align-items:center; justify-content:space-between; gap:8px; padding:8px 0; border-bottom:1px solid var(--border);';

    const left = document.createElement('label');
    left.style.cssText = 'display:flex; align-items:center; gap:8px; cursor:pointer; flex:1; min-width:0;';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = inclusionMap.get(entry.id) !== false;
    checkbox.addEventListener('change', () => {
      inclusionMap.set(entry.id, checkbox.checked);
      refreshComparisonMatchColumnIfOpen(teamNumber, eventCode);
    });

    const label = document.createElement('span');
    label.textContent = `Match #${entry.matchNumber}`;

    left.appendChild(checkbox);
    left.appendChild(label);

    const viewBtn = document.createElement('button');
    viewBtn.className = 'btn btn-small btn-outline';
    viewBtn.style.cssText = 'width:auto; flex-shrink:0;';
    viewBtn.textContent = 'View';
    viewBtn.addEventListener('click', async () => {
      const teamId = currentTeamData?.id;
      const fields = teamId && typeof loadMatchFormConfig === 'function'
        ? await loadMatchFormConfig(teamId, entry.season)
        : [];
      openViewEntryModal(`Match #${entry.matchNumber} — Team #${teamNumber}`, fields, entry);
    });

    item.appendChild(left);
    item.appendChild(viewBtn);
    body.appendChild(item);
  });
}

// ====== Export — reuses sheets-export.js's shared OAuth/Sheets-vs-Excel
// choice modal (openExportChoiceModal) rather than any new UI, same as every
// other export entry point in the app. ======
function buildComparisonStatsRows(matchFields, includedEntries) {
  const rows = [['Field', 'Type', 'Detail', 'Value']];
  const stats = computeMatchFieldStats(includedEntries, matchFields);
  stats.forEach((stat) => {
    if (stat.count === 0) {
      rows.push([stat.field.label, stat.type, 'No data', '']);
      return;
    }
    if (stat.type === 'number' || stat.type === 'counter') {
      rows.push([stat.field.label, stat.type, 'Average', Number(stat.avg.toFixed(2))]);
      rows.push([stat.field.label, stat.type, 'Min', stat.min]);
      rows.push([stat.field.label, stat.type, 'Max', stat.max]);
      rows.push([stat.field.label, stat.type, 'Matches Counted', stat.count]);
    } else {
      stat.breakdown.forEach((b) => {
        rows.push([stat.field.label, stat.type, String(b.value), b.count]);
      });
    }
  });

  const notes = collectMatchTextNotes(includedEntries, matchFields);
  if (notes.length > 0) {
    rows.push(['', '', '', '']);
    rows.push(['Notes Across Matches', '', '', '']);
    notes.forEach(({ field, notes: fieldNotes }) => {
      fieldNotes.forEach((n) => {
        rows.push([field.label, 'note', `Match #${n.matchNumber}`, n.value]);
      });
    });
  }

  return rows;
}

async function gatherComparisonExportData(teamNumber, eventCode, teamId) {
  const pitEntry = typeof getPitScoutedEntry === 'function' ? getPitScoutedEntry(teamNumber, eventCode) : null;
  const pitDocs = pitEntry ? [pitEntry] : [];

  const allMatchEntries = typeof getMatchEntriesForTeam === 'function' ? getMatchEntriesForTeam(teamNumber, eventCode) : [];
  let normal = allMatchEntries;
  let mismatched = [];
  if (allMatchEntries.length > 0 && typeof splitMismatchedMatchEntries === 'function') {
    try {
      const split = await splitMismatchedMatchEntries(allMatchEntries);
      normal = split.normal;
      mismatched = split.mismatched;
    } catch (err) {
      console.warn('Failed to check for mismatched match numbers during export:', err);
    }
  }
  const inclusionMap = getInclusionMap(eventCode, teamNumber, normal, mismatched);
  const includedEntries = allMatchEntries.filter((e) => inclusionMap.get(e.id) !== false);

  const season = typeof resolveExportSeason === 'function'
    ? resolveExportSeason([...pitDocs, ...allMatchEntries])
    : undefined;
  const pitFields = await loadFormConfigReadOnly(teamId, season, 'pitScouting', getDefaultPitFields);
  const matchFields = await loadFormConfigReadOnly(teamId, season, 'matchScouting', getDefaultMatchFields);

  const nameMap = typeof getEventTeamNameMap === 'function' ? await getEventTeamNameMap(eventCode) : {};
  if (typeof attachTeamNames === 'function') {
    attachTeamNames(pitDocs, nameMap);
    attachTeamNames(includedEntries, nameMap);
  }

  return { pitFields, matchFields, pitDocs, includedEntries, totalMatchCount: allMatchEntries.length };
}

async function exportComparisonToNewSpreadsheet(title, pitFields, pitDocs, matchFields, includedEntries) {
  const sheetTitles = ['Pit Data', 'Match Entries Used', 'Match Stats Summary'];
  const createResp = await createSpreadsheet(title, sheetTitles);
  const spreadsheetId = createResp.spreadsheetId;

  await writeSheetValues(spreadsheetId, 'Pit Data', buildPitSheetRows(pitFields, pitDocs));
  await writeSheetValues(spreadsheetId, 'Match Entries Used', buildMatchSheetRows(matchFields, includedEntries));
  await writeSheetValues(spreadsheetId, 'Match Stats Summary', buildComparisonStatsRows(matchFields, includedEntries));

  return createResp.spreadsheetUrl;
}

function downloadComparisonWorkbook(filename, pitFields, pitDocs, matchFields, includedEntries) {
  if (typeof XLSX === 'undefined') {
    throw new Error('Excel export library failed to load. Check your connection and try again.');
  }
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(buildPitSheetRows(pitFields, pitDocs)), 'Pit Data');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(buildMatchSheetRows(matchFields, includedEntries)), 'Match Entries Used');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(buildComparisonStatsRows(matchFields, includedEntries)), 'Match Stats Summary');
  XLSX.writeFile(wb, filename);
}

async function handleComparisonExportSheetsClick(statusPrefix) {
  const teamNumber = currentComparisonTeamNumber;
  const eventCode = currentComparisonEventCode;
  const teamId = currentTeamData?.id;
  if (!teamNumber || !eventCode || !teamId) {
    setStatusMessage(statusPrefix, 'error', 'Select a team and event first.');
    return;
  }

  showLoading('Waiting for Google authorization...');
  try {
    await getGoogleAccessToken();

    showLoading('Gathering comparison data...');
    const { pitFields, matchFields, pitDocs, includedEntries } = await gatherComparisonExportData(teamNumber, eventCode, teamId);

    showLoading('Creating Google Sheet...');
    const teamName = pitDocs[0]?.teamName || includedEntries[0]?.teamName || '';
    const title = `${teamLabel(teamNumber, teamName)} Pit vs Match — ${selectedEvent?.name || eventCode}`;
    const url = await exportComparisonToNewSpreadsheet(title, pitFields, pitDocs, matchFields, includedEntries);

    hideLoading();
    setStatusMessage(statusPrefix, 'success', 'Export complete! Opening sheet...');
    window.open(url, '_blank');
  } catch (err) {
    hideLoading();
    console.error('Comparison sheets export failed:', err);
    setStatusMessage(statusPrefix, 'error', err.message || 'Export failed. Please try again.');
  }
}

async function handleComparisonExportExcelClick(statusPrefix) {
  const teamNumber = currentComparisonTeamNumber;
  const eventCode = currentComparisonEventCode;
  const teamId = currentTeamData?.id;
  if (!teamNumber || !eventCode || !teamId) {
    setStatusMessage(statusPrefix, 'error', 'Select a team and event first.');
    return;
  }

  showLoading('Gathering comparison data...');
  try {
    const { pitFields, matchFields, pitDocs, includedEntries } = await gatherComparisonExportData(teamNumber, eventCode, teamId);
    const teamName = pitDocs[0]?.teamName || includedEntries[0]?.teamName || '';
    const filename = sanitizeFilename(`${teamLabel(teamNumber, teamName)} Pit vs Match - ${selectedEvent?.name || eventCode}.xlsx`);
    downloadComparisonWorkbook(filename, pitFields, pitDocs, matchFields, includedEntries);

    hideLoading();
    setStatusMessage(statusPrefix, 'success', 'Excel file downloaded!');
  } catch (err) {
    hideLoading();
    console.error('Comparison Excel export failed:', err);
    setStatusMessage(statusPrefix, 'error', err.message || 'Export failed. Please try again.');
  }
}

// ====== Export precondition check ======
// Is there actually anything to export for this team+event — a pit entry,
// OR at least one match entry that isn't currently excluded? Checked before
// ever opening the Excel/Sheets/Print choice popup, same reasoning as
// sheets-export.js's precheckExportData() for every other export entry
// point in the app: don't offer a format choice for a click that could only
// ever produce an empty result.
function comparisonHasExportableData(teamNumber, eventCode) {
  const pitEntry = typeof getPitScoutedEntry === 'function' ? getPitScoutedEntry(teamNumber, eventCode) : null;
  if (pitEntry) return true;

  const allMatchEntries = typeof getMatchEntriesForTeam === 'function' ? getMatchEntriesForTeam(teamNumber, eventCode) : [];
  if (allMatchEntries.length === 0) return false;

  // By the time the Export button is clickable, the comparison modal has
  // already been opened for this team+event, which always seeds this map
  // (renderComparisonMatchSide -> getInclusionMap) — the `|| true` fallback
  // only matters defensively, if it somehow hasn't.
  const inclusionMap = matchInclusionState.get(`${eventCode}_${teamNumber}`);
  if (!inclusionMap) return true;
  return allMatchEntries.some((e) => inclusionMap.get(e.id) !== false);
}

// ====== Print / Save-as-PDF ======
// Escapes untrusted text (form-config field labels are team-editable via
// Form Builder; note values are free-typed scouting text) before it's
// concatenated into an HTML string for the print window — everywhere else
// in this app builds the DOM via createElement/textContent, which is
// inherently safe; this is the one spot using string HTML (a separate
// window opened via document.write), so it needs its own escaping.
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildComparisonPrintHtml(title, eventCode, pitEntry, pitFields, includedEntries, totalMatchCount, matchFields) {
  let pitRowsHtml;
  if (!pitEntry) {
    pitRowsHtml = '<p class="empty">This team has not been pit scouted yet.</p>';
  } else if (!pitFields || pitFields.length === 0) {
    pitRowsHtml = '<p class="empty">No pit scouting fields configured.</p>';
  } else {
    pitRowsHtml = `<table>${pitFields.map((field) => {
      const val = pitEntry[field.id];
      const display = typeof formatFieldValueForDisplay === 'function'
        ? formatFieldValueForDisplay(val)
        : ((val === null || val === undefined || val === '') ? '—' : String(val));
      return `<tr><th>${escapeHtml(field.label)}</th><td>${escapeHtml(display)}</td></tr>`;
    }).join('')}</table>`;
  }

  let matchSummaryHtml;
  if (totalMatchCount === 0) {
    matchSummaryHtml = '<p class="empty">This team has no match scouting entries yet.</p>';
  } else if (includedEntries.length === 0) {
    matchSummaryHtml = '<p class="empty"><strong>No match data included.</strong></p>';
  } else {
    const stats = computeMatchFieldStats(includedEntries, matchFields);
    const statsRowsHtml = stats.map((stat) => {
      let valueText;
      if (stat.count === 0) {
        valueText = 'No data';
      } else if (stat.type === 'number' || stat.type === 'counter') {
        valueText = `Avg ${stat.avg.toFixed(1)} (min ${stat.min}, max ${stat.max}) — n=${stat.count}`;
      } else {
        valueText = [...stat.breakdown]
          .sort((a, b) => b.count - a.count)
          .map((b) => `${b.value}: ${b.count}/${stat.count}`)
          .join(', ');
      }
      return `<tr><th>${escapeHtml(stat.field.label)}</th><td>${escapeHtml(valueText)}</td></tr>`;
    }).join('');

    const notes = collectMatchTextNotes(includedEntries, matchFields);
    let notesHtml = '';
    if (notes.length > 0) {
      const noteItems = notes.map(({ field, notes: fieldNotes }) =>
        fieldNotes.map((n) => `<li><strong>Match #${escapeHtml(n.matchNumber)} — ${escapeHtml(field.label)}:</strong> ${escapeHtml(n.value)}</li>`).join('')
      ).join('');
      notesHtml = `<h3>Notes Across Matches</h3><ul class="notes">${noteItems}</ul>`;
    }

    matchSummaryHtml = `<p class="meta">${includedEntries.length} of ${totalMatchCount} match(es) included.</p><table>${statsRowsHtml}</table>${notesHtml}`;
  }

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)} — Pit vs Match</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; color: #111; padding: 24px; }
  h1 { font-size: 1.3rem; margin-bottom: 4px; }
  h2 { font-size: 1rem; margin: 20px 0 8px; border-bottom: 2px solid #333; padding-bottom: 4px; }
  h3 { font-size: 0.9rem; margin: 16px 0 6px; }
  .subtitle { color: #555; margin-bottom: 20px; font-size: 0.85rem; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 12px; }
  th, td { text-align: left; padding: 5px 8px; border-bottom: 1px solid #ddd; font-size: 0.85rem; vertical-align: top; }
  th { width: 45%; color: #444; font-weight: 600; }
  .empty { font-style: italic; color: #666; }
  .meta { font-size: 0.8rem; color: #555; margin-bottom: 8px; }
  .notes { list-style: none; padding: 0; margin: 0; font-size: 0.82rem; }
  .notes li { padding: 6px 0; border-top: 1px dashed #ccc; }
  .columns { display: flex; gap: 30px; }
  .column { flex: 1; min-width: 0; }
  @media print { body { padding: 0; } }
</style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  <p class="subtitle">Pit vs Match Comparison — Event ${escapeHtml(eventCode)}</p>
  <div class="columns">
    <div class="column">
      <h2>Pit Scouting Data</h2>
      ${pitRowsHtml}
    </div>
    <div class="column">
      <h2>Match-Observed Stats</h2>
      ${matchSummaryHtml}
    </div>
  </div>
</body>
</html>`;
}

async function handleComparisonPrintClick(teamNumber, eventCode) {
  const teamId = currentTeamData?.id;
  if (!teamId) return;

  const pitEntry = typeof getPitScoutedEntry === 'function' ? getPitScoutedEntry(teamNumber, eventCode) : null;
  const pitFields = typeof loadFormConfig === 'function' ? await loadFormConfig(teamId, pitEntry?.season) : [];

  const allMatchEntries = typeof getMatchEntriesForTeam === 'function' ? getMatchEntriesForTeam(teamNumber, eventCode) : [];
  let normal = allMatchEntries;
  let mismatched = [];
  if (allMatchEntries.length > 0 && typeof splitMismatchedMatchEntries === 'function') {
    try {
      const split = await splitMismatchedMatchEntries(allMatchEntries);
      normal = split.normal;
      mismatched = split.mismatched;
    } catch (err) {
      console.warn('Failed to check for mismatched match numbers for print:', err);
    }
  }
  const inclusionMap = getInclusionMap(eventCode, teamNumber, normal, mismatched);
  const includedEntries = allMatchEntries.filter((e) => inclusionMap.get(e.id) !== false);

  const listSeason = allMatchEntries.find((e) => e.season)?.season;
  const matchFields = typeof loadMatchFormConfig === 'function' ? await loadMatchFormConfig(teamId, listSeason) : [];

  const teamName = pitEntry?.teamName || includedEntries[0]?.teamName || '';
  const title = teamName ? `Team #${teamNumber} — ${teamName}` : `Team #${teamNumber}`;

  const html = buildComparisonPrintHtml(title, eventCode, pitEntry, pitFields, includedEntries, allMatchEntries.length, matchFields);

  const printWindow = window.open('', '_blank');
  if (!printWindow) {
    if (typeof showNoticeModal === 'function') {
      showNoticeModal({ title: 'Print Blocked', message: 'Your browser blocked the print window. Please allow pop-ups for this site and try again.' });
    }
    return;
  }
  printWindow.document.open();
  printWindow.document.write(html);
  printWindow.document.close();
  printWindow.focus();
  // A short delay rather than relying on onload — document.write()'d content
  // is already fully parsed by the time close() returns in every browser
  // this needs to support, and a single deferred call avoids a double print
  // dialog that firing both onload AND a fallback timer could cause.
  setTimeout(() => {
    try { printWindow.print(); } catch (err) { console.warn('Print failed:', err); }
  }, 250);
}

// ====== Wire up buttons ======
document.addEventListener('DOMContentLoaded', () => {
  const closeCmpBtn = document.getElementById('btn-comparison-close');
  if (closeCmpBtn) closeCmpBtn.addEventListener('click', closeComparisonModal);
  const cmpOverlay = document.getElementById('comparison-modal-overlay');
  if (cmpOverlay) cmpOverlay.addEventListener('click', closeComparisonModal);

  const closeViewBtn = document.getElementById('btn-view-entry-close');
  if (closeViewBtn) closeViewBtn.addEventListener('click', closeViewEntryModal);
  const viewOverlay = document.getElementById('view-entry-modal-overlay');
  if (viewOverlay) viewOverlay.addEventListener('click', closeViewEntryModal);

  const closeMuBtn = document.getElementById('btn-matches-used-close');
  if (closeMuBtn) closeMuBtn.addEventListener('click', closeMatchesUsedModal);
  const muOverlay = document.getElementById('matches-used-modal-overlay');
  if (muOverlay) muOverlay.addEventListener('click', closeMatchesUsedModal);

  const btnViewPit = document.getElementById('btn-cmp-view-pit-entry');
  if (btnViewPit) {
    btnViewPit.addEventListener('click', async () => {
      const teamNumber = currentComparisonTeamNumber;
      const eventCode = currentComparisonEventCode;
      if (!teamNumber || !eventCode) return;
      const entry = typeof getPitScoutedEntry === 'function' ? getPitScoutedEntry(teamNumber, eventCode) : null;
      if (!entry) {
        if (typeof showNoticeModal === 'function') {
          showNoticeModal({ title: 'No Pit Entry', message: 'This team has not been pit scouted yet.' });
        }
        return;
      }
      const teamId = currentTeamData?.id;
      const fields = teamId && typeof loadFormConfig === 'function' ? await loadFormConfig(teamId, entry.season) : [];
      openViewEntryModal(`Pit Entry — Team #${teamNumber}`, fields, entry);
    });
  }

  const btnViewMatches = document.getElementById('btn-cmp-view-matches');
  if (btnViewMatches) {
    btnViewMatches.addEventListener('click', () => {
      const teamNumber = currentComparisonTeamNumber;
      const eventCode = currentComparisonEventCode;
      if (!teamNumber || !eventCode) return;
      openMatchesUsedModal(teamNumber, eventCode);
    });
  }

  const btnExport = document.getElementById('btn-cmp-export');
  if (btnExport) {
    btnExport.addEventListener('click', () => {
      const teamNumber = currentComparisonTeamNumber;
      const eventCode = currentComparisonEventCode;
      if (!teamNumber || !eventCode) return;

      if (!comparisonHasExportableData(teamNumber, eventCode)) {
        if (typeof showNoticeModal === 'function') {
          showNoticeModal({
            title: 'Nothing to Export',
            message: 'There is no pit entry and no included match data loaded for this team at this event.'
          });
        } else if (typeof setStatusMessage === 'function') {
          setStatusMessage('cmp-export', 'error', 'Nothing to export — no pit entry and no included match data for this team at this event.');
        }
        return;
      }

      openExportChoiceModal({
        title: `Export Comparison — Team #${teamNumber}`,
        statusPrefix: 'cmp-export',
        excelHandler: (prefix) => handleComparisonExportExcelClick(prefix),
        sheetsHandler: (prefix) => handleComparisonExportSheetsClick(prefix),
        printHandler: () => handleComparisonPrintClick(teamNumber, eventCode)
      });
    });
  }
});
