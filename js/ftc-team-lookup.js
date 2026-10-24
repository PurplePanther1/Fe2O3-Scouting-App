// ====== FTCScout team lookup (shared component) ======
// "Is there an official FTC team with this number, and what is it called?" —
// used by the unofficial-scrimmage add/link flows (scrimmages.js) and meant to
// be reused as-is by linking OUR scouting-app team to a real FTC team. Nothing
// here knows about scrimmages or Firestore rosters: lookupFtcTeam() returns
// data, openFtcTeamLookup() collects a decision and hands normalized data to
// the CALLER, who decides what to do with it.
//
// Loaded after ftcscout.js (fetchTeamDetail, the teamDetails cache,
// buildTeamDetailObject) and before scrimmages.js.

// ====== Normalized team shape handed to callers ======
function formatFtcTeamLocation(detail) {
  const parts = [detail.city, detail.state, detail.country].filter(Boolean);
  return parts.join(', ');
}

// `detail` is the flat object buildTeamDetailObject() (ftcscout.js) produces —
// also what the teamDetails cache holds.
function normalizeFtcTeam(detail) {
  return {
    number: Number(detail.teamNumber),
    name: String(detail.name || '').trim(),
    location: formatFtcTeamLocation(detail),
    opr: typeof detail.opr === 'number' ? detail.opr : null,
    season: detail.season != null ? String(detail.season) : null,
    raw: detail
  };
}

// ====== lookupFtcTeam(number, season) ->
//   { found: true, team }   an official team with that number
//   { found: false }        FTCScout answered teamByNumber: null — an unknown
//                           number is an ANSWER, not an error
//   { error: 'message' }    couldn't ask (network failure, API error)
// Reads the shared teamDetails cache first (only a doc fetched for THIS season,
// see getCachedTeamDetail()) and writes it after a fresh fetch. ======
async function lookupFtcTeam(number, season) {
  const n = Number(number);
  if (!Number.isInteger(n) || n < 1) return { error: 'Enter a valid team number.' };
  const seasonStr = String(season != null ? season : getSelectedSeason());

  const cached = await getCachedTeamDetail(n, seasonStr);
  if (cached) return { found: true, team: normalizeFtcTeam({ ...cached, teamNumber: n, season: seasonStr }) };

  let detail;
  try {
    detail = await fetchTeamDetail(n, seasonStr);
  } catch (err) {
    return { error: (err && err.message) || 'Could not reach FTCScout.' };
  }
  if (!detail) return { found: false };

  const detailObj = buildTeamDetailObject(n, detail, seasonStr);
  await cacheTeamDetail(n, detailObj);
  return { found: true, team: normalizeFtcTeam(detailObj) };
}

// ====== The lookup modal (#ftc-lookup-modal) ======
// One modal, reset on every open AND every close.
//
// SEARCH (an editable number box): the typed digits are searched in the LOCAL cached copy of
// FTCScout's whole team list (ftc-team-list.js) — exact number first, then numbers that START
// WITH the digits, then numbers that merely CONTAIN them, lower numbers first, at most 5.
//   0 results     "No FTCScout team matches <typed>."
//   1 result      looked up exactly (teamByNumber, cached) and shown as ONE card, auto-selected
//   2+ results    a list of rows (#number, name, location, OPR for the scrimmage's season);
//                 tapping a row selects it and puts ITS number in the box (and, through
//                 onNumberInput, into the Add/Edit modal behind) — the confirm button acts on
//                 the selected row. Teams already on the roster (opts.validateNumber returns a
//                 message for them) are greyed "already on this scrimmage" and can't be picked.
//   no list       (never fetched and offline) a note, and the exact-number lookup below.
// A LOCKED number box (Edit when renumbering isn't allowed, Team Details) skips the list: it
// looks up exactly that team, auto-selected.
//
// WHEN IT SEARCHES: by itself when the popup OPENS with a number in the box, 500 ms after the
// LAST keystroke (typing again restarts the wait, so a search never fires while the user is
// still typing), and IMMEDIATELY on the Look up button (which cancels any pending wait). A
// response that arrives after the modal closed, was reopened, or the number changed is ignored
// (ftcLookupSeq / session id). The list loads lazily the first time a search needs it
// ("Loading team list...").
const FTC_LOOKUP_DEBOUNCE_MS = 500;
let ftcLookupState = null;   // { session, opts, resolve, found, busy, rows, selected }
let ftcLookupSeq = 0;
let ftcLookupSession = 0;
let ftcLookupTimer = null;   // the pending debounced search, if any

