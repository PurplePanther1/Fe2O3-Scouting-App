// ====== FIRST FTC Events API Integration (via Cloudflare Worker) ======

// ⚠️ UPDATE THIS URL after deploying the worker:
//    wrangler deploy → it will print your worker URL
const FTC_PROXY_BASE = 'https://fe2o3-ftc-proxy.fe2o3-scouting.workers.dev';

// Currently selected event data
let selectedEvent = null;
let isSearching = false;
let debounceTimer = null;

// ====== In-memory event cache (keyed by season) ======
const eventCache = {};

// ====== Compute the current FTC season ======
function getCurrentFtcSeason() {
  const now = new Date();
  const month = now.getMonth() + 1;
  return month >= 9 ? now.getFullYear() : now.getFullYear() - 1;
}

// ====== Format an FTC season number as its "YYYY-YYYY" label (e.g. 2025 -> "2025-2026") ======
function formatFtcSeasonLabel(season) {
  const s = Number(season);
  return `${s}-${s + 1}`;
}

// ====== Populate season dropdown ======
function populateSeasonDropdown() {
  const select = document.getElementById('select-season');
  const current = getCurrentFtcSeason();
  const startYear = Math.max(current - 8, 2020);

  for (let y = current; y >= startYear; y--) {
    const option = document.createElement('option');
    option.value = y;
    const label = current === y ? `${formatFtcSeasonLabel(y)} (current)` : formatFtcSeasonLabel(y);
    option.textContent = label;
    if (y === current) {
      option.selected = true;
    }
    select.appendChild(option);
  }
}

// ====== Get selected season from dropdown ======
function getSelectedSeason() {
  return document.getElementById('select-season').value;
}

// ====== Fetch helper for the worker ======
async function callWorker(endpoint) {
  const url = `${FTC_PROXY_BASE}${endpoint}`;
  const response = await fetch(url);

  if (!response.ok) {
    const body = await response.text();
    let msg = `Worker error ${response.status}`;
    try {
      const parsed = JSON.parse(body);
      if (parsed.error) msg = parsed.error;
    } catch (_) {}
    throw new Error(msg);
  }

  return await response.json();
}

