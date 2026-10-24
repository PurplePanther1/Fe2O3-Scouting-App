// Unofficial scrimmages — the roster Edit modal as a small state machine (all STAGED,
// nothing written until Save, Cancel discards, reopening starts from the saved state):
//   A UNLINKED      name editable; number editable when renumbering is allowed (a
//                   captain / canManageScrimmages AND nobody editing it; a team WITH
//                   scouting data is fine since phase 3, its entries travel), checked as
//                   soon as the modal opens; button "Link to FTCScout"
//   B PENDING LINK  the official name in the read-only name box, number locked to the
//                   picked team's; button "Unlink" discards the staged link and restores
//                   the name; the number keeps what the user typed
//   C LINKED        name AND number read-only + the lock note; "Unlink from FTCScout"
//   (the lock note is its own always-visible line in B AND C, hidden in A and D; every
//   number hint sits DIRECTLY under the number box)
//   D PENDING UNLINK name (text kept) and number (when allowed) unlock; the button is
//                   "Link to FTCScout" again
// plus: the lookup popup's number is editable in Edit when renumbering is allowed and
// mirrored back; link + renumber is ONE transaction; the hints (permission / data /
// "<names> is editing ..."); a roster number at Save offers a merge (test 21).

const assert = require('node:assert/strict');
const { ftcScoutOpr } = require('../lib/harness');
const {
  signInUI, createTeamUI, joinTeamUI, createScrimmageUI, openScrimmageUI, openScoutingSubtab, teamRow
} = require('../lib/app');

const dup = (n) => `Team #${n} is already on this scrimmage's roster. Change the number or cancel.`;
const LOCK_LINE = "Linked to FTCScout. The name and number come from FTCScout and can't be edited while linked. Unlink to change them.";
const LOCK_LINE_B = "The name and number come from FTCScout and can't be edited while linked. Press Unlink to change them.";

async function openEdit(page, number) {
  await (await teamRow(page, '#team-list-info', number)).locator('.btn-scrimmage-team-edit').click();
  await page.waitForSelector('#scrimmage-team-modal:not(.hidden)');
}
const modalClosed = (page) => page.waitForSelector('#scrimmage-team-modal', { state: 'hidden' });
const numberEnabled = (page) => page.waitForFunction(() => !document.getElementById('input-scrimmage-team-number').disabled);
const hintText = async (page) => (await page.textContent('#scrimmage-team-number-hint')).trim();
const hintVisible = (page) => page.isVisible('#scrimmage-team-number-hint');

// What the modal shows right now, in one object.
const ui = (page) => page.evaluate(() => {
  const vis = (id) => { const el = document.getElementById(id); return !!el && el.offsetParent !== null; };
  return {
    name: document.getElementById('input-scrimmage-team-name').value,
    nameReadOnly: document.getElementById('input-scrimmage-team-name').readOnly,
    number: document.getElementById('input-scrimmage-team-number').value,
    numberDisabled: document.getElementById('input-scrimmage-team-number').disabled,
    linkBtn: vis('btn-scrimmage-team-lookup') ? document.getElementById('btn-scrimmage-team-lookup').textContent.trim() : null,
    unlinkBtn: vis('btn-scrimmage-team-unlink') ? document.getElementById('btn-scrimmage-team-unlink').textContent.trim() : null,
    help: vis('scrimmage-team-ftc-help') ? document.getElementById('scrimmage-team-ftc-help').textContent.trim() : '',
    lock: vis('scrimmage-team-lock-note') ? document.getElementById('scrimmage-team-lock-note').textContent.trim() : null,
    hint: vis('scrimmage-team-number-hint') ? document.getElementById('scrimmage-team-number-hint').textContent.trim() : null
  };
});

