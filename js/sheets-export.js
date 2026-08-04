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

// ====== Sheets API helpers ======
async function sheetsApiFetch(url, options = {}) {
  const token = await getGoogleAccessToken();
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

function createSpreadsheet(title, sheetTitles) {
  const body = {
    properties: { title },
    sheets: sheetTitles.map((sheetTitle, i) => ({ properties: { sheetId: i, title: sheetTitle } }))
  };
  return sheetsApiFetch(SHEETS_API_BASE, { method: 'POST', body: JSON.stringify(body) });
}

function writeSheetValues(spreadsheetId, sheetTitle, rows) {
  const range = `'${sheetTitle}'!A1`;
  const url = `${SHEETS_API_BASE}/${spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`;
  return sheetsApiFetch(url, {
    method: 'PUT',
    body: JSON.stringify({ range, majorDimension: 'ROWS', values: rows })
  });
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

// ====== Turn formConfig fields + Firestore docs into a 2D array of sheet rows ======
// fixedColumns: [{ header, key }] columns that always exist regardless of formConfig
// (e.g. Team Number, Match Number) — any formConfig field sharing one of their keys
// is skipped so the column isn't duplicated.
function buildSheetRows(fields, docs, fixedColumns) {
  const fixedKeys = fixedColumns.map(c => c.key);
  const dynamicColumns = fields
    .filter(f => !fixedKeys.includes(f.id))
    .map(f => ({ header: f.label, key: f.id }));

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
      return formatCellValue(doc[c.key]);
    }));
  });
  return rows;
}

function buildPitSheetRows(fields, docs) {
  return buildSheetRows(fields, docs, [{ header: 'Team Number', key: 'teamNumber' }]);
}