// ====== Cache freshness: re-fetch if older than 1 hour ======
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// ====== Fetch and cache all events for a season ======
async function ensureEventsLoaded(season) {
  // Already in memory and fresh
  if (eventCache[season]) return eventCache[season];

  // Try Firestore cache first
  const cacheDoc = await db.collection('eventCache').doc('season_' + season).get();
  if (cacheDoc.exists) {
    const data = cacheDoc.data();
    if (data.events && data.events.length > 0) {
      // Check freshness: if cachedAt is recent enough, use it
      const cachedAt = data.cachedAt ? data.cachedAt.toMillis() : 0;
      const age = Date.now() - cachedAt;
      if (age < CACHE_TTL_MS) {
        eventCache[season] = data.events;
        return data.events;
      }
      // Stale cache — fall through to re-fetch
      console.log(`[cache] season ${season} cache is ${Math.round(age/1000/60)}m old, re-fetching`);
    }
  }

  // Fetch from Worker
  const result = await callWorker(`/events?season=${encodeURIComponent(season)}`);
  const events = result.events || [];

  // Store in memory
  eventCache[season] = events;

  // Persist to Firestore for offline reuse
  try {
    await db.collection('eventCache').doc('season_' + season).set({
      events: events,
      cachedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
  } catch (err) {
    // Non-critical — cache will re-fetch next time
    console.warn('Failed to cache events to Firestore:', err);
  }

  return events;
}

// ====== Filter events client-side by query ======
function filterEvents(events, query) {
  if (!query || !query.trim()) return events.slice(0, 50);
  const q = query.trim().toLowerCase();
  return events.filter(evt =>
    (evt.name && evt.name.toLowerCase().includes(q)) ||
    (evt.code && evt.code.toLowerCase().includes(q))
  );
}

// ====== Get teams for a specific event via Worker ======
async function getEventTeams(eventCode, season) {
  console.time('[Timing] Worker /teams call');
  try {
    const result = await callWorker(`/teams?eventCode=${encodeURIComponent(eventCode)}&season=${encodeURIComponent(season || getSelectedSeason())}`);
    console.timeEnd('[Timing] Worker /teams call');
    return result.teams || [];
  } catch (err) {
    console.timeEnd('[Timing] Worker /teams call');
    throw err;
  }
}

// ====== Cache event data to Firestore ======
async function cacheEventToFirestore(eventData, ftcTeams) {
  if (!eventData || !eventData.code) return;

  console.time('[Timing] Firestore cache write (cacheEventToFirestore)');
  try {
    const eventRef = db.collection('events').doc(eventData.code);
    await eventRef.set({
      name: eventData.name,
      date: eventData.startDate ? new Date(eventData.startDate) : null,
      ftcTeams: ftcTeams.map(t => ({
        teamNumber: t.teamNumber,
        name: t.name || t.nameFull || t.nameShort || t.schoolName || t.teamNameCalc || '',
        nameShort: t.nameShort || '',
        nameFull: t.nameFull || '',
        schoolName: t.schoolName || '',
        city: t.city || '',
        stateProv: t.stateProv || '',
        country: t.country || '',
        opr: typeof t.opr === 'number' ? t.opr : null
      })),
      cachedAt: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    console.timeEnd('[Timing] Firestore cache write (cacheEventToFirestore)');
    return eventRef;
  } catch (err) {
    console.timeEnd('[Timing] Firestore cache write (cacheEventToFirestore)');
    throw err;
  }
}

// ====== Load cached event from Firestore ======
async function getCachedEvent(eventCode) {
  console.time('[Timing] Firestore cache read (getCachedEvent)');
  try {
    const doc = await db.collection('events').doc(eventCode).get();
    console.timeEnd('[Timing] Firestore cache read (getCachedEvent)');
    if (doc.exists) {
      const data = doc.data();
      // Normalize ftcTeams if stored as numbers or objects
      if (data.ftcTeams) {
        data.ftcTeams = data.ftcTeams.map(t => {
          if (typeof t === 'number') return { teamNumber: t, name: '', nameShort: '', nameFull: '', schoolName: '' };
          return {
            ...t,
            name: t.name || t.nameShort || t.nameFull || t.schoolName || ''
          };
        });
      }
      return { id: doc.id, ...data };
    }
    return null;
  } catch (err) {
    console.timeEnd('[Timing] Firestore cache read (getCachedEvent)');
    throw err;
  }
}

// ====== Render event list (full results area) ======
function renderEventList(events) {
  const container = document.getElementById('event-results');
  container.innerHTML = '';

  if (!events || events.length === 0) {
    container.innerHTML = '<p class="help-text">No events found. Try a different search term.</p>';
    return;
  }

  events.forEach(evt => {
    const item = document.createElement('div');
    item.className = 'event-item';
    if (selectedEvent && selectedEvent.code === evt.code) {
      item.classList.add('selected');
    }
    item.dataset.code = evt.code;

    const nameEl = document.createElement('div');
    nameEl.className = 'event-name';
    nameEl.textContent = evt.name;

    const codeEl = document.createElement('div');
    codeEl.className = 'event-code';
    codeEl.textContent = `${evt.code}  •  ${evt.startDate || 'Date TBD'}`;

    item.appendChild(nameEl);
    item.appendChild(codeEl);

    item.addEventListener('click', () => selectEvent(evt));

    container.appendChild(item);
  });
}

// ====== Render suggestions dropdown ======
function renderSuggestions(events) {
  const dropdown = document.getElementById('search-suggestions');

  if (!events || events.length === 0) {
    dropdown.classList.add('hidden');
    return;
  }

  dropdown.innerHTML = '';
  events.forEach(evt => {
    const item = document.createElement('div');
    item.className = 'suggestion-item';
    item.dataset.code = evt.code;

    const nameEl = document.createElement('div');
    nameEl.className = 'suggestion-name';
    nameEl.textContent = evt.name;

    const codeEl = document.createElement('div');
    codeEl.className = 'suggestion-code';
    codeEl.textContent = `${evt.code}  •  ${evt.startDate || ''}`;

    item.appendChild(nameEl);
    item.appendChild(codeEl);

    item.addEventListener('click', () => {
      clearSelectedEvent();
      selectEvent(evt);
      hideSuggestions();
      document.getElementById('input-event-search').value = evt.name;
    });

    dropdown.appendChild(item);
  });

  dropdown.classList.remove('hidden');
}

function hideSuggestions() {
  document.getElementById('search-suggestions').classList.add('hidden');
}

// ====== Clear any previously selected event's info, team list, search results, and team detail ======
function clearSelectedEvent() {
  selectedEvent = null;
  // Reset detail selection too — otherwise a team number that also exists in the
  // next event's roster would still read as "selected" and show "Close Detail"
  // even though the detail panel was just hidden below.
  currentSelectedTeamNumber = null;
  // Otherwise a stale array here would get re-rendered into the Team Information
  // tab's list the next time the user switches to it (app.js re-renders from this
  // array on every tab switch), showing the previous event's teams after clearing.
  currentEventTeams = [];
  const area = document.getElementById('selected-event-area');
  if (area) area.classList.add('hidden');
  const nameEl = document.getElementById('selected-event-name');
  if (nameEl) nameEl.textContent = '';
  const codeEl = document.getElementById('selected-event-code');
  if (codeEl) codeEl.textContent = '';
  const countEl = document.getElementById('selected-event-teams-count');
  if (countEl) countEl.textContent = '';

  const teamListMatch = document.getElementById('team-list-match');
  if (teamListMatch) teamListMatch.innerHTML = '';
  const statusMatch = document.getElementById('team-list-status-match');
  if (statusMatch) statusMatch.textContent = 'Select an event above to load teams.';

  const teamListPit = document.getElementById('team-list-pit');
  if (teamListPit) teamListPit.innerHTML = '';
  const statusPit = document.getElementById('team-list-status-pit');
  if (statusPit) statusPit.textContent = 'Select an event above to load teams.';

  const eventResults = document.getElementById('event-results');
  if (eventResults) eventResults.innerHTML = '';

  const teamListInfo = document.getElementById('team-list-info');
  if (teamListInfo) teamListInfo.innerHTML = '';
  const statusInfo = document.getElementById('team-list-status-info');
  if (statusInfo) statusInfo.textContent = 'Select an event above to load teams.';

  if (typeof closeTeamDetailModal === 'function') {
    closeTeamDetailModal();
  }

  const tdError = document.getElementById('td-error');
  if (tdError) tdError.textContent = '';

  // Remove .selected class from all event items
  document.querySelectorAll('.event-item').forEach(el => el.classList.remove('selected'));
  // Stop watching pit scouting status for the previous event
  if (typeof watchPitScoutStatus === 'function') {
    watchPitScoutStatus(null);
  }
  // Stop watching match scouting status for the previous event
  if (typeof watchMatchScoutStatus === 'function') {
    watchMatchScoutStatus(null);
  }

  if (typeof updatePinButtonUI === 'function') {
    updatePinButtonUI();
  }
  if (typeof renderPinnedEventsList === 'function') {
    renderPinnedEventsList();
  }

  if (typeof saveSessionState === 'function') {
    saveSessionState();
  }
}

// ====== Select an event ======
async function selectEvent(eventData) {
  console.time('[Timing] selectEvent total');
  selectedEvent = eventData;

  if (typeof saveSessionState === 'function') {
    saveSessionState();
  }

  // Highlight this event in the search results list (if rendered)
  document.querySelectorAll('.event-item').forEach(el => {
    el.classList.toggle('selected', el.dataset.code === eventData.code);
  });

  // Show selected event info
  document.getElementById('selected-event-name').textContent = eventData.name;
  document.getElementById('selected-event-code').textContent = `Code: ${eventData.code}`;
  document.getElementById('selected-event-teams-count').textContent = 'Loading teams...';
  document.getElementById('selected-event-area').classList.remove('hidden');

  // Selecting an event always lands on Team Information, regardless of which
  // subtab was active beforehand or which source (search vs. Pinned Events) it came from.
  if (typeof window.activateScoutingSubTab === 'function') {
    window.activateScoutingSubTab('info');
  }

  if (typeof updatePinButtonUI === 'function') {
    updatePinButtonUI();
  }
  if (typeof renderPinnedEventsList === 'function') {
    renderPinnedEventsList();
  }

  showLoading(`Fetching teams for ${eventData.code}...`);
  try {
    // Try cache first
    let ftcTeams = null;
    const cached = await getCachedEvent(eventData.code);
    if (cached && cached.ftcTeams && cached.ftcTeams.length > 0 && cached.ftcTeams.some(t => t.name && t.name.trim() !== '')) {
      ftcTeams = cached.ftcTeams.map(t => typeof t === 'number' ? { teamNumber: t, name: '' } : t);
    } else {
      // Fetch from Worker (which calls FIRST API server-side)
      ftcTeams = await getEventTeams(eventData.code, getSelectedSeason());
      
      // Batch fetch team details from FTCScout GraphQL API using batched aliasing for ALL teams in the event concurrently
      if (ftcTeams && ftcTeams.length > 0 && typeof fetchTeamDetailsBatch === 'function') {
        const season = getSelectedSeason();
        const batchSize = 40;
        const chunks = [];
        
        for (let i = 0; i < ftcTeams.length; i += batchSize) {
          chunks.push({
            chunkTeamNums: ftcTeams.slice(i, i + batchSize).map(t => t.teamNumber),
            chunkTeams: ftcTeams.slice(i, i + batchSize),
            index: i / batchSize
          });
        }
        
        console.log(`[FTCScout Batch] Starting concurrent batched fetch for ${ftcTeams.length} teams across ${chunks.length} chunks (batch size ${batchSize})`);
        
        await Promise.all(chunks.map(async ({ chunkTeamNums, chunkTeams, index }) => {
          const timerLabel = `[FTCScout Batch] Chunk #${index} (${chunkTeamNums.length} teams)`;
          const batchWriteTimerLabel = `[Timing] Chunk #${index} batched Firestore write`;
          console.time(timerLabel);
          try {
        const batchResults = await fetchTeamDetailsBatch(chunkTeamNums, season);
        console.timeEnd(timerLabel);
        
        console.time(batchWriteTimerLabel);
        try {
          let batch = db.batch();
          let opCount = 0;
          
          for (let t of chunkTeams) {
            const detail = batchResults[t.teamNumber];
            if (!detail || detail.isError || !detail.name || detail.name.startsWith('Team #')) {
              continue;
            }
            t.name = detail.name;
            t.nameShort = detail.name;
            t.opr = detail.quickStats?.tot?.value ?? null;

            // Normalize raw GraphQL team detail into flat structure expected by renderTeamDetail & getCachedTeamDetail
            const loc = detail.location || {};
            const normalizedDetail = {
              teamNumber: t.teamNumber,
              name: detail.name || `Team #${t.teamNumber}`,
              city: loc.city || '',
              state: loc.state || '',
              country: loc.country || '',
              rookieYear: detail.rookieYear || null,
              website: detail.website || null,
              opr: detail.quickStats?.tot?.value || null,
              auto: detail.quickStats?.auto?.value || null,
              dc: detail.quickStats?.dc?.value || null,
              eg: detail.quickStats?.eg?.value || null,
              statsCount: detail.quickStats?.count || 0,
              awards: detail.awards || []
            };
            
            const docRef = db.collection('teamDetails').doc(String(t.teamNumber));
            batch.set(docRef, {
              ...normalizedDetail,
              cachedAt: firebase.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
                opCount++;
                
                // Firestore batch limit is 500 operations. Chunk size is 40, so this is well within limits.
                if (opCount >= 450) {
                  await batch.commit();
                  batch = db.batch();
                  opCount = 0;
                }
              }
              
              if (opCount > 0) {
                await batch.commit();
              }
            } catch (fsErr) {
              console.warn('[FTCScout Batch] Batched Firestore cache write failed:', fsErr);
            }
            console.timeEnd(batchWriteTimerLabel);
          } catch (batchErr) {
            console.timeEnd(timerLabel);
            console.error(`[FTCScout Batch] Batch fetch failed for chunk #${index}:`, batchErr);
          }
        }));
      }

      // Cache result with populated names
      await cacheEventToFirestore(eventData, ftcTeams);
    }

    hideLoading();
    document.getElementById('selected-event-teams-count').textContent = `${ftcTeams.length} team(s) registered`;
    renderTeamList(ftcTeams);

    // Start watching pit scouting status for this event (live snapshot listener)
    if (typeof watchPitScoutStatus === 'function') {
      watchPitScoutStatus(eventData.code);
    }

    // Start watching match scouting status for this event
    if (typeof watchMatchScoutStatus === 'function') {
      watchMatchScoutStatus(eventData.code);
    }
    console.timeEnd('[Timing] selectEvent total');
  } catch (err) {
    hideLoading();
    console.timeEnd('[Timing] selectEvent total');
    console.error('Failed to fetch teams:', err);
    document.getElementById('selected-event-teams-count').textContent = 'Failed to load teams';
    showError('event-error', 'Could not load teams. Check your connection and try again.');
  }
}

// ====== Callback for scouted state changes (set by pit-scout.js) ======
let onScoutedStateChanged = null;

// ====== Render team lists for both match and pit scouting ======
function renderTeamList(teams) {
  console.time('[Timing] renderTeamList total');
  renderMatchTeamList(teams);
  renderPitTeamList(teams);
  if (typeof renderTeamInfoList === 'function') {
    renderTeamInfoList(teams);
  }
  console.timeEnd('[Timing] renderTeamList total');
}

// Shared selected team & search query across sub-tabs
let currentSelectedTeamNumber = null;
let currentEventTeams = [];
let currentTeamSearchQuery = '';
let currentTeamSortMode = 'number'; // 'number' | 'name' | 'opr' — shared across Match & Pit tabs

// Bulk-select state for the Pit tab (captain / canEditOtherEntries only — see updatePitBulkSelectUI)
let pitBulkSelectMode = false;
let pitBulkSelectedDocIds = new Set();

// ====== Show/hide & label the pit bulk-select toolbar based on permission and selection ======
function updatePitBulkSelectUI() {
  const toggleBtn = document.getElementById('btn-pit-bulk-select-toggle');
  const deleteBtn = document.getElementById('btn-pit-bulk-delete');
  if (!toggleBtn || !deleteBtn) return;

  const canBulkManage = (typeof canUserEditOtherEntries === 'function' ? canUserEditOtherEntries() : false)
    && (typeof canUserBulkDelete === 'function' ? canUserBulkDelete() : false);
  if (!canBulkManage) {
    toggleBtn.classList.add('hidden');
    deleteBtn.classList.add('hidden');
    pitBulkSelectMode = false;
    pitBulkSelectedDocIds.clear();
    return;
  }

  toggleBtn.classList.remove('hidden');
  toggleBtn.textContent = pitBulkSelectMode ? 'Cancel Select' : 'Select';

  if (pitBulkSelectMode && pitBulkSelectedDocIds.size > 0) {
    deleteBtn.classList.remove('hidden');
    deleteBtn.textContent = `Delete Selected (${pitBulkSelectedDocIds.size})`;
  } else {
    deleteBtn.classList.add('hidden');
  }
}

// ====== Sort a team list per the shared sort mode (number is the default, matching prior behavior) ======
function sortTeams(teams) {
  const sorted = [...teams];
  if (currentTeamSortMode === 'name') {
    sorted.sort((a, b) => {
      const nameA = a.name || a.nameFull || a.nameShort || a.schoolName || a.teamNameCalc || '';
      const nameB = b.name || b.nameFull || b.nameShort || b.schoolName || b.teamNameCalc || '';
      return nameA.localeCompare(nameB) || (a.teamNumber || 0) - (b.teamNumber || 0);
    });
  } else if (currentTeamSortMode === 'opr') {
    sorted.sort((a, b) => {
      const oprA = typeof a.opr === 'number' ? a.opr : -Infinity;
      const oprB = typeof b.opr === 'number' ? b.opr : -Infinity;
      return oprB - oprA || (a.teamNumber || 0) - (b.teamNumber || 0);
    });
  } else {
    sorted.sort((a, b) => (a.teamNumber || 0) - (b.teamNumber || 0));
  }
  return sorted;
}

// ====== Sync both sort selects & re-render both team lists when sort mode changes ======
function applyTeamSortMode(mode) {
  currentTeamSortMode = mode || 'number';

  const matchSelect = document.getElementById('select-team-sort-match');
  const pitSelect = document.getElementById('select-team-sort-pit');
  const infoSelect = document.getElementById('select-team-sort-info');
  if (matchSelect && matchSelect.value !== currentTeamSortMode) matchSelect.value = currentTeamSortMode;
  if (pitSelect && pitSelect.value !== currentTeamSortMode) pitSelect.value = currentTeamSortMode;
  if (infoSelect && infoSelect.value !== currentTeamSortMode) infoSelect.value = currentTeamSortMode;

  if (currentEventTeams && currentEventTeams.length > 0) {
    renderMatchTeamList(currentEventTeams);
    renderPitTeamList(currentEventTeams);
    if (typeof renderTeamInfoList === 'function') {
      renderTeamInfoList(currentEventTeams);
    }
    applyTeamSearchFilter(currentTeamSearchQuery);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const matchSortSelect = document.getElementById('select-team-sort-match');
  if (matchSortSelect) {
    matchSortSelect.addEventListener('change', (e) => applyTeamSortMode(e.target.value));
  }
  const pitSortSelect = document.getElementById('select-team-sort-pit');
  if (pitSortSelect) {
    pitSortSelect.addEventListener('change', (e) => applyTeamSortMode(e.target.value));
  }
  const infoSortSelect = document.getElementById('select-team-sort-info');
  if (infoSortSelect) {
    infoSortSelect.addEventListener('change', (e) => applyTeamSortMode(e.target.value));
  }

  // Pit bulk-select toggle
  const pitBulkToggleBtn = document.getElementById('btn-pit-bulk-select-toggle');
  if (pitBulkToggleBtn) {
    pitBulkToggleBtn.addEventListener('click', () => {
      pitBulkSelectMode = !pitBulkSelectMode;
      pitBulkSelectedDocIds.clear();
      if (currentEventTeams && currentEventTeams.length > 0) {
        renderPitTeamList(currentEventTeams);
        applyTeamSearchFilter(currentTeamSearchQuery);
      } else {
        updatePitBulkSelectUI();
      }
    });
  }

  // Pit bulk delete
  const pitBulkDeleteBtn = document.getElementById('btn-pit-bulk-delete');
  if (pitBulkDeleteBtn) {
    pitBulkDeleteBtn.addEventListener('click', async () => {
      const docIds = [...pitBulkSelectedDocIds];
      if (docIds.length === 0) return;
      if (!confirm(`Delete pit scouting data for ${docIds.length} team(s)? This cannot be undone.`)) return;

      showLoading('Deleting selected entries...');
      let results = { succeeded: [], failed: [] };
      try {
        if (typeof bulkDeletePitScoutData === 'function') {
          results = await bulkDeletePitScoutData(docIds);
        }
      } finally {
        hideLoading();
      }

      const statusEl = document.getElementById('pit-bulk-delete-status');
      if (statusEl) {
        if (results.failed.length > 0) {
          console.error('Bulk pit delete: failed doc IDs:', results.failed);
          statusEl.textContent = `Deleted ${results.succeeded.length} of ${docIds.length} entries — ${results.failed.length} failed`;
          statusEl.className = 'error-message';
        } else {
          statusEl.textContent = `Deleted ${results.succeeded.length} entr${results.succeeded.length === 1 ? 'y' : 'ies'}.`;
          statusEl.className = 'success-message';
        }
        setTimeout(() => { statusEl.textContent = ''; statusEl.className = ''; }, 5000);
      }

      pitBulkSelectMode = false;
      pitBulkSelectedDocIds.clear();
      if (currentEventTeams && currentEventTeams.length > 0) {
        renderPitTeamList(currentEventTeams);
        applyTeamSearchFilter(currentTeamSearchQuery);
      }
    });
  }
});

// ====== In-list team filtering & sync (Match & Pit) ======
function applyTeamSearchFilter(query) {
  currentTeamSearchQuery = query || '';
  const q = currentTeamSearchQuery.trim().toLowerCase();

  // Update all input values if they differ
  const matchInput = document.getElementById('input-team-search-match');
  const pitInput = document.getElementById('input-team-search-pit');
  const infoInput = document.getElementById('input-team-search-info');
  if (matchInput && matchInput.value !== currentTeamSearchQuery) {
    matchInput.value = currentTeamSearchQuery;
  }
  if (pitInput && pitInput.value !== currentTeamSearchQuery) {
    pitInput.value = currentTeamSearchQuery;
  }
  if (infoInput && infoInput.value !== currentTeamSearchQuery) {
    infoInput.value = currentTeamSearchQuery;
  }

  // Filter match team items
  const matchContainer = document.getElementById('team-list-match');
  if (matchContainer) {
    matchContainer.querySelectorAll('.team-item').forEach(item => {
      const text = item.textContent.toLowerCase();
      item.style.display = (!q || text.includes(q)) ? '' : 'none';
    });
  }

  // Filter pit team items
  const pitContainer = document.getElementById('team-list-pit');
  if (pitContainer) {
    pitContainer.querySelectorAll('.team-item').forEach(item => {
      const text = item.textContent.toLowerCase();
      item.style.display = (!q || text.includes(q)) ? '' : 'none';
    });
  }

  // Filter info team items
  const infoContainer = document.getElementById('team-list-info');
  if (infoContainer) {
    infoContainer.querySelectorAll('.team-item').forEach(item => {
      const text = item.textContent.toLowerCase();
      item.style.display = (!q || text.includes(q)) ? '' : 'none';
    });
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const matchSearchInput = document.getElementById('input-team-search-match');
  if (matchSearchInput) {
    matchSearchInput.addEventListener('input', (e) => {
      applyTeamSearchFilter(e.target.value);
    });
  }

  const pitSearchInput = document.getElementById('input-team-search-pit');
  if (pitSearchInput) {
    pitSearchInput.addEventListener('input', (e) => {
      applyTeamSearchFilter(e.target.value);
    });
  }

  const infoSearchInput = document.getElementById('input-team-search-info');
  if (infoSearchInput) {
    infoSearchInput.addEventListener('input', (e) => {
      applyTeamSearchFilter(e.target.value);
    });
  }

  // Also hook into scouting subtab buttons to re-apply filter on tab switch without resetting
  const subtabButtons = document.querySelectorAll('#scouting-subtabs .tab');
  subtabButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      // Small timeout to let DOM active class update first
      setTimeout(() => {
        applyTeamSearchFilter(currentTeamSearchQuery);
      }, 10);
    });
  });
});

function renderMatchTeamList(teams) {
  console.time('[Timing] renderMatchTeamList');
  const container = document.getElementById('team-list-match');
  const status = document.getElementById('team-list-status-match');
  if (!container || !status) {
    console.timeEnd('[Timing] renderMatchTeamList');
    return;
  }
  container.innerHTML = '';

  if (!teams || teams.length === 0) {
    status.textContent = 'No teams found for this event.';
    console.timeEnd('[Timing] renderMatchTeamList');
    return;
  }

  currentEventTeams = teams;
  status.textContent = `${teams.length} team(s)`;
  const sorted = sortTeams(teams);

  sorted.forEach(team => {
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

    const oprSpan = document.createElement('span');
    oprSpan.className = 'team-opr-inline';
    oprSpan.textContent = typeof team.opr === 'number' ? `OPR: ${team.opr.toFixed(1)}` : 'OPR: --';

    leftGroup.appendChild(numSpan);
    leftGroup.appendChild(nameSpan);
    leftGroup.appendChild(oprSpan);

    const btnGroup = document.createElement('div');
    btnGroup.style.cssText = 'display:flex; align-items:center; gap:6px; flex-shrink:0;';

    // Match scout quick button (+ Match Scout)
    const scoutBtn = document.createElement('button');
    scoutBtn.className = 'btn btn-small btn-primary';
    scoutBtn.style.cssText = 'width: auto; padding: 4px 10px; font-size: 0.8rem;';
    scoutBtn.textContent = '+ Match Scout';
    scoutBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (selectedEvent?.code && typeof openMatchScoutForm === 'function') {
        openMatchScoutForm(team.teamNumber, selectedEvent.code);
      }
    });

    btnGroup.appendChild(scoutBtn);

    item.appendChild(leftGroup);
    item.appendChild(btnGroup);
    container.appendChild(item);
  });
  console.timeEnd('[Timing] renderMatchTeamList');
}

