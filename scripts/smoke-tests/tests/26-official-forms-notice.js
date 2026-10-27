// Official forms from the TEAM side (js/official-forms.js), on the real rules:
//   - publishing NEVER changes an existing team's form; it only raises a notice
//   - the notice is computed from versions (official version > the team's handledVersion),
//     shown LIVE, only to the captain and members with Edit templates (canEditTemplates),
//     names ONLY the form(s) that updated (pit and match separately; a republish replaces,
//     never duplicates), under Edit Scouting Forms on My Team AND on My Account (+ a badge)
//   - Keep my form: handledVersion = the official version, no nagging until the next publish,
//     and the official form stays reachable from the form builder's "Official form" button
//   - Accept: the team's form becomes the official one (baseVersion = handledVersion = its
//     version), a snapshot of the old form is saved first, removed fields go to retiredFields,
//     and "Restore previous form" puts the old form back
//   - a team with NO config for a season + type gets a COPY of the official form, stamped
//     with its version, and no notice (the only automatic case)
// Everything uses a throwaway season (2022; 2020 for "no official form") so no real team is affected.

const assert = require('node:assert/strict');
const {
  signInUI, createTeamUI, joinTeamUI, formField, publishOfficialForm, readFormConfig, readSnapshots,
  openMyTeamTab, selectAppSeason, openBuilderFor, closeBuilder, builderLabels, setFormsPermission, noticeItems, noticeButton,
  confirmGeneric
} = require('../lib/app');

const SEASON = '2022';

const ids = (fields) => fields.map(f => f.id);
const itemCount = (page, where = 'myteam') => page.evaluate((w) => document.querySelectorAll(`#official-forms-notice-${w} .official-notice-item`).length, where);
const waitItems = (page, n, where = 'myteam') =>
  page.waitForFunction(([c, w]) => document.querySelectorAll(`#official-forms-notice-${w} .official-notice-item`).length === c, [n, where]);

