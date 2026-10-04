// ====== Match View: Live/Final Match Scores (wishlist item 31) ======
// Score summary + hierarchical breakdown for the Match-Based View
// (match-schedule-view.js), sourced from FTCScout's public GraphQL API
// (ftcscout.js's graphQL() helper) — not the FIRST Events API/worker, since
// FTCScout already exposes a full per-alliance score breakdown for the
// currently selected event's matches and is already called directly
// client-side elsewhere in this app (no worker/credential changes needed).
//
// Investigated before building this: neither FTCScout nor the FIRST Events
// API expose true mid-match live telemetry — both only reflect a match's
// score once FIRST has published the result. So "live" here means "shows up
// shortly after FIRST publishes it."
//
// Auto-fetches once per event (on selection), then caches — two layers,
// mirroring first-api.js's getEventSchedule() cache exactly:
//   1. In-memory (matchScoresCacheByEvent, keyed by eventCode) — instant
//      re-display when switching back to an event visited earlier this
//      session, no network/Firestore round-trip at all.
//   2. Firestore (events/{eventCode}.matchScores, same doc/merge-write
//      pattern as .schedule), so other sessions/users don't all hit FTCScout
//      independently, and a page refresh doesn't lose it either. Same 1-hour
//      TTL as the schedule cache — except once an event is finished, its
//      scores never go stale, so the TTL is skipped entirely at that point.
// The manual "Refresh Scores" button always forces a fresh FTCScout fetch
// (bypassing both cache layers) — for explicitly re-checking an in-progress
// event; it's not needed for the first load anymore, and disables once the
// event is finished (re-fetching a finished result can't change it).

const MATCH_SCORES_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour — same as getEventSchedule()'s CACHE_TTL_MS

// In-memory session cache — "{season}_{eventCode}" -> { scoresByNumber, finished }.
// Keyed by season as well as event code since FIRST reuses event codes
// across seasons for recurring events (same reasoning as the Firestore
// events/{eventCode} doc's `season`/`matchScoresSeason` fields below) — an
// in-session season switch must not show a stale season's scores for a
// reused code. Deliberately never cleared on event switch (unlike the
// current* vars below) so switching away and back within the same session
// is instant.
let matchScoresCacheByEvent = {};

// What's currently displayed — mirrors whichever event is selected right
// now. Kept separate from the cache above so resetMatchScores() can blank
// the display without losing other events' cached data.
let currentMatchScoresByNumber = {};
let currentEventScoresFinished = false;
let currentMatchScoresEventCode = null;
let matchScoresFetchInFlight = false;

// Guards against a stale response landing after the user has already
// switched events (or reset the view) while a fetch was in flight —
// incremented on every reset/event-switch, checked before applying results
// to the CURRENT display (the cache itself is still written either way,
// since that data is valid regardless of what's on screen at the moment it
// arrives).
let matchScoresFetchToken = 0;

// ====== Called from match-schedule-view.js's resetMatchScheduleView() —
// event change means the display no longer reflects any single event until
// onMatchScoresEventSelected() (below) runs for the new one. Does NOT touch
// matchScoresCacheByEvent — that's session-lifetime, not per-event-view. ======
function resetMatchScores() {
  currentMatchScoresByNumber = {};
  currentEventScoresFinished = false;
  currentMatchScoresEventCode = null;
  matchScoresFetchInFlight = false;
  matchScoresFetchToken++;
  updateMatchScoresControl('');
}

// ====== Called from match-schedule-view.js's onMatchScheduleEventSelected()
// hook — auto-loads scores for the newly selected event with no button click
// required. A session-cache hit applies synchronously; otherwise this falls
// through to the Firestore cache and, failing that, a live FTCScout fetch. ======
function onMatchScoresEventSelected(eventCode) {
  // A scrimmage has no FIRST/FTCScout scores, and its code must never reach
  // FTCScout or the global events/ collection.
  if (isScrimmageCode(eventCode)) return;
  currentMatchScoresEventCode = eventCode;
  const myToken = ++matchScoresFetchToken;

  const season = Number(typeof getSelectedSeason === 'function' ? getSelectedSeason() : null);
  const cached = matchScoresCacheByEvent[`${season}_${eventCode}`];
  if (cached) {
    applyScoresToDisplay(eventCode, cached.scoresByNumber, cached.finished, myToken);
    return;
  }

  loadMatchScoresForEvent(eventCode, myToken);
}