function buildMatchSheetRows(fields, docs) {
  return buildSheetRows(fields, docs, [
    { header: 'Team Number', key: 'teamNumber' },
    { header: 'Match Number', key: 'matchNumber' }
  ]);
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
// The teamId filter isn't just a convenience narrowing — firestore.rules' matchScouting
// read rule does a get() keyed on resource.data.teamId, and Firestore can only validate
// that for a list query when a where() clause pins teamId to a single value; without it
// the whole query is rejected as "insufficient permissions" for every requester.
async function fetchMatchDocsForEvent(eventCode, teamId) {
  const snap = await db.collection('matchScouting')
    .where('eventCode', '==', eventCode)
    .where('teamId', '==', teamId)
    .get();
  const docs = [];
  snap.forEach(doc => docs.push({ id: doc.id, ...doc.data() }));
  return docs;
}

// ====== Create a spreadsheet with Pit Scouting + Match Scouting tabs and fill it ======
async function exportToNewSpreadsheet(title, pitFields, pitDocs, matchFields, matchDocs) {
  const createResp = await createSpreadsheet(title, ['Pit Scouting', 'Match Scouting']);
  const spreadsheetId = createResp.spreadsheetId;

  const pitRows = buildPitSheetRows(pitFields, pitDocs);
  const matchRows = buildMatchSheetRows(matchFields, matchDocs);

  await writeSheetValues(spreadsheetId, 'Pit Scouting', pitRows);
  await writeSheetValues(spreadsheetId, 'Match Scouting', matchRows);

  return createResp.spreadsheetUrl;
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

// ====== Filesystem-safe filename (team/event names can contain characters like / or :) ======
function sanitizeFilename(name) {
  return String(name).replace(/[\\/:*?"<>|]/g, '-');
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

  return { pitFields, matchFields, pitDocs, matchDocs };
}

// ====== Gather every team's pit + match scouting data for the selected event ======
// Shared by both the Google Sheets and Excel export paths for a whole event.
async function gatherEventExportData(eventCode, teamId) {
  const [pitFields, matchFields] = await Promise.all([
    loadFormConfigReadOnly(teamId, 'pitScouting', DEFAULT_PIT_FIELDS),
    loadFormConfigReadOnly(teamId, 'matchScouting', DEFAULT_MATCH_FIELDS)
  ]);

  const pitSnap = await withStep('Reading pit scouting data',
    () => db.collection('pitScouting').where('eventCode', '==', eventCode).where('teamId', '==', teamId).get());
  const pitDocs = [];
  pitSnap.forEach(doc => pitDocs.push({ id: doc.id, ...doc.data() }));
  pitDocs.sort((a, b) => (a.teamNumber || 0) - (b.teamNumber || 0));

  const matchDocs = await withStep('Reading match scouting data', () => fetchMatchDocsForEvent(eventCode, teamId));
  matchDocs.sort((a, b) => (a.teamNumber || 0) - (b.teamNumber || 0) || (a.matchNumber || 0) - (b.matchNumber || 0));

  return { pitFields, matchFields, pitDocs, matchDocs };
}

// ====== Status message helper (mirrors the app's error/success paragraph convention) ======
// Auto-clears after a few seconds, same convention as other status messages in the
// app (e.g. bulk-delete status) — without this, a message like a cancelled Google
// auth popup would sit in the DOM indefinitely, including reappearing stale the next
// time the Team Detail modal (which hosts td-export-match-*) is reopened.
const exportStatusTimers = {};

function setExportStatus(prefix, type, message) {
  const errEl = document.getElementById(prefix + '-error');
  const okEl = document.getElementById(prefix + '-success');
  if (errEl) errEl.textContent = type === 'error' ? message : '';
  if (okEl) okEl.textContent = type === 'success' ? message : '';

  const timerKey = `${prefix}-${type}`;
  if (exportStatusTimers[timerKey]) {
    clearTimeout(exportStatusTimers[timerKey]);
    delete exportStatusTimers[timerKey];
  }
  if (message) {
    exportStatusTimers[timerKey] = setTimeout(() => {
      const el = document.getElementById(`${prefix}-${type}`);
      if (el) el.textContent = '';
      delete exportStatusTimers[timerKey];
    }, 5000);
  }
}

// ====== Export a single team's pit + match scouting data for the selected event ======
async function handleExportTeamClick(statusPrefix) {
  setExportStatus(statusPrefix, 'error', '');
  setExportStatus(statusPrefix, 'success', '');

  const teamNumber = currentSelectedTeamNumber;
  const eventCode = selectedEvent?.code;
  const teamId = currentTeamData?.id;

  if (!teamNumber || !eventCode) {
    setExportStatus(statusPrefix, 'error', 'Select a team and event first.');
    return;
  }
  if (!teamId) {
    setExportStatus(statusPrefix, 'error', 'Team data not loaded. Please rejoin your team.');
    return;
  }

  showLoading('Waiting for Google authorization...');
  try {
    await getGoogleAccessToken();

    showLoading('Gathering scouting data...');
    const { pitFields, matchFields, pitDocs, matchDocs } = await gatherTeamExportData(teamNumber, eventCode, teamId);

    showLoading('Creating Google Sheet...');
    const title = `Team ${teamNumber} Scouting — ${selectedEvent?.name || eventCode}`;
    const url = await withStep('Creating/writing Google Sheet', () =>
      exportToNewSpreadsheet(title, pitFields, pitDocs, matchFields, matchDocs));

    hideLoading();
    if (pitDocs.length === 0 && matchDocs.length === 0) {
      setExportStatus(statusPrefix, 'success', 'No scouting data found for this team yet — created an empty sheet.');
    } else {
      setExportStatus(statusPrefix, 'success', 'Export complete! Opening sheet...');
    }
    window.open(url, '_blank');
  } catch (err) {
    hideLoading();
    console.error('Sheets export failed:', err);
    setExportStatus(statusPrefix, 'error', err.message || 'Export failed. Please try again.');
  }
}

// ====== Download a single team's pit + match scouting data as an .xlsx file ======
async function handleExportTeamExcelClick(statusPrefix) {
  setExportStatus(statusPrefix, 'error', '');
  setExportStatus(statusPrefix, 'success', '');

  const teamNumber = currentSelectedTeamNumber;
  const eventCode = selectedEvent?.code;
  const teamId = currentTeamData?.id;

  if (!teamNumber || !eventCode) {
    setExportStatus(statusPrefix, 'error', 'Select a team and event first.');
    return;
  }
  if (!teamId) {
    setExportStatus(statusPrefix, 'error', 'Team data not loaded. Please rejoin your team.');
    return;
  }

  showLoading('Gathering scouting data...');
  try {
    const { pitFields, matchFields, pitDocs, matchDocs } = await gatherTeamExportData(teamNumber, eventCode, teamId);

    const filename = sanitizeFilename(`Team ${teamNumber} Scouting - ${selectedEvent?.name || eventCode}.xlsx`);
    downloadScoutingWorkbook(filename, pitFields, pitDocs, matchFields, matchDocs);

    hideLoading();
    setExportStatus(statusPrefix, 'success', pitDocs.length === 0 && matchDocs.length === 0
      ? 'No scouting data found for this team yet — downloaded an empty workbook.'
      : 'Excel file downloaded!');
  } catch (err) {
    hideLoading();
    console.error('Excel export failed:', err);
    setExportStatus(statusPrefix, 'error', err.message || 'Export failed. Please try again.');
  }
}

// ====== Export every team's pit + match scouting data for the selected event ======
async function handleExportEventClick(statusPrefix) {
  setExportStatus(statusPrefix, 'error', '');
  setExportStatus(statusPrefix, 'success', '');

  const eventCode = selectedEvent?.code;
  const teamId = currentTeamData?.id;

  if (!eventCode) {
    setExportStatus(statusPrefix, 'error', 'Select an event first.');
    return;
  }
  if (!teamId) {
    setExportStatus(statusPrefix, 'error', 'Team data not loaded. Please rejoin your team.');
    return;
  }

  showLoading('Waiting for Google authorization...');
  try {
    await getGoogleAccessToken();

    showLoading('Gathering scouting data...');
    const { pitFields, matchFields, pitDocs, matchDocs } = await gatherEventExportData(eventCode, teamId);

    showLoading('Creating Google Sheet...');
    const title = `${selectedEvent?.name || eventCode} — All Teams Scouting Export`;
    const url = await withStep('Creating/writing Google Sheet', () =>
      exportToNewSpreadsheet(title, pitFields, pitDocs, matchFields, matchDocs));

    hideLoading();
    if (pitDocs.length === 0 && matchDocs.length === 0) {
      setExportStatus(statusPrefix, 'success', 'No scouting data found for this event yet — created an empty sheet.');
    } else {
      setExportStatus(statusPrefix, 'success', 'Export complete! Opening sheet...');
    }
    window.open(url, '_blank');
  } catch (err) {
    hideLoading();
    console.error('Event sheets export failed:', err);
    setExportStatus(statusPrefix, 'error', err.message || 'Export failed. Please try again.');
  }
}

// ====== Download every team's pit + match scouting data for the event as one .xlsx file ======
async function handleExportEventExcelClick(statusPrefix) {
  setExportStatus(statusPrefix, 'error', '');
  setExportStatus(statusPrefix, 'success', '');

  const eventCode = selectedEvent?.code;
  const teamId = currentTeamData?.id;

  if (!eventCode) {
    setExportStatus(statusPrefix, 'error', 'Select an event first.');
    return;
  }
  if (!teamId) {
    setExportStatus(statusPrefix, 'error', 'Team data not loaded. Please rejoin your team.');
    return;
  }

  showLoading('Gathering scouting data...');
  try {
    const { pitFields, matchFields, pitDocs, matchDocs } = await gatherEventExportData(eventCode, teamId);

    const filename = sanitizeFilename(`${selectedEvent?.name || eventCode} - All Teams Scouting.xlsx`);
    downloadScoutingWorkbook(filename, pitFields, pitDocs, matchFields, matchDocs);

    hideLoading();
    setExportStatus(statusPrefix, 'success', pitDocs.length === 0 && matchDocs.length === 0
      ? 'No scouting data found for this event yet — downloaded an empty workbook.'
      : 'Excel file downloaded!');
  } catch (err) {
    hideLoading();
    console.error('Event Excel export failed:', err);
    setExportStatus(statusPrefix, 'error', err.message || 'Export failed. Please try again.');
  }
}

// ====== Export Choice Modal (Excel download vs Google Sheets) ======
let exportChoiceContext = null;

function openExportChoiceModal(context) {
  exportChoiceContext = context;
  const modal = document.getElementById('export-choice-modal');
  if (modal) modal.classList.remove('hidden');
}

function closeExportChoiceModal() {
  exportChoiceContext = null;
  const modal = document.getElementById('export-choice-modal');
  if (modal) modal.classList.add('hidden');
}

// ====== Wire up buttons ======
document.addEventListener('DOMContentLoaded', () => {
  const btnMatch = document.getElementById('btn-export-team-match');
  if (btnMatch) {
    btnMatch.addEventListener('click', () => {
      openExportChoiceModal({
        statusPrefix: 'td-export-match',
        sheetsHandler: handleExportTeamClick,
        excelHandler: handleExportTeamExcelClick
      });
    });
  }

  const btnEvent = document.getElementById('btn-export-event-sheets');
  if (btnEvent) {
    btnEvent.addEventListener('click', () => {
      openExportChoiceModal({
        statusPrefix: 'event-export',
        sheetsHandler: handleExportEventClick,
        excelHandler: handleExportEventExcelClick
      });
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
