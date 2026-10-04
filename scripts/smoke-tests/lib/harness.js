// Shared harness for the smoke tests: a static file server for the app, the
// Firebase Auth + Firestore emulators (loading the REAL firestore.rules), and
// per-test browser contexts with every external dependency mocked or cached.
//
// Hermetic by design: the app's firebase-config.js is rewritten in flight to
// point at a throwaway "demo-" project on the local emulators, so a smoke run
// can never read or write the production Firebase project. The app source is
// not modified — only the response to /js/firebase-config.js is swapped.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { spawn, execSync } = require('child_process');
const { chromium } = require('playwright');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const CDN_CACHE_DIR = path.join(__dirname, '..', '.cdn-cache');
const ARTIFACTS_DIR = path.join(__dirname, '..', 'artifacts');

const PROJECT_ID = 'demo-fe2o3-smoke';
const PORTS = { static: 5057, auth: 9199, firestore: 8180 };
const WORKER_ORIGIN = 'https://fe2o3-ftc-proxy.fe2o3-scouting.workers.dev';

// Only these top-level entries of the repo are ever served — same spirit as
// firebase.json's hosting.ignore (never expose .git, scripts/, .claude/, ...).
const SERVED_PREFIXES = ['/scouting', '/js/', '/css/', '/icons/'];
const SERVED_FILES = ['/', '/index.html', '/manifest.json', '/404.html', '/privacy.html'];

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
};

// ====== Static server ======
function startStaticServer(port = PORTS.static) {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(req.url.split('?')[0]);
    if (urlPath === '/scouting') { res.writeHead(301, { Location: '/scouting/' }); return res.end(); }
    const allowed = SERVED_FILES.includes(urlPath) || SERVED_PREFIXES.some(p => urlPath.startsWith(p));
    let filePath = path.join(REPO_ROOT, urlPath);
    if (!allowed || !filePath.startsWith(REPO_ROOT)) { res.writeHead(404); return res.end('not served'); }
    if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) filePath = path.join(filePath, 'index.html');
    if (!fs.existsSync(filePath)) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(filePath).pipe(res);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({ server, baseUrl: `http://127.0.0.1:${port}` }));
  });
}

// ====== Emulators ======
function waitForPort(port, timeoutMs = 120000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    (function attempt() {
      const sock = net.connect(port, '127.0.0.1');
      sock.once('connect', () => { sock.destroy(); resolve(); });
      sock.once('error', () => {
        sock.destroy();
        if (Date.now() - start > timeoutMs) return reject(new Error(`Timed out waiting for port ${port}`));
        setTimeout(attempt, 500);
      });
    })();
  });
}

function portIsFree(port) {
  return new Promise(resolve => {
    const sock = net.connect(port, '127.0.0.1');
    sock.once('connect', () => { sock.destroy(); resolve(false); });
    sock.once('error', () => { sock.destroy(); resolve(true); });
  });
}

