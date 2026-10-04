// deleteEntireTeam() (the Leave Team / Delete Account path for a team's LAST
// member) must clear every scrimmage and its entries BEFORE deleting the team
// doc — afterwards nothing may be left behind under the team.

const assert = require('node:assert/strict');
const { createRulesTestEnv } = require('../lib/harness');
const {
  signInUI, createTeamUI, createScrimmageUI, openScrimmageUI, openScoutingSubtab, fillRequiredFields
} = require('../lib/app');
const { doc, getDoc, getDocs, collection } = require('firebase/firestore');

module.exports = {
  name: 'scrimmage + team delete: deleteEntireTeam() clears scrimmages and their entries',
  async run(ctx) {
    const user = await ctx.makeUser('Team Deleter');
    const page = await ctx.newPage('team-delete');
    await signInUI(page, user);
    await createTeamUI(page, 'Doomed Team');
    await createScrimmageUI(page, { name: 'Doomed Scrim 1' });
    await createScrimmageUI(page, { name: 'Doomed Scrim 2' });

    // Give scrimmage 1 a team plus a pit entry so there is something to cascade.
    await openScrimmageUI(page, 'Doomed Scrim 1');
    await openScoutingSubtab(page, 'pit');
    await page.click('#btn-scrimmage-add-scout-pit');
    await page.waitForSelector('#scrimmage-team-modal:not(.hidden)');
    await page.fill('#input-scrimmage-team-number', '321');
    await page.click('#btn-scrimmage-team-save');
    await page.waitForSelector('#pit-modal:not(.hidden) #pit-dynamic-fields .pit-field');
    await page.waitForFunction(() => typeof currentPitLiveSession !== 'undefined' && currentPitLiveSession && currentPitLiveSession.isJoined());
    await fillRequiredFields(page, '#pit-modal', 'doomed pit note');
    await page.click('#btn-pit-save');
    await page.waitForSelector('#pit-modal', { state: 'hidden' });

    const [teamId, uid] = await page.evaluate(() => [currentTeamData.id, currentUser.uid]);
    const env = await createRulesTestEnv();
    try {
      // (withSecurityRulesDisabled() doesn't return the callback's value — capture it.)
      const admin = async (fn) => { let out; await env.withSecurityRulesDisabled(async (rc) => { out = await fn(rc.firestore()); }); return out; };
      const count = (c, ...path) => admin(async (fs) => (await getDocs(collection(fs, ...path))).size);
      assert.equal(await count(null, 'teams', teamId, 'scrimmages'), 2);
      assert.equal(await count(null, 'teams', teamId, 'pitScouting'), 1);

      await page.evaluate(([tid, u]) => deleteEntireTeam(tid, u, currentTeamData), [teamId, uid]);

      assert.equal(await count(null, 'teams', teamId, 'scrimmages'), 0, 'scrimmage docs cleared');
      assert.equal(await count(null, 'teams', teamId, 'pitScouting'), 0, 'scrimmage entries cleared');
      assert.equal(await count(null, 'teams', teamId, 'matchScouting'), 0);
      const teamGone = await admin(async (fs) => !(await getDoc(doc(fs, 'teams', teamId))).exists());
      assert.ok(teamGone, 'team doc deleted last');
    } finally {
      await env.cleanup();
    }
  }
};
