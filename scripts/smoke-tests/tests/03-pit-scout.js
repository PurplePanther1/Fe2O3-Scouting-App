// Pit scouting: create an entry from the Pit Scouting tab and confirm it
// persists across a full page reload.

const assert = require('node:assert/strict');
const { signInUI, createTeamUI, selectFixtureEvent, pitScoutTeam, openScoutingSubtab, teamRow } = require('../lib/app');

module.exports = {
  name: 'pit scouting: create an entry, survives reload',
  async run(ctx) {
    const user = await ctx.makeUser('Pit Scout');
    const page = await ctx.newPage('pit');
    await signInUI(page, user);
    await createTeamUI(page, 'Pit Smoke Team');
    await selectFixtureEvent(page);

    await pitScoutTeam(page, 101, 'smoke pit note');
    const meta = (await (await teamRow(page, '#team-list-pit', 101)).locator('.pit-row-meta').textContent()).trim();
    assert.match(meta, /Pit Scout/, `scouted-by line should name the scout, got: "${meta}"`);

    // Reload: session state restores the event; the entry must still be there.
    await page.reload();
    await page.waitForSelector('#screen-main.active');
    await page.waitForFunction(() => /team\(s\) registered/.test(document.getElementById('selected-event-teams-count')?.textContent || ''));
    await openScoutingSubtab(page, 'pit');
    await (await teamRow(page, '#team-list-pit', 101)).locator('.pit-row-meta').waitFor();

    // Re-opening shows the saved value.
    await (await teamRow(page, '#team-list-pit', 101)).locator('.btn-pit-quick-scout').click();
    await page.waitForSelector('#pit-modal:not(.hidden) #dyn-notes');
    await page.waitForFunction(() => document.getElementById('dyn-notes')?.value === 'smoke pit note');
  }
};
