// "Leaving a view clears its transient entry state" (app.js clearTransientIn(),
// driven by data-clear-on-leave in index.html) — and the guard against
// over-clearing: search/filter/sort boxes and the season dropdown are NOT tagged
// and must keep their values across subtab switches (they're listed for the
// owner's review rather than guessed at).

const assert = require('node:assert/strict');
const { signInUI, createTeamUI, selectFixtureEvent, openScoutingSubtab } = require('../lib/app');

const textOf = (page, id) => page.evaluate((i) => document.getElementById(i).textContent.trim(), id);

module.exports = {
  name: 'transient inputs: tagged boxes/status lines clear on leaving their view; filters, sorts and season do not',
  async run(ctx) {
    const user = await ctx.makeUser('Transient Scout');
    const page = await ctx.newPage('transient');
    await signInUI(page, user);
    await createTeamUI(page, 'Transient Smoke Team');
    await selectFixtureEvent(page);

    // ---------- every tagged element lives inside a view that actually gets "left" ----------
    const tagged = await page.$$eval('[data-clear-on-leave]', els => els.map(el => ({
      id: el.id,
      view: (el.closest('.subtab-content') || el.closest('.dtab-content') || {}).id || null
    })));
    assert.ok(tagged.length >= 10, `expected the tagged set to be present (${tagged.length})`);
    tagged.forEach(t => assert.ok(t.view, `${t.id} is not inside a subtab/dashboard-tab, so nothing would ever clear it`));

    // ---------- status lines: cleared when their subtab is LEFT, kept while staying ----------
    const perSubtab = [
      ['info', 'info-bulk-delete-status'],
      ['pit', 'pit-bulk-delete-status'],
      ['pit', 'event-export-pit-error'],
      ['pit', 'event-export-pit-success'],
      ['match', 'match-bulk-delete-status'],
      ['match', 'event-export-match-error'],
      ['match', 'event-export-match-success']
    ];
    for (const [tab, id] of perSubtab) {
      await openScoutingSubtab(page, tab);
      await page.evaluate((i) => { document.getElementById(i).textContent = 'stale text'; }, id);
      await page.click(`#scouting-subtabs .tab[data-subtab="${tab}"]`); // re-click the SAME tab: not leaving
      assert.equal(await textOf(page, id), 'stale text', `${id} must survive re-clicking its own tab`);
      await openScoutingSubtab(page, tab === 'info' ? 'pit' : 'info'); // leave
      assert.equal(await textOf(page, id), '', `${id} must be cleared after leaving the ${tab} tab`);
    }

    // ---------- dashboard-tab leave clears the event area's own lines ----------
    for (const id of ['event-export-error', 'event-export-success', 'event-error']) {
      await page.evaluate((i) => { document.getElementById(i).textContent = 'stale text'; }, id);
    }
    await page.click('#dashboard-tabs .tab[data-dtab="myteam"]');
    for (const id of ['event-export-error', 'event-export-success', 'event-error']) {
      assert.equal(await textOf(page, id), '', `${id} cleared after leaving the Scouting tab`);
    }
    await page.click('#dashboard-tabs .tab[data-dtab="scouting"]');

    // ---------- NOT cleared: search / filter / sort / season (unsure — left alone) ----------
    await openScoutingSubtab(page, 'pit');
    await page.fill('#input-team-search-pit', '202');
    await page.selectOption('#select-team-sort-pit', 'name');
    await openScoutingSubtab(page, 'match');
    await openScoutingSubtab(page, 'pit');
    assert.equal(await page.inputValue('#input-team-search-pit'), '202', 'team filter text is unchanged by switching subtabs');
    assert.equal(await page.inputValue('#select-team-sort-pit'), 'name', 'sort selector is unchanged by switching subtabs');
    assert.equal(await page.inputValue('#input-event-search'), 'Smoke', 'event search box is unchanged');
    const season = await page.inputValue('#select-season');
    await page.click('#dashboard-tabs .tab[data-dtab="myteam"]');
    await page.click('#dashboard-tabs .tab[data-dtab="scouting"]');
    assert.equal(await page.inputValue('#select-season'), season, 'season dropdown is unchanged');
    assert.equal(await page.inputValue('#input-event-search'), 'Smoke', 'event search survives leaving Scouting (session state)');
  }
};
