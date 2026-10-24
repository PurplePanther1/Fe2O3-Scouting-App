// Unofficial scrimmages, phase 4 — the whole-team export's "Include scrimmages"
// toggle and the "N scrimmage entries not included" line:
//   - checkbox in the export-choice modal, default OFF on EVERY open
//   - gatherFullTeamExportData(teamId, { includeScrimmages }): off = no scrimmage
//     data; on = scrimmage entries labelled by scrimmage NAME (unique even for two
//     scrimmages with the same name), team names from the scrimmage roster, season
//     from the scrimmage doc (entrySeason()), counted either way
//   - the precheck uses the FILTERED result: no data at all -> "nothing to
//     export" and no modal; scrimmage-only data -> the modal opens and an export
//     with the box off says where the data went
//   - the visible "N scrimmage entries not included" line wherever the whole-team
//     export is offered: My Team, Leave Team (last member), Delete Account
//   - the real Excel download: zip contents with the box off / on

const fs = require('node:fs');
const assert = require('node:assert/strict');
const {
  signInUI, createTeamUI, openScoutingSubtab, createScrimmageUI, openScrimmageUI, addAndScoutUI,
  submitScrimmageTeamModal, selectFixtureEvent, pitScoutTeam, matchScoutTeam, fillRequiredFields
} = require('../lib/app');

const openMyTeam = (page) => page.click('#dashboard-tabs .tab[data-dtab="myteam"]');
const choiceOpen = (page) => page.waitForSelector('#export-choice-modal:not(.hidden)');
const closeChoice = async (page) => { await page.click('#btn-export-choice-close'); await page.waitForSelector('#export-choice-modal', { state: 'hidden' }); };
const noteText = async (page, id) => (await page.textContent(`#${id}`)).trim();

// Clicks Excel in the open choice modal and returns { name, files } where files is
// { <zip entry>: { pit: [rows], match: [rows] } } read back out of the real download.
async function downloadExcel(page) {
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#btn-export-choice-excel')]);
  const b64 = fs.readFileSync(await download.path()).toString('base64');
  const files = await page.evaluate(async (data) => {
    const zip = await JSZip.loadAsync(data, { base64: true });
    const out = {};
    for (const name of Object.keys(zip.files)) {
      const wb = XLSX.read(await zip.file(name).async('array'), { type: 'array' });
      out[name] = { pit: XLSX.utils.sheet_to_json(wb.Sheets['Pit Scouting']), match: XLSX.utils.sheet_to_json(wb.Sheets['Match Scouting']) };
    }
    return out;
  }, b64);
  return { name: download.suggestedFilename(), files };
}

async function scoutPitViaAdd(page, number, name) {
  await addAndScoutUI(page, 'pit', { number, name });
  await page.waitForSelector('#pit-modal:not(.hidden) #pit-dynamic-fields .pit-field');
  await page.waitForFunction(() => typeof currentPitLiveSession !== 'undefined' && currentPitLiveSession && currentPitLiveSession.isJoined());
  await fillRequiredFields(page, '#pit-modal', 'scrim pit');
  await page.click('#btn-pit-save');
  await page.waitForSelector('#pit-modal', { state: 'hidden' });
}