// ====== Show/update/remove the "Scouted by / Last edited by" line on a pit
// team-list row — called on initial render and again (via
// refreshTeamListScoutedState) right after a save/delete, so it reflects the
// new state immediately rather than waiting for the next full re-render. ======
function updatePitTeamRowMetaLine(item, teamNumber, eventCode) {
  let metaLine = item.querySelector('.pit-row-meta');
  const isScouted = typeof isTeamScouted === 'function' ? isTeamScouted(teamNumber, eventCode) : false;
  const entry = (isScouted && typeof getPitScoutedEntry === 'function') ? getPitScoutedEntry(teamNumber, eventCode) : null;

  if (!entry) {
    if (metaLine) metaLine.remove();
    return;
  }

  if (!metaLine) {
    metaLine = document.createElement('div');
    metaLine.className = 'pit-row-meta';
    metaLine.style.cssText = 'font-size:0.75rem; color:var(--text-muted);';
    item.appendChild(metaLine);
  }

  const scoutedBy = entry.scoutedByName || entry.scoutedByEmail || 'Unknown';
  const lastEditedBy = entry.lastEditedByName || entry.lastEditedByEmail || 'N/A';
  metaLine.textContent = `Scouted by: ${scoutedBy} | Last edited by: ${lastEditedBy}`;
}

