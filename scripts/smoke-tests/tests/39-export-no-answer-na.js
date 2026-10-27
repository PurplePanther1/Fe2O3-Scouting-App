// A form field nobody answered exports as "N/A" however it is stored, in every export (Excel, Sheets, whole-team,
// per-event, per-team, pit-only, match-only, Pit vs Match) - they all build their cells in sheets-export.js
// buildSheetRows() / formatFieldCellValue():
//   missing key (live-session saves only write a field once it is touched), null (batch saves from Team View),
//   undefined, "" / whitespace, an empty multi-select list   -> "N/A"
//   a real 0, real text / number / choice, a non-empty list    -> exactly as it is
// The FIXED columns that can really be blank follow the same rule: Team Name (roster has no name for the team),
// Scouted By (neither scoutedByEmail nor scoutedByName), Scouted At (absent on an old entry) -> "N/A"; real values stay.
// Team Number / Match Number are the entry's identity, never blank in a real entry, and keep their old formatting.
// Nothing stored is changed. Both save paths (pit form + Match View = live, Team View = batch) export the same.

const fs = require('node:fs');
const assert = require('node:assert/strict');
const { signInUI, createTeamUI, selectFixtureEvent, openScoutingSubtab, teamRow, openMyTeamTab } = require('../lib/app');
const { FIXTURE_EVENT } = require('../lib/harness');

const CODE = FIXTURE_EVENT.code;
const field = (id, label, type, extra = {}) => ({ id, label, type, required: false, sortOrder: 0, showInPreview: false, ...extra });
const FIELDS = [
  field('t1', 'Text', 'text'),
  field('t2', 'Text Two', 'text'),
  field('n1', 'Number', 'number'),
  field('c1', 'Counter', 'counter', { min: 0, max: 20, step: 1 }),
  field('d1', 'Dropdown', 'dropdown', { options: ['A', 'B'] }),
  field('bm', 'Multi', 'buttonGroup', { options: ['X', 'Y'], multi: true }),
  field('ta', 'Notes', 'textarea')
];
const NA = 'N/A';

// Excel download -> { <file or 'workbook'>: { <sheet name>: [rows] } } (a zip has one workbook per event / scrimmage).
async function downloadExcel(page) {
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#btn-export-choice-excel')]);
  const b64 = fs.readFileSync(await download.path()).toString('base64');
  return page.evaluate(async ({ data, name }) => {
    const read = (wb) => Object.fromEntries(wb.SheetNames.map(n => [n, XLSX.utils.sheet_to_json(wb.Sheets[n])]));
    if (/\.zip$/i.test(name)) {
      const zip = await JSZip.loadAsync(data, { base64: true });
      const out = {};
      for (const f of Object.keys(zip.files)) out[f] = read(XLSX.read(await zip.file(f).async('array'), { type: 'array' }));
      return out;
    }
    return { workbook: read(XLSX.read(data, { type: 'base64' })) };
  }, { data: b64, name: download.suggestedFilename() });
}
const choiceOpen = (page) => page.waitForSelector('#export-choice-modal:not(.hidden)');

