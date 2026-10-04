// ====== FTCScout GraphQL API Integration ======
// No auth needed — public endpoint at https://api.ftcscout.org/graphql

const FTCSCOUT_GQL = 'https://api.ftcscout.org/graphql';

// ====== Execute a GraphQL query ======
async function graphQL(query) {
  try {
    const response = await fetch(FTCSCOUT_GQL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query })
    });
    console.log('[FTCScout GQL] HTTP status:', response.status, response.statusText);
    if (!response.ok) {
      const errText = await response.text();
      console.error('[FTCScout GQL] Error response body:', errText);
      throw new Error(`FTCScout GraphQL error ${response.status}: ${errText}`);
    }
    const data = await response.json();
    console.log('[FTCScout GQL] Raw response object:', data);
    if (data.errors) {
      console.error('[FTCScout GQL] GraphQL errors:', data.errors);
      throw new Error(data.errors[0].message);
    }
    return data.data;
  } catch (err) {
    console.error('[FTCScout GQL] Network or parse exception:', err);
    throw err;
  }
}

// ====== Fetch team detail from FTCScout GraphQL ======
async function fetchTeamDetail(teamNumber, season) {
  const data = await graphQL(`{
    teamByNumber(number: ${teamNumber}) {
      number
      name
      location { city state country }
      rookieYear
      website
      quickStats(season: ${season}) {
        season
        tot { value rank }
        auto { value rank }
        dc { value rank }
        eg { value rank }
        count
      }
      awards {
        season
        eventCode
        type
        placement
      }
    }
  }`);
  return data.teamByNumber;
}

// ====== Fetch multiple team details in a single batched GraphQL query via aliasing ======
async function fetchTeamDetailsBatch(teamNumbers, season) {
  if (!teamNumbers || teamNumbers.length === 0) return {};
  
  // Construct aliased query string
  // e.g. { t1234: teamByNumber(number: 1234) { number name location { city state country } } t5678: teamByNumber(...) }
  const fields = teamNumbers.map(num => {
    const alias = `t_${num}`;
    return `
      ${alias}: teamByNumber(number: ${num}) {
        number
        name
        location { city state country }
        rookieYear
        website
        quickStats(season: ${season}) {
          season
          tot { value rank }
          auto { value rank }
          dc { value rank }
          eg { value rank }
          count
        }
        awards {
          season
          eventCode
          type
          placement
        }
      }
    `;
  }).join('\n');

  const query = `{ ${fields} }`;
  const data = await graphQL(query);
  
  // Map back from aliases (t_1234 -> team object)
  const results = {};
  teamNumbers.forEach(num => {
    const alias = `t_${num}`;
    if (data && data[alias]) {
      results[num] = data[alias];
    }
  });
  return results;
}

// ====== Fetch event names for (season, eventCode) pairs in a single batched GraphQL query ======
async function fetchEventNamesBatch(pairs) {
  if (!pairs || pairs.length === 0) return {};

  const fields = pairs.map((p, i) => `
    e${i}: eventByCode(season: ${p.season}, code: ${JSON.stringify(p.code)}) {
      name
    }
  `).join('\n');

  const data = await graphQL(`{ ${fields} }`);

  const results = {};
  pairs.forEach((p, i) => {
    const alias = `e${i}`;
    results[`${p.season}_${p.code}`] = (data && data[alias] && data[alias].name) || null;
  });
  return results;
}

// In-memory cache of resolved event names, keyed `${season}_${eventCode}`
const eventNameCache = {};

// Last-loaded raw team detail per detail-pane prefix, so the awards season filter can re-render without refetching
const lastLoadedTeamDetail = {};

