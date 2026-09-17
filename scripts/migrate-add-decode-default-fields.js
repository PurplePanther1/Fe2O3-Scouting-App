// ====== Add each season's default fields (js/dynamic-form.js's
// getDefaultPitFields(season)/getDefaultMatchFields(season) — DECODE for
// season "2025", the original game-agnostic generic set for every other
// season) to every team's EXISTING formConfig doc that doesn't already have
// them, by field id — WITHOUT touching, reordering, or removing anything
// that team has already configured.
//
// Why this exists at all: loadSeasonScopedFormConfig() (dynamic-form.js)
// only ever falls back to the season default for a team+season with NO
// saved formConfig doc yet — a team that already has ANY doc (even one that
// happens to be identical to the generic default, which is true of every
// team's doc in this database right now except Fe2O3's just-rebuilt 2025
// docs) never reads a changed default at all, no matter how it changes in
// code. Without this migration, those teams would silently never see new
// default fields on their existing seasons.
//
// COPY-ONLY IN SPIRIT, NOT IN LITERAL SHAPE: unlike migrate-pit-scouting.js/
// migrate-match-scouting.js (which copy a doc to a new location untouched),
// this one APPENDS to an existing doc's `fields` array — but the append is
// itself non-destructive: every field already present (matched by id) is
// left byte-for-byte alone, in its existing position; only fields whose id
// isn't already present get added, at the end, in the defaults' own
// relative order, with fresh sortOrder values continuing on from the
// existing list's length (so they render after everything already there).
//
// SKIPS: Fe2O3's teams/GQQh0nPRrMTjULfdR65h/formConfig/2025_pitScouting and
// 2025_matchScouting — already replaced directly with the exact DECODE
// field set (originally written under the wrong season key, "2026", then
// moved to the confirmed-correct "2025" — DECODE was the 2025-2026 season,
// per the app's own FTC Events API game-name lookup); running this
// migration against them too would be a no-op in practice (every default
// field would already be present by id) but is excluded explicitly to keep
// the dry-run output focused on docs this migration actually changes
// anything for. Also skips the legacy un-prefixed formConfig/pitScouting
// and formConfig/matchScouting docs (no season prefix) — dead weight since
// the season-scoping migration, never read by the app for anything except a
// brand-new current-season doc's one-time inheritance, so there's nothing
// to gain by touching them.
//
// EVERY OTHER SEASON (including 2026, which is NOT DECODE — a different,
// not-yet-named game) gets the GENERIC default fields appended, same
// non-destructive rule, since that's what getDefaultMatchFields()/
// getDefaultPitFields() now resolve to for any season other than "2025".
//
// DRY RUN BY DEFAULT: `node migrate-add-decode-default-fields.js` only
// prints what WOULD change — no writes. Pass --apply to actually write.
// (No prior script in this repo has needed a dry-run flag — this one does,
// since unlike the copy-only migrations above, this one modifies documents
// that already have real, possibly team-customized data in them.)
const path = require('path');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

const serviceAccount = require(path.join(__dirname, 'serviceAccountKey.json'));
const app = initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore(app);

const APPLY = process.argv.includes('--apply');

// ====== Must exactly match js/dynamic-form.js's GENERIC_PIT_FIELDS/
// GENERIC_MATCH_FIELDS/DECODE_PIT_FIELDS/DECODE_MATCH_FIELDS and their
// SEASON_DEFAULT_*_FIELDS season-keying (copied verbatim, not required from
// that browser-only file — same reasoning as every other scripts/*.js here
// having no shared module with the client code). ======
const GENERIC_PIT_FIELDS = [
  { id: 'driveType', label: 'Drive Type', type: 'dropdown', required: true, options: ['Tank (2-motor, left/right)', 'Mecanum', 'Swerve', 'X-Drive / Omni', 'H-Drive', 'Other'], sortOrder: 0, showInPreview: true },
  { id: 'autoCapability', label: 'Auto Capability', type: 'dropdown', required: false, options: ['None (park only)', 'Basic (1 preload + park)', 'Intermediate (scoring + park)', 'Advanced (multi-cycle auto)', 'Custom / Hybrid'], sortOrder: 1, showInPreview: true },
  { id: 'claimedAvgAutoScore', label: 'Claimed Avg Auto Score', type: 'number', required: false, sortOrder: 2, showInPreview: true },
  { id: 'claimedAvgTeleopScore', label: 'Claimed Avg Teleop Score', type: 'number', required: false, sortOrder: 3, showInPreview: true },
  { id: 'claimedCycleTime', label: 'Claimed Cycle Time (seconds)', type: 'number', required: false, sortOrder: 4, showInPreview: true },
  { id: 'notes', label: 'Notes', type: 'textarea', required: false, sortOrder: 5, showInPreview: true }
];

