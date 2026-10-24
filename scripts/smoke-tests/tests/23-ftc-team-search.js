// FTCScout partial team search in the lookup popup, on the LOCAL cached team list
// (js/ftc-team-list.js + js/ftc-team-lookup.js). FTCScout's own search is prefix-only and
// ignores `limit`, so the app keeps its own copy of the whole list (number, name, location):
//   - fetched LAZILY (the first search that needs it; "Loading team list..." meanwhile), stored
//     in IndexedDB with a fetched-at time, NOT refetched after a reload, refreshed when older
//     than 24 h (checked with a faked clock), a stale copy still used when the refresh fails,
//     and with no copy at all the popup falls back to the exact-number lookup with a note
//   - ranking: the exact number first, then numbers that START WITH the digits, then numbers
//     that merely CONTAIN them, lower numbers first, at most 5 (36 -> 36, 365, 3650, 36012,
//     36533 and NOT 36999 / 1365 / 7360; 365 -> 365, 3650, 36533, then 1365 which only contains it;
//     865 -> 865, 8651, 21865)
//   - the results list: #number, name, location, OPR for the scrimmage's season from ONE batched
//     request; tapping a row selects it, puts ITS number in the popup's box and in the Add/Edit
//     modal behind; a team already on the roster is greyed "already on this scrimmage" and can't
//     be selected; one match is auto-selected as a single card; a failed OPR request only leaves
//     OPR blank (picking still works; the link then fetches the details itself)
//   - a LOCKED number (Team Details) shows exactly that team, not a list

const assert = require('node:assert/strict');
const { ftcScoutOpr } = require('../lib/harness');
const {
  signInUI, createTeamUI, createScrimmageUI, openScrimmageUI, openScoutingSubtab
} = require('../lib/app');

