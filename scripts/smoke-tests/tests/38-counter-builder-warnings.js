// Counter warnings in the field editor's Save (counter type only; team mode AND admin mode; adding AND editing):
//   - minimum = maximum          -> "Minimum and maximum are the same, so this counter can only ever be that one number.
//                                    A dropdown or button group is usually better. Save anyway?"
//   - assumed value outside min..max -> "The assumed value is outside the minimum-maximum range, so it will be treated as
//                                    the nearest limit. Save anyway?"  ONLY when the Assumed value was set (not the default 0)
//                                    AND is more than ONE STEP outside (assumed < min - step or > max + step)
//   - both                        -> ONE combined message
//   - normal counters             -> no warning at all
// Buttons are "Save anyway" / "Go back"; Go back keeps the editor open with everything as typed, nothing saved. Max below
// min is still the plain error (no confirm). The confirm fits at 320px. Counter rendering / stepping is not touched.

const assert = require('node:assert/strict');
const { signInUI, createTeamUI, readFormConfig, openBuilderFor, closeBuilder } = require('../lib/app');

const SAME = 'Minimum and maximum are the same, so this counter can only ever be that one number. A dropdown or button group is usually better.';
const OUTSIDE = 'The assumed value is outside the minimum-maximum range, so it will be treated as the nearest limit.';
const SEASON = '2020';

const confirmVisible = (page) => page.evaluate(() => !document.getElementById('generic-confirm-modal').classList.contains('hidden'));
const confirmText = (page) => page.evaluate(() => ({
  title: document.getElementById('generic-confirm-title').textContent.trim(),
  message: document.getElementById('generic-confirm-message').textContent.trim(),
  proceed: document.getElementById('btn-generic-confirm-proceed').textContent.trim(),
  cancel: document.getElementById('btn-generic-confirm-cancel').textContent.trim(),
  secondaryHidden: document.getElementById('btn-generic-confirm-secondary').classList.contains('hidden')
}));

// Opens the field editor (new field when label is null... otherwise Edit on the row with that label) and types the counter settings.
async function openEditor(page, editLabel) {
  if (editLabel) {
    await page.locator('#builder-field-list .builder-field-item').filter({ has: page.locator('.builder-field-label', { hasText: new RegExp(`^${editLabel}$`) }) }).getByRole('button', { name: 'Edit' }).click();
  } else {
    await page.click('#btn-builder-add-field');
  }
  await page.waitForSelector('#field-editor-modal:not(.hidden)');
}
async function typeCounter(page, { label, min, max, assumed, step }) {
  if (label != null) {
    await page.fill('#bld-field-label', label);
    await page.selectOption('#bld-field-type', 'counter');
    await page.setChecked('#bld-field-show-in-preview', false);
  }
  if (min != null) await page.fill('#bld-field-min', String(min));
  if (max != null) await page.fill('#bld-field-max', String(max));
  if (step != null) await page.fill('#bld-field-step', String(step));
  if (assumed != null) await page.fill('#bld-field-assumed', String(assumed));
}
const editorValues = (page) => page.evaluate(() => ({
  label: document.getElementById('bld-field-label').value, type: document.getElementById('bld-field-type').value,
  min: document.getElementById('bld-field-min').value, max: document.getElementById('bld-field-max').value, assumed: document.getElementById('bld-field-assumed').value
}));
const editorOpen = (page) => page.evaluate(() => !document.getElementById('field-editor-modal').classList.contains('hidden'));

// Save, expecting NO confirm: the editor closes.
async function saveQuietly(page) {
  await page.click('#btn-bld-save');
  await page.waitForSelector('#field-editor-modal', { state: 'hidden' });
  assert.equal(await confirmVisible(page), false, 'no warning for a normal counter');
}
// Save, expecting the confirm with this message; returns after checking its labels.
async function saveExpectingConfirm(page, expectedMessage) {
  await page.click('#btn-bld-save');
  await page.waitForSelector('#generic-confirm-modal:not(.hidden)');
  const c = await confirmText(page);
  assert.equal(c.message, `${expectedMessage} Save anyway?`);
  assert.equal(c.proceed, 'Save anyway');
  assert.equal(c.cancel, 'Go back');
  assert.ok(c.secondaryHidden, 'just the two buttons');
  assert.equal(await editorOpen(page), true, 'the editor stays behind the confirm');
}
async function goBack(page) {
  await page.click('#btn-generic-confirm-cancel');
  await page.waitForSelector('#generic-confirm-modal', { state: 'hidden' });
}
async function saveAnyway(page) {
  await page.click('#btn-generic-confirm-proceed');
  await page.waitForSelector('#generic-confirm-modal', { state: 'hidden' });
  await page.waitForSelector('#field-editor-modal', { state: 'hidden' });
}

