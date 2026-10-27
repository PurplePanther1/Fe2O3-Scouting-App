// The Delete button inside the pit form and the match form shows only while the open entry is a COMMITTED one
// (isEntryCommitted: Done / Save clicked at least once). A new entry shows just Cancel, and so does the empty
// shell document a live session leaves behind (opening a form creates it; Cancel keeps it). Covered:
//   pit form (live), Match View (live, locked match number), Team View (batch) new + edit,
//   a leftover empty shell reopened, a committed entry, and the button following the live document
//   (a second editor's window shows Delete as soon as the first editor's Done commits the entry).
// The Match View title follows the same rule: an uncommitted leftover shell is titled as a NEW entry ("Match #N - Team #T"),
// only a committed entry is "Edit Match #N".

const assert = require('node:assert/strict');
const { signInUI, createTeamUI, joinTeamUI, selectFixtureEvent } = require('../lib/app');
const { FIXTURE_EVENT } = require('../lib/harness');

const CODE = FIXTURE_EVENT.code;
const field = (id, label, type, extra = {}) => ({ id, label, type, required: false, sortOrder: 0, showInPreview: false, ...extra });

module.exports = {
  name: 'Delete button only for committed entries: pit, Match View (live), Team View (batch), edit, leftover empty shell, follows the live document',
  async run(ctx) {
    const captain = await ctx.makeUser('Captain Delete');
    const member = await ctx.makeUser('Member Delete');
    const cap = await ctx.newPage('captain');
    await signInUI(cap, captain);
    const joinCode = await createTeamUI(cap, 'Delete Button Team');
    await selectFixtureEvent(cap);
    const teamId = await cap.evaluate(() => currentTeamData.id);
    const season = await cap.evaluate(() => resolveFormConfigSeason());
    const putConfig = (type, fields) => cap.evaluate(async ([tid, id, f]) => {
      await db.collection('teams').doc(tid).collection('formConfig').doc(id).set({ fields: f, baseVersion: null, handledVersion: 0, retiredFields: [] }, { merge: true });
    }, [teamId, `${season}_${type}`, fields.map((f, i) => ({ ...f, sortOrder: i }))]);
    await putConfig('pitScouting', [field('t1', 'Text', 'text')]);
    await putConfig('matchScouting', [field('matchNumber', 'Match Number', 'number', { required: true }), field('t1', 'Text', 'text')]);
    await cap.evaluate(([tid, s]) => { invalidateFormConfigCache(tid, s); invalidateMatchFormConfigCache(tid, s); }, [teamId, season]);

    const deleteShown = (page, which) => page.evaluate((id) => !document.getElementById(id).classList.contains('hidden'), `${which}-delete-btn`);
    const openPit = async (page, n) => {
      await page.evaluate(([num, code]) => openPitScoutForm(num, code), [n, CODE]);
      await page.waitForSelector('#pit-modal:not(.hidden) #pit-dynamic-fields .pit-field');
      await page.waitForFunction(() => currentPitLiveSession && currentPitLiveSession.isJoined());
    };
    const openLiveMatch = async (page, matchNo, n) => {
      await page.evaluate(([m, num, code]) => openMatchScoutFormFromSchedule(m, num, code, 'Team'), [matchNo, n, CODE]);
      await page.waitForSelector('#match-modal:not(.hidden) #match-dynamic-fields .pit-field');
      await page.waitForFunction(() => currentMatchLiveSession && currentMatchLiveSession.isJoined());
    };
    const cancel = async (page, modal) => {
      await page.click(modal === 'pit' ? '#btn-pit-cancel-inline' : '#btn-match-cancel-inline');
      await page.waitForSelector(`#${modal}-modal`, { state: 'hidden' });
    };
    const done = async (page, modal) => {
      await page.click(modal === 'pit' ? '#btn-pit-save' : '#btn-match-save');
      await page.waitForSelector(`#${modal}-modal`, { state: 'hidden' });
    };
    const doc = (page, col, n, m) => page.evaluate(async ([tid, c, num, mm, code]) => {
      let q = db.collection('teams').doc(tid).collection(c).where('eventCode', '==', code).where('teamNumber', '==', num);
      if (mm != null) q = q.where('matchNumber', '==', mm);
      const s = await q.get();
      return s.empty ? null : { id: s.docs[0].id, ...s.docs[0].data() };
    }, [teamId, col, n, m ?? null, CODE]);
    const waitShell = (page, col, n, m) => page.waitForFunction(async ([tid, c, num, mm, code]) => {
      let q = db.collection('teams').doc(tid).collection(c).where('eventCode', '==', code).where('teamNumber', '==', num);
      if (mm != null) q = q.where('matchNumber', '==', mm);
      const s = await q.get();
      return s.size === 1 && Object.keys(s.docs[0].data().activeEditors || {}).length === 0;
    }, [teamId, col, n, m ?? null, CODE]);

    // ================= pit form =================
    await openPit(cap, 101);
    assert.equal(await deleteShown(cap, 'pit'), false, 'pit: a brand-new entry shows only Cancel');
    await cancel(cap, 'pit');
    await waitShell(cap, 'pitScouting', 101);
    let d = await doc(cap, 'pitScouting', 101);
    assert.ok(d && !d.checkpoint && d.scoutedBy == null, 'the Cancel left an empty, uncommitted shell document');
    await openPit(cap, 101);
    assert.equal(await deleteShown(cap, 'pit'), false, 'pit: reopening that empty shell still shows no Delete (it exists, but was never saved)');
    await cap.fill('#pit-modal #dyn-t1', 'real');
    await done(cap, 'pit');
    await openPit(cap, 101);
    assert.equal(await deleteShown(cap, 'pit'), true, 'pit: a committed entry shows Delete');
    await cancel(cap, 'pit');
    // a new entry for another team after a committed one: the button is hidden again (not left over from the last form)
    await openPit(cap, 202);
    assert.equal(await deleteShown(cap, 'pit'), false, 'pit: the next brand-new entry hides it again');
    await cancel(cap, 'pit');

    // ================= Match View (live, locked match number) =================
    const matchTitle = async (page) => (await page.textContent('#match-modal-title')).trim();
    await openLiveMatch(cap, 5, 101);
    assert.equal(await deleteShown(cap, 'match'), false, 'Match View: a brand-new entry shows only Cancel');
    assert.equal(await matchTitle(cap), 'Match #5 — Team #101 (Team)', 'Match View: a brand-new entry is titled as a new entry');
    await cancel(cap, 'match');
    await waitShell(cap, 'matchScouting', 101, 5);
    await openLiveMatch(cap, 5, 101);
    // (the leftover shell takes the edit path, but it is not committed: it is titled exactly like a new entry)
    assert.equal(await matchTitle(cap), 'Match #5 — Team #101 (Team)', 'a leftover empty shell is titled as a new entry, not "Edit Match #5"');
    assert.equal(await deleteShown(cap, 'match'), false, 'Match View: an empty uncommitted shell still shows no Delete');
    await cap.fill('#match-modal #dyn-t1', 'live match');
    await done(cap, 'match');
    await openLiveMatch(cap, 5, 101);
    assert.equal(await deleteShown(cap, 'match'), true, 'Match View: a committed entry shows Delete');
    assert.equal(await matchTitle(cap), 'Edit Match #5 — Team #101 (Team)', 'a committed entry keeps "Edit Match #5"');
    await cancel(cap, 'match');
    await openLiveMatch(cap, 6, 101);
    assert.equal(await deleteShown(cap, 'match'), false, 'Match View: the next new entry hides it again');
    await cancel(cap, 'match');

    // ================= Team View (batch) =================
    await cap.evaluate(([n, code]) => openMatchScoutForm(n, code), [202, CODE]);
    await cap.waitForSelector('#match-modal:not(.hidden) #match-dynamic-fields .pit-field');
    assert.equal(await deleteShown(cap, 'match'), false, 'Team View: a new entry shows only Cancel');
    await cap.fill('#match-modal #dyn-matchNumber', '7');
    await cap.fill('#match-modal #dyn-t1', 'batch');
    await done(cap, 'match');
    const batch = await doc(cap, 'matchScouting', 202, 7);
    await cap.evaluate(([id, data]) => openMatchScoutEdit(id, data), [batch.id, batch]);
    await cap.waitForSelector('#match-modal:not(.hidden) #match-dynamic-fields .pit-field');
    assert.equal(await deleteShown(cap, 'match'), true, 'Team View: editing a saved entry shows Delete');
    assert.equal(await matchTitle(cap), 'Edit Match #7 — Team #202', 'Team View: a saved entry is titled "Edit Match #7"');
    assert.equal((await cap.textContent('#match-modal-success')).trim(), 'Editing existing match entry.');
    await cancel(cap, 'match');
    // the edit path handed an uncommitted shell (no checkpoint, no scoutedBy) hides it
    const shell = { ...batch }; delete shell.checkpoint; delete shell.scoutedBy;
    await cap.evaluate(([id, data]) => openMatchScoutEdit(id, data), [batch.id, shell]);
    await cap.waitForSelector('#match-modal:not(.hidden) #match-dynamic-fields .pit-field');
    assert.equal(await deleteShown(cap, 'match'), false, 'an entry that is not committed never shows Delete');
    assert.equal(await matchTitle(cap), 'Match Scout Team #202', 'Team View: an uncommitted entry is titled as a new entry, not "Edit Match #7"');
    assert.equal((await cap.textContent('#match-modal-success')).trim(), '', 'and does not say it is editing an existing entry');
    await cancel(cap, 'match');
    await cap.evaluate(([n, code]) => openMatchScoutForm(n, code), [202, CODE]);
    await cap.waitForSelector('#match-modal:not(.hidden) #match-dynamic-fields .pit-field');
    assert.equal(await deleteShown(cap, 'match'), false, 'Team View: a new entry after an edit hides it again');
    await cancel(cap, 'match');

    // ================= the button follows the live document: a second window sees Delete once the first one saves =================
    const mem = await ctx.newPage('member');
    await signInUI(mem, member);
    await joinTeamUI(mem, joinCode);
    await selectFixtureEvent(mem);
    await openPit(mem, 303);              // the member starts a brand-new entry
    await openPit(cap, 303);              // the captain joins the same draft
    assert.equal(await deleteShown(mem, 'pit'), false);
    assert.equal(await deleteShown(cap, 'pit'), false, 'two windows on an uncommitted draft: no Delete in either');
    await mem.fill('#pit-modal #dyn-t1', 'first save');
    await done(mem, 'pit');               // first successful save -> committed
    await cap.waitForFunction(() => !document.getElementById('pit-delete-btn').classList.contains('hidden'), null, { timeout: 8000 });
    assert.equal(await deleteShown(cap, 'pit'), true, 'the other window\'s Delete appears after the entry is committed');
    await cancel(cap, 'pit');
    // same for Match View
    await openLiveMatch(mem, 8, 303);
    await openLiveMatch(cap, 8, 303);
    assert.equal(await deleteShown(cap, 'match'), false);
    await mem.fill('#match-modal #dyn-t1', 'first live save');
    await done(mem, 'match');
    await cap.waitForFunction(() => !document.getElementById('match-delete-btn').classList.contains('hidden'), null, { timeout: 8000 });
    await cancel(cap, 'match');
  }
};
