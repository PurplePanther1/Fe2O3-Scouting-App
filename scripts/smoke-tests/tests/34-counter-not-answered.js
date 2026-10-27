// A counter has a "not answered" state: it shows "-" and its value is null (stored as null, like an empty number box),
// with an "Assumed value" (field.assumedValue, default 0; an older field's defaultValue is read as it) that is what "-"
// counts as when + or - is pressed.
//   control   untouched = "-" (value null); + from "-" = min(max, assumed + step) but never below min; - from "-" =
//             assumed - step when that is >= min, else nothing; + at max / - at min do nothing and the buttons never set
//             "-"; typing a number sets it (clamped; a typed 0 is 0), typing "-" or clearing the box sets "-"; Escape cancels
//   data      getValues() null / number, a REQUIRED counter at "-" is refused, setValues(null) = "-", a saved 0 shows 0,
//             an old field with only defaultValue behaves as assumedValue
//   live      "-" syncs as null between two windows, cancel / undo restores it, the commit checkpoints null
//   readers   previews, Pit vs Match, the scouted-matches list, the entry viewer and the Excel exports show blank (never 0)
//             for null, and averages skip nulls (a real 0 still counts)
//   builder   the "Assumed value" setting: add, edit (an old defaultValue shows there), copy, admin mode, validation, layout
//   official  assumedValue is a "Counter settings" property: publish, the identical-form rule (defaultValue X == assumedValue X),
//             the Merge screen and the viewer
//   layout    the counter showing "-" fits from 320px to 1280px
// Team builder on throwaway season 2020, official forms on throwaway season 2024 (no real team is affected).

const fs = require('node:fs');
const assert = require('node:assert/strict');
const {
  signInUI, createTeamUI, joinTeamUI, selectFixtureEvent, openScoutingSubtab, teamRow, formField, publishOfficialForm, readFormConfig,
  openBuilderFor, closeBuilder, noticeItems, noticeButton, openMyTeamTab, selectAppSeason
} = require('../lib/app');
const { FIXTURE_EVENT } = require('../lib/harness');

const CODE = FIXTURE_EVENT.code;
const field = (id, label, type, extra = {}) => ({ id, label, type, required: false, sortOrder: 0, showInPreview: false, ...extra });
const numbered = (fields) => fields.map((f, i) => ({ ...f, sortOrder: i }));

async function downloadExcel(page) {
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#btn-export-choice-excel')]);
  const b64 = fs.readFileSync(await download.path()).toString('base64');
  return page.evaluate((data) => {
    const wb = XLSX.read(data, { type: 'base64' });
    const rows = (name) => (wb.Sheets[name] ? XLSX.utils.sheet_to_json(wb.Sheets[name]) : []);
    return { pit: rows('Pit Scouting'), match: rows('Match Scouting') };
  }, b64);
}

