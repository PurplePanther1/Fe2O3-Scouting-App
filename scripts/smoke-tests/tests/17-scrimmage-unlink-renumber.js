// Unofficial scrimmages — roster Edit on a LINKED team: read-only name, staged
// Unlink, and renumbering (a team WITH data renumbers/merges since phase 3 — see
// test 21; here the empty-team basics):
//   - a linked team's name box is read-only; "Unlink from FTCScout" STAGES an unlink
//     (nothing written until Save; Cancel reverts it)
//   - unlinking unlocks the name box (current text kept) and — only if safe — the
//     number box when the user may remove roster keys (captain / canManageScrimmages)
//     and nobody else is editing the team (direct query). Otherwise it stays locked
//     with a hint. A team's committed entries no longer lock it: they travel with it.
//   - Save of an unlink: linked false, location '', opr null, linkedAt null,
//     name = manualName = the name box
//   - a renumber is a roster re-key (remove old key, add new key); a number already
//     on the roster offers a MERGE (managers; test 21) instead of an error; empty
//     drafts are swept
//   - a plain member can unlink (rules allow it) but can never renumber
//   - Manage's "+ Add Team" refuses a duplicate number inline too

const assert = require('node:assert/strict');
const {
  signInUI, createTeamUI, joinTeamUI, createScrimmageUI, openScrimmageUI, openScrimmagesTab, teamRow
} = require('../lib/app');

const readTeams = (page, teamId, scrimmageId) => page.evaluate(async ([tid, sid]) =>
  (await db.collection('teams').doc(tid).collection('scrimmages').doc(sid).get()).data().teams || {}, [teamId, scrimmageId]);

const dup = (n) => `Team #${n} is already on this scrimmage's roster. Change the number or cancel.`;

async function openEdit(page, number) {
  await (await teamRow(page, '#team-list-info', number)).locator('.btn-scrimmage-team-edit').click();
  await page.waitForSelector('#scrimmage-team-modal:not(.hidden)');
}
const nameReadOnly = (page) => page.locator('#input-scrimmage-team-name').evaluate(el => el.readOnly);
const modalClosed = (page) => page.waitForSelector('#scrimmage-team-modal', { state: 'hidden' });

