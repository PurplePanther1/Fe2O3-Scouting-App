// The team form builder's "Official form" bar never claims "based on the latest official version" when the form
// differs. It says how many differences there are, using the admin "See what changed" logic (official form = where it
// starts, the team's form = the draft):
//   equal form              "Your form matches official version N."                 (no "See differences" button)
//   based on version >= N   "Your form is based on official version B, with 3 differences: 1 changed, 1 added, 1 removed, 1 moved."
//   base older than latest  "Official version N is available. Your form is based on version B, with ..."
//   never based             "Official version N is available. Your form is not based on an official version, with ..."
// (zero counts are left out; "1 difference" is singular). The "See differences" button opens a READ-ONLY popup (same
// layout as the admin "See what changed"): the official form's fields as unchanged / changed (what differs) / moved /
// removed (on your form), then the fields you added. Display only: nothing is written.
// Throwaway season 2025 (no other test publishes there).

const assert = require('node:assert/strict');
const { signInUI, createTeamUI, formField, publishOfficialForm, readFormConfig, readSnapshots, openMyTeamTab, openBuilderFor, closeBuilder } = require('../lib/app');

const SEASON = '2025';
const numbered = (fields) => fields.map((f, i) => ({ ...f, sortOrder: i }));
const alpha = formField('alpha', 'Alpha', 'text');
const beta = formField('beta', 'Beta', 'dropdown', { options: ['One', 'Two'] });
const gamma = formField('gamma', 'Gamma', 'counter', { min: 0, max: 9, step: 1, assumedValue: 5 });
const delta = formField('delta', 'Delta', 'text');
const epsilon = formField('epsilon', 'Epsilon', 'text');
const zeta = formField('zeta', 'Zeta', 'text');
const OFFICIAL = [alpha, beta, gamma, delta, epsilon];

