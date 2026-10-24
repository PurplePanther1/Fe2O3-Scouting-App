// REPRODUCTION of the "phantom pit entry" found in the real BIOBUZZ/Sinclair data:
// the season-change confirm said "1 team has data: 1 pit" while Team Details said
// "This team has not been pit scouted yet".
//
// ROOT CAUSE: the pit form's join() creates the entry doc the moment the form opens,
// and a Cancel leaves it behind as an EMPTY SHELL (identity fields + empty
// activeEditors; no checkpoint / scoutedBy) — by design, see live-entry-sync.js. Team
// Details and the scouted checkmarks ignore such shells (isEntryCommitted()), but the
// scrimmage code counted every doc as an "entry". "+ Add & scout a team" -> Cancel is
// the most direct way to leave one (a brand-new roster team, the form opens at once).
//
// FIX under test: every user-facing count (season-change confirm, Remove Team, Delete
// Scrimmage, "N scrimmage entries not included") counts COMMITTED entries only, while
// every delete still sweeps the shells away.

const assert = require('node:assert/strict');
const {
  signInUI, createTeamUI, createScrimmageUI, openScrimmageUI, openScoutingSubtab, openScrimmagesTab,
  addAndScoutUI, teamRow, fillRequiredFields
} = require('../lib/app');

const waitConfirm = (page, titleRe) => page.waitForFunction((src) =>
  !document.getElementById('generic-confirm-modal').classList.contains('hidden')
  && new RegExp(src).test(document.getElementById('generic-confirm-title').textContent), titleRe.source);

const pitDocs = (page, teamId, code, n) => page.evaluate(async ([tid, c, num]) => {
  let q = db.collection('teams').doc(tid).collection('pitScouting').where('eventCode', '==', c);
  if (num != null) q = q.where('teamNumber', '==', num);
  return (await q.get()).docs.map(d => ({ id: d.id, ...d.data() }));
}, [teamId, code, n == null ? null : n]);

async function manageSeasonTo(page, name, season) {
  await openScrimmagesTab(page);
  await page.locator('#scrimmage-list .scrimmage-item', { hasText: name }).locator('.btn-scrimmage-manage').click();
  await page.waitForSelector('#scrimmage-form-modal:not(.hidden)');
  await page.selectOption('#select-scrimmage-season', String(season));
  await page.click('#btn-scrimmage-form-save');
}

