// The admin screen's DRAFT AUTOSAVE and "See what changed" (js/official-form-admin.js), on the real rules:
//   - an edit is saved to officialFormDrafts/{season}_{formType} about a second later (debounced: a burst of
//     edits is ONE write), the panel shows "Saving..." then "Draft saved", and the doc has exactly
//     { fields, basisVersion, updatedAt, updatedBy }
//   - closing the screen needs no prompt once saved; reopening brings the draft back; a clean draft has no doc
//   - "Discard my changes" deletes the doc; a successful Publish deletes it
//   - a published version that moved past the draft's basisVersion keeps the warning + discard (also after reopening)
//   - a draft the rules refuse (101 fields: the real rules cap a draft at 100) shows "Not saved: changes are only
//     kept while this screen is open", keeps working in memory, closing asks first, and Discard still works
//   - "See what changed": hidden while the draft equals where it started; otherwise a read-only popup of the
//     STARTING version in its original order with unchanged / changed (what) / moved / removed, then the added
//     fields; opening and closing it never touches the draft
// Throwaway seasons: 2020 (never published: starts from the built-in default), 2022 (published here).

const assert = require('node:assert/strict');
const { signInUI, formField, publishOfficialForm, confirmGeneric } = require('../lib/app');

const labels = (page) => page.$$eval('#builder-field-list .builder-field-label', els => els.map(e => e.textContent.trim()));
const waitLabels = (page, expected) => page.waitForFunction((want) => {
  const got = [...document.querySelectorAll('#builder-field-list .builder-field-label')].map(e => e.textContent.trim());
  return got.length === want.length && got.every((l, i) => l === want[i]);
}, expected);
const saveText = (page) => page.evaluate(() => {
  const el = document.getElementById('admin-save-state');
  return el.classList.contains('hidden') ? '' : el.textContent.trim();
});
const waitSave = (page, text) => page.waitForFunction((t) => {
  const el = document.getElementById('admin-save-state');
  return !el.classList.contains('hidden') && el.textContent.trim() === t;
}, text);
const draftDoc = (page, id) => page.evaluate(async (docId) => {
  const snap = await db.collection('officialFormDrafts').doc(docId).get();
  if (!snap.exists) return null;
  const d = snap.data();
  return { keys: Object.keys(d).sort(), ids: d.fields.map(f => f.id), labels: d.fields.map(f => f.label), basisVersion: d.basisVersion, updatedBy: d.updatedBy, hasTime: !!(d.updatedAt && d.updatedAt.toMillis) };
}, id);

async function openAdmin(page, season, type = 'pitScouting') {
  await page.click('#btn-open-admin-from-team');
  await page.waitForSelector('#builder-modal:not(.hidden)');
  await page.selectOption('#builder-season-select', season);
  if (type !== 'pitScouting') await page.click(`.builder-type-tab[data-builder-type="${type}"]`);
  await page.waitForFunction(([s, t]) => currentBuilderSeason === s && currentFormBuilderType === t
    && adminDrafts.has(adminFormId(s, t))
    && !document.getElementById('builder-field-list').textContent.includes('Loading')
    && !/Loading/.test(document.getElementById('admin-draft-state').textContent), [season, type]);
}
const closeAdmin = async (page) => {
  await page.click('#btn-builder-close');
  await page.waitForSelector('#builder-modal', { state: 'hidden' });
};
async function addFieldUI(page, label) {
  await page.click('#btn-builder-add-field');
  await page.waitForSelector('#field-editor-modal:not(.hidden)');
  await page.fill('#bld-field-label', label);
  await page.selectOption('#bld-field-type', 'number');
  await page.setChecked('#bld-field-show-in-preview', false);
  await page.click('#btn-bld-save');
  await page.waitForSelector('#field-editor-modal', { state: 'hidden' });
  await page.waitForFunction((l) => [...document.querySelectorAll('#builder-field-list .builder-field-label')].some(e => e.textContent.trim() === l), label);
}
const row = (page, label) => page.locator('#builder-field-list .builder-field-item', { hasText: label });

