// An entry with NO data is never saved. "Empty" = every field on the CURRENT form is blank, ignoring the
// Match Number (and the team number, which is not a form field): whitespace-only text is blank, no choice /
// no number typed / a counter still at "-" (not answered) is blank; a typed 0 IS a value (also on a counter);
// a retired field's value never counts. Refusal = nothing saved, the form stays open, the error line shows
// "All fields are empty. Fill in at least one field before saving." (a required-field error wins when both
// apply), Cancel still works exactly as before.
// Covered save paths: pit Done (new + edit), match Done in Match View (LIVE session, new + edit), match Save in
// Team View (BATCH, new + edit). Also a layout check of the error line and the pure isEmpty() per field type.

const assert = require('node:assert/strict');
const { signInUI, createTeamUI, selectFixtureEvent } = require('../lib/app');
const { FIXTURE_EVENT } = require('../lib/harness');

const MSG = 'All fields are empty. Fill in at least one field before saving.';
const CODE = FIXTURE_EVENT.code;

const field = (id, label, type, extra = {}) => ({ id, label, type, required: false, sortOrder: 0, showInPreview: false, ...extra });
const SHARED = [
  field('t1', 'Text', 'text'),
  field('n1', 'Number', 'number'),
  field('c1', 'Counter', 'counter', { min: 0, max: 20, step: 1, assumedValue: 5 }),
  field('d1', 'Dropdown', 'dropdown', { options: ['A', 'B'] }),
  field('b1', 'Group', 'buttonGroup', { options: ['P', 'Q'] }),
  field('bm', 'Multi', 'buttonGroup', { options: ['X', 'Y'], multi: true }),
  field('ta', 'Notes', 'textarea')
];
const LEGACY = field('legacy', 'Legacy', 'text');

