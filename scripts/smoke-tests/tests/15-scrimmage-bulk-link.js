// Unofficial scrimmages — the roster's "Bulk link teams (N)" REVIEW popup and the
// link badges:
//   - the button does ONE batched FTCScout lookup for the UNLINKED teams only and
//     writes NOTHING; a review popup then lists the found teams as checkboxes (ALL
//     checked; `typed -> official` only when the name would change) and the
//     not-found ones (no checkboxes, "stay unlinked")
//   - the confirm button follows the count ("Link 3 teams" / "Link 1 team"),
//     disabled at zero; it links ONLY the checked teams, in one write
//   - Cancel / X / click-out change nothing and discard everything; the popup
//     starts fresh (all checked) next time
//   - no second confirm; no result line that stays on the page (just a brief,
//     auto-clearing message); a network failure changes nothing
//   - if FTCScout knows none of the teams: a notice, no checkbox list
//   - any member can do it
//   - badges: "unlinked" on Info / Pit / Match / Compare rows, "linked" on Info
//     only, none on an official event

const assert = require('node:assert/strict');
const { FTCSCOUT_UNKNOWN_NUMBER } = require('../lib/harness');
const {
  signInUI, createTeamUI, joinTeamUI, createScrimmageUI, openScrimmageUI, openScoutingSubtab,
  submitScrimmageTeamModal, selectFixtureEvent
} = require('../lib/app');

const readRoster = (page, teamId, scrimmageId) => page.evaluate(async ([tid, sid]) =>
  (await db.collection('teams').doc(tid).collection('scrimmages').doc(sid).get()).data().teams, [teamId, scrimmageId]);

async function addManual(page, number, name) {
  await openScoutingSubtab(page, 'info');
  await page.click('#btn-scrimmage-add-team');
  await submitScrimmageTeamModal(page, { number, name });
  await page.locator(`#team-list-info .team-item[data-team-number="${number}"]`).waitFor();
}

const confirmOpen = (page) => page.evaluate(() => !document.getElementById('generic-confirm-modal').classList.contains('hidden'));
const bulkText = async (page) => (await page.textContent('#btn-scrimmage-bulk-link')).trim();
const reviewOpen = (page) => page.evaluate(() => !document.getElementById('bulk-link-modal').classList.contains('hidden'));
const confirmLabel = async (page) => (await page.textContent('#btn-bulk-link-confirm')).trim();
// "#101 Alpha -> Alpha Bots": the number span and the text span, as the row lays them out (flex gap).
const rowText = (page, number) => page.locator(`#bulk-link-found .bulk-link-row[data-team-number="${number}"]`)
  .evaluate(row => [...row.querySelectorAll('span')].map(s => s.textContent.trim()).join(' '));

async function pressBulk(page) {
  await page.click('#btn-scrimmage-bulk-link');
  await page.waitForSelector('#bulk-link-modal:not(.hidden)');
}