// ====== Firestore-cache-first load, falling back to a live fetch — same
// shape as getEventSchedule() (first-api.js): check events/{eventCode} for a
// cached field first, and only hit the external API if that's missing/stale. ======
async function loadMatchScoresForEvent(eventCode, myToken) {
  if (isScrimmageCode(eventCode)) return;
  const season = Number(typeof getSelectedSeason === 'function' ? getSelectedSeason() : null);
  try {
    const eventRef = db.collection('events').doc(eventCode);
    const doc = await eventRef.get();
    if (doc.exists) {
      const data = doc.data();
      // Event codes repeat across seasons (see first-api.js's
      // cacheEventToFirestore()/getCachedEvent() comments) — matchScoresSeason
      // guards against serving a prior season's scores for a reused code.
      if (data.matchScores !== undefined && data.matchScoresSeason === season) {
        const cachedAt = data.matchScoresCachedAt ? data.matchScoresCachedAt.toMillis() : 0;
        const age = Date.now() - cachedAt;
        // A finished event's scores can never change, so its cache never
        // goes stale regardless of age — only an unfinished event's cache is
        // subject to the normal TTL.
        const stillFresh = data.matchScoresFinished === true || age < MATCH_SCORES_CACHE_TTL_MS;
        if (stillFresh) {
          matchScoresCacheByEvent[`${season}_${eventCode}`] = { scoresByNumber: data.matchScores, finished: !!data.matchScoresFinished };
          applyScoresToDisplay(eventCode, data.matchScores, !!data.matchScoresFinished, myToken);
          return;
        }
      }
    }
  } catch (err) {
    console.warn('Failed to read cached match scores, falling back to live fetch:', err);
  }

  await fetchAndCacheMatchScores(eventCode, myToken);
}

// ====== Live FTCScout fetch, shared by the auto-load path above and the
// manual Refresh Scores button below. Writes the result into both cache
// layers before applying it to the display (if this is still the event
// being viewed). ======
async function fetchAndCacheMatchScores(eventCode, myToken) {
  if (isScrimmageCode(eventCode)) return; // never query FTCScout / events/ with a scrimmage code
  const season = Number(typeof getSelectedSeason === 'function' ? getSelectedSeason() : null);
  if (!season) return;

  matchScoresFetchInFlight = true;
  if (myToken === matchScoresFetchToken) updateMatchScoresControl('Fetching scores...');

  try {
    // The score breakdown's shape is a season-typed union member
    // (MatchScores2025, MatchScores2024, ...) — the inline fragment name is
    // built from the selected season since GraphQL can't select fields on a
    // union without one. If FTCScout hasn't defined a type for this season
    // yet, the query itself fails and is caught below as "scores
    // unavailable" rather than crashing the view. Every field requested here
    // is confirmed present on MatchScores2022Alliance through
    // MatchScores2025Alliance — see match-scores.js's breakdown-tree builder
    // for exactly which ones some older seasons' games didn't have (e.g. no
    // "Depot" category before this game's rules introduced one — those
    // fields are always 0 for a season that never had that category, not
    // missing, since the schema field itself is common across seasons).
    const data = await graphQL(`{
      eventByCode(season: ${season}, code: ${JSON.stringify(eventCode)}) {
        finished
        matches {
          matchNum
          tournamentLevel
          hasBeenPlayed
          scores {
            __typename
            ... on MatchScores${season} {
              red { ${MATCH_SCORE_ALLIANCE_FIELDS} }
              blue { ${MATCH_SCORE_ALLIANCE_FIELDS} }
            }
          }
        }
      }
    }`);

    const event = data?.eventByCode;
    const scoresByNumber = {};
    (event?.matches || []).forEach(m => {
      // Match View only ever shows qualification matches (same scope as the
      // schedule fetch this joins onto, first-api.js's getEventSchedule()).
      if (m.tournamentLevel !== 'Quals') return;
      if (!m.hasBeenPlayed || !m.scores) return;
      scoresByNumber[m.matchNum] = { red: m.scores.red, blue: m.scores.blue };
    });
    const finished = !!event?.finished;

    matchScoresCacheByEvent[`${season}_${eventCode}`] = { scoresByNumber, finished };
    writeMatchScoresToFirestore(eventCode, scoresByNumber, finished, season);

    applyScoresToDisplay(eventCode, scoresByNumber, finished, myToken);
  } catch (err) {
    console.warn('Failed to fetch match scores from FTCScout:', err);
    if (myToken === matchScoresFetchToken && eventCode === currentMatchScoresEventCode) {
      updateMatchScoresControl('Could not load scores. Check your connection and try again.');
    }
  } finally {
    matchScoresFetchInFlight = false;
    if (myToken === matchScoresFetchToken) updateMatchScoresControl();
  }
}

