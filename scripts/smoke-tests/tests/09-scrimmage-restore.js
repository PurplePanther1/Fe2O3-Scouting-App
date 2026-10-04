// Session restore with scrimmages: a refresh restores the open scrimmage; a
// refresh whose saved selection points at a scrimmage that has since been
// deleted clears the selection and says so (no half-open state, no crash).

const assert = require('node:assert/strict');
const { signInUI, createTeamUI, createScrimmageUI, openScrimmageUI } = require('../lib/app');

const SESSION_KEY = 'fe2o3_session_state';

module.exports = {
  name: 'scrimmage restore: refresh restores it; a deleted one is cleared with a notice',
  async run(ctx) {
    const user = await ctx.makeUser('Restore Scout');
    const page = await ctx.newPage('restore');
    await signInUI(page, user);
    await createTeamUI(page, 'Restore Smoke Team');
    await createScrimmageUI(page, { name: 'Restore Me' });
    await openScrimmageUI(page, 'Restore Me');
    const [teamId, scrimmageId] = await page.evaluate(() => [currentTeamData.id, selectedEvent.scrimmageId]);

    // 1. Plain refresh restores it.
    await page.reload();
    await page.waitForSelector('#screen-main.active');
    await page.waitForFunction(() => selectedEvent && selectedEvent.isScrimmage && selectedEvent.name === 'Restore Me' && currentScrimmage);
    assert.ok(await page.locator('[data-scrimmage-banner]:visible').count() > 0, 'banner shown after restore');

    // 2. Save the browser-tab state, delete the scrimmage out from under it
    //    (from a second tab of the same user), put the stale state back, refresh.
    const saved = await page.evaluate((k) => sessionStorage.getItem(k), SESSION_KEY);
    assert.ok(saved && saved.includes(scrimmageId), 'the open scrimmage was persisted in session state');

    const other = await ctx.newPage('other-tab');
    await signInUI(other, user);
    await other.evaluate(async ([tid, sid]) => {
      await db.collection('teams').doc(tid).collection('scrimmages').doc(sid).delete();
    }, [teamId, scrimmageId]);

    // The first tab was watching it live, so it already cleared itself and told the user.
    await page.waitForFunction(() => selectedEvent === null);
    await page.waitForSelector('#generic-confirm-modal:not(.hidden)');
    assert.match(await page.textContent('#generic-confirm-title'), /Scrimmage Deleted/);

    await page.evaluate(([k, v]) => sessionStorage.setItem(k, v), [SESSION_KEY, saved]);
    await page.reload();
    await page.waitForSelector('#screen-main.active');
    await page.waitForSelector('#generic-confirm-modal:not(.hidden)');
    assert.match(await page.textContent('#generic-confirm-title'), /Scrimmage Not Found/);
    assert.equal(await page.evaluate(() => selectedEvent), null, 'selection cleared');
    assert.ok(await page.locator('[data-scrimmage-banner]:visible').count() === 0, 'no banner left behind');
    assert.ok(!(await page.isVisible('#match-view-toggle-bar')), 'no stray controls');
    assert.equal(await page.evaluate(() => currentScrimmage), null);
  }
};