async function startEmulators() {
  for (const p of [PORTS.auth, PORTS.firestore]) {
    if (!(await portIsFree(p))) throw new Error(`Port ${p} is already in use — is a previous emulator still running?`);
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fe2o3-smoke-'));
  const config = {
    firestore: { rules: path.join(REPO_ROOT, 'firestore.rules').replace(/\\/g, '/') },
    emulators: {
      auth: { host: '127.0.0.1', port: PORTS.auth },
      firestore: { host: '127.0.0.1', port: PORTS.firestore },
      ui: { enabled: false },
      singleProjectMode: true
    }
  };
  fs.writeFileSync(path.join(tmpDir, 'firebase.json'), JSON.stringify(config, null, 2));
  const logPath = path.join(tmpDir, 'emulators.log');
  const logFd = fs.openSync(logPath, 'w');
  // One command string (not an args array) — Node warns about the latter with
  // shell:true, and the shell is needed to resolve firebase.cmd on Windows.
  const proc = spawn(`firebase emulators:start --only auth,firestore --project ${PROJECT_ID} --config firebase.json`, {
    cwd: tmpDir, shell: true, stdio: ['ignore', logFd, logFd]
  });
  let exited = false;
  proc.once('exit', () => { exited = true; });
  try {
    await Promise.race([
      Promise.all([waitForPort(PORTS.auth), waitForPort(PORTS.firestore)]),
      new Promise((_, reject) => proc.once('exit', code => reject(new Error(`firebase emulators exited early (code ${code}). Log:\n${fs.readFileSync(logPath, 'utf8').slice(-2000)}`))))
    ]);
  } catch (err) {
    killTree(proc);
    throw err;
  }
  return {
    stop() {
      if (!exited) killTree(proc);
      try { fs.closeSync(logFd); } catch (_) {}
    }
  };
}

function killTree(proc) {
  try {
    if (process.platform === 'win32') execSync(`taskkill /pid ${proc.pid} /T /F`, { stdio: 'ignore' });
    else process.kill(-proc.pid, 'SIGKILL');
  } catch (_) {}
}

// ====== Emulator REST helpers (auth) ======
const authBase = () => `http://127.0.0.1:${PORTS.auth}`;

async function emuJson(url, body, method = 'POST') {
  const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status} ${JSON.stringify(json)}`);
  return json;
}

// Applies the emulator's pending VERIFY_EMAIL code for `email`.
async function verifyEmailViaEmulator(email) {
  const { oobCodes } = await emuJson(`${authBase()}/emulator/v1/projects/${PROJECT_ID}/oobCodes`, null, 'GET');
  const hit = [...oobCodes].reverse().find(c => c.email === email && c.requestType === 'VERIFY_EMAIL');
  if (!hit) throw new Error(`No pending verification code for ${email}`);
  await emuJson(`${authBase()}/identitytoolkit.googleapis.com/v1/accounts:update?key=fake`, { oobCode: hit.oobCode });
}

// A verified account with a display name already set (skips the sign-up UI;
// 01-login covers the real sign-up + verification screens).
async function createVerifiedUser(email, password, displayName) {
  const su = await emuJson(`${authBase()}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake`, { email, password, returnSecureToken: true });
  await emuJson(`${authBase()}/identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=fake`, { requestType: 'VERIFY_EMAIL', idToken: su.idToken });
  await verifyEmailViaEmulator(email);
  await emuJson(`${authBase()}/identitytoolkit.googleapis.com/v1/accounts:update?key=fake`, { idToken: su.idToken, displayName, returnSecureToken: false });
  return { email, password, displayName, uid: su.localId };
}

// ====== Fixtures for the app's external services ======
// The app's own current-season rule (first-api.js getCurrentFtcSeason(): the
// 2nd Saturday of September, 12:00 EST, starts the new season), so the fixture
// event always sits in the season the app defaults to.
function currentFtcSeason() {
  const now = Date.now();
  const year = new Date(now).getUTCFullYear();
  const sept1Dow = new Date(Date.UTC(year, 8, 1)).getUTCDay();
  const secondSaturday = 1 + ((6 - sept1Dow + 7) % 7) + 7;
  return now >= Date.UTC(year, 8, secondSaturday, 17, 0, 0) ? year : year - 1;
}
const FIXTURE_SEASON = String(currentFtcSeason());
const FIXTURE_OLD_SEASON = String(currentFtcSeason() - 1);
const FIXTURE_EVENT = { code: 'SMOKE1', name: 'Smoke Test Qualifier', dateStart: '2026-11-01', dateEnd: '2026-11-01', season: FIXTURE_SEASON };
// An event that only exists in the PREVIOUS season. Like the real FIRST API,
// the mocked worker only serves an event's teams/schedule under ITS season, so
// asking for it under any other season fails — which is exactly the failure a
// cross-season pin used to hit.
const FIXTURE_OLD_EVENT = { code: 'OLD1', name: 'Old Season Event', dateStart: '2025-11-01', dateEnd: '2025-11-01', season: FIXTURE_OLD_SEASON };
const FIXTURE_EVENTS = [FIXTURE_EVENT, FIXTURE_OLD_EVENT];
const FIXTURE_TEAMS = [
  { teamNumber: 101, nameShort: 'Alpha Bots', nameFull: 'Alpha Bots', schoolName: 'Alpha High', city: 'Dayton', stateProv: 'OH', country: 'USA' },
  { teamNumber: 202, nameShort: 'Beta Builders', nameFull: 'Beta Builders', schoolName: 'Beta Academy', city: 'Columbus', stateProv: 'OH', country: 'USA' },
  { teamNumber: 303, nameShort: 'Gamma Gears', nameFull: 'Gamma Gears', schoolName: 'Gamma Tech', city: 'Toledo', stateProv: 'OH', country: 'USA' }
];

function ftcScoutTeam(number) {
  const t = FIXTURE_TEAMS.find(x => x.teamNumber === Number(number));
  if (!t) return null;
  return {
    number: t.teamNumber, name: t.nameShort, location: { city: t.city, state: t.stateProv, country: t.country },
    rookieYear: 2020, website: null,
    quickStats: { season: 2025, tot: { value: 100 + t.teamNumber / 10, rank: 1 }, auto: { value: 30, rank: 1 }, dc: { value: 50, rank: 1 }, eg: { value: 20, rank: 1 }, count: 5 },
    awards: []
  };
}

async function fulfillJson(route, body, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(body) });
}

// ====== Browser plumbing ======
function patchFirebaseConfig(source) {
  const replacements = [
    [/projectId:\s*"[^"]+"/, `projectId: "${PROJECT_ID}"`],
    [/apiKey:\s*"[^"]+"/, 'apiKey: "fake-api-key"'],
    ['const auth = firebase.auth();', `const auth = firebase.auth(); auth.useEmulator('${authBase()}', { disableWarnings: true });`],
    ['const db = firebase.firestore();', `const db = firebase.firestore(); db.useEmulator('127.0.0.1', ${PORTS.firestore});`]
  ];
  let out = source;
  for (const [pattern, replacement] of replacements) {
    const next = out.replace(pattern, replacement);
    if (next === out) throw new Error(`js/firebase-config.js no longer matches the smoke harness' expectations (${pattern}) — update scripts/smoke-tests/lib/harness.js`);
    out = next;
  }
  return out;
}