module.exports = {
  name: 'official forms admin draft: autosave (debounced, Saving/Draft saved, restored on reopen, deleted on Discard/Publish, refused = Not saved), See what changed',
  async run(ctx) {
    const admin = await ctx.adminUser();
    const pageB = await ctx.newPage('adminB');   // a second window of the same admin: publishes "elsewhere"
    await signInUI(pageB, admin);
    const page = await ctx.newPage('admin');
    await signInUI(page, admin);

    // ============ autosave, season 2020 (never published: starts from the built-in default) ============
    await openAdmin(page, '2020');
    assert.equal(await saveText(page), '', 'nothing to say about a draft that has no changes');
    assert.ok(await page.isHidden('#btn-admin-changes'), '"See what changed" is hidden while the draft equals where it started');
    assert.equal(await draftDoc(page, '2020_pitScouting'), null, 'opening the screen saves nothing');
    // Watch the status line and count the writes.
    await page.evaluate(() => {
      window.__texts = [];
      new MutationObserver(() => {
        const el = document.getElementById('admin-save-state');
        window.__texts.push(el.classList.contains('hidden') ? '' : el.textContent.trim());
      }).observe(document.getElementById('admin-save-state'), { childList: true, characterData: true, subtree: true, attributes: true });
      window.__calls = [];
      const real = adminDraftRef;
      window.adminDraftRef = (id) => {
        const r = real(id);
        return { get: () => r.get(), set: (d) => { window.__calls.push('set'); return r.set(d); }, delete: () => { window.__calls.push('delete'); return r.delete(); } };
      };
    });

    // A burst of three edits through the builder's own edit hook = ONE write, about a second later.
    await page.evaluate(() => {
      for (let i = 1; i <= 3; i++) {
        const fields = [...getAdminDraftFields('2020', 'pitScouting'), { id: `burst${i}`, label: `Burst ${i}`, type: 'text', required: false, sortOrder: 0, showInPreview: false }];
        setAdminDraftFields('2020', 'pitScouting', fields);
      }
      window.__burstAt = Date.now();
    });
    assert.equal(await saveText(page), 'Saving...', 'right after an edit: Saving...');
    assert.equal(await draftDoc(page, '2020_pitScouting'), null, 'nothing is written immediately (debounced)');
    await waitSave(page, 'Draft saved');
    const waited = await page.evaluate(() => Date.now() - window.__burstAt);
    assert.ok(waited >= 800, `the save waited about a second after the last edit (${waited}ms)`);
    assert.deepEqual(await page.evaluate(() => window.__calls), ['set'], 'three quick edits are ONE write');
    const doc1 = await draftDoc(page, '2020_pitScouting');
    assert.deepEqual(doc1.keys, ['basisVersion', 'fields', 'updatedAt', 'updatedBy'], 'exactly the four allowed keys');
    assert.equal(doc1.basisVersion, 0, 'started from nothing published');
    assert.equal(doc1.updatedBy, admin.uid);
    assert.ok(doc1.hasTime);
    assert.deepEqual(doc1.ids.slice(-3), ['burst1', 'burst2', 'burst3']);
    const texts = await page.evaluate(() => window.__texts.filter(Boolean));
    assert.ok(texts.indexOf('Saving...') >= 0 && texts.lastIndexOf('Draft saved') > texts.indexOf('Saving...'), `status went Saving... -> Draft saved (${texts.join(' | ')})`);
    assert.ok(await page.isVisible('#btn-admin-changes'), 'a changed draft offers "See what changed"');

    // An edit through the real UI saves too.
    await addFieldUI(page, 'Gear Ratio');
    await waitSave(page, 'Draft saved');
    assert.ok((await draftDoc(page, '2020_pitScouting')).labels.includes('Gear Ratio'));

    // Close (no prompt: it is saved), reopen: the draft is back, with its state.
    await closeAdmin(page);
    assert.ok(await page.isHidden('#generic-confirm-modal'), 'no discard prompt when everything is saved');
    await openAdmin(page, '2020');
    assert.ok((await labels(page)).includes('Gear Ratio') && (await labels(page)).includes('Burst 3'), 'the saved draft is restored');
    assert.match(await page.textContent('#admin-draft-state'), /unpublished changes/);
    assert.equal(await saveText(page), 'Draft saved', 'a restored draft says it is saved');
    assert.ok(await page.isVisible('#btn-admin-changes'));
    assert.match(await page.textContent('#btn-admin-publish'), /Publish version 1/);

    // Closing right after an edit (before the second is up) flushes the save first: no prompt, nothing lost.
    await addFieldUI(page, 'Late Edit');
    await closeAdmin(page);
    assert.ok(await page.isHidden('#generic-confirm-modal'), 'closing right after an edit saves it instead of asking');
    assert.ok((await draftDoc(page, '2020_pitScouting')).labels.includes('Late Edit'), 'the late edit made it into the saved draft');

    // Discard my changes: deletes the doc and starts again from the default.
    await openAdmin(page, '2020');
    await page.evaluate(() => { window.__calls = []; const real = adminDraftRef; window.adminDraftRef = (id) => { const r = real(id); return { get: () => r.get(), set: (d) => { window.__calls.push('set'); return r.set(d); }, delete: () => { window.__calls.push('delete'); return r.delete(); } }; }; });
    await page.click('#btn-admin-reset');
    await page.waitForFunction(() => /built-in default/.test(document.getElementById('admin-draft-state').textContent));
    assert.equal(await draftDoc(page, '2020_pitScouting'), null, 'Discard deleted the saved draft');
    assert.ok(!(await labels(page)).includes('Gear Ratio'));
    assert.ok(await page.isHidden('#btn-admin-changes') && await page.isHidden('#btn-admin-reset'));
    assert.equal(await saveText(page), '');
    await closeAdmin(page);
    await openAdmin(page, '2020');
    assert.ok(!(await labels(page)).includes('Gear Ratio'), 'a discarded draft does not come back');
    await closeAdmin(page);

    // ============ a published form (2022): a draft from it, Publish deletes the draft ============
    const baseA = [formField('a', 'Field A', 'text', { showInPreview: false }), formField('b', 'Field B', 'text', { showInPreview: false }),
      formField('c', 'Field C', 'text', { showInPreview: false }), formField('d', 'Field D', 'text', { showInPreview: false }), formField('e', 'Field E', 'text', { showInPreview: false })];
    const v1 = await publishOfficialForm(pageB, { season: '2022', formType: 'pitScouting', fields: baseA });
    await openAdmin(page, '2022');
    await waitLabels(page, ['Field A', 'Field B', 'Field C', 'Field D', 'Field E']);
    assert.match(await page.textContent('#admin-draft-state'), /No changes since the published version/);
    assert.ok(await page.isHidden('#btn-admin-changes'));

    // ---- "See what changed": edit, remove, move, add ----
    await row(page, 'Field B').locator('button', { hasText: 'Edit' }).click();
    await page.waitForSelector('#field-editor-modal:not(.hidden)');
    await page.fill('#bld-field-label', 'Field B2');
    await page.click('#btn-bld-save');
    await page.waitForSelector('#field-editor-modal', { state: 'hidden' });
    await waitLabels(page, ['Field A', 'Field B2', 'Field C', 'Field D', 'Field E']);
    await row(page, 'Field C').locator('button', { hasText: '✕' }).click();
    await confirmGeneric(page);
    await waitLabels(page, ['Field A', 'Field B2', 'Field D', 'Field E']);
    await row(page, 'Field E').locator('.btn-move-up').click();
    await waitLabels(page, ['Field A', 'Field B2', 'Field E', 'Field D']);
    await row(page, 'Field E').locator('.btn-move-up').click();
    await waitLabels(page, ['Field A', 'Field E', 'Field B2', 'Field D']);
    await addFieldUI(page, 'Field F');
    await waitLabels(page, ['Field A', 'Field E', 'Field B2', 'Field D', 'Field F']);
    await waitSave(page, 'Draft saved');
    const before = await page.evaluate(() => JSON.stringify(adminDrafts.get('2022_pitScouting').fields));
    const docBefore = await draftDoc(page, '2022_pitScouting');
    assert.equal(docBefore.basisVersion, v1);

    await page.click('#btn-admin-changes');
    await page.waitForSelector('#admin-changes-modal:not(.hidden)');
    const shown = await page.$$eval('#admin-changes-list .admin-change-row', els => els.map(e => ({
      label: e.querySelector('.builder-field-label').textContent.trim(), status: e.dataset.status, text: e.querySelector('.admin-change-status').textContent.trim()
    })));
    assert.deepEqual(shown, [
      { label: 'Field A', status: 'unchanged', text: 'Unchanged' },
      { label: 'Field B', status: 'changed', text: 'Changed: Label' },
      { label: 'Field C', status: 'removed', text: 'Removed in the draft' },
      { label: 'Field D', status: 'unchanged', text: 'Unchanged' },
      { label: 'Field E', status: 'moved', text: 'Moved (now position 2)' },
      { label: 'Field F', status: 'added', text: 'Added (position 5)' }
    ], 'the STARTING version in its original order (B and C still under their old names), then the added field');
    assert.equal(await page.textContent('#admin-changes-list .admin-change-heading'), 'Added in the draft');
    assert.match(await page.textContent('#admin-changes-info'), new RegExp(`published version ${v1}`));
    assert.equal((await page.textContent('#admin-changes-summary')).trim(), '1 changed, 1 moved, 1 removed, 1 added, 2 unchanged');
    // Read-only: no inputs or editing buttons in the list.
    assert.equal(await page.locator('#admin-changes-list button, #admin-changes-list input, #admin-changes-list select').count(), 0);
    // Closing it (X, Close, overlay) changes nothing.
    for (const how of ['#btn-admin-changes-close', '#btn-admin-changes-close-inline']) {
      await page.click(how);
      await page.waitForSelector('#admin-changes-modal', { state: 'hidden' });
      await page.click('#btn-admin-changes');
      await page.waitForSelector('#admin-changes-modal:not(.hidden)');
    }
    await page.mouse.click(4, 4);
    await page.waitForSelector('#admin-changes-modal', { state: 'hidden' });
    assert.equal(await page.evaluate(() => JSON.stringify(adminDrafts.get('2022_pitScouting').fields)), before, 'viewing what changed does not change the draft');
    assert.deepEqual(await draftDoc(page, '2022_pitScouting'), docBefore, 'nor the saved draft');
    assert.ok(await page.isVisible('#btn-admin-reset') && await page.isEnabled('#btn-admin-publish'));

    // The pure comparison, edge cases (identical, reversed, everything removed, changed AND moved).
    const edge = await page.evaluate(() => {
      const f = (id, extra = {}) => ({ id, label: id.toUpperCase(), type: 'text', required: false, sortOrder: 0, showInPreview: true, ...extra });
      const base = [f('a'), f('b'), f('c')];
      const summarize = (r) => r.rows.map(x => adminChangeStatusParts(x).text).concat(r.added.map(x => `+${x.field.id}@${x.position}`));
      return {
        identical: summarize(describeDraftChanges(base, base.map(x => ({ ...x })))),
        reversed: summarize(describeDraftChanges(base, [base[2], base[1], base[0]])),
        allGone: summarize(describeDraftChanges(base, [])),
        changedAndMoved: summarize(describeDraftChanges(base, [f('b'), f('c'), f('a', { required: true })])),
        sortOrderOnly: summarize(describeDraftChanges(base, base.map((x, i) => ({ ...x, sortOrder: 10 * i, showInPreview: undefined })))),
        empty: summarize(describeDraftChanges([], [f('z')]))
      };
    });
    assert.deepEqual(edge.identical, ['Unchanged', 'Unchanged', 'Unchanged']);
    assert.deepEqual(edge.reversed, ['Unchanged', 'Moved (now position 2)', 'Moved (now position 1)'], 'a reversed list: the longest ordered run stays, the others are "moved"');
    assert.deepEqual(edge.allGone, ['Removed in the draft', 'Removed in the draft', 'Removed in the draft']);
    assert.deepEqual(edge.changedAndMoved, ['Changed: Required · Moved (now position 3)', 'Unchanged', 'Unchanged'], 'a field can be both changed and moved');
    assert.deepEqual(edge.sortOrderOnly, ['Unchanged', 'Unchanged', 'Unchanged'], 'sortOrder numbers and a default showInPreview are not differences');
    assert.deepEqual(edge.empty, ['+z@1']);

    // ---- the published version moves on elsewhere: warning + discard stay, also after a reopen ----
    const v2 = await publishOfficialForm(pageB, { season: '2022', formType: 'pitScouting', fields: [...baseA, formField('g', 'Field G', 'text', { showInPreview: false })] });
    await page.waitForFunction((v) => /was published since you started this draft/.test(document.getElementById('admin-draft-state').textContent) && officialForms.get('2022_pitScouting').version === v, v2);
    assert.ok(await page.isDisabled('#btn-admin-publish'), 'Publish is off while the draft is based on an older version');
    assert.ok(await page.isVisible('#btn-admin-reset'));
    await closeAdmin(page);
    await openAdmin(page, '2022');
    assert.match(await page.textContent('#admin-draft-state'), /was published since you started this draft/, 'the saved draft still knows its basis');
    assert.ok(await page.isDisabled('#btn-admin-publish'));
    await waitLabels(page, ['Field A', 'Field E', 'Field B2', 'Field D', 'Field F']);
    // "See what changed" still compares with the version the draft STARTED from (v1, from the history), not the newer one.
    await page.click('#btn-admin-changes');
    await page.waitForSelector('#admin-changes-modal:not(.hidden)');
    assert.match(await page.textContent('#admin-changes-info'), new RegExp(`published version ${v1}`));
    assert.deepEqual(await page.$$eval('#admin-changes-list .admin-change-row', els => els.map(e => e.dataset.status)), ['unchanged', 'changed', 'removed', 'unchanged', 'moved', 'added']);
    await page.click('#btn-admin-changes-close-inline');
    await page.click('#btn-admin-reset');
    await waitLabels(page, ['Field A', 'Field B', 'Field C', 'Field D', 'Field E', 'Field G']);
    assert.equal(await draftDoc(page, '2022_pitScouting'), null, 'Discard deleted the stale saved draft');
    assert.match(await page.textContent('#admin-draft-state'), /No changes since the published version/);

    // ---- Publish deletes the saved draft ----
    await addFieldUI(page, 'Field H');
    await waitSave(page, 'Draft saved');
    assert.notEqual(await draftDoc(page, '2022_pitScouting'), null);
    await page.click('#btn-admin-publish');
    await confirmGeneric(page);
    await page.waitForFunction(() => /Published version \d+\./.test(document.getElementById('builder-success').textContent));
    await page.waitForFunction(() => /No changes since the published version/.test(document.getElementById('admin-draft-state').textContent));
    assert.equal(await draftDoc(page, '2022_pitScouting'), null, 'a successful Publish deleted the saved draft');
    assert.equal(await saveText(page), '');
    assert.ok(await page.isHidden('#btn-admin-changes'), 'after publishing the draft equals the published version again');
    await closeAdmin(page);
    await openAdmin(page, '2022');
    assert.ok((await labels(page)).includes('Field H'), 'the next draft starts from what was published');
    assert.match(await page.textContent('#admin-draft-state'), /No changes since the published version/);
    await closeAdmin(page);

    // ============ a draft the rules refuse: "Not saved", kept in memory, closing asks, Discard still works ============
    await openAdmin(page, '2020');
    await page.evaluate(() => {
      window.__calls = [];
      const real = adminDraftRef;
      window.adminDraftRef = (id) => { const r = real(id); return { get: () => r.get(), set: (d) => { window.__calls.push('set'); return r.set(d); }, delete: () => { window.__calls.push('delete'); return r.delete(); } }; };
      // 101 fields: over the 100 the real rules allow, so the write is genuinely refused (permission-denied).
      const fields = Array.from({ length: 101 }, (_, i) => ({ id: `big${i}`, label: `Big ${i}`, type: 'text', required: false, sortOrder: i, showInPreview: false }));
      setAdminDraftFields('2020', 'pitScouting', fields);
    });
    await waitSave(page, 'Not saved: changes are only kept while this screen is open');
    assert.ok(await page.locator('#admin-save-state').evaluate(el => el.classList.contains('official-admin-warning')), 'the message is highlighted');
    assert.equal(await draftDoc(page, '2020_pitScouting'), null, 'nothing was stored');
    assert.equal(await page.evaluate(() => getAdminDraftFields('2020', 'pitScouting').length), 101, 'but the draft is still there in memory');
    // Working in memory continues (an edit through the builder still works; the save is retried and refused again).
    await page.evaluate(() => {
      const fields = getAdminDraftFields('2020', 'pitScouting').slice(0, 100);
      fields[0] = { ...fields[0], label: 'Edited in memory' };
      setAdminDraftFields('2020', 'pitScouting', fields.concat([{ id: 'one2many', label: 'One too many', type: 'text', required: false, sortOrder: 100, showInPreview: false }]));
    });
    await waitSave(page, 'Not saved: changes are only kept while this screen is open');
    // Closing asks first (the changes are not stored), Cancel keeps the screen open.
    await page.click('#btn-builder-close');
    await page.waitForSelector('#generic-confirm-modal:not(.hidden)');
    assert.match(await page.textContent('#generic-confirm-title'), /Discard unpublished changes/);
    assert.match(await page.textContent('#generic-confirm-message'), /could not be saved/);
    await page.click('#btn-generic-confirm-cancel');
    assert.ok(await page.isVisible('#builder-modal'), 'Cancel leaves the screen open');
    // Fix the draft (back to 100 fields): the next save works and the message follows.
    await page.evaluate(() => setAdminDraftFields('2020', 'pitScouting', getAdminDraftFields('2020', 'pitScouting').slice(0, 100)));
    await waitSave(page, 'Draft saved');
    assert.equal((await draftDoc(page, '2020_pitScouting')).ids.length, 100);
    // ...and break it again, then Discard: no saved doc to delete, so it works without touching Firestore's delete.
    await page.evaluate(() => { window.__calls = []; });
    await page.click('#btn-admin-reset'); // deletes the saved (good) draft
    await page.waitForFunction(() => /built-in default/.test(document.getElementById('admin-draft-state').textContent));
    assert.equal(await draftDoc(page, '2020_pitScouting'), null);
    await page.evaluate(() => {
      window.__calls = [];
      setAdminDraftFields('2020', 'pitScouting', Array.from({ length: 101 }, (_, i) => ({ id: `big${i}`, label: `Big ${i}`, type: 'text', required: false, sortOrder: i, showInPreview: false })));
    });
    await waitSave(page, 'Not saved: changes are only kept while this screen is open');
    await page.evaluate(() => { window.__calls = []; });
    await page.click('#btn-admin-reset');
    await page.waitForFunction(() => /built-in default/.test(document.getElementById('admin-draft-state').textContent));
    assert.deepEqual(await page.evaluate(() => window.__calls), [], 'Discard of a draft that was never stored does not try to delete anything');
    assert.ok(await page.locator('#builder-error').evaluate(el => !el.textContent.trim()), 'and shows no error');
    // Closing the refused draft and confirming Discard throws it away.
    await page.evaluate(() => setAdminDraftFields('2020', 'pitScouting', Array.from({ length: 101 }, (_, i) => ({ id: `big${i}`, label: `Big ${i}`, type: 'text', required: false, sortOrder: i, showInPreview: false }))));
    await waitSave(page, 'Not saved: changes are only kept while this screen is open');
    await page.click('#btn-builder-close');
    await page.waitForSelector('#generic-confirm-modal:not(.hidden)');
    await page.click('#btn-generic-confirm-proceed');
    await page.waitForSelector('#builder-modal', { state: 'hidden' });
    await openAdmin(page, '2020');
    assert.ok((await labels(page)).length < 101, 'the refused draft is gone after confirming Discard');
    await closeAdmin(page);
  }
};
