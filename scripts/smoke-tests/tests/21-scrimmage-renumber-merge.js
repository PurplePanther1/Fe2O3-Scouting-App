// Unofficial scrimmages, phase 3 — renumbering a team that HAS scouting data, and merging
// two teams (js/scrimmage-merge.js). Run through the real UI against the real
// firestore.rules; the interesting user is the MANAGER-ONLY one (canManageScrimmages, not
// captain, not canEditOtherEntries): they can create copies and cascade-delete, but can
// NOT update another scout's committed entry.
//
//   1. renumber (free number): pit + match entries travel (new doc ids, every field and
//      the ORIGINAL scout kept, old docs and the old number's empty shell gone), the lists,
//      scouted checkmarks and Team Details are right at the new number without a refresh,
//      nothing throws in the live listeners
//   2. failures never lose data: create fails -> nothing changed; roster step fails -> the
//      copies are taken back out and the originals are untouched, a retry works; the final
//      delete fails -> everything is safe at the new number and "Try Again" cleans up
//   3. the manager-only user can do it (real rules); a plain member cannot (permission
//      hint, locked number); a live editor blocks it with a NAMED message
//   4. a roster number at Save = Merge choice (managers); "Change the number" backs out;
//      the ADD flows still just error on a duplicate
//   5. merge with NO overlap: a plain confirm that says exactly what moves (Cancel changes
//      nothing); B survives; a blank B name takes A's
//   6. merge with OVERLAP: the Compare screen (both-pit + same match + one that just
//      moves), default = B, "Use all of", per-field radios, equal fields collapse,
//      "(deleted field)" values, Cancel/X/click-out -> "Discard changes?" -> nothing
//      written; the merge lands the chosen values in the live fields AND the checkpoint,
//      keeps B's scoutedBy/scoutedAt, sets lastEditedBy to the manager; all-B choices leave
//      B's doc untouched
//   7. blocked at the final write: an editor who appears, or an entry that changed, while
//      the Compare screen was open

const assert = require('node:assert/strict');
const {
  signInUI, createTeamUI, joinTeamUI, createScrimmageUI, openScrimmageUI, openScoutingSubtab, teamRow
} = require('../lib/app');

const OTHER = { uid: 'scout-someone-else', name: 'Sam Scout' };
const OTHER2 = { uid: 'scout-another', name: 'Alex Scout' };

async function setManagePermission(capPage, memberName, on) {
  await capPage.click('#dashboard-tabs .tab[data-dtab="myteam"]');
  const row = capPage.locator('#member-list .member-item', { hasText: memberName });
  await row.getByRole('button', { name: 'Edit Permissions' }).click();
  await capPage.waitForSelector('#member-permissions-modal:not(.hidden)');
  await capPage.setChecked('#perm-canManageScrimmages', on);
  await capPage.click('#btn-member-perms-save');
  await capPage.waitForSelector('#member-permissions-modal', { state: 'hidden' });
}

async function openEdit(page, number) {
  await page.click('#dashboard-tabs .tab[data-dtab="scouting"]');
  await openScoutingSubtab(page, 'info');
  await (await teamRow(page, '#team-list-info', number)).locator('.btn-scrimmage-team-edit').click();
  await page.waitForSelector('#scrimmage-team-modal:not(.hidden)');
}
const modalClosed = (page) => page.waitForSelector('#scrimmage-team-modal', { state: 'hidden' });
const numberEnabled = (page) => page.waitForFunction(() => !document.getElementById('input-scrimmage-team-number').disabled);
const errorText = async (page) => (await page.textContent('#scrimmage-team-error')).trim();