function clearFtcLookupTimer() {
  if (ftcLookupTimer !== null) { clearTimeout(ftcLookupTimer); ftcLookupTimer = null; }
}

function ftcLookupEl(id) {
  return document.getElementById(id);
}

function resetFtcLookupFields() {
  const number = ftcLookupEl('input-ftc-lookup-number');
  if (number) { number.value = ''; number.disabled = false; }
  const set = (id, text) => { const el = ftcLookupEl(id); if (el) el.textContent = text; };
  set('ftc-lookup-status', '');
  set('ftc-lookup-error', '');
  set('ftc-lookup-note', '');
  set('ftc-lookup-result-name', '');
  set('ftc-lookup-result-location', '');
  set('ftc-lookup-result-opr', '');
  const note = ftcLookupEl('ftc-lookup-note');
  if (note) note.classList.add('hidden');
  const results = ftcLookupEl('ftc-lookup-results');
  if (results) { results.textContent = ''; results.classList.add('hidden'); }
  const result = ftcLookupEl('ftc-lookup-result');
  if (result) result.classList.add('hidden');
  const go = ftcLookupEl('btn-ftc-lookup-go');
  if (go) go.disabled = false;
  const confirm = ftcLookupEl('btn-ftc-lookup-confirm');
  if (confirm) { confirm.disabled = false; confirm.classList.add('hidden'); }
}

// opts:
//   title, season, initialNumber, numberLocked, confirmLabel
//   numberLocked      true = the number is fixed (Edit / Team Details): exact lookup, no list;
//                     false = the box is editable (Add; Edit when renumbering is allowed)
//   onNumberInput(v)  optional; called with the box value on every edit AND when a result row
//                     is picked, so a caller can keep its own number box in sync
//   validateNumber(n) optional; return a message for a number that must not be picked (already
//                     on the roster): that result is greyed and can't be selected
//   onConfirm(result) result = { mode: 'linked', number, name, location, opr, raw } — the
//                     OFFICIAL name/location/OPR. May be async; return { error } to keep the
//                     modal open and show it.
//   onCancel()
// There is deliberately no manual / offline-add path: an unreachable FTCScout is just an error
// (the caller's own plain Add is the manual route).
// Returns a promise that resolves once the modal has fully CLOSED: with the result that was
// confirmed, or null if it was cancelled.
function openFtcTeamLookup(opts) {
  return new Promise((resolve) => {
    if (ftcLookupState) closeFtcLookup(null);
    clearFtcLookupTimer();
    ftcLookupSession += 1;
    ftcLookupSeq += 1;
    ftcLookupState = { session: ftcLookupSession, opts: opts || {}, resolve, found: null, busy: false, rows: [], selected: null };

    resetFtcLookupFields();
    const o = ftcLookupState.opts;
    ftcLookupEl('ftc-lookup-title').textContent = o.title || 'Look Up Team';
    const number = ftcLookupEl('input-ftc-lookup-number');
    number.value = o.initialNumber != null ? String(o.initialNumber) : '';
    number.disabled = !!o.numberLocked;
    ftcLookupEl('btn-ftc-lookup-confirm').textContent = o.confirmLabel || 'Use This Team';

    ftcLookupEl('ftc-lookup-modal').classList.remove('hidden');
    (o.numberLocked ? ftcLookupEl('btn-ftc-lookup-go') : number).focus();
    // A number already in the box is looked up at once; a blank box waits for typing.
    if (String(number.value).trim() !== '') runFtcLookup();
  });
}

// Resolves the promise AFTER the modal is hidden and reset.
function closeFtcLookup(result) {
  const state = ftcLookupState;
  ftcLookupState = null;
  clearFtcLookupTimer();
  ftcLookupSeq += 1; // any in-flight lookup is now stale
  const modal = ftcLookupEl('ftc-lookup-modal');
  if (modal) modal.classList.add('hidden');
  resetFtcLookupFields();
  if (!state) return;
  if (result == null && typeof state.opts.onCancel === 'function') {
    try { state.opts.onCancel(); } catch (err) { console.error('FTC lookup onCancel failed:', err); }
  }
  state.resolve(result == null ? null : result);
}

