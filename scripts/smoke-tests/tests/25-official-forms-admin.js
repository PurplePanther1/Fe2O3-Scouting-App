// The Admin button and the admin screen (js/official-form-admin.js), on the REAL rules:
//   - the button shows only for a VERIFIED leviticus.sietman@gmail.com account (an emulator
//     user with that address — the rules hard-code it, so the client constant is NOT overridden);
//     other users, the right address unverified, and a look-alike never see it; it works on
//     the Join/Create Team screen (no team) AND next to My Account on the team dashboard
//   - it is also on the standalone My Account page and the Account Activity page (which hide the dashboard header),
//     right next to their back button, hidden for everyone else; closing the admin screen returns to that page
//   - the screen is the team form builder pointed at a DRAFT: no team needed, nothing is
//     published until Publish, switching season/type keeps the drafts, closing with unpublished
//     changes loses nothing (they are autosaved - test 31 covers the autosave itself)
//   - Publish confirms with the version number, bumps ONLY that form's version (pit and match
//     are separate), keeps a version history, "Load as draft" / "Discard my changes" work, and
//     the current season carries a warning
// Published seasons are throwaway (2021) so no real team ever sees any of it.

const assert = require('node:assert/strict');
const { signInUI, createTeamUI, deleteTeamAsLastMember, confirmGeneric } = require('../lib/app');

const labels = (page) => page.$$eval('#builder-field-list .builder-field-label', els => els.map(e => e.textContent.trim()));
const officialDoc = (page, id) => page.evaluate(async (docId) => {
  const snap = await db.collection('officialForms').doc(docId).get();
  return snap.exists ? { version: snap.data().version, ids: snap.data().fields.map(f => f.id), publishedBy: snap.data().publishedBy } : null;
}, id);
const versionIds = (page, id) => page.evaluate(async (docId) => {
  const snap = await db.collection('officialForms').doc(docId).collection('versions').get();
  return snap.docs.map(d => d.id).sort();
}, id);

// The Admin button on a standalone page: next to the page's back button, opens the admin screen, closing it returns to the page.
async function adminButtonOnPage(page, buttonSel, backSel, label) {
  assert.ok(await page.isVisible(buttonSel), `${label}: the admin sees the Admin button`);
  const back = await page.locator(backSel).boundingBox();
  const btn = await page.locator(buttonSel).boundingBox();
  assert.ok(Math.abs((back.y + back.height / 2) - (btn.y + btn.height / 2)) < 20 && btn.x > back.x, `${label}: Admin sits next to the back button`);
  await page.click(buttonSel);
  await page.waitForSelector('#builder-modal:not(.hidden)');
  assert.match(await page.textContent('#builder-modal-title'), /^Admin: Official/, `${label}: opens the admin screen`);
  await page.click('#btn-builder-close');
  await page.waitForSelector('#builder-modal', { state: 'hidden' });
  assert.ok(await page.isVisible(backSel) && await page.isVisible(buttonSel), `${label}: closing the admin screen leaves you on the same page`);
}

async function addField(page, label, type = 'number') {
  await page.click('#btn-builder-add-field');
  await page.waitForSelector('#field-editor-modal:not(.hidden)');
  await page.fill('#bld-field-label', label);
  await page.selectOption('#bld-field-type', type);
  // The default form already shows 6 fields in the preview (the cap), so a 7th can't be in it.
  await page.setChecked('#bld-field-show-in-preview', false);
  await page.click('#btn-bld-save');
  await page.waitForSelector('#field-editor-modal', { state: 'hidden' });
  await page.waitForFunction((l) => [...document.querySelectorAll('#builder-field-list .builder-field-label')].some(e => e.textContent.trim() === l), label);
}

