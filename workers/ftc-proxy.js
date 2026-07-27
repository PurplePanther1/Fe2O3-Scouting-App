/**
 * Cloudflare Worker — FIRST FTC Events API Proxy
 *
 * Proxies requests to the FIRST FTC Events API so the API token
 * is never exposed to client-side code. The token is stored as a
 * Cloudflare Worker secret (environment variable).
 *
 * Endpoints:
 *   GET /events?query=SEARCH_TERM&season=YYYY   — search events by name/code (season defaults to current FTC season)
 *   GET /teams?eventCode=CODE&season=YYYY       — get teams for an event (season defaults to current FTC season)
 *
 * Deploy:
 *   npm install -g wrangler
 *   wrangler secret put FTC_API_USERNAME
 *   wrangler secret put FTC_API_TOKEN
 *   wrangler deploy
 */

const FTC_API_BASE = 'https://ftc-api.firstinspires.org/v2.0';

/**
 * Compute the current FTC season.
 * FTC seasons run September–April, named by the year they start.
 * If the current month is before September, season = current year - 1.
 * Otherwise, season = current year.
 * Examples: Jan 2026 → season 2025, Sep 2026 → season 2026.
 */
function getCurrentSeason() {
  const now = new Date();
  const month = now.getMonth() + 1; // getMonth() is 0-indexed
  return month >= 9 ? now.getFullYear() : now.getFullYear() - 1;
}

/**
 * Handle incoming request.
 */
export default {
  async fetch(request, env, ctx) {
    // Handle CORS preflight (OPTIONS)
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: corsHeaders(),
      });
    }

    // Only allow GET requests
    if (request.method !== 'GET') {
      return jsonResponse({ error: 'Method not allowed' }, 405);
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, ''); // strip trailing slash

    try {
      let result;

      if (path === '/events') {
        const query = url.searchParams.get('query') || '';
        const season = url.searchParams.get('season') || '';
        result = await handleSearchEvents(query, season, env);
      } else if (path === '/teams') {
        const eventCode = url.searchParams.get('eventCode');
        const season = url.searchParams.get('season') || '';
        if (!eventCode) {
          return jsonResponse({ error: 'eventCode query parameter is required' }, 400, corsHeaders());
        }
        result = await handleGetEventTeams(eventCode, season, env);
      } else {
        return jsonResponse({ error: 'Not found. Use GET /events or GET /teams?eventCode=...' }, 404, corsHeaders());
      }

      return jsonResponse(result, 200, corsHeaders());
    } catch (err) {
      console.error('Worker error:', err.message);
      return jsonResponse({ error: err.message }, 500, corsHeaders());
    }
  },
};

// ====== Route Handlers ======

/**
 * Fetch all events for a season, paginating through every page.
 * The FIRST API returns { events, eventCount, pageCurrent, pageTotal }.
 * NOTE: The API only includes pagination metadata when you explicitly pass a page parameter.
 * Without ?page=, it returns all events in one response with no pageTotal field.
 */
async function handleSearchEvents(query, season, env) {
  const s = season || getCurrentSeason();
  let allEvents = [];

  if (query && query.trim()) {
    // With a query, just fetch the first page and filter
    const data = await ftcApiGet(`/${s}/events`, env);
    const q = query.trim().toLowerCase();
    allEvents = (data.events || []).filter(evt =>
      (evt.name && evt.name.toLowerCase().includes(q)) ||
      (evt.code && evt.code.toLowerCase().includes(q))
    );
    console.log(`[events] query="${query}" season=${s} → ${allEvents.length} results (single page, no pagination needed)`);
  } else {
    // No query = fetch ALL pages to build a complete cache
    // Always start with ?page=1 so the API returns pagination metadata
    let page = 1;
    let totalPages = 1;

    while (page <= totalPages) {
      const data = await ftcApiGet(`/${s}/events?page=${page}`, env);

      if (page === 1) {
        totalPages = data.pageTotal || 1;
      }

      const batch = data.events || [];
      allEvents.push(...batch);
      page++;
    }
  }

  return { events: allEvents };
}

/**
 * Fetch all teams for an event, paginating through every page.
 * The FIRST API returns { teams, teamCount, pageCurrent, pageTotal }.
 */
async function handleGetEventTeams(eventCode, season, env) {
  const s = season || getCurrentSeason();
  let allTeams = [];
  let page = 1;
  let totalPages = 1;

  while (page <= totalPages) {
    const data = await ftcApiGet(`/${s}/teams?eventCode=${encodeURIComponent(eventCode)}&page=${page}`, env);

    if (page === 1) {
      totalPages = data.pageTotal || 1;
      console.log(`[teams] event=${eventCode} season=${s} pageTotal=${totalPages} teamCount=${data.teamCount || '?'}`);
    }

    const batch = data.teams || [];
    allTeams.push(...batch);
    console.log(`[teams] page ${page}: fetched ${batch.length} teams (total so far: ${allTeams.length})`);
    page++;
  }

  console.log(`[teams] DONE event=${eventCode} totalTeams=${allTeams.length} across ${page - 1} pages`);
  return { teams: allTeams };
}

// ====== Helper: Authenticated GET to FIRST API ======

async function ftcApiGet(endpoint, env) {
  const username = env.FTC_API_USERNAME;
  const token = env.FTC_API_TOKEN;

  if (!username || !token) {
    throw new Error('FIRST API credentials not configured. Set FTC_API_USERNAME and FTC_API_TOKEN secrets.');
  }

  const url = `${FTC_API_BASE}${endpoint}`;
  const auth = btoa(`${username}:${token}`);

  const response = await fetch(url, {
    headers: {
      'Authorization': `Basic ${auth}`,
      'Accept': 'application/json',
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`FIRST API error ${response.status}: ${text}`);
  }

  return await response.json();
}

// ====== Response Helpers ======

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...extraHeaders,
    },
  });
}