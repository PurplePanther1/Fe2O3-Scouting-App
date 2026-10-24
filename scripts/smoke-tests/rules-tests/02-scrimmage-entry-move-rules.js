// Emulator tests (REAL firestore.rules) for the write patterns phase 3 relies on to
// move a scrimmage team's scouting entries to another number (renumber / merge):
//
//   MOVE   = create a COPY of the entry under the new doc id (every field, teamNumber
//            changed, the ORIGINAL scout's scoutedBy / lastEditedBy kept), then delete the
//            old doc.
//   MERGE  = the same, plus replace the surviving doc (team B's) with the merged values
//            by DELETE + CREATE in ONE batch.
//
// The interesting user is the one with ONLY canManageScrimmages (no captain, no
// canEditOtherEntries): the rules never let them UPDATE somebody else's committed entry,
// but any member can CREATE and a scrimmage manager can cascade-DELETE scrimmage entries.
// These checks prove the whole plan works with NO rules change, and pin the limits that
// shaped it (why shells are deleted first, why updating in place is not an option).

const { assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');
const { doc, setDoc, getDoc, updateDoc, deleteDoc, writeBatch, setLogLevel } = require('firebase/firestore');

setLogLevel('silent');

module.exports = {
  name: 'rules: moving scrimmage entries (create copy + manager delete, merged entry under a new id)',
  async run(ctx) {
    const env = ctx.rulesEnv;
    const sfx = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
    const teamId = `mv_${sfx}`;
    const uid = { cap: `cap_${sfx}`, mgr: `mgr_${sfx}`, edit: `ed_${sfx}`, scout: `sc_${sfx}`, mem: `mem_${sfx}`, out: `out_${sfx}` };

    await env.withSecurityRulesDisabled(async (c) => {
      const f = c.firestore();
      await setDoc(doc(f, 'teams', teamId), {
        name: 'Move Team',
        members: [uid.cap, uid.mgr, uid.edit, uid.scout, uid.mem],
        roles: { [uid.cap]: 'captain' },
        permissions: {
          [uid.mgr]: { canManageScrimmages: true },           // ONLY this
          [uid.edit]: { canEditOtherEntries: true }
        }
      });
      await setDoc(doc(f, 'teams', teamId, 'scrimmages', 'S1'), {
        name: 'Move Scrimmage', season: '2026', eventCode: 'SCRIM-S1', createdAt: new Date(), teams: {}, matchCount: 0
      });
    });

    const db = {};
    Object.keys(uid).forEach(k => { db[k] = env.authenticatedContext(uid[k]).firestore(); });
    const pit = (who, id) => doc(db[who], 'teams', teamId, 'pitScouting', id);
    const match = (who, id) => doc(db[who], 'teams', teamId, 'matchScouting', id);

    // A committed entry scouted by `scout`, last edited by `edit` — the "someone else's" data.
    const entry = (n, extra = {}) => ({
      eventCode: 'SCRIM-S1', scrimmageId: 'S1', teamNumber: n, teamId, season: '2026',
      scoutedBy: uid.scout, scoutedByName: 'Scout', scoutedAt: new Date(1700000000000),
      lastEditedBy: uid.edit, lastEditedByName: 'Editor', lastEditedByTimestamp: 1700000001000,
      updatedAt: new Date(1700000002000),
      checkpoint: { notes: 'old', drive: 'tank' }, notes: 'old', drive: 'tank', activeEditors: {}, ...extra
    });
    const seed = async (kind, id, data) => env.withSecurityRulesDisabled(async (c) => {
      await setDoc(doc(c.firestore(), 'teams', teamId, kind, id), data);
    });

    const failures = [];
    let passed = 0;
    async function check(label, promiseFactory, expect) {
      try {
        await (expect === 'fail' ? assertFails(promiseFactory()) : assertSucceeds(promiseFactory()));
        passed++;
      } catch (err) {
        failures.push(`${label}  (expected ${expect === 'fail' ? 'DENY' : 'ALLOW'}): ${String(err.message || err).split('\n')[0]}`);
      }
    }
    const ok = (label, f) => check(label, f, 'succeed');
    const denied = (label, f) => check(label, f, 'fail');

    // ---------- the plan with NO rules change ----------
    await seed('pitScouting', `${teamId}_SCRIM-S1_100`, entry(100));
    await seed('matchScouting', `${teamId}_SCRIM-S1_1_100`, entry(100, { matchNumber: 1 }));

    // step 2: create the COPY at the new id, keeping the original scout's attribution
    await ok('manager-only: create a copy of ANOTHER scout\'s committed pit entry (scoutedBy/lastEditedBy kept)', () =>
      setDoc(pit('mgr', `${teamId}_SCRIM-S1_200`), entry(200)));
    await ok('manager-only: create a copy of another scout\'s committed match entry', () =>
      setDoc(match('mgr', `${teamId}_SCRIM-S1_1_200`), entry(200, { matchNumber: 1 })));
    await ok('plain member: can create such a copy too (create is open to any member)', () =>
      setDoc(pit('mem', `${teamId}_SCRIM-S1_201`), entry(201)));
    await denied('a non-member cannot create a copy', () => setDoc(pit('out', `${teamId}_SCRIM-S1_202`), entry(202)));

    // step 4: delete the old docs
    await denied('plain member cannot delete the old committed pit entry', () => deleteDoc(pit('mem', `${teamId}_SCRIM-S1_100`)));
    await ok('manager-only: can delete the old committed pit entry (cascade clause)', () => deleteDoc(pit('mgr', `${teamId}_SCRIM-S1_100`)));
    await ok('manager-only: can delete the old committed match entry', () => deleteDoc(match('mgr', `${teamId}_SCRIM-S1_1_100`)));
    await ok('batched copy-create + old-delete of many docs works for the manager', async () => {
      await seed('pitScouting', `${teamId}_SCRIM-S1_300`, entry(300));
      await seed('matchScouting', `${teamId}_SCRIM-S1_2_300`, entry(300, { matchNumber: 2 }));
      await seed('matchScouting', `${teamId}_SCRIM-S1_3_300`, entry(300, { matchNumber: 3 }));
      const b = writeBatch(db.mgr);
      b.set(pit('mgr', `${teamId}_SCRIM-S1_301`), entry(301));
      b.set(match('mgr', `${teamId}_SCRIM-S1_2_301`), entry(301, { matchNumber: 2 }));
      b.set(match('mgr', `${teamId}_SCRIM-S1_3_301`), entry(301, { matchNumber: 3 }));
      await b.commit();
      const d = writeBatch(db.mgr);
      d.delete(pit('mgr', `${teamId}_SCRIM-S1_300`));
      d.delete(match('mgr', `${teamId}_SCRIM-S1_2_300`));
      d.delete(match('mgr', `${teamId}_SCRIM-S1_3_300`));
      await d.commit();
    });

    // ---------- the limits that shaped it ----------
    await seed('pitScouting', `${teamId}_SCRIM-S1_400`, entry(400));
    await denied('manager-only CANNOT update another scout\'s committed entry in place', () =>
      updateDoc(pit('mgr', `${teamId}_SCRIM-S1_400`), { notes: 'merged' }));
    await denied('manager-only cannot overwrite (set) another scout\'s committed entry in place', () =>
      setDoc(pit('mgr', `${teamId}_SCRIM-S1_400`), entry(400, { notes: 'merged' })));
    await ok('the captain CAN update it in place', () => updateDoc(pit('cap', `${teamId}_SCRIM-S1_400`), { notes: 'by captain' }));
    await ok('a canEditOtherEntries holder CAN update it in place', () => updateDoc(pit('edit', `${teamId}_SCRIM-S1_400`), { notes: 'by editor' }));

    // A draft SHELL (no checkpoint / scoutedBy): copying another scout's scoutedBy ONTO it
    // is an update that isValidScoutedByWrite() refuses — so shells at the target id are
    // deleted before the copy is created.
    await seed('pitScouting', `${teamId}_SCRIM-S1_500`, { eventCode: 'SCRIM-S1', scrimmageId: 'S1', teamNumber: 500, teamId, season: '2026', activeEditors: {} });
    await denied('copying another scout\'s entry ONTO an existing empty shell is denied (scoutedBy rule)', () =>
      setDoc(pit('mgr', `${teamId}_SCRIM-S1_500`), entry(500)));
    await ok('...but the shell can be deleted first by the manager', () => deleteDoc(pit('mgr', `${teamId}_SCRIM-S1_500`)));
    await ok('...and then the copy created', () => setDoc(pit('mgr', `${teamId}_SCRIM-S1_500`), entry(500)));

    // ---------- merge: the surviving doc is replaced by a NEW doc id ----------
    // DELETE + CREATE of the SAME id in one batch is evaluated against the pre-batch
    // state (the create is seen as an UPDATE of a committed entry) and is denied for a
    // manager-only user — so the merged entry is written under a fresh id, then the old
    // docs are deleted.
    const id600 = `${teamId}_SCRIM-S1_600`;
    const id600m = `${teamId}_SCRIM-S1_600_m1`;
    await seed('pitScouting', id600, entry(600));
    await denied('manager-only: delete + re-create the SAME doc id in ONE batch is denied (rules see an update)', async () => {
      const b = writeBatch(db.mgr);
      b.delete(pit('mgr', id600));
      b.set(pit('mgr', id600), entry(600, { notes: 'merged' }));
      await b.commit();
    });
    const still600 = await getDoc(pit('mgr', id600));
    if (!still600.exists() || still600.data().notes !== 'old') failures.push('a denied batch replace changed the doc'); else passed++;
    await ok('manager-only: the merged entry under a NEW id keeps the original scoutedBy and is lastEditedBy the manager', () =>
      setDoc(pit('mgr', id600m), entry(600, { notes: 'merged', checkpoint: { notes: 'merged', drive: 'tank' }, lastEditedBy: uid.mgr, lastEditedByName: 'Manager' })));
    await ok('...then the replaced doc is deleted by the manager', () => deleteDoc(pit('mgr', id600)));
    const merged = await getDoc(pit('mgr', id600m));
    if (!merged.exists() || merged.data().notes !== 'merged' || merged.data().scoutedBy !== uid.scout) failures.push('merged doc missing / wrong scoutedBy'); else passed++;

    // Outside a scrimmage the cascade clause does not exist: a real-event entry cannot be
    // deleted by the manager-only user (so the move is scrimmage-only by construction).
    await seed('pitScouting', `${teamId}_REAL1_700`, { eventCode: 'REAL1', teamNumber: 700, teamId, season: '2026', scoutedBy: uid.scout, checkpoint: { a: 1 } });
    await denied('manager-only cannot delete a REAL-event entry (no scrimmageId)', () => deleteDoc(pit('mgr', `${teamId}_REAL1_700`)));

    if (failures.length > 0) throw new Error(`${failures.length} rules check(s) failed (${passed} passed):\n  ${failures.join('\n  ')}`);
    ctx.log(`${passed} checks`);
  }
};
