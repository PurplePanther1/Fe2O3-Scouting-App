// Unofficial scrimmages — a linked team's OPR/location are copied onto the roster at
// link time and belong to the season they were fetched for. After a SEASON CHANGE
// (Manage) the linked teams are refreshed for the NEW season with ONE batched FTCScout
// request and written back to the roster:
//   - every list shows the new season's OPR; Team Details (live) agrees
//   - a team FTCScout has no stats for in the new season gets "--" (null), never the
//     old number, and the user is told which ones
//   - an unreachable FTCScout clears the OPRs (never a wrong number) and says so
//   - the change-with-entries path (confirm -> delete -> write) refreshes too
//   - a name-only edit, or a scrimmage with no linked team, sends no request
//   - unlinked teams are never looked up

const assert = require('node:assert/strict');
const { ftcScoutOpr } = require('../lib/harness');
const {
  signInUI, createTeamUI, createScrimmageUI, openScrimmageUI, openScoutingSubtab, openScrimmagesTab, teamRow, submitScrimmageTeamModal
} = require('../lib/app');

const readTeams = (page, teamId, scrimmageId) => page.evaluate(async ([tid, sid]) =>
  (await db.collection('teams').doc(tid).collection('scrimmages').doc(sid).get()).data().teams || {}, [teamId, scrimmageId]);

const noticeOpen = (page, titleRe) => page.waitForFunction((src) =>
  !document.getElementById('generic-confirm-modal').classList.contains('hidden')
  && new RegExp(src).test(document.getElementById('generic-confirm-title').textContent), titleRe.source);

async function manageSeason(page, name, season, { nameTo } = {}) {
  await openScrimmagesTab(page);
  await page.locator('#scrimmage-list .scrimmage-item', { hasText: name }).locator('.btn-scrimmage-manage').click();
  await page.waitForSelector('#scrimmage-form-modal:not(.hidden)');
  if (nameTo) await page.fill('#input-scrimmage-name', nameTo);
  if (season) await page.selectOption('#select-scrimmage-season', String(season));
  await page.click('#btn-scrimmage-form-save');
}

const listOpr = async (page, tab, list, n) => {
  await openScoutingSubtab(page, tab);
  return (await page.locator(`${list} .team-item[data-team-number="${n}"] .team-opr-inline`).textContent()).trim();
};
const fmt = (v) => (v == null ? 'OPR: --' : `OPR: ${v.toFixed(1)}`);

// Adds a team LINKED through the Add modal's lookup (the real flow).
async function addLinked(page, number) {
  await openScoutingSubtab(page, 'info');
  await page.click('#btn-scrimmage-add-team');
  await page.waitForSelector('#scrimmage-team-modal:not(.hidden)');
  await page.fill('#input-scrimmage-team-number', String(number));
  await page.click('#btn-scrimmage-team-lookup');
  await page.waitForSelector('#ftc-lookup-modal:not(.hidden)');
  await page.click('#btn-ftc-lookup-go');
  await page.waitForSelector('#ftc-lookup-result:not(.hidden)');
  await page.click('#btn-ftc-lookup-confirm');
  await page.waitForFunction(() => document.getElementById('ftc-lookup-modal').classList.contains('hidden') && document.getElementById('scrimmage-team-modal').classList.contains('hidden'));
  await page.locator(`#team-list-info .team-item[data-team-number="${number}"]`).waitFor();
}