module.exports = {
  name: 'empty draft left by a cancelled pit form: not an "entry" in any count (season change, remove team, delete, not-included), still swept by every delete',
  async run(ctx) {
    const captain = await ctx.makeUser('Captain Draft');
    const page = await ctx.newPage('captain');
    await signInUI(page, captain);
    await createTeamUI(page, 'Draft Smoke Team');
    const teamId = await page.evaluate(() => currentTeamData.id);
    const currentSeason = await page.evaluate(() => String(getCurrentFtcSeason()));
    const oldSeason = String(Number(currentSeason) - 1);

    await createScrimmageUI(page, { name: 'Draft Scrim' });
    await openScrimmageUI(page, 'Draft Scrim', { goTo: 'pit' });
    const code = await page.evaluate(() => selectedEvent.code);

    // ---------- REPRODUCE: Add & scout a team, then Cancel the pit form ----------
    await addAndScoutUI(page, 'pit', { number: 20322, name: 'Big Blue Bytes' });
    await page.waitForSelector('#pit-modal:not(.hidden) #pit-dynamic-fields .pit-field');
    await page.waitForFunction(() => typeof currentPitLiveSession !== 'undefined' && currentPitLiveSession && currentPitLiveSession.isJoined());
    await page.click('#btn-pit-cancel-inline');
    await page.waitForSelector('#pit-modal', { state: 'hidden' });
    await page.waitForFunction(async ([tid, c]) => {
      const snap = await db.collection('teams').doc(tid).collection('pitScouting').where('eventCode', '==', c).get();
      return snap.size === 1 && Object.keys(snap.docs[0].data().activeEditors || {}).length === 0;
    }, [teamId, code]);
    let docs = await pitDocs(page, teamId, code, 20322);
    assert.equal(docs.length, 1, 'the cancelled form left a doc behind');
    const shell = docs[0];
    assert.equal(shell.id, `${teamId}_${code}_20322`);
    // Exactly the six fields of the real doc found in the production data.
    assert.deepEqual(Object.keys(shell).filter(k => k !== 'id').sort(), ['activeEditors', 'eventCode', 'scrimmageId', 'season', 'teamId', 'teamNumber'], 'identity fields only');
    assert.ok(!shell.checkpoint && !shell.scoutedBy, 'EMPTY SHELL: no checkpoint, no scoutedBy (never committed)');
    assert.deepEqual(shell.activeEditors, {}, 'and nobody is editing it');

    // The symptom: Team Details says not scouted ...
    await openScoutingSubtab(page, 'info');
    await (await teamRow(page, '#team-list-info', 20322)).getByRole('button', { name: 'View Detail' }).click();
    await page.waitForSelector('#team-detail-modal:not(.hidden) #td-modal-body:not(.hidden)');
    await page.waitForFunction(() => /has not been pit scouted yet/.test(document.getElementById('td-pit-data-status').textContent));
    await page.click('#btn-team-detail-close');
    // ... and the whole-team export line must agree: zero entries.
    assert.equal(await page.evaluate((tid) => countScrimmageEntries(tid), teamId), 0, '"N scrimmage entries not included" counts committed entries only');
    assert.equal((await page.evaluate((tid) => gatherFullTeamExportData(tid, { includeScrimmages: true }), teamId)).eventCodes.length, 0, 'and an included export has no row for the shell');

    // ---------- season change: NO prompt for a shell, but the shell is swept ----------
    await manageSeasonTo(page, 'Draft Scrim', oldSeason);
    await page.waitForSelector('#scrimmage-form-modal', { state: 'hidden' });
    assert.ok(!(await page.evaluate(() => !document.getElementById('generic-confirm-modal').classList.contains('hidden'))), 'no "Delete entries?" confirm for an empty draft');
    await page.waitForFunction((s) => currentScrimmage && String(currentScrimmage.season) === s, oldSeason);
    assert.equal((await pitDocs(page, teamId, code)).length, 0, 'the empty shell was swept by the season change');
    assert.ok(await page.evaluate(() => !!currentScrimmage.teams['20322']), 'the team stays on the roster');

    // ---------- mixed: 1 committed pit entry + 1 shell -> the confirm says "1 pit", the change sweeps both ----------
    await openScoutingSubtab(page, 'pit');
    await (await teamRow(page, '#team-list-pit', 20322)).locator('.btn-pit-quick-scout').click();
    await page.waitForSelector('#pit-modal:not(.hidden) #pit-dynamic-fields .pit-field');
    await page.waitForFunction(() => currentPitLiveSession && currentPitLiveSession.isJoined());
    await fillRequiredFields(page, '#pit-modal', 'real data');
    await page.click('#btn-pit-save');
    await page.waitForSelector('#pit-modal', { state: 'hidden' });
    await page.click('#btn-scrimmage-add-scout-pit');
    await page.fill('#input-scrimmage-team-number', '30001');
    await page.click('#btn-scrimmage-team-save');
    await page.waitForSelector('#pit-modal:not(.hidden) #pit-dynamic-fields .pit-field');
    await page.waitForFunction(() => currentPitLiveSession && currentPitLiveSession.isJoined());
    await page.click('#btn-pit-cancel-inline');
    await page.waitForSelector('#pit-modal', { state: 'hidden' });
    await page.waitForFunction(async ([tid, c]) => (await db.collection('teams').doc(tid).collection('pitScouting').where('eventCode', '==', c).get()).size === 2, [teamId, code]);
    assert.equal(await page.evaluate((tid) => countScrimmageEntries(tid), teamId), 1, 'one committed entry + one shell = 1');

    await manageSeasonTo(page, 'Draft Scrim', currentSeason);
    await waitConfirm(page, /Change Season and Delete Entries\?/);
    const msg = await page.textContent('#generic-confirm-message');
    assert.match(msg, /1 team has data: 1 pit and 0 match entries\./, 'counts the committed entry only');
    assert.match(msg, /#20322 — 1 pit, 0 match/);
    assert.doesNotMatch(msg, /30001/, 'the team with only a shell is not listed');
    await page.click('#btn-generic-confirm-cancel');
    await page.waitForSelector('#generic-confirm-modal', { state: 'hidden' });
    assert.equal((await pitDocs(page, teamId, code)).length, 2, 'Cancel changes nothing');
    await page.click('#btn-scrimmage-form-save');
    await waitConfirm(page, /Change Season and Delete Entries\?/);
    await page.click('#btn-generic-confirm-proceed');
    await page.waitForSelector('#scrimmage-form-modal', { state: 'hidden' });
    await page.waitForFunction(async ([tid, c]) => (await db.collection('teams').doc(tid).collection('pitScouting').where('eventCode', '==', c).get()).size === 0, [teamId, code]);

    // ---------- Remove Team: a shell-only team gets the PLAIN confirm and the shell goes with it ----------
    // (the earlier shell was swept by the season change; put one back first)
    await page.evaluate(async ([tid, c]) => {
      const sid = selectedEvent.scrimmageId;
      await db.collection('teams').doc(tid).collection('pitScouting').doc(`${tid}_${c}_30001`).set({ eventCode: c, scrimmageId: sid, teamNumber: 30001, teamId: tid, season: selectedEvent.season, activeEditors: {} });
    }, [teamId, code]);
    await openScoutingSubtab(page, 'info');
    await (await teamRow(page, '#team-list-info', 30001)).locator('.btn-scrimmage-team-remove').click();
    await waitConfirm(page, /^Remove Team$/);
    assert.doesNotMatch(await page.textContent('#generic-confirm-message'), /entr/, 'no "deletes N entries" for an empty shell');
    await page.click('#btn-generic-confirm-proceed');
    await page.waitForSelector('#generic-confirm-modal', { state: 'hidden' });
    await page.waitForFunction(() => !currentScrimmage.teams['30001']);
    assert.equal((await pitDocs(page, teamId, code, 30001)).length, 0, 'the shell was deleted with the team');

    // ---------- Delete Scrimmage: the totals count committed entries; the shell still goes ----------
    await page.evaluate(async ([tid, c]) => {
      const sid = selectedEvent.scrimmageId;
      const base = db.collection('teams').doc(tid).collection('pitScouting');
      await base.doc(`${tid}_${c}_20322`).set({ eventCode: c, scrimmageId: sid, teamNumber: 20322, teamId: tid, season: selectedEvent.season, scoutedBy: currentUser.uid, checkpoint: { notes: 'x' }, activeEditors: {} });
      await base.doc(`${tid}_${c}_20323`).set({ eventCode: c, scrimmageId: sid, teamNumber: 20323, teamId: tid, season: selectedEvent.season, activeEditors: {} });
    }, [teamId, code]);
    await openScrimmagesTab(page);
    await page.locator('#scrimmage-list .scrimmage-item', { hasText: 'Draft Scrim' }).locator('.btn-scrimmage-delete').click();
    await waitConfirm(page, /^Delete Scrimmage$/);
    assert.match(await page.textContent('#generic-confirm-message'), /1 teams \/ 1 pit \/ 0 match entries/, 'committed entries only (the shell is not counted)');
    await page.click('#btn-generic-confirm-proceed');
    await page.waitForFunction(async ([tid, c]) => (await db.collection('teams').doc(tid).collection('pitScouting').where('eventCode', '==', c).get()).size === 0, [teamId, code]);
  }
};
