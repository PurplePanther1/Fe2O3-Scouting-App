// Pit vs Match comparison view: with both a pit and a match entry for a
// team, the comparison modal shows the pit side and the match-observed side.

const assert = require('node:assert/strict');
const { signInUI, createTeamUI, selectFixtureEvent, pitScoutTeam, matchScoutTeam, openScoutingSubtab, teamRow } = require('../lib/app');

module.exports = {
  name: 'pit vs match: comparison modal shows pit data and match stats',
  async run(ctx) {
    const user = await ctx.makeUser('Compare Scout');
    const page = await ctx.newPage('compare');
    await signInUI(page, user);
    await createTeamUI(page, 'Compare Smoke Team');
    await selectFixtureEvent(page);

    await pitScoutTeam(page, 303, 'compare pit note');
    await matchScoutTeam(page, 303, 3, 'compare match note');

    await openScoutingSubtab(page, 'compare');
    const row = await teamRow(page, '#team-list-compare', 303);
    await row.getByRole('button', { name: 'Compare' }).click();
    await page.waitForSelector('#comparison-modal:not(.hidden)');

    await page.waitForFunction(() => (document.getElementById('cmp-pit-data')?.textContent || '').includes('compare pit note'));
    await page.waitForFunction(() => (document.getElementById('cmp-match-stats')?.textContent || '').trim().length > 0);
    assert.match(await page.textContent('#comparison-modal-title'), /303/);

    // "See ... Used" drill-downs open the read-only entry viewer.
    await page.click('#btn-cmp-view-pit-entry');
    await page.waitForSelector('#view-entry-modal:not(.hidden)');
    // Read-only viewer renders the entry as disabled inputs, so check values.
    await page.waitForFunction(() =>
      [...document.querySelectorAll('#view-entry-fields textarea')].some(t => t.value.includes('compare pit note')));
  }
};
