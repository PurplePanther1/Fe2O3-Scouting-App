// ====== READ-ONLY count of every pit/match scouting entry across every
// team, broken down by team, split into "committed" (has real scouted
// data — checkpoint or scoutedBy set, same test as isEntryCommitted() in
// js/live-entry-sync.js) vs. "draft/uncommitted" (an empty shell doc with
// no real data — see the live-entry-sync.js permission-bug root-cause
// writeup this script was written alongside: a non-privileged user's Cancel
// on a live session already reverts every field to null when they're the
// last to leave, so an uncommitted doc never holds real scouted values,
// just identity fields like eventCode/teamNumber/teamId/season and an empty
// activeEditors map).
//
// NEVER WRITES ANYTHING — no .set()/.update()/.delete() anywhere in this
// file. Safe to run any time, as many times as needed.
//
// Counts BOTH storage locations currently active for each entry type (see
// migrate-pit-scouting.js/migrate-match-scouting.js's own header comments):
//   - teams/{teamId}/pitScouting, teams/{teamId}/matchScouting  (current,
//     what the app actually reads/writes today)
//   - the legacy flat top-level pitScouting/matchScouting collections (no
//     longer written by any current code path, but not yet deleted either
//     — see firestore.rules' own comment on those two match blocks)
// via a single collectionGroup() query per entry type: collectionGroup()
// matches by collection ID regardless of nesting depth, so it returns docs
// from BOTH the flat collection (path "pitScouting/{docId}", ref.parent.parent
// is null) and every team's nested subcollection (path
// "teams/{teamId}/pitScouting/{docId}", ref.parent.parent is that team doc)
// in one pass — each doc is bucketed below by inspecting which shape its own
// path actually has, not by guessing.
// ======

const path = require('path');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

const serviceAccount = require(path.join(__dirname, 'serviceAccountKey.json'));

const app = initializeApp({
  credential: cert(serviceAccount)
});

const db = getFirestore(app);

// Mirrors isEntryCommitted() in js/live-entry-sync.js exactly.
function isEntryCommitted(data) {
  return !!(data && (data.checkpoint || data.scoutedBy));
}

async function countCollection(collectionId) {
  const snap = await db.collectionGroup(collectionId).get();

  // teamId -> { committed, draft }
  const nestedByTeam = new Map();
  // teamId (from the doc's own field — may be missing/invalid) -> { committed, draft }
  const flatByTeam = new Map();
  const flatMissingTeamId = []; // doc ids with no usable teamId field

  snap.docs.forEach((doc) => {
    const data = doc.data();
    const committed = isEntryCommitted(data);
    const parentTeamDoc = doc.ref.parent.parent; // non-null only for teams/{teamId}/<collectionId>/{docId}

    if (parentTeamDoc) {
      const teamId = parentTeamDoc.id;
      const bucket = nestedByTeam.get(teamId) || { committed: 0, draft: 0 };
      if (committed) bucket.committed++; else bucket.draft++;
      nestedByTeam.set(teamId, bucket);
    } else {
      const teamId = data.teamId;
      if (typeof teamId !== 'string' || teamId.trim() === '') {
        flatMissingTeamId.push(doc.id);
        return;
      }
      const bucket = flatByTeam.get(teamId) || { committed: 0, draft: 0 };
      if (committed) bucket.committed++; else bucket.draft++;
      flatByTeam.set(teamId, bucket);
    }
  });

  return { total: snap.size, nestedByTeam, flatByTeam, flatMissingTeamId };
}

function mergeTeamIds(...maps) {
  const ids = new Set();
  maps.forEach((m) => m.forEach((_, k) => ids.add(k)));
  return ids;
}

function fmtBucket(b) {
  if (!b) return '0 (0 committed, 0 draft)';
  const total = b.committed + b.draft;
  return `${total} (${b.committed} committed, ${b.draft} draft)`;
}

