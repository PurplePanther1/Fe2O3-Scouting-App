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
  const isPit = prefix === 'td-pit-';
  const detailArea = document.getElementById(isPit ? 'team-detail-area-pit' : 'team-detail-area-match') || document.getElementById('team-detail-area');
  const numberEl = document.getElementById(`${prefix}team-number`);
  const nameEl = document.getElementById(`${prefix}team-name`);
  const locationEl = document.getElementById(`${prefix}team-location`);
  const oprBadge = document.getElementById(`${prefix}opr-badge`);
  const awardsList = document.getElementById(`${prefix}awards-list`);
  const errorEl = document.getElementById(`${prefix}error`);

  // Show detail area with loading state
  if (detailArea) detailArea.classList.remove('hidden');
  if (numberEl) numberEl.textContent = `#${teamNumber}`;
  if (nameEl) nameEl.textContent = 'Loading...';
  if (locationEl) locationEl.textContent = '';
  if (oprBadge) oprBadge.textContent = 'OPR: --';
  if (awardsList) awardsList.innerHTML = '<p class="help-text" style="font-size:0.8rem">Loading awards...</p>';
  if (errorEl) errorEl.textContent = '';

  // Render match entries immediately (from cache if available) if match view
  if (!isPit && typeof renderMatchListForTeam === 'function' && eventCode) {
    renderMatchListForTeam(eventCode, teamNumber);
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

  // Awards
  const awardsList = document.getElementById(`${prefix}awards-list`);
  if (awardsList) {
    awardsList.innerHTML = '';
    
    // Filter awards to only the current season for relevance, or show all if none for this season
    const season = getSelectedSeason();
    let filteredAwards = (detail.awards || []).filter(a => a.season === Number(season));
    if (filteredAwards.length === 0) {
      filteredAwards = detail.awards || [];
    }
    
    if (filteredAwards.length > 0) {
      filteredAwards.forEach(award => {
        const item = document.createElement('div');
        item.style.cssText = 'padding:4px 0; font-size:0.85rem; border-bottom:1px solid var(--border); display:flex; justify-content:space-between';
        const nameSpan = document.createElement('span');
        const placement = award.placement ? ` #${award.placement}` : '';
        nameSpan.textContent = `${award.type}${placement}`;
        const seasonSpan = document.createElement('span');
        seasonSpan.style.cssText = 'color:var(--text-muted); font-size:0.75rem';
        seasonSpan.textContent = `${award.season}`;
        item.appendChild(nameSpan);
        item.appendChild(seasonSpan);
        awardsList.appendChild(item);
      });
    } else {
      awardsList.innerHTML = '<p class="help-text" style="font-size:0.8rem; margin-bottom:0">No awards found.</p>';
    }
  }
}

// ====== Wire up team list items to show detail on click ======
function wireTeamDetailClick(teamNumber, eventCode) {
  loadTeamDetail(teamNumber, eventCode);
}

// ====== Scout This Team button ======
document.getElementById('btn-scout-team').addEventListener('click', () => {
  const teamNum = document.getElementById('td-team-number').textContent.replace('#', '');
  const eventCode = selectedEvent?.code;
  if (teamNum && eventCode && typeof openPitScoutForm === 'function') {
    openPitScoutForm(teamNum, eventCode);
  }
});

// ====== Add Match Entry button ======
document.getElementById('btn-add-match-entry').addEventListener('click', () => {
  const teamNum = document.getElementById('td-team-number').textContent.replace('#', '');
  const eventCode = selectedEvent?.code;
  if (teamNum && eventCode && typeof openMatchScoutForm === 'function') {
    openMatchScoutForm(teamNum, eventCode);
  }
});
