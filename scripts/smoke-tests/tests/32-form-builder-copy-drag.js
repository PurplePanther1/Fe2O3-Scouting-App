// Copy a field and drag to reorder, in BOTH builders (js/form-builder.js): the team's form builder
// (writes teams/{id}/formConfig) and the admin builder (edits the official-form draft).
//   Copy   a button on every row; the copy sits directly below the original, label "<label> (copy)", a
//          unique id (not an active one, not a retired one), same type / options / required / counter
//          settings; "Show in preview" is off when the preview cap is already full; it goes through the
//          same write as adding a field (team mode: baseVersion / handledVersion / retiredFields survive)
//   Drag   the six-dot handle, pointer events (mouse AND touch), touch-action: none on the handle only; a
//          drop line shows where it lands; the new order is saved by the same function the arrows use;
//          Escape / no movement saves nothing; the list scrolls while dragging near its edge
// Throwaway season 2020 (no official form), so no real team is affected.

const assert = require('node:assert/strict');
const { signInUI, createTeamUI, formField, readFormConfig, openBuilderFor, closeBuilder, builderLabels, deleteTeamAsLastMember } = require('../lib/app');

const SEASON = '2020';
const ids = (fields) => fields.map(f => f.id);
const waitLabels = (page, expected) => page.waitForFunction((want) => {
  const got = [...document.querySelectorAll('#builder-field-list .builder-field-label')].map(e => e.textContent.trim());
  return got.length === want.length && got.every((l, i) => l === want[i]);
}, expected);
const row = (page, label) => page.locator('#builder-field-list .builder-field-item').filter({ has: page.locator('.builder-field-label', { hasText: new RegExp(`^${label.replace(/[()]/g, '\\$&')}$`) }) });
const copyBtn = (page, label) => row(page, label).locator('[data-builder-action="copy"]');
const handleOf = (page, label) => row(page, label).locator('.builder-drag-handle');

// Count calls to the shared order-saving function and to the writer, by wrapping the page's globals.
async function spy(page) {
  await page.evaluate(() => {
    if (!window.__spyInstalled) {
      window.__spyInstalled = true;
      const realOrder = saveFieldOrder;
      window.saveFieldOrder = (fields) => { window.__spy.order++; return realOrder(fields); };
      const realWrite = writeBuilderFields;
      window.writeBuilderFields = (teamId, fields, opts) => { window.__spy.writes.push({ syncRetired: !!(opts && opts.syncRetired), n: fields.length }); return realWrite(teamId, fields, opts); };
    }
    window.__spy = { order: 0, writes: [] };
  });
}
const spyState = (page) => page.evaluate(() => window.__spy);

// A mouse drag from a row's handle to Y (viewport pixels), released there.
async function mouseDrag(page, fromLabel, toY, { release = true, steps = 8 } = {}) {
  const box = await handleOf(page, fromLabel).boundingBox();
  const x = box.x + box.width / 2;
  await page.mouse.move(x, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(x, toY, { steps });
  if (release) await page.mouse.up();
}
// Y just below the vertical middle of a row (so the dragged row lands AFTER it).
async function belowMiddleOf(page, label) {
  const box = await row(page, label).boundingBox();
  return box.y + box.height * 0.75;
}
async function aboveMiddleOf(page, label) {
  const box = await row(page, label).boundingBox();
  return box.y + box.height * 0.25;
}

// A real touch gesture through the browser (CDP), which Chromium turns into pointer events with pointerType "touch".
async function touchDrag(page, cdp, fromLabel, toY) {
  const box = await handleOf(page, fromLabel).boundingBox();
  const x = Math.round(box.x + box.width / 2);
  const y0 = Math.round(box.y + box.height / 2);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: y0, id: 1 }] });
  const steps = 8;
  for (let i = 1; i <= steps; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: Math.round(y0 + ((toY - y0) * i) / steps), id: 1 }] });
    await page.waitForTimeout(20);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

