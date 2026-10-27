// Retired (deleted) fields — what an ACCEPT of an official form, or the team builder's ✕, leaves behind for entries that were
// scouted under the old form (js/official-forms.js, dynamic-form.js, live-entry-sync.js, sheets-export.js):
//   - editing an old entry that has a value in a retired field shows it, filled in, with a clear note
//     ("Deleted field: no longer on the form"); clearing it and saving removes the value from the stored
//     entry, after which the field is gone from that entry; leaving it keeps the value; Cancel keeps it
//   - a retired field is NEVER required: no asterisk, no required state, no "required" error — even
//     though Drive Type WAS a required field before it was removed
//   - a retired field with no value is not shown; a NEW entry never shows any
//   - the live checkpoint / cancel / commit paths keep working with retired fields (pit = live session,
//     match = the batch save path)
//   - exports: "Include deleted fields" (default OFF) is offered ONLY when an included entry has a value
//     in such a field; when ticked the columns are labelled "<label> (deleted)"; checkpoint /
//     activeEditors bookkeeping never shows up as a column (it used to)

const fs = require('node:fs');
const assert = require('node:assert/strict');
const { createRulesTestEnv } = require('../lib/harness');
const { getDocs, collection } = require('firebase/firestore');
const {
  signInUI, createTeamUI, formField, publishOfficialForm, readFormConfig, createScrimmageUI, openScrimmageUI,
  addAndScoutUI, openScoutingSubtab, fillRequiredFields, selectFixtureEvent, pitScoutTeam, openMyTeamTab,
  openBuilderFor, closeBuilder, noticeButton, noticeItems, confirmGeneric, teamRow
} = require('../lib/app');

const SEASON = '2024';

const waitItems = (page, n) =>
  page.waitForFunction((c) => document.querySelectorAll('#official-forms-notice-myteam .official-notice-item').length === c, n);

async function waitPitFormReady(page) {
  await page.waitForSelector('#pit-modal:not(.hidden) #pit-dynamic-fields .pit-field');
  await page.waitForFunction(() => typeof currentPitLiveSession !== 'undefined' && currentPitLiveSession && currentPitLiveSession.isJoined());
}

// Opens the existing pit entry of a roster team from the Pit tab ("Edit Pit Scout").
async function openPitEntry(page, number) {
  await page.click('#dashboard-tabs .tab[data-dtab="scouting"]');
  await openScoutingSubtab(page, 'pit');
  await (await teamRow(page, '#team-list-pit', number)).locator('.btn-pit-quick-scout').click();
  await waitPitFormReady(page);
}

const fieldInfo = (page, modal, id) => page.evaluate(([m, fid]) => {
  const div = document.querySelector(`${m} .pit-field[data-field-id="${fid}"]`);
  if (!div) return null;
  const el = div.querySelector(`#dyn-${fid}`);
  return {
    retired: div.classList.contains('field-retired'),
    label: div.querySelector('label').textContent.trim(),
    note: (div.querySelector('.retired-field-note') || {}).textContent || '',
    value: el ? el.value : null,
    required: el ? !!el.required : null,
    visible: !!(div.offsetWidth || div.offsetHeight)
  };
}, [modal, id]);

const pitDoc = (page, teamId, number) => page.evaluate(async ([tid, n]) => {
  const snap = await db.collection('teams').doc(tid).collection('pitScouting').where('teamNumber', '==', n).get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }))[0] || null;
}, [teamId, number]);

const matchDocs = (page, teamId, number) => page.evaluate(async ([tid, n]) => {
  const snap = await db.collection('teams').doc(tid).collection('matchScouting').where('teamNumber', '==', n).get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}, [teamId, number]);

