// Unofficial scrimmages, phase 2 — FTCScout lookup + linking (js/ftc-team-lookup.js):
//   add flow: Look up found / not found / network failure (just an error — there
//     is no manual button in the popup; the plain Add is the manual route) /
//     scout mode (modals fully closed before the pit form, cancel leaves nothing
//     behind) / a linked add REPLACES the typed name (manualName keeps it)
//   the lookup popup's number box is EDITABLE from the Add modal and kept in sync
//     with the Add modal's box (which keeps it when the popup is cancelled); an
//     already-on-the-roster number is an inline error in the popup AND the Add
//     modal (never a lookup, never a closed modal)
//   the TRAP: #99999 is a real FTCScout team — an UNLINKED scrimmage team 99999
//     never queries or shows it; only an explicit lookup does, and cancelling it
//     changes nothing
//   the lookup component: explicit Look up (nothing sent on open), reset on every
//     open AND close, stale responses dropped, z-order under the confirm modal
//   roster Edit -> Link to FTCScout: the OFFICIAL name drops into the read-only
//     name box at once (no preview line anywhere), nothing written until Save,
//     Cancel reverts, manualName keeps what was typed
//   Team Details: unlinked = no FTCScout request + a Link button; linked = the
//     real FTCScout data for the SCRIMMAGE'S season
// (Unlink / renumber live in 17-scrimmage-unlink.js.)

const assert = require('node:assert/strict');
const { FTCSCOUT_UNKNOWN_NUMBER, ftcScoutOpr } = require('../lib/harness');
const {
  signInUI, createTeamUI, openScoutingSubtab, createScrimmageUI, openScrimmageUI, openScrimmagesTab,
  teamRow, fillRequiredFields
} = require('../lib/app');

const readTeam = (page, teamId, scrimmageId, number) => page.evaluate(async ([tid, sid, n]) =>
  ((await db.collection('teams').doc(tid).collection('scrimmages').doc(sid).get()).data().teams || {})[String(n)] || null,
[teamId, scrimmageId, number]);

const rowText = (page, number) => page.textContent(`#team-list-info .team-item[data-team-number="${number}"]`);

async function openAddModal(page) {
  await page.click('#btn-scrimmage-add-team');
  await page.waitForSelector('#scrimmage-team-modal:not(.hidden)');
}

// In the open Add modal: type a number (+ name) and open the FTCScout lookup.
async function openLookupFromAdd(page, number, name) {
  await page.fill('#input-scrimmage-team-number', String(number));
  await page.fill('#input-scrimmage-team-name', name == null ? '' : name);
  await page.click('#btn-scrimmage-team-lookup');
  await page.waitForSelector('#ftc-lookup-modal:not(.hidden)');
}

const bothModalsHidden = (page) => page.evaluate(() =>
  document.getElementById('ftc-lookup-modal').classList.contains('hidden')
  && document.getElementById('scrimmage-team-modal').classList.contains('hidden'));

async function assertLookupModalReset(page, label) {
  assert.equal(await page.inputValue('#input-ftc-lookup-number'), '', `${label}: number reset`);
  assert.ok(!(await page.isDisabled('#input-ftc-lookup-number')), `${label}: number unlocked again`);
  for (const id of ['ftc-lookup-status', 'ftc-lookup-error', 'ftc-lookup-result-name', 'ftc-lookup-result-location', 'ftc-lookup-result-opr']) {
    assert.equal((await page.textContent(`#${id}`)).trim(), '', `${label}: #${id} reset`);
  }
  assert.ok(await page.locator('#ftc-lookup-result').evaluate(el => el.classList.contains('hidden')), `${label}: result hidden`);
  assert.ok(await page.locator('#btn-ftc-lookup-confirm').evaluate(el => el.classList.contains('hidden')), `${label}: confirm hidden`);
}

// The popup has Cancel + Look up / confirm and NOTHING ELSE: no manual-add button anywhere.
async function assertNoManualButton(page, label) {
  assert.equal(await page.locator('#btn-ftc-lookup-manual').count(), 0, `${label}: no "Add manually" button exists`);
  const labels = await page.$$eval('#ftc-lookup-modal button:not(.btn-modal-close)', bs => bs.filter(b => b.offsetParent !== null).map(b => b.textContent.trim()));
  assert.ok(!labels.some(t => /manual/i.test(t)), `${label}: no visible button mentions manual (${labels.join(' | ')})`);
}

async function openTeamDetails(page, number) {
  await openScoutingSubtab(page, 'info');
  await (await teamRow(page, '#team-list-info', number)).getByRole('button', { name: 'View Detail' }).click();
  await page.waitForSelector('#team-detail-modal:not(.hidden) #td-modal-body:not(.hidden)');
}