function renderPitTeamList(teams) {
  console.time('[Timing] renderPitTeamList');
  const container = document.getElementById('team-list-pit');
  const status = document.getElementById('team-list-status-pit');
  if (!container || !status) {
    console.timeEnd('[Timing] renderPitTeamList');
    return;
  }
  container.innerHTML = '';

  if (!teams || teams.length === 0) {
    status.textContent = 'No teams found for this event.';
    console.timeEnd('[Timing] renderPitTeamList');
    return;
  }

  status.textContent = `${teams.length} team(s)`;
  const sorted = sortTeams(teams);

  sorted.forEach(team => {
    const item = document.createElement('div');
    item.className = 'team-item team-item-pit';
    item.dataset.teamNumber = team.teamNumber;
    // Overrides the shared .team-item row layout so a second, full-width line
    // (Scouted by / Last edited by) can stack below the number/name/buttons
    // row for teams that have been pit scouted.
    item.style.cssText = 'display:flex; flex-direction:column; align-items:stretch; gap:4px;';

    const topRow = document.createElement('div');
    topRow.style.cssText = 'display:flex; align-items:center; justify-content:space-between; gap:8px;';

    const leftGroup = document.createElement('div');
    leftGroup.style.cssText = 'display:flex; align-items:center; gap:8px; flex:1; min-width:0;';

    const numSpan = document.createElement('span');
    numSpan.className = 'team-number';
    numSpan.textContent = `#${team.teamNumber}`;

    const nameSpan = document.createElement('span');
    nameSpan.className = 'team-name';
    nameSpan.textContent = team.name || team.nameFull || team.nameShort || team.schoolName || team.teamNameCalc || '';

    const oprSpan = document.createElement('span');
    oprSpan.className = 'team-opr-inline';
    oprSpan.textContent = typeof team.opr === 'number' ? `OPR: ${team.opr.toFixed(1)}` : 'OPR: --';

    leftGroup.appendChild(numSpan);
    leftGroup.appendChild(nameSpan);
    leftGroup.appendChild(oprSpan);

    const btnGroup = document.createElement('div');
    btnGroup.style.cssText = 'display:flex; align-items:center; gap:6px; flex-shrink:0;';

    const scoutBtn = document.createElement('button');
    // btn-pit-quick-scout is a style-neutral hook (no CSS rule targets it) — it just
    // gives refreshTeamListScoutedState() a stable selector to find this exact button,
    // since its actual style classes never change and can't be used to identify it.
    scoutBtn.className = 'btn btn-small btn-primary btn-pit-quick-scout';
    scoutBtn.style.cssText = 'width: auto; padding: 4px 10px; font-size: 0.8rem; display: inline-flex; align-items: center; gap: 4px;';

    const isScouted = typeof isTeamScouted === 'function' ? isTeamScouted(team.teamNumber, selectedEvent?.code) : false;
    if (isScouted) {
      scoutBtn.style.background = 'var(--success)';
      const checkSpan = document.createElement('span');
      checkSpan.textContent = '✓';
      const textSpan = document.createElement('span');
      textSpan.textContent = 'Edit Pit Scout';
      scoutBtn.appendChild(checkSpan);
      scoutBtn.appendChild(textSpan);
    } else {
      scoutBtn.textContent = '+ Pit Scout';
    }

    scoutBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (selectedEvent?.code && typeof openPitScoutForm === 'function') {
        openPitScoutForm(team.teamNumber, selectedEvent.code);
      }
    });

    // Bulk-select checkbox — only in select mode, and only for teams that have
    // been pit scouted (nothing to delete otherwise). Toggle visibility is already
    // permission-gated (see updatePitBulkSelectUI), so anyone who can see the mode
    // at all is allowed to bulk-delete any scouted entry.
    if (pitBulkSelectMode && isScouted && selectedEvent?.code) {
      const docId = `${selectedEvent.code}_${team.teamNumber}`;
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.style.cssText = 'width:18px; height:18px; flex-shrink:0; cursor:pointer;';
      checkbox.checked = pitBulkSelectedDocIds.has(docId);
      checkbox.addEventListener('change', (e) => {
        e.stopPropagation();
        if (checkbox.checked) {
          pitBulkSelectedDocIds.add(docId);
        } else {
          pitBulkSelectedDocIds.delete(docId);
        }
        updatePitBulkSelectUI();
      });
      leftGroup.insertBefore(checkbox, leftGroup.firstChild);
    }

    btnGroup.appendChild(scoutBtn);

    topRow.appendChild(leftGroup);
    topRow.appendChild(btnGroup);
    item.appendChild(topRow);

    updatePitTeamRowMetaLine(item, team.teamNumber, selectedEvent?.code);

    container.appendChild(item);
  });

  if (typeof refreshTeamListScoutedState === 'function') {
    refreshTeamListScoutedState();
  }
  updatePitBulkSelectUI();
  console.timeEnd('[Timing] renderPitTeamList');
}