async function main() {
  console.log(`Project: ${serviceAccount.project_id}`);
  console.log('Reading teams collection (for name lookup)...');
  const teamsSnap = await db.collection('teams').get();
  const teamNames = new Map();
  teamsSnap.forEach((d) => teamNames.set(d.id, d.data().name || '(unnamed team)'));
  console.log(`${teamsSnap.size} team(s) found.\n`);

  console.log('Reading pitScouting (collectionGroup — nested + flat)...');
  const pit = await countCollection('pitScouting');
  console.log(`Read ${pit.total} pitScouting doc(s) total.\n`);

  console.log('Reading matchScouting (collectionGroup — nested + flat)...');
  const match = await countCollection('matchScouting');
  console.log(`Read ${match.total} matchScouting doc(s) total.\n`);

  const allTeamIds = mergeTeamIds(pit.nestedByTeam, pit.flatByTeam, match.nestedByTeam, match.flatByTeam);
  // Include every known team even if it has zero entries, so a 0-entry team
  // is visible in the breakdown rather than silently absent.
  teamNames.forEach((_, id) => allTeamIds.add(id));

  console.log('====== Per-team breakdown (nested = teams/{teamId}/..., current path) ======');
  console.log('Format: total (committed, draft/uncommitted)\n');

  const sortedTeamIds = [...allTeamIds].sort((a, b) => {
    const nameA = teamNames.get(a) || a;
    const nameB = teamNames.get(b) || b;
    return nameA.localeCompare(nameB);
  });

  let grandNestedPitCommitted = 0, grandNestedPitDraft = 0;
  let grandNestedMatchCommitted = 0, grandNestedMatchDraft = 0;
  let grandFlatPitCommitted = 0, grandFlatPitDraft = 0;
  let grandFlatMatchCommitted = 0, grandFlatMatchDraft = 0;

  sortedTeamIds.forEach((teamId) => {
    const name = teamNames.get(teamId) || '(team doc not found — id from an entry\'s own field)';
    const nestedPit = pit.nestedByTeam.get(teamId);
    const nestedMatch = match.nestedByTeam.get(teamId);
    const flatPit = pit.flatByTeam.get(teamId);
    const flatMatch = match.flatByTeam.get(teamId);

    const hasAny = nestedPit || nestedMatch || flatPit || flatMatch;
    if (!hasAny) return; // 0-entry team — skip the line, still counted in team total above

    console.log(`${name}  [${teamId}]`);
    console.log(`  pit (nested):    ${fmtBucket(nestedPit)}`);
    console.log(`  match (nested):  ${fmtBucket(nestedMatch)}`);
    if (flatPit || flatMatch) {
      console.log(`  pit (flat/legacy):   ${fmtBucket(flatPit)}`);
      console.log(`  match (flat/legacy): ${fmtBucket(flatMatch)}`);
    }

    if (nestedPit) { grandNestedPitCommitted += nestedPit.committed; grandNestedPitDraft += nestedPit.draft; }
    if (nestedMatch) { grandNestedMatchCommitted += nestedMatch.committed; grandNestedMatchDraft += nestedMatch.draft; }
    if (flatPit) { grandFlatPitCommitted += flatPit.committed; grandFlatPitDraft += flatPit.draft; }
    if (flatMatch) { grandFlatMatchCommitted += flatMatch.committed; grandFlatMatchDraft += flatMatch.draft; }
  });

  console.log('\n====== Totals ======');
  console.log(`Teams with at least one entry: ${sortedTeamIds.filter(id => pit.nestedByTeam.has(id) || match.nestedByTeam.has(id) || pit.flatByTeam.has(id) || match.flatByTeam.has(id)).length} / ${teamsSnap.size} teams`);
  console.log(`Pit (nested, current):    ${grandNestedPitCommitted + grandNestedPitDraft} total — ${grandNestedPitCommitted} committed, ${grandNestedPitDraft} draft/uncommitted`);
  console.log(`Match (nested, current):  ${grandNestedMatchCommitted + grandNestedMatchDraft} total — ${grandNestedMatchCommitted} committed, ${grandNestedMatchDraft} draft/uncommitted`);
  console.log(`Pit (flat/legacy):        ${grandFlatPitCommitted + grandFlatPitDraft} total — ${grandFlatPitCommitted} committed, ${grandFlatPitDraft} draft/uncommitted`);
  console.log(`Match (flat/legacy):      ${grandFlatMatchCommitted + grandFlatMatchDraft} total — ${grandFlatMatchCommitted} committed, ${grandFlatMatchDraft} draft/uncommitted`);

  if (pit.flatMissingTeamId.length || match.flatMissingTeamId.length) {
    console.log('\n--- Flat docs with no usable teamId field (not attributable to any team) ---');
    if (pit.flatMissingTeamId.length) console.log(`  pitScouting: ${pit.flatMissingTeamId.join(', ')}`);
    if (match.flatMissingTeamId.length) console.log(`  matchScouting: ${match.flatMissingTeamId.join(', ')}`);
  }

  console.log('\nNo data was modified — read-only.');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Count script failed:', err);
    process.exit(1);
  });