module.exports = {
  name: 'exports: an unanswered field is N/A in every export (missing key, null, empty text, empty multi-select), a real 0 stays 0, live and batch saves export alike',
  async run(ctx) {
    const captain = await ctx.makeUser('Captain Export NA');
    const page = await ctx.newPage('captain');
    await signInUI(page, captain);
    await createTeamUI(page, 'Export NA Team');
    await selectFixtureEvent(page);
    const teamId = await page.evaluate(() => currentTeamData.id);
    const season = await page.evaluate(() => resolveFormConfigSeason());
    const numbered = (fields) => fields.map((f, i) => ({ ...f, sortOrder: i }));
    await page.evaluate(async ([tid, s, pit, match]) => {
      const col = db.collection('teams').doc(tid).collection('formConfig');
      await col.doc(`${s}_pitScouting`).set({ fields: pit, baseVersion: null, handledVersion: 0, retiredFields: [] }, { merge: true });
      await col.doc(`${s}_matchScouting`).set({ fields: match, baseVersion: null, handledVersion: 0, retiredFields: [] }, { merge: true });
      invalidateFormConfigCache(tid, s); invalidateMatchFormConfigCache(tid, s);
    }, [teamId, season, numbered(FIELDS), numbered([field('matchNumber', 'Match Number', 'number', { required: true }), ...FIELDS])]);

    const counterType = async (modal, id, text) => {
      await page.click(`#${modal}-modal #dyn-${id} .counter-display`);
      await page.keyboard.press('Control+A');
      await page.keyboard.type(text);
      await page.keyboard.press('Enter');
    };
    const done = async (modal, btn) => { await page.click(btn); await page.waitForSelector(`#${modal}-modal`, { state: 'hidden' }); };

    // ---------- the entries, through the real forms ----------
    // pit 101 (live): text, a typed 0 in the number and the counter; everything else untouched (keys absent)
    await page.evaluate(([n, c]) => openPitScoutForm(n, c), [101, CODE]);
    await page.waitForSelector('#pit-modal:not(.hidden) #pit-dynamic-fields .pit-field');
    await page.waitForFunction(() => currentPitLiveSession && currentPitLiveSession.isJoined());
    await page.fill('#pit-modal #dyn-t1', 'hello');
    await page.fill('#pit-modal #dyn-n1', '0');
    await counterType('pit', 'c1', '0');
    await done('pit', '#btn-pit-save');
    // pit 202 (live): a dropdown picked then un-picked (null), a multi-select toggled on then off (empty list), text
    await page.evaluate(([n, c]) => openPitScoutForm(n, c), [202, CODE]);
    await page.waitForSelector('#pit-modal:not(.hidden) #pit-dynamic-fields .pit-field');
    await page.waitForFunction(() => currentPitLiveSession && currentPitLiveSession.isJoined());
    await page.selectOption('#pit-modal #dyn-d1', 'A');
    await page.selectOption('#pit-modal #dyn-d1', '');
    await page.click('#pit-modal #dyn-bm .button-group-option');
    await page.click('#pit-modal #dyn-bm .button-group-option');
    await page.fill('#pit-modal #dyn-t1', 'x');
    await page.waitForTimeout(700); // let the debounced live writes land
    await done('pit', '#btn-pit-save');
    // match, LIVE (Match View): text + typed 0 number; the rest untouched
    await page.evaluate(([n, c]) => openMatchScoutForm(n, c, 1, 'Alpha'), [101, CODE]);
    await page.waitForSelector('#match-modal:not(.hidden) #match-dynamic-fields .pit-field');
    await page.waitForFunction(() => currentMatchLiveSession && currentMatchLiveSession.isJoined());
    await page.fill('#match-modal #dyn-t1', 'live');
    await page.fill('#match-modal #dyn-n1', '0');
    await done('match', '#btn-match-save');
    // match, BATCH (Team View): the same content
    await page.evaluate(([n, c]) => openMatchScoutForm(n, c), [101, CODE]);
    await page.waitForSelector('#match-modal:not(.hidden) #match-dynamic-fields .pit-field');
    await page.fill('#match-modal #dyn-matchNumber', '2');
    await page.fill('#match-modal #dyn-t1', 'batch');
    await page.fill('#match-modal #dyn-n1', '0');
    await done('match', '#btn-match-save');

    // ---------- what is STORED differs by save path (and an empty string is planted by hand) ----------
    const stored = await page.evaluate(async ([tid, code]) => {
      const q = (col, num, m) => {
        let r = db.collection('teams').doc(tid).collection(col).where('eventCode', '==', code).where('teamNumber', '==', num);
        if (m != null) r = r.where('matchNumber', '==', m);
        return r.get().then(s => ({ id: s.docs[0].id, ...s.docs[0].data() }));
      };
      const pit101 = await q('pitScouting', 101);
      await db.collection('teams').doc(tid).collection('pitScouting').doc(pit101.id).update({ t2: '', ta: '   ' });
      return { pit202: await q('pitScouting', 202), live: await q('matchScouting', 101, 1), batch: await q('matchScouting', 101, 2) };
    }, [teamId, CODE]);
    assert.ok(!('c1' in stored.live) && !('t2' in stored.live) && !('d1' in stored.live), 'live save: untouched fields have no key');
    assert.ok(stored.batch.c1 === null && stored.batch.t2 === null && stored.batch.d1 === null, 'batch save: untouched fields are stored as null');
    assert.deepEqual(stored.batch.bm, [], 'batch save: an untouched multi-select is an empty list');
    assert.deepEqual(stored.pit202.bm, [], 'live save: a multi-select toggled off is an empty list');
    assert.strictEqual(stored.pit202.d1, null, 'live save: a dropdown un-picked is null');

    // ---------- the shared formatter, case by case ----------
    const cells = await page.evaluate(() => {
      const f = [{ id: 'v', label: 'V' }];
      const row = (doc) => buildSheetRows(f, [{ teamNumber: 1, ...doc }], [{ header: 'Team', key: 'teamNumber' }])[1][1];
      return {
        missing: row({}), nullv: row({ v: null }), undef: row({ v: undefined }), empty: row({ v: '' }), spaces: row({ v: '   ' }), emptyList: row({ v: [] }),
        zero: row({ v: 0 }), text: row({ v: 'hello' }), num: row({ v: 7 }), choice: row({ v: 'A' }), list: row({ v: ['X', 'Y'] }), zeroText: row({ v: '0' }),
        // 0 stays 0 in a real field
      };
    });
    assert.deepEqual(cells, {
      missing: NA, nullv: NA, undef: NA, empty: NA, spaces: NA, emptyList: NA,
      zero: 0, text: 'hello', num: 7, choice: 'A', list: 'X + Y', zeroText: '0'
    });
    // the fixed columns, case by case: [Team Name, Team Number, Match Number, Scouted By, Scouted At]
    const fixed = await page.evaluate(() => {
      const cols = [{ header: 'Team Name', key: 'teamName' }, { header: 'Team Number', key: 'teamNumber' }, { header: 'Match Number', key: 'matchNumber' }];
      const row = (doc) => buildSheetRows([], [doc], cols)[1];
      const ts = { toDate: () => new Date(Date.UTC(2026, 9, 27, 15, 30)) };
      return {
        allMissing: row({}),
        blankish: row({ teamName: '   ', scoutedByEmail: '', scoutedByName: '  ', scoutedAt: null }),
        undef: row({ teamName: undefined, scoutedByEmail: undefined, scoutedByName: undefined, scoutedAt: undefined }),
        real: row({ teamName: 'Alpha Bots', teamNumber: 101, matchNumber: 0, scoutedByEmail: 'a@b.test', scoutedByName: 'Ann', scoutedAt: ts }),
        nameOnly: row({ teamName: 'Bo', scoutedByEmail: '  ', scoutedByName: 'Ann' }),
        emailBeatsName: row({ scoutedByEmail: 'a@b.test', scoutedByName: 'Ann' }),
        zeroTeamName: row({ teamName: 0 })
      };
    });
    assert.deepEqual(fixed.allMissing, [NA, '', '', NA, NA], 'missing: Team Name / Scouted By / Scouted At are N/A; identity numbers keep their old (blank) formatting');
    assert.deepEqual(fixed.blankish, [NA, '', '', NA, NA], 'null / empty / whitespace-only values are N/A');
    assert.deepEqual(fixed.undef, [NA, '', '', NA, NA]);
    assert.equal(fixed.real[0], 'Alpha Bots'); assert.equal(fixed.real[1], 101); assert.equal(fixed.real[2], 0, 'a real value (even 0) stays as it is');
    assert.equal(fixed.real[3], 'a@b.test', 'Scouted By: the email still comes first, as before');
    assert.ok(fixed.real[4] && fixed.real[4] !== NA, 'a real Scouted At is the formatted time');
    assert.equal(fixed.nameOnly[3], 'Ann', 'a whitespace email falls through to the name');
    assert.equal(fixed.emailBeatsName[3], 'a@b.test');
    assert.equal(fixed.zeroTeamName[0], 0, 'only blank values become N/A');
    // an old entry (no scouter name, no scoutedAt) in a team the event roster does not list, so also no team name
    await page.evaluate(async ([tid, code, s]) => {
      await db.collection('teams').doc(tid).collection('pitScouting').doc('legacy_9999').set({
        eventCode: code, teamNumber: 9999, teamId: tid, season: s, scoutedBy: currentUser.uid, scoutedByName: '', checkpoint: { t1: 'old' }, t1: 'old'
      });
    }, [teamId, CODE, season]);

    // ---------- the real Excel exports ----------
    const fieldCols = ['Text', 'Text Two', 'Number', 'Counter', 'Dropdown', 'Multi', 'Notes'];
    const noBlank = (rows, label) => rows.forEach((r, i) => fieldCols.forEach(c => assert.ok(c in r && r[c] !== '', `${label} row ${i + 1}: "${c}" is never a blank cell`)));
    const pitRow = (rows, n) => rows.find(r => r['Team Number'] === n);
    // a blank cell is a missing key once it is read back from the workbook
    const fixedCols = ['Team Name', 'Scouted By', 'Scouted At'];
    const noFixedBlank = (rows, label) => rows.forEach((r, i) => fixedCols.forEach(c => assert.ok(c in r && r[c] !== '', `${label} row ${i + 1}: "${c}" is never a blank cell`)));

    // per-event pit
    await openScoutingSubtab(page, 'pit');
    await page.click('#btn-export-event-pit'); await choiceOpen(page);
    const pitOnly = (await downloadExcel(page)).workbook['Pit Scouting'];
    noBlank(pitOnly, 'pit-only');
    noFixedBlank(pitOnly, 'pit-only');
    const legacy = pitRow(pitOnly, 9999);
    assert.deepEqual(fixedCols.map(c => legacy[c]), [NA, NA, NA], 'an old entry in an unlisted team: no team name, no scouter, no time = N/A');
    assert.equal(legacy['Team Number'], 9999, 'the team number is the real number');
    assert.deepEqual([pitRow(pitOnly, 101)['Team Name'], pitRow(pitOnly, 202)['Team Name']], ['Alpha Bots', 'Beta Builders'], 'real team names stay');
    assert.ok(pitRow(pitOnly, 101)['Scouted By'] !== NA && pitRow(pitOnly, 101)['Scouted By'] !== '', 'a real scouter stays');
    assert.ok(pitRow(pitOnly, 101)['Scouted At'] !== NA && pitRow(pitOnly, 101)['Scouted At'] !== '', 'a real time stays');
    assert.deepEqual(['Text', 'Text Two', 'Number', 'Counter', 'Dropdown', 'Multi', 'Notes'].map(c => pitRow(pitOnly, 101)[c]), ['hello', NA, 0, 0, NA, NA, NA], 'pit 101: real values and a real 0 stay, the rest N/A (absent key, empty string, whitespace)');
    assert.deepEqual(['Text', 'Number', 'Counter', 'Dropdown', 'Multi'].map(c => pitRow(pitOnly, 202)[c]), ['x', NA, NA, NA, NA], 'pit 202: null and the empty list are N/A too');

    // per-event match
    await openScoutingSubtab(page, 'match');
    await page.click('#btn-export-event-match'); await choiceOpen(page);
    const matchOnly = (await downloadExcel(page)).workbook['Match Scouting'];
    noBlank(matchOnly, 'match-only'); noFixedBlank(matchOnly, 'match-only');
    assert.ok(matchOnly.every(r => r['Team Name'] === 'Alpha Bots' && r['Scouted By'] !== NA && r['Scouted At'] !== NA), 'match rows: real name, scouter and time stay');
    const live = matchOnly.find(r => r['Match Number'] === 1);
    const batch = matchOnly.find(r => r['Match Number'] === 2);
    const same = (r) => ['Text Two', 'Number', 'Counter', 'Dropdown', 'Multi', 'Notes'].map(c => r[c]);
    assert.deepEqual(same(live), [NA, 0, NA, NA, NA, NA], 'live-saved match entry');
    assert.deepEqual(same(batch), same(live), 'the batch-saved entry exports exactly the same cells');

    // event-wide pit + match (the combined workbook)
    await openScoutingSubtab(page, 'info');
    await page.click('#btn-export-event-sheets'); await choiceOpen(page);
    const both = (await downloadExcel(page)).workbook;
    noBlank(both['Pit Scouting'], 'event-wide pit'); noBlank(both['Match Scouting'], 'event-wide match');
    noFixedBlank(both['Pit Scouting'], 'event-wide pit'); noFixedBlank(both['Match Scouting'], 'event-wide match');
    assert.deepEqual(fixedCols.map(c => pitRow(both['Pit Scouting'], 9999)[c]), [NA, NA, NA], 'event-wide: the old entry\'s fixed cells are N/A too');
    assert.deepEqual(same(both['Match Scouting'].find(r => r['Match Number'] === 2)), same(live));

    // whole-team export (a zip, one workbook per event)
    await openMyTeamTab(page);
    await page.click('#btn-myteam-export'); await choiceOpen(page);
    const whole = await downloadExcel(page);
    const wb = whole[Object.keys(whole).find(n => /SMOKE1/.test(n))];
    noBlank(wb['Pit Scouting'], 'whole-team pit'); noBlank(wb['Match Scouting'], 'whole-team match');
    noFixedBlank(wb['Pit Scouting'], 'whole-team pit'); noFixedBlank(wb['Match Scouting'], 'whole-team match');
    assert.equal(pitRow(wb['Pit Scouting'], 9999)['Team Name'], NA, 'whole-team: no team name = N/A');
    assert.equal(pitRow(wb['Pit Scouting'], 101)['Text Two'], NA);

    // per-team match export (View Matches Scouted)
    await page.click('#dashboard-tabs .tab[data-dtab="scouting"]');
    await page.evaluate(([n, c]) => openMatchScoutedModal(n, c, {}), [101, CODE]);
    await page.waitForFunction(() => document.querySelectorAll('#msm-match-entries > *').length >= 2);
    await page.click('#msm-export-team-match'); await choiceOpen(page);
    const teamMatch = Object.values(await downloadExcel(page))[0];
    const teamMatchRows = teamMatch['Match Scouting'] || Object.values(teamMatch).find(r => r.length && 'Match Number' in r[0]);
    noBlank(teamMatchRows, 'per-team match'); noFixedBlank(teamMatchRows, 'per-team match');
    await page.evaluate(() => closeMatchScoutedModal());

    // Pit vs Match export: both entry sheets and the stats summary
    await openScoutingSubtab(page, 'compare');
    await (await teamRow(page, '#team-list-compare', 101)).getByRole('button', { name: 'Compare' }).click();
    await page.waitForSelector('#comparison-modal:not(.hidden)');
    await page.waitForFunction(() => /Avg|No data/.test(document.getElementById('cmp-match-stats').textContent));
    await page.click('#btn-cmp-export'); await choiceOpen(page);
    const cmp = (await downloadExcel(page)).workbook;
    noBlank(cmp['Pit Data'], 'Pit vs Match pit sheet'); noBlank(cmp['Match Entries Used'], 'Pit vs Match match sheet');
    noFixedBlank(cmp['Pit Data'], 'Pit vs Match pit sheet'); noFixedBlank(cmp['Match Entries Used'], 'Pit vs Match match sheet');
    const stat = (label) => cmp['Match Stats Summary'].find(r => r.Field === label);
    assert.equal(stat('Counter').Detail, 'No data', 'no counter answers in any match');
    assert.equal(stat('Counter').Value, NA, 'the summary row for a field with no data says N/A');
    assert.ok(cmp['Match Stats Summary'].some(r => r.Field === 'Number' && r.Detail === 'Average' && r.Value === 0), 'a real 0 still averages as 0');
  }
};
