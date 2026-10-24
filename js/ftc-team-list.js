// ====== Local, cached copy of FTCScout's full team list ======
// FTCScout's own team search only matches number PREFIXES and ignores `limit`, so the
// lookup popup (ftc-team-lookup.js) searches a LOCAL copy of the whole list instead:
//   - ONE request (teamsSearch with an empty search text) returns every team: ~25.7k teams,
//     ~2.6 MB, ~1.2 s. Only what the popup needs is kept — [number, name, location] — so it
//     is small, and stored in IndexedDB (localStorage's ~5 MB is too tight and is
//     synchronous; IndexedDB holds structured data of this size comfortably) together with
//     the time it was fetched.
//   - LAZY: nothing is fetched or read until a lookup popup first needs it.
//   - It refreshes itself when older than FTC_TEAM_LIST_TTL_MS (24 h). A stale list is still
//     used when the refresh fails (offline, FTCScout down); with no list at all
//     getFtcTeamList() resolves null and the popup falls back to an exact-number lookup.
//   - After a failed refresh it does not retry for FTC_TEAM_LIST_RETRY_MS, so an offline
//     device doesn't re-attempt a 2.6 MB request on every popup.
//   - The "Refresh cached data" button (refreshFtcTeamListNow) replaces the copy on demand.
// All clock reads use Date.now() so a test can fake the time.

const FTC_TEAM_LIST_TTL_MS = 24 * 60 * 60 * 1000;
const FTC_TEAM_LIST_RETRY_MS = 60 * 1000;
const FTC_TEAM_LIST_DB_NAME = 'fe2o3-ftc-team-list';
const FTC_TEAM_LIST_STORE = 'lists';
const FTC_TEAM_LIST_KEY = 'all-teams';
const FTC_TEAM_LIST_QUERY = '{ teamsSearch(searchText: "") { number name location { city state country } } }';
const FTC_TEAM_LIST_MAX_RESULTS = 5;

let ftcTeamListMemo = null;          // { teams: [[number, name, location]...] ascending, fetchedAt }
let ftcTeamListLoading = null;       // the in-flight load, shared by every caller
let ftcTeamListFailedAt = 0;         // when the last refresh failed (0 = none)

// ====== IndexedDB (never throws: a device without it just refetches each session) ======
function openFtcTeamListDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB is not available')); return; }
    const req = indexedDB.open(FTC_TEAM_LIST_DB_NAME, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(FTC_TEAM_LIST_STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB open failed'));
  });
}

async function readStoredFtcTeamList() {
  try {
    const db = await openFtcTeamListDb();
    try {
      return await new Promise((resolve, reject) => {
        const req = db.transaction(FTC_TEAM_LIST_STORE, 'readonly').objectStore(FTC_TEAM_LIST_STORE).get(FTC_TEAM_LIST_KEY);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      });
    } finally {
      db.close();
    }
  } catch (err) {
    console.warn('Could not read the stored FTCScout team list:', err);
    return null;
  }
}

async function writeStoredFtcTeamList(record) {
  try {
    const db = await openFtcTeamListDb();
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction(FTC_TEAM_LIST_STORE, 'readwrite');
        tx.objectStore(FTC_TEAM_LIST_STORE).put(record, FTC_TEAM_LIST_KEY);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('IndexedDB write aborted'));
      });
    } finally {
      db.close();
    }
    return true;
  } catch (err) {
    console.warn('Could not store the FTCScout team list (it will be refetched next session):', err);
    return false;
  }
}

// ====== The one request ======
// Deliberately NOT graphQL() (ftcscout.js): that logs the whole response object to the console.
async function fetchFtcTeamListFromNetwork() {
  const response = await fetch(FTCSCOUT_GQL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: FTC_TEAM_LIST_QUERY })
  });
  if (!response.ok) throw new Error(`FTCScout team list error ${response.status}`);
  const body = await response.json();
  if (body.errors) throw new Error(body.errors[0].message);
  const rows = (body.data && body.data.teamsSearch) || [];
  const teams = [];
  rows.forEach((t) => {
    const number = Number(t && t.number);
    if (!Number.isInteger(number) || number < 1) return;
    const loc = (t.location && typeof t.location === 'object') ? t.location : {};
    teams.push([number, String(t.name || '').trim(), [loc.city, loc.state, loc.country].filter(Boolean).join(', ')]);
  });
  if (teams.length === 0) throw new Error('FTCScout returned an empty team list');
  teams.sort((a, b) => a[0] - b[0]);
  return { teams, fetchedAt: Date.now() };
}