// Clicks Excel in the open choice modal; returns { <file>: { pit: [rows], match: [rows], pitHeader, matchHeader } } for a
// zip (whole team) or a single { workbook } for a plain .xlsx.
async function downloadExcel(page) {
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#btn-export-choice-excel')]);
  const b64 = fs.readFileSync(await download.path()).toString('base64');
  return page.evaluate(async ({ data, name }) => {
    const readWb = (wb) => ({
      pit: wb.Sheets['Pit Scouting'] ? XLSX.utils.sheet_to_json(wb.Sheets['Pit Scouting']) : [],
      match: wb.Sheets['Match Scouting'] ? XLSX.utils.sheet_to_json(wb.Sheets['Match Scouting']) : [],
      pitHeader: wb.Sheets['Pit Scouting'] ? XLSX.utils.sheet_to_json(wb.Sheets['Pit Scouting'], { header: 1 })[0] || [] : [],
      matchHeader: wb.Sheets['Match Scouting'] ? XLSX.utils.sheet_to_json(wb.Sheets['Match Scouting'], { header: 1 })[0] || [] : []
    });
    if (/\.zip$/i.test(name)) {
      const zip = await JSZip.loadAsync(data, { base64: true });
      const out = {};
      for (const f of Object.keys(zip.files)) out[f] = readWb(XLSX.read(await zip.file(f).async('array'), { type: 'array' }));
      return out;
    }
    return { workbook: readWb(XLSX.read(data, { type: 'base64' })) };
  }, { data: b64, name: download.suggestedFilename() });
}

const choiceOpen = (page) => page.waitForSelector('#export-choice-modal:not(.hidden)');
const closeChoice = async (page) => { await page.click('#btn-export-choice-close'); await page.waitForSelector('#export-choice-modal', { state: 'hidden' }); };
const deletedOptionShown = (page) => page.isVisible('#export-choice-deleted-option');