const GENERIC_MATCH_FIELDS = [
  { id: 'matchNumber', label: 'Match Number', type: 'number', required: true, sortOrder: 0, showInPreview: false },
  { id: 'autoScore', label: 'Auto Score', type: 'number', required: false, sortOrder: 1, showInPreview: true },
  { id: 'teleopScore', label: 'Teleop Score', type: 'number', required: false, sortOrder: 2, showInPreview: true },
  { id: 'endgameScore', label: 'Endgame Score', type: 'number', required: false, sortOrder: 3, showInPreview: true },
  { id: 'cycleTime', label: 'Cycle Time (seconds)', type: 'number', required: false, sortOrder: 4, showInPreview: true },
  { id: 'notes', label: 'Notes', type: 'textarea', required: false, sortOrder: 5, showInPreview: true }
];

const DECODE_PIT_FIELDS = [
  { id: 'drivetrainType', label: 'Drivetrain type', type: 'dropdown', required: false, options: ['Mecanum', 'Tank', 'Other'], sortOrder: 0, showInPreview: true },
  { id: 'chassisSize', label: 'Chassis size', type: 'dropdown', required: false, options: ['Small', 'Big'], sortOrder: 1, showInPreview: false },
  { id: 'weightClass', label: 'Weight class', type: 'dropdown', required: false, options: ['Light', 'Medium', 'Heavy'], sortOrder: 2, showInPreview: true },
  { id: 'parkMethod', label: 'Park Method', type: 'buttonGroup', required: false, multi: false, options: ['Drive-In', 'Lift', 'Tilter', 'Other'], sortOrder: 3, showInPreview: true },
  { id: 'transferType', label: 'Transfer type', type: 'buttonGroup', required: false, multi: false, options: ['Single-Stage/Constant', 'Sorter/Indexer'], sortOrder: 4, showInPreview: false },
  { id: 'shootingRange', label: 'Shooting range', type: 'buttonGroup', required: false, multi: false, options: ['Far', 'Medium', 'Near', 'Anywhere'], sortOrder: 5, showInPreview: true },
  { id: 'artifactLoading', label: 'Artifact loading', type: 'dropdown', required: false, options: ['Human-Player Loaded', 'Self-Intake'], sortOrder: 6, showInPreview: false },
  { id: 'humanPlayerInterop', label: 'Human player interop', type: 'dropdown', required: false, options: ['Needs Own HP', 'Can Use Ours'], sortOrder: 7, showInPreview: false },
  { id: 'claimedArtifactsScoredAuto', label: 'Claimed artifacts scored (auto)', type: 'number', required: false, sortOrder: 8, showInPreview: true },
  { id: 'claimedArtifactsScoredTeleop', label: 'Claimed artifacts scored (teleop)', type: 'number', required: false, sortOrder: 9, showInPreview: true },
  { id: 'leavesLaunchLine', label: 'Leaves launch line?', type: 'dropdown', required: false, options: ['Yes', 'No'], sortOrder: 10, showInPreview: false },
  { id: 'claimedAvgSoloMatchScore', label: 'Claimed avg solo match score', type: 'number', required: false, sortOrder: 11, showInPreview: false },
  { id: 'claimedCycleTimeSec', label: 'Claimed cycle time (sec)', type: 'number', required: false, sortOrder: 12, showInPreview: false },
  { id: 'notes', label: 'Notes', type: 'textarea', required: false, sortOrder: 13, showInPreview: true }
];

const DECODE_MATCH_FIELDS = [
  { id: 'matchNumber', label: 'Match Number', type: 'number', required: true, sortOrder: 0, showInPreview: false },
  { id: 'artifactsScoredAuto', label: 'Artifacts scored (auto)', type: 'counter', required: false, min: 0, step: 1, sortOrder: 1, showInPreview: true },
  { id: 'leavesLaunchLine', label: 'Leaves launch line?', type: 'dropdown', required: false, options: ['Yes', 'No'], sortOrder: 2, showInPreview: true },
  { id: 'artifactsScoredTeleop', label: 'Artifacts scored (teleop)', type: 'counter', required: false, min: 0, step: 1, sortOrder: 3, showInPreview: true },
  { id: 'cycleTimeSec', label: 'Cycle time (sec)', type: 'number', required: false, stopwatch: true, sortOrder: 4, showInPreview: true },
  { id: 'rankingPointsEarned', label: 'Ranking points earned', type: 'buttonGroup', required: false, multi: true, options: ['2 Win RPs', 'Movement RP', 'Goal RP', 'Pattern RP'], sortOrder: 5, showInPreview: true },
  { id: 'notes', label: 'Notes', type: 'textarea', required: false, sortOrder: 6, showInPreview: true }
];

