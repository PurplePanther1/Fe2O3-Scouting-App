// Two display rules of the "new official version" notice (js/official-forms.js), on the real rules:
//   (1) a team whose form already EQUALS the official one (same ids, same order, same definitions -
//       sortOrder numbers, an absent vs default showInPreview, retiredFields and baseVersion don't
//       matter) gets NO notice even though the official version is newer; any difference brings it
//       back; and nothing is written for this (a display rule only)
//   (2) the My Team banner shows only the updates for the season selected in the app and follows
//       the selector (a pick AND a quiet restore); one line under the banner points to My Account
//       when other seasons have updates; the My Account card and its badge always show ALL of them
// A third display rule: the team form builder's "Official form" bar says "Your form matches official version N."
// when the team's fields equal the official ones, and keeps its old wording (available / based on version / kept)
// when they differ; display only, nothing is written.
// Throwaway seasons 2022 / 2023 (2024 has no official form here), so no real team is affected.

const assert = require('node:assert/strict');
const {
  signInUI, createTeamUI, formField, publishOfficialForm, readFormConfig, noticeItems, noticeButton,
  selectAppSeason, openMyTeamTab
} = require('../lib/app');

const A = '2022';
const B = '2023';
const NONE = '2024';

const putTeamForm = (page, tid, season, type, data) => page.evaluate(([teamId, id, d]) =>
  db.collection('teams').doc(teamId).collection('formConfig').doc(id).set(d), [tid, `${season}_${type}`, data]);
const patchTeamForm = (page, tid, season, type, data) => page.evaluate(([teamId, id, d]) =>
  db.collection('teams').doc(teamId).collection('formConfig').doc(id).set(d, { merge: true }), [tid, `${season}_${type}`, data]);
const numbered = (fields, step = 1) => fields.map((f, i) => ({ ...f, sortOrder: i * step }));

const waitItems = (page, n, where = 'myteam') =>
  page.waitForFunction(([c, w]) => document.querySelectorAll(`#official-forms-notice-${w} .official-notice-item`).length === c, [n, where]);
const otherLine = (page) => page.evaluate(() => {
  const el = document.getElementById('official-forms-other-seasons');
  return { hidden: el.classList.contains('hidden'), text: el.textContent.trim() };
});
const badge = (page) => page.evaluate(() => {
  const el = document.getElementById('official-forms-nav-badge-header');
  return { hidden: el.classList.contains('hidden'), text: el.textContent.trim() };
});