// ====== Populate the awards season filter from a team's actual award history ======
function populateAwardsSeasonSelect(prefix, awards) {
  const select = document.getElementById(`${prefix}awards-season-select`);
  if (!select) return;
  select.innerHTML = '';

  const seasons = Array.from(new Set((awards || []).map(a => a.season))).sort((a, b) => b - a);

  if (seasons.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'No awards';
    select.appendChild(opt);
    select.disabled = true;
    return;
  }

  select.disabled = false;
  seasons.forEach(season => {
    const opt = document.createElement('option');
    opt.value = season;
    opt.textContent = formatFtcSeasonLabel(season);
    select.appendChild(opt);
    // No-op if already cached (label above already reflects it); otherwise
    // patches this option's textContent in place once the name resolves —
    // a team's award history can reach back further than the main season
    // dropdown's prefetched range.
    if (typeof ensureSeasonGameNameLoaded === 'function') {
      ensureSeasonGameNameLoaded(season);
    }
  });

  // Default to the globally selected season if the team won something that season, else its most recent award season
  const globalSeason = Number(getSelectedSeason());
  select.value = seasons.includes(globalSeason) ? String(globalSeason) : String(seasons[0]);
}

// ====== Render the awards list for whichever season is picked in the filter ======
async function renderAwardsList(prefix) {
  const awardsList = document.getElementById(`${prefix}awards-list`);
  const select = document.getElementById(`${prefix}awards-season-select`);
  const stored = lastLoadedTeamDetail[prefix];
  if (!awardsList || !stored) return;

  if (!select || !select.value) {
    awardsList.innerHTML = '<p class="help-text" style="font-size:0.8rem; margin-bottom:0">No awards found.</p>';
    return;
  }

  const season = Number(select.value);
  const seasonLabel = formatFtcSeasonLabel(season);
  const filtered = (stored.detail.awards || []).filter(a => a.season === season);

  if (filtered.length === 0) {
    awardsList.innerHTML = `<p class="help-text" style="font-size:0.8rem; margin-bottom:0">No awards for ${seasonLabel}.</p>`;
    return;
  }

  awardsList.innerHTML = '<p class="help-text" style="font-size:0.8rem">Loading event names...</p>';

  const uniquePairs = Array.from(new Set(filtered.map(a => a.eventCode)))
    .map(code => ({ season, code }))
    .filter(p => !(`${p.season}_${p.code}` in eventNameCache));

  if (uniquePairs.length > 0) {
    try {
      const fetched = await fetchEventNamesBatch(uniquePairs);
      Object.assign(eventNameCache, fetched);
    } catch (err) {
      console.warn('Failed to fetch event names for awards:', err);
    }
  }

  // The user may have switched seasons while the fetch above was in flight
  if (!select || Number(select.value) !== season) return;

  awardsList.innerHTML = '';
  filtered.forEach(award => {
    const item = document.createElement('div');
    item.style.cssText = 'padding:4px 0; font-size:0.85rem; border-bottom:1px solid var(--border); display:flex; justify-content:space-between; gap:8px';
    const nameSpan = document.createElement('span');
    const placement = award.placement ? ` #${award.placement}` : '';
    nameSpan.textContent = `${award.type}${placement}`;
    const eventSpan = document.createElement('span');
    eventSpan.style.cssText = 'color:var(--text-muted); font-size:0.75rem; text-align:right';
    eventSpan.textContent = eventNameCache[`${season}_${award.eventCode}`] || award.eventCode;
    item.appendChild(nameSpan);
    item.appendChild(eventSpan);
    awardsList.appendChild(item);
  });
}

// Wire up the awards season filter (in the Team Detail modal) once
document.addEventListener('DOMContentLoaded', () => {
  const select = document.getElementById('td-awards-season-select');
  if (select) {
    select.addEventListener('change', () => renderAwardsList('td-'));
  }
});

// ====== Get or create cached team detail in Firestore ======
async function getCachedTeamDetail(teamNumber) {
  try {
    const doc = await db.collection('teamDetails').doc(String(teamNumber)).get();
    if (doc.exists) {
      const data = doc.data();
      // If cached data is an error or empty state, ignore it and delete the bad cache entry
      if (data.isError || !data.name || data.name.startsWith('Team #')) {
        await db.collection('teamDetails').doc(String(teamNumber)).delete().catch(() => {});
        return null;
      }
      const cachedAt = data.cachedAt ? data.cachedAt.toMillis() : 0;
      const age = Date.now() - cachedAt;
      if (age < CACHE_TTL_MS) {
        return data;
      }
    }
  } catch (err) {
    console.warn('Error reading team detail cache:', err);
  }
  return null;
}

