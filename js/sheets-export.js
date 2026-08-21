// ====== Google Sheets Export ======
// Client-side-only export: each user authorizes with their own Google account via
// Google Identity Services (GIS), then this app talks directly to the Sheets API
// with the resulting OAuth access token. No backend / service account / Cloud
// Functions involved, so this works fine on Firebase's free Spark plan.
//
// Setup required before this works — see the setup notes shared alongside this
// file. In short: a Google Cloud project with the Sheets API enabled and an
// OAuth "Web application" client ID, pasted into GOOGLE_SHEETS_CLIENT_ID below.

const GOOGLE_SHEETS_CLIENT_ID = '488364207504-bic9j0nh76a4kv429oalj0ilej8bmfrc.apps.googleusercontent.com';
const GOOGLE_SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const SHEETS_API_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

let gisTokenClient = null;
let googleAccessToken = null;
let googleAccessTokenExpiresAt = 0;

// ====== Separate scope/token client, used ONLY by the "Export Whole Team
// Data" flow (js/sheets-export.js's handleExportWholeTeamSheetsClick, wired
// from the leave/delete-as-last-member flows). It needs Drive API access
// (folder creation + moving created spreadsheets into them) that the rest of
// this file's exports don't — kept entirely separate from gisTokenClient
// above so every other export button's existing consent grant/scope is
// unaffected by this addition. ======
const GOOGLE_DRIVE_EXPORT_SCOPE = 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.file';
const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3/files';

let gisWholeTeamTokenClient = null;
let googleWholeTeamAccessToken = null;
let googleWholeTeamAccessTokenExpiresAt = 0;

// ====== Wait for the GIS script (loaded async in index.html) to be ready ======
function ensureGisLoaded() {
  return new Promise((resolve, reject) => {
    if (window.google && google.accounts && google.accounts.oauth2) {
      resolve();
      return;
    }
    let attempts = 0;
    const interval = setInterval(() => {
      attempts++;
      if (window.google && google.accounts && google.accounts.oauth2) {
        clearInterval(interval);
        resolve();
      } else if (attempts > 100) { // ~10s
        clearInterval(interval);
        reject(new Error('Google sign-in could not load. Check your internet connection and try again.'));
      }
    }, 100);
  });
}

// ====== Get a valid Google OAuth access token, prompting the user if needed ======
function getGoogleAccessToken() {
  return new Promise((resolve, reject) => {
    if (!GOOGLE_SHEETS_CLIENT_ID || GOOGLE_SHEETS_CLIENT_ID.includes('YOUR_CLIENT_ID')) {
      reject(new Error('Google Sheets export is not configured yet. Set GOOGLE_SHEETS_CLIENT_ID in js/sheets-export.js.'));
      return;
    }

    // Reuse the existing token if it's still valid (60s safety buffer)
    if (googleAccessToken && Date.now() < googleAccessTokenExpiresAt - 60000) {
      resolve(googleAccessToken);
      return;
    }

    ensureGisLoaded().then(() => {
      if (!gisTokenClient) {
        gisTokenClient = google.accounts.oauth2.initTokenClient({
          client_id: GOOGLE_SHEETS_CLIENT_ID,
          scope: GOOGLE_SHEETS_SCOPE,
          callback: () => {} // replaced per-request below
        });
      }

      gisTokenClient.callback = (response) => {
        if (response.error) {
          reject(new Error(`Google authorization failed: ${response.error}`));
          return;
        }
        googleAccessToken = response.access_token;
        googleAccessTokenExpiresAt = Date.now() + (Number(response.expires_in) || 3600) * 1000;
        resolve(googleAccessToken);
      };
      gisTokenClient.error_callback = (err) => {
        reject(new Error(err?.message || 'Google authorization was cancelled.'));
      };

      // prompt:'' — GIS shows the consent screen only the first time;
      // afterwards it silently reuses the granted session where possible.
      gisTokenClient.requestAccessToken({ prompt: '' });
    }).catch(reject);
  });
}

// ====== Get a valid Google OAuth access token for the whole-team export
// (spreadsheets + drive.file scope) — same shape as getGoogleAccessToken()
// above, but its own token client/cache so it prompts for its own (broader)
// consent independently of the shared one. ======
function getGoogleWholeTeamAccessToken() {
  return new Promise((resolve, reject) => {
    if (!GOOGLE_SHEETS_CLIENT_ID || GOOGLE_SHEETS_CLIENT_ID.includes('YOUR_CLIENT_ID')) {
      reject(new Error('Google Sheets export is not configured yet. Set GOOGLE_SHEETS_CLIENT_ID in js/sheets-export.js.'));
      return;
    }

    if (googleWholeTeamAccessToken && Date.now() < googleWholeTeamAccessTokenExpiresAt - 60000) {
      resolve(googleWholeTeamAccessToken);
      return;
    }

    ensureGisLoaded().then(() => {
      if (!gisWholeTeamTokenClient) {
        gisWholeTeamTokenClient = google.accounts.oauth2.initTokenClient({
          client_id: GOOGLE_SHEETS_CLIENT_ID,
          scope: GOOGLE_DRIVE_EXPORT_SCOPE,
          callback: () => {} // replaced per-request below
        });
      }

      gisWholeTeamTokenClient.callback = (response) => {
        if (response.error) {
          reject(new Error(`Google authorization failed: ${response.error}`));
          return;
        }
        googleWholeTeamAccessToken = response.access_token;
        googleWholeTeamAccessTokenExpiresAt = Date.now() + (Number(response.expires_in) || 3600) * 1000;
        resolve(googleWholeTeamAccessToken);
      };
      gisWholeTeamTokenClient.error_callback = (err) => {
        reject(new Error(err?.message || 'Google authorization was cancelled.'));
      };

      gisWholeTeamTokenClient.requestAccessToken({ prompt: '' });
    }).catch(reject);
  });
}

// ====== Sheets API helpers ======
// tokenGetter defaults to the shared spreadsheets-only token (getGoogleAccessToken)
// used by every existing export button. The whole-team export (below) passes
// getGoogleWholeTeamAccessToken instead, so its spreadsheets are created under
// a token that also carries drive.file — required for the Drive move step to
// see them — without touching any other caller's scope/consent.
async function sheetsApiFetch(url, options = {}, tokenGetter = getGoogleAccessToken) {
  const token = await tokenGetter();
  const resp = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  if (!resp.ok) {
    const errBody = await resp.json().catch(() => ({}));
    throw new Error(errBody?.error?.message || `Google Sheets API error (${resp.status})`);
  }
  return resp.json();
}

function createSpreadsheet(title, sheetTitles, tokenGetter) {
  const body = {
    properties: { title },
    sheets: sheetTitles.map((sheetTitle, i) => ({ properties: { sheetId: i, title: sheetTitle } }))
  };
  return sheetsApiFetch(SHEETS_API_BASE, { method: 'POST', body: JSON.stringify(body) }, tokenGetter);
}

function writeSheetValues(spreadsheetId, sheetTitle, rows, tokenGetter) {
  const range = `'${sheetTitle}'!A1`;
  const url = `${SHEETS_API_BASE}/${spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`;
  return sheetsApiFetch(url, {
    method: 'PUT',
    body: JSON.stringify({ range, majorDimension: 'ROWS', values: rows })
  }, tokenGetter);
}

// ====== Drive API helpers — folder creation + moving a spreadsheet into a
// folder. Only used by the whole-team export (always with
// getGoogleWholeTeamAccessToken); nothing else in this file touches Drive. ======
async function driveApiFetch(url, options = {}) {
  const token = await getGoogleWholeTeamAccessToken();
  const resp = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  if (!resp.ok) {
    const errBody = await resp.json().catch(() => ({}));
    throw new Error(errBody?.error?.message || `Google Drive API error (${resp.status})`);
  }
  return resp.json();
}

function createDriveFolder(name, parentId) {
  const body = {
    name,
    mimeType: 'application/vnd.google-apps.folder',
    ...(parentId ? { parents: [parentId] } : {})
  };
  return driveApiFetch(`${DRIVE_API_BASE}?fields=id,webViewLink`, { method: 'POST', body: JSON.stringify(body) });
}

// Sheets API's spreadsheets.create always lands the new file in Drive root —
// there's no parent-folder param on that endpoint — so every created
// spreadsheet needs this extra move step to land in its event folder.
function moveFileToFolder(fileId, folderId) {
  return driveApiFetch(`${DRIVE_API_BASE}/${fileId}?addParents=${folderId}&removeParents=root&fields=id,parents`, { method: 'PATCH', body: JSON.stringify({}) });
}

// ====== Formatting helpers ======
function formatCellValue(val) {
  if (val === null || val === undefined) return '';
  if (typeof val === 'object' && typeof val.toDate === 'function') return val.toDate().toLocaleString();
  return val;
}