module.exports = {
  name: 'FTCScout team search: cached team list (lazy, IndexedDB, 24 h refresh, stale fallback, exact-lookup fallback), ranking + top 5, results list, roster teams greyed, pick mirrors the number, OPR batch',
  async run(ctx) {
    const listAtStart = ctx.state.ftcScoutListRequests;   // (the request log is shared with the other tests)
    const user = await ctx.makeUser('Search Scout');
    const page = await ctx.newPage('search');
    await signInUI(page, user);
    await createTeamUI(page, 'Search Smoke Team');
    const teamId = await page.evaluate(() => currentTeamData.id);
    await createScrimmageUI(page, { name: 'Search Scrim' });
    await openScrimmageUI(page, 'Search Scrim');
    const sid = await page.evaluate(() => selectedEvent.scrimmageId);
    const season = await page.evaluate(() => String(selectedEvent.season));
    const unlinked = (n, name) => ({ number: n, name, manualName: name, linked: false, location: '', opr: null, linkedAt: null });
    const addRoster = (entries) => page.evaluate(async ([tid, id, list]) => {
      const update = {};
      list.forEach(e => { update[`teams.${e.number}`] = e; });
      await db.collection('teams').doc(tid).collection('scrimmages').doc(id).update(update);
    }, [teamId, sid, entries]);
    const team = (n) => page.evaluate(async ([tid, id, num]) => ((await db.collection('teams').doc(tid).collection('scrimmages').doc(id).get()).data().teams || {})[String(num)] || null, [teamId, sid, n]);
    // The teamDetails cache is shared by every test in the run: mark the teams this test looks at stale, so
    // 'one batched request' / 'OPR blank offline' don't depend on which test ran before.
    await page.evaluate(async (numbers) => {
      for (const n of numbers) await db.collection('teamDetails').doc(String(n)).update({ cachedAt: firebase.firestore.Timestamp.fromMillis(0) }).catch(() => {});
    }, [36, 365, 1365, 3650, 7360, 36012, 36533, 36999, 865, 8651, 21865]);
    await addRoster([unlinked(365, 'Roster Three Sixty Five'), unlinked(9100, 'Mirror Me')]);
    await page.waitForFunction(() => currentScrimmage.teams['365'] && currentScrimmage.teams['9100']);
    await openScoutingSubtab(page, 'info');

    const rows = () => page.locator('#ftc-lookup-results .ftc-result-row').evaluateAll(els => els.map(e => ({
      n: Number(e.dataset.number), roster: e.classList.contains('is-roster'), selected: e.getAttribute('aria-selected') === 'true', disabled: e.disabled, text: e.textContent.replace(/\s+/g, ' ').trim()
    })));
    const numbers = async () => (await rows()).map(r => r.n);
    const status = async () => (await page.textContent('#ftc-lookup-status')).trim();
    const openAdd = async (typed) => {
      await page.click('#btn-scrimmage-add-team');
      await page.waitForSelector('#scrimmage-team-modal:not(.hidden)');
      if (typed != null) await page.fill('#input-scrimmage-team-number', String(typed));
      await page.click('#btn-scrimmage-team-lookup');
      await page.waitForSelector('#ftc-lookup-modal:not(.hidden)');
    };
    const closeBoth = async () => {
      await page.click('#btn-ftc-lookup-cancel');
      await page.waitForSelector('#ftc-lookup-modal', { state: 'hidden' });
      await page.click('#btn-scrimmage-team-cancel');
      await page.waitForSelector('#scrimmage-team-modal', { state: 'hidden' });
    };
    const typeAndSearch = async (text) => {
      await page.fill('#input-ftc-lookup-number', String(text));
      await page.click('#btn-ftc-lookup-go');
    };

    // ======== lazy load + "Loading team list..." + ranking + top 5 ========
    const list0 = ctx.state.ftcScoutListRequests;
    assert.equal(list0, listAtStart, 'signing in, opening a team and a scrimmage did NOT fetch the team list — it loads when a search first needs it');
    ctx.state.ftcScoutListDelay = 900;
    const r0 = ctx.state.ftcScoutRequests.length;
    try {
      await openAdd(36);
      await page.waitForFunction(() => /Loading team list/.test(document.getElementById('ftc-lookup-status').textContent));
      assert.equal(await status(), 'Loading team list...', 'the popup says so while the list loads');
      await page.waitForSelector('#ftc-lookup-results .ftc-result-row');       // the typed 36 is searched as soon as the list is ready
    } finally {
      ctx.state.ftcScoutListDelay = 0;
    }
    assert.equal(await status(), '', 'the loading line is gone');
    assert.equal(ctx.state.ftcScoutListRequests, list0 + 1, 'ONE list request');
    assert.deepEqual(await numbers(), [36, 365, 3650, 36012, 36533], '"36": exact first, then numbers that start with 36 (lowest first) — at most 5');
    let list = await rows();
    assert.ok(!(await numbers()).some(n => [36999, 1365, 7360].includes(n)), 'the 6th+ matches (36999, and the contains-only 1365/7360) are cut off');
    assert.deepEqual(list.map(r => r.roster), [false, true, false, false, false], 'only #365 (on the roster) is greyed');
    assert.match(list[1].text, /already on this scrimmage/);
    assert.ok(list[1].disabled, 'a roster row cannot be selected');
    assert.deepEqual(list.map(r => r.selected), [false, false, false, false, false], 'several results: nothing is auto-selected');
    assert.ok(!(await page.isVisible('#btn-ftc-lookup-confirm')), 'so nothing to confirm yet');
    assert.ok(!(await page.isVisible('#ftc-lookup-result')), 'and no single card');
    assert.match(list[0].text, /#36\s*Thirty Six Robotics\s*Austin, TX, USA/, 'each row: #number, name, location');
    assert.match(list[3].text, /An Extremely Long Official Team Name/, 'long names are kept');

    // OPR: ONE batched request for the shown rows (not the roster one), for the scrimmage's season
    await page.waitForFunction(() => /OPR:/.test(document.querySelector('#ftc-lookup-results .ftc-result-row[data-number="36533"]').textContent));
    const batches = ctx.state.ftcScoutRequests.slice(r0).filter(q => /t_\d+\s*:\s*teamByNumber/.test(q));
    assert.equal(batches.length, 1, 'exactly one batched request for the results');
    for (const n of [36, 3650, 36012, 36533]) assert.match(batches[0], new RegExp(`t_${n}\\s*:`), `batch has #${n}`);
    assert.doesNotMatch(batches[0], /t_365\s*:/, 'the roster team is not looked up');
    assert.match(batches[0], new RegExp(`quickStats\\(season: ${season}\\)`), "the scrimmage's season");
    list = await rows();
    assert.match(list[4].text, new RegExp(`OPR: ${ftcScoutOpr(36533, season).toFixed(1).replace('.', '\\.')}`), 'OPR shown on the row');

    // tapping the greyed row does nothing; tapping a real row selects it and mirrors ITS number
    await page.locator('#ftc-lookup-results .ftc-result-row.is-roster').click({ force: true }).catch(() => {});
    assert.ok(!(await page.isVisible('#btn-ftc-lookup-confirm')), 'a greyed row cannot be selected');
    await page.click('#ftc-lookup-results .ftc-result-row[data-number="36533"]');
    list = await rows();
    assert.deepEqual(list.map(r => r.selected), [false, false, false, false, true], 'the tapped row is highlighted');
    assert.equal(await page.inputValue('#input-ftc-lookup-number'), '36533', "the popup's number box now has the PICKED number (the user only typed 36)");
    assert.equal(await page.inputValue('#input-scrimmage-team-number'), '36533', 'mirrored into the Add modal behind');
    assert.equal((await page.textContent('#btn-ftc-lookup-confirm')).trim(), 'Add Linked Team');
    await page.click('#ftc-lookup-results .ftc-result-row[data-number="3650"]');
    assert.equal(await page.inputValue('#input-scrimmage-team-number'), '3650', 'picking another row moves the selection and the mirror');
    await page.click('#ftc-lookup-results .ftc-result-row[data-number="36533"]');
    // Add uses the PICKED number, linked, with the official data
    await page.click('#btn-ftc-lookup-confirm');
    await page.waitForFunction(() => document.getElementById('ftc-lookup-modal').classList.contains('hidden') && document.getElementById('scrimmage-team-modal').classList.contains('hidden'));
    await page.waitForFunction(() => currentScrimmage.teams['36533']);
    const added = await team(36533);
    assert.deepEqual([added.number, added.name, added.linked, added.location, added.opr], [36533, 'Refuge Robotics', true, 'Salem, OR, USA', ftcScoutOpr(36533, season)], 'the picked team was added LINKED with its official data');
    assert.equal(await team(36), null, 'and nothing was added for the typed "36"');

    // ======== a failed OPR request only leaves OPR blank; picking still works and the link fetches the details ========
    await openAdd(null);
    ctx.state.ftcScoutMode = 'abort';
    try {
      await typeAndSearch(865);
      await page.waitForFunction(() => document.querySelectorAll('#ftc-lookup-results .ftc-result-row').length === 3);
      await page.waitForTimeout(500);
      assert.ok((await rows()).every(r => !/OPR:/.test(r.text)), 'FTCScout unreachable: OPR is blank, the list still works (it is local)');
      await page.click('#ftc-lookup-results .ftc-result-row[data-number="8651"]');
      assert.equal(await page.inputValue('#input-scrimmage-team-number'), '8651');
      assert.ok(await page.isVisible('#btn-ftc-lookup-confirm'), 'picking is not blocked by the missing OPR');
      await page.click('#btn-ftc-lookup-confirm');
      await page.waitForFunction(() => /Couldn't reach FTCScout/.test(document.getElementById('ftc-lookup-error').textContent));
      assert.equal(await team(8651), null, 'nothing was linked without the details');
    } finally {
      ctx.state.ftcScoutMode = 'ok';
    }
    await page.click('#btn-ftc-lookup-confirm');                       // back online: the same pick links, with its real OPR
    await page.waitForFunction(() => document.getElementById('scrimmage-team-modal').classList.contains('hidden'));
    await page.waitForFunction(() => currentScrimmage.teams['8651']);
    const t8651 = await team(8651);
    assert.deepEqual([t8651.name, t8651.linked, t8651.opr], ['Eighty Six Fifty One', true, ftcScoutOpr(8651, season)], 'linked with the real OPR once the details could be fetched');

    // ======== contains vs starts-with ========
    await openAdd(null);
    await typeAndSearch(365);
    await page.waitForSelector('#ftc-lookup-results .ftc-result-row');
    assert.deepEqual(await numbers(), [365, 3650, 36533, 1365], '"365": the exact number, then the numbers that start with it, then 1365 which only CONTAINS it');
    assert.deepEqual((await rows()).map(r => r.roster), [true, false, true, false], '#365 and #36533 are on the roster now: greyed');
    await typeAndSearch(865);
    await page.waitForFunction(() => document.querySelectorAll('#ftc-lookup-results .ftc-result-row').length === 3);
    assert.deepEqual(await numbers(), [865, 8651, 21865], '"865": 865 first, then 8651 (starts with), then 21865 (contains)');
    assert.deepEqual((await rows()).map(r => r.roster), [false, true, false], '#8651 was linked just above: greyed');
    await typeAndSearch(186);                                         // contained only in 21865 -> ONE match
    await page.waitForSelector('#ftc-lookup-result:not(.hidden)');
    assert.equal((await page.textContent('#ftc-lookup-result-name')).trim(), 'Fe2O3 Mock', 'a single match is auto-selected as one card');
    assert.equal(await page.locator('#ftc-lookup-results .ftc-result-row').count(), 0, '(no list for one match)');
    assert.ok(await page.isVisible('#btn-ftc-lookup-confirm'));
    await typeAndSearch(77777);
    await page.waitForFunction(() => /No FTCScout team matches 77777\./.test(document.getElementById('ftc-lookup-status').textContent));
    assert.equal(await status(), 'No FTCScout team matches 77777.');
    await closeBoth();

    // ======== Edit: picking a partial match mirrors the number into the Edit modal (kept on cancel) ========
    await (await page.locator('#team-list-info .team-item[data-team-number="9100"]')).locator('.btn-scrimmage-team-edit').click();
    await page.waitForSelector('#scrimmage-team-modal:not(.hidden)');
    await page.waitForFunction(() => !document.getElementById('input-scrimmage-team-number').disabled);
    await page.click('#btn-scrimmage-team-lookup');
    await page.waitForSelector('#ftc-lookup-modal:not(.hidden)');
    assert.ok(!(await page.isDisabled('#input-ftc-lookup-number')), 'renumbering allowed: the popup number is editable');
    await typeAndSearch(36);
    await page.waitForFunction(() => document.querySelectorAll('#ftc-lookup-results .ftc-result-row').length === 5);
    assert.deepEqual((await rows()).map(r => r.roster), [false, true, false, false, true], '#365 and #36533 greyed (on the roster)');
    await page.click('#ftc-lookup-results .ftc-result-row[data-number="3650"]');
    assert.equal(await page.inputValue('#input-scrimmage-team-number'), '3650', 'Edit modal: mirrored');
    assert.equal((await page.textContent('#btn-ftc-lookup-confirm')).trim(), 'Use This Team');
    await page.click('#btn-ftc-lookup-cancel');
    await page.waitForSelector('#ftc-lookup-modal', { state: 'hidden' });
    assert.equal(await page.inputValue('#input-scrimmage-team-number'), '3650', 'a cancelled popup keeps the picked number in the Edit modal');
    // pick + use it: the official name locks in (state B) and Save renumbers AND links
    await page.click('#btn-scrimmage-team-lookup');
    await page.waitForSelector('#ftc-lookup-modal:not(.hidden)');
    await page.waitForSelector('#ftc-lookup-result:not(.hidden)');       // 3650 alone -> a single card, auto-selected
    await page.click('#btn-ftc-lookup-confirm');
    await page.waitForSelector('#ftc-lookup-modal', { state: 'hidden' });
    assert.equal(await page.inputValue('#input-scrimmage-team-name'), 'Thirty Six Fifty');
    await page.click('#btn-scrimmage-team-save');
    await page.waitForSelector('#scrimmage-team-modal', { state: 'hidden' });
    await page.waitForFunction(() => currentScrimmage.teams['3650'] && !currentScrimmage.teams['9100']);
    assert.equal((await team(3650)).linked, true, 'Save re-keyed 9100 -> 3650 and linked it');

    // ======== a LOCKED number (Team Details) shows exactly that team, not a list ========
    await (await page.locator('#team-list-info .team-item[data-team-number="365"]')).getByRole('button', { name: 'View Detail' }).click();
    await page.waitForSelector('#team-detail-modal:not(.hidden) #td-modal-body:not(.hidden)');
    await page.getByRole('button', { name: 'Link to FTCScout' }).click();
    await page.waitForSelector('#ftc-lookup-modal:not(.hidden)');
    await page.waitForSelector('#ftc-lookup-result:not(.hidden)');
    assert.ok(await page.isDisabled('#input-ftc-lookup-number'), 'the number is fixed');
    assert.equal((await page.textContent('#ftc-lookup-result-name')).trim(), 'Three Sixty Five', 'exactly #365');
    assert.equal(await page.locator('#ftc-lookup-results .ftc-result-row').count(), 0, 'no list even though "365" also matches 3650, 36533 and 1365');
    await page.click('#btn-ftc-lookup-cancel');
    await page.waitForSelector('#ftc-lookup-modal', { state: 'hidden' });
    await page.click('#btn-team-detail-close');

    // ======== the list is kept ON THE DEVICE: a reload does not refetch it ========
    await page.reload();
    await page.waitForSelector('#screen-main.active');
    // (a refresh restores the open scrimmage — clicking its row again would DESELECT it)
    await page.waitForFunction(() => selectedEvent && selectedEvent.isScrimmage && currentScrimmage && currentScrimmage.teams['365']);
    await page.click('#dashboard-tabs .tab[data-dtab="scouting"]');
    await openScoutingSubtab(page, 'info');
    const afterReload = ctx.state.ftcScoutListRequests;
    await openAdd(36);
    await page.waitForSelector('#ftc-lookup-results .ftc-result-row');
    assert.deepEqual(await numbers(), [36, 365, 3650, 36012, 36533]);
    assert.equal(ctx.state.ftcScoutListRequests, afterReload, 'after a reload the list came from IndexedDB: no new request');
    await closeBoth();
    const stored = await page.evaluate(() => new Promise((resolve) => {
      const open = indexedDB.open('fe2o3-ftc-team-list', 1);
      open.onsuccess = () => {
        const get = open.result.transaction('lists').objectStore('lists').get('all-teams');
        get.onsuccess = () => resolve({ n: get.result.teams.length, fetchedAt: get.result.fetchedAt, first: get.result.teams[0] });
      };
    }));
    assert.ok(stored.n >= 20 && stored.fetchedAt > 0, 'stored with a fetched-at time');
    assert.deepEqual(stored.first, [36, 'Thirty Six Robotics', 'Austin, TX, USA'], 'only number, name, location are kept, ascending');

    // ======== 24 h staleness (faked clock), and a stale copy still used when the refresh fails ========
    // (the clock is skewed only around the call, so the auth/Firestore SDKs never see it)
    const withClock = (hoursAhead, fn) => page.evaluate(async ([h, src]) => {
      const real = Date.now;
      Date.now = () => real.call(Date) + h * 3600 * 1000;
      try { return await (new Function('return (' + src + ')'))()(); } finally { Date.now = real; }
    }, [hoursAhead, fn.toString()]);
    const before = ctx.state.ftcScoutListRequests;
    const fresh23 = await withClock(23, async () => { const l = await getFtcTeamList(); return { n: l.teams.length, failed: !!l.refreshFailed }; });
    assert.equal(ctx.state.ftcScoutListRequests, before, '23 h old: still fresh, no request');
    const fetchedBefore = await page.evaluate(() => ftcTeamListMemo.fetchedAt);
    const stale25 = await withClock(25, async () => { const l = await getFtcTeamList(); return { n: l.teams.length, failed: !!l.refreshFailed, fetchedAt: l.fetchedAt }; });
    assert.equal(ctx.state.ftcScoutListRequests, before + 1, '25 h old: the list refreshed itself (one request)');
    assert.ok(stale25.fetchedAt > fetchedBefore && !stale25.failed, 'and the stored fetched-at moved forward');
    // 50 h on, with FTCScout failing: the STALE copy is still used
    ctx.state.ftcScoutListMode = 'error';
    try {
      const useStale = await withClock(50, async () => { const l = await getFtcTeamList(); return { n: l.teams.length, failed: !!l.refreshFailed }; });
      assert.equal(ctx.state.ftcScoutListRequests, before + 2, 'it tried to refresh');
      assert.ok(useStale.failed && useStale.n === fresh23.n, 'the refresh failed, so the stale list is used as it is');
      const again = await withClock(50, async () => { const l = await getFtcTeamList(); return { n: l.teams.length }; });
      assert.equal(ctx.state.ftcScoutListRequests, before + 2, 'no retry hammering right after a failure');
      assert.equal(again.n, fresh23.n);
      // ...and the popup keeps searching it
      await withClock(50, async () => { /* leave the failure memo in place */ });
    } finally {
      ctx.state.ftcScoutListMode = 'ok';
    }

    // ======== no list at all and no way to get one: the exact-number lookup, with a note ========
    await page.evaluate(() => clearFtcTeamListCache({ clearStored: true }));
    ctx.state.ftcScoutListMode = 'error';
    try {
      await openAdd(5555);
      await page.waitForSelector('#ftc-lookup-result:not(.hidden)');
      assert.match(await page.textContent('#ftc-lookup-note'), /team list couldn't be loaded, so only an exact team number can be looked up/);
      assert.equal((await page.textContent('#ftc-lookup-result-name')).trim(), 'Five Star Robotics', 'the exact lookup still works');
      await typeAndSearch(36);
      await page.waitForFunction(() => /Thirty Six Robotics/.test(document.getElementById('ftc-lookup-result-name').textContent));   // exactly #36 — not 365, 3650, ...
      assert.equal(await page.locator('#ftc-lookup-results .ftc-result-row').count(), 0, 'no partial results without the list');
      await typeAndSearch(365);                                           // a roster number: the inline error comes back in the fallback
      await page.waitForFunction(() => /already on this scrimmage's roster/.test(document.getElementById('ftc-lookup-error').textContent));
      await closeBoth();
    } finally {
      ctx.state.ftcScoutListMode = 'ok';
    }
  }
};