module.exports = {
  name: 'scrimmage season change refreshes linked teams\' OPR for the NEW season (lists + Team Details), "--" when FTCScout has none, cleared when unreachable, one batched request, entries path too',
  async run(ctx) {
    const captain = await ctx.makeUser('Captain Season');
    const page = await ctx.newPage('captain');
    await signInUI(page, captain);
    await createTeamUI(page, 'Season OPR Team');
    const teamId = await page.evaluate(() => currentTeamData.id);
    const currentSeason = await page.evaluate(() => String(getCurrentFtcSeason()));
    const oldSeason = String(Number(currentSeason) - 1);
    const ftcRequests = () => ctx.state.ftcScoutRequests.length;

    try {
      await createScrimmageUI(page, { name: 'Refresh Scrim', season: oldSeason });
      await openScrimmageUI(page, 'Refresh Scrim');
      const sid = await page.evaluate(() => selectedEvent.scrimmageId);
      const teams = () => readTeams(page, teamId, sid);

      // Linked in the OLD season (stats exist for every known team before the current season),
      // plus an UNLINKED team that must never be looked up.
      await addLinked(page, 1234);
      await addLinked(page, 3579);
      await page.click('#btn-scrimmage-add-team');
      await submitScrimmageTeamModal(page, { number: 4242, name: 'Manual Cats' });
      await page.locator('#team-list-info .team-item[data-team-number="4242"]').waitFor();
      let t = await teams();
      assert.equal(t[1234].opr, ftcScoutOpr(1234, oldSeason), 'sanity: linked with the OLD season OPR');
      assert.equal(t[3579].opr, ftcScoutOpr(3579, oldSeason));
      assert.notEqual(ftcScoutOpr(1234, oldSeason), ftcScoutOpr(1234, currentSeason), 'sanity: the mock gives different OPR per season');
      assert.equal(await listOpr(page, 'info', '#team-list-info', 1234), fmt(ftcScoutOpr(1234, oldSeason)));

      // ---------- a name-only edit: no season change, no FTCScout request ----------
      let before = ftcRequests();
      await manageSeason(page, 'Refresh Scrim', null, { nameTo: 'Refresh Scrim' });
      await page.waitForSelector('#scrimmage-form-modal', { state: 'hidden' });
      assert.equal(ftcRequests(), before, 'no request when the season did not change');

      // ---------- move to the NEW season: one batched request, linked teams only ----------
      before = ftcRequests();
      await manageSeason(page, 'Refresh Scrim', currentSeason);
      await noticeOpen(page, /No OPR For This Season Yet/);
      const sent = ctx.state.ftcScoutRequests.slice(before);
      assert.equal(sent.length, 1, 'ONE batched request for all the linked teams');
      assert.match(sent[0], /t_1234: teamByNumber/);
      assert.match(sent[0], /t_3579: teamByNumber/);
      assert.doesNotMatch(sent[0], /t_4242/, 'the unlinked team is never looked up');
      assert.match(sent[0], new RegExp(`quickStats\\(season: ${currentSeason}\\)`), 'for the NEW season');
      // The notice talks ONLY about the linked team that got "--" and says what unlinked teams show.
      const msg = (await page.textContent('#generic-confirm-message')).trim();
      assert.equal(msg, `FTCScout has no stats for the ${currentSeason}-${Number(currentSeason) + 1} season yet for #3579, so its OPR shows --. Teams that aren't linked to FTCScout show "unlinked" instead.`);
      assert.doesNotMatch(msg, /#1234|#4242/, 'only the team without data is named');
      await page.click('#btn-generic-confirm-proceed');
      await page.waitForSelector('#generic-confirm-modal', { state: 'hidden' });

      t = await teams();
      assert.equal(t[1234].opr, ftcScoutOpr(1234, currentSeason), "1234 now has the NEW season's OPR");
      assert.equal(t[3579].opr, null, '3579 has no stats in the new season: null, NOT the old number');
      assert.equal(t[1234].location, 'Austin, TX, USA', 'location kept/refreshed');
      assert.deepEqual([t[4242].linked, t[4242].opr, t[4242].name], [false, null, 'Manual Cats'], 'the unlinked team is untouched');
      assert.equal(String((await page.evaluate(() => currentScrimmage.season))), currentSeason);
      // ...in EVERY list, and Team Details (live) agrees.
      for (const [tab, list] of [['info', '#team-list-info'], ['pit', '#team-list-pit'], ['match', '#team-list-match']]) {
        assert.equal(await listOpr(page, tab, list, 1234), fmt(ftcScoutOpr(1234, currentSeason)), `${tab}: new season OPR`);
        assert.equal(await listOpr(page, tab, list, 3579), 'OPR: --', `${tab}: "--" where FTCScout has nothing`);
        assert.equal(await listOpr(page, tab, list, 4242), 'OPR: unlinked', `${tab}: an UNLINKED team says so (not a dash)`);
      }
      await openScoutingSubtab(page, 'info');
      await (await teamRow(page, '#team-list-info', 1234)).getByRole('button', { name: 'View Detail' }).click();
      await page.waitForSelector('#team-detail-modal:not(.hidden) #td-modal-body:not(.hidden)');
      assert.equal((await page.textContent('#td-opr-badge')).trim(), fmt(ftcScoutOpr(1234, currentSeason)), 'Team Details shows the same number');
      await page.click('#btn-team-detail-close');
      // A LINKED team with no stats this season reads "OPR: --" in Team Details too (like the lists) — not "N/A".
      await (await teamRow(page, '#team-list-info', 3579)).getByRole('button', { name: 'View Detail' }).click();
      await page.waitForSelector('#team-detail-modal:not(.hidden) #td-modal-body:not(.hidden)');
      assert.equal((await page.textContent('#td-opr-badge')).trim(), 'OPR: --', 'Team Details badge for a linked team with no stats');
      await page.click('#btn-team-detail-close');
      await (await teamRow(page, '#team-list-info', 4242)).getByRole('button', { name: 'View Detail' }).click();
      await page.waitForSelector('#team-detail-modal:not(.hidden) #td-modal-body:not(.hidden)');
      assert.equal((await page.textContent('#td-opr-badge')).trim(), 'OPR: unlinked', 'Team Details badge for an unlinked team');
      await page.click('#btn-team-detail-close');

      // ---------- FTCScout UNREACHABLE during the change: OPRs cleared (never wrong), user told ----------
      ctx.state.ftcScoutMode = 'abort';
      await manageSeason(page, 'Refresh Scrim', oldSeason);
      await noticeOpen(page, /OPR Not Refreshed/);
      assert.match(await page.textContent('#generic-confirm-message'), /couldn't be reached/);
      await page.click('#btn-generic-confirm-proceed');
      await page.waitForSelector('#generic-confirm-modal', { state: 'hidden' });
      ctx.state.ftcScoutMode = 'ok';
      t = await teams();
      assert.equal(String((await page.evaluate(() => currentScrimmage.season))), oldSeason, 'the season change itself still happened');
      assert.deepEqual([t[1234].opr, t[3579].opr], [null, null], 'no stale number is left: both cleared');
      assert.equal(t[1234].linked, true, 'and still linked');
      assert.equal(await listOpr(page, 'info', '#team-list-info', 1234), 'OPR: --');

      // ---------- the change-WITH-ENTRIES path (confirm -> delete -> write) refreshes too ----------
      await page.evaluate(async ([tid, id]) => {
        const code = selectedEvent.code;
        await db.collection('teams').doc(tid).collection('pitScouting').doc(`${tid}_${code}_1234`).set({
          eventCode: code, scrimmageId: id, teamNumber: 1234, teamId: tid, season: selectedEvent.season,
          scoutedBy: currentUser.uid, scoutedByName: 'Seed', checkpoint: { notes: 'real' }, activeEditors: {}
        });
      }, [teamId, sid]);
      before = ftcRequests();
      await manageSeason(page, 'Refresh Scrim', currentSeason);
      await page.waitForFunction(() => !document.getElementById('generic-confirm-modal').classList.contains('hidden')
        && /Change Season and Delete Entries\?/.test(document.getElementById('generic-confirm-title').textContent));
      assert.equal(ftcRequests(), before, 'nothing is looked up until the change is confirmed');
      await page.click('#btn-generic-confirm-proceed');
      await noticeOpen(page, /No OPR For This Season Yet/);
      await page.click('#btn-generic-confirm-proceed');
      await page.waitForSelector('#generic-confirm-modal', { state: 'hidden' });
      t = await teams();
      assert.equal(t[1234].opr, ftcScoutOpr(1234, currentSeason), 'refreshed after the confirmed change');
      assert.equal(t[3579].opr, null);
      assert.equal(await page.evaluate(async ([tid, c]) => (await db.collection('teams').doc(tid).collection('pitScouting').where('eventCode', '==', c).get()).size, [teamId, await page.evaluate(() => selectedEvent.code)]), 0, 'and the entries were deleted as before');

      // ---------- ONE team with no stats and NOBODY unlinked: plain sentence, no "unlinked" aside ----------
      await openScoutingSubtab(page, 'info');
      await page.evaluate(async ([tid, id]) => {
        const ref = db.collection('teams').doc(tid).collection('scrimmages').doc(id);
        await ref.update(new firebase.firestore.FieldPath('teams', '1234'), firebase.firestore.FieldValue.delete(),
          new firebase.firestore.FieldPath('teams', '4242'), firebase.firestore.FieldValue.delete());
      }, [teamId, sid]);                                              // only linked #3579 is left
      await page.waitForFunction(() => !currentScrimmage.teams['1234'] && !currentScrimmage.teams['4242']);
      await manageSeason(page, 'Refresh Scrim', oldSeason);
      await page.waitForSelector('#scrimmage-form-modal', { state: 'hidden' });   // old season has data: no notice
      await page.waitForFunction((v) => currentScrimmage.teams['3579'].opr === v, ftcScoutOpr(3579, oldSeason));   // the refresh runs just after the modal closes
      assert.equal((await teams())[3579].opr, ftcScoutOpr(3579, oldSeason));
      await manageSeason(page, 'Refresh Scrim', currentSeason);
      await noticeOpen(page, /No OPR For This Season Yet/);
      assert.equal((await page.textContent('#generic-confirm-message')).trim(), `FTCScout has no stats for the ${currentSeason}-${Number(currentSeason) + 1} season yet for #3579, so its OPR shows --.`);
      await page.click('#btn-generic-confirm-proceed');
      await page.waitForSelector('#generic-confirm-modal', { state: 'hidden' });

      // ---------- ...and with an UNLINKED team on the roster the notice says what that shows instead ----------
      await page.evaluate(async ([tid, id]) => {
        await db.collection('teams').doc(tid).collection('scrimmages').doc(id).update({
          'teams.4242': { number: 4242, name: 'Manual Cats', manualName: 'Manual Cats', linked: false, location: '', opr: null, linkedAt: null }
        });
      }, [teamId, sid]);
      await page.waitForFunction(() => !!currentScrimmage.teams['4242']);
      await manageSeason(page, 'Refresh Scrim', oldSeason);
      await page.waitForSelector('#scrimmage-form-modal', { state: 'hidden' });
      await page.waitForFunction(() => currentScrimmage.teams['3579'].opr != null);   // refresh done
      await manageSeason(page, 'Refresh Scrim', currentSeason);
      await noticeOpen(page, /No OPR For This Season Yet/);
      assert.equal((await page.textContent('#generic-confirm-message')).trim(), `FTCScout has no stats for the ${currentSeason}-${Number(currentSeason) + 1} season yet for #3579, so its OPR shows --. Teams that aren't linked to FTCScout show "unlinked" instead.`);
      await page.click('#btn-generic-confirm-proceed');
      await page.waitForSelector('#generic-confirm-modal', { state: 'hidden' });
      assert.equal(await listOpr(page, 'info', '#team-list-info', 3579), 'OPR: --', 'linked, no stats: still "--"');
      assert.equal(await listOpr(page, 'info', '#team-list-info', 4242), 'OPR: unlinked', 'unlinked: says so');

      // ---------- no linked team at all: no request ----------
      await page.evaluate(async ([tid, id]) => {
        await db.collection('teams').doc(tid).collection('scrimmages').doc(id).update({ 'teams.3579.linked': false });
      }, [teamId, sid]);
      await page.waitForFunction(() => currentScrimmage.teams['3579'].linked === false);
      before = ftcRequests();
      await manageSeason(page, 'Refresh Scrim', oldSeason);
      await page.waitForSelector('#scrimmage-form-modal', { state: 'hidden' });
      assert.equal(ftcRequests(), before, 'no linked teams: nothing to refresh, no request');
    } finally {
      ctx.state.ftcScoutMode = 'ok';
    }
  }
};