module.exports = {
  name: 'whole-team export: "Include scrimmages" (default off, per-open), entries labelled by scrimmage name, N-not-included line on My Team/Leave/Delete, filtered precheck, real zip contents',
  async run(ctx) {
    const captain = await ctx.makeUser('Captain Export');
    const page = await ctx.newPage('captain');
    await signInUI(page, captain);
    await createTeamUI(page, 'Export Smoke Team');
    const teamId = await page.evaluate(() => currentTeamData.id);
    const currentSeason = await page.evaluate(() => String(getCurrentFtcSeason()));
    const oldSeason = String(Number(currentSeason) - 1);

    // ---------- one official entry; no scrimmage entries yet ----------
    await selectFixtureEvent(page);
    await pitScoutTeam(page, 101, 'official note');

    await openMyTeam(page);
    await page.waitForTimeout(500);
    assert.equal(await noteText(page, 'myteam-export-scrimmage-note'), '', 'N = 0: no "not included" line');
    await page.click('#btn-myteam-export');
    await choiceOpen(page);
    assert.equal((await page.textContent('#export-choice-title')).trim(), 'Export Whole Team Data');
    assert.ok(await page.isVisible('#chk-export-include-scrimmages'), 'the checkbox is there on a whole-team export');
    assert.ok(!(await page.isChecked('#chk-export-include-scrimmages')), 'default OFF');
    assert.equal(await noteText(page, 'export-choice-scrimmage-note'), 'This team has no scrimmage entries.');
    assert.equal(await noteText(page, 'myteam-export-scrimmage-note'), '', 'still no line');
    await closeChoice(page);

    // ---------- scrimmage A: 1 pit + 2 match entries (UI), roster name 'Robo Cats' ----------
    await createScrimmageUI(page, { name: 'Export Scrim' });
    await openScrimmageUI(page, 'Export Scrim', { goTo: 'pit' });
    await scoutPitViaAdd(page, 4242, 'Robo Cats');
    await matchScoutTeam(page, 4242, 5, 'match five');
    await matchScoutTeam(page, 4242, 6, 'match six');
    const aId = await page.evaluate(() => selectedEvent.scrimmageId);

    // ---------- scrimmage B: SAME name, an OLD season, one seeded entry stamped with ANOTHER season ----------
    const bId = await page.evaluate(async ([tid, old, cur]) => {
      const col = db.collection('teams').doc(tid).collection('scrimmages');
      const ref = col.doc();
      await ref.set({
        name: 'Export Scrim', season: old, eventCode: `SCRIM-${ref.id}`, createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        teams: {}, matchCount: 0
      });
      // (a scrimmage is created with an empty roster; teams are added after)
      await ref.update({ 'teams.9001': { number: 9001, name: 'Seed Team', manualName: 'Seed Team', linked: false, location: '', opr: null, linkedAt: null } });
      await db.collection('teams').doc(tid).collection('pitScouting').doc('seed_b1').set({
        eventCode: `SCRIM-${ref.id}`, scrimmageId: ref.id, teamNumber: 9001, teamId: tid, season: cur,
        scoutedBy: currentUser.uid, scoutedByName: 'Seed', checkpoint: { notes: 'seed' }
      });
      return ref.id;
    }, [teamId, oldSeason, currentSeason]);
    const N = 4;

    // ---------- the data layer ----------
    const off = await page.evaluate(async (tid) => {
      const r = await gatherFullTeamExportData(tid);
      return { eventCodes: r.eventCodes, count: r.scrimmageEntryCount, labels: r.eventLabels };
    }, teamId);
    assert.deepEqual(off.eventCodes, ['SMOKE1'], 'default: no scrimmage data');
    assert.equal(off.count, N, 'counted even though left out');
    assert.deepEqual(off.labels, { SMOKE1: 'SMOKE1' });
    const on = await page.evaluate(async (tid) => {
      const r = await gatherFullTeamExportData(tid, { includeScrimmages: true });
      const seasons = {};
      const names = {};
      r.eventCodes.forEach(c => {
        seasons[c] = [...r.byEvent[c].pitDocs, ...r.byEvent[c].matchDocs].map(d => entrySeason(d));
        names[c] = [...r.byEvent[c].pitDocs, ...r.byEvent[c].matchDocs].map(d => [d.teamNumber, d.teamName]);
      });
      return { eventCodes: r.eventCodes, count: r.scrimmageEntryCount, labels: r.eventLabels, seasons, names, pitFields: r.pitFields.length };
    }, teamId);
    assert.deepEqual([...on.eventCodes].sort(), [`SCRIM-${aId}`, `SCRIM-${bId}`, 'SMOKE1'].sort());
    assert.equal(on.count, N);
    const labels = Object.values(on.labels).sort();
    assert.deepEqual(labels, ['SMOKE1', 'Scrimmage - Export Scrim', 'Scrimmage - Export Scrim (2)'], 'labelled by scrimmage NAME, unique for equal names — never the raw code');
    assert.ok(on.pitFields > 0, 'form columns resolved');
    assert.deepEqual(on.names[`SCRIM-${aId}`].map(r => r[1]), ['Robo Cats', 'Robo Cats', 'Robo Cats'], "names come from the scrimmage's roster");
    assert.deepEqual(on.names[`SCRIM-${bId}`], [[9001, 'Seed Team']]);
    assert.deepEqual(on.seasons[`SCRIM-${bId}`], [oldSeason], "season read through entrySeason(): the scrimmage's own, not the one stamped on the entry");
    assert.deepEqual(on.names.SMOKE1.map(r => r[1]), ['Alpha Bots'], 'official events still use the event roster');

    // ---------- My Team: the visible line, the checkbox, per-open reset ----------
    await openMyTeam(page);
    await page.waitForFunction((n) => document.getElementById('myteam-export-scrimmage-note').textContent.trim() === `${n} scrimmage entries not included`, N);
    assert.ok(await page.isVisible('#myteam-export-scrimmage-note'), 'the line is visible');
    await page.click('#btn-myteam-export');
    await choiceOpen(page);
    assert.ok(!(await page.isChecked('#chk-export-include-scrimmages')));
    assert.equal(await noteText(page, 'export-choice-scrimmage-note'), `${N} scrimmage entries not included`);
    await page.check('#chk-export-include-scrimmages');
    assert.equal(await noteText(page, 'export-choice-scrimmage-note'), `Including ${N} scrimmage entries, one file per scrimmage.`);
    await page.uncheck('#chk-export-include-scrimmages');
    assert.equal(await noteText(page, 'export-choice-scrimmage-note'), `${N} scrimmage entries not included`);
    await page.check('#chk-export-include-scrimmages');
    await closeChoice(page);
    await page.click('#btn-myteam-export');
    await choiceOpen(page);
    assert.ok(!(await page.isChecked('#chk-export-include-scrimmages')), 'default OFF again on the next open');
    assert.equal(await noteText(page, 'export-choice-scrimmage-note'), `${N} scrimmage entries not included`);

    // ---------- the real download, box OFF ----------
    const offDownload = await downloadExcel(page);
    assert.equal(offDownload.name, 'Export Smoke Team - Full Scouting History.zip');
    assert.deepEqual(Object.keys(offDownload.files), ['SMOKE1.xlsx'], 'off: only the official event');
    assert.equal(offDownload.files['SMOKE1.xlsx'].pit.length, 1);
    await page.waitForFunction(() => /Downloaded! 1 event\(s\) exported\./.test(document.getElementById('myteam-export-success').textContent));
    assert.equal(await noteText(page, 'myteam-export-scrimmage-note'), `${N} scrimmage entries not included`, 'the line stays after an export without them');

    // ---------- ...and ON ----------
    await page.click('#btn-myteam-export');
    await choiceOpen(page);
    await page.check('#chk-export-include-scrimmages');
    const onDownload = await downloadExcel(page);
    const names = Object.keys(onDownload.files).sort();
    assert.deepEqual(names, ['SMOKE1.xlsx', 'Scrimmage - Export Scrim (2).xlsx', 'Scrimmage - Export Scrim.xlsx'], 'on: one file per event/scrimmage, named by scrimmage name');
    assert.ok(!names.some(n => n.includes('SCRIM-')), 'no raw SCRIM- code in any file name');
    const byRoster = Object.values(onDownload.files);
    const robo = byRoster.find(f => f.pit.some(r => r['Team Number'] === 4242));
    const seed = byRoster.find(f => f.pit.some(r => r['Team Number'] === 9001));
    assert.ok(robo && seed, 'both scrimmages exported');
    assert.equal(robo.pit.length, 1);
    assert.equal(robo.match.length, 2, "scrimmage A's two match entries");
    assert.deepEqual([...new Set([...robo.pit, ...robo.match].map(r => r['Team Name']))], ['Robo Cats'], 'Team Name column from the roster');
    assert.equal(seed.pit[0]['Team Name'], 'Seed Team');
    await page.waitForFunction(() => /Downloaded! 3 event\(s\) exported\./.test(document.getElementById('myteam-export-success').textContent));

    // ---------- Leave Team (last member): the line + the checkbox on top of that modal ----------
    await page.click('#btn-leave-team');
    await page.waitForSelector('#leave-team-confirm-modal:not(.hidden)');
    await page.waitForFunction((n) => document.getElementById('leave-team-confirm-export-scrimmage-note').textContent.trim() === `${n} scrimmage entries not included`, N);
    assert.ok(await page.isVisible('#leave-team-confirm-export-scrimmage-note'));
    await page.click('#btn-leave-team-confirm-export');
    await choiceOpen(page);
    assert.ok(!(await page.isChecked('#chk-export-include-scrimmages')), 'default OFF here too');
    const onTop = await page.evaluate(() => {
      const r = document.getElementById('btn-export-choice-excel').getBoundingClientRect();
      return !!document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2).closest('#export-choice-modal');
    });
    assert.ok(onTop, 'the choice modal is above the Leave Team modal');
    await closeChoice(page);
    await page.click('#btn-leave-team-confirm-cancel');
    await page.waitForSelector('#leave-team-confirm-modal', { state: 'hidden' });
    assert.equal(await noteText(page, 'leave-team-confirm-export-scrimmage-note'), '', 'the line is cleared when that modal closes');

    // ---------- Delete Account: the line next to each sole-owner team's export button ----------
    await page.evaluate(() => openDeleteAccountModal());
    await page.waitForFunction(([id, n]) => (document.getElementById(`delete-account-export-${id}-scrimmage-note`)?.textContent || '').trim() === `${n} scrimmage entries not included`, [teamId, N]);
    assert.ok(await page.isVisible(`#delete-account-export-${teamId}-scrimmage-note`));
    await page.click(`#delete-account-export-actions button`);
    await choiceOpen(page);
    assert.ok(!(await page.isChecked('#chk-export-include-scrimmages')), 'default OFF in the delete flow too');
    await closeChoice(page);
    await page.evaluate(() => closeDeleteAccountModal());

    // ---------- the box is whole-team only: per-event exports have none ----------
    await page.click('#dashboard-tabs .tab[data-dtab="scouting"]');
    await openScoutingSubtab(page, 'info'); // scrimmage A is still the open one (two share the name, so don't re-open by name)
    await page.click('#btn-export-event-sheets');
    await choiceOpen(page);
    assert.ok(!(await page.isVisible('#export-choice-scrimmage-option')), 'no Include-scrimmages box on a per-event export');
    await closeChoice(page);

    // ---------- scrimmage-ONLY team: the precheck uses the filtered result ----------
    const userB = await ctx.makeUser('Captain Only Scrim');
    const pageB = await ctx.newPage('scrim-only');
    await signInUI(pageB, userB);
    await createTeamUI(pageB, 'Scrim Only Team');
    const teamB = await pageB.evaluate(() => currentTeamData.id);
    await createScrimmageUI(pageB, { name: 'Only Scrim' });
    await openScrimmageUI(pageB, 'Only Scrim', { goTo: 'info' });
    await pageB.click('#btn-scrimmage-add-team');
    await submitScrimmageTeamModal(pageB, { number: 7001, name: 'Lonely Team' });
    await pageB.evaluate(async ([tid]) => {
      const sid = selectedEvent.scrimmageId;
      await db.collection('teams').doc(tid).collection('pitScouting').doc('only_1').set({
        eventCode: `SCRIM-${sid}`, scrimmageId: sid, teamNumber: 7001, teamId: tid, season: selectedEvent.season,
        scoutedBy: currentUser.uid, scoutedByName: 'Seed', checkpoint: { notes: 'only' }
      });
    }, [teamB]);
    await openMyTeam(pageB);
    await pageB.waitForFunction(() => document.getElementById('myteam-export-scrimmage-note').textContent.trim() === '1 scrimmage entry not included');
    await pageB.click('#btn-myteam-export');
    await choiceOpen(pageB);          // scrimmage-only data still gets the modal: the box is how to export it
    assert.equal(await noteText(pageB, 'export-choice-scrimmage-note'), '1 scrimmage entry not included');
    await pageB.click('#btn-export-choice-excel');
    await pageB.waitForFunction(() => /No scouting data found outside scrimmages/.test(document.getElementById('myteam-export-success').textContent));
    assert.match(await pageB.textContent('#myteam-export-success'), /tick "Include scrimmages"/);
    await pageB.click('#btn-myteam-export');
    await choiceOpen(pageB);
    await pageB.check('#chk-export-include-scrimmages');
    const only = await downloadExcel(pageB);
    assert.deepEqual(Object.keys(only.files), ['Scrimmage - Only Scrim.xlsx']);
    assert.equal(only.files['Scrimmage - Only Scrim.xlsx'].pit[0]['Team Name'], 'Lonely Team');

    // ---------- no data at all: "nothing to export", no modal, no line ----------
    const userC = await ctx.makeUser('Captain Empty');
    const pageC = await ctx.newPage('empty');
    await signInUI(pageC, userC);
    await createTeamUI(pageC, 'Empty Export Team');
    await openMyTeam(pageC);
    await pageC.click('#btn-myteam-export');
    await pageC.waitForFunction(() => /No scouting data found for this team — nothing to export\./.test(document.getElementById('myteam-export-success').textContent));
    assert.ok(!(await pageC.isVisible('#export-choice-modal')), 'no choice modal for an empty team');
    assert.equal(await noteText(pageC, 'myteam-export-scrimmage-note'), '');
  }
};