module.exports = {
  name: 'official forms admin: Admin button (verified admin only, with or without a team), draft screen, publish/versions/history',
  async run(ctx) {
    const admin = await ctx.adminUser();
    const plain = await ctx.makeUser('Plain Smoke');

    // ---------- who sees the button ----------
    const plainPage = await ctx.newPage('plain');
    await signInUI(plainPage, plain);
    assert.ok(await plainPage.isHidden('#btn-open-admin-from-team'), 'a normal user has no Admin button on the Join/Create Team screen');
    const fn = await plainPage.evaluate(() => ({
      verified: isOfficialFormsAdmin({ email: 'leviticus.sietman@gmail.com', emailVerified: true }),
      unverified: isOfficialFormsAdmin({ email: 'leviticus.sietman@gmail.com', emailVerified: false }),
      missingFlag: isOfficialFormsAdmin({ email: 'leviticus.sietman@gmail.com' }),
      other: isOfficialFormsAdmin({ email: 'someone@example.com', emailVerified: true }),
      lookalike: isOfficialFormsAdmin({ email: 'leviticus.sietman@gmail.com.evil.com', emailVerified: true }),
      prefix: isOfficialFormsAdmin({ email: 'xleviticus.sietman@gmail.com', emailVerified: true }),
      signedOut: isOfficialFormsAdmin(null)
    }));
    assert.deepEqual(fn, { verified: true, unverified: false, missingFlag: false, other: false, lookalike: false, prefix: false, signedOut: false });
    // The button follows the SIGNED-IN account: the right address UNVERIFIED hides it, verified shows it.
    await plainPage.evaluate(() => { window.__realUser = currentUser; currentUser = { email: 'leviticus.sietman@gmail.com', emailVerified: false, uid: 'x' }; updateAdminButtons(); });
    assert.ok(await plainPage.isHidden('#btn-open-admin-from-team'), 'the admin address UNVERIFIED does not show the button');
    await plainPage.evaluate(() => { currentUser = { email: 'leviticus.sietman@gmail.com', emailVerified: true, uid: 'x' }; updateAdminButtons(); });
    assert.ok(await plainPage.isVisible('#btn-open-admin-from-team'), 'verified shows it (the client check alone)');
    await plainPage.evaluate(() => { currentUser = window.__realUser; updateAdminButtons(); });
    assert.ok(await plainPage.isHidden('#btn-open-admin-from-team'), 'back to the real (normal) user: hidden again');
    // ...and a normal user's team dashboard has none either.
    await createTeamUI(plainPage, 'Plain Smoke Team');
    assert.ok(await plainPage.isHidden('#btn-open-admin-from-dashboard'), 'a normal user has no Admin button on the dashboard');
    await plainPage.click('#btn-open-my-account-from-dashboard');
    await plainPage.waitForSelector('#btn-my-account-standalone-back:not(.hidden)');
    assert.ok(await plainPage.isHidden('#btn-open-admin-from-account'), 'a normal user has no Admin button on My Account');
    await plainPage.click('#btn-open-account-activity');
    await plainPage.waitForSelector('#btn-account-activity-back');
    assert.ok(await plainPage.isHidden('#btn-open-admin-from-activity'), 'a normal user has no Admin button on Account Activity');
    // ...and not even when the client is (wrongly) told the address is unverified
    await plainPage.evaluate(() => { window.__realUser2 = currentUser; currentUser = { email: 'leviticus.sietman@gmail.com', emailVerified: false, uid: 'x' }; updateAdminButtons(); });
    assert.ok(await plainPage.isHidden('#btn-open-admin-from-account') && await plainPage.isHidden('#btn-open-admin-from-activity'), 'the admin address UNVERIFIED shows neither');
    await plainPage.evaluate(() => { currentUser = { email: 'leviticus.sietman@gmail.com', emailVerified: true, uid: 'x' }; updateAdminButtons(); });
    assert.ok(await plainPage.isVisible('#btn-open-admin-from-activity'), 'verified shows it (the client check alone)');
    await plainPage.evaluate(() => { currentUser = window.__realUser2; updateAdminButtons(); });
    assert.ok(await plainPage.isHidden('#btn-open-admin-from-activity'), 'back to the real user: hidden again');
    await plainPage.click('#btn-account-activity-back');
    await plainPage.click('#btn-my-account-standalone-back');

    // ---------- the admin, with NO team ----------
    const page = await ctx.newPage('admin');
    await signInUI(page, admin);
    assert.ok(await page.isVisible('#btn-open-admin-from-team'), 'the verified admin sees Admin on the Join/Create Team screen (before joining any team)');
    const myAcct = await page.locator('#btn-open-my-account-standalone').boundingBox();
    const adminBtn = await page.locator('#btn-open-admin-from-team').boundingBox();
    assert.ok(Math.abs((myAcct.y + myAcct.height / 2) - (adminBtn.y + adminBtn.height / 2)) < 14 && adminBtn.x > myAcct.x, 'Admin sits right next to My Account');
    // My Account / Account Activity reached from the Join/Create Team screen
    await page.click('#btn-open-my-account-standalone');
    await page.waitForSelector('#btn-my-account-standalone-back:not(.hidden)');
    await adminButtonOnPage(page, '#btn-open-admin-from-account', '#btn-my-account-standalone-back', 'My Account (no team)');
    await page.click('#btn-open-account-activity');
    await page.waitForSelector('#btn-account-activity-back');
    await adminButtonOnPage(page, '#btn-open-admin-from-activity', '#btn-account-activity-back', 'Account Activity (no team)');
    await page.click('#btn-account-activity-back');
    await page.click('#btn-my-account-standalone-back');
    await page.waitForSelector('#btn-open-admin-from-team', { state: 'visible' });
    await page.click('#btn-open-admin-from-team');
    await page.waitForSelector('#builder-modal:not(.hidden)');
    assert.match(await page.textContent('#builder-modal-title'), /^Admin: Official Pit Scouting Form Builder$/);
    assert.ok(await page.isVisible('#builder-admin-panel'));
    assert.ok(await page.isHidden('#builder-official-bar'), 'the team "Official form" bar is not shown in admin mode');
    assert.ok(await page.isVisible('#builder-help-admin') && await page.isHidden('#builder-help-team'));

    // ---------- a draft for a throwaway season ----------
    await page.selectOption('#builder-season-select', '2021');
    await page.waitForFunction(() => currentBuilderSeason === '2021' && adminDrafts.has('2021_pitScouting') && !document.getElementById('builder-field-list').textContent.includes('Loading') && /No pit form is published/.test(document.getElementById('admin-status').textContent) && /built-in default/.test(document.getElementById('admin-draft-state').textContent));
    assert.equal((await page.textContent('#btn-admin-publish')).trim(), 'Publish version 1');
    const defaults = await labels(page);
    assert.ok(defaults.includes('Drive Type') && defaults.includes('Notes'), 'starts from the default form');
    assert.equal(await officialDoc(page, '2021_pitScouting'), null, 'nothing published yet');

    await addField(page, 'Gear Ratio');
    assert.match(await page.textContent('#admin-draft-state'), /unpublished changes/);
    assert.equal(await officialDoc(page, '2021_pitScouting'), null, 'editing a draft writes NOTHING');
    // Switching to Match and back keeps the pit draft.
    await page.click('.builder-type-tab[data-builder-type="matchScouting"]');
    await page.waitForFunction(() => /No match form is published/.test(document.getElementById('admin-status').textContent));
    assert.equal((await page.textContent('#builder-modal-title')).trim(), 'Admin: Official Match Scouting Form Builder');
    await page.click('.builder-type-tab[data-builder-type="pitScouting"]');
    await page.waitForFunction(() => /No pit form is published/.test(document.getElementById('admin-status').textContent));
    assert.ok((await labels(page)).includes('Gear Ratio'), 'the draft survives switching form type');

    // Closing with unpublished changes needs no prompt: the draft is saved first (autosave), and
    // opening the screen again brings it back.
    await page.click('#btn-builder-close');
    await page.waitForSelector('#builder-modal', { state: 'hidden' });
    assert.ok(await page.isHidden('#generic-confirm-modal'), 'no discard prompt: the draft was saved');
    await page.click('#btn-open-admin-from-team');
    await page.waitForSelector('#builder-modal:not(.hidden)');
    await page.selectOption('#builder-season-select', '2021');
    await page.waitForFunction(() => [...document.querySelectorAll('#builder-field-list .builder-field-label')].some(e => e.textContent.trim() === 'Gear Ratio'));
    assert.match(await page.textContent('#admin-draft-state'), /unpublished changes/);

    // ---------- publish: confirm names the version; the doc and its history copy land ----------
    await page.click('#btn-admin-publish');
    await page.waitForSelector('#generic-confirm-modal:not(.hidden)');
    assert.equal((await page.textContent('#generic-confirm-title')).trim(), 'Publish version 1?');
    const message = await page.textContent('#generic-confirm-message');
    assert.match(message, /Publish version 1 of the 2021-2022/);
    assert.ok(!/CURRENT season/.test(message), 'a past season carries no current-season warning');
    await page.click('#btn-generic-confirm-cancel');
    assert.equal(await officialDoc(page, '2021_pitScouting'), null, 'Cancel publishes nothing');
    await page.click('#btn-admin-publish');
    await confirmGeneric(page);
    await page.waitForFunction(() => /Published version 1\./.test(document.getElementById('builder-success').textContent));
    const v1 = await officialDoc(page, '2021_pitScouting');
    assert.equal(v1.version, 1);
    assert.equal(v1.publishedBy, admin.uid);
    assert.ok(v1.ids.includes('gearRatio') && v1.ids.includes('driveType'), 'the published fields are the draft');
    assert.deepEqual(await versionIds(page, '2021_pitScouting'), ['1'], 'a history copy of version 1');
    await page.waitForFunction(() => /Published now: version 1/.test(document.getElementById('admin-status').textContent));
    assert.match(await page.textContent('#admin-draft-state'), /No changes since the published version/);
    assert.equal((await page.textContent('#btn-admin-publish')).trim(), 'Publish version 2');

    // ---------- v2 of pit (remove Notes); match is versioned separately ----------
    const notesRow = page.locator('#builder-field-list .builder-field-item', { hasText: 'Notes' });
    await notesRow.locator('button', { hasText: '✕' }).click();
    await confirmGeneric(page);
    await page.waitForFunction(() => !/Notes/.test(document.getElementById('builder-field-list').textContent));
    await page.click('#btn-admin-publish');
    await page.waitForSelector('#generic-confirm-modal:not(.hidden)');
    assert.equal((await page.textContent('#generic-confirm-title')).trim(), 'Publish version 2?');
    await page.click('#btn-generic-confirm-proceed');
    await page.waitForFunction(() => /Published version 2\./.test(document.getElementById('builder-success').textContent));
    const v2 = await officialDoc(page, '2021_pitScouting');
    assert.equal(v2.version, 2);
    assert.ok(!v2.ids.includes('notes'));
    assert.deepEqual(await versionIds(page, '2021_pitScouting'), ['1', '2']);
    const v1Copy = await page.evaluate(async () => (await db.collection('officialForms').doc('2021_pitScouting').collection('versions').doc('1').get()).data().fields.map(f => f.id));
    assert.ok(v1Copy.includes('notes'), 'the history copy of version 1 is untouched by version 2');

    await page.click('.builder-type-tab[data-builder-type="matchScouting"]');
    await page.waitForFunction(() => /No match form is published/.test(document.getElementById('admin-status').textContent));
    assert.equal((await page.textContent('#btn-admin-publish')).trim(), 'Publish version 1', 'match has its OWN version counter');
    await page.click('#btn-admin-publish');
    await confirmGeneric(page);
    await page.waitForFunction(() => /Published version 1\./.test(document.getElementById('builder-success').textContent));
    assert.equal((await officialDoc(page, '2021_matchScouting')).version, 1);
    assert.equal((await officialDoc(page, '2021_pitScouting')).version, 2, 'publishing match did not touch pit');
    await page.click('.builder-type-tab[data-builder-type="pitScouting"]');
    await page.waitForFunction(() => /Published now: version 2/.test(document.getElementById('admin-status').textContent));

    // ---------- history: lists versions; "Load as draft"; "Discard my changes" ----------
    await page.click('#btn-admin-history');
    await page.waitForSelector('#admin-history-list .official-admin-history-row');
    const rows = await page.$$eval('#admin-history-list .official-admin-history-row', els => els.map(e => e.dataset.version));
    assert.deepEqual(rows, ['2', '1'], 'newest first');
    await page.locator('#admin-history-list .official-admin-history-row[data-version="1"] button').click();
    await page.waitForFunction(() => [...document.querySelectorAll('#builder-field-list .builder-field-label')].some(e => e.textContent.trim() === 'Notes'));
    assert.match(await page.textContent('#admin-draft-state'), /unpublished changes/);
    await page.click('#btn-admin-reset');
    await page.waitForFunction(() => /No changes since the published version/.test(document.getElementById('admin-draft-state').textContent));
    assert.ok(!(await labels(page)).includes('Notes'), 'back to the published version (no Notes)');
    assert.ok(await page.isHidden('#btn-admin-reset'), 'nothing to discard now');

    // ---------- the current season carries a warning (and Cancel publishes nothing) ----------
    const currentSeason = await page.evaluate(() => String(getCurrentFtcSeason()));
    await page.selectOption('#builder-season-select', currentSeason);
    await page.waitForFunction(() => /No pit form is published|Published now/.test(document.getElementById('admin-status').textContent));
    const hadPublished = await officialDoc(page, `${currentSeason}_pitScouting`);
    assert.equal(hadPublished, null, 'no template for the current season in this run');
    await page.click('#btn-admin-publish');
    await page.waitForSelector('#generic-confirm-modal:not(.hidden)');
    assert.match(await page.textContent('#generic-confirm-message'), /This is the CURRENT season/);
    await page.click('#btn-generic-confirm-cancel');
    assert.equal(await officialDoc(page, `${currentSeason}_pitScouting`), null, 'Cancel on the current season publishes nothing');

    // Nothing dirty -> the screen closes without a prompt.
    await page.click('#btn-builder-close');
    await page.waitForSelector('#builder-modal', { state: 'hidden' });

    // ---------- the dashboard Admin button (next to My Account) ----------
    await createTeamUI(page, 'Admin Smoke Team');
    assert.ok(await page.isVisible('#btn-open-admin-from-dashboard'), 'the admin sees Admin on the team dashboard');
    const acct = await page.locator('#btn-open-my-account-from-dashboard').boundingBox();
    const dashAdmin = await page.locator('#btn-open-admin-from-dashboard').boundingBox();
    assert.ok(Math.abs((acct.y + acct.height / 2) - (dashAdmin.y + dashAdmin.height / 2)) < 14, 'beside My Account');
    await page.click('#btn-open-admin-from-dashboard');
    await page.waitForSelector('#builder-modal:not(.hidden)');
    assert.match(await page.textContent('#builder-modal-title'), /^Admin: Official/);
    await page.click('#btn-builder-close');
    await page.waitForSelector('#builder-modal', { state: 'hidden' });
    // My Account / Account Activity reached from the dashboard (the dashboard header is hidden there)
    await page.click('#btn-open-my-account-from-dashboard');
    await page.waitForSelector('#btn-my-account-standalone-back:not(.hidden)');
    assert.ok(await page.isHidden('#btn-open-admin-from-dashboard'), 'the dashboard header (and its Admin button) is hidden on this page');
    await adminButtonOnPage(page, '#btn-open-admin-from-account', '#btn-my-account-standalone-back', 'My Account (dashboard)');
    await page.click('#btn-open-account-activity');
    await page.waitForSelector('#btn-account-activity-back');
    await adminButtonOnPage(page, '#btn-open-admin-from-activity', '#btn-account-activity-back', 'Account Activity (dashboard)');
    await page.click('#btn-account-activity-back');
    assert.ok(await page.isVisible('#btn-open-admin-from-account'), 'back on My Account');
    await page.click('#btn-my-account-standalone-back');
    await page.waitForSelector('#btn-open-admin-from-dashboard', { state: 'visible' });

    // The shared admin account must not keep a team between tests.
    await deleteTeamAsLastMember(page);
  }
};
