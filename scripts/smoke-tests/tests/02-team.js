// Create a team, then have a second user join it with the join code.

const assert = require('node:assert/strict');
const { signInUI, createTeamUI, joinTeamUI } = require('../lib/app');

module.exports = {
  name: 'team: create a team, second user joins with the join code',
  async run(ctx) {
    const captain = await ctx.makeUser('Captain Smoke');
    const member = await ctx.makeUser('Member Smoke');

    const capPage = await ctx.newPage('captain');
    await signInUI(capPage, captain);
    const joinCode = await createTeamUI(capPage, 'Smoke Robotics');
    assert.equal((await capPage.textContent('#main-team-name')).trim(), 'Smoke Robotics');

    const memPage = await ctx.newPage('member');
    await signInUI(memPage, member);
    await joinTeamUI(memPage, joinCode);
    assert.equal((await memPage.textContent('#main-team-name')).trim(), 'Smoke Robotics');

    // Both members show up on the roster (captain's view updates live).
    await memPage.click('#dashboard-tabs .tab[data-dtab="myteam"]');
    await memPage.waitForFunction(() => {
      const t = document.getElementById('member-list')?.textContent || '';
      return t.includes('Captain Smoke') && t.includes('Member Smoke');
    });
    await capPage.click('#dashboard-tabs .tab[data-dtab="myteam"]');
    await capPage.waitForFunction(() => (document.getElementById('member-list')?.textContent || '').includes('Member Smoke'));
  }
};
