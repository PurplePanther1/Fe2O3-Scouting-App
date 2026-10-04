// Regression for "searching/selecting official events vs selecting scrimmages",
// all while ON the Scrimmages subtab. Root cause was a stale `isOpen` snapshot in
// the scrimmage row's click handler (taken at render, never refreshed when an
// official event was searched/selected or the selection cleared), so a click took
// the silent "deselect" branch. Drives the exact sequences in BOTH directions and
// asserts the search box, the results list and the scrimmage UI after every step.

const assert = require('node:assert/strict');
const { signInUI, createTeamUI, createScrimmageUI, scrimmageRow, openScrimmagesTab, selectFixtureEvent } = require('../lib/app');

const snapshot = (page) => page.evaluate(() => ({
  selected: selectedEvent ? (selectedEvent.isScrimmage ? `scrimmage:${selectedEvent.name}` : `event:${selectedEvent.code}`) : null,
  currentScrimmage: currentScrimmage ? currentScrimmage.name : null,
  loading: selectEventLoadingCode,
  box: document.getElementById('input-event-search').value,
  results: document.querySelectorAll('#event-results .event-item').length,
  banner: [...document.querySelectorAll('[data-scrimmage-banner]')].some(b => !b.classList.contains('hidden')),
  pinVisible: !document.getElementById('btn-pin-event').classList.contains('hidden'),
  toggleVisible: !document.getElementById('match-view-toggle-bar').classList.contains('hidden'),
  rowSelected: document.querySelector('#scrimmage-list .scrimmage-item')?.classList.contains('selected')
}));

module.exports = {
  name: 'search vs scrimmage: search / select official / click scrimmage in any order, repeatedly, from the Scrimmages tab',
  async run(ctx) {
    const user = await ctx.makeUser('Search Scout');
    const page = await ctx.newPage('search');
    await signInUI(page, user);
    await createTeamUI(page, 'Search Smoke Team');
    await createScrimmageUI(page, { name: 'Scrim A' });
    await openScrimmagesTab(page);

    const row = () => scrimmageRow(page, 'Scrim A').locator('.event-name');
    const search = async () => {
      await page.fill('#input-event-search', 'Smoke');
      await page.click('#btn-search-events');
      await page.waitForSelector('#event-results .event-item[data-code="SMOKE1"]');
    };
    const clickScrimmage = async () => {
      const before = await snapshot(page);
      await row().click();
      // Either it opened or it closed — wait for the selection to settle.
      await page.waitForFunction((wasOpen) => (selectedEvent && selectedEvent.isScrimmage) !== wasOpen && !selectEventLoadingCode, before.selected === 'scrimmage:Scrim A');
    };
    const selectOfficial = async () => {
      await page.click('#event-results .event-item[data-code="SMOKE1"]');
      await page.waitForFunction(() => selectedEvent && selectedEvent.code === 'SMOKE1' && /team\(s\) registered/.test(document.getElementById('selected-event-teams-count').textContent) && !selectEventLoadingCode);
    };
    const expectScrimmageOpen = async (label) => {
      const s = await snapshot(page);
      assert.equal(s.selected, 'scrimmage:Scrim A', `${label}: scrimmage selected`);
      assert.equal(s.currentScrimmage, 'Scrim A', `${label}: scrimmage data loaded`);
      assert.equal(s.box, '', `${label}: search box cleared`);
      assert.equal(s.results, 0, `${label}: results list cleared`);
      assert.equal(s.banner, true, `${label}: banner shown`);
      assert.equal(s.pinVisible, false, `${label}: Pin hidden`);
      assert.equal(s.toggleVisible, false, `${label}: Match View toggle hidden`);
      assert.equal(s.rowSelected, true, `${label}: row highlighted`);
      assert.equal(s.loading, null, `${label}: nothing left in flight`);
    };
    const expectOfficialOpen = async (label) => {
      const s = await snapshot(page);
      assert.equal(s.selected, 'event:SMOKE1', `${label}: official event selected`);
      assert.equal(s.currentScrimmage, null, `${label}: scrimmage deselected`);
      assert.equal(s.banner, false, `${label}: banner gone`);
      assert.equal(s.pinVisible, true, `${label}: Pin restored`);
      assert.equal(s.toggleVisible, true, `${label}: Match View toggle restored`);
      assert.equal(s.rowSelected, false, `${label}: row no longer highlighted`);
      assert.equal(s.loading, null, `${label}: nothing left in flight`);
    };
    const expectNothing = async (label) => {
      const s = await snapshot(page);
      assert.equal(s.selected, null, `${label}: nothing selected`);
      assert.equal(s.banner, false, `${label}: no banner`);
      assert.equal(s.rowSelected, false, `${label}: row not highlighted`);
    };

    // ----- Direction 1: search -> scrimmage -> search -> official -> scrimmage -> ... -----
    await search();
    let s = await snapshot(page);
    assert.equal(s.results, 1, 'search shows results');
    assert.equal(s.box, 'Smoke');

    await clickScrimmage();                                   // (repro 1) click after searching — used to do nothing
    await expectScrimmageOpen('search -> click scrimmage');

    await search();                                           // searching deselects the scrimmage
    await expectNothing('scrimmage open -> search');
    assert.equal((await snapshot(page)).results, 1);
    await clickScrimmage();                                   // (repro 1 again, with a scrimmage open before the search)
    await expectScrimmageOpen('scrimmage -> search -> click scrimmage');

    await search();
    await selectOfficial();                                   // official event while on the Scrimmages tab
    await expectOfficialOpen('search -> select official');
    s = await snapshot(page);
    assert.equal(s.box, 'Smoke', 'an official selection keeps its search text');
    assert.equal(s.results, 1, 'and its results');

    await clickScrimmage();                                   // (repro 2) click after selecting an official event
    await expectScrimmageOpen('official selected -> click scrimmage');

    // ----- Direction 2: scrimmage open -> search -> official -> scrimmage, repeatedly -----
    for (let round = 1; round <= 3; round++) {
      await search();
      await selectOfficial();
      await expectOfficialOpen(`round ${round}: search + select official`);
      await clickScrimmage();
      await expectScrimmageOpen(`round ${round}: click scrimmage`);
      await clickScrimmage();                                 // click again deselects
      await expectNothing(`round ${round}: click scrimmage again`);
    }

    // official selected -> click scrimmage -> click scrimmage (deselect) -> official still gone
    await search();
    await selectOfficial();
    await clickScrimmage();
    await expectScrimmageOpen('official -> scrimmage');
    await clickScrimmage();
    await expectNothing('scrimmage deselected');
    s = await snapshot(page);
    assert.equal(s.results, 0, 'deselecting the scrimmage leaves the (already cleared) results alone');

    // ----- the cleared search persists through a refresh -----
    await clickScrimmage();
    await expectScrimmageOpen('re-open before refresh');
    await page.reload();
    await page.waitForSelector('#screen-main.active');
    await page.waitForFunction(() => selectedEvent && selectedEvent.isScrimmage && currentScrimmage);
    s = await snapshot(page);
    assert.equal(s.selected, 'scrimmage:Scrim A', 'refresh restores the scrimmage');
    assert.equal(s.box, '', 'the cleared search box persisted through the refresh');
    assert.equal(s.results, 0);
    assert.equal(s.banner, true);

    // ----- ...and an official event selected the same way still works after all that -----
    await openScrimmagesTab(page);
    await search();
    await selectOfficial();
    await expectOfficialOpen('after refresh: search + select official');
  }
};
