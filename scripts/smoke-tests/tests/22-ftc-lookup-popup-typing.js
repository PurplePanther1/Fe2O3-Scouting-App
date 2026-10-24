// The FTCScout lookup popup's typing behaviour (js/ftc-team-lookup.js), applied everywhere
// the popup opens (Add, Edit, Team Details):
//   - a number already in the box is searched AUTOMATICALLY when the popup opens (no button
//     press); a blank box does nothing — and does not even load the team list — until typed into
//   - search-as-you-type with a 500 ms DEBOUNCE: nothing is searched while the user is still
//     typing; exactly one search runs 500 ms after the LAST keystroke; typing again restarts
//     the wait
//   - the Look up button searches IMMEDIATELY and cancels any pending wait (no second search)
//   - a late answer for an older query never overwrites a newer one; closing cancels the
//     pending wait; every open and close starts from a clean popup
//   - a roster team's number is GREYED in the results ("already on this scrimmage"), not an error
// The searches are counted by wrapping searchFtcTeamList() in the page (the search itself is
// local — it runs on the cached team list, no request per keystroke). The partial-match ranking,
// results list and the list's caching are in test 23.

const assert = require('node:assert/strict');
const {
  signInUI, createTeamUI, createScrimmageUI, openScrimmageUI, openScoutingSubtab
} = require('../lib/app');