module.exports = {
  name: 'official forms (team side): notice live + permissioned + per form type, Keep (no nag, still reachable), Accept + snapshot + Restore, new-team copy',
  async run(ctx) {
    const admin = await ctx.adminUser();
    const captain = await ctx.makeUser('Captain Notice');
    const member = await ctx.makeUser('Plain Member');
    const editor = await ctx.makeUser('Editor Member');
    const captain2 = await ctx.makeUser('Captain Fresh');

    const adminPage = await ctx.newPage('admin');
    await signInUI(adminPage, admin);

    const cap = await ctx.newPage('captain');
    await signInUI(cap, captain);
    const joinCode = await createTeamUI(cap, 'Official Notice Team');
    const teamId = await cap.evaluate(() => currentTeamData.id);
    const mem = await ctx.newPage('member');
    await signInUI(mem, member);
    await joinTeamUI(mem, joinCode);
    const edi = await ctx.newPage('editor');
    await signInUI(edi, editor);
    await joinTeamUI(edi, joinCode);
    await setFormsPermission(cap, 'Editor Member', true);
    await edi.waitForFunction(() => canUserEditTemplates());
    // The My Team banner follows the app's season selector: point every window at the throwaway season.
    for (const p of [cap, mem, edi]) await selectAppSeason(p, SEASON);

    // The team has a config for both form types in the throwaway season (the builder creates it).
    await openBuilderFor(cap, SEASON, 'pitScouting');
    const genericPitLabels = await builderLabels(cap);
    assert.equal(genericPitLabels[0], 'Drive Type');
    await openBuilderFor(cap, SEASON, 'matchScouting');
    await closeBuilder(cap);
    const pitBefore = await readFormConfig(cap, teamId, SEASON, 'pitScouting');
    const matchBefore = await readFormConfig(cap, teamId, SEASON, 'matchScouting');
    assert.equal(pitBefore.handledVersion, undefined, 'a plain default config has no version bookkeeping');
    assert.equal(pitBefore.baseVersion, undefined);
    const genericPit = await cap.evaluate(() => JSON.parse(JSON.stringify(GENERIC_PIT_FIELDS)));
    const genericMatch = await cap.evaluate(() => JSON.parse(JSON.stringify(GENERIC_MATCH_FIELDS)));
    const pick = (list, id) => list.find(f => f.id === id);
    const officialPit = [
      pick(genericPit, 'claimedAvgAutoScore'), pick(genericPit, 'claimedAvgTeleopScore'),
      { ...pick(genericPit, 'claimedCycleTime'), label: 'Cycle Time (s)' },
      formField('gearRatio', 'Gear Ratio', 'number'), pick(genericPit, 'notes')
    ];
    const officialMatch = [...genericMatch.filter(f => f.id !== 'autoScore'), formField('intakeType', 'Intake Type', 'dropdown', { options: ['A', 'B'] })];

    await openMyTeamTab(cap);
    await openMyTeamTab(edi);
    await openMyTeamTab(mem);
    assert.equal(await itemCount(cap), 0, 'no notice before anything is published');

    // ---------- publish PIT: only the pit notice; nobody's form changes ----------
    assert.equal(await publishOfficialForm(adminPage, { season: SEASON, formType: 'pitScouting', fields: officialPit }), 1);
    await waitItems(cap, 1);
    await waitItems(edi, 1);
    let items = await noticeItems(cap);
    assert.equal(items.length, 1);
    assert.equal(items[0].formType, 'pitScouting');
    assert.equal(items[0].title, 'The pit scouting form has a new official version', 'names ONLY the form that updated');
    assert.match(items[0].detail, /2022-2023/);
    assert.match(items[0].detail, /official version 1/);
    assert.match(items[0].detail, /not based on an official version/);
    assert.deepEqual(items[0].actions, ['Accept new form', 'Merge', 'Keep my form', 'View official form']);
    assert.ok(!items.some(i => /match/i.test(i.title)), 'no match line');
    assert.equal(await itemCount(mem), 0, 'a plain member never sees the notice');
    assert.ok(await mem.isHidden('#official-forms-notice-myteam'), 'not even the empty container shows for a plain member');
    // Belt and braces: even with the official forms loaded for them (the listener is normally only started for
    // editors), a plain member is shown nothing.
    await mem.evaluate(() => startWatchingOfficialForms());
    await mem.waitForFunction(() => officialForms.size > 0);
    assert.equal(await itemCount(mem), 0, 'a plain member sees no notice even with the official form loaded');
    assert.ok(await mem.isHidden('#official-forms-account-card'));
    assert.equal((await noticeItems(edi))[0].title, 'The pit scouting form has a new official version', 'a member with Edit templates sees it');
    // Nothing on the team changed (never a silent switch, not even for a team with no entries).
    const pitAfterPublish = await readFormConfig(cap, teamId, SEASON, 'pitScouting');
    assert.deepEqual(ids(pitAfterPublish.fields), ids(genericPit), 'the team form is untouched by a publish');
    assert.equal(pitAfterPublish.baseVersion, undefined);

    // ---------- publish MATCH: both show; a pit republish REPLACES (no duplicate) ----------
    assert.equal(await publishOfficialForm(adminPage, { season: SEASON, formType: 'matchScouting', fields: officialMatch }), 1);
    await waitItems(cap, 2);
    items = await noticeItems(cap);
    assert.deepEqual(items.map(i => i.formType), ['pitScouting', 'matchScouting'], 'pit then match, one never hides the other');
    assert.equal(items[1].title, 'The match scouting form has a new official version');
    assert.equal(await publishOfficialForm(adminPage, { season: SEASON, formType: 'pitScouting', fields: officialPit }), 2);
    await cap.waitForFunction(() => /official version 2/.test(document.querySelector('#official-forms-notice-myteam .official-notice-item[data-form-type="pitScouting"] .official-notice-detail').textContent));
    assert.equal(await itemCount(cap), 2, 'republishing pit replaced its notice instead of adding a third');

    // ---------- My Account: the same notice + a badge ----------
    assert.equal((await cap.textContent('#official-forms-nav-badge-header')).trim(), '2', 'the My Account button carries a count');
    await cap.click('#btn-open-my-account-from-dashboard');
    await cap.waitForSelector('#official-forms-account-card:not(.hidden)');
    items = await noticeItems(cap, 'account');
    assert.deepEqual(items.map(i => i.title), ['The pit scouting form has a new official version', 'The match scouting form has a new official version']);
    await cap.click('#btn-my-account-standalone-back');
    await openMyTeamTab(cap);
    await mem.click('#btn-open-my-account-from-dashboard');
    await mem.waitForTimeout(300);
    assert.ok(await mem.isHidden('#official-forms-account-card'), 'a plain member has no card on My Account');
    assert.ok(await mem.isHidden('#official-forms-nav-badge-header'), 'and no badge');
    await mem.click('#btn-my-account-standalone-back');

    // ---------- Keep my form (pit): no nag; the match notice stays; the official form is still reachable ----------
    await noticeButton(cap, 'pitScouting', 'keep').click();
    await waitItems(cap, 1);
    assert.equal((await noticeItems(cap))[0].formType, 'matchScouting', 'only the match notice is left');
    await cap.waitForFunction(() => /Keeping your pit scouting form/.test(document.getElementById('official-forms-myteam-success').textContent));
    let pitCfg = await readFormConfig(cap, teamId, SEASON, 'pitScouting');
    assert.equal(pitCfg.handledVersion, 2, 'handledVersion = the official version');
    assert.deepEqual(ids(pitCfg.fields), ids(genericPit), 'Keep changes nothing on the form');
    assert.ok(pitCfg.baseVersion == null);
    assert.equal((await readSnapshots(cap, teamId, SEASON, 'pitScouting')).length, 0, 'no snapshot for a Keep');
    await cap.waitForTimeout(900);
    assert.equal(await itemCount(cap), 1, 'it does not come back by itself (no nagging)');
    // ...and it is still viewable / acceptable from the form builder.
    await openBuilderFor(cap, SEASON, 'pitScouting');
    await cap.waitForFunction(() => /Official version 2 is available/.test(document.getElementById('builder-official-text').textContent));
    assert.match(await cap.textContent('#builder-official-text'), /You chose to keep your own form/);
    await cap.click('#btn-builder-official-view');
    await cap.waitForSelector('#official-form-view-modal:not(.hidden)');
    assert.match(await cap.textContent('#official-view-info'), /official version 2/);
    assert.deepEqual(await cap.$$eval('#official-view-fields .builder-field-label', els => els.map(e => e.textContent.trim())),
      ['Claimed Avg Auto Score', 'Claimed Avg Teleop Score', 'Cycle Time (s)', 'Gear Ratio', 'Notes'], 'the viewer lists the official fields');
    assert.ok(await cap.isVisible('#btn-official-view-accept') && await cap.isVisible('#btn-official-view-merge'), 'Accept / Merge are on the viewer');
    await cap.click('#btn-official-view-close-inline');
    await closeBuilder(cap);

    // ---------- the next publish brings the pit notice back ----------
    assert.equal(await publishOfficialForm(adminPage, { season: SEASON, formType: 'pitScouting', fields: officialPit }), 3);
    await waitItems(cap, 2);
    assert.deepEqual((await noticeItems(cap)).map(i => i.formType), ['pitScouting', 'matchScouting']);

    // ---------- Accept (pit): snapshot first, retired fields, notice gone ----------
    await noticeButton(cap, 'pitScouting', 'accept').click();
    await cap.waitForSelector('#generic-confirm-modal:not(.hidden)');
    assert.match(await cap.textContent('#generic-confirm-message'), /official version 3 \(1 field added, 2 removed, 1 changed\)/);
    assert.match(await cap.textContent('#generic-confirm-message'), /Restore previous form/);
    // Cancel changes nothing.
    await cap.click('#btn-generic-confirm-cancel');
    await cap.waitForTimeout(500);
    assert.deepEqual(ids((await readFormConfig(cap, teamId, SEASON, 'pitScouting')).fields), ids(genericPit), 'Cancel on the confirm changed nothing');
    assert.equal((await readSnapshots(cap, teamId, SEASON, 'pitScouting')).length, 0);
    await noticeButton(cap, 'pitScouting', 'accept').click();
    await confirmGeneric(cap);
    await waitItems(cap, 1);
    assert.equal((await noticeItems(cap))[0].formType, 'matchScouting');
    pitCfg = await readFormConfig(cap, teamId, SEASON, 'pitScouting');
    assert.deepEqual(ids(pitCfg.fields), ['claimedAvgAutoScore', 'claimedAvgTeleopScore', 'claimedCycleTime', 'gearRatio', 'notes'], 'the form is now the official one');
    assert.equal(pitCfg.fields.find(f => f.id === 'claimedCycleTime').label, 'Cycle Time (s)');
    assert.equal(pitCfg.baseVersion, 3);
    assert.equal(pitCfg.handledVersion, 3);
    assert.deepEqual(ids(pitCfg.retiredFields), ['driveType', 'autoCapability'], 'removed fields keep their definitions');
    assert.equal(pitCfg.retiredFields.find(f => f.id === 'driveType').required, true, 'the stored definition is kept as it was (it WAS required)');
    assert.deepEqual(pitCfg.retiredFields.find(f => f.id === 'driveType').options.length > 0, true);
    let snaps = await readSnapshots(cap, teamId, SEASON, 'pitScouting');
    assert.equal(snaps.length, 1, 'ONE snapshot of the previous form');
    assert.equal(snaps[0].action, 'accept');
    assert.equal(snaps[0].appliedVersion, 3);
    assert.deepEqual(ids(snaps[0].fields), ids(genericPit), 'the snapshot is the old form');
    assert.equal(snaps[0].createdBy, captain.uid);
    assert.equal(snaps[0].baseVersion, null);
    assert.equal(snaps[0].handledVersion, 2, 'the old handledVersion (from the Keep) is in the snapshot');
    assert.equal((await readFormConfig(cap, teamId, SEASON, 'matchScouting')).handledVersion, undefined, 'the match form is untouched');

    // ---------- Restore previous form ----------
    await openBuilderFor(cap, SEASON, 'pitScouting');
    assert.deepEqual(await builderLabels(cap), ['Claimed Avg Auto Score', 'Claimed Avg Teleop Score', 'Cycle Time (s)', 'Gear Ratio', 'Notes']);
    await cap.waitForFunction(() => /^Your form matches official version 3\./.test(document.getElementById('builder-official-text').textContent));
    await cap.waitForSelector('#btn-builder-restore-previous:not(.hidden)');
    await cap.click('#btn-builder-restore-previous');
    await cap.waitForSelector('#generic-confirm-modal:not(.hidden)');
    assert.match(await cap.textContent('#generic-confirm-message'), /before accepting the official form by Captain Notice/);
    await cap.click('#btn-generic-confirm-cancel');
    await cap.waitForTimeout(500);
    assert.deepEqual(ids((await readFormConfig(cap, teamId, SEASON, 'pitScouting')).fields), ids(pitCfg.fields), 'Cancel on Restore changes nothing');
    await cap.click('#btn-builder-restore-previous');
    await confirmGeneric(cap);
    await cap.waitForFunction((n) => document.querySelectorAll('#builder-field-list .builder-field-item').length === n, genericPit.length);
    assert.deepEqual(await builderLabels(cap), genericPitLabels, 'the builder shows the old form again');
    pitCfg = await readFormConfig(cap, teamId, SEASON, 'pitScouting');
    assert.deepEqual(ids(pitCfg.fields), ids(genericPit));
    assert.ok(pitCfg.baseVersion == null, 'baseVersion goes back with the restored form');
    assert.equal(pitCfg.handledVersion, 3, 'restoring is not a new decision: no notice comes back for version 3');
    assert.deepEqual(pitCfg.retiredFields, [], 'retired fields go back to what they were');
    snaps = await readSnapshots(cap, teamId, SEASON, 'pitScouting');
    assert.equal(snaps.length, 2, 'the form that was replaced by the restore is saved too');
    assert.equal(snaps[1].action, 'restore');
    assert.deepEqual(ids(snaps[1].fields), ['claimedAvgAutoScore', 'claimedAvgTeleopScore', 'claimedCycleTime', 'gearRatio', 'notes']);
    await closeBuilder(cap);
    await openMyTeamTab(cap);
    assert.equal(await itemCount(cap), 1, 'still only the match notice');

    // ---------- a NEW team (no config at all) gets a stamped COPY, and no notice ----------
    const fresh = await ctx.newPage('fresh');
    await signInUI(fresh, captain2);
    await createTeamUI(fresh, 'Fresh Official Team');
    const freshId = await fresh.evaluate(() => currentTeamData.id);
    assert.equal(await readFormConfig(fresh, freshId, SEASON, 'pitScouting'), null, 'a new team has no config until one is created');
    await openBuilderFor(fresh, SEASON, 'pitScouting');
    assert.deepEqual(await builderLabels(fresh), ['Claimed Avg Auto Score', 'Claimed Avg Teleop Score', 'Cycle Time (s)', 'Gear Ratio', 'Notes'], 'the first config is a copy of the official form');
    let freshCfg = await readFormConfig(fresh, freshId, SEASON, 'pitScouting');
    assert.equal(freshCfg.baseVersion, 3);
    assert.equal(freshCfg.handledVersion, 3, 'stamped with the official version');
    assert.deepEqual(freshCfg.retiredFields, []);
    await openBuilderFor(fresh, SEASON, 'matchScouting');
    freshCfg = await readFormConfig(fresh, freshId, SEASON, 'matchScouting');
    assert.equal(freshCfg.baseVersion, 1);
    assert.ok(ids(freshCfg.fields).includes('intakeType') && !ids(freshCfg.fields).includes('autoScore'));
    await fresh.waitForFunction(() => /^Your form matches official version \d+\./.test(document.getElementById('builder-official-text').textContent));
    await closeBuilder(fresh);
    await openMyTeamTab(fresh);
    assert.equal(await itemCount(fresh), 0, 'a team on the latest version has no notice');
    // A season with NO official form still seeds the ordinary default.
    await openBuilderFor(fresh, '2020', 'pitScouting');
    assert.equal((await builderLabels(fresh))[0], 'Drive Type', 'no official form -> the built-in default');
    const noOfficial = await readFormConfig(fresh, freshId, '2020', 'pitScouting');
    assert.equal(noOfficial.baseVersion, undefined);
    assert.match(await fresh.textContent('#builder-official-text'), /No official form has been published/);
    await closeBuilder(fresh);
  }
};