async function cacheTeamDetail(teamNumber, data) {
  // Never cache error states or empty team details
  if (!data || data.isError || !data.name || data.name.startsWith('Team #')) {
    return;
  }
  try {
    await db.collection('teamDetails').doc(String(teamNumber)).set({
      ...data,
      cachedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
  } catch (err) {
    console.warn('Failed to cache team detail:', err);
  }
}

// ====== Load team detail into the detail view ======
async function loadTeamDetail(teamNumber, eventCode, prefix = 'td-') {
  const numberEl = document.getElementById(`${prefix}team-number`);
  const nameEl = document.getElementById(`${prefix}team-name`);
  const locationEl = document.getElementById(`${prefix}team-location`);
  const oprBadge = document.getElementById(`${prefix}opr-badge`);
  const awardsList = document.getElementById(`${prefix}awards-list`);
  const errorEl = document.getElementById(`${prefix}error`);

  // Show loading state
  if (numberEl) numberEl.textContent = `#${teamNumber}`;
  if (nameEl) nameEl.textContent = 'Loading...';
  if (locationEl) locationEl.textContent = '';
  if (oprBadge) oprBadge.textContent = 'OPR: --';
  if (awardsList) awardsList.innerHTML = '<p class="help-text" style="font-size:0.8rem">Loading awards...</p>';
  if (errorEl) errorEl.textContent = '';

  // Render match entries immediately (from cache if available)
  if (typeof renderMatchListForTeam === 'function' && eventCode) {
    renderMatchListForTeam(eventCode, teamNumber);
  }

  // A scrimmage team that isn't linked to FTCScout must NEVER be looked up by
  // number: its number is whatever a scout typed (#99999 is a real FTCScout
  // team, for one), so a lookup would show some other team's name, location,
  // OPR and awards as if they were this one's. Show the roster's own info
  // instead. (A linked team — phase 2 — falls through to the normal lookup.)
  if (isScrimmageCode(eventCode)) {
    const rosterTeam = (typeof currentEventTeams !== 'undefined' ? currentEventTeams : []).find(t => Number(t.teamNumber) === Number(teamNumber));
    if (!rosterTeam || rosterTeam.linked !== true) {
      renderUnlinkedScrimmageTeamDetail(rosterTeam, teamNumber, prefix);
      return;
    }
  }

  try {
    // Check cache first
    const cached = await getCachedTeamDetail(teamNumber);
    if (cached) {
      renderTeamDetail(cached, teamNumber, prefix);
      return;
    }

    // Fetch from FTCScout GraphQL with fallback
    const season = getSelectedSeason();
    let detail = null;
    try {
      detail = await fetchTeamDetail(teamNumber, season);
    } catch (apiErr) {
      console.warn('FTCScout API fetch failed, attempting cached fallback:', apiErr);
    }
    
    if (detail) {
      // Extract location
      const loc = detail.location || {};
      const detailObj = {
        teamNumber,
        name: detail.name || `Team #${teamNumber}`,
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

      // Cache and render
      await cacheTeamDetail(teamNumber, detailObj);
      renderTeamDetail(detailObj, teamNumber, prefix);
    } else {
      // Render basic fallback info so UI never hangs on loading
      const fallbackObj = {
        teamNumber,
        name: `Team #${teamNumber}`,
        city: '',
        state: '',
        country: '',
        rookieYear: null,
        website: null,
        opr: null,
        auto: null,
        dc: null,
        eg: null,
        statsCount: 0,
        awards: []
      };
      renderTeamDetail(fallbackObj, teamNumber, prefix);
      if (errorEl) errorEl.textContent = 'Could not fetch live FTCScout details (offline or API limit). Showing basic team profile.';
    }
  } catch (err) {
    console.error('Failed to load team detail:', err);
    if (errorEl) errorEl.textContent = 'Failed to load team data.';
    if (nameEl) nameEl.textContent = `Team #${teamNumber}`;
    if (awardsList) awardsList.innerHTML = '<p class="help-text" style="font-size:0.8rem">No awards available.</p>';
  }
}

// ====== Team Details for a scrimmage team that isn't linked to FTCScout —
// roster info only, no network. Same DOM the normal path fills, so the rest of
// the modal (pit data, match entries, export) is unaffected. ======
function renderUnlinkedScrimmageTeamDetail(rosterTeam, teamNumber, prefix = 'td-') {
  const numEl = document.getElementById(`${prefix}team-number`);
  const nameEl = document.getElementById(`${prefix}team-name`);
  const locEl = document.getElementById(`${prefix}team-location`);
  const oprBadge = document.getElementById(`${prefix}opr-badge`);
  const awardsList = document.getElementById(`${prefix}awards-list`);
  const awardsSelect = document.getElementById(`${prefix}awards-season-select`);

  if (numEl) numEl.textContent = `#${teamNumber}`;
  if (nameEl) nameEl.textContent = (rosterTeam && rosterTeam.name) || `Team #${teamNumber}`;
  if (locEl) locEl.textContent = 'Unofficial scrimmage team';
  if (oprBadge) {
    oprBadge.textContent = 'OPR: N/A';
    oprBadge.style.background = 'transparent';
    oprBadge.style.border = '1px solid var(--border)';
  }
  if (awardsSelect) {
    awardsSelect.innerHTML = '';
    awardsSelect.disabled = true;
  }
  if (awardsList) {
    awardsList.innerHTML = '<p class="help-text" style="font-size:0.8rem; margin-bottom:0">This team isn\'t linked to FTCScout.</p>';
  }
  delete lastLoadedTeamDetail[prefix];
}

// ====== Render team detail into the DOM ======
function renderTeamDetail(detail, teamNumber, prefix = 'td-') {
  const numEl = document.getElementById(`${prefix}team-number`);
  const nameEl = document.getElementById(`${prefix}team-name`);
  if (numEl) numEl.textContent = `#${teamNumber}`;
  if (nameEl) nameEl.textContent = detail.name || 'Unknown Team';

  // Location
  const locEl = document.getElementById(`${prefix}team-location`);
  if (locEl) {
    const city = detail.city || detail.location?.city || '';
    const state = detail.state || detail.location?.state || '';
    const country = detail.country || detail.location?.country || '';
    const parts = [city, state, country].filter(Boolean);
    locEl.textContent = parts.join(', ') || 'Location unknown';
  }

  // OPR Badge
  const oprBadge = document.getElementById(`${prefix}opr-badge`);
  if (oprBadge) {
    if (detail.opr != null) {
      oprBadge.textContent = `OPR: ${Number(detail.opr).toFixed(1)}`;
      oprBadge.style.background = 'var(--primary)';
      oprBadge.style.border = 'none';
    } else {
      oprBadge.textContent = 'OPR: N/A';
      oprBadge.style.background = 'transparent';
      oprBadge.style.border = '1px solid var(--border)';
    }
  }

  // Awards — populate the season filter from this team's award history, then render that season's awards
  lastLoadedTeamDetail[prefix] = { detail, teamNumber };
  populateAwardsSeasonSelect(prefix, detail.awards || []);
  renderAwardsList(prefix);
}

// ====== Add Match Entry button (in the Team Detail modal) ======
const btnAddMatchEntry = document.getElementById('td-add-match-entry');
if (btnAddMatchEntry) {
  btnAddMatchEntry.addEventListener('click', () => {
    const eventCode = selectedEvent?.code;
    if (currentSelectedTeamNumber && eventCode && typeof openMatchScoutForm === 'function') {
      openMatchScoutForm(currentSelectedTeamNumber, eventCode);
    }
  });
}