module.exports = {
  name: 'builder Official form bar: matches / based on N with differences (changed, added, removed, moved) / older base / not based; See differences popup (read-only); layout',
  async run(ctx) {
    const admin = await ctx.adminUser();
    const captain = await ctx.makeUser('Captain Differences');
    const adminPage = await ctx.newPage('admin');
    await signInUI(adminPage, admin);
    const cap = await ctx.newPage('captain');
    await signInUI(cap, captain);
    await createTeamUI(cap, 'Differences Team');
    const teamId = await cap.evaluate(() => currentTeamData.id);

    const putTeam = (fields, extra = {}) => cap.evaluate(async ([tid, f, e]) => {
      await db.collection('teams').doc(tid).collection('formConfig').doc('2025_pitScouting').set({
        fields: f, baseVersion: 1, handledVersion: 0, retiredFields: [], ...e }, { merge: true });
    }, [teamId, numbered(fields), extra]);
    const barText = () => cap.textContent('#builder-official-text').then(t => t.trim());
    const waitBar = (re) => cap.waitForFunction((src) => new RegExp(src).test(document.getElementById('builder-official-text').textContent.trim()), re.source);
    const diffBtnShown = () => cap.evaluate(() => !document.getElementById('btn-builder-official-differences').classList.contains('hidden'));

    assert.equal(await publishOfficialForm(adminPage, { season: SEASON, formType: 'pitScouting', fields: numbered(OFFICIAL) }), 1);
    await putTeam(OFFICIAL);
    await openMyTeamTab(cap);
    await openBuilderFor(cap, SEASON, 'pitScouting');

    // ---------- equal form ----------
    await waitBar(/^Your form matches official version 1\.$/);
    assert.equal(await diffBtnShown(), false, 'an equal form has no "See differences" button');

    // ---------- each kind of difference on its own ----------
    const cases = [
      ['a changed assumed value', [alpha, beta, { ...gamma, assumedValue: 3 }, delta, epsilon], 'with 1 difference: 1 changed.'],
      ['a reorder', [beta, alpha, gamma, delta, epsilon], 'with 1 difference: 1 moved.'],
      ['an added field', [...OFFICIAL, zeta], 'with 1 difference: 1 added.'],
      ['a removed field', [alpha, beta, gamma, epsilon], 'with 1 difference: 1 removed.'],
      ['two removed fields', [alpha, beta, gamma], 'with 2 differences: 2 removed.']
    ];
    for (const [label, fields, tail] of cases) {
      await putTeam(fields);
      await waitBar(new RegExp(`^Your form is based on official version 1, ${tail.replace(/[.:]/g, '\\$&')}$`));
      assert.equal(await barText(), `Your form is based on official version 1, ${tail}`, `${label}: text`);
      assert.ok(!/latest/.test(await barText()), `${label}: never "based on the latest"`);
      assert.equal(await diffBtnShown(), true, `${label}: "See differences" is offered`);
    }
    // all four at once, in the order changed, added, removed, moved
    const combined = [epsilon, alpha, { ...beta, label: 'Beta!' }, gamma, zeta];
    await putTeam(combined);
    await waitBar(/with 4 differences/);
    assert.equal(await barText(), 'Your form is based on official version 1, with 4 differences: 1 changed, 1 added, 1 removed, 1 moved.');

    // ---------- the popup (read-only) ----------
    const cfgBefore = await readFormConfig(cap, teamId, SEASON, 'pitScouting');
    const snapsBefore = (await readSnapshots(cap, teamId, SEASON, 'pitScouting')).length;
    await cap.click('#btn-builder-official-differences');
    await cap.waitForSelector('#form-differences-modal:not(.hidden)');
    assert.equal((await cap.textContent('#form-diff-title')).trim(), 'How your pit form differs');
    assert.match(await cap.textContent('#form-diff-info'), /compared with official version 1\. Nothing here changes your form\./);
    assert.equal((await cap.textContent('#form-diff-summary')).trim(), '1 changed, 1 moved, 1 removed, 1 added, 2 unchanged');
    const rows = await cap.$$eval('#form-diff-list .admin-change-row', els => els.map(e => ({ id: e.dataset.fieldId, status: e.dataset.status, note: e.querySelector('.admin-change-status').textContent.trim() })));
    assert.deepEqual(rows.map(r => [r.id, r.status]), [['alpha', 'unchanged'], ['beta', 'changed'], ['gamma', 'unchanged'], ['delta', 'removed'], ['epsilon', 'moved'], ['zeta', 'added']],
      'the official fields in the official order with their status, then the fields you added');
    assert.equal(rows[0].note, 'Same on your form');
    assert.equal(rows[1].note, 'Changed on your form: Label');
    assert.match(rows[3].note, /^Removed on your form/);
    assert.match(rows[4].note, /^Moved on your form \(position 1\)$/);
    assert.equal(rows[5].note, 'Added by you (position 5)');
    assert.equal((await cap.textContent('#form-diff-list .admin-change-heading')).trim(), 'Fields you added');
    assert.equal(await cap.locator('#form-diff-list input, #form-diff-list select, #form-diff-list textarea').count(), 0, 'read-only: nothing to edit');
    // the counter setting is named when it is what differs
    await cap.click('#btn-form-diff-close-inline');
    await cap.waitForSelector('#form-differences-modal', { state: 'hidden' });
    await cap.waitForTimeout(700);
    assert.deepEqual(await readFormConfig(cap, teamId, SEASON, 'pitScouting'), cfgBefore, 'opening and closing the popup wrote nothing to the team form');
    await putTeam([alpha, beta, { ...gamma, assumedValue: 3 }, delta, epsilon]);
    await waitBar(/with 1 difference: 1 changed/);
    await cap.click('#btn-builder-official-differences');
    await cap.waitForSelector('#form-differences-modal:not(.hidden)');
    assert.equal(await cap.textContent('#form-diff-list [data-field-id="gamma"] .admin-change-status'), 'Changed on your form: Counter settings');
    assert.match(await cap.textContent('#form-diff-list [data-field-id="gamma"] .builder-field-meta'), /assumed 5/, 'it shows the OFFICIAL field definition');
    await cap.click('#btn-form-diff-close');
    await cap.waitForSelector('#form-differences-modal', { state: 'hidden' });
    // click-out closes it too
    await cap.click('#btn-builder-official-differences');
    await cap.waitForSelector('#form-differences-modal:not(.hidden)');
    await cap.evaluate(() => document.getElementById('form-differences-modal-overlay').click());
    await cap.waitForSelector('#form-differences-modal', { state: 'hidden' });
    await putTeam(combined);
    await waitBar(/with 4 differences/);
    assert.deepEqual(await readFormConfig(cap, teamId, SEASON, 'pitScouting'), { ...cfgBefore, fields: numbered(combined) }, 'opening / closing the popup wrote nothing');
    assert.equal((await readSnapshots(cap, teamId, SEASON, 'pitScouting')).length, snapsBefore, 'no snapshot either');

    // ---------- an older base version: the "available" wording keeps its place, the summary is added ----------
    assert.equal(await publishOfficialForm(adminPage, { season: SEASON, formType: 'pitScouting', fields: numbered(OFFICIAL) }), 2);
    await waitBar(/^Official version 2 is available\./);
    assert.equal(await barText(), 'Official version 2 is available. Your form is based on version 1, with 4 differences: 1 changed, 1 added, 1 removed, 1 moved.');
    await putTeam(OFFICIAL, { baseVersion: 1 });
    await waitBar(/^Your form matches official version 2\.$/); // an equal form matches whatever its base version was
    await putTeam([alpha, beta, { ...gamma, assumedValue: 3 }, delta, epsilon], { baseVersion: 1, handledVersion: 2 });
    await waitBar(/chose to keep/);
    assert.equal(await barText(), 'Official version 2 is available. Your form is based on version 1, with 1 difference: 1 changed. You chose to keep your own form for this version.');
    // never based on an official version
    await putTeam([alpha, beta], { baseVersion: null, handledVersion: 0 });
    await waitBar(/not based/);
    assert.equal(await barText(), 'Official version 2 is available. Your form is not based on an official version, with 3 differences: 3 removed.');
    // based on the newest version AND different
    await putTeam([alpha, beta, gamma, delta, epsilon, zeta], { baseVersion: 2, handledVersion: 0 });
    await waitBar(/^Your form is based on official version 2, /);
    assert.equal(await barText(), 'Your form is based on official version 2, with 1 difference: 1 added.');

    // ---------- layout: the bar and the popup, 320px - 1280px (popup buttons on screen at 320x480) ----------
    await putTeam(combined, { baseVersion: 2 });
    await waitBar(/with 4 differences/);
    for (const [width, height] of [[320, 480], [320, 700], [375, 700], [414, 700], [768, 800], [1280, 900]]) {
      await cap.setViewportSize({ width, height });
      await cap.waitForTimeout(120);
      const bar = await cap.evaluate(() => {
        const card = document.querySelector('#builder-modal .modal-card').getBoundingClientRect();
        const btns = ['btn-builder-official-view', 'btn-builder-official-differences', 'btn-builder-restore-previous']
          .map(id => document.getElementById(id)).filter(b => b && b.offsetParent !== null).map(b => b.getBoundingClientRect());
        const text = document.getElementById('builder-official-text');
        return { inside: btns.every(b => b.left >= card.left - 1 && b.right <= card.right + 1), n: btns.length, clip: text.scrollWidth - text.clientWidth, pageW: document.documentElement.scrollWidth, iw: window.innerWidth };
      });
      assert.ok(bar.n >= 2 && bar.inside, `${width}x${height}: the bar's buttons sit inside the builder`);
      assert.ok(bar.clip <= 1 && bar.pageW <= bar.iw + 1, `${width}x${height}: the bar text wraps, no sideways scroll`);
      await cap.evaluate(() => document.getElementById('btn-builder-official-differences').click());
      await cap.waitForSelector('#form-differences-modal:not(.hidden)');
      const pop = await cap.evaluate(() => {
        const card = document.querySelector('#form-differences-modal .modal-card').getBoundingClientRect();
        const close = document.getElementById('btn-form-diff-close-inline').getBoundingClientRect();
        const x = document.getElementById('btn-form-diff-close').getBoundingClientRect();
        const list = document.getElementById('form-diff-list');
        const lr = list.getBoundingClientRect();
        return { listInside: lr.left >= card.left - 1 && lr.right <= card.right + 1, closeInside: close.top >= 0 && close.bottom <= window.innerHeight + 1 && close.left >= 0 && close.right <= window.innerWidth + 1,
          xInside: x.top >= 0 && x.bottom <= window.innerHeight + 1, cardInside: card.left >= -1 && card.right <= window.innerWidth + 1 && card.bottom <= window.innerHeight + 1,
          listClip: list.scrollWidth - list.clientWidth, pageW: document.documentElement.scrollWidth, iw: window.innerWidth };
      });
      assert.ok(pop.closeInside && pop.xInside, `${width}x${height}: the popup's buttons stay on screen`);
      assert.ok(pop.cardInside && pop.listInside && pop.listClip <= 1 && pop.pageW <= pop.iw + 1, `${width}x${height}: the popup fits`);
      await cap.click('#btn-form-diff-close-inline');
      await cap.waitForSelector('#form-differences-modal', { state: 'hidden' });
    }
    await cap.setViewportSize({ width: 1280, height: 900 });
    await closeBuilder(cap);
  }
};
