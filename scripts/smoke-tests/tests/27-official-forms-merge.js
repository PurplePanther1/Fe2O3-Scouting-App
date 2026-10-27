// Merging an official form into the team's own (js/official-form-merge.js), by FIELD ID, on the real rules:
//   - fields only on the official form are ADDED, fields only on the team's form are KEPT (a
//     merge never removes a field), fields on both that differ become a per-field choice
//     (default = the team's own), equal fields collapse into one line
//   - the screen is STAGED: Cancel / X / click-out change nothing (asking first only when a
//     choice was changed), and a snapshot of the old form is saved with the save
//   - the official version shown when the screen OPENED is what is recorded as handled: a publish
//     while it is open leaves the notice to show again for the newer version afterwards (after
//     Save AND after Cancel) — a newer version is never skipped
//   - a form that changed under the open screen is not overwritten
//   - preview cap: fields a merge ADDS never push the preview past 6 (the team's own are untouched)

const assert = require('node:assert/strict');
const {
  signInUI, createTeamUI, formField, publishOfficialForm, readFormConfig, readSnapshots,
  openBuilderFor, closeBuilder, noticeItems, noticeButton, openMyTeamTab, selectAppSeason
} = require('../lib/app');

const SEASON = '2023';
const ids = (fields) => fields.map(f => f.id);
const waitItems = (page, n) =>
  page.waitForFunction((c) => document.querySelectorAll('#official-forms-notice-myteam .official-notice-item').length === c, n);
const mergeText = (page, sel) => page.textContent(`#official-merge-modal ${sel}`).then(t => t.trim());
const mergeOpen = (page) => page.waitForSelector('#official-merge-modal:not(.hidden)');
const mergeClosed = (page) => page.waitForSelector('#official-merge-modal', { state: 'hidden' });

