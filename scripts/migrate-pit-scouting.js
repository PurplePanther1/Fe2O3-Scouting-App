// ====== Migrate pitScouting entries from the flat top-level "pitScouting"
// collection into teams/{teamId}/pitScouting/{docId} subcollections.
//
// COPY-ONLY: never writes to, updates, or deletes anything in the flat
// "pitScouting" collection — only reads from it. matchScouting is untouched
// entirely; this script is pit-only.
//
// IDEMPOTENT: every doc is written to the same destination path
// (teams/{teamId}/pitScouting/{sourceDocId}) every run, via a full
// .set() overwrite — re-running just re-copies identical source data over
// itself. No duplicates, no accumulation, safe to run twice (once now, once
// again right before the app switches over to reading the new path).
//
// Groups by each doc's own `teamId` FIELD, never by parsing the doc ID.
// Old-era doc IDs (`${eventCode}_${teamNumber}`) don't encode a teamId at
// all — that's the exact ambiguity that caused the cross-team collision bug
// fixed in an earlier commit, so this deliberately never guesses a
// destination team from the ID shape. A doc with no usable teamId field is
// skipped and reported, never silently dropped or guessed at.
// ======

const path = require('path');
// firebase-admin@14 no longer exposes the old namespaced API (admin.credential,
// admin.firestore()) off the top-level `require('firebase-admin')` import —
// that surface is gone in this version. The modular API below is what's
// actually installed (verified against scripts/node_modules/firebase-admin@14.3.0).
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

const serviceAccount = require(path.join(__dirname, 'serviceAccountKey.json'));

const app = initializeApp({
  credential: cert(serviceAccount)
});

const db = getFirestore(app);

async function migratePitScouting() {
  console.log(`Project: ${serviceAccount.project_id}`);
  console.log('Reading flat "pitScouting" collection...');

  const snap = await db.collection('pitScouting').get();
  console.log(`Read ${snap.size} doc(s) from pitScouting.\n`);

  const skipped = []; // { id, reason }
  const failed = [];  // { id, error }
  let succeeded = 0;
  let attempted = 0;

  const bulkWriter = db.bulkWriter();

  bulkWriter.onWriteResult(() => {
    succeeded++;
  });

  bulkWriter.onWriteError((error) => {
    // Let the BulkWriter's built-in retry handle transient errors; only
    // give up (and record as a real failure) once it's exhausted its
    // default retry budget.
    if (error.failedAttempts < 5) {
      return true;
    }
    failed.push({ id: error.documentRef.id, error: error.message });
    return false;
  });

  for (const doc of snap.docs) {
    const data = doc.data();
    const teamId = data.teamId;

    if (typeof teamId !== 'string' || teamId.trim() === '') {
      skipped.push({ id: doc.id, reason: `missing/invalid teamId field (got: ${JSON.stringify(teamId)})` });
      continue;
    }

    const destRef = db.collection('teams').doc(teamId).collection('pitScouting').doc(doc.id);
    bulkWriter.set(destRef, data);
    attempted++;
  }

  await bulkWriter.close();

  console.log('====== Migration summary ======');
  console.log(`Read from flat pitScouting:        ${snap.size}`);
  console.log(`Attempted (had a valid teamId):    ${attempted}`);
  console.log(`Written to subcollections:         ${succeeded}`);
  console.log(`Skipped (missing/invalid teamId):  ${skipped.length}`);
  console.log(`Failed writes:                     ${failed.length}`);

  if (skipped.length > 0) {
    console.log('\n--- Skipped docs (not migrated — investigate manually) ---');
    skipped.forEach(s => console.log(`  ${s.id}: ${s.reason}`));
  }

  if (failed.length > 0) {
    console.log('\n--- Failed writes (not migrated — investigate and re-run) ---');
    failed.forEach(f => console.log(`  ${f.id}: ${f.error}`));
  }

  if (skipped.length === 0 && failed.length === 0) {
    console.log('\nAll docs migrated cleanly. The flat collection was not modified — safe to re-run any time.');
  } else {
    console.log('\nCompleted with issues — see above. The flat collection was not modified; fix the underlying issue and re-run.');
  }
}

migratePitScouting()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Migration script failed:', err);
    process.exit(1);
  });