// ====== Every alliance-score field this app's breakdown modal renders,
// shared between the GraphQL query above and buildBreakdownTree() below so
// the two can't drift out of sync. ======
const MATCH_SCORE_ALLIANCE_FIELDS = `totalPoints autoPoints dcPoints
  autoLeavePoints autoLeave1 autoLeave2
  autoArtifactPoints autoArtifactClassifiedPoints autoArtifactOverflowPoints
  autoPatternPoints
  dcBasePoints dcBase1 dcBase2
  dcArtifactPoints dcArtifactClassifiedPoints dcArtifactOverflowPoints
  dcPatternPoints dcDepotPoints
  penaltyPointsCommitted majorsCommitted minorsCommitted
  movementRp goalRp patternRp`;

// ====== Ranking-point criteria (wishlist item 31 follow-up) — confirmed via
// live FTCScout schema introspection: MatchScores2025Alliance exposes exactly
// these 3 boolean flags per alliance per match (movementRp/goalRp/patternRp),
// each true when that alliance met the criterion in THIS match. No separate
// metadata endpoint describes icon/display names, so the labels here are
// derived from FTCScout's own field names. ======
const RANKING_POINT_CRITERIA = [
  { key: 'movementRp', label: 'Movement RP' },
  { key: 'goalRp', label: 'Goal RP' },
  { key: 'patternRp', label: 'Pattern RP' }
];