function formatTimestamp(ts) {
  if (!ts) return '';
  if (typeof ts.toDate === 'function') return ts.toDate().toLocaleString();
  if (ts instanceof Date) return ts.toLocaleString();
  return String(ts);
}

// ====== Structural/metadata keys every pitScouting/matchScouting doc can
// carry that are NEVER form fields (Firestore doc id, denormalized team
// name, attribution/timestamp bookkeeping, ...) — excluded when scanning a
// doc for "deleted field" columns below, regardless of whether a given
// export's fixedColumns already happens to cover some of them too. ======
const RESERVED_DOC_KEYS = new Set([
  'id', 'eventCode', 'teamNumber', 'teamId', 'matchNumber', 'teamName',
  'scoutedBy', 'scoutedByEmail', 'scoutedByName', 'scoutedAt', 'updatedAt',
  'lastEditedBy', 'lastEditedByEmail', 'lastEditedByName', 'lastEditedByTimestamp'
]);

// ====== Turn formConfig fields + Firestore docs into a 2D array of sheet rows ======
// fixedColumns: [{ header, key }] columns that always exist regardless of formConfig
// (e.g. Team Number, Match Number) — any formConfig field sharing one of their keys
// is skipped so the column isn't duplicated.
//
// Also includes a column for any field that's no longer on the current form
// config but still has data on at least one doc in THIS export's scope — a
// field deleted from the form shouldn't silently drop its historical data
// from every export forever after. Skipped entirely (not just left empty)
// when nothing being exported this time has it, so it doesn't accumulate as
// a permanent empty column across unrelated exports.
function buildSheetRows(fields, docs, fixedColumns) {
  const fixedKeys = fixedColumns.map(c => c.key);
  const currentFieldColumns = fields
    .filter(f => !fixedKeys.includes(f.id))
    .map(f => ({ header: f.label, key: f.id }));

  const currentFieldKeys = new Set(fields.map(f => f.id));
  const deletedFieldKeys = new Set();
  docs.forEach(doc => {
    Object.keys(doc).forEach(key => {
      if (fixedKeys.includes(key)) return;
      if (currentFieldKeys.has(key)) return;
      if (RESERVED_DOC_KEYS.has(key)) return;
      deletedFieldKeys.add(key);
    });
  });
  // Sorted for a stable, deterministic column order — otherwise it'd vary
  // export to export based on incidental key-iteration order.
  const deletedFieldColumns = Array.from(deletedFieldKeys).sort().map(key => ({
    header: `${key} (deleted field)`,
    key
  }));

  const dynamicColumns = [...currentFieldColumns, ...deletedFieldColumns];
  const dynamicKeys = new Set(dynamicColumns.map(c => c.key));

  const columns = [
    ...fixedColumns,
    ...dynamicColumns,
    { header: 'Scouted By', key: '__scoutedBy' },
    { header: 'Scouted At', key: '__scoutedAt' }
  ];

  const rows = [columns.map(c => c.header)];
  docs.forEach(doc => {
    rows.push(columns.map(c => {
      if (c.key === '__scoutedBy') return doc.scoutedByEmail || doc.scoutedByName || '';
      if (c.key === '__scoutedAt') return formatTimestamp(doc.scoutedAt);
      if (dynamicKeys.has(c.key)) {
        // Distinguish "this field existed on the form when the entry was
        // made and was left blank" (key present, even as '') from "this
        // field didn't exist yet on this entry" (key entirely absent — a
        // field added to the form after this entry was scouted, or a
        // deleted field being included via the rule above): the latter
        // renders as N/A rather than an indistinguishable blank cell.
        if (!(c.key in doc)) return 'N/A';
        return formatCellValue(doc[c.key]);
      }
      return formatCellValue(doc[c.key]);
    }));
  });
  return rows;
}

function buildPitSheetRows(fields, docs) {
  return buildSheetRows(fields, docs, [
    { header: 'Team Name', key: 'teamName' },
    { header: 'Team Number', key: 'teamNumber' }
  ]);
}

function buildMatchSheetRows(fields, docs) {
  return buildSheetRows(fields, docs, [
    { header: 'Team Name', key: 'teamName' },
    { header: 'Team Number', key: 'teamNumber' },
    { header: 'Match Number', key: 'matchNumber' }
  ]);
}

// ====== Build a {teamNumber: name} map for one event, from the same
// Firestore-cached roster (events/{eventCode}) getCachedEvent() (first-api.js)
// already reads for event selection — not scoped to the currently selected
// event, so it works for any event, including ones from a team's export
// history that aren't the active one. Returns {} (not an error) if the event
// isn't cached, so a missing/old event just leaves the Team Name column blank
// for its rows rather than failing the export. ======
async function getEventTeamNameMap(eventCode) {
  const map = {};
  try {
    if (typeof getCachedEvent !== 'function') return map;
    const cached = await getCachedEvent(eventCode);
    const ftcTeams = cached?.ftcTeams || [];
    ftcTeams.forEach(t => {
      const num = t?.teamNumber;
      if (num === undefined || num === null) return;
      map[Number(num)] = t.name || t.nameShort || t.nameFull || t.schoolName || '';
    });
  } catch (err) {
    console.warn(`Failed to load team names for event ${eventCode}:`, err);
  }
  return map;
}

// ====== Attach .teamName to each doc (in place) using a {teamNumber: name}
// map built by getEventTeamNameMap() — neither pit nor match scouting docs
// store a team name themselves (only teamNumber), so every export path needs
// this before building sheet rows. Returns docs for convenient chaining. ======
function attachTeamNames(docs, nameMap) {
  docs.forEach(doc => {
    doc.teamName = nameMap[Number(doc.teamNumber)] || '';
  });
  return docs;
}

// ====== Read-only form config loaders ======
// loadFormConfig()/loadMatchFormConfig() (dynamic-form.js) seed a default config
// back into Firestore via .set() when a team has none yet — a create/update that
// firestore.rules restricts to captains / canEditTemplates. Export must work for
// any team member, and never needs to write anything, so it reads the doc itself
// and falls back to the same DEFAULT_*_FIELDS locally instead of seeding.
async function loadFormConfigReadOnly(teamId, configDocId, defaults) {
  try {
    const doc = await db.collection('teams').doc(teamId)
      .collection('formConfig').doc(configDocId).get();
    if (doc.exists) {
      const data = doc.data();
      return (data.fields || []).sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
    }
  } catch (err) {
    console.warn(`Failed to read ${configDocId} form config for export, using defaults:`, err);
  }
  return defaults.map(f => ({ ...f }));
}

// ====== Label errors with which step produced them, so failures are diagnosable ======
async function withStep(stepLabel, fn) {
  try {
    return await fn();
  } catch (err) {
    const labeled = new Error(`${stepLabel}: ${err.message}`);
    labeled.code = err.code;
    throw labeled;
  }
}

// ====== Fetch all matchScouting docs for an event (same query shape as watchMatchScoutStatus) ======
// Reads teams/{teamId}/matchScouting — scoped by path now, not a teamId
// where() clause.
async function fetchMatchDocsForEvent(eventCode, teamId) {
  const snap = await db.collection('teams').doc(teamId).collection('matchScouting')
    .where('eventCode', '==', eventCode)
    .get();
  const docs = [];
  snap.forEach(doc => docs.push({ id: doc.id, ...doc.data() }));
  return docs;
}

// ====== Create a spreadsheet with Pit Scouting + Match Scouting tabs and fill it ======
// Returns { spreadsheetId, spreadsheetUrl } — callers that only need the URL
// (the original single-event/whole-event export buttons) destructure just
// that; the whole-team export also needs spreadsheetId to move the file into
// its event folder afterward. tokenGetter defaults to the shared token (see
// sheetsApiFetch above); the whole-team export passes its own broader one.
async function exportToNewSpreadsheet(title, pitFields, pitDocs, matchFields, matchDocs, tokenGetter) {
  const createResp = await createSpreadsheet(title, ['Pit Scouting', 'Match Scouting'], tokenGetter);
  const spreadsheetId = createResp.spreadsheetId;

  const pitRows = buildPitSheetRows(pitFields, pitDocs);
  const matchRows = buildMatchSheetRows(matchFields, matchDocs);

  await writeSheetValues(spreadsheetId, 'Pit Scouting', pitRows, tokenGetter);
  await writeSheetValues(spreadsheetId, 'Match Scouting', matchRows, tokenGetter);

  return { spreadsheetId, spreadsheetUrl: createResp.spreadsheetUrl };
}