module.exports = {
  name: 'scrimmage Unlink + renumber basics: read-only linked name, staged Unlink (cancel reverts), number unlocks for a manager, re-key, duplicate offers a merge, drafts swept, member can unlink but not renumber, Manage duplicate',
  async run(ctx) {
    const captain = await ctx.makeUser('Captain Unlink');
    const member = await ctx.makeUser('Member Unlink');
    const page = await ctx.newPage('captain');
    await signInUI(page, captain);
    const joinCode = await createTeamUI(page, 'Unlink Smoke Team');
    const teamId = await page.evaluate(() => currentTeamData.id);

    await createScrimmageUI(page, { name: 'Unlink Scrim' });
    await openScrimmageUI(page, 'Unlink Scrim');
    const sid = await page.evaluate(() => selectedEvent.scrimmageId);
    const code = await page.evaluate(() => selectedEvent.code);
    const teams = () => readTeams(page, teamId, sid);

    // A roster of LINKED teams (the link flow itself is covered by test 14).
    const linkedEntry = (n, official, typed) => ({ number: n, name: official, manualName: typed, linked: true, location: 'Austin, TX, USA', opr: 140.5, linkedAt: new Date() });
    await page.evaluate(async ([tid, id, entries]) => {
      const ref = db.collection('teams').doc(tid).collection('scrimmages').doc(id);
      const update = {};
      entries.forEach(e => { update[`teams.${e.number}`] = e; });
      await ref.update(update);
    }, [teamId, sid, [
      linkedEntry(1234, 'Official Robo Cats', 'Robo Cats'),
      linkedEntry(2468, 'Gear Grinders Robotics', 'Gears'),
      linkedEntry(4040, 'Forty Forty', ''),
      linkedEntry(5555, 'Five Star Robotics', ''),
      linkedEntry(6666, 'Six Sixes', ''),
      linkedEntry(7777, 'Seven Sevens', ''),
      linkedEntry(8888, 'Eight Eights', '')
    ]]);
    await page.waitForFunction(() => Object.keys(currentScrimmage.teams).length === 7);
    await page.click('#subtab-info', { position: { x: 1, y: 1 } }).catch(() => {});

    // ---------- a linked team: read-only name, Unlink offered, number fixed ----------
    await openEdit(page, 1234);
    assert.equal(await page.inputValue('#input-scrimmage-team-name'), 'Official Robo Cats');
    assert.ok(await nameReadOnly(page), "a linked team's name is read-only");
    assert.ok(await page.isDisabled('#input-scrimmage-team-number'), 'number fixed');
    assert.ok(await page.isVisible('#btn-scrimmage-team-unlink'));
    assert.equal((await page.textContent('#btn-scrimmage-team-unlink')).trim(), 'Unlink from FTCScout');
    assert.ok(!(await page.isVisible('#btn-scrimmage-team-lookup')), 'no Link button on a linked team');

    // ---------- stage the Unlink: name unlocks (text kept), number unlocks (manager, no entries) ----------
    await page.click('#btn-scrimmage-team-unlink');
    await page.waitForFunction(() => !document.getElementById('input-scrimmage-team-number').disabled);
    assert.ok(!(await nameReadOnly(page)), 'the name box unlocks');
    assert.equal(await page.inputValue('#input-scrimmage-team-name'), 'Official Robo Cats', 'and keeps the current name as the starting text');
    assert.ok(!(await page.isDisabled('#input-scrimmage-team-number')), 'the number box unlocks too (captain, zero entries)');
    assert.ok(!(await page.isVisible('#btn-scrimmage-team-unlink')), 'Unlink is spent');
    assert.match(await page.textContent('#scrimmage-team-ftc-help'), /Will unlink from FTCScout when you Save/);
    assert.equal((await page.textContent('#scrimmage-team-number-hint')).trim(), '', 'allowed: no hint, the box simply unlocks');
    let t = (await teams())[1234];
    assert.deepEqual([t.linked, t.name, t.opr], [true, 'Official Robo Cats', 140.5], 'NOTHING written before Save');
    // Cancel reverts the staged unlink.
    await page.click('#btn-scrimmage-team-cancel');
    await modalClosed(page);
    await page.waitForTimeout(900); // a write started by the Cancel would land by now — it must not exist
    t = (await teams())[1234];
    assert.deepEqual([t.linked, t.name, t.opr], [true, 'Official Robo Cats', 140.5], 'cancel: still linked, nothing written');
    await openEdit(page, 1234);
    assert.ok(await nameReadOnly(page), 'reopened: read-only again');
    assert.ok(await page.isDisabled('#input-scrimmage-team-number'), 'reopened: number fixed again');
    assert.ok(await page.isVisible('#btn-scrimmage-team-unlink'), 'reopened: Unlink offered again');
    assert.equal(await page.inputValue('#input-scrimmage-team-name'), 'Official Robo Cats');

    // ---------- Save an unlink (same number, edited name) ----------
    await page.click('#btn-scrimmage-team-unlink');
    await page.waitForFunction(() => !document.getElementById('input-scrimmage-team-name').readOnly);
    await page.fill('#input-scrimmage-team-name', 'My Cats');
    await page.click('#btn-scrimmage-team-save');
    await modalClosed(page);
    await page.waitForFunction(() => currentScrimmage.teams['1234'].linked === false);
    t = (await teams())[1234];
    assert.deepEqual([t.linked, t.location, t.opr, t.linkedAt, t.name, t.manualName, t.number], [false, '', null, null, 'My Cats', 'My Cats', 1234], 'unlinked: linked false, location/opr/linkedAt cleared, name = manualName = the box');
    assert.equal((await page.locator('#team-list-info .team-item[data-team-number="1234"] .team-link-badge').textContent()).trim(), 'unlinked');
    // ...and it can be linked again (Edit now offers Link, name editable).
    await openEdit(page, 1234);
    assert.equal((await page.textContent('#btn-scrimmage-team-lookup')).trim(), 'Link to FTCScout');
    assert.ok(!(await nameReadOnly(page)));
    await page.waitForFunction(() => !document.getElementById('input-scrimmage-team-number').disabled);
    assert.ok(true, 'an already-unlinked team (captain, no entries) has an editable number from the moment the modal opens');
    await page.click('#btn-scrimmage-team-cancel');
    await modalClosed(page);

    // ---------- renumber: the roster is RE-KEYED ----------
    await openEdit(page, 2468);
    await page.click('#btn-scrimmage-team-unlink');
    await page.waitForFunction(() => !document.getElementById('input-scrimmage-team-number').disabled);
    await page.fill('#input-scrimmage-team-number', '2469');
    await page.click('#btn-scrimmage-team-save');
    await modalClosed(page);
    await page.waitForFunction(() => currentScrimmage.teams['2469'] && !currentScrimmage.teams['2468']);
    const after = await teams();
    assert.equal(after[2468], undefined, 'the old key is gone');
    assert.deepEqual([after[2469].number, after[2469].name, after[2469].manualName, after[2469].linked, after[2469].opr, after[2469].location], [2469, 'Gear Grinders Robotics', 'Gear Grinders Robotics', false, null, ''], 'the new key holds the unlinked entry (name kept as the starting text)');
    await page.locator('#team-list-info .team-item[data-team-number="2469"]').waitFor();
    assert.equal(await page.locator('#team-list-info .team-item[data-team-number="2468"]').count(), 0);

    // ---------- a number already on the roster: a manager is OFFERED a merge (no inline error) ----------
    await openEdit(page, 4040);
    await page.click('#btn-scrimmage-team-unlink');
    await page.waitForFunction(() => !document.getElementById('input-scrimmage-team-number').disabled);
    await page.fill('#input-scrimmage-team-number', '5555');
    await page.click('#btn-scrimmage-team-save');
    await page.waitForSelector('#scrimmage-team-merge-choice:not(.hidden)');
    assert.equal((await page.textContent('#scrimmage-team-merge-text')).trim(), 'Team #5555 (Five Star Robotics) is already on this scrimmage.');
    assert.equal((await page.textContent('#btn-scrimmage-team-merge')).trim(), 'Merge #4040 into #5555');
    assert.equal((await page.textContent('#btn-scrimmage-team-merge-change')).trim(), 'Change the number');
    assert.equal((await page.textContent('#scrimmage-team-error')).trim(), '', 'no inline error — the choice replaces it');
    assert.ok(await page.isDisabled('#btn-scrimmage-team-save'), 'Save is off while the choice shows');
    assert.ok(await page.isVisible('#scrimmage-team-modal'), 'stays open');
    assert.ok((await teams())[4040], 'nothing re-keyed');
    assert.equal((await teams())[4040].linked, true, 'and nothing unlinked');
    await page.click('#btn-scrimmage-team-merge-change');
    await page.waitForSelector('#scrimmage-team-merge-choice', { state: 'hidden' });
    assert.ok(!(await page.isDisabled('#btn-scrimmage-team-save')), 'Change the number: Save is back');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'input-scrimmage-team-number', 'and the number box is focused');
    await page.click('#btn-scrimmage-team-cancel');
    await modalClosed(page);

    // ---------- a team WITH a committed entry: unlink works; the number is unlocked and says its entry travels ----------
    await page.evaluate(async ([tid, id, c]) => {
      await db.collection('teams').doc(tid).collection('pitScouting').doc(`${tid}_${c}_5555`).set({
        eventCode: c, scrimmageId: id, teamNumber: 5555, teamId: tid, season: selectedEvent.season,
        scoutedBy: currentUser.uid, scoutedByName: 'Seed', checkpoint: { notes: 'real data' }, activeEditors: {}
      });
    }, [teamId, sid, code]);
    await openEdit(page, 5555);
    await page.click('#btn-scrimmage-team-unlink');
    await page.waitForFunction(() => /scouting entry moves with it/.test(document.getElementById('scrimmage-team-number-hint').textContent));
    assert.equal((await page.textContent('#scrimmage-team-number-hint')).trim(), "This team's 1 scouting entry moves with it if you change the number.");
    assert.ok(!(await page.isDisabled('#input-scrimmage-team-number')), 'a team with scouting data can be renumbered by a manager (phase 3)');
    assert.ok(!(await nameReadOnly(page)), 'and the name unlocked');
    await page.fill('#input-scrimmage-team-name', 'Five Stars');
    await page.click('#btn-scrimmage-team-save');
    await modalClosed(page);
    await page.waitForFunction(() => currentScrimmage.teams['5555'].linked === false);
    t = (await teams())[5555];
    assert.deepEqual([t.name, t.manualName, t.linked, t.number], ['Five Stars', 'Five Stars', false, 5555], 'unlinked in place');
    assert.equal(await page.evaluate(async ([tid, c]) => (await db.collection('teams').doc(tid).collection('pitScouting').where('eventCode', '==', c).where('teamNumber', '==', 5555).get()).size, [teamId, code]), 1, 'its entry is untouched');

    // ---------- an EMPTY DRAFT (the shell a cancelled form leaves) does not block, and is swept ----------
    await page.evaluate(async ([tid, id, c]) => {
      await db.collection('teams').doc(tid).collection('pitScouting').doc(`${tid}_${c}_6666`).set({
        eventCode: c, scrimmageId: id, teamNumber: 6666, teamId: tid, season: selectedEvent.season, activeEditors: {}
      });
    }, [teamId, sid, code]);
    await openEdit(page, 6666);
    await page.click('#btn-scrimmage-team-unlink');
    await page.waitForFunction(() => !document.getElementById('input-scrimmage-team-number').disabled);
    await page.fill('#input-scrimmage-team-number', '6667');
    await page.click('#btn-scrimmage-team-save');
    await modalClosed(page);
    await page.waitForFunction(() => currentScrimmage.teams['6667'] && !currentScrimmage.teams['6666']);
    assert.equal(await page.evaluate(async ([tid, c]) => (await db.collection('teams').doc(tid).collection('pitScouting').where('eventCode', '==', c).where('teamNumber', '==', 6666).get()).size, [teamId, code]), 0, 'the empty draft for the old number was deleted');

    // ...but a draft somebody is editing RIGHT NOW (fresh presence) blocks it.
    await page.evaluate(async ([tid, id, c]) => {
      await db.collection('teams').doc(tid).collection('pitScouting').doc(`${tid}_${c}_7777`).set({
        eventCode: c, scrimmageId: id, teamNumber: 7777, teamId: tid, season: selectedEvent.season,
        activeEditors: { someoneElse: { name: 'Someone', heartbeatAt: firebase.firestore.FieldValue.serverTimestamp() } }
      });
    }, [teamId, sid, code]);
    await openEdit(page, 7777);
    await page.click('#btn-scrimmage-team-unlink');
    await page.waitForFunction(() => /is editing a scouting entry for this team/.test(document.getElementById('scrimmage-team-number-hint').textContent));
    assert.equal((await page.textContent('#scrimmage-team-number-hint')).trim(), 'Someone is editing a scouting entry for this team. Wait until they are finished before changing its number.');
    assert.ok(await page.isDisabled('#input-scrimmage-team-number'), 'a draft with a live editor blocks the renumber');
    await page.click('#btn-scrimmage-team-cancel');
    await modalClosed(page);

    // ---------- Manage's "+ Add Team": a duplicate number is an inline error there too ----------
    await openScrimmagesTab(page);
    await page.locator('#scrimmage-list .scrimmage-item', { hasText: 'Unlink Scrim' }).locator('.btn-scrimmage-manage').click();
    await page.waitForSelector('#scrimmage-form-modal:not(.hidden)');
    await page.click('#btn-scrimmage-manage-add-team');
    await page.waitForSelector('#scrimmage-team-modal:not(.hidden)');
    await page.fill('#input-scrimmage-team-number', '8888');
    await page.click('#btn-scrimmage-team-save');
    assert.equal((await page.textContent('#scrimmage-team-error')).trim(), dup(8888));
    assert.ok(await page.isVisible('#scrimmage-team-modal'), 'Manage add: modal stays open');
    await page.fill('#input-scrimmage-team-number', '8889');
    await page.click('#btn-scrimmage-team-save');
    await modalClosed(page);
    assert.match(await page.textContent('#scrimmage-manage-team-success'), /Added Team #8889/);
    await page.click('#btn-scrimmage-form-cancel');
    await page.waitForSelector('#scrimmage-form-modal', { state: 'hidden' });

    // ---------- a plain MEMBER: can unlink, can never renumber ----------
    const memPage = await ctx.newPage('member');
    await signInUI(memPage, member);
    await joinTeamUI(memPage, joinCode);
    await openScrimmageUI(memPage, 'Unlink Scrim');
    await memPage.waitForFunction(() => currentScrimmage.teams['8888']);
    await openEdit(memPage, 8888);
    assert.ok(await nameReadOnly(memPage));
    await memPage.click('#btn-scrimmage-team-unlink');
    await memPage.waitForFunction(() => /needs a captain or scrimmage permission/.test(document.getElementById('scrimmage-team-number-hint').textContent));
    assert.equal((await memPage.textContent('#scrimmage-team-number-hint')).trim(), "Changing a team's number needs a captain or scrimmage permission.");
    assert.ok(await memPage.isDisabled('#input-scrimmage-team-number'), 'a member cannot renumber');
    assert.ok(!(await nameReadOnly(memPage)), 'but the name unlocks');
    await memPage.fill('#input-scrimmage-team-name', 'Eights');
    await memPage.click('#btn-scrimmage-team-save');
    await modalClosed(memPage);
    await memPage.waitForFunction(() => currentScrimmage.teams['8888'].linked === false);
    t = (await teams())[8888];
    assert.deepEqual([t.name, t.manualName, t.linked, t.location, t.opr, t.linkedAt], ['Eights', 'Eights', false, '', null, null], 'the member unlinked it (rules allow a roster edit)');
  }
};