module.exports = {
  name: 'empty entry refused: pit Done, match Done (live), match Save (batch), edits; match number / whitespace / a counter at "-" / retired value do not count, typed 0 does; error line layout',
  async run(ctx) {
    const captain = await ctx.makeUser('Captain Empty');
    const page = await ctx.newPage('captain');
    await signInUI(page, captain);
    await createTeamUI(page, 'Empty Entry Team');
    await selectFixtureEvent(page);
    const teamId = await page.evaluate(() => currentTeamData.id);
    const season = await page.evaluate(() => resolveFormConfigSeason());

    // ---------- forms with NOTHING required (so only the empty rule can refuse) ----------
    const putConfig = (type, data) => page.evaluate(async ([tid, id, d]) => {
      await db.collection('teams').doc(tid).collection('formConfig').doc(id).set(d, { merge: true });
    }, [teamId, `${season}_${type}`, data]);
    const numbered = (fields) => fields.map((f, i) => ({ ...f, sortOrder: i }));
    const pitFields = numbered([LEGACY, ...SHARED]);
    await putConfig('pitScouting', { fields: pitFields, baseVersion: null, handledVersion: 0, retiredFields: [] });
    await putConfig('matchScouting', { fields: numbered([field('matchNumber', 'Match Number', 'number', { required: true }), ...SHARED]), baseVersion: null, handledVersion: 0, retiredFields: [] });
    await page.evaluate(([tid, s]) => { invalidateFormConfigCache(tid, s); invalidateMatchFormConfigCache(tid, s); }, [teamId, season]);

    const docs = (col, n, extra = {}) => page.evaluate(async ([tid, code, num, ex, c]) => {
      let q = db.collection('teams').doc(tid).collection(c).where('eventCode', '==', code).where('teamNumber', '==', num);
      if (ex.matchNumber != null) q = q.where('matchNumber', '==', ex.matchNumber);
      return (await q.get()).docs.map(d => ({ id: d.id, ...d.data() }));
    }, [teamId, CODE, n, extra, col]);
    const pitDoc = async (n) => (await docs('pitScouting', n))[0];
    const matchDoc = async (n, m) => (await docs('matchScouting', n, { matchNumber: m }))[0];
    const isCommitted = (d) => !!d && (d.scoutedBy != null || !!d.checkpoint);

    const openPit = async (n) => {
      await page.evaluate(([num, code]) => openPitScoutForm(num, code), [n, CODE]);
      await page.waitForSelector('#pit-modal:not(.hidden) #pit-dynamic-fields .pit-field');
      await page.waitForFunction(() => currentPitLiveSession && currentPitLiveSession.isJoined());
    };
    const err = (modal) => page.textContent(`#${modal}-modal-error`).then(t => t.trim());
    const done = async (modal) => {
      await page.click(modal === 'pit' ? '#btn-pit-save' : '#btn-match-save');
      await page.waitForTimeout(250);
    };
    const refused = async (modal, message = MSG) => {
      assert.equal(await err(modal), message);
      assert.ok(await page.isVisible(`#${modal}-modal`), `${modal}: the form stays open`);
    };
    const closedOk = async (modal) => {
      await page.waitForSelector(`#${modal}-modal`, { state: 'hidden' });
      assert.equal(await err(modal), '', `${modal}: no error after a good save`);
    };
    const cancel = async (modal) => {
      await page.click(modal === 'pit' ? '#btn-pit-cancel-inline' : '#btn-match-cancel-inline');
      await page.waitForSelector(`#${modal}-modal`, { state: 'hidden' });
    };
    const fill = (modal, id, v) => page.fill(`#${modal}-modal #dyn-${id}`, v);
    // Click the counter's number, type, confirm (Enter). text '' = clear the box, '-' = type a minus.
    const typeCounter = async (modal, id, text) => {
      await page.click(`#${modal}-modal #dyn-${id} .counter-display`);
      await page.keyboard.press('Control+A');
      if (text === '') await page.keyboard.press('Backspace'); else await page.keyboard.type(text);
      await page.keyboard.press('Enter');
    };
    const counterText = (modal, id) => page.textContent(`#${modal}-modal #dyn-${id} .counter-display`);

    // ================= PIT: new entry =================
    await openPit(101);
    assert.equal(await counterText('pit', 'c1'), '-', 'an untouched counter shows "-"');
    await done('pit');
    await refused('pit');
    let d = await pitDoc(101);
    assert.ok(!isCommitted(d), 'nothing was committed on the live doc (no checkpoint, no scoutedBy)');
    assert.ok(Object.keys(d.activeEditors || {}).length === 1, 'the session is still open on the doc');
    assert.ok(await page.locator('#btn-pit-save').isEnabled());

    // layout of the error line (320px - 1280px) while it is showing
    for (const width of [320, 375, 414, 768, 1280]) {
      await page.setViewportSize({ width, height: 700 });
      await page.waitForTimeout(120);
      const m = await page.evaluate(() => {
        const e = document.getElementById('pit-modal-error');
        const b = e.getBoundingClientRect();
        const card = document.querySelector('#pit-modal .modal-card').getBoundingClientRect();
        return { left: b.left, right: b.right, w: b.width, h: b.height, clip: e.scrollWidth - e.clientWidth, cardLeft: card.left, cardRight: card.right,
          iw: window.innerWidth, pageW: document.documentElement.scrollWidth };
      });
      assert.ok(m.h > 0 && m.w > 0, `${width}px: the error line is visible`);
      assert.ok(m.left >= m.cardLeft - 1 && m.right <= m.cardRight + 1, `${width}px: the error line sits inside the form card`);
      assert.ok(m.left >= -1 && m.right <= m.iw + 1, `${width}px: inside the screen`);
      assert.ok(m.clip <= 1, `${width}px: the text is not clipped`);
      assert.ok(m.pageW <= m.iw + 1, `${width}px: the page does not scroll sideways`);
    }
    await page.setViewportSize({ width: 1280, height: 900 });

    // whitespace-only text / long text is blank
    await fill('pit', 't1', '   ');
    await fill('pit', 'ta', ' \n  ');
    await done('pit');
    await refused('pit');
    // a counter pressed + is a number (a value); typing "-" (or clearing the box) puts it back to "-" = blank
    await page.click('#pit-modal #dyn-c1 .counter-btn-plus');
    assert.equal(await counterText('pit', 'c1'), '6', 'assumed value 5: + from "-" gives 6');
    await typeCounter('pit', 'c1', '-');
    assert.equal(await counterText('pit', 'c1'), '-', 'typing "-" returns the counter to blank');
    await done('pit');
    await refused('pit');
    await page.click('#pit-modal #dyn-c1 .counter-btn-plus');
    await typeCounter('pit', 'c1', '');
    assert.equal(await counterText('pit', 'c1'), '-', 'clearing the box returns the counter to blank');
    await done('pit');
    await refused('pit');
    // a typed 0 counts
    await fill('pit', 'n1', '0');
    await done('pit');
    await closedOk('pit');
    d = await pitDoc(101);
    assert.ok(isCommitted(d), 'saved');
    assert.strictEqual(d.n1, 0, 'the 0 is stored');

    // Cancel after a refusal: nothing committed, shell cleaned up as before (typed-then-cleared text included)
    await openPit(202);
    await done('pit');
    await refused('pit');
    await fill('pit', 't1', 'x');
    await fill('pit', 't1', '');
    await done('pit');
    await refused('pit');
    await cancel('pit');
    await page.waitForFunction(async ([tid, code]) => {
      const snap = await db.collection('teams').doc(tid).collection('pitScouting').where('eventCode', '==', code).where('teamNumber', '==', 202).get();
      return snap.size === 1 && Object.keys(snap.docs[0].data().activeEditors || {}).length === 0;
    }, [teamId, CODE]);
    d = await pitDoc(202);
    assert.ok(!isCommitted(d), 'Cancel leaves only the empty shell (no data, nothing committed)');
    assert.ok(!d.t1, 'the typed-then-cleared value left nothing');

    // fill ONE field and it saves (a dropdown choice here), with the required-field error winning when both apply
    await putConfig('pitScouting', { fields: numbered([LEGACY, { ...SHARED[0], required: true }, ...SHARED.slice(1)]) });
    await page.waitForFunction(([id]) => (teamConfigDocs.get(id)?.fields || []).some(f => f.id === 't1' && f.required), [`${season}_pitScouting`]);
    await page.evaluate(([tid, s]) => invalidateFormConfigCache(tid, s), [teamId, season]);
    await openPit(202);
    await done('pit');
    await refused('pit', '"Text" is required.'); // required first, NOT the empty message
    await page.selectOption('#pit-modal #dyn-d1', 'A');
    await done('pit');
    await refused('pit', '"Text" is required.');
    await fill('pit', 't1', 'now');
    await done('pit');
    await closedOk('pit');
    d = await pitDoc(202);
    assert.equal(d.t1, 'now');
    await putConfig('pitScouting', { fields: pitFields });
    await page.waitForFunction(([id]) => !(teamConfigDocs.get(id)?.fields || []).some(f => f.id === 't1' && f.required), [`${season}_pitScouting`]);
    await page.evaluate(([tid, s]) => invalidateFormConfigCache(tid, s), [teamId, season]);

    // ================= PIT: edit an existing entry =================
    // clearing the ONLY value is refused; Cancel brings it back
    await openPit(101);
    assert.equal(await page.inputValue('#pit-modal #dyn-n1'), '0');
    await fill('pit', 'n1', '');
    await done('pit');
    await refused('pit');
    await cancel('pit');
    await page.waitForFunction(async ([tid, code]) => {
      const s = await db.collection('teams').doc(tid).collection('pitScouting').where('eventCode', '==', code).where('teamNumber', '==', 101).get();
      return s.docs[0].data().n1 === 0 && Object.keys(s.docs[0].data().activeEditors || {}).length === 0;
    }, [teamId, CODE]);
    // clearing one value while another stays is fine
    await openPit(101);
    await fill('pit', 'n1', '');
    await fill('pit', 't1', 'kept');
    await done('pit');
    await closedOk('pit');
    d = await pitDoc(101);
    assert.equal(d.t1, 'kept');
    assert.ok(d.n1 == null);

    // a RETIRED field's value alone is not enough
    await openPit(303);
    await fill('pit', 'legacy', 'old value');
    await done('pit');
    await closedOk('pit');
    await putConfig('pitScouting', { fields: numbered(SHARED), retiredFields: [LEGACY] });
    await page.waitForFunction(([id]) => (teamConfigDocs.get(id)?.retiredFields || []).length === 1, [`${season}_pitScouting`]);
    await page.evaluate(([tid, s]) => invalidateFormConfigCache(tid, s), [teamId, season]);
    await openPit(303);
    assert.equal(await page.locator('#pit-modal .field-retired').count(), 1, 'the retired field is shown (it has a value)');
    assert.equal(await page.inputValue('#pit-modal #dyn-legacy'), 'old value');
    await done('pit');
    await refused('pit');
    assert.equal((await pitDoc(303)).legacy, 'old value', 'nothing changed');
    await fill('pit', 't1', 'real');
    await done('pit');
    await closedOk('pit');
    d = await pitDoc(303);
    assert.equal(d.t1, 'real');
    assert.equal(d.legacy, 'old value', 'the retired value is untouched');
    // and clearing the retired value when it is all there is = empty = refused
    await openPit(303);
    await fill('pit', 't1', '');
    await fill('pit', 'legacy', '');
    await done('pit');
    await refused('pit');
    await cancel('pit');

    // ================= MATCH: LIVE (Match View) =================
    const matchOpen = async (docOpener, ...args) => {
      await page.evaluate(docOpener, args);
      await page.waitForSelector('#match-modal:not(.hidden) #match-dynamic-fields .pit-field');
    };
    await matchOpen(([n, code]) => openMatchScoutForm(n, code, 5, 'Alpha Bots'), 101, CODE);
    await page.waitForFunction(() => currentMatchLiveSession && currentMatchLiveSession.isJoined());
    assert.equal(await page.locator('#match-modal #dyn-matchNumber').count(), 0, 'live: the match number is fixed, not a field');
    await done('match');
    await refused('match');
    let m = await matchDoc(101, 5);
    assert.ok(!isCommitted(m), 'live: nothing committed');
    await fill('match', 't1', '  ');
    await done('match');
    await refused('match');
    await fill('match', 'n1', '0');
    await done('match');
    await closedOk('match');
    m = await matchDoc(101, 5);
    assert.ok(isCommitted(m));
    assert.strictEqual(m.n1, 0);
    // live: Cancel after a refusal leaves the shell and nothing else
    await matchOpen(([n, code]) => openMatchScoutForm(n, code, 6, 'Alpha Bots'), 101, CODE);
    await page.waitForFunction(() => currentMatchLiveSession && currentMatchLiveSession.isJoined());
    await done('match');
    await refused('match');
    await cancel('match');
    await page.waitForFunction(async ([tid, code]) => {
      const s = await db.collection('teams').doc(tid).collection('matchScouting').where('eventCode', '==', code).where('matchNumber', '==', 6).get();
      return s.size === 1 && Object.keys(s.docs[0].data().activeEditors || {}).length === 0;
    }, [teamId, CODE]);
    assert.ok(!isCommitted(await matchDoc(101, 6)));
    // live edit: clear the only value -> refused; Cancel restores it
    await matchOpen(([id, data]) => openMatchScoutEdit(id, data, true, 'Alpha Bots'), m.id, m);
    await page.waitForFunction(() => currentMatchLiveSession && currentMatchLiveSession.isJoined());
    await fill('match', 'n1', '');
    await done('match');
    await refused('match');
    await cancel('match');
    await page.waitForFunction(async ([tid, id]) => (await db.collection('teams').doc(tid).collection('matchScouting').doc(id).get()).data().n1 === 0, [teamId, m.id]);

    // ================= MATCH: BATCH (Team View) =================
    await matchOpen(([n, code]) => openMatchScoutForm(n, code), 202, CODE);
    assert.equal(await page.locator('#match-modal #dyn-matchNumber').count(), 1, 'batch: the match number is a field');
    await fill('match', 'matchNumber', '7');
    await done('match');
    await refused('match'); // the match number alone is not enough
    assert.equal((await docs('matchScouting', 202, { matchNumber: 7 })).length, 0, 'nothing saved');
    await fill('match', 't1', '   ');
    await done('match');
    await refused('match');
    await fill('match', 'matchNumber', '');
    await done('match');
    assert.equal(await err('match'), '"Match Number" is required.', 'a required-field error keeps priority over the empty error');
    await fill('match', 'matchNumber', '7');
    await page.selectOption('#match-modal #dyn-d1', 'B');
    await done('match');
    await closedOk('match');
    let b = await matchDoc(202, 7);
    assert.equal(b.d1, 'B');
    // batch edit: clearing the one value is refused (the match number stays), the entry is untouched
    await matchOpen(([id, data]) => openMatchScoutEdit(id, data), b.id, b);
    await page.selectOption('#match-modal #dyn-d1', '');
    await done('match');
    await refused('match');
    assert.equal((await matchDoc(202, 7)).d1, 'B', 'unchanged');
    // clearing it but typing a 0 elsewhere saves
    await fill('match', 'n1', '0');
    await done('match');
    await closedOk('match');
    b = await matchDoc(202, 7);
    assert.ok(b.d1 == null);
    assert.strictEqual(b.n1, 0);
    // Cancel in batch mode still just closes
    await matchOpen(([n, code]) => openMatchScoutForm(n, code), 303, CODE);
    await fill('match', 'matchNumber', '9');
    await done('match');
    await refused('match');
    await cancel('match');
    assert.equal((await docs('matchScouting', 303)).length, 0, 'batch Cancel leaves nothing behind');

    // the error line at 320px on the match form too
    await matchOpen(([n, code]) => openMatchScoutForm(n, code), 303, CODE);
    await fill('match', 'matchNumber', '9');
    await done('match');
    await page.setViewportSize({ width: 320, height: 480 });
    await page.waitForTimeout(150);
    const mm = await page.evaluate(() => {
      const e = document.getElementById('match-modal-error');
      const bb = e.getBoundingClientRect();
      return { l: bb.left, r: bb.right, h: bb.height, clip: e.scrollWidth - e.clientWidth, iw: window.innerWidth, pageW: document.documentElement.scrollWidth };
    });
    assert.ok(mm.h > 0 && mm.l >= -1 && mm.r <= mm.iw + 1 && mm.clip <= 1 && mm.pageW <= mm.iw + 1, `match error line fits at 320px (${JSON.stringify(mm)})`);
    await page.setViewportSize({ width: 1280, height: 900 });
    await cancel('match');

    // ================= the pure rule, per field type =================
    const unit = await page.evaluate(() => {
      const make = (fields, existing = null) => {
        const box = document.createElement('div');
        document.body.appendChild(box);
        const c = renderDynamicForm(box, fields, existing);
        return { c, box, el: (id) => box.querySelector(`#dyn-${id}`) };
      };
      const f = (id, type, extra = {}) => ({ id, label: id, type, required: false, sortOrder: 0, ...extra });
      const out = {};
      let x = make([f('t', 'text')]);
      out.blank = x.c.isEmpty();
      x.el('t').value = ' a '; out.text = x.c.isEmpty();
      x.el('t').value = '   '; out.textWhitespace = x.c.isEmpty();
      x = make([f('n', 'number')]);
      x.el('n').value = '0'; out.numberZero = x.c.isEmpty();
      x.el('n').value = ''; out.numberBlank = x.c.isEmpty();
      x = make([f('c', 'counter', { min: 0, max: 9, step: 1 })]);
      out.counterUntouched = x.c.isEmpty();
      x.box.querySelector('.counter-btn-plus').click(); out.counterMoved = x.c.isEmpty();
      x.box.querySelector('.counter-btn-minus').click(); out.counterBackToZero = x.c.isEmpty(); // 0 is a number, a value
      x = make([f('c', 'counter', { min: 2, max: 9, step: 1, assumedValue: 4 })]);
      out.counterAssumedUntouched = x.c.isEmpty(); // the assumed value is NOT a value
      x.box.querySelector('.counter-btn-minus').click(); out.counterBelowAssumed = x.c.isEmpty();
      x = make([f('c', 'counter', { min: 2, max: 9, step: 1, defaultValue: 4 })]);
      out.counterOldDefaultUntouched = x.c.isEmpty();
      x = make([f('c', 'counter', { min: 2, max: 9 })]);
      out.counterMinUntouched = x.c.isEmpty();
      x = make([f('c', 'counter', { min: 0, max: 9 })], { c: 0 });
      out.counterSavedZero = x.c.isEmpty(); // an old entry's stored 0 is data
      x.c.setValues({ c: null }); out.counterSetNull = x.c.isEmpty();
      x = make([f('d', 'dropdown', { options: ['A'] })]);
      x.el('d').value = 'A'; out.dropdown = x.c.isEmpty();
      x = make([f('b', 'buttonGroup', { options: ['P', 'Q'] })]);
      out.groupBlank = x.c.isEmpty();
      x.box.querySelector('.button-group-option').click(); out.groupPicked = x.c.isEmpty();
      x = make([f('m', 'buttonGroup', { options: ['P', 'Q'], multi: true })]);
      x.box.querySelector('.button-group-option').click(); out.multiPicked = x.c.isEmpty();
      x.box.querySelector('.button-group-option').click(); out.multiUnpicked = x.c.isEmpty();
      x = make([f('a', 'textarea')]);
      x.el('a').value = '\n \t'; out.textareaWhitespace = x.c.isEmpty();
      x.el('a').value = 'hi'; out.textarea = x.c.isEmpty();
      // matchNumber alone, a retired field alone
      x = make([f('matchNumber', 'number', { required: true }), f('t', 'text')]);
      x.el('matchNumber').value = '12'; out.matchNumberOnly = x.c.isEmpty();
      x.el('t').value = 'z'; out.matchNumberPlus = x.c.isEmpty();
      x = make([f('t', 'text'), f('old', 'text', { retired: true })], { old: 'legacy' });
      out.retiredOnly = x.c.isEmpty();
      x.el('t').value = 'z'; out.retiredPlus = x.c.isEmpty();
      return out;
    });
    assert.deepEqual(unit, {
      blank: true, text: false, textWhitespace: true, numberZero: false, numberBlank: true,
      counterUntouched: true, counterMoved: false, counterBackToZero: false, counterAssumedUntouched: true, counterBelowAssumed: false,
      counterOldDefaultUntouched: true, counterMinUntouched: true, counterSavedZero: false, counterSetNull: true,
      dropdown: false, groupBlank: true, groupPicked: false, multiPicked: false, multiUnpicked: true,
      textareaWhitespace: true, textarea: false, matchNumberOnly: true, matchNumberPlus: false, retiredOnly: true, retiredPlus: false
    });
  }
};