// No read-only / disabled input in the Add/Edit modal may be the active element, match :focus, or
// wear the focus highlight (the primary-colour border). Also returns the active element's id.
async function assertNoStaleFocus(page, label, { clicked = false } = {}) {
  await page.waitForTimeout(450);   // inputs have a 0.2s border-color transition: measure the settled colour
  const r = await page.evaluate(() => {
    const modal = document.getElementById('scrimmage-team-modal');
    const probe = document.createElement('div');
    probe.style.cssText = 'border:1px solid var(--primary)';
    document.body.appendChild(probe);
    const primary = getComputedStyle(probe).borderTopColor;
    probe.remove();
    const locked = [...modal.querySelectorAll('input')].filter(el => el.readOnly || el.disabled).map(el => ({
      id: el.id, active: document.activeElement === el, focusMatch: el.matches(':focus'), border: getComputedStyle(el).borderTopColor
    }));
    return { locked, primary, activeId: document.activeElement ? document.activeElement.id : '' };
  });
  for (const x of r.locked) {
    // (a box the user CLICKS is focused by the browser; it just must not look focused)
    if (!clicked) assert.ok(!x.active && !x.focusMatch, label + ': the read-only/disabled #' + x.id + ' must not be focused');
    assert.notEqual(x.border, r.primary, label + ': #' + x.id + ' must not wear the focus highlight');
  }
  return r.activeId;
}

async function pickInPopup(page, number) {
  await page.waitForSelector('#ftc-lookup-modal:not(.hidden)');
  await page.fill('#input-ftc-lookup-number', String(number));
  await page.click('#btn-ftc-lookup-go');
  await page.waitForSelector('#ftc-lookup-result:not(.hidden)');
  await page.click('#btn-ftc-lookup-confirm');
  await page.waitForSelector('#ftc-lookup-modal', { state: 'hidden' });
}