module.exports = {
  name: 'official forms: Merge by field id (add / keep / per-field choice), staged Cancel, snapshot, publish-during-merge re-shows the notice, concurrent edit refused, preview cap',
  async run(ctx) {
    const admin = await ctx.adminUser();
    const captain = await ctx.makeUser('Captain Merge');
    const adminPage = await ctx.newPage('admin');
    await signInUI(adminPage, admin);
    const cap = await ctx.newPage('captain');
    await signInUI(cap, captain);
    await createTeamUI(cap, 'Official Merge Team');
    const teamId = await cap.evaluate(() => currentTeamData.id);
    await selectAppSeason(cap, SEASON); // the My Team banner follows the app's season

    await openBuilderFor(cap, SEASON, 'pitScouting');
    await closeBuilder(cap);
    const genericPit = await cap.evaluate(() => JSON.parse(JSON.stringify(GENERIC_PIT_FIELDS)));
    const pick = (id) => genericPit.find(f => f.id === id);
    const officialPit = [
      pick('claimedAvgAutoScore'), pick('claimedAvgTeleopScore'),
      { ...pick('claimedCycleTime'), label: 'Cycle Time (s)' },
      formField('gearRatio', 'Gear Ratio', 'number'), pick('notes')
    ];
    const before = await readFormConfig(cap, teamId, SEASON, 'pitScouting');
    await openMyTeamTab(cap);
    assert.equal(await publishOfficialForm(adminPage, { season: SEASON, formType: 'pitScouting', fields: officialPit }), 1);
    await waitItems(cap, 1);

    // ---------- the Merge screen: what it lists ----------
    await noticeButton(cap, 'pitScouting', 'merge').click();
    await mergeOpen(cap);
    assert.equal(await mergeText(cap, '#official-merge-title'), 'Merge the official pit form');
    assert.match(await mergeText(cap, '#official-merge-intro'), /official version 1 into your form/);
    assert.match(await mergeText(cap, '#official-merge-intro'), /matched by field ID/);
    assert.equal(await mergeText(cap, '#official-merge-summary'), '1 to add · 2 only on your form (kept) · 1 different · 3 the same');
    assert.equal(await mergeText(cap, '[data-section="added"] .merge-field[data-field="gearRatio"] .merge-field-label'), 'Gear Ratio');
    assert.match(await mergeText(cap, '[data-section="added"] .merge-opt-value'), /Number/);
    const different = cap.locator('#official-merge-modal [data-section="different"] .merge-field[data-field="claimedCycleTime"]');
    assert.match(await different.textContent(), /Differs in: Label/);
    assert.ok(await different.locator('input[value="mine"]').isChecked(), "the default is the team's own version");
    assert.ok(!(await different.locator('input[value="official"]').isChecked()));
    assert.deepEqual(await cap.$$eval('#official-merge-modal [data-section="kept"] .merge-same-line', els => els.map(e => e.textContent)), ['Drive Type', 'Auto Capability'], 'only on the team form: kept');
    assert.deepEqual(await cap.$$eval('#official-merge-modal [data-section="same"] .merge-same-line', els => els.map(e => e.textContent)), ['Claimed Avg Auto Score', 'Claimed Avg Teleop Score', 'Notes'], 'equal fields collapse into one line, no choice');
    assert.equal(await cap.locator('#official-merge-modal .merge-field input[type="radio"]').count(), 2, 'only the one differing field has a choice (mine / official)');

    // Cancel with nothing changed: closes at once, nothing written.
    await cap.click('#btn-official-merge-cancel');
    await mergeClosed(cap);
    await cap.waitForTimeout(700);
    assert.deepEqual(await readFormConfig(cap, teamId, SEASON, 'pitScouting'), before, 'Cancel changed nothing');
    assert.equal((await readSnapshots(cap, teamId, SEASON, 'pitScouting')).length, 0);
    assert.equal(await cap.locator('#official-forms-notice-myteam .official-notice-item').count(), 1, 'the notice is still there');

    // A changed choice asks before it is thrown away.
    await noticeButton(cap, 'pitScouting', 'merge').click();
    await mergeOpen(cap);
    await cap.locator('#official-merge-modal .merge-field[data-field="claimedCycleTime"] input[value="official"]').check();
    await cap.click('#btn-official-merge-cancel');
    await cap.waitForSelector('#generic-confirm-modal:not(.hidden)');
    assert.equal((await cap.textContent('#generic-confirm-title')).trim(), 'Discard changes?');
    await cap.click('#btn-generic-confirm-cancel');
    assert.ok(await cap.isVisible('#official-merge-modal'), 'Cancel on "Discard changes?" keeps the screen open');
    assert.ok(await cap.locator('#official-merge-modal .merge-field[data-field="claimedCycleTime"] input[value="official"]').isChecked(), 'with the choice still made');
    await cap.click('#btn-official-merge-close');
    await cap.waitForSelector('#generic-confirm-modal:not(.hidden)');
    await cap.click('#btn-generic-confirm-proceed');
    await mergeClosed(cap);
    await cap.waitForTimeout(900);
    assert.deepEqual(await readFormConfig(cap, teamId, SEASON, 'pitScouting'), before, 'discarded: nothing was written');
    assert.equal((await readSnapshots(cap, teamId, SEASON, 'pitScouting')).length, 0);

    // ---------- a publish while the screen is open ----------
    await noticeButton(cap, 'pitScouting', 'merge').click();
    await mergeOpen(cap);
    assert.equal(await publishOfficialForm(adminPage, { season: SEASON, formType: 'pitScouting', fields: [...officialPit, formField('extra', 'Extra', 'text', { showInPreview: false })] }), 2);
    await cap.waitForSelector('#official-merge-notice:not(.hidden)');
    assert.match(await mergeText(cap, '#official-merge-notice'), /newer official version \(2\) was published while this is open\. This merge uses version 1/);
    await cap.locator('#official-merge-modal .merge-field[data-field="claimedCycleTime"] input[value="official"]').check();
    await cap.click('#btn-official-merge-confirm');
    await mergeClosed(cap);
    let cfg = await readFormConfig(cap, teamId, SEASON, 'pitScouting');
    assert.deepEqual(ids(cfg.fields), ['driveType', 'autoCapability', 'claimedAvgAutoScore', 'claimedAvgTeleopScore', 'claimedCycleTime', 'gearRatio', 'notes'],
      'gearRatio is added after the field that precedes it on the official form; nothing is removed');
    assert.equal(cfg.fields.find(f => f.id === 'claimedCycleTime').label, 'Cycle Time (s)', 'the chosen (official) version of the differing field');
    assert.equal(cfg.fields.find(f => f.id === 'driveType').required, true, "a field only on the team's form is kept exactly as it was");
    assert.equal(cfg.baseVersion, 1, 'recorded: the version that was on screen when it OPENED');
    assert.equal(cfg.handledVersion, 1, 'the newer version was NOT marked handled');
    assert.ok(!('extra' in Object.fromEntries(cfg.fields.map(f => [f.id, 1]))), 'version 2\'s new field was not merged in');
    let snaps = await readSnapshots(cap, teamId, SEASON, 'pitScouting');
    assert.equal(snaps.length, 1);
    assert.equal(snaps[0].action, 'merge');
    assert.deepEqual(ids(snaps[0].fields), ids(genericPit), 'the snapshot is the form from before the merge');
    // A later field edit in the builder keeps the version bookkeeping (it used to be a plain set({ fields })).
    await openBuilderFor(cap, SEASON, 'pitScouting');
    await cap.locator('#builder-field-list .builder-field-item').first().locator('.btn-move-down').click();
    await cap.waitForFunction(() => ((document.querySelector('#builder-field-list .builder-field-label') || {}).textContent || '').trim() === 'Auto Capability');
    cfg = await readFormConfig(cap, teamId, SEASON, 'pitScouting');
    assert.equal(ids(cfg.fields)[0], 'autoCapability', 'the field really moved');
    assert.equal(cfg.baseVersion, 1, 'a builder edit keeps baseVersion');
    assert.equal(cfg.handledVersion, 1, 'and handledVersion');
    await closeBuilder(cap);
    await openMyTeamTab(cap);
    // ...so the notice shows again, for version 2.
    await waitItems(cap, 1);
    await cap.waitForFunction(() => /official version 2/.test((document.querySelector('#official-forms-notice-myteam .official-notice-detail') || {}).textContent || ''));
    assert.match((await noticeItems(cap))[0].detail, /based on official version 1/);

    // ---------- merge version 2 with the defaults: the team's own choices stand ----------
    await noticeButton(cap, 'pitScouting', 'merge').click();
    await mergeOpen(cap);
    // (The team's preview was already full, so version 1's merge added Gear Ratio with "Show in
    // preview" OFF — which is now the one difference from the official form.)
    assert.equal((await readFormConfig(cap, teamId, SEASON, 'pitScouting')).fields.find(f => f.id === 'gearRatio').showInPreview, false, 'an ADDED field never pushes the preview past its limit');
    assert.equal(await mergeText(cap, '#official-merge-summary'), '1 to add · 2 only on your form (kept) · 1 different · 4 the same');
    assert.match(await cap.textContent('#official-merge-modal .merge-field[data-field="gearRatio"]'), /Differs in: Show in preview/);
    await cap.click('#btn-official-merge-confirm');
    await mergeClosed(cap);
    cfg = await readFormConfig(cap, teamId, SEASON, 'pitScouting');
    assert.ok(ids(cfg.fields).includes('extra') && ids(cfg.fields).includes('driveType') && ids(cfg.fields).includes('autoCapability'), 'extra added, nothing removed');
    assert.equal(cfg.baseVersion, 2);
    assert.equal(cfg.handledVersion, 2);
    await waitItems(cap, 0);
    assert.equal((await readSnapshots(cap, teamId, SEASON, 'pitScouting')).length, 2);

    // ---------- publish during an open merge, then CANCEL: the notice still shows the newer one ----------
    assert.equal(await publishOfficialForm(adminPage, { season: SEASON, formType: 'pitScouting', fields: officialPit }), 3);
    await waitItems(cap, 1);
    await noticeButton(cap, 'pitScouting', 'merge').click();
    await mergeOpen(cap);
    assert.equal(await publishOfficialForm(adminPage, { season: SEASON, formType: 'pitScouting', fields: officialPit }), 4);
    await cap.waitForSelector('#official-merge-notice:not(.hidden)');
    await cap.click('#btn-official-merge-cancel');
    await mergeClosed(cap);
    await cap.waitForFunction(() => /official version 4/.test(document.querySelector('#official-forms-notice-myteam .official-notice-detail').textContent));
    assert.equal((await readFormConfig(cap, teamId, SEASON, 'pitScouting')).handledVersion, 2, 'cancelling marked nothing as handled');

    // ---------- a form that changed under the open screen is not overwritten ----------
    await noticeButton(cap, 'pitScouting', 'merge').click();
    await mergeOpen(cap);
    await cap.evaluate(async (tid) => {
      const ref = db.collection('teams').doc(tid).collection('formConfig').doc('2023_pitScouting');
      const data = (await ref.get()).data();
      await ref.update({ fields: data.fields.filter(f => f.id !== 'notes') });
    }, teamId);
    const handledBefore = (await readFormConfig(cap, teamId, SEASON, 'pitScouting')).handledVersion;
    const snapsBefore = (await readSnapshots(cap, teamId, SEASON, 'pitScouting')).length;
    await cap.click('#btn-official-merge-confirm');
    await cap.waitForFunction(() => /Your form changed while this was open/.test(document.getElementById('official-merge-error').textContent));
    assert.ok(await cap.isVisible('#official-merge-modal'), 'the screen stays open with the message');
    assert.equal((await readFormConfig(cap, teamId, SEASON, 'pitScouting')).handledVersion, handledBefore, 'nothing was saved');
    assert.equal((await readSnapshots(cap, teamId, SEASON, 'pitScouting')).length, snapsBefore);
    await cap.click('#btn-official-merge-cancel');
    await mergeClosed(cap);

    // ---------- the pure calculation: preview cap, order-only and default-only differences ----------
    const calc = await cap.evaluate(() => {
      const f = (id, extra = {}) => ({ id, label: id, type: 'text', required: false, sortOrder: 0, ...extra });
      const team = [f('a'), f('b'), f('c'), f('d'), f('e', { showInPreview: false })];   // 4 in the preview (+ e off)
      const official = [f('a'), f('n1'), f('n2'), f('n3'), f('n4')];                     // 4 new ones, all in the preview
      const merged = computeMergedFields(team, official, {});
      const classify = classifyMerge(
        [f('x', { sortOrder: 5 }), f('y', { showInPreview: true })],
        [f('y', { sortOrder: 0 }), f('x', { sortOrder: 1, required: false })]);
      return {
        order: merged.map(m => m.id),
        previewOn: merged.filter(m => m.showInPreview !== false).map(m => m.id),
        teamOnes: ['a', 'b', 'c', 'd'].every(id => merged.find(m => m.id === id).showInPreview !== false),
        sameCount: classify.same.length, differentCount: classify.different.length
      };
    });
    assert.deepEqual(calc.order, ['a', 'n1', 'n2', 'n3', 'n4', 'b', 'c', 'd', 'e'], 'added fields land after the field that precedes them on the official form');
    assert.equal(calc.previewOn.length, 6, 'the preview never goes past 6');
    assert.ok(calc.teamOnes, "the team's own preview settings are never touched");
    assert.deepEqual(calc.previewOn.filter(id => id.startsWith('n')), ['n1', 'n2'], 'only the ADDED fields past the cap are switched off (from the end)');
    assert.equal(calc.sameCount, 2, 'order-only and absent-default differences are not differences');
    assert.equal(calc.differentCount, 0);
  }
};