function ftcTeamListIsFresh(record) {
  return !!record && Number.isFinite(record.fetchedAt) && (Date.now() - record.fetchedAt) < FTC_TEAM_LIST_TTL_MS;
}

// Is a fresh copy already in memory (so a search needs no waiting)?
function ftcTeamListReadyNow() {
  return ftcTeamListIsFresh(ftcTeamListMemo);
}

// Resolves { teams, fetchedAt, refreshFailed? } or null (no copy anywhere and the fetch failed).
async function getFtcTeamList() {
  if (ftcTeamListIsFresh(ftcTeamListMemo)) return ftcTeamListMemo;
  if (ftcTeamListLoading) return ftcTeamListLoading;
  const load = (async () => {
    const stored = ftcTeamListMemo || await readStoredFtcTeamList();
    if (ftcTeamListIsFresh(stored)) { ftcTeamListMemo = stored; return stored; }
    // Missing or older than 24 h: refresh — unless one just failed (then use what we have).
    if (!(ftcTeamListFailedAt && Date.now() - ftcTeamListFailedAt < FTC_TEAM_LIST_RETRY_MS)) {
      try {
        const fresh = await fetchFtcTeamListFromNetwork();
        ftcTeamListFailedAt = 0;
        ftcTeamListMemo = fresh;
        await writeStoredFtcTeamList(fresh);
        return fresh;
      } catch (err) {
        ftcTeamListFailedAt = Date.now();
        console.warn('Could not refresh the FTCScout team list:', err);
      }
    }
    if (stored && Array.isArray(stored.teams) && stored.teams.length > 0) {
      ftcTeamListMemo = stored;
      return { ...stored, refreshFailed: true };
    }
    return null;
  })();
  // Cleared by a .finally on the promise itself — NOT inside the async body, which can finish
  // synchronously (nothing awaited) and would clear it BEFORE this assignment, leaving a settled
  // promise stuck here forever.
  ftcTeamListLoading = load;
  load.finally(() => { if (ftcTeamListLoading === load) ftcTeamListLoading = null; });
  return load;
}

// The "Refresh cached data" button: fetch a new copy and REPLACE the stored one. Throws if the
// fetch fails (the old copy is left exactly as it was).
async function refreshFtcTeamListNow() {
  const fresh = await fetchFtcTeamListFromNetwork();
  ftcTeamListFailedAt = 0;
  ftcTeamListMemo = fresh;
  await writeStoredFtcTeamList(fresh);
  return fresh;
}

// Forget the in-memory copy (and, with clearStored, the stored one).
async function clearFtcTeamListCache({ clearStored = false } = {}) {
  ftcTeamListMemo = null;
  ftcTeamListFailedAt = 0;
  if (!clearStored) return;
  try {
    const db = await openFtcTeamListDb();
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction(FTC_TEAM_LIST_STORE, 'readwrite');
        tx.objectStore(FTC_TEAM_LIST_STORE).delete(FTC_TEAM_LIST_KEY);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  } catch (err) {
    console.warn('Could not clear the stored FTCScout team list:', err);
  }
}

// ====== Search ======
// The typed digits are matched as TEXT. Ranking: the exact number first, then numbers that
// START WITH the digits, then numbers that merely CONTAIN them; within each group lower numbers
// first (the list is sorted ascending). At most `limit` results.
// Resolves [{ number, name, location }].
function searchFtcTeamList(teams, text, limit = FTC_TEAM_LIST_MAX_RESULTS) {
  const typed = String(text == null ? '' : text).trim().replace(/^0+(?=\d)/, '');
  if (!/^\d+$/.test(typed) || !Array.isArray(teams)) return [];
  const exact = [];
  const starts = [];
  const contains = [];
  for (let i = 0; i < teams.length; i++) {
    const s = String(teams[i][0]);
    if (s === typed) exact.push(teams[i]);
    else if (s.startsWith(typed)) starts.push(teams[i]);
    else if (s.includes(typed)) contains.push(teams[i]);
  }
  return [...exact, ...starts, ...contains].slice(0, limit)
    .map(([number, name, location]) => ({ number, name, location }));
}
