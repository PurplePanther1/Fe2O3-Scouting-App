// Pinned Events: the season is recorded when pinning; the tab's season dropdown
// defaults to the APP'S SELECTED season (getSelectedSeason(), the main season
// dropdown), FOLLOWS it whenever the app's season changes, filters the list while
// I stay on the tab, and resets to the app's selected season whenever the tab is
// left; rows toggle select/deselect on a whole-row click; selecting a pin from
// another season switches the app's season first (no error) and the dropdown
// shows it; legacy pins (no season) are handled.
//
// The mocked FIRST worker is season-strict like the real one (an event's teams
// only exist under ITS season), which is what made the original cross-season pin
// click fail — reproduced directly below.

const assert = require('node:assert/strict');
const { FIXTURE_OLD_EVENT, FIXTURE_SEASON, FIXTURE_OLD_SEASON } = require('../lib/harness');
const { signInUI, createTeamUI, selectFixtureEvent, openScoutingSubtab } = require('../lib/app');

const pinRow = (page, text) => page.locator('#pinned-events-list .event-item', { hasText: text });
const pinNames = (page) => page.$$eval('#pinned-events-list .event-item .event-name', els => els.map(e => e.textContent.trim()));
const teamsLoaded = (page, n) => page.waitForFunction((count) =>
  new RegExp(`${count} team\\(s\\) registered`).test(document.getElementById('selected-event-teams-count')?.textContent || ''), n);