// The whole routine, against whichever builder is open; `read()` returns the saved fields as { label: field }.
async function exercise(page, read, tag) {
  const n = (s) => `${s} ${tag}`;
  // ---------- normal counters: no warning ----------
  await openEditor(page);
  await typeCounter(page, { label: n('Normal'), min: 0, max: 10, assumed: 5 });
  await saveQuietly(page);
  assert.equal((await read())[n('Normal')].assumedValue, 5);
  await openEditor(page);
  await typeCounter(page, { label: n('No max'), min: 0, assumed: 0 });
  await saveQuietly(page);
  await openEditor(page);
  await typeCounter(page, { label: n('At limit'), min: 1, max: 10, assumed: 10 });
  await saveQuietly(page); // the assumed value ON a limit is inside the range
  await openEditor(page);
  await typeCounter(page, { label: n('At min'), min: 1, max: 10, assumed: 1 });
  await saveQuietly(page);
  await openEditor(page);
  await typeCounter(page, { label: n('Negative'), min: -100, max: 100, assumed: 0 });
  await saveQuietly(page);

  // ---------- min = max ----------
  await openEditor(page);
  await typeCounter(page, { label: n('Same'), min: 5, max: 5, assumed: 5 });
  await saveExpectingConfirm(page, SAME);
  await goBack(page);
  assert.equal(await editorOpen(page), true, 'Go back keeps the editor open');
  assert.deepEqual(await editorValues(page), { label: n('Same'), type: 'counter', min: '5', max: '5', assumed: '5' }, 'with everything as typed');
  assert.equal(n('Same') in (await read()), false, 'nothing was saved');
  await saveExpectingConfirm(page, SAME);
  await saveAnyway(page);
  const same = (await read())[n('Same')];
  assert.deepEqual([same.min, same.max, same.assumedValue], [5, 5, 5], 'Save anyway saves it');

  // ---------- assumed outside the range (above max, below min, and the plain default 0 under a min of 2) ----------
  await openEditor(page);
  await typeCounter(page, { label: n('Above'), min: 0, max: 10, assumed: 20 });
  await saveExpectingConfirm(page, OUTSIDE);
  await goBack(page);
  assert.equal(n('Above') in (await read()), false);
  assert.equal((await editorValues(page)).assumed, '20');
  await saveExpectingConfirm(page, OUTSIDE);
  await saveAnyway(page);
  assert.equal((await read())[n('Above')].assumedValue, 20);
  await openEditor(page);
  await typeCounter(page, { label: n('Below'), min: 2, max: 8, assumed: -3 });
  await saveExpectingConfirm(page, OUTSIDE);
  await saveAnyway(page);
  await openEditor(page);
  await typeCounter(page, { label: n('Default under min'), min: 2, max: 8 }); // the Assumed value is left at its default 0
  await saveQuietly(page); // an Assumed value left at 0 never warns by itself, even with a minimum above 0
  assert.equal((await read())[n('Default under min')].assumedValue, undefined, 'and 0 is still not stored');

  // ---------- the warning needs BOTH: an Assumed value that was set (not the default 0) AND more than ONE STEP outside ----------
  // (min / max / step / assumed -> warns?)  step 1:
  for (const [label, s, expectWarn] of [
    ['One below min', { min: 5, max: 10, assumed: 4 }, false],   // exactly one step below the minimum
    ['One above max', { min: 5, max: 10, assumed: 11 }, false],  // exactly one step above the maximum
    ['Two below min', { min: 5, max: 10, assumed: 3 }, true],
    ['Two above max', { min: 5, max: 10, assumed: 12 }, true],
    ['Typed zero', { min: 3, max: 9, assumed: 0 }, false],      // a typed 0 is the default 0: no warning
    ['Zero over max', { min: -10, max: -3 }, false],             // default 0 above a negative maximum: no warning
    ['Zero under min', { min: 3, max: 9 }, false],               // default 0 below a minimum: no warning
    ['Step 5 one below', { min: 10, max: 20, step: 5, assumed: 5 }, false],  // one STEP (5) below the minimum
    ['Step 5 below', { min: 10, max: 20, step: 5, assumed: 4 }, true],
    ['Step 5 one above', { min: 10, max: 20, step: 5, assumed: 25 }, false],
    ['Step 5 above', { min: 10, max: 20, step: 5, assumed: 26 }, true],
    ['Same, assumed 1 off', { min: 5, max: 5, assumed: 6 }, false] // min = max still warns (about SAME only)
  ]) {
    await openEditor(page);
    await typeCounter(page, { label: n(label), ...s });
    if (label === 'Same, assumed 1 off') {
      await saveExpectingConfirm(page, SAME); // only the min = max sentence
      await saveAnyway(page);
    } else if (expectWarn) {
      await saveExpectingConfirm(page, OUTSIDE);
      await saveAnyway(page);
    } else {
      await saveQuietly(page);
    }
    assert.ok(n(label) in (await read()), `${label} saved`);
  }
  // min = max with the default Assumed value: still just the min = max sentence
  await openEditor(page);
  await typeCounter(page, { label: n('Same default'), min: 5, max: 5 });
  await saveExpectingConfirm(page, SAME);
  await goBack(page);
  await typeCounter(page, { assumed: 30 }); // and a far assumed value on top: ONE combined message again
  await page.click('#btn-bld-save');
  await page.waitForSelector('#generic-confirm-modal:not(.hidden)');
  assert.equal((await confirmText(page)).message, `${SAME} ${OUTSIDE} Save anyway?`);
  await goBack(page);
  await page.click('#btn-bld-cancel-inline');
  await page.waitForSelector('#field-editor-modal', { state: 'hidden' });

  // ---------- both: ONE combined message ----------
  await openEditor(page);
  await typeCounter(page, { label: n('Both'), min: 3, max: 3, assumed: 9 });
  await page.click('#btn-bld-save');
  await page.waitForSelector('#generic-confirm-modal:not(.hidden)');
  const both = await confirmText(page);
  assert.equal(both.message, `${SAME} ${OUTSIDE} Save anyway?`, 'both sentences in one confirm');
  assert.equal(both.message.split('Save anyway?').length - 1, 1, 'asked once');
  await goBack(page);
  await page.click('#btn-bld-save');
  await page.waitForSelector('#generic-confirm-modal:not(.hidden)');
  await saveAnyway(page);
  const b = (await read())[n('Both')];
  assert.deepEqual([b.min, b.max, b.assumedValue], [3, 3, 9]);

  // ---------- editing an existing field ----------
  await openEditor(page, n('Normal'));
  await typeCounter(page, { max: 0 });  // min 0 = max 0
  await saveExpectingConfirm(page, `${SAME} ${OUTSIDE}`.replace(`${SAME} ${OUTSIDE}`, `${SAME} ${OUTSIDE}`)); // assumed 5 is now outside 0-0 too
  await goBack(page);
  await typeCounter(page, { max: 10, assumed: 5 }); // back to normal while the editor was still open
  await saveQuietly(page);
  await openEditor(page, n('Normal'));
  await typeCounter(page, { min: 6, max: 6, assumed: 6 });
  await saveExpectingConfirm(page, SAME);
  await saveAnyway(page);
  const edited = (await read())[n('Normal')];
  assert.deepEqual([edited.min, edited.max, edited.assumedValue], [6, 6, 6], 'an edit goes through the same warning');

  // ---------- max below min stays the plain error (no confirm) ----------
  await openEditor(page, n('Normal'));
  await typeCounter(page, { min: 8, max: 3, assumed: 8 });
  await page.click('#btn-bld-save');
  assert.equal((await page.textContent('#field-editor-error')).trim(), "Counter maximum can't be lower than the minimum.");
  assert.equal(await confirmVisible(page), false);
  assert.equal(await editorOpen(page), true);
  // other field types never warn, whatever the (hidden) counter boxes hold
  await page.fill('#bld-field-max', '8');
  await page.selectOption('#bld-field-type', 'text');
  await saveQuietly(page);
  assert.equal((await read())[n('Normal')].type, 'text', 'a non-counter saves without the counter check');
}

