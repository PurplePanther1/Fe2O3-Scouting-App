// Bump this when static assets change meaningfully, to bust the old cache.
//
// Bug fix: bumped v1 -> v2 alongside switching the fetch handler below from
// cache-first to network-first (see that handler's own comment). v1's
// combination of "cache-first" + a CACHE_NAME that never changed meant every
// JS file in SHELL_ASSETS below was served from whatever a browser cached on
// its FIRST visit to this site, forever — the browser never even fetched a
// changed file after that, since cache-first returns the cached response
// without waiting on the network at all, and the network fetch (which DID
// update the cache) had already lost the race by the time it resolved.
// Because sw.js's own bytes never changed across three straight rounds of
// deploys, no browser that had already installed it ever detected an update
// either, so this was invisible in every one of those rounds' real-account
// testing regardless of how correct the actual fix was — a returning
// tester's browser was simply never running the new code. Bumping the
// version here changes this file's bytes, which is what makes a browser's
// normal update check (on next navigation) notice a new worker at all.
const CACHE_VERSION = 'v2';
const CACHE_NAME = `fe2o3-shell-${CACHE_VERSION}`;

const SHELL_ASSETS = [
  '/scouting/',
  '/css/style.css',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/js/firebase-config.js',
  '/js/auth.js',
  '/js/activity-log.js',
  '/js/team.js',
  '/js/members.js',
  '/js/first-api.js',
  '/js/session-state.js',
  '/js/pinned-events.js',
  '/js/ftcscout.js',
  '/js/dynamic-form.js',
  '/js/live-entry-sync.js',
  '/js/pit-scout.js',
  '/js/match-scout.js',
  '/js/match-schedule-view.js',
  '/js/match-scores.js',
  '/js/team-info.js',
  '/js/match-scouted-modal.js',
  '/js/form-builder.js',
  '/js/app.js',
  '/js/sheets-export.js',
  '/js/pit-vs-match.js',
  '/js/delete-account.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(
        names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Only handle same-origin GET requests — never touch Firebase/Google/CDN
  // calls or writes, so live sync and auth are unaffected by this cache.
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) {
    return;
  }

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(() => caches.match('/scouting/'))
    );
    return;
  }

  // Bug fix: this was cache-first (try the cache, only fall back to network
  // on a cache miss, with the network response silently updating the cache
  // for NEXT time) — see CACHE_VERSION's own comment for the full incident.
  // That's backwards for an app with no build step or content-hashed
  // filenames, actively being iterated on: it means a deployed fix is never
  // visible to a browser that already has a cached copy, for as long as that
  // cache entry exists (effectively forever, since nothing else here evicts
  // it). Network-first preserves the actual reason this exists — usable
  // scouting data entry when competition WiFi drops mid-event (db.js's own
  // enablePersistence() comment) — while making the common "online" case
  // always reflect whatever's actually deployed: try the network first,
  // update the cache with whatever comes back, and only serve the (possibly
  // stale, better-than-nothing) cached copy if the network request itself
  // fails outright.
  event.respondWith(
    fetch(req).then((res) => {
      if (res && res.ok) {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
      }
      return res;
    }).catch(() => caches.match(req))
  );
});