module.exports = {
  name: 'scrimmage bulk link: review popup after ONE lookup (nothing written), checkboxes default checked, only checked teams linked, cancel/X/click-out = no change, no lingering message, not-found listed, member can, badges',
  async run(ctx) {
    const captain = await ctx.makeUser('Captain Bulk');
    const member = await ctx.makeUser('Member Bulk');
    const page = await ctx.newPage('captain');
    await signInUI(page, captain);
    const joinCode = await createTeamUI(page, 'Bulk Link Team');
    const teamId = await page.evaluate(() => currentTeamData.id);
    const currentSeason = await page.evaluate(() => String(getCurrentFtcSeason()));

    await createScrimmageUI(page, { name: 'Bulk Scrim' });
    await createScrimmageUI(page, { name: 'Silent Scrim' });
    await openScrimmageUI(page, 'Bulk Scrim');
    const bulkId = await page.evaluate(() => selectedEvent.scrimmageId);

    // No unlinked team yet -> no bulk button.
    assert.ok(!(await page.isVisible('#btn-scrimmage-bulk-link')), 'no bulk button on an empty roster');

    await addManual(page, 101, 'Alpha');                         // typed name differs -> shown as "Alpha -> Alpha Bots"
    await addManual(page, 202, '');                              // blank -> just the official name
    await addManual(page, 303, 'gamma gears');                   // same (any case) -> just the official name
    await addManual(page, FTCSCOUT_UNKNOWN_NUMBER, 'Mystery');   // FTCScout doesn't know it
    await addManual(page, 4040, 'Seeded Linked');                // linked up front: must not be looked up
    await page.evaluate(async ([tid, sid]) => {
      await db.collection('teams').doc(tid).collection('scrimmages').doc(sid).update({
        'teams.4040.name': 'Already Official', 'teams.4040.linked': true, 'teams.4040.location': 'Somewhere', 'teams.4040.opr': 10
      });
    }, [teamId, bulkId]);
    await page.waitForFunction(() => currentScrimmage.teams['4040'].linked === true);

    // ---------- the button ----------
    assert.equal(await bulkText(page), 'Bulk link teams (4)', 'renamed; counts only the UNLINKED teams');
    assert.ok(await page.isVisible('#scrimmage-bulk-link-help'));
    assert.equal(await page.locator('#scrimmage-bulk-link-result').count(), 0, 'the permanent result line is gone');

    // ---------- badges: unlinked on Info/Pit/Match/Compare, linked on Info only ----------
    const badge = (list, n) => page.locator(`${list} .team-item[data-team-number="${n}"] .team-link-badge`);
    for (const [tab, list] of [['info', '#team-list-info'], ['pit', '#team-list-pit'], ['match', '#team-list-match'], ['compare', '#team-list-compare']]) {
      await openScoutingSubtab(page, tab);
      for (const n of [101, 202, 303, FTCSCOUT_UNKNOWN_NUMBER]) {
        await badge(list, n).waitFor();
        assert.equal((await badge(list, n).textContent()).trim(), 'unlinked', `${tab}: #${n} has the unlinked badge`);
        assert.equal(await badge(list, n).count(), 1, `${tab}: exactly one badge on #${n}`);
      }
      if (tab === 'info') {
        assert.equal((await badge(list, 4040).textContent()).trim(), 'linked', 'info: a linked team shows the linked indicator');
      } else {
        assert.equal(await badge(list, 4040).count(), 0, `${tab}: a linked team has no badge`);
      }
    }
    await openScoutingSubtab(page, 'info');

    // ---------- network failure: a short AUTO-CLEARING error, nothing changes, no popup ----------
    ctx.state.ftcScoutMode = 'abort';
    try {
      await page.click('#btn-scrimmage-bulk-link');
      await page.waitForFunction(() => /Couldn't reach FTCScout/.test(document.getElementById('scrimmage-roster-error').textContent));
      assert.match(await page.textContent('#scrimmage-roster-error'), /nothing was changed/);
      assert.ok(await page.evaluate(() => !!statusMessageTimers['scrimmage-roster-error']), 'the error is on the auto-clear timer (setStatusMessage)');
    } finally {
      ctx.state.ftcScoutMode = 'ok';
    }
    assert.ok(!(await reviewOpen(page)), 'no review popup for a failed lookup');
    assert.ok(!(await confirmOpen(page)));
    let roster = await readRoster(page, teamId, bulkId);
    assert.deepEqual([101, 202, 303, FTCSCOUT_UNKNOWN_NUMBER].map(n => roster[n].linked), [false, false, false, false], 'a failed lookup links nothing');

    // ---------- the lookup itself writes NOTHING; the review popup shows it ----------
    const before = ctx.state.ftcScoutRequests.length;
    await pressBulk(page);
    const sent = ctx.state.ftcScoutRequests.slice(before);
    assert.equal(sent.length, 1, 'ONE batched request, not one per team');
    for (const n of [101, 202, 303, FTCSCOUT_UNKNOWN_NUMBER]) assert.match(sent[0], new RegExp(`t_${n}: teamByNumber`), `#${n} was looked up`);
    assert.doesNotMatch(sent[0], /t_4040/, 'the already-linked team was not looked up');
    assert.match(sent[0], new RegExp(`quickStats\\(season: ${currentSeason}\\)`), "for the scrimmage's season");
    roster = await readRoster(page, teamId, bulkId);
    assert.deepEqual([101, 202, 303, FTCSCOUT_UNKNOWN_NUMBER].map(n => [roster[n].linked, roster[n].name]),
      [[false, 'Alpha'], [false, ''], [false, 'gamma gears'], [false, 'Mystery']], 'the lookup wrote NOTHING — the popup is open and nothing is linked yet');
    assert.ok(!(await confirmOpen(page)), 'no second confirm: the review IS the confirmation');
    assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('bulk-link-modal')).zIndex), '1001');

    // Found group: one checkbox row per found team, ALL checked, with the arrow only when the name changes.
    const found = await page.$$eval('#bulk-link-found .bulk-link-row', rows => rows.map(r => r.dataset.teamNumber));
    assert.deepEqual(found, ['101', '202', '303'], 'exactly the found teams');
    for (const n of [101, 202, 303]) assert.ok(await page.locator(`#bulk-link-found .bulk-link-row[data-team-number="${n}"] input[type=checkbox]`).isChecked(), `#${n} is checked by default`);
    assert.equal(await rowText(page, 101), '#101 Alpha -> Alpha Bots');
    assert.equal(await rowText(page, 202), '#202 Beta Builders', 'blank typed name: official name only, no arrow');
    assert.equal(await rowText(page, 303), '#303 Gamma Gears', 'same name (any case): official name only, no arrow');
    // Not-found group: listed WITHOUT checkboxes, says they stay unlinked.
    assert.ok(await page.isVisible('#bulk-link-notfound-group'));
    assert.deepEqual(await page.$$eval('#bulk-link-notfound .bulk-link-row', rows => rows.map(r => r.dataset.teamNumber)), [String(FTCSCOUT_UNKNOWN_NUMBER)]);
    assert.equal(await page.locator('#bulk-link-notfound input').count(), 0, 'not-found rows have no checkbox');
    assert.match(await page.textContent('#bulk-link-notfound-group'), /These stay unlinked\./);
    assert.match(await page.textContent('#bulk-link-notfound-group'), /Mystery/);
    assert.equal(await page.locator('#bulk-link-modal [data-team-number="4040"]').count(), 0, 'a linked team is not in the popup');

    // The confirm button follows the count; disabled at zero.
    assert.equal(await confirmLabel(page), 'Link 3 teams');
    await page.uncheck('#bulk-link-found .bulk-link-row[data-team-number="202"] input');
    assert.equal(await confirmLabel(page), 'Link 2 teams');
    await page.click('#btn-bulk-link-none');
    assert.equal(await confirmLabel(page), 'Link teams');
    assert.ok(await page.isDisabled('#btn-bulk-link-confirm'), 'disabled when nothing is checked');
    await page.check('#bulk-link-found .bulk-link-row[data-team-number="303"] input');
    assert.equal(await confirmLabel(page), 'Link 1 team', 'singular for one');
    assert.ok(!(await page.isDisabled('#btn-bulk-link-confirm')));
    await page.click('#btn-bulk-link-all');
    assert.equal(await confirmLabel(page), 'Link 3 teams');
    await page.uncheck('#bulk-link-found .bulk-link-row[data-team-number="202"] input');   // Tim does NOT want 202

    // ---------- Cancel / X / click-out: nothing changes, nothing lingers, next open starts fresh ----------
    const dismissals = [
      ['Cancel', () => page.click('#btn-bulk-link-cancel')],
      ['X', () => page.click('#btn-bulk-link-close')],
      ['click-out', () => page.click('#bulk-link-modal-overlay', { position: { x: 4, y: 4 } })]
    ];
    for (const [label, dismiss] of dismissals) {
      await dismiss();
      await page.waitForSelector('#bulk-link-modal', { state: 'hidden' });
      roster = await readRoster(page, teamId, bulkId);
      assert.deepEqual([101, 202, 303, FTCSCOUT_UNKNOWN_NUMBER].map(n => roster[n].linked), [false, false, false, false], `${label}: nothing linked`);
      assert.equal((await page.textContent('#scrimmage-roster-success')).trim() + (await page.textContent('#scrimmage-roster-error')).trim(), '', `${label}: no message left on the page`);
      assert.equal(await bulkText(page), 'Bulk link teams (4)', `${label}: still 4 unlinked`);
      await pressBulk(page);
      assert.equal(await confirmLabel(page), 'Link 3 teams', `${label}: a fresh popup starts with every team checked again`);
      assert.equal(await page.locator('#bulk-link-found input:checked').count(), 3);
      assert.equal(await page.locator('#bulk-link-found .bulk-link-row').count(), 3, `${label}: rows are not duplicated`);
      await page.uncheck('#bulk-link-found .bulk-link-row[data-team-number="202"] input');
    }

    // ---------- confirm: ONLY the checked teams are linked ----------
    assert.equal(await confirmLabel(page), 'Link 2 teams');
    await page.click('#btn-bulk-link-confirm');
    await page.waitForSelector('#bulk-link-modal', { state: 'hidden' });
    await page.waitForFunction(() => currentScrimmage.teams['101'].linked === true && currentScrimmage.teams['303'].linked === true);
    roster = await readRoster(page, teamId, bulkId);
    assert.deepEqual([roster[101].name, roster[101].manualName, roster[101].linked, roster[101].location], ['Alpha Bots', 'Alpha', true, 'Dayton, OH, USA'], 'overwritten; manualName keeps the typed name');
    assert.deepEqual([roster[303].name, roster[303].manualName, roster[303].linked], ['Gamma Gears', 'gamma gears', true]);
    assert.ok(roster[101].linkedAt && roster[303].linkedAt, 'linkedAt set');
    assert.equal(typeof roster[101].opr, 'number');
    assert.deepEqual([roster[202].linked, roster[202].name], [false, ''], 'the UNCHECKED team was not linked');
    assert.deepEqual([roster[FTCSCOUT_UNKNOWN_NUMBER].linked, roster[FTCSCOUT_UNKNOWN_NUMBER].name], [false, 'Mystery'], 'not found: stays unlinked, name untouched');
    assert.deepEqual([roster[4040].name, roster[4040].location], ['Already Official', 'Somewhere'], 'the already-linked team was not touched');
    // A brief auto-clearing message — never a result line that stays.
    await page.waitForFunction(() => /^Linked 2 teams to FTCScout\.$/.test(document.getElementById('scrimmage-roster-success').textContent.trim()));
    assert.ok(await page.evaluate(() => !!statusMessageTimers['scrimmage-roster-success']), 'on the auto-clear timer');
    await page.waitForFunction(() => document.getElementById('scrimmage-roster-success').textContent.trim() === '', null, { timeout: 8000 });
    assert.equal(await bulkText(page), 'Bulk link teams (2)');
    assert.equal((await badge('#team-list-info', 101).textContent()).trim(), 'linked');
    assert.equal((await badge('#team-list-info', 202).textContent()).trim(), 'unlinked', 'the unchecked team is still unlinked');

    // ---------- singular popup, then "none found" -> a notice, no checkbox list ----------
    await pressBulk(page);
    assert.deepEqual(await page.$$eval('#bulk-link-found .bulk-link-row', rows => rows.map(r => r.dataset.teamNumber)), ['202']);
    assert.equal(await confirmLabel(page), 'Link 1 team');
    await page.click('#btn-bulk-link-confirm');
    await page.waitForSelector('#bulk-link-modal', { state: 'hidden' });
    await page.waitForFunction(() => currentScrimmage.teams['202'].linked === true);
    assert.equal((await readRoster(page, teamId, bulkId))[202].name, 'Beta Builders');
    assert.equal(await bulkText(page), 'Bulk link teams (1)');
    await page.click('#btn-scrimmage-bulk-link');
    await page.waitForFunction(() => !document.getElementById('generic-confirm-modal').classList.contains('hidden')
      && /No Teams Found/.test(document.getElementById('generic-confirm-title').textContent));
    assert.ok(!(await reviewOpen(page)), 'no checkbox list when nothing was found');
    assert.match(await page.textContent('#generic-confirm-message'), new RegExp(`#${FTCSCOUT_UNKNOWN_NUMBER}`), 'the notice still lists which numbers failed');
    await page.click('#btn-generic-confirm-proceed');
    await page.waitForSelector('#generic-confirm-modal', { state: 'hidden' });

    // ---------- a plain MEMBER can do it ----------
    await openScrimmageUI(page, 'Silent Scrim');
    await addManual(page, 202, '');
    await addManual(page, 303, 'gamma GEARS');                   // same name, different case
    const silentId = await page.evaluate(() => selectedEvent.scrimmageId);

    const memPage = await ctx.newPage('member');
    await signInUI(memPage, member);
    await joinTeamUI(memPage, joinCode);
    await openScrimmageUI(memPage, 'Silent Scrim');
    await memPage.waitForFunction(() => Object.keys(currentScrimmage.teams).length === 2);
    assert.equal(await memPage.locator('.btn-scrimmage-team-remove').count(), 0, 'sanity: this is a plain member (no Remove)');
    assert.equal(await bulkText(memPage), 'Bulk link teams (2)', 'a member sees the bulk button');
    await pressBulk(memPage);
    assert.equal(await rowText(memPage, 202), '#202 Beta Builders');
    assert.equal(await rowText(memPage, 303), '#303 Gamma Gears');
    assert.ok(!(await memPage.isVisible('#bulk-link-notfound-group')), 'no not-found group when nothing failed');
    await memPage.click('#btn-bulk-link-confirm');
    await memPage.waitForSelector('#bulk-link-modal', { state: 'hidden' });
    await memPage.waitForFunction(() => /Linked 2 teams/.test(document.getElementById('scrimmage-roster-success').textContent));
    assert.ok(!(await confirmOpen(memPage)), 'no second confirm');
    roster = await readRoster(page, teamId, silentId);
    assert.deepEqual([roster[202].name, roster[202].linked, roster[303].name, roster[303].linked], ['Beta Builders', true, 'Gamma Gears', true], 'the member linked them (rules allow it)');
    assert.equal(roster[303].manualName, 'gamma GEARS', 'manualName kept');
    assert.ok(!(await memPage.isVisible('#btn-scrimmage-bulk-link')), 'the bulk button disappears at zero unlinked teams');

    // ---------- an official event has no link UI ----------
    await selectFixtureEvent(page);
    assert.ok(!(await page.isVisible('#btn-scrimmage-bulk-link')), 'no bulk button on an official event');
    for (const [tab, list] of [['info', '#team-list-info'], ['pit', '#team-list-pit'], ['match', '#team-list-match'], ['compare', '#team-list-compare']]) {
      await openScoutingSubtab(page, tab);
      await page.locator(`${list} .team-item`).first().waitFor();
      assert.equal(await page.locator(`${list} .team-link-badge`).count(), 0, `${tab}: official-event teams never get a link badge`);
    }
  }
};