module.exports = {
  name: 'counter builder warnings: min = max, assumed value outside the range, both combined; Save anyway / Go back; team + admin, add + edit; confirm layout at 320px',
  async run(ctx) {
    const admin = await ctx.adminUser();
    const captain = await ctx.makeUser('Captain Warn');
    const cap = await ctx.newPage('captain');
    await signInUI(cap, captain);
    await createTeamUI(cap, 'Counter Warn Team');
    const teamId = await cap.evaluate(() => currentTeamData.id);

    // ================= team builder =================
    await openBuilderFor(cap, SEASON, 'pitScouting');
    const readTeam = async () => Object.fromEntries((await readFormConfig(cap, teamId, SEASON, 'pitScouting')).fields.map(f => [f.label, f]));
    await exercise(cap, readTeam, 'T');

    // a normal confirm elsewhere keeps its own "Cancel" label (the shared modal's label is reset every call)
    await cap.locator('#builder-field-list .builder-field-item').first().locator('button', { hasText: '✕' }).click();
    await cap.waitForSelector('#generic-confirm-modal:not(.hidden)');
    assert.equal((await confirmText(cap)).cancel, 'Cancel', 'other confirms still say Cancel');
    await cap.click('#btn-generic-confirm-cancel');
    await cap.waitForSelector('#generic-confirm-modal', { state: 'hidden' });

    // ---------- the confirm's layout, 320px - 1280px (combined message = the longest) ----------
    await openEditor(cap);
    await typeCounter(cap, { label: 'Layout', min: 3, max: 3, assumed: 9 });
    await cap.click('#btn-bld-save');
    await cap.waitForSelector('#generic-confirm-modal:not(.hidden)');
    for (const [width, height] of [[320, 480], [320, 700], [375, 700], [414, 700], [768, 800], [1280, 900]]) {
      await cap.setViewportSize({ width, height });
      await cap.waitForTimeout(120);
      const m = await cap.evaluate(() => {
        const card = document.querySelector('#generic-confirm-modal .modal-card').getBoundingClientRect();
        const proceed = document.getElementById('btn-generic-confirm-proceed').getBoundingClientRect();
        const cancel = document.getElementById('btn-generic-confirm-cancel').getBoundingClientRect();
        const msg = document.getElementById('generic-confirm-message');
        return { card, proceed, cancel, clip: msg.scrollWidth - msg.clientWidth, ih: window.innerHeight, iw: window.innerWidth, pageW: document.documentElement.scrollWidth };
      });
      const onScreen = (r) => r.left >= 0 && r.right <= m.iw + 1 && r.top >= 0 && r.bottom <= m.ih + 1;
      assert.ok(onScreen(m.proceed) && onScreen(m.cancel), `${width}x${height}: Save anyway / Go back stay on screen`);
      assert.ok(m.card.left >= -1 && m.card.right <= m.iw + 1 && m.clip <= 1 && m.pageW <= m.iw + 1, `${width}x${height}: the confirm fits, the text wraps`);
    }
    await cap.setViewportSize({ width: 1280, height: 900 });
    await goBack(cap);
    await cap.click('#btn-bld-cancel-inline');
    await cap.waitForSelector('#field-editor-modal', { state: 'hidden' });
    await closeBuilder(cap);

    // ================= admin builder =================
    const adm = await ctx.newPage('admin');
    await signInUI(adm, admin);
    await adm.click('#btn-open-admin-from-team');
    await adm.waitForSelector('#builder-modal:not(.hidden)');
    await adm.selectOption('#builder-season-select', SEASON);
    await adm.waitForFunction((s) => currentBuilderSeason === s && adminDrafts.has(`${s}_pitScouting`) && !document.getElementById('builder-field-list').textContent.includes('Loading'), SEASON);
    const readAdmin = async () => Object.fromEntries(await adm.evaluate((s) => adminDrafts.get(`${s}_pitScouting`).fields.map(f => [f.label, f]), SEASON));
    await exercise(adm, readAdmin, 'A');
  }
};
