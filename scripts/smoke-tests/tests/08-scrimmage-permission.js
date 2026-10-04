// The canManageScrimmages permission through the real UI: a captain grants it
// in Edit Permissions, the member's Scrimmages tab gains Manage/Delete and + New
// Scrimmage LIVE (no refresh) — and the Manage modal (name / season / date /
// Add Team / Delete) works for them, including on a scrimmage they did NOT
// create — then the captain revokes it and the controls disappear live again.
// A member WITHOUT the permission never sees any of it.

const assert = require('node:assert/strict');
const { signInUI, createTeamUI, joinTeamUI, openScrimmagesTab, createScrimmageUI, scrimmageRow, submitScrimmageTeamModal } = require('../lib/app');

async function setScrimmagePermission(capPage, memberName, on) {
  await capPage.click('#dashboard-tabs .tab[data-dtab="myteam"]');
  const row = capPage.locator('#member-list .member-item', { hasText: memberName });
  await row.getByRole('button', { name: 'Edit Permissions' }).click();
  await capPage.waitForSelector('#member-permissions-modal:not(.hidden)');
  assert.ok(await capPage.isVisible('#perm-canManageScrimmages'), 'the checkbox exists in the permissions modal');
  await capPage.setChecked('#perm-canManageScrimmages', on);
  await capPage.click('#btn-member-perms-save');
  await capPage.waitForSelector('#member-permissions-modal', { state: 'hidden' });
}

module.exports = {
  name: 'scrimmage permission: grant/revoke canManageScrimmages shows/hides Manage, Delete and + New live',
  async run(ctx) {
    const captain = await ctx.makeUser('Captain Perm');
    const member = await ctx.makeUser('Member Perm');

    const capPage = await ctx.newPage('captain');
    await signInUI(capPage, captain);
    const joinCode = await createTeamUI(capPage, 'Perm Smoke Team');
    await createScrimmageUI(capPage, { name: 'Captain Made' });

    const memPage = await ctx.newPage('member');
    await signInUI(memPage, member);
    await joinTeamUI(memPage, joinCode);
    await openScrimmagesTab(memPage);
    await scrimmageRow(memPage, 'Captain Made').waitFor();
    assert.ok(!(await memPage.isVisible('#btn-new-scrimmage')), 'no create button before the grant');
    assert.equal(await memPage.locator('.btn-scrimmage-manage, .btn-scrimmage-delete').count(), 0, 'a plain member sees no row buttons');
    // The row itself still works for a plain member: whole-row click opens it.
    await scrimmageRow(memPage, 'Captain Made').locator('.event-name').click();
    await memPage.waitForFunction(() => selectedEvent && selectedEvent.name === 'Captain Made');
    await scrimmageRow(memPage, 'Captain Made').locator('.event-name').click();
    await memPage.waitForFunction(() => selectedEvent === null);

    // Grant -> controls appear on the member's open screen without a refresh.
    await setScrimmagePermission(capPage, 'Member Perm', true);
    await memPage.waitForSelector('#btn-new-scrimmage:not(.hidden)');
    await scrimmageRow(memPage, 'Captain Made').locator('.btn-scrimmage-delete').waitFor();
    await scrimmageRow(memPage, 'Captain Made').locator('.btn-scrimmage-manage').waitFor();

    // ...and they work, including on a scrimmage the member did NOT create.
    await createScrimmageUI(memPage, { name: 'Member Made' });
    await openScrimmagesTab(capPage);
    await scrimmageRow(capPage, 'Member Made').waitFor();
    await scrimmageRow(memPage, 'Captain Made').locator('.btn-scrimmage-manage').click();
    await memPage.waitForSelector('#scrimmage-form-modal:not(.hidden)');
    assert.ok(await memPage.isVisible('#scrimmage-season-group'), 'season is editable in Manage');
    assert.ok(await memPage.isVisible('#btn-scrimmage-manage-add-team'));
    assert.ok(await memPage.isVisible('#btn-scrimmage-manage-delete'));
    await memPage.fill('#input-scrimmage-name', 'Captain Made (renamed by member)');
    await memPage.selectOption('#select-scrimmage-season', '2025');
    await memPage.click('#btn-scrimmage-form-save');
    await scrimmageRow(memPage, 'renamed by member').waitFor();
    await scrimmageRow(capPage, 'renamed by member').waitFor();
    assert.match(await scrimmageRow(capPage, 'renamed by member').textContent(), /2025-2026/, 'the season edit reached the captain live');
    // Manage's Add Team, then Delete from inside Manage.
    await scrimmageRow(memPage, 'renamed by member').locator('.btn-scrimmage-manage').click();
    await memPage.waitForSelector('#scrimmage-form-modal:not(.hidden)');
    await memPage.click('#btn-scrimmage-manage-add-team');
    await submitScrimmageTeamModal(memPage, { number: 4321, name: 'Via Manage' });
    await memPage.waitForFunction(() => /Added Team #4321/.test(document.getElementById('scrimmage-manage-team-success')?.textContent || ''));
    await memPage.click('#btn-scrimmage-manage-delete');
    await memPage.waitForSelector('#generic-confirm-modal:not(.hidden)');
    await memPage.click('#btn-generic-confirm-proceed');
    await scrimmageRow(memPage, 'renamed by member').waitFor({ state: 'detached' });
    await scrimmageRow(capPage, 'renamed by member').waitFor({ state: 'detached' });

    // Revoke -> controls disappear live.
    await setScrimmagePermission(capPage, 'Member Perm', false);
    await memPage.waitForSelector('#btn-new-scrimmage', { state: 'hidden' });
    await memPage.waitForFunction(() => document.querySelectorAll('.btn-scrimmage-manage, .btn-scrimmage-delete').length === 0);
  }
};