module.exports = {
  name: 'official forms: retired fields — edit shows value + note, clear & save works with NO required error, new entry hides them, live cancel/commit, export "Include deleted fields"',
  async run(ctx) {
    const admin = await ctx.adminUser();
    const captain = await ctx.makeUser('Captain Retire');
    const adminPage = await ctx.newPage('admin');
    await signInUI(adminPage, admin);
    const cap = await ctx.newPage('captain');
    await signInUI(cap, captain);
    await createTeamUI(cap, 'Retired Fields Team');
    const teamId = await cap.evaluate(() => currentTeamData.id);

    // ---------- (1) the old-form entries: an official event entry (for the checkpoint-column regression) ----------
    await selectFixtureEvent(cap);
    await pitScoutTeam(cap, 101, 'event note');
    await openScoutingSubtab(cap, 'pit');
    await cap.click('#btn-export-event-pit');
    await choiceOpen(cap);
    assert.ok(!(await deletedOptionShown(cap)), 'no deleted-field values in this export -> the option is NOT offered');
    let out = await downloadExcel(cap);
    assert.ok(!out.workbook.pitHeader.some(h => /checkpoint|activeEditors|deletionNotice/i.test(h)), `live-session bookkeeping is no longer an export column (headers: ${out.workbook.pitHeader.join(' | ')})`);
    assert.ok(!out.workbook.pitHeader.some(h => /deleted/i.test(h)), 'and nothing is marked deleted');
    // A key that is not on the form but holds a value (a field removed in the builder, old data): the same option.
    const eventDocId = (await pitDoc(cap, teamId, 101)).id;
    await cap.evaluate(async ([tid, id]) => { await db.collection('teams').doc(tid).collection('pitScouting').doc(id).update({ legacyThing: 'old answer' }); }, [teamId, eventDocId]);
    await cap.click('#btn-export-event-pit');
    await choiceOpen(cap);
    assert.ok(await deletedOptionShown(cap), 'an entry with a value in a deleted field -> the option appears');
    assert.ok(!(await cap.isChecked('#chk-export-include-deleted')), 'default OFF');
    out = await downloadExcel(cap);
    assert.ok(!out.workbook.pitHeader.includes('legacyThing (deleted)'), 'off: no deleted column');
    await cap.click('#btn-export-event-pit');
    await choiceOpen(cap);
    await cap.check('#chk-export-include-deleted');
    out = await downloadExcel(cap);
    assert.ok(out.workbook.pitHeader.includes('legacyThing (deleted)'), 'ticked: labelled "<label> (deleted)" (no definition, so the key)');
    assert.equal(out.workbook.pit[0]['legacyThing (deleted)'], 'old answer');
    await cap.click('#btn-export-event-pit');
    await choiceOpen(cap);
    assert.ok(!(await cap.isChecked('#chk-export-include-deleted')), 'the box is OFF again on every open');
    await closeChoice(cap);
    // An empty shell left by a cancelled form (no checkpoint, no scoutedBy) is not an entry: a value on it
    // never makes the option appear.
    await cap.evaluate(async ([tid, id]) => {
      const col = db.collection('teams').doc(tid).collection('pitScouting');
      await col.doc(id).update({ legacyThing: firebase.firestore.FieldValue.delete() });
      await col.doc('shell_ghost').set({ eventCode: 'SMOKE1', teamNumber: 202, teamId: tid, season: String(getCurrentFtcSeason()), activeEditors: {}, ghostAnswer: 'x' });
    }, [teamId, eventDocId]);
    await cap.click('#btn-export-event-pit');
    await choiceOpen(cap);
    assert.ok(!(await deletedOptionShown(cap)), 'a value on an empty shell is not an entry: the option is not offered');
    await closeChoice(cap);
    await cap.evaluate(async (tid) => { await db.collection('teams').doc(tid).collection('pitScouting').doc('shell_ghost').delete(); }, teamId);
    // Done with the event entry. Remove it: a whole-team export builds ONE column set across every season it
    // finds (a field another season's form still has is not "deleted"), so the scrimmage's own season must be
    // the only one in play for the whole-team checks below.
    await cap.evaluate(async ([tid, id]) => { await db.collection('teams').doc(tid).collection('pitScouting').doc(id).delete(); }, [teamId, eventDocId]);

    // ---------- (2) a scrimmage in the throwaway season, scouted under the DEFAULT form ----------
    await createScrimmageUI(cap, { name: 'Retire Scrim', season: SEASON });
    await openScrimmageUI(cap, 'Retire Scrim', { goTo: 'pit' });
    await addAndScoutUI(cap, 'pit', { number: 777, name: 'Retiree' });
    await waitPitFormReady(cap);
    await fillRequiredFields(cap, '#pit-modal', 'keepme');          // Drive Type is REQUIRED on the default form
    await cap.fill('#pit-modal #dyn-claimedAvgAutoScore', '4');
    await cap.click('#btn-pit-save');
    await cap.waitForSelector('#pit-modal', { state: 'hidden' });
    const driveTypeValue = (await pitDoc(cap, teamId, 777)).driveType;
    assert.ok(driveTypeValue, 'the old entry has a Drive Type value');
    // A match entry with an Auto Score of 7 (batch mode: Team View).
    await openScoutingSubtab(cap, 'match');
    await (await teamRow(cap, '#team-list-match', 777)).getByRole('button', { name: '+ Match Scout' }).click();
    await cap.waitForSelector('#match-modal:not(.hidden) #match-dynamic-fields .pit-field');
    await cap.fill('#match-modal #dyn-matchNumber', '1');
    await cap.fill('#match-modal #dyn-autoScore', '7');
    await cap.fill('#match-modal #dyn-notes', 'm1');
    await cap.click('#btn-match-save');
    await cap.waitForSelector('#match-modal', { state: 'hidden' });

    // ---------- (3) publish an official form that DROPS those fields, and Accept it ----------
    const genericPit = await cap.evaluate(() => JSON.parse(JSON.stringify(GENERIC_PIT_FIELDS)));
    const genericMatch = await cap.evaluate(() => JSON.parse(JSON.stringify(GENERIC_MATCH_FIELDS)));
    const officialPit = genericPit.filter(f => !['driveType', 'autoCapability'].includes(f.id));
    const officialMatch = genericMatch.filter(f => f.id !== 'autoScore');
    await openMyTeamTab(cap);
    await publishOfficialForm(adminPage, { season: SEASON, formType: 'pitScouting', fields: officialPit });
    await publishOfficialForm(adminPage, { season: SEASON, formType: 'matchScouting', fields: officialMatch });
    await waitItems(cap, 2);
    await noticeButton(cap, 'pitScouting', 'accept').click();
    await confirmGeneric(cap);
    await waitItems(cap, 1);
    await noticeButton(cap, 'matchScouting', 'accept').click();
    await confirmGeneric(cap);
    await waitItems(cap, 0);
    const pitCfg = await readFormConfig(cap, teamId, SEASON, 'pitScouting');
    assert.deepEqual(pitCfg.retiredFields.map(f => f.id), ['driveType', 'autoCapability']);
    assert.equal(pitCfg.retiredFields[0].required, true, 'Drive Type was a REQUIRED field when it was retired');

    // ---------- (4) exports with the values still there ----------
    await cap.click('#btn-myteam-export');
    await choiceOpen(cap);
    assert.ok(!(await deletedOptionShown(cap)), 'scrimmages are left out by default, so no INCLUDED entry has a deleted value -> not offered');
    await cap.check('#chk-export-include-scrimmages');
    assert.ok(await deletedOptionShown(cap), 'including the scrimmage brings in entries with deleted-field values -> offered');
    await cap.uncheck('#chk-export-include-scrimmages');
    assert.ok(!(await deletedOptionShown(cap)), 'and it goes away again with the scrimmage box');
    await cap.check('#chk-export-include-scrimmages');
    assert.ok(!(await cap.isChecked('#chk-export-include-deleted')), 'default OFF');
    out = await downloadExcel(cap);
    const scrimFile = Object.keys(out).find(n => /Scrimmage - Retire Scrim/.test(n));
    assert.ok(scrimFile, 'the scrimmage workbook is in the zip');
    assert.ok(!out[scrimFile].pitHeader.some(h => /deleted/i.test(h)), 'off: no deleted-field columns');
    assert.ok(!out[scrimFile].pitHeader.concat(out[scrimFile].matchHeader).some(h => /checkpoint|activeEditors/i.test(h)));
    await cap.click('#btn-myteam-export');
    await choiceOpen(cap);
    await cap.check('#chk-export-include-scrimmages');
    await cap.check('#chk-export-include-deleted');
    out = await downloadExcel(cap);
    assert.ok(out[scrimFile].pitHeader.includes('Drive Type (deleted)'), `pit: "<label> (deleted)" (headers: ${out[scrimFile].pitHeader.join(' | ')})`);
    assert.equal(out[scrimFile].pit[0]['Drive Type (deleted)'], driveTypeValue, 'with its value');
    assert.ok(!out[scrimFile].pitHeader.includes('Auto Capability (deleted)'), 'a retired field NO included entry has a value in gets no column');
    assert.ok(out[scrimFile].matchHeader.includes('Auto Score (deleted)'), 'match: the same');
    assert.equal(out[scrimFile].match[0]['Auto Score (deleted)'], 7);

    // ---------- (5) editing the old PIT entry ----------
    await openPitEntry(cap, 777);
    let info = await fieldInfo(cap, '#pit-modal', 'driveType');
    assert.ok(info && info.visible, 'the retired field with a value is shown');
    assert.equal(info.value, driveTypeValue, 'filled in');
    assert.ok(info.retired);
    assert.match(info.note, /Deleted field: no longer on the form/);
    assert.equal(info.label, 'Drive Type', 'no required asterisk');
    assert.equal(info.required, false, 'no required state on the input either');
    assert.equal(await fieldInfo(cap, '#pit-modal', 'autoCapability'), null, 'a retired field with NO value is not shown');
    assert.equal((await fieldInfo(cap, '#pit-modal', 'claimedAvgAutoScore')).retired, false, 'a normal field is unchanged');
    assert.equal((await fieldInfo(cap, '#pit-modal', 'notes')).value, 'keepme');
    // Leaving it keeps the value.
    await cap.click('#btn-pit-save');
    await cap.waitForSelector('#pit-modal', { state: 'hidden' });
    assert.equal((await pitDoc(cap, teamId, 777)).driveType, driveTypeValue, 'Done without touching it keeps the value');
    // Clearing it live, then Cancel: the revert (cancelUndo) puts it back.
    await openPitEntry(cap, 777);
    await cap.selectOption('#pit-modal #dyn-driveType', '');
    await cap.waitForFunction(async ([tid]) => {
      const snap = await db.collection('teams').doc(tid).collection('pitScouting').where('teamNumber', '==', 777).get();
      return snap.docs[0].data().driveType == null;
    }, [teamId]);
    await cap.click('#btn-pit-cancel-inline');
    await cap.waitForSelector('#pit-modal', { state: 'hidden' });
    await cap.waitForFunction(async ([tid, v]) => {
      const snap = await db.collection('teams').doc(tid).collection('pitScouting').where('teamNumber', '==', 777).get();
      return snap.docs[0].data().driveType === v;
    }, [teamId, driveTypeValue]);
    // Clearing it and pressing Done: NO required error, the value leaves the stored entry.
    await openPitEntry(cap, 777);
    await cap.selectOption('#pit-modal #dyn-driveType', '');
    await cap.click('#btn-pit-save');
    await cap.waitForSelector('#pit-modal', { state: 'hidden' });
    assert.equal((await cap.textContent('#pit-modal-error')).trim(), '', 'no "required field is empty" error for a retired field');
    const saved = await pitDoc(cap, teamId, 777);
    assert.ok(!('driveType' in saved), 'the value is REMOVED from the stored entry (not left as null)');
    assert.ok(!('driveType' in saved.checkpoint), 'and from its checkpoint');
    assert.equal(saved.notes, 'keepme', 'everything else is intact');
    assert.equal(saved.claimedAvgAutoScore, 4);
    // ...after which the field is gone from that entry.
    await openPitEntry(cap, 777);
    assert.equal(await fieldInfo(cap, '#pit-modal', 'driveType'), null, 'the cleared retired field no longer shows on that entry');
    await cap.click('#btn-pit-cancel-inline');
    await cap.waitForSelector('#pit-modal', { state: 'hidden' });

    // ---------- (6) a NEW entry never shows retired fields ----------
    await addAndScoutUI(cap, 'pit', { number: 778, name: 'Newcomer' });
    await waitPitFormReady(cap);
    assert.equal(await cap.locator('#pit-modal .field-retired').count(), 0, 'no retired field on a new entry');
    assert.equal(await fieldInfo(cap, '#pit-modal', 'driveType'), null);
    assert.equal(await fieldInfo(cap, '#pit-modal', 'autoCapability'), null);
    await cap.fill('#pit-modal #dyn-notes', 'newcomer');  // an entry needs at least one value now (an empty one is refused)
    await cap.click('#btn-pit-save');           // nothing is REQUIRED on the official form: Done works as soon as one field has a value
    await cap.waitForSelector('#pit-modal', { state: 'hidden' });

    // ---------- (7) the old MATCH entry (batch save path) ----------
    const match = (await matchDocs(cap, teamId, 777))[0];
    await cap.evaluate(([id, data]) => openMatchScoutEdit(id, data), [match.id, match]);
    await cap.waitForSelector('#match-modal:not(.hidden) #match-dynamic-fields .pit-field');
    info = await fieldInfo(cap, '#match-modal', 'autoScore');
    assert.ok(info && info.retired && info.visible, 'the retired match field shows on the old entry');
    assert.equal(info.value, '7');
    assert.match(info.note, /Deleted field: no longer on the form/);
    assert.equal(info.label, 'Auto Score');
    assert.equal(await cap.locator('#match-modal .field-retired').count(), 1, 'only that one');
    await cap.fill('#match-modal #dyn-autoScore', '');
    await cap.click('#btn-match-save');
    await cap.waitForSelector('#match-modal', { state: 'hidden' });
    assert.ok(!('autoScore' in (await matchDocs(cap, teamId, 777))[0]), 'cleared + saved: the key is gone from the stored match entry');
    assert.equal((await matchDocs(cap, teamId, 777))[0].notes, 'm1');

    // ---------- (8) nothing left with a deleted value -> the export option is not offered ----------
    await openMyTeamTab(cap);
    await cap.click('#btn-myteam-export');
    await choiceOpen(cap);
    await cap.check('#chk-export-include-scrimmages');
    assert.ok(!(await deletedOptionShown(cap)), 'every deleted-field value has been cleared -> not offered, even with scrimmages included');
    await closeChoice(cap);

    // ---------- (8b) the builder's ✕ retires a field exactly like an Accept does ----------
    // Setup: a REQUIRED Claimed Cycle Time on the team's form, then scrimmage entries (pit 779, match 779) with values.
    await cap.evaluate(async ([tid, season]) => {
      const ref = db.collection('teams').doc(tid).collection('formConfig').doc(`${season}_pitScouting`);
      const fields = (await ref.get()).data().fields.map(f => f.id === 'claimedCycleTime' ? { ...f, required: true } : f);
      await ref.set({ fields }, { merge: true });
    }, [teamId, SEASON]);
    await cap.click('#dashboard-tabs .tab[data-dtab="scouting"]');   // the scrimmage is still the open event
    await addAndScoutUI(cap, 'pit', { number: 779, name: 'Remover' });
    await waitPitFormReady(cap);
    assert.equal(await cap.evaluate(() => document.getElementById('dyn-claimedCycleTime').required), true, 'Claimed Cycle Time is required while it is on the form');
    await cap.fill('#pit-modal #dyn-claimedCycleTime', '12');
    await cap.fill('#pit-modal #dyn-claimedAvgTeleopScore', '33');
    await cap.fill('#pit-modal #dyn-notes', 'n779');
    await cap.click('#btn-pit-save');
    await cap.waitForSelector('#pit-modal', { state: 'hidden' });
    assert.equal((await pitDoc(cap, teamId, 779)).claimedCycleTime, 12);
    await openScoutingSubtab(cap, 'match');
    await (await teamRow(cap, '#team-list-match', 779)).getByRole('button', { name: '+ Match Scout' }).click();
    await cap.waitForSelector('#match-modal:not(.hidden) #match-dynamic-fields .pit-field');
    await cap.fill('#match-modal #dyn-matchNumber', '1');
    await cap.fill('#match-modal #dyn-teleopScore', '9');
    await cap.fill('#match-modal #dyn-notes', 'm779');
    await cap.click('#btn-match-save');
    await cap.waitForSelector('#match-modal', { state: 'hidden' });

    // ✕ in the team's builder (pit): the confirm explains, the SAME write retires the field.
    const cfgBefore = await readFormConfig(cap, teamId, SEASON, 'pitScouting');
    const removeInBuilder = async (page, formType, label) => {
      await openBuilderFor(page, SEASON, formType);
      await page.locator('#builder-field-list .builder-field-item', { hasText: label }).locator('button', { hasText: '✕' }).click();
      await page.waitForSelector('#generic-confirm-modal:not(.hidden)');
      const msg = await page.textContent('#generic-confirm-message');
      await page.click('#btn-generic-confirm-proceed');
      await page.waitForSelector('#generic-confirm-modal', { state: 'hidden' });
      await page.waitForFunction((l) => ![...document.querySelectorAll('#builder-field-list .builder-field-label')].some(e => e.textContent.trim() === l), label);
      return msg;
    };
    const confirmText = await removeInBuilder(cap, 'pitScouting', 'Claimed Cycle Time (seconds)');
    assert.match(confirmText, /Scouted entries keep their data/);
    assert.match(confirmText, /still show it, marked as a deleted field/);
    let cfg = await readFormConfig(cap, teamId, SEASON, 'pitScouting');
    assert.ok(!cfg.fields.some(f => f.id === 'claimedCycleTime'), 'gone from the form');
    assert.deepEqual(cfg.retiredFields.map(f => f.id), ['driveType', 'autoCapability', 'claimedCycleTime'], 'appended to retiredFields (the Accept-retired ones are kept)');
    const retiredDef = cfg.retiredFields[2];
    assert.equal(retiredDef.label, 'Claimed Cycle Time (seconds)', 'its FULL definition, not just the id');
    assert.equal(retiredDef.type, 'number');
    assert.equal(retiredDef.required, true);
    assert.equal(cfg.baseVersion, cfgBefore.baseVersion, 'baseVersion untouched by the write');
    assert.equal(cfg.handledVersion, cfgBefore.handledVersion, 'handledVersion untouched by the write');
    // Admin mode is unchanged: ✕ there is the unpublished draft only (covered in 25) — and it never touches a team.

    // Re-adding a field under a retired id takes it out of retiredFields; removing it again stores the NEWER definition.
    await cap.click('#btn-builder-add-field');
    await cap.waitForSelector('#field-editor-modal:not(.hidden)');
    await cap.fill('#bld-field-label', 'Claimed Cycle Time');
    assert.equal(await cap.inputValue('#bld-field-id'), 'claimedCycleTime', 'the same id as the retired field');
    await cap.setChecked('#bld-field-show-in-preview', false);
    await cap.click('#btn-bld-save');
    await cap.waitForSelector('#field-editor-modal', { state: 'hidden' });
    await cap.waitForFunction(() => [...document.querySelectorAll('#builder-field-list .builder-field-label')].some(e => e.textContent.trim() === 'Claimed Cycle Time'));
    cfg = await readFormConfig(cap, teamId, SEASON, 'pitScouting');
    assert.deepEqual(cfg.retiredFields.map(f => f.id), ['driveType', 'autoCapability'], 'added back -> no longer retired');
    assert.equal(cfg.baseVersion, cfgBefore.baseVersion);
    assert.equal(cfg.handledVersion, cfgBefore.handledVersion);
    await cap.locator('#builder-field-list .builder-field-item', { hasText: 'Claimed Cycle Time' }).locator('button', { hasText: '✕' }).click();
    await confirmGeneric(cap);
    await cap.waitForFunction(() => ![...document.querySelectorAll('#builder-field-list .builder-field-label')].some(e => e.textContent.trim() === 'Claimed Cycle Time'));
    cfg = await readFormConfig(cap, teamId, SEASON, 'pitScouting');
    assert.deepEqual(cfg.retiredFields.map(f => f.id), ['driveType', 'autoCapability', 'claimedCycleTime'], 'removed again: one entry, not two');
    assert.equal(cfg.retiredFields[2].label, 'Claimed Cycle Time', 'and it is the NEWER definition');
    // (the same write also leaves the notice alone: nothing new was published)
    assert.equal((await noticeItems(cap)).length, 0);
    await closeBuilder(cap);

    // The old entry: value shown + note, never required, clear + Done removes it; the rest is intact.
    await openPitEntry(cap, 779);
    info = await fieldInfo(cap, '#pit-modal', 'claimedCycleTime');
    assert.ok(info && info.visible && info.retired, 'the ✕-removed field shows on the old entry that has a value');
    assert.equal(info.value, '12', 'filled in');
    assert.match(info.note, /Deleted field: no longer on the form/);
    assert.equal(info.label, 'Claimed Cycle Time', 'no required asterisk (it WAS required)');
    assert.equal(info.required, false);
    await cap.fill('#pit-modal #dyn-claimedCycleTime', '');
    await cap.click('#btn-pit-save');
    await cap.waitForSelector('#pit-modal', { state: 'hidden' });
    assert.equal((await cap.textContent('#pit-modal-error')).trim(), '', 'no required error for the removed field');
    let doc779 = await pitDoc(cap, teamId, 779);
    assert.ok(!('claimedCycleTime' in doc779), 'cleared + saved: the key is gone from the stored entry');
    assert.ok(!('claimedCycleTime' in doc779.checkpoint), 'and from its checkpoint');
    assert.equal(doc779.notes, 'n779');
    assert.equal(doc779.claimedAvgTeleopScore, 33);
    await openPitEntry(cap, 779);
    assert.equal(await fieldInfo(cap, '#pit-modal', 'claimedCycleTime'), null, 'after clearing, the field is gone from that entry');
    await cap.click('#btn-pit-cancel-inline');
    await cap.waitForSelector('#pit-modal', { state: 'hidden' });

    // NOT live: an entry that is open (here in `cap`) when the field is removed (in `capB`) keeps its form until
    // closed and reopened; saving it neither errors nor loses data.
    const capB = await ctx.newPage('captain-b');
    await signInUI(capB, captain);
    await openPitEntry(cap, 779);
    assert.ok(await fieldInfo(cap, '#pit-modal', 'claimedAvgTeleopScore'), 'open entry has the field');
    await removeInBuilder(capB, 'pitScouting', 'Claimed Avg Teleop Score');
    assert.ok((await readFormConfig(cap, teamId, SEASON, 'pitScouting')).retiredFields.some(f => f.id === 'claimedAvgTeleopScore'), 'removed in the other window');
    info = await fieldInfo(cap, '#pit-modal', 'claimedAvgTeleopScore');
    assert.ok(info && info.visible && !info.retired, 'the open entry still shows it as a normal field (not live)');
    assert.equal(info.value, '33');
    await cap.fill('#pit-modal #dyn-claimedAvgTeleopScore', '44');
    await cap.fill('#pit-modal #dyn-notes', 'n779 edited');
    await cap.click('#btn-pit-save');
    await cap.waitForSelector('#pit-modal', { state: 'hidden' });
    assert.equal((await cap.textContent('#pit-modal-error')).trim(), '', 'saving the open entry does not error');
    doc779 = await pitDoc(cap, teamId, 779);
    assert.equal(doc779.claimedAvgTeleopScore, 44, 'the value typed into the since-removed field was saved, not lost');
    assert.equal(doc779.notes, 'n779 edited');
    await openPitEntry(cap, 779);
    info = await fieldInfo(cap, '#pit-modal', 'claimedAvgTeleopScore');
    assert.ok(info && info.retired && info.value === '44', 'reopened: now shown as a deleted field with the saved value');
    await cap.click('#btn-pit-cancel-inline');
    await cap.waitForSelector('#pit-modal', { state: 'hidden' });
    await capB.close();

    // ✕ in the team's MATCH builder: same retiring, batch save path.
    await removeInBuilder(cap, 'matchScouting', 'Teleop Score');
    cfg = await readFormConfig(cap, teamId, SEASON, 'matchScouting');
    assert.ok(cfg.retiredFields.some(f => f.id === 'teleopScore' && f.label === 'Teleop Score'), 'match: retired with its definition');
    assert.ok(!cfg.fields.some(f => f.id === 'teleopScore'));
    await closeBuilder(cap);
    const match779 = (await matchDocs(cap, teamId, 779))[0];
    await cap.evaluate(([id, data]) => openMatchScoutEdit(id, data), [match779.id, match779]);
    await cap.waitForSelector('#match-modal:not(.hidden) #match-dynamic-fields .pit-field');
    info = await fieldInfo(cap, '#match-modal', 'teleopScore');
    assert.ok(info && info.retired && info.visible && info.value === '9', 'match: the removed field shows with its value');
    assert.match(info.note, /Deleted field: no longer on the form/);
    await cap.fill('#match-modal #dyn-teleopScore', '');
    await cap.click('#btn-match-save');
    await cap.waitForSelector('#match-modal', { state: 'hidden' });
    const match779After = (await matchDocs(cap, teamId, 779))[0];
    assert.ok(!('teleopScore' in match779After), 'match: cleared + saved removes the key');
    assert.equal(match779After.notes, 'm779');

    // A retired id that is (oddly) already listed — here an older "Notes" definition left in retiredFields while the
    // field is still on the form — is REPLACED by the newer one on ✕, never listed twice.
    await cap.evaluate(async ([tid, season]) => {
      const ref = db.collection('teams').doc(tid).collection('formConfig').doc(`${season}_pitScouting`);
      await ref.update({ retiredFields: firebase.firestore.FieldValue.arrayUnion({ id: 'notes', label: 'OLD NOTES', type: 'text', required: false, sortOrder: 9 }) });
    }, [teamId, SEASON]);
    await removeInBuilder(cap, 'pitScouting', 'Notes');
    cfg = await readFormConfig(cap, teamId, SEASON, 'pitScouting');
    assert.deepEqual(cfg.retiredFields.filter(f => f.id === 'notes').map(f => f.label), ['Notes'], 'one entry, the newer definition');
    await closeBuilder(cap);

    // ✕-removed fields export as "(deleted)" like Accept-retired ones: 779's remaining value (44).
    await openMyTeamTab(cap);
    await cap.click('#btn-myteam-export');
    await choiceOpen(cap);
    await cap.check('#chk-export-include-scrimmages');
    assert.ok(await deletedOptionShown(cap), 'a ✕-removed field with a value -> the option is offered');
    await cap.check('#chk-export-include-deleted');
    out = await downloadExcel(cap);
    assert.ok(out[scrimFile].pitHeader.includes('Claimed Avg Teleop Score (deleted)'), `labelled from its retired definition (headers: ${out[scrimFile].pitHeader.join(' | ')})`);

    // ---------- (9) deleting the team (its last member) clears the snapshots and form configs too ----------
    const env = await createRulesTestEnv();
    try {
      const count = async (...path) => { let n; await env.withSecurityRulesDisabled(async (rc) => { n = (await getDocs(collection(rc.firestore(), ...path))).size; }); return n; };
      assert.ok(await count('teams', teamId, 'formSnapshots') >= 2, 'the two Accepts saved a snapshot each');
      await cap.evaluate(([tid, uid]) => deleteEntireTeam(tid, uid, currentTeamData), [teamId, await cap.evaluate(() => currentUser.uid)]);
      assert.equal(await count('teams', teamId, 'formSnapshots'), 0, 'snapshots are deleted with the team');
      assert.equal(await count('teams', teamId, 'formConfig'), 0, 'and so are the form configs');
    } finally {
      await env.cleanup();
    }
  }
};