module.exports = {
  name: 'official forms notice rules: an identical form gets no notice (display only); My Team banner follows the selected season, My Account shows all',
  async run(ctx) {
    const admin = await ctx.adminUser();
    const captain = await ctx.makeUser('Captain Rules');
    const adminPage = await ctx.newPage('admin');
    await signInUI(adminPage, admin);
    const cap = await ctx.newPage('captain');
    await signInUI(cap, captain);
    await createTeamUI(cap, 'Official Notice Rules Team');
    const teamId = await cap.evaluate(() => currentTeamData.id);
    await openMyTeamTab(cap);

    // ================= (1) an identical form gets no notice =================
    const official = [
      formField('alpha', 'Alpha', 'text'),
      formField('beta', 'Beta', 'dropdown', { options: ['One', 'Two'], required: true }),
      formField('gamma', 'Gamma', 'counter', { min: 0, max: 9, step: 1 })
    ];
    const retiredJunk = [formField('oldOne', 'Old One', 'text')];
    // The team's copy: same fields, but different sortOrder numbers, retiredFields and baseVersion.
    const identicalTeam = numbered(official, 10);
    await putTeamForm(cap, teamId, A, 'pitScouting', { fields: identicalTeam, baseVersion: 7, handledVersion: 0, retiredFields: retiredJunk });
    assert.equal(await publishOfficialForm(adminPage, { season: A, formType: 'pitScouting', fields: numbered(official) }) >= 1, true);
    await selectAppSeason(cap, A);
    await cap.waitForFunction((s) => officialForms.has(`${s}_pitScouting`) && teamConfigDocs.has(`${s}_pitScouting`), A);
    // Give the live listeners a moment to have rendered, then: nothing shown anywhere.
    await cap.waitForTimeout(400);
    assert.equal((await noticeItems(cap)).length, 0, 'an identical form: no My Team notice');
    assert.equal((await noticeItems(cap, 'account')).length, 0, 'an identical form: nothing on My Account either');
    assert.ok(await cap.isHidden('#official-forms-notice-myteam'), 'the My Team container is hidden');
    assert.ok((await badge(cap)).hidden, 'no badge');
    const idleCfg = await readFormConfig(cap, teamId, A, 'pitScouting');
    assert.equal(idleCfg.handledVersion, 0, 'nothing was written for the hidden notice (handledVersion untouched)');
    assert.equal(idleCfg.baseVersion, 7);

    // A newer VERSION of the very same form is still nothing to decide.
    const v2 = await publishOfficialForm(adminPage, { season: A, formType: 'pitScouting', fields: numbered(official) });
    await cap.waitForFunction(([id, v]) => officialForms.get(id)?.version === v, [`${A}_pitScouting`, v2]);
    await cap.waitForTimeout(300);
    assert.equal((await noticeItems(cap)).length, 0, 'a newer version with identical fields: still no notice');

    // Default vs absent showInPreview / false-valued optional keys are the same field.
    const looseTeam = numbered(official).map((f) => { const { showInPreview, ...rest } = f; return { ...rest, required: !!f.required }; });
    await patchTeamForm(cap, teamId, A, 'pitScouting', { fields: looseTeam });
    await cap.waitForTimeout(400);
    assert.equal((await noticeItems(cap)).length, 0, 'absent showInPreview / required:false are the same as the defaults');

    // ---- the builder's "Official form" bar: "matches" when equal, the old wording when not ----
    const barText = (page) => page.textContent('#builder-official-text').then((t) => t.trim());
    const waitBar = (page, re) => page.waitForFunction((src) => new RegExp(src).test(document.getElementById('builder-official-text').textContent.trim()), re.source);
    const officialNow = await cap.evaluate((id) => officialForms.get(id).version, `${A}_pitScouting`);
    // handledVersion above the official version too: the "You chose to keep..." suffix must NOT be added to the match wording
    await patchTeamForm(cap, teamId, A, 'pitScouting', { handledVersion: 999 });
    const cfgBefore = await readFormConfig(cap, teamId, A, 'pitScouting');
    await cap.click('#btn-open-form-builder');
    await cap.waitForSelector('#builder-modal:not(.hidden)');
    await cap.selectOption('#builder-season-select', A);
    await cap.waitForFunction((s) => currentBuilderSeason === s && !document.getElementById('builder-field-list').textContent.includes('Loading'), A);
    await waitBar(cap, /^Your form matches official version/);
    assert.equal(await barText(cap), `Your form matches official version ${officialNow}.`, 'equal fields: the matches wording, nothing appended');
    assert.equal(await cap.isDisabled('#btn-builder-official-view'), false, 'the Official form button stays');
    // Live: a difference switches to the old wording (based on version 1, kept because handledVersion is high), undoing it switches back.
    await patchTeamForm(cap, teamId, A, 'pitScouting', { baseVersion: 1, fields: numbered([...official, formField('extra', 'Extra', 'text')]) });
    await waitBar(cap, /^Official version \d+ is available\./);
    assert.equal(await barText(cap), `Official version ${officialNow} is available. Your form is based on version 1, with 1 difference: 1 added. You chose to keep your own form for this version.`, 'different fields: the existing wording plus the differences summary');
    assert.equal(await cap.isDisabled('#btn-builder-official-view'), false);
    await patchTeamForm(cap, teamId, A, 'pitScouting', { fields: numbered(official, 5) });
    await waitBar(cap, /^Your form matches official version/);
    // Never based on an official version + different: the original "not based" wording.
    await patchTeamForm(cap, teamId, A, 'pitScouting', { baseVersion: null, fields: numbered([official[0]]) , handledVersion: 0 });
    await waitBar(cap, /^Official version \d+ is available\./);
    assert.equal(await barText(cap), `Official version ${officialNow} is available. Your form is not based on an official version, with 2 differences: 2 removed.`);
    // Same fields but never based on an official version: it is a match all the same.
    await patchTeamForm(cap, teamId, A, 'pitScouting', { fields: numbered(official) });
    await waitBar(cap, /^Your form matches official version/);
    assert.equal(await barText(cap), `Your form matches official version ${officialNow}.`, 'a form that merely equals the official one matches even if it was never accepted');
    // Display only: only the values this test wrote are there (nothing from the bar).
    const cfgAfter = await readFormConfig(cap, teamId, A, 'pitScouting');
    assert.equal(cfgAfter.handledVersion, 0);
    assert.equal(cfgAfter.baseVersion, null);
    assert.deepEqual(cfgAfter.retiredFields, cfgBefore.retiredFields);
    await cap.click('#btn-builder-close');
    await cap.waitForSelector('#builder-modal', { state: 'hidden' });
    // restore the state the rest of this test expects
    await patchTeamForm(cap, teamId, A, 'pitScouting', { baseVersion: 7, handledVersion: 0, fields: numbered(official, 5) });
    await cap.waitForTimeout(300);

    // Any difference brings the notice back; undoing it hides it again.
    const variants = {
      'a changed label': official.map((f) => (f.id === 'alpha' ? { ...f, label: 'Alpha!' } : f)),
      'a changed option': official.map((f) => (f.id === 'beta' ? { ...f, options: ['One', 'Three'] } : f)),
      'a changed required flag': official.map((f) => (f.id === 'alpha' ? { ...f, required: true } : f)),
      'a changed type': official.map((f) => (f.id === 'alpha' ? { ...f, type: 'number' } : f)),
      'a changed preview flag': official.map((f) => (f.id === 'alpha' ? { ...f, showInPreview: false } : f)),
      'a changed counter setting': official.map((f) => (f.id === 'gamma' ? { ...f, max: 10 } : f)),
      'a different order': [official[1], official[0], official[2]],
      'a removed field': [official[0], official[2]],
      'a removed LAST field (the team form is a prefix of the official one)': [official[0], official[1]],
      'an added field': [...official, formField('delta', 'Delta', 'text')],
      'a renamed id': official.map((f) => (f.id === 'alpha' ? { ...f, id: 'alpha2' } : f))
    };
    for (const [label, fields] of Object.entries(variants)) {
      await patchTeamForm(cap, teamId, A, 'pitScouting', { fields: numbered(fields) });
      await waitItems(cap, 1);
      assert.equal((await noticeItems(cap))[0].formType, 'pitScouting', `${label}: the notice is back`);
      await patchTeamForm(cap, teamId, A, 'pitScouting', { fields: numbered(official, 5) });
      await waitItems(cap, 0);
    }

    // ================= (2) the notice follows the selected season =================
    // Season A: pit (different team form). Season B: pit + match (different team forms).
    const teamDiffers = numbered([...official, formField('extra', 'Extra', 'text')]);
    await patchTeamForm(cap, teamId, A, 'pitScouting', { fields: teamDiffers, handledVersion: 0 });
    for (const type of ['pitScouting', 'matchScouting']) {
      await putTeamForm(cap, teamId, B, type, { fields: teamDiffers, baseVersion: null, handledVersion: 0, retiredFields: [] });
      await publishOfficialForm(adminPage, { season: B, formType: type, fields: numbered(official) });
    }
    await cap.waitForFunction(([a, b]) => officialForms.has(`${a}_pitScouting`) && officialForms.has(`${b}_matchScouting`) && teamConfigDocs.has(`${b}_matchScouting`), [A, B]);

    // Selected season A: just A's pit form; one line says other seasons have updates too.
    await selectAppSeason(cap, A);
    await waitItems(cap, 1);
    assert.deepEqual((await noticeItems(cap)).map((i) => i.formType), ['pitScouting']);
    assert.match((await noticeItems(cap))[0].detail, /2022-2023/, 'the My Team notice is season A\'s');
    let line = await otherLine(cap);
    assert.equal(line.hidden, false, 'a line points to the other season');
    assert.match(line.text, /My Account/);
    assert.match(line.text, /^Another season also has a new official form/);
    // ...directly under the banner.
    assert.ok(await cap.evaluate(() => document.getElementById('official-forms-notice-myteam').nextElementSibling.id === 'official-forms-other-seasons'), 'the line sits right under the banner');
    // My Account and the badge keep ALL three.
    await waitItems(cap, 3, 'account');
    assert.deepEqual((await noticeItems(cap, 'account')).map((i) => i.formType), ['pitScouting', 'matchScouting', 'pitScouting'], 'newest season first: B pit, B match, A pit');
    assert.deepEqual(await badge(cap), { hidden: false, text: '3' }, 'the badge counts every season');

    // Selected season B: both of B's forms, and the line now points at A.
    await selectAppSeason(cap, B);
    await waitItems(cap, 2);
    assert.deepEqual((await noticeItems(cap)).map((i) => i.formType), ['pitScouting', 'matchScouting']);
    assert.ok((await noticeItems(cap)).every((i) => /2023-2024/.test(i.detail)));
    assert.match((await otherLine(cap)).text, /^Another season also has/);
    assert.equal((await noticeItems(cap, 'account')).length, 3, 'My Account still lists all three');
    assert.equal((await badge(cap)).text, '3');

    // A season with nothing pending: no banner at all, but the line still points at the others.
    await selectAppSeason(cap, NONE);
    await waitItems(cap, 0);
    assert.ok(await cap.isHidden('#official-forms-notice-myteam'), 'no banner for a season with no update');
    line = await otherLine(cap);
    assert.equal(line.hidden, false);
    assert.match(line.text, /^2 other seasons also have a new official form\. See My Account\.$/);
    assert.equal((await noticeItems(cap, 'account')).length, 3);

    // A quiet restore (no 'change' event, like opening a team / restoring a saved season) re-renders too.
    await cap.evaluate((s) => setAppSeasonQuietly(s), B);
    await waitItems(cap, 2);
    await cap.evaluate((s) => setAppSeasonQuietly(s), A);
    await waitItems(cap, 1);

    // The builder's own season picker does NOT move the banner (it is the app's selected season).
    await cap.click('#btn-open-form-builder');
    await cap.waitForSelector('#builder-modal:not(.hidden)');
    await cap.selectOption('#builder-season-select', B);
    await cap.waitForFunction(() => currentBuilderSeason === '2023');
    assert.equal((await noticeItems(cap)).length, 1, 'the banner still follows the app season (A), not the builder\'s');
    await cap.click('#btn-builder-close');
    await cap.waitForSelector('#builder-modal', { state: 'hidden' });

    // Acting on a notice updates the line and the badge: Keep season A's pit form.
    await noticeButton(cap, 'pitScouting', 'keep').click();
    await waitItems(cap, 0);
    await waitItems(cap, 2, 'account');
    assert.equal((await badge(cap)).text, '2');
    line = await otherLine(cap);
    assert.match(line.text, /^Another season also has/, 'now only season B is "another season"');

    // With nothing pending anywhere, the line is gone too.
    await selectAppSeason(cap, B);
    await waitItems(cap, 2);
    await noticeButton(cap, 'pitScouting', 'keep').click();
    await waitItems(cap, 1);
    await noticeButton(cap, 'matchScouting', 'keep').click();
    await waitItems(cap, 0);
    await cap.waitForFunction(() => document.querySelectorAll('#official-forms-notice-account .official-notice-item').length === 0);
    assert.ok((await otherLine(cap)).hidden, 'nothing pending anywhere: no line');
    assert.ok((await badge(cap)).hidden, 'nothing pending anywhere: no badge');
  }
};