function ftcLookupNumberValue() {
  const raw = String(ftcLookupEl('input-ftc-lookup-number').value || '').trim();
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 && n <= 99999 ? n : null;
}

function showFtcLookupIdle() {
  ftcLookupSeq += 1;
  if (ftcLookupState) { ftcLookupState.found = null; ftcLookupState.rows = []; ftcLookupState.selected = null; }
  resetFtcLookupFieldsKeepNumber();
}

function resetFtcLookupFieldsKeepNumber() {
  const numberInput = ftcLookupEl('input-ftc-lookup-number');
  const value = numberInput.value;
  const disabled = numberInput.disabled;
  resetFtcLookupFields();
  numberInput.value = value;
  numberInput.disabled = disabled;
}

function showFtcLookupCard(team) {
  ftcLookupEl('ftc-lookup-result-name').textContent = team.name;
  ftcLookupEl('ftc-lookup-result-location').textContent = team.location || 'Location unknown';
  const seasonLabel = team.season ? ` (${team.season}-${Number(team.season) + 1})` : '';
  ftcLookupEl('ftc-lookup-result-opr').textContent = team.opr != null ? `OPR${seasonLabel}: ${team.opr.toFixed(1)}` : `OPR${seasonLabel}: N/A`;
  ftcLookupEl('ftc-lookup-result').classList.remove('hidden');
  ftcLookupEl('btn-ftc-lookup-confirm').classList.remove('hidden');
}

// ====== One team, looked up exactly (teamByNumber via lookupFtcTeam, cache first) -> the single card ======
// Used for a locked number, for a search with exactly one result, and as the fallback when the
// team list is unavailable. Resolves nothing; paints the popup (unless stale).
async function runFtcExactLookup(n, stale, { validate = false } = {}) {
  const state = ftcLookupState;
  const o = state.opts;
  const errEl = ftcLookupEl('ftc-lookup-error');
  const statusEl = ftcLookupEl('ftc-lookup-status');
  if (validate && typeof o.validateNumber === 'function') {
    const problem = o.validateNumber(n);
    if (problem) { errEl.textContent = problem; ftcLookupEl('btn-ftc-lookup-go').disabled = false; return; }
  }
  statusEl.textContent = `Looking up team #${n} on FTCScout...`;
  ftcLookupEl('btn-ftc-lookup-go').disabled = true;

  const res = await lookupFtcTeam(n, o.season);
  if (stale()) return;
  ftcLookupEl('btn-ftc-lookup-go').disabled = false;
  statusEl.textContent = '';

  if (res.error) {
    errEl.textContent = "Couldn't reach FTCScout. Check your connection and try again.";
    return;
  }
  if (!res.found) {
    statusEl.textContent = `No FTCScout team has the number ${n}.`;
    return;
  }
  state.found = res.team;
  state.selected = res.team.number;
  showFtcLookupCard(res.team);
}

// ====== The results list (2+ results, or a roster team among them) ======
function ftcLookupRowOprText(row) {
  if (row.detail) return row.detail.opr != null ? `OPR: ${row.detail.opr.toFixed(1)}` : 'OPR: --';
  return '';
}

function paintFtcLookupRows() {
  const state = ftcLookupState;
  const box = ftcLookupEl('ftc-lookup-results');
  if (!state || !box) return;
  box.textContent = '';
  state.rows.forEach((row) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ftc-result-row';
    btn.dataset.number = String(row.number);
    btn.setAttribute('role', 'option');
    const selected = !row.onRoster && state.selected === row.number;
    btn.setAttribute('aria-selected', selected ? 'true' : 'false');
    if (selected) btn.classList.add('is-selected');
    if (row.onRoster) { btn.classList.add('is-roster'); btn.disabled = true; btn.setAttribute('aria-disabled', 'true'); }
    const top = document.createElement('span');
    top.className = 'ftc-result-top';
    const num = document.createElement('span');
    num.className = 'ftc-result-number';
    num.textContent = `#${row.number}`;
    const name = document.createElement('span');
    name.className = 'ftc-result-name';
    name.textContent = row.name || '(no name)';
    top.appendChild(num);
    top.appendChild(name);
    btn.appendChild(top);
    const loc = document.createElement('span');
    loc.className = 'ftc-result-loc';
    loc.textContent = row.location || 'Location unknown';
    btn.appendChild(loc);
    const extra = document.createElement('span');
    extra.className = 'ftc-result-extra';
    extra.textContent = row.onRoster ? 'already on this scrimmage' : ftcLookupRowOprText(row);
    btn.appendChild(extra);
    btn.addEventListener('click', () => selectFtcLookupRow(row.number));
    box.appendChild(btn);
  });
  box.classList.remove('hidden');
}

