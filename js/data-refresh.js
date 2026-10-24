// ====== "Refresh cached data" (My Account > DATA) ======
// One button that re-caches what can be re-cached and makes event data reload fresh, with a
// per-DEVICE cooldown (localStorage, survives a reload) that starts only after a SUCCESSFUL
// refresh. What it does — and, just as important, what it does NOT:
//
//   REPLACES    the local FTCScout team list (ftc-team-list.js): fetched again, stored again.
//   EXPIRES     (on THIS device only) every cached copy of event data: it stamps the time here
//               (DATA_CACHE_EPOCH_KEY, first-api.js) and every read of the shared Firestore caches
//               — eventCache/season_<y> (event lists), events/<code> (roster, schedule, match
//               scores — even a finished event's), teamDetails/<n> (team stats / OPR) — treats a doc
//               cached before that moment as expired, so the next open of an event, schedule, score
//               list or Team Details fetches from FIRST/FTCScout and re-caches it (fresh for
//               everybody). The shared docs themselves are NEVER written or deleted by the button:
//               firestore.rules forbids deleting them, and writing "stale" markers into data every
//               team shares would let one click affect every other user.
//   CLEARS      the in-memory copies of those: the season event lists, resolved event names, match
//               scores per event, the form-config caches (re-read from Firestore on the next open)
//               and the season game-name cache (reloaded straight away).
//   NEVER       scouting entries, drafts, form configs or rosters in Firestore, anything the user
//               created; the signed-in session; the live listeners (so an open event or scrimmage keeps
//               working — the screen is simply not re-fetched until it is next opened); the service-
//               worker app-shell cache (network-first; it renews itself on every deploy through
//               CACHE_VERSION).
// If any part fails the cooldown does not start and nothing is stamped (the event caches stay valid).

const DATA_REFRESH_COOLDOWN_MS = 15 * 60 * 1000;   // <- the ONE place to change the cooldown
const DATA_REFRESH_STORAGE_KEY = 'fe2o3-data-refresh-last-success';

let dataRefreshBusy = false;
let dataRefreshStatusTimer = null;

function dataRefreshEl(id) {
  return document.getElementById(id);
}

// ====== Cooldown (per device) ======
function readDataRefreshLastSuccess() {
  try {
    const n = Number(localStorage.getItem(DATA_REFRESH_STORAGE_KEY));
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch (err) {
    return 0;
  }
}

function writeDataRefreshLastSuccess(ms) {
  try {
    localStorage.setItem(DATA_REFRESH_STORAGE_KEY, String(ms));
    localStorage.setItem(DATA_CACHE_EPOCH_KEY, String(ms));
  } catch (err) { /* private mode: no cooldown and no epoch, no harm */ }
}

// Milliseconds until the button works again (0 = available now). A stored time in the future
// (the device clock moved back) never blocks for longer than one cooldown.
function dataRefreshRemainingMs() {
  const last = readDataRefreshLastSuccess();
  if (!last) return 0;
  return Math.max(0, Math.min(DATA_REFRESH_COOLDOWN_MS, last + DATA_REFRESH_COOLDOWN_MS - Date.now()));
}

function renderDataRefreshControl() {
  const btn = dataRefreshEl('btn-refresh-cached-data');
  const help = dataRefreshEl('refresh-data-help');
  if (!btn) return;
  const minutes = Math.round(DATA_REFRESH_COOLDOWN_MS / 60000);
  if (help) {
    help.textContent = "Re-downloads FTCScout's team list and makes event rosters, schedules, scores and team stats reload fresh the next time you open them. "
      + `Your scouting data, forms and drafts are never touched. Available once every ${minutes} minutes.`;
  }
  if (dataRefreshBusy) {
    btn.disabled = true;
    btn.textContent = 'Refreshing...';
    return;
  }
  const remaining = dataRefreshRemainingMs();
  if (remaining > 0) {
    btn.disabled = true;
    btn.textContent = `Available again in ${Math.ceil(remaining / 60000)} min`;
  } else {
    btn.disabled = false;
    btn.textContent = 'Refresh cached data';
  }
}

function setDataRefreshStatus(type, message) {
  const err = dataRefreshEl('refresh-data-error');
  const ok = dataRefreshEl('refresh-data-success');
  if (err) err.textContent = type === 'error' ? message : '';
  if (ok) ok.textContent = type === 'success' ? message : '';
  if (dataRefreshStatusTimer) clearTimeout(dataRefreshStatusTimer);
  dataRefreshStatusTimer = message ? setTimeout(() => {
    if (err) err.textContent = '';
    if (ok) ok.textContent = '';
  }, 15000) : null;
}

// ====== In-memory copies ======
function clearInMemoryDataCaches() {
  const wipe = (obj) => { if (obj) Object.keys(obj).forEach(k => { delete obj[k]; }); };
  if (typeof eventCache !== 'undefined') wipe(eventCache);
  if (typeof eventNameCache !== 'undefined') wipe(eventNameCache);
  if (typeof matchScoresCacheByEvent !== 'undefined') matchScoresCacheByEvent = {};
  if (typeof formConfigCache !== 'undefined' && formConfigCache.clear) formConfigCache.clear();
  if (typeof matchFormConfigCache !== 'undefined' && matchFormConfigCache.clear) matchFormConfigCache.clear();
  if (typeof seasonGameNameCache !== 'undefined') {
    const seasons = Object.keys(seasonGameNameCache);
    wipe(seasonGameNameCache);
    // The dropdown labels were already patched; reload the names so later renders still have them.
    seasons.forEach(s => { if (typeof ensureSeasonGameNameLoaded === 'function') ensureSeasonGameNameLoaded(s); });
  }
}

// ====== The button ======
async function runDataRefresh() {
  if (dataRefreshBusy || dataRefreshRemainingMs() > 0) return;
  dataRefreshBusy = true;
  setDataRefreshStatus('', '');
  renderDataRefreshControl();
  const failures = [];
  try {
    try {
      await refreshFtcTeamListNow();                  // the one network step; a failure leaves the old list in place
    } catch (err) {
      console.warn('Could not refresh the FTCScout team list:', err);
      failures.push("FTCScout's team list");
    }
    if (failures.length === 0) clearInMemoryDataCaches();
  } catch (err) {
    console.error('Refresh cached data failed:', err);
    failures.push('some cached data');
  } finally {
    dataRefreshBusy = false;
  }

  if (failures.length > 0) {
    // A part-way failure: say so, and do NOT start the cooldown (nothing is stamped either).
    setDataRefreshStatus('error', `Couldn't finish refreshing (${failures.join(', ')}). Nothing you created was changed. Try again in a moment.`);
  } else {
    writeDataRefreshLastSuccess(Date.now());          // starts the cooldown AND expires the event caches on this device
    setDataRefreshStatus('success', 'Refreshed. Event data will reload when you next open it.');
  }
  renderDataRefreshControl();
}

document.addEventListener('DOMContentLoaded', () => {
  const btn = dataRefreshEl('btn-refresh-cached-data');
  if (!btn) return;
  btn.addEventListener('click', runDataRefresh);
  renderDataRefreshControl();
  setInterval(renderDataRefreshControl, 15000);       // the "Available again in N min" line counts down
  document.addEventListener('visibilitychange', renderDataRefreshControl);
});