module.exports = {
  name: 'FTCScout lookup popup typing: auto search on open, 500 ms debounce (one search after the last keystroke), Look up searches at once and cancels the wait, stale + close handling, roster teams greyed',
  async run(ctx) {
    const user = await ctx.makeUser('Typing Scout');
    const page = await ctx.newPage('typing');
    await signInUI(page, user);
    await createTeamUI(page, 'Typing Smoke Team');
    await createScrimmageUI(page, { name: 'Typing Scrim' });
    await openScrimmageUI(page, 'Typing Scrim');
    await openScoutingSubtab(page, 'info');
    await page.evaluate(async () => {
      await db.collection('teams').doc(currentTeamData.id).collection('scrimmages').doc(selectedEvent.scrimmageId).update({
        'teams.4040': { number: 4040, name: 'Already Here', manualName: 'Already Here', linked: false, location: '', opr: null, linkedAt: null }
      });
    });
    await page.waitForFunction(() => currentScrimmage.teams['4040']);
    // count every search (the typed text), with the time it ran
    await page.evaluate(() => {
      window.__searches = [];
      const real = window.searchFtcTeamList;
      window.searchFtcTeamList = (teams, text, limit) => { window.__searches.push(String(text)); return real(teams, text, limit); };
    });

    const base = ctx.state.ftcScoutRequests.length;   // other tests share the request log: only count THIS test's
    const listRequests0 = ctx.state.ftcScoutListRequests;
    const searches = () => page.evaluate(() => window.__searches.slice());
    const status = async () => (await page.textContent('#ftc-lookup-status')).trim();
    const openPopupFromAdd = async (typed) => {
      await page.click('#btn-scrimmage-add-team');
      await page.waitForSelector('#scrimmage-team-modal:not(.hidden)');
      if (typed != null) await page.fill('#input-scrimmage-team-number', String(typed));
      await page.click('#btn-scrimmage-team-lookup');
      await page.waitForSelector('#ftc-lookup-modal:not(.hidden)');
    };
    const closePopup = async () => {
      await page.click('#btn-ftc-lookup-cancel');
      await page.waitForSelector('#ftc-lookup-modal', { state: 'hidden' });
      await page.click('#btn-scrimmage-team-cancel');
      await page.waitForSelector('#scrimmage-team-modal', { state: 'hidden' });
    };

    // ---------- a blank box does nothing — not even loading the team list ----------
    await openPopupFromAdd(null);
    await page.waitForTimeout(900);
    assert.deepEqual(await searches(), [], 'blank box: no search on open, none after waiting');
    assert.equal(ctx.state.ftcScoutListRequests, listRequests0, 'the team list is loaded LAZILY: not until a search needs it');
    assert.equal(await status(), '', 'and nothing is shown');

    // ---------- debounce: nothing while typing, ONE search 500 ms after the last keystroke ----------
    await page.evaluate(() => {   // timestamps: the last keystroke, and the moment the search ran
      window.__t = { last: 0, start: 0 };
      document.getElementById('input-ftc-lookup-number').addEventListener('input', () => { window.__t.last = performance.now(); });
      const real = window.searchFtcTeamList;
      window.searchFtcTeamList = (teams, text, limit) => { if (!window.__t.start) window.__t.start = performance.now(); return real(teams, text, limit); };
    });
    await page.locator('#input-ftc-lookup-number').pressSequentially('7771', { delay: 120 });
    await page.waitForTimeout(200);
    assert.deepEqual(await searches(), [], 'still within 500 ms of the last keystroke: nothing has been searched (not 7, 77, 777 either)');
    await page.waitForFunction(() => window.__t.start > 0);
    const waited = await page.evaluate(() => window.__t.start - window.__t.last);
    assert.ok(waited >= 480 && waited < 900, `the search ran ~500 ms after the LAST keystroke (waited ${Math.round(waited)} ms)`);
    await page.waitForFunction(() => /No FTCScout team matches 7771/.test(document.getElementById('ftc-lookup-status').textContent));
    assert.deepEqual(await searches(), ['7771'], 'exactly ONE search, for the whole typed number');
    assert.equal(ctx.state.ftcScoutRequests.slice(base).filter(q => /teamByNumber/.test(q)).length, 0, 'and no per-number request at all');
    assert.equal(ctx.state.ftcScoutListRequests, listRequests0 + 1, 'the list was fetched once, when the first search needed it');

    // ---------- typing again restarts the wait ----------
    await page.evaluate(() => { window.__searches.length = 0; });
    await page.locator('#input-ftc-lookup-number').fill('');
    await page.locator('#input-ftc-lookup-number').pressSequentially('7772', { delay: 60 });
    await page.waitForTimeout(350);                                   // 350 ms: the wait (500) has not elapsed
    await page.locator('#input-ftc-lookup-number').press('Backspace');
    await page.locator('#input-ftc-lookup-number').pressSequentially('3', { delay: 60 }); // now 7773, typed 350 ms after the last key
    await page.waitForTimeout(350);
    assert.deepEqual(await searches(), [], 'each keystroke restarted the 500 ms wait: still nothing searched after 350 ms');
    await page.waitForFunction(() => /No FTCScout team matches 7773/.test(document.getElementById('ftc-lookup-status').textContent));
    assert.deepEqual(await searches(), ['7773'], 'one search; the number typed and then changed within the wait was never searched');

    // ---------- the Look up button searches IMMEDIATELY and cancels the pending wait ----------
    await page.evaluate(() => { window.__searches.length = 0; });
    await page.locator('#input-ftc-lookup-number').fill('7774');         // starts the 500 ms wait
    await page.click('#btn-ftc-lookup-go');                              // ...but the button doesn't wait
    await page.waitForFunction(() => /No FTCScout team matches 7774/.test(document.getElementById('ftc-lookup-status').textContent), null, { timeout: 450 });
    assert.deepEqual(await searches(), ['7774'], 'the button searched at once');
    await page.waitForTimeout(800);                                      // the cancelled wait must not fire a second time
    assert.deepEqual(await searches(), ['7774'], 'and the pending wait was cancelled: no second search');

    // ---------- a late answer for an older query never overwrites a newer one ----------
    ctx.state.ftcScoutDelays = { 5555: 1500 };
    try {
      await page.locator('#input-ftc-lookup-number').fill('5555');       // one match -> its details are fetched (slowly)
      await page.click('#btn-ftc-lookup-go');
      await page.waitForFunction(() => /Looking up team #5555/.test(document.getElementById('ftc-lookup-status').textContent));
      await page.locator('#input-ftc-lookup-number').fill('7776');
      await page.click('#btn-ftc-lookup-go');
      await page.waitForFunction(() => /No FTCScout team matches 7776/.test(document.getElementById('ftc-lookup-status').textContent));
      await page.waitForTimeout(1800);                                   // the slow 5555 answer lands now
      assert.equal(await status(), 'No FTCScout team matches 7776.', 'the late #5555 answer was ignored');
      assert.ok(!(await page.isVisible('#ftc-lookup-result')), 'and its card never appeared');
    } finally {
      ctx.state.ftcScoutDelays = {};
    }

    // ---------- clearing the box drops the result and searches for nothing ----------
    await page.evaluate(() => { window.__searches.length = 0; });
    await page.locator('#input-ftc-lookup-number').fill('');
    await page.waitForTimeout(900);
    assert.deepEqual(await searches(), [], 'an emptied box searches nothing');
    assert.equal(await status(), '');

    // ---------- closing cancels a pending wait; the next open is clean ----------
    await page.locator('#input-ftc-lookup-number').fill('7777');         // wait started
    await page.click('#btn-ftc-lookup-cancel');                          // closed before it fires
    await page.waitForSelector('#ftc-lookup-modal', { state: 'hidden' });
    await page.waitForTimeout(900);
    assert.deepEqual(await searches(), [], 'closed before the wait ended: nothing was searched');
    await page.click('#btn-scrimmage-team-cancel');
    await page.waitForSelector('#scrimmage-team-modal', { state: 'hidden' });
    await openPopupFromAdd(null);
    assert.equal(await page.inputValue('#input-ftc-lookup-number'), '', 'reopened: the number box is clean');
    assert.equal(await status(), '');
    await page.waitForTimeout(700);
    assert.deepEqual(await searches(), [], 'reopened: the old pending wait did not leak into the new open');
    await closePopup();

    // ---------- auto search on OPEN with a number already typed (Add) ----------
    await openPopupFromAdd(7781);
    await page.waitForFunction(() => /No FTCScout team matches 7781/.test(document.getElementById('ftc-lookup-status').textContent), null, { timeout: 4000 });
    assert.deepEqual(await searches(), ['7781'], 'searched by itself on open: one search, no button press');
    await closePopup();
    // a number FTCScout knows: the card and its confirm button appear on their own
    await openPopupFromAdd(303);
    await page.waitForSelector('#ftc-lookup-result:not(.hidden)');
    assert.equal((await page.textContent('#ftc-lookup-result-name')).trim(), 'Gamma Gears');
    assert.ok(await page.isVisible('#btn-ftc-lookup-confirm'), 'confirm is offered without pressing Look up');
    await closePopup();
    // a roster team: it IS an FTCScout team, so its row shows — greyed, not selectable, nothing looked up
    const r0 = ctx.state.ftcScoutRequests.length;
    await openPopupFromAdd(4040);
    await page.waitForSelector('#ftc-lookup-results .ftc-result-row.is-roster');
    assert.match(await page.textContent('#ftc-lookup-results .ftc-result-row.is-roster'), /Quad Forty[\s\S]*already on this scrimmage/);
    await page.waitForTimeout(600);
    assert.equal(ctx.state.ftcScoutRequests.length, r0, 'a roster team is never looked up');
    await closePopup();

    // ---------- auto search on open in EDIT (locked number) and from Team Details ----------
    await page.evaluate(async () => {
      await db.collection('teams').doc(currentTeamData.id).collection('scrimmages').doc(selectedEvent.scrimmageId).update({
        'teams.303': { number: 303, name: 'Typed Three', manualName: 'Typed Three', linked: false, location: '', opr: null, linkedAt: null }
      });
    });
    await page.waitForFunction(() => currentScrimmage.teams['303']);
    await (await page.locator('#team-list-info .team-item[data-team-number="303"]')).locator('.btn-scrimmage-team-edit').click();
    await page.waitForSelector('#scrimmage-team-modal:not(.hidden)');
    await page.click('#btn-scrimmage-team-lookup');
    await page.waitForSelector('#ftc-lookup-modal:not(.hidden)');
    await page.waitForSelector('#ftc-lookup-result:not(.hidden)');
    assert.equal((await page.textContent('#ftc-lookup-result-name')).trim(), 'Gamma Gears', 'Edit: the popup looked its number up by itself');
    await page.click('#btn-ftc-lookup-cancel');
    await page.waitForSelector('#ftc-lookup-modal', { state: 'hidden' });
    await page.click('#btn-scrimmage-team-cancel');
    await page.waitForSelector('#scrimmage-team-modal', { state: 'hidden' });
    await (await page.locator('#team-list-info .team-item[data-team-number="303"]')).getByRole('button', { name: 'View Detail' }).click();
    await page.waitForSelector('#team-detail-modal:not(.hidden) #td-modal-body:not(.hidden)');
    await page.getByRole('button', { name: 'Link to FTCScout' }).click();
    await page.waitForSelector('#ftc-lookup-modal:not(.hidden)');
    await page.waitForSelector('#ftc-lookup-result:not(.hidden)');
    assert.ok(await page.isDisabled('#input-ftc-lookup-number'), 'Team Details: the number is fixed');
    assert.equal((await page.textContent('#ftc-lookup-result-name')).trim(), 'Gamma Gears', 'Team Details: looked up on open');
    await page.click('#btn-ftc-lookup-cancel');
    await page.waitForSelector('#ftc-lookup-modal', { state: 'hidden' });
    await page.click('#btn-team-detail-close');
  }
};