module.exports = {
  name: "pinned events: season recorded, dropdown = app's season (default/follow/reset), whole-row toggle, cross-season select, legacy pins",
  async run(ctx) {
    const user = await ctx.makeUser('Pin Scout');
    const page = await ctx.newPage('pinned');
    await signInUI(page, user);
    await createTeamUI(page, 'Pin Smoke Team');

    const currentSeason = await page.evaluate(() => String(getCurrentFtcSeason()));
    assert.equal(currentSeason, FIXTURE_SEASON, "the fixture event sits in the app's default (current) season");
    const oldSeason = FIXTURE_OLD_SEASON;
    const pinned = () => page.evaluate(() => (currentTeamData.pinnedEvents || []).map(p => ({ code: p.code, season: p.season || null })));
    const appSeason = () => page.inputValue('#select-season');
    const pinnedSeason = () => page.inputValue('#select-pinned-season');

    // ---------- pinning records the season ----------
    await selectFixtureEvent(page); // SMOKE1, current season
    await page.click('#btn-pin-event');
    await page.waitForFunction(() => (currentTeamData.pinnedEvents || []).length === 1);
    assert.deepEqual(await pinned(), [{ code: 'SMOKE1', season: currentSeason }], 'pin records its season');
    assert.match(await page.textContent('#btn-pin-event'), /Unpin This Event/);

    // Switch the app to the OLD season the way a user does (the real dropdown), pin an event there.
    await page.selectOption('#select-season', oldSeason);
    await page.fill('#input-event-search', 'Old');
    await page.click('#btn-search-events');
    await page.click(`.event-item[data-code="${FIXTURE_OLD_EVENT.code}"]`);
    await teamsLoaded(page, 3);
    await page.click('#btn-pin-event');
    await page.waitForFunction(() => (currentTeamData.pinnedEvents || []).length === 2);
    assert.deepEqual((await pinned()).find(p => p.code === 'OLD1'), { code: 'OLD1', season: oldSeason });

    // Two LEGACY pins (pinned before seasons were recorded): one whose season the global
    // events/ cache knows (OLD1 was cached when selected above), one nobody knows.
    await page.evaluate(async () => {
      await db.collection('teams').doc(currentTeamData.id).update({
        pinnedEvents: firebase.firestore.FieldValue.arrayUnion({ code: 'OLD1', name: 'Legacy Old' }, { code: 'GHOST9', name: 'Legacy Ghost' })
      });
    });
    await page.waitForFunction(() => (currentTeamData.pinnedEvents || []).length === 4);

    // ---------- DEFAULT: the app's selected season (NOT the real current season) ----------
    assert.equal(await appSeason(), oldSeason, 'precondition: the app is showing the OLD season');
    await openScoutingSubtab(page, 'pinned');
    assert.equal(await pinnedSeason(), oldSeason, "the Pinned dropdown defaults to the app's selected season");
    assert.notEqual(await pinnedSeason(), currentSeason, '...and NOT the real current season');
    assert.equal(await pinnedSeason(), await page.evaluate(() => String(getSelectedSeason())), 'same value getSelectedSeason() returns');
    const mainOptions = await page.$$eval('#select-season option', os => os.map(o => o.value));
    const pinnedOptions = await page.$$eval('#select-pinned-season option', os => os.map(o => o.value));
    assert.deepEqual(pinnedOptions, mainOptions, 'same season choices as the main dropdown');
    assert.equal(await appSeason(), oldSeason, 'opening the tab did not touch the app season');

    // Filter (old season): its recorded pin, the legacy pin resolved through events/OLD1, and the unknown one.
    await page.waitForFunction(() => document.querySelectorAll('#pinned-events-list .event-item').length === 3);
    assert.deepEqual((await pinNames(page)).sort(), ['Legacy Ghost', 'Legacy Old', 'Old Season Event'].sort());
    assert.match(await pinRow(page, 'Legacy Ghost').textContent(), /season unknown/);
    assert.doesNotMatch(await pinRow(page, 'Legacy Old').textContent(), /season unknown/, 'legacy pin resolved to a season');
    assert.match(await page.textContent('#pinned-events-status'), /3 pinned event\(s\) for/);

    // Picking a season HERE only filters; the app's season is untouched.
    await page.selectOption('#select-pinned-season', currentSeason);
    await page.waitForFunction(() => document.querySelectorAll('#pinned-events-list .event-item').length === 2);
    assert.deepEqual((await pinNames(page)).sort(), ['Legacy Ghost', 'Smoke Test Qualifier'].sort());
    assert.equal(await appSeason(), oldSeason, 'filtering did not change the app season');
    // A season with no recorded pins shows only the unknown-season legacy pin.
    await page.selectOption('#select-pinned-season', String(Number(oldSeason) - 3));
    await page.waitForFunction(() => document.querySelectorAll('#pinned-events-list .event-item').length === 1);
    assert.deepEqual(await pinNames(page), ['Legacy Ghost']);
    assert.match(await page.textContent('#pinned-events-status'), /^1 pinned event\(s\) for /);

    // ---------- RESET: leaving the tab puts the dropdown back on the app's season ----------
    await page.selectOption('#select-pinned-season', currentSeason);
    await openScoutingSubtab(page, 'info');                   // leave: another subtab
    await openScoutingSubtab(page, 'pinned');
    assert.equal(await pinnedSeason(), oldSeason, "reset to the app's selected season after switching subtabs");
    await page.selectOption('#select-pinned-season', currentSeason);
    assert.equal(await pinnedSeason(), currentSeason, 'keeps my choice while I stay on the tab');
    await page.click('#dashboard-tabs .tab[data-dtab="myteam"]'); // leave: another dashboard tab
    await page.click('#dashboard-tabs .tab[data-dtab="scouting"]');
    await page.waitForSelector('#subtab-pinned.active');
    assert.equal(await pinnedSeason(), oldSeason, "reset to the app's selected season after switching dashboard tabs");

    // ---------- FOLLOW: when the APP's season changes, the dropdown shows it ----------
    await page.selectOption('#select-season', currentSeason);  // the user changes the main dropdown
    assert.equal(await pinnedSeason(), currentSeason, "the Pinned dropdown followed the app's season (main dropdown)");
    await page.waitForFunction(() => document.querySelectorAll('#pinned-events-list .event-item').length === 2);
    await page.selectOption('#select-pinned-season', oldSeason);   // filter only
    assert.equal(await appSeason(), currentSeason, 'a filter pick does not move the app');
    await page.selectOption('#select-season', oldSeason);      // app moves again: the dropdown follows even over my filter pick
    assert.equal(await pinnedSeason(), oldSeason);
    await page.selectOption('#select-season', currentSeason);
    assert.equal(await pinnedSeason(), currentSeason, 'follows every app season change');

    // ---------- root cause of the original bug, reproduced ----------
    // What a pin click used to do: selectEvent({code, name}) with NO season switch, so the
    // roster was asked for under the app's CURRENT season — which FIRST rejects.
    await page.evaluate(() => { clearSelectedEvent(); });
    await page.evaluate(async () => { await selectEvent({ code: 'OLD1', name: 'Old Season Event' }); });
    assert.match(await page.textContent('#event-error'), /Could not load teams/, 'asking for an old-season event under the current season fails (the original bug)');
    await page.evaluate(() => { clearSelectedEvent(); document.getElementById('event-error').textContent = ''; }); // (the repro's own error)

    // ---------- whole-row select / deselect; cross-season select switches the season, and the dropdown shows it ----------
    assert.equal(await appSeason(), currentSeason, 'precondition: the app is on the current season');
    await openScoutingSubtab(page, 'info');
    await openScoutingSubtab(page, 'pinned');
    assert.equal(await pinnedSeason(), currentSeason);
    await page.selectOption('#select-pinned-season', oldSeason);   // look at the OLD season's pins (filter only)
    const workerBefore = ctx.state.workerRequests.length;
    await pinRow(page, 'Old Season Event').locator('.event-name').click();
    await teamsLoaded(page, 3);
    assert.equal(await appSeason(), oldSeason, "the app's season switched to the pin's season");
    assert.equal(await pinnedSeason(), oldSeason, "...and the Pinned dropdown shows it too (this was the reported bug)");
    assert.equal((await page.textContent('#event-error')).trim(), '', 'no "try again" error');
    assert.equal(await page.evaluate(() => selectedEvent && selectedEvent.code), 'OLD1');
    assert.ok(await pinRow(page, 'Old Season Event').evaluate(el => el.classList.contains('selected')), 'selected row highlighted');
    assert.ok(await page.isVisible('#subtab-pinned.active'), 'stays on the Pinned tab');
    // (The roster may come from the Firestore event cache — it was cached under the pin's season —
    // so what matters is that nothing was ever requested under the WRONG season.)
    assert.deepEqual(ctx.state.workerRequests.slice(workerBefore).filter(p => p.startsWith('/teams?eventCode=OLD1&season=' + currentSeason)), [],
      'the roster was never requested under the wrong (current) season');
    // leaving and returning keeps showing the app's (now the pin's) season
    await openScoutingSubtab(page, 'info');
    await openScoutingSubtab(page, 'pinned');
    assert.equal(await pinnedSeason(), oldSeason, "after leaving and returning, the dropdown still shows the pin's season (it is the app's season now)");
    // click again -> deselect
    await pinRow(page, 'Old Season Event').locator('.event-name').click();
    await page.waitForFunction(() => selectedEvent === null);
    assert.ok(!(await pinRow(page, 'Old Season Event').evaluate(el => el.classList.contains('selected'))));

    // And back the other way, to the current season.
    await page.selectOption('#select-pinned-season', currentSeason);
    await pinRow(page, 'Smoke Test Qualifier').locator('.event-name').click();
    await teamsLoaded(page, 3);
    assert.equal(await appSeason(), currentSeason);
    assert.equal(await pinnedSeason(), currentSeason, "dropdown shows the pin's season");
    assert.equal((await page.textContent('#event-error')).trim(), '');
    assert.equal(await page.evaluate(() => selectedEvent && selectedEvent.code), 'SMOKE1');
    assert.match(await page.textContent('#btn-pin-event'), /Unpin This Event/, 'header Pin button knows SMOKE1 is pinned in this season');
    await openScoutingSubtab(page, 'info');
    await openScoutingSubtab(page, 'pinned');
    assert.equal(await pinnedSeason(), currentSeason);

    // ---------- a legacy pin whose season is resolvable selects like any other ----------
    await page.selectOption('#select-pinned-season', oldSeason);
    await pinRow(page, 'Legacy Old').locator('.event-name').click();
    await teamsLoaded(page, 3);
    assert.equal(await appSeason(), oldSeason);
    assert.equal(await pinnedSeason(), oldSeason);
    assert.equal((await page.textContent('#event-error')).trim(), '');
    assert.equal(await page.evaluate(() => selectedEvent && selectedEvent.code), 'OLD1');
    await pinRow(page, 'Legacy Old').locator('.event-name').click(); // deselect
    await page.waitForFunction(() => selectedEvent === null);

    // ---------- Unpin button: removes the pin and does NOT select the row ----------
    await pinRow(page, 'Legacy Ghost').locator('.btn-unpin').click();
    await page.waitForFunction(() => !(currentTeamData.pinnedEvents || []).some(p => p.code === 'GHOST9'));
    assert.equal(await page.evaluate(() => selectedEvent), null, 'Unpin did not also select the row');
    await pinRow(page, 'Legacy Old').locator('.btn-unpin').click(); // unpin the legacy OLD1 only
    await page.waitForFunction(() => !(currentTeamData.pinnedEvents || []).some(p => p.name === 'Legacy Old'));
    assert.deepEqual((await pinned()).map(p => p.code).sort(), ['OLD1', 'SMOKE1'], 'the season-recorded pins are untouched');

    // Unpinning the current-season SMOKE1 does not unpin OLD1 (same-code pins are per season).
    await page.selectOption('#select-pinned-season', currentSeason);
    await pinRow(page, 'Smoke Test Qualifier').locator('.btn-unpin').click();
    await page.waitForFunction(() => (currentTeamData.pinnedEvents || []).length === 1);
    assert.deepEqual(await pinned(), [{ code: 'OLD1', season: oldSeason }]);
  }
};