module.exports = {
  name: 'scrimmage renumber WITH data + merge: entries travel (real rules, manager-only user), failures never lose data, Merge choice, plain confirm, Compare screen (per-field choices, Discard confirm), editors/changes block',
  async run(ctx) {
    const captain = await ctx.makeUser('Captain Merge');
    const manager = await ctx.makeUser('Manager Merge');
    const member = await ctx.makeUser('Member Merge');
    const page = await ctx.newPage('captain');
    await signInUI(page, captain);
    const joinCode = await createTeamUI(page, 'Merge Smoke Team');
    const teamId = await page.evaluate(() => currentTeamData.id);

    await createScrimmageUI(page, { name: 'Merge Scrim' });
    await openScrimmageUI(page, 'Merge Scrim');
    const sid = await page.evaluate(() => selectedEvent.scrimmageId);
    const code = await page.evaluate(() => selectedEvent.code);
    const season = await page.evaluate(() => selectedEvent.season);

    const unlinked = (n, name) => ({ number: n, name, manualName: name, linked: false, location: '', opr: null, linkedAt: null });
    const roster = () => page.evaluate(async ([tid, id]) => (await db.collection('teams').doc(tid).collection('scrimmages').doc(id).get()).data().teams || {}, [teamId, sid]);
    const addRoster = (entries) => page.evaluate(async ([tid, id, list]) => {
      const update = {};
      list.forEach(e => { update[`teams.${e.number}`] = e; });
      await db.collection('teams').doc(tid).collection('scrimmages').doc(id).update(update);
    }, [teamId, sid, entries]);

    // Seeds one pit/match doc as `by` (an arbitrary uid — the captain may create anything).
    const seed = (s) => page.evaluate(async ([tid, id, c, seasonStr, spec]) => {
      const col = db.collection('teams').doc(tid).collection(spec.kind === 'pit' ? 'pitScouting' : 'matchScouting');
      const docId = spec.kind === 'pit' ? `${tid}_${c}_${spec.number}` : `${tid}_${c}_${spec.matchNumber}_${spec.number}`;
      const editors = {};
      Object.entries(spec.editors || {}).forEach(([uid, name]) => { editors[uid] = { name, heartbeatAt: new Date() }; });
      const data = { eventCode: c, scrimmageId: id, teamNumber: spec.number, teamId: tid, season: seasonStr, activeEditors: editors };
      if (spec.kind === 'match') data.matchNumber = spec.matchNumber;
      if (!spec.shell) {
        Object.assign(data, spec.fields || {}, {
          scoutedBy: spec.by.uid, scoutedByName: spec.by.name,
          scoutedAt: firebase.firestore.Timestamp.fromMillis(spec.at || 1700000000000),
          checkpoint: { ...(spec.fields || {}) }
        });
        if (spec.edited) Object.assign(data, { lastEditedBy: spec.edited.uid, lastEditedByName: spec.edited.name, lastEditedByTimestamp: 1700000009000 });
      }
      await col.doc(docId).set(data);
      return docId;
    }, [teamId, sid, code, season, s]);
    const docsFor = (n) => page.evaluate(async ([tid, c, num]) => {
      const out = [];
      for (const kind of ['pitScouting', 'matchScouting']) {
        const snap = await db.collection('teams').doc(tid).collection(kind).where('eventCode', '==', c).where('teamNumber', '==', num).get();
        snap.forEach(d => out.push({ kind: kind === 'pitScouting' ? 'pit' : 'match', id: d.id, data: d.data() }));
      }
      return out.sort((a, b) => a.id.localeCompare(b.id));
    }, [teamId, code, n]);
    const pitDoc = async (n) => (await docsFor(n)).filter(d => d.kind === 'pit');
    const matchDocs = async (n) => (await docsFor(n)).filter(d => d.kind === 'match');
    const millis = (t) => (t && (t.seconds != null ? t.seconds * 1000 : t._seconds * 1000)) || null;

    // ======================================================================
    // 1. Renumber a team WITH data to a free number (captain)
    // ======================================================================
    await addRoster([unlinked(7100, 'Seven Hundred')]);
    await page.waitForFunction(() => currentScrimmage.teams['7100']);
    await seed({ kind: 'pit', number: 7100, by: OTHER, edited: OTHER2, fields: { driveType: 'Mecanum', notes: 'pit notes 7100', claimedCycleTime: 7 } });
    await seed({ kind: 'match', number: 7100, matchNumber: 1, by: OTHER, fields: { autoScore: 11, notes: 'm1' } });
    await seed({ kind: 'match', number: 7100, matchNumber: 2, by: OTHER2, fields: { autoScore: 22, notes: 'm2' } });
    await page.evaluate(async ([tid, id, c]) => { // an empty shell on a DIFFERENT slot of the old number
      await db.collection('teams').doc(tid).collection('matchScouting').doc(`${tid}_${c}_9_7100`).set({ eventCode: c, scrimmageId: id, teamNumber: 7100, teamId: tid, matchNumber: 9, activeEditors: {} });
    }, [teamId, sid, code]);
    // an empty shell already sitting ON the new pit doc id (it must be cleared away before the copy can be created)
    await seed({ kind: 'pit', number: 7200, shell: true });
    const before = await docsFor(7100);
    assert.equal(before.length, 4, 'seeded: pit + 2 match entries + 1 shell');

    await openScoutingSubtab(page, 'pit');
    await (await teamRow(page, '#team-list-pit', 7100)).locator('.pit-row-meta').waitFor();   // scouted checkmark at the OLD number
    await openEdit(page, 7100);
    await numberEnabled(page);
    assert.equal((await page.textContent('#scrimmage-team-number-hint')).trim(), "This team's 3 scouting entries move with it if you change the number.", 'committed entries only (the shell is not counted)');
    await page.fill('#input-scrimmage-team-number', '7200');
    await page.click('#btn-scrimmage-team-save');
    await modalClosed(page);
    await page.waitForFunction(() => currentScrimmage.teams['7200'] && !currentScrimmage.teams['7100']);
    assert.match(await page.textContent('#scrimmage-roster-success'), /Team #7100 is now #7200\. 2 match entries and 1 pit entry moved with it\./);

    assert.equal((await docsFor(7100)).length, 0, 'old docs AND the old number\'s empty shell are gone');
    const moved = await docsFor(7200);
    assert.equal(moved.length, 3, 'three docs at the new number (the shell was not copied)');
    const mPit = moved.find(d => d.kind === 'pit');
    assert.equal(mPit.id, `${teamId}_${code}_7200`, 'new pit doc id embeds the new number');
    assert.deepEqual([mPit.data.teamNumber, mPit.data.driveType, mPit.data.notes, mPit.data.claimedCycleTime, mPit.data.scoutedBy, mPit.data.scoutedByName, mPit.data.lastEditedBy, mPit.data.lastEditedByName],
      [7200, 'Mecanum', 'pit notes 7100', 7, OTHER.uid, OTHER.name, OTHER2.uid, OTHER2.name], 'every field copied; the ORIGINAL scout and last editor kept');
    assert.deepEqual(mPit.data.checkpoint, { driveType: 'Mecanum', notes: 'pit notes 7100', claimedCycleTime: 7 }, 'checkpoint copied');
    assert.equal(millis(mPit.data.scoutedAt), 1700000000000, 'scoutedAt kept');
    const mMatch = moved.filter(d => d.kind === 'match');
    assert.deepEqual(mMatch.map(d => d.id), [`${teamId}_${code}_1_7200`, `${teamId}_${code}_2_7200`]);
    assert.deepEqual(mMatch.map(d => [d.data.teamNumber, d.data.matchNumber, d.data.autoScore, d.data.scoutedByName]), [[7200, 1, 11, OTHER.name], [7200, 2, 22, OTHER2.name]]);

    // Lists / counts / checkmarks / Team Details at the NEW number, no refresh.
    await openScoutingSubtab(page, 'pit');
    await (await teamRow(page, '#team-list-pit', 7200)).locator('.pit-row-meta').waitFor();
    assert.equal(await page.locator('#team-list-pit .team-item[data-team-number="7100"]').count(), 0, 'pit list: the old number is gone');
    assert.ok(await page.evaluate(([c]) => isTeamScouted(7200, c) && !isTeamScouted(7100, c), [code]), 'scoutedTeamsCache: new number scouted, old not');
    await openScoutingSubtab(page, 'match');
    await page.waitForFunction(([c]) => getMatchEntriesForTeam(7200, c).length === 2 && getMatchEntriesForTeam(7100, c).length === 0, [code]);
    await (await teamRow(page, '#team-list-match', 7200)).locator('.match-count-badge:not(.hidden)').waitFor();
    assert.equal((await (await teamRow(page, '#team-list-match', 7200)).locator('.match-count-badge').textContent()).trim().replace(/\D+/g, ''), '2', 'match list: 2 matches at the new number');
    await openScoutingSubtab(page, 'info');
    await (await teamRow(page, '#team-list-info', 7200)).getByRole('button', { name: 'View Detail' }).click();
    await page.waitForSelector('#team-detail-modal:not(.hidden) #td-modal-body:not(.hidden)');
    await page.waitForFunction(() => /2/.test(document.getElementById('td-match-count').textContent) && document.querySelectorAll('#td-pit-data-list > *').length > 0);
    assert.equal((await page.textContent('#td-team-number')).trim(), '#7200');
    await page.click('#btn-team-detail-close');

    // ======================================================================
    // 2. Failures never lose data
    // ======================================================================
    await addRoster([unlinked(7300, 'Fail Seven')]);
    await page.waitForFunction(() => currentScrimmage.teams['7300']);
    await seed({ kind: 'pit', number: 7300, by: OTHER, fields: { driveType: 'Swerve', notes: 'keep me' } });
    await seed({ kind: 'match', number: 7300, matchNumber: 3, by: OTHER2, fields: { autoScore: 33 } });
    const failRenumber = async () => {
      await openEdit(page, 7300);
      await numberEnabled(page);
      await page.fill('#input-scrimmage-team-number', '7400');
      await page.click('#btn-scrimmage-team-save');
    };

    // (a) creating the copies fails -> nothing changed anywhere
    await page.evaluate(() => { window.__realCommit = window.commitSetsInBatches; window.commitSetsInBatches = async () => { throw Object.assign(new Error('boom'), { code: 'unavailable' }); }; });
    await failRenumber();
    await page.waitForFunction(() => /Could not copy the scouting entries/.test(document.getElementById('scrimmage-team-error').textContent));
    assert.match(await errorText(page), /Nothing was changed/);
    assert.equal((await docsFor(7300)).length, 2, '(a) originals untouched');
    assert.equal((await docsFor(7400)).length, 0, '(a) no copies');
    assert.ok((await roster())[7300] && !(await roster())[7400], '(a) roster untouched');
    await page.evaluate(() => { window.commitSetsInBatches = window.__realCommit; });

    // (b) the roster step fails AFTER the copies exist -> the copies are taken back out, originals untouched, retry works
    await page.evaluate(() => {
      window.__realTx = db.runTransaction.bind(db);
      db.runTransaction = () => Promise.reject(Object.assign(new Error('boom'), { code: 'unavailable' }));
    });
    await page.click('#btn-scrimmage-team-save');
    await page.waitForFunction(() => /roster could not be updated/.test(document.getElementById('scrimmage-team-error').textContent));
    assert.equal((await docsFor(7300)).length, 2, '(b) originals untouched');
    assert.equal((await docsFor(7400)).length, 0, '(b) the copies were rolled back');
    assert.ok((await roster())[7300] && !(await roster())[7400], '(b) roster untouched');
    await page.evaluate(() => { db.runTransaction = window.__realTx; });
    await page.click('#btn-scrimmage-team-save');                        // RETRY, same modal
    await modalClosed(page);
    await page.waitForFunction(() => currentScrimmage.teams['7400'] && !currentScrimmage.teams['7300']);
    assert.equal((await docsFor(7300)).length, 0);
    assert.deepEqual((await docsFor(7400)).map(d => d.kind), ['match', 'pit'], '(b) retry moved everything');

    // (c) the FINAL delete fails -> everything is safe at the new number, the roster is done, Try Again cleans up
    await addRoster([unlinked(7500, 'Cleanup Seven')]);
    await page.waitForFunction(() => currentScrimmage.teams['7500']);
    await seed({ kind: 'pit', number: 7500, by: OTHER, fields: { driveType: 'Tank (2-motor, left/right)' } });
    await seed({ kind: 'match', number: 7500, matchNumber: 1, by: OTHER, fields: { autoScore: 5 } });
    await page.evaluate(() => { window.__realDel = window.deleteRefsReportingLeftovers; window.deleteRefsReportingLeftovers = async (refs) => refs; });
    await openEdit(page, 7500);
    await numberEnabled(page);
    await page.fill('#input-scrimmage-team-number', '7600');
    await page.click('#btn-scrimmage-team-save');
    await modalClosed(page);
    await page.waitForSelector('#generic-confirm-modal:not(.hidden)');
    assert.equal((await page.textContent('#generic-confirm-title')).trim(), 'Some Old Entries Remain');
    assert.match(await page.textContent('#generic-confirm-message'), /Renumbering #7500 to #7600 is done and every entry is safe at its new number, but 2 old entries could not be removed/);
    assert.equal((await docsFor(7600)).length, 2, '(c) the copies are complete');
    assert.equal((await docsFor(7500)).length, 2, '(c) harmless duplicates remain');
    assert.ok((await roster())[7600] && !(await roster())[7500], '(c) the roster is already re-keyed');
    await page.evaluate(() => { window.deleteRefsReportingLeftovers = window.__realDel; });
    await page.click('#btn-generic-confirm-proceed');                    // Try Again
    await page.waitForFunction(async ([tid, c]) => (await db.collection('teams').doc(tid).collection('pitScouting').where('eventCode', '==', c).where('teamNumber', '==', 7500).get()).size === 0, [teamId, code]);
    assert.equal((await docsFor(7500)).length, 0, '(c) Try Again removed the leftovers');
    assert.equal((await docsFor(7600)).length, 2);

    // ======================================================================
    // 3. Permissions: a manager-only user (real rules), a plain member, a live editor
    // ======================================================================
    const mgrPage = await ctx.newPage('manager');
    await signInUI(mgrPage, manager);
    await joinTeamUI(mgrPage, joinCode);
    await setManagePermission(page, 'Manager Merge', true);
    const memPage = await ctx.newPage('member');
    await signInUI(memPage, member);
    await joinTeamUI(memPage, joinCode);
    await openScrimmageUI(mgrPage, 'Merge Scrim');
    await openScrimmageUI(memPage, 'Merge Scrim');
    await mgrPage.waitForFunction(() => currentScrimmage.teams['7600'] && typeof canUserManageScrimmages === 'function' && canUserManageScrimmages() && !canUserEditOtherEntries());
    assert.ok(await mgrPage.evaluate(() => currentTeamData.roles[currentUser.uid] !== 'captain'), 'the manager is NOT the captain');

    // a member: number locked with the permission hint, even on a team with data
    await openEdit(memPage, 7600);
    await memPage.waitForFunction(() => /needs a captain or scrimmage permission/.test(document.getElementById('scrimmage-team-number-hint').textContent));
    assert.ok(await memPage.isDisabled('#input-scrimmage-team-number'), 'a member can never renumber a team with data');
    assert.ok(!(await memPage.isVisible('#scrimmage-team-merge-choice')));
    await memPage.click('#btn-scrimmage-team-cancel');
    await modalClosed(memPage);

    // the manager-only user renumbers a team that holds OTHER people's committed entries
    await addRoster([unlinked(7700, 'Mgr Moves')]);
    await mgrPage.waitForFunction(() => currentScrimmage.teams['7700']);
    await seed({ kind: 'pit', number: 7700, by: OTHER, edited: OTHER2, fields: { driveType: 'H-Drive', notes: 'someone else wrote this' } });
    await seed({ kind: 'match', number: 7700, matchNumber: 4, by: OTHER2, fields: { autoScore: 44 } });
    await openEdit(mgrPage, 7700);
    await numberEnabled(mgrPage);
    await mgrPage.fill('#input-scrimmage-team-number', '7710');
    await mgrPage.click('#btn-scrimmage-team-save');
    await modalClosed(mgrPage);
    await mgrPage.waitForFunction(() => currentScrimmage.teams['7710'] && !currentScrimmage.teams['7700']);
    assert.equal((await docsFor(7700)).length, 0, 'manager-only: the old entries were deleted (cascade clause)');
    const mgrMoved = await docsFor(7710);
    assert.deepEqual(mgrMoved.map(d => [d.kind, d.data.scoutedBy]), [['match', OTHER2.uid], ['pit', OTHER.uid]], 'manager-only: copies created with the ORIGINAL scouts as owners');
    assert.equal(mgrMoved.find(d => d.kind === 'pit').data.notes, 'someone else wrote this');

    // a live editor blocks the renumber with a named message (also at Save)
    await addRoster([unlinked(7800, 'Busy Eight')]);
    await page.waitForFunction(() => currentScrimmage.teams['7800']);
    await seed({ kind: 'pit', number: 7800, by: OTHER, fields: { driveType: 'Mecanum' } });
    await openEdit(page, 7800);
    await numberEnabled(page);
    await seed({ kind: 'match', number: 7800, matchNumber: 1, by: OTHER, fields: { autoScore: 1 }, editors: { pat: 'Pat' } });
    await page.fill('#input-scrimmage-team-number', '7810');
    await page.click('#btn-scrimmage-team-save');
    await page.waitForFunction(() => /Pat is editing/.test(document.getElementById('scrimmage-team-error').textContent));
    assert.equal(await errorText(page), 'Pat is editing a scouting entry for this team. Wait until they are finished before changing its number.');
    assert.equal((await docsFor(7810)).length, 0, 'nothing copied');
    assert.ok((await roster())[7800] && !(await roster())[7810], 'nothing re-keyed');
    await page.click('#btn-scrimmage-team-cancel');
    await modalClosed(page);

    // ======================================================================
    // 4. The ADD flows still just error on a duplicate (nothing to merge)
    // ======================================================================
    await openScoutingSubtab(page, 'info');
    await page.click('#btn-scrimmage-add-team');
    await page.waitForSelector('#scrimmage-team-modal:not(.hidden)');
    await page.fill('#input-scrimmage-team-number', '7600');
    await page.click('#btn-scrimmage-team-save');
    await page.waitForFunction(() => /already on this scrimmage's roster/.test(document.getElementById('scrimmage-team-error').textContent));
    assert.ok(!(await page.isVisible('#scrimmage-team-merge-choice')), 'Add: no merge offer');
    await page.click('#btn-scrimmage-team-cancel');
    await modalClosed(page);

    // ======================================================================
    // 5. Merge with NO overlap: a plain confirm that says exactly what moves
    // ======================================================================
    await addRoster([unlinked(8100, 'Typed A Name'), unlinked(8200, ''), unlinked(8300, 'Eight Three'), unlinked(8400, 'Eight Four')]);
    await page.waitForFunction(() => currentScrimmage.teams['8400']);
    // A = 8100: pit + match 1,2,3.  B = 8200 (blank name): match 4 only -> NO overlap.
    await seed({ kind: 'pit', number: 8100, by: OTHER, fields: { driveType: 'Mecanum', notes: 'A pit' } });
    for (const m of [1, 2, 3]) await seed({ kind: 'match', number: 8100, matchNumber: m, by: OTHER, fields: { autoScore: m * 10, notes: 'A m' + m } });
    await seed({ kind: 'match', number: 8200, matchNumber: 4, by: OTHER2, fields: { autoScore: 40 } });
    await openEdit(page, 8100);
    await numberEnabled(page);
    await page.fill('#input-scrimmage-team-number', '8200');
    await page.click('#btn-scrimmage-team-save');
    await page.waitForSelector('#scrimmage-team-merge-choice:not(.hidden)');
    assert.equal((await page.textContent('#scrimmage-team-merge-text')).trim(), 'Team #8200 is already on this scrimmage.', 'B has no name: no parentheses');
    assert.equal((await page.textContent('#btn-scrimmage-team-merge')).trim(), 'Merge #8100 into #8200');
    assert.ok(await page.isDisabled('#btn-scrimmage-team-save'));
    await page.click('#btn-scrimmage-team-merge');
    await page.waitForSelector('#generic-confirm-modal:not(.hidden)');
    assert.equal((await page.textContent('#generic-confirm-title')).trim(), 'Merge #8100 into #8200?');
    assert.equal((await page.textContent('#generic-confirm-message')).trim(), '3 match entries and 1 pit entry from #8100 move to #8200. #8100 is removed from the roster.');
    assert.ok(!(await page.isVisible('#scrimmage-merge-modal')), 'no overlap: no Compare screen');
    // Cancel changes nothing
    await page.click('#btn-generic-confirm-cancel');
    await page.waitForSelector('#generic-confirm-modal', { state: 'hidden' });
    await page.waitForTimeout(700);
    assert.equal((await docsFor(8100)).length, 4);
    assert.equal((await docsFor(8200)).length, 1);
    assert.ok((await roster())[8100], 'still on the roster');
    assert.ok(await page.isVisible('#scrimmage-team-merge-choice'), 'the choice is still showing');
    // Merge
    await page.click('#btn-scrimmage-team-merge');
    await page.waitForSelector('#generic-confirm-modal:not(.hidden)');
    await page.click('#btn-generic-confirm-proceed');
    await modalClosed(page);
    await page.waitForFunction(() => !currentScrimmage.teams['8100']);
    assert.match(await page.textContent('#scrimmage-roster-success'), /Merged Team #8100 into Team #8200\./);
    assert.equal((await docsFor(8100)).length, 0, 'A\'s entries are gone from #8100');
    const merged = await docsFor(8200);
    assert.deepEqual(merged.map(d => d.id).sort(), [`${teamId}_${code}_1_8200`, `${teamId}_${code}_2_8200`, `${teamId}_${code}_3_8200`, `${teamId}_${code}_4_8200`, `${teamId}_${code}_8200`].sort(), 'A\'s pit + matches moved onto #8200 next to B\'s match 4');
    assert.deepEqual([(await roster())[8200].name, (await roster())[8200].manualName], ['Typed A Name', 'Typed A Name'], 'B\'s blank name took A\'s');
    assert.equal(merged.find(d => d.id.endsWith('_4_8200')).data.scoutedBy, OTHER2.uid, 'B\'s own entry untouched');

    // ======================================================================
    // 6. Merge with OVERLAP: the Compare screen — run as the MANAGER-ONLY user
    // ======================================================================
    // A = 8300: pit, match 1 (conflict), match 2 (just moves).  B = 8400: pit (conflict), match 1 (conflict), match 5.
    await seed({ kind: 'pit', number: 8300, by: OTHER, edited: OTHER2, at: 1700000100000,
      fields: { driveType: 'Mecanum', autoCapability: 'Basic (1 preload + park)', claimedCycleTime: 6, notes: 'A pit notes', legacyThing: 'only on A' } });
    await seed({ kind: 'pit', number: 8400, by: OTHER2, at: 1700000200000,
      fields: { driveType: 'Swerve', autoCapability: 'Basic (1 preload + park)', claimedCycleTime: 6, notes: 'B pit notes' } });
    await seed({ kind: 'match', number: 8300, matchNumber: 1, by: OTHER, at: 1700000300000, fields: { autoScore: 10, teleopScore: 50, notes: 'A m1' } });
    await seed({ kind: 'match', number: 8400, matchNumber: 1, by: OTHER2, at: 1700000400000, edited: OTHER, fields: { autoScore: 30, teleopScore: 50, notes: 'B m1' } });
    await seed({ kind: 'match', number: 8300, matchNumber: 2, by: OTHER, fields: { autoScore: 20 } });
    await seed({ kind: 'match', number: 8400, matchNumber: 5, by: OTHER2, fields: { autoScore: 55 } });
    await mgrPage.waitForFunction(() => currentScrimmage.teams['8300'] && currentScrimmage.teams['8400']);

    await openEdit(mgrPage, 8300);
    await numberEnabled(mgrPage);
    await mgrPage.fill('#input-scrimmage-team-number', '8400');
    await mgrPage.click('#btn-scrimmage-team-save');
    await mgrPage.waitForSelector('#scrimmage-team-merge-choice:not(.hidden)');
    await mgrPage.click('#btn-scrimmage-team-merge');
    await mgrPage.waitForSelector('#scrimmage-merge-modal:not(.hidden)');
    assert.equal((await mgrPage.textContent('#merge-compare-title')).trim(), 'Merge #8300 into #8400');
    assert.equal((await mgrPage.textContent('#btn-merge-compare-confirm')).trim(), 'Merge into #8400');
    assert.equal((await mgrPage.textContent('#merge-compare-summary')).trim(), '1 more match entry and 0 pit entries from #8300 will move to #8400.');
    const zs = await mgrPage.evaluate(() => ['scrimmage-merge-modal', 'scrimmage-team-modal', 'generic-confirm-modal'].map(id => Number(getComputedStyle(document.getElementById(id)).zIndex)));
    assert.ok(zs[0] > zs[1] && zs[2] > zs[0], 'Compare is above the Edit modal and below the generic confirm: ' + zs);
    assert.equal(await mgrPage.locator('#merge-compare-list .merge-conflict').count(), 2, 'two conflicts: pit + match 1 (match 2 simply moves)');
    assert.deepEqual(await mgrPage.locator('#merge-compare-list .merge-conflict-title').allTextContents(), ['Pit scouting', 'Match 1']);
    const pitSec = mgrPage.locator('.merge-conflict[data-conflict="pit"]');
    const m1Sec = mgrPage.locator('.merge-conflict[data-conflict="match:1"]');
    // who scouted each, and when
    assert.match(await pitSec.locator('.merge-side').nth(0).textContent(), /#8300.*Scouted by Sam Scout.*last edited by Alex Scout/s);
    assert.match(await pitSec.locator('.merge-side').nth(1).textContent(), /#8400.*Scouted by Alex Scout/s);
    // differing fields have radios (default = B); equal fields collapse into "Same on both"
    const differing = await pitSec.locator('.merge-field').evaluateAll(els => els.map(e => e.dataset.field));
    assert.deepEqual(differing.sort(), ['driveType', 'legacyThing', 'notes'].sort(), 'only fields whose values differ get radios (incl. the deleted field)');
    const sameLines = await pitSec.locator('.merge-same-line').evaluateAll(els => els.map(e => e.dataset.field));
    assert.deepEqual(sameLines.sort(), ['autoCapability', 'claimedCycleTime'].sort(), 'equal fields collapse to one line');
    assert.match(await pitSec.locator('.merge-field[data-field="legacyThing"] .merge-field-label').textContent(), /legacyThing \(deleted field\)/);
    assert.match(await pitSec.locator('.merge-field[data-field="legacyThing"]').textContent(), /only on A/);
    assert.match(await pitSec.locator('.merge-field[data-field="legacyThing"]').textContent(), /\(blank\)/);
    const checkedOf = (sec) => sec.locator('input[type="radio"]:checked').evaluateAll(els => els.map(e => e.value));
    assert.deepEqual(await checkedOf(pitSec), ['b', 'b', 'b'], 'default = B everywhere');
    assert.deepEqual(await checkedOf(m1Sec), ['b', 'b'], 'default = B (match 1: autoScore + notes)');
    assert.equal(await m1Sec.locator('.merge-same-line[data-field="teleopScore"]').count(), 1);
    assert.ok(!(await mgrPage.isDisabled('#btn-merge-compare-confirm')), 'with defaults nothing is unresolved: Merge is enabled');

    // Cancel -> "Discard changes?" -> back to the Compare screen
    await pitSec.locator('[data-use-all="a"]').click();
    assert.deepEqual(await checkedOf(pitSec), ['a', 'a', 'a'], 'Use all of #8300');
    await mgrPage.click('#btn-merge-compare-cancel');
    await mgrPage.waitForSelector('#generic-confirm-modal:not(.hidden)');
    assert.equal((await mgrPage.textContent('#generic-confirm-title')).trim(), 'Discard changes?');
    await mgrPage.click('#btn-generic-confirm-cancel');
    await mgrPage.waitForSelector('#generic-confirm-modal', { state: 'hidden' });
    assert.ok(await mgrPage.isVisible('#scrimmage-merge-modal'), 'declining the discard keeps the Compare screen (and the choices)');
    assert.deepEqual(await checkedOf(pitSec), ['a', 'a', 'a']);
    // X and click-out ask too; Discard returns to the Edit modal exactly as it was
    await mgrPage.click('#btn-merge-compare-close');
    await mgrPage.waitForSelector('#generic-confirm-modal:not(.hidden)');
    assert.equal((await mgrPage.textContent('#generic-confirm-title')).trim(), 'Discard changes?');
    await mgrPage.click('#btn-generic-confirm-cancel');
    await mgrPage.locator('#scrimmage-merge-modal-overlay').click({ position: { x: 3, y: 3 } });
    await mgrPage.waitForSelector('#generic-confirm-modal:not(.hidden)');
    await mgrPage.click('#btn-generic-confirm-proceed');             // Discard
    await mgrPage.waitForSelector('#scrimmage-merge-modal', { state: 'hidden' });
    await mgrPage.waitForTimeout(900);
    assert.ok(await mgrPage.isVisible('#scrimmage-team-modal'), 'back in the Edit modal');
    assert.equal(await mgrPage.inputValue('#input-scrimmage-team-number'), '8400', 'exactly as it was (number)');
    assert.ok(await mgrPage.isVisible('#scrimmage-team-merge-choice'), 'and the merge choice is still showing');
    assert.equal((await docsFor(8300)).length, 3, 'discard: nothing written (A)');
    assert.equal((await docsFor(8400)).length, 3, 'discard: nothing written (B)');
    assert.ok((await roster())[8300], 'discard: roster untouched');

    // Now do it: pit = all of A ("Use all of #8300"); match 1 = per-field (notes from A, autoScore stays B)
    await mgrPage.click('#btn-scrimmage-team-merge');
    await mgrPage.waitForSelector('#scrimmage-merge-modal:not(.hidden)');
    assert.deepEqual(await checkedOf(mgrPage.locator('.merge-conflict[data-conflict="pit"]')), ['b', 'b', 'b'], 'reopened fresh: default = B again');
    await mgrPage.locator('.merge-conflict[data-conflict="pit"] [data-use-all="a"]').click();
    await mgrPage.locator('.merge-conflict[data-conflict="match:1"] .merge-field[data-field="notes"] input[value="a"]').check();
    await mgrPage.click('#btn-merge-compare-confirm');
    await mgrPage.waitForSelector('#scrimmage-merge-modal', { state: 'hidden' });
    await modalClosed(mgrPage);
    await mgrPage.waitForFunction(() => !currentScrimmage.teams['8300']);

    assert.equal((await docsFor(8300)).length, 0, 'A\'s docs are gone');
    const after = await docsFor(8400);
    assert.equal(after.length, 4, 'B: merged pit, merged match 1, moved match 2, own match 5');
    assert.ok(!after.some(d => d.id === `${teamId}_${code}_8400`), 'B\'s old pit doc was replaced (a manager-only user cannot update it in place)');
    const mp = after.find(d => d.kind === 'pit');
    assert.match(mp.id, /_8400_m/, 'the merged entry lives under a fresh id');
    assert.deepEqual([mp.data.driveType, mp.data.notes, mp.data.legacyThing, mp.data.autoCapability, mp.data.claimedCycleTime], ['Mecanum', 'A pit notes', 'only on A', 'Basic (1 preload + park)', 6], 'live fields: A\'s chosen values');
    assert.deepEqual(mp.data.checkpoint, { driveType: 'Mecanum', autoCapability: 'Basic (1 preload + park)', claimedAvgAutoScore: null, claimedAvgTeleopScore: null, claimedCycleTime: 6, notes: 'A pit notes', legacyThing: 'only on A' }, 'the chosen values are in the CHECKPOINT too (every configured field, null when unset — like a normal commit)');
    assert.deepEqual([mp.data.teamNumber, mp.data.scoutedBy, mp.data.scoutedByName, millis(mp.data.scoutedAt)], [8400, OTHER2.uid, OTHER2.name, 1700000200000], 'B\'s scoutedBy / scoutedAt kept');
    const mgrUid = await mgrPage.evaluate(() => currentUser.uid);
    assert.deepEqual([mp.data.lastEditedBy, mp.data.lastEditedByName], [mgrUid, 'Manager Merge'], 'lastEditedBy = the manager who merged');
    const mm1 = after.find(d => d.kind === 'match' && d.data.matchNumber === 1);
    assert.deepEqual([mm1.data.autoScore, mm1.data.notes, mm1.data.teleopScore], [30, 'A m1', 50], 'match 1: autoScore stays B\'s, notes are A\'s');
    assert.deepEqual([mm1.data.checkpoint.autoScore, mm1.data.checkpoint.notes], [30, 'A m1'], 'match 1 checkpoint too');
    assert.equal(mm1.data.scoutedBy, OTHER2.uid, 'match 1 keeps B\'s scouter');
    assert.equal(after.find(d => d.id === `${teamId}_${code}_2_8400`).data.autoScore, 20, 'match 2 simply moved');
    assert.equal(after.find(d => d.data.matchNumber === 5).id, `${teamId}_${code}_5_8400`, 'B\'s own match 5 untouched');

    // ---- all-B choices leave B's docs completely alone (same ids, no lastEditedBy change) ----
    await addRoster([unlinked(8500, 'Eight Five'), unlinked(8600, 'Eight Six')]);
    await seed({ kind: 'pit', number: 8500, by: OTHER, fields: { driveType: 'Mecanum', notes: 'a' } });
    const bId = await seed({ kind: 'pit', number: 8600, by: OTHER2, edited: OTHER, fields: { driveType: 'Swerve', notes: 'b' } });
    await page.waitForFunction(() => currentScrimmage.teams['8600']);
    await openEdit(page, 8500);
    await numberEnabled(page);
    await page.fill('#input-scrimmage-team-number', '8600');
    await page.click('#btn-scrimmage-team-save');
    await page.click('#btn-scrimmage-team-merge');
    await page.waitForSelector('#scrimmage-merge-modal:not(.hidden)');
    await page.click('#btn-merge-compare-confirm');                   // defaults: all B
    await page.waitForSelector('#scrimmage-merge-modal', { state: 'hidden' });
    await modalClosed(page);
    await page.waitForFunction(() => !currentScrimmage.teams['8500']);
    const keep = await pitDoc(8600);
    assert.equal(keep.length, 1);
    assert.equal(keep[0].id, bId, 'all-B: B\'s doc keeps its id');
    assert.deepEqual([keep[0].data.driveType, keep[0].data.lastEditedBy, keep[0].data.lastEditedByName], ['Swerve', OTHER.uid, OTHER.name], 'and its lastEditedBy is NOT touched');
    assert.equal((await docsFor(8500)).length, 0);

    // ======================================================================
    // 7. Blocked at the final write: an editor appears / an entry changes while the Compare screen is open
    // ======================================================================
    await addRoster([unlinked(8700, 'Eight Seven'), unlinked(8800, 'Eight Eight')]);
    await page.waitForFunction(() => currentScrimmage.teams['8800']);
    await seed({ kind: 'pit', number: 8700, by: OTHER, fields: { driveType: 'Mecanum', notes: 'a7' } });
    await seed({ kind: 'pit', number: 8800, by: OTHER2, fields: { driveType: 'Swerve', notes: 'b8' } });
    await openEdit(page, 8700);
    await numberEnabled(page);
    await page.fill('#input-scrimmage-team-number', '8800');
    await page.click('#btn-scrimmage-team-save');
    await page.click('#btn-scrimmage-team-merge');
    await page.waitForSelector('#scrimmage-merge-modal:not(.hidden)');
    // somebody opens B's match form meanwhile
    await seed({ kind: 'match', number: 8800, matchNumber: 7, by: OTHER2, fields: { autoScore: 1 }, editors: { robin: 'Robin' } });
    await page.click('#btn-merge-compare-confirm');
    await page.waitForFunction(() => /Robin is editing/.test(document.getElementById('merge-compare-error').textContent));
    assert.equal((await page.textContent('#merge-compare-error')).trim(), 'Robin is editing a scouting entry for one of these teams. Wait until they are finished before merging them.');
    assert.ok(await page.isVisible('#scrimmage-merge-modal'), 'the Compare screen stays open');
    assert.equal((await docsFor(8700)).length, 1, 'nothing written');
    // ...they leave, but B's pit entry was edited while the screen was open
    await seed({ kind: 'match', number: 8800, matchNumber: 7, by: OTHER2, fields: { autoScore: 1 } });
    await page.evaluate(async ([tid, c]) => {
      await db.collection('teams').doc(tid).collection('pitScouting').doc(`${tid}_${c}_8800`).update({ notes: 'changed behind your back' });
    }, [teamId, code]);
    await page.click('#btn-merge-compare-confirm');
    await page.waitForFunction(() => /changed while you were deciding/.test(document.getElementById('merge-compare-error').textContent));
    assert.match(await page.textContent('#merge-compare-error'), /Nothing was changed/);
    assert.equal((await docsFor(8700)).length, 1, 'still nothing written');
    assert.ok((await roster())[8700], 'and A is still on the roster');
    await page.click('#btn-merge-compare-cancel');
    await page.click('#btn-generic-confirm-proceed');
    await page.waitForSelector('#scrimmage-merge-modal', { state: 'hidden' });
    await page.click('#btn-scrimmage-team-cancel');
    await modalClosed(page);
  }
};