// ====== Handle search button click ======
async function doSearch() {
  if (isSearching) return;
  clearErrors();
  hideSuggestions();
  const query = document.getElementById('input-event-search').value.trim();

  // Empty search: clear everything and return
  if (!query) {
    clearSelectedEvent();
    return;
  }

  // Clear any previously selected event before showing new results
  clearSelectedEvent();
  const season = getSelectedSeason();

  isSearching = true;
  showLoading('Searching events...');
  try {
    // This loads the full list if not already cached, then filters
    const allEvents = await ensureEventsLoaded(season);
    const filtered = filterEvents(allEvents, query);
    hideLoading();
    renderEventList(filtered);
  } catch (err) {
    hideLoading();
    console.error('Event search error:', err);
    showError('event-error', 'Failed to search events. Check your connection and try again.');
  } finally {
    isSearching = false;
  }
}

// ====== Event Search Button ======
document.getElementById('btn-search-events').addEventListener('click', doSearch);

// ====== Deselect Event Button (normal-search flow's counterpart to the Pinned Events tab's Deselect button) ======
const btnDeselectEvent = document.getElementById('btn-deselect-event');
if (btnDeselectEvent) {
  btnDeselectEvent.addEventListener('click', () => {
    clearSelectedEvent();
  });
}

// ====== Live Autocomplete (client-side, no API calls) ======
document.getElementById('input-event-search').addEventListener('input', () => {
  if (debounceTimer) clearTimeout(debounceTimer);

  const query = document.getElementById('input-event-search').value.trim();
  if (!query) {
    hideSuggestions();
    return;
  }

  debounceTimer = setTimeout(() => {
    const season = getSelectedSeason();
    const allEvents = eventCache[season];
    if (!allEvents) {
      // Cache not loaded yet — don't show suggestions, just wait for search
      hideSuggestions();
      return;
    }

    const matches = filterEvents(allEvents, query).slice(0, 8);
    renderSuggestions(matches);
  }, 150); // 150ms debounce — fast since it's local
});

// ====== Hide suggestions on blur / Escape ======
document.getElementById('input-event-search').addEventListener('blur', () => {
  setTimeout(hideSuggestions, 200);
});

document.getElementById('input-event-search').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    hideSuggestions();
  } else if (e.key === 'Enter') {
    hideSuggestions();
    doSearch();
  }
});

// ====== When season changes, clear everything and re-fetch ======
document.getElementById('select-season').addEventListener('change', async () => {
  const season = getSelectedSeason();

  // Clear all previous state immediately
  clearSelectedEvent();
  document.getElementById('input-event-search').value = '';

  // If we don't have this season cached yet, pre-load it in the background
  if (!eventCache[season]) {
    try {
      await ensureEventsLoaded(season);
    } catch (err) {
      // Silently fail — the search button will handle errors
    }
  }
});

// ====== Pre-load current season on page load ======
populateSeasonDropdown();

// Kick off background load of the current season's events
const initialSeason = getSelectedSeason();
ensureEventsLoaded(initialSeason).catch(() => {});