module.exports = {
  name: 'scrimmage Edit modal states A/B/C/D (Link <-> Unlink swap, staged, Cancel reverts), unlinked number editable on open, popup number mirrored, link + renumber in ONE save, hints incl. "<names> is editing"',
  async run(ctx) {
    const captain = await ctx.makeUser('Captain States');
    const member = await ctx.makeUser('Member States');
    const page = await ctx.newPage('captain');
    await signInUI(page, captain);
    const joinCode = await createTeamUI(page, 'Edit States Team');
    const teamId = await page.evaluate(() => currentTeamData.id);
    const currentSeason = await page.evaluate(() => String(getCurrentFtcSeason()));

    await createScrimmageUI(page, { name: 'State Scrim' });
    await openScrimmageUI(page, 'State Scrim');
    const sid = await page.evaluate(() => selectedEvent.scrimmageId);
    const code = await page.evaluate(() => selectedEvent.code);
    const teams = () => page.evaluate(async ([tid, id]) => (await db.collection('teams').doc(tid).collection('scrimmages').doc(id).get()).data().teams || {}, [teamId, sid]);
    const shells = (n) => page.evaluate(async ([tid, c, num]) => (await db.collection('teams').doc(tid).collection('pitScouting').where('eventCode', '==', c).where('teamNumber', '==', num).get()).size, [teamId, code, n]);
    const unlinked = (n, name) => ({ number: n, name, manualName: name, linked: false, location: '', opr: null, linkedAt: null });
    const linkedEntry = (n, official) => ({ number: n, name: official, manualName: 'typed before', linked: true, location: 'Austin, TX, USA', opr: 140.5, linkedAt: new Date() });
    const seedShell = (n, editors) => page.evaluate(async ([tid, id, c, num, eds]) => {
      const ed = {};
      Object.entries(eds || {}).forEach(([uid, e]) => { ed[uid] = { name: e.name, heartbeatAt: e.ageMs != null ? new Date(Date.now() - e.ageMs) : new Date() }; });
      await db.collection('teams').doc(tid).collection('pitScouting').doc(`${tid}_${c}_${num}`).set({
        eventCode: c, scrimmageId: id, teamNumber: num, teamId: tid, season: selectedEvent.season, activeEditors: ed
      });
    }, [teamId, sid, code, n, editors || {}]);

    await page.evaluate(async ([tid, id, entries]) => {
      const update = {};
      entries.forEach(e => { update[`teams.${e.number}`] = e; });
      await db.collection('teams').doc(tid).collection('scrimmages').doc(id).update(update);
    }, [teamId, sid, [
      unlinked(9001, 'Typed Nine'), unlinked(9002, 'Typed Ninety'), unlinked(9003, 'Three'), unlinked(5555, 'Existing Five'),
      linkedEntry(6001, 'Official Six'),
      unlinked(3650, 'Own Number'), unlinked(7001, 'Has Data'), unlinked(7002, 'One Editor'), unlinked(7003, 'Two Editors'), unlinked(7004, 'Late Editor'), unlinked(7005, 'Own And Stale')
    ]]);
    await page.waitForFunction(() => Object.keys(currentScrimmage.teams).length === 11);

    // ======== the Add modal: the (editable) number box takes focus, nothing locked is focused ========
    await openScoutingSubtab(page, 'info');
    await page.click('#btn-scrimmage-add-team');
    await page.waitForSelector('#scrimmage-team-modal:not(.hidden)');
    assert.equal(await assertNoStaleFocus(page, 'Add modal'), 'input-scrimmage-team-number', 'Add: the number box is focused');
    await page.click('#btn-scrimmage-team-cancel');
    await modalClosed(page);

    // ======== A: UNLINKED, captain, no entries — the number is editable from the moment it opens ========
    // (the check is slowed here so the "Checking..." text can be seen)
    await page.evaluate(() => {
      const real = window.checkScrimmageRenumber;
      window.__realCheck = real;
      window.checkScrimmageRenumber = async (...a) => { await new Promise(r => setTimeout(r, 700)); return real(...a); };
    });
    await openEdit(page, 9001);
    let s = await ui(page);
    assert.equal(s.hint, 'Checking whether the number can change...', 'while the check runs');
    assert.equal(s.numberDisabled, true, 'locked while checking');
    await numberEnabled(page);
    s = await ui(page);
    assert.deepEqual([s.numberDisabled, s.hint, s.nameReadOnly], [false, null, false], 'allowed: number unlocked, no hint, name editable');
    assert.deepEqual([s.linkBtn, s.unlinkBtn], ['Link to FTCScout', null], 'A: Link to FTCScout only');
    assert.equal(s.name, 'Typed Nine');
    assert.equal(s.lock, null, 'A: the lock note is hidden (the boxes are editable)');
    assert.equal(await assertNoStaleFocus(page, 'state A'), 'input-scrimmage-team-name', 'A: an unlinked team opens with the NAME box focused');
    await page.evaluate(() => { window.checkScrimmageRenumber = window.__realCheck; });

    // ---- lookup popup from A: number EDITABLE, prefilled, mirrored back; its own number is not a duplicate ----
    await page.fill('#input-scrimmage-team-number', '9010');                    // typed in the modal first
    await page.click('#btn-scrimmage-team-lookup');
    await page.waitForSelector('#ftc-lookup-modal:not(.hidden)');
    assert.ok(!(await page.isDisabled('#input-ftc-lookup-number')), 'popup number editable when renumbering is allowed');
    assert.equal(await page.inputValue('#input-ftc-lookup-number'), '9010', "prefilled with the modal's number");
    await page.fill('#input-ftc-lookup-number', '5555');                        // a number already on the roster
    assert.equal(await page.inputValue('#input-scrimmage-team-number'), '5555', 'mirrored into the Edit modal');
    await page.click('#btn-ftc-lookup-go');
    await page.waitForSelector('#ftc-lookup-results .ftc-result-row.is-roster');
    assert.match(await page.textContent('#ftc-lookup-results .ftc-result-row.is-roster'), /already on this scrimmage/, "another roster team's number: its row is greyed");
    assert.ok(await page.locator('#ftc-lookup-results .ftc-result-row.is-roster').isDisabled(), 'and cannot be selected');
    assert.ok(!(await page.isVisible('#ftc-lookup-result')) && !(await page.isVisible('#btn-ftc-lookup-confirm')), 'so nothing can be confirmed for it');
    await page.fill('#input-ftc-lookup-number', '9001');                        // a number FTCScout does not have
    await page.click('#btn-ftc-lookup-go');
    await page.waitForFunction(() => /No FTCScout team matches 9001/.test(document.getElementById('ftc-lookup-status').textContent));
    assert.equal((await page.textContent('#ftc-lookup-error')).trim(), '', 'no match is not an error');
    await page.click('#btn-ftc-lookup-cancel');
    await page.waitForSelector('#ftc-lookup-modal', { state: 'hidden' });
    assert.equal(await page.inputValue('#input-scrimmage-team-number'), '9001', 'cancelled popup: the modal keeps the number it was left with');

    // ---- the team's OWN number (it IS an FTCScout team) is not a duplicate: its card shows and can be used ----
    await page.click('#btn-scrimmage-team-cancel');
    await modalClosed(page);
    await openEdit(page, 3650);
    await numberEnabled(page);
    await page.click('#btn-scrimmage-team-lookup');
    await page.waitForSelector('#ftc-lookup-modal:not(.hidden)');
    await page.waitForSelector('#ftc-lookup-result:not(.hidden)');
    assert.equal((await page.textContent('#ftc-lookup-result-name')).trim(), 'Thirty Six Fifty', 'own number: found, not greyed');
    assert.equal(await page.locator('#ftc-lookup-results .is-roster').count(), 0, "no roster greying for the Edit team's own number");
    assert.ok(await page.isVisible('#btn-ftc-lookup-confirm'));
    await page.click('#btn-ftc-lookup-cancel');
    await page.waitForSelector('#ftc-lookup-modal', { state: 'hidden' });
    await page.click('#btn-scrimmage-team-cancel');
    await modalClosed(page);
    await openEdit(page, 9001);
    await numberEnabled(page);

    // ======== A -> B: pick 2468 (a different number) in the popup ========
    await seedShell(9001);                                                      // an empty shell for the OLD number
    await page.click('#btn-scrimmage-team-lookup');
    await pickInPopup(page, 2468);
    s = await ui(page);
    assert.equal(s.name, 'Gear Grinders Robotics', 'B: the official name is in the box');
    assert.equal(s.nameReadOnly, true, 'B: read-only');
    assert.deepEqual([s.number, s.numberDisabled], ['2468', true], "B: the number is the picked team's and locked");
    assert.deepEqual([s.linkBtn, s.unlinkBtn], [null, 'Unlink'], 'B: the button is "Unlink" (NOT "Link to FTCScout")');
    assert.match(s.help, /^Will link to FTCScout: Gear Grinders Robotics \(Portland, OR, USA\)\. Save to apply\.$/);
    assert.equal(s.hint, null, 'B: no number hint');
    assert.equal(s.lock, LOCK_LINE_B, 'B: the lock note shows as its own line, with "Press Unlink"');
    await assertNoStaleFocus(page, 'state B');
    assert.equal((await teams())[9001].linked, false, 'nothing written yet');

    // ---- B -> A: Unlink discards the staged link; name restored, number keeps what was typed ----
    await page.click('#btn-scrimmage-team-unlink');
    s = await ui(page);
    assert.equal(s.name, 'Typed Nine', 'A again: the name is back to what it was before linking');
    assert.equal(s.nameReadOnly, false);
    assert.deepEqual([s.number, s.numberDisabled], ['2468', false], 'the number keeps the typed 2468 and is editable again');
    assert.deepEqual([s.linkBtn, s.unlinkBtn], ['Link to FTCScout', null], 'back to "Link to FTCScout"');
    assert.doesNotMatch(s.help, /Will link/);
    assert.equal(s.lock, null, 'A again: the lock note is gone');

    // ---- link again, and SAVE: re-key AND link fields in ONE transaction ----
    await page.fill('#input-scrimmage-team-name', 'Typed Nine Edited');         // what was typed before linking becomes manualName
    await page.click('#btn-scrimmage-team-lookup');
    assert.equal(await page.inputValue('#input-ftc-lookup-number'), '2468', 'popup starts from the modal\'s number');
    await pickInPopup(page, 2468);
    await page.evaluate(([tid, id]) => {
      window.__snaps = [];
      window.__unsub = db.collection('teams').doc(tid).collection('scrimmages').doc(id).onSnapshot(snap => {
        const t = snap.data().teams || {};
        window.__snaps.push({ has9001: !!t['9001'], has2468: !!t['2468'], linked2468: !!(t['2468'] && t['2468'].linked) });
      });
    }, [teamId, sid]);
    await page.waitForFunction(() => window.__snaps.length >= 1);
    await page.click('#btn-scrimmage-team-save');
    await modalClosed(page);
    await page.waitForFunction(() => currentScrimmage.teams['2468'] && !currentScrimmage.teams['9001']);
    const t2468 = (await teams())[2468];
    assert.deepEqual([t2468.number, t2468.name, t2468.manualName, t2468.linked, t2468.location, t2468.opr],
      [2468, 'Gear Grinders Robotics', 'Typed Nine Edited', true, 'Portland, OR, USA', ftcScoutOpr(2468, currentSeason)], 'linked at the new number');
    assert.equal(typeof t2468.opr, 'number');
    assert.ok(t2468.linkedAt, 'linkedAt set');
    assert.equal((await teams())[9001], undefined, 'the old key is gone');
    const snaps = await page.evaluate(() => { window.__unsub(); return window.__snaps; });
    assert.ok(snaps.every(x => !(x.has2468 && !x.linked2468) && !(x.has2468 && x.has9001)),
      `never an intermediate state (re-keyed but unlinked, or both keys): ${JSON.stringify(snaps)}`);
    assert.equal(await shells(9001), 0, 'the empty shell for the old number was swept');

    // ---- a roster number at SAVE (typed straight into the box): a manager is offered the merge ----
    await openEdit(page, 9002);
    await numberEnabled(page);
    await page.fill('#input-scrimmage-team-number', '5555');
    await page.click('#btn-scrimmage-team-save');
    await page.waitForSelector('#scrimmage-team-merge-choice:not(.hidden)');
    assert.equal((await page.textContent('#scrimmage-team-merge-text')).trim(), 'Team #5555 (Existing Five) is already on this scrimmage.');
    assert.equal((await page.textContent('#scrimmage-team-error')).trim(), '', 'the choice replaces the inline error');
    assert.ok(await page.isVisible('#scrimmage-team-modal'));
    assert.ok((await teams())[9002], 'nothing re-keyed');
    // typing in the number box dismisses the choice (it no longer applies)
    await page.fill('#input-scrimmage-team-number', '9021');
    await page.waitForSelector('#scrimmage-team-merge-choice', { state: 'hidden' });
    assert.ok(!(await page.isDisabled('#btn-scrimmage-team-save')));
    await page.fill('#input-scrimmage-team-number', '5555');
    await page.click('#btn-scrimmage-team-save');
    await page.waitForSelector('#scrimmage-team-merge-choice:not(.hidden)');
    await page.click('#btn-scrimmage-team-merge-change');
    await page.waitForSelector('#scrimmage-team-merge-choice', { state: 'hidden' });
    // ---- a plain renumber of an UNLINKED team (no link involved) works from the box ----
    await page.fill('#input-scrimmage-team-number', '9020');
    await page.fill('#input-scrimmage-team-name', 'Ninety Renamed');
    await page.click('#btn-scrimmage-team-save');
    await modalClosed(page);
    await page.waitForFunction(() => currentScrimmage.teams['9020'] && !currentScrimmage.teams['9002']);
    const t9020 = (await teams())[9020];
    assert.deepEqual([t9020.number, t9020.name, t9020.manualName, t9020.linked], [9020, 'Ninety Renamed', 'Ninety Renamed', false]);

    // ---- Cancel after staging a link: everything reverts (name, number, link) ----
    await openEdit(page, 9003);
    await numberEnabled(page);
    await page.fill('#input-scrimmage-team-number', '9030');
    await page.click('#btn-scrimmage-team-lookup');
    await pickInPopup(page, 3579);
    assert.equal((await ui(page)).name, 'Circuit Breakers');
    await page.click('#btn-scrimmage-team-cancel');
    await modalClosed(page);
    assert.deepEqual([(await teams())[9003].name, (await teams())[9003].linked, !!(await teams())[9030]], ['Three', false, false], 'Cancel: nothing written');
    await openEdit(page, 9003);
    s = await ui(page);
    assert.deepEqual([s.name, s.number, s.linkBtn, s.unlinkBtn, s.nameReadOnly], ['Three', '9003', 'Link to FTCScout', null, false], 'reopened from the saved state');
    await page.click('#btn-scrimmage-team-cancel');
    await modalClosed(page);

    // ======== C: LINKED — both boxes read-only, the lock line, "Unlink from FTCScout" ========
    await openEdit(page, 6001);
    s = await ui(page);
    assert.deepEqual([s.nameReadOnly, s.numberDisabled, s.name, s.number], [true, true, 'Official Six', '6001']);
    assert.equal(s.lock, LOCK_LINE, 'C: the lock note, word for word, as its own line');
    assert.equal(s.help, '', 'C: nothing hides behind the help text');
    assert.notEqual(await assertNoStaleFocus(page, 'state C (just opened)'), 'input-scrimmage-team-name', 'C: the read-only name box is NOT focused on open');
    // even if the user CLICKS a read-only box (browsers focus it), it must not wear the focus highlight
    await page.click('#input-scrimmage-team-name');
    await assertNoStaleFocus(page, 'state C (read-only name clicked)', { clicked: true });
    await page.click('#input-scrimmage-team-number', { force: true }).catch(() => {});
    await assertNoStaleFocus(page, 'state C (disabled number clicked)', { clicked: true });
    assert.deepEqual([s.linkBtn, s.unlinkBtn], [null, 'Unlink from FTCScout'], 'C: Unlink from FTCScout only');
    assert.equal(s.hint, null, 'no number hint while linked (the lock line explains it)');
    await page.waitForTimeout(500);
    assert.equal((await ui(page)).numberDisabled, true, 'and the renumber check finishing does not unlock a linked team');

    // ---- C -> D: Unlink stages; name text kept; number unlocks; the button becomes Link ----
    await page.click('#btn-scrimmage-team-unlink');
    s = await ui(page);
    assert.deepEqual([s.nameReadOnly, s.name, s.numberDisabled], [false, 'Official Six', false], 'D: name unlocked (text kept), number unlocked');
    assert.deepEqual([s.linkBtn, s.unlinkBtn], ['Link to FTCScout', null], 'D: the button is "Link to FTCScout" again');
    assert.equal(s.help, 'Will unlink from FTCScout when you Save.');
    assert.equal(s.lock, null, 'D: the lock note is hidden (the boxes are editable)');
    assert.equal(await assertNoStaleFocus(page, 'state D'), 'input-scrimmage-team-name', 'D: Unlink hands focus to the now-editable name box');
    assert.equal((await teams())[6001].linked, true, 'still linked in the roster');

    // ---- D: change the number to 3579, then LINK the new number without closing ----
    await page.fill('#input-scrimmage-team-number', '3579');
    await page.click('#btn-scrimmage-team-lookup');
    assert.equal(await page.inputValue('#input-ftc-lookup-number'), '3579', "the popup opens with the box's current number");
    await page.click('#btn-ftc-lookup-go');
    await page.waitForSelector('#ftc-lookup-result:not(.hidden)');
    await page.click('#btn-ftc-lookup-confirm');
    await page.waitForSelector('#ftc-lookup-modal', { state: 'hidden' });
    s = await ui(page);
    assert.deepEqual([s.name, s.nameReadOnly, s.number, s.numberDisabled, s.linkBtn, s.unlinkBtn], ['Circuit Breakers', true, '3579', true, null, 'Unlink'], 'B (on top of D)');
    // ---- Unlink here discards ONLY the staged link: back to D with the old text ----
    await page.click('#btn-scrimmage-team-unlink');
    s = await ui(page);
    assert.deepEqual([s.name, s.nameReadOnly, s.number, s.numberDisabled, s.linkBtn, s.unlinkBtn], ['Official Six', false, '3579', false, 'Link to FTCScout', null], 'back in D: name restored, number kept, Link offered');
    assert.equal(s.help, 'Will unlink from FTCScout when you Save.');
    // ---- Cancel reverts the lot; reopening starts from C ----
    await page.click('#btn-scrimmage-team-cancel');
    await modalClosed(page);
    await page.waitForTimeout(500);
    const t6001 = (await teams())[6001];
    assert.deepEqual([t6001.linked, t6001.name, t6001.opr], [true, 'Official Six', 140.5], 'nothing written');
    await openEdit(page, 6001);
    s = await ui(page);
    assert.deepEqual([s.nameReadOnly, s.numberDisabled, s.unlinkBtn, s.lock], [true, true, 'Unlink from FTCScout', LOCK_LINE], 'reopened in C');
    // ---- D + Save: unlink AND renumber together ----
    await page.click('#btn-scrimmage-team-unlink');
    await page.fill('#input-scrimmage-team-number', '6002');
    await page.fill('#input-scrimmage-team-name', 'Six Again');
    await page.click('#btn-scrimmage-team-save');
    await modalClosed(page);
    await page.waitForFunction(() => currentScrimmage.teams['6002'] && !currentScrimmage.teams['6001']);
    const t6002 = (await teams())[6002];
    assert.deepEqual([t6002.number, t6002.name, t6002.manualName, t6002.linked, t6002.location, t6002.opr, t6002.linkedAt], [6002, 'Six Again', 'Six Again', false, '', null, null]);

    // ======== a team with data is renumberable (test 21 covers the move); editors still block ========
    await page.evaluate(async ([tid, id, c]) => {
      await db.collection('teams').doc(tid).collection('pitScouting').doc(`${tid}_${c}_7001`).set({
        eventCode: c, scrimmageId: id, teamNumber: 7001, teamId: tid, season: selectedEvent.season,
        scoutedBy: currentUser.uid, scoutedByName: 'Seed', checkpoint: { notes: 'real' }, activeEditors: {}
      });
    }, [teamId, sid, code]);
    await openEdit(page, 7001);
    await numberEnabled(page);
    s = await ui(page);
    assert.deepEqual([s.hint, s.numberDisabled, s.nameReadOnly], ["This team's 1 scouting entry moves with it if you change the number.", false, false], 'team with data (phase 3): the number is editable and the hint says its entry travels');
    // ---- the hint sits DIRECTLY under the number box (above the name box) ----
    const pos = await page.evaluate(() => {
      const r = (id) => document.getElementById(id).getBoundingClientRect();
      const number = r('input-scrimmage-team-number'), hint = r('scrimmage-team-number-hint'), name = r('input-scrimmage-team-name');
      return { gap: hint.top - number.bottom, hintAboveName: hint.bottom <= name.top, sibling: document.getElementById('input-scrimmage-team-number').nextElementSibling.id };
    });
    assert.equal(pos.sibling, 'scrimmage-team-number-hint', 'the hint is the next element after the number box');
    assert.ok(pos.gap >= 0 && pos.gap < 24, 'hint hugs the number box (gap ' + pos.gap + 'px)');
    assert.ok(pos.hintAboveName, 'and sits above the name box');
    await page.click('#btn-scrimmage-team-cancel');
    await modalClosed(page);

    // ---- one editor ----
    await seedShell(7002, { jordan: { name: 'Jordan' } });
    await openEdit(page, 7002);
    await page.waitForFunction(() => /editing/.test(document.getElementById('scrimmage-team-number-hint').textContent));
    s = await ui(page);
    assert.equal(s.hint, 'Jordan is editing a scouting entry for this team. Wait until they are finished before changing its number.');
    assert.equal(s.numberDisabled, true);
    await page.click('#btn-scrimmage-team-cancel');
    await modalClosed(page);
    // ---- two editors (one on the pit form, one on the match form) ----
    await seedShell(7003, { jordan: { name: 'Jordan' } });
    await page.evaluate(async ([tid, id, c]) => {
      await db.collection('teams').doc(tid).collection('matchScouting').doc(`m_${c}_7003`).set({
        eventCode: c, scrimmageId: id, teamNumber: 7003, teamId: tid, season: selectedEvent.season, matchNumber: 1,
        activeEditors: { sam: { name: 'Sam', heartbeatAt: new Date() }, jordan2: { name: 'Jordan', heartbeatAt: new Date() } }
      });
    }, [teamId, sid, code]);
    await openEdit(page, 7003);
    await page.waitForFunction(() => /editing/.test(document.getElementById('scrimmage-team-number-hint').textContent));
    assert.equal(await hintText(page), 'Jordan and Sam are editing a scouting entry for this team. Wait until they are finished before changing its number.', 'two names, each once');
    await page.click('#btn-scrimmage-team-cancel');
    await modalClosed(page);
    // ---- your OWN session and a STALE one do not count ----
    const me = await page.evaluate(() => currentUser.uid);
    await seedShell(7005, { [me]: { name: 'Captain States' }, ghost: { name: 'Ghost', ageMs: 10 * 60 * 1000 } });
    await openEdit(page, 7005);
    await numberEnabled(page);
    assert.equal((await ui(page)).hint, null, 'own session + a stale presence: not blocking');
    await page.click('#btn-scrimmage-team-cancel');
    await modalClosed(page);
    // ---- an editor who appears BETWEEN opening and Save: inline error naming them, nothing written ----
    await openEdit(page, 7004);
    await numberEnabled(page);
    await seedShell(7004, { pat: { name: 'Pat' } });
    await page.fill('#input-scrimmage-team-number', '7040');
    await page.click('#btn-scrimmage-team-save');
    await page.waitForFunction(() => /Pat is editing/.test(document.getElementById('scrimmage-team-error').textContent));
    assert.equal((await page.textContent('#scrimmage-team-error')).trim(), 'Pat is editing a scouting entry for this team. Wait until they are finished before changing its number.');
    assert.ok((await teams())[7004] && !(await teams())[7040], 'nothing re-keyed');
    await page.click('#btn-scrimmage-team-cancel');
    await modalClosed(page);

    // ======== a plain MEMBER: number locked from the moment it opens (permission hint) ========
    const memPage = await ctx.newPage('member');
    await signInUI(memPage, member);
    await joinTeamUI(memPage, joinCode);
    await openScrimmageUI(memPage, 'State Scrim');
    await memPage.waitForFunction(() => currentScrimmage.teams['9003']);
    await openEdit(memPage, 9003);
    await memPage.waitForFunction(() => /needs a captain or scrimmage permission/.test(document.getElementById('scrimmage-team-number-hint').textContent));
    s = await ui(memPage);
    assert.deepEqual([s.hint, s.numberDisabled, s.nameReadOnly, s.linkBtn], ["Changing a team's number needs a captain or scrimmage permission.", true, false, 'Link to FTCScout'], 'member, unlinked: number locked with the permission hint, name editable');
    // the popup's number is FIXED for him
    await memPage.click('#btn-scrimmage-team-lookup');
    await memPage.waitForSelector('#ftc-lookup-modal:not(.hidden)');
    assert.ok(await memPage.isDisabled('#input-ftc-lookup-number'), 'popup number fixed when renumbering is not allowed');
    assert.equal((await memPage.textContent('#ftc-lookup-title')).trim(), 'Link Team #9003 to FTCScout');
    await memPage.click('#btn-ftc-lookup-cancel');
    await memPage.waitForSelector('#ftc-lookup-modal', { state: 'hidden' });
    await memPage.click('#btn-scrimmage-team-cancel');
    await modalClosed(memPage);
    // he can still LINK (a plain roster edit) at the team's own number
    await openEdit(memPage, 7005);
    await memPage.waitForFunction(() => /needs a captain/.test(document.getElementById('scrimmage-team-number-hint').textContent));
    await memPage.click('#btn-scrimmage-team-cancel');
    await modalClosed(memPage);
    await openEdit(memPage, 5555);
    await memPage.click('#btn-scrimmage-team-lookup');
    await memPage.waitForSelector('#ftc-lookup-modal:not(.hidden)');
    await memPage.click('#btn-ftc-lookup-go');
    await memPage.waitForSelector('#ftc-lookup-result:not(.hidden)');
    await memPage.click('#btn-ftc-lookup-confirm');
    await memPage.waitForSelector('#ftc-lookup-modal', { state: 'hidden' });
    s = await ui(memPage);
    assert.deepEqual([s.name, s.nameReadOnly, s.unlinkBtn], ['Five Star Robotics', true, 'Unlink'], 'member: B works too');
    await memPage.click('#btn-scrimmage-team-save');
    await modalClosed(memPage);
    await memPage.waitForFunction(() => currentScrimmage.teams['5555'].linked === true);
    assert.equal((await teams())[5555].manualName, 'Existing Five', 'manualName kept what was there');

    // ---- a focus that goes stale is repaired: the focused box turning read-only must not keep the focus ----
    await openEdit(page, 9003);
    await numberEnabled(page);
    await page.focus('#input-scrimmage-team-name');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'input-scrimmage-team-name');
    await page.evaluate(() => { scrimmageTeamModalState.lookup.linked = true; renderScrimmageTeamFtcUi(); });   // -> state C while the name box has focus
    assert.equal(await page.evaluate(() => document.getElementById('input-scrimmage-team-name').readOnly), true);
    await assertNoStaleFocus(page, 'focus repair (name turned read-only while focused)');
    await page.click('#btn-scrimmage-team-cancel');
    await modalClosed(page);
  }
};