async function serveCdnFromCache(route) {
  const url = route.request().url();
  const file = path.join(CDN_CACHE_DIR, crypto.createHash('sha1').update(url).digest('hex'));
  const metaFile = file + '.type';
  if (fs.existsSync(file)) {
    return route.fulfill({ status: 200, contentType: fs.readFileSync(metaFile, 'utf8'), body: fs.readFileSync(file) });
  }
  const response = await route.fetch();
  const body = await response.body();
  if (response.ok()) {
    fs.mkdirSync(CDN_CACHE_DIR, { recursive: true });
    fs.writeFileSync(file, body);
    fs.writeFileSync(metaFile, response.headers()['content-type'] || 'application/javascript');
  }
  return route.fulfill({ response, body });
}

async function installRoutes(context, state) {
  await context.route('**/js/firebase-config.js', async route => {
    const original = fs.readFileSync(path.join(REPO_ROOT, 'js', 'firebase-config.js'), 'utf8');
    await route.fulfill({ status: 200, contentType: 'application/javascript', body: patchFirebaseConfig(original) });
  });

  await context.route(url => /gstatic\.com\/firebasejs|cdn\.jsdelivr\.net/.test(url.href), serveCdnFromCache);

  await context.route(`${WORKER_ORIGIN}/**`, async route => {
    const u = new URL(route.request().url());
    state.workerRequests.push(u.pathname + u.search);
    const season = u.searchParams.get('season');
    const eventCode = u.searchParams.get('eventCode');
    const event = FIXTURE_EVENTS.find(e => e.code === eventCode);
    const eventInSeason = !!event && event.season === season;
    if (u.pathname === '/events') return fulfillJson(route, { events: FIXTURE_EVENTS.filter(e => e.season === season).map(({ season: _s, ...e }) => e) });
    if (u.pathname === '/teams') {
      return eventInSeason ? fulfillJson(route, { teams: FIXTURE_TEAMS }) : fulfillJson(route, { error: `FIRST API error 404: event ${eventCode} not found in season ${season}` }, 500);
    }
    if (u.pathname === '/schedule') {
      return eventInSeason ? fulfillJson(route, { schedule: [] }) : fulfillJson(route, { error: `FIRST API error 404: event ${eventCode} not found in season ${season}` }, 500);
    }
    if (u.pathname === '/season') return fulfillJson(route, { gameName: 'SMOKE' });
    return fulfillJson(route, { error: 'smoke-test: unmocked worker path ' + u.pathname }, 404);
  });

  await context.route('https://api.ftcscout.org/graphql', async route => {
    const query = (JSON.parse(route.request().postData() || '{}').query) || '';
    state.ftcScoutRequests.push(query);
    const aliased = [...query.matchAll(/t_(\d+)\s*:\s*teamByNumber/g)].map(m => m[1]);
    if (aliased.length > 0) {
      const data = {};
      aliased.forEach(n => { data[`t_${n}`] = ftcScoutTeam(n); });
      return fulfillJson(route, { data });
    }
    const single = query.match(/teamByNumber\(number:\s*(\d+)\)/);
    if (single) return fulfillJson(route, { data: { teamByNumber: ftcScoutTeam(single[1]) } });
    return fulfillJson(route, { data: {} }); // anything else (e.g. match scores) -> empty
  });

  // Everything else off-box (Google sign-in script, feedback worker, fonts, ...)
  // is aborted so a smoke run never depends on, or talks to, live services.
  await context.route(url => {
    const h = url.hostname;
    return !['127.0.0.1', 'localhost'].includes(h) && !/gstatic\.com|cdn\.jsdelivr\.net|api\.ftcscout\.org/.test(h) && h !== new URL(WORKER_ORIGIN).hostname;
  }, route => {
    state.blockedRequests.push(route.request().url());
    return route.abort();
  });
}