const SEASON_DEFAULT_PIT_FIELDS = { '2025': DECODE_PIT_FIELDS };
const SEASON_DEFAULT_MATCH_FIELDS = { '2025': DECODE_MATCH_FIELDS };

const SKIP_DOCS = new Set([
  'GQQh0nPRrMTjULfdR65h/2025_pitScouting',
  'GQQh0nPRrMTjULfdR65h/2025_matchScouting'
]);

function defaultsFor(configType, season) {
  if (configType === 'matchScouting') {
    return SEASON_DEFAULT_MATCH_FIELDS[String(season)] || GENERIC_MATCH_FIELDS;
  }
  return SEASON_DEFAULT_PIT_FIELDS[String(season)] || GENERIC_PIT_FIELDS;
}

async function run() {
  console.log(`Project: ${serviceAccount.project_id}`);
  console.log(`Mode: ${APPLY ? 'APPLY (writing for real)' : 'DRY RUN (no writes — pass --apply to actually run this)'}\n`);

  const teamsSnap = await db.collection('teams').get();
  let docsChanged = 0;
  let docsUnchanged = 0;
  let docsSkipped = 0;

  for (const teamDoc of teamsSnap.docs) {
    const teamId = teamDoc.id;
    const teamName = teamDoc.data().name;
    const configSnap = await db.collection('teams').doc(teamId).collection('formConfig').get();

    for (const doc of configSnap.docs) {
      const docId = doc.id;
      const key = `${teamId}/${docId}`;

      // Legacy un-prefixed docs (no season prefix) — id is exactly
      // "pitScouting" or "matchScouting", nothing else matches this.
      if (docId === 'pitScouting' || docId === 'matchScouting') {
        docsSkipped++;
        continue;
      }
      const match = docId.match(/^(\d+)_(pitScouting|matchScouting)$/);
      if (!match) {
        console.log(`  SKIP ${key}: doc id doesn't match "{season}_{pitScouting|matchScouting}" — leaving alone.`);
        docsSkipped++;
        continue;
      }
      const [, season, configType] = match;

      if (SKIP_DOCS.has(key)) {
        console.log(`SKIP ${key} (${teamName}) — already rebuilt directly by item 1 this round.`);
        docsSkipped++;
        continue;
      }

      const existingFields = doc.data().fields || [];
      const existingIds = new Set(existingFields.map((f) => f.id));
      const defaults = defaultsFor(configType, season);
      const missing = defaults.filter((f) => !existingIds.has(f.id));

      if (missing.length === 0) {
        docsUnchanged++;
        console.log(`OK   ${key} (${teamName}, season ${season}, ${configType}) — already has every default field (${existingFields.length} total). No change.`);
        continue;
      }

      const appended = missing.map((f, i) => ({ ...f, sortOrder: existingFields.length + i }));
      const newFields = [...existingFields, ...appended];

      docsChanged++;
      console.log(`\n${APPLY ? 'APPLYING' : 'WOULD CHANGE'} ${key} (${teamName}, season ${season}, ${configType}):`);
      console.log(`  Existing (${existingFields.length}, untouched, same order): ${existingFields.map((f) => f.id).join(', ')}`);
      console.log(`  Appending (${appended.length}): ${appended.map((f) => `${f.id} (sortOrder ${f.sortOrder})`).join(', ')}`);
      console.log(`  Result: ${newFields.length} fields total`);

      if (APPLY) {
        await db.collection('teams').doc(teamId).collection('formConfig').doc(docId).set({ fields: newFields });
      }
    }
  }

  console.log('\n====== Summary ======');
  console.log(`Docs with fields appended:    ${docsChanged}${APPLY ? ' (written)' : ' (dry run only — nothing written)'}`);
  console.log(`Docs already up to date:      ${docsUnchanged}`);
  console.log(`Docs skipped (legacy/rebuilt/unrecognized id): ${docsSkipped}`);
  if (!APPLY && docsChanged > 0) {
    console.log('\nThis was a dry run — re-run with --apply to actually write these changes.');
  }
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Migration script failed:', err);
    process.exit(1);
  });