// ====== Build & download an .xlsx workbook from the same row data used for the
// Google Sheets export (buildPitSheetRows/buildMatchSheetRows) — same two-tab shape,
// just rendered client-side via SheetJS instead of written through the Sheets API. ======
function downloadScoutingWorkbook(filename, pitFields, pitDocs, matchFields, matchDocs) {
  if (typeof XLSX === 'undefined') {
    throw new Error('Excel export library failed to load. Check your connection and try again.');
  }

  const pitRows = buildPitSheetRows(pitFields, pitDocs);
  const matchRows = buildMatchSheetRows(matchFields, matchDocs);

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(pitRows), 'Pit Scouting');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(matchRows), 'Match Scouting');
  XLSX.writeFile(wb, filename);
}

// ====== Build a 2-tab workbook as raw bytes (not a file download) — used by
// the whole-team export to bundle one small workbook per event into a single
// ZIP, rather than triggering a separate browser download for each. ======
function buildWorkbookBytes(pitFields, pitDocs, matchFields, matchDocs) {
  if (typeof XLSX === 'undefined') {
    throw new Error('Excel export library failed to load. Check your connection and try again.');
  }

  const pitRows = buildPitSheetRows(pitFields, pitDocs);
  const matchRows = buildMatchSheetRows(matchFields, matchDocs);

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(pitRows), 'Pit Scouting');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(matchRows), 'Match Scouting');
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
}

// ====== Create a spreadsheet with just a Match Scouting tab — the "View
// Matches Scouted" modal's export button, which has no pit-scouting section
// to include. ======
async function exportMatchOnlyToNewSpreadsheet(title, matchFields, matchDocs) {
  const createResp = await createSpreadsheet(title, ['Match Scouting']);
  const spreadsheetId = createResp.spreadsheetId;

  const matchRows = buildMatchSheetRows(matchFields, matchDocs);
  await writeSheetValues(spreadsheetId, 'Match Scouting', matchRows);

  return createResp.spreadsheetUrl;
}

// ====== Build & download a single-tab .xlsx workbook — match-only counterpart
// to downloadScoutingWorkbook() above. ======
function downloadMatchOnlyWorkbook(filename, matchFields, matchDocs) {
  if (typeof XLSX === 'undefined') {
    throw new Error('Excel export library failed to load. Check your connection and try again.');
  }

  const matchRows = buildMatchSheetRows(matchFields, matchDocs);

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(matchRows), 'Match Scouting');
  XLSX.writeFile(wb, filename);
}

// ====== Create a spreadsheet with just a Pit Scouting tab — pit-only
// counterpart to exportMatchOnlyToNewSpreadsheet() above, used by the Pit
// Scouting tab's "Export All Pit Data" button and per-row export button. ======
async function exportPitOnlyToNewSpreadsheet(title, pitFields, pitDocs) {
  const createResp = await createSpreadsheet(title, ['Pit Scouting']);
  const spreadsheetId = createResp.spreadsheetId;

  const pitRows = buildPitSheetRows(pitFields, pitDocs);
  await writeSheetValues(spreadsheetId, 'Pit Scouting', pitRows);

  return createResp.spreadsheetUrl;
}

// ====== Build & download a single-tab .xlsx workbook — pit-only counterpart
// to downloadMatchOnlyWorkbook() above. ======
function downloadPitOnlyWorkbook(filename, pitFields, pitDocs) {
  if (typeof XLSX === 'undefined') {
    throw new Error('Excel export library failed to load. Check your connection and try again.');
  }

  const pitRows = buildPitSheetRows(pitFields, pitDocs);

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(pitRows), 'Pit Scouting');
  XLSX.writeFile(wb, filename);
}