async function launchBrowser() {
  return chromium.launch({ headless: process.env.SMOKE_HEADED !== '1' });
}

async function newPage(browser, baseUrl, state, label) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block', baseURL: baseUrl });
  await installRoutes(context, state);
  const page = await context.newPage();
  page.on('pageerror', err => state.pageErrors.push(`[${label}] ${err.message}`));
  page.on('console', msg => { if (msg.type() === 'error') state.consoleErrors.push(`[${label}] ${msg.text()}`); });
  page.setDefaultTimeout(15000);
  return { page, context };
}

async function screenshotOnFailure(page, name) {
  try {
    fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, `${name}.png`), fullPage: true });
  } catch (_) {}
}

// ====== Rules tests: a rules-unit-testing environment pointed at the SAME
// emulator, loading the repo's real firestore.rules (never a copy). Rules
// tests use unique team/user IDs instead of clearing Firestore, since the
// emulator is shared with the browser tests. ======
async function createRulesTestEnv() {
  const { initializeTestEnvironment } = require('@firebase/rules-unit-testing');
  return initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      host: '127.0.0.1',
      port: PORTS.firestore,
      rules: fs.readFileSync(path.join(REPO_ROOT, 'firestore.rules'), 'utf8')
    }
  });
}

module.exports = {
  REPO_ROOT, PROJECT_ID, PORTS, FIXTURE_EVENT, FIXTURE_OLD_EVENT, FIXTURE_SEASON, FIXTURE_OLD_SEASON, FIXTURE_TEAMS,
  startStaticServer, startEmulators, launchBrowser, newPage, screenshotOnFailure,
  createVerifiedUser, verifyEmailViaEmulator, createRulesTestEnv
};