module.exports = {
  name: 'counter "not answered": "-" / assumed value stepping, typing, required, live sync, undo, previews / exports / averages, builder + admin + official settings, layout',
  async run(ctx) {
    const admin = await ctx.adminUser();
    const captain = await ctx.makeUser('Captain Counter');
    const member = await ctx.makeUser('Member Counter');
    const cap = await ctx.newPage('captain');
    await signInUI(cap, captain);
    const joinCode = await createTeamUI(cap, 'Counter Team');
    await selectFixtureEvent(cap);
    const teamId = await cap.evaluate(() => currentTeamData.id);
    const season = await cap.evaluate(() => resolveFormConfigSeason());

    // ================= 1. the control and the form controller (no database) =================
    const unit = await cap.evaluate(() => {
      const mk = (field, existing = null) => {
        const box = document.createElement('div');
        document.body.appendChild(box);
        const c = renderDynamicForm(box, [{ id: 'c', label: 'Counter', type: 'counter', required: false, sortOrder: 0, ...field }], existing);
        const api = {
          c, box,
          show: () => box.querySelector('.counter-display').textContent,
          val: () => c.getField('c').value,
          plus: () => box.querySelector('.counter-btn-plus').click(),
          minus: () => box.querySelector('.counter-btn-minus').click(),
          plusOff: () => box.querySelector('.counter-btn-plus').disabled,
          minusOff: () => box.querySelector('.counter-btn-minus').disabled,
          type: (text, how = 'blur') => {
            box.querySelector('.counter-display').click();
            const input = box.querySelector('.counter-edit-input');
            input.value = text;
            if (how === 'escape') input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            else input.dispatchEvent(new Event('blur'));
          }
        };
        return api;
      };
      const out = {};
      // untouched
      let x = mk({ min: -100, step: 1 });
      out.untouched = [x.show(), x.val(), x.c.getValues().c, x.c.isEmpty()];
      x.plus(); out.minus100plus = [x.show(), x.val()];
      x = mk({ min: -100, step: 1 }); x.minus(); out.minus100minus = [x.show(), x.val()];
      // assumed value 5
      x = mk({ min: 0, max: 20, step: 1, assumedValue: 5 }); x.plus(); out.assumed5plus = x.show();
      x = mk({ min: 0, max: 20, step: 1, assumedValue: 5 }); x.minus(); out.assumed5minus = x.show();
      // min 2, assumed 0: + = 2, - does nothing
      x = mk({ min: 2, max: 9, step: 1 }); x.plus(); out.min2plus = x.show();
      x = mk({ min: 2, max: 9, step: 1 }); out.min2minusOff = x.minusOff(); x.minus(); out.min2minus = [x.show(), x.val()];
      // limits never set "-"
      x = mk({ min: 0, max: 2, step: 1 });
      x.plus(); x.plus(); out.toMax = x.show(); out.plusOffAtMax = x.plusOff(); x.plus(); out.plusAtMax = [x.show(), x.val()];
      x.minus(); x.minus(); out.toMin = x.show(); out.minusOffAtMin = x.minusOff(); x.minus(); out.minusAtMin = [x.show(), x.val()];
      // a number above / below the assumed value steps normally
      x = mk({ min: 0, max: 20, step: 2, assumedValue: 5 });
      x.type('8'); out.typed8 = x.show(); x.plus(); out.above = x.show(); x.minus(); x.minus(); out.belowNow = x.show();
      x.type('2'); x.minus(); out.belowAssumed = x.show(); x.minus(); out.clampedAtMin = x.show();
      // typing
      x = mk({ min: 0, max: 9, step: 1 });
      x.type('0'); out.type0 = [x.show(), x.val(), x.c.getValues().c, x.c.isEmpty()];
      x.type('99'); out.type99 = x.show();
      x.type('-5'); out.typeBelowMin = x.show();
      x.type('4'); x.type(''); out.clearToBlank = [x.show(), x.val(), x.c.getValues().c, x.c.isEmpty()];
      x.type('4'); x.type('7', 'escape'); out.escape = x.show();
      x.box.querySelector('.counter-display').click(); out.editStartsBlankFor4 = box0(x);
      function box0(api) { const i = api.box.querySelector('.counter-edit-input'); const v = i ? i.value : null; if (i) i.dispatchEvent(new Event('blur')); return v; }
      x = mk({ min: 0, max: 9, step: 1 }); x.box.querySelector('.counter-display').click();
      const blankEdit = x.box.querySelector('.counter-edit-input'); out.blankEditValue = blankEdit.value; blankEdit.dispatchEvent(new Event('blur')); out.blankEditStays = x.show();
      // an assumed value outside the range is clamped into it when used
      x = mk({ min: 0, max: 10, step: 1, assumedValue: 20 }); x.plus(); out.assumedAboveMax = x.show();
      x = mk({ min: 0, max: 10, step: 1, assumedValue: 20 }); x.minus(); out.assumedAboveMaxMinus = x.show();
      x = mk({ min: 0, max: 10, step: 1, assumedValue: -4 }); x.plus(); out.assumedBelowMin = x.show();
      x = mk({ min: 0, max: 10, step: 1, assumedValue: -4 }); x.minus(); out.assumedBelowMinMinus = x.show();
      // step 5 / max clamp
      x = mk({ min: 0, max: 7, step: 5 }); x.plus(); const s1 = x.show(); x.plus(); out.step5 = [s1, x.show(), x.plusOff()];
      // an old field with only defaultValue behaves as assumedValue; assumedValue wins when both exist
      x = mk({ min: 0, max: 20, step: 1, defaultValue: 5 }); x.plus(); out.oldDefaultPlus = x.show();
      x = mk({ min: 0, max: 20, step: 1, defaultValue: 5 }); x.minus(); out.oldDefaultMinus = x.show();
      x = mk({ min: 0, max: 20, step: 1, defaultValue: 5, assumedValue: 2 }); x.plus(); out.bothAssumedWins = x.show();
      // saved values
      out.savedZero = (() => { const y = mk({ min: 0 }, { c: 0 }); return [y.show(), y.val(), y.c.getValues().c, y.c.isEmpty()]; })();
      out.savedSeven = (() => { const y = mk({ min: 0 }, { c: 7 }); return [y.show(), y.val(), y.c.getValues().c]; })();
      out.savedNull = (() => { const y = mk({ min: 0 }, { c: null }); return [y.show(), y.val(), y.c.getValues().c]; })();
      out.savedAbsent = (() => { const y = mk({ min: 0 }, { other: 1 }); return [y.show(), y.val()]; })();
      // setValues (the live path): null / '' -> "-", a number -> itself (not clamped: an old entry keeps what it stored)
      x = mk({ min: 0, max: 9, step: 1 });
      x.c.setValues({ c: 4 }); const sv4 = x.show(); x.c.setValues({ c: null }); const svNull = x.show();
      x.c.setValues({ c: 4 }); x.c.setValues({ c: '' }); const svBlank = x.show();
      x.c.setValues({ c: 0 }); const sv0 = x.show(); x.c.setValues({ c: 99 }); out.setValues = [sv4, svNull, svBlank, sv0, x.show()];
      // getValues
      x = mk({ min: 0, max: 9, step: 1 }); const g0 = x.c.getValues().c; x.plus(); const g1 = x.c.getValues().c; x.type('0'); out.getValues = [g0, g1, x.c.getValues().c, typeof x.c.getValues().c];
      // required: refused at "-", fine at 0
      x = mk({ min: 0, max: 9, step: 1, required: true, label: 'Cycles' });
      out.requiredBlank = x.c.validate(); x.type('0'); out.requiredZero = x.c.validate();
      x.type(''); out.requiredCleared = x.c.validate();
      // retired counter = a plain number box
      const retiredFields = withRetiredFieldsHavingValues({ fields: [], retiredFields: [{ id: 'old', label: 'Old', type: 'counter', min: 0, max: 9, step: 1 }] }, { old: 0 });
      const rbox = document.createElement('div'); document.body.appendChild(rbox);
      renderDynamicForm(rbox, retiredFields, { old: 0 });
      out.retired = [retiredFields.length, retiredFields[0] && retiredFields[0].type, rbox.querySelector('#dyn-old').tagName, rbox.querySelector('#dyn-old').value];
      out.retiredNull = withRetiredFieldsHavingValues({ fields: [], retiredFields: [{ id: 'old', label: 'Old', type: 'counter' }] }, { old: null }).length;
      // the pure stepping rule
      const nx = (f, cur, dir) => counterNextValue(f, cur, dir);
      out.next = [nx({ min: -100 }, null, 1), nx({ min: -100 }, null, -1), nx({ min: 2 }, null, 1), nx({ min: 2 }, null, -1), nx({ min: 0, max: 5 }, 5, 1), nx({ min: 0, max: 5 }, 0, -1), nx({ min: 0, step: 3 }, 4, -1)];
      // the buttons at "-" when the Assumed value sits at / past an edge: disabled state (really greyed) and what each press gives
      const edge = (field) => {
        const y = mk(field);
        const look = (btn) => { const cs = getComputedStyle(btn); return { disabled: btn.disabled, opacity: Number(cs.opacity), cursor: cs.cursor }; };
        const state = { shows: y.show(), plus: look(y.box.querySelector('.counter-btn-plus')), minus: look(y.box.querySelector('.counter-btn-minus')) };
        const p = mk(field); p.plus(); state.afterPlus = [p.show(), p.val()];
        const m = mk(field); m.minus(); state.afterMinus = [m.show(), m.val()];
        return state;
      };
      out.edge = {
        oneBelowMin: edge({ min: 5, max: 10, step: 1, assumedValue: 4 }),
        oneAboveMax: edge({ min: 5, max: 10, step: 1, assumedValue: 11 }),
        zeroUnderMin: edge({ min: 3, max: 9, step: 1 }),
        zeroOverMax: edge({ min: -10, max: -3, step: 1 }),
        step2OneBelow: edge({ min: 5, max: 10, step: 2, assumedValue: 3 }),
        step2OneAbove: edge({ min: 5, max: 10, step: 2, assumedValue: 12 }),
        twoAboveMax: edge({ min: 5, max: 10, step: 1, assumedValue: 12 }),
        twoBelowMin: edge({ min: 5, max: 10, step: 1, assumedValue: 3 }),
        onMax: edge({ min: 5, max: 10, step: 1, assumedValue: 10 }),
        onMin: edge({ min: 5, max: 10, step: 1, assumedValue: 5 }),
        normal: edge({ min: 0, max: 20, step: 1, assumedValue: 5 }),
        defaults: edge({ min: 0, step: 1 })
      };
      return out;
    });
    assert.deepEqual(unit.untouched, ['-', '', null, true], 'untouched: "-", value blank, getValues null, empty');
    assert.deepEqual(unit.minus100plus, ['1', '1'], 'min -100, assumed 0: + from "-" gives 1');
    assert.deepEqual(unit.minus100minus, ['-1', '-1'], 'min -100, assumed 0: - from "-" gives -1');
    assert.equal(unit.assumed5plus, '6', 'assumed 5: + gives 6');
    assert.equal(unit.assumed5minus, '4', 'assumed 5: - gives 4');
    assert.equal(unit.min2plus, '2', 'min 2, assumed 0: + gives 2 (never below min)');
    assert.equal(unit.min2minusOff, true, '...and - is disabled');
    assert.deepEqual(unit.min2minus, ['-', ''], '...and - does nothing');
    assert.equal(unit.toMax, '2'); assert.equal(unit.plusOffAtMax, true);
    assert.deepEqual(unit.plusAtMax, ['2', '2'], '+ at max does nothing');
    assert.equal(unit.toMin, '0'); assert.equal(unit.minusOffAtMin, true);
    assert.deepEqual(unit.minusAtMin, ['0', '0'], '- at min does nothing and never sets "-"');
    assert.deepEqual([unit.typed8, unit.above, unit.belowNow], ['8', '10', '6'], 'a number above the assumed value steps by step (step 2), up and back down');
    assert.deepEqual([unit.belowAssumed, unit.clampedAtMin], ['0', '0'], 'below the assumed value steps normally, clamped at min');
    assert.deepEqual(unit.type0, ['0', '0', 0, false], 'a typed 0 is 0 and is data');
    assert.equal(unit.type99, '9', 'typing above max clamps to max');
    assert.equal(unit.typeBelowMin, '0', 'typing below min clamps to min');
    assert.deepEqual(unit.clearToBlank, ['-', '', null, true], 'clearing the box and confirming sets "-"');
    assert.equal(unit.escape, '4', 'Escape cancels the edit');
    assert.equal(unit.editStartsBlankFor4, '4');
    assert.equal(unit.blankEditValue, '', 'editing a "-" starts with an empty box');
    assert.equal(unit.blankEditStays, '-', 'confirming the empty box leaves "-"');
    assert.equal(unit.assumedAboveMax, '-', 'an assumed value above max: + does nothing'); assert.equal(unit.assumedAboveMaxMinus, '10', '...and - is clamped to the max');
    assert.equal(unit.assumedBelowMin, '0'); assert.equal(unit.assumedBelowMinMinus, '-', 'an assumed value below min: + gives min, - does nothing');
    assert.deepEqual(unit.step5, ['5', '7', true], 'step 5 with max 7 clamps to 7');
    assert.equal(unit.oldDefaultPlus, '6', 'an old defaultValue 5 acts as the assumed value: + gives 6');
    assert.equal(unit.oldDefaultMinus, '4');
    assert.equal(unit.bothAssumedWins, '3', 'assumedValue wins over defaultValue');
    assert.deepEqual(unit.savedZero, ['0', '0', 0, false], 'a saved 0 from an old entry shows 0');
    assert.deepEqual(unit.savedSeven, ['7', '7', 7]);
    assert.deepEqual(unit.savedNull, ['-', '', null], 'a saved null shows "-"');
    assert.deepEqual(unit.savedAbsent, ['-', ''], 'an entry without the key shows "-"');
    assert.deepEqual(unit.setValues, ['4', '-', '-', '0', '99'], 'setValues: null / blank -> "-", numbers as they are (not clamped)');
    assert.deepEqual(unit.getValues, [null, 1, 0, 'number']);
    assert.equal(unit.requiredBlank, '"Cycles" is required.', 'a required counter at "-" is refused');
    assert.equal(unit.requiredZero, null, 'a required counter at 0 is fine');
    assert.equal(unit.requiredCleared, '"Cycles" is required.', 'and refused again once cleared');
    assert.deepEqual(unit.retired, [1, 'number', 'INPUT', '0'], 'a retired counter is shown as a plain number box');
    assert.equal(unit.retiredNull, 0, 'a retired counter with no value is not shown');
    assert.deepEqual(unit.next, [1, -1, 2, null, null, null, 1]);

    // ---- the buttons at "-" with the Assumed value at an edge: the disabled one is really greyed, the enabled one gives the limit ----
    const E = unit.edge;
    const isOff = (b) => b.disabled === true && b.opacity < 0.5 && b.cursor === 'not-allowed';
    const isOn = (b) => b.disabled === false && b.opacity === 1;
    const plusMinus = (name, plusState, minusState, afterPlus, afterMinus) => {
      const e = E[name];
      assert.equal(e.shows, '-', `${name}: shows "-"`);
      assert.ok((plusState === 'on' ? isOn : isOff)(e.plus), `${name}: + is ${plusState === 'on' ? 'enabled' : 'disabled and greyed'} (${JSON.stringify(e.plus)})`);
      assert.ok((minusState === 'on' ? isOn : isOff)(e.minus), `${name}: - is ${minusState === 'on' ? 'enabled' : 'disabled and greyed'} (${JSON.stringify(e.minus)})`);
      assert.deepEqual(e.afterPlus, afterPlus, `${name}: pressing +`);
      assert.deepEqual(e.afterMinus, afterMinus, `${name}: pressing -`);
    };
    plusMinus('oneBelowMin', 'on', 'off', ['5', '5'], ['-', '']);        // assumed 4, min 5: + gives min, - disabled
    plusMinus('oneAboveMax', 'off', 'on', ['-', ''], ['10', '10']);      // assumed 11, max 10: + disabled, - gives max
    plusMinus('zeroUnderMin', 'on', 'off', ['3', '3'], ['-', '']);       // default 0, min 3
    plusMinus('zeroOverMax', 'off', 'on', ['-', ''], ['-3', '-3']);      // default 0, max -3
    plusMinus('step2OneBelow', 'on', 'off', ['5', '5'], ['-', '']);      // one step (2) below min
    plusMinus('step2OneAbove', 'off', 'on', ['-', ''], ['10', '10']);    // one step (2) above max
    plusMinus('twoAboveMax', 'off', 'on', ['-', ''], ['10', '10']);
    plusMinus('twoBelowMin', 'on', 'off', ['5', '5'], ['-', '']);
    // normal counters are unchanged: an Assumed value ON a limit still gives the limit, in range both buttons work
    plusMinus('onMax', 'on', 'on', ['10', '10'], ['9', '9']);
    plusMinus('onMin', 'on', 'off', ['6', '6'], ['-', '']);
    plusMinus('normal', 'on', 'on', ['6', '6'], ['4', '4']);
    plusMinus('defaults', 'on', 'off', ['1', '1'], ['-', '']);

    // ================= 2. entries: save, edit, undo (real forms, real documents) =================
    const putConfig = (type, data) => cap.evaluate(async ([tid, id, d]) => {
      await db.collection('teams').doc(tid).collection('formConfig').doc(id).set(d, { merge: true });
    }, [teamId, `${season}_${type}`, data]);
    await putConfig('pitScouting', {
      fields: numbered([field('t1', 'Text', 'text', { showInPreview: true }), field('c1', 'Counter', 'counter', { min: 0, max: 20, step: 1, assumedValue: 5, showInPreview: true }),
        field('c2', 'Old Counter', 'counter', { min: 0, max: 20, step: 1, defaultValue: 3, showInPreview: true })]),
      baseVersion: null, handledVersion: 0, retiredFields: []
    });
    await putConfig('matchScouting', {
      fields: numbered([field('matchNumber', 'Match Number', 'number', { required: true }), field('t1', 'Text', 'text', { showInPreview: true }), field('c1', 'Counter', 'counter', { min: 0, max: 20, step: 1, assumedValue: 5, showInPreview: true })]),
      baseVersion: null, handledVersion: 0, retiredFields: []
    });
    await cap.evaluate(([tid, s]) => { invalidateFormConfigCache(tid, s); invalidateMatchFormConfigCache(tid, s); }, [teamId, season]);

    const openPit = async (page, n) => {
      await page.evaluate(([num, code]) => openPitScoutForm(num, code), [n, CODE]);
      await page.waitForSelector('#pit-modal:not(.hidden) #pit-dynamic-fields .pit-field');
      await page.waitForFunction(() => currentPitLiveSession && currentPitLiveSession.isJoined());
    };
    const shown = (page, modal, id) => page.textContent(`#${modal}-modal #dyn-${id} .counter-display`);
    const typeCounter = async (page, modal, id, text) => {
      await page.click(`#${modal}-modal #dyn-${id} .counter-display`);
      await page.keyboard.press('Control+A');
      if (text === '') await page.keyboard.press('Backspace'); else await page.keyboard.type(text);
      await page.keyboard.press('Enter');
    };
    const plus = (page, modal, id) => page.click(`#${modal}-modal #dyn-${id} .counter-btn-plus`);
    const minus = (page, modal, id) => page.click(`#${modal}-modal #dyn-${id} .counter-btn-minus`);
    const doc = (page, col, n, matchNo) => page.evaluate(async ([tid, c, num, m, code]) => {
      let q = db.collection('teams').doc(tid).collection(c).where('eventCode', '==', code).where('teamNumber', '==', num);
      if (m != null) q = q.where('matchNumber', '==', m);
      const s = await q.get();
      return s.empty ? null : { id: s.docs[0].id, ...s.docs[0].data() };
    }, [teamId, col, n, matchNo ?? null, CODE]);
    const waitField = (page, col, n, key, want, matchNo) => page.waitForFunction(async ([tid, c, num, k, w, m, code]) => {
      let q = db.collection('teams').doc(tid).collection(c).where('eventCode', '==', code).where('teamNumber', '==', num);
      if (m != null) q = q.where('matchNumber', '==', m);
      const s = await q.get();
      if (s.empty) return false;
      const v = s.docs[0].data()[k];
      return (v === undefined ? '__absent' : v) === w;
    }, [teamId, col, n, key, want, matchNo ?? null, CODE]);
    const save = async (page, modal) => { await page.click(modal === 'pit' ? '#btn-pit-save' : '#btn-match-save'); await page.waitForSelector(`#${modal}-modal`, { state: 'hidden' }); };
    const cancel = async (page, modal) => { await page.click(modal === 'pit' ? '#btn-pit-cancel-inline' : '#btn-match-cancel-inline'); await page.waitForSelector(`#${modal}-modal`, { state: 'hidden' }); };

    // an entry saved with both counters untouched: null, not 0 (the key is there, as null; the checkpoint too)
    await openPit(cap, 202);
    assert.deepEqual([await shown(cap, 'pit', 'c1'), await shown(cap, 'pit', 'c2')], ['-', '-'], 'a new entry starts with both counters at "-"');
    await cap.fill('#pit-modal #dyn-t1', 'untouched');
    await save(cap, 'pit');
    let d = await doc(cap, 'pitScouting', 202);
    // (a live session writes a field only when it is touched, so the key is simply absent, exactly like an untouched number box)
    assert.ok(d.c1 == null && d.c2 == null, 'untouched counters are stored as null / absent, never 0');
    assert.strictEqual(d.checkpoint.c1, null, 'commit checkpoints null for "-"');
    assert.strictEqual(d.checkpoint.c2, null);
    assert.strictEqual(d.t1, 'untouched');

    // an entry with real numbers: + from "-" with assumed 5, - from "-" with an old default 3, then a typed 0
    await openPit(cap, 303);
    await plus(cap, 'pit', 'c1');
    assert.equal(await shown(cap, 'pit', 'c1'), '6', 'assumed 5 -> 6');
    await minus(cap, 'pit', 'c2');
    assert.equal(await shown(cap, 'pit', 'c2'), '2', 'old defaultValue 3 acts as assumed 3 -> 2');
    await typeCounter(cap, 'pit', 'c2', '0');
    assert.equal(await shown(cap, 'pit', 'c2'), '0');
    await cap.fill('#pit-modal #dyn-t1', 'numbers');
    await save(cap, 'pit');
    d = await doc(cap, 'pitScouting', 303);
    assert.strictEqual(d.c1, 6);
    assert.strictEqual(d.c2, 0, 'a typed 0 is stored as 0');

    // edit of that (older) entry: the saved 0 shows 0, "-" typed over a number saves null, the 0 survives
    await openPit(cap, 303);
    assert.deepEqual([await shown(cap, 'pit', 'c1'), await shown(cap, 'pit', 'c2')], ['6', '0'], 'the saved numbers (incl. the 0) show as they are');
    await typeCounter(cap, 'pit', 'c1', '-');
    assert.equal(await shown(cap, 'pit', 'c1'), '-');
    await save(cap, 'pit');
    d = await doc(cap, 'pitScouting', 303);
    assert.strictEqual(d.c1, null, 'typing "-" over a number saves null');
    assert.strictEqual(d.c2, 0, 'the 0 is untouched');
    assert.strictEqual(d.checkpoint.c1, null);

    // cancel / undo: a changed number goes back to the checkpoint (a 0, and a null)
    await openPit(cap, 303);
    await plus(cap, 'pit', 'c2');
    await waitField(cap, 'pitScouting', 303, 'c2', 1);
    await cancel(cap, 'pit');
    await waitField(cap, 'pitScouting', 303, 'c2', 0);
    await openPit(cap, 202);
    await plus(cap, 'pit', 'c1');
    await waitField(cap, 'pitScouting', 202, 'c1', 6);
    await cancel(cap, 'pit');
    await waitField(cap, 'pitScouting', 202, 'c1', null);
    await openPit(cap, 202);
    assert.equal(await shown(cap, 'pit', 'c1'), '-', 'after Cancel the counter is back to "-"');
    await cancel(cap, 'pit');
    // ...and a new entry that is abandoned leaves nothing but the shell: "-" is restored in it too
    await openPit(cap, 101);
    await plus(cap, 'pit', 'c1');
    await waitField(cap, 'pitScouting', 101, 'c1', 6);
    await cancel(cap, 'pit');
    await waitField(cap, 'pitScouting', 101, 'c1', null);

    // ================= 3. live sync between two windows, and the layout of "-" =================
    const mem = await ctx.newPage('member');
    await signInUI(mem, member);
    await joinTeamUI(mem, joinCode);
    await selectFixtureEvent(mem);
    await openPit(cap, 101);
    await openPit(mem, 101);
    // layout of the counter showing "-" (320px - 1280px), while the entry is open
    for (const width of [320, 375, 414, 768, 1280]) {
      await cap.setViewportSize({ width, height: 700 });
      await cap.waitForTimeout(120);
      const m = await cap.evaluate(() => {
        const f = document.querySelector('#pit-modal #dyn-c1');
        const r = f.getBoundingClientRect();
        const card = document.querySelector('#pit-modal .modal-card').getBoundingClientRect();
        const disp = f.querySelector('.counter-display').getBoundingClientRect();
        const btns = [...f.querySelectorAll('.counter-btn')].map(b => b.getBoundingClientRect());
        return { l: r.left, r: r.right, cl: card.left, cr: card.right, dispW: disp.width, dispH: disp.height, text: f.querySelector('.counter-display').textContent,
          btnW: btns.map(b => b.width), btnInside: btns.every(b => b.left >= card.left - 1 && b.right <= card.right + 1), iw: window.innerWidth, pageW: document.documentElement.scrollWidth,
          overflow: f.scrollWidth - f.clientWidth };
      });
      assert.equal(m.text, '-', `${width}px: shows "-"`);
      assert.ok(m.dispW > 8 && m.dispH > 8, `${width}px: the "-" has a real tap target`);
      assert.ok(m.btnW.every(w => w >= 40), `${width}px: the +/- buttons keep their size`);
      assert.ok(m.btnInside && m.l >= m.cl - 1 && m.r <= m.cr + 1, `${width}px: the counter sits inside the form`);
      assert.ok(m.overflow <= 1 && m.pageW <= m.iw + 1, `${width}px: nothing overflows sideways`);
    }
    await cap.setViewportSize({ width: 1280, height: 900 });

    // live: + in one window shows in the other; typing "-" clears it in both; a typed 0 shows as 0
    await plus(cap, 'pit', 'c1');
    await mem.waitForFunction(() => document.querySelector('#pit-modal #dyn-c1 .counter-display').textContent === '6');
    await typeCounter(cap, 'pit', 'c1', '-');
    await mem.waitForFunction(() => document.querySelector('#pit-modal #dyn-c1 .counter-display').textContent === '-');
    await waitField(cap, 'pitScouting', 101, 'c1', null);
    await typeCounter(mem, 'pit', 'c1', '0');
    await cap.waitForFunction(() => document.querySelector('#pit-modal #dyn-c1 .counter-display').textContent === '0');
    await waitField(cap, 'pitScouting', 101, 'c1', 0);
    await typeCounter(mem, 'pit', 'c1', '');
    await cap.waitForFunction(() => document.querySelector('#pit-modal #dyn-c1 .counter-display').textContent === '-');
    await waitField(cap, 'pitScouting', 101, 'c1', null);
    await plus(mem, 'pit', 'c2'); // old defaultValue 3 -> 4
    await cap.waitForFunction(() => document.querySelector('#pit-modal #dyn-c2 .counter-display').textContent === '4');
    await cancel(mem, 'pit'); // not the last editor: nothing is reverted
    await cap.fill('#pit-modal #dyn-t1', 'live');
    await save(cap, 'pit');
    d = await doc(cap, 'pitScouting', 101);
    assert.strictEqual(d.c1, null, 'live: the "-" was committed as null');
    assert.strictEqual(d.c2, 4, 'live: the other window\'s number was kept');
    assert.strictEqual(d.checkpoint.c1, null);
    await mem.close();

    // ================= 4. readers: previews, Pit vs Match, scouted list, viewer, exports, averages =================
    // three match entries for team 101 (batch): c1 left at "-", typed 4, typed 0
    const saveMatch = async (matchNo, text, counterText) => {
      await cap.evaluate(([n, code]) => openMatchScoutForm(n, code), [101, CODE]);
      await cap.waitForSelector('#match-modal:not(.hidden) #match-dynamic-fields .pit-field');
      await cap.fill('#match-modal #dyn-matchNumber', String(matchNo));
      await cap.fill('#match-modal #dyn-t1', text);
      if (counterText !== null) await typeCounter(cap, 'match', 'c1', counterText);
      await save(cap, 'match');
    };
    await saveMatch(1, 'm1', null);
    await saveMatch(2, 'm2', '4');
    await saveMatch(3, 'm3', '0');
    assert.strictEqual((await doc(cap, 'matchScouting', 101, 1)).c1, null, 'batch: untouched counter saved as null');
    assert.strictEqual((await doc(cap, 'matchScouting', 101, 2)).c1, 4);
    assert.strictEqual((await doc(cap, 'matchScouting', 101, 3)).c1, 0, 'batch: typed 0 saved as 0');

    const stats = await cap.evaluate(() => {
      const f = [{ id: 'c', label: 'C', type: 'counter' }, { id: 'n', label: 'N', type: 'number' }];
      const mixed = computeMatchFieldStats([{ c: null, n: null }, { c: 2, n: 2 }, { c: 4, n: 4 }, {}, { c: 0, n: 0 }], f);
      const allNull = computeMatchFieldStats([{ c: null }, {}], f);
      return { mixed: mixed.map(s => ({ count: s.count, avg: s.avg, min: s.min, max: s.max })), allNull: allNull.map(s => s.count),
        rows: buildComparisonStatsRows(f, [{ c: null }, { c: 2 }, { c: 4 }]).filter(r => r[0] === 'C').map(r => r.slice(2)),
        display: [formatFieldValueForDisplay(null), formatFieldValueForDisplay(0), formatFieldValueForDisplay(undefined)] };
    });
    assert.deepEqual(stats.mixed[0], { count: 3, avg: 2, min: 0, max: 4 }, 'averages skip the nulls: 2, 4 and a real 0 -> avg 2 over 3 answers (not 1.2 over 5)');
    assert.deepEqual(stats.mixed[1], { count: 3, avg: 2, min: 0, max: 4 }, 'the same for a plain number field');
    assert.deepEqual(stats.allNull, [0, 0], 'only nulls: no data, never a 0 average');
    assert.deepEqual(stats.rows, [['Average', 3], ['Min', 2], ['Max', 4], ['Matches Counted', 2]], 'the Pit vs Match export rows skip nulls');
    assert.deepEqual(stats.display, ['—', '0', '—'], 'the shared display helper: null is the blank placeholder, 0 stays 0');

    // Pit vs Match modal: the match stats skip the m1 null (avg of 4 and 0), the pit side shows the live entry
    await openScoutingSubtab(cap, 'compare');
    await (await teamRow(cap, '#team-list-compare', 101)).getByRole('button', { name: 'Compare' }).click();
    await cap.waitForSelector('#comparison-modal:not(.hidden)');
    await cap.waitForFunction(() => /Avg/.test(document.getElementById('cmp-match-stats').textContent));
    const cmp = await cap.textContent('#cmp-match-stats');
    assert.match(cmp, /Counter\s*Avg 2\.0 \(min 0, max 4\) — n=2/, `Pit vs Match: the average skips the "-" entry (${cmp.replace(/\s+/g, ' ')})`);
    const cmpPit = await cap.textContent('#cmp-pit-data');
    assert.match(cmpPit.replace(/\s+/g, ' '), /Counter—/, 'Pit vs Match pit side: a null counter shows the blank placeholder');
    assert.match(cmpPit.replace(/\s+/g, ' '), /Old Counter4/);
    await cap.click('#btn-cmp-view-pit-entry');
    await cap.waitForSelector('#view-entry-modal:not(.hidden)');
    assert.equal(await cap.textContent('#view-entry-fields #dyn-c1 .counter-display'), '-', 'the read-only entry viewer shows "-"');
    assert.equal(await cap.textContent('#view-entry-fields #dyn-c2 .counter-display'), '4');
    assert.ok(await cap.evaluate(() => [...document.querySelectorAll('#view-entry-fields .counter-btn')].every(b => b.disabled)), 'and stays read-only');
    await cap.evaluate(() => closeViewEntryModal());
    await cap.evaluate(() => { document.getElementById('comparison-modal').classList.add('hidden'); });

    // the scouted-matches list: blank placeholder for the null, the numbers (and the 0) as they are
    await cap.evaluate(([n, code]) => openMatchScoutedModal(n, code, {}), [101, CODE]);
    await cap.waitForFunction(() => document.querySelectorAll('#msm-match-entries > *').length >= 3);
    const items = (await cap.$$eval('#msm-match-entries > *', els => els.map(e => e.textContent.replace(/\s+/g, ' '))));
    const itemFor = (n) => items.find(t => new RegExp(`^Match #${n}(?!\\d)`).test(t)) || '';
    assert.match(itemFor(1), /Counter: —/, 'scouted matches: the null counter shows —');
    assert.match(itemFor(2), /Counter: 4/);
    assert.match(itemFor(3), /Counter: 0/, 'scouted matches: a real 0 shows 0');
    await cap.evaluate(() => closeMatchScoutedModal());

    // the real Excel exports: "N/A" for a counter nobody answered (null OR absent - test 39 covers the export rule), 0 for a real 0
    await openScoutingSubtab(cap, 'match');
    await cap.click('#btn-export-event-match');
    await cap.waitForSelector('#export-choice-modal:not(.hidden)');
    const xm = await downloadExcel(cap);
    const byMatch = Object.fromEntries(xm.match.map(r => [r['Match Number'], r]));
    assert.strictEqual(byMatch[1].Counter, 'N/A', 'Excel match export: the null counter is N/A, never 0');
    assert.strictEqual(byMatch[2].Counter, 4);
    assert.strictEqual(byMatch[3].Counter, 0, 'Excel match export: a real 0 is 0');
    await openScoutingSubtab(cap, 'pit');
    await cap.click('#btn-export-event-pit');
    await cap.waitForSelector('#export-choice-modal:not(.hidden)');
    const xp = await downloadExcel(cap);
    const byTeam = Object.fromEntries(xp.pit.map(r => [r['Team Number'], r]));
    // team 202 was never touched in the live form (its key is absent); team 303's counter was typed back to "-" (saved null): both N/A
    assert.strictEqual(byTeam[202].Counter, 'N/A', 'Excel pit export: an untouched counter (absent key) is N/A, never 0');
    assert.strictEqual(byTeam[202]['Old Counter'], 'N/A');
    assert.strictEqual(byTeam[303].Counter, 'N/A', 'Excel pit export: a counter typed back to "-" (saved null) is N/A');
    assert.strictEqual(byTeam[303]['Old Counter'], 0, 'Excel pit export: a real 0 is 0');
    assert.strictEqual(byTeam[101]['Old Counter'], 4);
    const sheetRows = await cap.evaluate(() => buildSheetRows([{ id: 'c', label: 'C' }], [{ teamNumber: 1, c: null }, { teamNumber: 2, c: 0 }, { teamNumber: 3 }], [{ header: 'Team', key: 'teamNumber' }]).slice(1).map(r => r.slice(0, 2)));
    assert.deepEqual(sheetRows, [[1, 'N/A'], [2, 0], [3, 'N/A']], 'the Sheets / Excel row builder: null and a missing key are N/A, 0 stays 0');

    // ================= 5. the builder's Assumed value setting (team builder, season 2020) =================
    const BS = '2020';
    await cap.evaluate(async ([tid]) => {
      await db.collection('teams').doc(tid).collection('formConfig').doc('2020_pitScouting').set({
        fields: [
          { id: 'oldc', label: 'Old Counter Field', type: 'counter', required: false, sortOrder: 0, showInPreview: false, min: 0, max: 10, step: 1, defaultValue: 4 },
          { id: 'note', label: 'Note', type: 'text', required: false, sortOrder: 1, showInPreview: false }
        ], baseVersion: null, handledVersion: 0, retiredFields: []
      });
    }, [teamId]);
    await openMyTeamTab(cap);
    await openBuilderFor(cap, BS, 'pitScouting');
    const builderRow = (label) => cap.locator('#builder-field-list .builder-field-item').filter({ has: cap.locator('.builder-field-label', { hasText: new RegExp(`^${label}$`) }) });
    await cap.waitForFunction(() => document.querySelectorAll('#builder-field-list .builder-field-item').length === 2);
    // an old field's defaultValue shows as its Assumed value; saving rewrites it as assumedValue
    await builderRow('Old Counter Field').getByRole('button', { name: 'Edit' }).click();
    await cap.waitForSelector('#field-editor-modal:not(.hidden)');
    assert.equal(await cap.inputValue('#bld-field-assumed'), '4', 'an old defaultValue shows as the Assumed value');
    assert.equal((await cap.textContent('label[for="bld-field-assumed"]')).trim(), 'Assumed value (what - counts as when you press + or -)');
    assert.equal(await cap.locator('#bld-field-default').count(), 0, 'the old "Starting Value" box is gone');
    await cap.click('#btn-bld-save');
    await cap.waitForSelector('#field-editor-modal', { state: 'hidden' });
    let cfg = await readFormConfig(cap, teamId, BS, 'pitScouting');
    let oldc = cfg.fields.find(f => f.id === 'oldc');
    assert.strictEqual(oldc.assumedValue, 4, 'saved as assumedValue');
    assert.ok(!('defaultValue' in oldc), 'defaultValue is not written again');
    // validation: max below min is refused, max = min is fine, a changed assumed value saves
    await builderRow('Old Counter Field').getByRole('button', { name: 'Edit' }).click();
    await cap.waitForSelector('#field-editor-modal:not(.hidden)');
    await cap.fill('#bld-field-min', '5'); await cap.fill('#bld-field-max', '3');
    await cap.click('#btn-bld-save');
    assert.equal((await cap.textContent('#field-editor-error')).trim(), "Counter maximum can't be lower than the minimum.");
    assert.ok(await cap.isVisible('#field-editor-modal'), 'the editor stays open');
    await cap.fill('#bld-field-max', '5');
    await cap.fill('#bld-field-assumed', '2');
    await cap.click('#btn-bld-save');
    // min = max with an assumed value outside it: one combined "Save anyway?" confirm (test 38 covers the warnings in full)
    await cap.waitForSelector('#generic-confirm-modal:not(.hidden)');
    await cap.click('#btn-generic-confirm-proceed');
    await cap.waitForSelector('#field-editor-modal', { state: 'hidden' });
    cfg = await readFormConfig(cap, teamId, BS, 'pitScouting');
    oldc = cfg.fields.find(f => f.id === 'oldc');
    assert.deepEqual([oldc.min, oldc.max, oldc.assumedValue], [5, 5, 2], 'min = max is accepted; the edited assumed value is stored');
    // layout of the editor at 320px - 1280px, with the long Assumed value label
    await builderRow('Old Counter Field').getByRole('button', { name: 'Edit' }).click();
    await cap.waitForSelector('#field-editor-modal:not(.hidden)');
    for (const width of [320, 375, 414, 768, 1280]) {
      await cap.setViewportSize({ width, height: 600 });
      await cap.waitForTimeout(120);
      const m = await cap.evaluate(() => {
        const input = document.getElementById('bld-field-assumed').getBoundingClientRect();
        const label = document.querySelector('label[for="bld-field-assumed"]').getBoundingClientRect();
        const card = document.querySelector('#field-editor-modal .modal-card').getBoundingClientRect();
        const save = document.getElementById('btn-bld-save');
        save.scrollIntoView({ block: 'nearest' });
        const s = save.getBoundingClientRect();
        return { il: input.left, ir: input.right, ll: label.left, lr: label.right, cl: card.left, cr: card.right, sl: s.left, sr: s.right, st: s.top, sb: s.bottom, iw: window.innerWidth, ih: window.innerHeight, pageW: document.documentElement.scrollWidth };
      });
      assert.ok(m.il >= m.cl - 1 && m.ir <= m.cr + 1 && m.ll >= m.cl - 1 && m.lr <= m.cr + 1, `${width}px: the Assumed value label and box sit inside the editor`);
      assert.ok(m.sl >= 0 && m.sr <= m.iw + 1 && m.st >= 0 && m.sb <= m.ih + 1, `${width}px: Save can be reached on screen`);
      assert.ok(m.pageW <= m.iw + 1, `${width}px: no sideways scroll`);
    }
    await cap.setViewportSize({ width: 1280, height: 900 });
    await cap.click('#btn-bld-cancel-inline');
    await cap.waitForSelector('#field-editor-modal', { state: 'hidden' });
    // add a counter with an Assumed value; one left at 0 stores no key
    const addCounter = async (label, assumed) => {
      await cap.click('#btn-builder-add-field');
      await cap.waitForSelector('#field-editor-modal:not(.hidden)');
      await cap.fill('#bld-field-label', label);
      await cap.selectOption('#bld-field-type', 'counter');
      await cap.setChecked('#bld-field-show-in-preview', false);
      assert.equal(await cap.inputValue('#bld-field-assumed'), '0', 'a new counter\'s Assumed value starts at 0');
      if (assumed !== null) await cap.fill('#bld-field-assumed', String(assumed));
      await cap.click('#btn-bld-save');
      await cap.waitForSelector('#field-editor-modal', { state: 'hidden' });
      await cap.waitForFunction((l) => [...document.querySelectorAll('#builder-field-list .builder-field-label')].some(e => e.textContent.trim() === l), label);
    };
    await addCounter('Added Counter', 7);
    await addCounter('Zero Counter', null);
    cfg = await readFormConfig(cap, teamId, BS, 'pitScouting');
    assert.strictEqual(cfg.fields.find(f => f.label === 'Added Counter').assumedValue, 7);
    assert.ok(!('assumedValue' in cfg.fields.find(f => f.label === 'Zero Counter')) && !('defaultValue' in cfg.fields.find(f => f.label === 'Zero Counter')), 'the default 0 stores nothing');
    // Copy keeps the setting
    await builderRow('Added Counter').locator('[data-builder-action="copy"]').click();
    await cap.waitForFunction(() => [...document.querySelectorAll('#builder-field-list .builder-field-label')].some(e => e.textContent.trim() === 'Added Counter (copy)'));
    cfg = await readFormConfig(cap, teamId, BS, 'pitScouting');
    assert.strictEqual(cfg.fields.find(f => f.label === 'Added Counter (copy)').assumedValue, 7, 'Copy keeps the assumed value');
    await closeBuilder(cap);

    // ================= 6. admin mode: the same setting in the draft, then published =================
    const OS = '2024';
    const adm = await ctx.newPage('admin');
    await signInUI(adm, admin);
    await adm.click('#btn-open-admin-from-team');
    await adm.waitForSelector('#builder-modal:not(.hidden)');
    await adm.selectOption('#builder-season-select', OS);
    await adm.waitForFunction((s) => currentBuilderSeason === s && adminDrafts.has(`${s}_pitScouting`) && !document.getElementById('builder-field-list').textContent.includes('Loading'), OS);
    await adm.click('#btn-builder-add-field');
    await adm.waitForSelector('#field-editor-modal:not(.hidden)');
    await adm.fill('#bld-field-label', 'Admin Counter');
    await adm.selectOption('#bld-field-type', 'counter');
    await adm.setChecked('#bld-field-show-in-preview', false);
    await adm.fill('#bld-field-assumed', '7');
    await adm.click('#btn-bld-save');
    await adm.waitForSelector('#field-editor-modal', { state: 'hidden' });
    const draftField = () => adm.evaluate((s) => (adminDrafts.get(`${s}_pitScouting`).fields.find(f => f.label === 'Admin Counter') || {}), OS);
    assert.strictEqual((await draftField()).assumedValue, 7, 'admin draft: the assumed value is in the draft');
    const arow = adm.locator('#builder-field-list .builder-field-item').filter({ has: adm.locator('.builder-field-label', { hasText: /^Admin Counter$/ }) });
    await arow.getByRole('button', { name: 'Edit' }).click();
    await adm.waitForSelector('#field-editor-modal:not(.hidden)');
    assert.equal(await adm.inputValue('#bld-field-assumed'), '7');
    await adm.fill('#bld-field-assumed', '8');
    await adm.click('#btn-bld-save');
    await adm.waitForSelector('#field-editor-modal', { state: 'hidden' });
    assert.strictEqual((await draftField()).assumedValue, 8, 'admin draft: edited');
    await arow.locator('[data-builder-action="copy"]').click();
    await adm.waitForFunction(() => [...document.querySelectorAll('#builder-field-list .builder-field-label')].some(e => e.textContent.trim() === 'Admin Counter (copy)'));
    assert.strictEqual(await adm.evaluate((s) => adminDrafts.get(`${s}_pitScouting`).fields.find(f => f.label === 'Admin Counter (copy)').assumedValue, OS), 8, 'admin draft: Copy keeps it');
    await adm.click('#btn-builder-close');
    await adm.waitForSelector('#builder-modal', { state: 'hidden' });

    // ================= 7. official forms: publish, the identical rule, Merge, the viewer =================
    await selectAppSeason(cap, OS);
    await openMyTeamTab(cap);
    const waitItems = (n) => cap.waitForFunction((c) => document.querySelectorAll('#official-forms-notice-myteam .official-notice-item').length === c, n);
    const official = numbered([field('alpha', 'Alpha', 'text', { showInPreview: true }), field('gamma', 'Gamma', 'counter', { min: 0, max: 9, step: 1, assumedValue: 5, showInPreview: true })]);
    // the team's copy says defaultValue 5: the same field as assumedValue 5 -> no notice at all
    await cap.evaluate(([tid, f]) => db.collection('teams').doc(tid).collection('formConfig').doc('2024_pitScouting').set({
      fields: f, baseVersion: null, handledVersion: 0, retiredFields: [] }), [teamId, numbered([official[0], { ...official[1], assumedValue: undefined, defaultValue: 5 }].map(x => JSON.parse(JSON.stringify(x))))]);
    assert.equal(await publishOfficialForm(adm, { season: OS, formType: 'pitScouting', fields: official }) >= 1, true);
    await cap.waitForFunction((s) => officialForms.has(`${s}_pitScouting`) && teamConfigDocs.has(`${s}_pitScouting`), OS);
    await cap.waitForTimeout(500);
    assert.equal((await noticeItems(cap)).length, 0, 'defaultValue 5 on the team form == assumedValue 5 on the official form: no notice');
    const same = await cap.evaluate(() => ({
      a: sameFieldDefinition({ id: 'g', type: 'counter', min: 0, defaultValue: 5 }, { id: 'g', type: 'counter', min: 0, assumedValue: 5 }),
      zero: sameFieldDefinition({ id: 'g', type: 'counter', min: 0 }, { id: 'g', type: 'counter', min: 0, assumedValue: 0 }),
      zeroOld: sameFieldDefinition({ id: 'g', type: 'counter', min: 0, defaultValue: 0 }, { id: 'g', type: 'counter', min: 0 }),
      diff: sameFieldDefinition({ id: 'g', type: 'counter', min: 0, assumedValue: 5 }, { id: 'g', type: 'counter', min: 0, assumedValue: 6 }),
      bothWin: sameFieldDefinition({ id: 'g', type: 'counter', defaultValue: 3, assumedValue: 5 }, { id: 'g', type: 'counter', assumedValue: 5 }),
      names: describeFieldDifferences({ id: 'g', type: 'counter', assumedValue: 5 }, { id: 'g', type: 'counter', assumedValue: 6 }),
      namesOld: describeFieldDifferences({ id: 'g', type: 'counter', defaultValue: 5 }, { id: 'g', type: 'counter', assumedValue: 6 }),
      line: describeFieldDefinition({ id: 'g', type: 'counter', min: 0, max: 9, step: 1, assumedValue: 5 }),
      lineOld: describeFieldDefinition({ id: 'g', type: 'counter', min: 0, max: 9, step: 1, defaultValue: 5 }),
      lineZero: describeFieldDefinition({ id: 'g', type: 'counter', min: 0, max: 9, step: 1 })
    }));
    assert.deepEqual([same.a, same.zero, same.zeroOld, same.diff, same.bothWin], [true, true, true, false, true]);
    assert.deepEqual(same.names, ['Counter settings']);
    assert.deepEqual(same.namesOld, ['Counter settings']);
    assert.match(same.line, /Range 0-9, step 1, assumed 5/);
    assert.match(same.lineOld, /Range 0-9, step 1, assumed 5/);
    assert.ok(!/assumed/.test(same.lineZero), 'assumed 0 is not mentioned');
    // a different assumed value brings the notice back; the viewer and the Merge screen name it
    await cap.evaluate(([tid, f]) => db.collection('teams').doc(tid).collection('formConfig').doc('2024_pitScouting').set({ fields: f }, { merge: true }),
      [teamId, numbered([official[0], { ...official[1], assumedValue: 3 }])]);
    await waitItems(1);
    await noticeButton(cap, 'pitScouting', 'view').click();
    await cap.waitForSelector('#official-form-view-modal:not(.hidden)');
    const viewerMeta = (await cap.$$eval('#official-view-fields .builder-field-meta', els => els.map(e => e.textContent))).join(' | ');
    assert.match(viewerMeta, /Range 0-9, step 1, assumed 5/, 'the viewer shows the official assumed value');
    await cap.click('#btn-official-view-close');
    await noticeButton(cap, 'pitScouting', 'merge').click();
    await cap.waitForSelector('#official-merge-modal:not(.hidden)');
    const different = cap.locator('#official-merge-modal [data-section="different"] .merge-field[data-field="gamma"]');
    assert.match(await different.textContent(), /Differs in: Counter settings/, 'Merge: an assumed value difference is a Counter settings difference');
    assert.match(await different.textContent(), /assumed 3/);
    assert.match(await different.textContent(), /assumed 5/);
    await different.locator('input[value="official"]').check();
    await cap.click('#btn-official-merge-confirm');
    await cap.waitForSelector('#official-merge-modal', { state: 'hidden' });
    cfg = await readFormConfig(cap, teamId, OS, 'pitScouting');
    assert.strictEqual(cfg.fields.find(f => f.id === 'gamma').assumedValue, 5, 'Merge: the official assumed value was taken');
    assert.ok(!('defaultValue' in cfg.fields.find(f => f.id === 'gamma')));
    await waitItems(0);
    await selectAppSeason(cap, season);
  }
};