// ====== Filesystem-safe filename (team/event names can contain characters like / or :) ======
function sanitizeFilename(name) {
  return String(name).replace(/[\\/:*?"<>|]/g, '-');
}

// ====== "Team {number} - {name}" (or just "Team {number}" if no name
// resolved, e.g. an uncached event) — shared by every single-team export's
// filename AND its matching Sheets title, so both consistently show the name
// alongside the bare number rather than just the number. ======
function teamLabel(teamNumber, teamName) {
  return teamName ? `Team ${teamNumber} - ${teamName}` : `Team ${teamNumber}`;
}

// ====== Gather a single team's pit + match scouting data for the selected event ======
// Shared by both the Google Sheets and Excel export paths for a team.
async function gatherTeamExportData(teamNumber, eventCode, teamId) {
  const [pitFields, matchFields] = await Promise.all([
    loadFormConfigReadOnly(teamId, 'pitScouting', DEFAULT_PIT_FIELDS),
    loadFormConfigReadOnly(teamId, 'matchScouting', DEFAULT_MATCH_FIELDS)
  ]);

  // findExistingPitDoc() (pit-scout.js) queries by data fields rather than
  // guessing a document ID, so it finds this team's entry regardless of
  // which document-ID era it was saved under.
  const pitEntry = await withStep('Reading pit scouting data', () =>
    findExistingPitDoc(teamId, eventCode, teamNumber));
  const pitDocs = pitEntry ? [pitEntry] : [];

  const allMatchDocs = await withStep('Reading match scouting data', () => fetchMatchDocsForEvent(eventCode, teamId));
  const matchDocs = allMatchDocs
    .filter(d => Number(d.teamNumber) === Number(teamNumber))
    .sort((a, b) => (a.matchNumber || 0) - (b.matchNumber || 0));

  const nameMap = await getEventTeamNameMap(eventCode);
  attachTeamNames(pitDocs, nameMap);
  attachTeamNames(matchDocs, nameMap);

  return { pitFields, matchFields, pitDocs, matchDocs };
}

// ====== Gather a single team's MATCH-ONLY scouting data (no pit) for the
// selected event — used by the "View Matches Scouted" modal's export button. ======
async function gatherTeamMatchExportData(teamNumber, eventCode, teamId) {
  const matchFields = await loadFormConfigReadOnly(teamId, 'matchScouting', DEFAULT_MATCH_FIELDS);

  const allMatchDocs = await withStep('Reading match scouting data', () => fetchMatchDocsForEvent(eventCode, teamId));
  const matchDocs = allMatchDocs
    .filter(d => Number(d.teamNumber) === Number(teamNumber))
    .sort((a, b) => (a.matchNumber || 0) - (b.matchNumber || 0));

  attachTeamNames(matchDocs, await getEventTeamNameMap(eventCode));

  return { matchFields, matchDocs };
}

// ====== Gather a single team's PIT-ONLY scouting data (no match) for the
// selected event — used by the Pit Scouting tab's per-row export button. ======
async function gatherTeamPitOnlyExportData(teamNumber, eventCode, teamId) {
  const pitFields = await loadFormConfigReadOnly(teamId, 'pitScouting', DEFAULT_PIT_FIELDS);

  const pitEntry = await withStep('Reading pit scouting data', () =>
    findExistingPitDoc(teamId, eventCode, teamNumber));
  const pitDocs = pitEntry ? [pitEntry] : [];

  attachTeamNames(pitDocs, await getEventTeamNameMap(eventCode));

  return { pitFields, pitDocs };
}

// ====== Gather every team's pit + match scouting data for the selected event ======
// Shared by both the Google Sheets and Excel export paths for a whole event.
async function gatherEventExportData(eventCode, teamId) {
  const [pitFields, matchFields] = await Promise.all([
    loadFormConfigReadOnly(teamId, 'pitScouting', DEFAULT_PIT_FIELDS),
    loadFormConfigReadOnly(teamId, 'matchScouting', DEFAULT_MATCH_FIELDS)
  ]);

  const pitSnap = await withStep('Reading pit scouting data',
    () => db.collection('teams').doc(teamId).collection('pitScouting').where('eventCode', '==', eventCode).get());
  const pitDocs = [];
  pitSnap.forEach(doc => pitDocs.push({ id: doc.id, ...doc.data() }));
  pitDocs.sort((a, b) => (a.teamNumber || 0) - (b.teamNumber || 0));

  const matchDocs = await withStep('Reading match scouting data', () => fetchMatchDocsForEvent(eventCode, teamId));
  matchDocs.sort((a, b) => (a.teamNumber || 0) - (b.teamNumber || 0) || (a.matchNumber || 0) - (b.matchNumber || 0));

  const nameMap = await getEventTeamNameMap(eventCode);
  attachTeamNames(pitDocs, nameMap);
  attachTeamNames(matchDocs, nameMap);

  return { pitFields, matchFields, pitDocs, matchDocs };
}

// ====== Gather every team's PIT-ONLY scouting data for the selected event —
// used by the Pit Scouting tab's "Export All Pit Data" button. ======
async function gatherEventPitOnlyExportData(eventCode, teamId) {
  const pitFields = await loadFormConfigReadOnly(teamId, 'pitScouting', DEFAULT_PIT_FIELDS);

  const pitSnap = await withStep('Reading pit scouting data',
    () => db.collection('teams').doc(teamId).collection('pitScouting').where('eventCode', '==', eventCode).get());
  const pitDocs = [];
  pitSnap.forEach(doc => pitDocs.push({ id: doc.id, ...doc.data() }));
  pitDocs.sort((a, b) => (a.teamNumber || 0) - (b.teamNumber || 0));

  attachTeamNames(pitDocs, await getEventTeamNameMap(eventCode));

  return { pitFields, pitDocs };
}

// ====== Gather every team's MATCH-ONLY scouting data for the selected event —
// used by the Match Scouting tab's "Export All Match Data" button. ======
async function gatherEventMatchOnlyExportData(eventCode, teamId) {
  const matchFields = await loadFormConfigReadOnly(teamId, 'matchScouting', DEFAULT_MATCH_FIELDS);

  const matchDocs = await withStep('Reading match scouting data', () => fetchMatchDocsForEvent(eventCode, teamId));
  matchDocs.sort((a, b) => (a.teamNumber || 0) - (b.teamNumber || 0) || (a.matchNumber || 0) - (b.matchNumber || 0));

  attachTeamNames(matchDocs, await getEventTeamNameMap(eventCode));

  return { matchFields, matchDocs };
}

// ====== Gather EVERY pit/match scouting doc this team has ever recorded, for
// ANY event — not just the currently selected one. Same unfiltered-by-event
// query deleteAllScoutingEntriesForTeam() (delete-account.js) already uses
// when a team is deleted — an unfiltered read of the teams/{teamId}/pitScouting
// and teams/{teamId}/matchScouting subcollections. Grouped client-side by
// eventCode. Used only by the "Export Whole Team Data" flow, right before a
// team's data is permanently deleted (leaving/deleting as its last member). ======
async function gatherFullTeamExportData(teamId) {
  const [pitFields, matchFields] = await Promise.all([
    loadFormConfigReadOnly(teamId, 'pitScouting', DEFAULT_PIT_FIELDS),
    loadFormConfigReadOnly(teamId, 'matchScouting', DEFAULT_MATCH_FIELDS)
  ]);

  const pitSnap = await withStep('Reading all pit scouting data',
    () => db.collection('teams').doc(teamId).collection('pitScouting').get());
  const matchSnap = await withStep('Reading all match scouting data',
    () => db.collection('teams').doc(teamId).collection('matchScouting').get());

  const byEvent = {}; // eventCode -> { pitDocs: [], matchDocs: [] }
  const getBucket = (eventCode) => {
    if (!byEvent[eventCode]) byEvent[eventCode] = { pitDocs: [], matchDocs: [] };
    return byEvent[eventCode];
  };

  pitSnap.forEach(doc => {
    const data = { id: doc.id, ...doc.data() };
    if (!data.eventCode) return;
    getBucket(data.eventCode).pitDocs.push(data);
  });
  matchSnap.forEach(doc => {
    const data = { id: doc.id, ...doc.data() };
    if (!data.eventCode) return;
    getBucket(data.eventCode).matchDocs.push(data);
  });

  const eventCodes = Object.keys(byEvent).sort();
  // A for..of (not forEach) since each event's team-name lookup is async, and
  // different events can have different rosters — one map per event, not one
  // shared map, unlike the single-event gather functions above.
  for (const eventCode of eventCodes) {
    const bucket = byEvent[eventCode];
    bucket.pitDocs.sort((a, b) => (a.teamNumber || 0) - (b.teamNumber || 0));
    bucket.matchDocs.sort((a, b) => (a.teamNumber || 0) - (b.teamNumber || 0) || (a.matchNumber || 0) - (b.matchNumber || 0));

    const nameMap = await getEventTeamNameMap(eventCode);
    attachTeamNames(bucket.pitDocs, nameMap);
    attachTeamNames(bucket.matchDocs, nameMap);
  }

  return { pitFields, matchFields, eventCodes, byEvent };
}

// ====== Status message helper (mirrors the app's error/success paragraph convention) ======
// General-purpose, not export-specific — lives here because export was its
// first user, but also used for e.g. the My Team tab's Join Another Team
// status (see members.js). Auto-clears after a few seconds — without this, a
// message like a cancelled Google auth popup would sit in the DOM
// indefinitely, including reappearing stale the next time the Team Detail
// modal (which hosts td-export-match-*) is reopened. Expects elements named
// `${prefix}-error` and `${prefix}-success`.
const statusMessageTimers = {};

function setStatusMessage(prefix, type, message) {
  const errEl = document.getElementById(prefix + '-error');
  const okEl = document.getElementById(prefix + '-success');
  if (errEl) errEl.textContent = type === 'error' ? message : '';
  if (okEl) okEl.textContent = type === 'success' ? message : '';

  const timerKey = `${prefix}-${type}`;
  if (statusMessageTimers[timerKey]) {
    clearTimeout(statusMessageTimers[timerKey]);
    delete statusMessageTimers[timerKey];
  }
  if (message) {
    statusMessageTimers[timerKey] = setTimeout(() => {
      const el = document.getElementById(`${prefix}-${type}`);
      if (el) el.textContent = '';
      delete statusMessageTimers[timerKey];
    }, 5000);
  }
}

// ====== Clear a status message immediately (no delay) — used when the
// context it applied to changes (switching tabs/teams), not just on a timer. ======
function clearStatusMessage(prefix) {
  if (statusMessageTimers[`${prefix}-error`]) {
    clearTimeout(statusMessageTimers[`${prefix}-error`]);
    delete statusMessageTimers[`${prefix}-error`];
  }
  if (statusMessageTimers[`${prefix}-success`]) {
    clearTimeout(statusMessageTimers[`${prefix}-success`]);
    delete statusMessageTimers[`${prefix}-success`];
  }
  const errEl = document.getElementById(prefix + '-error');
  const okEl = document.getElementById(prefix + '-success');
  if (errEl) errEl.textContent = '';
  if (okEl) okEl.textContent = '';
}

// ====== Gather data and check for emptiness BEFORE showing the Excel/Sheets
// choice modal at all. Without this, clicking an export button with no data
// still opened the format-choice modal, and picking Sheets went all the way
// through the Google OAuth prompt before finally reporting "no data found" —
// both now short-circuit into an inline message here instead. Every export
// entry point's own handleXClick()/handleXExcelClick() still gathers its own
// data again once actually invoked (kept deliberately unchanged/self-
// contained) — this only decides whether the modal opens at all, at the cost
// of one extra (small, already-permitted) read when there IS data. Returns
// true if the modal should proceed to open, false if it already showed the
// empty-state message (or an error) and the caller should stop. ======
async function precheckExportData(statusPrefix, gatherFn, isEmptyFn, emptyMessage) {
  showLoading('Checking for scouting data...');
  try {
    const result = await gatherFn();
    hideLoading();
    if (isEmptyFn(result)) {
      setStatusMessage(statusPrefix, 'success', emptyMessage);
      return false;
    }
    return true;
  } catch (err) {
    hideLoading();
    console.error('Export precheck failed:', err);
    setStatusMessage(statusPrefix, 'error', err.message || 'Failed to check for scouting data. Please try again.');
    return false;
  }
}

// ====== Export a single team's pit + match scouting data for the selected event ======
async function handleExportTeamClick(statusPrefix) {
  setStatusMessage(statusPrefix, 'error', '');
  setStatusMessage(statusPrefix, 'success', '');

  const teamNumber = currentSelectedTeamNumber;
  const eventCode = selectedEvent?.code;
  const teamId = currentTeamData?.id;

  if (!teamNumber || !eventCode) {
    setStatusMessage(statusPrefix, 'error', 'Select a team and event first.');
    return;
  }
  if (!teamId) {
    setStatusMessage(statusPrefix, 'error', 'Team data not loaded. Please rejoin your team.');
    return;
  }

  showLoading('Waiting for Google authorization...');
  try {
    await getGoogleAccessToken();

    showLoading('Gathering scouting data...');
    const { pitFields, matchFields, pitDocs, matchDocs } = await gatherTeamExportData(teamNumber, eventCode, teamId);

    showLoading('Creating Google Sheet...');
    const teamName = pitDocs[0]?.teamName || matchDocs[0]?.teamName || '';
    const title = `${teamLabel(teamNumber, teamName)} Scouting — ${selectedEvent?.name || eventCode}`;
    const { spreadsheetUrl } = await withStep('Creating/writing Google Sheet', () =>
      exportToNewSpreadsheet(title, pitFields, pitDocs, matchFields, matchDocs));

    hideLoading();
    if (pitDocs.length === 0 && matchDocs.length === 0) {
      setStatusMessage(statusPrefix, 'success', 'No scouting data found for this team yet — created an empty sheet.');
    } else {
      setStatusMessage(statusPrefix, 'success', 'Export complete! Opening sheet...');
    }
    window.open(spreadsheetUrl, '_blank');
  } catch (err) {
    hideLoading();
    console.error('Sheets export failed:', err);
    setStatusMessage(statusPrefix, 'error', err.message || 'Export failed. Please try again.');
  }
}

// ====== Download a single team's pit + match scouting data as an .xlsx file ======
async function handleExportTeamExcelClick(statusPrefix) {
  setStatusMessage(statusPrefix, 'error', '');
  setStatusMessage(statusPrefix, 'success', '');

  const teamNumber = currentSelectedTeamNumber;
  const eventCode = selectedEvent?.code;
  const teamId = currentTeamData?.id;

  if (!teamNumber || !eventCode) {
    setStatusMessage(statusPrefix, 'error', 'Select a team and event first.');
    return;
  }
  if (!teamId) {
    setStatusMessage(statusPrefix, 'error', 'Team data not loaded. Please rejoin your team.');
    return;
  }

  showLoading('Gathering scouting data...');
  try {
    const { pitFields, matchFields, pitDocs, matchDocs } = await gatherTeamExportData(teamNumber, eventCode, teamId);

    const teamName = pitDocs[0]?.teamName || matchDocs[0]?.teamName || '';
    const filename = sanitizeFilename(`${teamLabel(teamNumber, teamName)} Scouting - ${selectedEvent?.name || eventCode}.xlsx`);
    downloadScoutingWorkbook(filename, pitFields, pitDocs, matchFields, matchDocs);

    hideLoading();
    setStatusMessage(statusPrefix, 'success', pitDocs.length === 0 && matchDocs.length === 0
      ? 'No scouting data found for this team yet — downloaded an empty workbook.'
      : 'Excel file downloaded!');
  } catch (err) {
    hideLoading();
    console.error('Excel export failed:', err);
    setStatusMessage(statusPrefix, 'error', err.message || 'Export failed. Please try again.');
  }
}

// ====== Export a single team's MATCH-ONLY scouting data (Google Sheets) —
// same shape as handleExportTeamClick() above, but for the "View Matches
// Scouted" modal (currentMatchScoutedTeamNumber/EventCode, match-scouted-
// modal.js) and with no pit-scouting sheet. ======
async function handleExportTeamMatchOnlyClick(statusPrefix) {
  setStatusMessage(statusPrefix, 'error', '');
  setStatusMessage(statusPrefix, 'success', '');

  const teamNumber = currentMatchScoutedTeamNumber;
  const eventCode = currentMatchScoutedEventCode;
  const teamId = currentTeamData?.id;

  if (!teamNumber || !eventCode) {
    setStatusMessage(statusPrefix, 'error', 'Select a team and event first.');
    return;
  }
  if (!teamId) {
    setStatusMessage(statusPrefix, 'error', 'Team data not loaded. Please rejoin your team.');
    return;
  }

  showLoading('Waiting for Google authorization...');
  try {
    await getGoogleAccessToken();

    showLoading('Gathering scouting data...');
    const { matchFields, matchDocs } = await gatherTeamMatchExportData(teamNumber, eventCode, teamId);

    showLoading('Creating Google Sheet...');
    const title = `${teamLabel(teamNumber, matchDocs[0]?.teamName || '')} Match Scouting — ${selectedEvent?.name || eventCode}`;
    const url = await withStep('Creating/writing Google Sheet', () =>
      exportMatchOnlyToNewSpreadsheet(title, matchFields, matchDocs));

    hideLoading();
    setStatusMessage(statusPrefix, 'success', matchDocs.length === 0
      ? 'No match scouting data found for this team yet — created an empty sheet.'
      : 'Export complete! Opening sheet...');
    window.open(url, '_blank');
  } catch (err) {
    hideLoading();
    console.error('Match-only sheets export failed:', err);
    setStatusMessage(statusPrefix, 'error', err.message || 'Export failed. Please try again.');
  }
}

// ====== Download a single team's MATCH-ONLY scouting data as an .xlsx file —
// Excel counterpart to handleExportTeamMatchOnlyClick() above. ======
async function handleExportTeamMatchOnlyExcelClick(statusPrefix) {
  setStatusMessage(statusPrefix, 'error', '');
  setStatusMessage(statusPrefix, 'success', '');

  const teamNumber = currentMatchScoutedTeamNumber;
  const eventCode = currentMatchScoutedEventCode;
  const teamId = currentTeamData?.id;

  if (!teamNumber || !eventCode) {
    setStatusMessage(statusPrefix, 'error', 'Select a team and event first.');
    return;
  }
  if (!teamId) {
    setStatusMessage(statusPrefix, 'error', 'Team data not loaded. Please rejoin your team.');
    return;
  }

  showLoading('Gathering scouting data...');
  try {
    const { matchFields, matchDocs } = await gatherTeamMatchExportData(teamNumber, eventCode, teamId);

    const filename = sanitizeFilename(`${teamLabel(teamNumber, matchDocs[0]?.teamName || '')} Match Scouting - ${selectedEvent?.name || eventCode}.xlsx`);
    downloadMatchOnlyWorkbook(filename, matchFields, matchDocs);

    hideLoading();
    setStatusMessage(statusPrefix, 'success', matchDocs.length === 0
      ? 'No match scouting data found for this team yet — downloaded an empty workbook.'
      : 'Excel file downloaded!');
  } catch (err) {
    hideLoading();
    console.error('Match-only Excel export failed:', err);
    setStatusMessage(statusPrefix, 'error', err.message || 'Export failed. Please try again.');
  }
}

// ====== Export one team's PIT-ONLY entry — used by the Pit Scouting tab's
// per-row export button. Unlike handleExportTeamMatchOnlyClick() above (which
// reads currentMatchScoutedTeamNumber/EventCode, set when the "View Matches
// Scouted" modal opens), there's no modal here to hold "currently showing"
// state — many rows can exist at once — so teamNumber/eventCode/teamId are
// passed explicitly instead. ======
async function handleExportTeamPitOnlyClick(teamNumber, eventCode, teamId, statusPrefix) {
  setStatusMessage(statusPrefix, 'error', '');
  setStatusMessage(statusPrefix, 'success', '');

  if (!teamNumber || !eventCode || !teamId) {
    setStatusMessage(statusPrefix, 'error', 'Select a team and event first.');
    return;
  }

  showLoading('Waiting for Google authorization...');
  try {
    await getGoogleAccessToken();

    showLoading('Gathering scouting data...');
    const { pitFields, pitDocs } = await gatherTeamPitOnlyExportData(teamNumber, eventCode, teamId);

    showLoading('Creating Google Sheet...');
    const title = `${teamLabel(teamNumber, pitDocs[0]?.teamName || '')} Pit Data — ${selectedEvent?.name || eventCode}`;
    const url = await withStep('Creating/writing Google Sheet', () =>
      exportPitOnlyToNewSpreadsheet(title, pitFields, pitDocs));

    hideLoading();
    // Includes the team number in the message since this status line is
    // shared with the tab's "Export All Pit Data" button (event-export-pit),
    // away from whichever row was actually clicked.
    setStatusMessage(statusPrefix, 'success', pitDocs.length === 0
      ? `No pit scouting data found for Team #${teamNumber} yet — created an empty sheet.`
      : `Export complete for Team #${teamNumber}! Opening sheet...`);
    window.open(url, '_blank');
  } catch (err) {
    hideLoading();
    console.error('Team pit-only sheets export failed:', err);
    setStatusMessage(statusPrefix, 'error', err.message || 'Export failed. Please try again.');
  }
}

// ====== Download one team's PIT-ONLY entry as an .xlsx file — Excel
// counterpart to handleExportTeamPitOnlyClick() above. ======
async function handleExportTeamPitOnlyExcelClick(teamNumber, eventCode, teamId, statusPrefix) {
  setStatusMessage(statusPrefix, 'error', '');
  setStatusMessage(statusPrefix, 'success', '');

  if (!teamNumber || !eventCode || !teamId) {
    setStatusMessage(statusPrefix, 'error', 'Select a team and event first.');
    return;
  }

  showLoading('Gathering scouting data...');
  try {
    const { pitFields, pitDocs } = await gatherTeamPitOnlyExportData(teamNumber, eventCode, teamId);

    const filename = sanitizeFilename(`${teamLabel(teamNumber, pitDocs[0]?.teamName || '')} Pit Data - ${selectedEvent?.name || eventCode}.xlsx`);
    downloadPitOnlyWorkbook(filename, pitFields, pitDocs);

    hideLoading();
    setStatusMessage(statusPrefix, 'success', pitDocs.length === 0
      ? `No pit scouting data found for Team #${teamNumber} yet — downloaded an empty workbook.`
      : `Excel file downloaded for Team #${teamNumber}!`);
  } catch (err) {
    hideLoading();
    console.error('Team pit-only Excel export failed:', err);
    setStatusMessage(statusPrefix, 'error', err.message || 'Export failed. Please try again.');
  }
}

// ====== Open the shared export-choice modal for a single team's pit-only
// export, binding teamNumber/eventCode/teamId in via closures — called from
// the Pit Scouting tab row's export button (first-api.js), same closure
// pattern as openWholeTeamExportChoice() below. Prechecks for data first
// (precheckExportData()) so an unscouted team shows the inline "nothing
// found" message immediately, with no format-choice popup at all. ======
async function openTeamPitExportChoice(teamNumber, eventCode, teamId, statusPrefix) {
  setStatusMessage(statusPrefix, 'error', '');
  setStatusMessage(statusPrefix, 'success', '');

  if (!teamNumber || !eventCode || !teamId) {
    setStatusMessage(statusPrefix, 'error', 'Select a team and event first.');
    return;
  }

  const hasData = await precheckExportData(
    statusPrefix,
    () => gatherTeamPitOnlyExportData(teamNumber, eventCode, teamId),
    (r) => r.pitDocs.length === 0,
    `No pit scouting data found for Team #${teamNumber} yet.`
  );
  if (!hasData) return;

  openExportChoiceModal({
    title: `Export Pit Data — Team #${teamNumber}`,
    statusPrefix,
    excelHandler: (prefix) => handleExportTeamPitOnlyExcelClick(teamNumber, eventCode, teamId, prefix),
    sheetsHandler: (prefix) => handleExportTeamPitOnlyClick(teamNumber, eventCode, teamId, prefix)
  });
}

// ====== Export every team's pit + match scouting data for the selected event ======
async function handleExportEventClick(statusPrefix) {
  setStatusMessage(statusPrefix, 'error', '');
  setStatusMessage(statusPrefix, 'success', '');

  const eventCode = selectedEvent?.code;
  const teamId = currentTeamData?.id;

  if (!eventCode) {
    setStatusMessage(statusPrefix, 'error', 'Select an event first.');
    return;
  }
  if (!teamId) {
    setStatusMessage(statusPrefix, 'error', 'Team data not loaded. Please rejoin your team.');
    return;
  }

  showLoading('Waiting for Google authorization...');
  try {
    await getGoogleAccessToken();

    showLoading('Gathering scouting data...');
    const { pitFields, matchFields, pitDocs, matchDocs } = await gatherEventExportData(eventCode, teamId);

    showLoading('Creating Google Sheet...');
    const title = `${selectedEvent?.name || eventCode} — All Teams Scouting Export`;
    const { spreadsheetUrl } = await withStep('Creating/writing Google Sheet', () =>
      exportToNewSpreadsheet(title, pitFields, pitDocs, matchFields, matchDocs));

    hideLoading();
    if (pitDocs.length === 0 && matchDocs.length === 0) {
      setStatusMessage(statusPrefix, 'success', 'No scouting data found for this event yet — created an empty sheet.');
    } else {
      setStatusMessage(statusPrefix, 'success', 'Export complete! Opening sheet...');
    }
    window.open(spreadsheetUrl, '_blank');
  } catch (err) {
    hideLoading();
    console.error('Event sheets export failed:', err);
    setStatusMessage(statusPrefix, 'error', err.message || 'Export failed. Please try again.');
  }
}

// ====== Download every team's pit + match scouting data for the event as one .xlsx file ======
async function handleExportEventExcelClick(statusPrefix) {
  setStatusMessage(statusPrefix, 'error', '');
  setStatusMessage(statusPrefix, 'success', '');

  const eventCode = selectedEvent?.code;
  const teamId = currentTeamData?.id;

  if (!eventCode) {
    setStatusMessage(statusPrefix, 'error', 'Select an event first.');
    return;
  }
  if (!teamId) {
    setStatusMessage(statusPrefix, 'error', 'Team data not loaded. Please rejoin your team.');
    return;
  }

  showLoading('Gathering scouting data...');
  try {
    const { pitFields, matchFields, pitDocs, matchDocs } = await gatherEventExportData(eventCode, teamId);

    const filename = sanitizeFilename(`${selectedEvent?.name || eventCode} - All Teams Scouting.xlsx`);
    downloadScoutingWorkbook(filename, pitFields, pitDocs, matchFields, matchDocs);

    hideLoading();
    setStatusMessage(statusPrefix, 'success', pitDocs.length === 0 && matchDocs.length === 0
      ? 'No scouting data found for this event yet — downloaded an empty workbook.'
      : 'Excel file downloaded!');
  } catch (err) {
    hideLoading();
    console.error('Event Excel export failed:', err);
    setStatusMessage(statusPrefix, 'error', err.message || 'Export failed. Please try again.');
  }
}

// ====== Export every team's PIT-ONLY scouting data for the selected event —
// used by the Pit Scouting tab's "Export All Pit Data" button. ======
async function handleExportEventPitOnlyClick(statusPrefix) {
  setStatusMessage(statusPrefix, 'error', '');
  setStatusMessage(statusPrefix, 'success', '');

  const eventCode = selectedEvent?.code;
  const teamId = currentTeamData?.id;

  if (!eventCode) {
    setStatusMessage(statusPrefix, 'error', 'Select an event first.');
    return;
  }
  if (!teamId) {
    setStatusMessage(statusPrefix, 'error', 'Team data not loaded. Please rejoin your team.');
    return;
  }

  showLoading('Waiting for Google authorization...');
  try {
    await getGoogleAccessToken();

    showLoading('Gathering scouting data...');
    const { pitFields, pitDocs } = await gatherEventPitOnlyExportData(eventCode, teamId);

    showLoading('Creating Google Sheet...');
    const title = `${selectedEvent?.name || eventCode} — All Teams Pit Data`;
    const url = await withStep('Creating/writing Google Sheet', () =>
      exportPitOnlyToNewSpreadsheet(title, pitFields, pitDocs));

    hideLoading();
    setStatusMessage(statusPrefix, 'success', pitDocs.length === 0
      ? 'No pit scouting data found for this event yet — created an empty sheet.'
      : 'Export complete! Opening sheet...');
    window.open(url, '_blank');
  } catch (err) {
    hideLoading();
    console.error('Event pit-only sheets export failed:', err);
    setStatusMessage(statusPrefix, 'error', err.message || 'Export failed. Please try again.');
  }
}

// ====== Download every team's PIT-ONLY scouting data for the event as one
// .xlsx file — Excel counterpart to handleExportEventPitOnlyClick() above. ======
async function handleExportEventPitOnlyExcelClick(statusPrefix) {
  setStatusMessage(statusPrefix, 'error', '');
  setStatusMessage(statusPrefix, 'success', '');

  const eventCode = selectedEvent?.code;
  const teamId = currentTeamData?.id;

  if (!eventCode) {
    setStatusMessage(statusPrefix, 'error', 'Select an event first.');
    return;
  }
  if (!teamId) {
    setStatusMessage(statusPrefix, 'error', 'Team data not loaded. Please rejoin your team.');
    return;
  }

  showLoading('Gathering scouting data...');
  try {
    const { pitFields, pitDocs } = await gatherEventPitOnlyExportData(eventCode, teamId);

    const filename = sanitizeFilename(`${selectedEvent?.name || eventCode} - All Teams Pit Data.xlsx`);
    downloadPitOnlyWorkbook(filename, pitFields, pitDocs);

    hideLoading();
    setStatusMessage(statusPrefix, 'success', pitDocs.length === 0
      ? 'No pit scouting data found for this event yet — downloaded an empty workbook.'
      : 'Excel file downloaded!');
  } catch (err) {
    hideLoading();
    console.error('Event pit-only Excel export failed:', err);
    setStatusMessage(statusPrefix, 'error', err.message || 'Export failed. Please try again.');
  }
}

// ====== Export every team's MATCH-ONLY scouting data for the selected event —
// used by the Match Scouting tab's "Export All Match Data" button. ======
async function handleExportEventMatchOnlyClick(statusPrefix) {
  setStatusMessage(statusPrefix, 'error', '');
  setStatusMessage(statusPrefix, 'success', '');

  const eventCode = selectedEvent?.code;
  const teamId = currentTeamData?.id;

  if (!eventCode) {
    setStatusMessage(statusPrefix, 'error', 'Select an event first.');
    return;
  }
  if (!teamId) {
    setStatusMessage(statusPrefix, 'error', 'Team data not loaded. Please rejoin your team.');
    return;
  }

  showLoading('Waiting for Google authorization...');
  try {
    await getGoogleAccessToken();

    showLoading('Gathering scouting data...');
    const { matchFields, matchDocs } = await gatherEventMatchOnlyExportData(eventCode, teamId);

    showLoading('Creating Google Sheet...');
    const title = `${selectedEvent?.name || eventCode} — All Teams Match Data`;
    const url = await withStep('Creating/writing Google Sheet', () =>
      exportMatchOnlyToNewSpreadsheet(title, matchFields, matchDocs));

    hideLoading();
    setStatusMessage(statusPrefix, 'success', matchDocs.length === 0
      ? 'No match scouting data found for this event yet — created an empty sheet.'
      : 'Export complete! Opening sheet...');
    window.open(url, '_blank');
  } catch (err) {
    hideLoading();
    console.error('Event match-only sheets export failed:', err);
    setStatusMessage(statusPrefix, 'error', err.message || 'Export failed. Please try again.');
  }
}

// ====== Download every team's MATCH-ONLY scouting data for the event as one
// .xlsx file — Excel counterpart to handleExportEventMatchOnlyClick() above. ======
async function handleExportEventMatchOnlyExcelClick(statusPrefix) {
  setStatusMessage(statusPrefix, 'error', '');
  setStatusMessage(statusPrefix, 'success', '');

  const eventCode = selectedEvent?.code;
  const teamId = currentTeamData?.id;

  if (!eventCode) {
    setStatusMessage(statusPrefix, 'error', 'Select an event first.');
    return;
  }
  if (!teamId) {
    setStatusMessage(statusPrefix, 'error', 'Team data not loaded. Please rejoin your team.');
    return;
  }

  showLoading('Gathering scouting data...');
  try {
    const { matchFields, matchDocs } = await gatherEventMatchOnlyExportData(eventCode, teamId);

    const filename = sanitizeFilename(`${selectedEvent?.name || eventCode} - All Teams Match Data.xlsx`);
    downloadMatchOnlyWorkbook(filename, matchFields, matchDocs);

    hideLoading();
    setStatusMessage(statusPrefix, 'success', matchDocs.length === 0
      ? 'No match scouting data found for this event yet — downloaded an empty workbook.'
      : 'Excel file downloaded!');
  } catch (err) {
    hideLoading();
    console.error('Event match-only Excel export failed:', err);
    setStatusMessage(statusPrefix, 'error', err.message || 'Export failed. Please try again.');
  }
}

// ====== Export a team's ENTIRE scouting history (every event, not just the
// selected one) as a single ZIP of small per-event .xlsx workbooks. Used only
// when leaving/deleting a team as its LAST remaining member, right before
// that data is permanently deleted — see openWholeTeamExportChoice() below
// for how teamId/teamName get bound in from the leave/delete-account flows. ======
async function handleExportWholeTeamExcelClick(teamId, teamName, statusPrefix) {
  setStatusMessage(statusPrefix, 'error', '');
  setStatusMessage(statusPrefix, 'success', '');

  if (typeof JSZip === 'undefined') {
    setStatusMessage(statusPrefix, 'error', 'Zip export library failed to load. Check your connection and try again.');
    return;
  }
  if (!teamId) {
    setStatusMessage(statusPrefix, 'error', 'Team data not loaded. Please try again.');
    return;
  }

  showLoading('Gathering all scouting data...');
  try {
    const { pitFields, matchFields, eventCodes, byEvent } = await gatherFullTeamExportData(teamId);

    if (eventCodes.length === 0) {
      hideLoading();
      setStatusMessage(statusPrefix, 'success', 'No scouting data found for this team — nothing to export.');
      return;
    }

    showLoading('Building workbook files...');
    const zip = new JSZip();
    eventCodes.forEach(eventCode => {
      const { pitDocs, matchDocs } = byEvent[eventCode];
      const bytes = buildWorkbookBytes(pitFields, pitDocs, matchFields, matchDocs);
      zip.file(`${sanitizeFilename(eventCode)}.xlsx`, bytes);
    });

    showLoading('Creating ZIP file...');
    const blob = await zip.generateAsync({ type: 'blob' });

    const filename = sanitizeFilename(`${teamName || 'Team'} - Full Scouting History.zip`);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);

    hideLoading();
    setStatusMessage(statusPrefix, 'success', `Downloaded! ${eventCodes.length} event(s) exported.`);
  } catch (err) {
    hideLoading();
    console.error('Whole-team Excel export failed:', err);
    setStatusMessage(statusPrefix, 'error', err.message || 'Export failed. Please try again.');
  }
}

// ====== Export a team's ENTIRE scouting history to Google Drive, organized
// as: team folder -> one subfolder per event-with-data -> one 2-tab
// spreadsheet per subfolder. Uses getGoogleWholeTeamAccessToken (spreadsheets
// + drive.file) since folder creation/moving needs Drive API access none of
// this file's other exports request. Used only by the leave/delete-as-last-
// member flow, right before the team's data is gone for good. ======
async function handleExportWholeTeamSheetsClick(teamId, teamName, statusPrefix) {
  setStatusMessage(statusPrefix, 'error', '');
  setStatusMessage(statusPrefix, 'success', '');

  if (!teamId) {
    setStatusMessage(statusPrefix, 'error', 'Team data not loaded. Please try again.');
    return;
  }

  showLoading('Waiting for Google authorization...');
  try {
    await getGoogleWholeTeamAccessToken();

    showLoading('Gathering all scouting data...');
    const { pitFields, matchFields, eventCodes, byEvent } = await gatherFullTeamExportData(teamId);

    if (eventCodes.length === 0) {
      hideLoading();
      setStatusMessage(statusPrefix, 'success', 'No scouting data found for this team — nothing to export.');
      return;
    }

    const folderLabel = teamName || 'Team';

    showLoading('Creating team folder in Google Drive...');
    const rootFolder = await withStep('Creating Drive folder', () =>
      createDriveFolder(`${folderLabel} — Full Scouting Export`));

    for (const eventCode of eventCodes) {
      showLoading(`Exporting event ${eventCode}...`);
      const { pitDocs, matchDocs } = byEvent[eventCode];

      const eventFolder = await withStep(`Creating folder for event ${eventCode}`, () =>
        createDriveFolder(eventCode, rootFolder.id));

      const created = await withStep(`Creating spreadsheet for event ${eventCode}`, () =>
        exportToNewSpreadsheet(`${folderLabel} — ${eventCode}`, pitFields, pitDocs, matchFields, matchDocs, getGoogleWholeTeamAccessToken));

      await withStep(`Moving spreadsheet for event ${eventCode} into its folder`, () =>
        moveFileToFolder(created.spreadsheetId, eventFolder.id));
    }

    hideLoading();
    setStatusMessage(statusPrefix, 'success', `Export complete! ${eventCodes.length} event(s) exported. Opening folder...`);
    window.open(rootFolder.webViewLink, '_blank');
  } catch (err) {
    hideLoading();
    console.error('Whole-team Sheets export failed:', err);
    setStatusMessage(statusPrefix, 'error', err.message || 'Export failed. Please try again.');
  }
}

// ====== Open the shared export-choice modal (Excel vs Sheets) for the
// whole-team export, binding teamId/teamName in via closures — called from
// the leave-team confirmation modal (members.js) and the delete-account
// modal's sole-owner-team buttons (delete-account.js). statusPrefix must be
// unique per caller (elements `${statusPrefix}-error`/`-success` must exist
// in the DOM) since delete-account can show buttons for multiple teams at once. ======
async function openWholeTeamExportChoice(teamId, teamName, statusPrefix) {
  setStatusMessage(statusPrefix, 'error', '');
  setStatusMessage(statusPrefix, 'success', '');

  if (!teamId) {
    setStatusMessage(statusPrefix, 'error', 'Team data not loaded. Please try again.');
    return;
  }

  const hasData = await precheckExportData(
    statusPrefix,
    () => gatherFullTeamExportData(teamId),
    (r) => r.eventCodes.length === 0,
    'No scouting data found for this team — nothing to export.'
  );
  if (!hasData) return;

  openExportChoiceModal({
    title: 'Export Whole Team Data',
    statusPrefix,
    excelHandler: (prefix) => handleExportWholeTeamExcelClick(teamId, teamName, prefix),
    sheetsHandler: (prefix) => handleExportWholeTeamSheetsClick(teamId, teamName, prefix)
  });
}

// ====== Open the shared export-choice modal for a single team's pit + match
// export (Team Detail's "Export Pit + Match Data" button) — prechecks for
// data first via precheckExportData(). ======
async function openTeamExportChoice(statusPrefix) {
  setStatusMessage(statusPrefix, 'error', '');
  setStatusMessage(statusPrefix, 'success', '');

  const teamNumber = currentSelectedTeamNumber;
  const eventCode = selectedEvent?.code;
  const teamId = currentTeamData?.id;

  if (!teamNumber || !eventCode) {
    setStatusMessage(statusPrefix, 'error', 'Select a team and event first.');
    return;
  }
  if (!teamId) {
    setStatusMessage(statusPrefix, 'error', 'Team data not loaded. Please rejoin your team.');
    return;
  }

  const hasData = await precheckExportData(
    statusPrefix,
    () => gatherTeamExportData(teamNumber, eventCode, teamId),
    (r) => r.pitDocs.length === 0 && r.matchDocs.length === 0,
    'No scouting data found for this team yet.'
  );
  if (!hasData) return;

  openExportChoiceModal({
    title: 'Export Pit + Match Data',
    statusPrefix,
    sheetsHandler: handleExportTeamClick,
    excelHandler: handleExportTeamExcelClick
  });
}

// ====== Open the shared export-choice modal for "View Matches Scouted"'s
// match-only export — prechecks for data first via precheckExportData(). ======
async function openTeamMatchOnlyExportChoice(statusPrefix) {
  setStatusMessage(statusPrefix, 'error', '');
  setStatusMessage(statusPrefix, 'success', '');

  const teamNumber = currentMatchScoutedTeamNumber;
  const eventCode = currentMatchScoutedEventCode;
  const teamId = currentTeamData?.id;

  if (!teamNumber || !eventCode) {
    setStatusMessage(statusPrefix, 'error', 'Select a team and event first.');
    return;
  }
  if (!teamId) {
    setStatusMessage(statusPrefix, 'error', 'Team data not loaded. Please rejoin your team.');
    return;
  }

  const hasData = await precheckExportData(
    statusPrefix,
    () => gatherTeamMatchExportData(teamNumber, eventCode, teamId),
    (r) => r.matchDocs.length === 0,
    'No match scouting data found for this team yet.'
  );
  if (!hasData) return;

  openExportChoiceModal({
    title: 'Export Match Data',
    statusPrefix,
    sheetsHandler: handleExportTeamMatchOnlyClick,
    excelHandler: handleExportTeamMatchOnlyExcelClick
  });
}

// ====== Open the shared export-choice modal for the event-wide pit + match
// export (Scouting tab's "Export Pit + Match Data (All Teams)" button) —
// prechecks for data first via precheckExportData(). ======
async function openEventExportChoice(statusPrefix) {
  setStatusMessage(statusPrefix, 'error', '');
  setStatusMessage(statusPrefix, 'success', '');

  const eventCode = selectedEvent?.code;
  const teamId = currentTeamData?.id;

  if (!eventCode) {
    setStatusMessage(statusPrefix, 'error', 'Select an event first.');
    return;
  }
  if (!teamId) {
    setStatusMessage(statusPrefix, 'error', 'Team data not loaded. Please rejoin your team.');
    return;
  }

  const hasData = await precheckExportData(
    statusPrefix,
    () => gatherEventExportData(eventCode, teamId),
    (r) => r.pitDocs.length === 0 && r.matchDocs.length === 0,
    'No scouting data found for this event yet.'
  );
  if (!hasData) return;

  openExportChoiceModal({
    title: 'Export Pit + Match Data',
    statusPrefix,
    sheetsHandler: handleExportEventClick,
    excelHandler: handleExportEventExcelClick
  });
}

// ====== Open the shared export-choice modal for the Pit Scouting tab's
// "Export All Pit Data" button (event-wide, pit-only) — prechecks for data
// first via precheckExportData(). ======
async function openEventPitExportChoice(statusPrefix) {
  setStatusMessage(statusPrefix, 'error', '');
  setStatusMessage(statusPrefix, 'success', '');

  const eventCode = selectedEvent?.code;
  const teamId = currentTeamData?.id;

  if (!eventCode) {
    setStatusMessage(statusPrefix, 'error', 'Select an event first.');
    return;
  }
  if (!teamId) {
    setStatusMessage(statusPrefix, 'error', 'Team data not loaded. Please rejoin your team.');
    return;
  }

  const hasData = await precheckExportData(
    statusPrefix,
    () => gatherEventPitOnlyExportData(eventCode, teamId),
    (r) => r.pitDocs.length === 0,
    'No pit scouting data found for this event yet.'
  );
  if (!hasData) return;

  openExportChoiceModal({
    title: 'Export Pit Data',
    statusPrefix,
    sheetsHandler: handleExportEventPitOnlyClick,
    excelHandler: handleExportEventPitOnlyExcelClick
  });
}

// ====== Open the shared export-choice modal for the Match Scouting tab's
// "Export All Match Data" button (event-wide, match-only) — prechecks for
// data first via precheckExportData(). ======
async function openEventMatchOnlyExportChoice(statusPrefix) {
  setStatusMessage(statusPrefix, 'error', '');
  setStatusMessage(statusPrefix, 'success', '');

  const eventCode = selectedEvent?.code;
  const teamId = currentTeamData?.id;

  if (!eventCode) {
    setStatusMessage(statusPrefix, 'error', 'Select an event first.');
    return;
  }
  if (!teamId) {
    setStatusMessage(statusPrefix, 'error', 'Team data not loaded. Please rejoin your team.');
    return;
  }

  const hasData = await precheckExportData(
    statusPrefix,
    () => gatherEventMatchOnlyExportData(eventCode, teamId),
    (r) => r.matchDocs.length === 0,
    'No match scouting data found for this event yet.'
  );
  if (!hasData) return;

  openExportChoiceModal({
    title: 'Export Match Data',
    statusPrefix,
    sheetsHandler: handleExportEventMatchOnlyClick,
    excelHandler: handleExportEventMatchOnlyExcelClick
  });
}

// ====== Export Choice Modal (Excel download vs Google Sheets) ======
let exportChoiceContext = null;

function openExportChoiceModal(context) {
  exportChoiceContext = context;
  const modal = document.getElementById('export-choice-modal');
  if (modal) modal.classList.remove('hidden');

  // Defaults to the original (only) export this modal used to support —
  // callers that need a different label (e.g. the match-only export) pass
  // their own context.title.
  const titleEl = document.getElementById('export-choice-title');
  if (titleEl) titleEl.textContent = context?.title || 'Export Pit + Match Data';
}

function closeExportChoiceModal() {
  exportChoiceContext = null;
  const modal = document.getElementById('export-choice-modal');
  if (modal) modal.classList.add('hidden');
}

// ====== Wire up buttons ======
document.addEventListener('DOMContentLoaded', () => {
  const btnMatch = document.getElementById('td-export-team-match');
  if (btnMatch) {
    btnMatch.addEventListener('click', () => openTeamExportChoice('td-export-match'));
  }

  // "View Matches Scouted" modal's export button — match entries only, no
  // pit-scouting sheet/tab, for whichever team that modal currently shows.
  const btnMsmMatch = document.getElementById('msm-export-team-match');
  if (btnMsmMatch) {
    btnMsmMatch.addEventListener('click', () => openTeamMatchOnlyExportChoice('msm-export-match'));
  }

  const btnEvent = document.getElementById('btn-export-event-sheets');
  if (btnEvent) {
    btnEvent.addEventListener('click', () => openEventExportChoice('event-export'));
  }

  // Pit Scouting tab's "Export All Pit Data" button — event-wide, pit-only.
  const btnEventPit = document.getElementById('btn-export-event-pit');
  if (btnEventPit) {
    btnEventPit.addEventListener('click', () => openEventPitExportChoice('event-export-pit'));
  }

  // Match Scouting tab's "Export All Match Data" button — event-wide, match-only.
  const btnEventMatch = document.getElementById('btn-export-event-match');
  if (btnEventMatch) {
    btnEventMatch.addEventListener('click', () => openEventMatchOnlyExportChoice('event-export-match'));
  }

  // My Team tab's standalone "Export Team Data" button — reuses the exact
  // same whole-team-history gather/export flow as the Leave Team/Delete
  // Account "Export Whole Team Data" buttons (openWholeTeamExportChoice(),
  // which already prechecks for data), just without any leave/delete
  // confirmation wrapped around it — visible any time, not gated on being
  // the team's last member.
  const btnMyTeamExport = document.getElementById('btn-myteam-export');
  if (btnMyTeamExport) {
    btnMyTeamExport.addEventListener('click', () => {
      if (typeof openWholeTeamExportChoice === 'function') {
        openWholeTeamExportChoice(currentTeamId, currentTeamData?.name, 'myteam-export');
      }
    });
  }

  const closeBtn = document.getElementById('btn-export-choice-close');
  if (closeBtn) closeBtn.addEventListener('click', closeExportChoiceModal);

  const overlay = document.getElementById('export-choice-modal-overlay');
  if (overlay) overlay.addEventListener('click', closeExportChoiceModal);

  const excelBtn = document.getElementById('btn-export-choice-excel');
  if (excelBtn) {
    excelBtn.addEventListener('click', () => {
      const ctx = exportChoiceContext;
      closeExportChoiceModal();
      if (ctx) ctx.excelHandler(ctx.statusPrefix);
    });
  }

  const sheetsBtn = document.getElementById('btn-export-choice-sheets');
  if (sheetsBtn) {
    sheetsBtn.addEventListener('click', () => {
      const ctx = exportChoiceContext;
      closeExportChoiceModal();
      if (ctx) ctx.sheetsHandler(ctx.statusPrefix);
    });
  }
});