module.exports = {
  name: 'form builder: Copy a field + drag to reorder (mouse + touch), team builder and admin builder',
  async run(ctx) {
    const admin = await ctx.adminUser();
    const captain = await ctx.makeUser('Captain Copy');
    const cap = await ctx.newPage('captain');
    await signInUI(cap, captain);
    await createTeamUI(cap, 'Copy Drag Team');
    const teamId = await cap.evaluate(() => currentTeamData.id);

    // ============ team builder: Copy ============
    const seed = [
      formField('a', 'Field A', 'dropdown', { options: ['X', 'Y', 'Z'], required: true, showInPreview: true }),
      formField('b', 'Field B', 'text', { showInPreview: false }),
      formField('c', 'Field C', 'counter', { min: 2, max: 9, step: 3, defaultValue: 4, showInPreview: false }),
      formField('d', 'Field D', 'buttonGroup', { options: ['P', 'Q'], multi: true, showInPreview: false })
    ].map((f, i) => ({ ...f, sortOrder: i }));
    const retired = [formField('aCopy', 'Old A Copy', 'text')];
    await cap.evaluate(async ([tid, fields, retiredFields]) => {
      await db.collection('teams').doc(tid).collection('formConfig').doc('2020_pitScouting')
        .set({ fields, baseVersion: 3, handledVersion: 3, retiredFields });
    }, [teamId, seed, retired]);
    await openBuilderFor(cap, SEASON, 'pitScouting');
    await waitLabels(cap, ['Field A', 'Field B', 'Field C', 'Field D']);
    assert.equal(await cap.locator('#builder-field-list [data-builder-action="copy"]').count(), 4, 'every row has a Copy button');
    await spy(cap);

    await copyBtn(cap, 'Field A').click();
    await waitLabels(cap, ['Field A', 'Field A (copy)', 'Field B', 'Field C', 'Field D']);
    let cfg = await readFormConfig(cap, teamId, SEASON, 'pitScouting');
    assert.deepEqual(ids(cfg.fields), ['a', 'aCopy2', 'b', 'c', 'd'], 'directly below the original, with an id that is neither active nor RETIRED (aCopy is retired)');
    const copy = cfg.fields[1];
    assert.equal(copy.label, 'Field A (copy)');
    assert.equal(copy.type, 'dropdown');
    assert.deepEqual(copy.options, ['X', 'Y', 'Z']);
    assert.equal(copy.required, true);
    assert.equal(copy.showInPreview, true, 'the cap (6) is not full: the copy keeps the original\'s setting');
    assert.deepEqual(cfg.fields.map(f => f.sortOrder), [0, 1, 2, 3, 4], 'sortOrder renumbered');
    assert.equal(cfg.baseVersion, 3, 'baseVersion survives (merge write)');
    assert.equal(cfg.handledVersion, 3, 'handledVersion survives');
    assert.deepEqual(ids(cfg.retiredFields), ['aCopy'], 'retiredFields untouched (the copy does not take the retired id)');
    assert.deepEqual((await spyState(cap)).writes, [{ syncRetired: true, n: 5 }], 'the same write as adding a field (syncRetired)');

    // a copy of a copy, a second copy of the original, counter + button-group settings
    await copyBtn(cap, 'Field A').click();
    await waitLabels(cap, ['Field A', 'Field A (copy)', 'Field A (copy)', 'Field B', 'Field C', 'Field D']);
    cfg = await readFormConfig(cap, teamId, SEASON, 'pitScouting');
    assert.deepEqual(ids(cfg.fields), ['a', 'aCopy3', 'aCopy2', 'b', 'c', 'd'], 'a second copy of A gets the next free id and sits directly below A');
    await copyBtn(cap, 'Field C').click();
    await waitLabels(cap, ['Field A', 'Field A (copy)', 'Field A (copy)', 'Field B', 'Field C', 'Field C (copy)', 'Field D']);
    await copyBtn(cap, 'Field D').click();
    await waitLabels(cap, ['Field A', 'Field A (copy)', 'Field A (copy)', 'Field B', 'Field C', 'Field C (copy)', 'Field D', 'Field D (copy)']);
    cfg = await readFormConfig(cap, teamId, SEASON, 'pitScouting');
    const byId = Object.fromEntries(cfg.fields.map(f => [f.id, f]));
    assert.deepEqual([byId.cCopy.min, byId.cCopy.max, byId.cCopy.step, byId.cCopy.defaultValue], [2, 9, 3, 4], 'counter settings are copied');
    assert.equal(byId.dCopy.multi, true);
    assert.deepEqual(byId.dCopy.options, ['P', 'Q']);
    assert.equal(byId.bCopy, undefined);
    await copyBtn(cap, 'Field B').click();
    await waitLabels(cap, ['Field A', 'Field A (copy)', 'Field A (copy)', 'Field B', 'Field B (copy)', 'Field C', 'Field C (copy)', 'Field D', 'Field D (copy)']);
    cfg = await readFormConfig(cap, teamId, SEASON, 'pitScouting');
    assert.equal(cfg.fields.find(f => f.id === 'bCopy').showInPreview, false, 'a copy of a field that is not in the preview stays out of it');
    assert.equal(cfg.baseVersion, 3);
    assert.equal(cfg.handledVersion, 3);
    assert.deepEqual(ids(cfg.retiredFields), ['aCopy']);
    // copying the copy: "<label> (copy)" of the copy, a fresh id
    await row(cap, 'Field D (copy)').locator('[data-builder-action="copy"]').click();
    await waitLabels(cap, ['Field A', 'Field A (copy)', 'Field A (copy)', 'Field B', 'Field B (copy)', 'Field C', 'Field C (copy)', 'Field D', 'Field D (copy)', 'Field D (copy) (copy)']);
    cfg = await readFormConfig(cap, teamId, SEASON, 'pitScouting');
    assert.equal(cfg.fields.length, 10);
    assert.equal(new Set(ids(cfg.fields)).size, 10, 'every id is unique');

    // preview cap full -> the copy is OFF the preview
    const six = Array.from({ length: 6 }, (_, i) => formField(`p${i}`, `Preview ${i}`, 'text', { sortOrder: i }));
    await cap.evaluate(async ([tid, fields]) => {
      await db.collection('teams').doc(tid).collection('formConfig').doc('2020_matchScouting').set({ fields, baseVersion: null, handledVersion: 0, retiredFields: [] }, { merge: true });
    }, [teamId, six]);
    await openBuilderFor(cap, SEASON, 'matchScouting');
    await waitLabels(cap, six.map(f => f.label));
    await copyBtn(cap, 'Preview 2').click();
    await waitLabels(cap, ['Preview 0', 'Preview 1', 'Preview 2', 'Preview 2 (copy)', 'Preview 3', 'Preview 4', 'Preview 5']);
    cfg = await readFormConfig(cap, teamId, SEASON, 'matchScouting');
    assert.equal(cfg.fields[3].showInPreview, false, 'the preview already holds 6 fields: the copy is added with Show in preview off');
    assert.equal(cfg.fields.filter(f => f.showInPreview !== false).length, 6, 'still exactly 6 in the preview');
    assert.equal(cfg.handledVersion, 0);

    // ============ team builder: drag ============
    await openBuilderFor(cap, SEASON, 'pitScouting');
    await waitLabels(cap, ['Field A', 'Field A (copy)', 'Field A (copy)', 'Field B', 'Field B (copy)', 'Field C', 'Field C (copy)', 'Field D', 'Field D (copy)', 'Field D (copy) (copy)']);
    // fewer rows to reason about: remove the extras through the data, then re-render.
    await cap.evaluate(async ([tid]) => {
      const ref = db.collection('teams').doc(tid).collection('formConfig').doc('2020_pitScouting');
      const snap = await ref.get();
      const keep = snap.data().fields.filter(f => ['a', 'b', 'c', 'd'].includes(f.id)).map((f, i) => ({ ...f, sortOrder: i }));
      await ref.set({ fields: keep }, { merge: true });
    }, [teamId]);
    await openBuilderFor(cap, SEASON, 'matchScouting');
    await openBuilderFor(cap, SEASON, 'pitScouting');
    await waitLabels(cap, ['Field A', 'Field B', 'Field C', 'Field D']);
    await spy(cap);

    // handle: touch-action none on the handle ONLY; a grab cursor
    const styles = await cap.evaluate(() => {
      const item = document.querySelector('#builder-field-list .builder-field-item');
      const touch = (el) => getComputedStyle(el).touchAction;
      return {
        handle: touch(item.querySelector('.builder-drag-handle')), row: touch(item), list: touch(document.getElementById('builder-field-list')),
        summary: touch(item.querySelector('.builder-field-summary')), actions: touch(item.querySelector('.builder-field-actions')),
        arrows: touch(item.querySelector('.builder-move-group')), cursor: getComputedStyle(item.querySelector('.builder-drag-handle')).cursor
      };
    });
    assert.equal(styles.handle, 'none', 'touch-action: none on the handle');
    assert.deepEqual([styles.row, styles.list, styles.summary, styles.actions, styles.arrows], ['auto', 'auto', 'auto', 'auto', 'auto'], 'nothing else blocks page scrolling');

    // drag A below C: [B, C, A, D], with a visible drop line while dragging, gone afterwards
    const toY = await belowMiddleOf(cap, 'Field C');
    await mouseDrag(cap, 'Field A', toY, { release: false });
    const during = await cap.evaluate(() => {
      const ind = document.querySelector('#builder-field-list .builder-drop-indicator');
      const dragging = document.querySelector('#builder-field-list .builder-field-item--dragging .builder-field-label');
      const rows = [...document.querySelectorAll('#builder-field-list .builder-field-item')].map(r => ({ label: r.querySelector('.builder-field-label').textContent.trim(), top: r.getBoundingClientRect().top, bottom: r.getBoundingClientRect().bottom }));
      return { has: !!ind, top: ind && ind.getBoundingClientRect().top, h: ind && ind.getBoundingClientRect().height, dragging: dragging && dragging.textContent.trim(), rows, bodyClass: document.body.classList.contains('builder-dragging') };
    });
    assert.ok(during.has, 'a drop indicator is shown while dragging');
    assert.equal(during.dragging, 'Field A', 'the dragged row is marked');
    assert.ok(during.bodyClass);
    const rowC = during.rows.find(r => r.label === 'Field C');
    const rowD = during.rows.find(r => r.label === 'Field D');
    assert.ok(during.top >= rowC.bottom - 6 && during.top <= rowD.top + 2, `the drop line sits between C and D (line ${during.top}, C ends ${rowC.bottom}, D starts ${rowD.top})`);
    assert.deepEqual(await builderLabels(cap), ['Field A', 'Field B', 'Field C', 'Field D'], 'nothing moves until the drop');
    await cap.mouse.up();
    await waitLabels(cap, ['Field B', 'Field C', 'Field A', 'Field D']);
    assert.equal(await cap.locator('#builder-field-list .builder-drop-indicator').count(), 0, 'the drop line is gone');
    assert.equal(await cap.evaluate(() => document.body.classList.contains('builder-dragging')), false);
    cfg = await readFormConfig(cap, teamId, SEASON, 'pitScouting');
    assert.deepEqual(ids(cfg.fields), ['b', 'c', 'a', 'd'], 'saved');
    assert.deepEqual(cfg.fields.map(f => f.sortOrder), [0, 1, 2, 3]);
    assert.equal(cfg.baseVersion, 3, 'baseVersion survives a drag');
    assert.equal(cfg.handledVersion, 3);
    assert.deepEqual(ids(cfg.retiredFields), ['aCopy'], 'retiredFields survive a drag');
    assert.equal((await spyState(cap)).order, 1, 'saved through saveFieldOrder (the function the arrows use)');

    // the arrows go through the same function
    await row(cap, 'Field D').locator('.btn-move-up').click();
    await waitLabels(cap, ['Field B', 'Field C', 'Field D', 'Field A']);
    assert.equal((await spyState(cap)).order, 2, 'an arrow click is also one saveFieldOrder');
    // drag to the very top
    await mouseDrag(cap, 'Field A', await aboveMiddleOf(cap, 'Field B'));
    await waitLabels(cap, ['Field A', 'Field B', 'Field C', 'Field D']);
    assert.deepEqual(ids((await readFormConfig(cap, teamId, SEASON, 'pitScouting')).fields), ['a', 'b', 'c', 'd']);
    // drag past the end
    await mouseDrag(cap, 'Field A', (await belowMiddleOf(cap, 'Field D')) + 30);
    await waitLabels(cap, ['Field B', 'Field C', 'Field D', 'Field A']);
    const orderCalls = (await spyState(cap)).order;
    // dropping where it started, and Escape, save nothing
    await mouseDrag(cap, 'Field B', await aboveMiddleOf(cap, 'Field B'));
    await cap.waitForTimeout(250);
    assert.equal((await spyState(cap)).order, orderCalls, 'dropping a row where it started saves nothing');
    await mouseDrag(cap, 'Field B', await belowMiddleOf(cap, 'Field D'), { release: false });
    await cap.keyboard.press('Escape');
    assert.equal(await cap.locator('#builder-field-list .builder-drop-indicator').count(), 0, 'Escape removes the drop line');
    await cap.mouse.up();
    await cap.waitForTimeout(250);
    assert.deepEqual(await builderLabels(cap), ['Field B', 'Field C', 'Field D', 'Field A']);
    assert.equal((await spyState(cap)).order, orderCalls, 'Escape saves nothing');
    // a click on the handle (no movement) saves nothing and leaves nothing dragging
    await handleOf(cap, 'Field C').click();
    await cap.waitForTimeout(250);
    assert.equal((await spyState(cap)).order, orderCalls);
    assert.equal(await cap.locator('.builder-field-item--dragging').count(), 0);

    // touch: a real touch gesture on the handle
    const cdp = await cap.context().newCDPSession(cap);
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    const touchBefore = (await spyState(cap)).order;
    await touchDrag(cap, cdp, 'Field B', await belowMiddleOf(cap, 'Field C'));
    await waitLabels(cap, ['Field C', 'Field B', 'Field D', 'Field A']);
    assert.equal((await spyState(cap)).order, touchBefore + 1, 'a touch drag saves through the same function');
    assert.deepEqual(ids((await readFormConfig(cap, teamId, SEASON, 'pitScouting')).fields), ['c', 'b', 'd', 'a']);
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
    await closeBuilder(cap);
    await cap.evaluate(async ([tid]) => { /* tidy: leave no stale state for the next steps */ }, [teamId]);
    await deleteTeamAsLastMember(cap);

    // ============ admin builder: Copy + drag edit the DRAFT ============
    const page = await ctx.newPage('admin');
    await signInUI(page, admin);
    await page.click('#btn-open-admin-from-team');
    await page.waitForSelector('#builder-modal:not(.hidden)');
    await page.selectOption('#builder-season-select', SEASON);
    await page.waitForFunction(() => currentBuilderSeason === '2020' && adminDrafts.has('2020_pitScouting') && !document.getElementById('builder-field-list').textContent.includes('Loading'));
    await spy(page);
    const start = await builderLabels(page);
    assert.ok(start.length >= 3, 'the default pit form is the starting draft');
    const first = start[0];
    await copyBtn(page, first).click();
    await waitLabels(page, [start[0], `${start[0]} (copy)`, ...start.slice(1)]);
    const draft = await page.evaluate(() => adminDrafts.get('2020_pitScouting').fields.map(f => ({ id: f.id, label: f.label, sortOrder: f.sortOrder })));
    assert.equal(draft[1].id, `${draft[0].id}Copy`, 'a unique id');
    assert.deepEqual(draft.map(f => f.sortOrder), draft.map((_, i) => i));
    assert.deepEqual((await spyState(page)).writes, [{ syncRetired: true, n: start.length + 1 }], 'same path as adding a field (a no-op write in admin mode)');
    assert.equal(await page.evaluate(async () => (await db.collection('officialForms').doc('2020_pitScouting').get()).exists), false, 'copying in the admin builder publishes nothing');
    await page.waitForFunction(() => document.getElementById('admin-save-state').textContent.trim() === 'Draft saved');
    // The admin default form has more than 6 preview fields? Its cap is respected: never more than 6 in the preview.
    assert.ok(await page.evaluate(() => adminDrafts.get('2020_pitScouting').fields.filter(f => f.showInPreview !== false).length <= 6));

    // drag in the admin builder: the second row (the copy) to the end
    const labelsNow = await builderLabels(page);
    const lastLabel = labelsNow[labelsNow.length - 1];
    await mouseDrag(page, `${first} (copy)`, (await belowMiddleOf(page, lastLabel)) + 20);
    await waitLabels(page, [labelsNow[0], ...labelsNow.slice(2), `${first} (copy)`]);
    assert.equal((await spyState(page)).order, 1);
    assert.equal((await page.evaluate(() => adminDrafts.get('2020_pitScouting').fields)).at(-1).label, `${first} (copy)`);
    await page.waitForFunction(() => document.getElementById('admin-save-state').textContent.trim() === 'Draft saved');
    assert.equal((await page.evaluate(async () => (await db.collection('officialFormDrafts').doc('2020_pitScouting').get()).data().fields.at(-1).label)), `${first} (copy)`, 'the dragged order is autosaved');

    // auto-scroll: on a short screen, holding the handle near the bottom edge scrolls the card
    await page.setViewportSize({ width: 320, height: 480 });
    await page.waitForTimeout(200);
    const scroller = await page.evaluate(() => { const el = nearestScrollableAncestor(document.getElementById('builder-field-list')); return el === document.scrollingElement ? 'page' : el.className || el.id; });
    assert.ok(scroller, 'there is a scrolling container');
    const firstNow = (await builderLabels(page))[0];
    await handleOf(page, firstNow).scrollIntoViewIfNeeded();
    const top0 = await page.evaluate(() => nearestScrollableAncestor(document.getElementById('builder-field-list')).scrollTop);
    const box = await handleOf(page, firstNow).boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, 478, { steps: 6 });
    await page.waitForTimeout(700);
    const top1 = await page.evaluate(() => nearestScrollableAncestor(document.getElementById('builder-field-list')).scrollTop);
    assert.ok(top1 > top0, `dragging near the bottom edge scrolls the list (${top0} -> ${top1})`);
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await page.setViewportSize({ width: 1280, height: 900 });
    assert.equal(await page.locator('.builder-drop-indicator').count(), 0);

    // Discard so the shared admin account leaves nothing behind.
    await page.click('#btn-admin-reset');
    await page.waitForFunction(() => /built-in default/.test(document.getElementById('admin-draft-state').textContent));
    await page.click('#btn-builder-close');
    await page.waitForSelector('#builder-modal', { state: 'hidden' });
  }
};
