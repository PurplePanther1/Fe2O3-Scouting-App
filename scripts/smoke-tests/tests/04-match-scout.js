// Match scouting via Team View: create an entry and see it listed.

const assert = require('node:assert/strict');
const { signInUI, createTeamUI, selectFixtureEvent, matchScoutTeam, teamRow } = require('../lib/app');

module.exports = {
  name: 'match scouting (Team View): create an entry, listed under View Matches Scouted',
  async run(ctx) {
    const user = await ctx.makeUser('Match Scout');
    const page = await ctx.newPage('match');
    await signInUI(page, user);
    await createTeamUI(page, 'Match Smoke Team');
    await selectFixtureEvent(page);

    await matchScoutTeam(page, 202, 7, 'smoke match note');
    const row = await teamRow(page, '#team-list-match', 202);
    assert.equal((await row.locator('.match-count-badge').textContent()).trim(), '1');

    await row.getByRole('button', { name: 'View Matches Scouted' }).click();
    await page.waitForSelector('#match-scouted-modal:not(.hidden)');
    await page.waitForFunction(() => /Match #?\s*7/.test(document.getElementById('msm-match-entries')?.textContent || ''));
    const entries = await page.textContent('#msm-match-entries');
    assert.match(entries, /smoke match note/);
  }
};