// Tap a row: highlight it, put ITS number in the box and (onNumberInput) in the modal behind,
// and let the confirm button act on it. A roster row can't be selected.
function selectFtcLookupRow(number) {
  const state = ftcLookupState;
  if (!state || state.busy) return;
  const row = state.rows.find(r => r.number === number);
  if (!row || row.onRoster) return;
  state.selected = number;
  state.found = row.detail || { number: row.number, name: row.name, location: row.location, opr: null, season: null, raw: null, partial: true };
  const input = ftcLookupEl('input-ftc-lookup-number');
  input.value = String(number);   // (no input event: picking must not start a new search)
  if (typeof state.opts.onNumberInput === 'function') state.opts.onNumberInput(String(number));
  ftcLookupEl('ftc-lookup-error').textContent = '';
  paintFtcLookupRows();
  ftcLookupEl('btn-ftc-lookup-confirm').classList.remove('hidden');
}

// ONE batched request (fetchTeamDetailsBatch) for the shown rows' details for the scrimmage's
// season, teamDetails cache first. A failure just leaves OPR blank — it never blocks picking.
async function loadFtcLookupRowDetails(rows, stale) {
  const o = ftcLookupState.opts;
  const seasonStr = String(o.season != null ? o.season : getSelectedSeason());
  const wanted = rows.filter(r => !r.onRoster);
  const cached = await Promise.all(wanted.map(r => getCachedTeamDetail(r.number, seasonStr)));
  if (stale()) return;
  const missing = [];
  wanted.forEach((r, i) => {
    if (cached[i]) r.detail = normalizeFtcTeam({ ...cached[i], teamNumber: r.number, season: seasonStr });
    else missing.push(r.number);
  });
  paintFtcLookupRows();
  if (missing.length === 0) return;
  let fetched;
  try {
    fetched = await fetchTeamDetailsBatch(missing, seasonStr);
  } catch (err) {
    console.warn('Could not load OPRs for the lookup results:', err);
    return;
  }
  if (stale()) return;
  for (const r of wanted) {
    if (r.detail || !fetched[r.number]) continue;
    const obj = buildTeamDetailObject(r.number, fetched[r.number], seasonStr);
    r.detail = normalizeFtcTeam(obj);
    cacheTeamDetail(r.number, obj);   // fire and forget
  }
  const state = ftcLookupState;
  if (state.selected != null) {
    const sel = state.rows.find(r => r.number === state.selected);
    if (sel && sel.detail) state.found = sel.detail;
  }
  paintFtcLookupRows();
}

async function runFtcLookup() {
  clearFtcLookupTimer();
  const state = ftcLookupState;
  if (!state || state.busy) return;
  const o = state.opts;
  const errEl = ftcLookupEl('ftc-lookup-error');
  const statusEl = ftcLookupEl('ftc-lookup-status');

  const n = ftcLookupNumberValue();
  if (n === null) {
    errEl.textContent = 'Enter a team number from 1 to 99999.';
    return;
  }

  resetFtcLookupFieldsKeepNumber();
  state.found = null; state.rows = []; state.selected = null;
  const mySeq = ++ftcLookupSeq;
  const mySession = state.session;
  const stale = () => !ftcLookupState || ftcLookupState.session !== mySession || mySeq !== ftcLookupSeq;

  // A locked number is exactly one team: no list, no search.
  if (o.numberLocked) {
    await runFtcExactLookup(n, stale);
    return;
  }

  ftcLookupEl('btn-ftc-lookup-go').disabled = true;
  if (!ftcTeamListReadyNow()) statusEl.textContent = 'Loading team list...';
  const list = await getFtcTeamList();
  if (stale()) return;
  statusEl.textContent = '';

  if (!list) {
    // Never fetched and can't be now: the exact lookup still works, with a note.
    const note = ftcLookupEl('ftc-lookup-note');
    note.textContent = "The team list couldn't be loaded, so only an exact team number can be looked up.";
    note.classList.remove('hidden');
    await runFtcExactLookup(n, stale, { validate: true });
    return;
  }

  const rows = searchFtcTeamList(list.teams, String(n)).map(r => ({
    ...r,
    onRoster: typeof o.validateNumber === 'function' ? !!o.validateNumber(r.number) : false,
    detail: null
  }));
  state.rows = rows;
  ftcLookupEl('btn-ftc-lookup-go').disabled = false;

  if (rows.length === 0) {
    statusEl.textContent = `No FTCScout team matches ${n}.`;
    return;
  }
  if (rows.length === 1 && !rows[0].onRoster) {
    // Exactly one match: the same single card (with its OPR) as an exact lookup, auto-selected.
    await runFtcExactLookup(rows[0].number, stale);
    return;
  }
  paintFtcLookupRows();
  loadFtcLookupRowDetails(rows, stale);
}