// ====== Merge-write onto the same events/{eventCode} doc getEventSchedule()
// already caches .schedule/.scheduleCachedAt on — same "skip if the doc
// doesn't exist yet" guard as that function, for the same reason
// (firestore.rules' write rule needs request.resource.data.name to already
// be a string on the RESULTING document; if the doc doesn't exist yet this
// merge-write would have no name and get denied — see getEventSchedule()'s
// comment in first-api.js for how that was confirmed against the real
// rules). In practice the doc always exists by the time this runs (selectEvent()
// caches name+ftcTeams before schedule/scores are ever fetched). ======
async function writeMatchScoresToFirestore(eventCode, scoresByNumber, finished, season) {
  if (isScrimmageCode(eventCode)) return;
  try {
    const eventRef = db.collection('events').doc(eventCode);
    const doc = await eventRef.get();
    if (!doc.exists) return;
    await eventRef.set({
      matchScores: scoresByNumber,
      matchScoresFinished: finished,
      matchScoresSeason: season,
      matchScoresCachedAt: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  } catch (err) {
    console.warn('Failed to cache match scores to Firestore:', err);
  }
}

// ====== Apply a resolved scores payload to the CURRENT display — guarded on
// both the fetch token and the event code, since a slow response (Firestore
// read or FTCScout fetch) can land after the user has already switched to a
// different event; the cache write above already happened regardless. ======
function applyScoresToDisplay(eventCode, scoresByNumber, finished, myToken) {
  if (myToken !== matchScoresFetchToken || eventCode !== currentMatchScoresEventCode) return;

  currentMatchScoresByNumber = scoresByNumber;
  currentEventScoresFinished = finished;

  const playedCount = Object.keys(scoresByNumber).length;
  const asOf = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  updateMatchScoresControl(finished
    ? `Event finished — scores final (${playedCount} match(es) played).`
    : `${playedCount} match(es) played as of ${asOf}.`);

  if (typeof refreshMatchScheduleScoreBadges === 'function') refreshMatchScheduleScoreBadges();
}

// ====== Manual "Refresh Scores" button — always forces a live re-fetch for
// whichever event is currently selected, bypassing both cache layers. Not
// required for the first load anymore (onMatchScoresEventSelected() above
// handles that automatically); this is for explicitly re-checking an
// in-progress event. ======
async function refreshMatchScores() {
  if (!selectedEvent?.code || selectedEvent.isScrimmage || matchScoresFetchInFlight || currentEventScoresFinished) return;
  await fetchAndCacheMatchScores(selectedEvent.code, matchScoresFetchToken);
}

// ====== What to show a given match number, or null if nothing's cached for
// it yet (not fetched, or the match hasn't been played). ======
function getMatchScoreSummary(matchNumber) {
  return currentMatchScoresByNumber[matchNumber] || null;
}

// ====== Sync the Refresh Scores button + status line to current state.
// statusOverride, when given, replaces the normal status text for this one
// call (e.g. "Fetching scores..." while in flight) without needing separate
// state for it. ======
function updateMatchScoresControl(statusOverride) {
  const btn = document.getElementById('btn-refresh-match-scores');
  const status = document.getElementById('match-scores-status');

  if (btn) {
    btn.disabled = matchScoresFetchInFlight || currentEventScoresFinished;
    btn.textContent = currentEventScoresFinished ? 'Scores Final' : (matchScoresFetchInFlight ? 'Refreshing...' : '🔄 Refresh Scores');
  }
  if (status && statusOverride !== undefined) {
    status.textContent = statusOverride;
  }
}

// ====== Score Breakdown Modal ======
function openMatchScoreBreakdownModal(matchNumber) {
  const summary = getMatchScoreSummary(matchNumber);
  if (!summary) return;

  const match = currentEventSchedule.find(m => Number(m.matchNumber) === Number(matchNumber));
  const titleEl = document.getElementById('match-score-modal-title');
  if (titleEl) titleEl.textContent = match?.description || `Match ${matchNumber}`;

  const body = document.getElementById('match-score-modal-body');
  if (body) {
    body.innerHTML = '';
    body.appendChild(buildScoreBreakdownTree(summary, match));
    body.appendChild(buildRankingPointsSection(summary));
  }

  const modal = document.getElementById('match-score-modal');
  if (modal) modal.classList.remove('hidden');
}

function closeMatchScoreBreakdownModal() {
  const modal = document.getElementById('match-score-modal');
  if (modal) modal.classList.add('hidden');
}

// ====== Per-robot leave/base points for one alliance color, one category
// prefix ('autoLeave' or 'dcBase') — FTCScout's *1/*2 fields are literally
// each station's own point contribution (confirmed against real match data:
// e.g. autoLeave1=0, autoLeave2=3, autoLeavePoints=3), so this is the
// closest thing FTCScout's API has to a "per-robot indicator": not a
// did-it-happen flag, but that robot's own points within the category.
// Paired with the real team number at that station (from the schedule this
// modal joins onto by match number) so it's clear which robot is which. ======
function perRobotChildren(prefix, summary, match) {
  if (!match || typeof getAllianceTeams !== 'function') return [];
  const { red, blue } = getAllianceTeams(match);
  return [1, 2].map(station => ({
    label: `Robot ${station}`,
    red: summary.red[`${prefix}${station}`],
    blue: summary.blue[`${prefix}${station}`],
    redSubLabel: red[station - 1] ? `#${red[station - 1].teamNumber}` : '',
    blueSubLabel: blue[station - 1] ? `#${blue[station - 1].teamNumber}` : ''
  }));
}

// ====== The full hierarchy — closely follows FTCScout's own score-breakdown
// layout: Auto Points -> Leave/Artifacts/Pattern, DC Points ->
// Base/Artifacts/Pattern/Depot, Penalties, Total. Every field referenced
// here is confirmed present on FTCScout's MatchScores*Alliance types (see
// MATCH_SCORE_ALLIANCE_FIELDS above, and match-scores.js's header comment).
//
// One deliberate deviation from the literal ask: "Majors Points"/"Minors
// Points" as separate POINT subtotals aren't available — FTCScout only
// exposes major/minor foul COUNTS (majorsCommitted/minorsCommitted) plus one
// combined penaltyPointsCommitted total, not a per-category point split. So
// those two rows show counts (labeled "Majors Committed"/"Minors
// Committed"), nested under the real point total. ======
function buildBreakdownTree(summary, match) {
  return [
    {
      label: 'Auto Points', red: summary.red.autoPoints, blue: summary.blue.autoPoints,
      children: [
        { label: 'Leave Points', red: summary.red.autoLeavePoints, blue: summary.blue.autoLeavePoints,
          children: perRobotChildren('autoLeave', summary, match) },
        { label: 'Artifacts', red: summary.red.autoArtifactPoints, blue: summary.blue.autoArtifactPoints,
          children: [
            { label: 'Classified', red: summary.red.autoArtifactClassifiedPoints, blue: summary.blue.autoArtifactClassifiedPoints },
            { label: 'Overflow', red: summary.red.autoArtifactOverflowPoints, blue: summary.blue.autoArtifactOverflowPoints }
          ] },
        { label: 'Pattern', red: summary.red.autoPatternPoints, blue: summary.blue.autoPatternPoints }
      ]
    },
    {
      label: 'DC Points', red: summary.red.dcPoints, blue: summary.blue.dcPoints,
      children: [
        { label: 'Base Points', red: summary.red.dcBasePoints, blue: summary.blue.dcBasePoints,
          children: perRobotChildren('dcBase', summary, match) },
        { label: 'Artifacts', red: summary.red.dcArtifactPoints, blue: summary.blue.dcArtifactPoints,
          children: [
            { label: 'Classified', red: summary.red.dcArtifactClassifiedPoints, blue: summary.blue.dcArtifactClassifiedPoints },
            { label: 'Overflow', red: summary.red.dcArtifactOverflowPoints, blue: summary.blue.dcArtifactOverflowPoints }
          ] },
        { label: 'Pattern', red: summary.red.dcPatternPoints, blue: summary.blue.dcPatternPoints },
        { label: 'Depot', red: summary.red.dcDepotPoints, blue: summary.blue.dcDepotPoints }
      ]
    },
    {
      label: 'Penalties', red: summary.red.penaltyPointsCommitted, blue: summary.blue.penaltyPointsCommitted,
      children: [
        { label: 'Majors Committed', red: summary.red.majorsCommitted, blue: summary.blue.majorsCommitted },
        { label: 'Minors Committed', red: summary.red.minorsCommitted, blue: summary.blue.minorsCommitted }
      ]
    },
    { label: 'Total', red: summary.red.totalPoints, blue: summary.blue.totalPoints, isTotal: true }
  ];
}

function buildScoreBreakdownTree(summary, match) {
  const container = document.createElement('div');
  container.className = 'msb-tree';

  const header = document.createElement('div');
  header.className = 'msb-columns';
  const blank1 = document.createElement('span');
  const blank2 = document.createElement('span');
  const redHead = document.createElement('span');
  redHead.className = 'msb-red';
  redHead.textContent = 'Red';
  const blueHead = document.createElement('span');
  blueHead.className = 'msb-blue';
  blueHead.textContent = 'Blue';
  [blank1, blank2, redHead, blueHead].forEach(el => header.appendChild(el));
  container.appendChild(header);

  buildBreakdownTree(summary, match).forEach(node => container.appendChild(buildTreeNode(node)));
  return container;
}

// ====== Ranking-point icon row, at the bottom of the breakdown modal (below
// the point tree) — one row per criterion, each with a red-side and
// blue-side icon: filled/colored if that alliance met it in this match,
// dimmed/grey if not. Same 4-column grid as the tree above (blank caret
// column | label | red | blue) for visual alignment, even though nothing
// here expands. ======
function buildRankingPointsSection(summary) {
  const section = document.createElement('div');
  section.className = 'msb-rp-section';

  const heading = document.createElement('div');
  heading.className = 'msb-rp-heading';
  heading.textContent = 'Ranking Points';
  section.appendChild(heading);

  RANKING_POINT_CRITERIA.forEach(rp => {
    const row = document.createElement('div');
    row.className = 'msb-rp-row';

    const blank = document.createElement('span');
    const label = document.createElement('span');
    label.className = 'msb-rp-label';
    label.textContent = rp.label;

    row.appendChild(blank);
    row.appendChild(label);
    row.appendChild(buildRpIcon('red', !!summary.red[rp.key]));
    row.appendChild(buildRpIcon('blue', !!summary.blue[rp.key]));
    section.appendChild(row);
  });

  return section;
}

function buildRpIcon(color, achieved) {
  const icon = document.createElement('span');
  icon.className = `msb-rp-icon msb-rp-${color}` + (achieved ? ' achieved' : '');
  icon.textContent = '●';
  icon.title = achieved ? 'Achieved' : 'Not achieved';
  return icon;
}

function buildValueCell(color, value, subLabel) {
  const cell = document.createElement('span');
  cell.className = `msb-val msb-${color}`;
  cell.textContent = value;
  if (subLabel) {
    const sub = document.createElement('span');
    sub.className = 'msb-sub-label';
    sub.textContent = subLabel;
    cell.appendChild(sub);
  }
  return cell;
}

function buildTreeNode(node) {
  const hasChildren = node.children && node.children.length > 0;

  const wrap = document.createElement('div');
  wrap.className = 'msb-node' + (node.isTotal ? ' msb-total' : '');

  const row = document.createElement('div');
  row.className = 'msb-row' + (hasChildren ? '' : ' no-children');

  const caret = document.createElement('button');
  caret.type = 'button';
  caret.className = 'msb-caret';
  caret.textContent = hasChildren ? '▸' : '';
  caret.disabled = !hasChildren;
  caret.setAttribute('aria-label', hasChildren ? `Expand ${node.label}` : '');

  const label = document.createElement('span');
  label.className = 'msb-label';
  label.textContent = node.label;

  row.appendChild(caret);
  row.appendChild(label);
  row.appendChild(buildValueCell('red', node.red, node.redSubLabel));
  row.appendChild(buildValueCell('blue', node.blue, node.blueSubLabel));
  wrap.appendChild(row);

  if (hasChildren) {
    const childrenWrap = document.createElement('div');
    childrenWrap.className = 'msb-children collapsed';
    node.children.forEach(child => childrenWrap.appendChild(buildTreeNode(child)));
    wrap.appendChild(childrenWrap);

    const toggle = () => {
      const collapsed = childrenWrap.classList.toggle('collapsed');
      caret.textContent = collapsed ? '▸' : '▾';
    };
    row.addEventListener('click', toggle);
  }

  return wrap;
}

document.addEventListener('DOMContentLoaded', () => {
  const refreshBtn = document.getElementById('btn-refresh-match-scores');
  if (refreshBtn) refreshBtn.addEventListener('click', refreshMatchScores);

  const closeBtn = document.getElementById('btn-match-score-close');
  if (closeBtn) closeBtn.addEventListener('click', closeMatchScoreBreakdownModal);

  const overlay = document.getElementById('match-score-modal-overlay');
  if (overlay) overlay.addEventListener('click', closeMatchScoreBreakdownModal);
});