module.exports = {
  name: 'scrimmage FTCScout link: lookup found/not found/error, editable popup number synced with Add, duplicate number inline, no manual button, linked add replaces typed name, 99999 trap, stale guard, Edit link fills the name (no preview), Team Details linked vs unlinked',
  async run(ctx) {
    const captain = await ctx.makeUser('Captain Link');
    const page = await ctx.newPage('captain');
    await signInUI(page, captain);
    await createTeamUI(page, 'Link Smoke Team');
    const teamId = await page.evaluate(() => currentTeamData.id);
    const currentSeason = await page.evaluate(() => String(getCurrentFtcSeason()));
    const oldSeason = String(Number(currentSeason) - 1);

    await createScrimmageUI(page, { name: 'Link Scrim' });
    await openScrimmageUI(page, 'Link Scrim');
    const scrimmageId = await page.evaluate(() => selectedEvent.scrimmageId);
    const team = (n) => readTeam(page, teamId, scrimmageId, n);
    const ftcRequests = () => ctx.state.ftcScoutRequests.length;

    try {
      // ---------- FOUND: explicit lookup, official data, confirm adds it LINKED ----------
      await openAddModal(page);
      assert.equal((await page.textContent('#btn-scrimmage-team-lookup')).trim(), 'Look up on FTCScout');
      const beforeOpen = ftcRequests();
      await openLookupFromAdd(page, 1234, 'Robo Cats');
      assert.equal(await page.inputValue('#input-ftc-lookup-number'), '1234', 'prefilled from the Add modal');
      assert.ok(!(await page.isDisabled('#input-ftc-lookup-number')), 'the number is EDITABLE when the popup is opened from the Add modal');
      assert.equal((await page.textContent('#ftc-lookup-title')).trim(), 'Look Up a Team');
      // Opening it with a number in the box searches BY ITSELF (the cached team list, then the one team's details).
      await page.waitForSelector('#ftc-lookup-result:not(.hidden)');
      assert.ok(await page.isVisible('#btn-ftc-lookup-confirm'), 'the one match is auto-selected: confirm is offered without any click');
      await assertNoManualButton(page, 'idle');

      await page.click('#btn-ftc-lookup-go');
      await page.waitForSelector('#ftc-lookup-result:not(.hidden)');
      assert.equal((await page.textContent('#ftc-lookup-result-name')).trim(), 'Official Robo Cats');
      assert.equal((await page.textContent('#ftc-lookup-result-location')).trim(), 'Austin, TX, USA');
      assert.ok((await page.textContent('#ftc-lookup-result-opr')).includes(ftcScoutOpr(1234, currentSeason).toFixed(1)), 'OPR for the scrimmage season is shown');
      assert.equal(await page.locator('#ftc-lookup-result-preview, .ftc-link-preview').count(), 0, 'no "Name: A -> B" preview anywhere');
      await assertNoManualButton(page, 'found');
      const reqs = ctx.state.ftcScoutRequests.slice(beforeOpen);
      const listReqs = reqs.filter(q => /teamsSearch/.test(q));
      const teamReqs = reqs.filter(q => /teamByNumber/.test(q));
      assert.ok(listReqs.length <= 1, 'the team list is fetched at most once (lazily, then cached on the device)');
      assert.equal(teamReqs.length, 1, 'exactly one team lookup — the Look up click re-used the cached details');
      assert.match(teamReqs[0], /teamByNumber\(number: 1234\)/);
      assert.match(teamReqs[0], new RegExp(`quickStats\\(season: ${currentSeason}\\)`), "the scrimmage's season, not another");
      assert.equal((await page.textContent('#btn-ftc-lookup-confirm')).trim(), 'Add Linked Team');

      await page.click('#btn-ftc-lookup-confirm');
      await page.waitForFunction(() => document.getElementById('ftc-lookup-modal').classList.contains('hidden')
        && document.getElementById('scrimmage-team-modal').classList.contains('hidden'));
      await page.locator('#team-list-info .team-item[data-team-number="1234"]').waitFor();
      const linked = await team(1234);
      assert.equal(linked.name, 'Official Robo Cats', 'the official name REPLACED the typed one');
      assert.equal(linked.manualName, 'Robo Cats', 'manualName keeps what was typed');
      assert.equal(linked.linked, true);
      assert.equal(linked.location, 'Austin, TX, USA');
      assert.equal(linked.opr, ftcScoutOpr(1234, currentSeason));
      assert.ok(linked.linkedAt, 'linkedAt is set');
      assert.match(await rowText(page, 1234), /Official Robo Cats/);
      assert.equal((await page.locator('#team-list-info .team-item[data-team-number="1234"] .team-name').textContent()).trim(), 'Official Robo Cats', 'the row shows the official name, not the typed one');
      assert.equal((await page.locator('#team-list-info .team-item[data-team-number="1234"] .team-link-badge').textContent()).trim(), 'linked');
      assert.match(await page.textContent('#scrimmage-roster-success'), /Added Team #1234/);
      await assertLookupModalReset(page, 'after confirm');

      // ---------- NOT FOUND: an answer, not an error; the plain Add is the manual route ----------
      await openAddModal(page);
      await openLookupFromAdd(page, FTCSCOUT_UNKNOWN_NUMBER, 'Typed Eight');
      await page.click('#btn-ftc-lookup-go');
      await page.waitForFunction((n) => new RegExp(`^No FTCScout team matches ${n}\\.$`).test(document.getElementById('ftc-lookup-status').textContent.trim()), FTCSCOUT_UNKNOWN_NUMBER);
      assert.equal((await page.textContent('#ftc-lookup-error')).trim(), '', 'not found is not an error');
      assert.ok(!(await page.isVisible('#btn-ftc-lookup-confirm')), 'nothing to link');
      await assertNoManualButton(page, 'not found');
      // Editing the number INSIDE the popup updates the Add modal behind it...
      await page.fill('#input-ftc-lookup-number', '5432');
      assert.equal(await page.inputValue('#input-scrimmage-team-number'), '5432', "the popup's number is mirrored into the Add modal");
      await page.fill('#input-ftc-lookup-number', String(FTCSCOUT_UNKNOWN_NUMBER));
      assert.equal(await page.inputValue('#input-scrimmage-team-number'), String(FTCSCOUT_UNKNOWN_NUMBER));
      // ...and Cancel returns to the Add modal, which KEEPS the number (and the name).
      await page.fill('#input-ftc-lookup-number', '6543');
      await page.click('#btn-ftc-lookup-cancel');
      await page.waitForSelector('#ftc-lookup-modal', { state: 'hidden' });
      assert.ok(await page.isVisible('#scrimmage-team-modal'), 'Add modal still open under a cancelled lookup');
      assert.equal(await page.inputValue('#input-scrimmage-team-number'), '6543', 'the Add modal keeps the number typed in the popup');
      assert.equal(await page.inputValue('#input-scrimmage-team-name'), 'Typed Eight');
      await assertLookupModalReset(page, 'after cancel');
      // Reopen: the popup starts from the Add modal's number again.
      await page.click('#btn-scrimmage-team-lookup');
      await page.waitForSelector('#ftc-lookup-modal:not(.hidden)');
      assert.equal(await page.inputValue('#input-ftc-lookup-number'), '6543');
      await page.click('#btn-ftc-lookup-cancel');
      await page.waitForSelector('#ftc-lookup-modal', { state: 'hidden' });
      // The plain Add button adds it unlinked with the typed name.
      await page.fill('#input-scrimmage-team-number', String(FTCSCOUT_UNKNOWN_NUMBER));
      await page.click('#btn-scrimmage-team-save');
      await page.waitForFunction(() => document.getElementById('ftc-lookup-modal').classList.contains('hidden')
        && document.getElementById('scrimmage-team-modal').classList.contains('hidden'));
      await page.locator(`#team-list-info .team-item[data-team-number="${FTCSCOUT_UNKNOWN_NUMBER}"]`).waitFor();
      const manual = await team(FTCSCOUT_UNKNOWN_NUMBER);
      assert.deepEqual([manual.name, manual.manualName, manual.linked, manual.location, manual.opr, manual.linkedAt], ['Typed Eight', 'Typed Eight', false, '', null, null], 'added manually: unlinked with the typed name');
      assert.equal((await page.locator(`#team-list-info .team-item[data-team-number="${FTCSCOUT_UNKNOWN_NUMBER}"] .team-link-badge`).textContent()).trim(), 'unlinked');

      // ---------- NETWORK FAILURE / API ERROR: just an error — no manual button, no offline path ----------
      for (const mode of ['abort', 'error']) {
        ctx.state.ftcScoutMode = mode;
        await openAddModal(page);
        await openLookupFromAdd(page, 4040, 'Offline Team');
        await page.click('#btn-ftc-lookup-go');
        await page.waitForFunction(() => /Couldn't reach FTCScout/.test(document.getElementById('ftc-lookup-error').textContent));
        assert.equal((await page.textContent('#ftc-lookup-error')).trim(), "Couldn't reach FTCScout. Check your connection and try again.");
        assert.doesNotMatch(await page.textContent('#ftc-lookup-modal'), /manual/i, `${mode}: nothing offers a manual route`);
        assert.ok(!(await page.isVisible('#btn-ftc-lookup-confirm')), `${mode}: nothing to link`);
        await assertNoManualButton(page, mode);
        assert.equal((await page.textContent('#ftc-lookup-status')).trim(), '', `${mode}: no "not found" line for an error`);
        await page.click('#btn-ftc-lookup-cancel');
        await page.waitForSelector('#ftc-lookup-modal', { state: 'hidden' });
        if (mode === 'abort') {
          await page.click('#btn-scrimmage-team-cancel');
          await page.waitForSelector('#scrimmage-team-modal', { state: 'hidden' });
        }
      }
      // The Add modal is still open with the typed number and name: plain Add works offline.
      assert.equal(await page.inputValue('#input-scrimmage-team-number'), '4040');
      await page.click('#btn-scrimmage-team-save');
      await page.waitForFunction(() => document.getElementById('scrimmage-team-modal').classList.contains('hidden'));
      await page.locator('#team-list-info .team-item[data-team-number="4040"]').waitFor();
      assert.equal((await team(4040)).linked, false, 'added with the plain Add after the failure');
      ctx.state.ftcScoutMode = 'ok';

      // ---------- already on the roster: an INLINE ERROR, modal stays open, no lookup ----------
      const dup = (n) => `Team #${n} is already on this scrimmage's roster. Change the number or cancel.`;
      const beforeExisting = ftcRequests();
      await openAddModal(page);
      await page.fill('#input-scrimmage-team-number', '1234');
      await page.fill('#input-scrimmage-team-name', 'Another Name');
      await page.click('#btn-scrimmage-team-save');
      assert.equal((await page.textContent('#scrimmage-team-error')).trim(), dup(1234), 'plain Add: inline error');
      assert.ok(await page.isVisible('#scrimmage-team-modal'), 'the Add modal stays open');
      // Opening the lookup for that number: the team IS in the list, but it is already on this
      // scrimmage — so its row is GREYED, can't be selected, and nothing is looked up.
      await page.click('#btn-scrimmage-team-lookup');
      await page.waitForSelector('#ftc-lookup-modal:not(.hidden)');
      assert.equal(await page.inputValue('#input-ftc-lookup-number'), '1234');
      await page.waitForSelector('#ftc-lookup-results .ftc-result-row.is-roster');
      assert.match(await page.textContent('#ftc-lookup-results .ftc-result-row.is-roster'), /already on this scrimmage/);
      assert.ok(await page.locator('#ftc-lookup-results .ftc-result-row.is-roster').isDisabled(), 'the greyed row cannot be selected');
      assert.ok(!(await page.isVisible('#ftc-lookup-result')), 'no card for a number already on the roster');
      assert.ok(!(await page.isVisible('#btn-ftc-lookup-confirm')), 'nothing to confirm');
      assert.equal(ftcRequests(), beforeExisting, 'no FTCScout request');
      // Fix the number INSIDE the popup: it mirrors into the Add modal, and a lookup works.
      await page.fill('#input-ftc-lookup-number', '3579');
      assert.equal(await page.inputValue('#input-scrimmage-team-number'), '3579');
      await page.click('#btn-ftc-lookup-go');
      await page.waitForSelector('#ftc-lookup-result:not(.hidden)');
      assert.equal((await page.textContent('#ftc-lookup-error')).trim(), '', 'the error cleared');
      await page.click('#btn-ftc-lookup-cancel');
      await page.waitForSelector('#ftc-lookup-modal', { state: 'hidden' });
      assert.equal(await page.inputValue('#input-scrimmage-team-number'), '3579');
      // An UNLINKED roster number is refused the same way — it is not silently linked.
      await page.fill('#input-scrimmage-team-number', '4040');
      await page.click('#btn-scrimmage-team-save');
      assert.equal((await page.textContent('#scrimmage-team-error')).trim(), dup(4040));
      assert.equal((await team(4040)).linked, false);
      assert.equal((await team(1234)).name, 'Official Robo Cats', 'existing teams untouched');
      await page.click('#btn-scrimmage-team-cancel');
      await page.waitForSelector('#scrimmage-team-modal', { state: 'hidden' });
      assert.equal(await team(3579), null, 'cancelled: nothing was added');

      // ---------- the 99999 TRAP ----------
      const beforeTrap = ftcRequests();
      await openAddModal(page);
      await page.fill('#input-scrimmage-team-number', '99999');
      await page.fill('#input-scrimmage-team-name', 'Not The Demo Team');
      await page.click('#btn-scrimmage-team-save'); // the plain Add: manual, unlinked
      await page.waitForSelector('#scrimmage-team-modal', { state: 'hidden' });
      await page.locator('#team-list-info .team-item[data-team-number="99999"]').waitFor();
      assert.equal((await team(99999)).linked, false);
      await openTeamDetails(page, 99999);
      assert.equal(ftcRequests(), beforeTrap, 'an UNLINKED scrimmage team never queries FTCScout — not on add, not on Team Details');
      assert.equal((await page.textContent('#td-team-name')).trim(), 'Not The Demo Team');
      assert.equal((await page.textContent('#td-team-location')).trim(), 'Unofficial scrimmage team');
      assert.doesNotMatch(await page.textContent('#team-detail-modal'), /Off-Season Demo Team|Demo City/, "none of the real #99999's data is shown");
      assert.match(await page.textContent('#td-awards-list'), /This team isn't linked to FTCScout\./);
      assert.equal((await page.locator('#td-awards-list .btn-td-link-ftc').textContent()).trim(), 'Link to FTCScout');
      // An EXPLICIT lookup does reach FTCScout — and cancelling it changes nothing.
      await page.click('#td-awards-list .btn-td-link-ftc');
      await page.waitForSelector('#ftc-lookup-modal:not(.hidden)');
      assert.equal((await page.textContent('#ftc-lookup-title')).trim(), 'Link Team #99999 to FTCScout');
      assert.ok(await page.isDisabled('#input-ftc-lookup-number'), 'number fixed');
      await assertNoManualButton(page, 'link popup');
      assert.equal(ftcRequests(), beforeTrap, 'still nothing sent until Look up is pressed');
      await page.click('#btn-ftc-lookup-go');
      await page.waitForSelector('#ftc-lookup-result:not(.hidden)');
      assert.equal((await page.textContent('#ftc-lookup-result-name')).trim(), 'Off-Season Demo Team');
      assert.equal((await page.textContent('#btn-ftc-lookup-confirm')).trim(), 'Link Team');
      await page.click('#btn-ftc-lookup-cancel');
      await page.waitForSelector('#ftc-lookup-modal', { state: 'hidden' });
      await assertLookupModalReset(page, 'after cancelling the 99999 lookup');
      const stillUnlinked = await team(99999);
      assert.deepEqual([stillUnlinked.name, stillUnlinked.linked], ['Not The Demo Team', false], 'cancelled: nothing changed');
      assert.match(await page.textContent('#td-awards-list'), /isn't linked/);
      await page.click('#btn-team-detail-close');

      // ---------- the lookup component on its own ----------
      // (a) stale responses: change the number while a slow lookup is in flight.
      await page.evaluate(() => {
        window.__lookup = openFtcTeamLookup({ title: 'Component test', season: String(getCurrentFtcSeason()), initialNumber: '', numberLocked: false, confirmLabel: 'Use' });
      });
      await page.waitForSelector('#ftc-lookup-modal:not(.hidden)');
      assert.ok(!(await page.isDisabled('#input-ftc-lookup-number')), 'unlocked number box when numberLocked is false');
      ctx.state.ftcScoutDelays = { 5555: 1500 };
      await page.fill('#input-ftc-lookup-number', '5555');
      await page.click('#btn-ftc-lookup-go');
      await page.waitForFunction(() => /Looking up team #5555/.test(document.getElementById('ftc-lookup-status').textContent));
      await page.fill('#input-ftc-lookup-number', '2468'); // typing drops the in-flight lookup (no live search)
      assert.equal((await page.textContent('#ftc-lookup-status')).trim(), '', 'editing the number clears the loading line');
      await page.click('#btn-ftc-lookup-go');
      await page.waitForSelector('#ftc-lookup-result:not(.hidden)');
      assert.equal((await page.textContent('#ftc-lookup-result-name')).trim(), 'Gear Grinders Robotics');
      await page.waitForTimeout(1900); // the 5555 response lands now — and must be ignored
      assert.equal((await page.textContent('#ftc-lookup-result-name')).trim(), 'Gear Grinders Robotics', 'the late #5555 response did not overwrite the result');
      assert.equal(await page.inputValue('#input-ftc-lookup-number'), '2468');
      // (b) a number change after a result also drops that result (it was for another number).
      await page.fill('#input-ftc-lookup-number', '246');
      assert.ok(!(await page.isVisible('#ftc-lookup-result')), 'result hidden once the number no longer matches');
      assert.ok(!(await page.isVisible('#btn-ftc-lookup-confirm')), 'and nothing can be confirmed for it');
      // (c) closing while a lookup is in flight, then reopening: the late response leaks nowhere.
      await page.fill('#input-ftc-lookup-number', '5555');
      await page.click('#btn-ftc-lookup-go');
      await page.click('#btn-ftc-lookup-cancel');
      assert.equal(await page.evaluate(() => window.__lookup), null, 'cancel resolves the promise with null');
      await page.waitForSelector('#ftc-lookup-modal', { state: 'hidden' });
      await page.evaluate(() => { window.__lookup2 = openFtcTeamLookup({ title: 'Second open', season: String(getCurrentFtcSeason()), initialNumber: 303, numberLocked: true }); });
      await page.waitForSelector('#ftc-lookup-modal:not(.hidden)');
      // The reopened popup looks #303 up BY ITSELF (auto look up on open) — and the late
      // #5555 response from the closed session must not replace that result.
      await page.waitForSelector('#ftc-lookup-result:not(.hidden)');
      await page.waitForTimeout(1900);
      assert.equal((await page.textContent('#ftc-lookup-result-name')).trim(), 'Gamma Gears', 'a response for a closed session never shows in the reopened modal');
      assert.equal(await page.inputValue('#input-ftc-lookup-number'), '303', 'fields come from the new open, not the old one');
      await page.click('#btn-ftc-lookup-close');
      await page.waitForSelector('#ftc-lookup-modal', { state: 'hidden' });
      await assertLookupModalReset(page, 'after the X');
      ctx.state.ftcScoutDelays = {};
      // (d) z-order: the generic confirm (bulk-link overwrite) must layer ABOVE the lookup modal.
      const z = await page.evaluate(() => ['ftc-lookup-modal', 'generic-confirm-modal', 'scrimmage-team-modal', 'team-detail-modal']
        .map(id => Number(getComputedStyle(document.getElementById(id)).zIndex)));
      assert.ok(z[1] > z[0], `generic confirm (${z[1]}) above the lookup modal (${z[0]})`);
      assert.ok(z[0] >= z[2] && z[0] > z[3], `lookup modal (${z[0]}) at/above the Add/Edit (${z[2]}) and Team Detail (${z[3]}) modals it opens from`);

      // ---------- scout mode: modals fully closed BEFORE the form; cancel leaves nothing behind ----------
      await openScoutingSubtab(page, 'pit');
      await page.click('#btn-scrimmage-add-scout-pit');
      await page.waitForSelector('#scrimmage-team-modal:not(.hidden)');
      await openLookupFromAdd(page, 5555, '');
      await page.click('#btn-ftc-lookup-go');
      await page.waitForSelector('#ftc-lookup-result:not(.hidden)');
      assert.equal((await page.textContent('#btn-ftc-lookup-confirm')).trim(), 'Add & Scout (Linked)');
      await page.click('#btn-ftc-lookup-cancel');
      await page.click('#btn-scrimmage-team-cancel');
      await page.waitForSelector('#scrimmage-team-modal', { state: 'hidden' });
      assert.ok(!(await page.isVisible('#pit-modal')), 'cancelled: no pit form');
      assert.equal(await team(5555), null, 'cancelled: the team was not added');
      const orphan = await page.evaluate(async ([tid]) => (await db.collection('teams').doc(tid).collection('pitScouting').where('teamNumber', '==', 5555).get()).size, [teamId]);
      assert.equal(orphan, 0, 'cancelled: no orphan draft');

      await page.click('#btn-scrimmage-add-scout-pit');
      await page.waitForSelector('#scrimmage-team-modal:not(.hidden)');
      await openLookupFromAdd(page, 3579, 'Circ');
      await page.click('#btn-ftc-lookup-go');
      await page.waitForSelector('#ftc-lookup-result:not(.hidden)');
      await page.click('#btn-ftc-lookup-confirm');
      await page.waitForSelector('#pit-modal:not(.hidden) #pit-dynamic-fields .pit-field');
      assert.ok(await bothModalsHidden(page), 'the lookup AND Add modals are fully closed before the pit form shows');
      assert.deepEqual([(await team(3579)).name, (await team(3579)).manualName, (await team(3579)).linked], ['Circuit Breakers', 'Circ', true]);
      await page.waitForFunction(() => typeof currentPitLiveSession !== 'undefined' && currentPitLiveSession && currentPitLiveSession.isJoined());
      await fillRequiredFields(page, '#pit-modal', 'linked scout');
      await page.click('#btn-pit-save');
      await page.waitForSelector('#pit-modal', { state: 'hidden' });
      await (await teamRow(page, '#team-list-pit', 3579)).locator('.pit-row-meta').waitFor();
      const pitDocs = await page.evaluate(async ([tid]) => (await db.collection('teams').doc(tid).collection('pitScouting').where('teamNumber', '==', 3579).get()).size, [teamId]);
      assert.equal(pitDocs, 1, 'exactly one pit entry for the new linked team');

      // ---------- roster Edit -> Link to FTCScout (name filled at once, nothing written until Save) ----------
      await openScoutingSubtab(page, 'info');
      await openAddModal(page);
      await page.fill('#input-scrimmage-team-number', '2468');
      await page.fill('#input-scrimmage-team-name', 'Gears');
      await page.click('#btn-scrimmage-team-save');
      await page.waitForSelector('#scrimmage-team-modal', { state: 'hidden' });
      await page.locator('#team-list-info .team-item[data-team-number="2468"]').waitFor();
      assert.equal((await page.locator('#team-list-info .team-item[data-team-number="2468"] .team-link-badge').textContent()).trim(), 'unlinked');

      await (await teamRow(page, '#team-list-info', 2468)).locator('.btn-scrimmage-team-edit').click();
      await page.waitForSelector('#scrimmage-team-modal:not(.hidden)');
      assert.equal((await page.textContent('#scrimmage-team-title')).trim(), 'Edit Team #2468');
      assert.equal((await page.textContent('#btn-scrimmage-team-lookup')).trim(), 'Link to FTCScout');
      assert.ok(!(await page.isVisible('#btn-scrimmage-team-unlink')), 'an unlinked team has no Unlink');
      // captain, no entries: the number is editable from the moment the Edit modal opens (see test 20)
      await page.waitForFunction(() => !document.getElementById('input-scrimmage-team-number').disabled);
      assert.ok(!(await page.locator('#input-scrimmage-team-name').evaluate(el => el.readOnly)), 'an unlinked team name is editable');
      assert.equal(await page.inputValue('#input-scrimmage-team-name'), 'Gears');
      await page.click('#btn-scrimmage-team-lookup');
      await page.waitForSelector('#ftc-lookup-modal:not(.hidden)');
      assert.equal((await page.textContent('#ftc-lookup-title')).trim(), 'Link a Team to FTCScout');
      assert.ok(!(await page.isDisabled('#input-ftc-lookup-number')), 'Edit + renumbering allowed: the popup number is editable');
      assert.equal(await page.inputValue('#input-ftc-lookup-number'), '2468');
      await assertNoManualButton(page, 'edit popup');
      await page.click('#btn-ftc-lookup-go');
      await page.waitForSelector('#ftc-lookup-result:not(.hidden)');
      assert.equal((await page.textContent('#btn-ftc-lookup-confirm')).trim(), 'Use This Team');
      assert.equal(await page.locator('#ftc-lookup-result-preview').count(), 0, 'no preview line in the popup');
      await page.click('#btn-ftc-lookup-confirm');
      await page.waitForSelector('#ftc-lookup-modal', { state: 'hidden' });
      assert.ok(await page.isVisible('#scrimmage-team-modal'), 'back in the Edit modal');
      // The OFFICIAL name is in the box straight away (read-only), BEFORE Save; no preview line.
      assert.equal(await page.inputValue('#input-scrimmage-team-name'), 'Gear Grinders Robotics', 'official name filled in before Save');
      assert.ok(await page.locator('#input-scrimmage-team-name').evaluate(el => el.readOnly), 'and the box is read-only');
      assert.match(await page.textContent('#scrimmage-team-ftc-help'), /Will link to FTCScout: Gear Grinders Robotics \(Portland, OR, USA\)/);
      assert.equal(await page.locator('#scrimmage-team-link-preview').count(), 0, 'no "Name: A -> B" preview line');
      assert.doesNotMatch(await page.textContent('#scrimmage-team-modal'), /Name: .* -> /);
      let still = await team(2468);
      assert.deepEqual([still.name, still.linked], ['Gears', false], 'nothing is written before Save');
      // Cancel reverts EVERYTHING: the pending link is dropped and the box is back to the original text.
      await page.click('#btn-scrimmage-team-cancel');
      await page.waitForSelector('#scrimmage-team-modal', { state: 'hidden' });
      still = await team(2468);
      assert.deepEqual([still.name, still.linked], ['Gears', false], 'cancel: unchanged');
      await (await teamRow(page, '#team-list-info', 2468)).locator('.btn-scrimmage-team-edit').click();
      await page.waitForSelector('#scrimmage-team-modal:not(.hidden)');
      assert.equal(await page.inputValue('#input-scrimmage-team-name'), 'Gears', 'the name box is back to its original value');
      assert.ok(!(await page.locator('#input-scrimmage-team-name').evaluate(el => el.readOnly)), 'and editable again');
      assert.doesNotMatch(await page.textContent('#scrimmage-team-ftc-help'), /Will link/, 'pending link reset on reopen');
      // Do it for real.
      await page.click('#btn-scrimmage-team-lookup');
      await page.waitForSelector('#ftc-lookup-modal:not(.hidden)');
      await page.click('#btn-ftc-lookup-go');
      await page.waitForSelector('#ftc-lookup-result:not(.hidden)');
      await page.click('#btn-ftc-lookup-confirm');
      await page.waitForSelector('#ftc-lookup-modal', { state: 'hidden' });
      await page.click('#btn-scrimmage-team-save');
      await page.waitForSelector('#scrimmage-team-modal', { state: 'hidden' });
      await page.waitForFunction((n) => (document.querySelector(`#team-list-info .team-item[data-team-number="${n}"]`)?.textContent || '').includes('Gear Grinders Robotics'), 2468);
      const gears = await team(2468);
      assert.deepEqual([gears.name, gears.manualName, gears.linked, gears.location, gears.opr], ['Gear Grinders Robotics', 'Gears', true, 'Portland, OR, USA', ftcScoutOpr(2468, currentSeason)], 'manualName keeps what was typed');
      assert.ok(gears.linkedAt);
      // A linked team's Edit: no Link button, a READ-ONLY name, an Unlink button.
      await (await teamRow(page, '#team-list-info', 2468)).locator('.btn-scrimmage-team-edit').click();
      await page.waitForSelector('#scrimmage-team-modal:not(.hidden)');
      assert.ok(!(await page.isVisible('#btn-scrimmage-team-lookup')), 'a linked team has no Link button');
      assert.ok(await page.isVisible('#btn-scrimmage-team-unlink'), 'a linked team has Unlink');
      assert.ok(await page.locator('#input-scrimmage-team-name').evaluate(el => el.readOnly), 'a linked team\'s name is read-only');
      assert.match(await page.textContent('#scrimmage-team-lock-note'), /^Linked to FTCScout\./, 'the lock note is its own line (state C)');
      // Save with nothing staged writes nothing (and must not clobber manualName with the official name).
      await page.click('#btn-scrimmage-team-save');
      await page.waitForSelector('#scrimmage-team-modal', { state: 'hidden' });
      assert.equal((await team(2468)).manualName, 'Gears', 'a no-op Save leaves manualName alone');
      // A team with NO typed name links the same way and manualName stays blank.
      await openAddModal(page);
      await page.fill('#input-scrimmage-team-number', '5555');
      await page.click('#btn-scrimmage-team-save');
      await page.waitForSelector('#scrimmage-team-modal', { state: 'hidden' });
      await page.locator('#team-list-info .team-item[data-team-number="5555"]').waitFor();
      await (await teamRow(page, '#team-list-info', 5555)).locator('.btn-scrimmage-team-edit').click();
      await page.waitForSelector('#scrimmage-team-modal:not(.hidden)');
      await page.click('#btn-scrimmage-team-lookup');
      await page.waitForSelector('#ftc-lookup-modal:not(.hidden)');
      await page.click('#btn-ftc-lookup-go');
      await page.waitForSelector('#ftc-lookup-result:not(.hidden)');
      await page.click('#btn-ftc-lookup-confirm');
      await page.waitForSelector('#ftc-lookup-modal', { state: 'hidden' });
      assert.equal(await page.inputValue('#input-scrimmage-team-name'), 'Five Star Robotics');
      await page.click('#btn-scrimmage-team-save');
      await page.waitForSelector('#scrimmage-team-modal', { state: 'hidden' });
      await page.waitForFunction(() => (document.querySelector('#team-list-info .team-item[data-team-number="5555"]')?.textContent || '').includes('Five Star Robotics'));
      const five = await team(5555);
      assert.deepEqual([five.name, five.manualName, five.linked], ['Five Star Robotics', '', true]);

      // ---------- Team Details: LINKED = real FTCScout data for the scrimmage's season ----------
      await openTeamDetails(page, 1234);
      assert.equal((await page.textContent('#td-team-name')).trim(), 'Official Robo Cats');
      assert.equal((await page.textContent('#td-team-location')).trim(), 'Austin, TX, USA');
      assert.equal((await page.textContent('#td-opr-badge')).trim(), `OPR: ${ftcScoutOpr(1234, currentSeason).toFixed(1)}`);
      assert.equal(await page.locator('#td-awards-list .btn-td-link-ftc').count(), 0, 'a linked team has no Link button');
      assert.doesNotMatch(await page.textContent('#td-awards-list'), /isn't linked/);
      await page.click('#btn-team-detail-close');

      // ---------- ...and for an OLD-season scrimmage, the OLD season's numbers ----------
      await createScrimmageUI(page, { name: 'Past Season Scrim', season: oldSeason });
      await openScrimmageUI(page, 'Past Season Scrim');
      const oldId = await page.evaluate(() => selectedEvent.scrimmageId);
      await openAddModal(page);
      await openLookupFromAdd(page, 1234, '');
      const beforeOld = ftcRequests();
      await page.click('#btn-ftc-lookup-go');
      await page.waitForSelector('#ftc-lookup-result:not(.hidden)');
      assert.match(ctx.state.ftcScoutRequests[beforeOld], new RegExp(`quickStats\\(season: ${oldSeason}\\)`), 'the lookup used the OLD scrimmage season (the cached current-season doc was not reused)');
      assert.ok((await page.textContent('#ftc-lookup-result-opr')).includes(ftcScoutOpr(1234, oldSeason).toFixed(1)));
      await page.click('#btn-ftc-lookup-confirm');
      await page.waitForFunction(() => document.getElementById('ftc-lookup-modal').classList.contains('hidden')
        && document.getElementById('scrimmage-team-modal').classList.contains('hidden'));
      await page.locator('#team-list-info .team-item[data-team-number="1234"]').waitFor();
      assert.equal((await readTeam(page, teamId, oldId, 1234)).opr, ftcScoutOpr(1234, oldSeason));
      // Make the shared cache doc useless for this season so Team Details has to fetch.
      await page.evaluate(() => db.collection('teamDetails').doc('1234').set({ name: 'stale', season: '1999', teamNumber: 1234, cachedAt: firebase.firestore.FieldValue.serverTimestamp() }));
      const beforeDetail = ftcRequests();
      await openTeamDetails(page, 1234);
      assert.equal((await page.textContent('#td-opr-badge')).trim(), `OPR: ${ftcScoutOpr(1234, oldSeason).toFixed(1)}`);
      assert.match(ctx.state.ftcScoutRequests[beforeDetail], new RegExp(`teamByNumber\\(number: 1234\\)[\\s\\S]*quickStats\\(season: ${oldSeason}\\)`), 'Team Details fetched for the scrimmage season');
      await page.click('#btn-team-detail-close');
      await openScrimmageUI(page, 'Link Scrim');

      // ---------- Team Details: UNLINKED -> Link button -> link from there ----------
      await openAddModal(page);
      await page.fill('#input-scrimmage-team-number', '202');
      await page.fill('#input-scrimmage-team-name', 'Beta');
      await page.click('#btn-scrimmage-team-save');
      await page.waitForSelector('#scrimmage-team-modal', { state: 'hidden' });
      await page.locator('#team-list-info .team-item[data-team-number="202"]').waitFor();
      const beforeUnlinkedDetail = ftcRequests();
      await openTeamDetails(page, 202);
      assert.equal(ftcRequests(), beforeUnlinkedDetail, 'unlinked Team Details sends no FTCScout request');
      assert.match(await page.textContent('#td-awards-list'), /This team isn't linked to FTCScout\./);
      await page.click('#td-awards-list .btn-td-link-ftc');
      await page.waitForSelector('#ftc-lookup-modal:not(.hidden)');
      await page.click('#btn-ftc-lookup-go');
      await page.waitForSelector('#ftc-lookup-result:not(.hidden)');
      assert.equal(await page.locator('#ftc-lookup-result-preview').count(), 0, 'Team Details link: no preview either');
      await page.click('#btn-ftc-lookup-confirm');
      await page.waitForSelector('#ftc-lookup-modal', { state: 'hidden' });
      await page.waitForFunction(() => document.getElementById('td-team-name').textContent.trim() === 'Beta Builders');
      assert.equal((await page.textContent('#td-team-location')).trim(), 'Columbus, OH, USA');
      assert.equal((await page.textContent('#td-opr-badge')).trim(), `OPR: ${ftcScoutOpr(202, currentSeason).toFixed(1)}`);
      assert.doesNotMatch(await page.textContent('#td-awards-list'), /isn't linked/, 'the detail reloaded as a linked team');
      assert.match(await page.textContent('#team-detail-modal-title'), /Team #202 — Beta Builders/);
      const beta = await team(202);
      assert.deepEqual([beta.name, beta.manualName, beta.linked], ['Beta Builders', 'Beta', true]);
      await page.click('#btn-team-detail-close');
      assert.equal((await page.locator('#team-list-info .team-item[data-team-number="202"] .team-link-badge').textContent()).trim(), 'linked');
    } finally {
      ctx.state.ftcScoutMode = 'ok';
      ctx.state.ftcScoutDelays = {};
    }
  }
};