async function confirmFtcLookup() {
  const state = ftcLookupState;
  if (!state || state.busy) return;
  const o = state.opts;
  const errEl = ftcLookupEl('ftc-lookup-error');

  const n = ftcLookupNumberValue();
  if (n === null) {
    errEl.textContent = 'Enter a team number from 1 to 99999.';
    return;
  }
  let team = state.found;
  if (!team || team.number !== n) return;

  errEl.textContent = '';
  state.busy = true;
  const buttons = ['btn-ftc-lookup-go', 'btn-ftc-lookup-confirm'].map(ftcLookupEl);
  buttons.forEach(b => { if (b) b.disabled = true; });
  try {
    // A row picked before its OPR arrived (or whose OPR request failed): fetch the full detail
    // now, so a link never stores a missing OPR the team really has.
    if (team.partial) {
      const res = await lookupFtcTeam(team.number, o.season);
      if (ftcLookupState !== state) return;
      if (res.error) { errEl.textContent = "Couldn't reach FTCScout. Check your connection and try again."; return; }
      if (!res.found) { errEl.textContent = `No FTCScout team has the number ${n}.`; return; }
      team = res.team;
    }
    const result = { mode: 'linked', number: n, name: team.name, location: team.location, opr: team.opr, raw: team.raw };
    const out = typeof o.onConfirm === 'function' ? await o.onConfirm(result) : undefined;
    if (out && out.error) {
      errEl.textContent = out.error;
      return;
    }
    if (ftcLookupState === state) closeFtcLookup(result);
  } catch (err) {
    console.error('FTC lookup onConfirm failed:', err);
    errEl.textContent = 'Something went wrong. Please try again.';
  } finally {
    state.busy = false;
    // Only meaningful when the modal stayed open (an error); a closed modal was reset.
    if (ftcLookupState === state) buttons.forEach(b => { if (b) b.disabled = false; });
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const on = (id, evt, fn) => { const el = ftcLookupEl(id); if (el) el.addEventListener(evt, fn); };
  on('btn-ftc-lookup-go', 'click', runFtcLookup);
  on('btn-ftc-lookup-confirm', 'click', () => confirmFtcLookup());
  on('btn-ftc-lookup-cancel', 'click', () => closeFtcLookup(null));
  on('btn-ftc-lookup-close', 'click', () => closeFtcLookup(null));
  on('ftc-lookup-modal-overlay', 'click', () => closeFtcLookup(null));
  // Editing the number clears whatever result was showing and (re)starts the 500 ms wait
  // before searching; an empty box searches for nothing.
  on('input-ftc-lookup-number', 'input', () => {
    clearFtcLookupTimer();
    showFtcLookupIdle();
    const state = ftcLookupState;
    if (!state) return;
    const value = ftcLookupEl('input-ftc-lookup-number').value;
    if (typeof state.opts.onNumberInput === 'function') state.opts.onNumberInput(value);
    if (String(value).trim() === '') return;
    const session = state.session;
    ftcLookupTimer = setTimeout(() => {
      ftcLookupTimer = null;
      if (ftcLookupState && ftcLookupState.session === session) runFtcLookup();
    }, FTC_LOOKUP_DEBOUNCE_MS);
  });
  on('input-ftc-lookup-number', 'keydown', (e) => { if (e.key === 'Enter') runFtcLookup(); });
});
